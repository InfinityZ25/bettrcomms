use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const INSTALL_SCRIPT: &str = include_str!("../../../../scripts/install-nvidia-audio.ps1");
const DOWNLOAD_BYTES: u64 = 706_540_584;
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaInstallInfo {
    schema_version: u8,
    supported: bool,
    installed: bool,
    gpu_name: Option<String>,
    selected_package: Option<&'static str>,
    download_bytes: u64,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaInstallResult {
    installed: bool,
    destination: String,
}

fn app_data_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_owned())?;
    Ok(PathBuf::from(local).join("Bettercomms"))
}

fn install_root() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("nvidia-audio-effects"))
}

fn manifest_is_ready(root: &Path) -> bool {
    root.join("setup.json").is_file()
        && root.join("runtime").join("NVAudioEffects.dll").is_file()
        && root.join("models").join("denoiser_48k.trtpkg").is_file()
}

#[cfg(target_os = "windows")]
fn detected_nvidia_gpu() -> Option<String> {
    let mut command = Command::new(windows_powershell());
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_VideoController | Where-Object Name -match 'NVIDIA' | Select-Object -First 1 -ExpandProperty Name)",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("PSModulePath")
        .creation_flags(0x0800_0000);
    let output = run_with_timeout(&mut command, Duration::from_secs(10)).ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!name.is_empty()).then_some(name)
}

#[cfg(not(target_os = "windows"))]
fn detected_nvidia_gpu() -> Option<String> {
    None
}

fn is_supported_ada_gpu(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("GEFORCE RTX 40") || (upper.contains("RTX ") && upper.contains(" ADA"))
}

#[tauri::command]
pub async fn nvidia_install_info() -> Result<NvidiaInstallInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = install_root()?;
        let gpu = detected_nvidia_gpu();
        let supported = cfg!(target_os = "windows") && gpu.as_deref().is_some_and(is_supported_ada_gpu);
        let detail = if manifest_is_ready(&root) {
            "NVIDIA Audio Effects runtime is installed".to_owned()
        } else if supported {
            "A supported NVIDIA Ada GPU was detected; the pinned Audio Effects package can be installed".to_owned()
        } else {
            "This installer currently supports detected NVIDIA Ada GPUs only".to_owned()
        };
        Ok(NvidiaInstallInfo {
            schema_version: 1,
            supported,
            installed: manifest_is_ready(&root),
            gpu_name: gpu,
            selected_package: supported.then_some("NVIDIA Audio Effects SDK 1.6.1.2 Ada"),
            download_bytes: DOWNLOAD_BYTES,
            detail,
        })
    })
    .await
    .map_err(|error| format!("NVIDIA setup probe failed: {error}"))?
}

#[tauri::command]
pub async fn nvidia_install() -> Result<NvidiaInstallResult, String> {
    tauri::async_runtime::spawn_blocking(|| install_impl())
        .await
        .map_err(|error| format!("NVIDIA setup task failed: {error}"))?
}

fn install_impl() -> Result<NvidiaInstallResult, String> {
    let _guard = match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => return Err("NVIDIA setup is already running".to_owned()),
        Err(TryLockError::Poisoned(_)) => return Err("NVIDIA setup lock is unavailable".to_owned()),
    };
    let destination = install_root()?;
    if manifest_is_ready(&destination) {
        return Err("NVIDIA runtime files are already installed. Restart Bettercomms to load them. If they remain unavailable, exit Bettercomms, remove the NVIDIA runtime directory, restart, and install again.".to_owned());
    }
    let gpu = detected_nvidia_gpu().ok_or_else(|| "No NVIDIA GPU was detected".to_owned())?;
    if !cfg!(target_os = "windows") || !is_supported_ada_gpu(&gpu) {
        return Err(format!("Unsupported GPU for the pinned Ada package: {gpu}"));
    }
    let parent = app_data_root()?;
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_nanos();
    let work = parent.join(format!("nvidia-install-{}-{nonce}", std::process::id()));
    let script = parent.join(format!("nvidia-install-{}.ps1", std::process::id()));
    std::fs::write(&script, INSTALL_SCRIPT)
        .map_err(|error| format!("Cannot stage installer script: {error}"))?;
    #[cfg(target_os = "windows")]
    let status = run_with_timeout(
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
        Duration::from_secs(35 * 60),
    );
    #[cfg(not(target_os = "windows"))]
    let status: Result<std::process::Output, String> =
        Err("NVIDIA setup is available on Windows only".to_owned());

    let _ = std::fs::remove_file(&script);
    let output = status?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("NVIDIA setup failed: {}", stderr.trim()));
    }
    if !manifest_is_ready(&destination) {
        return Err("NVIDIA setup completed without a valid runtime manifest".to_owned());
    }
    Ok(NvidiaInstallResult {
        installed: true,
        destination: destination.to_string_lossy().into_owned(),
    })
}

#[cfg(target_os = "windows")]
fn windows_powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

#[cfg(target_os = "windows")]
fn run_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start PowerShell: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("Cannot wait for PowerShell: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("Cannot read PowerShell result: {error}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("NVIDIA setup exceeded its 35-minute time limit".to_owned());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_only_known_ada_names() {
        assert!(is_supported_ada_gpu("NVIDIA GeForce RTX 4070 SUPER"));
        assert!(is_supported_ada_gpu("NVIDIA RTX 6000 Ada Generation"));
        assert!(is_supported_ada_gpu("NVIDIA RTX 4000 SFF Ada Generation"));
        assert!(!is_supported_ada_gpu("NVIDIA GeForce RTX 3080"));
        assert!(!is_supported_ada_gpu("NVIDIA Quadro RTX 4000"));
        assert!(!is_supported_ada_gpu("NVIDIA L40"));
        assert!(!is_supported_ada_gpu("AMD Radeon RX 7900"));
    }

    #[test]
    fn readiness_requires_manifest_dll_and_model() {
        let root =
            std::env::temp_dir().join(format!("bettercomms-nvidia-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::create_dir_all(root.join("models")).unwrap();
        std::fs::write(root.join("setup.json"), "{}").unwrap();
        assert!(!manifest_is_ready(&root));
        std::fs::write(root.join("runtime/NVAudioEffects.dll"), []).unwrap();
        std::fs::write(root.join("models/denoiser_48k.trtpkg"), []).unwrap();
        assert!(manifest_is_ready(&root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn timeout_runner_captures_stdout() {
        let mut command = Command::new(windows_powershell());
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('captured')",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("PSModulePath")
            .creation_flags(0x0800_0000);
        let output = run_with_timeout(&mut command, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "captured");
    }
}
