use askama::Template;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use super::{AppStateRef, Chrome, JobRow, chrome, done, format, not_found, render, render_string, see_other};
use crate::AppState;
use crate::jobs::{self, Trigger, Work};

#[derive(Deserialize)]
pub struct ListQuery {
    kind: Option<String>,
    fragment: Option<String>,
}

#[derive(Template)]
#[template(path = "jobs_body.html")]
struct ListBody {
    active: Vec<JobRow>,
    finished: Vec<JobRow>,
    kind: String,
}

#[derive(Template)]
#[template(path = "jobs.html")]
struct ListPage {
    chrome: Chrome,
    kind: String,
    src: String,
    body: String,
}

const FILTERS: &[&str] = &["download", "check", "comskip", "problems"];

async fn list_body(state: &AppState, kind: Option<String>) -> ListBody {
    let filter = kind.clone().filter(|k| FILTERS.contains(&k.as_str()));
    let f = filter.clone();
    let (active, finished) = state
        .db
        .call(move |conn| Ok((jobs::active(conn)?, jobs::finished(conn, f.as_deref(), 100)?)))
        .await
        .unwrap_or_default();
    let active = active
        .iter()
        .filter(|j| match filter.as_deref() {
            None => true,
            Some("problems") => false,
            Some(k) => j.kind == k,
        })
        .map(JobRow::new)
        .collect();
    ListBody { active, finished: finished.iter().map(JobRow::new).collect(), kind: filter.unwrap_or_default() }
}

pub async fn list(State(state): AppStateRef, Query(q): Query<ListQuery>) -> Response {
    let body = list_body(&state, q.kind.clone()).await;
    if q.fragment.is_some() {
        return render(body);
    }
    render(ListPage {
        chrome: chrome(&state, "jobs").await,
        src: match &q.kind {
            Some(k) => format!("/jobs?kind={k}"),
            None => "/jobs".into(),
        },
        kind: body.kind.clone(),
        body: render_string(body),
    })
}

pub struct LogView {
    pub at: String,
    pub level: String,
    pub message: String,
}

#[derive(Template)]
#[template(path = "job_body.html")]
struct DetailBody {
    job: JobRow,
    log: Vec<LogView>,
    can_retry: bool,
    created: String,
    started: String,
    finished: String,
}

#[derive(Template)]
#[template(path = "job.html")]
struct DetailPage {
    chrome: Chrome,
    id: i64,
    title: String,
    body: String,
}

#[derive(Deserialize)]
pub struct DetailQuery {
    fragment: Option<String>,
}

pub async fn detail(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Query(q): Query<DetailQuery>) -> Response {
    let found = state
        .db
        .call(move |conn| Ok(jobs::job(conn, id)?.map(|j| (j, jobs::logs(conn, id)))))
        .await
        .ok()
        .flatten();
    let Some((job, logs)) = found else { return not_found("Job") };
    let body = DetailBody {
        can_retry: matches!(job.status.as_str(), "failed" | "cancelled" | "interrupted") && job.work().is_some(),
        created: format::clock(job.created_at),
        started: job.started_at.map(format::clock).unwrap_or_default(),
        finished: job.finished_at.map(format::clock).unwrap_or_default(),
        log: logs
            .unwrap_or_default()
            .into_iter()
            .map(|l| LogView { at: format::clock(l.at), level: l.level, message: l.message })
            .collect(),
        job: JobRow::new(&job),
    };
    if q.fragment.is_some() {
        return render(body);
    }
    render(DetailPage { chrome: chrome(&state, "jobs").await, id, title: job.title, body: render_string(body) })
}

pub async fn cancel(State(state): AppStateRef, headers: HeaderMap, UrlPath(id): UrlPath<i64>) -> Response {
    let _ = state.jobs.cancel(id).await;
    done(&headers)
}

/// Runs the same work again, as a new job.
pub async fn retry(State(state): AppStateRef, UrlPath(id): UrlPath<i64>) -> Response {
    let work = state.db.call(move |conn| jobs::job(conn, id)).await.ok().flatten().and_then(|j| j.work());
    match work {
        Some(work) => match state.jobs.enqueue(work, Trigger::Manual).await {
            Ok(new_id) => see_other(&format!("/jobs/{new_id}")),
            Err(_) => see_other(&format!("/jobs/{id}")),
        },
        None => not_found("Job"),
    }
}

pub async fn check_now(State(state): AppStateRef, headers: HeaderMap) -> Response {
    let _ = state.jobs.enqueue(Work::Check, Trigger::Manual).await;
    done(&headers)
}
