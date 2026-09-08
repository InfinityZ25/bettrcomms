//! Windows owns the complete non-client frame. The WebView stays in the client
//! rectangle: no overlay, clipping region or caption input interception.
use crate::visibility::{SizeChange, VisibilityAction, visibility_action};
use serde::Deserialize;
use std::cell::Cell;
use tauri::{Listener, Runtime, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, ICoreWebView2Controller,
    ICoreWebView2ExecuteScriptCompletedHandler,
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Dwm::{
        DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute,
    },
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GA_ROOT, GetAncestor, PostMessageW, SIZE_MINIMIZED, WM_APP, WM_NCDESTROY, WM_SIZE,
        },
    },
};
use windows_core::{BOOL, PCWSTR};

const VISIBILITY_SUBCLASS_ID: usize = 0x5258_4755;
const RESTORE_WEBVIEW_MESSAGE: u32 = WM_APP + 0x525;
const CAPTION_THEME_EVENT: &str = "better-gui:caption-theme";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptionTheme {
    background: [u8; 3],
    foreground: [u8; 3],
    dark: bool,
}

/// Register before publishing readiness so the first palette cannot race the
/// listener. The event changes only the caption of this WebView's own window.
pub(crate) fn configure<R: Runtime>(webview: &Webview<R>, background: [u8; 3], script: String) {
    let themed_webview = webview.clone();
    let theme_listener = webview.listen(CAPTION_THEME_EVENT, move |event| {
        if let Ok(theme) = serde_json::from_str::<CaptionTheme>(event.payload()) {
            apply_caption_theme(&themed_webview, theme);
        }
    });
    let cleanup_webview = webview.clone();
    webview.window().on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            cleanup_webview.unlisten(theme_listener);
        }
    });
    apply_caption_theme(
        webview,
        CaptionTheme {
            background,
            foreground: [250, 250, 249],
            dark: true,
        },
    );
    let label = webview.label().to_owned();
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller().clone();
        let Some(hwnd) = root_window(&controller) else {
            return;
        };
        let state_ptr = Box::into_raw(Box::new(VisibilityState {
            controller: controller.clone(),
            minimized: Cell::new(false),
        }));
        if !unsafe {
            SetWindowSubclass(
                hwnd,
                Some(visibility_proc),
                VISIBILITY_SUBCLASS_ID,
                state_ptr as usize,
            )
        }
        .as_bool()
        {
            unsafe { drop(Box::from_raw(state_ptr)) };
            eprintln!("better-gui: could not install visibility handler for {label}");
        }
        let result: windows_core::Result<()> = (|| unsafe {
            let core = controller.CoreWebView2()?;
            let utf16: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();
            let script = PCWSTR(utf16.as_ptr());
            core.AddScriptToExecuteOnDocumentCreated(
                script,
                None::<&ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>,
            )?;
            core.ExecuteScript(script, None::<&ICoreWebView2ExecuteScriptCompletedHandler>)?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("better-gui: could not publish native frame state for {label}: {error}");
        }
    });
}

fn color_ref(rgb: [u8; 3]) -> u32 {
    u32::from(rgb[0]) | (u32::from(rgb[1]) << 8) | (u32::from(rgb[2]) << 16)
}

fn apply_caption_theme<R: Runtime>(webview: &Webview<R>, theme: CaptionTheme) {
    let _ = webview.with_webview(move |platform| {
        let Some(hwnd) = root_window(&platform.controller()) else {
            return;
        };
        let dark = BOOL::from(theme.dark);
        let background = color_ref(theme.background);
        let foreground = color_ref(theme.foreground);
        // These attributes color a real caption, not an extended client surface.
        // Windows still owns inactive, hover and high-contrast rendering.
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                std::ptr::from_ref(&dark).cast(),
                size_of::<BOOL>() as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR,
                std::ptr::from_ref(&background).cast(),
                size_of::<u32>() as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TEXT_COLOR,
                std::ptr::from_ref(&foreground).cast(),
                size_of::<u32>() as u32,
            );
        }
    });
}

fn root_window(controller: &ICoreWebView2Controller) -> Option<HWND> {
    let mut parent = HWND::default();
    unsafe { controller.ParentWindow(&mut parent) }.ok()?;
    let root = unsafe { GetAncestor(parent, GA_ROOT) };
    (!root.0.is_null()).then_some(root)
}

struct VisibilityState {
    controller: ICoreWebView2Controller,
    minimized: Cell<bool>,
}

/// Only manages composition while minimized. All caption, sizing and mouse
/// messages follow the normal Windows procedure.
unsafe extern "system" fn visibility_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    state_ptr: usize,
) -> LRESULT {
    if message == WM_SIZE {
        let state = unsafe { &*(state_ptr as *const VisibilityState) };
        let change = if wparam.0 as u32 == SIZE_MINIMIZED {
            SizeChange::Minimized
        } else {
            SizeChange::Shown
        };
        let (minimized, action) = visibility_action(state.minimized.get(), change);
        state.minimized.set(minimized);
        match action {
            VisibilityAction::Hide => {
                let _ = unsafe { state.controller.SetIsVisible(false) };
            }
            VisibilityAction::Restore => {
                if unsafe {
                    PostMessageW(Some(hwnd), RESTORE_WEBVIEW_MESSAGE, WPARAM(0), LPARAM(0))
                }
                .is_err()
                {
                    let _ = unsafe { state.controller.SetIsVisible(true) };
                }
            }
            VisibilityAction::None => {}
        }
    } else if message == RESTORE_WEBVIEW_MESSAGE {
        let state = unsafe { &*(state_ptr as *const VisibilityState) };
        if !state.minimized.get() {
            // Wry already resized its child and controller to the client area.
            // Root bounds here would use the wrong parent coordinate space.
            let _ = unsafe { state.controller.SetIsVisible(true) };
            let _ = unsafe { state.controller.NotifyParentWindowPositionChanged() };
        }
        return LRESULT(0);
    } else if message == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(visibility_proc), subclass_id);
            drop(Box::from_raw(state_ptr as *mut VisibilityState));
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caption_palette_accepts_only_rgb_bytes_and_a_theme_flag() {
        assert!(
            serde_json::from_str::<CaptionTheme>(
                r#"{"background":[28,25,23],"foreground":[250,250,249],"dark":true}"#
            )
            .is_ok()
        );
        for invalid in [
            r#"{"background":[256,0,0],"foreground":[0,0,0],"dark":true}"#,
            r#"{"background":[0,0],"foreground":[0,0,0],"dark":true}"#,
            r#"{"background":[0,0,0],"foreground":[0,0,0],"dark":"true"}"#,
        ] {
            assert!(serde_json::from_str::<CaptionTheme>(invalid).is_err());
        }
    }
    #[test]
    fn caption_colors_use_win32_rgb_byte_order() {
        assert_eq!(color_ref([28, 25, 23]), 0x17191c);
        assert_eq!(color_ref([250, 250, 249]), 0xf9fafa);
    }
}
