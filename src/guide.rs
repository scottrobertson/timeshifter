//! Remembers what the provider said for a few minutes, so moving between pages doesn't
//! ask it for the whole channel list every time.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::recording::{Channel, Program};
use crate::settings::Settings;
use crate::xtream::{self, Account};

const CHANNELS_FOR: Duration = Duration::from_secs(10 * 60);
const PROGRAMS_FOR: Duration = Duration::from_secs(3 * 60);
const ACCOUNT_FOR: Duration = Duration::from_secs(30 * 60);

struct Cached<T> {
    at: Instant,
    value: Arc<T>,
}

impl<T> Cached<T> {
    fn fresh(&self, ttl: Duration) -> Option<Arc<T>> {
        (self.at.elapsed() < ttl).then(|| self.value.clone())
    }
}

#[derive(Default)]
pub struct Guide {
    channels: Mutex<Option<Cached<Vec<Channel>>>>,
    programs: Mutex<HashMap<i64, Cached<Vec<Program>>>>,
    account: Mutex<Option<Cached<Account>>>,
}

impl Guide {
    /// Forgets everything, for when the provider settings change.
    pub fn clear(&self) {
        *self.channels.lock().unwrap() = None;
        self.programs.lock().unwrap().clear();
        *self.account.lock().unwrap() = None;
    }

    pub async fn channels(&self, settings: &Settings, fresh: bool) -> Result<Arc<Vec<Channel>>> {
        if !fresh && let Some(hit) = self.channels.lock().unwrap().as_ref().and_then(|c| c.fresh(CHANNELS_FOR)) {
            return Ok(hit);
        }
        let value = Arc::new(xtream::archive_channels(settings).await?);
        *self.channels.lock().unwrap() = Some(Cached { at: Instant::now(), value: value.clone() });
        Ok(value)
    }

    /// The channel list if it's been read recently, without asking the provider.
    pub fn cached_channels(&self) -> Option<Arc<Vec<Channel>>> {
        self.channels.lock().unwrap().as_ref().map(|c| c.value.clone())
    }

    pub async fn channel(&self, settings: &Settings, stream_id: i64) -> Result<Option<Channel>> {
        Ok(self.channels(settings, false).await?.iter().find(|c| c.stream_id == stream_id).cloned())
    }

    pub async fn programs(&self, settings: &Settings, stream_id: i64, fresh: bool) -> Result<Arc<Vec<Program>>> {
        if !fresh && let Some(hit) = self.programs.lock().unwrap().get(&stream_id).and_then(|c| c.fresh(PROGRAMS_FOR)) {
            return Ok(hit);
        }
        let value = Arc::new(xtream::programs(settings, stream_id).await?);
        self.programs.lock().unwrap().insert(stream_id, Cached { at: Instant::now(), value: value.clone() });
        Ok(value)
    }

    pub async fn account(&self, settings: &Settings, fresh: bool) -> Result<Arc<Account>> {
        if !fresh && let Some(hit) = self.account.lock().unwrap().as_ref().and_then(|c| c.fresh(ACCOUNT_FOR)) {
            return Ok(hit);
        }
        let value = Arc::new(xtream::account(settings).await?);
        *self.account.lock().unwrap() = Some(Cached { at: Instant::now(), value: value.clone() });
        Ok(value)
    }

    /// The provider's timezone, which guide times are in. Only if it's already known, so a
    /// page never waits on it.
    pub fn timezone(&self) -> Option<String> {
        self.account.lock().unwrap().as_ref().and_then(|a| a.value.timezone.clone())
    }
}
