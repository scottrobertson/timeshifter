use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::settings::Settings;

/// Schema changes, applied in order. The version is kept in SQLite's user_version.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_starred_channels.sql"),
    include_str!("../migrations/0003_presets.sql"),
];

/// The one SQLite connection, shared by every request and job. A single connection means
/// writers queue up instead of failing with SQLITE_BUSY.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).with_context(|| format!("couldn't create {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("couldn't open {}", path.display()))?;
        Db::setup(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Db {
        Db::setup(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn setup(mut conn: Connection) -> Result<Db> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        // The job queue lives in memory, so anything left queued or running was cut off by
        // a restart. Close it off rather than leave it looking busy forever.
        conn.execute(
            "UPDATE jobs SET status = 'interrupted', error = 'Interrupted by a restart', finished_at = unixepoch() \
             WHERE status IN ('queued', 'running')",
            [],
        )?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub async fn call<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || f(&mut db.lock())).await.context("database task panicked")?
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic mid query can't leave SQLite itself inconsistent, so carry on with the
        // connection rather than taking the whole app down.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn settings(&self) -> Settings {
        self.call(|conn| Ok(get(conn, "settings")?.unwrap_or_default()))
            .await
            .unwrap_or_default()
    }

    pub async fn save_settings(&self, settings: Settings) -> Result<()> {
        self.call(move |conn| set(conn, "settings", &settings)).await
    }
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: usize = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? as usize;
    if current > MIGRATIONS.len() {
        bail!("This database was made by a newer timeshifter (schema v{current})");
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("upgrading the database to v{}", i + 1))?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get(0))
        .optional()?;
    Ok(match raw {
        Some(raw) => Some(serde_json::from_str(&raw).with_context(|| format!("reading {key}"))?),
        None => None,
    })
}

pub fn set<T: Serialize>(conn: &Connection, key: &str, value: &T) -> Result<()> {
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_start_as_defaults() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        assert!(get::<Settings>(&conn, "settings").unwrap().is_none());
        let settings = Settings { url: "http://example.com".into(), padding_after: 30, ..Settings::default() };
        set(&conn, "settings", &settings).unwrap();
        assert_eq!(get::<Settings>(&conn, "settings").unwrap(), Some(settings));
    }

    #[test]
    fn a_restart_closes_off_running_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timeshifter.db");
        {
            let db = Db::open(&path).unwrap();
            db.lock()
                .execute("INSERT INTO jobs (kind, trigger, status, title, created_at) VALUES ('check', 'manual', 'running', 'Check', 1)", [])
                .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let status: String = db.lock().query_row("SELECT status FROM jobs", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "interrupted");
    }
}
