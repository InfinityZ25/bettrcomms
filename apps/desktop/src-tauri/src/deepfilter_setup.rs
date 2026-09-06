use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const INSTALL_SCRIPT: &str = include_str!("../../../../scripts/install-deepfilter.ps1");
const DOWNLOAD_BYTES: u64 = 215_038_684;
const MODEL: &[u8] = include_bytes!("../resources/deepfilter/denoiser_model.onnx");
const INITIAL_STATES: &[u8] = include_bytes!("../resources/deepfilter/initial_states.json");
const META: &[u8] = include_bytes!("../resources/deepfilter/meta.json");
const BUNDLED_NOTICES: [(&str, &[u8]); 5] = [
    (
        "deepfilter-stream-LICENSE",
        include_bytes!("../resources/deepfilter/deepfilter-stream-LICENSE"),
    ),
    (
        "deepfilter-stream-NOTICE",
        include_bytes!("../resources/deepfilter/deepfilter-stream-NOTICE"),
    ),
    (
        "DeepFilterNet-LICENSE",
        include_bytes!("../resources/deepfilter/DeepFilterNet-LICENSE"),
    ),
    (
        "DeepFilterNet-LICENSE-APACHE",
        include_bytes!("../resources/deepfilter/DeepFilterNet-LICENSE-APACHE"),
    ),
    (
        "DeepFilterNet-LICENSE-MIT",
        include_bytes!("../resources/deepfilter/DeepFilterNet-LICENSE-MIT"),
    ),
];
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepfilterInstallInfo {
    schema_version: u8,
    supported: bool,
    installed: bool,
    download_bytes: u64,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepfilterInstallResult {
    installed: bool,
    destination: String,
}

fn app_data_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_owned())?;
    Ok(PathBuf::from(local).join("Bettercomms"))
}

pub(crate) fn install_root() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("deepfilter-directml"))
}

fn manifest_is_ready(root: &Path) -> bool {
    [
        "setup.json",
        "runtime/onnxruntime.dll",
        "runtime/onnxruntime_providers_shared.dll",
        "runtime/DirectML.dll",
        "models/denoiser_model.onnx",
        "models/initial_states.json",
        "models/meta.json",
        "notices/onnxruntime-LICENSE",
        "notices/onnxruntime-ThirdPartyNotices.txt",
        "notices/directml-LICENSE.txt",
        "notices/directml-LICENSE-CODE.txt",
        "notices/directml-ThirdPartyNotices.txt",
        "notices/deepfilter-stream-LICENSE",
        "notices/deepfilter-stream-NOTICE",
        "notices/DeepFilterNet-LICENSE-APACHE",
        "notices/DeepFilterNet-LICENSE-MIT",
        "notices/DeepFilterNet-LICENSE",
        "notices/Bettercomms-MODEL-NOTICE.txt",
    ]
    .iter()
    .all(|relative| root.join(relative).is_file())
}

fn require_trusted_webview(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("DeepFilterNet setup requires the main app window".to_owned());
    }
    crate::media_permissions::trusted_app_origin(&webview.url().map_err(|error| error.to_string())?)
        .map(|_| ())
        .map_err(|_| "DeepFilterNet setup requires the BetterComms app origin".to_owned())
}

#[tauri::command]
pub async fn deepfilter_install_info(
    webview: tauri::Webview,
) -> Result<DeepfilterInstallInfo, String> {
    require_trusted_webview(&webview)?;
    tauri::async_runtime::spawn_blocking(|| {
        let root = install_root()?;
        let supported = cfg!(target_os = "windows")
            && cfg!(target_arch = "x86_64")
            && crate::gpu_devices::compatible_adapters()
                .is_ok_and(|adapters| !adapters.is_empty());
        let installed = manifest_is_ready(&root);
        let detail = if installed {
            "DeepFilterNet and the DirectML runtime are installed; processing readiness still requires a native model probe"
        } else if supported {
            "The pinned DeepFilterNet and DirectML runtime can be installed for this Windows x64 device"
        } else {
            "The optional DeepFilterNet DirectML package requires a compatible AMD or Intel GPU on Windows x64"
        };
        Ok(DeepfilterInstallInfo {
            schema_version: 1,
            supported,
            installed,
            download_bytes: DOWNLOAD_BYTES,
            detail: detail.to_owned(),
        })
    })
    .await
    .map_err(|error| format!("DeepFilterNet setup probe failed: {error}"))?
}

#[tauri::command]
pub async fn deepfilter_install(
    webview: tauri::Webview,
) -> Result<DeepfilterInstallResult, String> {
    require_trusted_webview(&webview)?;
    tauri::async_runtime::spawn_blocking(install_impl)
        .await
        .map_err(|error| format!("DeepFilterNet setup task failed: {error}"))?
}

fn install_impl() -> Result<DeepfilterInstallResult, String> {
    let _guard = match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return Err("DeepFilterNet setup is already running".to_owned())
        }
        Err(TryLockError::Poisoned(_)) => {
            return Err("DeepFilterNet setup lock is unavailable".to_owned())
        }
    };
    if !cfg!(target_os = "windows") || !cfg!(target_arch = "x86_64") {
        return Err("DeepFilterNet DirectML setup is available on Windows x64 only".to_owned());
    }
    if crate::gpu_devices::compatible_adapters()
        .map_err(|error| format!("Cannot enumerate compatible graphics adapters: {error}"))?
        .is_empty()
    {
        return Err("No compatible AMD or Intel GPU is available for DirectML".to_owned());
    }
    let destination = install_root()?;
    if manifest_is_ready(&destination) {
        return Err("DeepFilterNet is already installed. Restart Bettercomms to load it. If it remains unavailable, exit Bettercomms, remove the deepfilter-directml directory, restart, and install again.".to_owned());
    }
    let parent = app_data_root()?;
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_nanos();
    let work = parent.join(format!("deepfilter-install-{}-{nonce}", std::process::id()));
    let script = parent.join(format!("deepfilter-install-{}.ps1", std::process::id()));
    std::fs::write(&script, INSTALL_SCRIPT)
        .map_err(|error| format!("Cannot stage installer script: {error}"))?;
    let bundled = work.join("bundled");
    std::fs::create_dir_all(&bundled)
        .map_err(|error| format!("Cannot stage bundled DeepFilterNet assets: {error}"))?;
    for (name, bytes) in [
        ("denoiser_model.onnx", MODEL),
        ("initial_states.json", INITIAL_STATES),
        ("meta.json", META),
    ]
    .into_iter()
    .chain(BUNDLED_NOTICES)
    {
        std::fs::write(bundled.join(name), bytes)
            .map_err(|error| format!("Cannot stage bundled DeepFilterNet asset {name}: {error}"))?;
    }

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
            .arg("-BundledAssets")
            .arg(&bundled)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env_remove("PSModulePath")
            .creation_flags(0x0800_0000),
        Duration::from_secs(15 * 60),
    );
    #[cfg(not(target_os = "windows"))]
    let status: Result<std::process::Output, String> =
        Err("DeepFilterNet setup is available on Windows x64 only".to_owned());

    let _ = std::fs::remove_file(&script);
    let output = status?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DeepFilterNet setup failed: {}", stderr.trim()));
    }
    if !manifest_is_ready(&destination) {
        return Err("DeepFilterNet setup completed without a valid runtime manifest".to_owned());
    }
    Ok(DeepfilterInstallResult {
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
            return Err("DeepFilterNet setup exceeded its 15-minute time limit".to_owned());
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
    fn readiness_requires_runtime_models_manifest_and_notices() {
        let root = std::env::temp_dir().join(format!(
            "bettercomms-deepfilter-setup-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        for relative in ["runtime", "models", "notices"] {
            std::fs::create_dir_all(root.join(relative)).unwrap();
        }
        for relative in [
            "setup.json",
            "runtime/onnxruntime.dll",
            "runtime/onnxruntime_providers_shared.dll",
            "runtime/DirectML.dll",
            "models/denoiser_model.onnx",
            "models/initial_states.json",
            "models/meta.json",
            "notices/onnxruntime-LICENSE",
            "notices/onnxruntime-ThirdPartyNotices.txt",
            "notices/directml-LICENSE.txt",
            "notices/directml-LICENSE-CODE.txt",
            "notices/directml-ThirdPartyNotices.txt",
            "notices/deepfilter-stream-LICENSE",
            "notices/deepfilter-stream-NOTICE",
            "notices/DeepFilterNet-LICENSE-APACHE",
            "notices/DeepFilterNet-LICENSE-MIT",
            "notices/DeepFilterNet-LICENSE",
            "notices/Bettercomms-MODEL-NOTICE.txt",
        ] {
            std::fs::write(root.join(relative), []).unwrap();
        }
        assert!(manifest_is_ready(&root));
        std::fs::remove_file(root.join("models/initial_states.json")).unwrap();
        assert!(!manifest_is_ready(&root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn download_size_accounts_for_every_pinned_asset() {
        assert_eq!(DOWNLOAD_BYTES, 12_746_067 + 202_292_617);
    }
}
