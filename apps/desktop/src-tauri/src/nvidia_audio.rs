//! Bounded Windows adapter for the NVIDIA Audio Effects 1.x C API.
//!
//! The SDK and model are optional, are never downloaded by this module, and are
//! loaded only from an installer-written manifest in an app-private directory.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Shutdown, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tungstenite::{
    accept_hdr_with_config,
    handshake::server::{Request as WsRequest, Response as WsResponse},
    protocol::WebSocketConfig,
    Message,
};

const SAMPLE_RATE: u32 = 48_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const STATUS_PROBE_CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_FRAME_SAMPLES: usize = 960; // NVIDIA supports 10 ms or 20 ms at 48 kHz.

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaStatus {
    pub ready: bool,
    pub detail: String,
    pub sample_rate: u32,
    pub frame_samples: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaSession {
    pub session_id: String,
    pub frame_samples: u32,
    pub sample_rate: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupManifest {
    schema_version: u8,
    sdk_dll: PathBuf,
    model: PathBuf,
}

enum Request {
    Status(mpsc::SyncSender<Result<NvidiaStatus, String>>),
    Start(mpsc::SyncSender<Result<NvidiaSession, String>>),
    Process {
        session_id: String,
        samples: Vec<f32>,
        reply: mpsc::SyncSender<Result<Vec<f32>, String>>,
    },
    Stop {
        session_id: String,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
}

static WORKER: OnceLock<mpsc::SyncSender<Request>> = OnceLock::new();

const STREAM_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
struct StreamControl {
    cancelled: AtomicBool,
    frame_samples: AtomicU32,
    socket: Mutex<Option<TcpStream>>,
}

static STREAMS: OnceLock<Mutex<HashMap<String, Arc<StreamControl>>>> = OnceLock::new();
static MODEL_INITIALIZATION: OnceLock<Mutex<()>> = OnceLock::new();

struct SuccessfulProbe {
    status: NvidiaStatus,
    validated_at: Instant,
}

impl SuccessfulProbe {
    fn fresh_status(&self, now: Instant) -> Option<NvidiaStatus> {
        (now.duration_since(self.validated_at) < STATUS_PROBE_CACHE_TTL)
            .then(|| self.status.clone())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaStreamSession {
    pub session_id: String,
    pub frame_samples: u32,
    pub sample_rate: u32,
    pub port: u16,
    pub token: String,
}

fn streams() -> &'static Mutex<HashMap<String, Arc<StreamControl>>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_model_initialization<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = MODEL_INITIALIZATION
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "NVIDIA model initialization lock failed".to_owned())?;
    operation()
}

fn random_hex(byte_count: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::getrandom(&mut bytes).map_err(|_| "secure random generation failed".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Starts a frame-at-a-time transport which never crosses Tauri IPC with audio data.
/// The returned token must be the WebSocket client's first message and is deliberately
/// separate from the URL so it cannot appear in routine request logs.
#[tauri::command]
pub async fn nvidia_stream_start(
    intensity: Option<f32>,
    vad: Option<bool>,
) -> Result<NvidiaStreamSession, String> {
    let intensity = validate_intensity(intensity)?;
    tauri::async_runtime::spawn_blocking(move || start_stream(intensity, vad.unwrap_or(false)))
        .await
        .map_err(|error| format!("NVIDIA stream start task failed: {error}"))?
}

fn start_stream(intensity: f32, vad: bool) -> Result<NvidiaStreamSession, String> {
    let session_id = format!("nvafx-stream-{}", random_hex(16)?);
    let token = random_hex(32)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("could not bind NVIDIA loopback stream: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let control = Arc::new(StreamControl {
        cancelled: AtomicBool::new(false),
        frame_samples: AtomicU32::new(0),
        socket: Mutex::new(None),
    });
    {
        let mut active = streams()
            .lock()
            .map_err(|_| "NVIDIA stream registry failed")?;
        if active.len() >= 2 {
            return Err("the two-stream NVIDIA audio limit is reached".into());
        }
        active.insert(session_id.clone(), Arc::clone(&control));
    }
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread_id = session_id.clone();
    let thread_token = token.clone();
    let spawn = std::thread::Builder::new()
        .name("bettercomms-nvidia-stream".into())
        .spawn(move || {
            let result = stream_thread(listener, &thread_token, &control, ready_tx, intensity, vad);
            if let Err(error) = result {
                eprintln!("NVIDIA audio stream stopped: {error}");
            }
            if let Ok(mut active) = streams().lock() {
                active.remove(&thread_id);
            }
        });
    if let Err(error) = spawn {
        streams()
            .lock()
            .ok()
            .map(|mut active| active.remove(&session_id));
        return Err(format!("could not start NVIDIA stream worker: {error}"));
    }
    let frame_samples = ready_rx
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| "NVIDIA stream model initialization timed out".to_owned())??;
    Ok(NvidiaStreamSession {
        session_id,
        frame_samples,
        sample_rate: SAMPLE_RATE,
        port,
        token,
    })
}

#[tauri::command]
pub async fn nvidia_stream_stop(session_id: String) -> Result<(), String> {
    let control = streams()
        .lock()
        .map_err(|_| "NVIDIA stream registry failed")?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "NVIDIA audio stream is not active".to_owned())?;
    control.cancelled.store(true, Ordering::Release);
    if let Ok(socket) = control.socket.lock() {
        if let Some(socket) = socket.as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    Ok(())
}

fn stream_thread(
    listener: TcpListener,
    token: &str,
    control: &StreamControl,
    ready: mpsc::SyncSender<Result<u32, String>>,
    intensity: f32,
    vad: bool,
) -> Result<(), String> {
    // Both objects are constructed and destroyed on this dedicated thread. Model
    // initialization is serialized with readiness probes so the settings screen
    // cannot transiently load a second GPU model while this stream starts.
    let initialized = with_model_initialization(|| {
        let mut runtime = PlatformRuntime::load()?;
        let mut effect = runtime.create_effect(false, intensity, vad)?;
        let frame_samples = effect.frame_samples;
        // Warm the model before exposing the port so joining a call cannot put the
        // first real-time frame behind lazy CUDA/model initialization.
        effect.process(&vec![0.0; frame_samples as usize])?;
        control
            .frame_samples
            .store(frame_samples, Ordering::Release);
        Ok((runtime, effect, frame_samples))
    });
    let (runtime, mut effect, frame_samples) = match initialized {
        Ok(initialized) => initialized,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    // `runtime` was bound before `effect`, so Rust drops the effect first and
    // keeps its function pointers backed by the DLL for their full lifetime.
    let _ = &runtime;
    if ready.send(Ok(frame_samples)).is_err() {
        return Ok(());
    }
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let accept_started = Instant::now();
    let tcp = loop {
        if control.cancelled.load(Ordering::Acquire)
            || accept_started.elapsed() >= STREAM_IDLE_TIMEOUT
        {
            return Ok(());
        }
        match listener.accept() {
            Ok((tcp, address)) if address.ip().is_loopback() => break tcp,
            Ok((tcp, _)) => {
                let _ = tcp.shutdown(Shutdown::Both);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(format!("NVIDIA stream accept failed: {error}")),
        }
    };
    // Each session permits exactly one client. Close the listening endpoint as
    // soon as that client is accepted so later connection attempts are refused.
    drop(listener);
    *control
        .socket
        .lock()
        .map_err(|_| "NVIDIA stream socket registry failed")? = Some(
        tcp.try_clone()
            .map_err(|error| format!("could not track NVIDIA stream socket: {error}"))?,
    );
    serve_stream(tcp, token, &control.cancelled, &mut effect)
}

fn allowed_origin(origin: &str) -> bool {
    origin == crate::media_permissions::RELEASE_ORIGIN
        || matches!(
            origin,
            "http://localhost:5173"
                | "http://127.0.0.1:5173"
                | "http://tauri.localhost"
                | "tauri://localhost"
        )
}

fn stream_websocket_config() -> WebSocketConfig {
    WebSocketConfig {
        write_buffer_size: 0,
        max_write_buffer_size: 8192,
        max_message_size: Some(4096),
        max_frame_size: Some(4096),
        ..WebSocketConfig::default()
    }
}

fn configure_stream_tcp(tcp: &TcpStream) -> Result<(), String> {
    // On Windows, a socket accepted from this nonblocking listener inherits
    // nonblocking mode. Restore blocking I/O before applying bounded deadlines.
    tcp.set_nonblocking(false)
        .map_err(|error| format!("could not configure NVIDIA stream blocking I/O: {error}"))?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("could not configure NVIDIA stream latency: {error}"))?;
    tcp.set_read_timeout(Some(STREAM_HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    tcp.set_write_timeout(Some(STREAM_HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn serve_stream(
    tcp: TcpStream,
    token: &str,
    cancelled: &AtomicBool,
    effect: &mut Effect,
) -> Result<(), String> {
    configure_stream_tcp(&tcp)?;
    let config = stream_websocket_config();
    let mut socket = accept_hdr_with_config(
        tcp,
        |request: &WsRequest, response: WsResponse| {
            let valid = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .is_some_and(allowed_origin);
            if valid {
                Ok(response)
            } else {
                let mut denied = tungstenite::handshake::server::ErrorResponse::new(Some(
                    "origin denied".into(),
                ));
                *denied.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                Err(denied)
            }
        },
        Some(config),
    )
    .map_err(|error| format!("NVIDIA stream handshake failed: {error}"))?;

    match socket
        .read()
        .map_err(|error| format!("NVIDIA stream authentication failed: {error}"))?
    {
        Message::Text(value) if valid_auth_message(&value, token) => {}
        _ => {
            let _ = socket.close(None);
            return Err("NVIDIA stream authentication failed".into());
        }
    }
    socket
        .send(Message::Text(format!(
            r#"{{"type":"ready","frameSamples":{},"sampleRate":{}}}"#,
            effect.frame_samples, SAMPLE_RATE
        )))
        .map_err(|error| format!("NVIDIA stream ready message failed: {error}"))?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|error| error.to_string())?;
    let expected_bytes = effect.frame_samples as usize * 4;
    let mut last_frame = Instant::now();
    while !cancelled.load(Ordering::Acquire) {
        let bytes = match socket.read() {
            Ok(Message::Binary(bytes)) => bytes,
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => return Err("NVIDIA stream accepts binary audio frames only".into()),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if last_frame.elapsed() >= STREAM_IDLE_TIMEOUT {
                    return Ok(());
                }
                continue;
            }
            Err(error) => return Err(format!("NVIDIA stream read failed: {error}")),
        };
        last_frame = Instant::now();
        if bytes.len() != expected_bytes {
            return Err(format!(
                "NVIDIA stream requires exactly {expected_bytes} bytes per frame"
            ));
        }
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        validate_samples(&samples)?;
        let output = effect.process(&samples)?;
        let mut encoded = Vec::with_capacity(expected_bytes);
        for sample in output {
            encoded.extend_from_slice(&sample.to_le_bytes());
        }
        socket
            .send(Message::Binary(encoded))
            .map_err(|error| format!("NVIDIA stream write failed: {error}"))?;
    }
    let _ = socket.close(None);
    Ok(())
}

fn valid_auth_message(message: &str, expected_token: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Auth<'a> {
        token: &'a str,
    }
    serde_json::from_str::<Auth<'_>>(message).is_ok_and(|auth| auth.token == expected_token)
}

fn worker() -> Result<&'static mpsc::SyncSender<Request>, String> {
    if let Some(sender) = WORKER.get() {
        return Ok(sender);
    }
    let (sender, receiver) = mpsc::sync_channel(8);
    std::thread::Builder::new()
        .name("bettercomms-nvidia-afx".into())
        .spawn(move || worker_main(receiver))
        .map_err(|error| format!("could not start NVIDIA audio worker: {error}"))?;
    // Another caller can win this race. Dropping our sender then cleanly exits
    // the redundant worker because it has no remaining producers.
    let _ = WORKER.set(sender);
    WORKER
        .get()
        .ok_or_else(|| "NVIDIA audio worker initialization failed".to_owned())
}

fn round_trip<T>(
    make: impl FnOnce(mpsc::SyncSender<Result<T, String>>) -> Request,
) -> Result<T, String> {
    let (reply, response) = mpsc::sync_channel(1);
    worker()?
        .try_send(make(reply))
        .map_err(|_| "NVIDIA audio worker is busy".to_owned())?;
    response
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| "NVIDIA audio operation timed out".to_owned())?
}

#[tauri::command]
pub async fn nvidia_status() -> NvidiaStatus {
    if let Some(frame_samples) = active_stream_frame_samples() {
        return NvidiaStatus {
            ready: true,
            detail: "NVIDIA Audio Effects is processing a validated 48 kHz stream".into(),
            sample_rate: SAMPLE_RATE,
            frame_samples: Some(frame_samples),
        };
    }
    tauri::async_runtime::spawn_blocking(|| round_trip(Request::Status))
        .await
        .unwrap_or_else(|error| Err(format!("NVIDIA audio status task failed: {error}")))
        .unwrap_or_else(|detail| NvidiaStatus {
            ready: false,
            detail,
            sample_rate: SAMPLE_RATE,
            frame_samples: None,
        })
}

fn active_stream_frame_samples() -> Option<u32> {
    let active = streams().lock().ok()?;
    active.values().find_map(|control| {
        let samples = control.frame_samples.load(Ordering::Acquire);
        (samples != 0 && !control.cancelled.load(Ordering::Acquire)).then_some(samples)
    })
}

#[tauri::command]
pub async fn nvidia_start() -> Result<NvidiaSession, String> {
    tauri::async_runtime::spawn_blocking(|| round_trip(Request::Start))
        .await
        .map_err(|error| format!("NVIDIA audio start task failed: {error}"))?
}

#[tauri::command]
pub async fn nvidia_process(session_id: String, samples: Vec<f32>) -> Result<Vec<f32>, String> {
    validate_samples(&samples)?;
    tauri::async_runtime::spawn_blocking(move || {
        round_trip(|reply| Request::Process {
            session_id,
            samples,
            reply,
        })
    })
    .await
    .map_err(|error| format!("NVIDIA audio processing task failed: {error}"))?
}

fn validate_samples(samples: &[f32]) -> Result<(), String> {
    if samples.len() > MAX_FRAME_SAMPLES {
        return Err("NVIDIA audio input exceeds the maximum one-frame size".into());
    }
    if samples
        .iter()
        .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
    {
        return Err("NVIDIA audio samples must be finite values in [-1, 1]".into());
    }
    Ok(())
}

fn validate_intensity(intensity: Option<f32>) -> Result<f32, String> {
    let intensity = intensity.unwrap_or(1.0);
    if !intensity.is_finite() || !(0.0..=1.0).contains(&intensity) {
        return Err("NVIDIA denoise intensity must be a finite value in [0, 1]".into());
    }
    Ok(intensity)
}

#[tauri::command]
pub async fn nvidia_stop(session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        round_trip(|reply| Request::Stop { session_id, reply })
    })
    .await
    .map_err(|error| format!("NVIDIA audio stop task failed: {error}"))?
}

fn worker_main(receiver: mpsc::Receiver<Request>) {
    let mut runtime: Option<PlatformRuntime> = None;
    let mut successful_probe: Option<SuccessfulProbe> = None;
    let mut sessions: Vec<(String, Effect, Instant)> = Vec::with_capacity(2);
    let mut next_session = 1_u64;

    loop {
        let request = match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // A vanished WebView cannot call stop. Bound each GPU lease anyway.
                sessions.retain(|(_, _, used)| used.elapsed() < Duration::from_secs(10));
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        sessions.retain(|(_, _, used)| used.elapsed() < Duration::from_secs(10));
        match request {
            Request::Status(reply) => {
                let result = match sessions.first() {
                    Some((_, effect, _)) => Ok(NvidiaStatus {
                        ready: true,
                        detail: "NVIDIA Audio Effects is processing a validated 48 kHz session"
                            .into(),
                        sample_rate: SAMPLE_RATE,
                        frame_samples: Some(effect.frame_samples),
                    }),
                    None => status_probe(&mut runtime, &mut successful_probe),
                };
                let _ = reply.send(result);
            }
            Request::Start(reply) => {
                let result = (|| {
                    if sessions.len() >= 2 {
                        return Err("the two-session NVIDIA audio limit is reached".into());
                    }
                    let effect = with_model_initialization(|| {
                        let rt = ensure_runtime(&mut runtime)?;
                        rt.create_effect(true, 1.0, false)
                    })?;
                    let id = format!("nvafx-{next_session}");
                    next_session = next_session.wrapping_add(1);
                    let result = NvidiaSession {
                        session_id: id.clone(),
                        frame_samples: effect.frame_samples,
                        sample_rate: SAMPLE_RATE,
                    };
                    sessions.push((id, effect, Instant::now()));
                    Ok(result)
                })();
                let created_id = result
                    .as_ref()
                    .ok()
                    .map(|started| started.session_id.clone());
                if reply.send(result).is_err() {
                    // The caller timed out or its WebView vanished during model load.
                    if let Some(created_id) = created_id {
                        sessions.retain(|(id, _, _)| id != &created_id);
                    }
                }
            }
            Request::Process {
                session_id,
                samples,
                reply,
            } => {
                let result = match sessions.iter_mut().find(|(id, _, _)| id == &session_id) {
                    Some((_, effect, used)) => {
                        *used = Instant::now();
                        effect.process(&samples)
                    }
                    _ => Err("NVIDIA audio session is not active".into()),
                };
                let _ = reply.send(result);
            }
            Request::Stop { session_id, reply } => {
                let result = match sessions.iter().position(|(id, _, _)| id == &session_id) {
                    Some(index) => {
                        sessions.swap_remove(index); // Effect::drop runs on this worker thread.
                        Ok(())
                    }
                    _ => Err("NVIDIA audio session is not active".into()),
                };
                let _ = reply.send(result);
            }
        }
    }
}

fn status_probe(
    runtime: &mut Option<PlatformRuntime>,
    successful_probe: &mut Option<SuccessfulProbe>,
) -> Result<NvidiaStatus, String> {
    let now = Instant::now();
    if let Some(status) = successful_probe
        .as_ref()
        .and_then(|probe| probe.fresh_status(now))
    {
        return Ok(status);
    }
    let (status, cacheable) = with_model_initialization(|| {
        // A stream may have completed initialization while this status request
        // waited for the shared lock. Reuse that validated result instead of
        // loading another effect beside the live one.
        if let Some(frame_samples) = active_stream_frame_samples() {
            return Ok((
                NvidiaStatus {
                    ready: true,
                    detail: "NVIDIA Audio Effects is processing a validated 48 kHz stream".into(),
                    sample_rate: SAMPLE_RATE,
                    frame_samples: Some(frame_samples),
                },
                false,
            ));
        }
        let rt = ensure_runtime(runtime)?;
        let mut effect = rt.create_effect(true, 1.0, false)?;
        let silence = vec![0.0; effect.frame_samples as usize];
        effect.process(&silence)?;
        Ok((
            NvidiaStatus {
                ready: true,
                detail: "NVIDIA Audio Effects loaded and passed a 48 kHz processing probe".into(),
                sample_rate: SAMPLE_RATE,
                frame_samples: Some(effect.frame_samples),
            },
            true,
        ))
    })?;
    if cacheable {
        *successful_probe = Some(SuccessfulProbe {
            status: status.clone(),
            validated_at: Instant::now(),
        });
    }
    Ok(status)
}

fn ensure_runtime(runtime: &mut Option<PlatformRuntime>) -> Result<&mut PlatformRuntime, String> {
    if runtime.is_none() {
        *runtime = Some(PlatformRuntime::load()?);
    }
    Ok(runtime.as_mut().expect("runtime was initialized"))
}

fn manifest_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(2);
    if cfg!(debug_assertions) {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("src-tauri is nested under apps/desktop");
        candidates.push(repository.join(".local/nvidia-audio-effects/setup.json"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data).join("Bettercomms/nvidia-audio-effects/setup.json"),
        );
    }
    candidates
}

fn resolve_setup() -> Result<(PathBuf, PathBuf), String> {
    let manifest_path = manifest_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "NVIDIA Audio Effects is not installed for Bettercomms".to_owned())?;
    let root = manifest_path
        .parent()
        .ok_or_else(|| "NVIDIA setup manifest has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|_| "NVIDIA setup directory is unavailable".to_owned())?;
    let bytes = std::fs::read(&manifest_path)
        .map_err(|_| "NVIDIA setup manifest could not be read".to_owned())?;
    let manifest: SetupManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "NVIDIA setup manifest is invalid".to_owned())?;
    if manifest.schema_version != 1 {
        return Err("NVIDIA setup manifest version is unsupported".into());
    }
    let dll = trusted_file(&root, &manifest.sdk_dll, "SDK DLL")?;
    let model = trusted_file(&root, &manifest.model, "model")?;
    if dll.file_name().and_then(|name| name.to_str()) != Some("NVAudioEffects.dll") {
        return Err("NVIDIA setup SDK DLL must be named NVAudioEffects.dll".into());
    }
    Ok((dll, model))
}

fn trusted_file(root: &Path, relative: &Path, label: &str) -> Result<PathBuf, String> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "NVIDIA {label} path must be a simple relative path"
        ));
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| format!("NVIDIA {label} is missing"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(format!(
            "NVIDIA {label} is outside the app-private setup directory"
        ));
    }
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
struct PlatformRuntime;

#[cfg(not(target_os = "windows"))]
struct Effect {
    frame_samples: u32,
}

#[cfg(not(target_os = "windows"))]
impl PlatformRuntime {
    fn load() -> Result<Self, String> {
        Err("NVIDIA Audio Effects is available only on Windows".into())
    }
    fn create_effect(
        &mut self,
        _probe: bool,
        _intensity: f32,
        _vad: bool,
    ) -> Result<Effect, String> {
        unreachable!()
    }
}

#[cfg(not(target_os = "windows"))]
impl Effect {
    fn process(&mut self, _samples: &[f32]) -> Result<Vec<f32>, String> {
        unreachable!()
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use libloading::os::windows::Library;
    use std::{
        ffi::{c_char, c_void, CString},
        os::windows::ffi::OsStrExt,
        ptr,
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn AddDllDirectory(new_directory: *const u16) -> *mut c_void;
        fn RemoveDllDirectory(cookie: *mut c_void) -> i32;
    }

    struct DllDirectory(*mut c_void);

    impl Drop for DllDirectory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { RemoveDllDirectory(self.0) };
            }
        }
    }

    type Handle = *mut c_void;
    type Status = i32;
    type Create = unsafe extern "C" fn(*const c_char, *mut Handle) -> Status;
    type Destroy = unsafe extern "C" fn(Handle) -> Status;
    type SetString = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> Status;
    type SetU32 = unsafe extern "C" fn(Handle, *const c_char, u32) -> Status;
    type SetFloat = unsafe extern "C" fn(Handle, *const c_char, f32) -> Status;
    type GetU32 = unsafe extern "C" fn(Handle, *const c_char, *mut u32) -> Status;
    type Load = unsafe extern "C" fn(Handle) -> Status;
    type Run = unsafe extern "C" fn(Handle, *const *const f32, *mut *mut f32, u32, u32) -> Status;

    pub(super) struct PlatformRuntime {
        _library: Library,
        _search_directory: DllDirectory,
        model: CString,
        create: Create,
        destroy: Destroy,
        set_string: SetString,
        set_u32: SetU32,
        set_float: SetFloat,
        get_u32: GetU32,
        load: Load,
        run: Run,
    }

    pub(super) struct Effect {
        handle: Handle,
        pub(super) frame_samples: u32,
        destroy: Destroy,
        run: Run,
    }

    // The opaque SDK handle is used only on the dedicated worker thread.
    unsafe impl Send for Effect {}
    unsafe impl Send for PlatformRuntime {}

    impl PlatformRuntime {
        pub(super) fn load() -> Result<Self, String> {
            let (dll, model) = resolve_setup()?;
            // Canonicalization adds a `\\?\` prefix on Windows. NVIDIA's model
            // loader rejects that otherwise equivalent spelling.
            let model = dunce::simplified(&model);
            let model = CString::new(model.to_str().ok_or("NVIDIA model path is not UTF-8")?)
                .map_err(|_| "NVIDIA model path contains a NUL byte".to_owned())?;
            let dll_directory = dll
                .parent()
                .expect("validated SDK DLL has a parent directory");
            let wide_directory: Vec<u16> = dll_directory
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let search_directory =
                DllDirectory(unsafe { AddDllDirectory(wide_directory.as_ptr()) });
            if search_directory.0.is_null() {
                return Err("could not register the NVIDIA private runtime directory".into());
            }
            // Search the loaded DLL's directory for its private CUDA/TensorRT dependencies,
            // plus normal system directories. Current working directory is excluded.
            let library = unsafe { Library::load_with_flags(&dll, 0x0000_0100 | 0x0000_1000) }
                .map_err(|error| format!("could not load NVIDIA Audio Effects SDK: {error}"))?;
            unsafe {
                Ok(Self {
                    create: symbol(&library, b"NvAFX_CreateEffect\0")?,
                    destroy: symbol_any(&library, &[b"NvAFX_DestroyEffect\0", b"NvAFX_Destroy\0"])?,
                    set_string: symbol(&library, b"NvAFX_SetString\0")?,
                    set_u32: symbol(&library, b"NvAFX_SetU32\0")?,
                    set_float: symbol(&library, b"NvAFX_SetFloat\0")?,
                    get_u32: symbol(&library, b"NvAFX_GetU32\0")?,
                    load: symbol(&library, b"NvAFX_Load\0")?,
                    run: symbol(&library, b"NvAFX_Run\0")?,
                    _library: library,
                    _search_directory: search_directory,
                    model,
                })
            }
        }

        pub(super) fn create_effect(
            &mut self,
            _probe: bool,
            intensity: f32,
            vad: bool,
        ) -> Result<Effect, String> {
            let mut handle = ptr::null_mut();
            check(
                unsafe { (self.create)(b"denoiser\0".as_ptr().cast(), &mut handle) },
                "create effect",
            )?;
            if handle.is_null() {
                return Err("NVIDIA created a null effect handle".into());
            }
            let result = (|| {
                check(
                    unsafe {
                        (self.set_string)(
                            handle,
                            b"model_path\0".as_ptr().cast(),
                            self.model.as_ptr(),
                        )
                    },
                    "set model",
                )?;
                check(
                    unsafe { (self.set_u32)(handle, b"use_default_gpu\0".as_ptr().cast(), 1) },
                    "select GPU",
                )?;
                check(
                    unsafe {
                        (self.set_u32)(handle, b"enable_vad\0".as_ptr().cast(), u32::from(vad))
                    },
                    "configure speech-only filtering",
                )?;
                check(
                    unsafe {
                        (self.set_float)(handle, b"intensity_ratio\0".as_ptr().cast(), intensity)
                    },
                    "set denoise intensity",
                )?;
                check(unsafe { (self.load)(handle) }, "load model")?;
                let mut sample_rate = 0;
                let mut channels = 0;
                let mut frame_samples = 0;
                check(
                    unsafe {
                        (self.get_u32)(
                            handle,
                            b"input_sample_rate\0".as_ptr().cast(),
                            &mut sample_rate,
                        )
                    },
                    "query sample rate",
                )?;
                check(
                    unsafe {
                        (self.get_u32)(
                            handle,
                            b"num_input_channels\0".as_ptr().cast(),
                            &mut channels,
                        )
                    },
                    "query channels",
                )?;
                check(
                    unsafe {
                        (self.get_u32)(
                            handle,
                            b"num_input_samples_per_frame\0".as_ptr().cast(),
                            &mut frame_samples,
                        )
                    },
                    "query frame size",
                )?;
                if sample_rate != SAMPLE_RATE
                    || channels != 1
                    || !(1..=MAX_FRAME_SAMPLES as u32).contains(&frame_samples)
                {
                    return Err(format!("NVIDIA model has unsupported format: {sample_rate} Hz, {channels} channels, {frame_samples} samples"));
                }
                Ok(Effect {
                    handle,
                    frame_samples,
                    destroy: self.destroy,
                    run: self.run,
                })
            })();
            if result.is_err() {
                unsafe {
                    (self.destroy)(handle);
                }
            }
            result
        }
    }

    impl Effect {
        pub(super) fn process(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
            if samples.len() != self.frame_samples as usize {
                return Err(format!(
                    "NVIDIA audio requires exactly {} samples per frame",
                    self.frame_samples
                ));
            }
            let input = [samples.as_ptr()];
            let mut output = vec![0.0_f32; samples.len()];
            let mut outputs = [output.as_mut_ptr()];
            check(
                unsafe {
                    (self.run)(
                        self.handle,
                        input.as_ptr(),
                        outputs.as_mut_ptr(),
                        self.frame_samples,
                        1,
                    )
                },
                "process frame",
            )?;
            if output.iter().any(|sample| !sample.is_finite()) {
                return Err("NVIDIA audio produced non-finite output".into());
            }
            Ok(output)
        }
    }

    impl Drop for Effect {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    (self.destroy)(self.handle);
                }
            }
        }
    }

    unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
        library.get::<T>(name).map(|value| *value).map_err(|_| {
            format!(
                "NVIDIA SDK is missing symbol {}",
                String::from_utf8_lossy(&name[..name.len() - 1])
            )
        })
    }

    unsafe fn symbol_any<T: Copy>(library: &Library, names: &[&[u8]]) -> Result<T, String> {
        for name in names {
            if let Ok(value) = library.get::<T>(name) {
                return Ok(*value);
            }
        }
        Err("NVIDIA SDK is missing its destroy symbol".into())
    }

    fn check(status: Status, operation: &str) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "NVIDIA Audio Effects {operation} failed (status {status})"
            ))
        }
    }
}

#[cfg(target_os = "windows")]
use windows::{Effect, PlatformRuntime};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    #[test]
    fn rejects_parent_and_absolute_manifest_paths() {
        let root = std::env::temp_dir();
        assert!(trusted_file(&root, Path::new("../NVAudioEffects.dll"), "SDK DLL").is_err());
        assert!(trusted_file(&root, Path::new("C:/NVAudioEffects.dll"), "SDK DLL").is_err());
    }

    #[test]
    fn rejects_invalid_samples_before_starting_worker() {
        assert!(validate_samples(&[f32::NAN]).is_err());
        assert!(validate_samples(&[1.1]).is_err());
        assert!(validate_samples(&vec![0.0; MAX_FRAME_SAMPLES + 1]).is_err());
    }

    #[test]
    fn validates_denoise_intensity_before_starting_worker() {
        assert_eq!(validate_intensity(None).unwrap(), 1.0);
        assert_eq!(validate_intensity(Some(0.0)).unwrap(), 0.0);
        assert_eq!(validate_intensity(Some(0.5)).unwrap(), 0.5);
        assert_eq!(validate_intensity(Some(1.0)).unwrap(), 1.0);
        assert!(validate_intensity(Some(-0.01)).is_err());
        assert!(validate_intensity(Some(1.01)).is_err());
        assert!(validate_intensity(Some(f32::NAN)).is_err());
        assert!(validate_intensity(Some(f32::INFINITY)).is_err());
    }

    #[test]
    fn stream_auth_requires_the_exact_json_token() {
        assert!(valid_auth_message(r#"{"token":"secret"}"#, "secret"));
        assert!(!valid_auth_message("secret", "secret"));
        assert!(!valid_auth_message(
            r#"{"token":"secret","extra":true}"#,
            "secret"
        ));
        assert!(!valid_auth_message(r#"{"token":"other"}"#, "secret"));
    }

    #[test]
    fn stream_origins_are_an_explicit_allowlist() {
        assert!(allowed_origin("http://localhost:5173"));
        assert!(allowed_origin("http://127.0.0.1:5173"));
        assert!(allowed_origin("http://tauri.localhost"));
        assert!(allowed_origin("tauri://localhost"));
        assert!(!allowed_origin("http://localhost:5174"));
        assert!(!allowed_origin("https://example.com"));
    }

    #[test]
    fn stream_websocket_buffers_are_bounded_to_one_native_frame() {
        let config = stream_websocket_config();
        assert_eq!(config.write_buffer_size, 0);
        assert_eq!(config.max_write_buffer_size, 8192);
        assert_eq!(config.max_message_size, Some(4096));
        assert_eq!(config.max_frame_size, Some(4096));
    }

    #[test]
    fn successful_probe_cache_expires_after_the_bounded_ttl() {
        let validated_at = Instant::now();
        let probe = SuccessfulProbe {
            status: NvidiaStatus {
                ready: true,
                detail: "validated".into(),
                sample_rate: SAMPLE_RATE,
                frame_samples: Some(480),
            },
            validated_at,
        };
        assert!(probe
            .fresh_status(validated_at + STATUS_PROBE_CACHE_TTL - Duration::from_millis(1))
            .is_some());
        assert!(probe
            .fresh_status(validated_at + STATUS_PROBE_CACHE_TTL)
            .is_none());
    }

    #[test]
    fn model_initializations_are_serialized_without_gpu_access() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..4 {
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            threads.push(std::thread::spawn(move || {
                with_model_initialization(|| {
                    let current = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    maximum.fetch_max(current, AtomicOrdering::SeqCst);
                    std::thread::sleep(Duration::from_millis(10));
                    active.fetch_sub(1, AtomicOrdering::SeqCst);
                    Ok(())
                })
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(maximum.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn accepted_stream_waits_for_delayed_auth_bytes() {
        use std::io::{Read, Write};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            stream.write_all(b"a").unwrap();
        });
        let mut accepted = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        };
        configure_stream_tcp(&accepted).unwrap();
        let mut byte = [0_u8; 1];
        accepted.read_exact(&mut byte).unwrap();
        assert_eq!(byte, *b"a");
        client.join().unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires the separately installed NVIDIA SDK, model, driver, and RTX GPU"]
    fn installed_sdk_processes_configured_intensity_and_vad() {
        let mut runtime = PlatformRuntime::load().expect("installed NVIDIA SDK must load");
        for (intensity, vad) in [(0.0, false), (0.5, false), (1.0, true)] {
            let mut effect = runtime
                .create_effect(true, intensity, vad)
                .expect("installed NVIDIA SDK must accept denoiser options");
            assert!(matches!(effect.frame_samples, 480 | 960));
            let output = effect
                .process(&vec![0.0; effect.frame_samples as usize])
                .expect("configured NVIDIA SDK must process silence");
            assert_eq!(output.len(), effect.frame_samples as usize);
            assert!(output.iter().all(|sample| sample.is_finite()));
        }
    }
}
