//go:build darwin && !ios

package main

import "testing"

func TestMacMediaPermissionDelegateIsInstalled(t *testing.T) {
	if !macMediaPermissionDelegateInstalled() {
		t.Fatal("Wails' WKUIDelegate is missing BetterComms' media permission callback")
	}
}

func TestMacMediaPermissionOnlyGrantsBundledMainPage(t *testing.T) {
	for _, kind := range []int{0, 1, 2} {
		if !trustedMacMediaOrigin("wails", "wails", 0, true, "wails", "wails", false, kind) {
			t.Fatalf("bundled main page denied media type %d", kind)
		}
	}
	for _, test := range []struct {
		name                     string
		originScheme, originHost string
		originPort               int
		mainFrame                bool
		pageScheme, pageHost     string
		pageHasPort              bool
		mediaType                int
	}{
		{"iframe", "wails", "wails", 0, false, "wails", "wails", false, 0},
		{"foreign origin", "https", "example.com", 0, true, "wails", "wails", false, 1},
		{"lookalike host", "wails", "wails.evil", 0, true, "wails", "wails", false, 0},
		{"navigated page", "wails", "wails", 0, true, "https", "example.com", false, 1},
		{"origin port", "wails", "wails", 443, true, "wails", "wails", false, 0},
		{"page port", "wails", "wails", 0, true, "wails", "wails", true, 0},
		{"unknown capture type", "wails", "wails", 0, true, "wails", "wails", false, 99},
	} {
		t.Run(test.name, func(t *testing.T) {
			if trustedMacMediaOrigin(test.originScheme, test.originHost, test.originPort,
				test.mainFrame, test.pageScheme, test.pageHost, test.pageHasPort, test.mediaType) {
				t.Fatal("untrusted page received a media grant")
			}
		})
	}
}
