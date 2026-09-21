package nativescreen

import (
	"context"
	"errors"
	"os/exec"
	"time"

	"bettercomms/desktop-wails/internal/native/nativeprocess"
)

const maxThumbnailBytes = 512 * 1024

var thumbnailSlots = make(chan struct{}, 2)

type thumbnailOutput struct{ bytes []byte }

func (b *thumbnailOutput) Write(p []byte) (int, error) {
	if len(b.bytes)+len(p) > maxThumbnailBytes {
		return 0, errors.New("source preview exceeds its size limit")
	}
	b.bytes = append(b.bytes, p...)
	return len(p), nil
}

func completeJPEG(body []byte) bool {
	return len(body) >= 4 && len(body) <= maxThumbnailBytes && body[0] == 0xff && body[1] == 0xd8 && body[len(body)-2] == 0xff && body[len(body)-1] == 0xd9
}

// Thumbnail captures one bounded JPEG from an opaque source id. It never
// restores a minimized window or writes the captured image to disk.
func (m *Manager) Thumbnail(ctx context.Context, sourceID string) ([]byte, error) {
	m.mu.Lock()
	source, exists := m.sources[sourceID]
	m.mu.Unlock()
	if !exists {
		return nil, errors.New("refresh sources before requesting a preview")
	}
	if source.Minimized {
		return nil, errors.New("minimized windows cannot provide a preview")
	}
	if _, _, _, _, err := sourceBounds(source, false); err != nil {
		return nil, err
	}
	select {
	case thumbnailSlots <- struct{}{}:
	default:
		return nil, errors.New("two source previews are already running")
	}
	defer func() { <-thumbnailSlots }()
	path, err := ffmpegPath()
	if err != nil {
		return nil, err
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	kind := "hwnd"
	if source.Kind == "monitor" {
		kind = "hmonitor"
	}
	cmd := exec.CommandContext(bounded, path, "-hide_banner", "-loglevel", "error", "-filter_complex", thumbnailFilter(kind, source.Handle), "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1")
	hideWindow(cmd)
	var output thumbnailOutput
	cmd.Stdout = &output
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if err := nativeprocess.Attach(cmd); err != nil {
		cancel()
		_ = cmd.Wait()
		return nil, err
	}
	if err := cmd.Wait(); err != nil {
		return nil, errors.New("source preview failed or timed out")
	}
	if !completeJPEG(output.bytes) {
		return nil, errors.New("source preview returned an incomplete JPEG")
	}
	return output.bytes, nil
}
