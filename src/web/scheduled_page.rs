use askama::Template;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use super::{AppStateRef, Chrome, chrome, done, format, render, render_string};
use crate::AppState;
use crate::db::now;
use crate::recording::ready_at;
use crate::scheduled;

pub struct Row {
    pub id: i64,
    pub title: String,
    pub channel: String,
    pub airs: String,
    pub status: String,
    pub label: &'static str,
    pub pending: bool,
    pub ready_iso: String,
    pub ready: String,
    pub ready_passed: bool,
    pub output_path: String,
    pub finished_ago: String,
    pub finished_iso: String,
}

#[derive(Template)]
#[template(path = "scheduled_body.html")]
struct Body {
    rows: Vec<Row>,
}

#[derive(Template)]
#[template(path = "scheduled.html")]
struct Page {
    chrome: Chrome,
    body: String,
}

#[derive(Deserialize)]
pub struct Q {
    fragment: Option<String>,
}

async fn body(state: &AppState) -> Body {
    let settings = state.db.settings().await;
    let all = state.db.call(|conn| scheduled::all(conn)).await.unwrap_or_default();
    let now = now();
    let rows = all
        .into_iter()
        .map(|s| {
            let after = s.overrides.padding_after.unwrap_or(settings.padding_after);
            let ready = ready_at(&s.program, after, settings.ready_grace_minutes);
            Row {
                id: s.id,
                title: s.program.title.clone(),
                channel: s.channel.clone(),
                airs: format::when(&s.program.start_local),
                label: match s.status.as_str() {
                    "pending" => "Waiting",
                    "done" => "Downloaded",
                    _ => "Gave up",
                },
                pending: s.status == "pending",
                status: s.status,
                ready_iso: format::iso(ready),
                ready: format::until(ready),
                ready_passed: ready <= now,
                output_path: s.output_path.unwrap_or_default(),
                finished_ago: s.completed_at.map(format::ago).unwrap_or_default(),
                finished_iso: s.completed_at.map(format::iso).unwrap_or_default(),
            }
        })
        .collect();
    Body { rows }
}

pub async fn list(State(state): AppStateRef, Query(q): Query<Q>) -> Response {
    let body = body(&state).await;
    if q.fragment.is_some() {
        return render(body);
    }
    render(Page { chrome: chrome(&state, "scheduled").await, body: render_string(body) })
}

pub async fn remove(State(state): AppStateRef, headers: HeaderMap, UrlPath(id): UrlPath<i64>) -> Response {
    let _ = state.db.call(move |conn| scheduled::remove(conn, id)).await;
    state.live.nudge("jobs");
    done(&headers)
}
