package overlay

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// The visual copilot's second surface: the signals a viewer sends land on the
// sharer's desktop, over the application being shared, rather than only inside
// BetterComms.
//
// This is a separate manager from the camera tile because the two have opposite
// shapes. The camera overlay is one window in a corner that lives as long as
// the camera is on. A copilot signal is one of several small windows, each
// pinned to a point inside the shared source, each expiring on its own, and all
// of them following the shared window as it is moved, resized, or covered.
const (
	// MaxCopilotOverlays bounds how many signals can be on screen at once.
	// Five is more than a person can read; past that they occlude the very
	// thing being pointed at.
	MaxCopilotOverlays = 5
	// MaxCopilotWidth and MaxCopilotHeight bound one signal. A signal is an
	// annotation, not a second view of the screen.
	MaxCopilotWidth  = 480
	MaxCopilotHeight = 360

	// copilotMargin insets a corner-anchored signal from the source's edge.
	copilotMargin = 12

	// A lease allows background WebView timer throttling without leaving an
	// orphaned annotation behind when the page disappears.
	copilotTimeout       = 4 * time.Second
	copilotTrailLifetime = 450 * time.Millisecond
	// copilotWatchInterval is how often placement is re-checked. The shared
	// window can be dragged, and a signal that lags behind it points at
	// nothing.
	copilotWatchInterval = 100 * time.Millisecond
)

// CopilotPoint is the anchor mode of one signal.
//
// It pins the signal to a normalised position inside the shared source; the
// four corner values pin it to the source's own corners instead, which is where
// a capture card goes so it does not cover what is being discussed.
const CopilotPoint = "point"

var copilotCorners = map[string]bool{
	CopilotPoint: true, "top-left": true, "top-right": true,
	"bottom-left": true, "bottom-right": true,
}

// Geometry is where the shared source sits on the virtual desktop, and how
// large the encoder is making it.
//
// The overlay package defines its own shape rather than importing the capture
// package, so placement stays testable without a capture running.
type Geometry struct {
	Left, Top     int32
	Width, Height uint32
	EncodedWidth  uint32
	EncodedHeight uint32
}

// GeometryFunc measures a live capture session. requireForeground asks for a
// measurement only while the shared window is the one in front.
type GeometryFunc func(sessionID string, requireForeground bool) (Geometry, error)

// CopilotFrame describes one signal the page is drawing.
type CopilotFrame struct {
	// MarkID identifies the signal across refreshes. It is the page's own mark
	// id, so a moving signal reuses its window instead of flickering.
	MarkID string `json:"markId"`
	// SessionID names the capture the signal belongs to. A signal for a
	// session that ended is refused rather than placed on the desktop.
	SessionID string `json:"sessionId"`
	// Corner is CopilotPoint or one of the four source corners.
	Corner string `json:"corner"`
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
	// X and Y are the normalised position inside the source, used by
	// CopilotPoint.
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// CopilotUpdate reconciles the annotations for one capture. Artwork is sent
// once through Frame; subsequent updates contain only position and expiry.
type CopilotUpdate struct {
	SessionID string            `json:"sessionId"`
	Marks     []CopilotPosition `json:"marks"`
}

type CopilotPosition struct {
	MarkID      string              `json:"markId"`
	Corner      string              `json:"corner"`
	X           float64             `json:"x"`
	Y           float64             `json:"y"`
	RemainingMS uint32              `json:"remainingMs"`
	Revision    uint64              `json:"revision"`
	Trail       []CopilotTrailPoint `json:"trail,omitempty"`
}

type CopilotTrailPoint struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	AgeMS uint32  `json:"ageMs"`
}

// Status describes actual source presentation, independently of delivery over
// the call channel. Missing identifies artwork expired by the native lease.
type CopilotStatus struct {
	State   string   `json:"state"`
	Missing []string `json:"missing"`
}

func (u CopilotUpdate) validate() error {
	if u.SessionID == "" || len(u.SessionID) > 128 || len(u.Marks) > MaxCopilotOverlays {
		return errors.New("Visual overlay update is invalid")
	}
	seen := make(map[string]bool, len(u.Marks))
	for _, mark := range u.Marks {
		frame := CopilotFrame{MarkID: mark.MarkID, SessionID: u.SessionID, Corner: mark.Corner, Width: 1, Height: 1, X: mark.X, Y: mark.Y}
		if err := frame.validate(); err != nil {
			return err
		}
		if seen[mark.MarkID] || mark.RemainingMS == 0 || mark.RemainingMS > 60_000 || mark.Revision == 0 || mark.Revision > 9_007_199_254_740_991 || len(mark.Trail) > 6 {
			return errors.New("Visual overlay update is invalid")
		}
		seen[mark.MarkID] = true
		if len(mark.Trail) > 0 && mark.Corner != CopilotPoint {
			return errors.New("Only point signals can carry a laser trail")
		}
		for _, point := range mark.Trail {
			if !insideSource(point.X) || !insideSource(point.Y) || point.AgeMS > uint32(copilotTrailLifetime/time.Millisecond) {
				return errors.New("Visual overlay trail is invalid")
			}
		}
	}
	return nil
}

// validate bounds everything the page controls.
//
// The page is trusted to draw a signal, not to name a window, a size, or a
// position outside the shared source. Every field is checked here so a bug or a
// hostile page cannot put an unbounded window at an arbitrary desktop
// coordinate.
func (f CopilotFrame) validate() error {
	if f.MarkID == "" || len(f.MarkID) > 64 {
		return errors.New("Visual overlay id is invalid")
	}
	for _, c := range []byte(f.MarkID) {
		alphanumeric := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if !alphanumeric && c != '-' {
			return errors.New("Visual overlay id is invalid")
		}
	}
	if f.SessionID == "" || len(f.SessionID) > 128 {
		return errors.New("Visual overlay names no share")
	}
	if !copilotCorners[f.Corner] {
		return fmt.Errorf("unknown visual overlay anchor %q", f.Corner)
	}
	if f.Width == 0 || f.Height == 0 || f.Width > MaxCopilotWidth || f.Height > MaxCopilotHeight {
		return errors.New("Visual overlay dimensions are unsupported")
	}
	if !insideSource(f.X) || !insideSource(f.Y) {
		return errors.New("The signal points outside captured content")
	}
	return nil
}

// insideSource reports whether a normalised coordinate names a place in the
// captured picture. NaN and infinity fail it, which is why the comparison is
// written as two bounds rather than a distance.
func insideSource(value float64) bool {
	return value >= 0 && value <= 1
}

// copilotPosition maps a signal onto the virtual desktop.
//
// Native capture scales the whole source without letterboxing, and viewer
// coordinates already exclude the CSS letterboxing on their side, so a
// normalised point maps straight back onto the source rectangle. The encoded
// dimensions do not enter the arithmetic: rounding them to even pixels must not
// move where a signal lands.
func copilotPosition(geometry Geometry, width, height uint32, x, y float64, corner string) (int32, int32) {
	if corner != CopilotPoint {
		left, top := int32(copilotMargin), int32(copilotMargin)
		if strings.HasSuffix(corner, "right") {
			left = max(int32(geometry.Width)-int32(width)-copilotMargin, 0)
		}
		if strings.HasPrefix(corner, "bottom") {
			top = max(int32(geometry.Height)-int32(height)-copilotMargin, 0)
		}
		return geometry.Left + left, geometry.Top + top
	}
	return geometry.Left + int32(math.Round(x*float64(geometry.Width))) - int32(width)/2,
		geometry.Top + int32(math.Round(y*float64(geometry.Height))) - int32(height)/2
}

// copilotItem is one signal's window and the state needed to keep following it.
type copilotItem struct {
	surface      surface
	session      string
	corner       string
	width        uint32
	height       uint32
	x            float64
	y            float64
	refreshed    time.Time
	expires      time.Time
	renewable    bool
	revision     uint64
	art          []byte
	trail        []CopilotTrailPoint
	trailAt      time.Time
	trailPainted bool
	placed       bool
	left, top    int32
	shown        bool
}

// CopilotManager owns the signal windows over a shared source.
type CopilotManager struct {
	geometry GeometryFunc
	// now is injected so the expiry rule can be tested without sleeping.
	now   func() time.Time
	paint func(surface, uint32, uint32, []byte, bool) error
	place func(surface, int32, int32, bool) error

	mu       sync.Mutex
	items    map[string]*copilotItem
	watching bool
	stop     chan struct{}
}

// NewCopilotManager returns a manager with no signals on screen. geometry is
// how it finds the shared source; a nil geometry refuses every signal.
func NewCopilotManager(geometry GeometryFunc) *CopilotManager {
	return &CopilotManager{
		geometry: geometry,
		now:      time.Now,
		paint:    paintSurface,
		place:    placeSurface,
		items:    map[string]*copilotItem{},
	}
}

// Frame draws or refreshes one signal.
//
// rgba is the signal's own picture at exactly the declared size. Unlike the
// camera tile there is no scaling: the page drew this at the size it wants, and
// resampling an annotation only blurs its text.
func (m *CopilotManager) Frame(frame CopilotFrame, rgba []byte) error {
	if err := frame.validate(); err != nil {
		return err
	}
	if uint64(len(rgba)) != uint64(frame.Width)*uint64(frame.Height)*4 {
		return errors.New("Visual overlay RGBA frame length is invalid")
	}
	if m.geometry == nil {
		return errors.New("Visual overlays require Windows native sharing")
	}

	geometry, err := m.geometry(frame.SessionID, false)
	if err != nil {
		return err
	}
	left, top := copilotPosition(geometry, frame.Width, frame.Height, frame.X, frame.Y, frame.Corner)

	bgra, err := rgbaToBGRAScaled(rgba, frame.Width, frame.Height, frame.Width, frame.Height)
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// A signal that changed share or size needs a new window: a layered window
	// is painted through a buffer sized once, and the share it is placed
	// against decides where it belongs.
	if item, ok := m.items[frame.MarkID]; ok &&
		(item.session != frame.SessionID || item.width != frame.Width || item.height != frame.Height) {
		closeSurface(item.surface)
		delete(m.items, frame.MarkID)
	}

	item, ok := m.items[frame.MarkID]
	if !ok {
		if len(m.items) >= MaxCopilotOverlays {
			return errors.New("Too many visual overlays")
		}
		opened, fittedWidth, fittedHeight, err := openSurface(frame.Width, frame.Height, TopLeft, true)
		if err != nil {
			return err
		}
		if fittedWidth != frame.Width || fittedHeight != frame.Height {
			closeSurface(opened)
			return errors.New("The screen is too small for this overlay")
		}
		item = &copilotItem{surface: opened, session: frame.SessionID, width: frame.Width, height: frame.Height}
		m.items[frame.MarkID] = item
	}

	item.corner, item.x, item.y = frame.Corner, frame.X, frame.Y
	item.refreshed = m.now()
	item.art = bgra
	item.trail = nil
	item.trailPainted = false

	if err := m.draw(item, bgra, left, top); err != nil {
		closeSurface(item.surface)
		delete(m.items, frame.MarkID)
		return err
	}
	m.watchLocked()
	return nil
}

// draw paints and places one signal. Every annotation is hidden while the
// shared window is not in front, so it never floats over unrelated content.
func (m *CopilotManager) draw(item *copilotItem, bgra []byte, left, top int32) error {
	if err := m.paint(item.surface, item.width, item.height, bgra, false); err != nil {
		return err
	}
	return m.placeItem(item, left, top, m.visible(item))
}

func (m *CopilotManager) visible(item *copilotItem) bool {
	_, err := m.geometry(item.session, true)
	return err == nil
}

func (m *CopilotManager) placeItem(item *copilotItem, left, top int32, visible bool) error {
	if item.placed && item.left == left && item.top == top && item.shown == visible {
		return nil
	}
	if err := m.place(item.surface, left, top, visible); err != nil {
		return err
	}
	item.placed, item.left, item.top, item.shown = true, left, top, visible
	return nil
}

// Sync renews a bounded lease and moves existing windows without transmitting,
// converting, or repainting their artwork. Validation precedes every mutation.
func (m *CopilotManager) Sync(update CopilotUpdate) (CopilotStatus, error) {
	result := CopilotStatus{State: "unavailable", Missing: []string{}}
	if err := update.validate(); err != nil {
		return result, err
	}
	if m.geometry == nil {
		return result, nil
	}
	geometry, err := m.geometry(update.SessionID, false)
	visible := false
	if err == nil {
		_, foregroundErr := m.geometry(update.SessionID, true)
		visible = foregroundErr == nil
		if visible {
			result.State = "visible"
		} else {
			result.State = "hidden"
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mark := range update.Marks {
		if item := m.items[mark.MarkID]; item != nil && item.session == update.SessionID && mark.Revision < item.revision {
			return result, errors.New("Visual overlay update is stale")
		}
	}
	wanted := make(map[string]bool, len(update.Marks))
	for _, mark := range update.Marks {
		wanted[mark.MarkID] = true
	}
	for id, item := range m.items {
		if item.session == update.SessionID && (err != nil || !wanted[id]) {
			m.removeLocked(id)
		}
	}
	if err != nil {
		m.stopIfEmptyLocked()
		return result, nil
	}

	now := m.now()
	for _, mark := range update.Marks {
		item := m.items[mark.MarkID]
		if item == nil || item.session != update.SessionID {
			result.Missing = append(result.Missing, mark.MarkID)
			continue
		}
		if m.expired(item, now) {
			m.removeLocked(mark.MarkID)
			result.Missing = append(result.Missing, mark.MarkID)
			continue
		}
		item.corner, item.x, item.y, item.refreshed = mark.Corner, mark.X, mark.Y, now
		deadline := now.Add(time.Duration(mark.RemainingMS) * time.Millisecond)
		if item.expires.IsZero() || mark.Revision > item.revision {
			item.expires, item.renewable = deadline, mark.RemainingMS == 60_000
		} else if item.renewable && mark.RemainingMS == 60_000 {
			item.expires = deadline
		} else {
			item.renewable = false
			if deadline.Before(item.expires) {
				item.expires = deadline
			}
		}
		item.revision = mark.Revision
		item.trail = append(item.trail[:0], mark.Trail...)
		item.trailAt = now
		if err := m.paintTrail(item, geometry, now); err != nil {
			m.removeLocked(mark.MarkID)
			return result, err
		}
		left, top := copilotPosition(geometry, item.width, item.height, item.x, item.y, item.corner)
		if err := m.placeItem(item, left, top, visible); err != nil {
			m.removeLocked(mark.MarkID)
			return result, err
		}
	}
	if len(m.items) > 0 {
		m.watchLocked()
	} else {
		m.stopIfEmptyLocked()
	}
	return result, nil
}

func (m *CopilotManager) expired(item *copilotItem, now time.Time) bool {
	return now.Sub(item.refreshed) >= copilotTimeout || (!item.expires.IsZero() && !now.Before(item.expires))
}

// paintTrail touches a small cached sprite only while a short tail is fading.
// Once the tail expires its original pixels are restored exactly once.
func (m *CopilotManager) paintTrail(item *copilotItem, geometry Geometry, now time.Time) error {
	frame, live := copilotTrailFrame(item.art, item.width, item.height, geometry, item.x, item.y, item.trail, now.Sub(item.trailAt))
	if !live && !item.trailPainted {
		return nil
	}
	if !live {
		frame = item.art
		item.trail = nil
	}
	if err := m.paint(item.surface, item.width, item.height, frame, false); err != nil {
		return err
	}
	item.trailPainted = live
	return nil
}

func copilotTrailFrame(art []byte, width, height uint32, geometry Geometry, x, y float64, points []CopilotTrailPoint, elapsed time.Duration) ([]byte, bool) {
	var frame []byte
	for _, point := range points {
		age := time.Duration(point.AgeMS)*time.Millisecond + max(elapsed, 0)
		if age >= copilotTrailLifetime {
			continue
		}
		cx := float64(width)/2 + (point.X-x)*float64(geometry.Width)
		cy := float64(height)/2 + (point.Y-y)*float64(geometry.Height)
		const radius = 3.0
		if cx+radius < 0 || cy+radius < 0 || cx-radius >= float64(width) || cy-radius >= float64(height) {
			continue
		}
		if frame == nil {
			frame = append([]byte(nil), art...)
		}
		alpha := 0.65 * (1 - float64(age)/float64(copilotTrailLifetime))
		for py := max(int(math.Floor(cy-radius)), 0); py < min(int(math.Ceil(cy+radius)), int(height)); py++ {
			for px := max(int(math.Floor(cx-radius)), 0); px < min(int(math.Ceil(cx+radius)), int(width)); px++ {
				distance := math.Hypot(float64(px)+0.5-cx, float64(py)+0.5-cy)
				if distance >= radius {
					continue
				}
				a := alpha * min(radius-distance, 1)
				offset := (py*int(width) + px) * 4
				for channel, value := range [4]float64{95, 102, 255, 255} {
					frame[offset+channel] = byte(math.Round(value*a + float64(frame[offset+channel])*(1-a)))
				}
			}
		}
	}
	return frame, frame != nil
}

func (m *CopilotManager) removeLocked(id string) {
	if item := m.items[id]; item != nil {
		closeSurface(item.surface)
		delete(m.items, id)
	}
}

func (m *CopilotManager) stopIfEmptyLocked() {
	if len(m.items) == 0 && m.watching {
		close(m.stop)
		m.watching, m.stop = false, nil
	}
}

// Clear takes every signal off the desktop.
func (m *CopilotManager) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clearLocked()
}

func (m *CopilotManager) clearLocked() {
	for id := range m.items {
		m.removeLocked(id)
	}
	m.stopIfEmptyLocked()
}

// Shutdown clears the overlays on exit, so no signal window outlives the
// process that drew it.
func (m *CopilotManager) Shutdown() { m.Clear() }

// Count reports how many signals are on screen.
func (m *CopilotManager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.items)
}

// watchLocked starts the follower if it is not already running.
func (m *CopilotManager) watchLocked() {
	if m.watching {
		return
	}
	stop := make(chan struct{})
	m.watching, m.stop = true, stop
	go m.watch(stop)
}

// watch keeps every signal on its source and closes the ones nothing is
// refreshing.
//
// Without it a signal would stay where it was first drawn while the shared
// window moved out from under it, and a page that crashed mid-call would leave
// windows floating over the desktop with nothing left to remove them.
func (m *CopilotManager) watch(stop chan struct{}) {
	ticker := time.NewTicker(copilotWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if !m.reposition(stop) {
				return
			}
		}
	}
}

// reposition runs one follower pass and reports whether the follower should
// keep going.
func (m *CopilotManager) reposition(stop chan struct{}) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stop != stop {
		// This pass belongs to a follower that has already been replaced.
		return false
	}

	type sourceState struct {
		geometry           Geometry
		available, visible bool
	}
	sources := make(map[string]sourceState)
	now := m.now()
	for id, item := range m.items {
		if m.expired(item, now) {
			m.removeLocked(id)
			continue
		}
		source, known := sources[item.session]
		if !known {
			geometry, err := m.geometry(item.session, false)
			source = sourceState{geometry: geometry, available: err == nil}
			if err == nil {
				_, err = m.geometry(item.session, true)
				source.visible = err == nil
			}
			sources[item.session] = source
		}
		if !source.available {
			m.removeLocked(id)
			continue
		}
		left, top := copilotPosition(source.geometry, item.width, item.height, item.x, item.y, item.corner)
		if err := m.paintTrail(item, source.geometry, now); err != nil {
			m.removeLocked(id)
			continue
		}
		if err := m.placeItem(item, left, top, source.visible); err != nil {
			m.removeLocked(id)
		}
	}

	if len(m.items) > 0 {
		return true
	}
	m.watching, m.stop = false, nil
	return false
}
