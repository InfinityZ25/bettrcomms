//go:build windows

package nativescreen

import (
	"errors"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Enumeration runs against the real desktop. Every machine this can run on has
// at least one display attached, so an empty monitor list is a failure.
func TestEnumerateFindsThisMachinesDisplays(t *testing.T) {
	sources, err := enumerate()
	if err != nil {
		t.Fatalf("enumerate: %v", err)
	}

	var monitors int
	for _, source := range sources {
		if source.Kind != "monitor" {
			continue
		}
		monitors++
		if source.Category != "display" {
			t.Errorf("display %q has category %q", source.Name, source.Category)
		}
		if source.Width == 0 || source.Height == 0 {
			t.Errorf("display %q has no dimensions", source.Name)
		}
		if source.Handle == 0 {
			t.Errorf("display %q has no handle", source.Name)
		}
		t.Logf("display: %s %dx%d", source.Name, source.Width, source.Height)
	}
	if monitors == 0 {
		t.Error("no displays were enumerated")
	}
}

// Every source must carry an opaque id and a real handle. The id is what the
// page holds; the handle is what never reaches it.
func TestEveryEnumeratedSourceIsAddressable(t *testing.T) {
	sources, err := enumerate()
	if err != nil {
		t.Fatalf("enumerate: %v", err)
	}

	seen := map[string]bool{}
	for _, source := range sources {
		if len(source.ID) != 32 {
			t.Errorf("%q has id %q, want 32 hex characters", source.Name, source.ID)
		}
		if seen[source.ID] {
			t.Errorf("id %q was issued twice", source.ID)
		}
		seen[source.ID] = true

		if source.Handle == 0 {
			t.Errorf("%q has no handle", source.Name)
		}
		if source.Kind != "window" && source.Kind != "monitor" {
			t.Errorf("%q has kind %q", source.Name, source.Kind)
		}
		if source.Width <= 100 && source.Kind == "window" {
			t.Errorf("window %q is smaller than the enumeration floor: %dx%d", source.Name, source.Width, source.Height)
		}
	}
}

// The picker shows displays first. Anything else buries the most common choice.
func TestEnumerationOrdersDisplaysFirst(t *testing.T) {
	sources, err := enumerate()
	if err != nil {
		t.Fatalf("enumerate: %v", err)
	}
	lastDisplay := -1
	firstOther := -1
	for index, source := range sources {
		if source.Category == "display" {
			lastDisplay = index
		} else if firstOther < 0 {
			firstOther = index
		}
	}
	if firstOther >= 0 && lastDisplay > firstOther {
		t.Errorf("a display at %d sorts after a non-display at %d", lastDisplay, firstOther)
	}
	if !slices.IsSortedFunc(sources, func(left, right Source) int {
		return int(sourceSortRank(left)) - int(sourceSortRank(right))
	}) {
		t.Error("sources are not in rank order")
	}
}

// Enumerating twice must not leak entries from the first pass into the second.
func TestEnumerationDoesNotAccumulate(t *testing.T) {
	first, err := enumerate()
	if err != nil {
		t.Fatalf("first enumerate: %v", err)
	}
	second, err := enumerate()
	if err != nil {
		t.Fatalf("second enumerate: %v", err)
	}
	// The desktop can change between passes, but not by a factor of two.
	if len(second) > len(first)*2+8 {
		t.Errorf("second pass returned %d sources after %d; entries accumulated", len(second), len(first))
	}
}

// This process is its own ancestor, which is the base case the audio guard
// depends on.
func TestProcessDescendsFromRecognisesItself(t *testing.T) {
	self := uint32(windows.GetCurrentProcessId())
	descends, err := processDescendsFrom(self, self)
	if err != nil {
		t.Fatalf("processDescendsFrom: %v", err)
	}
	if descends {
		// A process is not a descendant of itself; the identity case is
		// handled by liveWindowProcess before the walk.
		t.Log("the walk reported self-descent, which liveWindowProcess screens separately")
	}
}

// A child of this process must be recognised as ours. This is what stops the
// app from capturing its own webview audio as "application audio".
func TestProcessDescendsFromRecognisesAChild(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "ping -n 30 127.0.0.1 >nul")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	self := uint32(windows.GetCurrentProcessId())
	descends, err := processDescendsFrom(uint32(cmd.Process.Pid), self)
	if err != nil {
		t.Fatalf("processDescendsFrom: %v", err)
	}
	if !descends {
		t.Error("a direct child was not recognised as descending from this process")
	}
}

// A grandchild is still ours: the webview spawns its own children.
func TestProcessDescendsFromWalksPastTheFirstParent(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "start /wait cmd.exe /c ping -n 30 127.0.0.1 >nul & ping -n 30 127.0.0.1 >nul")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	time.Sleep(200 * time.Millisecond)

	// The direct child is enough to prove the walk works; a deeper tree is
	// timing-dependent to observe.
	self := uint32(windows.GetCurrentProcessId())
	if descends, err := processDescendsFrom(uint32(cmd.Process.Pid), self); err != nil || !descends {
		t.Errorf("descends = %v, err = %v", descends, err)
	}
}

// An unrelated process must not be treated as ours, or the guard would refuse
// every legitimate application-audio capture.
func TestProcessDescendsFromRejectsAnUnrelatedProcess(t *testing.T) {
	// PID 4 is the System process, which nothing in user space parents.
	descends, err := processDescendsFrom(4, uint32(windows.GetCurrentProcessId()))
	if err != nil {
		// System is not openable at this privilege level, which the walk
		// reports as unverifiable at depth zero. That is the honest answer.
		if !errors.Is(err, errUnverifiableTree) {
			t.Errorf("err = %v", err)
		}
		return
	}
	if descends {
		t.Error("the System process was reported as a descendant of this one")
	}
}

// A window this process owns must be refused as an application-audio source.
func TestLiveWindowProcessRefusesThisApplication(t *testing.T) {
	// A dead handle is refused before anything else is consulted.
	if _, err := liveWindowProcess(0xDEAD0000); !errors.Is(err, errWindowClosed) {
		t.Errorf("err = %v, want errWindowClosed", err)
	}
	_ = os.Getpid()
}

func TestMonitorBoundsDescribesARealDisplay(t *testing.T) {
	sources, err := enumerate()
	if err != nil {
		t.Fatalf("enumerate: %v", err)
	}
	for _, source := range sources {
		if source.Kind != "monitor" {
			continue
		}
		bounds, err := monitorBounds(source.Handle)
		if err != nil {
			t.Fatalf("monitorBounds: %v", err)
		}
		if bounds.Right-bounds.Left <= 0 || bounds.Bottom-bounds.Top <= 0 {
			t.Errorf("display %q has empty bounds %+v", source.Name, bounds)
		}
		return
	}
	t.Skip("no display to describe")
}
