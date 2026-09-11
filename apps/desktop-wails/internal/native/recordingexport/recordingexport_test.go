package recordingexport

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// newTestStore returns a store and a directory to export into.
//
// The directory is created first so its cleanup is registered first and
// therefore runs last: cleanups are LIFO, and Windows refuses to remove a
// directory whose staging file the store still holds open.
func newTestStore(t *testing.T, ffmpeg string) (*Store, string) {
	t.Helper()
	directory := t.TempDir()
	store := NewStore(func() string { return ffmpeg })
	t.Cleanup(store.Close)
	return store, directory
}

// The suggested name only seeds a save dialog, but it must not be able to
// steer one: a separator, a drive letter, or a trailing dot each change where
// the dialog opens or what it writes.
func TestSafeSuggestedNameCannotSteerTheDialog(t *testing.T) {
	for _, test := range []struct{ name, input, want string }{
		{"an ordinary name", "Team sync.webm", "Team sync.webm"},
		{"a POSIX path", "/etc/passwd", "passwd"},
		{"a Windows path", `C:\Windows\System32\config`, "config"},
		{"a traversal", "../../secrets.txt", "secrets.txt"},
		{"a bare traversal", "..", defaultName},
		{"a dot", ".", defaultName},
		{"empty", "", defaultName},
		{"only separators", "///", defaultName},
		{"a drive-relative name", `C:recording.webm`, "C_recording.webm"},
		{"reserved characters", `re<c>o:r"d|i?n*g.webm`, "re_c_o_r_d_i_n_g.webm"},
		{"a trailing dot", "recording.", "recording"},
		{"trailing spaces", "recording.webm   ", "recording.webm"},
		{"a control character", "rec\x00ord\ning.webm", "rec_ord_ing.webm"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := SafeSuggestedName(test.input)
			if got != test.want {
				t.Errorf("SafeSuggestedName(%q) = %q, want %q", test.input, got, test.want)
			}
			// Whatever comes out must be a bare leaf.
			if strings.ContainsAny(got, `/\`) {
				t.Errorf("%q still carries a path separator", got)
			}
			if filepath.Base(got) != got {
				t.Errorf("%q is not a bare file name", got)
			}
		})
	}
}

func TestSafeSuggestedNameIsBounded(t *testing.T) {
	got := SafeSuggestedName(strings.Repeat("a", 1000) + ".webm")
	if len(got) > 240 {
		t.Errorf("the name is %d characters, want at most 240", len(got))
	}
}

func TestSuggestedNameForSwapsTheExtension(t *testing.T) {
	for _, test := range []struct {
		input  string
		format Format
		want   string
	}{
		{"Team sync.webm", FormatMP4, "Team sync.mp4"},
		{"Team sync.webm", FormatWAV, "Team sync.wav"},
		{"notes", FormatMP3, "notes.mp3"},
		{"/tmp/../call.webm", FormatMP4, "call.mp4"},
	} {
		if got := SuggestedNameFor(test.input, test.format); got != test.want {
			t.Errorf("SuggestedNameFor(%q, %v) = %q, want %q", test.input, test.format, got, test.want)
		}
	}
}

func TestParseFormatAcceptsOnlyWhatCanBeProduced(t *testing.T) {
	for _, value := range []string{"mp4", "wav", "mp3"} {
		if _, err := ParseFormat(value); err != nil {
			t.Errorf("%q was rejected: %v", value, err)
		}
	}
	for _, value := range []string{"", "mkv", "exe", "MP4", "mp4 "} {
		if _, err := ParseFormat(value); err == nil {
			t.Errorf("%q was accepted", value)
		}
	}
}

func TestBeginGuardsItsInputs(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	if _, err := store.Begin("", "owner", 10, ""); err == nil {
		t.Error("an empty destination was accepted")
	}
	if _, err := store.Begin(destination, "owner", 0, ""); err == nil {
		t.Error("a zero size was accepted")
	}
	if _, err := store.Begin(destination, "owner", MaxExportBytes+1, ""); err == nil {
		t.Error("an oversized export was accepted")
	}
	// Conversion needs a runtime this store does not have.
	if _, err := store.Begin(destination, "owner", 10, FormatMP4); err == nil {
		t.Error("a conversion was accepted with no runtime")
	}
}

// A straight export writes the exact bytes the page streamed, and only commits
// under the chosen name once it is complete.
func TestAnExportWritesExactlyWhatWasStreamed(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "recording.webm")
	payload := bytes.Repeat([]byte("bettercomms"), 5000)

	grant, err := store.Begin(destination, "owner", int64(len(payload)), "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}

	// Nothing exists under the chosen name until the export finishes.
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Error("the destination was created before the export completed")
	}

	for offset := 0; offset < len(payload); offset += MaxChunkBytes {
		end := min(offset+MaxChunkBytes, len(payload))
		if err := store.Append(grant.ExportID, "owner", int64(offset), payload[offset:end]); err != nil {
			t.Fatalf("Append at %d: %v", offset, err)
		}
	}

	result, err := store.Finish(context.Background(), grant.ExportID, "owner")
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if result.FileName != "recording.webm" {
		t.Errorf("file name = %q", result.FileName)
	}
	written, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("read destination: %v", err)
	}
	if !bytes.Equal(written, payload) {
		t.Errorf("wrote %d bytes, want the %d streamed", len(written), len(payload))
	}

	// No staging file is left beside it.
	entries, err := os.ReadDir(filepath.Dir(destination))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 {
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		slices.Sort(names)
		t.Errorf("the export left %v behind, want only the recording", names)
	}
}

// An out-of-order offset would let a page write holes into, or rewrite bytes
// of, a file it does not otherwise control.
func TestAppendRefusesAnOutOfOrderOffset(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	grant, err := store.Begin(destination, "owner", 100, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Append(grant.ExportID, "owner", 0, []byte("first")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	// A gap.
	if err := store.Append(grant.ExportID, "owner", 50, []byte("later")); err == nil {
		t.Error("a gap was accepted")
	}
	// A rewrite.
	if err := store.Append(grant.ExportID, "owner", 0, []byte("again")); err == nil {
		t.Error("a rewrite of committed bytes was accepted")
	}
}

func TestAppendGuardsSizeAndEmptiness(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	grant, err := store.Begin(destination, "owner", 10, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Append(grant.ExportID, "owner", 0, nil); err == nil {
		t.Error("an empty chunk was accepted")
	}
	if err := store.Append(grant.ExportID, "owner", 0, make([]byte, MaxChunkBytes+1)); err == nil {
		t.Error("an oversized chunk was accepted")
	}
	// More than the export declared.
	if err := store.Append(grant.ExportID, "owner", 0, make([]byte, 20)); err == nil {
		t.Error("more bytes than declared were accepted")
	}
}

// A grant belongs to the window that opened it. Another window must not be
// able to stream into a file that window's person chose.
func TestAGrantBelongsToItsOwner(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	grant, err := store.Begin(destination, "owner", 10, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Append(grant.ExportID, "intruder", 0, []byte("hi")); err == nil {
		t.Error("another owner appended to the export")
	}
	if _, err := store.Finish(context.Background(), grant.ExportID, "intruder"); err == nil {
		t.Error("another owner finished the export")
	}
	if err := store.Abort(grant.ExportID, "intruder"); err == nil {
		t.Error("another owner aborted the export")
	}
}

func TestFinishRefusesAnIncompleteExport(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	grant, err := store.Begin(destination, "owner", 100, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Append(grant.ExportID, "owner", 0, []byte("short")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := store.Finish(context.Background(), grant.ExportID, "owner"); err == nil {
		t.Error("an incomplete export was committed")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Error("an incomplete export created the destination")
	}
}

// An abandoned grant is reclaimed, so a page that opens dialogs and walks away
// cannot hold staging files forever.
func TestAbandonedGrantsExpire(t *testing.T) {
	store, directory := newTestStore(t, "")

	grant, err := store.Begin(filepath.Join(directory, "out.webm"), "owner", 10, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}

	// Move the clock past the lifetime and provoke a sweep.
	store.now = func() time.Time { return time.Now().Add(ExportTTL + time.Minute) }
	if _, err := store.Begin(filepath.Join(directory, "other.webm"), "owner", 10, ""); err != nil {
		t.Fatalf("second Begin: %v", err)
	}

	if err := store.Append(grant.ExportID, "owner", 0, []byte("hi")); err == nil {
		t.Error("an expired grant still accepts chunks")
	}
}

func TestTooManyGrantsAreRefused(t *testing.T) {
	store, directory := newTestStore(t, "")

	for index := range MaxActiveExports {
		if _, err := store.Begin(filepath.Join(directory, "out"+string(rune('a'+index))+".webm"), "owner", 10, ""); err != nil {
			t.Fatalf("grant %d: %v", index, err)
		}
	}
	if _, err := store.Begin(filepath.Join(directory, "one-too-many.webm"), "owner", 10, ""); err == nil {
		t.Error("the grant limit was exceeded")
	}
}

func TestAbortDiscardsTheStagingFile(t *testing.T) {
	store, directory := newTestStore(t, "")
	destination := filepath.Join(directory, "out.webm")

	grant, err := store.Begin(destination, "owner", 10, "")
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Append(grant.ExportID, "owner", 0, []byte("partial")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := store.Abort(grant.ExportID, "owner"); err != nil {
		t.Fatalf("Abort: %v", err)
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("abort left %d files behind", len(entries))
	}
	// Aborting again is not an error: the goal is that it is gone.
	if err := store.Abort(grant.ExportID, "owner"); err != nil {
		t.Errorf("Abort: %v", err)
	}
}

// The input is a file the page produced. Without the whitelists a crafted
// container could make FFmpeg open a network URL or a format nobody asked for.
func TestConversionWhitelistsItsInput(t *testing.T) {
	for _, format := range []Format{FormatMP4, FormatWAV, FormatMP3} {
		args := convertArgs("in.webm", "out."+format.Extension(), format)

		index := slices.Index(args, "-protocol_whitelist")
		if index < 0 || args[index+1] != "file,pipe" {
			t.Errorf("%v does not restrict protocols: %v", format, args)
		}
		index = slices.Index(args, "-format_whitelist")
		if index < 0 || args[index+1] != "matroska,mov" {
			t.Errorf("%v does not restrict formats: %v", format, args)
		}
		index = slices.Index(args, "-f")
		if index < 0 || args[index+1] != string(format) {
			t.Errorf("%v does not pin its output format: %v", format, args)
		}
		if args[len(args)-1] != "out."+format.Extension() {
			t.Errorf("%v does not end with its output path: %v", format, args)
		}
	}
}

// A screen recording may legitimately have no audio, so MP4 must not fail on a
// missing audio stream.
func TestMP4ConversionToleratesAMissingAudioStream(t *testing.T) {
	args := convertArgs("in.webm", "out.mp4", FormatMP4)
	if !slices.Contains(args, "0:a:0?") {
		t.Errorf("the audio mapping is not optional: %v", args)
	}
	if !slices.Contains(args, "0:v:0") {
		t.Errorf("no video stream is mapped: %v", args)
	}
}

// The audio-only targets must drop video rather than failing on it.
func TestAudioConversionsDropVideo(t *testing.T) {
	for _, format := range []Format{FormatWAV, FormatMP3} {
		args := convertArgs("in.webm", "out", format)
		if !slices.Contains(args, "-vn") {
			t.Errorf("%v does not drop video: %v", format, args)
		}
	}
}

func TestDescribeFollowsTheRuntime(t *testing.T) {
	withRuntimeStore, _ := newTestStore(t, "ffmpeg.exe")
	withRuntime := withRuntimeStore.Describe()
	for _, format := range withRuntime.Formats {
		if !format.Available {
			t.Errorf("%s is unavailable despite a runtime", format.ID)
		}
	}
	withoutStore, _ := newTestStore(t, "")
	without := withoutStore.Describe()
	for _, format := range without.Formats {
		if format.Available {
			t.Errorf("%s is available with no runtime", format.ID)
		}
	}
	if len(without.Formats) != 3 {
		t.Errorf("%d formats described, want 3", len(without.Formats))
	}
}
