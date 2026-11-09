//! Pushes fresh bits of page to every open tab over server sent events.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::{Notify, broadcast};

#[derive(Clone)]
pub struct Push {
    pub event: &'static str,
    pub data: String,
}

pub struct Live {
    tx: broadcast::Sender<Push>,
    last: Mutex<HashMap<&'static str, String>>,
    /// Set when something on screen may have changed, so the panels get redrawn.
    pub dirty: Notify,
}

impl Default for Live {
    fn default() -> Live {
        Live { tx: broadcast::channel(256).0, last: Mutex::default(), dirty: Notify::new() }
    }
}

impl Live {
    /// The latest copy of every panel, so a new tab starts current, and the stream after it.
    pub fn subscribe(&self) -> (Vec<Push>, broadcast::Receiver<Push>) {
        let rx = self.tx.subscribe();
        let snapshot = self
            .last
            .lock()
            .unwrap()
            .iter()
            .map(|(event, data)| Push { event, data: data.clone() })
            .collect();
        (snapshot, rx)
    }

    pub fn watched(&self) -> bool {
        self.tx.receiver_count() > 0
    }

    pub fn changed(&self) {
        self.dirty.notify_one();
    }

    /// Sends a rendered panel, unless nothing in it changed.
    pub fn panel(&self, event: &'static str, html: String) {
        let mut last = self.last.lock().unwrap();
        if last.get(event) == Some(&html) {
            return;
        }
        last.insert(event, html.clone());
        let _ = self.tx.send(Push { event, data: html });
    }

    /// Tells pages showing this kind of data to reload it.
    pub fn nudge(&self, event: &'static str) {
        // Browsers drop events with no data, so it needs something in it.
        let _ = self.tx.send(Push { event, data: "1".into() });
    }

    pub fn send(&self, event: &'static str, data: String) {
        let _ = self.tx.send(Push { event, data });
    }
}
