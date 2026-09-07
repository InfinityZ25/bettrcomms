# Push-to-talk (local development)

Push-to-talk is **off by default**. Open **Settings → Voice & devices → Push-to-talk**, enable it, select **Set push-to-talk shortcut**, and press a keyboard key or click a mouse button on that control. Left, middle, right, back and forward mouse buttons are supported when the browser delivers them. Escape cancels assignment; Tab and Windows/Command remain reserved. Disable the checkbox to return to the ordinary microphone behavior. Preferences are saved per browser profile and origin.

During a call, hold the shortcut to transmit microphone audio and release it to stop. The footer shows the shortcut and transmission state. Manual mute and deafen take priority; unmuting or undeafening requires a fresh shortcut press. Typing and interacting with controls does not open the microphone. Changing the binding, losing window focus, hiding the page, disconnecting, and leaving the call release the shortcut. Joining with push-to-talk enabled starts silent.

This implementation handles browser/WebView input while BetterComms has focus. It does **not** install native global keyboard/mouse hooks, and cannot provide background push-to-talk while a game or another application has focus. OS/browser-reserved shortcuts may not reach the page. Microphone tests in Settings remain explicit local previews, independent of call push-to-talk.

## Implementation

- `PushToTalkSettings.tsx`: opt-in settings and keyboard/mouse assignment.
- `media/pushToTalk.ts`: validated local preferences, input events, mute/deafen precedence, and subscription cleanup.
- `CallStage.tsx`: observes the input controller and publishes actual microphone state to participants.
- `MediaEngine.setMicrophoneEnabled`: gates the processed call microphone, including pending device/denoiser replacements. WebRTC, server voice, and local microphone recording consume that same gated track. Camera, screen, system audio, and playback volume remain independent.

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

## Validation

```powershell
npm run build
npm test
npx playwright test tests/push-to-talk.spec.ts tests/call-presence-ui.spec.ts tests/media-lifecycle.spec.ts
```

Browser tests use the real local API/PostgreSQL, isolated accounts, and synthetic media. They check opt-in persistence, keyboard/mouse assignment, decoded microphone signal/silence, mute/deafen precedence, replacement, focus release, and rejoining. They do not establish physical microphone quality, global game shortcuts, native capture, or cross-network connectivity.

Side-button acceptance uses Chromium input events to verify both Back and Forward can be assigned and held without navigating history. The microphone release consumes the matching mouse-up event as well as suppressing auxiliary clicks.

Local validation completed: production build, 80 unit tests, 76 browser tests (one optional TURN test skipped), and Go tests/vet against Docker PostgreSQL on port 55432. The final full browser run used a freshly restarted Vite server and passed without retries. An earlier run had loopback measurement failures; they did not reproduce after restarting Vite with `--force`. No loopback assertions were changed.

React Doctor reports 43/100 for the changed React components, matching the score from the original `CallStage`/`DeviceSettings` baseline. Existing component-complexity warnings remain. Its two state-updater diagnostics refer to callbacks passed to the ordinary asynchronous `perform(fn)` helper, which is not a React state setter. No lint configuration was changed to hide these diagnostics.
