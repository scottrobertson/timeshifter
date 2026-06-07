# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive, so you can catch anything you missed.

There are two ways to run it:

- **[Interactive mode](#interactive-mode-pick-a-show)** — you pick a channel and a past show from the guide, and it downloads it.
- **[Watch mode](#watch-mode-automatic-downloads)** — you set up rules (e.g. "every F1 race") and it downloads matching shows automatically as soon as they air.

For now it works with Xtream Codes providers (the most common kind, where you log in with a URL, username and password).

## Features

- Pick a past show from the channel's guide and download it.
- Or run `watch` mode to download matching shows automatically as soon as they air.
- Type to filter both the channel list and the guide.
- Pad or trim the start and end of a recording, as a default or per-download.
- Name files however you like, including into subfolders.
- Stamps each file with the show's air time, so it sorts by air date in your media library.
- Live progress with download speed and ETA.
- Saves as `.ts`, which plays in VLC, Plex, Emby and Jellyfin. No transcoding, so it's quick.
- Runs as a Docker image (ffmpeg bundled), or directly with Node and ffmpeg.

## Setup

Create your `.env`:

```
cp .env.example .env
```

Fill in your provider's base URL (including port), username and password. See `.env.example` for the optional settings.

## Interactive mode (pick a show)

This is the default: it prompts you to pick a channel and a show, then downloads it. If you'd rather have shows download automatically, see [Watch mode](#watch-mode-automatic-downloads) below.

Pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

There's a prebuilt image, so there's nothing to install. It's an interactive CLI, so run it with `-it`, pass your `.env`, and mount a folder for the downloads:

```
docker run -it --rm \
  --env-file .env \
  -v "$(pwd)/downloads:/downloads" \
  ghcr.io/scottrobertson/timeshifter:latest
```

</details>

<details>
<summary><strong>Run with Docker Compose</strong></summary>

Because it's an interactive CLI, use `run` (not `up`):

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

</details>

<details>
<summary><strong>Run with npm</strong></summary>

Needs Node 20+ and [ffmpeg](https://ffmpeg.org/download.html) on your PATH (used to clean up the recording so it seeks properly):

```
npm install
npm start
```

</details>

## Watch mode (automatic downloads)

Instead of picking shows by hand, you can let timeshifter watch the guide and download anything that matches a set of rules, as soon as it has finished airing. Good for "grab every F1 race" type things.

Create a `subscriptions.json` (see `subscriptions.example.json`):

```json
{
  "pollIntervalMinutes": 10,
  "subscriptions": [
    {
      "name": "F1 races",
      "channel": "UK: Sky Sports F1 FHD",
      "titleContains": ["Formula 1", "ᴸᶦᵛᵉ"],
      "from": "2026-06-01",
      "paddingBefore": 5,
      "paddingAfter": 30
    }
  ]
}
```

- `channel` is the channel's exact name (case-insensitive), as shown in the interactive channel list, e.g. `"UK: Sky Sports F1 FHD"`.
- `titleContains` must **all** appear in the title, and `titleExcludes` (optional) must **not**. Matching is case-insensitive.
- `from` (optional) only downloads shows that finish after that date. Leave it out to grab everything currently in the channel's archive.
- `paddingBefore` / `paddingAfter` (optional) override the global padding for this rule.
- `pollIntervalMinutes` (default 10) is how often the guide is re-checked. `readyGraceMinutes` (default 0) adds an extra wait after a show ends before downloading, if your provider is slow to make catchup available.

It won't re-download a show whose file is already in the download dir, so it's safe to leave running and to restart. To see what it would grab without downloading anything, append `--dry-run` to any of the commands below.

Then pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

It's a long-running process, so run it detached (no `-it`) and mount the subscriptions file:

```
docker run -d --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/downloads:/downloads" \
  -v "$(pwd)/subscriptions.json:/app/subscriptions.json:ro" \
  ghcr.io/scottrobertson/timeshifter:latest watch
```

</details>

<details>
<summary><strong>Run with Docker Compose</strong></summary>

It's a long-running service, so use `up -d`:

```yaml
services:
  timeshifter:
    image: ghcr.io/scottrobertson/timeshifter:latest
    command: watch
    restart: unless-stopped
    environment:
      IPTV_URL: http://my-provider.com:8080
      IPTV_USERNAME: your-username
      IPTV_PASSWORD: your-password
    volumes:
      - ./downloads:/downloads
      - ./subscriptions.json:/app/subscriptions.json:ro
```

```
docker compose up -d timeshifter
```

</details>

<details>
<summary><strong>Run with npm</strong></summary>

Needs Node 20+ and [ffmpeg](https://ffmpeg.org/download.html) on your PATH:

```
npm install
npm start watch
```

</details>

## Notes / troubleshooting

- **403 / forbidden or dropped downloads:** requests are sent with a VLC user agent by default, since many providers block or cut off clients that don't look like a real player. If yours expects something specific, override it with `IPTV_USER_AGENT` in `.env`.
- **Timeshift URL style:** most panels use the default path style. If downloads fail with a valid account, try `TIMESHIFT_MODE=php`.
- **Padding:** `PADDING_BEFORE_MINUTES` / `PADDING_AFTER_MINUTES` start the recording early and end it late, in case the guide times are off. A negative number does the opposite (starts late, ends early). These are the defaults; you can also change them per-download at the confirm prompt. A still-airing show's end is capped at the current time.
- **Filename:** set `FILENAME_TEMPLATE` to control how files are named. Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{ext}`. You can put shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`. Defaults to `{channel} - {title} - {datetime}.{ext}`.
- **File time:** the downloaded file's modified time is set to when the show aired, so it sorts by air date in a media library. Set `SET_AIRED_TIME=false` to keep the normal download time. In Emby/Jellyfin, set the library's "date added behavior" to use the file date for this to affect "date added" sorting.
- **Times** in the guide, filenames and the timeshift URL are all the provider's local time, which is what the endpoint expects. So no timezone conversion happens, and the label (e.g. `Europe/London`) shows which timezone those times are in.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
