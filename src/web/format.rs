//! Turning numbers and timestamps into the short text pages show.

use chrono::{DateTime, Local, NaiveDateTime, Utc};

/// For data-ago and data-since, which the page's script keeps ticking.
pub fn iso(unix: i64) -> String {
    DateTime::<Utc>::from_timestamp(unix, 0).map(|d| d.to_rfc3339()).unwrap_or_default()
}

pub fn ago(unix: i64) -> String {
    let secs = (Utc::now().timestamp() - unix).max(0);
    match secs {
        0..10 => "just now".into(),
        10..60 => format!("{secs}s ago"),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86_400 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

/// "in 7m", for things still to come.
pub fn until(unix: i64) -> String {
    let secs = (unix - Utc::now().timestamp()).max(0);
    match secs {
        0..60 => "in under a minute".into(),
        60..3600 => format!("in {}m", secs / 60),
        3600..86_400 => format!("in {}h {:02}m", secs / 3600, (secs / 60) % 60),
        _ => format!("in {}d", secs / 86_400),
    }
}

pub fn duration(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m", secs / 3600, (secs / 60) % 60),
    }
}

/// A time on this server's clock, like "14:03" today or "12 Sep 14:03" otherwise.
pub fn clock(unix: i64) -> String {
    let Some(at) = DateTime::<Utc>::from_timestamp(unix, 0) else { return String::new() };
    let at = at.with_timezone(&Local);
    if at.date_naive() == Local::now().date_naive() {
        at.format("%H:%M").to_string()
    } else {
        at.format("%-d %b %H:%M").to_string()
    }
}

fn parse_local(local: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(local, "%Y-%m-%d %H:%M:%S").ok()
}

/// The time part of a provider wall clock time, "21:30".
pub fn hm(local: &str) -> String {
    parse_local(local).map(|at| at.format("%H:%M").to_string()).unwrap_or_else(|| local.to_string())
}

/// A provider wall clock time with its day, like "Today 21:30" or "Sat 12 Sep 21:30".
pub fn when(local: &str) -> String {
    match parse_local(local) {
        Some(at) => format!("{} {}", short_day(at), at.format("%H:%M")),
        None => local.to_string(),
    }
}

fn short_day(at: NaiveDateTime) -> String {
    let today = Local::now().date_naive();
    match (at.date() - today).num_days() {
        0 => "Today".into(),
        1 => "Tomorrow".into(),
        -1 => "Yesterday".into(),
        _ => at.format("%a %-d %b").to_string(),
    }
}

/// The heading for a day in the guide, like "Today" or "Saturday 12 September".
pub fn day(local: &str) -> String {
    let Some(at) = parse_local(local) else { return local.get(..10).unwrap_or(local).to_string() };
    let today = Local::now().date_naive();
    match (at.date() - today).num_days() {
        0 => "Today".into(),
        1 => "Tomorrow".into(),
        -1 => "Yesterday".into(),
        _ => at.format("%A %-d %B").to_string(),
    }
}

pub fn bytes(n: i64) -> String {
    let n = n as f64;
    if n >= 1e9 {
        format!("{:.2} GB", n / 1e9)
    } else if n >= 1e6 {
        format!("{:.0} MB", n / 1e6)
    } else {
        format!("{:.0} KB", n / 1e3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_and_sizes() {
        assert_eq!(duration(5), "5s");
        assert_eq!(duration(65), "1m 05s");
        assert_eq!(duration(3_900), "1h 05m");
        assert_eq!(bytes(1_234_000_000), "1.23 GB");
        assert_eq!(bytes(42_000_000), "42 MB");
    }

    #[test]
    fn provider_times() {
        assert_eq!(hm("2024-03-10 21:30:00"), "21:30");
        assert_eq!(when("2024-03-10 21:30:00"), "Sun 10 Mar 21:30");
        assert_eq!(day("2024-03-10 21:30:00"), "Sunday 10 March");
        assert_eq!(hm("odd"), "odd");
    }
}
