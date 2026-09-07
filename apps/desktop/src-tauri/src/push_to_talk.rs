use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};

const LEASE: Duration = Duration::from_secs(5);
const EVENT: &str = "bc-global-push-to-talk";

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Binding {
    Keyboard { code: String },
    Mouse { button: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Input {
    Keyboard { scan: u32, extended: bool },
    Mouse(u8),
}

impl Binding {
    fn input(&self) -> Result<Input, String> {
        match self {
            Self::Mouse { button } if *button <= 4 => Ok(Input::Mouse(*button)),
            Self::Keyboard { code } => {
                // Physical DOM codes map to Windows scan codes, independent of layout.
                let (scan, extended) = match code.as_str() {
                    "Digit1" => (0x02, false), "Digit2" => (0x03, false), "Digit3" => (0x04, false),
                    "Digit4" => (0x05, false), "Digit5" => (0x06, false), "Digit6" => (0x07, false),
                    "Digit7" => (0x08, false), "Digit8" => (0x09, false), "Digit9" => (0x0a, false),
                    "Digit0" => (0x0b, false), "Minus" => (0x0c, false), "Equal" => (0x0d, false),
                    "Backspace" => (0x0e, false), "KeyQ" => (0x10, false), "KeyW" => (0x11, false),
                    "KeyE" => (0x12, false), "KeyR" => (0x13, false), "KeyT" => (0x14, false),
                    "KeyY" => (0x15, false), "KeyU" => (0x16, false), "KeyI" => (0x17, false),
                    "KeyO" => (0x18, false), "KeyP" => (0x19, false), "BracketLeft" => (0x1a, false),
                    "BracketRight" => (0x1b, false), "Enter" => (0x1c, false), "ControlLeft" => (0x1d, false),
                    "KeyA" => (0x1e, false), "KeyS" => (0x1f, false), "KeyD" => (0x20, false),
                    "KeyF" => (0x21, false), "KeyG" => (0x22, false), "KeyH" => (0x23, false),
                    "KeyJ" => (0x24, false), "KeyK" => (0x25, false), "KeyL" => (0x26, false),
                    "Semicolon" => (0x27, false), "Quote" => (0x28, false), "Backquote" => (0x29, false),
                    "ShiftLeft" => (0x2a, false), "Backslash" => (0x2b, false), "KeyZ" => (0x2c, false),
                    "KeyX" => (0x2d, false), "KeyC" => (0x2e, false), "KeyV" => (0x2f, false),
                    "KeyB" => (0x30, false), "KeyN" => (0x31, false), "KeyM" => (0x32, false),
                    "Comma" => (0x33, false), "Period" => (0x34, false), "Slash" => (0x35, false),
                    "ShiftRight" => (0x36, false), "NumpadMultiply" => (0x37, false), "AltLeft" => (0x38, false),
                    "Space" => (0x39, false), "CapsLock" => (0x3a, false),
                    "F1" => (0x3b, false), "F2" => (0x3c, false), "F3" => (0x3d, false),
                    "F4" => (0x3e, false), "F5" => (0x3f, false), "F6" => (0x40, false),
                    "F7" => (0x41, false), "F8" => (0x42, false), "F9" => (0x43, false),
                    "F10" => (0x44, false), "NumLock" => (0x45, true), "ScrollLock" => (0x46, false),
                    "Numpad7" => (0x47, false), "Numpad8" => (0x48, false), "Numpad9" => (0x49, false),
                    "NumpadSubtract" => (0x4a, false), "Numpad4" => (0x4b, false), "Numpad5" => (0x4c, false),
                    "Numpad6" => (0x4d, false), "NumpadAdd" => (0x4e, false), "Numpad1" => (0x4f, false),
                    "Numpad2" => (0x50, false), "Numpad3" => (0x51, false), "Numpad0" => (0x52, false),
                    "NumpadDecimal" => (0x53, false), "IntlBackslash" => (0x56, false),
                    "F11" => (0x57, false), "F12" => (0x58, false),
                    "ControlRight" => (0x1d, true), "AltRight" => (0x38, true),
                    "NumpadEnter" => (0x1c, true), "NumpadDivide" => (0x35, true),
                    "Home" => (0x47, true), "ArrowUp" => (0x48, true), "PageUp" => (0x49, true),
                    "ArrowLeft" => (0x4b, true), "ArrowRight" => (0x4d, true), "End" => (0x4f, true),
                    "ArrowDown" => (0x50, true), "PageDown" => (0x51, true), "Insert" => (0x52, true),
                    "Delete" => (0x53, true), "ContextMenu" => (0x5d, true),
                    _ => return Err("This key is not supported globally. Choose a letter, modifier, F1–F12, navigation key, or mouse button.".into()),
                };
                Ok(Input::Keyboard { scan, extended })
            }
            _ => Err("Choose mouse button 1 through 5".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    session_id: String,
    sequence: u32,
    pressed: bool,
    healthy: bool,
    focused: bool,
}

struct Shared {
    snapshot: Snapshot,
    heartbeat: Instant,
}

// The hook never captures characters, records inputs, or suppresses game controls.
struct InputState {
    armed: bool,
    pressed: bool,
    sequence: u32,
}
impl InputState {
    fn new(already_down: bool) -> Self {
        Self {
            armed: !already_down,
            pressed: false,
            sequence: 0,
        }
    }
    fn update(&mut self, down: bool) -> bool {
        if !down {
            self.armed = true;
        }
        let pressed = self.armed && down;
        if pressed == self.pressed {
            return false;
        }
        self.pressed = pressed;
        self.sequence = self.sequence.wrapping_add(1);
        true
    }
}

struct Session {
    id: String,
    shared: Arc<Mutex<Shared>>,
    _worker: platform::Worker,
}

#[derive(Default)]
pub struct PushToTalkState {
    session: Mutex<Option<Session>>,
    lifecycle: tokio::sync::Mutex<()>,
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Global push-to-talk is restricted to the app window".into());
    }
    crate::media_permissions::trusted_app_origin(&window.url().map_err(|e| e.to_string())?)?;
    Ok(())
}

#[derive(Serialize)]
pub struct Capabilities {
    available: bool,
    detail: &'static str,
}

#[tauri::command]
pub fn push_to_talk_capabilities(window: WebviewWindow) -> Result<Capabilities, String> {
    trusted(&window)?;
    Ok(Capabilities {
        available: cfg!(windows),
        detail: if cfg!(windows) {
            "Global keyboard and mouse push-to-talk is available during calls on Windows."
        } else {
            "Global push-to-talk is not available on this platform; use the focused-window shortcut."
        },
    })
}

#[tauri::command]
pub async fn push_to_talk_start(
    state: tauri::State<'_, PushToTalkState>,
    window: WebviewWindow,
    binding: Binding,
) -> Result<Snapshot, String> {
    trusted(&window)?;
    let input = binding.input()?;
    let _lifecycle = state.lifecycle.lock().await;
    let old = state
        .session
        .lock()
        .map_err(|_| "Global input state unavailable")?
        .take();
    drop(old);
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not allocate global input session")?;
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let snapshot = Snapshot {
        session_id: id.clone(),
        sequence: 0,
        pressed: false,
        healthy: true,
        focused: window.is_focused().unwrap_or(true),
    };
    let shared = Arc::new(Mutex::new(Shared {
        snapshot: snapshot.clone(),
        heartbeat: Instant::now(),
    }));
    let worker_shared = shared.clone();
    let worker =
        tauri::async_runtime::spawn_blocking(move || platform::start(input, worker_shared, window))
            .await
            .map_err(|_| "Global input worker failed")??;
    *state
        .session
        .lock()
        .map_err(|_| "Global input state unavailable")? = Some(Session {
        id,
        shared,
        _worker: worker,
    });
    Ok(snapshot)
}

#[tauri::command]
pub fn push_to_talk_heartbeat(
    state: tauri::State<'_, PushToTalkState>,
    window: WebviewWindow,
    session_id: String,
) -> Result<Snapshot, String> {
    trusted(&window)?;
    let sessions = state
        .session
        .lock()
        .map_err(|_| "Global input state unavailable")?;
    let session = sessions
        .as_ref()
        .filter(|session| session.id == session_id)
        .ok_or("Global input session expired")?;
    let mut shared = session
        .shared
        .lock()
        .map_err(|_| "Global input state unavailable")?;
    shared.heartbeat = Instant::now();
    Ok(shared.snapshot.clone())
}

#[tauri::command]
pub async fn push_to_talk_stop(
    state: tauri::State<'_, PushToTalkState>,
    window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    let _lifecycle = state.lifecycle.lock().await;
    let removed = {
        let mut sessions = state
            .session
            .lock()
            .map_err(|_| "Global input state unavailable")?;
        if sessions
            .as_ref()
            .is_some_and(|session| session.id == session_id)
        {
            sessions.take()
        } else {
            None
        }
    };
    drop(removed);
    Ok(())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        cell::RefCell,
        sync::mpsc,
        thread::{self, JoinHandle},
    };
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, MAPVK_VSC_TO_VK_EX},
            WindowsAndMessaging::*,
        },
    };

    const CHANGED: u32 = WM_APP + 47;
    struct HookInput {
        input: Input,
        state: InputState,
        vk: u32,
    }
    thread_local! { static INPUT: RefCell<Option<HookInput>> = const { RefCell::new(None) }; }

    pub struct Worker {
        thread_id: u32,
        thread: Option<JoinHandle<()>>,
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn change(input: Input, down: bool, vk: u32) {
        INPUT.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let Some(current) = slot.as_mut().filter(|current| current.input == input) {
                current.vk = vk;
                if current.state.update(down) {
                    unsafe {
                        let _ =
                            PostThreadMessageW(GetCurrentThreadId(), CHANGED, WPARAM(0), LPARAM(0));
                    }
                }
            }
        });
    }

    unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(
                message.0 as u32,
                WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP
            )
        {
            let key = &*(data.0 as *const KBDLLHOOKSTRUCT);
            change(
                Input::Keyboard {
                    scan: key.scanCode,
                    extended: key.flags.contains(LLKHF_EXTENDED),
                },
                matches!(message.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN),
                key.vkCode,
            );
        }
        CallNextHookEx(None, code, message, data)
    }

    unsafe extern "system" fn mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0 {
            let mouse = &*(data.0 as *const MSLLHOOKSTRUCT);
            let input = match message.0 as u32 {
                WM_LBUTTONDOWN => Some((0, true, 1)),
                WM_LBUTTONUP => Some((0, false, 1)),
                WM_MBUTTONDOWN => Some((1, true, 4)),
                WM_MBUTTONUP => Some((1, false, 4)),
                WM_RBUTTONDOWN => Some((2, true, 2)),
                WM_RBUTTONUP => Some((2, false, 2)),
                WM_XBUTTONDOWN | WM_XBUTTONUP => match mouse.mouseData >> 16 {
                    1 => Some((3, message.0 as u32 == WM_XBUTTONDOWN, 5)),
                    2 => Some((4, message.0 as u32 == WM_XBUTTONDOWN, 6)),
                    _ => None,
                },
                _ => None,
            };
            if let Some((button, down, vk)) = input {
                change(Input::Mouse(button), down, vk);
            }
        }
        CallNextHookEx(None, code, message, data)
    }

    fn publish(shared: &Arc<Mutex<Shared>>, window: &WebviewWindow, healthy: bool) {
        let focused = window.is_focused().unwrap_or(true);
        let value = INPUT.with(|slot| {
            let mut slot = slot.borrow_mut();
            let state = &mut slot.as_mut()?.state;
            if !healthy {
                state.update(false);
            }
            let mut shared = shared.lock().ok()?;
            shared.snapshot.pressed = state.pressed;
            shared.snapshot.sequence = state.sequence;
            shared.snapshot.healthy = healthy;
            shared.snapshot.focused = focused;
            Some(shared.snapshot.clone())
        });
        if trusted(window).is_ok() {
            if let Some(value) = value {
                let _ = window.emit(EVENT, value);
            }
        }
    }

    pub fn start(
        input: Input,
        shared: Arc<Mutex<Shared>>,
        window: WebviewWindow,
    ) -> Result<Worker, String> {
        let (ready, started) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("push-to-talk".into())
            .spawn(move || unsafe {
                let mut message = MSG::default();
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                let vk = match input {
                    Input::Keyboard { scan, extended } => {
                        MapVirtualKeyW(scan | if extended { 0xe000 } else { 0 }, MAPVK_VSC_TO_VK_EX)
                    }
                    Input::Mouse(button) => [1, 4, 2, 5, 6][button as usize],
                };
                INPUT.with(|slot| {
                    *slot.borrow_mut() = Some(HookInput {
                        input,
                        state: InputState::new(GetAsyncKeyState(vk as i32) < 0),
                        vk,
                    })
                });
                let module = GetModuleHandleW(None).map(|module| module.into());
                let hook = module.and_then(|module| match input {
                    Input::Keyboard { .. } => {
                        SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module), 0)
                    }
                    Input::Mouse(_) => SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), Some(module), 0),
                });
                let Ok(hook) = hook else {
                    let _ = ready.send(Err("Windows could not register global input".to_owned()));
                    return;
                };
                let timer = SetTimer(None, 0, 250, None);
                if timer == 0 {
                    let _ = UnhookWindowsHookEx(hook);
                    let _ = ready.send(Err("Global input watchdog could not start".into()));
                    return;
                }
                if ready.send(Ok(GetCurrentThreadId())).is_ok() {
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        if message.message == WM_TIMER {
                            if shared
                                .lock()
                                .map_or(true, |state| state.heartbeat.elapsed() > LEASE)
                                || trusted(&window).is_err()
                            {
                                break;
                            }
                            // Reconcile a release missed during a desktop switch. Do this outside the hook callback.
                            INPUT.with(|slot| {
                                let mut slot = slot.borrow_mut();
                                if let Some(current) = slot.as_mut() {
                                    if GetAsyncKeyState(current.vk as i32) >= 0
                                        && current.state.update(false)
                                    {
                                        let _ = PostThreadMessageW(
                                            GetCurrentThreadId(),
                                            CHANGED,
                                            WPARAM(0),
                                            LPARAM(0),
                                        );
                                    }
                                }
                            });
                        }
                        if message.message == CHANGED {
                            publish(&shared, &window, true);
                        }
                    }
                }
                let _ = KillTimer(None, timer);
                let _ = UnhookWindowsHookEx(hook);
                publish(&shared, &window, false);
                INPUT.with(|slot| *slot.borrow_mut() = None);
            })
            .map_err(|_| "Could not start global input thread")?;
        // The worker always reports registration before entering the message loop.
        match started.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(thread_id)) => Ok(Worker {
                thread_id,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err("Global input registration timed out".into()),
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub struct Worker;
    pub fn start(_: Input, _: Arc<Mutex<Shared>>, _: WebviewWindow) -> Result<Worker, String> {
        Err("Global push-to-talk requires the Windows desktop app".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initial_hold_and_repeat_never_open_until_released() {
        let mut state = InputState::new(true);
        assert!(!state.update(true));
        assert!(!state.pressed);
        assert!(!state.update(false));
        assert!(state.update(true));
        assert!(!state.update(true));
        assert_eq!(state.sequence, 1);
        assert!(state.update(false));
        assert!(!state.pressed);
        assert_eq!(state.sequence, 2);
    }
    #[test]
    fn physical_keys_distinguish_extended_and_numpad() {
        let parse = |code: &str| Binding::Keyboard { code: code.into() }.input().unwrap();
        assert_ne!(parse("ControlLeft"), parse("ControlRight"));
        assert_ne!(parse("Enter"), parse("NumpadEnter"));
        assert_ne!(parse("ArrowUp"), parse("Numpad8"));
        assert_eq!(
            parse("KeyV"),
            Input::Keyboard {
                scan: 0x2f,
                extended: false
            }
        );
    }
    #[test]
    fn invalid_bindings_and_reserved_keys_are_rejected() {
        for code in ["Escape", "Tab", "MetaLeft", "Unidentified", ""] {
            assert!(Binding::Keyboard { code: code.into() }.input().is_err());
        }
        for button in 0..=4 {
            assert_eq!(
                Binding::Mouse { button }.input().unwrap(),
                Input::Mouse(button)
            );
        }
        assert!(Binding::Mouse { button: 5 }.input().is_err());
        assert!(
            serde_json::from_str::<Binding>(r#"{"kind":"mouse","button":1,"extra":true}"#).is_err()
        );
    }
}
