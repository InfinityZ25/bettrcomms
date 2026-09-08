# Desktop window controls

The desktop host draws its own title bar, so the minimize/maximize/close
buttons are the app's responsibility. Each desktop answers that differently.
`apps/desktop/crates/better-gui` resolves the difference in Rust and publishes
one state object; `apps/web/src/DesktopFrame.tsx` renders whatever that state
asks for.

## Per platform

| Platform | Who draws the buttons | How |
| --- | --- | --- |
| Windows | The system | WebView2's Window Controls Overlay paints the real buttons over the page, with the system's own hover, press and high-contrast behaviour |
| macOS | The system | The overlay title bar keeps AppKit's traffic lights; the page only reserves room for them |
| Linux | The app | There is no native overlay, so the page draws the buttons in the order and on the side `gtk-decoration-layout` asks for |

Windows also loses pieces of the frame to `decorations: false`, so the crate
puts them back through DWM — rounded corners, the frame border, the dark frame
— and hides the WebView2 controller while the window is minimized, which stops
it composing and keeps it from coming back blank on some driver stacks.

The Windows overlay is an experimental WebView2 API. A runtime without it is
not an error: the crate publishes the client-side state instead and the page
draws its own buttons, the same ones it drew before any of this existed.

## The three pixels Windows argues about

None of this is guesswork; each number was measured on a running window and the
measurements are what the tests assert.

**The overlay is a pixel taller than you ask for.** WebView2 draws a one-pixel
top border and then a caption button of exactly `Height`. Asking for the full
32-pixel title bar put the buttons on client rows 1..32 — over the bar's own
bottom border and a row into the page. The crate now asks for
`height - border_width - 1` so the band ends where the border begins.

**The frame reserves a pixel the overlay also reserves.** On Windows 11 an
undecorated window insets its client area by a pixel so the border DWM paints
does not cover the first row of content. WebView2 already leaves its own row for
that border, so the two stack and the buttons sit a pixel low with a visible gap
above them. The subclass takes that pixel back in `WM_NCCALCSIZE`, capped at
four pixels so it can never swallow a real title bar. Nothing is removed: DWM
still paints the border, now over the row the overlay leaves empty, and the
window styles that carry the shadow, the snap animations and the resize edges
are never touched.

**Snap Layouts cannot be had this way.** Windows opens the flyout for a window
that answers `WM_NCHITTEST` with `HTMAXBUTTON`, and WebView2's overlay has no
hit testing to offer: the API is a background colour, a height and an enable
flag. Claiming the rectangle from the host does not work either, and the reason
is worth writing down so nobody spends the afternoon on it again:

- The top-level window can be made to answer `HTMAXBUTTON` over the maximize
  button, and it does — verified by sending it `WM_NCHITTEST` from outside. No
  flyout appears, because nothing asks it.
- The window that actually owns the mouse there is
  `Chrome_RenderWidgetHostHWND`, a Chromium window several levels inside the
  frame. `WindowFromPoint` resolves to it, so the shell attributes the hover to
  it and never consults the frame.
- Making the windows above it answer `HTMAXBUTTON`, or answer `HTTRANSPARENT` so
  the point falls through, changes nothing — the render widget still catches it,
  and it lives on a Chromium thread that `SetWindowSubclass` cannot reach from
  the host thread.

The remaining lever would be to take the mouse away from WebView2 over that one
button and re-implement its hover and its click, which trades a button that
works today for a flyout. That is not a trade this crate makes. An in-page
button set does not escape it either: the render widget owns the mouse over the
page whoever draws the buttons.

## The contract

The plugin publishes `window.__BETTER_WINDOW_CONTROLS__` and dispatches
`better-window-controls-change`. The shape is in
`apps/web/src/windowControls.ts`, which validates it before use — a half-written
state would otherwise leave the window with no way to close.

The publish can land after the first render on macOS and Linux, so the page
starts from a guess made from the user agent and swaps to the real state when
it arrives. On Windows the state is installed as a document-created script, so
it is already there before any page script runs and a reload does not flash the
page's own buttons over the native ones.

Two numbers have to agree across the boundary:

- The title bar height and border width in `WindowControlsConfig` and in
  `.desktop-titlebar`. The overlay's height is derived from both, and a mismatch
  puts the system buttons over the app's own content.
- `macos_traffic_light_inset` and `trafficLightPosition` in
  `tauri.macos.conf.json`.

The overlay's `background` should match the colour the page paints behind the
title bar; WebView2 derives its glyph and hover colours from it.

## Configuration

`tauri.conf.json` keeps `decorations: false` for Windows and Linux.
`tauri.macos.conf.json` overrides the window with `decorations: true`,
`titleBarStyle: "Overlay"` and `hiddenTitle: true`, which is what leaves the
traffic lights in place over a transparent frame.

## What is verified

`cargo test -p better-gui` covers the pure parts: the minimize/restore decision
table, the `gtk-decoration-layout` parser, the overlay height across display
scales, and the state a reload reads back. `npm test` covers the frontend's
validation and snapshot identity.

The Windows geometry above was verified on a running window by reading the
screen pixel by pixel. With a 32-pixel title bar at 100% scale the client rows
now come out as: row 0 the frame border DWM paints, rows 1 to 30 the caption
button, row 31 the title bar's own bottom border, row 32 the page. Maximize,
minimize and restore were exercised afterwards and the client rect and frame
inset came back correct in each state.

macOS and Linux have had no such run. Their code paths compile and their pure
parts are tested, but nobody has looked at the traffic lights or at a GTK button
layout on a real window, and `DESKTOP_VALIDATION.md` does not cover them
either.
