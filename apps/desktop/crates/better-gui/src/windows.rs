use std::cell::Cell;
use std::ffi::c_void;

use tauri::{Runtime, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_COLOR, ICoreWebView2,
    ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, ICoreWebView2Controller,
    ICoreWebView2ExecuteScriptCompletedHandler, ICoreWebView2Settings9,
};
use webview2_com::WindowCloseRequestedEventHandler;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Dwm::{
        DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute,
    },
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetClientRect, IsZoomed, NCCALCSIZE_PARAMS, PostMessageW,
            SET_WINDOW_POS_FLAGS, SIZE_MINIMIZED, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, SetWindowPos, WM_APP, WM_CLOSE, WM_NCCALCSIZE, WM_NCDESTROY,
            WM_SIZE,
        },
    },
};
use windows_core::{BOOL, Interface, PCWSTR, Type};

use crate::visibility::{SizeChange, VisibilityAction, visibility_action};

const VISIBILITY_SUBCLASS_ID: usize = 0x5258_4755;
const RESTORE_WEBVIEW_MESSAGE: u32 = WM_APP + 0x525;

/// Largest top inset this crate will take back from the frame.
///
/// The inset an undecorated Windows 11 window carries is one or two pixels of
/// border. A real title bar is tens of pixels tall, and taking that back would
/// put the page under a caption the system is still drawing.
const MAX_RECLAIMED_TOP_INSET: i32 = 4;

const NON_CLIENT_REGION_REFRESH_SCRIPT: windows_core::PCWSTR = windows_core::w!(
    "(() => { const elements = document.querySelectorAll('.better-window-titlebar'); for (const element of elements) { element.style.setProperty('app-region', 'no-drag'); element.style.setProperty('-webkit-app-region', 'no-drag'); } requestAnimationFrame(() => requestAnimationFrame(() => { for (const element of elements) { element.style.removeProperty('app-region'); element.style.removeProperty('-webkit-app-region'); } })); })();"
);

/// Turns "did WebView2 give us the native overlay?" into the script that tells
/// the page who draws the window buttons, or into `None` when there is nothing
/// new to say — which is what a plain scale-factor refresh wants.
pub(crate) type OverlayReadyScript = Box<dyn Fn(bool) -> Option<String> + Send + 'static>;

// Generated bindings do not expose this experimental API yet. These definitions
// mirror WebView2Experimental.idl from Microsoft.Web.WebView2 1.0.4126-prerelease.
windows_core::imp::define_interface!(
    ICoreWebView2Experimental31,
    ICoreWebView2Experimental31_Vtbl,
    0xe68b6e14_da59_5e50_aa3e_0a190d1f04d3
);
windows_core::imp::interface_hierarchy!(ICoreWebView2Experimental31, windows_core::IUnknown);

impl ICoreWebView2Experimental31 {
    unsafe fn window_controls_overlay(
        &self,
    ) -> windows_core::Result<ICoreWebView2ExperimentalWindowControlsOverlay> {
        unsafe {
            let mut result = std::mem::zeroed();
            (Interface::vtable(self).window_controls_overlay)(Interface::as_raw(self), &mut result)
                .and_then(|| Type::from_abi(result))
        }
    }
}

#[repr(C)]
#[doc(hidden)]
pub struct ICoreWebView2Experimental31_Vtbl {
    base__: windows_core::IUnknown_Vtbl,
    window_controls_overlay:
        unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> windows_core::HRESULT,
}

windows_core::imp::define_interface!(
    ICoreWebView2ExperimentalWindowControlsOverlay,
    ICoreWebView2ExperimentalWindowControlsOverlay_Vtbl,
    0x69854fbf_8515_58cd_881c_49db610c8fbe
);
windows_core::imp::interface_hierarchy!(
    ICoreWebView2ExperimentalWindowControlsOverlay,
    windows_core::IUnknown
);

impl ICoreWebView2ExperimentalWindowControlsOverlay {
    unsafe fn set_background_color(&self, value: COREWEBVIEW2_COLOR) -> windows_core::Result<()> {
        unsafe {
            (Interface::vtable(self).set_background_color)(Interface::as_raw(self), value).ok()
        }
    }

    unsafe fn set_height(&self, value: u32) -> windows_core::Result<()> {
        unsafe { (Interface::vtable(self).set_height)(Interface::as_raw(self), value).ok() }
    }

    unsafe fn set_is_enabled(&self, value: bool) -> windows_core::Result<()> {
        unsafe {
            (Interface::vtable(self).set_is_enabled)(Interface::as_raw(self), value.into()).ok()
        }
    }
}

#[repr(C)]
#[doc(hidden)]
pub struct ICoreWebView2ExperimentalWindowControlsOverlay_Vtbl {
    base__: windows_core::IUnknown_Vtbl,
    background_color:
        unsafe extern "system" fn(*mut c_void, *mut COREWEBVIEW2_COLOR) -> windows_core::HRESULT,
    set_background_color:
        unsafe extern "system" fn(*mut c_void, COREWEBVIEW2_COLOR) -> windows_core::HRESULT,
    height: unsafe extern "system" fn(*mut c_void, *mut u32) -> windows_core::HRESULT,
    set_height: unsafe extern "system" fn(*mut c_void, u32) -> windows_core::HRESULT,
    is_enabled:
        unsafe extern "system" fn(*mut c_void, *mut windows_core::BOOL) -> windows_core::HRESULT,
    set_is_enabled:
        unsafe extern "system" fn(*mut c_void, windows_core::BOOL) -> windows_core::HRESULT,
}

/// Enables the native caption buttons over the page.
///
/// `button_height` is what WebView2 is asked for. The band it paints is one
/// pixel taller, because it draws its own top border above the button; the
/// caller has already taken that pixel off.
pub(crate) fn configure_window_controls_overlay<R: Runtime>(
    webview: &Webview<R>,
    button_height: u32,
    background: [u8; 3],
    on_ready: Option<OverlayReadyScript>,
) {
    let label = webview.label().to_owned();
    let callback_label = label.clone();
    let scheduled = webview.with_webview(move |platform_webview| {
        let overlay: windows_core::Result<ICoreWebView2> = (|| unsafe {
            let core_webview = platform_webview.controller().CoreWebView2()?;
            let experimental = core_webview.cast::<ICoreWebView2Experimental31>()?;
            let overlay = experimental.window_controls_overlay()?;

            overlay.set_background_color(COREWEBVIEW2_COLOR {
                A: 255,
                R: background[0],
                G: background[1],
                B: background[2],
            })?;
            overlay.set_height(button_height)?;
            overlay.set_is_enabled(true)?;

            let settings = core_webview.Settings()?;
            let settings9 = settings.cast::<ICoreWebView2Settings9>()?;
            settings9.SetIsNonClientRegionSupportEnabled(true)?;

            Ok(core_webview)
        })();

        // Un runtime de WebView2 sin la API experimental no es un fallo del
        // host. La barra pasa a dibujar sus propios botones y la ventana sigue
        // siendo usable, asi que esto se reporta y se sigue.
        let is_native = match &overlay {
            Ok(_) => true,
            Err(error) => {
                eprintln!(
                    "better-gui: WebView2 Window Controls Overlay is unavailable for webview {callback_label}: {error}"
                );
                false
            }
        };

        let Some(on_ready) = on_ready else {
            return;
        };
        let Some(script) = on_ready(is_native) else {
            return;
        };

        // Incluso sin overlay hace falta el CoreWebView2 para contarle a la
        // pagina que le toca dibujar los botones ella misma.
        let core_webview = match overlay {
            Ok(core_webview) => Some(core_webview),
            Err(_) => unsafe { platform_webview.controller().CoreWebView2() }.ok(),
        };
        let Some(core_webview) = core_webview else {
            eprintln!("better-gui: could not reach CoreWebView2 for webview {callback_label}");
            return;
        };

        if is_native {
            forward_overlay_close_to_the_window(
                &core_webview,
                &platform_webview.controller(),
                &callback_label,
            );
        }

        if let Err(error) = unsafe { install_ready_script(&core_webview, &script) } {
            eprintln!(
                "better-gui: could not publish the window controls state to webview {callback_label}: {error}"
            );
        }
    });

    if let Err(error) = scheduled {
        eprintln!(
            "better-gui: could not schedule Window Controls Overlay setup for webview {label}: {error}"
        );
    }
}

/// WebView2 paints the overlay's close button but does not act on it: without
/// this the system close button is inert.
fn forward_overlay_close_to_the_window(
    core_webview: &ICoreWebView2,
    controller: &ICoreWebView2Controller,
    label: &str,
) {
    let Some(hwnd) = root_window(controller, label) else {
        return;
    };

    let close_hwnd = hwnd.0 as usize;
    let close_requested =
        WindowCloseRequestedEventHandler::create(Box::new(move |_sender, _args| {
            let hwnd = HWND(close_hwnd as *mut c_void);
            unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }?;
            Ok(())
        }));
    let mut token = 0;

    if let Err(error) =
        unsafe { core_webview.add_WindowCloseRequested(&close_requested, &mut token) }
    {
        eprintln!(
            "better-gui: the native close button will not close the window for webview {label}: {error}"
        );
    }
}

/// Publishes the window controls state to the current document and to every
/// document that follows.
///
/// The document-created script is what keeps a reload from flashing the page's
/// own buttons over the native ones: it runs before any script the page ships.
unsafe fn install_ready_script(
    core_webview: &ICoreWebView2,
    script: &str,
) -> windows_core::Result<()> {
    let utf16: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();
    let script = PCWSTR(utf16.as_ptr());

    unsafe {
        core_webview.AddScriptToExecuteOnDocumentCreated(
            script,
            None::<&ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>,
        )?;
        core_webview.ExecuteScript(script, None::<&ICoreWebView2ExecuteScriptCompletedHandler>)?;
    }

    Ok(())
}

pub(crate) fn install_window_frame_handler<R: Runtime>(webview: &Webview<R>) {
    let label = webview.label().to_owned();
    let callback_label = label.clone();

    let scheduled = webview.with_webview(move |platform_webview| {
        let controller = platform_webview.controller().clone();
        let Some(hwnd) = root_window(&controller, &callback_label) else {
            return;
        };
        let core_webview = match unsafe { controller.CoreWebView2() } {
            Ok(core_webview) => core_webview,
            Err(error) => {
                eprintln!(
                    "better-gui: could not get CoreWebView2 for webview {callback_label}: {error}"
                );
                return;
            }
        };
        let state = Box::new(WindowFrameState {
            controller,
            core_webview,
            is_minimized: Cell::new(false),
            restoring: Cell::new(false),
            label: callback_label.clone(),
        });
        let state_ptr = Box::into_raw(state);
        let installed = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(parent_window_subclass_proc),
                VISIBILITY_SUBCLASS_ID,
                state_ptr as usize,
            )
            .as_bool()
        };

        if !installed {
            unsafe { drop(Box::from_raw(state_ptr)) };
            eprintln!(
                "better-gui: could not install the window frame handler for webview {callback_label}"
            );
        }
    });

    if let Err(error) = scheduled {
        eprintln!(
            "better-gui: could not schedule the window frame handler for webview {label}: {error}"
        );
    }
}

/// El procedimiento de ventana es reentrante: restaurar el webview cambia el
/// marco con `SWP_FRAMECHANGED` y Windows despacha otro `WM_SIZE` antes de que
/// la llamada original termine. Por eso el estado se muta a traves de `Cell` y
/// nunca por una referencia `&mut`: dos `&mut` vivos sobre el mismo puntero
/// serian aliasing mutable, que es comportamiento indefinido aunque el codigo
/// generado parezca funcionar.
struct WindowFrameState {
    controller: ICoreWebView2Controller,
    core_webview: ICoreWebView2,
    is_minimized: Cell<bool>,
    restoring: Cell<bool>,
    label: String,
}

pub(crate) fn configure_native_window_frame<R: Runtime>(webview: &Webview<R>) {
    let label = webview.label().to_owned();
    let callback_label = label.clone();
    let scheduled = webview.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        let Some(hwnd) = root_window(&controller, &callback_label) else {
            return;
        };

        unsafe { apply_native_window_frame(hwnd, &callback_label) };
    });

    if let Err(error) = scheduled {
        eprintln!(
            "better-gui: could not schedule native window frame setup for webview {label}: {error}"
        );
    }
}

unsafe fn apply_native_window_frame(hwnd: HWND, label: &str) {
    let corner_preference = DWMWCP_ROUND;
    let border_color = DWMWA_COLOR_DEFAULT;
    let use_dark_mode = BOOL(1);

    for (attribute, value, value_size, description) in [
        (
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&corner_preference).cast::<c_void>(),
            size_of_val(&corner_preference) as u32,
            "enable native rounded corners",
        ),
        (
            DWMWA_BORDER_COLOR,
            std::ptr::from_ref(&border_color).cast::<c_void>(),
            size_of_val(&border_color) as u32,
            "restore the native frame border",
        ),
        (
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&use_dark_mode).cast::<c_void>(),
            size_of_val(&use_dark_mode) as u32,
            "use the dark native frame",
        ),
    ] {
        if let Err(error) = unsafe { DwmSetWindowAttribute(hwnd, attribute, value, value_size) } {
            eprintln!("better-gui: could not {description} for webview {label}: {error}");
        }
    }

    let frame_flags: SET_WINDOW_POS_FLAGS =
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
    if let Err(error) = unsafe { SetWindowPos(hwnd, None, 0, 0, 0, 0, frame_flags) } {
        eprintln!("better-gui: could not refresh the native frame for webview {label}: {error}");
    }
}

fn root_window(controller: &ICoreWebView2Controller, label: &str) -> Option<HWND> {
    let mut parent = HWND::default();
    if let Err(error) = unsafe { controller.ParentWindow(&mut parent) } {
        eprintln!(
            "better-gui: could not get the parent window handle for webview {label}: {error}"
        );
        return None;
    }

    let root = unsafe { GetAncestor(parent, GA_ROOT) };
    if root.0.is_null() {
        eprintln!("better-gui: could not resolve the root window for webview {label}");
        return None;
    }

    Some(root)
}

unsafe extern "system" fn parent_window_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    state_ptr: usize,
) -> LRESULT {
    if message == WM_NCCALCSIZE {
        if let Some(result) = unsafe { reclaim_frame_top_inset(hwnd, wparam, lparam) } {
            return result;
        }
    } else if message == WM_SIZE {
        let state = unsafe { &*(state_ptr as *const WindowFrameState) };
        let change = if wparam.0 as u32 == SIZE_MINIMIZED {
            SizeChange::Minimized
        } else {
            SizeChange::Shown
        };

        let (minimized, action) = visibility_action(state.is_minimized.get(), change);
        // El estado se publica antes de actuar. Restaurar reentra en este mismo
        // procedimiento, y la reentrada tiene que leer el estado nuevo.
        state.is_minimized.set(minimized);

        match action {
            VisibilityAction::Hide => {
                let _ = unsafe { state.controller.SetIsVisible(false) };
            }
            VisibilityAction::Restore => {
                // Durante `WM_SIZE` la ventana todavia no tiene su tamano
                // definitivo, asi que el restore se difiere a la siguiente
                // vuelta de la cola. Si la cola no lo acepta se hace en linea:
                // vale mas un restore con medidas provisionales que un webview
                // que no vuelve.
                if unsafe {
                    PostMessageW(Some(hwnd), RESTORE_WEBVIEW_MESSAGE, WPARAM(0), LPARAM(0))
                }
                .is_err()
                {
                    unsafe { restore_webview(state, hwnd) };
                }
            }
            VisibilityAction::None => {}
        }
    } else if message == RESTORE_WEBVIEW_MESSAGE {
        let state = unsafe { &*(state_ptr as *const WindowFrameState) };
        if !state.is_minimized.get() {
            unsafe { restore_webview(state, hwnd) };
        }
    } else if message == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(parent_window_subclass_proc), subclass_id);
            drop(Box::from_raw(state_ptr as *mut WindowFrameState));
        }
    }

    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// Gives the page back the pixel the undecorated frame reserves at the top.
///
/// On Windows 11 an undecorated window insets its client area by a pixel so the
/// border DWM paints does not cover the first row of content. WebView2 already
/// reserves its own row at the top of the overlay for exactly that border, so
/// the two insets stack and the caption buttons sit a pixel low with a gap
/// above them.
///
/// Taking the pixel back removes the gap without removing anything: DWM keeps
/// painting the border, now over the row the overlay already leaves empty, and
/// the window styles that carry the shadow, the snap animations and the resize
/// behaviour are never touched. A maximized window is left alone — its client
/// rect is the monitor's work area, and there is no border row to line up with.
///
/// Returns `None` when there is nothing to reclaim, so the caller falls through
/// to the normal handling.
unsafe fn reclaim_frame_top_inset(hwnd: HWND, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    if wparam.0 == 0 || unsafe { IsZoomed(hwnd) }.as_bool() {
        return None;
    }

    let params = unsafe { &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS) };
    // De entrada `rgrc[0]` es el rectangulo de ventana propuesto; a la salida
    // es el rectangulo de cliente. La diferencia en el borde superior es el
    // margen que la ventana se reservo.
    let proposed_top = params.rgrc[0].top;
    let result = unsafe { DefSubclassProc(hwnd, WM_NCCALCSIZE, wparam, lparam) };
    let inset = params.rgrc[0].top - proposed_top;

    if (1..=MAX_RECLAIMED_TOP_INSET).contains(&inset) {
        params.rgrc[0].top = proposed_top;
    }

    Some(result)
}

unsafe fn restore_webview(state: &WindowFrameState, hwnd: HWND) {
    // `apply_native_window_frame` despacha `WM_NCCALCSIZE` y `WM_SIZE` de vuelta
    // a este procedimiento antes de retornar. Sin este cerrojo un restore podria
    // encadenar otro y dejar la ventana redimensionandose sola.
    if state.restoring.replace(true) {
        return;
    }

    let _ = unsafe { state.controller.SetIsVisible(true) };
    unsafe { apply_native_window_frame(hwnd, &state.label) };
    let mut bounds = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut bounds) }.is_ok() {
        let _ = unsafe { state.controller.SetBounds(bounds) };
    }
    let _ = unsafe { state.controller.NotifyParentWindowPositionChanged() };
    let _ = unsafe {
        state.core_webview.ExecuteScript(
            NON_CLIENT_REGION_REFRESH_SCRIPT,
            None::<&ICoreWebView2ExecuteScriptCompletedHandler>,
        )
    };

    state.restoring.set(false);
}
