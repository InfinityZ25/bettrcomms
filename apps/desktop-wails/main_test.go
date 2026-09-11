package main

import (
	"testing"

	"bettercomms/desktop-wails/internal/desktop"
)

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
