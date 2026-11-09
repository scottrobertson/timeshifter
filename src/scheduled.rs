//! One off recordings picked out of the guide before they aired. Each is a timer: the
//! guide check records the slot that was picked once it has passed, then marks it done.

use anyhow::Result;
use rusqlite::{Connection, params};

use crate::db::now;
use crate::plan::Overrides;
use crate::recording::Program;

/// Finished recordings stay in the list this long, so you can see what happened.
const KEEP_FINISHED_DAYS: i64 = 30;

/// How long after the slot ended a failing download keeps being retried. Long enough to
/// ride out a provider outage, short enough that a show that never aired isn't retried forever.
pub const EXPIRE_AFTER_SECS: i64 = 48 * 3600;

#[derive(Debug, Clone, PartialEq)]
pub struct Scheduled {
    pub id: i64,
    pub channel: String,
    pub program: Program,
    pub overrides: Overrides,
    pub status: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub output_path: Option<String>,
}

const COLUMNS: &str = "id, channel, title, description, start_ts, end_ts, start_local, end_local, overrides, status, \
    created_at, completed_at, output_path";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Scheduled> {
    let overrides: String = r.get(8)?;
    Ok(Scheduled {
        id: r.get(0)?,
        channel: r.get(1)?,
        program: Program {
            title: r.get(2)?,
            description: r.get(3)?,
            start: r.get(4)?,
            end: r.get(5)?,
            start_local: r.get(6)?,
            end_local: r.get(7)?,
            // Only ever recorded once the slot has passed, so the archive is there.
            has_archive: true,
        },
        overrides: serde_json::from_str(&overrides).unwrap_or_default(),
        status: r.get(9)?,
        created_at: r.get(10)?,
        completed_at: r.get(11)?,
        output_path: r.get(12)?,
    })
}

/// Still to come first, soonest at the top, then finished ones most recent first.
pub fn all(conn: &Connection) -> Result<Vec<Scheduled>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM scheduled ORDER BY status != 'pending', \
         CASE WHEN status = 'pending' THEN start_ts ELSE -start_ts END"
    ))?;
    Ok(stmt.query_map([], from_row)?.collect::<rusqlite::Result<_>>()?)
}

pub fn pending(conn: &Connection) -> Result<Vec<Scheduled>> {
    Ok(all(conn)?.into_iter().filter(|s| s.status == "pending").collect())
}

#[cfg(test)]
pub fn get(conn: &Connection, id: i64) -> Result<Option<Scheduled>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM scheduled WHERE id = ?"), [id], from_row)
        .optional()?)
}

pub fn add(conn: &Connection, channel: &str, program: &Program, overrides: &Overrides) -> Result<i64> {
    insert(conn, channel, program, overrides, "pending", now(), None, None)
}

#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    channel: &str,
    program: &Program,
    overrides: &Overrides,
    status: &str,
    created_at: i64,
    completed_at: Option<i64>,
    output_path: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO scheduled (channel, title, description, start_ts, end_ts, start_local, end_local, overrides, status, created_at, completed_at, output_path) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            channel,
            program.title,
            program.description,
            program.start,
            program.end,
            program.start_local,
            program.end_local,
            serde_json::to_string(overrides)?,
            status,
            created_at,
            completed_at,
            output_path,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn finish(conn: &Connection, id: i64, status: &str, output_path: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE scheduled SET status = ?, completed_at = ?, output_path = COALESCE(?, output_path) WHERE id = ? AND status = 'pending'",
        params![status, now(), output_path, id],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM scheduled WHERE id = ?", [id])?;
    Ok(())
}

/// Tidies away finished entries nobody is looking at any more. The recording itself is
/// never touched.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM scheduled WHERE status != 'pending' AND COALESCE(completed_at, created_at) < ?",
        [now - KEEP_FINISHED_DAYS * 86_400],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::recording::tests::program;

    #[test]
    fn lists_upcoming_first_then_finished() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        let early = program("Artemis II Launch");
        let late = Program { start: early.start + 86_400, end: early.end + 86_400, ..program("Crew-12 Docking") };
        let done = add(&conn, "NASA TV", &early, &Overrides::default()).unwrap();
        let later = add(&conn, "NASA TV", &late, &Overrides { padding_after: Some(15), ..Overrides::default() }).unwrap();
        let sooner = add(&conn, "NASA TV", &early, &Overrides::default()).unwrap();
        finish(&conn, done, "done", Some("/catchup/launch.ts")).unwrap();

        let ids: Vec<i64> = all(&conn).unwrap().iter().map(|s| s.id).collect();
        assert_eq!(ids, [sooner, later, done]);
        let finished = get(&conn, done).unwrap().unwrap();
        assert_eq!((finished.status.as_str(), finished.output_path.as_deref()), ("done", Some("/catchup/launch.ts")));
        assert_eq!(get(&conn, later).unwrap().unwrap().overrides.padding_after, Some(15));
        assert_eq!(pending(&conn).unwrap().len(), 2);
    }

    #[test]
    fn prunes_old_finished_ones_only() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        let p = program("Artemis II Launch");
        insert(&conn, "NASA TV", &p, &Overrides::default(), "done", 0, Some(1_000), None).unwrap();
        insert(&conn, "NASA TV", &p, &Overrides::default(), "pending", 0, None, None).unwrap();
        let recent = insert(&conn, "NASA TV", &p, &Overrides::default(), "expired", 0, Some(now()), None).unwrap();
        assert_eq!(prune(&conn, now()).unwrap(), 1);
        assert_eq!(all(&conn).unwrap().len(), 2);
        assert!(get(&conn, recent).unwrap().is_some());
    }
}
