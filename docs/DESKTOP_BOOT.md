# Desktop boot and authentication contract

## Verified repository behavior

The Vite development server proxies `/api` and matching WebSocket upgrades to `http://127.0.0.1:8080`. `scripts/start-desktop.ps1` enters through `npm run dev` and Tauri's development runner, so it rebuilds the Rust host and starts the matching Vite frontend when the Go API is running locally.

Do not launch `apps/desktop/src-tauri/target/debug/bettercomms-desktop.exe` directly during development. That executable has no Rust source watcher. It can continue loading the current Vite page while exposing an older native IPC command table, which makes newly added commands fail with `Command ... not found`. The guarded launcher refuses to start when another Bettercomms executable from this workspace is already running; close the existing window normally and rerun it instead of layering another native host over the same frontend.

From the repository root, use separate terminals:

```powershell
./scripts/start-api.ps1 -DevAuth
./scripts/start-desktop.ps1
```

The desktop package is separately installable and is not a root npm workspace. Run its commands from `apps/desktop` or use `npm --prefix apps/desktop ...`; do not use `npm run ... -w apps/desktop`. The project uses npm and preserves `package-lock.json`.

Production is different. Tauri loads `apps/web/dist` from its application protocol. The current web client constructs HTTP, WebSocket, login, and logout locations from relative `/api` paths. Those resolve against the Tauri asset origin, where no Go API exists. Consequently the current packaged shell can render static UI but cannot safely complete API or WorkOS authentication. This is an explicit unavailable capability, not a packaging defect to hide with CSP or a permissive proxy.

## Required production design

The web transport layer must consume one normalized API origin. In a browser deployment it may remain same-origin. In Tauri it must obtain the origin from the typed `desktop_boot_config` command. That command accepts debug loopback HTTP and requires HTTPS for production; it rejects credentials, paths, query strings, and fragments. HTTP and WebSocket URL construction must share this origin and convert `https` to `wss`.

The release build must inject the exact API and WebSocket origins into CSP through an environment-specific Tauri configuration. The checked-in default only permits the local development endpoints. Do not broaden production `connect-src` to all HTTPS hosts.

WorkOS sign-in for desktop must use the system browser. The Go server starts authorization with PKCE and a cryptographically random state bound to the initiating desktop session. The registered HTTPS callback terminates at the Go server; it exchanges the code server-side, then returns a short-lived, single-use handoff to the app through a registered deep link or a random-port loopback listener. The app validates state, redeems the handoff over HTTPS, and stores only the intended session material in OS-protected storage. Raw WorkOS client secrets never ship in the desktop binary.

Deep-link and secure-storage plugins require separate, narrowly scoped Tauri capabilities and platform configuration. Neither is present today. Until that implementation and the tests below pass, the desktop report must keep `authReturn` unavailable and bundling disabled.

## Acceptance tests

1. Development loads through port 5173, reaches the Go API through the Vite proxy, upgrades the room WebSocket, logs in with the allowed development mechanism, and logs out.
2. A packaged test build loads assets with no Vite process and sends API/WebSocket traffic only to the configured HTTPS/WSS origins.
3. Production startup fails closed with a readable configuration error when the API origin is missing, plaintext, contains credentials, or includes a path/query/fragment.
4. WorkOS login opens the system browser; cancellation, state mismatch, expired handoff, replay, wrong local user, and callback received after app restart all have bounded outcomes.
5. A hostile webview navigation cannot invoke a handoff for another state, read stored session material, or redirect the API client to an arbitrary origin.
6. Logout revokes/clears the server session and OS-protected local material. Account/session revocation reaches an already-open WebSocket.
7. The built capability manifest contains only reviewed deep-link and secure-storage permissions plus the existing core permissions; shell, process execution, and unrestricted filesystem remain absent.

## Current status

| Item | Status | Evidence |
|---|---|---|
| Vite-to-Go development proxy | Implemented in web Vite config | Relative HTTP and WebSocket paths route to loopback API |
| Tauri production asset path | Build verified | `tauri build --no-bundle` builds `apps/web/dist` and embeds it in the optimized executable |
| Desktop API-origin validation command | Implemented; MSVC check and unit tests pass | Rejects unsafe production origins |
| Frontend use of desktop origin | Unavailable | Web API module hardcodes relative `/api` |
| WorkOS system-browser return | Unavailable | No deep-link/loopback handoff or secure storage plugin |
| Signed/bundled desktop | Unavailable | Bundling intentionally disabled |
