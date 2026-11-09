//! Brings over config.json and scheduled.json from the command line version, the first
//! time the app starts. After that the database is the only place settings live.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::DateTime;
use rusqlite::Connection;
use serde::Deserialize;

use crate::db;
use crate::plan::Overrides;
use crate::recording::Program;
use crate::scheduled;
use crate::settings::Settings;
use crate::subscriptions::{self, Subscription};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Watch {
    poll_interval_minutes: Option<i64>,
    ready_grace_minutes: Option<i64>,
    subscriptions: Vec<OldSubscription>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldSubscription {
    name: String,
    channel: String,
    #[serde(default)]
    title_contains: Vec<String>,
    #[serde(default)]
    title_excludes: Vec<String>,
    from: Option<String>,
    padding_before: Option<i64>,
    padding_after: Option<i64>,
    filename_template: Option<String>,
    filename_strip: Option<Vec<String>>,
    comskip: Option<bool>,
}

#[derive(Deserialize)]
struct ScheduleFile {
    #[serde(default)]
    recordings: Vec<OldRecording>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldRecording {
    channel: String,
    program: OldProgram,
    padding_before: Option<i64>,
    padding_after: Option<i64>,
    filename: Option<String>,
    filename_template: Option<String>,
    filename_strip: Option<Vec<String>>,
    write_nfo: Option<bool>,
    comskip: Option<bool>,
    created_at: String,
    status: String,
    completed_at: Option<String>,
    output_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldProgram {
    title: String,
    #[serde(default)]
    description: String,
    start: String,
    end: String,
    start_local: String,
    end_local: String,
}

fn unix(iso: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp())
}

/// Runs once, on a database that has never had settings saved. Returns what it brought
/// over, for the startup log.
pub fn first_run(conn: &mut Connection, config_dir: &Path) -> Result<Vec<String>> {
    if db::get::<Settings>(conn, "settings")?.is_some() {
        return Ok(vec![]);
    }
    let mut notes = Vec::new();
    let tx = conn.transaction()?;

    let config_file = config_dir.join("config.json");
    let settings = if config_file.exists() {
        let raw = std::fs::read_to_string(&config_file).with_context(|| format!("reading {}", config_file.display()))?;
        let value: serde_json::Value = serde_json::from_str(&raw).with_context(|| format!("{} isn't valid JSON", config_file.display()))?;
        let mut settings: Settings = serde_json::from_value(value.clone()).context("reading config.json")?;
        settings.url = settings.base_url();
        let watch: Watch = value.get("watch").map(|w| serde_json::from_value(w.clone())).transpose()?.unwrap_or_default();
        settings.poll_interval_minutes = watch.poll_interval_minutes.unwrap_or(settings.poll_interval_minutes);
        settings.ready_grace_minutes = watch.ready_grace_minutes.unwrap_or(settings.ready_grace_minutes);
        for old in &watch.subscriptions {
            subscriptions::save(
                &tx,
                &Subscription {
                    id: 0,
                    name: old.name.clone(),
                    channel: old.channel.clone(),
                    title_contains: old.title_contains.clone(),
                    title_excludes: old.title_excludes.clone(),
                    from: old.from.clone(),
                    overrides: Overrides {
                        padding_before: old.padding_before,
                        padding_after: old.padding_after,
                        filename_template: old.filename_template.clone(),
                        filename_strip: old.filename_strip.clone(),
                        comskip: old.comskip,
                        ..Overrides::default()
                    },
                },
            )?;
        }
        notes.push(format!("Imported settings and {} subscriptions from {}", watch.subscriptions.len(), config_file.display()));
        settings
    } else {
        Settings::default()
    };
    db::set(&tx, "settings", &settings)?;

    let schedule_file = config_dir.join("scheduled.json");
    if schedule_file.exists() {
        let raw = std::fs::read_to_string(&schedule_file)?;
        let file: ScheduleFile = serde_json::from_str(&raw).with_context(|| format!("reading {}", schedule_file.display()))?;
        let mut count = 0;
        for old in file.recordings {
            let (Some(start), Some(end)) = (unix(&old.program.start), unix(&old.program.end)) else { continue };
            let program = Program {
                title: old.program.title,
                description: old.program.description,
                start,
                end,
                start_local: old.program.start_local,
                end_local: old.program.end_local,
                has_archive: true,
            };
            let overrides = Overrides {
                filename: old.filename,
                padding_before: old.padding_before,
                padding_after: old.padding_after,
                write_nfo: old.write_nfo,
                comskip: old.comskip,
                filename_template: old.filename_template,
                filename_strip: old.filename_strip,
                nfo: None,
            };
            scheduled::insert(
                &tx,
                &old.channel,
                &program,
                &overrides,
                &old.status,
                unix(&old.created_at).unwrap_or_else(db::now),
                old.completed_at.as_deref().and_then(unix),
                old.output_path.as_deref(),
            )?;
            count += 1;
        }
        notes.push(format!("Imported {count} scheduled recordings from {}", schedule_file.display()));
    }

    tx.commit()?;
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn brings_over_the_old_files_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{
              "url": "http://my-provider.com:8080/",
              "username": "astro",
              "password": "secret",
              "downloadDir": "/catchup",
              "paddingAfter": 5,
              "filenameStrip": ["ᴸᶦᵛᵉ"],
              "watch": {
                "pollIntervalMinutes": 15,
                "subscriptions": [
                  { "name": "NASA launches", "channel": "NASA TV", "titleContains": ["Launch"], "from": "2026-06-01", "paddingAfter": 30, "comskip": false }
                ]
              }
            }"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("scheduled.json"),
            r#"{ "recordings": [
              { "id": "a1b2c3d4", "channel": "NASA TV", "program": { "title": "Crew-12 Docking", "description": "", "start": "2026-09-13T13:00:00.000Z", "end": "2026-09-13T14:00:00.000Z", "startLocal": "2026-09-13 14:00:00", "endLocal": "2026-09-13 15:00:00" }, "paddingAfter": 10, "createdAt": "2026-09-10T10:00:00.000Z", "status": "pending" }
            ] }"#,
        )
        .unwrap();

        let db = Db::open_in_memory();
        let notes = first_run(&mut db.lock(), dir.path()).unwrap();
        assert_eq!(notes.len(), 2);

        let conn = db.lock();
        let settings: Settings = db::get(&conn, "settings").unwrap().unwrap();
        assert_eq!(settings.url, "http://my-provider.com:8080");
        assert_eq!((settings.padding_after, settings.poll_interval_minutes, settings.write_nfo), (5, 15, true));
        assert_eq!(settings.filename_strip, ["ᴸᶦᵛᵉ"]);

        let subs = subscriptions::all(&conn).unwrap();
        assert_eq!(subs[0].name, "NASA launches");
        assert_eq!((subs[0].overrides.padding_after, subs[0].overrides.comskip), (Some(30), Some(false)));

        let recs = scheduled::all(&conn).unwrap();
        assert_eq!(recs[0].program.start, 1_789_304_400);
        assert_eq!(recs[0].overrides.padding_after, Some(10));
        drop(conn);

        assert!(first_run(&mut db.lock(), dir.path()).unwrap().is_empty());
    }

    #[test]
    fn starts_empty_without_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory();
        assert!(first_run(&mut db.lock(), dir.path()).unwrap().is_empty());
        let settings: Settings = db::get(&db.lock(), "settings").unwrap().unwrap();
        assert!(!settings.has_provider());
    }
}
