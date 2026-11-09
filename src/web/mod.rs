//! Routes, the shared page chrome and the live update stream.

mod channels;
mod format;
mod jobs_pages;
mod overview;
mod scheduled_page;
mod settings_page;
mod subscriptions_page;

use std::convert::Infallible;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use askama::Template;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use futures_util::{Stream, StreamExt};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};

use crate::AppState;
use crate::jobs::{self, JobView};
use crate::live::Push;

pub type AppStateRef = State<Arc<AppState>>;

const CSS: &str = include_str!("../../static/style.css");
const JS: &str = include_str!("../../static/app.js");
const ICON: &str = include_str!("../../static/icon.svg");

/// Changes every time the server starts. Open pages reload when it changes, so after a
/// deploy nobody is left looking at old pages.
static BOOT: LazyLock<String> = LazyLock::new(|| chrono::Utc::now().timestamp_millis().to_string());
static ASSET_VERSION: LazyLock<String> = LazyLock::new(|| {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (CSS, JS).hash(&mut hasher);
    format!("{:x}", hasher.finish())
});

pub fn router(state: Arc<AppState>) -> Router {
    let compression =
        CompressionLayer::new().compress_when(DefaultPredicate::new().and(NotForContentType::const_new("text/event-stream")));

    Router::new()
        .route("/", get(overview::page))
        .route("/channels", get(channels::list))
        .route("/channels/refresh", post(channels::refresh))
        .route("/channels/star", post(channels::star))
        .route("/channels/{id}", get(channels::guide))
        .route("/channels/{id}/plan", get(channels::plan_page).post(channels::plan_submit))
        .route("/subscriptions", get(subscriptions_page::list))
        .route("/subscriptions/new", get(subscriptions_page::new_form).post(subscriptions_page::create))
        .route("/subscriptions/{id}", get(subscriptions_page::edit_form).post(subscriptions_page::update))
        .route("/subscriptions/{id}/delete", post(subscriptions_page::delete))
        .route("/scheduled", get(scheduled_page::list))
        .route("/scheduled/{id}/remove", post(scheduled_page::remove))
        .route("/jobs", get(jobs_pages::list))
        .route("/jobs/check", post(jobs_pages::check_now))
        .route("/jobs/{id}", get(jobs_pages::detail))
        .route("/jobs/{id}/cancel", post(jobs_pages::cancel))
        .route("/jobs/{id}/retry", post(jobs_pages::retry))
        .route("/settings", get(settings_page::page).post(settings_page::save))
        .route("/settings/test", post(settings_page::test))
        .route("/presets/new", post(settings_page::preset_new))
        .route("/presets/{id}", post(settings_page::preset_save))
        .route("/presets/{id}/delete", post(settings_page::preset_delete))
        .route("/fragments/activity", get(activity_fragment))
        .route("/events", get(events))
        .route("/static/style.css", get(|| async { asset(CSS, "text/css") }))
        .route("/static/app.js", get(|| async { asset(JS, "text/javascript") }))
        .route("/icon.svg", get(|| async { asset(ICON, "image/svg+xml") }))
        .layer(compression)
        .with_state(state)
}

fn asset(body: &'static str, content_type: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
        body,
    )
        .into_response()
}

pub fn render(page: impl Template) -> Response {
    match page.render() {
        Ok(html) => ([(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response(),
        Err(err) => {
            tracing::error!(%err, "template failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "A page template failed. The server log has the details.").into_response()
        }
    }
}

pub fn render_string(page: impl Template) -> String {
    page.render().unwrap_or_else(|err| {
        tracing::error!(%err, "template failed");
        String::new()
    })
}

pub fn not_found(what: &str) -> Response {
    (StatusCode::NOT_FOUND, format!("{what} not found")).into_response()
}

/// The page's script posts some forms itself and only needs an OK. Without the script, go
/// back to the page.
pub fn done(headers: &HeaderMap) -> Response {
    if headers.contains_key("x-timeshifter") {
        return StatusCode::NO_CONTENT.into_response();
    }
    let back = headers.get(header::REFERER).and_then(|v| v.to_str().ok()).unwrap_or("/");
    Redirect::to(back).into_response()
}

pub fn see_other(to: &str) -> Response {
    Redirect::to(to).into_response()
}

pub struct Chrome {
    pub version: &'static str,
    pub nav: &'static str,
    pub nav_badge: String,
    pub has_provider: bool,
}

pub async fn chrome(state: &AppState, nav: &'static str) -> Chrome {
    let active = state.db.call(|conn| jobs::active(conn)).await.unwrap_or_default();
    Chrome {
        version: &ASSET_VERSION,
        nav,
        nav_badge: render_string(NavBadge::from(&active)),
        has_provider: state.db.settings().await.has_provider(),
    }
}

#[derive(Template)]
#[template(path = "nav_badge.html")]
pub struct NavBadge {
    pub count: usize,
    pub running: bool,
}

impl From<&Vec<JobView>> for NavBadge {
    fn from(active: &Vec<JobView>) -> NavBadge {
        NavBadge { count: active.len(), running: active.iter().any(|j| j.status == "running") }
    }
}

/// A job as lists show it.
pub struct JobRow {
    pub id: i64,
    pub title: String,
    pub link: Option<String>,
    pub kind: &'static str,
    /// For a download, which channel and airing it is, since titles repeat.
    pub about: String,
    pub trigger: &'static str,
    pub status: String,
    pub status_label: &'static str,
    pub active: bool,
    pub running: bool,
    pub step: String,
    pub pct: Option<i64>,
    pub progress: String,
    pub summary: String,
    pub error: String,
    pub warnings: i64,
    pub started_iso: String,
    pub elapsed: String,
    pub finished_iso: String,
    pub finished_ago: String,
    pub took: String,
}

impl JobRow {
    pub fn new(job: &JobView) -> JobRow {
        let now = crate::db::now();
        let pct = match (job.done, job.total) {
            (Some(done), Some(total)) if total > 0 => Some((done * 100 / total).clamp(0, 100)),
            _ => None,
        };
        let progress = match (job.kind.as_str(), job.done, job.total) {
            ("download", Some(done), Some(total)) => format!("{} of {}", format::bytes(done), format::bytes(total)),
            ("download", Some(done), None) => format::bytes(done),
            ("comskip", Some(done), Some(_)) => format!("{done}%"),
            (_, Some(done), Some(total)) => format!("{done} of {total}"),
            _ => String::new(),
        };
        JobRow {
            id: job.id,
            title: job.title.clone(),
            link: job.link.clone(),
            kind: match job.kind.as_str() {
                "check" => "Check",
                "download" => "Download",
                "comskip" => "Comskip",
                _ => "Job",
            },
            about: match job.work() {
                Some(crate::jobs::Work::Download { channel, program, .. }) => {
                    format!("{} · {}", channel.name, format::when(&program.start_local))
                }
                _ => String::new(),
            },
            trigger: match job.trigger.as_str() {
                "manual" => "Started by you",
                "scheduled" => "On the timer",
                _ => "Automatic",
            },
            status: job.status.clone(),
            status_label: match job.status.as_str() {
                "queued" => "Queued",
                "running" => "Running",
                "succeeded" if job.warnings > 0 => "Warnings",
                "succeeded" => "Done",
                "failed" => "Failed",
                "cancelled" => "Stopped",
                "interrupted" => "Interrupted",
                _ => "Unknown",
            },
            active: job.is_active(),
            running: job.status == "running",
            step: job.step.clone().unwrap_or_default(),
            pct,
            progress,
            summary: job.summary.clone().unwrap_or_default(),
            error: job.error.clone().unwrap_or_default(),
            warnings: job.warnings,
            started_iso: job.started_at.map(format::iso).unwrap_or_default(),
            elapsed: job.started_at.map(|s| format::duration(now - s)).unwrap_or_default(),
            finished_iso: job.finished_at.map(format::iso).unwrap_or_default(),
            finished_ago: job.finished_at.map(format::ago).unwrap_or_default(),
            took: match (job.started_at, job.finished_at) {
                (Some(s), Some(f)) => format::duration(f - s),
                _ => String::new(),
            },
        }
    }

    pub fn tone(&self) -> &str {
        if self.status == "succeeded" && self.warnings > 0 { "warn" } else { &self.status }
    }
}

/// The live "what's happening" panel: running and queued jobs, and when the next check is.
#[derive(Template)]
#[template(path = "activity_panel.html")]
pub struct ActivityPanel {
    pub jobs: Vec<JobRow>,
    pub next_check: String,
    pub next_check_iso: String,
    pub has_provider: bool,
    pub timer: bool,
}

pub async fn activity_panel(state: &AppState) -> ActivityPanel {
    let active = state.db.call(|conn| jobs::active(conn)).await.unwrap_or_default();
    let next = *state.next_check.lock().unwrap();
    ActivityPanel {
        jobs: active.iter().map(JobRow::new).collect(),
        next_check: next.map(format::until).unwrap_or_default(),
        next_check_iso: next.map(format::iso).unwrap_or_default(),
        has_provider: state.db.settings().await.has_provider(),
        timer: state.timer,
    }
}

async fn activity_fragment(State(state): AppStateRef) -> Response {
    render(activity_panel(&state).await)
}

/// Redraws the live panels whenever something changes. Changes come in bursts, so wait a
/// moment and draw once for the lot.
pub async fn render_live(state: Arc<AppState>) {
    loop {
        state.live.dirty.notified().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !state.live.watched() {
            continue;
        }
        let active = state.db.call(|conn| jobs::active(conn)).await.unwrap_or_default();
        state.live.panel("nav", render_string(NavBadge::from(&active)));
        state.live.panel("activity", render_string(activity_panel(&state).await));
    }
}

async fn events(State(state): AppStateRef) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (snapshot, rx) = state.live.subscribe();
    state.live.changed();
    let boot = Push { event: "boot", data: BOOT.clone() };
    let first = futures_util::stream::iter(std::iter::once(boot).chain(snapshot));
    let rest = BroadcastStream::new(rx).filter_map(|p| async move { p.ok() });
    let stream = first.chain(rest).map(|p| Ok(Event::default().event(p.event).data(p.data)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Empty form fields come through as Some(""), which means "not set".
pub fn filled(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// The boxes of a list field, like "Title contains", without the ones left empty.
pub fn words(values: &[String]) -> Vec<String> {
    values.iter().map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string).collect()
}

/// What a list field shows, with one empty box when there's nothing yet so there's somewhere to type.
pub fn boxes(values: &[String]) -> Vec<String> {
    if values.is_empty() { vec![String::new()] } else { values.to_vec() }
}
