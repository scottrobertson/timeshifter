# Build stage: compile TypeScript to plain JS using the full dev toolchain.
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: ffmpeg (remuxes the .ts so it seeks), node, prod deps, output.
FROM node:26-alpine
# tini runs as PID 1 and forwards signals, so Ctrl-C works (node as PID 1 doesn't).
RUN apk add --no-cache ffmpeg tini
WORKDIR /app
ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/downloads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

VOLUME ["/downloads"]
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
