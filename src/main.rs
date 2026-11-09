mod check;
mod db;
mod download;
mod guide;
mod import;
mod jobs;
mod live;
mod plan;
mod recording;
mod scheduled;
mod settings;
mod starred;
mod subscriptions;
mod web;
mod xtream;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};

use guide::Guide;
use jobs::{Jobs, Trigger, Work};
use live::Live;

pub struct AppState {
    pub db: db::Db,
    pub jobs: Jobs,
    pub guide: Arc<Guide>,
    pub live: Arc<Live>,
    pub config_dir: PathBuf,
    /// When the timer will next check the guide, as unix seconds.
    pub next_check: Mutex<Option<i64>>,
    /// The timer only runs in release builds, so a dev server restarting on every save
    /// doesn't hammer the provider.
    pub timer: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "timeshifter=info,tower_http=warn".into()),
        )
        .init();

    let config_dir: PathBuf = std::env::var("TIMESHIFTER_CONFIG_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "config".into())
        .into();
    let port: u16 = match std::env::var("PORT").ok().filter(|v| !v.trim().is_empty()) {
        Some(v) => v.parse().context("PORT must be a number")?,
        None => 8080,
    };

    let db = db::Db::open(&config_dir.join("timeshifter.db"))?;
    for note in import::first_run(&mut db.lock(), &config_dir)? {
        tracing::info!("{note}");
    }

    let live = Arc::new(Live::default());
    let guide = Arc::new(Guide::default());
    let jobs = Jobs::new(db.clone(), live.clone(), guide.clone(), config_dir.clone());
    let state = Arc::new(AppState {
        db,
        jobs,
        guide,
        live,
        config_dir,
        next_check: Mutex::new(None),
        timer: !cfg!(debug_assertions) || std::env::var("TIMESHIFTER_TIMER").is_ok(),
    });

    if state.timer {
        tokio::spawn(timer(state.clone()));
    } else {
        tracing::info!("development build, so the guide is only checked when you press Check now");
    }
    tokio::spawn(web::render_live(state.clone()));

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on http://localhost:{port}");
    axum::serve(listener, web::router(state)).await?;
    Ok(())
}

/// Queues a guide check every few minutes. The check does the work; this only decides
/// when. The interval is read each time, so a change in Settings applies from the next one.
async fn timer(state: Arc<AppState>) {
    // A moment for the server to come up, then check straight away.
    tokio::time::sleep(Duration::from_secs(3)).await;
    loop {
        let settings = state.db.settings().await;
        if settings.has_provider()
            && let Err(e) = state.jobs.enqueue(Work::Check, Trigger::Scheduled).await
        {
            tracing::error!("couldn't queue the guide check: {e:#}");
        }
        let wait = settings.poll_interval_minutes.max(1) * 60;
        *state.next_check.lock().unwrap() = Some(db::now() + wait);
        state.live.changed();
        tokio::time::sleep(Duration::from_secs(wait as u64)).await;
    }
}
