# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days. timeshifter lets you download from that archive, so you can catch anything you missed.

It's a small web app you leave running. You can:

- **Download a show** that already aired, picked from a channel's guide.
- **Schedule a show** that hasn't aired yet. It downloads on its own once it has.
- **Subscribe** to shows by title, like "every NASA launch", and they download as they air.

For now it works with Xtream Codes providers (the most common kind, where you log in with a server address, username and password).

## Features

- Browse every channel that keeps an archive, and its guide, with instant filtering.
- Pad or trim the start and end of a recording, as a default, per subscription, or per download.
- Name files however you like, including into folders.
- Dates each file by when the show aired, so it sorts by air date in your media library.
- Writes a `.nfo` next to each recording, so Emby, Jellyfin, Kodi and Silo pick up the title, description, air date and runtime.
- Optional ad break detection with comskip, written as a `.edl` that media servers use to skip them.
- Everything runs as a background job you can watch live, stop, and look back on, with a full log for each one.
- Saves as `.ts`, cleaned up with ffmpeg so it seeks properly. No transcoding, so it's quick.
- Works properly on a phone.

There's no login. Run it somewhere only you can reach, like your home network or Tailscale.

## Running it

There's a prebuilt Docker image with ffmpeg and comskip included. Mount a folder at `/config` for timeshifter's database, and one for your recordings:

```yaml
services:
  timeshifter:
    image: ghcr.io/scottrobertson/timeshifter:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      TZ: Europe/London # for times shown on the page; optional
    volumes:
      - ./config:/config
      - ./downloads:/catchup
```

```
docker compose up -d
```

Open http://localhost:8080, go to **Settings**, and fill in your provider's server address (including the port), username and password. Use **Test connection** to check them. Set the download folder to wherever you mounted your recordings, `/catchup` in the example above.

### Coming from the command line version

Point the new image at the same config folder. On first start, timeshifter brings over your `config.json` (settings and subscriptions) and `scheduled.json`. After that, everything is changed in the web app, and those files aren't read again.

## How it works

### The guide check

Every few minutes (10 by default, set in Settings) timeshifter reads the guide for each subscription and scheduled recording, and queues a download for anything that's ready. **Check now** on the Overview page does the same thing straight away.

Shows download **after** they've finished, not while they're on. Catchup is served by time, so the footage has to exist before it can be asked for. A show counts as ready once it has ended, plus any padding after it, plus the **Extra wait** from Settings if your provider is slow to make catchup available.

It won't download a show whose file is already in the download folder, so it's safe to restart, and safe to point at a folder you already have recordings in. Recordings already there still get their `.nfo` refreshed, and their `.edl` if comskip is on.

### Subscriptions

A subscription is a channel and some words. Every word in **Title contains** has to be in the title, and none of the words in **But not** can be. Case doesn't matter. **From** skips anything that finished before that date, otherwise it takes everything in the archive.

Each subscription can override the padding, filename, `.nfo` and comskip settings. Use a filename with a folder, like `NASA/{title} {date}.{ext}`, to keep a subscription's recordings together.

The subscription's page shows what it matches in the guide right now, so you can check the words pick out the right shows.

### Scheduled recordings

Open a channel, switch to **Coming up**, and pick a show. A scheduled recording records the time slot you picked, whatever the guide says later, so pad it out if the schedule tends to slip.

If the download keeps failing, it's tried again on every check for 48 hours after the show ended, then given up on. Finished ones stay on the Scheduled page for 30 days. Removing one from the list never deletes the recording.

### Filenames

The filename template fills in `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{year}`, `{month}`, `{day}` and `{ext}`. Month and day are zero padded. The default is `{channel} - {title} - {datetime}.{ext}`.

**Remove from titles** takes out junk the guide adds to titles, like `ᴸᶦᵛᵉ`. It only changes the filename. Changing it changes filenames, so subscriptions may download shows again under the new name.

### Commercial detection

Turn on comskip in Settings, per subscription, or per download. It runs after each download as its own job, so a long comskip run doesn't hold up the next download. It writes a `.edl` next to the recording, which Plex, Emby, Jellyfin and Kodi read to skip the ad breaks. A recording with no breaks still gets an empty `.edl`, so it isn't processed again.

Detection uses comskip's defaults. To tune it, put your own `comskip.ini` in the config folder, or point `COMSKIP_INI` at one.

## Configuration

Almost everything is set in the web app. These environment variables are for the container itself:

| Variable | Default | What it does |
| --- | --- | --- |
| `TIMESHIFTER_CONFIG_DIR` | `/config` in Docker, `config` otherwise | Where the database lives, and where an old `config.json` is imported from |
| `PORT` | `8080` | The port the web app listens on |
| `TZ` | UTC | The timezone for times shown on the page. Guide times always use your provider's own timezone, which is what the catchup endpoint expects |
| `COMSKIP_PATH` | the bundled build | A different comskip binary |
| `COMSKIP_INI` | `comskip.ini` in the config folder, if there is one | Your own comskip settings |

## Troubleshooting

- **403s or dropped downloads:** many providers block clients that don't look like a real player, so requests use a VLC user agent by default. Change it under Settings, Advanced, if yours expects something else.
- **Downloads fail with a login that works:** try the other catchup URL style under Settings, Advanced. Most providers use the path style, a few older ones use `timeshift.php`.
- **A show is listed but not in the archive:** the provider only marks shows as archived once they've aired, and only for as many days as the channel keeps.
- **Media library sorting:** in Emby or Jellyfin, set the library's "date added behavior" to use the file date, so the aired date timeshifter sets is used.

## Developing

See [CLAUDE.md](CLAUDE.md).

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
