use std::path::Path;

use askama::Template;
use axum::extract::{Path as UrlPath, State};
use axum::response::Response;
use axum_extra::extract::{Form, Query};
use serde::Deserialize;

use super::{AppStateRef, Chrome, boxes, chrome, filled, format, not_found, render, render_string, see_other, words};
use crate::AppState;
use crate::check;
use crate::db::now;
use crate::jobs::{Trigger, Work};
use crate::plan::{self, Overrides};
use crate::recording::{is_due, is_upcoming};
use crate::settings::Settings;
use crate::subscriptions::{self, Subscription, channel_name_matches};

pub struct SubRow {
    pub href: String,
    pub name: String,
    pub channel: String,
    pub words: String,
    pub excludes: String,
    pub details: Vec<String>,
    pub status: Option<(&'static str, String)>,
}

#[derive(Template)]
#[template(path = "subscriptions_body.html")]
struct ListBody {
    rows: Vec<SubRow>,
    checked: Option<(String, String)>,
}

#[derive(Template)]
#[template(path = "subscriptions.html")]
struct ListPage {
    chrome: Chrome,
    body: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    fragment: Option<String>,
}

fn quoted(words: &[String], joiner: &str) -> String {
    let quoted: Vec<String> = words.iter().map(|w| format!("\"{w}\"")).collect();
    match quoted.len() {
        0 => String::new(),
        1 => quoted[0].clone(),
        n => format!("{} {joiner} {}", quoted[..n - 1].join(", "), quoted[n - 1]),
    }
}

/// The settings a subscription changes, in a few words each.
fn details(sub: &Subscription) -> Vec<String> {
    let o = &sub.overrides;
    let mut out = Vec::new();
    if let Some(from) = &sub.from {
        out.push(format!("From {from}"));
    }
    if let Some(b) = o.padding_before {
        out.push(format!("{b} min early"));
    }
    if let Some(a) = o.padding_after {
        out.push(format!("{a} min after"));
    }
    if let Some(t) = &o.filename_template {
        out.push(format!("Saves as {t}"));
    }
    if let Some(n) = o.write_nfo {
        out.push(if n { ".nfo on" } else { ".nfo off" }.into());
    }
    if let Some(c) = o.comskip {
        out.push(if c { "comskip on" } else { "comskip off" }.into());
    }
    out
}

pub async fn list(State(state): AppStateRef, Query(q): Query<ListQuery>) -> Response {
    let subs = state.db.call(|conn| subscriptions::all(conn)).await.unwrap_or_default();
    let last = check::last(&state.db).await;
    let rows = subs
        .iter()
        .map(|s| {
            let result = last.as_ref().and_then(|l| l.subscriptions.iter().find(|r| r.id == s.id));
            let status = result.map(|r| {
                if r.checked != *s {
                    ("quiet", "Changed since the last check".to_string())
                } else if !r.channel_found {
                    ("warn", format!("No channel is called \"{}\"", s.channel))
                } else {
                    let mut parts = vec![format!("{} downloaded", r.have)];
                    if r.queued > 0 {
                        parts.push(format!("{} queued", r.queued));
                    }
                    parts.push(format!("{} coming up", r.upcoming));
                    ("quiet", parts.join(" · "))
                }
            });
            SubRow {
                href: format!("/subscriptions/{}", s.id),
                name: s.name.clone(),
                channel: s.channel.clone(),
                words: quoted(&s.title_contains, "and"),
                excludes: quoted(&s.title_excludes, "or"),
                details: details(s),
                status,
            }
        })
        .collect();
    let body = ListBody { rows, checked: last.map(|l| (format::iso(l.at), format::ago(l.at))) };
    if q.fragment.is_some() {
        return render(body);
    }
    render(ListPage { chrome: chrome(&state, "subscriptions").await, body: render_string(body) })
}

#[derive(Deserialize, Default, Clone)]
pub struct SubForm {
    name: Option<String>,
    channel: Option<String>,
    #[serde(default)]
    title_contains: Vec<String>,
    #[serde(default)]
    title_excludes: Vec<String>,
    from: Option<String>,
    padding_before: Option<String>,
    padding_after: Option<String>,
    filename_template: Option<String>,
    #[serde(default)]
    filename_strip: Vec<String>,
    write_nfo: Option<String>,
    comskip: Option<String>,
}

impl SubForm {
    fn from_subscription(s: &Subscription) -> SubForm {
        let o = &s.overrides;
        let switch = |v: Option<bool>| v.map(|on| if on { "on" } else { "off" }.to_string());
        SubForm {
            name: Some(s.name.clone()),
            channel: Some(s.channel.clone()),
            title_contains: s.title_contains.clone(),
            title_excludes: s.title_excludes.clone(),
            from: s.from.clone(),
            padding_before: o.padding_before.map(|v| v.to_string()),
            padding_after: o.padding_after.map(|v| v.to_string()),
            filename_template: o.filename_template.clone(),
            filename_strip: o.filename_strip.clone().unwrap_or_default(),
            write_nfo: switch(o.write_nfo),
            comskip: switch(o.comskip),
        }
    }

    fn to_subscription(&self, id: i64) -> Result<Subscription, String> {
        let minutes = |v: &Option<String>| -> Result<Option<i64>, String> {
            filled(v).map(|v| v.parse().map_err(|_| "Padding has to be a whole number of minutes".to_string())).transpose()
        };
        let switch = |v: &Option<String>| match v.as_deref() {
            Some("on") => Some(true),
            Some("off") => Some(false),
            _ => None,
        };
        let sub = Subscription {
            id,
            name: filled(&self.name).unwrap_or_default(),
            channel: filled(&self.channel).unwrap_or_default(),
            title_contains: words(&self.title_contains),
            title_excludes: words(&self.title_excludes),
            from: filled(&self.from),
            overrides: Overrides {
                padding_before: minutes(&self.padding_before)?,
                padding_after: minutes(&self.padding_after)?,
                filename_template: filled(&self.filename_template),
                filename_strip: Some(words(&self.filename_strip)).filter(|w| !w.is_empty()),
                write_nfo: switch(&self.write_nfo),
                comskip: switch(&self.comskip),
                filename: None,
            },
        };
        subscriptions::validate(&sub).map_err(|e| e.to_string())?;
        Ok(sub)
    }

    fn get(&self, field: &str) -> String {
        let value = match field {
            "name" => &self.name,
            "channel" => &self.channel,
            "from" => &self.from,
            "padding_before" => &self.padding_before,
            "padding_after" => &self.padding_after,
            "filename_template" => &self.filename_template,
            "write_nfo" => &self.write_nfo,
            "comskip" => &self.comskip,
            _ => &None,
        };
        value.clone().unwrap_or_default()
    }

    fn values(&self, field: &str) -> Vec<String> {
        boxes(match field {
            "title_contains" => &self.title_contains,
            "title_excludes" => &self.title_excludes,
            "filename_strip" => &self.filename_strip,
            _ => &[],
        })
    }
}

pub struct Match {
    pub title: String,
    pub when: String,
    pub tone: &'static str,
    pub label: &'static str,
}

#[derive(Template)]
#[template(path = "subscription_form.html")]
struct FormPage {
    chrome: Chrome,
    id: i64,
    form: SubForm,
    defaults: Settings,
    channels: Vec<String>,
    error: Option<String>,
    matches: String,
    strip_placeholder: String,
}

/// The "In the guide now" panel, which redraws as the form is edited.
#[derive(Template, Default)]
#[template(path = "subscription_matches.html")]
struct MatchesPanel {
    hint: Option<String>,
    error: Option<String>,
    matches: Vec<Match>,
    more_matches: usize,
}

#[derive(Deserialize)]
pub struct FormQuery {
    fragment: Option<String>,
}

const MATCHES_SHOWN: usize = 25;

async fn matches_panel(state: &AppState, settings: &Settings, form: &SubForm) -> MatchesPanel {
    if filled(&form.channel).is_none() || words(&form.title_contains).is_empty() {
        return MatchesPanel {
            hint: Some("Pick a channel and a word the title has to contain to see what it matches.".into()),
            ..MatchesPanel::default()
        };
    }
    // The name doesn't change what matches, so a missing one shouldn't stop the preview.
    let mut form = form.clone();
    if filled(&form.name).is_none() {
        form.name = Some("Preview".into());
    }
    let sub = match form.to_subscription(0) {
        Ok(sub) => sub,
        Err(e) => return MatchesPanel { error: Some(e), ..MatchesPanel::default() },
    };
    match matches_for(state, settings, &sub).await {
        Ok(mut matches) => {
            let more_matches = matches.len().saturating_sub(MATCHES_SHOWN);
            matches.truncate(MATCHES_SHOWN);
            MatchesPanel { matches, more_matches, ..MatchesPanel::default() }
        }
        Err(e) => MatchesPanel { error: Some(e), ..MatchesPanel::default() },
    }
}

/// Edits to the form ask for just the panel, with the form's values in the query string.
async fn preview(state: &AppState, form: &SubForm) -> Response {
    let settings = state.db.settings().await;
    render(matches_panel(state, &settings, form).await)
}

async fn form_page(state: &AppState, id: i64, form: SubForm, error: Option<String>) -> Response {
    let settings = state.db.settings().await;
    let channels = state.guide.cached_channels().unwrap_or_default();
    // The channel list is only for suggestions, so a page never waits long on the provider for it.
    let channels = if channels.is_empty() && settings.has_provider() {
        state.guide.channels(&settings, false).await.unwrap_or_default()
    } else {
        channels
    };
    let mut names: Vec<String> = channels.iter().map(|c| c.name.clone()).collect();
    names.dedup();

    let matches = render_string(matches_panel(state, &settings, &form).await);
    render(FormPage {
        chrome: chrome(state, "subscriptions").await,
        id,
        form,
        strip_placeholder: settings.filename_strip.join(", "),
        defaults: settings,
        channels: names,
        error,
        matches,
    })
}

/// What the subscription picks out of the guide right now, soonest to come first.
async fn matches_for(state: &AppState, settings: &Settings, sub: &Subscription) -> Result<Vec<Match>, String> {
    if !settings.has_provider() {
        return Ok(vec![]);
    }
    let channels = state.guide.channels(settings, false).await.map_err(|e| format!("Couldn't read the channel list: {e:#}"))?;
    let Some(channel) = channels.iter().find(|c| channel_name_matches(&sub.channel, &c.name)) else {
        return Err(format!("No channel is called \"{}\". The name has to match the channel list.", sub.channel));
    };
    let programs = state
        .guide
        .programs(settings, channel.stream_id, false)
        .await
        .map_err(|e| format!("Couldn't read the guide: {e:#}"))?;
    let now = now();
    let mut out: Vec<(i64, Match)> = programs
        .iter()
        .filter(|p| sub.matches_title(&p.title))
        .map(|p| {
            let plan = plan::resolve(settings, &channel.name, p, &sub.overrides);
            let after = plan.as_ref().map(|p| p.padding_after).unwrap_or(0);
            let (tone, label) = if plan
                .as_ref()
                .is_ok_and(|plan| !settings.download_dir.is_empty() && Path::new(&settings.download_dir).join(&plan.filename).exists())
            {
                ("have", "Downloaded")
            } else if is_due(p, after, settings.ready_grace_minutes, sub.cutoff(), now) {
                ("queued", "Next check")
            } else if is_upcoming(p, after, settings.ready_grace_minutes, sub.cutoff(), now) {
                ("scheduled", "Coming up")
            } else if sub.cutoff().is_some_and(|c| p.end <= c) {
                ("quiet", "Before From")
            } else {
                ("quiet", "Not in the archive")
            };
            (p.start, Match { title: p.title.clone(), when: format::when(&p.start_local), tone, label })
        })
        .collect();
    // Coming up soonest first, then the archive newest first.
    out.sort_by_key(|(start, m)| (m.tone != "scheduled", if m.tone == "scheduled" { *start } else { -*start }));
    Ok(out.into_iter().map(|(_, m)| m).collect())
}

pub async fn new_form(State(state): AppStateRef, Query(q): Query<FormQuery>, Query(form): Query<SubForm>) -> Response {
    if q.fragment.is_some() {
        return preview(&state, &form).await;
    }
    form_page(&state, 0, SubForm::default(), None).await
}

pub async fn create(State(state): AppStateRef, Form(form): Form<SubForm>) -> Response {
    let sub = match form.to_subscription(0) {
        Ok(s) => s,
        Err(e) => return form_page(&state, 0, form, Some(e)).await,
    };
    match state.db.call(move |conn| subscriptions::save(conn, &sub)).await {
        Ok(id) => {
            check_soon(&state).await;
            see_other(&format!("/subscriptions/{id}?saved=1"))
        }
        Err(e) => form_page(&state, 0, form, Some(format!("Couldn't save it: {e:#}"))).await,
    }
}

pub async fn edit_form(
    State(state): AppStateRef,
    UrlPath(id): UrlPath<i64>,
    Query(q): Query<FormQuery>,
    Query(form): Query<SubForm>,
) -> Response {
    if q.fragment.is_some() {
        return preview(&state, &form).await;
    }
    match state.db.call(move |conn| subscriptions::get(conn, id)).await {
        Ok(Some(sub)) => form_page(&state, id, SubForm::from_subscription(&sub), None).await,
        _ => not_found("Subscription"),
    }
}

pub async fn update(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Form(form): Form<SubForm>) -> Response {
    let sub = match form.to_subscription(id) {
        Ok(s) => s,
        Err(e) => return form_page(&state, id, form, Some(e)).await,
    };
    match state.db.call(move |conn| subscriptions::save(conn, &sub)).await {
        Ok(_) => {
            check_soon(&state).await;
            see_other("/subscriptions")
        }
        Err(e) => form_page(&state, id, form, Some(format!("Couldn't save it: {e:#}"))).await,
    }
}

/// Checks the guide straight after a subscription is saved, so its status on the list
/// reflects the change and anything it now matches starts downloading.
async fn check_soon(state: &AppState) {
    if state.db.settings().await.has_provider() {
        let _ = state.jobs.enqueue(Work::Check, Trigger::Manual).await;
    }
}

pub async fn delete(State(state): AppStateRef, UrlPath(id): UrlPath<i64>) -> Response {
    let _ = state.db.call(move |conn| subscriptions::delete(conn, id)).await;
    see_other("/subscriptions")
}
