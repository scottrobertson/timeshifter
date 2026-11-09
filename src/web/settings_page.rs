use std::path::Path;

use askama::Template;
use axum::extract::{Path as UrlPath, Query, State};
use axum::response::Response;
use axum_extra::extract::Form;
use serde::Deserialize;

use super::{AppStateRef, Chrome, boxes, chrome, filled, render, see_other, words};
use crate::AppState;
use crate::presets::{self, Preset};
use crate::settings::{Settings, TimeshiftMode};
use crate::xtream;

#[derive(Deserialize)]
pub struct PageQuery {
    saved: Option<String>,
    /// The preset to show opened, after adding or saving it.
    preset: Option<i64>,
}

/// A preset as the Settings page shows it.
struct PresetCard {
    preset: Preset,
    open: bool,
    saved: bool,
    error: Option<String>,
}

#[derive(Template)]
#[template(path = "settings.html")]
struct Page {
    chrome: Chrome,
    s: Settings,
    php: bool,
    has_password: bool,
    saved: bool,
    error: Option<String>,
    folder_note: Option<String>,
    config_dir: String,
    strip: Vec<String>,
    presets: Vec<PresetCard>,
}

fn folder_note(settings: &Settings) -> Option<String> {
    let dir = settings.download_dir.trim();
    if dir.is_empty() {
        return Some("Nothing can be downloaded until this is set.".into());
    }
    let path = Path::new(dir);
    if !path.exists() {
        return Some("This folder doesn't exist yet. It gets made on the first download.".into());
    }
    if !path.is_dir() {
        return Some("This is a file, not a folder.".into());
    }
    None
}

/// What happened to one preset, to show on its card.
#[derive(Default)]
struct PresetNote {
    open: Option<i64>,
    saved: bool,
    error: Option<String>,
    /// What was typed, when it couldn't be saved.
    typed: Option<Preset>,
}

async fn page_with(state: &AppState, s: Settings, saved: bool, error: Option<String>) -> Response {
    page_with_presets(state, s, saved, error, PresetNote::default()).await
}

async fn page_with_presets(state: &AppState, s: Settings, saved: bool, error: Option<String>, note: PresetNote) -> Response {
    let has_password = !state.db.settings().await.password.is_empty();
    let presets = state.db.call(|conn| presets::all(conn)).await.unwrap_or_default();
    let presets = presets
        .into_iter()
        .map(|p| {
            let here = note.open == Some(p.id);
            PresetCard {
                preset: note.typed.clone().filter(|_| here).unwrap_or(p),
                open: here,
                saved: here && note.saved,
                error: note.error.clone().filter(|_| here),
            }
        })
        .collect();
    render(Page {
        presets,
        chrome: chrome(state, "settings").await,
        folder_note: folder_note(&s),
        config_dir: state.config_dir.display().to_string(),
        php: s.timeshift_mode == TimeshiftMode::Php,
        strip: boxes(&s.filename_strip),
        s,
        has_password,
        saved,
        error,
    })
}

pub async fn page(State(state): AppStateRef, Query(q): Query<PageQuery>) -> Response {
    let settings = state.db.settings().await;
    match q.preset {
        Some(id) => {
            let note = PresetNote { open: Some(id), saved: q.saved.is_some(), ..PresetNote::default() };
            page_with_presets(&state, settings, false, None, note).await
        }
        None => page_with(&state, settings, q.saved.is_some(), None).await,
    }
}

#[derive(Deserialize, Default)]
pub struct PresetForm {
    name: Option<String>,
    filename_template: Option<String>,
    padding_before: Option<String>,
    padding_after: Option<String>,
    write_nfo: Option<String>,
    comskip: Option<String>,
    nfo_title: Option<String>,
    nfo_plot: Option<String>,
    nfo_set: Option<String>,
}

fn preset_from(form: &PresetForm, id: i64) -> Result<Preset, String> {
    let minutes = |v: &Option<String>, name: &str| -> Result<Option<i64>, String> {
        filled(v).map(|v| v.parse().map_err(|_| format!("{name} has to be a whole number of minutes"))).transpose()
    };
    let text = |v: &Option<String>| filled(v).unwrap_or_default();
    let preset = Preset {
        id,
        name: text(&form.name),
        filename_template: text(&form.filename_template),
        padding_before: minutes(&form.padding_before, "Start early")?,
        padding_after: minutes(&form.padding_after, "Keep going after")?,
        write_nfo: form.write_nfo.is_some(),
        comskip: form.comskip.is_some(),
        nfo_title: text(&form.nfo_title),
        nfo_plot: text(&form.nfo_plot),
        nfo_set: text(&form.nfo_set),
        ..Preset::default()
    };
    if preset.name.is_empty() {
        return Err("Give it a name".into());
    }
    Ok(preset)
}

/// Starts a preset with the same .nfo and comskip choices as the settings.
pub async fn preset_new(State(state): AppStateRef) -> Response {
    let settings = state.db.settings().await;
    let preset = Preset { name: "New preset".into(), write_nfo: settings.write_nfo, comskip: settings.comskip, ..Preset::default() };
    match state.db.call(move |conn| presets::add(conn, &preset)).await {
        Ok(id) => see_other(&format!("/settings?preset={id}#preset-{id}")),
        Err(e) => page_with(&state, settings, false, Some(format!("Couldn't add a preset: {e:#}"))).await,
    }
}

pub async fn preset_save(State(state): AppStateRef, UrlPath(id): UrlPath<i64>, Form(form): Form<PresetForm>) -> Response {
    let preset = match preset_from(&form, id) {
        Ok(p) => p,
        Err(error) => {
            let typed = Preset {
                id,
                name: filled(&form.name).unwrap_or_default(),
                filename_template: filled(&form.filename_template).unwrap_or_default(),
                nfo_title: filled(&form.nfo_title).unwrap_or_default(),
                nfo_plot: filled(&form.nfo_plot).unwrap_or_default(),
                nfo_set: filled(&form.nfo_set).unwrap_or_default(),
                write_nfo: form.write_nfo.is_some(),
                comskip: form.comskip.is_some(),
                ..Preset::default()
            };
            let note = PresetNote { open: Some(id), error: Some(error), typed: Some(typed), ..PresetNote::default() };
            return page_with_presets(&state, state.db.settings().await, false, None, note).await;
        }
    };
    if let Err(e) = state.db.call(move |conn| presets::update(conn, &preset)).await {
        let note = PresetNote { open: Some(id), error: Some(format!("Couldn't save: {e:#}")), ..PresetNote::default() };
        return page_with_presets(&state, state.db.settings().await, false, None, note).await;
    }
    see_other(&format!("/settings?preset={id}&saved=1#preset-{id}"))
}

pub async fn preset_delete(State(state): AppStateRef, UrlPath(id): UrlPath<i64>) -> Response {
    let _ = state.db.call(move |conn| presets::delete(conn, id)).await;
    see_other("/settings#presets")
}

#[derive(Deserialize, Default)]
pub struct SettingsForm {
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
    timeshift_mode: Option<String>,
    user_agent: Option<String>,
    download_dir: Option<String>,
    filename_template: Option<String>,
    #[serde(default)]
    filename_strip: Vec<String>,
    padding_before: Option<String>,
    padding_after: Option<String>,
    set_aired_time: Option<String>,
    write_nfo: Option<String>,
    nfo_title: Option<String>,
    nfo_plot: Option<String>,
    nfo_set: Option<String>,
    comskip: Option<String>,
    poll_interval_minutes: Option<String>,
    ready_grace_minutes: Option<String>,
}

/// The settings as the form has them. An empty password keeps the saved one, so the
/// page never has to send it back to the browser.
fn from_form(form: &SettingsForm, saved: &Settings) -> Result<Settings, String> {
    let defaults = Settings::default();
    let minutes = |v: &Option<String>, name: &str| -> Result<i64, String> {
        match filled(v) {
            None => Ok(0),
            Some(v) => v.parse().map_err(|_| format!("{name} has to be a whole number of minutes")),
        }
    };
    let settings = Settings {
        url: filled(&form.url).unwrap_or_default().trim_end_matches('/').to_string(),
        username: filled(&form.username).unwrap_or_default(),
        password: form.password.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| saved.password.clone()),
        timeshift_mode: if form.timeshift_mode.as_deref() == Some("php") { TimeshiftMode::Php } else { TimeshiftMode::Path },
        user_agent: filled(&form.user_agent).unwrap_or(defaults.user_agent),
        download_dir: filled(&form.download_dir).unwrap_or_default(),
        filename_template: filled(&form.filename_template).unwrap_or(defaults.filename_template),
        filename_strip: words(&form.filename_strip),
        padding_before: minutes(&form.padding_before, "Start early")?,
        padding_after: minutes(&form.padding_after, "Keep going after")?,
        set_aired_time: form.set_aired_time.is_some(),
        write_nfo: form.write_nfo.is_some(),
        nfo_title: filled(&form.nfo_title).unwrap_or(defaults.nfo_title),
        nfo_plot: filled(&form.nfo_plot).unwrap_or(defaults.nfo_plot),
        nfo_set: filled(&form.nfo_set).unwrap_or_default(),
        comskip: form.comskip.is_some(),
        poll_interval_minutes: minutes(&form.poll_interval_minutes, "Check every")?,
        ready_grace_minutes: minutes(&form.ready_grace_minutes, "Extra wait")?,
    };
    if !settings.url.is_empty() && !settings.url.starts_with("http://") && !settings.url.starts_with("https://") {
        return Err("The server address has to start with http:// or https://".into());
    }
    if settings.poll_interval_minutes < 1 {
        return Err("Check every has to be at least 1 minute".into());
    }
    if settings.ready_grace_minutes < 0 {
        return Err("Extra wait can't be negative".into());
    }
    Ok(settings)
}

pub async fn save(State(state): AppStateRef, Form(form): Form<SettingsForm>) -> Response {
    let saved = state.db.settings().await;
    let settings = match from_form(&form, &saved) {
        Ok(s) => s,
        Err(e) => {
            let mut shown = saved.clone();
            shown.url = filled(&form.url).unwrap_or_default();
            shown.username = filled(&form.username).unwrap_or_default();
            shown.download_dir = filled(&form.download_dir).unwrap_or_default();
            return page_with(&state, shown, false, Some(e)).await;
        }
    };
    let provider_changed = (&settings.url, &settings.username, &settings.password, &settings.user_agent)
        != (&saved.url, &saved.username, &saved.password, &saved.user_agent);
    if let Err(e) = state.db.save_settings(settings).await {
        return page_with(&state, saved, false, Some(format!("Couldn't save: {e:#}"))).await;
    }
    if provider_changed {
        state.guide.clear();
    }
    state.live.changed();
    see_other("/settings?saved=1")
}

#[derive(Template)]
#[template(path = "settings_test.html")]
struct TestResult {
    ok: bool,
    message: String,
    details: Vec<String>,
}

/// Tries the login in the form, without saving it.
pub async fn test(State(state): AppStateRef, Form(form): Form<SettingsForm>) -> Response {
    let saved = state.db.settings().await;
    let settings = match from_form(&form, &saved) {
        Ok(s) => s,
        Err(e) => return render(TestResult { ok: false, message: e, details: vec![] }),
    };
    if !settings.has_provider() {
        return render(TestResult { ok: false, message: "Fill in the address, username and password first".into(), details: vec![] });
    }
    let account = match xtream::account(&settings).await {
        Ok(a) => a,
        Err(e) => return render(TestResult { ok: false, message: format!("{e:#}"), details: vec![] }),
    };
    let mut details = Vec::new();
    if let Some(status) = &account.status {
        details.push(format!("Account {}", status.to_lowercase()));
    }
    if let Some(expires) = account.expires_at {
        details.push(format!("expires {}", expires.with_timezone(&chrono::Local).format("%-d %b %Y")));
    }
    if let Some(n) = account.max_connections {
        details.push(if n == 1 { "1 connection".into() } else { format!("{n} connections") });
    }
    if let Some(tz) = &account.timezone {
        details.push(format!("guide times in {tz}"));
    }
    let message = match xtream::archive_channels(&settings).await {
        Ok(channels) => format!("Connected. {} channels keep an archive.", channels.len()),
        Err(e) => format!("Logged in, but couldn't list channels: {e:#}"),
    };
    render(TestResult { ok: true, message, details })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_password_keeps_the_saved_one() {
        let saved = Settings { password: "secret".into(), ..Settings::default() };
        let form = SettingsForm {
            url: Some("http://example.com:8080/".into()),
            username: Some("astro".into()),
            password: Some(String::new()),
            poll_interval_minutes: Some("10".into()),
            write_nfo: Some("on".into()),
            ..SettingsForm::default()
        };
        let s = from_form(&form, &saved).unwrap();
        assert_eq!((s.url.as_str(), s.password.as_str()), ("http://example.com:8080", "secret"));
        assert!(s.write_nfo && !s.comskip && !s.set_aired_time);
        assert_eq!(s.filename_template, Settings::default().filename_template);
    }

    #[test]
    fn says_what_is_wrong() {
        let saved = Settings::default();
        let bad = SettingsForm { url: Some("example.com".into()), poll_interval_minutes: Some("10".into()), ..SettingsForm::default() };
        assert!(from_form(&bad, &saved).unwrap_err().contains("http://"));
        let zero = SettingsForm { poll_interval_minutes: Some("0".into()), ..SettingsForm::default() };
        assert!(from_form(&zero, &saved).is_err());
        let words = SettingsForm { padding_after: Some("ten".into()), poll_interval_minutes: Some("10".into()), ..SettingsForm::default() };
        assert_eq!(from_form(&words, &saved).unwrap_err(), "Keep going after has to be a whole number of minutes");
    }
}
