use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, TryLockError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const INSTALL_SCRIPT: &str = include_str!("../../../../scripts/install-ffmpeg-runtime.ps1");
const DOWNLOAD_BYTES: u64 = 247_913_948;
const FFMPEG_BYTES: u64 = 223_360_000;
const LICENSE_BYTES: u64 = 35_147;
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInstallInfo {
    supported: bool,
    installed: bool,
    download_bytes: u64,
    installed_bytes: u64,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInstallResult {
    installed: bool,
    restart_required: bool,
}

fn app_root() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| path.join("Bettercomms"))
        .ok_or_else(|| "Local application directory is unavailable".to_owned())
}

fn install_root() -> Result<PathBuf, String> {
    Ok(app_root()?.join("ffmpeg-8.1"))
}

fn valid_file(path: &Path, bytes: u64) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == bytes)
}

fn installed(root: &Path) -> bool {
    installed_with_sizes(root, FFMPEG_BYTES, LICENSE_BYTES)
}

fn installed_with_sizes(root: &Path, ffmpeg_bytes: u64, license_bytes: u64) -> bool {
    valid_file(&root.join("ffmpeg.exe"), ffmpeg_bytes)
        && valid_file(&root.join("LICENSE"), license_bytes)
        && root.join("setup.json").is_file()
}

pub(crate) fn runtime_path() -> Option<PathBuf> {
    install_root()
        .ok()
        .filter(|root| installed(root))
        .map(|root| root.join("ffmpeg.exe"))
}

fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("FFmpeg setup requires the main app window".to_owned());
    }
    crate::media_permissions::trusted_app_origin(&webview.url().map_err(|error| error.to_string())?)
        .map(|_| ())
        .map_err(|_| "FFmpeg setup requires the BetterComms app origin".to_owned())
}

#[tauri::command]
pub fn ffmpeg_install_info(webview: tauri::Webview) -> Result<FfmpegInstallInfo, String> {
    trusted(&webview)?;
    let supported = cfg!(all(target_os = "windows", target_arch = "x86_64"));
    let installed = install_root().is_ok_and(|root| self::installed(&root));
    Ok(FfmpegInstallInfo {
        supported,
        installed,
        download_bytes: DOWNLOAD_BYTES,
        installed_bytes: FFMPEG_BYTES + LICENSE_BYTES,
        detail: if installed {
            "The private FFmpeg 8.1 runtime is ready for native sharing"
        } else if supported {
            "Install the verified FFmpeg 8.1 runtime privately for BetterComms; Windows and other apps are not changed"
        } else {
            "Native sharing setup is available on Windows x64 only"
        }
        .to_owned(),
    })
}

#[tauri::command]
pub async fn ffmpeg_install(webview: tauri::Webview) -> Result<FfmpegInstallResult, String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(install_impl)
        .await
        .map_err(|error| format!("FFmpeg setup task failed: {error}"))?
}

fn install_impl() -> Result<FfmpegInstallResult, String> {
    let _guard = match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => return Err("FFmpeg setup is already running".to_owned()),
        Err(TryLockError::Poisoned(_)) => return Err("FFmpeg setup lock is unavailable".to_owned()),
    };
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("FFmpeg setup is available on Windows x64 only".to_owned());
    }
    let destination = install_root()?;
    if installed(&destination) {
        return Ok(FfmpegInstallResult {
            installed: true,
            restart_required: false,
        });
    }
    let parent = app_root()?;
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_nanos();
    let work = parent.join(format!("ffmpeg-install-{}-{nonce}", std::process::id()));
    let script = parent.join(format!("ffmpeg-install-{}.ps1", std::process::id()));
    std::fs::write(&script, INSTALL_SCRIPT)
        .map_err(|error| format!("Could not stage FFmpeg installer: {error}"))?;
    #[cfg(windows)]
    let output = run_with_timeout(
        Command::new(windows_powershell())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .arg("-Destination")
            .arg(&destination)
            .arg("-WorkingDirectory")
            .arg(&work)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env_remove("PSModulePath")
            .creation_flags(0x0800_0000),
        Duration::from_secs(15 * 60),
    );
    #[cfg(not(windows))]
    let output: Result<std::process::Output, String> =
        Err("FFmpeg setup is available on Windows x64 only".into());
    let _ = std::fs::remove_file(&script);
    let output = output?;
    if !output.status.success() {
        return Err(format!(
            "FFmpeg setup failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(1000)
                .collect::<String>()
        ));
    }
    if !installed(&destination) {
        return Err("FFmpeg setup completed without a valid runtime".to_owned());
    }
    Ok(FfmpegInstallResult {
        installed: true,
        restart_required: false,
    })
}

#[cfg(windows)]
fn windows_powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

#[cfg(windows)]
fn run_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg setup: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("Could not wait for FFmpeg setup: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("Could not read FFmpeg setup result: {error}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("FFmpeg setup exceeded its 15-minute time limit".to_owned());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_requires_every_pinned_runtime_file() {
        let root =
            std::env::temp_dir().join(format!("bettercomms-ffmpeg-ready-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ffmpeg.exe"), b"exe").unwrap();
        std::fs::write(root.join("LICENSE"), b"license").unwrap();
        std::fs::write(root.join("setup.json"), b"{}").unwrap();
        assert!(installed_with_sizes(&root, 3, 7));
        std::fs::remove_file(root.join("LICENSE")).unwrap();
        assert!(!installed_with_sizes(&root, 3, 7));
        let _ = std::fs::remove_dir_all(root);
    }
}
