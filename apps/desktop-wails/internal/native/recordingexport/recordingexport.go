// Package recordingexport writes a recording the page holds to a file the
// person chose, optionally converting it on the way.
//
// The page streams the recording in bounded chunks rather than handing over a
// whole blob, and it never learns or supplies a filesystem path: the host
// obtains one from a native save dialog and refers to it afterwards only by an
// opaque grant id. A page cannot write anywhere it was not explicitly given.
package recordingexport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	// MaxChunkBytes bounds one append the page makes.
	MaxChunkBytes = 1024 * 1024
	// MaxExportBytes bounds a recording the page may export.
	MaxExportBytes = 512 * 1024 * 1024
	// MaxConvertedBytes bounds what a conversion may produce. A conversion can
	// legitimately grow, so it is looser than the input bound.
	MaxConvertedBytes = 2 * 1024 * 1024 * 1024

	// MaxRunningConversions bounds concurrent encodes, each of which is a
	// CPU-hungry subprocess.
	MaxRunningConversions = 2
	// MaxActiveExports bounds how many grants can be outstanding at once.
	MaxActiveExports = 8
	// ExportTTL reclaims a grant the page opened and abandoned.
	ExportTTL = 10 * time.Minute

	defaultName = "recording.webm"
)

// Format is a conversion target.
type Format string

const (
	FormatMP4 Format = "mp4"
	FormatWAV Format = "wav"
	FormatMP3 Format = "mp3"
)

// ParseFormat validates a format name from the page.
func ParseFormat(value string) (Format, error) {
	switch Format(value) {
	case FormatMP4, FormatWAV, FormatMP3:
		return Format(value), nil
	}
	return "", errors.New("conversion format must be mp4, wav, or mp3")
}

// Extension is the file extension a format produces.
func (f Format) Extension() string { return string(f) }

// Capability is one conversion target and whether this machine can produce it.
type Capability struct {
	ID        string `json:"id"`
	Extension string `json:"extension"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
}

// Capabilities is the set of conversion targets.
type Capabilities struct {
	Formats []Capability `json:"formats"`
}

// Grant is the opaque handle the page uses to stream into a chosen file.
type Grant struct {
	ExportID string `json:"exportId"`
}

// Result is where a completed export landed.
type Result struct {
	FileName string `json:"fileName"`
	// Path is shown to the person so they can find the file. It is only ever
	// a location they chose themselves in the save dialog.
	Path string `json:"path"`
}

// pending is one export in progress.
type pending struct {
	destination string
	staging     *os.File
	stagingPath string
	sizeBytes   int64
	written     int64
	format      Format
	owner       string
	createdAt   time.Time
}

// Store owns the outstanding grants and the running conversions.
type Store struct {
	mu          sync.Mutex
	exports     map[string]*pending
	conversions int

	// ffmpeg resolves the runtime, injected so conversion is testable.
	ffmpeg func() string
	now    func() time.Time
}

// NewStore returns a store that resolves its conversion runtime with ffmpeg.
func NewStore(ffmpeg func() string) *Store {
	return &Store{
		exports: map[string]*pending{},
		ffmpeg:  ffmpeg,
		now:     time.Now,
	}
}

// Describe reports which conversion targets this machine can produce.
func (s *Store) Describe() Capabilities {
	runtime := s.ffmpeg != nil && s.ffmpeg() != ""
	return Capabilities{Formats: []Capability{
		{ID: "mp4", Extension: "mp4", Label: "MP4 · H.264 high quality", Available: runtime},
		{ID: "wav", Extension: "wav", Label: "WAV · PCM 48 kHz", Available: runtime},
		{ID: "mp3", Extension: "mp3", Label: "MP3 · 256 kbps", Available: runtime},
	}}
}

// SafeSuggestedName reduces a page-supplied name to a bare, harmless leaf.
//
// The result only ever seeds a save dialog, but it must not be able to steer
// one: a path separator, a drive letter, or a trailing dot would each change
// where the dialog opens or what it writes.
func SafeSuggestedName(input string) string {
	leaf := input
	if index := strings.LastIndexAny(leaf, `/\`); index >= 0 {
		leaf = leaf[index+1:]
	}
	if leaf == "" {
		return defaultName
	}

	var builder strings.Builder
	for _, character := range leaf {
		if builder.Len() >= 240 {
			break
		}
		switch {
		case unicode.IsControl(character),
			strings.ContainsRune(`<>:"/\|?*`, character):
			builder.WriteRune('_')
		default:
			builder.WriteRune(character)
		}
	}
	// A trailing dot or space is silently dropped by Windows, which would make
	// the written name differ from the one shown.
	sanitised := strings.TrimRight(strings.TrimSpace(builder.String()), ". ")
	if sanitised == "" || sanitised == "." || sanitised == ".." {
		return defaultName
	}
	return sanitised
}

// SuggestedNameFor is the save-dialog name for a conversion of input.
func SuggestedNameFor(input string, format Format) string {
	safe := SafeSuggestedName(input)
	stem := strings.TrimSuffix(safe, filepath.Ext(safe))
	if stem == "" {
		stem = "recording"
	}
	return stem + "." + format.Extension()
}

func newID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("could not create an export identifier")
	}
	return hex.EncodeToString(raw), nil
}

// Begin reserves a grant for a destination the person already chose.
//
// destination comes from a native save dialog the host opened, never from the
// page. format may be empty for a straight copy.
func (s *Store) Begin(destination, owner string, sizeBytes int64, format Format) (Grant, error) {
	if destination == "" {
		return Grant{}, errors.New("no export destination was chosen")
	}
	if sizeBytes <= 0 || sizeBytes > MaxExportBytes {
		return Grant{}, fmt.Errorf("recording assets must contain 1 byte to %d MiB", MaxExportBytes/(1024*1024))
	}
	if format != "" && (s.ffmpeg == nil || s.ffmpeg() == "") {
		return Grant{}, errors.New("Install the native sharing runtime before converting recordings")
	}

	parent := filepath.Dir(destination)
	// Staged beside the destination so the final rename stays on one volume and
	// is therefore atomic: a partial file never appears under the chosen name.
	staging, err := os.CreateTemp(parent, ".bettercomms-export-*")
	if err != nil {
		return Grant{}, fmt.Errorf("could not create the export staging file: %w", err)
	}

	discardStaging := func() {
		_ = staging.Close()
		_ = os.Remove(staging.Name())
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if len(s.exports) >= MaxActiveExports {
		discardStaging()
		return Grant{}, errors.New("too many recording exports are already pending")
	}

	var exportID string
	for {
		candidate, err := newID()
		if err != nil {
			discardStaging()
			return Grant{}, err
		}
		if _, taken := s.exports[candidate]; !taken {
			exportID = candidate
			break
		}
	}
	s.exports[exportID] = &pending{
		destination: destination,
		staging:     staging,
		stagingPath: staging.Name(),
		sizeBytes:   sizeBytes,
		format:      format,
		owner:       owner,
		createdAt:   s.now(),
	}
	return Grant{ExportID: exportID}, nil
}

// expireLocked reclaims grants the page opened and abandoned.
func (s *Store) expireLocked() {
	now := s.now()
	for id, export := range s.exports {
		if now.Sub(export.createdAt) > ExportTTL {
			_ = export.staging.Close()
			_ = os.Remove(export.stagingPath)
			delete(s.exports, id)
		}
	}
}

// lookupLocked resolves a grant and checks it belongs to the caller. The
// caller must hold the mutex.
func (s *Store) lookupLocked(exportID, owner string) (*pending, error) {
	export, ok := s.exports[exportID]
	if !ok {
		return nil, errors.New("this recording export is no longer available")
	}
	if export.owner != owner {
		return nil, errors.New("this recording export belongs to another window")
	}
	return export, nil
}

// Append writes one chunk at an explicit offset.
//
// The offset must be exactly where the last chunk ended. Accepting an arbitrary
// one would let a page write sparse holes, or rewrite bytes it had already
// committed, inside a file it does not otherwise control.
func (s *Store) Append(exportID, owner string, offset int64, chunk []byte) error {
	if len(chunk) == 0 {
		return errors.New("recording export chunks must not be empty")
	}
	if len(chunk) > MaxChunkBytes {
		return fmt.Errorf("recording export chunks must be at most %d bytes", MaxChunkBytes)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	export, err := s.lookupLocked(exportID, owner)
	if err != nil {
		return err
	}
	if offset != export.written {
		return fmt.Errorf("recording export chunk arrived out of order at %d, expected %d", offset, export.written)
	}
	if export.written+int64(len(chunk)) > export.sizeBytes {
		return errors.New("recording export exceeded the size it declared")
	}
	if _, err := export.staging.Write(chunk); err != nil {
		return fmt.Errorf("could not write the recording export: %w", err)
	}
	export.written += int64(len(chunk))
	return nil
}

// Finish completes an export, converting it first when a format was chosen.
func (s *Store) Finish(ctx context.Context, exportID, owner string) (Result, error) {
	s.mu.Lock()
	export, err := s.lookupLocked(exportID, owner)
	if err != nil {
		s.mu.Unlock()
		return Result{}, err
	}
	if export.written != export.sizeBytes {
		s.mu.Unlock()
		return Result{}, fmt.Errorf("recording export is incomplete: %d of %d bytes", export.written, export.sizeBytes)
	}
	converting := export.format != ""
	if converting {
		if s.conversions >= MaxRunningConversions {
			s.mu.Unlock()
			return Result{}, errors.New("too many recordings are already being converted")
		}
		s.conversions++
	}
	delete(s.exports, exportID)
	s.mu.Unlock()

	if converting {
		defer func() {
			s.mu.Lock()
			s.conversions--
			s.mu.Unlock()
		}()
	}

	if err := export.staging.Sync(); err != nil {
		s.discard(export)
		return Result{}, fmt.Errorf("could not flush the recording input: %w", err)
	}
	if err := export.staging.Close(); err != nil {
		s.discard(export)
		return Result{}, fmt.Errorf("could not close the recording input: %w", err)
	}

	source := export.stagingPath
	if converting {
		converted, err := s.convert(ctx, export)
		if err != nil {
			_ = os.Remove(export.stagingPath)
			return Result{}, err
		}
		_ = os.Remove(export.stagingPath)
		source = converted
	}

	// The rename is the commit. Until it happens the chosen name holds either
	// nothing or the file it held before.
	if err := os.Rename(source, export.destination); err != nil {
		_ = os.Remove(source)
		return Result{}, fmt.Errorf("could not save the recording: %w", err)
	}
	return Result{
		FileName: filepath.Base(export.destination),
		Path:     export.destination,
	}, nil
}

// convertArgs are the FFmpeg arguments for one conversion target.
//
// The protocol and format whitelists matter: the input is a file the page
// produced, and without them a crafted container could make FFmpeg open a
// network URL or a format nobody asked for.
func convertArgs(input, output string, format Format) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-protocol_whitelist", "file,pipe",
		"-format_whitelist", "matroska,mov",
		"-i", input,
	}
	switch format {
	case FormatMP4:
		args = append(args,
			"-map", "0:v:0",
			// The audio stream is optional: a screen recording may have none.
			"-map", "0:a:0?",
			"-c:v", "libx264", "-preset", "medium", "-crf", "18",
			"-pix_fmt", "yuv420p", "-movflags", "+faststart",
			"-c:a", "aac", "-b:a", "256k",
			"-f", "mp4",
		)
	case FormatWAV:
		args = append(args,
			"-map", "0:a:0", "-vn",
			"-c:a", "pcm_s16le", "-ar", "48000",
			"-f", "wav",
		)
	case FormatMP3:
		args = append(args,
			"-map", "0:a:0", "-vn",
			"-c:a", "libmp3lame", "-b:a", "256k",
			"-f", "mp3",
		)
	}
	return append(args, output)
}

func (s *Store) convert(ctx context.Context, export *pending) (string, error) {
	runtime := ""
	if s.ffmpeg != nil {
		runtime = s.ffmpeg()
	}
	if runtime == "" {
		return "", errors.New("native conversion runtime is no longer installed")
	}

	parent := filepath.Dir(export.destination)
	output, err := os.CreateTemp(parent, ".bettercomms-conversion-*."+export.format.Extension())
	if err != nil {
		return "", fmt.Errorf("could not create conversion output: %w", err)
	}
	outputPath := output.Name()
	_ = output.Close()

	cmd := exec.CommandContext(ctx, runtime, convertArgs(export.stagingPath, outputPath, export.format)...)
	hideWindow(cmd)
	detail, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(outputPath)
		message := strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(string(detail)))
		// The staging path names a directory the page has no business knowing.
		message = strings.ReplaceAll(message, export.stagingPath, "<export-staging>")
		if len(message) > 512 {
			message = message[:512]
		}
		if message == "" {
			return "", errors.New("the recording could not be converted")
		}
		return "", fmt.Errorf("the recording could not be converted: %s", message)
	}

	info, err := os.Stat(outputPath)
	if err != nil {
		_ = os.Remove(outputPath)
		return "", fmt.Errorf("could not inspect the converted recording: %w", err)
	}
	if info.Size() == 0 || info.Size() > MaxConvertedBytes {
		_ = os.Remove(outputPath)
		return "", errors.New("the converted recording was empty or beyond its size limit")
	}
	return outputPath, nil
}

// Abort discards an export the page gave up on.
func (s *Store) Abort(exportID, owner string) error {
	s.mu.Lock()
	export, ok := s.exports[exportID]
	if ok && export.owner != owner {
		s.mu.Unlock()
		return errors.New("this recording export belongs to another window")
	}
	delete(s.exports, exportID)
	s.mu.Unlock()
	if !ok {
		return nil
	}
	s.discard(export)
	return nil
}

func (s *Store) discard(export *pending) {
	_ = export.staging.Close()
	_ = os.Remove(export.stagingPath)
}

// Close abandons every outstanding export. Nothing partial is left under a
// name the person chose, because a staged file is never renamed until it is
// complete.
func (s *Store) Close() {
	s.mu.Lock()
	exports := s.exports
	s.exports = map[string]*pending{}
	s.mu.Unlock()
	for _, export := range exports {
		s.discard(export)
	}
}
