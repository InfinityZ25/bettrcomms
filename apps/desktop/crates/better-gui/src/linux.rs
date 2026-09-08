//! Linux has no native window-controls overlay.
//!
//! A client-side-decorated window draws its own buttons, which is exactly what
//! every GTK app does. What the desktop publishes instead is the layout it
//! wants — `gtk-decoration-layout` — and honouring it is what makes the buttons
//! read as native: GNOME's three on the right, elementary's two on the left, a
//! user who reordered them in Tweaks, a theme that drops minimize entirely.
//!
//! Reading that setting is all this module does; the page draws the result.

use gtk::prelude::SettingsExt;

use crate::WindowControlsConfig;
use crate::controls::{ControlsMode, WindowControlsState};
use crate::decoration_layout::parse_decoration_layout;

/// Reads the desktop's window button layout.
///
/// Must run on the main thread, because it touches GTK. `on_webview_ready`
/// does.
pub(crate) fn window_controls_state(config: &WindowControlsConfig) -> WindowControlsState {
    let fallback = WindowControlsState::client_side("linux", config.height);

    let Some(settings) = gtk::Settings::default() else {
        eprintln!(
            "better-gui: no GTK settings are available; using the default window button layout"
        );
        return fallback;
    };

    let Some(layout) = settings.gtk_decoration_layout() else {
        return fallback;
    };

    let Some((button_side, buttons)) = parse_decoration_layout(layout.as_str()) else {
        // Un escritorio puede pedir una barra sin botones, y esa peticion se
        // respeta igual que en cualquier otra aplicacion GTK: la ventana sigue
        // cerrandose desde el gestor de ventanas y sus atajos.
        return WindowControlsState {
            buttons: Vec::new(),
            ..fallback
        };
    };

    WindowControlsState {
        mode: ControlsMode::ClientSide,
        buttons,
        button_side,
        ..fallback
    }
}
