package nativescreen

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"bettercomms/desktop-wails/internal/native/h264"
)

// One access unit must stay paceable. A VBV large enough to let a keyframe
// reach several hundred kilobytes produces a burst no pacer can spread and
// shallow path buffers drop outright.
func TestRateControlBufferBoundsOneAccessUnitForPacing(t *testing.T) {
	// A tenth of a second of bits.
	for _, test := range []struct{ fps, rate, want uint32 }{
		{120, 20, 2_000},
		{60, 20, 2_000},
		{240, 8, 800},
		// Low frame rates keep at least two frame intervals of headroom.
		{15, 8, 1_067},
	} {
		if got := vbvKilobits(test.fps, test.rate); got != test.want {
			t.Errorf("vbvKilobits(%d, %d) = %d, want %d", test.fps, test.rate, got, test.want)
		}
	}
	// The previous half-second buffer was five times looser at every rate.
	if vbvKilobits(120, 20) >= 20/2*1_000 {
		t.Error("the buffer is no tighter than the half-second one it replaced")
	}
	if vbvKilobits(60, 1) < 64 {
		t.Error("the buffer fell below its floor")
	}
}

func TestCustomCaptureLimitsIncludeHighRefreshRates(t *testing.T) {
	for _, test := range []struct {
		name                            string
		width, height, fps, bitrateMbps uint32
		wantErr                         bool
	}{
		{"720p240", 1280, 720, 240, 12, false},
		{"1080p120 at the bitrate ceiling", 1920, 1080, 120, 200, false},
		{"below the frame-rate floor", 1280, 720, 14, 12, true},
		{"above the frame-rate ceiling", 1280, 720, 241, 12, true},
		{"no bitrate", 1280, 720, 120, 0, true},
		{"above the bitrate ceiling", 1280, 720, 120, 201, true},
		{"wider than 4K", 3841, 1080, 60, 12, true},
		{"taller than 4K", 1920, 2161, 60, 12, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateCaptureSettings(test.width, test.height, test.fps, test.bitrateMbps)
			if (err != nil) != test.wantErr {
				t.Errorf("err = %v, wantErr = %v", err, test.wantErr)
			}
			if err != nil && !errors.Is(err, ErrCaptureSettings) {
				t.Errorf("err = %v, want ErrCaptureSettings", err)
			}
		})
	}
}

// Dimensions are ceilings. Upscaling would add encoder and decoder load
// without adding any source detail.
func TestFitCaptureDimensionsNeverUpscales(t *testing.T) {
	for _, test := range []struct {
		name                                           string
		sourceWidth, sourceHeight, maxWidth, maxHeight uint32
		wantWidth, wantHeight                          uint32
	}{
		{"a smaller source is left alone", 1280, 720, 1920, 1080, 1280, 720},
		{"an exact fit is left alone", 1920, 1080, 1920, 1080, 1920, 1080},
		{"a larger source is scaled down", 3840, 2160, 1920, 1080, 1920, 1080},
		{"the tighter axis wins", 3840, 1080, 1920, 1080, 1920, 540},
		{"an odd result is made even", 1919, 1079, 1919, 1079, 1918, 1078},
		{"a zero source is refused", 0, 720, 1920, 1080, 0, 0},
		{"a zero ceiling is refused", 1280, 720, 0, 1080, 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			width, height := fitCaptureDimensions(test.sourceWidth, test.sourceHeight, test.maxWidth, test.maxHeight)
			if width != test.wantWidth || height != test.wantHeight {
				t.Errorf("got %dx%d, want %dx%d", width, height, test.wantWidth, test.wantHeight)
			}
			// H.264 chroma subsampling needs even dimensions.
			if width%2 != 0 || height%2 != 0 {
				t.Errorf("got odd dimensions %dx%d", width, height)
			}
		})
	}
}

func TestCaptureFilterNamesTheHandleAndSettings(t *testing.T) {
	got := captureFilter("hwnd", 0x1234, true, false, 60, 1920, 1080)

	for _, want := range []string{
		"gfxcapture=hwnd=4660",
		"capture_cursor=1",
		"display_border=0",
		"max_framerate=60",
		"scale=1920:1080",
		"out_color_matrix=bt709",
		"out_range=tv",
		"format=yuv420p",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("filter is missing %q: %s", want, got)
		}
	}
}

// The colour space in the filter and the one announced in the SDP are the same
// choice. A mismatch shows up as washed-out or over-saturated video.
func TestCaptureFilterAndEncoderAgreeOnColour(t *testing.T) {
	filter := captureFilter("hmonitor", 1, false, false, 30, 1280, 720)
	args := encoderArgs("libx264", 30, 8, h264.Main)

	if !strings.Contains(filter, "out_color_matrix=bt709") {
		t.Error("the filter does not convert to bt709")
	}
	if index := slices.Index(args, "-colorspace"); index < 0 || args[index+1] != "bt709" {
		t.Error("the encoder is not told the stream is bt709")
	}
	if !strings.Contains(filter, "out_range=tv") {
		t.Error("the filter does not produce limited range")
	}
	if index := slices.Index(args, "-color_range"); index < 0 || args[index+1] != "tv" {
		t.Error("the encoder is not told the range is limited")
	}
}

// No encoder may emit B-frames: they reorder output, which a real-time sender
// cannot pace and a receiver cannot start on.
func TestNoEncoderEmitsBFrames(t *testing.T) {
	for _, encoder := range []string{"h264_nvenc", "h264_amf", "h264_qsv", "libx264"} {
		args := encoderArgs(encoder, 60, 10, h264.Main)
		index := slices.Index(args, "-bf")
		if index < 0 || args[index+1] != "0" {
			t.Errorf("%s does not disable B-frames: %v", encoder, args)
		}
	}
}

// The hardware encoders must be told to make every recovery point a real IDR.
// A plain I-frame is not something a decoder can restart on.
func TestHardwareEncodersForceRealIDRs(t *testing.T) {
	for encoder, flag := range map[string]string{
		"h264_nvenc": "-forced-idr",
		"h264_amf":   "-forced_idr",
	} {
		args := encoderArgs(encoder, 60, 10, h264.Main)
		index := slices.Index(args, flag)
		if index < 0 || args[index+1] != "1" {
			t.Errorf("%s does not force IDRs: %v", encoder, args)
		}
		if !slices.Contains(args, "-force_key_frames") {
			t.Errorf("%s has no forced keyframe expression", encoder)
		}
	}
}

// AMF rejects FFmpeg's generic "baseline"; it wants the constrained spelling.
func TestAMFSpellsConstrainedBaselineOut(t *testing.T) {
	args := encoderArgs("h264_amf", 60, 10, h264.Baseline)
	index := slices.Index(args, "-profile:v")
	if index < 0 || args[index+1] != "constrained_baseline" {
		t.Errorf("AMF profile = %v, want constrained_baseline", args)
	}
	// Every other encoder takes the plain name.
	for _, encoder := range []string{"h264_nvenc", "h264_qsv", "libx264"} {
		args := encoderArgs(encoder, 60, 10, h264.Baseline)
		index := slices.Index(args, "-profile:v")
		if index < 0 || args[index+1] != "baseline" {
			t.Errorf("%s profile = %v, want baseline", encoder, args)
		}
	}
}

// The GOP length is the keyframe interval in frames, which is what makes the
// recovery point land where the SDP and the recorder expect it.
func TestGOPLengthFollowsTheFrameRate(t *testing.T) {
	for _, fps := range []uint32{30, 60, 120} {
		args := encoderArgs("libx264", fps, 10, h264.Main)
		index := slices.Index(args, "-g")
		if index < 0 {
			t.Fatalf("%d fps: no GOP length", fps)
		}
		want := fps * KeyframeIntervalSeconds
		if args[index+1] != strings.TrimSpace(itoa(want)) {
			t.Errorf("%d fps: GOP = %s, want %d", fps, args[index+1], want)
		}
	}
}

func itoa(value uint32) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func TestSourceCategoryGroupsWindows(t *testing.T) {
	for _, test := range []struct {
		name, title, executable, class, want string
	}{
		{"a browser", "GitHub", `C:\Program Files\Google\Chrome\chrome.exe`, "Chrome_WidgetWin_1", "browser"},
		{"the shell", "File Explorer", "explorer.exe", "CabinetWClass", "utility"},
		{"the desktop", "", "explorer.exe", "Progman", "utility"},
		{"a PowerToys tool", "Awake", "PowerToys.Awake.exe", "Window", "utility"},
		{"a named game", "Minecraft 1.21", "javaw.exe", "GLFW30", "game"},
		{"an Unreal title", "Fortnite", "FortniteClient-Win64-Shipping.exe", "UnrealWindow", "game"},
		{"any Unreal shipping build", "Some Game", "MyGame-Win64-Shipping.exe", "Window", "game"},
		{"a launcher", "Epic Games Launcher", "EpicGamesLauncher.exe", "Window", "app"},
		{"an ordinary app", "Notes", "notes.exe", "Window", "app"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := sourceCategory(test.title, test.executable, test.class); got != test.want {
				t.Errorf("sourceCategory = %q, want %q", got, test.want)
			}
		})
	}
}

// A launcher is an app even when its executable also matches a game rule, so
// the picker does not label a store front as the game it launches.
func TestLauncherWinsOverGameHeuristics(t *testing.T) {
	if got := sourceCategory("Minecraft Launcher", "MinecraftLauncher.exe", "Window"); got != "app" {
		t.Errorf("a launcher was categorised %q, want app", got)
	}
}

func TestSourceSortRankPutsDisplaysFirst(t *testing.T) {
	ranks := map[string]uint8{}
	for _, category := range []string{"display", "game", "browser", "app", "utility"} {
		ranks[category] = sourceSortRank(Source{Category: category})
	}
	if !(ranks["display"] < ranks["game"] &&
		ranks["game"] < ranks["browser"] &&
		ranks["browser"] < ranks["app"] &&
		ranks["app"] < ranks["utility"]) {
		t.Errorf("ranks are out of order: %v", ranks)
	}
}

// The page holds a source ID between refreshes. Minting a new one for a window
// that is plainly the same would silently invalidate a selection.
func TestReconcileSourceIDsKeepsAStableIdentity(t *testing.T) {
	previous := map[string]Source{
		"old-id": {ID: "old-id", Kind: "window", Handle: 0x100, Name: "Editor"},
	}
	current := []Source{
		{ID: "fresh-1", Kind: "window", Handle: 0x100, Name: "Editor"},
		{ID: "fresh-2", Kind: "window", Handle: 0x200, Name: "Browser"},
	}
	reconcileSourceIDs(previous, current)

	if current[0].ID != "old-id" {
		t.Errorf("the unchanged window got id %q, want old-id", current[0].ID)
	}
	if current[1].ID != "fresh-2" {
		t.Errorf("a new window was given id %q", current[1].ID)
	}
}

// A window whose title changed is a different entry: the name is part of what
// the person picked.
func TestReconcileSourceIDsTreatsARenamedWindowAsNew(t *testing.T) {
	previous := map[string]Source{
		"old-id": {ID: "old-id", Kind: "window", Handle: 0x100, Name: "Editor"},
	}
	current := []Source{{ID: "fresh", Kind: "window", Handle: 0x100, Name: "Editor — modified"}}
	reconcileSourceIDs(previous, current)

	if current[0].ID != "fresh" {
		t.Errorf("a renamed window reused id %q", current[0].ID)
	}
}

// annexB builds a start code plus one NAL of the given type.
func annexB(kind byte, payload ...byte) []byte {
	return append([]byte{0, 0, 0, 1, kind}, payload...)
}

// Access units are split on delimiters so SPS, PPS, SEI and the slice they
// describe stay in one unit. A receiver joining at a keyframe needs all of it.
func TestAccessUnitsSplitOnDelimiters(t *testing.T) {
	var units accessUnits

	// Two complete units, then the start of a third.
	stream := slices.Concat(
		annexB(9, 0x10), annexB(7, 0x42), annexB(8, 0xce), annexB(5, 0xaa),
		annexB(9, 0x10), annexB(1, 0xbb),
		annexB(9, 0x10), annexB(1, 0xcc),
	)
	frames, err := units.push(stream)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("got %d frames, want 2", len(frames))
	}
	// The first unit must still carry its parameter sets.
	if !containsNAL(frames[0], 7) || !containsNAL(frames[0], 8) || !containsNAL(frames[0], 5) {
		t.Error("the keyframe unit lost its parameter sets")
	}
	if !containsNAL(frames[1], 1) {
		t.Error("the second unit lost its slice")
	}
}

// A delimiter with no picture must not be forwarded: it would advance RTP time
// for a frame the receiver never gets.
func TestAccessUnitsDropDelimiterOnlyUnits(t *testing.T) {
	var units accessUnits

	stream := slices.Concat(
		annexB(9, 0x10),
		annexB(9, 0x10),
		annexB(1, 0xbb),
		annexB(9, 0x10),
	)
	frames, err := units.push(stream)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	for _, frame := range frames {
		if !carriesPicture(frame) {
			t.Errorf("a delimiter-only unit was forwarded: %x", frame)
		}
	}
}

// A unit split across two reads must come out whole.
func TestAccessUnitsSurviveASplitRead(t *testing.T) {
	var units accessUnits

	whole := slices.Concat(annexB(9, 0x10), annexB(5, 0xaa, 0xbb, 0xcc), annexB(9, 0x10), annexB(1, 0xdd))
	half := len(whole) / 2

	if frames, err := units.push(whole[:half]); err != nil {
		t.Fatalf("first push: %v", err)
	} else if len(frames) != 0 {
		t.Fatalf("a partial unit was emitted: %d frames", len(frames))
	}
	frames, err := units.push(whole[half:])
	if err != nil {
		t.Fatalf("second push: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1", len(frames))
	}
	if !containsNAL(frames[0], 5) {
		t.Error("the reassembled unit lost its keyframe slice")
	}
}

// An encoder producing something this pipeline was not built to carry must
// fail loudly rather than growing without bound.
func TestAccessUnitsRefuseAnUnboundedFrame(t *testing.T) {
	var units accessUnits
	// No delimiter, so nothing ever drains.
	chunk := make([]byte, 1024*1024)
	for range 9 {
		if _, err := units.push(chunk); err != nil {
			return
		}
	}
	t.Error("the buffer grew past its limit without failing")
}

func containsNAL(frame []byte, kind byte) bool {
	for i := 0; i+3 < len(frame); i++ {
		if frame[i] == 0 && frame[i+1] == 0 && frame[i+2] == 1 && frame[i+3]&31 == kind {
			return true
		}
	}
	return false
}
