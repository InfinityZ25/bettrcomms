// Package nativescreen shares a window or display through Windows Graphics
// Capture, encoded by a bounded native encoder process.
//
// Capture goes through FFmpeg's gfxcapture filter and a hardware H.264 encoder.
// The encoded access units go straight to WebRTC: no frame is ever handed to a
// browser video encoder, which is what keeps a 4K120 share from costing the
// sender a software encode.
package nativescreen

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"bettercomms/desktop-wails/internal/native/h264"
)

// KeyframeIntervalSeconds is the time between IDR frames, which is the worst
// case a viewer waits to start or to recover from loss the sender cannot
// retransmit.
//
// A measured 1080p VMAF comparison of one-second against two-second intervals
// at 60 and 120 FPS and 8 and 20 Mbps put every pair within 0.16 VMAF, with the
// sign reversing between repeated runs of the same settings. The interval has
// no measurable quality cost in this range, so take the shorter recovery. This
// is not a substitute for answering a PLI, which the encoder subprocess cannot.
const KeyframeIntervalSeconds = 1

// maxAccessUnitBytes bounds one encoded frame. A larger one means the encoder
// is producing something this pipeline was not built to carry.
const maxAccessUnitBytes = 8 * 1024 * 1024

// Source is one shareable window or display.
type Source struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Width     uint32 `json:"width"`
	Height    uint32 `json:"height"`
	Category  string `json:"category"`
	Minimized bool   `json:"minimized"`
	// Handle is the HWND or HMONITOR. It never reaches the page: the web client
	// only ever names a source by its opaque ID.
	Handle uintptr `json:"-"`
}

// Encoder is one H.264 encoder and whether this machine can actually run it.
type Encoder struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

// Capabilities is what native sharing can do on this machine.
type Capabilities struct {
	Available bool      `json:"available"`
	Detail    string    `json:"detail"`
	Encoders  []Encoder `json:"encoders"`
	Version   uint8     `json:"version"`
}

// Started describes a capture that is now running.
type Started struct {
	SessionID   string       `json:"sessionId"`
	Width       uint32       `json:"width"`
	Height      uint32       `json:"height"`
	FPS         uint32       `json:"fps"`
	Encoder     string       `json:"encoder"`
	H264Profile h264.Profile `json:"h264Profile"`
	BitrateMbps uint32       `json:"bitrateMbps"`
}

// ErrCaptureSettings names settings outside what this host will encode.
var ErrCaptureSettings = errors.New("Choose 15–240 FPS, up to 4K and 1–200 Mbps")

// validateCaptureSettings bounds what the page may ask the encoder for.
func validateCaptureSettings(width, height, fps, bitrateMbps uint32) error {
	if fps < 15 || fps > 240 || bitrateMbps < 1 || bitrateMbps > 200 || width > 3840 || height > 2160 {
		return ErrCaptureSettings
	}
	return nil
}

// fitCaptureDimensions scales a source down to fit a ceiling, never up.
//
// The maxima are ceilings, including the 4K safety ceiling behind "Match
// source". Upscaling adds encoder and decoder load without adding any source
// detail, so the scale is clamped at 1.
func fitCaptureDimensions(sourceWidth, sourceHeight, maximumWidth, maximumHeight uint32) (uint32, uint32) {
	if sourceWidth == 0 || sourceHeight == 0 || maximumWidth == 0 || maximumHeight == 0 {
		return 0, 0
	}
	scale := math.Min(
		float64(maximumWidth)/float64(sourceWidth),
		float64(maximumHeight)/float64(sourceHeight),
	)
	scale = math.Min(scale, 1)

	// H.264 chroma subsampling needs even dimensions, and a zero-sized plane
	// is not encodable, so two is the floor.
	even := func(value float64) uint32 {
		rounded := uint32(math.Floor(value)) / 2 * 2
		if rounded < 2 {
			return 2
		}
		return rounded
	}
	return even(float64(sourceWidth) * scale), even(float64(sourceHeight) * scale)
}

// captureFilter is the FFmpeg filter chain for one capture: Windows Graphics
// Capture into system memory, scaled to the negotiated size, in the colour
// space the SDP announces.
func captureFilter(handleKind string, handle uintptr, cursor, displayBorder bool, fps, width, height uint32) string {
	flag := func(on bool) int {
		if on {
			return 1
		}
		return 0
	}
	return fmt.Sprintf(
		"gfxcapture=%s=%d:capture_cursor=%d:display_border=%d:max_framerate=%d,hwdownload,format=bgra,scale=%d:%d:out_color_matrix=bt709:out_range=tv,format=yuv420p",
		handleKind, handle, flag(cursor), flag(displayBorder), fps, width, height,
	)
}

// thumbnailFilter is the smaller chain used for a picker preview.
func thumbnailFilter(handleKind string, handle uintptr) string {
	return fmt.Sprintf(
		"gfxcapture=%s=%d:capture_cursor=0:display_border=0:max_framerate=30:width=640:height=360:resize_mode=scale_aspect:scale_mode=bilinear,hwdownload,format=bgra,format=yuvj420p",
		handleKind, handle,
	)
}

// vbvKilobits is the rate-control buffer for one capture, in kilobits.
//
// A half-second VBV lets a single access unit reach several hundred kilobytes,
// which arrives as a burst no pacer can usefully spread and which shallow path
// buffers drop outright. Bound one frame to about a tenth of a second of bits,
// and never to less than two frame intervals so low frame rates keep headroom.
func vbvKilobits(fps, rate uint32) uint32 {
	if fps == 0 {
		fps = 1
	}
	seconds := math.Max(2/float64(fps), 0.1)
	buffer := uint32(math.Round(float64(rate) * 1000 * seconds))
	if buffer < 64 {
		return 64
	}
	return buffer
}

// encoderArgs are the FFmpeg output arguments for one encoder.
//
// Every branch here exists to produce a stream a joining receiver can start on
// and a lossy path can recover from: no B-frames, a real IDR at every recovery
// point, and parameter sets repeated with it.
func encoderArgs(encoder string, fps, rate uint32, profile h264.Profile) []string {
	profileName := profile.FFmpegName()
	// AMF spells constrained baseline out; FFmpeg's generic "baseline" is not
	// a profile it accepts.
	if encoder == "h264_amf" && profile == h264.Baseline {
		profileName = "constrained_baseline"
	}
	keyframeInterval := fps * KeyframeIntervalSeconds

	args := []string{
		"-c:v", encoder,
		"-pix_fmt", "yuv420p",
		"-colorspace", "bt709",
		"-color_primaries", "bt709",
		"-color_trc", "bt709",
		"-color_range", "tv",
		"-profile:v", profileName,
		"-bf", "0",
		"-g", strconv.FormatUint(uint64(keyframeInterval), 10),
		"-b:v", fmt.Sprintf("%dM", rate),
		"-maxrate", fmt.Sprintf("%dM", rate),
		"-bufsize", fmt.Sprintf("%dk", vbvKilobits(fps, rate)),
	}
	forcedIDR := fmt.Sprintf("expr:gte(t,n_forced*%d)", KeyframeIntervalSeconds)

	switch encoder {
	case "h264_nvenc":
		// Every viewer and recording needs the recovery point to be a real
		// IDR, not a plain I-frame the decoder cannot restart on.
		args = append(args, "-forced-idr", "1", "-force_key_frames", forcedIDR)
		// Measured low-bitrate quality preset; retain no B-frames or lookahead.
		args = append(args,
			"-preset", "p6",
			"-tune", "ll",
			"-rc", "cbr",
			"-rc-lookahead", "0",
			"-spatial-aq", "1",
			"-temporal-aq", "1",
			"-aq-strength", "8",
			"-multipass", "fullres",
			"-zerolatency", "1",
		)
	case "h264_amf":
		// Every joining receiver and recording needs SPS/PPS at an IDR.
		args = append(args,
			"-header_spacing", strconv.FormatUint(uint64(keyframeInterval), 10),
			"-forced_idr", "1",
			"-force_key_frames", forcedIDR,
			"-aud", "0",
		)
		args = append(args,
			"-usage", "ultralowlatency",
			"-quality", "balanced",
			"-rc", "cbr",
			"-async_depth", "1",
		)
	case "h264_qsv":
		args = append(args, "-preset", "fast", "-look_ahead", "0")
	default:
		args = append(args, "-preset", "veryfast", "-tune", "zerolatency")
	}
	return args
}

// knownEncoders are the encoders probed, best first. The order is the
// preference order when more than one is available.
var knownEncoders = []struct{ id, label string }{
	{"h264_nvenc", "NVIDIA NVENC · H.264"},
	{"h264_amf", "AMD AMF · H.264"},
	{"h264_qsv", "Intel Quick Sync · H.264"},
	{"libx264", "CPU x264 · H.264"},
}

// browserExecutables are shared with the page so a browser window reads as a
// browser rather than an anonymous app.
var browserExecutables = map[string]bool{
	"chrome.exe": true, "msedge.exe": true, "firefox.exe": true,
	"brave.exe": true, "opera.exe": true,
}

var utilityExecutables = map[string]bool{
	"explorer.exe": true, "taskmgr.exe": true, "cmd.exe": true,
	"powershell.exe": true, "windowsterminal.exe": true,
	"textinputhost.exe": true, "shellexperiencehost.exe": true,
}

var gameExecutables = map[string]bool{
	"minecraft.exe": true, "blender.exe": true, "obs64.exe": true,
	"unity.exe": true, "unrealeditor.exe": true,
	"valorant-win64-shipping.exe": true, "fortniteclient-win64-shipping.exe": true,
	"cs2.exe": true, "overwatch.exe": true, "league of legends.exe": true,
	"eldenring.exe": true,
}

var gameWindowClasses = map[string]bool{
	"glfw30": true, "lwjgl": true, "unitywndclass": true,
	"unrealwindow": true, "sdl_app": true,
}

var gameTitleTerms = []string{
	"minecraft", "roblox", "valorant", "fortnite", "counter-strike", "overwatch",
}

// sourceCategory groups a window so the picker can order and label it. The
// grouping is a presentation hint, never a capability decision.
func sourceCategory(title, executable, windowClass string) string {
	title = strings.ToLower(title)
	executable = strings.ToLower(executable)
	if cut := strings.LastIndexAny(executable, `\/`); cut >= 0 {
		executable = executable[cut+1:]
	}
	windowClass = strings.ToLower(windowClass)

	switch {
	case browserExecutables[executable]:
		return "browser"
	case strings.HasPrefix(executable, "powertoys."),
		utilityExecutables[executable],
		windowClass == "progman", windowClass == "workerw",
		title == "windows input experience":
		return "utility"
	case strings.Contains(executable, "launcher"), strings.Contains(title, "launcher"):
		return "app"
	case gameExecutables[executable],
		strings.HasSuffix(executable, "-win64-shipping.exe"),
		gameWindowClasses[windowClass],
		containsAny(title, gameTitleTerms):
		return "game"
	default:
		return "app"
	}
}

func containsAny(value string, terms []string) bool {
	for _, term := range terms {
		if strings.Contains(value, term) {
			return true
		}
	}
	return false
}

// sourceSortRank orders the picker: displays first, then what someone is most
// likely to be sharing.
func sourceSortRank(source Source) uint8 {
	switch source.Category {
	case "display":
		return 0
	case "game":
		return 1
	case "browser":
		return 2
	case "app":
		return 3
	default:
		return 4
	}
}

// reconcileSourceIDs keeps a source's opaque ID stable across refreshes.
//
// The page holds an ID between enumerations. Minting a new one for a window
// that is plainly the same would silently invalidate a selection the person
// already made.
func reconcileSourceIDs(previous map[string]Source, current []Source) {
	for index := range current {
		for _, existing := range previous {
			if existing.Kind == current[index].Kind &&
				existing.Handle == current[index].Handle &&
				existing.Name == current[index].Name {
				current[index].ID = existing.ID
				break
			}
		}
	}
}

// accessUnits splits an Annex B byte stream into whole access units.
//
// Frames are delimited by access unit delimiters (NAL type 9), which the
// encoders above are configured to emit. Splitting on those rather than on
// slice boundaries is what keeps SPS, PPS, and SEI attached to the picture
// they describe, so a receiver joining at a keyframe gets everything it needs
// in one packet sequence.
type accessUnits struct {
	buffer []byte
}

// push appends encoder output and returns whichever complete access units it
// completed. The trailing partial unit stays buffered.
func (a *accessUnits) push(bytes []byte) ([][]byte, error) {
	a.buffer = append(a.buffer, bytes...)
	if len(a.buffer) > maxAccessUnitBytes {
		return nil, errors.New("Encoder frame exceeded limit")
	}

	var boundaries []int
	for i := 0; i+4 < len(a.buffer); {
		prefix := 0
		switch {
		case hasPrefix(a.buffer[i:], []byte{0, 0, 0, 1}):
			prefix = 4
		case hasPrefix(a.buffer[i:], []byte{0, 0, 1}):
			prefix = 3
		default:
			i++
			continue
		}
		if i+prefix < len(a.buffer) && a.buffer[i+prefix]&31 == 9 {
			boundaries = append(boundaries, i)
		}
		i += prefix + 1
	}

	var frames [][]byte
	if len(boundaries) > 1 {
		end := boundaries[len(boundaries)-1]
		for pair := 0; pair+1 < len(boundaries); pair++ {
			frame := a.buffer[boundaries[pair]:boundaries[pair+1]]
			// A delimiter-only unit carries no picture. Forwarding it would
			// advance RTP time for a frame the receiver never gets.
			if carriesPicture(frame) {
				frames = append(frames, append([]byte(nil), frame...))
			}
		}
		a.buffer = append([]byte(nil), a.buffer[end:]...)
	}
	return frames, nil
}

// carriesPicture reports whether an access unit holds a coded slice, which is
// NAL types 1 through 5.
func carriesPicture(frame []byte) bool {
	for i := 0; i+3 < len(frame); i++ {
		if frame[i] == 0 && frame[i+1] == 0 && frame[i+2] == 1 {
			if kind := frame[i+3] & 31; kind >= 1 && kind <= 5 {
				return true
			}
		}
	}
	return false
}

func hasPrefix(value, prefix []byte) bool {
	return len(value) >= len(prefix) && string(value[:len(prefix)]) == string(prefix)
}

// newSourceID mints the opaque identifier the page uses to name a source.
//
// The page never receives an HWND or a PID. It holds one of these instead, and
// the host resolves it against its own last enumeration, so a page cannot aim
// capture at a window it was never offered.
func newSourceID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("Could not allocate capture ID")
	}
	return hex.EncodeToString(raw), nil
}

// Geometry is where a running capture's source currently sits on the virtual
// desktop, and how large the encoder is making it.
//
// Visual-copilot overlays are placed with it: a viewer points at a fraction of
// the picture they can see, and that fraction has to become a pixel on the
// sharer's desktop. Both numbers are needed because the encoded frame is
// scaled from the source, so a normalised point maps through the source
// rectangle, not the encoded one.
type Geometry struct {
	Left   int32  `json:"left"`
	Top    int32  `json:"top"`
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
	// EncodedWidth and EncodedHeight are what viewers actually receive.
	EncodedWidth  uint32 `json:"encodedWidth"`
	EncodedHeight uint32 `json:"encodedHeight"`
}

// CopilotGeometry measures the source of a running capture.
//
// requireForeground refuses the measurement when the shared window is behind
// another one, which is how a pointed-at overlay hides itself instead of
// floating over whatever the person switched to.
//
// A source that has changed size since the capture started is refused rather
// than measured: the encoder is still scaling from the old dimensions, so every
// point would land somewhere slightly wrong, and a silently misplaced signal is
// worse than a visible refusal.
func (m *Manager) CopilotGeometry(sessionID string, requireForeground bool) (Geometry, error) {
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active == nil || active.info.SessionID != sessionID || active.stopped.Load() {
		return Geometry{}, errors.New("The native share ended or changed")
	}

	left, top, width, height, err := sourceBounds(active.source, requireForeground)
	if err != nil {
		return Geometry{}, err
	}
	if width != active.source.Width || height != active.source.Height {
		return Geometry{}, errors.New("The shared source changed size. Restart sharing to place signals accurately.")
	}
	return Geometry{
		Left:          left,
		Top:           top,
		Width:         width,
		Height:        height,
		EncodedWidth:  active.info.Width,
		EncodedHeight: active.info.Height,
	}, nil
}
