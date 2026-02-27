# 📷 Photo Explorer

A self-hosted, file-explorer-style photo gallery you can run on any machine or NAS with Docker. Browse your local photo library through a clean web UI — no cloud, no uploads, your files stay where they are.

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Docker](https://img.shields.io/badge/Docker-ready-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Tree navigation** — collapsible folder hierarchy in the left panel, just like Windows Explorer
- **Thumbnail grid** — click any folder to see all images inside it
- **Full-screen viewer** — double-click an image (or press Enter) to open it with a filmstrip navigator
- **Rotate images** — 90° left/right rotation per click, saved permanently into EXIF metadata (JPEGs) or losslessly re-encoded (PNG, WebP, TIFF, AVIF)
- **Smart thumbnail cache** — thumbnails are generated once and cached; cache is automatically invalidated when a file changes
- **Login protection** — simple username/password session auth with bcrypt-hashed passwords
- **Context menu** — right-click any thumbnail for quick actions
- **Resizable panels** — drag the divider between the tree and content area

## Supported Formats

JPG/JPEG · PNG · WebP · TIFF · AVIF

---

## Quick Start

### Option A — Pull from Docker Hub (recommended)

**1. Download the compose file**

```bash
curl -O https://raw.githubusercontent.com/yourusername/photo-explorer/main/docker-compose.yml
```

**2. Edit `docker-compose.yml`** — set your photo folder path and credentials:

```yaml
volumes:
  - /path/to/your/photos:/images   # ← your photos go here

environment:
  - PE_USERNAME=admin              # ← your chosen username
  - PE_PASSWORD=changeme          # ← your chosen password
  - PE_SESSION_SECRET=            # ← run: openssl rand -hex 32
```

**3. Start the container**

```bash
docker compose up -d
```

**4. Open your browser** at `http://localhost:5055`

---

### Option B — Build from source

```bash
git clone https://github.com/yourusername/photo-explorer.git
cd photo-explorer

# Edit docker-compose.yml as above, then:
docker compose up -d --build
```

---

## Volume Path Examples

| OS | Example |
|----|---------|
| Linux / Mac | `/home/alice/Pictures:/images` |
| Windows | `C:/Users/Alice/Pictures:/images` |
| Synology NAS | `/volume1/photo:/images` |
| QNAP NAS | `/share/Multimedia/Photos:/images` |

> **Read-only tip:** append `:ro` to the volume path if you want to prevent deletions from the UI — e.g. `/home/alice/Pictures:/images:ro`

---

## Configuration Reference

All configuration is done via environment variables in `docker-compose.yml`.

| Variable | Default | Description |
|----------|---------|-------------|
| `PE_USERNAME` | `admin` | Login username |
| `PE_PASSWORD` | `changeme` | Login password |
| `PE_SESSION_SECRET` | random | Secret used to sign session cookies. Set a fixed value so sessions survive container restarts. Generate with `openssl rand -hex 32` |

**Change the port** — edit the `ports` line:

```yaml
ports:
  - "3000:3000"   # Access at http://localhost:3000
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `← →` | Navigate images in viewer |
| `R` | Rotate right 90° |
| `L` | Rotate left 90° |
| `Enter` | Open selected image in viewer |
| `Escape` / `Backspace` | Return to grid view |
| `CTRL` / `SHIFT` | Multiple file selection |

---

## Architecture

```
Browser  →  Express (Node.js :3000)  →  /images  (your photo library, bind mount)
                                     →  /tmp/pe-thumbcache  (thumbnail cache, in-container)
```

- **Backend:** Node.js + Express
- **Image processing:** [sharp](https://sharp.pixelplumbing.com/) for thumbnails and lossless rotation of non-JPEG formats
- **EXIF handling:** [exiftool-vendored](https://github.com/photostructure/exiftool-vendored.js) for lossless JPEG rotation via EXIF `Orientation` tag (no re-encoding)
- **Auth:** `express-session` + `bcryptjs`
- **Thumbnail cache:** keyed by file path + mtime, stored in the container's `/tmp` — automatically busted on any file modification

---