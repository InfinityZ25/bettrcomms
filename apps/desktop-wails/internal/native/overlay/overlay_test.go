package overlay

import (
	"errors"
	"testing"
	"time"
)

// UpdateLayeredWindow expects premultiplied BGRA. Handing it straight alpha
// draws a bright halo around anything translucent, and getting the channel
// order wrong swaps red and blue.
func TestRGBAToBGRAPremultipliesAndSwapsChannels(t *testing.T) {
	// One opaque pixel: red 10, green 20, blue 30.
	opaque := []byte{10, 20, 30, 255}
	got, err := rgbaToBGRAScaled(opaque, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("rgbaToBGRAScaled: %v", err)
	}
	if want := []byte{30, 20, 10, 255}; string(got) != string(want) {
		t.Errorf("opaque pixel = %v, want %v (BGRA)", got, want)
	}

	// Half-transparent white must come out half-bright, not full-bright.
	half := []byte{255, 255, 255, 128}
	got, err = rgbaToBGRAScaled(half, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("rgbaToBGRAScaled: %v", err)
	}
	if got[0] > 130 || got[1] > 130 || got[2] > 130 {
		t.Errorf("half-transparent white = %v, want the colour premultiplied down", got)
	}
	if got[3] != 128 {
		t.Errorf("alpha = %d, want 128", got[3])
	}

	// A fully transparent pixel contributes no colour at all.
	clear := []byte{255, 0, 0, 0}
	got, err = rgbaToBGRAScaled(clear, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("rgbaToBGRAScaled: %v", err)
	}
	if got[0] != 0 || got[1] != 0 || got[2] != 0 || got[3] != 0 {
		t.Errorf("transparent pixel = %v, want all zero", got)
	}
}

func TestRGBAToBGRAScales(t *testing.T) {
	// A 2x2 frame: distinct opaque colours per quadrant.
	source := []byte{
		1, 0, 0, 255, 2, 0, 0, 255,
		3, 0, 0, 255, 4, 0, 0, 255,
	}

	// Down to 1x1 takes the top-left sample.
	got, err := rgbaToBGRAScaled(source, 2, 2, 1, 1)
	if err != nil {
		t.Fatalf("downscale: %v", err)
	}
	if len(got) != 4 || got[2] != 1 {
		t.Errorf("downscaled = %v, want the top-left sample", got)
	}

	// Up to 4x4 repeats each sample without reading out of bounds.
	got, err = rgbaToBGRAScaled(source, 2, 2, 4, 4)
	if err != nil {
		t.Fatalf("upscale: %v", err)
	}
	if len(got) != 4*4*4 {
		t.Errorf("upscaled to %d bytes, want %d", len(got), 4*4*4)
	}
	// The last row's last pixel comes from the source's bottom-right.
	if last := got[len(got)-2]; last != 4 {
		t.Errorf("bottom-right = %d, want 4", last)
	}
}

func TestRGBAToBGRARejectsAMismatchedLength(t *testing.T) {
	if _, err := rgbaToBGRAScaled([]byte{1, 2, 3}, 1, 1, 1, 1); err == nil {
		t.Error("a short frame was accepted")
	}
	if _, err := rgbaToBGRAScaled(make([]byte, 16), 2, 2, 0, 1); err == nil {
		t.Error("a zero-width target was accepted")
	}
}

// Pacing must hold a steady cadence under jitter, and must not let a paused
// camera earn credit it spends as a burst when it resumes.
func TestAdvanceFrameDeadlineHoldsCadenceAndResetsAfterAPause(t *testing.T) {
	start := time.Now()

	// A frame arriving on time steps the deadline one interval.
	next := advanceFrameDeadline(start, start)
	if want := start.Add(minFrameInterval); !next.Equal(want) {
		t.Errorf("next = %v, want %v", next, want)
	}

	// Slight jitter still steps by one interval rather than resetting.
	next = advanceFrameDeadline(next, next.Add(-time.Millisecond))
	if want := start.Add(2 * minFrameInterval); !next.Equal(want) {
		t.Errorf("jittered next = %v, want %v", next, want)
	}

	// A long pause resets rather than accumulating credit.
	late := start.Add(10 * time.Second)
	next = advanceFrameDeadline(next, late)
	if want := late.Add(minFrameInterval); !next.Equal(want) {
		t.Errorf("after a pause next = %v, want %v", next, want)
	}
}

func TestSizePresetsAndLayout(t *testing.T) {
	for preset, want := range map[Size]uint32{Small: 240, Medium: 320, Large: 400} {
		if got := preset.Width(); got != want {
			t.Errorf("%s width = %d, want %d", preset, got, want)
		}
	}
	// An unknown preset takes the middle one rather than failing: a bad preset
	// is a page bug, not a reason to leave someone without their camera.
	if got := Size("enormous").Width(); got != 320 {
		t.Errorf("unknown preset width = %d, want the medium 320", got)
	}

	// A row of 16:9 tiles is 9/16 of the width, stacked.
	for _, test := range []struct {
		width        uint32
		rows         uint8
		wantW, wantH uint32
	}{
		{320, 1, 320, 180},
		{320, 2, 320, 360},
		{400, 3, 400, 675},
	} {
		width, height := layout(test.width, test.rows)
		if width != test.wantW || height != test.wantH {
			t.Errorf("layout(%d, %d) = %dx%d, want %dx%d",
				test.width, test.rows, width, height, test.wantW, test.wantH)
		}
	}
}

func TestValidateRowsBoundsTheStack(t *testing.T) {
	for _, rows := range []uint8{1, 2, 3, 4} {
		if err := validateRows(rows); err != nil {
			t.Errorf("%d rows was rejected: %v", rows, err)
		}
	}
	for _, rows := range []uint8{0, 5, 255} {
		if err := validateRows(rows); err == nil {
			t.Errorf("%d rows was accepted", rows)
		}
	}
}

func TestPositionValidity(t *testing.T) {
	for _, position := range []Position{TopLeft, TopRight, BottomLeft, BottomRight} {
		if !position.Valid() {
			t.Errorf("%s was rejected", position)
		}
	}
	for _, position := range []Position{"", "middle", "TOP-LEFT"} {
		if position.Valid() {
			t.Errorf("%q was accepted", position)
		}
	}
}

// A closed manager refuses everything rather than reaching for a nil surface.
func TestAClosedOverlayRefusesEverything(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Update("nothing", Update{}); !errors.Is(err, ErrClosed) {
		t.Errorf("Update err = %v, want ErrClosed", err)
	}
	if err := manager.Frame("nothing", 320, 180, make([]byte, 320*180*4)); !errors.Is(err, ErrClosed) {
		t.Errorf("Frame err = %v, want ErrClosed", err)
	}
	// Closing what is not open succeeds: the goal is that it is gone.
	if err := manager.Close("nothing"); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestOpenRejectsBadOptions(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Open(Options{Position: "middle", Size: Medium, Rows: 1}); err == nil {
		t.Error("an unknown position was accepted")
	}
	if _, err := manager.Open(Options{Position: TopRight, Size: Medium, Rows: 0}); err == nil {
		t.Error("a zero row count was accepted")
	}
}

// Frame dimensions are checked before anything is painted, so a page cannot
// make the overlay read past a buffer it supplied.
func TestFrameDimensionsAreCheckedBeforePainting(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Shutdown)

	for _, test := range []struct {
		name          string
		width, height uint32
		payload       int
	}{
		{"no width", 0, 180, 0},
		{"beyond the maximum width", MaxWidth + 1, 180, 4},
		{"beyond the maximum height", 320, MaxHeight + 1, 4},
		{"a payload shorter than declared", 320, 180, 16},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := manager.Frame("any", test.width, test.height, make([]byte, test.payload))
			if err == nil {
				t.Error("accepted")
			}
			// The dimension check must come before the closed check, or a
			// malformed frame would be reported as merely late.
			if errors.Is(err, ErrClosed) && test.name != "a payload shorter than declared" {
				t.Errorf("err = %v, want a dimension failure", err)
			}
		})
	}
}
