package main

import (
	"testing"

	"bettercomms/desktop-wails/internal/desktop"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestDevicePermissionsNeverBlanketAllowDocuments(t *testing.T) {
	policy := nativeWindowPermissions()
	if len(policy) == 0 {
		t.Fatal("empty policy enables blanket allow in the pinned Windows host")
	}
	for _, kind := range []application.PermissionType{application.PermissionMicrophone, application.PermissionCamera} {
		if value, exists := policy[kind]; !exists || value != application.PermissionDefault {
			t.Fatalf("device %v must defer to WebView2's permission decision", kind)
		}
	}
	for _, kind := range []application.PermissionType{application.PermissionGeolocation, application.PermissionNotifications, application.PermissionClipboardRead} {
		if policy[kind] != application.PermissionDeny {
			t.Fatalf("unneeded web permission %v must remain denied", kind)
		}
	}
}

func TestPackagedAPIOriginAndRuntimeOverrides(t *testing.T) {
	previous := bakedAPIOrigin
	t.Cleanup(func() { bakedAPIOrigin = previous })
	t.Setenv("BETTERCOMMS_API_ORIGIN", "")
	bakedAPIOrigin = ""
	if configuredAPIOrigin(false) != desktop.ReleaseOrigin {
		t.Fatal("default release origin differs from the Tauri contract")
	}
	bakedAPIOrigin = "https://packaging.example:8443"
	if configuredAPIOrigin(false) != bakedAPIOrigin {
		t.Fatal("release ignored its compiled API origin")
	}
	if configuredAPIOrigin(true) != "http://127.0.0.1:8080" {
		t.Fatal("development must keep its local API default")
	}
	t.Setenv("BETTERCOMMS_API_ORIGIN", "https://runtime.example")
	if configuredAPIOrigin(false) != "https://runtime.example" {
		t.Fatal("explicit runtime configuration was ignored")
	}
	if releaseAPIOrigin() != "https://packaging.example:8443" {
		t.Fatal("runtime configuration changed build metadata")
	}
}

func TestNativeWindowsNonClientRegionsAreEnabled(t *testing.T) {
	options := nativeWindowsWindowOptions()
	if !options.NonClientRegionSupport {
		t.Error("WebView2 native app-region support must stay enabled")
	}
	if !options.WebView2CompositionHosting {
		t.Error("composition hosting is required for native caption buttons")
	}
}

// Browser sign-in needs a cookie jar in this process, and that jar is the API
// proxy. A development build that skipped the proxy would leave the window with
// no hand-off, and the page would fall back to navigating the webview to the
// identity provider — which is the one thing this host must never do.
func TestADevelopmentBuildAlsoGetsTheProxyBrowserSignInNeeds(t *testing.T) {
	origin, err := desktop.ResolveAPIOrigin("http://127.0.0.1:8080", true)
	if err != nil {
		t.Fatalf("ResolveAPIOrigin: %v", err)
	}

	proxy := startAPIProxy(origin)
	if proxy == nil {
		t.Fatal("a development build got no API proxy")
	}
	t.Cleanup(func() { _ = proxy.Close() })

	if proxy.Base() == "" || proxy.Token() == "" {
		t.Errorf("the boot report would carry base %q and token %q", proxy.Base(), proxy.Token())
	}
	// This is the field the page reads before it offers the hand-off at all.
	if state := authReturn(proxy).State; state == desktop.Unavailable {
		t.Errorf("authReturn = %q, so the window would navigate itself to WorkOS instead", state)
	}
}

// With no origin there is nothing to proxy, and the report has to say so rather
// than offering a sign-in that cannot complete.
func TestNoOriginMeansNoProxyAndNoHandOff(t *testing.T) {
	if proxy := startAPIProxy(""); proxy != nil {
		_ = proxy.Close()
		t.Fatal("a proxy was started with no origin")
	}
	if state := authReturn(nil).State; state != desktop.Unavailable {
		t.Errorf("authReturn = %q with no proxy, want unavailable", state)
	}
}
