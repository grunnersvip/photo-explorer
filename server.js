const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const os = require('os');
const crypto = require('crypto');
const { ExifTool } = require('exiftool-vendored');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 3000;
const IMAGES_ROOT = '/images';

// Thumbnail cache stored inside the container's tmp dir
// Survives as long as the container is running; cleared on rebuild (acceptable)
const CACHE_DIR = path.join(os.tmpdir(), 'pe-thumbcache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const exiftool = new ExifTool({ taskTimeoutMillis: 10000 });
process.on('SIGTERM', () => exiftool.end());
process.on('SIGINT',  () => exiftool.end());

// ── AUTH ────────────────────────────────────────────────────────────────────

const AUTH_USER = process.env.PE_USERNAME || 'admin';
const AUTH_PASS = process.env.PE_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.PE_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

let AUTH_HASH = null;
bcrypt.hash(AUTH_PASS, 12).then(hash => {
  AUTH_HASH = hash;
  console.log(`[auth] User: ${AUTH_USER} — ready`);
  if (!process.env.PE_SESSION_SECRET)
    console.warn('[auth] Warning: PE_SESSION_SECRET not set — sessions reset on restart');
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!AUTH_HASH) return res.status(503).send('Server starting, please retry');
  const userMatch = username === AUTH_USER;
  const passMatch = await bcrypt.compare(password || '', AUTH_HASH);
  if (userMatch && passMatch) {
    req.session.authenticated = true;
    req.session.username = username;
    console.log(`[auth] Login OK: ${username} from ${req.ip}`);
    return res.redirect('/');
  }
  console.warn(`[auth] Failed login: "${username}" from ${req.ip}`);
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  const user = req.session.username;
  req.session.destroy(() => { console.log(`[auth] Logout: ${user}`); res.redirect('/login'); });
});

app.get('/api/whoami', requireAuth, (req, res) => {
  res.json({ username: req.session.username });
});

app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));

// ── HELPERS ─────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.avif']);
function isImage(f) { return IMAGE_EXTS.has(path.extname(f).toLowerCase()); }
function isJpeg(f) { const e = path.extname(f).toLowerCase(); return e === '.jpg' || e === '.jpeg'; }
function safePath(rel) {
  const abs = path.resolve(IMAGES_ROOT, rel.replace(/^\/+/, ''));
  if (!abs.startsWith(IMAGES_ROOT)) throw new Error('Path traversal blocked');
  return abs;
}

// ── THUMBNAIL CACHE ─────────────────────────────────────────────────────────
//
// Cache key = MD5(absolute path + mtime) → stored as <hash>.jpg in CACHE_DIR
// If the file is modified (rotation, edit), mtime changes → new cache key →
// old cached thumb is naturally bypassed and a new one is generated.
//
function thumbCacheKey(abs) {
  try {
    const stat = fs.statSync(abs);
    const raw = abs + ':' + stat.mtimeMs;
    return crypto.createHash('md5').update(raw).digest('hex') + '.jpg';
  } catch {
    return null;
  }
}

async function getOrCreateThumb(abs) {
  const key = thumbCacheKey(abs);
  if (!key) throw new Error('File not found');

  const cachePath = path.join(CACHE_DIR, key);

  // Cache hit — serve immediately
  if (fs.existsSync(cachePath)) return cachePath;

  // Cache miss — read exact orientation via exiftool, rotate explicitly
  let degrees = 0;
  if (isJpeg(abs)) {
    const { orientation } = await readExifOrientation(abs);
    degrees = orientationToDegrees(orientation);
  }

  await sharp(abs)
    .rotate(degrees)                       // explicit degrees from exiftool
    .resize(220, 220, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(cachePath);

  return cachePath;
}

// ── EXIF ────────────────────────────────────────────────────────────────────

const CW_MAP  = { 1: 6, 6: 3, 3: 8, 8: 1 };
const CCW_MAP = { 1: 8, 8: 3, 3: 6, 6: 1 };
function orientationToDegrees(o) { return { 1: 0, 6: 90, 3: 180, 8: 270 }[o] ?? 0; }

async function readExifOrientation(abs) {
  try {
    const tags = await exiftool.read(abs);
    const val = tags.Orientation;
    let num;
    if (typeof val === 'number') { num = val; }
    else if (typeof val === 'string') {
      if (val.includes('90 CW') || val === 'RightTop')                                num = 6;
      else if (val.includes('180') || val === 'BottomRight')                          num = 3;
      else if (val.includes('270') || val.includes('90 CCW') || val === 'LeftBottom') num = 8;
      else                                                                              num = 1;
    } else { return { orientation: 1, tagPresent: false }; }
    return { orientation: [1,3,6,8].includes(num) ? num : 1, tagPresent: true };
  } catch { return { orientation: 1, tagPresent: false }; }
}

async function rotateExifOrientation(abs, direction) {
  const { orientation: current, tagPresent } = await readExifOrientation(abs);
  const newOrientation = (direction === 'cw' ? CW_MAP : CCW_MAP)[current];
  if (!tagPresent) console.log(`[exiftool] Creating Orientation tag: ${path.basename(abs)}`);
  await exiftool.write(abs, { Orientation: newOrientation }, ['-overwrite_original', '-n']);
  console.log(`[exiftool] ${current}→${newOrientation} (${direction}): ${path.basename(abs)}`);
  return newOrientation;
}

async function rotateLosslessOther(abs, degrees) {
  const ext = path.extname(abs).toLowerCase();
  const tmp = path.join(os.tmpdir(), `pe-${Date.now()}-${path.basename(abs)}`);
  try {
    let p = sharp(abs).rotate(degrees).withMetadata();
    if (ext === '.png')       p = p.png({ compressionLevel: 9 });
    else if (ext === '.webp') p = p.webp({ lossless: true });
    else if (ext === '.tiff') p = p.tiff({ compression: 'lzw' });
    else if (ext === '.avif') p = p.avif({ lossless: true, effort: 6 });
    await p.toFile(tmp);
    fs.renameSync(tmp, abs);
  } catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
}

// ── TREE ────────────────────────────────────────────────────────────────────

function buildTree(dir, relBase) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const folders = [], images = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) {
      const sub = buildTree(path.join(dir, e.name), rel);
      if (sub) folders.push({ name: e.name, path: rel, type: 'folder', children: sub.children, imageCount: sub.imageCount });
    } else if (e.isFile() && isImage(e.name)) {
      images.push({ name: e.name, path: rel, type: 'file' });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { children: [...folders, ...images], imageCount: images.length + folders.reduce((s, f) => s + f.imageCount, 0) };
}

// ── API ──────────────────────────────────────────────────────────────────────

app.get('/api/tree', requireAuth, (req, res) => {
  const tree = buildTree(IMAGES_ROOT, '');
  res.json({ children: tree?.children || [], imageCount: tree?.imageCount || 0 });
});

// Return folder listing IMMEDIATELY — no EXIF reads, no blocking.
// The browser will request each thumb individually; rotation badges are
// fetched lazily via /api/orientation when the user selects an image.
app.get('/api/folder', requireAuth, (req, res) => {
  const rel = (req.query.path || '').replace(/^\/+/, '');
  let abs;
  try { abs = safePath(rel); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { return res.status(404).json({ error: 'Folder not found' }); }

  const images = entries
    .filter(e => e.isFile() && isImage(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map(e => ({
      name: e.name,
      path: rel ? path.join(rel, e.name) : e.name,
      rotation: 0   // populated lazily by /api/orientation
    }));

  res.json({ images });
});

// Lazy EXIF orientation read — called only when user selects an image
app.get('/api/orientation', requireAuth, async (req, res) => {
  const rel = (req.query.path || '').replace(/^\/+/, '');
  let abs;
  try { abs = safePath(rel); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  if (!isJpeg(abs)) return res.json({ orientation: 1, degrees: 0 });
  const { orientation } = await readExifOrientation(abs);
  res.json({ orientation, degrees: orientationToDegrees(orientation) });
});

app.get('/api/image', requireAuth, (req, res) => {
  const rel = (req.query.path || '').replace(/^\/+/, '');
  let abs;
  try { abs = safePath(rel); } catch { return res.status(400).send('Invalid path'); }
  if (!fs.existsSync(abs)) return res.status(404).send('Not found');
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tiff': 'image/tiff', '.avif': 'image/avif' };
  res.setHeader('Content-Type', mime[path.extname(rel).toLowerCase()] || 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(abs);
});

// Thumbnail — served from disk cache; generated once per file-version
app.get('/api/thumb', requireAuth, async (req, res) => {
  const rel = (req.query.path || '').replace(/^\/+/, '');
  let abs;
  try { abs = safePath(rel); } catch { return res.status(400).send('Invalid path'); }
  if (!fs.existsSync(abs)) return res.status(404).send('Not found');

  try {
    const cachePath = await getOrCreateThumb(abs);
    res.setHeader('Content-Type', 'image/jpeg');
    // Cached thumbs can be cached by the browser too — they're keyed by mtime
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(cachePath);
  } catch (err) {
    console.error('Thumb error:', err.message);
    res.status(500).send('Error');
  }
});

app.post('/api/rotate', requireAuth, async (req, res) => {
  const { path: rel, direction } = req.body;
  if (!rel || !direction) return res.status(400).json({ error: 'Missing params' });
  let abs;
  try { abs = safePath(rel); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
  try {
    if (isJpeg(abs)) {
      const newOrientation = await rotateExifOrientation(abs, direction);
      res.json({ rotation: orientationToDegrees(newOrientation), orientation: newOrientation });
    } else {
      await rotateLosslessOther(abs, direction === 'cw' ? 90 : 270);
      res.json({ rotation: 0 });
    }
  } catch (err) {
    if (err.code === 'EACCES') return res.status(500).json({ error: 'Permission denied' });
    res.status(500).json({ error: 'Failed to rotate: ' + err.message });
  }
});

app.post('/api/delete', requireAuth, (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0)
    return res.status(400).json({ error: 'Missing paths' });

  const results = { deleted: [], failed: [] };
  for (const rel of paths) {
    let abs;
    try { abs = safePath(rel); } catch { results.failed.push({ path: rel, error: 'Invalid path' }); continue; }
    if (!fs.existsSync(abs)) { results.failed.push({ path: rel, error: 'Not found' }); continue; }
    try {
      fs.unlinkSync(abs);
      results.deleted.push(rel);
      console.log(`[delete] ${abs}`);
    } catch (err) { results.failed.push({ path: rel, error: err.message }); }
  }
  res.json(results);
});

// ── CACHE STATS (optional debug endpoint) ───────────────────────────────────
app.get('/api/cache-stats', requireAuth, (req, res) => {
  const files = fs.readdirSync(CACHE_DIR);
  const size = files.reduce((s, f) => {
    try { return s + fs.statSync(path.join(CACHE_DIR, f)).size; } catch { return s; }
  }, 0);
  res.json({ count: files.length, sizeMB: (size / 1024 / 1024).toFixed(1) });
});

// ── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, 0.0.0.0, async () => {
  console.log(`Photo Explorer — http://localhost:${PORT}`);
  console.log(`[auth] Username: ${AUTH_USER}`);
  console.log(`[cache] Thumbnail cache: ${CACHE_DIR}`);
  try {
    const v = await exiftool.version();
    console.log(`[tools] exiftool ${v} — JPEG rotation via EXIF tag`);
  } catch (e) { console.error('[tools] exiftool failed:', e.message); }
});
