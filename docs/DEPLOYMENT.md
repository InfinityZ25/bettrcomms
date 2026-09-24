# Hosted preview and desktop builds

The hosted preview uses one Railway Go service to serve the Vite production files, API and WebSockets at `https://bettrcomms-production.up.railway.app`. PostgreSQL is a separate Railway service accessed through its private network. Vercel is not required.

## Deploy

The root Dockerfile builds both applications and runs as a non-root user. Configure `DATABASE_URL` using Railway's Postgres variable reference, `APP_URL`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and `WORKOS_REDIRECT_URI`. Set `DEV_AUTH=false`, `COOKIE_SECURE=true`, and `PORT=8080`. The WorkOS callback is `/api/v1/auth/callback` on the app origin. Never put server secrets in Vite variables or Git. `railway up --service bettrcomms --detach` deploys the current source. Migrations run before the API starts; `/healthz` gates routing.

The initial preview retains the existing WorkOS **Staging** environment and users. Railway's environment name “production” does not switch WorkOS to production. An actual WorkOS sign-in remains an interactive acceptance check. The service currently has one replica: live rooms and OAuth state are in memory, so deployments disconnect calls and invalidate pending login attempts. Database sessions and chat persist.

`railway.json` is the currently supported configuration used for this deployment. Railway reports its config-as-code format will retire on December 1, 2026; migrate to Railway Infrastructure as Code before then.

## Native downloads

The **Wails desktop preview release** GitHub Actions workflow builds a Windows x64 NSIS installer and separate macOS Apple Silicon/Intel `.app` ZIP archives. Run it manually for test artifacts. Pushing a `wails-v<version>` tag matching `apps/desktop-wails/package.json` publishes those artifacts as a GitHub prerelease after all three builds pass. These preview builds are unsigned and macOS is not notarized; packaged sign-in and native media acceptance remain open in `WAILS_COMPLETION.md`.

Wails release builds embed the shared frontend and pin `https://app.bettrcomms.com` as their API origin. The host proxies API and WebSocket traffic through an authenticated loopback service and opens WorkOS sign-in in the system browser. The hosted UI is trusted application code, so GitHub/Railway access is part of the application's trust boundary. The older Tauri release configuration remains in the repository for its existing clients.

Changing the hosted domain requires updating the Wails release origin, the workflow build origin, Railway app/callback variables, and WorkOS's redirect list together. The Wails and Tauri origin tests check their current agreement.

Windows native capture requires the FFmpeg runtime described in NATIVE_SHARING.md. Version 0.1.10 packages the verified runtime in Windows installers; the 0.1.1 private app-storage downloader remains a repair fallback and a global WinGet installation is optional. Run `scripts/prepare-ffmpeg-bundle.ps1` before a local Windows Tauri bundle; CI does this automatically and the generated 213 MiB resource is ignored by Git. NVIDIA/DirectML runtimes remain separately provisioned through their documented flows; installers do not copy proprietary runtimes from the development machine. macOS currently uses WebView-supported microphone/camera/browser capture; Windows capture, system audio and GPU denoising adapters are not macOS implementations. A successful Mac compile is not a physical-device acceptance test.

Version 0.1.1 also changes the Windows playback policy and native screen ICE handling. Both participants need the new binary for these changes; hosted UI deployment alone does not update native code. `scripts/test-hosted-desktop.mjs` checks audio context startup without a user gesture and the FFmpeg setup IPC, using a fresh isolated profile with no test autoplay flag.

## Connectivity limits

The hosted Go service relays signaling/chat and offers an encrypted microphone-only WebSocket fallback when direct WebRTC fails. STUN assists direct peer discovery. Server voice is visible in connection diagnostics and can be selected explicitly in Settings → Connection. Direct-only mode disables it. See [server voice](VOICE_RELAY.md) for encryption, buffering, runtime support, and the signaling trust model.

Camera, screen video, and shared system/application audio still require WebRTC connectivity. A production TURN deployment is still needed for those sources on restrictive NATs and networks; Railway's HTTP service alone does not supply a UDP media relay. TCP fallback can stall on packet loss. Native congestion adaptation and large-group scaling remain outside this preview.

The public repository has no project-wide reuse license selected yet. Third-party notices retain their individual licenses; publication alone does not license BetterComms source under MIT or another open-source license.

Automatic deployment note: the Railway source is linked to GitHub, but the current connection did not create repository push triggers. The CLI account cannot issue project deployment tokens (`Not Authorized`), so no token-backed GitHub deploy job is installed. Deployment remains `railway up --service bettrcomms --detach` from an authenticated machine until Railway GitHub App access or an environment-scoped deployment token is configured. This does not affect the running app/database.
