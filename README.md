# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive. You pick a channel and a past show from the guide, and it saves that show so you can catch anything you missed.

For now it works with Xtream Codes providers (the most common kind, where you log in with a URL, username and password).

## Features

- Pick a past show from the channel's guide and download it.
- Type to filter both the channel list and the guide.
- Pad or trim the start and end of a recording, as a default or per-download.
- Name files however you like, including into subfolders.
- Stamps each file with the show's air time, so it sorts by air date in your media library.
- Live progress with download speed and ETA.
- Saves as `.ts`, which plays in VLC, Plex, Emby and Jellyfin. No transcoding, so it's quick.
- Runs with Docker or Node, nothing else to install.

## Setup

Create your `.env`:

```
cp .env.example .env
```

Fill in your provider's base URL (including port), username and password. See `.env.example` for the optional settings.

## Run with Docker (recommended)

There's a prebuilt image, so there's nothing to install. It's an interactive CLI, so run it with `-it`, pass your `.env`, and mount a folder for the downloads:

```
docker run -it --rm \
  --env-file .env \
  -v "$(pwd)/downloads:/downloads" \
  ghcr.io/scottrobertson/timeshifter:latest
```

Or with Docker Compose. Because it's an interactive CLI, use `run` (not `up`):

```yaml
services:
  timeshifter:
    image: ghcr.io/scottrobertson/timeshifter:latest
    environment:
      IPTV_URL: http://my-provider.com:8080
      IPTV_USERNAME: your-username
      IPTV_PASSWORD: your-password
    volumes:
      - ./downloads:/downloads
    stdin_open: true
    tty: true
```

```
docker compose run --rm timeshifter
```

## Run manually

Needs Node 20+ and [ffmpeg](https://ffmpeg.org/download.html) on your PATH (used to clean up the recording so it seeks properly):

```
npm install
npm start
```

## Notes / troubleshooting

- **403 / forbidden on download:** some providers block requests without a known player user agent. Set `IPTV_USER_AGENT` in `.env` (a VLC string is in the example).
- **Timeshift URL style:** most panels use the default path style. If downloads fail with a valid account, try `TIMESHIFT_MODE=php`.
- **Padding:** `PADDING_BEFORE_MINUTES` / `PADDING_AFTER_MINUTES` start the recording early and end it late, in case the guide times are off. A negative number does the opposite (starts late, ends early). These are the defaults; you can also change them per-download at the confirm prompt. A still-airing show's end is capped at the current time.
- **Filename:** set `FILENAME_TEMPLATE` to control how files are named. Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{ext}`. You can put shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`. Defaults to `{channel} - {title} - {datetime}.{ext}`.
- **File time:** the downloaded file's modified time is set to when the show aired, so it sorts by air date in a media library. Set `SET_AIRED_TIME=false` to keep the normal download time. In Emby/Jellyfin, set the library's "date added behavior" to use the file date for this to affect "date added" sorting.
- **Times** in the guide, filenames and the timeshift URL are all the provider's local time, which is what the endpoint expects. So no timezone conversion happens, and the label (e.g. `Europe/London`) shows which timezone those times are in.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
