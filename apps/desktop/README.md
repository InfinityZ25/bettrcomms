# BetterComms desktop host

This is the initial Tauri 2 host for the sibling Vite application at `../web`. The web app remains the working media implementation. The Rust command `desktop_media_capabilities` reports the desktop adapter's real state and deliberately does not claim native Windows capture is complete.

From this directory:

```powershell
npm install
npm run dev
npm run build
```

`npm run dev` expects the local Go API and PostgreSQL to already be running.
From the repository root, start them in a separate terminal first:

```powershell
docker compose up -d postgres
./scripts/start-api.ps1 -DevAuth
```

The desktop launcher checks `http://127.0.0.1:8080/healthz` before starting
Vite and Tauri and reports these commands if the API is unavailable.

Development starts the sibling web app at `http://localhost:5173`. Production builds consume `../web/dist` (expressed as `../../web/dist` because Tauri resolves `frontendDist` from `src-tauri`). Rust and the Tauri Windows prerequisites are required. Bundling is disabled until installer identity, signing, icons, and updater policy are decided.

The capability file grants only core app, event, and window defaults. There is no shell, filesystem, process, HTTP, or global-shortcut plugin.

Windows push-to-talk uses dedicated native keyboard/mouse hooks and four restricted app commands, without a global-shortcut plugin. It is disabled by default and enabled in Settings. See [push-to-talk setup and validation status](../../docs/PUSH_TO_TALK.md). For local development, prefer `./scripts/start-desktop.ps1` from the repository root: it reuses the workspace Vite server and initializes stable Visual Studio Build Tools. The desktop dependencies remain separately installable with `npm --prefix apps/desktop ci`.

`desktop_boot_config` validates `BETTERCOMMS_API_ORIGIN`. Debug builds default to `http://127.0.0.1:8080`; production requires an HTTPS origin containing no credentials, path, query, or fragment. The current web client still uses relative `/api` URLs and does not consume this command, so packaged authentication/API access is not implemented. See `docs/DESKTOP_BOOT.md` before enabling bundles.

The latest toolchain results are recorded in `docs/DESKTOP_VALIDATION.md`. This Windows host now has Rust 1.98.1 and Visual Studio Build Tools 2022 17.14.39 with the VC workload. MSVC `cargo check`, both Rust unit tests, and `tauri build --no-bundle` pass.

To preview the native WebView against a Vite server that is already running on port 5173 without starting a duplicate frontend:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm exec --yes --package @tauri-apps/cli@2 -- tauri dev --no-watch --config '{"build":{"beforeDevCommand":""}}'
```

This development preview uses Vite's `/api` proxy and development authentication. It does not make the packaged asset-origin API or WorkOS return flow functional; those remain gated by `docs/DESKTOP_BOOT.md`.
