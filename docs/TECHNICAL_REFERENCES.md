# Primary technical references

These sources anchor implementation choices. They are not evidence that BetterComms has completed the associated feature.

- [Tauri 2 Vite guide](https://v2.tauri.app/start/frontend/vite/) documents `devUrl`, `frontendDist`, and the Vite development/build integration.
- [Tauri 2 configuration reference](https://v2.tauri.app/reference/config/) defines the configuration schema used by the desktop scaffold.
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/) and [core permissions](https://v2.tauri.app/reference/acl/core-permissions/) define the window-scoped permission model and core defaults. The scaffold grants no shell or filesystem plugin.
- [Tauri process model](https://v2.tauri.app/concept/process-model/) explains the security boundary between the core process and webview.
- [WorkOS AuthKit OAuth application token verification](https://workos.com/docs/authkit/connect/oauth#verifying-tokens) documents JWKS verification with issuer and audience checks. The exact BetterComms application mode and claims must be confirmed during integration.
- [WebRTC 1.0](https://www.w3.org/TR/webrtc/) defines peer connections, ICE transport policy, negotiated media, and statistics interfaces.
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) defines camera/microphone capture and constraints; [Screen Capture](https://www.w3.org/TR/screen-capture/) defines browser display capture and its user-consent requirements.
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445) defines ICE, and [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656) defines TURN relay behavior.
- [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587) specifies Opus payload use in RTP.
- [Windows Graphics Capture](https://learn.microsoft.com/windows/uwp/audio-video-camera/screen-capture) documents Windows screen/window capture, device-loss considerations, and protected-content behavior.
- [Application loopback audio capture](https://learn.microsoft.com/windows/win32/coreaudio/application-loopback) documents Windows process-tree include/exclude loopback activation and its OS-version constraints.
- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) lists Rust, Microsoft C++ build tools, and WebView2 requirements used by the verification plan.

References must be rechecked when implementation begins because browser, operating-system, SDK, and framework behavior changes. Shipping support is determined by the acceptance evidence in `IMPLEMENTATION_MATRIX.md` and `TEST_PLAN.md`.
