//! Pass-through MP4 recording for the exact Annex-B access units produced by
//! native screen capture. Capture threads only perform bounded `try_send`s.
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const ACCESS_UNIT_QUEUE: usize = 8;
const MAX_FINISHED_ASSETS: usize = 8;
const MAX_MUXER_DIAGNOSTIC_BYTES: usize = 16 * 1024;

#[derive(Clone)]
struct Capture {
    fps: u32,
    ffmpeg: PathBuf,
}

struct Recorder {
    session_id: String,
    sender: SyncSender<AccessUnit>,
    stop: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    worker: JoinHandle<Result<WorkerResult, String>>,
}

struct AccessUnit {
    bytes: Vec<u8>,
    captured_at: Instant,
}

struct WorkerResult {
    file: NamedTempFile,
    started_delay_ms: u64,
    duration_ms: u64,
}

struct Asset {
    file: NamedTempFile,
    size_bytes: u64,
}

#[derive(Default)]
struct Store {
    captures: HashMap<String, Capture>,
    recorders: HashMap<String, Recorder>,
    assets: HashMap<String, Asset>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not allocate recording ID".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native recording is restricted to the app window".to_owned());
    }
    crate::media_permissions::trusted_app_origin(
        &window.url().map_err(|error| error.to_string())?,
    )?;
    Ok(())
}

fn staging_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Local application directory is unavailable".to_owned())?
        .join("Bettercomms/recording-staging");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create recording staging directory: {error}"))?;
    Ok(root)
}

/// Called once after a native capture process starts. No frontend path is used.
pub fn register_session(session_id: &str, fps: u32, ffmpeg: PathBuf) -> Result<(), String> {
    if !matches!(fps, 30 | 60) || !ffmpeg.is_file() {
        return Err("Native recording received an invalid capture registration".to_owned());
    }
    store()
        .lock()
        .map_err(|_| "Native recording state is unavailable".to_owned())?
        .captures
        .insert(session_id.to_owned(), Capture { fps, ffmpeg });
    Ok(())
}

/// Called from the capture output loop. This never waits for disk or FFmpeg.
pub fn feed_access_unit(session_id: &str, access_unit: &[u8]) {
    let captured_at = Instant::now();
    let guard = match store().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let recorder = guard
        .recorders
        .values()
        .find(|recorder| recorder.session_id == session_id);
    let Some(recorder) = recorder else { return };
    match recorder.sender.try_send(AccessUnit {
        bytes: access_unit.to_vec(),
        captured_at,
    }) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            set_failure(
                &recorder.failure,
                "Native recording could not keep up with capture",
            );
            recorder.stop.store(true, Ordering::Release);
        }
        Err(TrySendError::Disconnected(_)) => recorder.stop.store(true, Ordering::Release),
    }
}

/// Called on explicit stop and every encoder/capture error path.
pub fn capture_ended(session_id: &str) {
    if let Ok(mut guard) = store().lock() {
        guard.captures.remove(session_id);
        for recorder in guard
            .recorders
            .values()
            .filter(|recorder| recorder.session_id == session_id)
        {
            recorder.stop.store(true, Ordering::Release);
        }
    }
}

fn set_failure(slot: &Mutex<Option<String>>, message: &str) {
    if let Ok(mut failure) = slot.lock() {
        if failure.is_none() {
            *failure = Some(message.to_owned());
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    recording_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingAsset {
    asset_id: String,
    mime_type: &'static str,
    size_bytes: u64,
    started_delay_ms: u64,
    duration_ms: u64,
}

#[tauri::command]
pub fn native_screen_recording_start(
    window: WebviewWindow,
    session_id: String,
) -> Result<RecordingStarted, String> {
    trusted(&window)?;
    let recording_id = {
        let mut guard = store()
            .lock()
            .map_err(|_| "Native recording state is unavailable".to_owned())?;
        let capture = guard
            .captures
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Native screen capture is no longer active".to_owned())?;
        if guard
            .recorders
            .values()
            .any(|recorder| recorder.session_id == session_id)
        {
            return Err("This native screen capture is already being recorded".to_owned());
        }
        let recording_id = token()?;
        let (sender, receiver) = mpsc::sync_channel(ACCESS_UNIT_QUEUE);
        let stop = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        let requested_at = Instant::now();
        let worker_stop = stop.clone();
        let worker_failure = failure.clone();
        let worker_capture = capture.clone();
        let worker = std::thread::spawn(move || {
            record_worker(
                worker_capture,
                receiver,
                requested_at,
                worker_stop,
                worker_failure,
            )
        });
        guard.recorders.insert(
            recording_id.clone(),
            Recorder {
                session_id: session_id.clone(),
                sender,
                stop: stop.clone(),
                failure: failure.clone(),
                worker,
            },
        );
        recording_id
    };
    Ok(RecordingStarted { recording_id })
}

fn is_idr(access_unit: &[u8]) -> bool {
    let mut index = 0;
    while index + 4 <= access_unit.len() {
        let prefix = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        if access_unit
            .get(index + prefix)
            .is_some_and(|header| header & 0x1f == 5)
        {
            return true;
        }
        index += prefix + 1;
    }
    false
}

fn ffmpeg_command(path: &Path, fps: u32, output: &Path) -> Command {
    let mut command = Command::new(path);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "+genpts",
            "-framerate",
            &fps.to_string(),
            "-f",
            "h264",
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            "-fs",
            &MAX_ASSET_BYTES.to_string(),
            "-y",
        ])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

struct ProcessGuard {
    child: Arc<Mutex<std::process::Child>>,
    done: Arc<AtomicBool>,
    watchdog: Option<JoinHandle<()>>,
}

impl ProcessGuard {
    fn new(child: std::process::Child, stop: Arc<AtomicBool>) -> Self {
        let child = Arc::new(Mutex::new(child));
        let done = Arc::new(AtomicBool::new(false));
        let watch_child = child.clone();
        let watch_done = done.clone();
        let watchdog = std::thread::spawn(move || {
            let mut stop_deadline = None;
            while !watch_done.load(Ordering::Acquire) {
                if stop.load(Ordering::Acquire) {
                    let deadline = stop_deadline
                        .get_or_insert_with(|| Instant::now() + Duration::from_secs(5));
                    if Instant::now() >= *deadline {
                        if let Ok(mut child) = watch_child.lock() {
                            let _ = child.kill();
                        }
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        Self {
            child,
            done,
            watchdog: Some(watchdog),
        }
    }

    fn try_wait(&self) -> Result<Option<std::process::ExitStatus>, String> {
        self.child
            .lock()
            .map_err(|_| "Recording muxer state is unavailable".to_owned())?
            .try_wait()
            .map_err(|error| format!("Could not wait for recording muxer: {error}"))
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Release);
        self.kill();
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
    }
}

fn record_worker(
    capture: Capture,
    receiver: Receiver<AccessUnit>,
    requested_at: Instant,
    stop: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<WorkerResult, String> {
    let file = TempFileBuilder::new()
        .prefix("native-screen-")
        .suffix(".mp4")
        .tempfile_in(staging_root()?)
        .map_err(|error| format!("Could not create native recording: {error}"))?;
    let mut child = ffmpeg_command(&capture.ffmpeg, capture.fps, file.path())
        .spawn()
        .map_err(|error| format!("Could not start recording muxer: {error}"))?;
    if let Err(error) = crate::native_process::attach(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| "Recording muxer input is unavailable".to_owned())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Recording muxer diagnostics are unavailable".to_owned())?;
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut diagnostic = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let remaining = MAX_MUXER_DIAGNOSTIC_BYTES.saturating_sub(diagnostic.len());
                    diagnostic.extend_from_slice(&buffer[..count.min(remaining)]);
                }
                Err(_) => break,
            }
        }
        let _ = stderr_sender.send(diagnostic);
    });
    let process = ProcessGuard::new(child, stop.clone());
    let mut started_at = None;
    let mut last_frame_at = None;
    let mut consume = |access_unit: AccessUnit| -> Result<(), String> {
        if started_at.is_none() {
            if !is_idr(&access_unit.bytes) {
                return Ok(());
            }
            started_at = Some(access_unit.captured_at);
        }
        input
            .write_all(&access_unit.bytes)
            .map_err(|error| format!("Could not write recording access unit: {error}"))?;
        last_frame_at = Some(access_unit.captured_at);
        Ok(())
    };
    loop {
        if stop.load(Ordering::Acquire) {
            while let Ok(access_unit) = receiver.try_recv() {
                consume(access_unit)?;
            }
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(access_unit) => consume(access_unit)?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = process.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            process.kill();
            return Err("Recording muxer did not finish in time".to_owned());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let diagnostic = stderr_receiver
        .recv_timeout(Duration::from_millis(250))
        .unwrap_or_default();
    if let Some(message) = failure.lock().ok().and_then(|slot| slot.clone()) {
        return Err(message);
    }
    let started_at = started_at
        .ok_or_else(|| "Native recording ended before a decodable IDR frame arrived".to_owned())?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&diagnostic)
            .replace(
                file.path().to_string_lossy().as_ref(),
                "<recording-staging>",
            )
            .replace(['\r', '\n'], " ");
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            "Recording muxer could not finalize the MP4".to_owned()
        } else {
            format!(
                "Recording muxer could not finalize the MP4: {}",
                detail.chars().take(512).collect::<String>()
            )
        });
    }
    let size_bytes = file
        .as_file()
        .metadata()
        .map_err(|error| format!("Could not inspect native recording: {error}"))?
        .len();
    if size_bytes == 0 || size_bytes > MAX_ASSET_BYTES {
        return Err("Native recording exceeded its 512 MiB limit or was empty".to_owned());
    }
    let frame_ms = 1000_u64.div_ceil(capture.fps as u64);
    Ok(WorkerResult {
        file,
        started_delay_ms: started_at.duration_since(requested_at).as_millis() as u64,
        duration_ms: last_frame_at
            .unwrap_or(started_at)
            .duration_since(started_at)
            .as_millis() as u64
            + frame_ms,
    })
}

#[tauri::command]
pub async fn native_screen_recording_stop(
    window: WebviewWindow,
    recording_id: String,
) -> Result<RecordingAsset, String> {
    trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || finish_recording(recording_id))
        .await
        .map_err(|error| format!("Native recording task failed: {error}"))?
}

fn finish_recording(recording_id: String) -> Result<RecordingAsset, String> {
    let recorder = store()
        .lock()
        .map_err(|_| "Native recording state is unavailable".to_owned())?
        .recorders
        .remove(&recording_id)
        .ok_or_else(|| "Native recording is missing or already stopped".to_owned())?;
    recorder.stop.store(true, Ordering::Release);
    let result = recorder
        .worker
        .join()
        .map_err(|_| "Native recording worker stopped unexpectedly".to_owned())??;
    let size_bytes = result
        .file
        .as_file()
        .metadata()
        .map_err(|error| format!("Could not inspect native recording: {error}"))?
        .len();
    let asset_id = token()?;
    let mut guard = store()
        .lock()
        .map_err(|_| "Native recording state is unavailable".to_owned())?;
    if guard.assets.len() >= MAX_FINISHED_ASSETS {
        return Err(
            "Release another completed native recording before reading this one".to_owned(),
        );
    }
    guard.assets.insert(
        asset_id.clone(),
        Asset {
            file: result.file,
            size_bytes,
        },
    );
    Ok(RecordingAsset {
        asset_id,
        mime_type: "video/mp4",
        size_bytes,
        started_delay_ms: result.started_delay_ms,
        duration_ms: result.duration_ms,
    })
}

#[tauri::command]
pub fn native_screen_recording_read(
    window: WebviewWindow,
    asset_id: String,
    offset: u64,
    max_bytes: usize,
) -> Result<tauri::ipc::Response, String> {
    trusted(&window)?;
    if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
        return Err("Native recording reads must be between 1 byte and 256 KiB".to_owned());
    }
    let mut guard = store()
        .lock()
        .map_err(|_| "Native recording state is unavailable".to_owned())?;
    let asset = guard
        .assets
        .get_mut(&asset_id)
        .ok_or_else(|| "Native recording asset is missing or released".to_owned())?;
    if offset > asset.size_bytes {
        return Err("Native recording read offset exceeds the asset size".to_owned());
    }
    let count = max_bytes.min((asset.size_bytes - offset) as usize);
    let file: &mut File = asset.file.as_file_mut();
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| {
            let mut bytes = vec![0_u8; count];
            file.read_exact(&mut bytes).map(|_| bytes)
        })
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Could not read native recording: {error}"))
}

#[tauri::command]
pub fn native_screen_recording_release(
    window: WebviewWindow,
    asset_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    store()
        .lock()
        .map_err(|_| "Native recording state is unavailable".to_owned())?
        .assets
        .remove(&asset_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idr_detection_accepts_three_and_four_byte_annex_b_start_codes() {
        assert!(is_idr(&[0, 0, 0, 1, 9, 16, 0, 0, 1, 5, 7]));
        assert!(is_idr(&[0, 0, 1, 5, 7]));
        assert!(!is_idr(&[0, 0, 0, 1, 1, 7]));
    }

    #[test]
    fn opaque_ids_are_random_and_fixed_length() {
        let first = token().unwrap();
        let second = token().unwrap();
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
