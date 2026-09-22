# Wails migration PR handoff

This PR delivers the current migration for review at the user's request. It is
**not ready to replace Tauri**. Deployment is excluded; incomplete work below
remains in scope rather than being declared complete. Preserve `apps/desktop`.

## Implemented

- Separate `apps/desktop-wails` host pinned to Wails v3.0.0-beta.18, sharing the
  React/Vite frontend and retaining the Tauri runtime path.
- Wails native non-client region configuration and CSS. Removed the redundant
  Go WindowService and generated bindings; controls use the built-in Window API.
- API proxy, external-browser authentication flow, Windows credential storage,
  content policy and explicit default WebView2 camera/microphone permissions.
- Go implementations and frontend adapters for native FFmpeg/capture/WebRTC,
  process audio, recording/export, background PTT, overlays and optional DSP.
  Implementation is not proof of end-to-end hardware or packaged acceptance.
- Verified FFmpeg bundle staging, per-user Windows installer, locked-file
  protection and Windows CI validation/artifact jobs. No deployment/release.

## Merge/replacement blockers and missing work

1. **Native window revalidation:** the previous native build reported window
   action failure. A reproduced JS bundle initialisation failure is now fixed:
   keep Wails runtime modules together to avoid reading `objectNames.Call` before
   initialisation across cyclic chunks. The compiled-runtime browser regression
   passes, but a rebuilt native host still needs validation. Do not restore
   a custom Go window service to work around this. Validate native dragging,
   resize, minimize/maximize/restore/close, Snap Layouts, focus and mixed DPI.
2. **Native end-to-end acceptance:** actual packaged calls, capture, process
   audio, export dialogs/file fidelity, background PTT, overlays, DSP fallback,
   renderer stalls, resource cleanup and cross-network delivery remain open.
   NVIDIA/Intel hardware and sustained gaming load are not established here.
3. **Security/auth:** complete top-level navigation restriction and per-document
   token lifecycle are missing. CSP is not a navigation firewall. Real packaged
   WorkOS completion, device prompts and stored-grant behavior require acceptance.
4. **Data/platform parity:** migration of Tauri preferences and local recording
   libraries is missing. macOS packaging and secure credential storage outside
   Windows are incomplete; Windows tests do not prove other platforms.
5. **Packaging/installers:** WebView2 is a prerequisite, not provisioned by this
   installer. Changing-version upgrades, transactional rollback, signing and
   optional DSP fresh-install/cancel/rollback acceptance remain outstanding.
6. **Regression/CI:** the last full browser run was 90 passed, 1 failed, 1 opt-in
   TURN skip. The integral call/recording test remains intermittently failing.
   Initial Windows CI failed in `TestResolveInstallVerifiesEveryPath` and
   `TestTrustedFileRefusesAnythingOutsideTheSetupDirectory`: valid fixture paths
   were rejected as outside their private directories. This remains unresolved;
   no remote green result is claimed.
7. **Documentation/capabilities:** older scaffold-era sections still need a full
   reconciliation. Use the chronological completion ledger for actual evidence,
   not a claim of full parity from feature names or implementation presence.

## Validation evidence and limits

- Frontend: 232 unit tests and production build passed before handoff.
- Wails: Go tests/vet and production host compilation passed before handoff.
- Windows installer: install, same-version reinstall, locked-payload refusal and
  uninstall preservation passed on the earlier installer revision. Those results
  do not validate a rebuilt installer containing the latest permission/CSP changes.
- Browser tests use synthetic media and do not prove native Windows acceptance.
- An isolated diagnostic uses the **real compiled JS runtime** with mocked host
  HTTP responses. It now passes state/minimise/maximise/close under CSP and is
  part of the normal Playwright suite. Native hit testing is not simulated proof.

Run the packaged-runtime regression from repository root:

```powershell
npm run build
npx playwright test tests/wails-runtime.spec.ts
```

The diagnostic needs no account, backend or database and sends no external
requests. It is narrower than a real WebView2 test and does not identify the
native root cause by itself. Desktop automation was stopped when the user
pressed Escape; no login or permission dialogs were automated.

See [completion ledger](WAILS_COMPLETION.md) for detailed prior checks.
