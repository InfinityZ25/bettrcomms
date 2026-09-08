//! Native window controls for the BetterComms desktop host.
//!
//! Each desktop provides window controls differently. This crate hides that
//! difference behind one state object the page reads:
//!
//! - **Windows** uses the complete native frame outside the WebView. Windows
//!   owns caption geometry, input, Snap Layouts and hover state. The page only
//!   supplies its palette. WebView composition pauses while minimized.
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
    /// custom title bar stops above it. Windows uses its system frame metrics.
    pub border_width: u32,
    /// RGB caption background requested from DWM. It should match the title
    /// bar the page paints.
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
            background: [29, 24, 22],
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

/// Restore the real non-client frame before telling the page to hide its bar.
#[cfg(windows)]
fn configure_windows<R: Runtime>(
    webview: &Webview<R>,
    config: &WindowControlsConfig,
    published: &PublishedStates,
) {
    if let Err(error) = webview.window().set_decorations(true) {
        eprintln!("better-gui: could not restore the native frame: {error}");
        let fallback = WindowControlsState::client_side("windows", config.height);
        let _ = webview.eval(&fallback.publish_script());
        published.set(webview.label().to_owned(), fallback);
        return;
    }
    let state = WindowControlsState::native_frame();
    let script = state.publish_script();
    published.set(webview.label().to_owned(), state);
    windows::configure(webview, config.background, script);
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

#[cfg(test)]
mod tests {
    use super::{PublishedStates, WindowControlsState};

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
