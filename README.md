# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive, so you can catch anything you missed.

There are two ways to run it:

- **[Interactive mode](#interactive-mode-pick-a-show)** — you pick a channel and a past show from the guide, and it downloads it.
- **[Watch mode](#watch-mode-automatic-downloads)** — you set up rules (e.g. "every NASA launch") and it downloads matching shows automatically as soon as they air.

For now it works with Xtream Codes providers (the most common kind, where you log in with a URL, username and password).

## Features

- Pick a past show from the channel's guide and download it.
- Or run `watch` mode to download matching shows automatically as soon as they air.
- Type to filter both the channel list and the guide.
- Pad or trim the start and end of a recording, as a default or per-download.
- Name files however you like, including into subfolders.
- Stamps each file with the show's air time, so it sorts by air date in your media library.
- Writes a `.nfo` metadata file next to each recording, so Emby, Jellyfin and Kodi pick up the title, description, air date, runtime and (when the guide includes it) the season and episode number.
- Live progress with download speed and ETA.
- Saves as `.ts`, which plays in VLC, Plex, Emby and Jellyfin. No transcoding, so it's quick.
- Runs as a Docker image (ffmpeg bundled), or directly with Node and ffmpeg.

## Setup

Everything lives in a single `config.json` in the working directory. Copy the example and fill in your provider's base URL (including port), username, password, and where to save downloads:

```json
{
  "url": "http://my-provider.com:8080",
  "username": "your-username",
  "password": "your-password",
  "downloadDir": "/catchup"
}
```

If you've cloned the repo, run `cp config.example.json config.json` and edit it.

`url`, `username`, `password` and `downloadDir` are required. Everything else is optional:

| Field | Default | What it does |
| --- | --- | --- |
| `downloadDir` | (required) | Where recordings are saved. Can be relative or absolute. |
| `userAgent` | `VLC/3.0.18 LibVLC/3.0.18` | User agent sent with every request. Many panels drop clients that don't look like a real player, so a VLC string is the default. |
| `timeshiftMode` | `path` | Timeshift URL style. Most panels use `path`; a few older ones use `php`. |
| `paddingBefore` / `paddingAfter` | `0` | Minutes added before the start and after the end of each recording, in case the guide times are off. A negative number does the opposite (starts late, ends early). You can also change these per-download at the confirm prompt. |
| `filenameTemplate` | `{channel} - {title} - {datetime}.{ext}` | How files are named. Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{year}`, `{month}`, `{day}` (month and day zero-padded), `{ext}`. Supports subfolders, e.g. `{channel}/{title} - {date}.{ext}`. |
| `filenameStrip` | `[]` | Strings to remove from the title when building the filename, e.g. `["ᴸᶦᵛᵉ"]` for a live badge the EPG tacks on. Leftover double spaces are tidied up. Only affects the filename; show lists and the `.nfo` keep the original title. Note that changing it changes the filenames, so watch mode may re-download shows it already has under the old name. |
| `setAiredTime` | `true` | Set the file's modified time to when the show aired, so it sorts by air date in a media library. Set to `false` to keep the download time. |
| `writeNfo` | `true` | Write a `.nfo` metadata file next to each recording (title, description, air date, runtime, and season/episode when the guide includes it) so Emby, Jellyfin and Kodi read it instead of guessing from the filename. Set to `false` to skip it. You can also flip this per-download at the confirm prompt. |
| `comskip` | `false` | Run [comskip](https://github.com/erikkaashoek/Comskip) on each recording to write a `.edl` commercial-skip file next to it. You can also flip this per-download at the confirm prompt. See [Commercial detection](#commercial-detection-edl). |
| `watch` | — | Watch-mode rules. See [Watch mode](#watch-mode-automatic-downloads). |

## Interactive mode (pick a show)

This is the default: it prompts you to pick a channel and a show, then downloads it. If you'd rather have shows download automatically, see [Watch mode](#watch-mode-automatic-downloads) below.

Pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

There's a prebuilt image, so there's nothing to install. It's an interactive CLI, so run it with `-it`, mount your `config.json`, and mount a folder for the downloads (set `downloadDir` in the config to wherever you mount it, e.g. `/catchup`):

```
docker run -it --rm \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  -v "$(pwd)/downloads:/catchup" \
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
    volumes:
      - ./config.json:/app/config.json:ro
      - ./downloads:/catchup
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

Instead of picking shows by hand, you can let timeshifter watch the guide and download anything that matches a set of rules, as soon as it has finished airing. Good for "grab every NASA launch" type things.

Add a `watch` block to your `config.json` (see `config.example.json`):

```json
{
  "url": "http://my-provider.com:8080",
  "username": "your-username",
  "password": "your-password",
  "downloadDir": "/catchup",
  "watch": {
    "pollIntervalMinutes": 10,
    "subscriptions": [
      {
        "name": "NASA launches",
        "channel": "NASA TV",
        "titleContains": ["Launch", "Live"],
        "from": "2026-06-01",
        "paddingBefore": 5,
        "paddingAfter": 30
      }
    ]
  }
}
```

- `channel` is the channel's exact name (case-insensitive), as shown in the interactive channel list, e.g. `"NASA TV"`.
- `titleContains` must **all** appear in the title, and `titleExcludes` (optional) must **not**. Matching is case-insensitive.
- `from` (optional) only downloads shows that finish after that date. Leave it out to grab everything currently in the channel's archive.
- `paddingBefore` / `paddingAfter` (optional) override the global padding for this rule.
- `filenameTemplate` (optional) overrides the global `filenameTemplate` for this rule, so you can sort each subscription into its own folder, e.g. `"NASA/{title} - {date}.{ext}"`.
- `filenameStrip` (optional) overrides the global `filenameStrip` for this rule.
- `comskip` (optional) overrides the global `comskip` for this rule, either way: set `false` to turn it off on a subscription even when it's on globally, or `true` to turn it on for just this one.
- `pollIntervalMinutes` (default 10) is how often the guide is re-checked. `readyGraceMinutes` (default 0) adds an extra wait after a show ends before downloading, if your provider is slow to make catchup available.

It won't re-download a show whose file is already in the download dir, so it's safe to leave running and to restart. `config.json` is re-read at the start of every poll, so you can edit your subscriptions without restarting (if you save a broken file, it keeps using the last good one). To see what it would grab without downloading anything, append `--dry-run` to any of the commands below.

Then pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

It's a long-running process, so run it detached (no `-it`). The subscriptions live in `config.json`, so there's just the one file to mount:

```
docker run -d --restart unless-stopped \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  -v "$(pwd)/downloads:/catchup" \
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
      TZ: Europe/London # for the log timestamps; optional
    volumes:
      - ./config.json:/app/config.json:ro
      - ./downloads:/catchup
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

## Commercial detection (.edl)

Set `"comskip": true` to run [comskip](https://github.com/erikkaashoek/Comskip) on each recording. It detects the ad breaks and writes a `.edl` file next to the recording (e.g. `NASA TV - Artemis II Launch - 2026-06-01_18-30.edl`), which Plex, Emby, Jellyfin and Kodi read to skip or mark the commercials.

```json
{
  "url": "http://my-provider.com:8080",
  "username": "your-username",
  "password": "your-password",
  "downloadDir": "/catchup",
  "comskip": true
}
```

- It runs after the download, so it adds some processing time per recording (comskip reads the whole file).
- In watch mode it also **backfills**: any recording already in your download dir that's missing a `.edl` gets one on the next poll, then it's left alone.
- This is the global default. Each subscription can override it with its own `comskip` (see [Watch mode](#watch-mode-automatic-downloads)), so you can leave it on for most and turn it off on the odd one, or the other way around. In interactive mode you can also flip it on or off per download at the confirm prompt.
- The Docker image bundles comskip, so `"comskip": true` works out of the box. Running with Node instead, install comskip yourself and either put it on your `PATH` or point `COMSKIP_PATH` at the binary.
- `COMSKIP_PATH` overrides which comskip binary is used, if you want a specific build.
- Detection runs with comskip's defaults. To tune it, point `COMSKIP_INI` at your own `comskip.ini`; otherwise a minimal built-in one is used that just turns on `.edl` output.

## Notes / troubleshooting

- **403 / forbidden or dropped downloads:** requests are sent with a VLC user agent by default, since many providers block or cut off clients that don't look like a real player. If yours expects something specific, set `userAgent` in `config.json`.
- **Timeshift URL style:** most panels use the default path style. If downloads fail with a valid account, try `"timeshiftMode": "php"`.
- **Padding:** `paddingBefore` / `paddingAfter` start the recording early and end it late, in case the guide times are off. A negative number does the opposite (starts late, ends early). These are the defaults; you can also change them per-download at the confirm prompt. A still-airing show's end is capped at the current time.
- **Filename:** set `filenameTemplate` to control how files are named. Defaults to `{channel} - {title} - {datetime}.{ext}`.
  - Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{year}`, `{month}`, `{day}`, `{ext}`. Month and day are zero-padded (`03`, not `3`).
  - You can put shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`.
  - Set `filenameStrip` (globally or per subscription) to remove junk the EPG adds to titles, e.g. `["ᴸᶦᵛᵉ"]`. It only affects the filename.
- **File time:** the downloaded file's modified time is set to when the show aired, so it sorts by air date in a media library. Set `"setAiredTime": false` to keep the normal download time. In Emby/Jellyfin, set the library's "date added behavior" to use the file date for this to affect "date added" sorting.
- **.nfo metadata:** a `.nfo` file is written next to each recording with the title, description, air date and runtime, so Emby, Jellyfin and Kodi use that instead of guessing from the filename. When the guide prefixes the description with a season/episode marker (e.g. `S21 E8`), that's pulled out into proper season and episode fields. In watch mode it's also created or refreshed for recordings you already have. Set `"writeNfo": false` to turn it off. In interactive mode you can also flip it on or off per download at the confirm prompt.
- **Timezone:** set the `TZ` environment variable (e.g. `Europe/London`) to control the timezone of the watch-mode log timestamps; it defaults to UTC. The Docker image bundles the zone data. Guide and recording times are unaffected; they always use the provider's own local time, which is what the endpoint expects, so no timezone conversion happens.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
