use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{InvokeBody, Request},
    Manager, WebviewWindow,
};

const MAX_WIDTH: u32 = 640;
const MAX_HEIGHT: u32 = 900;
const MAX_FRAME_BYTES: usize = MAX_WIDTH as usize * MAX_HEIGHT as usize * 4;
const MAX_FPS: u8 = 24;
const MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / MAX_FPS as u64);

#[derive(Default)]
pub struct CameraOverlayState {
    overlay: Mutex<Option<Overlay>>,
    lifecycle: tokio::sync::Mutex<()>,
}
struct Overlay {
    id: String,
    hwnd: isize,
    position: OverlayPosition,
    width: u32,
    height: u32,
    click_through: bool,
    rows: u8,
    last_frame: Option<Instant>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlaySize {
    Small,
    Medium,
    Large,
}
impl OverlaySize {
    fn width(self) -> u32 {
        match self {
            Self::Small => 240,
            Self::Medium => 320,
            Self::Large => 400,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInfo {
    overlay_id: String,
    width: u32,
    height: u32,
    max_width: u32,
    max_height: u32,
    max_frame_bytes: usize,
    max_fps: u8,
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Camera overlay is restricted to the app window".into());
    }
    crate::media_permissions::trusted_app_origin(&window.url().map_err(|e| e.to_string())?)?;
    Ok(())
}
fn token() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|_| "Could not allocate overlay ID")?;
    Ok(b.iter().map(|v| format!("{v:02x}")).collect())
}
fn info(o: &Overlay) -> OverlayInfo {
    OverlayInfo {
        overlay_id: o.id.clone(),
        width: o.width,
        height: o.height,
        max_width: MAX_WIDTH,
        max_height: MAX_HEIGHT,
        max_frame_bytes: MAX_FRAME_BYTES,
        max_fps: MAX_FPS,
    }
}

#[tauri::command]
pub async fn camera_overlay_open(
    state: tauri::State<'_, CameraOverlayState>,
    window: WebviewWindow,
    position: OverlayPosition,
    size: OverlaySize,
    click_through: bool,
    rows: u8,
) -> Result<OverlayInfo, String> {
    trusted(&window)?;
    let _lifecycle = state.lifecycle.lock().await;
    validate_rows(rows)?;
    let id = token()?;
    let width = size.width();
    let height = width * 9 / 16 * rows as u32;
    let old = {
        state
            .overlay
            .lock()
            .map_err(|_| "Camera overlay state unavailable")?
            .take()
    };
    if let Some(old) = old {
        on_main(&window, move || platform::destroy(old.hwnd)).await??;
    }
    let ui_window = window.clone();
    let (hwnd, width, height) = on_main(&window, move || {
        platform::create(&ui_window, width, height, position, click_through)
    })
    .await??;
    let overlay = Overlay {
        id,
        hwnd,
        position,
        width,
        height,
        click_through,
        rows,
        last_frame: Some(Instant::now()),
    };
    let result = info(&overlay);
    *state
        .overlay
        .lock()
        .map_err(|_| "Camera overlay state unavailable")? = Some(overlay);
    start_heartbeat(window.clone(), result.overlay_id.clone());
    Ok(result)
}

#[tauri::command]
pub async fn camera_overlay_update(
    state: tauri::State<'_, CameraOverlayState>,
    window: WebviewWindow,
    overlay_id: String,
    position: Option<OverlayPosition>,
    size: Option<OverlaySize>,
    click_through: Option<bool>,
    rows: Option<u8>,
) -> Result<OverlayInfo, String> {
    trusted(&window)?;
    let _lifecycle = state.lifecycle.lock().await;
    let (hwnd, p, w, h, click) = {
        let mut guard = state
            .overlay
            .lock()
            .map_err(|_| "Camera overlay state unavailable")?;
        let o = guard.as_mut().ok_or("Camera overlay is closed")?;
        if o.id != overlay_id {
            return Err("Camera overlay grant is stale".into());
        }
        if let Some(v) = position {
            o.position = v
        }
        if let Some(v) = size {
            o.width = v.width();
        }
        if let Some(v) = rows {
            validate_rows(v)?;
            o.rows = v;
        }
        o.height = o.width * 9 / 16 * o.rows as u32;
        if let Some(v) = click_through {
            o.click_through = v
        }
        (o.hwnd, o.position, o.width, o.height, o.click_through)
    };
    let ui_window = window.clone();
    let (fitted_width, fitted_height) = on_main(&window, move || {
        platform::configure(&ui_window, hwnd, w, h, p, click)
    })
    .await??;
    let mut guard = state
        .overlay
        .lock()
        .map_err(|_| "Camera overlay state unavailable")?;
    let o = guard.as_mut().ok_or("Camera overlay is closed")?;
    if o.id != overlay_id {
        return Err("Camera overlay grant is stale".into());
    }
    o.width = fitted_width;
    o.height = fitted_height;
    Ok(info(o))
}

#[tauri::command]
pub async fn camera_overlay_frame(
    state: tauri::State<'_, CameraOverlayState>,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<(), String> {
    trusted(&window)?;
    let _lifecycle = state.lifecycle.lock().await;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("Missing {name} header"))
    };
    let id = header("x-bettercomms-overlay-id")?.to_owned();
    let width: u32 = header("x-bettercomms-frame-width")?
        .parse()
        .map_err(|_| "Invalid frame width")?;
    let height: u32 = header("x-bettercomms-frame-height")?
        .parse()
        .map_err(|_| "Invalid frame height")?;
    if width == 0 || height == 0 || width > MAX_WIDTH || height > MAX_HEIGHT {
        return Err("Camera overlay frame dimensions are unsupported".into());
    }
    let expected = width as usize * height as usize * 4;
    if expected > MAX_FRAME_BYTES {
        return Err("Camera overlay frame is too large".into());
    }
    let rgba = match request.body() {
        InvokeBody::Raw(v) if v.len() == expected => v.clone(),
        InvokeBody::Raw(_) => return Err("Camera overlay RGBA frame length is invalid".into()),
        _ => return Err("Camera overlay frames require a binary IPC body".into()),
    };
    let (hwnd, position, target_width, target_height, click, delay) = {
        let mut guard = state
            .overlay
            .lock()
            .map_err(|_| "Camera overlay state unavailable")?;
        let o = guard.as_mut().ok_or("Camera overlay is closed")?;
        if o.id != id {
            return Err("Camera overlay grant is stale".into());
        }
        if width != o.width || height != o.height {
            return Err("Camera overlay frame dimensions do not match the current layout".into());
        }
        let delay = o.last_frame.map_or(Duration::ZERO, |last| {
            MIN_FRAME_INTERVAL.saturating_sub(last.elapsed())
        });
        (
            o.hwnd,
            o.position,
            o.width,
            o.height,
            o.click_through,
            delay,
        )
    };
    // Pace early frames instead of discarding them. The frontend sends only one
    // frame at a time; keep the lifecycle grant held while waiting asynchronously.
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    if let Some(overlay) = state
        .overlay
        .lock()
        .map_err(|_| "Camera overlay state unavailable")?
        .as_mut()
    {
        overlay.last_frame = Some(Instant::now());
    }
    let bgra = rgba_to_bgra_scaled(&rgba, width, height, target_width, target_height)?;
    let target_height = (bgra.len() / 4 / target_width as usize) as u32;
    let ui_window = window.clone();
    on_main(&window, move || {
        platform::paint(
            &ui_window,
            hwnd,
            target_width,
            target_height,
            position,
            click,
            &bgra,
        )
    })
    .await??;
    Ok(())
}

fn start_heartbeat(window: WebviewWindow, overlay_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let expired = {
                let state = window.state::<CameraOverlayState>();
                let _lifecycle = state.lifecycle.lock().await;
                let mut guard = match state.overlay.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                if !guard
                    .as_ref()
                    .is_some_and(|overlay| overlay.id == overlay_id)
                {
                    return;
                }
                if !guard
                    .as_ref()
                    .and_then(|overlay| overlay.last_frame)
                    .is_some_and(|last| last.elapsed() > Duration::from_secs(5))
                {
                    None
                } else {
                    guard.take().map(|overlay| overlay.hwnd)
                }
            };
            if let Some(hwnd) = expired {
                let _ = on_main(&window, move || platform::destroy(hwnd)).await;
                return;
            }
        }
    });
}

fn validate_rows(rows: u8) -> Result<(), String> {
    if (1..=4).contains(&rows) {
        Ok(())
    } else {
        Err("Camera overlay supports one to four rows".into())
    }
}

#[tauri::command]
pub async fn camera_overlay_close(
    state: tauri::State<'_, CameraOverlayState>,
    window: WebviewWindow,
    overlay_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    let _lifecycle = state.lifecycle.lock().await;
    let o = {
        let mut g = state
            .overlay
            .lock()
            .map_err(|_| "Camera overlay state unavailable")?;
        if g.as_ref().is_some_and(|o| o.id != overlay_id) {
            return Err("Camera overlay grant is stale".into());
        }
        g.take()
    };
    if let Some(o) = o {
        on_main(&window, move || platform::destroy(o.hwnd)).await??;
    }
    Ok(())
}

async fn on_main<T: Send + 'static>(
    window: &WebviewWindow,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(task());
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "Camera overlay UI task ended unexpectedly".into())
}

fn rgba_to_bgra_scaled(
    source: &[u8],
    sw: u32,
    sh: u32,
    dw: u32,
    dh: u32,
) -> Result<Vec<u8>, String> {
    if source.len() != sw as usize * sh as usize * 4 {
        return Err("Camera overlay RGBA frame length is invalid".into());
    }
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    for y in 0..dh {
        let sy = y as u64 * sh as u64 / dh as u64;
        for x in 0..dw {
            let sx = x as u64 * sw as u64 / dw as u64;
            let si = ((sy * sw as u64 + sx) * 4) as usize;
            let di = ((y * dw + x) * 4) as usize;
            let a = source[si + 3] as u16;
            out[di] = (source[si + 2] as u16 * a / 255) as u8;
            out[di + 1] = (source[si + 1] as u16 * a / 255) as u8;
            out[di + 2] = (source[si] as u16 * a / 255) as u8;
            out[di + 3] = a as u8;
        }
    }
    Ok(out)
}

#[cfg(windows)]
mod platform {
    use super::OverlayPosition;
    use tauri::WebviewWindow;
    use windows::{
        core::w,
        Win32::{
            Foundation::{COLORREF, HWND, POINT, SIZE},
            Graphics::Gdi::{
                CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC,
                GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, AC_SRC_ALPHA,
                AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
                MONITORINFO, MONITOR_DEFAULTTONEAREST,
            },
            UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetWindowLongPtrW, SetWindowDisplayAffinity,
                SetWindowLongPtrW, SetWindowPos, UpdateLayeredWindow, GWL_EXSTYLE, HWND_TOPMOST,
                SWP_NOACTIVATE, SWP_SHOWWINDOW, ULW_ALPHA, WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED,
                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
            },
        },
    };
    fn overlay_style(click: bool) -> windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE {
        let mut style = WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
        if click {
            style |= WS_EX_TRANSPARENT;
        }
        style
    }
    fn bounds(
        main: &WebviewWindow,
        w: u32,
        h: u32,
        p: OverlayPosition,
    ) -> Result<(i32, i32), String> {
        let owner = main.hwnd().map_err(|e| e.to_string())?;
        let monitor = unsafe { MonitorFromWindow(HWND(owner.0), MONITOR_DEFAULTTONEAREST) };
        let mut i = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetMonitorInfoW(monitor, &mut i) }
            .ok()
            .map_err(|e| e.to_string())?;
        let m = 24;
        Ok(match p {
            OverlayPosition::TopLeft => (i.rcWork.left + m, i.rcWork.top + m),
            OverlayPosition::TopRight => (i.rcWork.right - w as i32 - m, i.rcWork.top + m),
            OverlayPosition::BottomLeft => (i.rcWork.left + m, i.rcWork.bottom - h as i32 - m),
            OverlayPosition::BottomRight => (
                i.rcWork.right - w as i32 - m,
                i.rcWork.bottom - h as i32 - m,
            ),
        })
    }
    fn fit(main: &WebviewWindow, w: u32, h: u32) -> Result<(u32, u32), String> {
        let owner = main.hwnd().map_err(|e| e.to_string())?;
        let monitor = unsafe { MonitorFromWindow(HWND(owner.0), MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetMonitorInfoW(monitor, &mut info) }
            .ok()
            .map_err(|e| e.to_string())?;
        let available_width = (info.rcWork.right - info.rcWork.left - 48).max(1) as u32;
        let available_height = (info.rcWork.bottom - info.rcWork.top - 48).max(1) as u32;
        if w <= available_width && h <= available_height {
            return Ok((w, h));
        }
        let scale = (available_width as f64 / w as f64).min(available_height as f64 / h as f64);
        Ok((
            (w as f64 * scale).floor().max(1.0) as u32,
            (h as f64 * scale).floor().max(1.0) as u32,
        ))
    }
    pub fn create(
        main: &WebviewWindow,
        w: u32,
        h: u32,
        p: OverlayPosition,
        click: bool,
    ) -> Result<(isize, u32, u32), String> {
        let (w, h) = fit(main, w, h)?;
        let (x, y) = bounds(main, w, h, p)?;
        let ex = overlay_style(click);
        let hwnd = unsafe {
            CreateWindowExW(
                ex,
                w!("STATIC"),
                w!(""),
                WS_POPUP,
                x,
                y,
                w as i32,
                h as i32,
                None,
                None,
                None,
                None,
            )
        }
        .map_err(|e| format!("Could not create camera overlay: {e}"))?;
        // Best effort: older Windows builds may not support exclusion. Failure
        // must not prevent the user from seeing their overlay.
        let _ = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };
        Ok((hwnd.0 as isize, w, h))
    }
    pub fn configure(
        main: &WebviewWindow,
        raw: isize,
        w: u32,
        h: u32,
        p: OverlayPosition,
        click: bool,
    ) -> Result<(u32, u32), String> {
        let (w, h) = fit(main, w, h)?;
        let hwnd = HWND(raw as *mut _);
        let (x, y) = bounds(main, w, h, p)?;
        let old = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        let style = if click {
            old | WS_EX_TRANSPARENT.0 as isize
        } else {
            old & !(WS_EX_TRANSPARENT.0 as isize)
        };
        unsafe {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                x,
                y,
                w as i32,
                h as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok((w, h))
    }
    pub fn paint(
        main: &WebviewWindow,
        raw: isize,
        w: u32,
        h: u32,
        p: OverlayPosition,
        click: bool,
        pixels: &[u8],
    ) -> Result<(), String> {
        let _ = configure(main, raw, w, h, p, click)?;
        let hwnd = HWND(raw as *mut _);
        let screen = unsafe { GetDC(None) };
        if screen.is_invalid() {
            return Err("Could not access display for camera overlay".into());
        }
        let memory = unsafe { CreateCompatibleDC(Some(screen)) };
        if memory.is_invalid() {
            unsafe { ReleaseDC(None, screen) };
            return Err("Could not create camera overlay buffer".into());
        }
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap =
            unsafe { CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) }
                .map_err(|e| e.to_string())?;
        unsafe {
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast(), pixels.len());
            let old = SelectObject(memory, bitmap.into());
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            let point = POINT { x: 0, y: 0 };
            let size = SIZE {
                cx: w as i32,
                cy: h as i32,
            };
            let result = UpdateLayeredWindow(
                hwnd,
                Some(screen),
                None,
                Some(&size),
                Some(memory),
                Some(&point),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            result.map_err(|e| e.to_string())
        }
    }
    pub fn destroy(raw: isize) -> Result<(), String> {
        unsafe { DestroyWindow(HWND(raw as *mut _)) }.map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn styles_for_test(click: bool) -> u32 {
        overlay_style(click).0
    }
}
#[cfg(not(windows))]
mod platform {
    use super::OverlayPosition;
    use tauri::WebviewWindow;
    pub fn create(
        _: &WebviewWindow,
        _: u32,
        _: u32,
        _: OverlayPosition,
        _: bool,
    ) -> Result<(isize, u32, u32), String> {
        Err("Native camera overlay is available on Windows only".into())
    }
    pub fn configure(
        _: &WebviewWindow,
        _: isize,
        _: u32,
        _: u32,
        _: OverlayPosition,
        _: bool,
    ) -> Result<(u32, u32), String> {
        Err("Native camera overlay is available on Windows only".into())
    }
    pub fn paint(
        _: &WebviewWindow,
        _: isize,
        _: u32,
        _: u32,
        _: OverlayPosition,
        _: bool,
        _: &[u8],
    ) -> Result<(), String> {
        Err("Native camera overlay is available on Windows only".into())
    }
    pub fn destroy(_: isize) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rgba_conversion_is_bounded_and_premultiplied() {
        let out = rgba_to_bgra_scaled(&[100, 50, 20, 128], 1, 1, 2, 1).unwrap();
        assert_eq!(out, [10, 25, 50, 128, 10, 25, 50, 128]);
        assert!(rgba_to_bgra_scaled(&[], 1, 1, 1, 1).is_err());
    }
    #[test]
    fn presets_stay_within_frame_bound() {
        for size in [OverlaySize::Small, OverlaySize::Medium, OverlaySize::Large] {
            assert!(size.width() <= MAX_WIDTH);
        }
    }
    #[cfg(windows)]
    #[test]
    fn native_style_is_topmost_no_activate_and_optionally_click_through() {
        use windows::Win32::UI::WindowsAndMessaging::{
            WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        };
        let base = platform::styles_for_test(false);
        for required in [
            WS_EX_LAYERED,
            WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW,
            WS_EX_TOPMOST,
        ] {
            assert_eq!(base & required.0, required.0);
        }
        assert_eq!(base & WS_EX_TRANSPARENT.0, 0);
        assert_eq!(
            platform::styles_for_test(true) & WS_EX_TRANSPARENT.0,
            WS_EX_TRANSPARENT.0
        );
    }
}
