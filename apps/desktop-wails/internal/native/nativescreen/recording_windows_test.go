//go:build windows

package nativescreen

import (
	"bytes"
	"context"
	"testing"
	"time"

	"bettercomms/desktop-wails/internal/native/nativerecording"
)

// This is the acceptance test for native recording: a real Windows Graphics
// Capture, encoded by the real hardware encoder, remuxed by the real muxer into
// an MP4 the page reads back in chunks. Nothing here is synthetic.
func TestARealCaptureRecordsToAPlayableMP4(t *testing.T) {
	requireRuntime(t)

	capabilities := Probe(context.Background())
	encoder := ""
	for _, candidate := range capabilities.Encoders {
		if candidate.Available {
			encoder = candidate.ID
			break
		}
	}
	if encoder == "" {
		t.Skip("no encoder passed its probe on this machine")
	}

	recordings := nativerecording.NewStore(t.TempDir())
	t.Cleanup(recordings.Close)

	manager := NewManager()
	manager.SetRecorder(recordings)
	t.Cleanup(manager.Close)

	sources, err := manager.Sources()
	if err != nil {
		t.Fatalf("Sources: %v", err)
	}
	var display Source
	for _, source := range sources {
		if source.Kind == "monitor" {
			display = source
			break
		}
	}
	if display.ID == "" {
		t.Skip("no display to capture")
	}

	started, err := manager.Start(context.Background(), StartOptions{
		SourceID:    display.ID,
		Encoder:     encoder,
		Width:       640,
		Height:      360,
		FPS:         30,
		BitrateMbps: 2,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	recording, err := recordings.Start(started.SessionID)
	if err != nil {
		t.Fatalf("recording Start: %v", err)
	}

	// Recording begins at the first keyframe, and the encoder's GOP is one
	// second, so the first frame can be over a second away. Record long enough
	// that the measured duration is not dominated by that wait.
	time.Sleep(4 * time.Second)

	asset, err := recordings.Stop(recording.RecordingID)
	if err != nil {
		_, detail, _ := manager.Diagnostics(started.SessionID)
		t.Fatalf("recording Stop: %v (encoder said: %s)", err, detail)
	}
	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("capture Stop: %v", err)
	}

	t.Logf("recorded %d bytes over %d ms, first frame %d ms in",
		asset.SizeBytes, asset.DurationMs, asset.StartedDelayMs)

	if asset.SizeBytes < 1024 {
		t.Errorf("the recording is %d bytes, too small to hold two seconds of video", asset.SizeBytes)
	}
	if asset.DurationMs < 500 {
		t.Errorf("the recording reports %d ms, want at least 500", asset.DurationMs)
	}
	// Size and duration must agree with the 2 Mbps the encoder was given,
	// within a wide margin. A file far off that ratio means the duration is
	// being measured against the wrong frames.
	if bitsPerSecond := float64(asset.SizeBytes) * 8 / (float64(asset.DurationMs) / 1000); bitsPerSecond > 8_000_000 {
		t.Errorf("%d bytes over %d ms is %.1f Mbps, far above the 2 Mbps requested",
			asset.SizeBytes, asset.DurationMs, bitsPerSecond/1_000_000)
	}

	// Read it back exactly the way the page does, in bounded chunks.
	var whole []byte
	for offset := int64(0); offset < asset.SizeBytes; {
		chunk, err := recordings.Read(asset.AssetID, offset, nativerecording.MaxReadBytes)
		if err != nil {
			t.Fatalf("Read at %d: %v", offset, err)
		}
		if len(chunk) == 0 {
			break
		}
		whole = append(whole, chunk...)
		offset += int64(len(chunk))
	}
	if int64(len(whole)) != asset.SizeBytes {
		t.Fatalf("read %d bytes, want %d", len(whole), asset.SizeBytes)
	}

	// An MP4's first box is ftyp, and faststart puts moov ahead of the media
	// so the page can play without the whole file.
	if len(whole) < 16 || !bytes.Equal(whole[4:8], []byte("ftyp")) {
		t.Fatalf("the file is not an MP4: % x", whole[:min(16, len(whole))])
	}
	moov := bytes.Index(whole, []byte("moov"))
	mdat := bytes.Index(whole, []byte("mdat"))
	if moov < 0 {
		t.Error("the file has no moov box, so it carries no track")
	}
	if moov >= 0 && mdat >= 0 && moov > mdat {
		t.Error("moov follows mdat; the file is not faststart and cannot stream")
	}
	// The track must be H.264, copied through rather than re-encoded.
	if !bytes.Contains(whole, []byte("avc1")) {
		t.Error("the file holds no H.264 track")
	}

	if err := recordings.Release(asset.AssetID); err != nil {
		t.Fatalf("Release: %v", err)
	}
}

// Ending a capture must end any recording of it, so a stopped share cannot
// leave a muxer holding a file open.
func TestStoppingACaptureEndsItsRecording(t *testing.T) {
	requireRuntime(t)

	capabilities := Probe(context.Background())
	encoder := ""
	for _, candidate := range capabilities.Encoders {
		if candidate.Available {
			encoder = candidate.ID
			break
		}
	}
	if encoder == "" {
		t.Skip("no encoder passed its probe on this machine")
	}

	recordings := nativerecording.NewStore(t.TempDir())
	t.Cleanup(recordings.Close)
	manager := NewManager()
	manager.SetRecorder(recordings)
	t.Cleanup(manager.Close)

	sources, err := manager.Sources()
	if err != nil {
		t.Fatalf("Sources: %v", err)
	}
	var display Source
	for _, source := range sources {
		if source.Kind == "monitor" {
			display = source
			break
		}
	}
	if display.ID == "" {
		t.Skip("no display to capture")
	}

	started, err := manager.Start(context.Background(), StartOptions{
		SourceID: display.ID, Encoder: encoder,
		Width: 640, Height: 360, FPS: 30, BitrateMbps: 2,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := recordings.Start(started.SessionID); err != nil {
		t.Fatalf("recording Start: %v", err)
	}
	time.Sleep(700 * time.Millisecond)

	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("capture Stop: %v", err)
	}

	// The capture is gone, so nothing can be recorded from it any more.
	if _, err := recordings.Start(started.SessionID); err == nil {
		t.Error("a recording started from a capture that had ended")
	}
}
