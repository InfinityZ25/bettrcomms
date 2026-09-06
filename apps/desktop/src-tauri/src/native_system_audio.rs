use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::WebviewWindow;
const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const FRAME: usize = 8;
const RING: usize = 192_000;
const READ: usize = 38_400;

#[derive(Default)]
pub struct NativeSystemAudioState {
    sessions: Mutex<HashMap<String, Session>>,
}
struct Session {
    stop: Arc<AtomicBool>,
    ring: Arc<Mutex<VecDeque<u8>>>,
    failure: Arc<Mutex<Option<String>>>,
    worker: Option<JoinHandle<()>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
impl Drop for NativeSystemAudioState {
    fn drop(&mut self) {
        if let Ok(s) = self.sessions.get_mut() {
            for v in s.values() {
                v.stop.store(true, Ordering::Release)
            }
            for (_, mut v) in s.drain() {
                if let Some(w) = v.worker.take() {
                    let _ = w.join();
                }
            }
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    available: bool,
    detail: String,
    minimum_windows_build: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    session_id: String,
    sample_rate: u32,
    channels: u16,
}
fn trusted(w: &WebviewWindow) -> Result<(), String> {
    if w.label() != "main" {
        return Err("Native system audio is restricted to the app window".into());
    }
    crate::media_permissions::trusted_app_origin(&w.url().map_err(|e| e.to_string())?)?;
    Ok(())
}
fn token() -> Result<String, String> {
    let mut b = [0; 16];
    getrandom::getrandom(&mut b).map_err(|_| "Could not allocate audio ID")?;
    Ok(b.iter().map(|v| format!("{v:02x}")).collect())
}
#[cfg(windows)]
fn build() -> Option<u32> {
    #[repr(C)]
    struct V {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        sp: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(v: *mut V) -> i32;
    }
    let mut v = V {
        size: size_of::<V>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        sp: [0; 128],
    };
    (unsafe { RtlGetVersion(&mut v) } >= 0).then_some(v.build)
}
#[cfg(not(windows))]
fn build() -> Option<u32> {
    None
}
#[tauri::command]
pub fn native_system_audio_capabilities(window: WebviewWindow) -> Result<Capabilities, String> {
    trusted(&window)?;
    let b = build();
    let available = b.is_some_and(|v| v >= 20348);
    Ok(Capabilities{available,detail:match b{Some(v)if available=>format!("Process-loopback exclusion is available (Windows build {v}); no audio was captured"),Some(v)=>format!("Windows build {v} is older than required build 20348"),None=>"Process-loopback exclusion is unavailable".into()},minimum_windows_build:20348})
}
#[tauri::command]
pub async fn native_system_audio_start(
    window: WebviewWindow,
    state: tauri::State<'_, NativeSystemAudioState>,
) -> Result<Started, String> {
    trusted(&window)?;
    if !build().is_some_and(|v| v >= 20348) {
        return Err("System audio exclusion requires Windows build 20348 or newer".into());
    }
    let permit = Arc::clone(SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2))))
        .try_acquire_owned()
        .map_err(|_| "Too many system audio sessions")?;
    let id = token()?;
    let stop = Arc::new(AtomicBool::new(false));
    let ring = Arc::new(Mutex::new(VecDeque::with_capacity(RING)));
    let failure = Arc::new(Mutex::new(None));
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let s = stop.clone();
    let r = ring.clone();
    let worker_failure = failure.clone();
    let fallback = tx.clone();
    let worker = std::thread::spawn(move || {
        if let Err(error) = platform::capture(s, r, tx) {
            if let Ok(mut slot) = worker_failure.lock() {
                *slot = Some(error.clone());
            }
            let _ = fallback.try_send(Err(error));
        }
    });
    let ready = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "System audio startup timed out".to_owned())?
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = ready {
        stop.store(true, Ordering::Release);
        let _ = worker.join();
        return Err(e);
    }
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Audio state unavailable")?;
    if sessions.len() >= 2 {
        stop.store(true, Ordering::Release);
        drop(sessions);
        let _ = worker.join();
        return Err("Too many system audio sessions".into());
    }
    sessions.insert(
        id.clone(),
        Session {
            stop,
            ring,
            failure,
            worker: Some(worker),
            _permit: permit,
        },
    );
    Ok(Started {
        session_id: id,
        sample_rate: RATE,
        channels: CHANNELS,
    })
}
#[tauri::command]
pub fn native_system_audio_read(
    window: WebviewWindow,
    state: tauri::State<'_, NativeSystemAudioState>,
    session_id: String,
) -> Result<tauri::ipc::Response, String> {
    trusted(&window)?;
    let (ring, failure, finished) = state
        .sessions
        .lock()
        .map_err(|_| "Audio state unavailable")?
        .get(&session_id)
        .map(|s| {
            (
                s.ring.clone(),
                s.failure.clone(),
                s.worker.as_ref().is_some_and(|w| w.is_finished()),
            )
        })
        .ok_or("System audio capture is no longer active")?;
    if let Some(error) = failure
        .lock()
        .map_err(|_| "Audio failure state unavailable")?
        .clone()
    {
        return Err(format!("Native system audio stopped: {error}"));
    }
    if finished {
        return Err("Native system audio stopped unexpectedly".to_owned());
    }
    let mut q = ring.lock().map_err(|_| "Audio buffer unavailable")?;
    // A delayed reader gets the newest 100 ms instead of replaying stale audio.
    let stale = q.len().saturating_sub(READ) / FRAME * FRAME;
    q.drain(..stale);
    let n = q.len().min(READ) / FRAME * FRAME;
    Ok(tauri::ipc::Response::new(q.drain(..n).collect::<Vec<u8>>()))
}
#[tauri::command]
pub async fn native_system_audio_stop(
    window: WebviewWindow,
    state: tauri::State<'_, NativeSystemAudioState>,
    session_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    let s = state
        .sessions
        .lock()
        .map_err(|_| "Audio state unavailable")?
        .remove(&session_id);
    if let Some(mut s) = s {
        s.stop.store(true, Ordering::Release);
        if let Some(w) = s.worker.take() {
            tauri::async_runtime::spawn_blocking(move || w.join())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|_| "Audio worker panicked")?;
        }
    }
    Ok(())
}
fn append(q: &Mutex<VecDeque<u8>>, b: &[u8]) {
    if let Ok(mut q) = q.lock() {
        let n = b.len() / FRAME * FRAME;
        let b = &b[..n];
        let drop = q
            .len()
            .saturating_add(n)
            .saturating_sub(RING)
            .div_ceil(FRAME)
            * FRAME;
        let drain = drop.min(q.len());
        q.drain(..drain);
        if n >= RING {
            q.clear();
            q.extend(&b[n - RING..])
        } else {
            q.extend(b)
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{mem::ManuallyDrop, ptr};
    use windows::{
        core::{implement, IUnknown, Interface, HRESULT},
        Win32::{
            Media::Audio::*,
            System::{
                Com::StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED},
                Variant::VT_BLOB,
            },
        },
    };
    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Handler {
        sender: Mutex<Option<std::sync::mpsc::SyncSender<Result<IAudioClient, String>>>>,
    }
    impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
        fn ActivateCompleted(
            &self,
            op: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let result = (|| {
                let op = op
                    .as_ref()
                    .ok_or("Audio activation returned no operation")?;
                let mut hr = HRESULT(0);
                let mut unk: Option<IUnknown> = None;
                unsafe { op.GetActivateResult(&mut hr, &mut unk) }.map_err(|e| e.to_string())?;
                hr.ok().map_err(|e| e.to_string())?;
                unk.ok_or("Audio activation returned no interface".to_owned())?
                    .cast::<IAudioClient>()
                    .map_err(|e| e.to_string())
            })();
            if let Ok(mut s) = self.sender.lock() {
                if let Some(s) = s.take() {
                    let _ = s.send(result);
                }
            }
            Ok(())
        }
    }
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    pub fn capture(
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<VecDeque<u8>>>,
        ready: std::sync::mpsc::SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| e.to_string())?;
        let _com = Com;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler = Handler {
            sender: Mutex::new(Some(tx)),
        }
        .into();
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: std::process::id(),
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        // VT_BLOB points at stack-owned activation parameters. Do not run
        // PropVariantClear: it would attempt to free memory COM did not allocate.
        let variant = ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: (&mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast(),
                        },
                    },
                }),
            },
        });
        let _op = unsafe {
            ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*variant),
                &handler,
            )
        }
        .map_err(|e| e.to_string())?;
        let client = match rx.recv_timeout(Duration::from_secs(4)) {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                let _ = ready.send(Err(e.clone()));
                return Err(e);
            }
            Err(_) => {
                let e = "System audio activation timed out".to_owned();
                let _ = ready.send(Err(e.clone()));
                return Err(e);
            }
        };
        let format = WAVEFORMATEX {
            wFormatTag: 3,
            nChannels: CHANNELS,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * FRAME as u32,
            nBlockAlign: FRAME as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0,
                0,
                &format,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        let capture: IAudioCaptureClient =
            unsafe { client.GetService() }.map_err(|e| e.to_string())?;
        unsafe { client.Start() }.map_err(|e| e.to_string())?;
        let _ = ready.send(Ok(()));
        while !stop.load(Ordering::Acquire) {
            loop {
                let frames = unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())?;
                if frames == 0 {
                    break;
                }
                let mut data = ptr::null_mut();
                let mut got = 0;
                let mut flags = 0;
                unsafe { capture.GetBuffer(&mut data, &mut got, &mut flags, None, None) }
                    .map_err(|e| e.to_string())?;
                let n = got as usize * FRAME;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    append(&ring, &vec![0; n])
                } else {
                    append(&ring, unsafe { std::slice::from_raw_parts(data, n) })
                }
                unsafe { capture.ReleaseBuffer(got) }.map_err(|e| e.to_string())?;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = unsafe { client.Stop() };
        Ok(())
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn capture(
        _: Arc<AtomicBool>,
        _: Arc<Mutex<VecDeque<u8>>>,
        ready: std::sync::mpsc::SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        let e = "Native system audio is Windows-only".to_owned();
        let _ = ready.send(Err(e.clone()));
        Err(e)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ring_is_bounded_and_aligned() {
        let q = Mutex::new(VecDeque::new());
        append(&q, &vec![7; RING + FRAME * 3]);
        let q = q.lock().unwrap();
        assert_eq!(q.len(), RING);
        assert_eq!(q.len() % FRAME, 0)
    }

    #[test]
    #[ignore = "opens the real process-loopback device; run only with explicit approval"]
    #[cfg(windows)]
    fn real_exclude_tree_capture_starts_and_stops() -> Result<(), String> {
        let stop = Arc::new(AtomicBool::new(false));
        let ring = Arc::new(Mutex::new(VecDeque::new()));
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_stop = stop.clone();
        let worker_ring = ring.clone();
        let worker =
            std::thread::spawn(move || platform::capture(worker_stop, worker_ring, sender));
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Real process-loopback startup timed out".to_owned())??;
        std::thread::sleep(Duration::from_millis(100));
        stop.store(true, Ordering::Release);
        worker
            .join()
            .map_err(|_| "Real process-loopback worker panicked".to_owned())??;
        let bytes = ring.lock().map_err(|_| "Audio ring was poisoned")?.len();
        if bytes > RING || bytes % FRAME != 0 {
            return Err("Real process-loopback ring violated its bounds".to_owned());
        }
        Ok(())
    }

    fn tone_magnitude(samples: &[f32], frequency: f32) -> f32 {
        let omega = std::f32::consts::TAU * frequency / RATE as f32;
        let (mut real, mut imaginary) = (0.0_f32, 0.0_f32);
        for (index, sample) in samples.iter().step_by(CHANNELS as usize).enumerate() {
            let phase = omega * index as f32;
            real += sample * phase.cos();
            imaginary -= sample * phase.sin();
        }
        (real.hypot(imaginary) * 2.0) / (samples.len() / CHANNELS as usize) as f32
    }

    #[test]
    #[ignore = "requires an independent sibling process playing 880 Hz"]
    #[cfg(windows)]
    fn real_exclusion_rejects_child_tone_and_keeps_external_tone() -> Result<(), String> {
        use std::{
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        let stop = Arc::new(AtomicBool::new(false));
        let ring = Arc::new(Mutex::new(VecDeque::new()));
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_stop = stop.clone();
        let worker_ring = ring.clone();
        let worker =
            std::thread::spawn(move || platform::capture(worker_stop, worker_ring, sender));
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Capture startup timed out")??;

        let base = std::path::PathBuf::from(
            std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?,
        )
        .join("Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe");
        let mut players = std::fs::read_dir(base)
            .map_err(|_| "FFplay package unavailable")?
            .filter_map(Result::ok)
            .map(|e| e.path().join("bin/ffplay.exe"))
            .filter(|p| p.is_file())
            .collect::<Vec<_>>();
        players.sort();
        let player = players.pop().ok_or("FFplay unavailable")?;
        let mut child = Command::new(player)
            .args([
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1.2",
                "-af",
                "volume=0.2",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(900));
        stop.store(true, Ordering::Release);
        let _ = child.kill();
        let _ = child.wait();
        worker.join().map_err(|_| "Capture worker panicked")??;
        let bytes = ring
            .lock()
            .map_err(|_| "Audio ring poisoned")?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let samples = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        let excluded = tone_magnitude(&samples, 440.0);
        let external = tone_magnitude(&samples, 880.0);
        if external < 0.005 {
            return Err(format!(
                "Independent 880 Hz fixture was not captured ({external:.6})"
            ));
        }
        if excluded > external * 0.15 {
            return Err(format!(
                "Excluded child 440 Hz leaked: child={excluded:.6}, external={external:.6}"
            ));
        }
        Ok(())
    }
}
