package overlay

import (
	"bytes"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// A monitor to the left of the primary one has a negative origin. Mapping a
// point through it must land on that monitor, not near zero.
func TestPointsMapOntoNegativeMonitorOrigins(t *testing.T) {
	geometry := Geometry{Left: -1920, Top: 0, Width: 1920, Height: 1080, EncodedWidth: 1280, EncodedHeight: 720}
	left, top := copilotPosition(geometry, 100, 100, 0.5, 0.5, CopilotPoint)
	if left != -1010 || top != 490 {
		t.Errorf("centre of a left-hand monitor mapped to (%d, %d), want (-1010, 490)", left, top)
	}
}

// The encoded size is not the source size: it is fitted and rounded to even
// pixels. A signal must land on the source, so the encoded numbers must not
// appear in the arithmetic at all.
func TestPortraitAndRoundedUltrawideFramesMapWithoutPadding(t *testing.T) {
	for _, test := range []struct {
		name       string
		geometry   Geometry
		x, y       float64
		left, top  int32
		signalSize uint32
	}{
		{
			name:       "a portrait window whose encode is taller than wide",
			geometry:   Geometry{Left: 20, Top: 30, Width: 500, Height: 900, EncodedWidth: 600, EncodedHeight: 1080},
			x:          0.1,
			y:          0.9,
			left:       20,
			top:        790,
			signalSize: 100,
		},
		{
			name:       "an ultrawide display whose encode height rounds",
			geometry:   Geometry{Left: 0, Top: 0, Width: 3440, Height: 1440, EncodedWidth: 1920, EncodedHeight: 802},
			x:          0.7,
			y:          0.6,
			left:       2358,
			top:        814,
			signalSize: 100,
		},
		{
			name:       "the top-left corner of the source",
			geometry:   Geometry{Left: 0, Top: 0, Width: 3440, Height: 1440, EncodedWidth: 1920, EncodedHeight: 802},
			x:          0,
			y:          0,
			left:       -50,
			top:        -50,
			signalSize: 100,
		},
		{
			name:       "the bottom-right corner of the source",
			geometry:   Geometry{Left: 0, Top: 0, Width: 3440, Height: 1440, EncodedWidth: 1920, EncodedHeight: 802},
			x:          1,
			y:          1,
			left:       3390,
			top:        1390,
			signalSize: 100,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			left, top := copilotPosition(test.geometry, test.signalSize, test.signalSize, test.x, test.y, CopilotPoint)
			if left != test.left || top != test.top {
				t.Errorf("mapped to (%d, %d), want (%d, %d)", left, top, test.left, test.top)
			}
		})
	}
}

// A corner-anchored card sits inside the source, inset from its edge, and
// follows the source's own origin rather than the desktop's.
func TestCornersAnchorInsideTheSource(t *testing.T) {
	geometry := Geometry{Left: 100, Top: 200, Width: 1000, Height: 800}
	for _, test := range []struct {
		corner    string
		left, top int32
	}{
		{"top-left", 112, 212},
		{"top-right", 100 + 1000 - 300 - 12, 212},
		{"bottom-left", 112, 200 + 800 - 200 - 12},
		{"bottom-right", 100 + 1000 - 300 - 12, 200 + 800 - 200 - 12},
	} {
		t.Run(test.corner, func(t *testing.T) {
			left, top := copilotPosition(geometry, 300, 200, 0.5, 0.5, test.corner)
			if left != test.left || top != test.top {
				t.Errorf("%s anchored at (%d, %d), want (%d, %d)", test.corner, left, top, test.left, test.top)
			}
		})
	}
}

// A signal wider than the source it is anchored in must not be pushed off the
// left edge to make the inset fit.
func TestACornerSignalLargerThanItsSourceStaysAtTheOrigin(t *testing.T) {
	geometry := Geometry{Left: 40, Top: 60, Width: 200, Height: 150}
	left, top := copilotPosition(geometry, 480, 360, 0, 0, "bottom-right")
	if left != 40 || top != 60 {
		t.Errorf("an oversized card anchored at (%d, %d), want the source origin (40, 60)", left, top)
	}
}

func TestFramesOutsideTheSourceAreRefused(t *testing.T) {
	for _, test := range []struct {
		name string
		x, y float64
	}{
		{"left of the source", -0.01, 0.5},
		{"below the source", 0.5, 1.01},
		{"a NaN coordinate", math.NaN(), 0.5},
		{"an infinite coordinate", 0.5, math.Inf(1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			frame := validFrame()
			frame.X, frame.Y = test.x, test.y
			if err := frame.validate(); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func validFrame() CopilotFrame {
	return CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: CopilotPoint,
		Width: 40, Height: 40, X: 0.5, Y: 0.5,
	}
}

func TestFrameValidationBoundsWhatThePageControls(t *testing.T) {
	if err := validFrame().validate(); err != nil {
		t.Fatalf("a valid frame was rejected: %v", err)
	}

	for _, test := range []struct {
		name   string
		change func(*CopilotFrame)
	}{
		{"an empty id", func(f *CopilotFrame) { f.MarkID = "" }},
		{"an overlong id", func(f *CopilotFrame) { f.MarkID = strings.Repeat("a", 65) }},
		{"an id with a path separator", func(f *CopilotFrame) { f.MarkID = "../evil" }},
		{"an id with a space", func(f *CopilotFrame) { f.MarkID = "mark 1" }},
		{"no session", func(f *CopilotFrame) { f.SessionID = "" }},
		{"an unknown anchor", func(f *CopilotFrame) { f.Corner = "middle" }},
		{"a zero width", func(f *CopilotFrame) { f.Width = 0 }},
		{"a zero height", func(f *CopilotFrame) { f.Height = 0 }},
		{"a width past the bound", func(f *CopilotFrame) { f.Width = MaxCopilotWidth + 1 }},
		{"a height past the bound", func(f *CopilotFrame) { f.Height = MaxCopilotHeight + 1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			frame := validFrame()
			test.change(&frame)
			if err := frame.validate(); err == nil {
				t.Error("accepted")
			}
		})
	}
}

// The manager must not open a window for a share that is not running. Checking
// the geometry before anything is created is what keeps a stale signal from
// briefly appearing on the desktop.
func TestASignalForAnEndedShareNeverOpensAWindow(t *testing.T) {
	manager := NewCopilotManager(func(string, bool) (Geometry, error) {
		return Geometry{}, errors.New("The native share ended or changed")
	})
	t.Cleanup(manager.Shutdown)

	if err := manager.Frame(validFrame(), make([]byte, 40*40*4)); err == nil {
		t.Fatal("a signal for an ended share was accepted")
	}
	if manager.Count() != 0 {
		t.Errorf("%d windows were left open", manager.Count())
	}
}

func TestAFrameThatDoesNotMatchItsDimensionsIsRefused(t *testing.T) {
	manager := NewCopilotManager(func(string, bool) (Geometry, error) {
		t.Error("the geometry was measured before the frame was checked")
		return Geometry{}, nil
	})
	t.Cleanup(manager.Shutdown)

	if err := manager.Frame(validFrame(), make([]byte, 40*40*4-1)); err == nil {
		t.Error("a short frame was accepted")
	}
}

// A host with no capture support must refuse rather than panic on a nil
// measurement function.
func TestAManagerWithNoCaptureRefusesSignals(t *testing.T) {
	manager := NewCopilotManager(nil)
	t.Cleanup(manager.Shutdown)

	if err := manager.Frame(validFrame(), make([]byte, 40*40*4)); err == nil {
		t.Error("a signal was accepted with no way to measure the share")
	}
}

func validUpdate() CopilotUpdate {
	return CopilotUpdate{SessionID: "session-1", Marks: []CopilotPosition{{MarkID: "mark-1", Corner: CopilotPoint, X: 0.5, Y: 0.5, RemainingMS: 1000, Revision: 1}}}
}

func TestSyncValidatesTheWholeBatchBeforeTouchingTheSource(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*CopilotUpdate)
	}{
		{"no session", func(u *CopilotUpdate) { u.SessionID = "" }},
		{"overlong session", func(u *CopilotUpdate) { u.SessionID = strings.Repeat("s", 129) }},
		{"duplicate marks", func(u *CopilotUpdate) { u.Marks = append(u.Marks, u.Marks[0]) }},
		{"too many marks", func(u *CopilotUpdate) { u.Marks = make([]CopilotPosition, 6) }},
		{"invalid second mark", func(u *CopilotUpdate) { u.Marks = append(u.Marks, CopilotPosition{MarkID: "../bad"}) }},
		{"expired lifetime", func(u *CopilotUpdate) { u.Marks[0].RemainingMS = 0 }},
		{"unbounded lifetime", func(u *CopilotUpdate) { u.Marks[0].RemainingMS = 60_001 }},
		{"no revision", func(u *CopilotUpdate) { u.Marks[0].Revision = 0 }},
		{"unsafe revision", func(u *CopilotUpdate) { u.Marks[0].Revision = 9_007_199_254_740_992 }},
		{"not finite", func(u *CopilotUpdate) { u.Marks[0].X = math.NaN() }},
		{"unknown anchor", func(u *CopilotUpdate) { u.Marks[0].Corner = "elsewhere" }},
		{"too many trail points", func(u *CopilotUpdate) { u.Marks[0].Trail = make([]CopilotTrailPoint, 7) }},
		{"old trail point", func(u *CopilotUpdate) { u.Marks[0].Trail = []CopilotTrailPoint{{X: 0.5, Y: 0.5, AgeMS: 451}} }},
		{"outside trail point", func(u *CopilotUpdate) { u.Marks[0].Trail = []CopilotTrailPoint{{X: -0.1, Y: 0.5}} }},
		{"trail on card", func(u *CopilotUpdate) {
			u.Marks[0].Corner = "top-right"
			u.Marks[0].Trail = []CopilotTrailPoint{{X: 0.5, Y: 0.5}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := NewCopilotManager(func(string, bool) (Geometry, error) {
				t.Error("invalid update measured the source")
				return Geometry{}, nil
			})
			update := validUpdate()
			test.change(&update)
			if _, err := manager.Sync(update); err == nil {
				t.Fatal("invalid update accepted")
			}
		})
	}
}

func TestSyncReportsMissingArtworkAndCanProbeAnEmptySource(t *testing.T) {
	manager := NewCopilotManager(func(string, bool) (Geometry, error) { return Geometry{Width: 1920, Height: 1080}, nil })
	status, err := manager.Sync(validUpdate())
	if err != nil || status.State != "visible" || len(status.Missing) != 1 || status.Missing[0] != "mark-1" {
		t.Fatalf("missing artwork: %+v, %v", status, err)
	}
	if manager.watching || manager.Count() != 0 {
		t.Fatal("a missing sprite started the native watcher")
	}
	status, err = manager.Sync(CopilotUpdate{SessionID: "session-1"})
	if err != nil || status.State != "visible" || len(status.Missing) != 0 {
		t.Fatalf("empty probe: %+v, %v", status, err)
	}

	manager.geometry = func(string, bool) (Geometry, error) { return Geometry{}, errors.New("ended") }
	status, err = manager.Sync(validUpdate())
	if err != nil || status.State != "unavailable" {
		t.Fatalf("ended source: %+v, %v", status, err)
	}
	manager.geometry = func(_ string, requireForeground bool) (Geometry, error) {
		if requireForeground {
			return Geometry{}, errors.New("covered")
		}
		return Geometry{Width: 1920, Height: 1080}, nil
	}
	status, err = manager.Sync(CopilotUpdate{SessionID: "session-1"})
	if err != nil || status.State != "hidden" {
		t.Fatalf("hidden source: %+v, %v", status, err)
	}
	status, err = NewCopilotManager(nil).Sync(validUpdate())
	if err != nil || status.State != "unavailable" {
		t.Fatalf("unsupported host: %+v, %v", status, err)
	}
}

func TestLaserTrailIsBoundedFadesAndPreservesCachedArtwork(t *testing.T) {
	art := make([]byte, 20*20*4)
	geometry := Geometry{Width: 1000, Height: 1000}
	points := []CopilotTrailPoint{{X: 0.495, Y: 0.5, AgeMS: 10}}
	bright, live := copilotTrailFrame(art, 20, 20, geometry, 0.5, 0.5, points, 0)
	if !live || bytes.Equal(bright, art) || !bytes.Equal(art, make([]byte, len(art))) {
		t.Fatal("the trail failed to draw separately from cached artwork")
	}
	faded, live := copilotTrailFrame(art, 20, 20, geometry, 0.5, 0.5, points, 300*time.Millisecond)
	if !live {
		t.Fatal("a young trail disappeared")
	}
	brightAlpha, fadedAlpha := 0, 0
	for index := 3; index < len(art); index += 4 {
		brightAlpha += int(bright[index])
		fadedAlpha += int(faded[index])
	}
	if fadedAlpha >= brightAlpha {
		t.Fatal("the trail did not fade")
	}
	if frame, live := copilotTrailFrame(art, 20, 20, geometry, 0.5, 0.5, points, copilotTrailLifetime); live || frame != nil {
		t.Fatal("an expired trail still allocated a frame")
	}
	if frame, live := copilotTrailFrame(art, 20, 20, geometry, 0.5, 0.5, []CopilotTrailPoint{{X: 0.1, Y: 0.1}}, 0); live || frame != nil {
		t.Fatal("a trail outside the sprite allocated or painted outside it")
	}
}
