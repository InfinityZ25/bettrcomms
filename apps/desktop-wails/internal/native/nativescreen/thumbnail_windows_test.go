//go:build windows

package nativescreen

import (
	"bytes"
	"context"
	"image/jpeg"
	"testing"
)

func TestDisplayThumbnailIsBoundedJPEG(t *testing.T) {
	requireRuntime(t)
	m := NewManager()
	defer m.Close()
	sources, err := m.Sources()
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		if source.Kind != "monitor" {
			continue
		}
		body, err := m.Thumbnail(context.Background(), source.ID)
		if err != nil {
			t.Fatal(err)
		}
		info, err := jpeg.DecodeConfig(bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if info.Width > 640 || info.Height > 360 || len(body) > maxThumbnailBytes {
			t.Fatal("preview exceeded limits")
		}
		t.Logf("decoded source preview: %dx%d, %d bytes; image not persisted", info.Width, info.Height, len(body))
		return
	}
	t.Skip("no display available")
}
