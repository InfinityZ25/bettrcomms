# Hosted preview and desktop builds

The hosted preview uses one Railway Go service to serve the Vite production files, API and WebSockets at `https://bettrcomms-production.up.railway.app`. PostgreSQL is a separate Railway service accessed through its private network. Vercel is not required.

## Deploy

The root Dockerfile builds both applications and runs as a non-root user. Configure `DATABASE_URL` using Railway's Postgres variable reference, `APP_URL`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and `WORKOS_REDIRECT_URI`. Set `DEV_AUTH=false`, `COOKIE_SECURE=true`, and `PORT=8080`. The WorkOS callback is `/api/v1/auth/callback` on the app origin. Never put server secrets in Vite variables or Git. `railway up --service bettrcomms --detach` deploys the current source. Migrations run before the API starts; `/healthz` gates routing.

The initial preview retains the existing WorkOS **Staging** environment and users. Railway's environment name “production” does not switch WorkOS to production. An actual WorkOS sign-in remains an interactive acceptance check. The service currently has one replica: live rooms and OAuth state are in memory, so deployments disconnect calls and invalidate pending login attempts. Database sessions and chat persist.

`railway.json` is the currently supported configuration used for this deployment. Railway reports its config-as-code format will retire on December 1, 2026; migrate to Railway Infrastructure as Code before then.

## Native downloads

Run the **Desktop release bundles** GitHub Actions workflow, or push a `v*` tag. It produces Windows x64 NSIS/MSI installers and macOS Apple Silicon/Intel DMGs. Artifacts are attached to the workflow run. These initial builds are unsigned and macOS is not notarized; signing credentials are not configured.

Release builds use `apps/desktop/src-tauri/tauri.release.conf.json` to load the pinned HTTPS app origin in the native WebView. This keeps HttpOnly authentication cookies and WebSockets on one origin. The usual Tauri development command still loads localhost. Native commands reject pages outside the app's exact origin, and remote plugin capabilities permit only that origin. Authentication pages receive no native permissions. The hosted UI is trusted application code: deploying it updates the UI of installed clients, so GitHub/Railway access is part of the native application's trust boundary. No system-browser OAuth return flow or offline startup is implemented.

Changing the hosted domain requires updating the release window URL, capability allowlist, `RELEASE_ORIGIN`, Railway app/callback variables, and WorkOS's redirect list together. A Rust test checks the three desktop declarations remain consistent.

Windows native capture requires the existing FFmpeg runtime described in NATIVE_SHARING.md. NVIDIA/DirectML runtimes remain separately provisioned through their documented flows; installers do not bundle the development machine's proprietary runtimes. macOS currently uses WebView-supported microphone/camera/browser capture; Windows capture, system audio and GPU denoising adapters are not macOS implementations. A successful Mac compile is not a physical-device acceptance test.

## Connectivity limits

The hosted Go service relays signaling/chat and offers an encrypted microphone-only WebSocket fallback when direct WebRTC fails. STUN assists direct peer discovery. Server voice is visible in connection diagnostics and can be selected explicitly in Settings → Connection. Direct-only mode disables it. See [server voice](VOICE_RELAY.md) for encryption, buffering, runtime support, and the signaling trust model.

Camera, screen video, and shared system/application audio still require WebRTC connectivity. A production TURN deployment is still needed for those sources on restrictive NATs and networks; Railway's HTTP service alone does not supply a UDP media relay. TCP fallback can stall on packet loss. Native congestion adaptation and large-group scaling remain outside this preview.

The public repository has no project-wide reuse license selected yet. Third-party notices retain their individual licenses; publication alone does not license BetterComms source under MIT or another open-source license.

Automatic deployment note: the Railway source is linked to GitHub, but the current connection did not create repository push triggers. The CLI account cannot issue project deployment tokens (`Not Authorized`), so no token-backed GitHub deploy job is installed. Deployment remains `railway up --service bettrcomms --detach` from an authenticated machine until Railway GitHub App access or an environment-scoped deployment token is configured. This does not affect the running app/database.
