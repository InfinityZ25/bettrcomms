# Primary technical references

These sources anchor implementation choices. They are not evidence that BetterComms has completed the associated feature.

- [Wails v3 documentation](https://v3.wails.io/) covers desktop build, bindings, and platform packaging.
- [WorkOS AuthKit OAuth application token verification](https://workos.com/docs/authkit/connect/oauth#verifying-tokens) documents JWKS verification with issuer and audience checks. The exact BetterComms application mode and claims must be confirmed during integration.
- [WebRTC 1.0](https://www.w3.org/TR/webrtc/) defines peer connections, ICE transport policy, negotiated media, and statistics interfaces.
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) defines camera/microphone capture and constraints; [Screen Capture](https://www.w3.org/TR/screen-capture/) defines browser display capture and its user-consent requirements.
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445) defines ICE, and [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656) defines TURN relay behavior.
- [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587) specifies Opus payload use in RTP.
- [Windows Graphics Capture](https://learn.microsoft.com/windows/uwp/audio-video-camera/screen-capture) documents Windows screen/window capture, device-loss considerations, and protected-content behavior.
- [Application loopback audio capture](https://learn.microsoft.com/windows/win32/coreaudio/application-loopback) documents Windows process-tree include/exclude loopback activation and its OS-version constraints.

References must be rechecked when implementation begins because browser, operating-system, SDK, and framework behavior changes. Shipping support is determined by the acceptance evidence in `IMPLEMENTATION_MATRIX.md` and `TEST_PLAN.md`.
