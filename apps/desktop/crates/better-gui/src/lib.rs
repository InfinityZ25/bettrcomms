//! Native window controls for the BetterComms desktop host.
//!
//! The app draws its own title bar (`decorations: false` on Windows and Linux,
//! an overlay title bar on macOS), so the window buttons are the app's problem.
//! Each desktop answers that differently, and this crate hides the difference
//! behind one state object the page reads:
//!
//! - **Windows** gets the real thing. WebView2's Window Controls Overlay paints
//!   the system minimize/maximize/close buttons over the page, with the
//!   system's own hover, snap-layout flyout and high-contrast behaviour. The
//!   crate also restores the pieces `decorations: false` takes away — rounded
//!   corners, the frame border, the dark frame — and stops the webview from
//!   composing while the window is minimized.
//! - **macOS** keeps its native traffic lights, which the overlay title bar in
//!   `tauri.macos.conf.json` leaves in place. The page is only told how much
//!   room to leave for them.
//! - **Linux** has no native overlay: a client-side-decorated window draws its
//!   own buttons. The crate reads `gtk-decoration-layout` so the page can draw
//!   them in the order and on the side the desktop asked for.
//!
//! The page reads `window.__BETTER_WINDOW_CONTROLS__` and listens for
//! `better-window-controls-change`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Runtime, Webview, plugin::TauriPlugin};

pub(crate) mod controls;
// El parser es puro y sus pruebas tienen que correr en cualquier host, no solo
// en Linux, asi que se compila siempre aunque solo se use alli.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) mod decoration_layout;
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod visibility;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub use controls::{ButtonSide, ControlsMode, WindowButton, WindowControlsState};

/// How the host wants its title bar dressed.
#[derive(Clone, Debug)]
pub struct WindowControlsConfig {
    /// Tauri webview label that owns the title bar.
    pub webview_label: &'static str,
    /// Title bar height in logical CSS pixels, border included. The page must
    /// reserve exactly this much.
    pub height: u32,
    /// Width of the title bar's own bottom border, in logical CSS pixels. The
    /// native Windows overlay stops above it; without this the system buttons
    /// paint over the border and spill a row into the page below.
    pub border_width: u32,
    /// Opaque RGB background WebView2 uses to derive the overlay's glyph and
    /// hover colours. It should match the title bar the page paints, or the
    /// buttons sit on a visible patch of a different colour.
    pub background: [u8; 3],
    /// Logical pixels to reserve for the macOS traffic lights, measured from
    /// the leading edge. Has to agree with `trafficLightPosition` in
    /// `tauri.macos.conf.json`.
    pub macos_traffic_light_inset: u32,
}

impl Default for WindowControlsConfig {
    fn default() -> Self {
        Self {
            webview_label: "main",
            height: 32,
            border_width: 1,
            background: [14, 16, 18],
            macos_traffic_light_inset: 78,
        }
    }
}

/// Creates the `better-gui` plugin with the BetterComms defaults.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(WindowControlsConfig::default())
}

/// Creates the `better-gui` plugin with an explicit title bar configuration.
pub fn init_with_config<R: Runtime>(config: WindowControlsConfig) -> TauriPlugin<R> {
    let published = PublishedStates::default();
    let ready_states = published.clone();
    let ready_config = config.clone();

    tauri::plugin::Builder::new("better-gui")
        .on_webview_ready(move |webview| {
            if webview.label() != ready_config.webview_label {
                return;
            }

            configure(&webview, &ready_config, &ready_states);
        })
        .on_page_load(move |webview, _payload| {
            // Una recarga borra el global. Sin volver a publicarlo la barra
            // vuelve sin saber quien dibuja los botones y pinta los suyos
            // encima de los nativos.
            let Some(state) = published.get(webview.label()) else {
                return;
            };

            if let Err(error) = webview.eval(&state.publish_script()) {
                eprintln!(
                    "better-gui: could not republish the window controls state for webview {}: {error}",
                    webview.label()
                );
            }
        })
        .build()
}

fn configure<R: Runtime>(
    webview: &Webview<R>,
    config: &WindowControlsConfig,
    published: &PublishedStates,
) {
    #[cfg(windows)]
    {
        configure_windows(webview, config, published);
    }

    #[cfg(target_os = "macos")]
    {
        publish(webview, published, macos::window_controls_state(config));
    }

    #[cfg(target_os = "linux")]
    {
        publish(webview, published, linux::window_controls_state(config));
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        publish(
            webview,
            published,
            WindowControlsState::client_side("unknown", config.height),
        );
    }
}

/// Windows is the only platform whose answer is not known up front: the overlay
/// is an experimental WebView2 API and an older runtime simply does not have
/// it. The two candidate states are decided here and the winner is picked once
/// WebView2 has answered.
#[cfg(windows)]
fn configure_windows<R: Runtime>(
    webview: &Webview<R>,
    config: &WindowControlsConfig,
    published: &PublishedStates,
) {
    let native = WindowControlsState {
        platform: "windows",
        mode: ControlsMode::NativeOverlay,
        height: config.height,
        // La geometria real de los botones nativos la publica WebView2 en
        // `env(titlebar-area-*)`, que es mas fiel que cualquier numero de aqui.
        inset_start: 0,
        inset_end: 0,
        buttons: Vec::new(),
        button_side: ButtonSide::End,
    };
    let fallback = WindowControlsState::client_side("windows", config.height);

    let label = webview.label().to_owned();
    let states = published.clone();
    let resolve = Box::new(move |overlay_is_native: bool| {
        let state = if overlay_is_native {
            native.clone()
        } else {
            fallback.clone()
        };
        let script = state.publish_script();
        states.set(label.clone(), state);
        Some(script)
    });

    let scale_factor = webview.window().scale_factor().unwrap_or(1.0);
    windows::configure_window_controls_overlay(
        webview,
        overlay_button_height(config, scale_factor),
        config.background,
        Some(resolve),
    );
    // El manejador va antes que el refresco del marco: ese refresco despacha el
    // `WM_NCCALCSIZE` donde se recupera el pixel superior, y si la subclase no
    // esta puesta todavia el mensaje pasa de largo.
    windows::install_window_frame_handler(webview);
    windows::configure_native_window_frame(webview);

    let resized_webview = webview.clone();
    let resized_config = config.clone();
    webview.window().on_window_event(move |event| {
        if let tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
            // La altura del overlay es fisica, asi que un cambio de escala la
            // deja desalineada con la barra que pinta la pagina.
            windows::configure_window_controls_overlay(
                &resized_webview,
                overlay_button_height(&resized_config, *scale_factor),
                resized_config.background,
                None,
            );
        }
    });
}

/// WebView2 draws the overlay as a one-pixel top border plus a caption button
/// of exactly the height it is given, so the band it covers is one pixel taller
/// than the request.
///
/// Measured on a real window: asking for 32 put the buttons on client rows
/// 1..32, one row below the top and two past a 32-pixel title bar.
const OVERLAY_TOP_BORDER: u32 = 1;

/// Returns the height to ask WebView2 for.
///
/// Two pixels come off the title bar: the bar's own bottom border, which the
/// buttons must not cover, and the one WebView2 adds above the button for its
/// own top border. Give it the full height instead and the native buttons paint
/// over the border and spill a row into the page underneath.
#[cfg(windows)]
fn overlay_button_height(config: &WindowControlsConfig, scale_factor: f64) -> u32 {
    let available = physical_height(
        config.height.saturating_sub(config.border_width),
        scale_factor,
    );

    available.saturating_sub(OVERLAY_TOP_BORDER).max(1)
}

#[cfg(not(windows))]
fn publish<R: Runtime>(
    webview: &Webview<R>,
    published: &PublishedStates,
    state: WindowControlsState,
) {
    let script = state.publish_script();
    published.set(webview.label().to_owned(), state);

    if let Err(error) = webview.eval(&script) {
        eprintln!(
            "better-gui: could not publish the window controls state for webview {}: {error}",
            webview.label()
        );
    }
}

/// The resolved state per webview, kept so a reload can be answered without
/// asking the platform again.
#[derive(Clone, Default)]
struct PublishedStates(Arc<Mutex<HashMap<String, WindowControlsState>>>);

impl PublishedStates {
    fn get(&self, label: &str) -> Option<WindowControlsState> {
        // Un lock envenenado significa que un publisher entro en panico. El
        // estado que dejo sigue siendo valido y perder la barra de titulo por
        // eso seria peor que leerlo.
        let states = self.0.lock().unwrap_or_else(|error| error.into_inner());
        states.get(label).cloned()
    }

    fn set(&self, label: String, state: WindowControlsState) {
        let mut states = self.0.lock().unwrap_or_else(|error| error.into_inner());
        states.insert(label, state);
    }
}

fn physical_height(logical_height: u32, scale_factor: f64) -> u32 {
    let valid_scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };

    (f64::from(logical_height) * valid_scale)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32
}

#[cfg(test)]
mod tests {
    use super::{PublishedStates, WindowControlsState, physical_height};

    #[test]
    fn overlay_height_tracks_display_scale() {
        assert_eq!(physical_height(36, 1.0), 36);
        assert_eq!(physical_height(36, 1.25), 45);
        assert_eq!(physical_height(36, 1.5), 54);
        assert_eq!(physical_height(36, 2.0), 72);
    }

    #[test]
    fn overlay_height_rejects_invalid_scale_factors() {
        assert_eq!(physical_height(36, 0.0), 36);
        assert_eq!(physical_height(36, f64::NAN), 36);
    }

    /// La barra mide 32 px con un borde inferior de 1, asi que al overlay le
    /// quedan 31: 1 para su propio borde superior y 30 de boton. Son las
    /// medidas tomadas de la ventana real.
    #[cfg(windows)]
    #[test]
    fn the_overlay_band_stops_above_the_title_bars_own_border() {
        let config = super::WindowControlsConfig {
            height: 32,
            border_width: 1,
            ..super::WindowControlsConfig::default()
        };

        assert_eq!(super::overlay_button_height(&config, 1.0), 30);
        assert_eq!(super::overlay_button_height(&config, 2.0), 61);
    }

    #[cfg(windows)]
    #[test]
    fn a_title_bar_too_short_for_an_overlay_still_asks_for_a_visible_one() {
        let config = super::WindowControlsConfig {
            height: 1,
            border_width: 1,
            ..super::WindowControlsConfig::default()
        };

        assert_eq!(super::overlay_button_height(&config, 1.0), 1);
    }

    #[test]
    fn a_reload_can_read_back_the_state_that_was_resolved_once() {
        let published = PublishedStates::default();
        assert_eq!(published.get("main"), None);

        let state = WindowControlsState::client_side("linux", 32);
        published.set("main".to_owned(), state.clone());

        assert_eq!(published.get("main"), Some(state));
        assert_eq!(published.get("other"), None);
    }
}
