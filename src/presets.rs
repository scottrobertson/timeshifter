//! Presets: named filename and .nfo templates to pick on the download page, for shows
//! the guide describes badly.

use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::recording::{Fields, Nfo, custom_words};
use crate::settings::Settings;

/// How many past values each made up word suggests.
const REMEMBERED: usize = 20;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preset {
    #[serde(skip)]
    pub id: i64,
    pub name: String,
    pub filename_template: String,
    pub padding_before: Option<i64>,
    pub padding_after: Option<i64>,
    pub write_nfo: bool,
    pub comskip: bool,
    pub nfo_title: String,
    pub nfo_plot: String,
    pub nfo_set: String,
    /// What's been typed for each made up word, newest first, offered as suggestions.
    pub history: BTreeMap<String, Vec<String>>,
}

fn or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() { fallback } else { value }
}

impl Preset {
    pub fn filename(&self, settings: &Settings) -> String {
        or(&self.filename_template, &settings.filename_template).to_string()
    }

    pub fn nfo(&self, settings: &Settings) -> Nfo {
        Nfo {
            title: or(&self.nfo_title, &settings.nfo_title).to_string(),
            plot: or(&self.nfo_plot, &settings.nfo_plot).to_string(),
            set: or(&self.nfo_set, &settings.nfo_set).to_string(),
        }
    }

    /// The made up words the download page asks for.
    pub fn words(&self, settings: &Settings) -> Vec<String> {
        let nfo = self.nfo(settings);
        custom_words(&[&self.filename(settings), &nfo.title, &nfo.plot, &nfo.set])
    }
}

fn read(id: i64, raw: &str) -> Result<Preset> {
    Ok(Preset { id, ..serde_json::from_str(raw)? })
}

/// Every preset, by name.
pub fn all(conn: &Connection) -> Result<Vec<Preset>> {
    let mut stmt = conn.prepare("SELECT id, value FROM presets")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut presets = rows
        .map(|row| {
            let (id, raw) = row?;
            read(id, &raw)
        })
        .collect::<Result<Vec<_>>>()?;
    presets.sort_by_key(|p| p.name.to_lowercase());
    Ok(presets)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Preset>> {
    let raw: Option<String> = conn.query_row("SELECT value FROM presets WHERE id = ?", [id], |r| r.get(0)).optional()?;
    raw.map(|raw| read(id, &raw)).transpose()
}

pub fn add(conn: &Connection, preset: &Preset) -> Result<i64> {
    conn.execute("INSERT INTO presets (value) VALUES (?)", [serde_json::to_string(preset)?])?;
    Ok(conn.last_insert_rowid())
}

/// Saves what the Settings page edits, keeping the remembered values.
pub fn update(conn: &Connection, preset: &Preset) -> Result<()> {
    let history = get(conn, preset.id)?.map(|p| p.history).unwrap_or_default();
    let saved = Preset { history, ..preset.clone() };
    conn.execute("UPDATE presets SET value = ? WHERE id = ?", params![serde_json::to_string(&saved)?, preset.id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM presets WHERE id = ?", [id])?;
    Ok(())
}

/// Keeps what was typed for each made up word, to suggest next time.
pub fn remember(conn: &Connection, id: i64, fields: &Fields) -> Result<()> {
    let Some(mut preset) = get(conn, id)? else { return Ok(()) };
    for (word, value) in fields {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let past = preset.history.entry(word.clone()).or_default();
        past.retain(|v| v != value);
        past.insert(0, value.to_string());
        past.truncate(REMEMBERED);
    }
    conn.execute("UPDATE presets SET value = ? WHERE id = ?", params![serde_json::to_string(&preset)?, id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn blanks_follow_the_settings() {
        let settings = Settings { nfo_set: "NASA".into(), ..Settings::default() };
        let preset = Preset { filename_template: "Missions/{mission}.{ext}".into(), nfo_title: "{title}: {stage}".into(), ..Preset::default() };
        assert_eq!(preset.filename(&settings), "Missions/{mission}.{ext}");
        assert_eq!(preset.nfo(&settings).set, "NASA");
        assert_eq!(preset.words(&settings), ["mission", "stage"]);
    }

    #[test]
    fn remembers_typed_values_newest_first() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        let id = add(&conn, &Preset { name: "Launches".into(), ..Preset::default() }).unwrap();
        let typed = |v: &str| [("mission".to_string(), v.to_string()), ("stage".to_string(), String::new())];
        remember(&conn, id, &typed("Artemis II")).unwrap();
        remember(&conn, id, &typed("Artemis III")).unwrap();
        remember(&conn, id, &typed("Artemis II")).unwrap();
        let preset = get(&conn, id).unwrap().unwrap();
        assert_eq!(preset.history["mission"], ["Artemis II", "Artemis III"]);
        assert!(!preset.history.contains_key("stage"));

        update(&conn, &Preset { id, name: "Rocket launches".into(), ..Preset::default() }).unwrap();
        let preset = get(&conn, id).unwrap().unwrap();
        assert_eq!((preset.name.as_str(), preset.history["mission"].len()), ("Rocket launches", 2));
    }
}
