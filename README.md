# timeshifter

Download timeshift (catchup) recordings from an Xtream Codes IPTV provider. You
pick a channel and a past show from the program guide, and it records that show
to a file so you can grab anything you missed.

## How it works

Xtream Codes providers expose a catchup archive for some channels (usually a few
days back). This tool:

1. Authenticates against the provider's `player_api.php`.
2. Lists channels that have an archive.
3. Pulls the EPG (guide) for the channel you pick.
4. Works out the start time and length of the show you choose, builds the
   timeshift URL, and records it with ffmpeg.

## Requirements

- Node 20+ (built on 24).
- [ffmpeg](https://ffmpeg.org/) on your PATH for the download step:
  ```
  brew install ffmpeg
  ```

## Setup

```
npm install
cp .env.example .env
```

Fill in `.env` with your provider's base URL (including port), username and
password. See `.env.example` for the optional settings.

## Usage

```
npm start
```

You'll get:

1. A searchable list of channels that have an archive.
2. A list of past shows from that channel's guide.
3. A confirmation, then ffmpeg records the show into `./downloads`.

When it finishes it runs `ffprobe` on the file and prints the recorded length,
warning if it came out noticeably shorter than requested.

## Docker

The image bundles ffmpeg, so you don't need it installed locally.

Pull the prebuilt image (published to GHCR on every push to `main`):

```
docker pull ghcr.io/scottrobertson/timeshifter:latest
```

Or build it yourself:

```
docker build -t timeshifter .
```

It's an interactive CLI, so run it with `-it`, pass your `.env`, and mount a
folder for the downloads (the image writes to `/downloads`):

```
docker run -it --rm \
  --env-file .env \
  -v "$(pwd)/downloads:/downloads" \
  timeshifter
```

Multi-stage build on Alpine: TypeScript is compiled in a builder stage and the
final image ships only ffmpeg, node, the production deps and the compiled JS.

## Notes / troubleshooting

- **403 / forbidden on download:** some providers block requests without a known
  player user agent. Set `IPTV_USER_AGENT` in `.env` (a VLC string is in the
  example).
- **Output format:** defaults to `ts` (raw stream, no remux, plays fine in VLC
  and Plex). Set `OUTPUT_FORMAT=mp4` if you'd rather have an MP4 (it remuxes with
  `-c copy`, no re-encode).
- **Timeshift URL style:** most panels use the default path style. If downloads
  fail with a valid account, try `TIMESHIFT_MODE=php`.
- **Padding:** set `PADDING_BEFORE_MINUTES` / `PADDING_AFTER_MINUTES` to start a
  bit early and run a bit long, in case the guide times are off. A still-airing
  show's end padding is capped at "now".
- **Filename:** set `FILENAME_TEMPLATE` to control how files are named. Tokens:
  `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{ext}`. You can put
  shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`. Defaults to
  `{channel} - {title} - {datetime}.{ext}`.
- **ffmpeg warnings during download:** lines like `non-existing PPS`, `no frame!`,
  `Packet corrupt` and `timestamp discontinuity` are normal for timeshift TS
  streams. You join the stream mid-GOP and the provider stitches archive segments
  together, so the timestamps jump and the odd packet is corrupt. ffmpeg copies
  through it. By default these are hidden behind a clean progress line; set
  `VERBOSE=true` to see ffmpeg's full output. The duration check at the end is the
  real test of whether the recording is complete.
- **Times** shown in the guide are the provider's local time, which is what the
  timeshift URL needs, so no timezone conversion is done.
- M3U-only providers aren't supported here. The EPG + timeshift flow needs the
  Xtream API.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
