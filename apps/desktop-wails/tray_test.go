package main

import (
	"path/filepath"
	"testing"

	"bettercomms/desktop-wails/internal/desktop"
)

func TestTrayPreferenceIsOptInAndPageGated(t *testing.T) {
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	service := &TrayService{gate: gate, path: filepath.Join(t.TempDir(), "tray.json")}
	if enabled, err := service.Enabled(gate.Token()); err != nil || enabled {
		t.Fatalf("tray should default off: %v %v", enabled, err)
	}
	if err := service.SetEnabled("wrong-token", true); err == nil {
		t.Fatal("untrusted page changed tray preference")
	}
	if err := service.SetEnabled(gate.Token(), true); err != nil {
		t.Fatal(err)
	}
	if err := service.SetEnabled(gate.Token(), false); err != nil {
		t.Fatal(err)
	}
	if enabled, err := service.Enabled(gate.Token()); err != nil || enabled {
		t.Fatalf("tray opt-out was not saved: %v %v", enabled, err)
	}
}
