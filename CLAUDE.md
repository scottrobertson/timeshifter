# timeshifter

A small Rust web app that downloads shows from an Xtream Codes provider's catchup archive. You pick shows from the guide, schedule ones that haven't aired, or subscribe to titles, and background jobs do the downloading.

There's no login. It's meant to run somewhere only you can reach, like a Tailscale network.

## Stack

- Rust (edition 2024, version pinned in `.tool-versions`, installed with asdf)
- axum for the web server, askama for HTML templates
- rusqlite for the app's own SQLite database, one shared connection
- reqwest for the provider
- Tailwind v4 for CSS, plain JS in `static/app.js`, live updates over server sent events
- ffmpeg to clean up each recording, comskip for ad breaks

## Layout

| Path | What it does |
|---|---|
| `src/main.rs` | Env config, app state, the timer that queues guide checks, the server |
| `src/recording.rs` | The rules: recording windows, the catchup URL, filenames, the .nfo, when a show is due. No IO |
| `src/plan.rs` | Settings plus a subscription's or recording's overrides, resolved into what to actually do |
| `src/xtream.rs` | The provider's API, with retries |
| `src/guide.rs` | Remembers the channel list and guides for a few minutes, so pages are quick |
| `src/jobs.rs` | The job queue. All background work goes through it |
| `src/check.rs` | The guide check job: works out what's due and queues downloads |
| `src/download.rs` | The download and comskip jobs, and the .nfo |
| `src/subscriptions.rs`, `src/scheduled.rs` | Their tables |
| `src/import.rs` | Brings over the old command line version's `config.json` and `scheduled.json` on first start |
| `src/db.rs`, `migrations/` | SQLite setup and schema. The schema comments explain each table |
| `src/live.rs` | Pushes page fragments and nudges to open tabs |
| `src/web/` | Routes and page handlers, one file per area |
| `templates/` | askama templates. `*_body.html` and `*_panel.html` are the bits that get reloaded or pushed live |
| `static/app.js` | Live updates, background forms, filtering, ticking clocks, tooltips, toasts |

CSS, JS and the icon are baked into the binary at build time.

## Why it works the way it does

- Guide times are never converted. The catchup endpoint takes the provider's own wall clock time, and the guide's `start` and `end` strings are already in it. Unix timestamps are only used for comparing against now.
- Every download goes through the queue holding the provider lock, so they run one at a time. Providers limit connections, and a second stream can get the first one cut off.
- comskip runs as its own job with its own lock, so a slow comskip run doesn't hold up the next download.
- The queue is in memory. Anything left queued or running when the server stops is marked interrupted on the next start. The next guide check queues due downloads again, and scheduled recordings stay pending until their download actually finishes.
- Two requests for the same file join the same job. That's also how a subscription whose filename template gives repeat airings the same name only downloads one of them.
- Downloads go to a hidden `.part` file, get remuxed to a hidden `.remux` file, then are renamed into place. Media servers ignore dotfiles, and the rename means a library only ever sees a finished file.
- Downloads use a plain GET, never Range requests. Some CDNs drip feed Range requests.
- A download that stops within 1% of the advertised length counts as complete. Providers often close a little early.
- The timer only runs in release builds, so a dev server restarting on every save doesn't hammer the provider. Set `TIMESHIFTER_TIMER=1` to turn it on in development.
- Open pages reload when the server restarts, by watching for a new boot id on the event stream.

## Running locally

Needs Rust from asdf, Tailwind and ffmpeg:

```sh
asdf install
brew install tailwindcss ffmpeg
```

Run the app with watchexec, so it rebuilds and restarts on every change:

```sh
TIMESHIFTER_CONFIG_DIR=data watchexec --restart -w src -w templates -w styles -w static/app.js -w migrations -- cargo run
```

Open http://localhost:8080 and add your provider in Settings.

Only `static/app.js` is watched in `static/`. The build writes `static/style.css`, so watching that would restart forever.

## Tests and lint

CI runs both of these on every push, and they need to pass:

```sh
cargo clippy --all-targets -- -D warnings
cargo test
```

Test fixtures use NASA launches and similar, never real broadcasters.

## Deploying

CI builds the image on every push, boots it as a smoke test, and pushes it to `ghcr.io/scottrobertson/timeshifter` from `main` only.

Versions are pinned in more than one place, so bump them together. Rust is in `.tool-versions` and the `FROM` line in `Dockerfile` (CI uses stable). Tailwind is in `Dockerfile` and `.github/workflows/ci.yml`.
