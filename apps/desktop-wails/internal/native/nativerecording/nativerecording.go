// Package nativerecording records a native screen capture to MP4 without
// re-encoding it.
//
// The capture's H.264 access units are already exactly what an MP4 track holds,
// so recording is a remux: the same bytes going to viewers are written to a
// file. Nothing is decoded and nothing is encoded a second time, which is what
// makes recording a 4K120 share cost almost nothing beyond the disk write.
package nativerecording

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"bettercomms/desktop-wails/internal/native/nativeprocess"
)

const (
	// MaxAssetBytes bounds one recording. FFmpeg is told the same limit, so it
	// finalises a valid file at the boundary rather than being killed mid-write.
	MaxAssetBytes = 512 * 1024 * 1024
	// MaxReadBytes bounds one read the page makes. The file is handed over in
	// chunks so a 512 MiB recording never has to exist in the webview at once.
	MaxReadBytes = 256 * 1024

	// The queue holds about a tenth of a second of frames, bounded so a stalled
	// muxer cannot grow it without limit.
	minAccessUnitQueue = 8
	maxAccessUnitQueue = 32

	// MaxFinishedAssets bounds how many completed recordings are held for the
	// page to read. Each is a file on disk.
	MaxFinishedAssets = 8

	maxDiagnosticBytes = 16 * 1024
	muxerFinishTimeout = 5 * time.Second
)

// Started is the handle for a recording in progress.
type Started struct {
	RecordingID string `json:"recordingId"`
}

// Asset is a finished recording the page can read.
type Asset struct {
	AssetID string `json:"assetId"`
	// SizeBytes is the whole file; the page reads it in MaxReadBytes chunks.
	SizeBytes int64 `json:"sizeBytes"`
	// StartedDelayMs is how long after the request the first decodable frame
	// arrived, so the page can align this track with the others it recorded.
	StartedDelayMs uint64 `json:"startedDelayMs"`
	DurationMs     uint64 `json:"durationMs"`
}

// capture is a live screen capture that can be recorded.
type capture struct {
	fps    uint32
	ffmpeg string
}

// accessUnit is one encoded frame with the instant it was captured.
type accessUnit struct {
	bytes      []byte
	capturedAt time.Time
}

// recorder is one recording in progress.
type recorder struct {
	sessionID string
	frames    chan accessUnit
	stop      chan struct{}
	stopOnce  sync.Once
	done      chan struct{}

	mu     sync.Mutex
	result *result
	err    error
}

type result struct {
	path           string
	startedDelayMs uint64
	durationMs     uint64
}

type finished struct {
	path      string
	sizeBytes int64
}

// Store owns the captures, the recordings in progress, and the finished files.
type Store struct {
	mu         sync.Mutex
	captures   map[string]capture
	recorders  map[string]*recorder
	assets     map[string]finished
	assetOrder []string

	// stagingRoot is where recordings are written. It is a directory this
	// process owns, never a path the page supplies.
	stagingRoot string
}

// NewStore returns a store writing to dir.
func NewStore(dir string) *Store {
	return &Store{
		captures:    map[string]capture{},
		recorders:   map[string]*recorder{},
		assets:      map[string]finished{},
		stagingRoot: dir,
	}
}

// DefaultStagingRoot is the per-user directory recordings are staged in.
func DefaultStagingRoot() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		dir, err := os.UserCacheDir()
		if err != nil {
			return "", errors.New("Local application directory is unavailable")
		}
		base = dir
	}
	root := filepath.Join(base, "Bettercomms", "native-recordings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("Could not create the recording staging directory: %w", err)
	}
	return root, nil
}

func newID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("Could not allocate a recording ID")
	}
	return hex.EncodeToString(raw), nil
}

// RegisterSession makes a live capture recordable.
func (s *Store) RegisterSession(sessionID string, fps uint32, ffmpeg string) error {
	if sessionID == "" || fps == 0 || ffmpeg == "" {
		return errors.New("Native recording needs a live capture")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.captures[sessionID] = capture{fps: fps, ffmpeg: ffmpeg}
	return nil
}

// FeedAccessUnit offers one encoded frame to whatever is recording this capture.
//
// It never blocks. A muxer that cannot keep up loses the recording rather than
// stalling capture, because capture is also feeding live viewers.
func (s *Store) FeedAccessUnit(sessionID string, unit []byte) {
	s.mu.Lock()
	var target *recorder
	for _, active := range s.recorders {
		if active.sessionID == sessionID {
			target = active
			break
		}
	}
	s.mu.Unlock()
	if target == nil {
		return
	}

	frame := accessUnit{bytes: append([]byte(nil), unit...), capturedAt: time.Now()}
	select {
	case target.frames <- frame:
	default:
		target.fail(errors.New("Native recording could not keep up with the capture"))
		target.halt()
	}
}

// CaptureEnded closes any recording of a capture that has stopped.
func (s *Store) CaptureEnded(sessionID string) {
	s.mu.Lock()
	delete(s.captures, sessionID)
	var targets []*recorder
	for _, active := range s.recorders {
		if active.sessionID == sessionID {
			targets = append(targets, active)
		}
	}
	s.mu.Unlock()

	for _, target := range targets {
		target.halt()
	}
}

func (r *recorder) halt() { r.stopOnce.Do(func() { close(r.stop) }) }

func (r *recorder) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err == nil {
		r.err = err
	}
}

// Start begins recording a live capture.
func (s *Store) Start(sessionID string) (Started, error) {
	s.mu.Lock()
	live, ok := s.captures[sessionID]
	if !ok {
		s.mu.Unlock()
		return Started{}, errors.New("Native screen capture is no longer active")
	}
	for _, active := range s.recorders {
		if active.sessionID == sessionID {
			s.mu.Unlock()
			return Started{}, errors.New("This native screen capture is already being recorded")
		}
	}
	recordingID, err := newID()
	if err != nil {
		s.mu.Unlock()
		return Started{}, err
	}

	queue := int(live.fps / 10)
	if queue < minAccessUnitQueue {
		queue = minAccessUnitQueue
	}
	if queue > maxAccessUnitQueue {
		queue = maxAccessUnitQueue
	}
	active := &recorder{
		sessionID: sessionID,
		frames:    make(chan accessUnit, queue),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	s.recorders[recordingID] = active
	s.mu.Unlock()

	go active.run(live, s.stagingRoot, time.Now())
	return Started{RecordingID: recordingID}, nil
}

// muxerArgs remuxes the piped H.264 elementary stream into MP4.
//
// "-c:v copy" is the whole point: the access units are written through
// unchanged. "+faststart" moves the index to the front so the page can play
// the file without downloading all of it, and "-fs" makes FFmpeg finalise a
// valid file at the size limit rather than being killed mid-write.
func muxerArgs(fps uint32, output string) []string {
	return []string{
		"-hide_banner", "-loglevel", "error",
		"-fflags", "+genpts",
		"-framerate", strconv.FormatUint(uint64(fps), 10),
		"-f", "h264", "-i", "pipe:0",
		"-an",
		"-c:v", "copy",
		"-movflags", "+faststart",
		"-fs", strconv.FormatInt(MaxAssetBytes, 10),
		"-y", output,
	}
}

// isIDR reports whether an access unit carries a keyframe slice.
func isIDR(unit []byte) bool {
	for index := 0; index+4 <= len(unit); {
		prefix := 0
		switch {
		case index+4 <= len(unit) && unit[index] == 0 && unit[index+1] == 0 && unit[index+2] == 0 && unit[index+3] == 1:
			prefix = 4
		case index+3 <= len(unit) && unit[index] == 0 && unit[index+1] == 0 && unit[index+2] == 1:
			prefix = 3
		default:
			index++
			continue
		}
		if index+prefix < len(unit) && unit[index+prefix]&0x1f == 5 {
			return true
		}
		index += prefix + 1
	}
	return false
}

func (r *recorder) run(live capture, stagingRoot string, requestedAt time.Time) {
	defer close(r.done)

	file, err := os.CreateTemp(stagingRoot, "native-screen-*.mp4")
	if err != nil {
		r.fail(fmt.Errorf("Could not create native recording: %w", err))
		return
	}
	output := file.Name()
	// FFmpeg writes the file itself; this handle only reserved the name.
	_ = file.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := exec.CommandContext(ctx, live.ffmpeg, muxerArgs(live.fps, output)...)
	hideWindow(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		r.fail(fmt.Errorf("Recording muxer input is unavailable: %w", err))
		_ = os.Remove(output)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		r.fail(fmt.Errorf("Recording muxer diagnostics are unavailable: %w", err))
		_ = os.Remove(output)
		return
	}
	if err := cmd.Start(); err != nil {
		r.fail(fmt.Errorf("Could not start recording muxer: %w", err))
		_ = os.Remove(output)
		return
	}
	if err := nativeprocess.Attach(cmd); err != nil {
		cancel()
		_ = cmd.Wait()
		r.fail(err)
		_ = os.Remove(output)
		return
	}

	diagnostics := make(chan string, 1)
	go func() {
		body, _ := io.ReadAll(io.LimitReader(stderr, maxDiagnosticBytes))
		diagnostics <- string(body)
	}()

	var startedAt, lastFrameAt time.Time
	consume := func(frame accessUnit) error {
		// Recording must begin at a keyframe. Starting on a delta frame gives a
		// file whose first seconds cannot be decoded.
		if startedAt.IsZero() {
			if !isIDR(frame.bytes) {
				return nil
			}
			startedAt = frame.capturedAt
		}
		if _, err := input.Write(frame.bytes); err != nil {
			return fmt.Errorf("Could not write recording access unit: %w", err)
		}
		lastFrameAt = frame.capturedAt
		return nil
	}

	writing := true
	for writing {
		select {
		case <-r.stop:
			// Drain whatever is already queued so the tail of the recording is
			// not lost to the stop.
			for {
				select {
				case frame := <-r.frames:
					if err := consume(frame); err != nil {
						r.fail(err)
						writing = false
					}
					continue
				default:
				}
				break
			}
			writing = false
		case frame := <-r.frames:
			if err := consume(frame); err != nil {
				r.fail(err)
				writing = false
			}
		}
	}
	_ = input.Close()

	finish := make(chan error, 1)
	go func() { finish <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-finish:
	case <-time.After(muxerFinishTimeout):
		cancel()
		<-finish
		r.fail(errors.New("Recording muxer did not finish in time"))
		_ = os.Remove(output)
		return
	}

	var detail string
	select {
	case detail = <-diagnostics:
	case <-time.After(250 * time.Millisecond):
	}

	r.mu.Lock()
	existing := r.err
	r.mu.Unlock()
	if existing != nil {
		_ = os.Remove(output)
		return
	}

	if startedAt.IsZero() {
		r.fail(errors.New("Native recording ended before a decodable IDR frame arrived"))
		_ = os.Remove(output)
		return
	}
	if waitErr != nil {
		// The staging path is replaced before anything reaches the page: it
		// names a directory the page has no business knowing.
		detail = strings.ReplaceAll(detail, output, "<recording-staging>")
		detail = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(detail))
		if len(detail) > 512 {
			detail = detail[:512]
		}
		if detail == "" {
			r.fail(errors.New("Recording muxer could not finalize the MP4"))
		} else {
			r.fail(fmt.Errorf("Recording muxer could not finalize the MP4: %s", detail))
		}
		_ = os.Remove(output)
		return
	}

	info, err := os.Stat(output)
	if err != nil {
		r.fail(fmt.Errorf("Could not inspect native recording: %w", err))
		_ = os.Remove(output)
		return
	}
	if info.Size() == 0 || info.Size() > MaxAssetBytes {
		r.fail(errors.New("Native recording exceeded its 512 MiB limit or was empty"))
		_ = os.Remove(output)
		return
	}

	// The last frame occupies a frame interval too, or a one-frame recording
	// would report zero duration.
	frameMs := (1000 + uint64(live.fps) - 1) / uint64(live.fps)
	if lastFrameAt.IsZero() {
		lastFrameAt = startedAt
	}
	r.mu.Lock()
	r.result = &result{
		path:           output,
		startedDelayMs: uint64(startedAt.Sub(requestedAt).Milliseconds()),
		durationMs:     uint64(lastFrameAt.Sub(startedAt).Milliseconds()) + frameMs,
	}
	r.mu.Unlock()
}

// Stop finishes a recording and returns the asset the page can read.
func (s *Store) Stop(recordingID string) (Asset, error) {
	s.mu.Lock()
	active, ok := s.recorders[recordingID]
	delete(s.recorders, recordingID)
	s.mu.Unlock()
	if !ok {
		return Asset{}, errors.New("Native recording is missing or already stopped")
	}

	active.halt()
	<-active.done

	active.mu.Lock()
	produced, failure := active.result, active.err
	active.mu.Unlock()
	if failure != nil {
		return Asset{}, failure
	}
	if produced == nil {
		return Asset{}, errors.New("Native recording produced no file")
	}

	info, err := os.Stat(produced.path)
	if err != nil {
		return Asset{}, fmt.Errorf("Could not inspect native recording: %w", err)
	}
	assetID, err := newID()
	if err != nil {
		_ = os.Remove(produced.path)
		return Asset{}, err
	}

	s.mu.Lock()
	s.assets[assetID] = finished{path: produced.path, sizeBytes: info.Size()}
	s.assetOrder = append(s.assetOrder, assetID)
	// Each held asset is a file on disk. Drop the oldest rather than letting
	// an abandoned page accumulate them.
	for len(s.assetOrder) > MaxFinishedAssets {
		oldest := s.assetOrder[0]
		s.assetOrder = s.assetOrder[1:]
		if stale, ok := s.assets[oldest]; ok {
			_ = os.Remove(stale.path)
			delete(s.assets, oldest)
		}
	}
	s.mu.Unlock()

	return Asset{
		AssetID:        assetID,
		SizeBytes:      info.Size(),
		StartedDelayMs: produced.startedDelayMs,
		DurationMs:     produced.durationMs,
	}, nil
}

// Read returns one chunk of a finished recording.
//
// The page reads the file in pieces rather than receiving a path: it never
// learns where the recording lives, and a 512 MiB file never has to exist in
// the webview at once.
func (s *Store) Read(assetID string, offset int64, length int) ([]byte, error) {
	if offset < 0 {
		return nil, errors.New("Native recording read offset is invalid")
	}
	if length <= 0 || length > MaxReadBytes {
		length = MaxReadBytes
	}

	s.mu.Lock()
	asset, ok := s.assets[assetID]
	s.mu.Unlock()
	if !ok {
		return nil, errors.New("Native recording is missing or already released")
	}
	if offset >= asset.sizeBytes {
		return nil, nil
	}

	file, err := os.Open(asset.path)
	if err != nil {
		return nil, fmt.Errorf("Could not read native recording: %w", err)
	}
	defer func() { _ = file.Close() }()

	if remaining := asset.sizeBytes - offset; int64(length) > remaining {
		length = int(remaining)
	}
	chunk := make([]byte, length)
	count, err := file.ReadAt(chunk, offset)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("Could not read native recording: %w", err)
	}
	return chunk[:count], nil
}

// Release deletes a finished recording. Releasing one that is already gone
// succeeds: the caller's goal is that it not be there.
func (s *Store) Release(assetID string) error {
	s.mu.Lock()
	asset, ok := s.assets[assetID]
	delete(s.assets, assetID)
	for index, held := range s.assetOrder {
		if held == assetID {
			s.assetOrder = append(s.assetOrder[:index], s.assetOrder[index+1:]...)
			break
		}
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	if err := os.Remove(asset.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("Could not release native recording: %w", err)
	}
	return nil
}

// Close stops every recording and removes every staged file. The application
// calls this on shutdown so recordings never outlive the process.
func (s *Store) Close() {
	s.mu.Lock()
	recorders := make([]*recorder, 0, len(s.recorders))
	for _, active := range s.recorders {
		recorders = append(recorders, active)
	}
	s.recorders = map[string]*recorder{}
	assets := s.assets
	s.assets = map[string]finished{}
	s.assetOrder = nil
	s.mu.Unlock()

	for _, active := range recorders {
		active.halt()
		<-active.done
		active.mu.Lock()
		produced := active.result
		active.mu.Unlock()
		if produced != nil {
			_ = os.Remove(produced.path)
		}
	}
	for _, asset := range assets {
		_ = os.Remove(asset.path)
	}
}
