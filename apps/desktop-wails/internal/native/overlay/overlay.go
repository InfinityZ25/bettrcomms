// Package overlay draws the always-on-top camera tile over other applications.
//
// The overlay is a layered window this process owns, painted from RGBA frames
// the page sends. It is deliberately not a second webview: a webview would cost
// a browser engine per overlay, could not be excluded from the shared capture,
// and could not be made click-through.
//
// Two properties matter and are enforced here rather than assumed:
//
//   - The overlay is excluded from screen capture, so sharing a display does
//     not show the viewer a picture of themselves inside their own share.
//   - Frames are paced. The page sends what its camera produces; painting all
//     of it would spend the GPU on frames nobody can see.
package overlay

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	// MaxWidth and MaxHeight bound one frame. They are generous for a camera
	// tile and small enough that a frame stays a bounded allocation.
	MaxWidth  = 640
	MaxHeight = 900
	// MaxFrameBytes is the largest RGBA buffer the page may send.
	MaxFrameBytes = MaxWidth * MaxHeight * 4
	// MaxFPS is the paint rate. Beyond this the paint costs more than it shows.
	MaxFPS = 24

	// minFrameInterval is the pacing floor derived from MaxFPS.
	minFrameInterval = time.Second / MaxFPS

	// heartbeatInterval and frameTimeout close an overlay the page stopped
	// feeding, so a crashed page cannot leave a window floating over the
	// desktop.
	heartbeatInterval = 2 * time.Second
	frameTimeout      = 6 * time.Second
)

// Position is which corner of the display the overlay sits in.
type Position string

const (
	TopLeft     Position = "top-left"
	TopRight    Position = "top-right"
	BottomLeft  Position = "bottom-left"
	BottomRight Position = "bottom-right"
)

// Valid reports whether p is a corner this package places.
func (p Position) Valid() bool {
	switch p {
	case TopLeft, TopRight, BottomLeft, BottomRight:
		return true
	}
	return false
}

// Size is the overlay's width preset.
type Size string

const (
	Small  Size = "small"
	Medium Size = "medium"
	Large  Size = "large"
)

// Width is the pixel width of a preset. An unknown preset takes the middle
// one rather than failing: a bad preset is a page bug, not a reason to leave
// someone without their camera tile.
func (s Size) Width() uint32 {
	switch s {
	case Small:
		return 240
	case Large:
		return 400
	default:
		return 320
	}
}

// Info is what the page needs to send frames the overlay will accept.
type Info struct {
	OverlayID string `json:"overlayId"`
	Width     uint32 `json:"width"`
	Height    uint32 `json:"height"`
	MaxWidth  uint32 `json:"maxWidth"`
	MaxHeight uint32 `json:"maxHeight"`
	// MaxFrameBytes and MaxFPS let the page size and pace its own sends rather
	// than discovering the limits by being refused.
	MaxFrameBytes int   `json:"maxFrameBytes"`
	MaxFPS        uint8 `json:"maxFps"`
}

// Options describe an overlay to open.
type Options struct {
	Position Position `json:"position"`
	Size     Size     `json:"size"`
	// ClickThrough lets the pointer reach whatever is underneath. A camera tile
	// over a game must not eat clicks.
	ClickThrough bool `json:"clickThrough"`
	// Rows stacks that many 16:9 tiles vertically.
	Rows uint8 `json:"rows"`
}

// Update changes an open overlay. A nil field is left as it is.
type Update struct {
	Position     *Position `json:"position,omitempty"`
	Size         *Size     `json:"size,omitempty"`
	ClickThrough *bool     `json:"clickThrough,omitempty"`
	Rows         *uint8    `json:"rows,omitempty"`
}

var (
	// ErrClosed reports an overlay that is not open.
	ErrClosed = errors.New("Camera overlay is closed")
	// ErrStale reports a grant for an overlay that has since been replaced.
	ErrStale = errors.New("Camera overlay grant is stale")
)

// validateRows bounds the tile stack. One row is a single camera; more than
// four is taller than any corner of a display can usefully hold.
func validateRows(rows uint8) error {
	if rows < 1 || rows > 4 {
		return errors.New("Camera overlay rows must be 1 to 4")
	}
	return nil
}

// layout is the pixel size of a stack of 16:9 tiles at the given width.
func layout(width uint32, rows uint8) (uint32, uint32) {
	return width, width * 9 / 16 * uint32(rows)
}

// state is one open overlay.
type state struct {
	id           string
	position     Position
	width        uint32
	height       uint32
	clickThrough bool
	rows         uint8
	shown        bool
	lastFrame    time.Time
	nextFrameAt  time.Time
}

func (s *state) info() Info {
	return Info{
		OverlayID:     s.id,
		Width:         s.width,
		Height:        s.height,
		MaxWidth:      MaxWidth,
		MaxHeight:     MaxHeight,
		MaxFrameBytes: MaxFrameBytes,
		MaxFPS:        MaxFPS,
	}
}

// advanceFrameDeadline moves the pacing deadline one interval on, resetting to
// now when the overlay has been idle.
//
// Stepping the deadline rather than setting it to now+interval keeps a steady
// cadence under jitter; snapping back when it has fallen behind stops a paused
// camera from earning a burst of credit it would spend all at once.
func advanceFrameDeadline(deadline, now time.Time) time.Time {
	next := deadline.Add(minFrameInterval)
	if next.Before(now) {
		return now.Add(minFrameInterval)
	}
	return next
}

// rgbaToBGRAScaled converts a page frame to the premultiplied BGRA a layered
// window wants, scaling to the overlay's current size.
//
// Nearest-neighbour is deliberate: this runs per frame on the paint thread for
// a small tile, and a filtered resample would cost more than the difference is
// worth at this size.
func rgbaToBGRAScaled(source []byte, sourceWidth, sourceHeight, width, height uint32) ([]byte, error) {
	if uint64(len(source)) != uint64(sourceWidth)*uint64(sourceHeight)*4 {
		return nil, errors.New("Camera overlay RGBA frame length is invalid")
	}
	if width == 0 || height == 0 {
		return nil, errors.New("Camera overlay has no area to paint")
	}

	out := make([]byte, uint64(width)*uint64(height)*4)
	for y := uint32(0); y < height; y++ {
		sourceY := uint64(y) * uint64(sourceHeight) / uint64(height)
		for x := uint32(0); x < width; x++ {
			sourceX := uint64(x) * uint64(sourceWidth) / uint64(width)
			from := (sourceY*uint64(sourceWidth) + sourceX) * 4
			to := (uint64(y)*uint64(width) + uint64(x)) * 4

			// UpdateLayeredWindow expects premultiplied alpha; handing it
			// straight alpha shows a bright halo around anything translucent.
			alpha := uint16(source[from+3])
			out[to] = byte(uint16(source[from+2]) * alpha / 255)
			out[to+1] = byte(uint16(source[from+1]) * alpha / 255)
			out[to+2] = byte(uint16(source[from]) * alpha / 255)
			out[to+3] = byte(alpha)
		}
	}
	return out, nil
}

// Manager owns the single camera overlay this application may show.
type Manager struct {
	lifecycle sync.Mutex
	mu        sync.Mutex
	current   *state
	surface   surface

	stopHeartbeat chan struct{}
}

// NewManager returns a manager with no overlay open.
func NewManager() *Manager { return &Manager{} }

func newOverlayID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("Could not allocate overlay ID")
	}
	return hex.EncodeToString(raw), nil
}

// Open shows an overlay, replacing any that was already open.
func (m *Manager) Open(options Options) (Info, error) {
	if !options.Position.Valid() {
		return Info{}, fmt.Errorf("unknown overlay position %q", options.Position)
	}
	if err := validateRows(options.Rows); err != nil {
		return Info{}, err
	}

	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.closeCurrent()

	id, err := newOverlayID()
	if err != nil {
		return Info{}, err
	}
	width, height := layout(options.Size.Width(), options.Rows)
	if height > MaxHeight {
		return Info{}, errors.New("Camera overlay is taller than the display allows")
	}

	surface, fittedWidth, fittedHeight, err := openSurface(width, height, options.Position, options.ClickThrough)
	if err != nil {
		return Info{}, err
	}

	now := time.Now()
	current := &state{
		id:           id,
		position:     options.Position,
		width:        fittedWidth,
		height:       fittedHeight,
		clickThrough: options.ClickThrough,
		rows:         options.Rows,
		lastFrame:    now,
		nextFrameAt:  now,
	}

	m.mu.Lock()
	m.current = current
	m.surface = surface
	m.mu.Unlock()

	m.startHeartbeat(id)
	return current.info(), nil
}

// Update changes an open overlay's placement or size.
func (m *Manager) Update(overlayID string, change Update) (Info, error) {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()

	m.mu.Lock()
	current, surface := m.current, m.surface
	m.mu.Unlock()
	if current == nil {
		return Info{}, ErrClosed
	}
	if current.id != overlayID {
		return Info{}, ErrStale
	}

	next := *current
	if change.Position != nil {
		if !change.Position.Valid() {
			return Info{}, fmt.Errorf("unknown overlay position %q", *change.Position)
		}
		next.position = *change.Position
	}
	if change.Size != nil {
		next.width = change.Size.Width()
	}
	if change.Rows != nil {
		if err := validateRows(*change.Rows); err != nil {
			return Info{}, err
		}
		next.rows = *change.Rows
	}
	if change.ClickThrough != nil {
		next.clickThrough = *change.ClickThrough
	}
	next.width, next.height = layout(next.width, next.rows)

	fittedWidth, fittedHeight, err := configureSurface(surface, next.width, next.height, next.position, next.clickThrough)
	if err != nil {
		return Info{}, err
	}
	next.width, next.height = fittedWidth, fittedHeight

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != overlayID {
		return Info{}, ErrStale
	}
	*m.current = next
	return m.current.info(), nil
}

// Frame paints one RGBA frame, pacing it to the overlay's rate.
func (m *Manager) Frame(overlayID string, sourceWidth, sourceHeight uint32, rgba []byte) error {
	if sourceWidth == 0 || sourceHeight == 0 || sourceWidth > MaxWidth || sourceHeight > MaxHeight {
		return errors.New("Camera overlay frame dimensions are unsupported")
	}
	expected := uint64(sourceWidth) * uint64(sourceHeight) * 4
	if expected > MaxFrameBytes {
		return errors.New("Camera overlay frame is too large")
	}
	if uint64(len(rgba)) != expected {
		return errors.New("Camera overlay RGBA frame length is invalid")
	}

	m.mu.Lock()
	current, surface := m.current, m.surface
	if current == nil {
		m.mu.Unlock()
		return ErrClosed
	}
	if current.id != overlayID {
		m.mu.Unlock()
		return ErrStale
	}
	if sourceWidth != current.width || sourceHeight != current.height {
		m.mu.Unlock()
		return errors.New("Camera overlay frame dimensions do not match the current layout")
	}
	targetWidth, targetHeight := current.width, current.height
	show := !current.shown
	delay := time.Until(current.nextFrameAt)
	m.mu.Unlock()

	// Early frames are paced, not discarded: the page sends one at a time, so
	// dropping one would drop a frame nothing replaces.
	if delay > 0 {
		time.Sleep(delay)
	}

	bgra, err := rgbaToBGRAScaled(rgba, sourceWidth, sourceHeight, targetWidth, targetHeight)
	if err != nil {
		return err
	}
	if err := paintSurface(surface, targetWidth, targetHeight, bgra, show); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != overlayID {
		return nil
	}
	now := time.Now()
	m.current.lastFrame = now
	m.current.nextFrameAt = advanceFrameDeadline(m.current.nextFrameAt, now)
	if show {
		m.current.shown = true
	}
	return nil
}

// Close hides the named overlay.
func (m *Manager) Close(overlayID string) error {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()

	m.mu.Lock()
	current := m.current
	m.mu.Unlock()
	if current == nil {
		return nil
	}
	if current.id != overlayID {
		return ErrStale
	}
	m.closeCurrent()
	return nil
}

// Shutdown closes any overlay. The application calls this on exit so no window
// outlives the process that created it.
func (m *Manager) Shutdown() {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.closeCurrent()
}

func (m *Manager) closeCurrent() {
	m.mu.Lock()
	surface := m.surface
	m.current = nil
	m.surface = nil
	stop := m.stopHeartbeat
	m.stopHeartbeat = nil
	m.mu.Unlock()

	if stop != nil {
		close(stop)
	}
	if surface != nil {
		closeSurface(surface)
	}
}

// startHeartbeat closes an overlay the page has stopped feeding.
//
// The page is the only thing that knows the camera is still on. If it crashes
// or navigates away, nothing else would ever take this window off the desktop.
func (m *Manager) startHeartbeat(overlayID string) {
	stop := make(chan struct{})
	m.mu.Lock()
	m.stopHeartbeat = stop
	m.mu.Unlock()

	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				m.mu.Lock()
				current := m.current
				expired := current != nil && current.id == overlayID &&
					time.Since(current.lastFrame) > frameTimeout
				m.mu.Unlock()
				if expired {
					_ = m.Close(overlayID)
					return
				}
			}
		}
	}()
}
