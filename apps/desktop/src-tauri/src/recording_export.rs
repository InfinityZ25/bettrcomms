use getrandom::getrandom;
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_EXPORT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ACTIVE_EXPORTS: usize = 8;
const EXPORT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct RecordingExportState {
    exports: Mutex<HashMap<String, PendingExport>>,
}

struct PendingExport {
    owner: ExportOwner,
    destination: PathBuf,
    staging: NamedTempFile,
    expected_bytes: u64,
    written_bytes: u64,
    touched_at: Instant,
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
    if exports.len() >= MAX_ACTIVE_EXPORTS {
        return Err("too many recording exports are already pending".to_owned());
    }
    let export_id = loop {
        let candidate = opaque_id()?;
        if !exports.contains_key(&candidate) {
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
    Ok(())
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
}
