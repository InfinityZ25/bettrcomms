use serde::Serialize;
use url::Url;

mod camera_overlay;
mod copilot_overlay;
mod deepfilter_audio;
mod deepfilter_runtime;
mod deepfilter_setup;
mod ffmpeg_setup;
mod gpu_devices;
mod media_permissions;
mod native_process;
mod native_screen;
mod native_screen_recording;
mod native_screen_rtc;
mod native_system_audio;
mod nvidia_audio;
mod nvidia_setup;
mod recording_export;
mod push_to_talk;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootConfig {
    schema_version: u8,
    api_origin: String,
    auth_return: Capability,
}

/// Returns an API origin only after applying the desktop transport policy.
/// Production defaults to the pinned hosted app. Authentication stays in that
/// HTTPS origin and uses its HttpOnly session cookie.
#[tauri::command]
fn desktop_boot_config() -> Result<DesktopBootConfig, String> {
    let raw = std::env::var("BETTERCOMMS_API_ORIGIN").unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            "http://127.0.0.1:8080".to_owned()
        } else {
            media_permissions::RELEASE_ORIGIN.to_owned()
        }
    });

    if raw.is_empty() {
        return Err("BETTERCOMMS_API_ORIGIN is required in production builds".to_owned());
    }

    let origin = Url::parse(&raw).map_err(|_| "BETTERCOMMS_API_ORIGIN is not a valid URL")?;
    let loopback = origin.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
    });
    if origin.scheme() != "https" && !(cfg!(debug_assertions) && loopback) {
        return Err(
            "the desktop API origin must use HTTPS (debug loopback HTTP is allowed)".to_owned(),
        );
    }
    if origin.cannot_be_a_base()
        || origin.username() != ""
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(
            "the desktop API origin must contain only scheme, host, and optional port".to_owned(),
        );
    }

    Ok(DesktopBootConfig {
        schema_version: 1,
        api_origin: origin.as_str().trim_end_matches('/').to_owned(),
        auth_return: Capability {
            state: CapabilityState::Experimental,
            detail: "the packaged app uses same-origin hosted WorkOS login in its WebView; system-browser return is not implemented",
        },
    })
}

/// A truthful snapshot of the media paths exposed by this build.
///
/// Runtime encoder availability is probed separately by native_screen_capabilities.
/// Window/display capture is distinct from an injected exclusive-game capture hook.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMediaCapabilities {
    schema_version: u8,
    platform: &'static str,
    architecture: &'static str,
    browser_media: Capability,
    native_game_video: Capability,
    native_process_audio: Capability,
    local_track_recording: Capability,
    notes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capability {
    state: CapabilityState,
    detail: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CapabilityState {
    Implemented,
    Experimental,
    Unavailable,
}

#[tauri::command]
fn desktop_media_capabilities() -> DesktopMediaCapabilities {
    let is_windows = cfg!(target_os = "windows");

    DesktopMediaCapabilities {
        schema_version: 1,
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        browser_media: Capability {
            state: CapabilityState::Implemented,
            detail: "WebView getUserMedia/getDisplayMedia; actual device and codec support must be probed in the web client",
        },
        native_game_video: Capability {
            state: if is_windows {
                CapabilityState::Implemented
            } else {
                CapabilityState::Unavailable
            },
            detail: if is_windows {
                "Windows Graphics Capture shares windows/displays through native H.264 WebRTC; exclusive-game hooks and application audio are not implemented. Probe native_screen_capabilities for encoder readiness."
            } else {
                "No native game-capture adapter exists for this platform"
            },
        },
        native_process_audio: Capability {
            state: if is_windows {
                CapabilityState::Experimental
            } else {
                CapabilityState::Unavailable
            },
            detail: if is_windows {
                "Windows process-loopback captures system output while excluding the BetterComms process tree; runtime support requires Windows build 20348 or newer"
            } else {
                "No native per-process audio adapter exists for this platform"
            },
        },
        local_track_recording: Capability {
            state: if is_windows { CapabilityState::Implemented } else { CapabilityState::Unavailable },
            detail: "Native local screen recording remuxes the live H.264 stream to MP4. Other independent tracks use browser recording. Continuous rewind and active-recording crash recovery remain unavailable.",
        },
        notes: vec![
            "native Windows sharing requires the bundled FFmpeg runtime and a successful encoder probe",
            "the web client must fall back to browser media whenever a native capability is not implemented",
        ],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(recording_export::RecordingExportState::default())
        .manage(push_to_talk::PushToTalkState::default())
        .manage(camera_overlay::CameraOverlayState::default())
        .manage(copilot_overlay::CopilotOverlayState::default())
        .manage(native_screen::NativeScreenState::default())
        .manage(native_system_audio::NativeSystemAudioState::default())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(resource_dir) = app.path().resource_dir() {
                ffmpeg_setup::configure_bundled_runtime(resource_dir);
            }
            let webview = app
                .get_webview_window("main")
                .ok_or_else(|| "BetterComms main webview was not created".to_owned())?;
            media_permissions::install_permission_prompt_guard(&webview)?;
            Ok(())
        })
        .invoke_handler(|invoke| {
            // Custom app commands are not automatically covered by plugin ACLs.
            // OAuth and other remote pages must never gain native access.
            let trusted = invoke
                .message
                .webview()
                .url()
                .ok()
                .and_then(|url| media_permissions::trusted_app_origin(&url).ok())
                .is_some();
            if !trusted {
                invoke
                    .resolver
                    .reject("Native commands require the BetterComms app origin");
                return true;
            }
            let handler: &dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = &tauri::generate_handler![
                desktop_boot_config,
                push_to_talk::push_to_talk_capabilities,
                push_to_talk::push_to_talk_start,
                push_to_talk::push_to_talk_heartbeat,
                push_to_talk::push_to_talk_stop,
                camera_overlay::camera_overlay_open,
                camera_overlay::camera_overlay_update,
                camera_overlay::camera_overlay_frame,
                camera_overlay::camera_overlay_close,
                copilot_overlay::copilot_overlay_frame,
                copilot_overlay::copilot_overlay_clear,
                native_screen::native_screen_capabilities,
                native_screen::native_screen_sources,
                native_screen::native_screen_thumbnail,
                native_screen::native_screen_start,
                native_screen::native_screen_stop,
                native_screen::native_screen_diagnostics,
                native_screen::native_screen_peer_offer,
                native_screen::native_screen_peer_answer,
                native_screen::native_screen_peer_candidate,
                native_screen::native_screen_peer_remove,
                native_screen_recording::native_screen_recording_start,
                native_screen_recording::native_screen_recording_stop,
                native_screen_recording::native_screen_recording_read,
                native_screen_recording::native_screen_recording_release,
                native_system_audio::native_system_audio_capabilities,
                native_system_audio::native_system_audio_start,
                native_system_audio::native_system_audio_read,
                native_system_audio::native_system_audio_stop,
                desktop_media_capabilities,
                media_permissions::desktop_media_permission_set,
                media_permissions::desktop_media_permission_status,
                media_permissions::open_media_privacy_settings,
                nvidia_audio::nvidia_status,
                nvidia_audio::nvidia_start,
                nvidia_audio::nvidia_process,
                nvidia_audio::nvidia_stop,
                nvidia_audio::nvidia_stream_start,
                nvidia_audio::nvidia_stream_stop,
                nvidia_setup::nvidia_install_info,
                nvidia_setup::nvidia_install,
                deepfilter_audio::deepfilter_status,
                deepfilter_audio::deepfilter_stream_start,
                deepfilter_audio::deepfilter_stream_stop,
                deepfilter_setup::deepfilter_install_info,
                deepfilter_setup::deepfilter_install,
                ffmpeg_setup::ffmpeg_install_info,
                ffmpeg_setup::ffmpeg_install,
                recording_export::recording_export_begin,
                recording_export::recording_export_append,
                recording_export::recording_export_finish,
                recording_export::recording_export_abort,
                recording_export::recording_conversion_capabilities,
                recording_export::recording_conversion_begin,
                recording_export::recording_conversion_finish
            ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("error while running BetterComms desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_recording_reports_platform_and_recovery_limits() {
        let report = desktop_media_capabilities();
        assert_eq!(
            matches!(
                report.local_track_recording.state,
                CapabilityState::Implemented
            ),
            cfg!(windows)
        );
        assert!(report
            .local_track_recording
            .detail
            .contains("crash recovery remain unavailable"));
    }

    #[test]
    fn debug_boot_origin_is_loopback() {
        std::env::remove_var("BETTERCOMMS_API_ORIGIN");
        let report = desktop_boot_config().expect("debug builds have a loopback default");
        assert_eq!(report.api_origin, "http://127.0.0.1:8080");
    }
}
