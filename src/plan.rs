//! How a recording will be made: the filename, the padding, and whether the .nfo and
//! comskip run. Downloads, scheduled recordings and subscriptions all go through here.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::recording::{Nfo, Program, output_filename};
use crate::settings::Settings;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub filename: String,
    pub padding_before: i64,
    pub padding_after: i64,
    pub write_nfo: bool,
    pub comskip: bool,
    /// .nfo details typed in for this recording. None takes them from the guide.
    #[serde(default)]
    pub nfo: Option<Nfo>,
}

/// What a subscription or scheduled recording saved. Anything left empty follows the
/// settings, so a later change there still applies.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Overrides {
    pub filename: Option<String>,
    pub padding_before: Option<i64>,
    pub padding_after: Option<i64>,
    pub write_nfo: Option<bool>,
    pub comskip: Option<bool>,
    pub filename_template: Option<String>,
    pub filename_strip: Option<Vec<String>>,
    pub nfo: Option<Nfo>,
}

pub fn resolve(settings: &Settings, channel: &str, program: &Program, overrides: &Overrides) -> Result<Plan> {
    let filename = match &overrides.filename {
        Some(name) => name.clone(),
        None => output_filename(
            channel,
            program,
            overrides.filename_template.as_deref().unwrap_or(&settings.filename_template),
            overrides.filename_strip.as_deref().unwrap_or(&settings.filename_strip),
        )?,
    };
    Ok(Plan {
        filename,
        padding_before: overrides.padding_before.unwrap_or(settings.padding_before),
        padding_after: overrides.padding_after.unwrap_or(settings.padding_after),
        write_nfo: overrides.write_nfo.unwrap_or(settings.write_nfo),
        comskip: overrides.comskip.unwrap_or(settings.comskip),
        nfo: overrides.nfo.clone(),
    })
}

/// Only what was changed from the defaults, so a scheduled recording keeps following the
/// settings for everything else.
pub fn changes(plan: &Plan, defaults: &Plan) -> Overrides {
    fn differs<T: PartialEq + Clone>(a: &T, b: &T) -> Option<T> {
        (a != b).then(|| a.clone())
    }
    Overrides {
        filename: differs(&plan.filename, &defaults.filename),
        padding_before: differs(&plan.padding_before, &defaults.padding_before),
        padding_after: differs(&plan.padding_after, &defaults.padding_after),
        write_nfo: differs(&plan.write_nfo, &defaults.write_nfo),
        comskip: differs(&plan.comskip, &defaults.comskip),
        nfo: plan.nfo.clone(),
        ..Overrides::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::tests::program;

    #[test]
    fn overrides_win_and_the_rest_follow_settings() {
        let settings = Settings { padding_before: 2, padding_after: 5, comskip: true, ..Settings::default() };
        let p = program("Artemis II Launch");
        let plan = resolve(&settings, "NASA TV", &p, &Overrides::default()).unwrap();
        assert_eq!(plan.filename, "NASA TV - Artemis II Launch - 2024-03-10_12-00.ts");
        assert_eq!((plan.padding_before, plan.padding_after, plan.write_nfo, plan.comskip), (2, 5, true, true));

        let overrides = Overrides {
            padding_after: Some(30),
            comskip: Some(false),
            filename_template: Some("NASA/{title}.{ext}".into()),
            ..Overrides::default()
        };
        let plan = resolve(&settings, "NASA TV", &p, &overrides).unwrap();
        assert_eq!(plan.filename, "NASA/Artemis II Launch.ts");
        assert_eq!((plan.padding_before, plan.padding_after, plan.comskip), (2, 30, false));

        let named = Overrides { filename: Some("mine.ts".into()), ..overrides };
        assert_eq!(resolve(&settings, "NASA TV", &p, &named).unwrap().filename, "mine.ts");
    }

    #[test]
    fn only_changes_are_kept() {
        let settings = Settings::default();
        let defaults = resolve(&settings, "NASA TV", &program("Launch"), &Overrides::default()).unwrap();
        assert_eq!(changes(&defaults, &defaults), Overrides::default());
        let edited = Plan { padding_after: 15, write_nfo: false, ..defaults.clone() };
        assert_eq!(
            changes(&edited, &defaults),
            Overrides { padding_after: Some(15), write_nfo: Some(false), ..Overrides::default() }
        );
    }
}
