# Build stage: compile TypeScript to plain JS using the full dev toolchain.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: only ffmpeg, node, prod deps and the compiled output.
FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/downloads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

VOLUME ["/downloads"]
ENTRYPOINT ["node", "dist/index.js"]
