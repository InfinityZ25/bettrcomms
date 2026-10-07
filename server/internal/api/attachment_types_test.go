package api

import (
	"bytes"
	"encoding/binary"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"testing"
)

func attachmentFTYP(major string, compatible ...string) []byte {
	data := make([]byte, 16+4*len(compatible))
	binary.BigEndian.PutUint32(data, uint32(len(data)))
	copy(data[4:8], "ftyp")
	copy(data[8:12], major)
	for index, brand := range compatible {
		copy(data[16+4*index:], brand)
	}
	return data
}

func TestAttachmentISOContainerSignatures(t *testing.T) {
	padding := []byte{0, 0, 0, 8, 'f', 'r', 'e', 'e'}
	invalidSize := attachmentFTYP("isom", "mp42")
	binary.BigEndian.PutUint32(invalidSize, uint32(len(invalidSize)+1))
	minorVersion := attachmentFTYP("xxxx")
	copy(minorVersion[12:16], "mp42")
	for _, test := range []struct {
		name string
		data []byte
		want string
	}{
		{"iphone major", attachmentFTYP("isom", "iso2", "avc1", "mp41"), "video/mp4"},
		{"compatible brand", attachmentFTYP("xxxx", "mp42"), "video/mp4"},
		{"fragmented video", attachmentFTYP("iso6", "dash"), "video/mp4"},
		{"audio", attachmentFTYP("M4A ", "isom", "mp42"), "audio/mp4"},
		{"quicktime", attachmentFTYP("qt  "), "video/quicktime"},
		{"avif", attachmentFTYP("avif", "mif1"), "image/avif"},
		{"leading padding", append(padding, attachmentFTYP("iso6")...), "video/mp4"},
		{"unknown brand", attachmentFTYP("xxxx"), "application/octet-stream"},
		{"truncated box", invalidSize, "application/octet-stream"},
		{"minor version is not a brand", minorVersion, "application/octet-stream"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := attachmentContentType(test.data); got != test.want {
				t.Fatalf("content type = %q, want %q", got, test.want)
			}
		})
	}
	if allowedAttachment("video.mp4", attachmentContentType([]byte("<html>not a video</html>"))) {
		t.Fatal("filename authorized HTML as video")
	}
	if allowedAttachment("image.svg", "image/png") || allowedAttachment("script.mjs", "text/plain") {
		t.Fatal("active filename accepted")
	}
}

func TestAttachmentMultipartSpoolCleanup(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("TMPDIR", directory)
	t.Setenv("TMP", directory)
	t.Setenv("TEMP", directory)
	parseRequest := func(file []byte, duplicate bool) {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "video.mp4")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(file); err != nil {
			t.Fatal(err)
		}
		if duplicate {
			if err = writer.WriteField("file", "duplicate"); err != nil {
				t.Fatal(err)
			}
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "/attachments", &body)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		_, err = readAttachmentUpload(request, 1024)
		if duplicate && !errors.Is(err, errInvalidAttachment) || !duplicate && !errors.Is(err, errAttachmentTooLarge) {
			t.Fatalf("unexpected parse error: %v", err)
		}
	}
	parseRequest(bytes.Repeat([]byte{0}, 1025), false)
	parseRequest(attachmentFTYP("isom"), true)
	files, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("failed multipart parsing retained %d temporary files", len(files))
	}
}
