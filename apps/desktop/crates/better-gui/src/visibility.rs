//! Decision table for the WebView2 visibility handler.
//!
//! WebView2 keeps composing while the host window is minimized, which wastes
//! GPU work and, on some driver stacks, brings the webview back blank. The
//! handler hides the controller while the window is iconic and restores it when
//! the window comes back.
//!
//! The rule lives here, apart from the Win32 window procedure, for two reasons.
//! The window procedure is reentrant — restoring the webview resizes the frame,
//! and that dispatches another `WM_SIZE` into the same procedure before the
//! first one returns — so the transition has to be a pure function over the
//! previous state instead of something spread across a mutable borrow. And a
//! pure function is testable on any host, while the procedure only exists on
//! Windows.

/// The window size transitions the handler distinguishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SizeChange {
    /// `WM_SIZE` with `SIZE_MINIMIZED`.
    Minimized,
    /// Any other `WM_SIZE`: restored, maximized or a plain resize. Windows does
    /// not distinguish "restored from the taskbar" from "resized by a drag", so
    /// neither does this.
    Shown,
}

/// What the window procedure must do with the WebView2 controller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VisibilityAction {
    /// Hide the controller so a minimized window stops composing.
    Hide,
    /// Show the controller again and resync frame and bounds.
    Restore,
    /// The transition does not change controller visibility.
    None,
}

/// Returns the next `is_minimized` state and the action for this transition.
///
/// `Hide` is emitted on every minimized message, not only on the edge:
/// `SetIsVisible(false)` is idempotent and a missed hide costs a window that
/// keeps rendering while iconic. `Restore` is emitted only on the edge, because
/// it resizes the frame and re-runs a script in the page — doing that on every
/// resize would fight the user dragging a border.
pub(crate) fn visibility_action(
    was_minimized: bool,
    change: SizeChange,
) -> (bool, VisibilityAction) {
    match change {
        SizeChange::Minimized => (true, VisibilityAction::Hide),
        SizeChange::Shown if was_minimized => (false, VisibilityAction::Restore),
        SizeChange::Shown => (false, VisibilityAction::None),
    }
}

#[cfg(test)]
mod tests {
    use super::{SizeChange, VisibilityAction, visibility_action};

    #[test]
    fn minimizing_hides_the_controller() {
        assert_eq!(
            visibility_action(false, SizeChange::Minimized),
            (true, VisibilityAction::Hide)
        );
    }

    #[test]
    fn restoring_from_minimized_restores_the_controller() {
        assert_eq!(
            visibility_action(true, SizeChange::Shown),
            (false, VisibilityAction::Restore)
        );
    }

    #[test]
    fn resizing_a_visible_window_does_not_touch_the_controller() {
        assert_eq!(
            visibility_action(false, SizeChange::Shown),
            (false, VisibilityAction::None)
        );
    }

    #[test]
    fn repeated_minimized_messages_stay_hidden() {
        assert_eq!(
            visibility_action(true, SizeChange::Minimized),
            (true, VisibilityAction::Hide)
        );
    }

    /// Maximizar, minimizar y restaurar es el recorrido reportado como S1: la
    /// ventana vuelve maximizada y el webview tiene que volver con ella.
    #[test]
    fn maximize_minimize_restore_restores_once() {
        let mut minimized = false;
        let mut actions = Vec::new();

        for change in [
            SizeChange::Shown,     // maximizar
            SizeChange::Minimized, // minimizar
            SizeChange::Shown,     // restaurar, aun maximizada
        ] {
            let (next, action) = visibility_action(minimized, change);
            minimized = next;
            actions.push(action);
        }

        assert_eq!(
            actions,
            vec![
                VisibilityAction::None,
                VisibilityAction::Hide,
                VisibilityAction::Restore
            ]
        );
        assert!(!minimized);
    }

    /// El restore se difiere con `PostMessage`. Si la ventana se vuelve a
    /// minimizar antes de que ese mensaje se despache, el estado ya dice
    /// `minimized` y el procedimiento descarta el restore pendiente en vez de
    /// mostrar el controller sobre una ventana iconica.
    #[test]
    fn a_deferred_restore_is_discarded_when_the_window_minimizes_again() {
        let (minimized, action) = visibility_action(true, SizeChange::Shown);
        assert_eq!(action, VisibilityAction::Restore);
        assert!(!minimized);

        let (minimized, action) = visibility_action(minimized, SizeChange::Minimized);
        assert_eq!(action, VisibilityAction::Hide);
        assert!(
            minimized,
            "el restore diferido debe verse cancelado por el estado"
        );
    }

    /// Restaurar redimensiona el marco y eso vuelve a entrar al mismo
    /// procedimiento con un `WM_SIZE`. Esa reentrada no puede pedir otro
    /// restore ni perder el estado.
    #[test]
    fn the_resize_caused_by_a_restore_does_not_restore_again() {
        let (minimized, action) = visibility_action(true, SizeChange::Shown);
        assert_eq!(action, VisibilityAction::Restore);

        let (minimized, action) = visibility_action(minimized, SizeChange::Shown);
        assert_eq!(action, VisibilityAction::None);
        assert!(!minimized);
    }
}
