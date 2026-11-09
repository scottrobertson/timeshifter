//! Xtream Codes API client. Only what timeshifter needs: check the login, list the
//! channels that keep an archive, and read a channel's guide.

use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Result, anyhow};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::recording::{Channel, Program, dedupe_overlapping};
use crate::settings::Settings;

const TIMEOUT: Duration = Duration::from_secs(30);

// No overall timeout here, since a recording can take an hour to come down. Guide
// requests set their own.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("building the HTTP client")
});

#[derive(Debug, Clone, Default)]
pub struct Account {
    pub status: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_connections: Option<i64>,
    /// The provider's timezone. Guide times are in it.
    pub timezone: Option<String>,
}

/// reqwest's own error text is vague, so say what actually went wrong.
pub fn describe_request_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return format!("Timed out after {}s", TIMEOUT.as_secs());
    }
    let mut source = std::error::Error::source(err);
    let mut deepest = None;
    while let Some(s) = source {
        deepest = Some(s.to_string());
        source = s.source();
    }
    match deepest {
        Some(cause) => format!("Connection failed: {cause}"),
        None => err.to_string(),
    }
}

// Providers turn requests away with a 503 or 429 when they're busy, so those get tried
// again after a growing pause.
const ATTEMPTS: u32 = 4;
const FIRST_RETRY_DELAY: Duration = if cfg!(test) { Duration::from_millis(5) } else { Duration::from_secs(1) };
const LONGEST_RETRY_DELAY: Duration = Duration::from_secs(30);

fn worth_retrying(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

/// Waits what the provider asked for in Retry-After, otherwise doubles each time. A little
/// randomness stops requests that failed together from all retrying together.
fn retry_delay(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let backoff = FIRST_RETRY_DELAY * 2u32.pow(attempt);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let jitter = Duration::from_millis(u64::from(nanos % 250));
    (retry_after.unwrap_or(backoff) + jitter).min(LONGEST_RETRY_DELAY)
}

pub async fn get(settings: &Settings, url: &str, timeout: Option<Duration>) -> Result<reqwest::Response> {
    let mut attempt = 0;
    loop {
        let mut request = CLIENT.get(url).header(reqwest::header::USER_AGENT, &settings.user_agent);
        if let Some(t) = timeout {
            request = request.timeout(t);
        }
        let res = request.send().await.map_err(|e| anyhow!(describe_request_error(&e)))?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        attempt += 1;
        if !worth_retrying(status) || attempt >= ATTEMPTS {
            let reason = status.canonical_reason().map(|r| format!(" {r}")).unwrap_or_default();
            return Err(anyhow!("The provider returned {}{reason}", status.as_u16()));
        }
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        tokio::time::sleep(retry_delay(attempt - 1, retry_after)).await;
    }
}

async fn player_api(settings: &Settings, params: &[(&str, &str)]) -> Result<Value> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("username", &settings.username)
        .append_pair("password", &settings.password)
        .extend_pairs(params)
        .finish();
    let url = format!("{}/player_api.php?{query}", settings.base_url());
    let res = get(settings, &url, Some(TIMEOUT)).await?;
    let text = res.text().await.map_err(|e| anyhow!(describe_request_error(&e)))?;
    serde_json::from_str(&text).map_err(|_| anyhow!("The provider didn't send back JSON. Check the server URL."))
}

fn number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn decode_base64(value: &str) -> String {
    base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| value.to_string())
}

pub async fn account(settings: &Settings) -> Result<Account> {
    parse_account(&player_api(settings, &[]).await?)
}

pub fn parse_account(data: &Value) -> Result<Account> {
    let info = data.get("user_info").filter(|v| v.is_object());
    let Some(info) = info.filter(|i| number(i.get("auth")) == 1.0) else {
        let message = info.and_then(|i| text(i.get("message")));
        return Err(anyhow!(
            "{}",
            message.unwrap_or_else(|| "The provider turned down the login. Check the URL, username and password.".into())
        ));
    };
    let positive = |v: Option<&Value>| Some(number(v)).filter(|n| *n > 0.0);
    Ok(Account {
        status: text(info.get("status")),
        expires_at: positive(info.get("exp_date")).and_then(|s| DateTime::from_timestamp(s as i64, 0)),
        max_connections: positive(info.get("max_connections")).map(|n| n as i64),
        timezone: data.get("server_info").and_then(|s| text(s.get("timezone"))),
    })
}

/// Channels that keep an archive, grouped by category in the provider's order.
pub async fn archive_channels(settings: &Settings) -> Result<Vec<Channel>> {
    // Categories are only for grouping, so a provider that won't list them still works.
    let categories = player_api(settings, &[("action", "get_live_categories")]).await.unwrap_or(Value::Null);
    let streams = player_api(settings, &[("action", "get_live_streams")]).await?;
    Ok(parse_channels(&categories, &streams))
}

pub fn parse_channels(categories: &Value, streams: &Value) -> Vec<Channel> {
    let categories: Vec<(String, String)> = categories
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| Some((text(c.get("category_id"))?, text(c.get("category_name"))?)))
                .collect()
        })
        .unwrap_or_default();
    let rank = |id: &Option<String>| {
        id.as_ref()
            .and_then(|id| categories.iter().position(|(c, _)| c == id))
            .unwrap_or(usize::MAX)
    };

    let mut channels: Vec<(usize, Channel)> = streams
        .as_array()
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|s| number(s.get("tv_archive")) == 1.0)
        .map(|s| {
            let category = text(s.get("category_id"));
            let stream_id = number(s.get("stream_id")) as i64;
            let channel = Channel {
                stream_id,
                name: text(s.get("name")).unwrap_or_else(|| format!("Channel {stream_id}")),
                archive_days: number(s.get("tv_archive_duration")).max(0.0) as i64,
                group: categories.iter().find(|(id, _)| Some(id) == category.as_ref()).map(|(_, n)| n.clone()),
            };
            (rank(&category), channel)
        })
        .collect();
    // A stable sort, so channels keep the provider's order within a category.
    channels.sort_by_key(|(rank, _)| *rank);
    channels.into_iter().map(|(_, c)| c).collect()
}

/// A channel's guide, newest first. Includes shows that already aired, which is what the
/// archive holds.
pub async fn programs(settings: &Settings, stream_id: i64) -> Result<Vec<Program>> {
    let data = player_api(
        settings,
        &[("action", "get_simple_data_table"), ("stream_id", &stream_id.to_string())],
    )
    .await?;
    Ok(parse_programs(&data))
}

pub fn parse_programs(data: &Value) -> Vec<Program> {
    let listings = data
        .get("epg_listings")
        .and_then(|l| l.as_array())
        .map(|l| l.as_slice())
        .unwrap_or_default();
    let programs = listings
        .iter()
        .filter_map(|l| {
            let start_local = text(l.get("start"))?;
            let program = Program {
                title: text(l.get("title")).map(|t| decode_base64(&t)).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Untitled".into()),
                description: text(l.get("description")).map(|d| decode_base64(&d)).unwrap_or_default(),
                start: number(l.get("start_timestamp")) as i64,
                end: number(l.get("stop_timestamp")) as i64,
                start_local,
                end_local: text(l.get("end")).unwrap_or_default(),
                has_archive: number(l.get("has_archive")) == 1.0,
            };
            (program.end > program.start).then_some(program)
        })
        .collect();
    let mut programs = dedupe_overlapping(programs);
    programs.reverse();
    programs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn reads_the_account() {
        let ok = parse_account(&json!({
            "user_info": { "auth": 1, "status": "Active", "exp_date": "1800000000", "max_connections": "2" },
            "server_info": { "timezone": "Europe/London" },
        }))
        .unwrap();
        assert_eq!(ok.status.as_deref(), Some("Active"));
        assert_eq!(ok.expires_at.unwrap().timestamp(), 1_800_000_000);
        assert_eq!(ok.max_connections, Some(2));
        assert_eq!(ok.timezone.as_deref(), Some("Europe/London"));

        let no_expiry = parse_account(&json!({ "user_info": { "auth": "1", "exp_date": null } })).unwrap();
        assert_eq!(no_expiry.expires_at, None);

        let refused = parse_account(&json!({ "user_info": { "auth": 0, "message": "Nope" } })).unwrap_err();
        assert_eq!(refused.to_string(), "Nope");
        assert!(parse_account(&json!({})).is_err());
    }

    #[test]
    fn lists_archive_channels_in_category_order() {
        let categories = json!([
            { "category_id": "2", "category_name": "Space" },
            { "category_id": 1, "category_name": "News" },
        ]);
        let streams = json!([
            { "stream_id": 1, "name": "No Archive", "tv_archive": 0, "category_id": "2" },
            { "stream_id": "7", "name": "Newsroom", "tv_archive": "1", "tv_archive_duration": "3", "category_id": "1" },
            { "stream_id": 9, "name": "NASA TV", "tv_archive": 1, "tv_archive_duration": 7, "category_id": "2" },
            { "stream_id": 10, "name": "NASA TV UHD", "tv_archive": 1, "tv_archive_duration": 7, "category_id": "2" },
            { "stream_id": 11, "name": "", "tv_archive": 1 },
        ]);
        let channels = parse_channels(&categories, &streams);
        let names: Vec<&str> = channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["NASA TV", "NASA TV UHD", "Newsroom", "Channel 11"]);
        assert_eq!(channels[0].group.as_deref(), Some("Space"));
        assert_eq!((channels[2].stream_id, channels[2].archive_days), (7, 3));
        assert_eq!(channels[3].group, None);
        assert_eq!(parse_channels(&Value::Null, &streams).len(), 4);
    }

    #[test]
    fn reads_the_guide_newest_first() {
        let data = json!({ "epg_listings": [
            { "title": b64("Artemis II Launch"), "description": b64("Live coverage."), "start": "2024-03-10 12:00:00", "end": "2024-03-10 13:00:00", "start_timestamp": "1710072000", "stop_timestamp": "1710075600", "has_archive": 1 },
            { "title": b64("Crew-12 Docking"), "description": "", "start": "2024-03-10 13:00:00", "end": "2024-03-10 14:00:00", "start_timestamp": 1710075600, "stop_timestamp": 1710079200, "has_archive": "0" },
            { "title": b64("Backwards"), "start": "2024-03-10 15:00:00", "start_timestamp": "200", "stop_timestamp": "100" },
            { "title": b64("No start string"), "start_timestamp": "100", "stop_timestamp": "200" },
        ]});
        let programs = parse_programs(&data);
        assert_eq!(programs.len(), 2);
        assert_eq!(programs[0].title, "Crew-12 Docking");
        assert!(!programs[0].has_archive);
        assert_eq!(programs[1].title, "Artemis II Launch");
        assert_eq!(programs[1].description, "Live coverage.");
        assert_eq!(programs[1].end_local, "2024-03-10 13:00:00");
        assert!(parse_programs(&json!({})).is_empty());
    }
}
