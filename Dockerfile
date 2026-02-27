FROM node:20-alpine

RUN apk add --no-cache \
    vips-dev \
    python3 \
    make \
    g++ \
    perl \
    exiftool

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
