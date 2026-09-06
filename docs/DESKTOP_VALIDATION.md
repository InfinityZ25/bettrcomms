# Desktop validation record

Date: 2026-09-05. Host: Windows x86-64.

## Completed checks

- Installed Rust 1.98.1 stable MSVC with the minimal rustup profile. The installer was run with `--no-modify-path`, so it did not alter the user's global `PATH`.
- `cargo metadata --no-deps` succeeds for `apps/desktop/src-tauri/Cargo.toml`.
- `cargo fmt --check` succeeds.
- `package.json`, `tauri.conf.json`, and `capabilities/main.json` parse as JSON.
- Cargo resolved and locked the Tauri dependency graph in `Cargo.lock`.
- Installed Visual Studio Build Tools 2022 17.14.39 with the Microsoft VC tools workload and recommended components. `vswhere` reports the instance complete and launchable with no reboot required.
- `cargo check` succeeds on `x86_64-pc-windows-msvc`.
- `cargo test` succeeds: 2 passed, 0 failed. The tests keep native recording unavailable and validate the debug loopback API-origin default.
- `tauri build --no-bundle` succeeds after its production web build. The optimized executable was produced at `apps/desktop/src-tauri/target/release/bettercomms-desktop.exe` in 1 minute 30 seconds.

## Resolved toolchain gate

The first official `winget` installation attempt exited with Windows code 1602 before installing components. After the user approved the Windows security prompts, a second installation of `Microsoft.VisualStudio.2022.BuildTools` with `Microsoft.VisualStudio.Workload.VCTools`, recommended components, quiet mode, and no reboot succeeded.

A secondary GNU toolchain check had failed at Windows import-library creation. That diagnostic result is superseded by the successful required MSVC checks.

The validated commands are:

```powershell
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm --prefix apps/web run build
npm --prefix apps/desktop run build
```

The initial MSVC check exposed one scaffold defect: Tauri's Windows resource step required `icons/icon.ico`. A source SVG and the standard Tauri-generated platform icon set were added, after which check, test, and release build passed. This validates compilation and asset embedding. It does not validate packaged WorkOS authentication, installer signing, updater behavior, or the runtime smoke tests in `DESKTOP_BOOT.md`; bundling remains intentionally disabled.

## Native capability boundary

The native development preview launched successfully using the existing Vite server on port 5173. Windows reported its `BetterComms` window responding. This confirms development window startup; packaged authentication and physical media-device acceptance remain pending.

No native Windows Graphics Capture or process-loopback implementation was added during this validation. OS-version or DLL presence alone would only show that an API might exist; it would not prove source permission, graphics-device creation, a usable frame, or isolated process audio. The current Rust report therefore keeps those capabilities experimental and explicitly says it produces no native frames or loopback session.
