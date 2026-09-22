package main

import (
	"math"
	"testing"

	"bettercomms/desktop-wails/internal/desktop"
)

func TestAudioOriginPolicy(t *testing.T) {
	for _, origin := range []string{"http://wails.localhost", "https://wails.localhost", "wails://wails"} {
		if !audioOriginAllowed(origin, false) {
			t.Fatal("host origin refused")
		}
	}
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:5173"} {
		if audioOriginAllowed(origin, false) || !audioOriginAllowed(origin, true) {
			t.Fatal("development origin gate failed")
		}
	}
	for _, origin := range []string{"", "null", "wails://evil", "http://wails.localhost/", "http://wails.localhost:5173", "http://wails.localhost.evil", "http://localhost:3000", "https://app.bettrcomms.com"} {
		if audioOriginAllowed(origin, true) {
			t.Fatalf("untrusted origin accepted: %q", origin)
		}
	}
}

func TestAudioServiceAuthorisationAndOptions(t *testing.T) {
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	s := &NativeMediaService{gate: gate}
	if _, err := s.NvidiaInstall(t.Context(), "wrong"); err == nil {
		t.Fatal("unauthorised NVIDIA install")
	}
	if _, err := s.DeepfilterInstall(t.Context(), "wrong"); err == nil {
		t.Fatal("unauthorised DirectML install")
	}
	if _, err := s.NvidiaStatus("wrong"); err == nil {
		t.Fatal("unauthorised NVIDIA probe")
	}
	if _, err := s.DeepfilterStatus("wrong"); err == nil {
		t.Fatal("unauthorised DirectML probe")
	}
	if _, err := s.AudioStreamStart("wrong", "nvidia", 1, false, 100); err == nil {
		t.Fatal("unauthorised start")
	}
	if err := s.AudioStreamStop("wrong", "anything"); err == nil {
		t.Fatal("unauthorised stop")
	}
	for _, intensity := range []float32{-1, 2, float32(math.NaN()), float32(math.Inf(1))} {
		if _, err := s.AudioStreamStart(gate.Token(), "nvidia", intensity, false, 100); err == nil {
			t.Fatal("invalid intensity")
		}
	}
	if _, err := s.AudioStreamStart(gate.Token(), "unknown", 1, false, 100); err == nil {
		t.Fatal("unknown processor")
	}
}
