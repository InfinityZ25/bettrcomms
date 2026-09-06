//! One authenticated, bounded audio transport per native denoiser instance.
use crate::{deepfilter_runtime::DeepFilter, media_permissions::trusted_app_origin};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tungstenite::{
    accept_hdr_with_config,
    handshake::server::{Request, Response},
    protocol::WebSocketConfig,
    Message,
};

const TIMEOUT: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(10);
static STREAMS: OnceLock<Mutex<HashMap<String, Arc<Control>>>> = OnceLock::new();
static INITIALIZE: Mutex<()> = Mutex::new(());
struct Control {
    cancelled: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
    origin: String,
}
fn streams() -> &'static Mutex<HashMap<String, Arc<Control>>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ready: bool,
    pub detail: String,
    pub adapter_name: Option<String>,
    pub frame_samples: Option<usize>,
    pub sample_rate: u32,
}
static PROBE: Mutex<Option<(Instant, Status)>> = Mutex::new(None);

fn origin(webview: &tauri::Webview) -> Result<String, String> {
    if webview.label() != "main" {
        return Err("Audio commands require the main app window.".into());
    }
    trusted_app_origin(&webview.url().map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn deepfilter_status(webview: tauri::Webview) -> Result<Status, String> {
    origin(&webview)?;
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| e.to_string())
}

pub fn status() -> Status {
    let unavailable = |detail| Status {
        ready: false,
        detail,
        adapter_name: None,
        frame_samples: None,
        sample_rate: 48_000,
    };
    if let Ok(cache) = PROBE.lock() {
        if let Some((at, result)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return result.clone();
            }
        }
    }
    // A status query must never load another model alongside an active stream.
    if streams().lock().map(|s| !s.is_empty()).unwrap_or(true) {
        if let Ok(cache) = PROBE.lock() {
            if let Some((_, result)) = cache.as_ref() {
                return result.clone();
            }
        }
        return unavailable(
            "DeepFilterNet is starting; retry once the audio stream is ready.".into(),
        );
    }
    let _guard = match INITIALIZE.lock() {
        Ok(guard) => guard,
        Err(_) => return unavailable("DeepFilterNet initialization lock failed.".into()),
    };
    // Another probe or stream may have initialized while this query waited.
    if let Ok(cache) = PROBE.lock() {
        if let Some((at, result)) = cache.as_ref() {
            let active = streams().lock().map(|s| !s.is_empty()).unwrap_or(true);
            if active || at.elapsed() < Duration::from_secs(60) {
                return result.clone();
            }
        }
    }
    match DeepFilter::load(100.0) {
        Ok(mut effect) => match effect.validate_realtime() {
            Ok(detail) => {
                let result = Status {
                    ready: true,
                    detail,
                    adapter_name: Some(effect.adapter_name.clone()),
                    frame_samples: Some(512),
                    sample_rate: 48_000,
                };
                if let Ok(mut cache) = PROBE.lock() {
                    *cache = Some((Instant::now(), result.clone()));
                }
                result
            }
            Err(error) => unavailable(error),
        },
        Err(error) => unavailable(error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    session_id: String,
    frame_samples: usize,
    sample_rate: u32,
    port: u16,
    token: String,
}
fn random_hex(count: usize) -> Result<String, String> {
    let mut bytes = vec![0; count];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
pub async fn deepfilter_stream_start(
    webview: tauri::Webview,
    attenuation_db: f32,
) -> Result<Session, String> {
    let origin = origin(&webview)?;
    if !attenuation_db.is_finite() || !(0.0..=100.0).contains(&attenuation_db) {
        return Err("Maximum attenuation must be between 0 and 100 dB.".into());
    }
    tauri::async_runtime::spawn_blocking(move || start(origin, attenuation_db))
        .await
        .map_err(|e| e.to_string())?
}

fn start(origin: String, attenuation: f32) -> Result<Session, String> {
    let session_id = random_hex(16)?;
    let token = random_hex(32)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let control = Arc::new(Control {
        cancelled: AtomicBool::new(false),
        socket: Mutex::new(None),
        origin,
    });
    {
        let mut active = streams().lock().map_err(|_| "Audio registry failed")?;
        // A call and a microphone test may coexist while one replaces its old
        // processor. The third slot allows that brief ownership overlap.
        if active.len() >= 3 {
            return Err("The three-stream DeepFilterNet limit is reached. Stop the microphone test before starting another.".into());
        }
        active.insert(session_id.clone(), control.clone());
    }
    let worker_control = control.clone();
    let worker_id = session_id.clone();
    let worker_token = token.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("bettercomms-deepfilter".into())
        .spawn(move || {
            let _ = run(
                listener,
                &worker_token,
                &worker_control,
                attenuation,
                ready_tx,
            );
            if let Ok(mut active) = streams().lock() {
                active.remove(&worker_id);
            }
        })
    {
        if let Ok(mut active) = streams().lock() {
            active.remove(&session_id);
        }
        return Err(error.to_string());
    }
    match ready_rx.recv_timeout(TIMEOUT) {
        Ok(Ok(())) => Ok(Session {
            session_id,
            frame_samples: 512,
            sample_rate: 48_000,
            port,
            token,
        }),
        result => {
            control.cancelled.store(true, Ordering::Release);
            Err(match result {
                Ok(Err(error)) => error,
                _ => "DeepFilterNet initialization timed out.".into(),
            })
        }
    }
}

#[tauri::command]
pub fn deepfilter_stream_stop(webview: tauri::Webview, session_id: String) -> Result<(), String> {
    let owner = origin(&webview)?;
    let active = streams().lock().map_err(|_| "Audio registry failed")?;
    if let Some(control) = active.get(&session_id) {
        if control.origin != owner {
            return Err("Audio session belongs to a different origin.".into());
        }
        control.cancelled.store(true, Ordering::Release);
        if let Ok(socket) = control.socket.lock() {
            if let Some(tcp) = socket.as_ref() {
                let _ = tcp.shutdown(Shutdown::Both);
            }
        }
    }
    Ok(())
}

fn run(
    listener: TcpListener,
    token: &str,
    control: &Control,
    attenuation: f32,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let initialized: Result<DeepFilter, String> = (|| {
        let _guard = INITIALIZE
            .lock()
            .map_err(|_| "DeepFilterNet initialization lock failed")?;
        if control.cancelled.load(Ordering::Acquire) {
            return Err("Audio start was cancelled.".into());
        }
        let mut effect = DeepFilter::load(attenuation)?;
        let detail = effect.validate_realtime()?;
        if let Ok(mut cache) = PROBE.lock() {
            *cache = Some((
                Instant::now(),
                Status {
                    ready: true,
                    detail,
                    adapter_name: Some(effect.adapter_name.clone()),
                    frame_samples: Some(512),
                    sample_rate: 48_000,
                },
            ));
        }
        effect.reset()?;
        Ok(effect)
    })();
    let mut effect = match initialized {
        Ok(effect) => effect,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    if control.cancelled.load(Ordering::Acquire) || ready.send(Ok(())).is_err() {
        return Ok(());
    }
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let began = Instant::now();
    let tcp = loop {
        if control.cancelled.load(Ordering::Acquire) || began.elapsed() >= IDLE {
            return Ok(());
        }
        match listener.accept() {
            Ok((tcp, peer)) if peer.ip().is_loopback() => break tcp,
            Ok((tcp, _)) => {
                let _ = tcp.shutdown(Shutdown::Both);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    drop(listener);
    *control
        .socket
        .lock()
        .map_err(|_| "Audio socket registry failed")? =
        Some(tcp.try_clone().map_err(|e| e.to_string())?);
    tcp.set_nonblocking(false).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    let mut socket = accept_hdr_with_config(
        tcp,
        |request: &Request, response: Response| {
            if request
                .headers()
                .get("origin")
                .and_then(|h| h.to_str().ok())
                == Some(control.origin.as_str())
            {
                Ok(response)
            } else {
                let mut denied = tungstenite::handshake::server::ErrorResponse::new(Some(
                    "origin denied".into(),
                ));
                *denied.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                Err(denied)
            }
        },
        Some(WebSocketConfig {
            write_buffer_size: 0,
            max_write_buffer_size: 8192,
            max_message_size: Some(4096),
            max_frame_size: Some(4096),
            ..WebSocketConfig::default()
        }),
    )
    .map_err(|e| e.to_string())?;
    match socket.read().map_err(|e| e.to_string())? {
        Message::Text(value) if valid_auth(&value, token) => (),
        _ => return Err("DeepFilterNet stream authentication failed.".into()),
    }
    socket
        .send(Message::Text(
            r#"{"type":"ready","frameSamples":512,"sampleRate":48000}"#.into(),
        ))
        .map_err(|e| e.to_string())?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|e| e.to_string())?;
    let mut last_frame = Instant::now();
    while !control.cancelled.load(Ordering::Acquire) {
        let data = match socket.read() {
            Ok(Message::Binary(data)) => data,
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => return Err("DeepFilterNet accepts binary audio frames only.".into()),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                if last_frame.elapsed() >= IDLE {
                    return Ok(());
                }
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        last_frame = Instant::now();
        let input = decode_frame(&data)?;
        let output = effect.process(&input)?;
        let bytes = output.iter().flat_map(|v| v.to_le_bytes()).collect();
        socket
            .send(Message::Binary(bytes))
            .map_err(|e| e.to_string())?;
    }
    let _ = socket.close(None);
    Ok(())
}

fn decode_frame(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() != 512 * 4 {
        return Err("DeepFilterNet requires exactly 512 float samples.".into());
    }
    let values: Vec<_> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if values.iter().any(|v| !v.is_finite() || v.abs() > 8.0) {
        return Err("DeepFilterNet input contains invalid audio samples.".into());
    }
    Ok(values)
}
fn valid_auth(value: &str, token: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Auth {
        token: String,
    }
    serde_json::from_str::<Auth>(value).is_ok_and(|auth| auth.token == token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_frame_validation() {
        assert!(decode_frame(&vec![0; 2048]).is_ok());
        assert!(decode_frame(&vec![0; 2047]).is_err());
        let mut bad = vec![0; 2048];
        bad[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode_frame(&bad).is_err());
    }
    #[test]
    fn authentication_is_explicit_and_strict() {
        assert!(valid_auth(r#"{"token":"secret"}"#, "secret"));
        assert!(!valid_auth(r#"{"token":"wrong"}"#, "secret"));
        assert!(!valid_auth(r#"{"token":"secret","extra":1}"#, "secret"));
        assert!(!valid_auth("secret", "secret"));
    }
}
