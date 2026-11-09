//! Channels starred to keep them at the top of the channel list.

use anyhow::Result;
use rusqlite::{Connection, params};

use crate::db::now;

/// Starred channel names, lowercased so they compare the way channel names do elsewhere.
pub fn all(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM starred_channels")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.into_iter().map(|n| n.trim().to_lowercase()).collect())
}

pub fn set(conn: &Connection, name: &str, starred: bool) -> Result<()> {
    let name = name.trim();
    if starred {
        conn.execute("INSERT OR IGNORE INTO starred_channels (name, starred_at) VALUES (?, ?)", params![name, now()])?;
    } else {
        conn.execute("DELETE FROM starred_channels WHERE name = ?", [name])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn stars_and_unstars_ignoring_case() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        set(&conn, "NASA TV", true).unwrap();
        set(&conn, "nasa tv ", true).unwrap();
        set(&conn, "ESA Live", true).unwrap();
        let mut names = all(&conn).unwrap();
        names.sort();
        assert_eq!(names, ["esa live", "nasa tv"]);

        set(&conn, "Nasa TV", false).unwrap();
        assert_eq!(all(&conn).unwrap(), ["esa live"]);
    }
}
