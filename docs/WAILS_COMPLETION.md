# Wails desktop validation status

The Wails v3 host in `apps/desktop-wails` is the sole native desktop host. It embeds the shared React/Vite frontend and exposes page-token-gated native services through generated bindings. Browser media remains available when a native capability is unavailable.

Automated checks cover frontend builds and unit tests, Wails Go tests and vet, API/server tests, and browser Playwright flows. They do not establish physical-device capture, background input, GPU processing, or cross-network connectivity. Windows capture, native H.264 transport, recording, system audio, global input, and optional DSP have Wails implementations and adapters, but their release claims still require physical Windows hardware and packaged-app acceptance. macOS currently relies on webview microphone, camera, and browser capture; Windows-specific adapters are unavailable there.

The Wails macOS package script creates an ad hoc signed `.app`, ZIP, and DMG and verifies the app bundle. It is not Developer ID signed or notarized, so Gatekeeper may require an explicit per-app Open Anyway action. Windows installers are unsigned. Production release remains gated on signed/notarized packages, packaged WorkOS sign-in, real API/WebSocket session checks, native media lifecycle tests, and cross-device acceptance.

The native service should continue to reject unauthorised page tokens and unexpected origins. Every stop, error, and disconnect path must release capture tracks, audio contexts, worklets, recorders, socket writers, and listeners. See `TEST_PLAN.md` for release evidence.
