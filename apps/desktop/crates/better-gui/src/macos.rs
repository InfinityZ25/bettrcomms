//! macOS keeps its own window buttons.
//!
//! The overlay title bar configured in `tauri.macos.conf.json`
//! (`titleBarStyle: "Overlay"`) leaves the real traffic lights in place over a
//! transparent frame, so there is nothing to create here and nothing to
//! emulate: closing, minimizing, zooming, the green button's full-screen
//! behaviour and the option-click variants all stay in AppKit's hands.
//!
//! The one thing the page cannot work out on its own is how much room the
//! traffic lights take, so that is what this module reports.

use crate::WindowControlsConfig;
use crate::controls::{ButtonSide, ControlsMode, WindowControlsState};

pub(crate) fn window_controls_state(config: &WindowControlsConfig) -> WindowControlsState {
    WindowControlsState {
        platform: "macos",
        mode: ControlsMode::NativeTrafficLights,
        height: config.height,
        // Los semaforos van siempre al borde inicial en macOS; el sistema no
        // ofrece moverlos de lado.
        inset_start: config.macos_traffic_light_inset,
        inset_end: 0,
        buttons: Vec::new(),
        button_side: ButtonSide::Start,
    }
}

#[cfg(test)]
mod tests {
    use super::window_controls_state;
    use crate::WindowControlsConfig;
    use crate::controls::{ButtonSide, ControlsMode};

    #[test]
    fn macos_draws_no_buttons_and_only_reserves_room_for_the_traffic_lights() {
        let config = WindowControlsConfig {
            height: 32,
            macos_traffic_light_inset: 78,
            ..WindowControlsConfig::default()
        };
        let state = window_controls_state(&config);

        assert_eq!(state.mode, ControlsMode::NativeTrafficLights);
        assert!(state.buttons.is_empty());
        assert_eq!(state.button_side, ButtonSide::Start);
        assert_eq!(state.inset_start, 78);
        assert_eq!(state.inset_end, 0);
        assert_eq!(state.height, 32);
    }
}
