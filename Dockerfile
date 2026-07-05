# Build stage: compile TypeScript to plain JS using the full dev toolchain.
FROM node:26-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# comskip build stage: build comskip from source. Debian packages both of its
# awkward deps (argtable2 and the ffmpeg dev libs), so it's a plain apt install
# plus a standard autotools build.
FROM node:26-bookworm-slim AS comskip
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates build-essential autoconf automake libtool pkg-config git \
      libargtable2-dev libavformat-dev libavcodec-dev libavutil-dev libswscale-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/erikkaashoek/Comskip /src/comskip \
 && cd /src/comskip \
 && ./autogen.sh \
 && ./configure \
 && make \
 && cp comskip /usr/local/bin/comskip

# Runtime stage: ffmpeg (remuxes the .ts so it seeks), node, prod deps, output.
FROM node:26-bookworm-slim
# tini runs as PID 1 and forwards signals, so Ctrl-C works (node as PID 1 doesn't).
# tzdata lets the TZ env var resolve, so log timestamps use your local time.
# libargtable2-0 is comskip's one runtime dep; ffmpeg pulls the libav* libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tini tzdata libargtable2-0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# Bundled comskip, so "comskip": true works with no extra setup.
COPY --from=comskip /usr/local/bin/comskip /usr/local/bin/comskip
ENV COMSKIP_PATH=/usr/local/bin/comskip

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/index.js"]
