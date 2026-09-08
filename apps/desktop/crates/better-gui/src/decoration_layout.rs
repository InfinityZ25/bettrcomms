//! Parser for GTK's `gtk-decoration-layout` setting.
//!
//! Linux has no equivalent of the WebView2 overlay or of the macOS traffic
//! lights: a client-side-decorated window draws its own buttons. What the
//! desktop does publish is the layout it wants — which buttons, in which order,
//! on which side — as a string like `appmenu:minimize,maximize,close`. GNOME
//! puts them on the right, elementary on the left, and a user can reorder them.
//! Honouring that string is the closest thing to a native button set there is.
//!
//! The parser lives apart from the GTK calls so it is testable on any host.

use crate::controls::{ButtonSide, WindowButton};

/// Splits a `gtk-decoration-layout` value into a side and an ordered button
/// list, or returns `None` when the value names no window button at all.
///
/// The string is `left:right`. Items that are not buttons (`appmenu`, `icon`,
/// `menu`, `spacer`) are dropped, and unknown names are ignored rather than
/// treated as an error: a desktop is free to add its own, and a title bar with
/// the buttons it did recognise beats no title bar.
pub(crate) fn parse_decoration_layout(layout: &str) -> Option<(ButtonSide, Vec<WindowButton>)> {
    // GTK documents the value as `left:right`. Without a colon every item sits
    // on the left, and any colon past the first one is part of a malformed
    // value we do not try to rescue.
    let (start, end) = match layout.split_once(':') {
        Some((start, end)) => (start, end),
        None => (layout, ""),
    };

    let start_buttons = parse_group(start);
    let end_buttons = parse_group(end);

    match (start_buttons.is_empty(), end_buttons.is_empty()) {
        (true, true) => None,
        (false, true) => Some((ButtonSide::Start, start_buttons)),
        (true, false) => Some((ButtonSide::End, end_buttons)),
        // Split layouts exist — `close:minimize,maximize` is a real thing on
        // some setups. A single group of buttons is all the title bar can
        // render, so the larger group wins, and a tie goes to the trailing
        // edge because that is where a stray `close` normally sits.
        (false, false) => {
            if start_buttons.len() > end_buttons.len() {
                Some((ButtonSide::Start, start_buttons))
            } else {
                Some((ButtonSide::End, end_buttons))
            }
        }
    }
}

fn parse_group(group: &str) -> Vec<WindowButton> {
    let mut buttons = Vec::new();

    for item in group.split(',') {
        let button = match item.trim() {
            "minimize" => WindowButton::Minimize,
            "maximize" => WindowButton::Maximize,
            "close" => WindowButton::Close,
            _ => continue,
        };

        // A layout that repeats a button would give the page two controls that
        // do the same thing.
        if !buttons.contains(&button) {
            buttons.push(button);
        }
    }

    buttons
}

#[cfg(test)]
mod tests {
    use super::parse_decoration_layout;
    use crate::controls::{ButtonSide, WindowButton};

    #[test]
    fn gnome_puts_every_button_on_the_trailing_edge() {
        assert_eq!(
            parse_decoration_layout("appmenu:minimize,maximize,close"),
            Some((
                ButtonSide::End,
                vec![
                    WindowButton::Minimize,
                    WindowButton::Maximize,
                    WindowButton::Close
                ]
            ))
        );
    }

    #[test]
    fn elementary_puts_them_on_the_leading_edge_in_its_own_order() {
        assert_eq!(
            parse_decoration_layout("close,maximize:"),
            Some((
                ButtonSide::Start,
                vec![WindowButton::Close, WindowButton::Maximize]
            ))
        );
    }

    #[test]
    fn a_layout_without_a_colon_is_all_leading() {
        assert_eq!(
            parse_decoration_layout("close"),
            Some((ButtonSide::Start, vec![WindowButton::Close]))
        );
    }

    #[test]
    fn non_button_items_are_dropped() {
        assert_eq!(
            parse_decoration_layout("icon,menu,spacer:close"),
            Some((ButtonSide::End, vec![WindowButton::Close]))
        );
    }

    #[test]
    fn a_layout_with_no_buttons_has_nothing_to_render() {
        assert_eq!(parse_decoration_layout("appmenu:"), None);
        assert_eq!(parse_decoration_layout(""), None);
    }

    /// El escritorio puede pedir botones en los dos lados. La barra solo puede
    /// dibujar un grupo, y el grande es el que manda.
    #[test]
    fn a_split_layout_keeps_the_larger_group() {
        assert_eq!(
            parse_decoration_layout("close:minimize,maximize"),
            Some((
                ButtonSide::End,
                vec![WindowButton::Minimize, WindowButton::Maximize]
            ))
        );
        assert_eq!(
            parse_decoration_layout("minimize,maximize:close"),
            Some((
                ButtonSide::Start,
                vec![WindowButton::Minimize, WindowButton::Maximize]
            ))
        );
    }

    #[test]
    fn a_repeated_button_is_only_rendered_once() {
        assert_eq!(
            parse_decoration_layout(":close,close"),
            Some((ButtonSide::End, vec![WindowButton::Close]))
        );
    }
}
