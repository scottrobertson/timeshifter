//! The rules for turning a show in the guide into a recording: its time window, the
//! catchup URL, the filename and the .nfo. Nothing here touches the network or the disk.

use anyhow::{Result, bail};
use chrono::NaiveDateTime;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};

use crate::settings::{Settings, TimeshiftMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub stream_id: i64,
    pub name: String,
    pub archive_days: i64,
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Program {
    pub title: String,
    pub description: String,
    /// Unix seconds.
    pub start: i64,
    pub end: i64,
    /// The provider's own wall clock, "YYYY-MM-DD HH:MM:SS". The catchup endpoint wants
    /// its own local time, so these are used as is and never converted.
    pub start_local: String,
    pub end_local: String,
    pub has_archive: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub start_local: String,
    pub end_local: String,
    pub minutes: i64,
}

const LOCAL_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

fn parse_local(local: &str) -> Result<NaiveDateTime> {
    match NaiveDateTime::parse_from_str(local, LOCAL_FORMAT) {
        Ok(at) => Ok(at),
        Err(_) => bail!("Unexpected EPG start format: \"{local}\""),
    }
}

/// Moves a provider wall clock time by some minutes, keeping day rollovers right without
/// knowing the provider's timezone.
pub fn shift_local(local: &str, minutes: i64) -> Result<String> {
    let at = parse_local(local)? + chrono::Duration::minutes(minutes);
    Ok(at.format(LOCAL_FORMAT).to_string())
}

/// "YYYY-MM-DD HH:MM:SS" as the timeshift URL wants it, "YYYY-MM-DD:HH-MM".
pub fn format_start_for_url(local: &str) -> Result<String> {
    Ok(parse_local(local)?.format("%Y-%m-%d:%H-%M").to_string())
}

/// When a show's catchup can be fetched, in the provider's own time like the rest of the guide.
pub fn ready_at_local(program: &Program, minutes_after_end: i64) -> String {
    shift_local(&program.end_local, minutes_after_end).unwrap_or_else(|_| program.end_local.clone())
}

pub fn ready_at(program: &Program, padding_after: i64, grace: i64) -> i64 {
    program.end + (padding_after + grace) * 60
}

/// The whole window a show would be recorded over. Used to show the plan for a show that
/// hasn't aired, where capping at now would give a one minute window.
pub fn planned_window(program: &Program, before: i64, after: i64) -> Result<Window> {
    let start = program.start - before * 60;
    let end = program.end + after * 60;
    let minutes = whole_minutes(end - start);
    let start_local = shift_local(&program.start_local, -before)?;
    Ok(Window { end_local: shift_local(&start_local, minutes)?, start_local, minutes })
}

/// The window to actually record, capped at now so a show that's still on doesn't ask for
/// footage that doesn't exist yet.
pub fn recording_window(program: &Program, before: i64, after: i64, now: i64) -> Result<Window> {
    let planned = planned_window(program, before, after)?;
    let start = program.start - before * 60;
    let end = (program.end + after * 60).min(now);
    let minutes = whole_minutes(end - start);
    if minutes >= planned.minutes {
        return Ok(planned);
    }
    Ok(Window { end_local: shift_local(&planned.start_local, minutes)?, start_local: planned.start_local, minutes })
}

fn whole_minutes(seconds: i64) -> i64 {
    ((seconds + 59).div_euclid(60)).max(1)
}

// The same characters JavaScript's encodeURIComponent leaves alone.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, COMPONENT).to_string()
}

pub fn timeshift_url(settings: &Settings, stream_id: i64, window: &Window) -> Result<String> {
    let start = format_start_for_url(&window.start_local)?;
    let base = settings.base_url();
    Ok(match settings.timeshift_mode {
        TimeshiftMode::Php => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("username", &settings.username)
                .append_pair("password", &settings.password)
                .append_pair("stream", &stream_id.to_string())
                .append_pair("start", &start)
                .append_pair("duration", &window.minutes.to_string())
                .finish();
            format!("{base}/streaming/timeshift.php?{query}")
        }
        TimeshiftMode::Path => format!(
            "{base}/timeshift/{}/{}/{}/{start}/{stream_id}.ts",
            encode_component(&settings.username),
            encode_component(&settings.password),
            window.minutes,
        ),
    })
}

fn tidy_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn strip_title(title: &str, strip: &[String]) -> String {
    let mut result = title.to_string();
    for s in strip.iter().filter(|s| !s.is_empty()) {
        result = result.replace(s.as_str(), "");
    }
    tidy_spaces(&result)
}

fn sanitize(name: &str) -> String {
    let swapped: String = name
        .chars()
        .map(|c| if "/\\?%*:|\"<>".contains(c) { '-' } else { c })
        .collect();
    tidy_spaces(&swapped).chars().take(120).collect()
}

pub fn output_filename(channel: &str, program: &Program, template: &str, strip: &[String]) -> Result<String> {
    let at = parse_local(&program.start_local)?;
    let date = at.format("%Y-%m-%d").to_string();
    let time = at.format("%H-%M").to_string();
    let token = |key: &str| -> Option<String> {
        Some(match key {
            "channel" => sanitize(channel),
            "title" => sanitize(&strip_title(&program.title, strip)),
            "date" => date.clone(),
            "time" => time.clone(),
            "datetime" => format!("{date}_{time}"),
            "year" => at.format("%Y").to_string(),
            "month" => at.format("%m").to_string(),
            "day" => at.format("%d").to_string(),
            "ext" => "ts".into(),
            _ => return None,
        })
    };

    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let word_len = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
        let key = &after[..word_len];
        match (after[word_len..].starts_with('}'), token(key)) {
            (true, Some(value)) if !key.is_empty() => {
                out.push_str(&value);
                rest = &after[word_len + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The show is in the archive, it finished after the cutoff, and its catchup should be
/// there by now.
pub fn is_due(program: &Program, padding_after: i64, grace: i64, cutoff: Option<i64>, now: i64) -> bool {
    if !program.has_archive || cutoff.is_some_and(|c| program.end <= c) {
        return false;
    }
    now >= ready_at(program, padding_after, grace)
}

/// The show's catchup isn't there yet. The archive flag doesn't count, since providers
/// only set it once a show has aired.
pub fn is_upcoming(program: &Program, padding_after: i64, grace: i64, cutoff: Option<i64>, now: i64) -> bool {
    if cutoff.is_some_and(|c| program.end <= c) {
        return false;
    }
    now < ready_at(program, padding_after, grace)
}

/// Some panels list the same show more than once, a few minutes apart. Overlapping entries
/// with the same title become one, from the earliest start to the latest end, so the
/// recording covers the show whichever copy is right. A real repeat doesn't overlap.
pub fn dedupe_overlapping(mut programs: Vec<Program>) -> Vec<Program> {
    programs.sort_by_key(|p| p.start);
    let mut kept: Vec<Program> = Vec::new();
    for p in programs {
        let existing = kept
            .iter_mut()
            .find(|k| k.title == p.title && p.start < k.end && k.start < p.end);
        match existing {
            None => kept.push(p),
            Some(k) => {
                if p.end > k.end {
                    k.end = p.end;
                    k.end_local = p.end_local;
                }
                k.has_archive |= p.has_archive;
            }
        }
    }
    kept
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The .nfo media servers read for the title, plot and air date. It has to be a movie,
/// because some servers (Silo) ignore a sidecar that doesn't match the library type.
pub fn build_nfo(program: &Program, date_added: &str) -> String {
    let premiered: String = program.start_local.chars().take(10).collect();
    let runtime = ((program.end - program.start) as f64 / 60.0).round().max(0.0) as i64;
    [
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#.to_string(),
        "<movie>".into(),
        format!("  <title>{}</title>", escape_xml(&program.title)),
        format!("  <plot>{}</plot>", escape_xml(&program.description)),
        format!("  <premiered>{premiered}</premiered>"),
        format!("  <runtime>{runtime}</runtime>"),
        format!("  <dateadded>{date_added}</dateadded>"),
        "</movie>".into(),
        String::new(),
    ]
    .join("\n")
}

#[cfg(test)]
pub mod tests {
    use super::*;

    // 2024-03-10 12:00 UTC to 13:00, long enough ago that nothing caps at now.
    pub fn program(title: &str) -> Program {
        Program {
            title: title.into(),
            description: String::new(),
            start: 1_710_072_000,
            end: 1_710_075_600,
            start_local: "2024-03-10 12:00:00".into(),
            end_local: "2024-03-10 13:00:00".into(),
            has_archive: true,
        }
    }

    fn settings() -> Settings {
        Settings {
            url: "http://example.com:8080".into(),
            username: "user".into(),
            password: "pass".into(),
            ..Settings::default()
        }
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn formats_the_start_for_the_url() {
        assert_eq!(format_start_for_url("2024-03-10 12:00:00").unwrap(), "2024-03-10:12-00");
        assert_eq!(format_start_for_url("2024-03-10 09:05:30").unwrap(), "2024-03-10:09-05");
    }

    #[test]
    fn window_without_padding_is_the_show() {
        let w = recording_window(&program("Launch"), 0, 0, NOW).unwrap();
        assert_eq!((w.minutes, w.start_local.as_str(), w.end_local.as_str()), (60, "2024-03-10 12:00:00", "2024-03-10 13:00:00"));
    }

    #[test]
    fn window_adds_and_trims_padding() {
        let w = recording_window(&program("Launch"), 2, 5, NOW).unwrap();
        assert_eq!((w.minutes, w.start_local.as_str(), w.end_local.as_str()), (67, "2024-03-10 11:58:00", "2024-03-10 13:05:00"));
        let w = recording_window(&program("Launch"), -5, -10, NOW).unwrap();
        assert_eq!((w.minutes, w.start_local.as_str()), (45, "2024-03-10 12:05:00"));
    }

    #[test]
    fn window_start_crosses_midnight() {
        let p = Program {
            start: 1_710_028_860,
            end: 1_710_030_660,
            start_local: "2024-03-10 00:01:00".into(),
            ..program("Launch")
        };
        let w = recording_window(&p, 5, 5, NOW).unwrap();
        assert_eq!((w.start_local.as_str(), w.minutes), ("2024-03-09 23:56:00", 40));
    }

    #[test]
    fn window_is_capped_at_now_while_a_show_is_on() {
        let p = program("Launch");
        let now = p.start + 10 * 60;
        assert_eq!(recording_window(&p, 0, 30, now).unwrap().minutes, 10);
    }

    #[test]
    fn planned_window_covers_a_show_that_hasnt_aired() {
        let p = program("Launch");
        let before_it_airs = p.start - 86_400;
        assert_eq!(planned_window(&p, 5, 30).unwrap().minutes, 95);
        assert_eq!(recording_window(&p, 5, 30, before_it_airs).unwrap().minutes, 1);
        assert_eq!(planned_window(&p, 2, 5).unwrap(), recording_window(&p, 2, 5, NOW).unwrap());
    }

    #[test]
    fn ready_time_rolls_into_the_next_day() {
        assert_eq!(ready_at_local(&program("Launch"), 0), "2024-03-10 13:00:00");
        assert_eq!(ready_at_local(&program("Launch"), 45), "2024-03-10 13:45:00");
        let late = Program { end_local: "2024-03-10 23:40:00".into(), ..program("Launch") };
        assert_eq!(ready_at_local(&late, 30), "2024-03-11 00:10:00");
    }

    #[test]
    fn builds_timeshift_urls() {
        let w = Window { start_local: "2024-03-10 12:00:00".into(), end_local: String::new(), minutes: 60 };
        assert_eq!(
            timeshift_url(&settings(), 42, &w).unwrap(),
            "http://example.com:8080/timeshift/user/pass/60/2024-03-10:12-00/42.ts"
        );
        let odd = Settings { username: "a b".into(), password: "p/@".into(), ..settings() };
        assert_eq!(
            timeshift_url(&odd, 42, &w).unwrap(),
            "http://example.com:8080/timeshift/a%20b/p%2F%40/60/2024-03-10:12-00/42.ts"
        );
        let php = Settings { timeshift_mode: TimeshiftMode::Php, ..settings() };
        assert_eq!(
            timeshift_url(&php, 42, &w).unwrap(),
            "http://example.com:8080/streaming/timeshift.php?username=user&password=pass&stream=42&start=2024-03-10%3A12-00&duration=60"
        );
    }

    fn name(template: &str, channel: &str, p: &Program, strip: &[&str]) -> String {
        let strip: Vec<String> = strip.iter().map(|s| s.to_string()).collect();
        output_filename(channel, p, template, &strip).unwrap()
    }

    #[test]
    fn fills_filename_templates() {
        let p = Program { start_local: "2024-03-10 21:30:00".into(), ..program("Artemis II Launch") };
        assert_eq!(name("{channel} - {title} - {datetime}.{ext}", "NASA TV", &p, &[]), "NASA TV - Artemis II Launch - 2024-03-10_21-30.ts");
        assert_eq!(name("{channel}/{title}.{ext}", "NASA TV", &p, &[]), "NASA TV/Artemis II Launch.ts");
        assert_eq!(name("{year}/{month}/{day} {title}.{ext}", "NASA TV", &p, &[]), "2024/03/10 Artemis II Launch.ts");
        assert_eq!(name("{channel} {bogus} {", "NASA TV", &p, &[]), "NASA TV {bogus} {");
    }

    #[test]
    fn sanitises_the_channel_and_title() {
        let p = Program { start_local: "2024-03-10 21:30:00".into(), ..program("Launch: Part 1") };
        assert_eq!(name("{channel} - {title} - {datetime}.{ext}", "News/Sport", &p, &[]), "News-Sport - Launch- Part 1 - 2024-03-10_21-30.ts");
    }

    #[test]
    fn strips_title_junk() {
        assert_eq!(name("{title}.{ext}", "NASA TV", &program("Rocket Launch ᴸᶦᵛᵉ"), &["ᴸᶦᵛᵉ"]), "Rocket Launch.ts");
        assert_eq!(name("{title}.{ext}", "NASA TV", &program("Rocket (HD) Launch"), &["(HD)"]), "Rocket Launch.ts");
    }

    #[test]
    fn refuses_an_odd_start_format() {
        let p = Program { start_local: "10/03/2024 21:30".into(), ..program("Launch") };
        let err = output_filename("NASA TV", &p, "{title}", &[]).unwrap_err();
        assert!(err.to_string().contains("Unexpected EPG start format"));
    }

    #[test]
    fn due_and_upcoming_at_the_edges() {
        let p = program("Launch");
        assert!(!is_due(&p, 0, 0, None, p.end - 1));
        assert!(is_due(&p, 0, 0, None, p.end));
        assert!(!is_due(&p, 30, 0, None, p.end + 29 * 60));
        assert!(is_due(&p, 30, 5, None, p.end + 35 * 60));
        assert!(!is_due(&Program { has_archive: false, ..p.clone() }, 0, 0, None, NOW));
        assert!(!is_due(&p, 0, 0, Some(p.end), NOW));
        assert!(is_due(&p, 0, 0, Some(p.end - 1), NOW));

        assert!(is_upcoming(&p, 0, 0, None, p.end - 1));
        assert!(!is_upcoming(&p, 0, 0, None, p.end));
        assert!(is_upcoming(&Program { has_archive: false, ..p.clone() }, 0, 0, None, p.start));
        assert!(!is_upcoming(&p, 0, 0, Some(p.end), p.start));
    }

    #[test]
    fn overlapping_copies_merge_but_repeats_stay() {
        let a = program("Launch");
        let b = Program {
            start: a.start + 300,
            end: a.end + 600,
            end_local: "2024-03-10 13:10:00".into(),
            has_archive: false,
            ..a.clone()
        };
        let repeat = Program { start: a.end + 3600, end: a.end + 7200, ..a.clone() };
        let other = Program { title: "Docking".into(), ..a.clone() };
        let merged = dedupe_overlapping(vec![b, repeat, a.clone(), other]);
        assert_eq!(merged.len(), 3);
        let launch = &merged[0];
        assert_eq!((launch.start, launch.end, launch.end_local.as_str(), launch.has_archive), (a.start, a.end + 600, "2024-03-10 13:10:00", true));
    }

    #[test]
    fn nfo_fills_and_escapes() {
        let p = Program {
            description: "Quote: \"go\"\nLive & loud.".into(),
            start_local: "2024-03-10 21:30:00".into(),
            ..program("Apollo & Soyuz <Live>")
        };
        let nfo = build_nfo(&p, "2024-03-10 22:05:00");
        assert!(nfo.starts_with(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#));
        assert!(nfo.ends_with("</movie>\n"));
        assert!(nfo.contains("<title>Apollo &amp; Soyuz &lt;Live&gt;</title>"));
        assert!(nfo.contains("<plot>Quote: &quot;go&quot;\nLive &amp; loud.</plot>"));
        assert!(nfo.contains("<premiered>2024-03-10</premiered>"));
        assert!(nfo.contains("<runtime>60</runtime>"));
        assert!(nfo.contains("<dateadded>2024-03-10 22:05:00</dateadded>"));
    }
}
