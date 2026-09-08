use crate::{camera_overlay::{on_main, platform, rgba_to_bgra_scaled, OverlayPosition}, native_screen::{copilot_geometry, NativeScreenState}};
use std::{collections::HashMap, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{ipc::{InvokeBody, Request}, Manager, WebviewWindow};

#[derive(Default)]
pub struct CopilotOverlayState { items: Mutex<HashMap<String, Item>>, watching: AtomicBool }
struct Item { hwnd: isize, session: String, refreshed: Instant, anchor: (f64, f64), size: (u32, u32), corner: String }

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("Visual overlay is restricted to the app window".into()); }
    crate::media_permissions::trusted_app_origin(&window.url().map_err(|e| e.to_string())?).map(|_| ())
}

fn position(geometry: (i32, i32, u32, u32, u32, u32), size: (u32, u32), anchor: (f64, f64), corner: &str) -> Result<(i32, i32), String> {
    let (left, top, width, height, encoded_width, encoded_height) = geometry;
    if corner != "point" {
        return Ok((left + if corner.ends_with("right") { (width as i32 - size.0 as i32 - 12).max(0) } else { 12 }, top + if corner.starts_with("bottom") { (height as i32 - size.1 as i32 - 12).max(0) } else { 12 }));
    }
    let scale = (encoded_width as f64 / width as f64).min(encoded_height as f64 / height as f64);
    // Same even-dimension letterbox used by the native FFmpeg pipeline.
    let w = (width as f64 * scale / 2.).floor() * 2.;
    let h = (height as f64 * scale / 2.).floor() * 2.;
    let x = (anchor.0 * encoded_width as f64 - (encoded_width as f64 - w) / 2.) / w;
    let y = (anchor.1 * encoded_height as f64 - (encoded_height as f64 - h) / 2.) / h;
    if !(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y) { return Err("The signal points outside captured content".into()); }
    Ok((left + (x * width as f64).round() as i32 - size.0 as i32 / 2, top + (y * height as f64).round() as i32 - size.1 as i32 / 2))
}

#[cfg(windows)]
fn move_window(hwnd: isize, x: i32, y: i32, visible: bool) -> Result<(), String> {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SW_HIDE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_SHOWWINDOW}};
    if !visible { let _ = unsafe { ShowWindow(HWND(hwnd as *mut _), SW_HIDE) }; return Ok(()); }
    unsafe { SetWindowPos(HWND(hwnd as *mut _), Some(HWND_TOPMOST), x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_SHOWWINDOW) }.map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn move_window(_: isize, _: i32, _: i32, _: bool) -> Result<(), String> { Err("Windows overlay unavailable".into()) }

#[cfg(windows)]
fn require_capture_exclusion(hwnd: isize) -> Result<(), String> {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE}};
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut _), WDA_EXCLUDEFROMCAPTURE) }.map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn require_capture_exclusion(_: isize) -> Result<(), String> { Err("Windows overlay unavailable".into()) }

#[tauri::command]
pub async fn copilot_overlay_frame(window: WebviewWindow, request: Request<'_>) -> Result<(), String> {
    trusted(&window)?;
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("Missing {name}"));
    let id = header("x-copilot-id")?.to_owned();
    let session = header("x-copilot-session")?.to_owned();
    let corner = header("x-copilot-corner")?.to_owned();
    let width: u32 = header("x-copilot-width")?.parse().map_err(|_| "Invalid width")?;
    let height: u32 = header("x-copilot-height")?.parse().map_err(|_| "Invalid height")?;
    let x: f64 = header("x-copilot-x")?.parse().map_err(|_| "Invalid position")?;
    let y: f64 = header("x-copilot-y")?.parse().map_err(|_| "Invalid position")?;
    if id.len() > 64 || id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') || width == 0 || height == 0 || width > 480 || height > 360 || !x.is_finite() || !y.is_finite() || !(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y)
        || !["point", "top-left", "top-right", "bottom-left", "bottom-right"].contains(&corner.as_str()) {
        return Err("Invalid visual overlay frame".into());
    }
    let bytes = match request.body() { InvokeBody::Raw(bytes) if bytes.len() == width as usize * height as usize * 4 => bytes, _ => return Err("Invalid overlay pixels".into()) };
    let pixels = rgba_to_bgra_scaled(bytes, width, height, width, height)?;
    let ui = window.clone();
    on_main(&window, move || {
        let geometry = copilot_geometry(&ui.state::<NativeScreenState>(), &session, false)?;
        let (px, py) = position(geometry, (width, height), (x, y), &corner)?;
        let state = ui.state::<CopilotOverlayState>();
        let mut items = state.items.lock().map_err(|_| "Overlay state unavailable")?;
        if items.get(&id).is_some_and(|item| item.session != session || item.size != (width, height)) {
            if let Some(old) = items.remove(&id) { platform::destroy(old.hwnd)?; }
        }
        if !items.contains_key(&id) {
            if items.len() >= 5 { return Err("Too many visual overlays".into()); }
            let (hwnd, actual_w, actual_h) = platform::create(&ui, width, height, OverlayPosition::TopLeft, true)?;
            if actual_w != width || actual_h != height { let _ = platform::destroy(hwnd); return Err("The screen is too small for this overlay".into()); }
            if let Err(error) = require_capture_exclusion(hwnd) { let _ = platform::destroy(hwnd); return Err(error); }
            items.insert(id.clone(), Item { hwnd, session: session.clone(), refreshed: Instant::now(), anchor: (x, y), size: (width, height), corner: corner.clone() });
        }
        let item = items.get_mut(&id).ok_or("Overlay disappeared")?;
        item.refreshed = Instant::now(); item.anchor = (x, y); item.corner = corner.clone();
        let visible = corner != "point" || copilot_geometry(&ui.state::<NativeScreenState>(), &session, true).is_ok();
        let result = platform::paint(item.hwnd, width, height, &pixels, false).and_then(|_| move_window(item.hwnd, px, py, visible));
        if let Err(error) = result { if let Some(item) = items.remove(&id) { let _ = platform::destroy(item.hwnd); } return Err(error); }
        drop(items);
        if !state.watching.swap(true, Ordering::AcqRel) { watchdog(ui.clone()); }
        Ok(())
    }).await?
}

fn watchdog(window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let ui = window.clone();
            let result = on_main(&window, move || {
                let state = ui.state::<CopilotOverlayState>();
                let Ok(mut items) = state.items.lock() else { return false; };
                items.retain(|_, item| {
                    let geometry = copilot_geometry(&ui.state::<NativeScreenState>(), &item.session, false);
                    if item.refreshed.elapsed() > Duration::from_millis(1200) || geometry.is_err() { let _ = platform::destroy(item.hwnd); return false; }
                    let visible = item.corner != "point" || copilot_geometry(&ui.state::<NativeScreenState>(), &item.session, true).is_ok();
                    if let Ok((x, y)) = position(geometry.unwrap(), item.size, item.anchor, &item.corner) { let _ = move_window(item.hwnd, x, y, visible); }
                    true
                });
                let active = !items.is_empty();
                if !active { state.watching.store(false, Ordering::Release); }
                active
            }).await;
            if !matches!(result, Ok(true)) { break; }
        }
    });
}

#[tauri::command]
pub async fn copilot_overlay_clear(window: WebviewWindow) -> Result<(), String> {
    trusted(&window)?;
    let ui = window.clone();
    on_main(&window, move || {
        let state = ui.state::<CopilotOverlayState>();
        let mut items = state.items.lock().map_err(|_| "Overlay state unavailable")?;
        for (_, item) in items.drain() { let _ = platform::destroy(item.hwnd); }
        Ok(())
    }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_letterboxed_points_and_negative_monitor_origins() {
        assert_eq!(position((-1920, 0, 1920, 1080, 1280, 720), (100, 100), (0.5, 0.5), "point").unwrap(), (-1010, 490));
        assert!(position((0, 0, 800, 800, 1280, 720), (100, 100), (0.01, 0.5), "point").is_err());
        assert_eq!(position((0, 0, 800, 800, 1280, 720), (100, 100), (0.5, 0.5), "point").unwrap(), (350, 350));
    }
}
