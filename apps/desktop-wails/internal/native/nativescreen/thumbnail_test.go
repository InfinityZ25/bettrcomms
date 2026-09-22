package nativescreen

import (
	"context"
	"testing"
)

func TestThumbnailRejectsUnknownOrMinimizedSource(t *testing.T) {
	m := NewManager()
	if _, err := m.Thumbnail(context.Background(), "unissued"); err == nil {
		t.Fatal("unissued source accepted")
	}
	m.sources["minimized"] = Source{ID: "minimized", Kind: "window", Minimized: true}
	if _, err := m.Thumbnail(context.Background(), "minimized"); err == nil {
		t.Fatal("minimized preview accepted")
	}
}

func TestThumbnailBytesAreBoundedAndComplete(t *testing.T) {
	var output thumbnailOutput
	if _, err := output.Write(make([]byte, maxThumbnailBytes)); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte{1}); err == nil {
		t.Fatal("oversized thumbnail accepted")
	}
	if completeJPEG(output.bytes) || completeJPEG([]byte{255, 216}) {
		t.Fatal("invalid JPEG accepted")
	}
	if !completeJPEG([]byte{255, 216, 255, 217}) {
		t.Fatal("JPEG boundary check rejected markers")
	}
}
