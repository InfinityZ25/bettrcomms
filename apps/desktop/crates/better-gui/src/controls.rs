//! The state the host publishes to the page.
//!
//! Every platform ends up in the same shape so the frontend has a single thing
//! to read. What differs is who draws the buttons: Windows hands them to
//! WebView2, macOS keeps its own traffic lights, and Linux has no native
//! overlay at all, so the page draws them in the order the desktop asks for.

use serde::Serialize;

/// A window button the page has to draw itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowButton {
    Minimize,
    Maximize,
    Close,
}

/// Which end of the title bar the client-side buttons belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ButtonSide {
    /// The leading edge: left in a left-to-right locale.
    Start,
    /// The trailing edge.
    End,
}

/// Who draws the window buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlsMode {
    /// WebView2 paints the real Windows buttons over the page. Their geometry
    /// arrives through the `titlebar-area-*` environment variables, so the
    /// insets in this state stay at zero.
    NativeOverlay,
    /// macOS keeps its own traffic lights on an overlay title bar. The page
    /// only has to leave room for them.
    NativeTrafficLights,
    /// Nothing native is available: the page draws `buttons` itself.
    ClientSide,
}

/// What the page needs to lay out its title bar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControlsState {
    pub platform: &'static str,
    pub mode: ControlsMode,
    /// Title bar height in logical CSS pixels.
    pub height: u32,
    /// Logical pixels to reserve before the title bar content.
    pub inset_start: u32,
    /// Logical pixels to reserve after the title bar content.
    pub inset_end: u32,
    /// Buttons the page must draw, already in the platform's own order. Empty
    /// whenever the buttons are native.
    pub buttons: Vec<WindowButton>,
    pub button_side: ButtonSide,
}

impl WindowControlsState {
    /// The state for a host that could not reach anything native. The page
    /// draws Windows-style buttons on the trailing edge, which is the layout
    /// the app shipped with before any of this existed.
    pub fn client_side(platform: &'static str, height: u32) -> Self {
        Self {
            platform,
            mode: ControlsMode::ClientSide,
            height,
            inset_start: 0,
            inset_end: 0,
            buttons: vec![
                WindowButton::Minimize,
                WindowButton::Maximize,
                WindowButton::Close,
            ],
            button_side: ButtonSide::End,
        }
    }

    /// The script that publishes this state and wakes the page's subscribers.
    ///
    /// It is re-run on every page load, not only once: a reload wipes the
    /// global and the title bar would come back without knowing who owns the
    /// buttons.
    pub fn publish_script(&self) -> String {
        let payload = serde_json::to_string(self)
            .unwrap_or_else(|_| String::from("{\"mode\":\"client-side\"}"));

        format!(
            "(() => {{ window.__BETTER_WINDOW_CONTROLS__ = {payload}; \
             window.dispatchEvent(new Event('better-window-controls-change')); }})();"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{ButtonSide, ControlsMode, WindowControlsState};

    #[test]
    fn the_fallback_state_draws_all_three_buttons_at_the_trailing_edge() {
        let state = WindowControlsState::client_side("windows", 32);

        assert_eq!(state.mode, ControlsMode::ClientSide);
        assert_eq!(state.button_side, ButtonSide::End);
        assert_eq!(state.buttons.len(), 3);
        assert_eq!((state.inset_start, state.inset_end), (0, 0));
    }

    #[test]
    fn the_published_script_carries_the_state_and_notifies_the_page() {
        let script = WindowControlsState::client_side("linux", 32).publish_script();

        assert!(script.contains("__BETTER_WINDOW_CONTROLS__"));
        assert!(script.contains("\"mode\":\"client-side\""));
        assert!(script.contains("\"buttonSide\":\"end\""));
        assert!(script.contains("better-window-controls-change"));
    }
}
