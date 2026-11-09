//! Browsing the channels and their guides, and picking a show to download or schedule.

use std::collections::HashMap;
use std::path::Path;

use askama::Template;
use axum::extract::{Path as UrlPath, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum_extra::extract::{Form, Query};
use serde::Deserialize;

use super::{AppStateRef, Chrome, chrome, done, filled, format, not_found, render, render_string, see_other};
use crate::AppState;
use crate::db::now;
use crate::jobs::{self, Trigger, Work};
use crate::plan::{self, Overrides, Plan};
use crate::presets::{self, Preset};
use crate::recording::{
    Channel, Fields, Nfo, Program, custom_words, filename_with_fields, planned_window, ready_at_local, recording_window,
};
use crate::scheduled;
use crate::settings::Settings;
use crate::starred;
use crate::subscriptions::{self, Subscription, channel_name_matches};

pub struct ChannelRow {
    pub href: String,
    pub name: String,
    pub group: String,
    pub archive_days: i64,
    pub search: String,
    pub starred: bool,
}

#[derive(Template)]
#[template(path = "channels.html")]
struct ChannelsPage {
    chrome: Chrome,
    starred: Vec<ChannelRow>,
    rows: Vec<ChannelRow>,
    groups: usize,
    error: Option<String>,
}

pub async fn list(State(state): AppStateRef) -> Response {
    let settings = state.db.settings().await;
    let starred_names = state.db.call(|conn| starred::all(conn)).await.unwrap_or_default();
    let (all, error) = if !settings.has_provider() {
        (vec![], None)
    } else {
        match state.guide.channels(&settings, false).await {
            Ok(channels) => (channels.iter().map(|c| channel_row(c, &starred_names)).collect(), None),
            Err(e) => (vec![], Some(format!("Couldn't read the channel list: {e:#}"))),
        }
    };
    let mut groups: Vec<&str> = all.iter().map(|r: &ChannelRow| r.group.as_str()).collect();
    groups.sort();
    groups.dedup();
    let groups = groups.len();
    let (starred, rows) = all.into_iter().partition(|r| r.starred);
    render(ChannelsPage { groups, chrome: chrome(&state, "channels").await, starred, rows, error })
}

fn channel_row(c: &Channel, starred_names: &[String]) -> ChannelRow {
    let group = c.group.clone().unwrap_or_default();
    ChannelRow {
        href: format!("/channels/{}", c.stream_id),
        search: format!("{} {group}", c.name),
        starred: starred_names.contains(&c.name.trim().to_lowercase()),
        name: c.name.clone(),
        group,
        archive_days: c.archive_days,
    }
}

#[derive(Deserialize)]
pub struct StarForm {
    name: String,
    starred: String,
}

pub async fn star(State(state): AppStateRef, headers: HeaderMap, Form(form): Form<StarForm>) -> Response {
    let on = form.starred == "1";
    let _ = state.db.call(move |conn| starred::set(conn, &form.name, on)).await;
    done(&headers)
}

/// Throws away what's remembered about the provider, so the next page reads it fresh.
pub async fn refresh(State(state): AppStateRef, headers: HeaderMap) -> Response {
    state.guide.clear();
    done(&headers)
}

#[derive(Deserialize)]
pub struct GuideQuery {
    view: Option<String>,
    fragment: Option<String>,
}

pub struct GuideRow {
    pub title: String,
    pub description: String,
    pub time: String,
    pub search: String,
    pub on_now: bool,
    pub muted: bool,
    pub state: Option<(&'static str, String)>,
    pub action: Option<(&'static str, String)>,
    pub note: String,
}

pub struct GuideDay {
    pub label: String,
    pub rows: Vec<GuideRow>,
}

#[derive(Template)]
#[template(path = "guide_body.html")]
struct GuideBody {
    days: Vec<GuideDay>,
    upcoming: bool,
    error: Option<String>,
}

#[derive(Template)]
#[template(path = "guide.html")]
struct GuidePage {
    chrome: Chrome,
    channel: Channel,
    timezone: String,
    upcoming: bool,
    src: String,
    body: String,
}

pub async fn guide(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Query(q): Query<GuideQuery>) -> Response {
    let settings = state.db.settings().await;
    let channel = match state.guide.channel(&settings, id).await {
        Ok(Some(c)) => c,
        Ok(None) => return not_found("Channel"),
        Err(e) => return error_page(&state, "channels", format!("Couldn't read the channel list: {e:#}")).await,
    };
    let upcoming = q.view.as_deref() == Some("upcoming");
    let body = guide_body(&state, &settings, &channel, upcoming).await;
    if q.fragment.is_some() {
        return render(body);
    }
    let _ = state.guide.account(&settings, false).await;
    render(GuidePage {
        chrome: chrome(&state, "channels").await,
        timezone: state.guide.timezone().unwrap_or_default(),
        src: format!("/channels/{id}{}", if upcoming { "?view=upcoming" } else { "" }),
        body: render_string(body),
        channel,
        upcoming,
    })
}

/// What's already happening for each recording, keyed by its filename.
async fn active_downloads(state: &AppState) -> HashMap<String, String> {
    let active = state.db.call(|conn| jobs::active(conn)).await.unwrap_or_default();
    active
        .into_iter()
        .filter_map(|j| match j.work() {
            Some(Work::Download { plan, .. }) => Some((plan.filename, j.status)),
            _ => None,
        })
        .collect()
}

async fn guide_body(state: &AppState, settings: &Settings, channel: &Channel, upcoming: bool) -> GuideBody {
    let programs = match state.guide.programs(settings, channel.stream_id, false).await {
        Ok(p) => p,
        Err(e) => {
            return GuideBody {
                days: vec![],
                upcoming,
                error: Some(format!("Couldn't read the guide: {e:#}")),
            };
        }
    };
    let (subs, scheduled) = state
        .db
        .call(|conn| Ok((subscriptions::all(conn)?, scheduled::pending(conn)?)))
        .await
        .unwrap_or_default();
    let subs: Vec<Subscription> = subs.into_iter().filter(|s| channel_name_matches(&s.channel, &channel.name)).collect();
    let active = active_downloads(state).await;
    let now = now();
    let download_dir = Path::new(&settings.download_dir);

    let mut shown: Vec<&Program> = programs
        .iter()
        .filter(|p| if upcoming { p.end > now } else { p.start <= now })
        .collect();
    if upcoming {
        shown.reverse();
    }

    let mut days: Vec<GuideDay> = Vec::new();
    for p in shown {
        let sub = subs.iter().find(|s| s.matches_title(&p.title));
        let overrides = sub.map(|s| s.overrides.clone()).unwrap_or_default();
        let filename = plan::resolve(settings, &channel.name, p, &overrides).map(|plan| plan.filename).ok();
        let on_now = p.start <= now && p.end > now;
        let is_scheduled = scheduled.iter().any(|s| channel_name_matches(&s.channel, &channel.name) && s.program.start == p.start);

        let state_chip = match filename.as_ref() {
            Some(f) if active.get(f).map(String::as_str) == Some("running") => Some(("running", "Downloading".to_string())),
            Some(f) if active.contains_key(f) => Some(("queued", "Queued".to_string())),
            Some(f) if !settings.download_dir.is_empty() && download_dir.join(f).exists() => Some(("have", "Downloaded".to_string())),
            _ if is_scheduled => Some(("scheduled", "Scheduled".to_string())),
            _ => None,
        };
        let plan_href = |mode: &str| format!("/channels/{}/plan?start={}&mode={mode}", channel.stream_id, p.start);
        let action = match (upcoming, &state_chip) {
            (_, Some(_)) => None,
            (true, None) => Some(("Schedule", plan_href("schedule"))),
            (false, None) if p.has_archive => Some(("Download", plan_href("download"))),
            (false, None) if on_now => Some(("Schedule", plan_href("schedule"))),
            _ => None,
        };
        let note = match (sub, upcoming) {
            (Some(s), _) => format!("Matches {}", s.name),
            (None, false) if on_now && !p.has_archive => "On now. Schedule it to get the whole thing once it ends.".into(),
            (None, false) if !p.has_archive => "Not in the archive".into(),
            (None, false) if on_now => "On now, so only what has aired so far".into(),
            _ => String::new(),
        };
        let row = GuideRow {
            title: p.title.clone(),
            description: p.description.clone(),
            time: time_range(p),
            search: format!("{} {}", p.title, p.description),
            on_now,
            muted: !upcoming && !p.has_archive && !on_now,
            state: state_chip,
            action,
            note,
        };
        let label = format::day(&p.start_local);
        match days.last_mut() {
            Some(day) if day.label == label => day.rows.push(row),
            _ => days.push(GuideDay { label, rows: vec![row] }),
        }
    }
    GuideBody { days, upcoming, error: None }
}

/// "21:30–22:30", with the end day too when the show runs past midnight.
fn time_range(p: &Program) -> String {
    let same_day = p.start_local.get(..10) == p.end_local.get(..10);
    let end = if same_day { format::hm(&p.end_local) } else { format::when(&p.end_local) };
    format!("{}–{}", format::hm(&p.start_local), end)
}

#[derive(Deserialize, Default)]
pub struct PlanForm {
    start: i64,
    mode: Option<String>,
    fragment: Option<String>,
    /// Set by the form itself. Unticked boxes aren't sent at all, so without this a first
    /// visit (use the defaults) and an unticked box (off) would look the same.
    form: Option<String>,
    padding_before: Option<String>,
    padding_after: Option<String>,
    filename: Option<String>,
    write_nfo: Option<String>,
    comskip: Option<String>,
    nfo_title: Option<String>,
    nfo_plot: Option<String>,
    nfo_set: Option<String>,
    preset: Option<String>,
    /// A preset's made up words, and what was typed for each, as two lists in the same order.
    #[serde(default)]
    field_name: Vec<String>,
    #[serde(default)]
    field_value: Vec<String>,
}

impl PlanForm {
    fn preset_id(&self) -> Option<i64> {
        self.preset.as_deref().and_then(|p| p.parse().ok())
    }

    fn fields(&self) -> Vec<(String, String)> {
        self.field_name.iter().cloned().zip(self.field_value.iter().cloned()).collect()
    }
}

/// What the form's boxes hold. With a preset they hold its templates, and the {words} get
/// filled in when the plan is made.
#[derive(Clone)]
struct Boxes {
    filename: String,
    padding_before: i64,
    padding_after: i64,
    write_nfo: bool,
    comskip: bool,
    nfo: Nfo,
}

pub struct PresetOption {
    href: String,
    name: String,
    selected: bool,
}

/// A box on the download page for one of a preset's made up words.
pub struct FieldBox {
    name: String,
    label: String,
    value: String,
    suggestions: Vec<String>,
}

/// "event_name" as a label, "Event name".
fn label(word: &str) -> String {
    let spaced = word.replace('_', " ");
    let mut chars = spaced.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[derive(Template)]
#[template(path = "plan_preview.html")]
struct PlanPreview {
    schedule: bool,
    title: Option<String>,
    on_now: bool,
    timezone: String,
    start: String,
    end: String,
    minutes: i64,
    ready: String,
    saving: String,
    exists: bool,
    no_folder: bool,
    error: Option<String>,
}

#[derive(Template)]
#[template(path = "plan.html")]
struct PlanPage {
    chrome: Chrome,
    channel: Channel,
    program: Program,
    airs: String,
    ends: String,
    runtime: i64,
    schedule: bool,
    can_download: bool,
    can_schedule: bool,
    b: Boxes,
    presets: Vec<PresetOption>,
    preset_id: String,
    fields: Vec<FieldBox>,
    default_filename: String,
    start: i64,
    back_href: String,
    preview: String,
    error: Option<String>,
}

impl PlanPage {
    /// Keeps the chosen preset when switching between downloading and scheduling.
    fn mode_href(&self, mode: &str) -> String {
        let preset = if self.preset_id.is_empty() { String::new() } else { format!("&preset={}", self.preset_id) };
        format!("?start={}&mode={mode}{preset}", self.start)
    }
}

struct Picked {
    settings: Settings,
    channel: Channel,
    program: Program,
    preset: Option<Preset>,
    presets: Vec<Preset>,
}

async fn pick(state: &AppState, id: i64, form: &PlanForm) -> Result<Picked, Box<Response>> {
    let start = form.start;
    let settings = state.db.settings().await;
    let fail = |error: String| async move { Box::new(error_page(state, "channels", error).await) };
    let channel = match state.guide.channel(&settings, id).await {
        Ok(Some(c)) => c,
        Ok(None) => return Err(Box::new(not_found("Channel"))),
        Err(e) => return Err(fail(format!("Couldn't read the channel list: {e:#}")).await),
    };
    let programs = match state.guide.programs(&settings, id, false).await {
        Ok(p) => p,
        Err(e) => return Err(fail(format!("Couldn't read the guide: {e:#}")).await),
    };
    let Some(program) = programs.iter().find(|p| p.start == start).cloned() else {
        return Err(fail("That show isn't in the guide any more. Pick it again from the channel's guide.".into()).await);
    };
    let presets = state.db.call(|conn| presets::all(conn)).await.unwrap_or_default();
    let preset = form.preset_id().and_then(|id| presets.iter().find(|p| p.id == id).cloned());
    Ok(Picked { settings, channel, program, preset, presets })
}

fn templated_nfo(picked: &Picked) -> Nfo {
    Nfo::from_settings(&picked.settings, &picked.channel.name, &picked.program)
}

/// What the boxes start out holding: the preset's templates, or the plan from the settings.
fn initial_boxes(picked: &Picked, defaults: &Plan) -> Boxes {
    let s = &picked.settings;
    match &picked.preset {
        Some(p) => Boxes {
            filename: p.filename(s),
            padding_before: p.padding_before.unwrap_or(s.padding_before),
            padding_after: p.padding_after.unwrap_or(s.padding_after),
            write_nfo: p.write_nfo,
            comskip: p.comskip,
            nfo: p.nfo(s),
        },
        None => Boxes {
            filename: defaults.filename.clone(),
            padding_before: defaults.padding_before,
            padding_after: defaults.padding_after,
            write_nfo: defaults.write_nfo,
            comskip: defaults.comskip,
            nfo: templated_nfo(picked),
        },
    }
}

/// The boxes as the form has them, falling back to how they started for anything not sent.
fn boxes_from(form: &PlanForm, initial: &Boxes) -> Result<Boxes, String> {
    let minutes = |value: &Option<String>, fallback: i64| -> Result<i64, String> {
        match filled(value) {
            None => Ok(fallback),
            Some(v) => v.parse().map_err(|_| "Padding has to be a whole number of minutes".to_string()),
        }
    };
    let sent = form.form.is_some();
    let ticked = |value: &Option<String>, fallback: bool| if sent { value.is_some() } else { fallback };
    // Browsers send line breaks in a textarea as \r\n.
    let plot = |v: &str| v.replace("\r\n", "\n").trim().to_string();
    Ok(Boxes {
        filename: filled(&form.filename).unwrap_or_else(|| initial.filename.clone()),
        padding_before: minutes(&form.padding_before, initial.padding_before)?,
        padding_after: minutes(&form.padding_after, initial.padding_after)?,
        write_nfo: ticked(&form.write_nfo, initial.write_nfo),
        comskip: ticked(&form.comskip, initial.comskip),
        nfo: Nfo {
            title: filled(&form.nfo_title).unwrap_or_else(|| initial.nfo.title.clone()),
            plot: plot(form.nfo_plot.as_deref().unwrap_or(&initial.nfo.plot)),
            set: if sent { filled(&form.nfo_set).unwrap_or_default() } else { initial.nfo.set.clone() },
        },
    })
}

/// The plan the boxes describe, with the preset's words filled in. The .nfo is only kept
/// when it says something other than the Settings templates.
fn plan_from(boxes: &Boxes, picked: &Picked, fields: &Fields) -> Result<Plan, String> {
    let (channel, program) = (&picked.channel.name, &picked.program);
    let filename = filename_with_fields(channel, program, &boxes.filename, &picked.settings.filename_strip, fields)
        .map_err(|e| format!("{e:#}"))?;
    let nfo = Nfo::from_templates(&boxes.nfo, channel, program, fields);
    let templated = templated_nfo(picked);
    let templated = Nfo { plot: templated.plot.replace("\r\n", "\n"), ..templated };
    Ok(Plan {
        filename,
        padding_before: boxes.padding_before,
        padding_after: boxes.padding_after,
        write_nfo: boxes.write_nfo,
        comskip: boxes.comskip,
        nfo: (nfo != templated).then_some(nfo),
    })
}

/// The preset's words that are used but haven't been typed in yet.
fn missing(boxes: &Boxes, fields: &Fields) -> Vec<String> {
    let mut templates = vec![boxes.filename.as_str()];
    if boxes.write_nfo {
        templates.extend([boxes.nfo.title.as_str(), boxes.nfo.plot.as_str(), boxes.nfo.set.as_str()]);
    }
    custom_words(&templates)
        .into_iter()
        .filter(|w| !fields.iter().any(|(k, v)| k == w && !v.trim().is_empty()))
        .collect()
}

fn plan_for(form: &PlanForm, picked: &Picked, defaults: &Plan) -> (Result<Boxes, String>, Result<Plan, String>) {
    let boxes = boxes_from(form, &initial_boxes(picked, defaults));
    let plan = boxes.as_ref().map_err(Clone::clone).and_then(|b| plan_from(b, picked, &form.fields()));
    (boxes, plan)
}

fn wants_schedule(form: &PlanForm, program: &Program) -> bool {
    match form.mode.as_deref() {
        Some("schedule") => true,
        Some("download") => false,
        _ => program.start > now(),
    }
}

fn preview(state: &AppState, picked: &Picked, plan: &Result<Plan, String>, schedule: bool) -> PlanPreview {
    let p = &picked.program;
    let timezone = state.guide.timezone().unwrap_or_default();
    let mut view = PlanPreview {
        schedule,
        title: None,
        on_now: p.start <= now() && p.end > now(),
        timezone,
        start: String::new(),
        end: String::new(),
        minutes: 0,
        ready: String::new(),
        saving: String::new(),
        exists: false,
        no_folder: picked.settings.download_dir.trim().is_empty(),
        error: None,
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(e) => {
            view.error = Some(e.clone());
            return view;
        }
    };
    // A show that hasn't aired has no footage to cap the window at, so show the whole of it.
    let window = if schedule {
        planned_window(p, plan.padding_before, plan.padding_after)
    } else {
        recording_window(p, plan.padding_before, plan.padding_after, now())
    };
    match window {
        Ok(w) => {
            view.start = format::when(&w.start_local);
            view.end = format::when(&w.end_local);
            view.minutes = w.minutes;
        }
        Err(e) => view.error = Some(format!("{e:#}")),
    }
    view.ready = format::when(&ready_at_local(p, plan.padding_after + picked.settings.ready_grace_minutes));
    let path = Path::new(&picked.settings.download_dir).join(&plan.filename);
    view.exists = !view.no_folder && path.exists();
    view.saving = path.to_string_lossy().to_string();
    if plan.write_nfo {
        view.title = Some(plan.nfo.clone().unwrap_or_else(|| templated_nfo(picked)).title);
    }
    view
}

pub async fn plan_page(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Query(form): Query<PlanForm>) -> Response {
    let picked = match pick(&state, id, &form).await {
        Ok(p) => p,
        Err(r) => return *r,
    };
    let _ = state.guide.account(&picked.settings, false).await;
    let defaults = match plan::resolve(&picked.settings, &picked.channel.name, &picked.program, &Overrides::default()) {
        Ok(d) => d,
        Err(e) => return error_page(&state, "channels", format!("{e:#}")).await,
    };
    let schedule = wants_schedule(&form, &picked.program);
    let (boxes, plan) = plan_for(&form, &picked, &defaults);
    let preview = preview(&state, &picked, &plan, schedule);
    if form.fragment.is_some() {
        return render(preview);
    }
    let boxes = boxes.unwrap_or_else(|_| initial_boxes(&picked, &defaults));
    plan_view(&state, picked, &form, defaults, boxes, schedule, render_string(preview), None).await
}

#[allow(clippy::too_many_arguments)]
async fn plan_view(
    state: &AppState,
    picked: Picked,
    form: &PlanForm,
    defaults: Plan,
    boxes: Boxes,
    schedule: bool,
    preview: String,
    error: Option<String>,
) -> Response {
    let p = &picked.program;
    let now = now();
    let plan_href = format!("/channels/{}/plan?start={}&mode={}", picked.channel.stream_id, p.start, if schedule { "schedule" } else { "download" });
    let selected = picked.preset.as_ref().map(|p| p.id);
    let mut presets = vec![PresetOption { href: plan_href.clone(), name: "None".into(), selected: selected.is_none() }];
    presets.extend(picked.presets.iter().map(|p| PresetOption {
        href: format!("{plan_href}&preset={}", p.id),
        name: p.name.clone(),
        selected: selected == Some(p.id),
    }));
    let typed = form.fields();
    let fields = match &picked.preset {
        Some(preset) => preset
            .words(&picked.settings)
            .into_iter()
            .map(|word| FieldBox {
                label: label(&word),
                value: typed.iter().find(|(k, _)| *k == word).map(|(_, v)| v.clone()).unwrap_or_default(),
                suggestions: preset.history.get(&word).cloned().unwrap_or_default(),
                name: word,
            })
            .collect(),
        None => vec![],
    };
    render(PlanPage {
        presets: if picked.presets.is_empty() { vec![] } else { presets },
        preset_id: selected.map(|id| id.to_string()).unwrap_or_default(),
        fields,
        b: boxes,
        chrome: chrome(state, "channels").await,
        airs: format::when(&p.start_local),
        ends: format::when(&p.end_local),
        runtime: ((p.end - p.start) as f64 / 60.0).round() as i64,
        can_download: p.has_archive && p.start <= now,
        can_schedule: p.end > now,
        default_filename: defaults.filename,
        start: p.start,
        back_href: format!("/channels/{}{}", picked.channel.stream_id, if schedule { "?view=upcoming" } else { "" }),
        schedule,
        preview,
        error,
        channel: picked.channel,
        program: picked.program,
    })
}

pub async fn plan_submit(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Form(form): Form<PlanForm>) -> Response {
    let picked = match pick(&state, id, &form).await {
        Ok(p) => p,
        Err(r) => return *r,
    };
    let defaults = match plan::resolve(&picked.settings, &picked.channel.name, &picked.program, &Overrides::default()) {
        Ok(d) => d,
        Err(e) => return error_page(&state, "channels", format!("{e:#}")).await,
    };
    let schedule = wants_schedule(&form, &picked.program);
    let fields = form.fields();
    let (boxes, plan) = plan_for(&form, &picked, &defaults);
    let blank = boxes.as_ref().map(|b| missing(b, &fields)).unwrap_or_default();
    let problem = match &plan {
        Err(e) => Some(e.clone()),
        Ok(_) if !blank.is_empty() => {
            Some(format!("Fill in {} first", blank.iter().map(|w| label(w)).collect::<Vec<_>>().join(" and ")))
        }
        Ok(_) if picked.settings.download_dir.trim().is_empty() => Some("Set a download folder in Settings first".into()),
        Ok(_) if schedule && picked.program.end <= now() => Some("This show has already finished, so download it instead".into()),
        Ok(_) if !schedule && !(picked.program.has_archive && picked.program.start <= now()) => {
            Some("This show isn't in the archive yet, so schedule it instead".into())
        }
        Ok(_) => None,
    };
    if let Some(error) = problem {
        let preview = render_string(preview(&state, &picked, &plan, schedule));
        let shown = boxes.unwrap_or_else(|_| initial_boxes(&picked, &defaults));
        return plan_view(&state, picked, &form, defaults, shown, schedule, preview, Some(error)).await;
    }
    let plan = plan.expect("checked above");
    if let Some(id) = picked.preset.as_ref().map(|p| p.id) {
        let _ = state.db.call(move |conn| presets::remember(conn, id, &fields)).await;
    }

    if schedule {
        let overrides = plan::changes(&plan, &defaults);
        let (channel, program) = (picked.channel.name.clone(), picked.program.clone());
        if let Err(e) = state.db.call(move |conn| scheduled::add(conn, &channel, &program, &overrides)).await {
            return error_page(&state, "channels", format!("Couldn't save it: {e:#}")).await;
        }
        state.live.nudge("jobs");
        return see_other("/scheduled");
    }

    let work = Work::Download { channel: picked.channel, program: picked.program, plan, scheduled_id: None };
    match state.jobs.enqueue(work, Trigger::Manual).await {
        Ok(job) => see_other(&format!("/jobs/{job}")),
        Err(e) => error_page(&state, "channels", format!("Couldn't queue the download: {e:#}")).await,
    }
}

#[derive(Template)]
#[template(path = "error.html")]
struct ErrorPage {
    chrome: Chrome,
    error: String,
}

pub async fn error_page(state: &AppState, nav: &'static str, error: String) -> Response {
    render(ErrorPage { chrome: chrome(state, nav).await, error })
}
