use askama::Template;
use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;

use super::{AppStateRef, Chrome, JobRow, chrome, format, render};
use crate::AppState;
use crate::check;
use crate::db::now;
use crate::jobs;

#[derive(Deserialize)]
pub struct FragmentQuery {
    fragment: Option<String>,
}

pub struct UpNext {
    pub title: String,
    pub href: String,
    pub source: String,
    pub scheduled: bool,
    pub channel: String,
    pub airs: String,
    pub ready_iso: String,
    pub ready_in: String,
}

#[derive(Template)]
#[template(path = "overview_body.html")]
pub struct OverviewBody {
    pub activity: String,
    pub downloading: usize,
    pub queued: usize,
    pub coming_up: usize,
    pub next_title: String,
    pub next_when: String,
    pub saved_week: usize,
    pub saved_day: usize,
    pub problems: usize,
    pub up_next: Vec<UpNext>,
    pub more_up_next: usize,
    pub recent: Vec<JobRow>,
    pub checked: Option<(String, String)>,
    pub has_provider: bool,
}

#[derive(Template)]
#[template(path = "overview.html")]
struct OverviewPage {
    chrome: Chrome,
    body: String,
}

const UP_NEXT_SHOWN: usize = 8;

async fn body(state: &AppState) -> OverviewBody {
    let week_ago = now() - 7 * 86_400;
    let day_ago = now() - 86_400;
    let (active, recent, saved_week, saved_day, problems) = state
        .db
        .call(move |conn| {
            let count = |sql: &str, since: i64| -> anyhow::Result<usize> {
                Ok(conn.query_row(sql, [since], |r| r.get::<_, i64>(0))? as usize)
            };
            Ok((
                jobs::active(conn)?,
                jobs::finished(conn, Some("download"), 6)?,
                count("SELECT count(*) FROM jobs WHERE kind = 'download' AND status = 'succeeded' AND finished_at > ?", week_ago)?,
                count("SELECT count(*) FROM jobs WHERE kind = 'download' AND status = 'succeeded' AND finished_at > ?", day_ago)?,
                count("SELECT count(*) FROM jobs WHERE status IN ('failed', 'interrupted') AND finished_at > ?", week_ago)?,
            ))
        })
        .await
        .unwrap_or_default();
    let last = check::last(&state.db).await;
    let upcoming = last.as_ref().map(|l| l.upcoming.clone()).unwrap_or_default();
    let next = upcoming.first();

    OverviewBody {
        activity: super::render_string(super::activity_panel(state).await),
        downloading: active.iter().filter(|j| j.kind == "download" && j.status == "running").count(),
        queued: active.iter().filter(|j| j.status == "queued").count(),
        coming_up: upcoming.len(),
        next_title: next.map(|u| u.title.clone()).unwrap_or_default(),
        next_when: next.map(|u| format::when(&u.start_local)).unwrap_or_default(),
        saved_week,
        saved_day,
        problems,
        more_up_next: upcoming.len().saturating_sub(UP_NEXT_SHOWN),
        up_next: upcoming
            .iter()
            .take(UP_NEXT_SHOWN)
            .map(|u| UpNext {
                title: u.title.clone(),
                href: format!("/channels/{}?view=upcoming", u.stream_id),
                source: u.subscription.clone().unwrap_or_else(|| "Scheduled".into()),
                scheduled: u.subscription.is_none(),
                channel: u.channel.clone(),
                airs: format::when(&u.start_local),
                ready_iso: format::iso(u.ready),
                ready_in: format::until(u.ready),
            })
            .collect(),
        recent: recent.iter().map(JobRow::new).collect(),
        checked: last.map(|l| (format::iso(l.at), format::ago(l.at))),
        has_provider: state.db.settings().await.has_provider(),
    }
}

pub async fn page(State(state): AppStateRef, Query(q): Query<FragmentQuery>) -> Response {
    let body = body(&state).await;
    if q.fragment.is_some() {
        return render(body);
    }
    render(OverviewPage { chrome: chrome(&state, "overview").await, body: super::render_string(body) })
}
