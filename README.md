# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive, so you can catch anything you missed.

There are two ways to use it:

- **[Interactive mode](#interactive-mode-pick-a-show)** — you pick a channel and a past show from the guide, and it downloads it.
- **[Automatic downloads](#automatic-downloads-watch-mode)** — you leave `watch` running and it downloads for you, either from rules you set up (e.g. "every NASA launch") or from one-offs you picked out of the guide before they aired.

For now it works with Xtream Codes providers (the most common kind, where you log in with a URL, username and password).

## Features

- Pick a past show from the channel's guide and download it.
- Or pick a show that's still to come, and have it downloaded once, after it airs.
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

Everything timeshifter needs lives in one folder: `config` in the directory you run it from, or `/config` in the Docker image, which is the folder you mount there. Run it once and it writes a starter `config.json` in that folder for you to fill in, with your provider's base URL (including port), username, password, and where to save downloads:

```json
{
  "url": "http://my-provider.com:8080",
  "username": "your-username",
  "password": "your-password",
  "downloadDir": "/catchup"
}
```

If you've cloned the repo, `cp config/config.example.json config/config.json` gets you there with every optional field filled in as well.

The same folder is where `scheduled.json` ends up, which holds any [scheduled recordings](#scheduled-recordings). It's written for you, so you never need to create or edit it. A `comskip.ini` in there is picked up too, if you want to tune [commercial detection](#commercial-detection-edl).

> With Docker, mount the folder, never the files inside it. Docker creates a *directory* when you bind mount a file that isn't there yet, and then nothing can write to it.

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
| `watch` | — | Watch-mode rules. See [Subscriptions](#subscriptions). |

## Interactive mode (pick a show)

This is the default: it prompts you to pick a channel and a show, then downloads it. If you'd rather have shows download automatically, see [Automatic downloads](#automatic-downloads-watch-mode) below.

Pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

There's a prebuilt image, so there's nothing to install. It's an interactive CLI, so run it with `-it`, mount a folder at `/config` for `config.json` and `scheduled.json`, and mount a folder for the downloads (set `downloadDir` in the config to wherever you mount it, e.g. `/catchup`):

```
docker run -it --rm \
  -v "$(pwd)/config:/config" \
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
      - ./config:/config
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

## Automatic downloads (watch mode)

`watch` is a long-running process that re-checks the guide every few minutes and downloads whatever is due. It gets its work from two places, and either one on its own is fine:

- **[Subscriptions](#subscriptions)** are standing rules in `config.json`, like "every NASA launch". Good for anything you always want.
- **[Scheduled recordings](#scheduled-recordings)** are one-offs you pick out of the guide before they air. Good for a game that's on later in the week.

Both download **after** the show has finished, not while it's on. Catchup is served by time, so the footage has to exist before it can be asked for.

### Subscriptions

Let timeshifter watch the guide and download anything that matches a set of rules, as soon as it has finished airing. Add a `watch` block to your `config.json` (see `config/config.example.json`):

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

### Scheduled recordings

For a one off, like a game that's on later in the week, pick it out of the guide before it airs and forget about it. You don't need any subscriptions in `config.json` for this, or even a `watch` block.

**Nothing happens until the watcher is running.** It's the thing that notices the slot has passed and does the download, so leave it running as [below](#running-the-watcher). You can schedule a show while it's running and it'll be picked up on the next poll.

Setting one up is [interactive mode](#interactive-mode-pick-a-show) with `schedule` on the end, so pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

```
docker run -it --rm \
  -v "$(pwd)/config:/config" \
  -v "$(pwd)/downloads:/catchup" \
  ghcr.io/scottrobertson/timeshifter:latest schedule
```

</details>

<details>
<summary><strong>Run with Docker Compose</strong></summary>

`run` starts a one-off container from a service you've already defined, with the same mounts, and what you pass replaces that service's `command`. It's fine to do this while the watcher is up, you just get a second container for as long as you're picking:

```
docker compose run --rm timeshifter schedule
```

</details>

<details>
<summary><strong>Run with npm</strong></summary>

```
npm start schedule
```

</details>

That's where you set them up, see what's coming, and drop any you've changed your mind about:

```
  pending 2026-09-05 19:30  NASA TV  Artemis II Launch   ·  ready 2026-09-05 22:30
  done    2026-09-01 14:00  NASA TV  Press Conference    ·  /catchup/NASA TV - Press Conference - 2026-09-01_14-00.ts

? What do you want to do?
> Schedule a show
  Remove one
  Quit
```

Choose "Schedule a show" and you pick a channel, then a show from the ones still to come.

You can also get there from the normal flow: run `timeshifter` and shows that haven't started yet are in the list alongside the past ones, marked `[upcoming — schedule]`.

```
Pick a program (type to filter):
> 2026-09-05 19:30-22:00 · Artemis II Launch   [upcoming — schedule]
  2026-09-05 14:00-15:00 · Mission Briefing    [upcoming — schedule]
  2026-09-04 09:00-10:30 · Crew Arrival        [now airing — partial]
  2026-09-03 18:00-20:00 · Press Conference
```

Either way you get the usual plan, with a `Ready` line saying when it'll be downloaded. Adjust the padding, edit the filename, or flip the `.nfo` and comskip, then choose Schedule.

```
  Channel:  NASA TV
  Program:  Artemis II Launch
  Airs:     2026-09-05 19:30
  Ends:     2026-09-05 22:00
  Runtime:  150 min

  Padding:  5 min before, 30 min after
  Start:    2026-09-05 19:25
  End:      2026-09-05 22:30
  Length:   185 min
  Ready:    2026-09-05 22:30
  Saving:   /catchup/NASA TV - Artemis II Launch - 2026-09-05_19-30.ts
  .nfo:     write
  comskip:  run
```

`Ready` is the show's end plus your after-padding (plus `readyGraceMinutes`, if you've set one).

Some things worth knowing:

- **It records the time slot, not the show.** Picking a show is just a convenient way to choose a start and end. Whatever is on that channel between those times is what you get, so if the schedule slips, pad it out. The guide isn't consulted again once it's scheduled.
- If the download doesn't work, it's retried on every poll for 48 hours after the slot ended, then given up on and marked `expired`.
- Padding, `.nfo` and comskip are saved per recording only if you changed them at the prompt. Leave them alone and they follow your `config.json`, so a later edit there still applies. Same for the filename: edit it and that exact name is used, otherwise it's built from `filenameTemplate` when the download happens.
- Finished ones stay in the list for 30 days so you can see what happened, then the entry drops out of `scheduled.json`. That only tidies the list. The recording itself is never deleted.

### Running the watcher

This is the part that does the downloading, for subscriptions and scheduled recordings alike. It won't re-download a show whose file is already in the download dir, so it's safe to leave running and to restart. `config.json` is re-read at the start of every poll, so you can edit your subscriptions without restarting (if you save a broken file, it keeps using the last good one). To see what it would grab without downloading anything, append `--dry-run` to any of the commands below.

Pick whichever way to run suits you:

<details>
<summary><strong>Run with Docker</strong></summary>

It's a long-running process, so run it detached (no `-it`):

```
docker run -d --restart unless-stopped \
  -v "$(pwd)/config:/config" \
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
      - ./config:/config
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
- This is the global default. Each subscription can override it with its own `comskip` (see [Subscriptions](#subscriptions)), so you can leave it on for most and turn it off on the odd one, or the other way around. In interactive mode you can also flip it on or off per download at the confirm prompt.
- The Docker image bundles comskip, so `"comskip": true` works out of the box. Running with Node instead, install comskip yourself and either put it on your `PATH` or point `COMSKIP_PATH` at the binary.
- `COMSKIP_PATH` overrides which comskip binary is used, if you want a specific build.
- Detection runs with comskip's defaults, from a minimal built-in `comskip.ini` that just turns on `.edl` output. To tune it, put your own `comskip.ini` next to `config.json` and it's used instead. `COMSKIP_INI` points at one somewhere else, if you'd rather.

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
- **Config folder:** `config` in the directory you run from, or `/config` in the Docker image. Set `TIMESHIFTER_CONFIG_DIR` to put `config.json`, `scheduled.json` and `comskip.ini` somewhere else.
- **Timezone:** set the `TZ` environment variable (e.g. `Europe/London`) to control the timezone of the watch-mode log timestamps; it defaults to UTC. The Docker image bundles the zone data. Guide and recording times are unaffected; they always use the provider's own local time, which is what the endpoint expects, so no timezone conversion happens.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
