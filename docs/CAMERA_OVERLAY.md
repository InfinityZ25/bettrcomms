# Native camera overlay

The Windows app can show up to four received cameras above a windowed or borderless fullscreen game. The call toolbar offers Camera overlay, corner and size presets, click-through, and optional self-view. Activation is per call; only layout preferences persist.

The window is a Rust-owned Win32 layered popup with no extra WebView, taskbar entry, audio renderer, network connection, or capture device. The existing call WebView decodes the camera tracks and composites their small previews, labels and mute/deafen/speaking state into RGBA. A bounded binary IPC transfer updates the native window at at most 10 FPS. Source tracks and recordings are untouched. This is not a wholly Rust media pipeline: moving the existing WebRTC decoders into Rust would be a separate transport project.

Only the trusted main app origin can control the window. Each opening has a fresh opaque grant; stale grants cannot paint or update a replacement. Frame dimensions and byte length are checked, lifecycle commands are serialized, and painting does not accumulate a frame queue. Leaving the call or disabling the overlay closes it; a native heartbeat closes it if the frontend stops delivering frames. The native window requests exclusion from screen capture to avoid recapturing the camera overlay into whole-screen shares.

The window uses the display containing BetterComms. Native presets are constrained to its work area. Click-through is on by default and the window does not activate or steal keyboard focus. Desktop background-rendering flags allow preview updates while the main app is occluded; those flags do not prove performance under every game/GPU load.

Exclusive fullscreen and game-specific anti-cheat compatibility are not supported by this topmost-window approach. There is no DLL injection or DirectX/OpenGL/Vulkan presentation hook. macOS and browser clients do not expose this Windows-only control.

Validation includes `tests/camera-overlay.spec.ts` for real synthetic-camera composition/source ownership, native unit checks for frame bounds and premultiplied alpha, and `scripts/test-native-camera-overlay.mjs` against an isolated development desktop host for binary IPC, resizing, grant revocation and frame timing. A test window is not an acceptance test for every fullscreen game.
