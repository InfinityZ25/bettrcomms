fn main() {
    #[cfg(all(windows, target_arch = "x86_64"))]
    prepare_windows_ffmpeg_resources();
    tauri_build::build();
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn prepare_windows_ffmpeg_resources() {
    const FFMPEG_BYTES: u64 = 223_360_000;
    const LICENSE_BYTES: u64 = 35_147;

    let dir = std::path::Path::new("generated/ffmpeg/windows-x64");
    let ffmpeg = dir.join("ffmpeg.exe");
    let license = dir.join("LICENSE");
    let setup = dir.join("setup.json");
    let source = dir.join("SOURCE.txt");
    for path in [&ffmpeg, &license, &setup, &source] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let complete = file_len(&ffmpeg) == Some(FFMPEG_BYTES)
        && file_len(&license) == Some(LICENSE_BYTES)
        && setup.is_file()
        && source.is_file();
    if complete {
        return;
    }

    if std::env::var("PROFILE").ok().as_deref() == Some("release") {
        panic!(
            "Windows release builds require the pinned FFmpeg 8.1 bundle at {}.\n\
             From the repository root run: ./scripts/prepare-ffmpeg-bundle.ps1\n\
             Development (`npm run dev`) does not need this bundle; native sharing uses the private app-data runtime or WinGet fallback.",
            dir.display()
        );
    }

    // tauri-build rejects missing bundle.resources paths even for `tauri dev`.
    // These placeholders are the wrong size, so ffmpeg_setup::installed() ignores them.
    std::fs::create_dir_all(dir).expect("create generated ffmpeg resource directory");
    std::fs::write(&ffmpeg, []).expect("write development ffmpeg placeholder");
    std::fs::write(&license, []).expect("write development LICENSE placeholder");
    std::fs::write(
        &setup,
        br#"{"schemaVersion":1,"developmentPlaceholder":true}"#,
    )
    .expect("write development setup.json placeholder");
    std::fs::write(
        &source,
        b"Development placeholder. Run scripts/prepare-ffmpeg-bundle.ps1 before a Windows installer build.\n",
    )
    .expect("write development SOURCE.txt placeholder");
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn file_len(path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}
