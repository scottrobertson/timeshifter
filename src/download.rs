//! Fetching a recording and the files that go next to it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::db::now;
use crate::jobs::{JobCtx, Jobs, Trigger, Work};
use crate::plan::Plan;
use crate::recording::{Channel, Program, build_nfo, recording_window, timeshift_url};
use crate::scheduled;
use crate::settings::Settings;
use crate::xtream;

pub fn size(bytes: i64) -> String {
    let n = bytes as f64;
    if n >= 1e9 { format!("{:.2} GB", n / 1e9) } else { format!("{:.0} MB", n / 1e6) }
}

pub async fn run(
    jobs: &Jobs,
    ctx: &JobCtx,
    channel: &Channel,
    program: &Program,
    plan: &Plan,
    scheduled_id: Option<i64>,
) -> Result<()> {
    let settings = jobs.db().settings().await;
    if settings.download_dir.trim().is_empty() {
        bail!("Set a download folder in Settings first");
    }
    let window = recording_window(program, plan.padding_before, plan.padding_after, now())?;
    let url = timeshift_url(&settings, channel.stream_id, &window)?;
    let output = Path::new(&settings.download_dir).join(&plan.filename);
    ctx.info(format!(
        "Recording {} from {} to {}, {} min",
        channel.name,
        &window.start_local[..16],
        &window.end_local[..16],
        window.minutes
    ))
    .await;

    let saved = fetch(&settings, ctx, &url, &output).await?;

    if settings.set_aired_time
        && let Err(e) = set_file_time(&output, program.end)
    {
        ctx.warn(format!("Couldn't set the file date: {e:#}")).await;
    }
    if plan.write_nfo {
        match sync_nfo(program, &output) {
            Ok(_) => ctx.info("Wrote the .nfo").await,
            Err(e) => ctx.warn(format!("Couldn't write the .nfo: {e:#}")).await,
        }
    }
    let path = output.to_string_lossy().to_string();
    if let Some(id) = scheduled_id {
        let path = path.clone();
        jobs.db().call(move |conn| scheduled::finish(conn, id, "done", Some(&path))).await?;
    }
    if plan.comskip {
        jobs.enqueue(Work::Comskip { path: path.clone() }, Trigger::Automatic).await?;
    }
    ctx.info(format!("Saved {path}")).await;
    ctx.summary(format!("Saved {}", size(saved)));
    Ok(())
}

/// Streams the recording to a hidden .part file, remuxes it so it seeks properly, then
/// renames it into place. Media servers ignore the work files, and the rename means a
/// library only ever sees the finished recording appear.
pub async fn fetch(settings: &Settings, ctx: &JobCtx, url: &str, output: &Path) -> Result<i64> {
    let dir = output.parent().unwrap_or(Path::new("."));
    let base = output.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let part = dir.join(format!(".{base}.part"));
    let remuxed = dir.join(format!(".{base}.remux"));
    tokio::fs::create_dir_all(dir).await.with_context(|| format!("Couldn't create {}", dir.display()))?;

    let result = async {
        ctx.step("Downloading").await;
        let (bytes, expected) = stream_to_file(settings, ctx, url, &part).await?;
        if let Some(expected) = expected.filter(|e| (bytes as f64) < *e as f64 * 0.99) {
            ctx.warn(format!("Expected about {}, so this may be incomplete", size(expected))).await;
        }
        ctx.step("Processing the recording").await;
        remux(ctx, &part, &remuxed).await?;
        tokio::fs::rename(&remuxed, output).await.context("Couldn't move the recording into place")?;
        Ok(bytes)
    }
    .await;
    let _ = tokio::fs::remove_file(&part).await;
    let _ = tokio::fs::remove_file(&remuxed).await;
    result
}

/// A plain GET straight to a file. No Range requests: some CDNs serve a normal GET fine
/// but drip feed Range requests, so resuming by byte offset crawls.
pub async fn stream_to_file(settings: &Settings, ctx: &JobCtx, url: &str, dest: &Path) -> Result<(i64, Option<i64>)> {
    let res = xtream::get(settings, url, None).await.map_err(|e| anyhow!("Download failed: {e:#}"))?;
    let expected = res.content_length().map(|n| n as i64).filter(|n| *n > 0);
    let mut file = tokio::io::BufWriter::new(
        tokio::fs::File::create(dest).await.with_context(|| format!("Couldn't write {}", dest.display()))?,
    );
    let mut stream = res.bytes_stream();
    let started = Instant::now();
    let mut bytes: i64 = 0;
    loop {
        let chunk = tokio::select! {
            chunk = stream.next() => chunk,
            _ = ctx.cancelled() => bail!("Stopped"),
        };
        match chunk {
            None => break,
            Some(Ok(chunk)) => {
                file.write_all(&chunk).await.context("Couldn't write the recording")?;
                bytes += chunk.len() as i64;
                let speed = bytes as f64 / started.elapsed().as_secs_f64().max(0.001);
                ctx.progress(bytes, expected, Some(format!("Downloading at {:.0} MB/s", speed / 1e6))).await;
            }
            // Servers tend to close a touch before the advertised length. Essentially all
            // of it is fine; only a real shortfall is a failure.
            Some(Err(e)) => {
                if expected.is_some_and(|x| bytes as f64 >= x as f64 * 0.99) {
                    break;
                }
                bail!("The download broke off after {}: {}", size(bytes), xtream::describe_request_error(&e));
            }
        }
    }
    file.flush().await.context("Couldn't write the recording")?;
    ctx.progress(bytes, expected, None).await;
    Ok((bytes, expected))
}

/// Rewrites the timestamps without re-encoding. The provider stitches archive segments
/// together, which leaves the raw file unseekable with a nonsense duration.
async fn remux(ctx: &JobCtx, input: &Path, output: &Path) -> Result<()> {
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostats", "-fflags", "+genpts", "-i"])
        .arg(input)
        .args(["-c", "copy", "-avoid_negative_ts", "make_zero", "-muxpreload", "0", "-muxdelay", "0"])
        // The work file has no .ts extension to work the format out from.
        .args(["-f", "mpegts", "-y"])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => anyhow!("ffmpeg isn't installed. Install it first, for example with brew install ffmpeg."),
            _ => anyhow!("Couldn't start ffmpeg: {e}"),
        })?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut messages = String::new();
    let status = tokio::select! {
        status = async {
            let _ = stderr.read_to_string(&mut messages).await;
            child.wait().await
        } => status?,
        _ = ctx.cancelled() => bail!("Stopped"),
    };
    if !status.success() {
        let messages = messages.trim();
        if messages.is_empty() {
            bail!("ffmpeg failed ({status})");
        }
        bail!("ffmpeg failed: {messages}");
    }
    Ok(())
}

/// Sets a file's modified time, so a library sorts recordings by when they aired.
pub fn set_file_time(path: &Path, unix: i64) -> Result<()> {
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix.max(0) as u64);
    let file = std::fs::File::options().write(true).open(path)?;
    file.set_times(std::fs::FileTimes::new().set_modified(when).set_accessed(when))?;
    Ok(())
}

pub fn sidecar(output: &Path, ext: &str) -> PathBuf {
    output.with_extension(ext)
}

#[derive(Debug, PartialEq)]
pub enum NfoChange {
    Created,
    Updated,
    Unchanged,
}

/// Writes or refreshes a recording's .nfo. Keeps the original dateadded so a refresh
/// doesn't churn it, and only writes when something changed, so it's cheap on every check.
pub fn sync_nfo(program: &Program, output: &Path) -> Result<NfoChange> {
    let path = sidecar(output, "nfo");
    let existing = std::fs::read_to_string(&path).ok();
    let date_added = existing
        .as_deref()
        .and_then(|e| Some(e.split("<dateadded>").nth(1)?.split("</dateadded>").next()?.to_string()))
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
    let contents = build_nfo(program, &date_added);
    if existing.as_deref() == Some(contents.as_str()) {
        return Ok(NfoChange::Unchanged);
    }
    std::fs::write(&path, contents).with_context(|| format!("Couldn't write {}", path.display()))?;
    Ok(if existing.is_none() { NfoChange::Created } else { NfoChange::Updated })
}

// comskip only writes the .edl when output_edl is on, and by default it also leaves .txt
// and .log files next to the recording, so those are turned off.
const DEFAULT_COMSKIP_INI: &str = "[Main Settings]\noutput_edl=1\noutput_txt=0\noutput_default=0\n";

/// Your own comskip.ini: COMSKIP_INI if it's set, otherwise one in the config folder.
/// Absolute, because comskip runs in the download folder.
pub fn custom_comskip_ini(env: Option<String>, config_dir: &Path) -> Option<PathBuf> {
    if let Some(path) = env.filter(|p| !p.trim().is_empty()) {
        return std::path::absolute(path).ok();
    }
    let file = config_dir.join("comskip.ini");
    file.exists().then(|| std::path::absolute(file).ok()).flatten()
}

pub async fn run_comskip(jobs: &Jobs, ctx: &JobCtx, path: &str) -> Result<()> {
    let output = Path::new(path);
    if !output.exists() {
        bail!("The recording isn't there any more");
    }
    let edl = sidecar(output, "edl");
    if edl.exists() {
        ctx.summary(breaks(count_lines(&edl)?));
        return Ok(());
    }
    ctx.step("Detecting commercials").await;
    let breaks_found = ensure_edl(ctx, output, jobs.config_dir()).await?;
    ctx.summary(breaks(breaks_found));
    Ok(())
}

fn breaks(n: usize) -> String {
    if n == 1 { "1 ad break found".into() } else { format!("{n} ad breaks found") }
}

fn count_lines(path: &Path) -> Result<usize> {
    Ok(std::fs::read_to_string(path)?.lines().filter(|l| !l.trim().is_empty()).count())
}

/// Runs comskip to write the .edl next to the recording, and gives back how many ad breaks
/// it found. A recording with none still gets an empty .edl, so it isn't run again.
pub async fn ensure_edl(ctx: &JobCtx, output: &Path, config_dir: &Path) -> Result<usize> {
    let edl = sidecar(output, "edl");
    let dir = output.parent().unwrap_or(Path::new(".")).to_path_buf();
    let temp = tempdir_for_ini()?;
    let ini = match custom_comskip_ini(std::env::var("COMSKIP_INI").ok(), config_dir) {
        Some(ini) => ini,
        None => {
            let path = temp.join("comskip.ini");
            std::fs::write(&path, DEFAULT_COMSKIP_INI)?;
            path
        }
    };
    let bin = std::env::var("COMSKIP_PATH").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "comskip".into());

    let result = async {
        // -v 1 makes comskip print its progress even when it isn't writing to a terminal.
        let mut child = Command::new(&bin)
            .arg("-v")
            .arg("1")
            .arg(format!("--ini={}", ini.display()))
            .arg(format!("--output={}", dir.display()))
            .arg(output)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => anyhow!("comskip isn't installed. Install it or set COMSKIP_PATH."),
                _ => anyhow!("Couldn't start comskip: {e}"),
            })?;
        let mut stderr = child.stderr.take().expect("piped stderr");
        let mut messages = String::new();
        let read = async {
            let mut buffer = String::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stderr.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buffer.push_str(&String::from_utf8_lossy(&chunk[..n]));
                // comskip redraws its progress in place with \r, so split on that too.
                while let Some(pos) = buffer.find(['\r', '\n']) {
                    let segment: String = buffer.drain(..=pos).collect();
                    take_segment(ctx, segment.trim(), &mut messages).await;
                }
            }
            take_segment(ctx, buffer.trim(), &mut messages).await;
            child.wait().await
        };
        // comskip exits non zero just for "no commercials found", so whether the .edl was
        // written is the real test.
        tokio::select! {
            _ = read => {}
            _ = ctx.cancelled() => bail!("Stopped"),
        }
        if !edl.exists() {
            let messages = messages.trim();
            if messages.is_empty() {
                bail!("comskip produced no .edl");
            }
            bail!("comskip produced no .edl: {messages}");
        }
        count_lines(&edl)
    }
    .await;

    let _ = std::fs::remove_dir_all(&temp);
    // The -v used for progress makes comskip leave a .log next to the recording.
    let _ = std::fs::remove_file(sidecar(output, "log"));
    result
}

async fn take_segment(ctx: &JobCtx, segment: &str, messages: &mut String) {
    if segment.is_empty() {
        return;
    }
    let percent = segment
        .strip_suffix('%')
        .and_then(|s| s.rsplit(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse::<i64>().ok());
    match percent {
        Some(p) => ctx.progress(p.min(100), Some(100), None).await,
        None => {
            messages.push_str(segment);
            messages.push('\n');
        }
    }
}

fn tempdir_for_ini() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("timeshifter-comskip-{}-{}", std::process::id(), now_nanos()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::tests::program;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn sidecars_sit_next_to_the_recording() {
        let ts = Path::new("/catchup/NASA TV/Launch - 2024-03-10_12-00.ts");
        assert_eq!(sidecar(ts, "nfo"), Path::new("/catchup/NASA TV/Launch - 2024-03-10_12-00.nfo"));
        assert_eq!(sidecar(ts, "edl"), Path::new("/catchup/NASA TV/Launch - 2024-03-10_12-00.edl"));
    }

    #[test]
    fn sets_the_file_date() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("launch.ts");
        std::fs::write(&file, "x").unwrap();
        set_file_time(&file, 1_710_075_600).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(), 1_710_075_600);
    }

    #[test]
    fn nfo_is_created_left_alone_then_updated_keeping_dateadded() {
        let dir = tempfile::tempdir().unwrap();
        let ts = dir.path().join("launch.ts");
        assert_eq!(sync_nfo(&program("Artemis II Launch"), &ts).unwrap(), NfoChange::Created);
        let first = std::fs::read_to_string(sidecar(&ts, "nfo")).unwrap();
        assert_eq!(sync_nfo(&program("Artemis II Launch"), &ts).unwrap(), NfoChange::Unchanged);
        assert_eq!(sync_nfo(&program("Artemis III Launch"), &ts).unwrap(), NfoChange::Updated);
        let second = std::fs::read_to_string(sidecar(&ts, "nfo")).unwrap();
        let added = |s: &str| s.split("<dateadded>").nth(1).unwrap().split('<').next().unwrap().to_string();
        assert_eq!(added(&first), added(&second));
        assert!(second.contains("Artemis III Launch"));
    }

    #[test]
    fn finds_your_own_comskip_ini() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(custom_comskip_ini(None, dir.path()), None);
        std::fs::write(dir.path().join("comskip.ini"), "").unwrap();
        assert_eq!(custom_comskip_ini(None, dir.path()), Some(dir.path().join("comskip.ini")));
        assert_eq!(custom_comskip_ini(Some("/etc/mine.ini".into()), dir.path()), Some(PathBuf::from("/etc/mine.ini")));
        assert!(custom_comskip_ini(Some("mine.ini".into()), dir.path()).unwrap().is_absolute());
    }

    /// A stand in for an external tool, as a small shell script.
    fn fake_tool(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    // COMSKIP_PATH is process wide, so the comskip cases run in one test.
    #[tokio::test]
    async fn comskip_writes_the_edl_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let ts = dir.path().join("Artemis II Launch.ts");
        std::fs::write(&ts, "x").unwrap();
        let ctx = JobCtx::detached();

        // The real comskip takes the recording last and writes next to it.
        let edl = fake_tool(
            bin.path(),
            "edl",
            r#"for last; do :; done; base="${last%.ts}"; printf '10\r50%%\r' >&2; printf '0 10 0\n20 30 0\n' > "$base.edl"; echo log > "$base.log"; exit 1"#,
        );
        unsafe { std::env::set_var("COMSKIP_PATH", &edl) };
        assert_eq!(ensure_edl(&ctx, &ts, dir.path()).await.unwrap(), 2);
        let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left, ["Artemis II Launch.edl", "Artemis II Launch.ts"]);

        let clean = dir.path().join("clean.ts");
        std::fs::write(&clean, "x").unwrap();
        let empty = fake_tool(bin.path(), "empty", r#"for last; do :; done; : > "${last%.ts}.edl"; exit 1"#);
        unsafe { std::env::set_var("COMSKIP_PATH", &empty) };
        assert_eq!(ensure_edl(&ctx, &clean, dir.path()).await.unwrap(), 0);

        let broken = dir.path().join("broken.ts");
        std::fs::write(&broken, "x").unwrap();
        let fail = fake_tool(bin.path(), "fail", "echo 'no video stream' >&2; exit 1");
        unsafe { std::env::set_var("COMSKIP_PATH", &fail) };
        let err = ensure_edl(&ctx, &broken, dir.path()).await.unwrap_err();
        assert_eq!(err.to_string(), "comskip produced no .edl: no video stream");

        unsafe { std::env::set_var("COMSKIP_PATH", dir.path().join("missing")) };
        let err = ensure_edl(&ctx, &broken, dir.path()).await.unwrap_err();
        assert!(err.to_string().contains("comskip isn't installed"));
        unsafe { std::env::remove_var("COMSKIP_PATH") };
    }
}
