# Pinned to match .tool-versions.
FROM rust:1.99-trixie AS build
ARG TAILWIND_VERSION=v4.3.3
ARG TARGETARCH
RUN case "$TARGETARCH" in arm64) arch=arm64 ;; *) arch=x64 ;; esac \
 && curl -fsSL -o /usr/local/bin/tailwindcss \
    "https://github.com/tailwindlabs/tailwindcss/releases/download/${TAILWIND_VERSION}/tailwindcss-linux-${arch}" \
 && chmod +x /usr/local/bin/tailwindcss
WORKDIR /app
# Build the dependencies against an empty main first, so Docker can cache them and a
# code change only recompiles timeshifter itself.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY build.rs ./
COPY migrations migrations
COPY src src
COPY styles styles
COPY templates templates
COPY static static
# Copied files can be older than the placeholder build, so cargo would skip them without the touch.
RUN touch src/main.rs && cargo build --release

# comskip, built from source. Debian packages both of its awkward dependencies, so it's a
# plain apt install and a standard autotools build. Same Debian as the final image, so the
# libraries it links against are the ones that ship.
FROM debian:trixie-slim AS comskip
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

FROM debian:trixie-slim
# ffmpeg cleans up each recording so it seeks properly. tini passes signals on, so
# stopping the container is quick. tzdata lets TZ work for the times on the page.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg tini tzdata libargtable2-0 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=comskip /usr/local/bin/comskip /usr/local/bin/comskip
COPY --from=build /app/target/release/timeshifter /usr/local/bin/timeshifter
ENV COMSKIP_PATH=/usr/local/bin/comskip
# The database lives here, and an old config.json or scheduled.json in it is imported on
# first start. Mount one folder, not single files.
ENV TIMESHIFTER_CONFIG_DIR=/config
RUN mkdir -p /config
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "timeshifter"]
