# Push-to-talk (local development)

Push-to-talk is **off by default**. Open **Settings → Voice & devices → Push-to-talk**, enable it, select **Set push-to-talk shortcut**, and press a keyboard key or click a mouse button on that control. Left, middle, right, back and forward mouse buttons are supported when the browser delivers them. Escape cancels assignment; Tab and Windows/Command remain reserved. Disable the checkbox to return to the ordinary microphone behavior. Preferences are saved per browser profile and origin.

During a call, hold the shortcut to transmit microphone audio and release it to stop. The footer shows the shortcut and transmission state. Waiting does not display or publish manual mute: the captured microphone remains live and enabled while its processed output sends silence. Pressing and releasing the shortcut does not reacquire the device. Manual mute and deafen take priority; unmuting or undeafening requires a fresh shortcut press. Typing does not transmit by default. Enable **Allow push-to-talk while typing in BetterComms** to allow any assigned keyboard shortcut in this app's editors without consuming text or editing shortcuts. Assignment controls always remain protected. The preference does not inspect editors in other applications or change global input behavior, and uses existing focus/input listeners without additional polling. Keyboard shortcuts still work when call buttons retain focus; assigned Space/Enter presses do not also activate those buttons. Primary mouse clicks on controls remain protected. Changing the binding, disconnecting, unloading the page, and leaving the call release the shortcut. Joining with push-to-talk enabled starts silent, including when the physical shortcut is already held.

The **Windows desktop app** registers a native keyboard or mouse hook during calls with push-to-talk enabled. The footer shows **Global** when connected. It is designed to work with another application focused or BetterComms minimized. The selected input still reaches the foreground application. No global input is registered when the feature is disabled or outside a call. Keyboard support includes letters, digits, modifiers, F1–F12, navigation, punctuation and numpad keys; unsupported keys report an error and keep microphone transmission silent.

The **browser and non-Windows hosts** use foreground input; losing focus or hiding the page releases the shortcut. OS/browser-reserved shortcuts may not reach the page. Microphone tests in Settings remain explicit local previews, independent of call push-to-talk. Settings are separate between browser and native profiles.

Wails unit tests cover registration ordering, heartbeat expiry, and cleanup. Packaged Windows background keyboard/mouse, minimized-window, game, and physical microphone acceptance remains a release gate. Foreground browser input remains available when native input is unavailable.

## Implementation

- `PushToTalkSettings.tsx`: opt-in settings and keyboard/mouse assignment.
- `media/pushToTalk.ts`: validated local preferences, input events, mute/deafen precedence, and subscription cleanup.
- `media/nativePushToTalk.ts`: session-scoped Wails events, one-second heartbeat, stale-event rejection and fail-closed microphone gating on native errors. DOM input cannot override a failed native registration.
- `apps/desktop-wails/internal/native/pushtotalk`: Windows native input registration with leased sessions and page-token-gated service calls.
- `CallStage.tsx`: observes separate transmission and manual mute/deafen states; participant presence reports manual mute/deafen, independently of waiting for the shortcut.
- `MediaEngine.setMicrophoneEnabled`: gates the processed call microphone, including pending device/denoiser replacements. WebRTC, server voice, and local microphone recording consume that same gated track. Camera, screen, system audio, and playback volume remain independent.

The native lease stops input observation when the renderer disconnects or stops sending heartbeats. Microphone gating still runs in the WebView; this is not a native hardware mute guarantee if the renderer itself hangs.

## Local startup and validation

Start the local API and browser frontend as described in the root README. For the Wails desktop host on Windows, run `./scripts/start-desktop-wails.ps1` after installing its documented prerequisites. Development auth remains opt-in and loopback-only.

Run `npm run build`, `npm test`, and `npx playwright test tests/push-to-talk.spec.ts tests/call-presence-ui.spec.ts tests/media-lifecycle.spec.ts`. Browser tests use synthetic media and do not validate global OS input. Run `go test ./...` and `go vet ./...` in `apps/desktop-wails`; complete physical Windows acceptance before claiming global push-to-talk reliability.
