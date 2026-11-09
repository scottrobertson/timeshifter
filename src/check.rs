//! The regular guide check. It works out what every subscription and scheduled recording
//! wants, queues downloads for whatever is ready, and remembers what's still to come.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::db::{self, now};
use crate::download::{NfoChange, sidecar, sync_nfo};
use crate::jobs::{JobCtx, Jobs, Trigger, Work};
use crate::plan;
use crate::recording::{Channel, Nfo, Program, is_due, is_upcoming, ready_at, ready_at_local};
use crate::scheduled::{self, EXPIRE_AFTER_SECS};
use crate::subscriptions::{self, Subscription, channel_name_matches};

/// What the last check found, for the Overview and Subscriptions pages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LastCheck {
    pub at: i64,
    pub upcoming: Vec<Upcoming>,
    pub subscriptions: Vec<SubscriptionResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upcoming {
    /// The subscription's name, or None for a scheduled recording.
    pub subscription: Option<String>,
    pub channel: String,
    pub stream_id: i64,
    pub title: String,
    pub start: i64,
    pub start_local: String,
    pub ready: i64,
    pub ready_local: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubscriptionResult {
    pub id: i64,
    /// The subscription as it was when checked. Lets the page tell when it's been edited
    /// since, so it doesn't show a result for the old version.
    #[serde(default)]
    pub checked: Subscription,
    pub channel_found: bool,
    pub have: usize,
    pub queued: usize,
    pub upcoming: usize,
}

pub async fn last(db: &db::Db) -> Option<LastCheck> {
    db.call(|conn| db::get(conn, "last_check")).await.ok().flatten()
}

pub async fn run(jobs: &Jobs, ctx: &JobCtx) -> Result<()> {
    let settings = jobs.db().settings().await;
    if !settings.has_provider() {
        bail!("Add your provider in Settings first");
    }
    if settings.download_dir.trim().is_empty() {
        bail!("Set a download folder in Settings first");
    }
    ctx.step("Reading the channel list").await;
    let channels = jobs.guide().channels(&settings, true).await?;
    // Also learns the provider's timezone, which pages show next to guide times.
    let _ = jobs.guide().account(&settings, false).await;
    let (subs, pending) = jobs
        .db()
        .call(|conn| Ok((subscriptions::all(conn)?, scheduled::pending(conn)?)))
        .await?;

    let now = now();
    let grace = settings.ready_grace_minutes;
    let download_dir = Path::new(&settings.download_dir);
    let mut found = LastCheck { at: now, ..LastCheck::default() };
    let mut queued = 0;
    // Two subscriptions on one channel would otherwise each ask for the same guide.
    let mut guides: HashMap<i64, Arc<Vec<Program>>> = HashMap::new();
    ctx.set_total((subs.len() + pending.len()) as i64).await;

    for sub in &subs {
        ctx.check_stopped()?;
        ctx.progress(found.subscriptions.len() as i64, Some((subs.len() + pending.len()) as i64), Some(format!("Checking {}", sub.name))).await;
        let mut result = SubscriptionResult { id: sub.id, checked: sub.clone(), ..SubscriptionResult::default() };
        let matching: Vec<&Channel> = channels.iter().filter(|c| channel_name_matches(&sub.channel, &c.name)).collect();
        result.channel_found = !matching.is_empty();
        if matching.is_empty() {
            ctx.warn(format!("{}: no channel is called \"{}\"", sub.name, sub.channel)).await;
        }
        for channel in matching {
            let programs = match guide_for(jobs, &settings, &mut guides, channel).await {
                Ok(p) => p,
                Err(e) => {
                    ctx.warn(format!("{}: couldn't read the guide for {}: {e:#}", sub.name, channel.name)).await;
                    continue;
                }
            };
            for program in programs.iter().filter(|p| sub.matches_title(&p.title)) {
                let plan = match plan::resolve(&settings, &channel.name, program, &sub.overrides) {
                    Ok(plan) => plan,
                    Err(e) => {
                        ctx.warn(format!("{}: skipped {}: {e:#}", sub.name, program.title)).await;
                        continue;
                    }
                };
                if !is_due(program, plan.padding_after, grace, sub.cutoff(), now) {
                    if is_upcoming(program, plan.padding_after, grace, sub.cutoff(), now) {
                        result.upcoming += 1;
                        found.upcoming.push(upcoming(Some(&sub.name), channel, program, plan.padding_after + grace));
                    }
                    continue;
                }
                let output = download_dir.join(&plan.filename);
                if output.exists() {
                    result.have += 1;
                    let nfo = plan.write_nfo.then(|| Nfo::from_settings(&settings, &channel.name, program));
                    keep_sidecars_current(jobs, ctx, program, &output, nfo, plan.comskip).await?;
                    continue;
                }
                let work = Work::Download { channel: channel.clone(), program: program.clone(), plan, scheduled_id: None };
                result.queued += 1;
                // Already queued, or another airing that saves to the same filename.
                if !jobs.enqueue_new(work, Trigger::Automatic).await?.1 {
                    continue;
                }
                queued += 1;
                ctx.info(format!("{}: queued {} ({})", sub.name, program.title, short(&program.start_local))).await;
            }
        }
        found.subscriptions.push(result);
    }

    for (i, rec) in pending.iter().enumerate() {
        ctx.check_stopped()?;
        ctx.progress((subs.len() + i) as i64, Some((subs.len() + pending.len()) as i64), Some("Checking scheduled recordings".into())).await;
        let Some(channel) = channels.iter().find(|c| channel_name_matches(&rec.channel, &c.name)) else {
            ctx.warn(format!("Scheduled {}: no channel is called \"{}\"", rec.program.title, rec.channel)).await;
            continue;
        };
        let plan = plan::resolve(&settings, &channel.name, &rec.program, &rec.overrides)?;
        if !is_due(&rec.program, plan.padding_after, grace, None, now) {
            found.upcoming.push(upcoming(None, channel, &rec.program, plan.padding_after + grace));
            continue;
        }
        let output = download_dir.join(&plan.filename);
        let id = rec.id;
        if output.exists() {
            let path = output.to_string_lossy().to_string();
            jobs.db().call(move |conn| scheduled::finish(conn, id, "done", Some(&path))).await?;
            ctx.info(format!("Scheduled {}: already downloaded", rec.program.title)).await;
            continue;
        }
        if now > rec.program.end + EXPIRE_AFTER_SECS {
            jobs.db().call(move |conn| scheduled::finish(conn, id, "expired", None)).await?;
            ctx.warn(format!("Gave up on {} after 48 hours of the download not working", rec.program.title)).await;
            continue;
        }
        let work = Work::Download { channel: channel.clone(), program: rec.program.clone(), plan, scheduled_id: Some(rec.id) };
        if !jobs.enqueue_new(work, Trigger::Automatic).await?.1 {
            continue;
        }
        queued += 1;
        ctx.info(format!("Scheduled: queued {} ({})", rec.program.title, short(&rec.program.start_local))).await;
    }

    found.upcoming.sort_by_key(|u| u.start);
    let upcoming_count = found.upcoming.len();
    jobs.db()
        .call(move |conn| {
            scheduled::prune(conn, now)?;
            db::set(conn, "last_check", &found)
        })
        .await?;

    let mut parts = vec![match queued {
        0 => "Nothing new".to_string(),
        1 => "Queued 1 download".to_string(),
        n => format!("Queued {n} downloads"),
    }];
    if upcoming_count > 0 {
        parts.push(format!("{upcoming_count} coming up"));
    }
    ctx.summary(parts.join(", "));
    Ok(())
}

async fn guide_for(
    jobs: &Jobs,
    settings: &crate::settings::Settings,
    guides: &mut HashMap<i64, Arc<Vec<Program>>>,
    channel: &Channel,
) -> Result<Arc<Vec<Program>>> {
    if let Some(hit) = guides.get(&channel.stream_id) {
        return Ok(hit.clone());
    }
    let programs = jobs.guide().programs(settings, channel.stream_id, true).await?;
    guides.insert(channel.stream_id, programs.clone());
    Ok(programs)
}

/// A recording that's already there still gets its .nfo refreshed, and its .edl if comskip
/// is on and it doesn't have one yet.
async fn keep_sidecars_current(
    jobs: &Jobs,
    ctx: &JobCtx,
    program: &Program,
    output: &Path,
    nfo: Option<Nfo>,
    comskip: bool,
) -> Result<()> {
    if let Some(nfo) = nfo {
        match sync_nfo(program, &nfo, false, output) {
            Ok(NfoChange::Created) => ctx.info(format!("Wrote the .nfo for {}", program.title)).await,
            Ok(NfoChange::Updated) => ctx.info(format!("Updated the .nfo for {}", program.title)).await,
            Ok(NfoChange::Unchanged) => {}
            Err(e) => ctx.warn(format!("Couldn't write the .nfo for {}: {e:#}", program.title)).await,
        }
    }
    if comskip && !sidecar(output, "edl").exists() {
        let path = output.to_string_lossy().to_string();
        jobs.enqueue(Work::Comskip { path }, Trigger::Automatic).await?;
    }
    Ok(())
}

fn upcoming(subscription: Option<&str>, channel: &Channel, program: &Program, wait: i64) -> Upcoming {
    Upcoming {
        subscription: subscription.map(str::to_string),
        channel: channel.name.clone(),
        stream_id: channel.stream_id,
        title: program.title.clone(),
        start: program.start,
        start_local: program.start_local.clone(),
        ready: ready_at(program, wait, 0),
        ready_local: ready_at_local(program, wait),
    }
}

/// "YYYY-MM-DD HH:MM:SS" without the seconds.
pub fn short(local: &str) -> &str {
    local.get(..16).unwrap_or(local)
}
