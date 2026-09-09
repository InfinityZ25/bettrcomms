package main

import "testing"

func TestNativeWindowsNonClientRegionsAreEnabled(t *testing.T) {
	options := nativeWindowsWindowOptions()
	if !options.NonClientRegionSupport {
		t.Error("WebView2 native app-region support must stay enabled")
	}
	if !options.WebView2CompositionHosting {
		t.Error("composition hosting is required for native caption buttons")
	}
}
