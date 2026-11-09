//! The job queue. All background work goes through here, so there's one place that knows
//! what's waiting and running, open tabs can follow along, and anything can be stopped.
//! Each kind of work holds a lock: downloads take turns on the provider, comskip runs one
//! at a time because it's heavy, and a check never overlaps another check.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::db::{Db, now};
use crate::guide::Guide;
use crate::live::Live;
use crate::plan::Plan;
use crate::recording::{Channel, Program};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant)]
pub enum Work {
    /// Reads the guide for every subscription and scheduled recording, and queues
    /// downloads for whatever is ready.
    Check,
    Download {
        channel: Channel,
        program: Program,
        plan: Plan,
        scheduled_id: Option<i64>,
    },
    /// Writes the .edl that lets media servers skip the ad breaks.
    Comskip { path: String },
    #[cfg(test)]
    Test { key: i64, millis: u64, fail: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Lock {
    Check,
    Provider,
    Comskip,
    #[cfg(test)]
    Test(i64),
}

impl Work {
    pub fn kind(&self) -> &'static str {
        match self {
            Work::Check => "check",
            Work::Download { .. } => "download",
            Work::Comskip { .. } => "comskip",
            #[cfg(test)]
            Work::Test { .. } => "test",
        }
    }

    fn lock(&self) -> Lock {
        match self {
            Work::Check => Lock::Check,
            Work::Download { .. } => Lock::Provider,
            Work::Comskip { .. } => Lock::Comskip,
            #[cfg(test)]
            Work::Test { key, .. } => Lock::Test(*key),
        }
    }

    /// Two requests for the same thing, like the same recording twice.
    fn same_as(&self, other: &Work) -> bool {
        match (self, other) {
            (Work::Check, Work::Check) => true,
            (Work::Download { plan: a, .. }, Work::Download { plan: b, .. }) => a.filename == b.filename,
            (Work::Comskip { path: a }, Work::Comskip { path: b }) => a == b,
            #[cfg(test)]
            (Work::Test { key: a, .. }, Work::Test { key: b, .. }) => a == b,
            _ => false,
        }
    }

    fn title(&self) -> String {
        match self {
            Work::Check => "Check the guide".into(),
            Work::Download { program, .. } => program.title.clone(),
            Work::Comskip { path } => {
                let name = std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string());
                format!("Find ad breaks in {}", name.unwrap_or_else(|| path.clone()))
            }
            #[cfg(test)]
            Work::Test { key, .. } => format!("Test {key}"),
        }
    }

    fn link(&self) -> Option<String> {
        match self {
            Work::Download { channel, .. } => Some(format!("/channels/{}", channel.stream_id)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Trigger {
    Manual,
    Scheduled,
    Automatic,
}

impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Trigger::Manual => "manual",
            Trigger::Scheduled => "scheduled",
            Trigger::Automatic => "automatic",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct JobView {
    pub id: i64,
    pub kind: String,
    pub trigger: String,
    pub status: String,
    pub title: String,
    pub link: Option<String>,
    pub params: String,
    pub step: Option<String>,
    pub done: Option<i64>,
    pub total: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    /// Log lines at warn or error level.
    pub warnings: i64,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

impl JobView {
    pub fn is_active(&self) -> bool {
        self.status == "queued" || self.status == "running"
    }

    pub fn work(&self) -> Option<Work> {
        serde_json::from_str(&self.params).ok()
    }
}

pub struct LogLine {
    pub at: i64,
    pub level: String,
    pub message: String,
}

const VIEW_COLUMNS: &str = "id, kind, trigger, status, title, link, params, step, done, total, summary, error, \
    (SELECT count(*) FROM job_logs l WHERE l.job_id = jobs.id AND l.level != 'info'), created_at, started_at, finished_at";

fn view_from_row(r: &rusqlite::Row) -> rusqlite::Result<JobView> {
    Ok(JobView {
        id: r.get(0)?,
        kind: r.get(1)?,
        trigger: r.get(2)?,
        status: r.get(3)?,
        title: r.get(4)?,
        link: r.get(5)?,
        params: r.get(6)?,
        step: r.get(7)?,
        done: r.get(8)?,
        total: r.get(9)?,
        summary: r.get(10)?,
        error: r.get(11)?,
        warnings: r.get(12)?,
        created_at: r.get(13)?,
        started_at: r.get(14)?,
        finished_at: r.get(15)?,
    })
}

pub fn job(conn: &Connection, id: i64) -> Result<Option<JobView>> {
    Ok(conn
        .query_row(&format!("SELECT {VIEW_COLUMNS} FROM jobs WHERE id = ?"), [id], view_from_row)
        .optional()?)
}

/// Running jobs first, then the queue in the order it will run.
pub fn active(conn: &Connection) -> Result<Vec<JobView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VIEW_COLUMNS} FROM jobs WHERE status IN ('queued', 'running') ORDER BY status = 'queued', id"
    ))?;
    Ok(stmt.query_map([], view_from_row)?.collect::<rusqlite::Result<_>>()?)
}

/// Finished jobs, newest first. kind narrows it to one kind, or "problems" for anything
/// that failed, was interrupted or logged a warning.
pub fn finished(conn: &Connection, kind: Option<&str>, limit: i64) -> Result<Vec<JobView>> {
    let filter = match kind {
        Some("problems") => {
            " AND (status IN ('failed', 'interrupted') OR EXISTS (SELECT 1 FROM job_logs l WHERE l.job_id = jobs.id AND l.level != 'info'))"
        }
        Some(_) => " AND kind = ?2",
        None => "",
    };
    let sql = format!(
        "SELECT {VIEW_COLUMNS} FROM jobs WHERE status NOT IN ('queued', 'running'){filter} ORDER BY finished_at DESC, id DESC LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = match kind {
        Some(k) if k != "problems" => stmt.query_map(params![limit, k], view_from_row)?,
        _ => stmt.query_map(params![limit], view_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn logs(conn: &Connection, id: i64) -> Result<Vec<LogLine>> {
    let mut stmt = conn.prepare("SELECT at, level, message FROM job_logs WHERE job_id = ? ORDER BY id")?;
    Ok(stmt
        .query_map([id], |r| Ok(LogLine { at: r.get(0)?, level: r.get(1)?, message: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?)
}

// Finished jobs are kept this long, and never more than KEEP_MAX of them, so scheduled
// checks don't pile up forever.
const KEEP_DAYS: i64 = 14;
const KEEP_MAX: i64 = 1000;

fn prune(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM jobs WHERE status NOT IN ('queued', 'running') \
           AND (finished_at < ? OR id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT ?))",
        params![now() - KEEP_DAYS * 86_400, KEEP_MAX],
    )?;
    Ok(())
}

#[derive(Default)]
struct State {
    queue: Vec<(i64, Work)>,
    running: HashMap<i64, (Work, CancellationToken)>,
}

#[derive(Clone)]
pub struct Jobs(Arc<Inner>);

struct Inner {
    db: Db,
    live: Arc<Live>,
    guide: Arc<Guide>,
    config_dir: PathBuf,
    state: Mutex<State>,
}

impl Jobs {
    pub fn new(db: Db, live: Arc<Live>, guide: Arc<Guide>, config_dir: PathBuf) -> Jobs {
        Jobs(Arc::new(Inner { db, live, guide, config_dir, state: Mutex::new(State::default()) }))
    }

    pub fn db(&self) -> &Db {
        &self.0.db
    }

    pub fn guide(&self) -> &Guide {
        &self.0.guide
    }

    pub fn config_dir(&self) -> &std::path::Path {
        &self.0.config_dir
    }

    /// Queues a job and starts it once its lock is free. Asking for something already
    /// queued or running gives back that job instead of adding a second.
    pub async fn enqueue(&self, work: Work, trigger: Trigger) -> Result<i64> {
        Ok(self.enqueue_new(work, trigger).await?.0)
    }

    /// Like enqueue, and also says whether a new job was added rather than an existing one joined.
    pub async fn enqueue_new(&self, work: Work, trigger: Trigger) -> Result<(i64, bool)> {
        let mut state = self.0.state.lock().await;
        let existing = state
            .queue
            .iter()
            .map(|(id, w)| (*id, w))
            .chain(state.running.iter().map(|(id, (w, _))| (*id, w)))
            .find(|(_, w)| w.same_as(&work))
            .map(|(id, _)| id);
        if let Some(id) = existing {
            return Ok((id, false));
        }
        let (kind, title, link, params) = (work.kind(), work.title(), work.link(), serde_json::to_string(&work)?);
        let id = self
            .db()
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO jobs (kind, trigger, title, link, params, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    params![kind, trigger.as_str(), title, link, params, now()],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await?;
        tracing::info!("job #{id} queued: {}", work.title());
        state.queue.push((id, work));
        self.pump(&mut state);
        self.announce();
        Ok((id, true))
    }

    /// Stops a job. A queued one is dropped straight away; a running one stops at the next
    /// safe point and cleans up after itself.
    pub async fn cancel(&self, id: i64) -> Result<()> {
        let mut state = self.0.state.lock().await;
        if let Some(pos) = state.queue.iter().position(|(qid, _)| *qid == id) {
            state.queue.remove(pos);
            self.db()
                .call(move |conn| {
                    conn.execute("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?", params![now(), id])?;
                    Ok(())
                })
                .await?;
            self.announce();
        } else if let Some((_, token)) = state.running.get(&id) {
            token.cancel();
        }
        Ok(())
    }

    /// Something on screen changed in a way that needs the page's data reloaded.
    fn announce(&self) {
        self.0.live.changed();
        self.0.live.nudge("jobs");
    }

    /// Starts every queued job whose lock is free, oldest first.
    fn pump(&self, state: &mut State) {
        let mut taken: HashSet<Lock> = state.running.values().map(|(w, _)| w.lock()).collect();
        let mut i = 0;
        while i < state.queue.len() {
            if !taken.insert(state.queue[i].1.lock()) {
                i += 1;
                continue;
            }
            let (id, work) = state.queue.remove(i);
            let token = CancellationToken::new();
            state.running.insert(id, (work.clone(), token.clone()));
            self.spawn(id, work, token);
        }
    }

    fn spawn(&self, id: i64, work: Work, token: CancellationToken) {
        let jobs = self.clone();
        tokio::spawn(async move {
            match JobCtx::start(&jobs, id, token.clone()).await {
                Ok(ctx) => {
                    let run = {
                        let (jobs, ctx) = (jobs.clone(), ctx.clone());
                        tokio::spawn(async move { jobs.run(work, &ctx).await })
                    };
                    // Its own task, so a panic fails the job rather than leaving it running forever.
                    let outcome = run.await.unwrap_or_else(|_| Err(anyhow!("The job crashed")));
                    jobs.finish(id, &ctx, outcome, token.is_cancelled()).await;
                }
                Err(e) => tracing::error!("job #{id} couldn't start: {e:#}"),
            }
            let mut state = jobs.0.state.lock().await;
            state.running.remove(&id);
            jobs.pump(&mut state);
        });
    }

    async fn run(&self, work: Work, ctx: &JobCtx) -> Result<()> {
        match work {
            Work::Check => crate::check::run(self, ctx).await,
            Work::Download { channel, program, plan, scheduled_id } => {
                crate::download::run(self, ctx, &channel, &program, &plan, scheduled_id).await
            }
            Work::Comskip { path } => crate::download::run_comskip(self, ctx, &path).await,
            #[cfg(test)]
            Work::Test { millis, fail, .. } => {
                ctx.step("Working").await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(millis)) => {}
                    _ = ctx.cancelled() => anyhow::bail!("Stopped"),
                }
                if fail {
                    anyhow::bail!("it broke");
                }
                ctx.summary("all good");
                Ok(())
            }
        }
    }

    async fn finish(&self, id: i64, ctx: &JobCtx, outcome: Result<()>, cancelled: bool) {
        let (status, error) = match &outcome {
            Ok(()) => ("succeeded", None),
            Err(_) if cancelled => ("cancelled", None),
            Err(e) => ("failed", Some(format!("{e:#}"))),
        };
        if let Some(e) = &error {
            ctx.log("error", e).await;
        }
        let summary = ctx.view().and_then(|v| v.summary);
        let view = self
            .db()
            .call(move |conn| {
                conn.execute(
                    "UPDATE jobs SET status = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?",
                    params![status, error, summary, now(), id],
                )?;
                prune(conn)?;
                job(conn, id)
            })
            .await;
        match view {
            Ok(Some(view)) => {
                tracing::info!("job #{id} {status}: {}", view.title);
                self.toast(&view);
            }
            Ok(None) => {}
            Err(e) => tracing::error!("job #{id} couldn't be closed off: {e:#}"),
        }
        self.announce();
    }

    /// A popup for jobs worth hearing about: anything someone started, and any failure.
    fn toast(&self, view: &JobView) {
        let tone = match view.status.as_str() {
            "failed" => "error",
            _ if view.warnings > 0 => "warn",
            "succeeded" => "success",
            _ => "quiet",
        };
        if view.trigger != "manual" && tone != "error" && !(view.kind == "download" && tone == "success") {
            return;
        }
        let text = match view.status.as_str() {
            "failed" => view.error.clone().unwrap_or_else(|| "Failed".into()),
            "cancelled" => "Stopped".into(),
            _ => view.summary.clone().unwrap_or_else(|| "Done".into()),
        };
        let toast = serde_json::json!({
            "tone": tone,
            "title": view.title,
            "text": text,
            "href": format!("/jobs/{}", view.id),
        });
        self.0.live.send("toast", toast.to_string());
    }
}

// How often a job's progress goes out to the database and open tabs. A download ticks for
// every chunk, far faster than anyone can read.
const PROGRESS_EVERY: Duration = Duration::from_millis(400);

/// What a running job uses to report its step, progress and log. A detached one only
/// prints, for running job code in tests.
#[derive(Clone)]
pub struct JobCtx(Option<Arc<CtxInner>>, CancellationToken);

struct CtxInner {
    jobs: Jobs,
    view: StdMutex<JobView>,
    flushed_at: StdMutex<Option<Instant>>,
}

impl JobCtx {
    #[cfg(test)]
    pub fn detached() -> JobCtx {
        JobCtx(None, CancellationToken::new())
    }

    async fn start(jobs: &Jobs, id: i64, token: CancellationToken) -> Result<JobCtx> {
        let view = jobs
            .db()
            .call(move |conn| {
                conn.execute("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", params![now(), id])?;
                job(conn, id)
            })
            .await?
            .ok_or_else(|| anyhow!("job {id} not found"))?;
        tracing::info!("job #{id} started: {}", view.title);
        jobs.announce();
        Ok(JobCtx(
            Some(Arc::new(CtxInner { jobs: jobs.clone(), view: StdMutex::new(view), flushed_at: StdMutex::new(None) })),
            token,
        ))
    }

    fn view(&self) -> Option<JobView> {
        self.0.as_ref().map(|c| c.view.lock().unwrap_or_else(|e| e.into_inner()).clone())
    }

    /// Resolves once someone presses Stop.
    pub async fn cancelled(&self) {
        self.1.cancelled().await
    }

    /// Fails once someone presses Stop, for work that checks between steps.
    pub fn check_stopped(&self) -> Result<()> {
        if self.1.is_cancelled() {
            anyhow::bail!("Stopped");
        }
        Ok(())
    }

    fn update(&self, f: impl FnOnce(&mut JobView)) {
        if let Some(c) = &self.0 {
            f(&mut c.view.lock().unwrap_or_else(|e| e.into_inner()));
        }
    }

    async fn flush(&self, force: bool) {
        let Some(c) = &self.0 else { return };
        let view = {
            let mut at = c.flushed_at.lock().unwrap_or_else(|e| e.into_inner());
            if !force && at.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            *at = Some(Instant::now());
            c.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
        };
        let (id, step, done, total) = (view.id, view.step, view.done, view.total);
        let _ = c
            .jobs
            .db()
            .call(move |conn| {
                conn.execute("UPDATE jobs SET step = ?, done = ?, total = ? WHERE id = ?", params![step, done, total, id])?;
                Ok(())
            })
            .await;
        c.jobs.0.live.changed();
    }

    /// Moves on to a new stage, like "Downloading". Clears the progress.
    pub async fn step(&self, step: impl Into<String>) {
        let step = step.into();
        self.update(|v| {
            v.step = Some(step);
            v.done = None;
            v.total = None;
        });
        self.flush(true).await;
    }

    /// Updates progress, and optionally the step's wording, without forcing a write.
    pub async fn progress(&self, done: i64, total: Option<i64>, step: Option<String>) {
        self.update(|v| {
            v.done = Some(done);
            v.total = total;
            if let Some(step) = step {
                v.step = Some(step);
            }
        });
        self.flush(false).await;
    }

    pub async fn set_total(&self, total: i64) {
        self.update(|v| {
            v.done = Some(0);
            v.total = Some(total);
        });
        self.flush(true).await;
    }

    /// The one line result shown once the job finishes.
    pub fn summary(&self, summary: impl Into<String>) {
        let summary = summary.into();
        tracing::info!("{} {summary}", self.prefix());
        self.update(|v| v.summary = Some(summary));
    }

    pub async fn info(&self, message: impl AsRef<str>) {
        self.log("info", message.as_ref()).await;
    }

    pub async fn warn(&self, message: impl AsRef<str>) {
        self.log("warn", message.as_ref()).await;
    }

    fn prefix(&self) -> String {
        match self.view() {
            Some(v) => format!("[{} #{}]", v.kind, v.id),
            None => "[job]".into(),
        }
    }

    async fn log(&self, level: &'static str, message: &str) {
        if level == "info" {
            tracing::info!("{} {message}", self.prefix());
        } else {
            tracing::warn!("{} {message}", self.prefix());
        }
        let Some(c) = &self.0 else { return };
        if level != "info" {
            self.update(|v| v.warnings += 1);
        }
        let id = c.view.lock().unwrap_or_else(|e| e.into_inner()).id;
        let message = message.to_string();
        let _ = c
            .jobs
            .db()
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO job_logs (job_id, at, level, message) VALUES (?, ?, ?, ?)",
                    params![id, now(), level, message],
                )?;
                Ok(())
            })
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn jobs() -> Jobs {
        Jobs::new(Db::open_in_memory(), Arc::default(), Arc::default(), std::env::temp_dir())
    }

    fn test(key: i64, millis: u64) -> Work {
        Work::Test { key, millis, fail: false }
    }

    fn status(jobs: &Jobs, id: i64) -> String {
        job(&jobs.db().lock(), id).unwrap().unwrap().status
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn runs_a_job_and_records_the_result() {
        let jobs = jobs();
        let id = jobs.enqueue(test(1, 0), Trigger::Manual).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let job = job(&jobs.db().lock(), id).unwrap().unwrap();
        assert_eq!((job.status.as_str(), job.summary.as_deref(), job.trigger.as_str()), ("succeeded", Some("all good"), "manual"));
        assert!(job.started_at.is_some() && job.finished_at.is_some());
    }

    #[tokio::test]
    async fn a_failure_keeps_its_error_and_log_line() {
        let jobs = jobs();
        let id = jobs.enqueue(Work::Test { key: 1, millis: 0, fail: true }, Trigger::Scheduled).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let job = job(&jobs.db().lock(), id).unwrap().unwrap();
        assert_eq!((job.status.as_str(), job.error.as_deref(), job.warnings), ("failed", Some("it broke"), 1));
        assert_eq!(finished(&jobs.db().lock(), Some("problems"), 10).unwrap().len(), 1);
        assert_eq!(finished(&jobs.db().lock(), Some("download"), 10).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn jobs_with_the_same_lock_take_turns() {
        let jobs = jobs();
        let first = jobs.enqueue(test(1, 300), Trigger::Manual).await.unwrap();
        let second = jobs.enqueue(Work::Test { key: 1, millis: 0, fail: true }, Trigger::Manual).await.unwrap();
        let other = jobs.enqueue(test(2, 300), Trigger::Manual).await.unwrap();
        settle().await;
        assert_eq!(status(&jobs, first), "running");
        assert_eq!(status(&jobs, other), "running");
        // The same key counts as the same work, so the second request joins the first.
        assert_eq!(first, second);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(status(&jobs, first), "succeeded");
    }

    #[tokio::test]
    async fn stopping_works_for_queued_and_running_jobs() {
        let jobs = jobs();
        let running = jobs.enqueue(Work::Check, Trigger::Manual).await.unwrap();
        jobs.cancel(running).await.unwrap();
        let slow = jobs.enqueue(test(5, 5_000), Trigger::Manual).await.unwrap();
        settle().await;
        jobs.cancel(slow).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(status(&jobs, slow), "cancelled");
    }
}
