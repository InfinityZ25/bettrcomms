//! Windows Graphics Capture runs in a bounded, native encoder process. Encoded
//! access units go directly to WebRTC, never through a browser video encoder.
use crate::native_screen_rtc::{
    h264_ffmpeg_level, NativeH264Profile, NativeIceCandidate, NativeIceServer, NativeScreenRtcHub,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewWindow};

#[derive(Default)]
pub struct NativeScreenState {
    sources: Mutex<HashMap<String, Source>>,
    session: Mutex<Option<Arc<Session>>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    kind: String,
    name: String,
    width: u32,
    height: u32,
    category: String,
    minimized: bool,
    #[serde(skip)]
    handle: usize,
}
#[derive(Serialize)]
pub struct Sources {
    sources: Vec<Source>,
}
#[derive(Clone, Serialize)]
pub struct Encoder {
    id: String,
    label: String,
    available: bool,
    reason: String,
}
#[derive(Clone, Serialize)]
pub struct Capabilities {
    available: bool,
    detail: String,
    encoders: Vec<Encoder>,
    version: u8,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    session_id: String,
    width: u32,
    height: u32,
    fps: u32,
    encoder: String,
    h264_profile: NativeH264Profile,
}
struct Session {
    info: Started,
    hub: Arc<NativeScreenRtcHub>,
    child: Mutex<Child>,
    stopped: AtomicBool,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native capture is restricted to the app window".into());
    }
    crate::media_permissions::trusted_app_origin(&window.url().map_err(|e| e.to_string())?)?;
    Ok(())
}
fn token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not allocate capture ID")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn ffmpeg() -> Result<PathBuf, String> {
    if let Some(path) = crate::ffmpeg_setup::runtime_path() {
        return Ok(path);
    }
    // Use a known installed distribution, not a frontend-provided executable.
    let local =
        std::env::var_os("LOCALAPPDATA").ok_or("Local application directory is unavailable")?;
    let base = PathBuf::from(local)
        .join("Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe");
    let mut candidates=std::fs::read_dir(base).map_err(|_|"Native sharing needs its FFmpeg 8.1 runtime. Use Install native sharing runtime in the screen picker.")?.filter_map(Result::ok).map(|e|e.path().join("bin/ffmpeg.exe")).filter(|p|p.is_file()).collect::<Vec<_>>();
    candidates.sort();
    candidates
        .pop()
          .ok_or("Native sharing needs its FFmpeg 8.1 runtime. Use Install native sharing runtime in the screen picker.".into())
}
fn command(path: &PathBuf) -> Command {
    let mut c = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c.stdin(Stdio::null());
    c
}
fn encoder_args(c: &mut Command, encoder: &str, fps: u32, rate: u32, profile: NativeH264Profile) {
    c.args([
        "-c:v",
        encoder,
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-profile:v",
        if encoder == "h264_amf" && profile == NativeH264Profile::Baseline {
            "constrained_baseline"
        } else {
            profile.ffmpeg_name()
        },
        "-bf",
        "0",
        "-g",
        &(fps * 2).to_string(),
        "-b:v",
        &format!("{rate}M"),
        "-maxrate",
        &format!("{rate}M"),
        "-bufsize",
        &format!("{}M", (rate / 2).max(1)),
    ]);
    match encoder {
        "h264_nvenc" => {
            // Measured low-bitrate quality preset; retain no B-frames/lookahead.
            c.args([
                "-preset",
                "p6",
                "-tune",
                "ll",
                "-rc",
                "cbr",
                "-rc-lookahead",
                "0",
                "-spatial-aq",
                "1",
                "-temporal-aq",
                "1",
                "-aq-strength",
                "8",
                "-multipass",
                "fullres",
                "-zerolatency",
                "1",
            ]);
        }
        "h264_amf" => {
            // Every joining receiver and recording needs SPS/PPS at an IDR.
            c.args([
                "-header_spacing",
                &(fps * 2).to_string(),
                "-forced_idr",
                "1",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
                "-aud",
                "0",
            ]);
            c.args([
                "-usage",
                "ultralowlatency",
                "-quality",
                "balanced",
                "-rc",
                "cbr",
                "-async_depth",
                "1",
            ]);
        }
        "h264_qsv" => {
            c.args(["-preset", "fast", "-look_ahead", "0"]);
        }
        _ => {
            c.args(["-preset", "veryfast", "-tune", "zerolatency"]);
        }
    }
}
fn probe() -> Capabilities {
    let path = match ffmpeg() {
        Ok(p) => p,
        Err(detail) => {
            return Capabilities {
                available: false,
                detail,
                encoders: vec![],
                version: 1,
            }
        }
    };
    let mut encoders = Vec::new();
    for (id, label) in [
        ("h264_nvenc", "NVIDIA NVENC · H.264"),
        ("h264_amf", "AMD AMF · H.264"),
        ("h264_qsv", "Intel Quick Sync · H.264"),
        ("libx264", "CPU x264 · H.264"),
    ] {
        let mut c = command(&path);
        c.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=1280x720:rate=30",
            "-frames:v",
            "2",
        ]);
        encoder_args(&mut c, id, 30, 10, NativeH264Profile::Baseline);
        c.args(["-f", "null", "-"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let available = match c.spawn() {
            Ok(mut child) => {
                let start = std::time::Instant::now();
                loop {
                    match child.try_wait() {
                        Ok(Some(s)) => break s.success(),
                        Err(_) => break false,
                        _ => {}
                    }
                    if start.elapsed() > Duration::from_secs(10) {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(_) => false,
        };
        encoders.push(Encoder {
            id: id.into(),
            label: label.into(),
            available,
            reason: if available {
                "Native encoder probe passed"
            } else {
                "Encoder or compatible driver is unavailable"
            }
            .into(),
        });
    }
    Capabilities {available:cfg!(windows)&&encoders.iter().any(|e|e.available),detail:"Windows Graphics Capture. H.264 encoder selection controls the outgoing stream. Optional system audio excludes BetterComms and requires Windows build 20348 or newer.".into(),encoders,version:1}
}
static THUMBNAIL_SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
const MAX_THUMBNAIL_BYTES: usize = 512 * 1024;
#[cfg(test)]
static LAST_THUMBNAIL_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
#[tauri::command]
pub async fn native_screen_capabilities(window: WebviewWindow) -> Result<Capabilities, String> {
    trusted(&window)?;
    // Probe again after an explicit runtime install or a driver update. A
    // process-lifetime cache would leave native sharing unavailable until the
    // app restarts after setup.
    tauri::async_runtime::spawn_blocking(probe)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn native_screen_sources(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
) -> Result<Sources, String> {
    trusted(&window)?;
    // Serialize enumeration with registry replacement. Concurrent refreshes
    // must not return IDs from one snapshot after another snapshot has already
    // replaced the opaque-ID registry.
    let mut registry = state
        .sources
        .lock()
        .map_err(|_| "Capture state unavailable")?;
    let mut sources = enumerate()?;
    reconcile_source_ids(&registry, &mut sources);
    *registry = sources.iter().map(|s| (s.id.clone(), s.clone())).collect();
    Ok(Sources { sources })
}

fn reconcile_source_ids(previous: &HashMap<String, Source>, current: &mut [Source]) {
    for source in current {
        if let Some(existing) = previous.values().find(|existing| {
            existing.kind == source.kind
                && existing.handle == source.handle
                && existing.name == source.name
        }) {
            source.id.clone_from(&existing.id);
        }
    }
}

/// Returns one in-memory 640x360 JPEG for a source from the most recent trusted
/// enumeration. Pixels are neither persisted nor exposed through a filesystem path.
#[tauri::command]
pub async fn native_screen_thumbnail(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    source_id: String,
) -> Result<tauri::ipc::Response, String> {
    trusted(&window)?;
    let source = state
        .sources
        .lock()
        .map_err(|_| "Capture state unavailable")?
        .get(&source_id)
        .cloned()
        .ok_or("Refresh sources before requesting a preview")?;
    if source.minimized {
        return Err("Restore this window before loading its preview".to_owned());
    }
    let permit =
        Arc::clone(THUMBNAIL_SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2))))
            .try_acquire_owned()
            .map_err(|_| "Two native previews are already loading")?;
    let path = ffmpeg()?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        capture_thumbnail(path, source)
    })
    .await
    .map_err(|error| format!("Native preview task failed: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn capture_thumbnail(path: PathBuf, source: Source) -> Result<Vec<u8>, String> {
    capture_thumbnail_with_timeout(path, source, Duration::from_secs(3))
}

fn capture_thumbnail_with_timeout(
    path: PathBuf,
    source: Source,
    process_timeout: Duration,
) -> Result<Vec<u8>, String> {
    let handle = if source.kind == "monitor" {
        "hmonitor"
    } else if source.kind == "window" {
        "hwnd"
    } else {
        return Err("The selected preview source is invalid".to_owned());
    };
    let input = format!(
        "gfxcapture={handle}={}:capture_cursor=0:display_border=0:max_framerate=30:width=640:height=360:resize_mode=scale_aspect:scale_mode=bilinear,hwdownload,format=bgra,format=yuvj420p",
        source.handle
    );
    let mut cmd = command(&path);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_complex",
        &input,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "5",
        "-f",
        "image2pipe",
        "pipe:1",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Could not start native preview: {error}"))?;
    #[cfg(test)]
    LAST_THUMBNAIL_PID.store(child.id(), Ordering::Release);
    if let Err(error) = crate::native_process::attach(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Native preview output is unavailable".to_owned());
        }
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut image = Vec::new();
        let mut buffer = [0_u8; 16 * 1024];
        let result = loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break Ok(image),
                Ok(count) => {
                    let remaining = (MAX_THUMBNAIL_BYTES + 1).saturating_sub(image.len());
                    image.extend_from_slice(&buffer[..count.min(remaining)]);
                }
                Err(error) => break Err(format!("Could not read native preview: {error}")),
            }
        };
        let _ = sender.send(result);
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < process_timeout => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Native preview timed out".to_owned());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not monitor native preview: {error}"));
            }
        }
    };
    let image = receiver
        .recv_timeout(Duration::from_millis(250))
        .map_err(|_| "Native preview output did not close".to_owned())??;
    if !status.success() {
        return Err("The selected source could not be previewed".to_owned());
    }
    if image.len() > MAX_THUMBNAIL_BYTES {
        return Err("Native preview exceeded its size limit".to_owned());
    }
    if !image.starts_with(&[0xff, 0xd8]) || !image.ends_with(&[0xff, 0xd9]) {
        return Err("Native preview did not produce a complete JPEG".to_owned());
    }
    Ok(image)
}

fn source_category(title: &str, executable: &str, window_class: &str) -> &'static str {
    let title = title.to_ascii_lowercase();
    let executable = executable.to_ascii_lowercase();
    let executable = executable.rsplit(['\\', '/']).next().unwrap_or(&executable);
    let window_class = window_class.to_ascii_lowercase();
    if matches!(
        executable,
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe" | "opera.exe"
    ) {
        "browser"
    } else if executable.starts_with("powertoys.")
        || matches!(
            executable,
            "explorer.exe"
                | "taskmgr.exe"
                | "cmd.exe"
                | "powershell.exe"
                | "windowsterminal.exe"
                | "textinputhost.exe"
                | "shellexperiencehost.exe"
        )
        || matches!(window_class.as_str(), "progman" | "workerw")
        || title == "windows input experience"
    {
        "utility"
    } else if executable.contains("launcher") || title.contains("launcher") {
        "app"
    } else if matches!(
        executable,
        "minecraft.exe"
            | "blender.exe"
            | "obs64.exe"
            | "unity.exe"
            | "unrealeditor.exe"
            | "valorant-win64-shipping.exe"
            | "fortniteclient-win64-shipping.exe"
            | "cs2.exe"
            | "overwatch.exe"
            | "league of legends.exe"
            | "eldenring.exe"
    ) || executable.ends_with("-win64-shipping.exe")
        || matches!(
            window_class.as_str(),
            "glfw30" | "lwjgl" | "unitywndclass" | "unrealwindow" | "sdl_app"
        )
        || [
            "minecraft",
            "roblox",
            "valorant",
            "fortnite",
            "counter-strike",
            "overwatch",
        ]
        .iter()
        .any(|term| title.contains(term))
    {
        "game"
    } else {
        "app"
    }
}

fn source_sort_rank(source: &Source) -> u8 {
    match source.category.as_str() {
        "display" => 0,
        "game" => 1,
        "browser" => 2,
        "app" => 3,
        _ => 4,
    }
}

#[cfg(windows)]
fn enumerate() -> Result<Vec<Source>, String> {
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, RECT},
            Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR},
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetWindowPlacement, GetWindowRect, GetWindowTextW,
                GetWindowThreadProcessId, IsIconic, IsWindowVisible, WINDOWPLACEMENT,
            },
        },
    };
    unsafe fn executable_name(window: HWND) -> String {
        let mut process_id = 0;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == 0 {
            return String::new();
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return String::new();
        };
        let mut path = [0_u16; 1024];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        if result.is_err() {
            String::new()
        } else {
            String::from_utf16_lossy(&path[..length as usize])
        }
    }
    unsafe fn window_class(window: HWND) -> String {
        let mut class = [0_u16; 256];
        let length = GetClassNameW(window, &mut class);
        String::from_utf16_lossy(&class[..length.max(0) as usize])
    }
    unsafe extern "system" fn monitor(h: HMONITOR, _: HDC, r: *mut RECT, p: LPARAM) -> BOOL {
        let out = &mut *(p.0 as *mut Vec<Source>);
        let rect = *r;
        out.push(Source {
            id: token().unwrap_or_default(),
            kind: "monitor".into(),
            name: format!("Display {}", out.len() + 1),
            width: (rect.right - rect.left).max(0) as u32,
            height: (rect.bottom - rect.top).max(0) as u32,
            category: "display".into(),
            minimized: false,
            handle: h.0 as usize,
        });
        BOOL(1)
    }
    unsafe extern "system" fn window(h: HWND, p: LPARAM) -> BOOL {
        if !IsWindowVisible(h).as_bool() {
            return BOOL(1);
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(h, &mut title);
        let minimized = IsIconic(h).as_bool();
        let mut r = RECT::default();
        let dimensions_available = if minimized {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            if GetWindowPlacement(h, &mut placement).is_ok() {
                r = placement.rcNormalPosition;
                true
            } else {
                false
            }
        } else {
            GetWindowRect(h, &mut r).is_ok()
        };
        if n > 0 && dimensions_available && r.right - r.left > 100 && r.bottom - r.top > 100 {
            let out = &mut *(p.0 as *mut Vec<Source>);
            let name = String::from_utf16_lossy(&title[..n as usize]);
            let executable = executable_name(h);
            let class = window_class(h);
            out.push(Source {
                id: token().unwrap_or_default(),
                kind: "window".into(),
                name: name.clone(),
                width: (r.right - r.left) as u32,
                height: (r.bottom - r.top) as u32,
                category: source_category(&name, &executable, &class).into(),
                minimized,
                handle: h.0 as usize,
            });
        }
        BOOL(1)
    }
    let mut out: Vec<Source> = Vec::new();
    unsafe {
        let param = LPARAM(&mut out as *mut _ as isize);
        let _ = EnumDisplayMonitors(None, None, Some(monitor), param);
        EnumWindows(Some(window), param).map_err(|e| e.to_string())?;
    }
    out.retain(|s| !s.id.is_empty());
    out.sort_by(|left, right| {
        source_sort_rank(left)
            .cmp(&source_sort_rank(right))
            .then_with(|| left.minimized.cmp(&right.minimized))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(out)
}
#[cfg(not(windows))]
fn enumerate() -> Result<Vec<Source>, String> {
    Err("Native screen capture is available on Windows only".into())
}

#[cfg(windows)]
async fn restore_selected_window(source: &Source) -> Result<Option<(u32, u32)>, String> {
    if source.kind != "window" {
        return Ok(None);
    }
    let handle = source.handle;
    tauri::async_runtime::spawn_blocking(move || {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{
                GetWindowRect, IsIconic, SetForegroundWindow, ShowWindowAsync, SW_RESTORE,
            },
        };
        let window = HWND(handle as *mut std::ffi::c_void);
        if unsafe { IsIconic(window).as_bool() } {
            unsafe {
                let _ = ShowWindowAsync(window, SW_RESTORE);
                let _ = SetForegroundWindow(window);
            }
            let started = Instant::now();
            while unsafe { IsIconic(window).as_bool() } {
                if started.elapsed() >= Duration::from_secs(2) {
                    return Err(
                        "Windows could not restore the selected app. Restore it and try Share again."
                            .into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe { GetWindowRect(window, &mut rect) }
            .map_err(|_| "The selected app no longer has a capturable area".to_owned())?;
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        if width <= 100 || height <= 100 {
            return Err("The selected app no longer has a capturable area".to_owned());
        }
        Ok(Some((width, height)))
    })
    .await
    .map_err(|error| format!("Could not restore the selected app: {error}"))?
}

#[cfg(not(windows))]
async fn restore_selected_window(_source: &Source) -> Result<Option<(u32, u32)>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn native_screen_start(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    source_id: String,
    encoder: String,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_mbps: u32,
    cursor: bool,
    display_border: Option<bool>,
    h264_profile: Option<NativeH264Profile>,
) -> Result<Started, String> {
    trusted(&window)?;
    if ![30, 60].contains(&fps)
        || !(5..=80).contains(&bitrate_mbps)
        || width > 3840
        || height > 2160
    {
        return Err("Choose 30/60 FPS, up to 4K and 5–80 Mbps".into());
    }
    // Revalidate at start so an installed runtime or changed GPU driver is
    // reflected without restarting the desktop app.
    let caps = tauri::async_runtime::spawn_blocking(probe)
        .await
        .map_err(|error| format!("Native encoder probe failed: {error}"))?;
    if !caps.encoders.iter().any(|e| e.id == encoder && e.available) {
        return Err("This encoder is unavailable".into());
    }
    let mut source = state
        .sources
        .lock()
        .map_err(|_| "Capture state unavailable")?
        .get(&source_id)
        .cloned()
        .ok_or("Refresh sources and select a window or display")?;
    if let Some((width, height)) = restore_selected_window(&source).await? {
        source.width = width;
        source.height = height;
        source.minimized = false;
    }
    {
        let mut slot = state
            .session
            .lock()
            .map_err(|_| "Capture state unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|session| session.stopped.load(Ordering::Acquire))
        {
            slot.take();
        }
        if slot.is_some() {
            return Err("Stop the current native screen share first".into());
        }
    }
    let w = if width == 0 {
        source.width.min(3840)
    } else {
        width
    };
    let h = if height == 0 {
        source.height.min(2160)
    } else {
        height
    };
    let w = w / 2 * 2;
    let h = h / 2 * 2;
    if w < 16 || h < 16 {
        return Err("The selected source has no capturable area".into());
    }
    let id = token()?;
    let h264_profile = h264_profile.unwrap_or(NativeH264Profile::Baseline);
    let hub = NativeScreenRtcHub::new(id.clone(), h264_profile, w, h, fps, bitrate_mbps)?;
    let ffmpeg_path = ffmpeg()?;
    let mut cmd = command(&ffmpeg_path);
    let handle = if source.kind == "monitor" {
        "hmonitor"
    } else {
        "hwnd"
    };
    let input=format!("gfxcapture={handle}={}:capture_cursor={}:display_border={}:max_framerate={fps},hwdownload,format=bgra,scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p",source.handle,u8::from(cursor),u8::from(display_border.unwrap_or(false)));
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        &input,
        "-an",
        "-r",
        &fps.to_string(),
    ]);
    encoder_args(&mut cmd, &encoder, fps, bitrate_mbps, h264_profile);
    cmd.args([
        "-level:v",
        h264_ffmpeg_level(h264_profile, w, h, fps, bitrate_mbps)?,
    ]);
    cmd.args(["-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start native capture: {e}"))?;
    if let Err(error) = crate::native_process::attach(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Encoder output unavailable".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Encoder diagnostics unavailable".into());
        }
    };
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let diagnostics_reader = diagnostics.clone();
    std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = [0_u8; 4096];
        while let Ok(count) = stderr.read(&mut bytes) {
            if count == 0 {
                break;
            }
            let mut output = diagnostics_reader
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let remaining = (16 * 1024_usize).saturating_sub(output.len());
            output.extend_from_slice(&bytes[..count.min(remaining)]);
        }
    });
    let info = Started {
        session_id: id.clone(),
        width: w,
        height: h,
        fps,
        encoder,
        h264_profile,
    };
    let session = Arc::new(Session {
        info: info.clone(),
        hub,
        child: Mutex::new(child),
        stopped: AtomicBool::new(false),
    });
    {
        let mut slot = state
            .session
            .lock()
            .map_err(|_| "Capture state unavailable")?;
        if slot.is_some() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            return Err("Another native screen share started concurrently".into());
        }
        *slot = Some(session.clone());
    }
    if let Err(error) = crate::native_screen_recording::register_session(&id, fps, ffmpeg_path) {
        session.stopped.store(true, Ordering::Release);
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut slot = state
            .session
            .lock()
            .map_err(|_| "Capture state unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|current| current.info.session_id == id)
        {
            slot.take();
        }
        return Err(error);
    }
    let worker = session.clone();
    let event_id = id.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let mut parser = AccessUnits::default();
        let mut bytes = [0u8; 65536];
        let mut ready = Some(ready_tx);
        while !worker.stopped.load(Ordering::Acquire) {
            match stdout.read(&mut bytes) {
                Ok(0) => break,
                Err(error) => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Err(format!("Could not read encoder output: {error}")));
                    }
                    break;
                }
                Ok(n) => match parser.push(&bytes[..n]) {
                    Ok(frames) => {
                        for frame in frames {
                            crate::native_screen_recording::feed_access_unit(&event_id, &frame);
                            match tauri::async_runtime::block_on(worker.hub.write_access_unit(
                                frame,
                                Duration::from_secs_f64(1.0 / fps as f64),
                            )) {
                                Ok(()) => {
                                    if let Some(tx) = ready.take() {
                                        let _ = tx.send(Ok(()));
                                    }
                                }
                                Err(error) => {
                                    if let Some(tx) = ready.take() {
                                        let _ = tx.send(Err(error));
                                    }
                                    worker.stopped.store(true, Ordering::Release);
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(tx) = ready.take() {
                            let _ = tx.send(Err(error));
                        }
                        break;
                    }
                },
            }
        }
        if let Some(tx) = ready.take() {
            let detail =
                String::from_utf8_lossy(&diagnostics.lock().unwrap_or_else(|e| e.into_inner()))
                    .trim()
                    .to_owned();
            let _ = tx.send(Err(if detail.is_empty() {
                "Native capture ended before its first frame".into()
            } else {
                format!("Native capture could not start: {detail}")
            }));
        }
        worker.stopped.store(true, Ordering::Relaxed);
        crate::native_screen_recording::capture_ended(&event_id);
        if let Ok(mut child) = worker.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        tauri::async_runtime::block_on(worker.hub.close());
        let _=window.emit("native-screen-ended",serde_json::json!({"sessionId":event_id,"reason":"Native capture ended. The source may have closed or the encoder stopped."}));
    });
    match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(info),
        outcome => {
            session.stopped.store(true, Ordering::Release);
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            session.hub.close().await;
            let mut slot = state
                .session
                .lock()
                .map_err(|_| "Capture state unavailable")?;
            if slot
                .as_ref()
                .is_some_and(|current| current.info.session_id == id)
            {
                slot.take();
            }
            match outcome {
                Ok(Ok(Err(error))) => Err(error),
                Ok(Err(_)) => Err("Native capture startup task ended unexpectedly".into()),
                Err(_) => Err("Native capture timed out waiting for its first frame".into()),
                _ => unreachable!(),
            }
        }
    }
}
fn session(state: &NativeScreenState, id: &str) -> Result<Arc<Session>, String> {
    state
        .session
        .lock()
        .map_err(|_| "Capture state unavailable")?
        .as_ref()
        .filter(|s| s.info.session_id == id && !s.stopped.load(Ordering::Acquire))
        .cloned()
        .ok_or("Native share is no longer active".into())
}
#[tauri::command]
pub async fn native_screen_stop(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    session_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    let s = {
        let mut slot = state
            .session
            .lock()
            .map_err(|_| "Capture state unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|s| s.info.session_id == session_id)
        {
            slot.take()
        } else {
            None
        }
    };
    if let Some(s) = s {
        s.stopped.store(true, Ordering::Relaxed);
        crate::native_screen_recording::capture_ended(&session_id);
        if let Ok(mut c) = s.child.lock() {
            let _ = c.kill();
        }
        s.hub.close().await;
    }
    Ok(())
}
#[tauri::command]
pub async fn native_screen_peer_offer(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    session_id: String,
    peer_id: String,
    ice_servers: Vec<NativeIceServer>,
    direct_only: bool,
) -> Result<serde_json::Value, String> {
    trusted(&window)?;
    let s = session(&state, &session_id)?;
    let offer = s.hub.create_peer(peer_id, ice_servers, direct_only).await?;
    Ok(serde_json::json!({"type":"offer","sdp":offer.sdp}))
}
#[derive(Deserialize)]
pub struct Description {
    #[serde(rename = "type")]
    kind: String,
    sdp: String,
}
#[tauri::command]
pub async fn native_screen_peer_answer(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    session_id: String,
    peer_id: String,
    description: Description,
) -> Result<(), String> {
    trusted(&window)?;
    if description.kind != "answer" {
        return Err("Expected an answer".into());
    }
    session(&state, &session_id)?
        .hub
        .set_answer(&peer_id, description.sdp)
        .await
}
#[tauri::command]
pub async fn native_screen_peer_candidate(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    session_id: String,
    peer_id: String,
    candidate: Option<NativeIceCandidate>,
) -> Result<(), String> {
    trusted(&window)?;
    if let Some(candidate) = candidate {
        session(&state, &session_id)?
            .hub
            .add_candidate(&peer_id, candidate)
            .await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn native_screen_peer_remove(
    window: WebviewWindow,
    state: tauri::State<'_, NativeScreenState>,
    session_id: String,
    peer_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    session(&state, &session_id)?
        .hub
        .remove_peer(&peer_id)
        .await
}

#[derive(Default)]
struct AccessUnits {
    buffer: Vec<u8>,
}
impl AccessUnits {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 8 * 1024 * 1024 {
            return Err("Encoder frame exceeded limit".into());
        }
        let mut boundaries = Vec::new();
        let mut i = 0;
        while i + 4 < self.buffer.len() {
            let prefix = if self.buffer[i..].starts_with(&[0, 0, 0, 1]) {
                4
            } else if self.buffer[i..].starts_with(&[0, 0, 1]) {
                3
            } else {
                i += 1;
                continue;
            };
            if self.buffer.get(i + prefix).is_some_and(|b| b & 31 == 9) {
                boundaries.push(i)
            }
            i += prefix + 1;
        }
        let mut frames = Vec::new();
        if boundaries.len() > 1 {
            let end = *boundaries.last().unwrap();
            for pair in boundaries.windows(2) {
                let frame = &self.buffer[pair[0]..pair[1]];
                // Delimiter-only units carry no picture and must not advance RTP time.
                if frame
                    .windows(4)
                    .any(|nal| nal[..3] == [0, 0, 1] && matches!(nal[3] & 31, 1..=5))
                {
                    frames.push(frame.to_vec());
                }
            }
            self.buffer.drain(..end);
        }
        Ok(frames)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_are_stable_only_for_sources_still_in_the_latest_snapshot() {
        let old = Source {
            id: "stable-id".into(),
            kind: "window".into(),
            name: "Game".into(),
            width: 1280,
            height: 720,
            category: "game".into(),
            minimized: false,
            handle: 42,
        };
        let mut previous = HashMap::new();
        previous.insert(old.id.clone(), old);
        let mut current = vec![
            Source {
                id: "new-random-id".into(),
                kind: "window".into(),
                name: "Game".into(),
                width: 1920,
                height: 1080,
                category: "game".into(),
                minimized: false,
                handle: 42,
            },
            Source {
                id: "other-id".into(),
                kind: "window".into(),
                name: "Other".into(),
                width: 800,
                height: 600,
                category: "app".into(),
                minimized: false,
                handle: 99,
            },
        ];
        reconcile_source_ids(&previous, &mut current);
        assert_eq!(current[0].id, "stable-id");
        assert_eq!(current[1].id, "other-id");
        assert_eq!(current.len(), 2);
    }

    #[test]
    fn source_categories_and_order_prioritize_graphics_then_browsers_and_apps() {
        assert_eq!(
            source_category("Minecraft 1.21", "javaw.exe", "GLFW30"),
            "game"
        );
        assert_eq!(
            source_category(
                "Minecraft Wiki",
                r"C:\Program Files\Google\Chrome\chrome.exe",
                "Chrome_WidgetWin_1"
            ),
            "browser"
        );
        assert_eq!(
            source_category("Terminal", "powershell.exe", "ConsoleWindowClass"),
            "utility"
        );
        assert_eq!(
            source_category("Editor", "code.exe", "Chrome_WidgetWin_1"),
            "app"
        );
        assert_eq!(
            source_category("Launcher", "javaw.exe", "SunAwtFrame"),
            "app"
        );

        let source = |name: &str, category: &str, minimized: bool| Source {
            id: name.into(),
            kind: "window".into(),
            name: name.into(),
            width: 1280,
            height: 720,
            category: category.into(),
            minimized,
            handle: 1,
        };
        let mut sources = vec![
            source("utility", "utility", false),
            source("browser", "browser", false),
            source("minimized-game", "game", true),
            source("game", "game", false),
            source("app", "app", false),
        ];
        sources.sort_by(|left, right| {
            source_sort_rank(left)
                .cmp(&source_sort_rank(right))
                .then_with(|| left.minimized.cmp(&right.minimized))
        });
        assert_eq!(
            sources
                .iter()
                .map(|source| source.name.as_str())
                .collect::<Vec<_>>(),
            ["game", "minimized-game", "browser", "app", "utility"]
        );
    }

    fn jpeg_dimensions(image: &[u8]) -> Option<(u16, u16)> {
        if !image.starts_with(&[0xff, 0xd8]) {
            return None;
        }
        let mut offset = 2;
        while offset + 3 < image.len() {
            if image[offset] != 0xff {
                offset += 1;
                continue;
            }
            while offset < image.len() && image[offset] == 0xff {
                offset += 1;
            }
            let marker = *image.get(offset)?;
            offset += 1;
            if marker == 0x01 || marker == 0xd8 || marker == 0xd9 || (0xd0..=0xd7).contains(&marker)
            {
                continue;
            }
            let length = usize::from(u16::from_be_bytes([
                *image.get(offset)?,
                *image.get(offset + 1)?,
            ]));
            if length < 2 || offset.checked_add(length)? > image.len() {
                return None;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                && length >= 7
            {
                let height = u16::from_be_bytes([*image.get(offset + 3)?, *image.get(offset + 4)?]);
                let width = u16::from_be_bytes([*image.get(offset + 5)?, *image.get(offset + 6)?]);
                return Some((width, height));
            }
            offset += length;
        }
        None
    }

    #[cfg(windows)]
    fn assert_process_not_active(pid: u32) -> Result<(), String> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let raw = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(raw) => raw,
            Err(_) => return Ok(()),
        };
        // SAFETY: OpenProcess returned a new owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        let mut exit_code = 0_u32;
        unsafe { GetExitCodeProcess(HANDLE(handle.as_raw_handle()), &mut exit_code) }
            .map_err(|error| format!("Could not inspect preview process: {error}"))?;
        if exit_code == 259 {
            return Err("Native preview FFmpeg remained active".to_owned());
        }
        Ok(())
    }

    #[test]
    #[ignore = "captures one real monitor frame in memory; run only with explicit approval"]
    #[cfg(windows)]
    fn real_thumbnail_is_640x360_and_reaps_ffmpeg() -> Result<(), String> {
        let source = enumerate()?
            .into_iter()
            .find(|source| source.kind == "monitor")
            .ok_or_else(|| "No visible monitor was available".to_owned())?;
        let image = capture_thumbnail(ffmpeg()?, source.clone())?;
        assert_eq!(jpeg_dimensions(&image), Some((640, 360)));
        let pid = LAST_THUMBNAIL_PID.load(Ordering::Acquire);
        if pid == 0 {
            return Err("Native preview did not report its FFmpeg process".to_owned());
        }
        assert_process_not_active(pid)?;

        let timeout = capture_thumbnail_with_timeout(ffmpeg()?, source, Duration::ZERO);
        if !timeout.is_err_and(|error| error == "Native preview timed out") {
            return Err("Native preview did not exercise its timeout path".to_owned());
        }
        let timeout_pid = LAST_THUMBNAIL_PID.load(Ordering::Acquire);
        assert_process_not_active(timeout_pid)
    }

    #[test]
    #[ignore = "creates and captures a real application window; run only with explicit approval"]
    #[cfg(windows)]
    fn real_application_window_thumbnail_is_640x360() -> Result<(), String> {
        let title = format!("Bettercomms preview fixture {}", std::process::id());
        let escaped_title = title.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName PresentationFramework; $w=New-Object Windows.Window; $w.Title='{escaped_title}'; $w.Width=720; $w.Height=420; $w.Background='Navy'; $w.Content=New-Object Windows.Controls.TextBlock -Property @{{Text='Preview fixture';Foreground='White';FontSize=48}}; $w.WindowStartupLocation='CenterScreen'; $w.ShowDialog() | Out-Null"
        );
        let mut fixture_command = Command::new("powershell.exe");
        fixture_command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        use std::os::windows::process::CommandExt;
        fixture_command.creation_flags(0x08000000);
        let mut fixture = fixture_command
            .spawn()
            .map_err(|error| format!("Could not create preview fixture window: {error}"))?;
        let result = (|| {
            let started = std::time::Instant::now();
            let source = loop {
                if let Some(source) = enumerate()?
                    .into_iter()
                    .find(|source| source.kind == "window" && source.name == title)
                {
                    break source;
                }
                if started.elapsed() >= Duration::from_secs(5) {
                    return Err("Controlled preview fixture window did not appear".to_owned());
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            let image = capture_thumbnail(ffmpeg()?, source)?;
            if jpeg_dimensions(&image) != Some((640, 360)) {
                return Err("Application preview was not a 640x360 JPEG".to_owned());
            }
            assert_process_not_active(LAST_THUMBNAIL_PID.load(Ordering::Acquire))
        })();
        let _ = fixture.kill();
        let _ = fixture.wait();
        result
    }

    #[test]
    #[ignore = "creates and minimizes a real application window; run only with explicit approval"]
    #[cfg(windows)]
    fn real_minimized_application_remains_listed_with_normal_dimensions() -> Result<(), String> {
        let title = format!("Bettercomms minimized fixture {}", std::process::id());
        let escaped_title = title.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName PresentationFramework; $w=New-Object Windows.Window; $w.Title='{escaped_title}'; $w.Width=720; $w.Height=420; $w.Background='Navy'; $w.Content=New-Object Windows.Controls.TextBlock -Property @{{Text='Preview fixture';Foreground='White';FontSize=48}}; $w.Add_Loaded({{ $w.WindowState='Minimized' }}); $w.ShowDialog() | Out-Null"
        );
        let mut fixture_command = Command::new("powershell.exe");
        fixture_command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        use std::os::windows::process::CommandExt;
        fixture_command.creation_flags(0x08000000);
        let mut fixture = fixture_command
            .spawn()
            .map_err(|error| format!("Could not create minimized fixture window: {error}"))?;
        let result = (|| {
            let started = Instant::now();
            let source = loop {
                if let Some(source) = enumerate()?
                    .into_iter()
                    .find(|source| source.kind == "window" && source.name == title)
                {
                    if !source.minimized {
                        if started.elapsed() >= Duration::from_secs(5) {
                            return Err("Fixture never entered its minimized state".to_owned());
                        }
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                    if source.width < 700 || source.height < 400 {
                        return Err(format!(
                            "Fixture lost its normal dimensions: {}x{}",
                            source.width, source.height
                        ));
                    }
                    break source;
                }
                if started.elapsed() >= Duration::from_secs(5) {
                    return Err("Minimized fixture did not appear in source enumeration".to_owned());
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            tauri::async_runtime::block_on(restore_selected_window(&source))?;
            let image = capture_thumbnail(ffmpeg()?, source)?;
            if jpeg_dimensions(&image) != Some((640, 360)) {
                return Err("Restored application preview was not a 640x360 JPEG".to_owned());
            }
            Ok(())
        })();
        let _ = fixture.kill();
        let _ = fixture.wait();
        result
    }

    #[test]
    fn access_units_survive_split_start_codes() {
        let mut p = AccessUnits::default();
        assert!(p.push(&[0, 0]).unwrap().is_empty());
        assert!(p
            .push(&[0, 1, 9, 16, 0, 0, 1, 5, 7, 8, 0, 0, 0])
            .unwrap()
            .is_empty());
        let f = p.push(&[1, 9, 16]).unwrap();
        assert_eq!(f, vec![vec![0, 0, 0, 1, 9, 16, 0, 0, 1, 5, 7, 8]]);
    }
    #[test]
    fn access_unit_memory_is_bounded() {
        assert!(AccessUnits::default()
            .push(&vec![0; 8 * 1024 * 1024 + 1])
            .is_err());
    }
    #[test]
    fn duplicate_delimiters_do_not_create_phantom_frames() {
        let frames = AccessUnits::default()
            .push(&[
                0, 0, 1, 9, 16, 0, 0, 1, 9, 16, 0, 0, 1, 5, 44, 0, 0, 1, 9, 16,
            ])
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].contains(&44));
    }
}
