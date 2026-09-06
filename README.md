# Bettercomms

A browser-first communication app for small groups, with a Go control plane and a Tauri desktop foundation. Direct-first WebRTC media stays separate from persistent messages and room membership.

## Run locally

Prerequisites: Node.js 24, Go 1.26, Docker Desktop, and PowerShell 7 on Windows.

```powershell
npm ci
docker compose up -d postgres
```

The root `.env` holds `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. It is ignored by Git; never prefix the API key with `VITE_`.

Start the API in one terminal:

```powershell
./scripts/start-api.ps1
```

Start the browser client in another:

```powershell
npm run dev
```

Open **http://localhost:5173**. WorkOS's allowed callback must include `http://localhost:5173/api/v1/auth/callback`. The API proxy keeps browser authentication and WebSocket signaling on the same origin.

For automated tests or a local test account, explicitly start the API with `./scripts/start-api.ps1 -DevAuth`. This reveals the local development login form and enables a loopback-restricted test endpoint. Normal startup does not enable this bypass. Use distinct browser profiles or private windows for distinct participants.

The API generates cryptographically random session tokens, stores only their hashes in PostgreSQL, and revokes the active session on logout. Docker's database binds only to loopback on port 54329 and persists in the `bettercomms_postgres-data` volume.

## Optional local relay

```powershell
./scripts/start-relay.ps1
```

Restart the API after starting the relay. The script generates a private coturn secret and configuration under `.local/`; authenticated clients receive short-lived relay credentials. This is a **local development service**, not an internet-reachable TURN deployment. Docker Desktop NAT, externally advertised addresses, TLS, firewall ports, and relay reachability must be configured and tested before friends on other networks can rely on it. Direct WebRTC also needs HTTPS outside localhost.

## What is implemented

- WorkOS authorization-code login, revocable sessions, and optional local development auth.
- PostgreSQL-backed friends, requests, private rooms, direct rooms, membership, and chat.
- Room permissions, membership removal, room management, and authenticated signaling.
- Browser microphone, camera, screen sharing, and shared audio where supported by the browser.
- Direct-first and direct-only WebRTC, configurable quality ceilings, and live media statistics.
- Cameras above or beside content, focus layout, screen zoom/pan/fullscreen, and local layout preferences.
- Per-person playback gain, optional voice leveling, and browser noise suppression.
- Per-track recording with an automatic local library, synchronized playback, independent audio volume/mute, video selection, and original-track downloads; see release notes for storage and capture limits.
- Optional RNNoise AudioWorklet adapter with a real browser signal and disposal test.
- Optional native NVIDIA Audio Effects processing on Windows, with an app-private Ada/RTX 40-series runtime and RNNoise fallback. See [NVIDIA setup](docs/NVIDIA_SETUP.md).

## Validation

With PostgreSQL, the API in explicit development-auth mode, and Vite running:

```powershell
npm run build
npm test
npx playwright install chromium
npm run test:e2e
Push-Location server
$env:TEST_DATABASE_URL='postgres://bettercomms:local-development-only@127.0.0.1:54329/bettercomms?sslmode=disable'
go test ./...
go vet ./...
Pop-Location
```

The browser suite uses two isolated authenticated browser contexts against the real backend/database. Camera and microphone devices are synthetic. Screen-share transport is tested with a synthetic canvas stream; it does **not** prove native game capture, actual screen-picker behavior, GPU encoding, or connectivity between two external networks. Test traces and screenshots go to ignored `test-results/` and `playwright-report/`.

## Native desktop and remaining scope

`apps/desktop/` contains a Tauri 2 host with minimal capabilities and explicit native feature reporting. Visual Studio C++ Build Tools is installed on this Windows host; MSVC checks and the desktop test suite pass. The native development preview runs against the local Vite server; see [desktop setup](apps/desktop/README.md). Packaged desktop authentication/API routing, native process-specific game audio, native GPU capture, Krisp integration, continuous rewind, in-progress recording crash recovery, signed installers, and macOS/Linux parity remain release gates—not claimed working features.

Read [the product spec](docs/PRODUCT_SPEC.md), [implementation matrix](docs/IMPLEMENTATION_MATRIX.md), [desktop validation](docs/DESKTOP_VALIDATION.md), [native roadmap](docs/NATIVE_MEDIA_ROADMAP.md), and [server protocol](server/PROTOCOL.md).

## Repository

```text
apps/web/       React client and browser media engine
apps/desktop/   Tauri shell and native capability boundary
server/        Go API, signaling, migrations, authorization tests
tests/         Browser integration and media tests
scripts/       Local service launchers
docs/          Specification, acceptance criteria, known limitations
```

No cloud deployment or public exposure is performed by the local setup.
