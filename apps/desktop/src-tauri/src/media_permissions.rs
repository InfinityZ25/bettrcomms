use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use url::Url;

pub(crate) const RELEASE_ORIGIN: &str = "https://bettrcomms-production.up.railway.app";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaPermissionKind {
    Microphone,
    Camera,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPermissionStatus {
    kind: MediaPermissionKind,
    state: &'static str,
    origin: String,
}

pub(crate) fn trusted_app_origin(current_url: &Url) -> Result<String, String> {
    let host = current_url
        .host_str()
        .ok_or_else(|| "media permission commands require the BetterComms app origin".to_owned())?;
    let trusted = match current_url.scheme() {
        "https" if current_url.origin().ascii_serialization() == RELEASE_ORIGIN => true,
        "tauri" if host == "localhost" && current_url.port().is_none() => true,
        "http" if host.eq_ignore_ascii_case("tauri.localhost") && current_url.port().is_none() => {
            true
        }
        "http"
            if cfg!(debug_assertions)
                && host.eq_ignore_ascii_case("localhost")
                && current_url.port() == Some(5173) =>
        {
            true
        }
        _ => false,
    };
    if !trusted {
        return Err(
            "media permission commands are restricted to the BetterComms app origin".to_owned(),
        );
    }

    Ok(current_url.origin().ascii_serialization())
}

fn same_origin(candidate: &str, expected: &str) -> bool {
    Url::parse(candidate)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .is_some_and(|origin| origin == expected)
}

#[cfg(windows)]
fn native_kind(
    kind: MediaPermissionKind,
) -> webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    };
    match kind {
        MediaPermissionKind::Microphone => COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        MediaPermissionKind::Camera => COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    }
}

#[cfg(windows)]
fn profile4(
    platform_webview: &tauri::webview::PlatformWebview,
) -> windows_core::Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Profile4> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
    use windows_core::Interface;

    let controller = platform_webview.controller();
    let core = unsafe { controller.CoreWebView2()? };
    let core13: ICoreWebView2_13 = core.cast()?;
    let profile = unsafe { core13.Profile()? };
    profile.cast()
}

#[cfg(windows)]
async fn wait_for_native_result<T: Send + 'static>(
    receiver: std::sync::mpsc::Receiver<Result<T, String>>,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "WebView2 did not finish the permission operation".to_owned())?
    })
    .await
    .map_err(|error| format!("permission operation task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_media_permission_set(
    webview: WebviewWindow,
    kind: MediaPermissionKind,
    allowed: bool,
) -> Result<MediaPermissionStatus, String> {
    let origin = trusted_app_origin(&webview.url().map_err(|error| error.to_string())?)?;

    #[cfg(windows)]
    {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
            },
            SetPermissionStateCompletedHandler,
        };

        let (sender, receiver) = std::sync::mpsc::channel();
        let native_origin = origin.clone();
        webview
            .with_webview(move |platform_webview| {
                let completion_sender = sender.clone();
                let result = (|| {
                    let profile = profile4(&platform_webview).map_err(|error| error.to_string())?;
                    let state = if allowed {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DENY
                    };
                    let completion =
                        SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                            let _ =
                                completion_sender.send(result.map_err(|error| error.to_string()));
                            Ok(())
                        }));
                    let native_origin = windows_core::HSTRING::from(native_origin);
                    unsafe {
                        profile.SetPermissionState(
                            native_kind(kind),
                            &native_origin,
                            state,
                            &completion,
                        )
                    }
                    .map_err(|error| error.to_string())
                })();
                if let Err(error) = result {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        wait_for_native_result(receiver).await?;
        return Ok(MediaPermissionStatus {
            kind,
            state: if allowed { "allowed" } else { "denied" },
            origin,
        });
    }

    #[cfg(not(windows))]
    Err("desktop media permission management is currently available only on Windows".to_owned())
}

#[tauri::command]
pub async fn desktop_media_permission_status(
    webview: WebviewWindow,
    kind: MediaPermissionKind,
) -> Result<MediaPermissionStatus, String> {
    let origin = trusted_app_origin(&webview.url().map_err(|error| error.to_string())?)?;

    #[cfg(windows)]
    {
        use webview2_com::{
            take_pwstr, GetNonDefaultPermissionSettingsCompletedHandler,
            Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
            },
        };

        let (sender, receiver) = std::sync::mpsc::channel();
        let expected_origin = origin.clone();
        webview
            .with_webview(move |platform_webview| {
                let completion_sender = sender.clone();
                let result = (|| {
                    let profile = profile4(&platform_webview).map_err(|error| error.to_string())?;
                    let completion = GetNonDefaultPermissionSettingsCompletedHandler::create(
                        Box::new(move |result, settings| {
                            if let Err(error) = result {
                                let _ = completion_sender.send(Err(error.to_string()));
                                return Ok(());
                            }
                            let response = (|| -> windows_core::Result<&'static str> {
                                let settings = settings.ok_or_else(|| {
                                    windows_core::Error::new(
                                        windows_core::HRESULT(0x80004005u32 as i32),
                                        "WebView2 returned no permission settings",
                                    )
                                })?;
                                let mut count = 0;
                                unsafe { settings.Count(&mut count) }?;
                                for index in 0..count {
                                    let setting = unsafe { settings.GetValueAtIndex(index) }?;
                                    let mut setting_kind = Default::default();
                                    unsafe { setting.PermissionKind(&mut setting_kind) }?;
                                    if setting_kind != native_kind(kind) {
                                        continue;
                                    }
                                    let mut setting_origin = Default::default();
                                    unsafe { setting.PermissionOrigin(&mut setting_origin) }?;
                                    if !same_origin(&take_pwstr(setting_origin), &expected_origin) {
                                        continue;
                                    }
                                    let mut permission_state = Default::default();
                                    unsafe { setting.PermissionState(&mut permission_state) }?;
                                    return Ok(
                                        if permission_state == COREWEBVIEW2_PERMISSION_STATE_ALLOW {
                                            "allowed"
                                        } else if permission_state
                                            == COREWEBVIEW2_PERMISSION_STATE_DENY
                                        {
                                            "denied"
                                        } else {
                                            "prompt"
                                        },
                                    );
                                }
                                Ok("prompt")
                            })();
                            let _ =
                                completion_sender.send(response.map_err(|error| error.to_string()));
                            Ok(())
                        }),
                    );
                    unsafe { profile.GetNonDefaultPermissionSettings(&completion) }
                        .map_err(|error| error.to_string())
                })();
                if let Err(error) = result {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        let state = wait_for_native_result(receiver).await?;
        return Ok(MediaPermissionStatus {
            kind,
            state,
            origin,
        });
    }

    #[cfg(not(windows))]
    Err("desktop media permission management is currently available only on Windows".to_owned())
}

#[tauri::command]
pub fn open_media_privacy_settings(kind: MediaPermissionKind) -> Result<(), String> {
    #[cfg(windows)]
    {
        let uri = match kind {
            MediaPermissionKind::Microphone => "ms-settings:privacy-microphone",
            MediaPermissionKind::Camera => "ms-settings:privacy-webcam",
        };
        std::process::Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .map_err(|error| format!("could not open Windows privacy settings: {error}"))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    Err("media privacy settings are currently available only on Windows".to_owned())
}

/// Denies unconfigured microphone/camera requests so WebView2 never displays its
/// generic permission prompt. Explicit UI actions call `desktop_media_permission_set`
/// first; WebView2 then resolves capture from the persisted per-origin profile state.
#[cfg(windows)]
pub fn install_permission_prompt_guard(webview: &WebviewWindow) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler,
    };

    webview
        .with_webview(|platform_webview| {
            let controller = platform_webview.controller();
            let result = unsafe { controller.CoreWebView2() }.and_then(|core| unsafe {
                let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = Default::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    {
                        // A stored allow is handled before this event. Any event reaching
                        // this guard is unconfigured, and external origins are always denied.
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                }));
                let mut token = Default::default();
                core.add_PermissionRequested(&handler, &mut token)
            });
            if let Err(error) = result {
                eprintln!("could not install WebView2 media permission guard: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn install_permission_prompt_guard(_webview: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusts_only_configured_development_origin() {
        let trusted = Url::parse("http://localhost:5173/call/123").unwrap();
        assert_eq!(
            trusted_app_origin(&trusted).unwrap(),
            "http://localhost:5173"
        );
        assert!(trusted_app_origin(&Url::parse("https://example.com").unwrap()).is_err());
        assert!(trusted_app_origin(&Url::parse("http://localhost:5174").unwrap()).is_err());
    }

    #[test]
    fn compares_permission_origins_canonically() {
        assert!(same_origin(
            "http://localhost:5173/",
            "http://localhost:5173"
        ));
        assert!(same_origin(
            "HTTP://LOCALHOST:5173/call/123",
            "http://localhost:5173"
        ));
        assert!(!same_origin(
            "http://localhost:5174/",
            "http://localhost:5173"
        ));
        assert!(!same_origin("not a URL", "http://localhost:5173"));
    }

    #[test]
    fn release_origin_is_exact_and_matches_packaged_config() {
        assert!(trusted_app_origin(&Url::parse(RELEASE_ORIGIN).unwrap()).is_ok());
        for bad in [
            "http://bettrcomms-production.up.railway.app",
            "https://bettrcomms-production.up.railway.app.evil.example",
            "https://bettrcomms-production.up.railway.app:8443",
            "https://api.workos.com",
        ] {
            assert!(trusted_app_origin(&Url::parse(bad).unwrap()).is_err());
        }
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["url"], RELEASE_ORIGIN);
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(
            capability["remote"]["urls"],
            serde_json::json!([RELEASE_ORIGIN])
        );
    }
}
