# timeshifter

Most IPTV providers keep a catchup archive for their channels, usually going back a few days.

timeshifter lets you download from that archive. You pick a channel and a past show from the guide, and it saves that show so you can catch anything you missed.

## Setup

Create your `.env`:

```
cp .env.example .env
```

Then configure one of two ways:

- **M3U playlist:** set `M3U_URL` to your playlist URL. The channel list comes from the playlist. For the guide, if the playlist is Xtream-backed (its stream URLs contain the host/username/password, as most are), the provider's API is used so you get the full past guide that catchup needs. Otherwise it falls back to the playlist's EPG, which often only lists upcoming programs.
- **Xtream Codes API:** set `IPTV_URL` (base URL including port), `IPTV_USERNAME` and `IPTV_PASSWORD`.

See `.env.example` for the optional settings.

## Run with Docker (recommended)

A prebuilt image with ffmpeg already bundled, so there's nothing else to install. It's an interactive CLI, so run it with `-it`, pass your `.env`, and mount a folder for the downloads:

```
docker run -it --rm \
  --env-file .env \
  -v "$(pwd)/downloads:/downloads" \
  ghcr.io/scottrobertson/timeshifter:latest
```

## Run manually

Needs Node 20+ and [ffmpeg](https://ffmpeg.org/download.html) on your PATH:

```
npm install
npm start
```

## Notes / troubleshooting

- **403 / forbidden on download:** some providers block requests without a known player user agent. Set `IPTV_USER_AGENT` in `.env` (a VLC string is in the example).
- **Output format:** defaults to `ts` (raw stream, no remux, plays fine in VLC and Plex). Set `OUTPUT_FORMAT=mp4` if you'd rather have an MP4 (it remuxes with `-c copy`, no re-encode).
- **Timeshift URL style:** most panels use the default path style. If downloads fail with a valid account, try `TIMESHIFT_MODE=php`.
- **Padding:** set `PADDING_BEFORE_MINUTES` / `PADDING_AFTER_MINUTES` to start a bit early and run a bit long, in case the guide times are off. A still-airing show's end padding is capped at "now".
- **Filename:** set `FILENAME_TEMPLATE` to control how files are named. Tokens: `{channel}`, `{title}`, `{date}`, `{time}`, `{datetime}`, `{ext}`. You can put shows in subfolders, e.g. `{channel}/{title} - {date}.{ext}`. Defaults to `{channel} - {title} - {datetime}.{ext}`.
- **ffmpeg warnings during download:** lines like `non-existing PPS`, `no frame!`, `Packet corrupt` and `timestamp discontinuity` are normal here. Catchup streams aren't perfectly clean, so ffmpeg logs these warnings while it copies the recording, but the file is fine. By default these are hidden behind a clean progress line; set `VERBOSE=true` to see ffmpeg's full output. The duration check at the end is the real test of whether the recording is complete.
- **Times** shown in the guide are the provider's local time, which is what the timeshift URL needs, so no timezone conversion is done.
- **M3U catchup URLs:** if a channel has a `catchup-source` template it's used directly. If not, the catchup URL is worked out from the stream URL (Xtream-style playlists become a `/timeshift/...` URL, otherwise a standard `?utc=...` query is appended). The Xtream API option is more predictable if your provider offers it.

## Built with Claude

This project was built with [Claude](https://claude.com/claude-code).
