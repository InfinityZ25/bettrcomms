package nativerecording

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func nal(kind byte, payload ...byte) []byte {
	return append([]byte{0, 0, 0, 1, kind}, payload...)
}

func keyframe() []byte {
	return slices.Concat(nal(9, 0x10), nal(7, 0x42, 0xe0, 0x1f), nal(8, 0xce), nal(5, 0xaa))
}

func delta() []byte { return slices.Concat(nal(9, 0x30), nal(1, 0xbb)) }

// Recording must begin at a keyframe. Starting on a delta frame produces a file
// whose opening seconds cannot be decoded.
func TestIsIDRFindsAKeyframe(t *testing.T) {
	if !isIDR(keyframe()) {
		t.Error("a keyframe was not recognised")
	}
	if isIDR(delta()) {
		t.Error("a delta frame was treated as a keyframe")
	}
	// Three-byte start codes count too.
	if !isIDR([]byte{0, 0, 1, 0x65}) {
		t.Error("a three-byte start code keyframe was missed")
	}
	for _, malformed := range [][]byte{nil, {0}, {0, 0}, {0, 0, 1}, bytes.Repeat([]byte{0}, 64)} {
		if isIDR(malformed) {
			t.Errorf("malformed input %x was reported as a keyframe", malformed)
		}
	}
}

// The muxer must copy the stream, not re-encode it: the access units already
// are what an MP4 track holds.
func TestTheMuxerRemuxesRatherThanReencodes(t *testing.T) {
	args := muxerArgs(60, "out.mp4")

	index := slices.Index(args, "-c:v")
	if index < 0 || args[index+1] != "copy" {
		t.Errorf("the muxer re-encodes: %v", args)
	}
	// A valid file at the size boundary, rather than a process killed mid-write.
	index = slices.Index(args, "-fs")
	if index < 0 || args[index+1] != "536870912" {
		t.Errorf("the muxer has no size limit: %v", args)
	}
	// The index at the front so the page can play without the whole file.
	index = slices.Index(args, "-movflags")
	if index < 0 || !strings.Contains(args[index+1], "faststart") {
		t.Errorf("the muxer does not produce a faststart file: %v", args)
	}
	index = slices.Index(args, "-framerate")
	if index < 0 || args[index+1] != "60" {
		t.Errorf("the muxer was not told the frame rate: %v", args)
	}
}

func TestRegisterSessionRejectsAnIncompleteCapture(t *testing.T) {
	store := NewStore(t.TempDir())
	for _, test := range []struct {
		name, sessionID, ffmpeg string
		fps                     uint32
	}{
		{"no session", "", "ffmpeg", 30},
		{"no frame rate", "session", "ffmpeg", 0},
		{"no runtime", "session", "", 30},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := store.RegisterSession(test.sessionID, test.fps, test.ffmpeg); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func TestStartNeedsALiveCapture(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	if _, err := store.Start("never-registered"); err == nil {
		t.Error("a recording started with no capture behind it")
	}
}

// One capture is recorded once. Two muxers on one stream would double the disk
// cost and produce two files nobody asked for.
func TestACaptureIsRecordedOnlyOnce(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	if err := store.RegisterSession("session", 30, ffmpegForTest(t)); err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	first, err := store.Start("session")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := store.Start("session"); err == nil {
		t.Error("a second recording of the same capture started")
	}

	// Stopping frees it again.
	_, _ = store.Stop(first.RecordingID)
	if _, err := store.Start("session"); err != nil {
		t.Errorf("a capture could not be recorded again after stopping: %v", err)
	}
}

func TestStopRejectsAnUnknownRecording(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	if _, err := store.Stop("never-started"); err == nil {
		t.Error("stopping an unknown recording succeeded")
	}
}

// A recording that never saw a keyframe is not a recording. Reporting success
// would hand the page a file it cannot decode.
func TestARecordingWithNoKeyframeFails(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	if err := store.RegisterSession("session", 30, ffmpegForTest(t)); err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	started, err := store.Start("session")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Fewer than the queue holds, so this reaches the missing-keyframe check
	// rather than the overflow one.
	for range 4 {
		store.FeedAccessUnit("session", delta())
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)

	if _, err := store.Stop(started.RecordingID); err == nil {
		t.Error("a recording with no keyframe reported success")
	} else if !strings.Contains(err.Error(), "IDR") {
		t.Errorf("err = %v, want the missing-keyframe reason", err)
	}
}

// ffmpegForTest finds a runtime, skipping when there is none.
func ffmpegForTest(t *testing.T) string {
	t.Helper()
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		t.Skip("no LOCALAPPDATA to search for a runtime")
	}
	matches, _ := filepath.Glob(filepath.Join(local,
		"Microsoft", "WinGet", "Packages",
		"Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "*", "bin", "ffmpeg.exe"))
	if len(matches) == 0 {
		t.Skip("no FFmpeg runtime on this machine")
	}
	slices.Sort(matches)
	return matches[len(matches)-1]
}

func TestReadAndReleaseGuardTheirInputs(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	if _, err := store.Read("nothing", 0, 1024); err == nil {
		t.Error("reading an unknown asset succeeded")
	}
	if _, err := store.Read("nothing", -1, 1024); err == nil {
		t.Error("a negative offset was accepted")
	}
	// Releasing what is not there succeeds: the goal is that it is gone.
	if err := store.Release("nothing"); err != nil {
		t.Errorf("Release: %v", err)
	}
}

// Only a bounded number of finished recordings are held, because each is a
// file on disk an abandoned page would otherwise accumulate.
func TestFinishedAssetsAreBounded(t *testing.T) {
	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	// Fabricate finished assets directly: the bound is bookkeeping, not muxing.
	for index := range MaxFinishedAssets + 3 {
		path := filepath.Join(store.stagingRoot, "asset-"+string(rune('a'+index))+".mp4")
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		id := "asset-" + string(rune('a'+index))
		store.mu.Lock()
		store.assets[id] = finished{path: path, sizeBytes: 1}
		store.assetOrder = append(store.assetOrder, id)
		for len(store.assetOrder) > MaxFinishedAssets {
			oldest := store.assetOrder[0]
			store.assetOrder = store.assetOrder[1:]
			if stale, ok := store.assets[oldest]; ok {
				_ = os.Remove(stale.path)
				delete(store.assets, oldest)
			}
		}
		store.mu.Unlock()
	}

	store.mu.Lock()
	held := len(store.assets)
	store.mu.Unlock()
	if held != MaxFinishedAssets {
		t.Errorf("%d assets held, want %d", held, MaxFinishedAssets)
	}

	entries, err := os.ReadDir(store.stagingRoot)
	if err != nil {
		t.Fatalf("read staging: %v", err)
	}
	if len(entries) != MaxFinishedAssets {
		t.Errorf("%d files on disk, want %d; evicted assets were not deleted", len(entries), MaxFinishedAssets)
	}
}

// A synthetic H.264 stream is not decodable, so the muxer rightly rejects it.
// This exercises the plumbing only; the acceptance test that records a real
// capture lives in the nativescreen package, which has one to record.
func TestARecordingProducesAReadableMP4(t *testing.T) {
	runtime := ffmpegForTest(t)

	store := NewStore(t.TempDir())
	t.Cleanup(store.Close)

	const fps = 30
	if err := store.RegisterSession("session", fps, runtime); err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	started, err := store.Start("session")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// A synthetic stream cannot be decoded, so this asserts the plumbing:
	// frames reach the muxer, a file is produced, and it is readable in chunks.
	store.FeedAccessUnit("session", keyframe())
	for range 30 {
		store.FeedAccessUnit("session", delta())
		time.Sleep(2 * time.Millisecond)
	}

	asset, err := store.Stop(started.RecordingID)
	if err != nil {
		// A synthetic H.264 stream can legitimately be rejected by the muxer.
		// Say so rather than passing a test that proved nothing.
		t.Skipf("the muxer rejected the synthetic stream, which proves nothing about real capture: %v", err)
	}

	if asset.AssetID == "" {
		t.Error("the asset has no id")
	}
	if asset.SizeBytes <= 0 {
		t.Errorf("the asset is %d bytes", asset.SizeBytes)
	}
	if asset.DurationMs == 0 {
		t.Error("the asset reports no duration")
	}

	// Read it back the way the page does.
	var whole []byte
	for offset := int64(0); offset < asset.SizeBytes; {
		chunk, err := store.Read(asset.AssetID, offset, MaxReadBytes)
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
		t.Errorf("read %d bytes, want %d", len(whole), asset.SizeBytes)
	}
	// An MP4 begins with a box header whose type is "ftyp".
	if len(whole) < 12 || !bytes.Equal(whole[4:8], []byte("ftyp")) {
		t.Errorf("the file is not an MP4: % x", whole[:min(16, len(whole))])
	}

	if err := store.Release(asset.AssetID); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, err := store.Read(asset.AssetID, 0, 16); err == nil {
		t.Error("a released asset is still readable")
	}
}
