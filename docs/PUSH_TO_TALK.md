# Push-to-talk (local development)

Push-to-talk is **off by default**. Open **Settings → Voice & devices → Push-to-talk**, enable it, select **Set push-to-talk shortcut**, and press a keyboard key or click a mouse button on that control. Left, middle, right, back and forward mouse buttons are supported when the browser delivers them. Escape cancels assignment; Tab and Windows/Command remain reserved. Disable the checkbox to return to the ordinary microphone behavior. Preferences are saved per browser profile and origin.

During a call, hold the shortcut to transmit microphone audio and release it to stop. The footer shows the shortcut and transmission state. Manual mute and deafen take priority; unmuting or undeafening requires a fresh shortcut press. Typing and interacting with BetterComms controls does not open the microphone. Changing the binding, disconnecting, unloading the page, and leaving the call release the shortcut. Joining with push-to-talk enabled starts silent, including when the physical shortcut is already held.

The **Windows desktop app** registers a native keyboard or mouse hook during calls with push-to-talk enabled. The footer shows **Global** when connected. It is designed to work with another application focused or BetterComms minimized. The selected input still reaches the foreground application. No global input is registered when the feature is disabled or outside a call. Keyboard support includes letters, digits, modifiers, F1–F12, navigation, punctuation and numpad keys; unsupported keys report an error and keep the call microphone muted.

The **browser and non-Windows hosts** use foreground input; losing focus or hiding the page releases the shortcut. OS/browser-reserved shortcuts may not reach the page. Microphone tests in Settings remain explicit local previews, independent of call push-to-talk. Settings are separate between browser and native profiles.

Native acceptance passed against the actual Windows host on an unlocked desktop: background keyboard press/release, all five mouse buttons, keyboard and mouse while minimized, input passthrough to a separate WinForms application, manual mute/deafen, rebinding, leave/rejoin with an already-held button, heartbeat expiry and origin rejection. Tests use Windows `SendInput` and synthetic audio through the real call engine. Physical microphones, games with anti-cheat, elevated applications, exclusive fullscreen and cross-network audio have not been validated by these tests.

Acceptance exposed a WebView2 focus issue after restoring the window: `document.hasFocus()` could remain true while Windows had another app in the foreground. Native input snapshots now include the actual Tauri window focus. This preserves the guard for focused BetterComms controls without blocking background input when Settings retains DOM focus. The controller regression test also covers that mismatch.

## Implementation

- `PushToTalkSettings.tsx`: opt-in settings and keyboard/mouse assignment.
- `media/pushToTalk.ts`: validated local preferences, input events, mute/deafen precedence, and subscription cleanup.
- `media/nativePushToTalk.ts`: session-scoped Tauri events, one-second heartbeat, stale-event rejection and fail-closed microphone gating on native errors. DOM input cannot override a failed native registration.
- `apps/desktop/src-tauri/src/push_to_talk.rs`: Windows physical key/mouse matching, pass-through hooks on a dedicated message thread, five-second registration lease, release reconciliation, and trusted main-window commands. Only the selected binding's pressed/released state crosses IPC; no text or unrelated input is recorded. The hook callback posts work and returns immediately, following the [Windows keyboard](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc) and [mouse hook](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc) requirements.
- `CallStage.tsx`: observes the input controller and publishes actual microphone state to participants.
- `MediaEngine.setMicrophoneEnabled`: gates the processed call microphone, including pending device/denoiser replacements. WebRTC, server voice, and local microphone recording consume that same gated track. Camera, screen, system audio, and playback volume remain independent.

The native lease stops input observation when the renderer disconnects or stops sending heartbeats. Microphone gating still runs in the WebView; this is not a native hardware mute guarantee if the renderer itself hangs.

## Local startup on this Windows machine

Windows reserves the repository's usual PostgreSQL port `54329` here. The private `.local/compose.local.yaml` overrides only the loopback database mapping with `55432`. No database data or Docker volumes need to be deleted.

From the repository root, start Docker Desktop, then:

```powershell
npm ci
docker compose -f compose.yaml -f .local/compose.local.yaml up -d postgres
./scripts/start-api.ps1 -DevAuth -DatabasePort 55432
```

In a second terminal:

```powershell
npm run dev
```

Open **http://localhost:5173** and use **Enter local workspace** with a name and local test email. Create a room and join it. Use another browser profile/private window and another email for a second participant; add them as a friend and invite them to the room. Development auth remains explicitly enabled and loopback-only; WorkOS secrets are unnecessary for this local flow.

To recreate the private override on a fresh checkout:

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
@'
services:
  postgres:
    ports: !override
      - '127.0.0.1:55432:5432'
'@ | Set-Content .local/compose.local.yaml
```

The default launcher still uses `54329` unless `-DatabasePort` is supplied.

For global input, install the separate desktop dependencies once and launch the native development window from the repository root:

```powershell
npm --prefix apps/desktop ci
./scripts/start-desktop.ps1
```

The launcher reuses this workspace's Vite server, rebuilds the Rust command table, and selects stable Visual Studio C++ Build Tools when no developer shell was explicitly selected. This avoids this machine's incomplete Visual Studio preview installation. Close any previous BetterComms desktop window before running the launcher. This remains the local Vite/API development flow; packaged authentication is outside this change.

## Validation

```powershell
npm run build
npm test
npx playwright test tests/push-to-talk.spec.ts tests/call-presence-ui.spec.ts tests/media-lifecycle.spec.ts
```

Browser tests use the real local API/PostgreSQL, isolated accounts, and synthetic media. They check opt-in persistence, keyboard/mouse assignment, decoded microphone signal/silence, mute/deafen precedence, replacement, focus release, and rejoining. They do not establish physical microphone quality, global game shortcuts, native capture, or cross-network connectivity.

Side-button acceptance uses Chromium input events to verify both Back and Forward can be assigned and held without navigating history. The microphone release consumes the matching mouse-up event as well as suppressing auxiliary clicks.

The browser checkpoint passed its production build, 80 unit tests, 76 browser tests (one optional TURN test skipped), and Go tests/vet against Docker PostgreSQL on port 55432. The native integration passes the production frontend build, 93 unit tests, `cargo check`, debug `cargo build`, and Rust tests (55 passed, 11 unrelated native acceptance tests ignored). The final full browser regression run passed 76 tests without retries; one optional TURN test was skipped. No Go server code changed during native integration.

React Doctor reports 47/100 for the native integration's changed files; the broader browser checkpoint/original component baseline was 43/100. The subsets differ. The existing `CallStage` complexity warning remains. Its two state-updater diagnostics refer to callbacks passed to the ordinary asynchronous `perform(fn)` helper, which is not a React state setter. No lint configuration was changed to hide these diagnostics.

### Native acceptance

Use an isolated debug host with an unlocked Windows desktop. These test-only WebView2 flags must not be used for ordinary microphone use. With Vite/API running, close any previous native test host, then run from the repository root:

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path (Get-Location) '.local/native-ptt-profile'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9226 --remote-debugging-address=127.0.0.1 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream'
$testHost = Start-Process ./apps/desktop/src-tauri/target/debug/bettercomms-desktop.exe -WindowStyle Hidden -PassThru
$testHost.Id | Set-Content .local/native-ptt-process
try {
    node scripts/test-native-push-to-talk.mjs
} finally {
    Stop-Process -Id $testHost.Id -ErrorAction SilentlyContinue
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
}
```

The full script uses a separate WinForms test window, Windows `SendInput`, the actual Tauri command/event bridge, synthetic audio, and the real call engine. It asserts foreground ownership before injecting presses, background key down/up, all five mouse buttons with passthrough, minimized keyboard/mouse operation, rebinding, manual mute/deafen, leave/rejoin with already-held input, watchdog expiry and origin rejection. Shortcut assignment uses the Settings UI handlers; background holds use actual OS input. Playwright connects with `noDefaults` to avoid forced focus emulation. The fixture restores only the verified test-host process through Windows, without adding app permissions for test automation. It releases injected inputs and closes its fixture in cleanup.

For the independently runnable native registration/lease/origin checks, use `node scripts/test-native-push-to-talk.mjs --lifecycle-only`. Both this mode and the full native input suite have passed. Lifecycle-only mode does not test OS input or background microphone behavior.
