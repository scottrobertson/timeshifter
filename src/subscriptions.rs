//! Standing rules for downloading shows automatically.

use anyhow::{Result, bail};
use chrono::{NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::now;
use crate::plan::Overrides;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Subscription {
    pub id: i64,
    pub name: String,
    /// The channel's name as the provider lists it, give or take case.
    pub channel: String,
    pub title_contains: Vec<String>,
    pub title_excludes: Vec<String>,
    /// Like "2026-06-01" or "2026-06-01T13:00".
    pub from: Option<String>,
    pub overrides: Overrides,
}

pub fn channel_name_matches(wanted: &str, name: &str) -> bool {
    wanted.trim().to_lowercase() == name.trim().to_lowercase()
}

impl Subscription {
    pub fn matches_title(&self, title: &str) -> bool {
        let lower = title.to_lowercase();
        self.title_contains.iter().all(|t| lower.contains(&t.to_lowercase()))
            && !self.title_excludes.iter().any(|t| lower.contains(&t.to_lowercase()))
    }

    /// Shows that finished before this are left alone.
    pub fn cutoff(&self) -> Option<i64> {
        self.from.as_deref().and_then(parse_from)
    }
}

/// A date on its own is midnight UTC; a date and time is in the server's own timezone.
pub fn parse_from(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp());
    }
    ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(value, f).ok())
        .and_then(|at| chrono::Local.from_local_datetime(&at).earliest())
        .map(|at| at.timestamp())
}

pub fn validate(sub: &Subscription) -> Result<()> {
    if sub.name.trim().is_empty() {
        bail!("Give it a name");
    }
    if sub.channel.trim().is_empty() {
        bail!("Pick a channel");
    }
    if sub.title_contains.is_empty() {
        bail!("Add at least one word the title has to contain");
    }
    if sub.from.as_deref().is_some_and(|f| parse_from(f).is_none()) {
        bail!("From has to be a date like 2026-06-01");
    }
    Ok(())
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Subscription> {
    let json = |i: usize| -> rusqlite::Result<String> { r.get(i) };
    Ok(Subscription {
        id: r.get(0)?,
        name: r.get(1)?,
        channel: r.get(2)?,
        title_contains: serde_json::from_str(&json(3)?).unwrap_or_default(),
        title_excludes: serde_json::from_str(&json(4)?).unwrap_or_default(),
        from: r.get(5)?,
        overrides: serde_json::from_str(&json(6)?).unwrap_or_default(),
    })
}

const COLUMNS: &str = "id, name, channel, title_contains, title_excludes, from_date, overrides";

pub fn all(conn: &Connection) -> Result<Vec<Subscription>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM subscriptions ORDER BY name COLLATE NOCASE, id"))?;
    Ok(stmt.query_map([], from_row)?.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Subscription>> {
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM subscriptions WHERE id = ?"), [id], from_row)
        .optional()?)
}

/// An id of 0 adds a new subscription.
pub fn save(conn: &Connection, sub: &Subscription) -> Result<i64> {
    let values = params![
        sub.name.trim(),
        sub.channel.trim(),
        serde_json::to_string(&sub.title_contains)?,
        serde_json::to_string(&sub.title_excludes)?,
        sub.from.as_deref().map(str::trim).filter(|f| !f.is_empty()),
        serde_json::to_string(&sub.overrides)?,
    ];
    if sub.id > 0 {
        let mut values = values.to_vec();
        values.push(&sub.id);
        conn.execute(
            "UPDATE subscriptions SET name = ?, channel = ?, title_contains = ?, title_excludes = ?, from_date = ?, overrides = ? WHERE id = ?",
            values.as_slice(),
        )?;
        return Ok(sub.id);
    }
    let created = now();
    let mut values = values.to_vec();
    values.push(&created);
    conn.execute(
        "INSERT INTO subscriptions (name, channel, title_contains, title_excludes, from_date, overrides, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        values.as_slice(),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM subscriptions WHERE id = ?", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn launches() -> Subscription {
        Subscription {
            name: "NASA launches".into(),
            channel: "NASA TV".into(),
            title_contains: vec!["Launch".into(), "live".into()],
            title_excludes: vec!["Replay".into()],
            ..Subscription::default()
        }
    }

    #[test]
    fn titles_need_every_word_and_none_of_the_excluded() {
        let sub = launches();
        assert!(sub.matches_title("Artemis II Launch LIVE"));
        assert!(!sub.matches_title("Artemis II Launch"));
        assert!(!sub.matches_title("Artemis II Launch Live Replay"));
    }

    #[test]
    fn channel_names_ignore_case_and_spaces() {
        assert!(channel_name_matches(" nasa tv", "NASA TV "));
        assert!(!channel_name_matches("NASA", "NASA TV"));
    }

    #[test]
    fn from_dates() {
        assert_eq!(parse_from("2026-06-01"), Some(1_780_272_000));
        assert!(parse_from("2026-06-01T13:00").is_some());
        assert_eq!(parse_from("June"), None);
        let sub = Subscription { from: Some("2026-06-01".into()), ..launches() };
        assert_eq!(sub.cutoff(), Some(1_780_272_000));
    }

    #[test]
    fn validation_says_what_is_missing() {
        assert!(validate(&launches()).is_ok());
        let no_words = Subscription { title_contains: vec![], ..launches() };
        assert_eq!(validate(&no_words).unwrap_err().to_string(), "Add at least one word the title has to contain");
        let bad_date = Subscription { from: Some("soon".into()), ..launches() };
        assert!(validate(&bad_date).is_err());
    }

    #[test]
    fn saves_updates_and_deletes() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        let mut sub = launches();
        sub.overrides.padding_after = Some(30);
        let id = save(&conn, &sub).unwrap();
        let saved = get(&conn, id).unwrap().unwrap();
        assert_eq!(saved, Subscription { id, ..sub.clone() });

        let renamed = Subscription { name: "Launches".into(), from: Some(" ".into()), ..saved };
        save(&conn, &renamed).unwrap();
        let saved = get(&conn, id).unwrap().unwrap();
        assert_eq!((saved.name.as_str(), saved.from), ("Launches", None));
        assert_eq!(all(&conn).unwrap().len(), 1);

        delete(&conn, id).unwrap();
        assert!(all(&conn).unwrap().is_empty());
    }
}
