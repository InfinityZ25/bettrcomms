use getrandom::getrandom;
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::File,
    io::Read,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::WebviewWindow;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_EXPORT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CONVERTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RUNNING_CONVERSIONS: usize = 2;
const MAX_ACTIVE_EXPORTS: usize = 8;
const EXPORT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct RecordingExportState {
    exports: Mutex<HashMap<String, PendingExport>>,
    conversions: Mutex<HashMap<String, RunningConversion>>,
}

impl Drop for RecordingExportState {
    fn drop(&mut self) {
        if let Ok(conversions) = self.conversions.get_mut() {
            for conversion in conversions.values() {
                conversion.cancel.store(true, Ordering::Release);
            }
        }
    }
}

struct RunningConversion {
    owner: ExportOwner,
    cancel: Arc<AtomicBool>,
}

struct PendingExport {
    owner: ExportOwner,
    destination: PathBuf,
    staging: NamedTempFile,
    expected_bytes: u64,
    written_bytes: u64,
    touched_at: Instant,
    format: Option<ConversionFormat>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConversionFormat {
    Mp4,
    Wav,
    Mp3,
}

impl ConversionFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "mp4" => Ok(Self::Mp4),
            "wav" => Ok(Self::Wav),
            "mp3" => Ok(Self::Mp3),
            _ => Err("conversion format must be mp4, wav, or mp3".to_owned()),
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExportOwner {
    window_label: String,
    origin: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingExportGrant {
    export_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingExportResult {
    file_name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCapability {
    id: &'static str,
    extension: &'static str,
    label: &'static str,
    available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCapabilities {
    available: bool,
    detail: String,
    formats: Vec<ConversionCapability>,
}

#[tauri::command]
pub async fn recording_conversion_capabilities(
    webview: WebviewWindow,
) -> Result<ConversionCapabilities, String> {
    export_owner(&webview)?;
    let Some(path) = crate::ffmpeg_setup::runtime_path() else {
        return Ok(ConversionCapabilities {
            available: false,
            detail: "Install the native sharing runtime to convert recording tracks".to_owned(),
            formats: conversion_formats(false, false, false),
        });
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command
            .args(["-hide_banner", "-encoders"])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Could not inspect the conversion runtime: {error}"))?;
        let encoders = String::from_utf8_lossy(&output.stdout);
        let h264 = output.status.success()
            && encoders.contains("libx264")
            && encoders.lines().any(|line| line.contains(" aac "));
        let mp3 = output.status.success() && encoders.contains("libmp3lame");
        Ok(ConversionCapabilities {
            available: output.status.success(),
            detail: if h264 && mp3 {
                "MP4, WAV, and MP3 conversion is ready"
            } else {
                "One or more FFmpeg conversion encoders are unavailable"
            }
            .to_owned(),
            formats: conversion_formats(h264, output.status.success(), mp3),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn conversion_formats(h264: bool, wav: bool, mp3: bool) -> Vec<ConversionCapability> {
    vec![
        ConversionCapability {
            id: "mp4",
            extension: "mp4",
            label: "MP4 · H.264 high quality",
            available: h264,
        },
        ConversionCapability {
            id: "wav",
            extension: "wav",
            label: "WAV · PCM 48 kHz",
            available: wav,
        },
        ConversionCapability {
            id: "mp3",
            extension: "mp3",
            label: "MP3 · 256 kbps",
            available: mp3,
        },
    ]
}

#[tauri::command]
pub async fn recording_conversion_begin(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    file_name: String,
    size_bytes: u64,
    format: String,
) -> Result<Option<RecordingExportGrant>, String> {
    let owner = export_owner(&webview)?;
    let format = ConversionFormat::parse(&format)?;
    if size_bytes == 0 || size_bytes > MAX_EXPORT_BYTES {
        return Err(format!(
            "recording assets must contain 1 byte to {} MiB",
            MAX_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    if crate::ffmpeg_setup::runtime_path().is_none() {
        return Err("Install the native sharing runtime before converting recordings".to_owned());
    }
    let safe = safe_suggested_name(&file_name);
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("recording");
    let suggested_name = format!("{stem}.{}", format.extension());
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let mut pending = create_pending_export(handle.path().to_path_buf(), size_bytes, owner)?;
    pending.format = Some(format);
    let mut exports = exports_lock(&state)?;
    remove_expired(&mut exports, Instant::now());
    let conversions = state
        .conversions
        .lock()
        .map_err(|_| "recording conversion state is unavailable")?;
    if exports.len() + conversions.len() >= MAX_ACTIVE_EXPORTS {
        return Err("too many recording exports are already pending".to_owned());
    }
    let export_id = loop {
        let candidate = opaque_id()?;
        if !exports.contains_key(&candidate) && !conversions.contains_key(&candidate) {
            break candidate;
        }
    };
    exports.insert(export_id.clone(), pending);
    Ok(Some(RecordingExportGrant { export_id }))
}

fn exports_lock(
    state: &RecordingExportState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, PendingExport>>, String> {
    state
        .exports
        .lock()
        .map_err(|_| "recording export state is unavailable".to_owned())
}

fn remove_expired(exports: &mut HashMap<String, PendingExport>, now: Instant) {
    exports.retain(|_, export| now.duration_since(export.touched_at) < EXPORT_TTL);
}

fn safe_suggested_name(input: &str) -> String {
    let leaf = Path::new(input)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("recording.webm");
    let sanitized: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(240)
        .collect();
    let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "recording.webm".to_owned()
    } else {
        sanitized.to_owned()
    }
}

fn opaque_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| "could not create an export identifier".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn export_owner(webview: &WebviewWindow) -> Result<ExportOwner, String> {
    if webview.label() != "main" {
        return Err("recording export commands require the main app window".to_owned());
    }
    let current_url = webview.url().map_err(|error| error.to_string())?;
    Ok(ExportOwner {
        window_label: webview.label().to_owned(),
        origin: crate::media_permissions::trusted_app_origin(&current_url).map_err(|_| {
            "recording export commands require the BetterComms app origin".to_owned()
        })?,
    })
}

fn require_owner(export: &PendingExport, owner: &ExportOwner) -> Result<(), String> {
    if export.owner != *owner {
        Err("recording export grant does not belong to this app window and origin".to_owned())
    } else {
        Ok(())
    }
}

fn create_pending_export(
    destination: PathBuf,
    expected_bytes: u64,
    owner: ExportOwner,
) -> Result<PendingExport, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "the selected export location has no parent directory".to_owned())?;
    let staging = TempFileBuilder::new()
        .prefix(".bettercomms-recording-")
        .tempfile_in(parent)
        .map_err(|error| format!("could not create the recording export: {error}"))?;
    Ok(PendingExport {
        owner,
        destination,
        staging,
        expected_bytes,
        written_bytes: 0,
        touched_at: Instant::now(),
        format: None,
    })
}

#[tauri::command]
pub async fn recording_export_begin(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    file_name: String,
    size_bytes: u64,
) -> Result<Option<RecordingExportGrant>, String> {
    let owner = export_owner(&webview)?;
    if size_bytes > MAX_EXPORT_BYTES {
        return Err(format!(
            "recording assets larger than {} MiB cannot be exported",
            MAX_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    let suggested_name = safe_suggested_name(&file_name);
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let destination = handle.path().to_path_buf();
    let pending = create_pending_export(destination, size_bytes, owner)?;

    let mut exports = exports_lock(&state)?;
    remove_expired(&mut exports, Instant::now());
    let conversions = state
        .conversions
        .lock()
        .map_err(|_| "recording conversion state is unavailable")?;
    if exports.len() + conversions.len() >= MAX_ACTIVE_EXPORTS {
        return Err("too many recording exports are already pending".to_owned());
    }
    let export_id = loop {
        let candidate = opaque_id()?;
        if !exports.contains_key(&candidate) && !conversions.contains_key(&candidate) {
            break candidate;
        }
    };
    exports.insert(export_id.clone(), pending);
    Ok(Some(RecordingExportGrant { export_id }))
}

#[tauri::command]
pub fn recording_export_append(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    export_id: String,
    offset: u64,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let owner = export_owner(&webview)?;
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Err("recording export chunks must contain between 1 byte and 1 MiB".to_owned());
    }
    let mut exports = exports_lock(&state)?;
    remove_expired(&mut exports, Instant::now());
    let write_result = {
        let export = exports
            .get_mut(&export_id)
            .ok_or_else(|| "recording export is missing or expired".to_owned())?;
        require_owner(export, &owner)?;
        append_pending(export, offset, &bytes)
    };
    if write_result
        .as_ref()
        .is_err_and(|error| error.kind() != io::ErrorKind::Other)
    {
        // A short write leaves the staging stream's precise position unknown.
        // Revoke the grant instead of allowing a retry to corrupt the asset.
        exports.remove(&export_id);
    }
    write_result.map_err(|error| {
        if error.kind() == io::ErrorKind::Other {
            error.to_string()
        } else {
            format!("could not write the recording export: {error}")
        }
    })
}

fn append_pending(export: &mut PendingExport, offset: u64, bytes: &[u8]) -> io::Result<()> {
    if offset != export.written_bytes {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!(
                "recording export chunk offset {offset} does not match expected offset {}",
                export.written_bytes
            ),
        ));
    }
    let next_size = export
        .written_bytes
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "recording export size overflowed"))?;
    if next_size > export.expected_bytes {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "recording export received more bytes than declared",
        ));
    }
    export.staging.write_all(bytes)?;
    export.written_bytes = next_size;
    export.touched_at = Instant::now();
    Ok(())
}

fn finish_pending(mut export: PendingExport) -> Result<RecordingExportResult, String> {
    if export.written_bytes != export.expected_bytes {
        return Err(format!(
            "recording export is incomplete: received {} of {} bytes",
            export.written_bytes, export.expected_bytes
        ));
    }
    export
        .staging
        .flush()
        .and_then(|_| export.staging.as_file().sync_all())
        .map_err(|error| format!("could not flush the recording export: {error}"))?;
    let destination = export.destination.clone();
    let persisted: File = export
        .staging
        .persist(&destination)
        .map_err(|error| format!("could not save the recording export: {}", error.error))?;
    persisted
        .sync_all()
        .map_err(|error| format!("could not finalize the recording export: {error}"))?;
    sync_parent(&destination).map_err(|error| {
        format!("the recording was saved but its directory could not be synchronized: {error}")
    })?;
    Ok(RecordingExportResult {
        file_name: destination
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("recording")
            .to_owned(),
        path: destination.to_string_lossy().into_owned(),
    })
}

#[cfg(unix)]
fn sync_parent(destination: &Path) -> io::Result<()> {
    File::open(destination.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_destination: &Path) -> io::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn recording_export_finish(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    export_id: String,
) -> Result<RecordingExportResult, String> {
    let owner = export_owner(&webview)?;
    let export = {
        let mut exports = exports_lock(&state)?;
        remove_expired(&mut exports, Instant::now());
        let export = exports
            .get(&export_id)
            .ok_or_else(|| "recording export is missing or expired".to_owned())?;
        require_owner(export, &owner)?;
        if export.format.is_some() {
            return Err("use recording_conversion_finish for a conversion grant".to_owned());
        }
        exports.remove(&export_id).expect("export was just checked")
    };
    finish_pending(export)
}

#[tauri::command]
pub fn recording_export_abort(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    export_id: String,
) -> Result<(), String> {
    let owner = export_owner(&webview)?;
    let mut exports = exports_lock(&state)?;
    remove_expired(&mut exports, Instant::now());
    if let Some(export) = exports.get(&export_id) {
        require_owner(export, &owner)?;
    }
    exports.remove(&export_id);
    drop(exports);
    let conversions = state
        .conversions
        .lock()
        .map_err(|_| "recording conversion state is unavailable")?;
    if let Some(conversion) = conversions.get(&export_id) {
        require_running_owner(conversion, &owner)?;
        conversion.cancel.store(true, Ordering::Release);
    }
    Ok(())
}

fn require_running_owner(
    conversion: &RunningConversion,
    owner: &ExportOwner,
) -> Result<(), String> {
    if conversion.owner != *owner {
        Err("recording export grant does not belong to this app window and origin".to_owned())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn recording_conversion_finish(
    state: tauri::State<'_, RecordingExportState>,
    webview: WebviewWindow,
    export_id: String,
) -> Result<RecordingExportResult, String> {
    let owner = export_owner(&webview)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let export = {
        let mut exports = exports_lock(&state)?;
        remove_expired(&mut exports, Instant::now());
        let export = exports
            .get(&export_id)
            .ok_or_else(|| "recording conversion is missing or expired".to_owned())?;
        require_owner(export, &owner)?;
        if export.format.is_none() {
            return Err("this grant is for an original recording export".to_owned());
        }
        if export.written_bytes != export.expected_bytes {
            return Err(format!(
                "recording conversion is incomplete: received {} of {} bytes",
                export.written_bytes, export.expected_bytes
            ));
        }
        let mut running = state
            .conversions
            .lock()
            .map_err(|_| "recording conversion state is unavailable")?;
        if running.len() >= MAX_RUNNING_CONVERSIONS {
            return Err("two recording conversions are already running".to_owned());
        }
        running.insert(
            export_id.clone(),
            RunningConversion {
                owner: owner.clone(),
                cancel: cancel.clone(),
            },
        );
        exports
            .remove(&export_id)
            .expect("conversion was just checked")
    };
    let joined =
        tauri::async_runtime::spawn_blocking(move || convert_pending(export, cancel)).await;
    state
        .conversions
        .lock()
        .map_err(|_| "recording conversion state is unavailable")?
        .remove(&export_id);
    joined.map_err(|error| format!("recording conversion task failed: {error}"))?
}

fn convert_pending(
    mut export: PendingExport,
    cancel: Arc<AtomicBool>,
) -> Result<RecordingExportResult, String> {
    let format = export
        .format
        .ok_or("recording conversion format is missing")?;
    export
        .staging
        .flush()
        .and_then(|_| export.staging.as_file().sync_all())
        .map_err(|error| format!("could not flush the recording input: {error}"))?;
    let parent = export
        .destination
        .parent()
        .ok_or("the selected conversion location has no parent directory")?;
    let output = TempFileBuilder::new()
        .prefix(".bettercomms-conversion-")
        .suffix(&format!(".{}", format.extension()))
        .tempfile_in(parent)
        .map_err(|error| format!("could not create conversion output: {error}"))?
        .into_temp_path();
    let ffmpeg = crate::ffmpeg_setup::runtime_path()
        .ok_or("native conversion runtime is no longer installed")?;
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "matroska,mov",
            "-i",
        ])
        .arg(export.staging.path());
    match format {
        ConversionFormat::Mp4 => {
            command.args([
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-f",
                "mp4",
            ]);
        }
        ConversionFormat::Wav => {
            command.args([
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "48000",
                "-f",
                "wav",
            ]);
        }
        ConversionFormat::Mp3 => {
            command.args([
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "256k",
                "-f",
                "mp3",
            ]);
        }
    }
    command
        .args(["-threads", "4"])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start recording conversion: {error}"))?;
    if let Err(error) = crate::native_process::attach(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let stderr = child
        .stderr
        .take()
        .ok_or("could not monitor recording conversion")?;
    let diagnostics = std::thread::spawn(move || {
        let mut retained = Vec::new();
        for byte in stderr.bytes().filter_map(Result::ok) {
            if retained.len() < 4096 {
                retained.push(byte)
            }
        }
        retained
    });
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = diagnostics.join();
            return Err("recording conversion was canceled".to_owned());
        }
        if output
            .metadata()
            .is_ok_and(|metadata| metadata.len() > MAX_CONVERTED_BYTES)
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = diagnostics.join();
            return Err("converted recording exceeded the 2 GiB limit".to_owned());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = diagnostics.join();
            return Err("recording conversion exceeded its 30-minute time limit".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = diagnostics.join();
                return Err(format!("could not monitor recording conversion: {error}"));
            }
        }
    };
    let diagnostic = String::from_utf8_lossy(&diagnostics.join().unwrap_or_default())
        .trim()
        .to_owned();
    if !status.success() {
        return Err(if diagnostic.is_empty() {
            "FFmpeg could not convert this recording track".to_owned()
        } else {
            format!("FFmpeg could not convert this recording track: {diagnostic}")
        });
    }
    let length = output
        .metadata()
        .map_err(|error| format!("could not inspect converted recording: {error}"))?
        .len();
    if length == 0 || length > MAX_CONVERTED_BYTES {
        return Err("FFmpeg produced an invalid converted recording size".to_owned());
    }
    File::options()
        .write(true)
        .open(&output)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("could not flush converted recording: {error}"))?;
    let destination = export.destination.clone();
    output
        .persist(&destination)
        .map_err(|error| format!("could not save converted recording: {error}"))?;
    sync_parent(&destination).map_err(|error| format!("the converted recording was saved but its directory could not be synchronized: {error}"))?;
    Ok(RecordingExportResult {
        file_name: destination
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("recording")
            .to_owned(),
        path: destination.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn pending_at(directory: &Path, name: &str, size: u64) -> PendingExport {
        create_pending_export(
            directory.join(name),
            size,
            ExportOwner {
                window_label: "main".to_owned(),
                origin: "http://tauri.localhost".to_owned(),
            },
        )
        .expect("create staging file")
    }

    #[test]
    fn suggested_name_cannot_select_a_path() {
        assert_eq!(
            safe_suggested_name("../../private/track.webm"),
            "track.webm"
        );
        assert_eq!(
            safe_suggested_name(r"C:\\private\\track?.webm"),
            "track_.webm"
        );
        assert_eq!(safe_suggested_name(".."), "recording.webm");
    }

    #[test]
    fn chunk_lifecycle_persists_exact_bytes_and_replaces_destination() {
        let directory = tempfile::tempdir().expect("temp directory");
        let destination = directory.path().join("track.webm");
        fs::write(&destination, b"old").expect("seed destination");
        let mut pending = pending_at(directory.path(), "track.webm", 6);
        append_pending(&mut pending, 0, b"abc").expect("first chunk");
        append_pending(&mut pending, 3, b"def").expect("second chunk");

        let result = finish_pending(pending).expect("finish export");
        assert_eq!(result.file_name, "track.webm");
        assert_eq!(fs::read(destination).expect("read export"), b"abcdef");
    }

    #[test]
    fn rejects_retried_or_reordered_chunks_without_corrupting_staging() {
        let directory = tempfile::tempdir().expect("temp directory");
        let mut pending = pending_at(directory.path(), "track.webm", 6);
        append_pending(&mut pending, 0, b"abc").expect("first chunk");
        assert!(append_pending(&mut pending, 0, b"abc").is_err());
        assert!(append_pending(&mut pending, 4, b"def").is_err());
        append_pending(&mut pending, 3, b"def").expect("ordered second chunk");
        finish_pending(pending).expect("finish exact export");
        assert_eq!(
            fs::read(directory.path().join("track.webm")).expect("read export"),
            b"abcdef"
        );
    }

    #[test]
    fn incomplete_export_is_rejected_and_staging_is_deleted() {
        let directory = tempfile::tempdir().expect("temp directory");
        let staging_path = {
            let mut pending = pending_at(directory.path(), "track.webm", 4);
            let path = pending.staging.path().to_path_buf();
            pending.staging.write_all(b"abc").expect("chunk");
            pending.written_bytes = 3;
            assert!(finish_pending(pending).is_err());
            path
        };
        assert!(!staging_path.exists());
        assert!(!directory.path().join("track.webm").exists());
    }

    #[test]
    fn expired_exports_are_removed_with_their_staging_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let mut pending = pending_at(directory.path(), "track.webm", 1);
        let staging_path = pending.staging.path().to_path_buf();
        pending.touched_at = Instant::now() - EXPORT_TTL - Duration::from_secs(1);
        let mut exports = HashMap::from([("opaque".to_owned(), pending)]);
        remove_expired(&mut exports, Instant::now());
        assert!(exports.is_empty());
        assert!(!staging_path.exists());
    }

    #[test]
    fn conversion_format_is_a_closed_whitelist() {
        assert_eq!(
            ConversionFormat::parse("mp4").unwrap(),
            ConversionFormat::Mp4
        );
        assert_eq!(
            ConversionFormat::parse("wav").unwrap(),
            ConversionFormat::Wav
        );
        assert_eq!(
            ConversionFormat::parse("mp3").unwrap(),
            ConversionFormat::Mp3
        );
        for invalid in ["m4a", "../../mp4", "mp4 -f hls", "http"] {
            assert!(ConversionFormat::parse(invalid).is_err());
        }
    }

    #[test]
    #[ignore = "uses the installed pinned FFmpeg runtime for real media conversion"]
    fn real_webm_conversions_decode_and_preserve_inputs() -> Result<(), String> {
        let ffmpeg = crate::ffmpeg_setup::runtime_path().ok_or("FFmpeg runtime unavailable")?;
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        let video = directory.path().join("source-video.webm");
        let audio = directory.path().join("source-audio.webm");
        let generate = |arguments: &[&str], output: &Path| -> Result<(), String> {
            let status = Command::new(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-y"])
                .args(arguments)
                .arg(output)
                .status()
                .map_err(|error| error.to_string())?;
            status
                .success()
                .then_some(())
                .ok_or("could not generate synthetic WebM".to_owned())
        };
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-c:v",
                "libvpx-vp9",
                "-c:a",
                "libopus",
                "-f",
                "webm",
            ],
            &video,
        )?;
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000:duration=1",
                "-vn",
                "-c:a",
                "libopus",
                "-f",
                "webm",
            ],
            &audio,
        )?;
        let original_video = fs::read(&video).map_err(|error| error.to_string())?;
        let original_audio = fs::read(&audio).map_err(|error| error.to_string())?;
        let winget =
            PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?)
                .join(
                    "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
                );
        let mut probes = fs::read_dir(winget)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("bin/ffprobe.exe"))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        probes.sort();
        let ffprobe = probes.pop().ok_or("FFprobe unavailable")?;
        for (source, target_name, format, expected_codec) in [
            (
                &video,
                "converted.mp4",
                ConversionFormat::Mp4,
                "codec_name=h264",
            ),
            (
                &audio,
                "converted.wav",
                ConversionFormat::Wav,
                "codec_name=pcm_s16le",
            ),
            (
                &audio,
                "converted.mp3",
                ConversionFormat::Mp3,
                "codec_name=mp3",
            ),
        ] {
            let bytes = fs::read(source).map_err(|error| error.to_string())?;
            let mut pending = pending_at(directory.path(), target_name, bytes.len() as u64);
            pending
                .staging
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            pending.written_bytes = bytes.len() as u64;
            pending.format = Some(format);
            let result = convert_pending(pending, Arc::new(AtomicBool::new(false)))?;
            let status = Command::new(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(&result.path)
                .args(["-f", "null", "-"])
                .status()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!("converted {} did not decode", result.file_name));
            }
            let metadata = Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_name,sample_rate",
                    "-of",
                    "default=nw=1",
                ])
                .arg(&result.path)
                .output()
                .map_err(|error| error.to_string())?;
            let metadata = String::from_utf8_lossy(&metadata.stdout);
            if !metadata.contains(expected_codec)
                || (format != ConversionFormat::Mp4 && !metadata.contains("sample_rate=48000"))
                || (format == ConversionFormat::Mp4 && !metadata.contains("codec_name=aac"))
            {
                return Err(format!(
                    "converted {} metadata was unexpected: {metadata}",
                    result.file_name
                ));
            }
        }
        if fs::read(&video).map_err(|error| error.to_string())? != original_video
            || fs::read(&audio).map_err(|error| error.to_string())? != original_audio
        {
            return Err("conversion modified an original input".to_owned());
        }
        let mut canceled = pending_at(
            directory.path(),
            "canceled.mp4",
            original_video.len() as u64,
        );
        canceled
            .staging
            .write_all(&original_video)
            .map_err(|error| error.to_string())?;
        canceled.written_bytes = original_video.len() as u64;
        canceled.format = Some(ConversionFormat::Mp4);
        let cancel = Arc::new(AtomicBool::new(true));
        if !convert_pending(canceled, cancel).is_err_and(|error| error.contains("canceled")) {
            return Err("pre-canceled conversion did not stop".to_owned());
        }
        if directory.path().join("canceled.mp4").exists()
            || fs::read_dir(directory.path())
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".bettercomms-conversion-")
                })
        {
            return Err("canceled conversion left an output or staging file".to_owned());
        }
        Ok(())
    }
}
