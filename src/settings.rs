//! Everything set on the Settings page. Stored as one JSON value in the database, with
//! the same field names config.json used, so importing an old config.json is a plain read.

use serde::{Deserialize, Serialize};

pub const DEFAULT_FILENAME_TEMPLATE: &str = "{channel} - {title} - {datetime}.{ext}";
pub const DEFAULT_NFO_TITLE: &str = "{title}";
pub const DEFAULT_NFO_PLOT: &str = "{description}";
// Many panels drop connections from clients that don't look like a real player,
// especially on long downloads.
pub const DEFAULT_USER_AGENT: &str = "VLC/3.0.18 LibVLC/3.0.18";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TimeshiftMode {
    #[default]
    Path,
    Php,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub url: String,
    pub username: String,
    pub password: String,
    pub download_dir: String,
    pub user_agent: String,
    pub timeshift_mode: TimeshiftMode,
    pub padding_before: i64,
    pub padding_after: i64,
    pub filename_template: String,
    pub filename_strip: Vec<String>,
    pub set_aired_time: bool,
    pub write_nfo: bool,
    /// What the .nfo says, filled in like the filename template.
    pub nfo_title: String,
    pub nfo_plot: String,
    pub nfo_set: String,
    pub comskip: bool,
    pub poll_interval_minutes: i64,
    pub ready_grace_minutes: i64,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            download_dir: String::new(),
            user_agent: DEFAULT_USER_AGENT.into(),
            timeshift_mode: TimeshiftMode::Path,
            padding_before: 0,
            padding_after: 0,
            filename_template: DEFAULT_FILENAME_TEMPLATE.into(),
            filename_strip: Vec::new(),
            set_aired_time: true,
            write_nfo: true,
            nfo_title: DEFAULT_NFO_TITLE.into(),
            nfo_plot: DEFAULT_NFO_PLOT.into(),
            nfo_set: String::new(),
            comskip: false,
            poll_interval_minutes: 10,
            ready_grace_minutes: 0,
        }
    }
}

impl Settings {
    /// The provider login is filled in, so the guide can be read.
    pub fn has_provider(&self) -> bool {
        !self.url.trim().is_empty() && !self.username.trim().is_empty() && !self.password.is_empty()
    }

    pub fn base_url(&self) -> String {
        self.url.trim().trim_end_matches('/').to_string()
    }
}
