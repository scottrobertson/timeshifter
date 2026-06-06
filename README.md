# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive. You pick a channel and a past show from the guide, and it saves that show so you can catch anything you missed.

For now it works with Xtream Codes providers (the most common kind, where you log in with a URL, username and password).

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

Needs Node 20+:

```
npm install
npm start
```

## Notes / troubleshooting

- **Recordings are saved as `.ts`.** That's what the provider serves, and it plays fine in VLC, Plex, Emby and Jellyfin. The download is a plain file copy (no transcoding), so it's quick.
- **403 / forbidden on download:** some providers block requests without a known player user agent. Set `IPTV_USER_AGENT` in `.env` (a VLC string is in the example).
- **Timeshift URL style:** most panels use the default path style. If downloads fail with a valid account, try `TIMESHIFT_MODE=php`.
- **Padding:** set `PADDING_BEFORE_MINUTES` / `PADDING_AFTER_MINUTES` to start a bit early and run a bit long, in case the guide times are off. A still-airing show's end padding is capped at "now".
- **Filename:** set `FILENAME_TEMPLATE` to control how files are named. Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{ext}`. You can put shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`. Defaults to `{channel} - {title} - {datetime}.{ext}`.
- **File time:** the downloaded file's modified time is set to when the show aired, so it sorts by air date in a media library. Set `SET_AIRED_TIME=false` to keep the normal download time. In Emby/Jellyfin, set the library's "date added behavior" to use the file date for this to affect "date added" sorting.
- **Times** shown in the guide are the provider's local time, which is what the timeshift URL needs, so no timezone conversion is done.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
