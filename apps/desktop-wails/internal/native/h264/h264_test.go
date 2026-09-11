package h264

import (
	"errors"
	"fmt"
	"testing"
)

// The lowest level that fits is what must be chosen. Announcing a higher level
// than the stream needs turns away receivers that could have decoded it.
func TestLevelPicksTheLowestThatFits(t *testing.T) {
	for _, test := range []struct {
		name                            string
		profile                         Profile
		width, height, fps, bitrateMbps uint32
		want                            string
	}{
		{"720p30 at 4 Mbps", Baseline, 1280, 720, 30, 4, "3.1"},
		{"1080p30 at 8 Mbps", Main, 1920, 1080, 30, 8, "4.0"},
		{"1080p60 at 12 Mbps", Main, 1920, 1080, 60, 12, "4.2"},
		{"1440p60 at 20 Mbps", Main, 2560, 1440, 60, 20, "5.1"},
		{"4K60 at 40 Mbps", High, 3840, 2160, 60, 40, "5.2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := FFmpegLevel(test.profile, test.width, test.height, test.fps, test.bitrateMbps)
			if err != nil {
				t.Fatalf("FFmpegLevel: %v", err)
			}
			if got != test.want {
				t.Errorf("level = %s, want %s", got, test.want)
			}
		})
	}
}

// High profile carries 1.25x the bitrate of baseline and main at the same
// level, so a rate that forces main up a level can stay put on high.
func TestHighProfileGetsTheLargerBitrateAllowance(t *testing.T) {
	const width, height, fps, bitrate = 1920, 1080, 30, 18

	main, err := FFmpegLevel(Main, width, height, fps, bitrate)
	if err != nil {
		t.Fatalf("main: %v", err)
	}
	high, err := FFmpegLevel(High, width, height, fps, bitrate)
	if err != nil {
		t.Fatalf("high: %v", err)
	}
	if main != "4.0" {
		t.Errorf("main level = %s, want 4.0", main)
	}
	// 18 Mbps is under main's 20 Mbps at 4.0 too, so both land at 4.0 here;
	// the allowance shows at a rate main cannot carry.
	if high != "4.0" {
		t.Errorf("high level = %s, want 4.0", high)
	}

	// 22 Mbps exceeds main's 20 Mbps at 4.0 but fits high's 25 Mbps.
	main, err = FFmpegLevel(Main, width, height, fps, 22)
	if err != nil {
		t.Fatalf("main at 22 Mbps: %v", err)
	}
	high, err = FFmpegLevel(High, width, height, fps, 22)
	if err != nil {
		t.Fatalf("high at 22 Mbps: %v", err)
	}
	if main == high {
		t.Errorf("both profiles chose %s; high's larger allowance did not apply", main)
	}
}

func TestSettingsBeyondLevel52AreRejected(t *testing.T) {
	if _, err := FFmpegLevel(High, 7680, 4320, 120, 400); !errors.Is(err, ErrTooDemanding) {
		t.Errorf("err = %v, want ErrTooDemanding", err)
	}
}

// A width or height large enough to overflow 32-bit arithmetic must be
// rejected, not wrapped into a level that looks satisfiable.
func TestEnormousDimensionsDoNotWrap(t *testing.T) {
	if _, err := FFmpegLevel(Main, 1<<31, 1<<31, 60, 10); err == nil {
		t.Error("dimensions that overflow 32-bit macroblock arithmetic were accepted")
	}
	if _, err := FFmpegLevel(Main, 4096, 4096, 1<<20, 10); err == nil {
		t.Error("a frame rate that overflows was accepted")
	}
}

func TestZeroSettingsAreRejected(t *testing.T) {
	for _, test := range []struct {
		name                            string
		width, height, fps, bitrateMbps uint32
	}{
		{"no width", 0, 720, 30, 4},
		{"no height", 1280, 0, 30, 4},
		{"no frame rate", 1280, 720, 0, 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := FFmpegLevel(Main, test.width, test.height, test.fps, test.bitrateMbps); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func TestUnknownProfilesAreRejected(t *testing.T) {
	if Profile("extended").Valid() {
		t.Error("an unsupported profile reported itself valid")
	}
	if _, err := FFmpegLevel(Profile("extended"), 1280, 720, 30, 4); err == nil {
		t.Error("an unsupported profile was accepted")
	}
}

// The SDP profile-level-id must carry the same level the encoder is given.
// A mismatch tells a receiver to expect a stream that is not being sent.
func TestProfileLevelIDMatchesTheEncoderLevel(t *testing.T) {
	for _, test := range []struct {
		profile Profile
		want    string
	}{
		{Baseline, "42e01f"},
		{Main, "4d001f"},
		{High, "64001f"},
	} {
		t.Run(string(test.profile), func(t *testing.T) {
			got, err := ProfileLevelID(test.profile, 1280, 720, 30, 4)
			if err != nil {
				t.Fatalf("ProfileLevelID: %v", err)
			}
			if got != test.want {
				t.Errorf("profile-level-id = %s, want %s", got, test.want)
			}

			idc, _, err := Level(test.profile, 1280, 720, 30, 4)
			if err != nil {
				t.Fatalf("Level: %v", err)
			}
			// The last byte of the id is the level_idc the encoder is given.
			if got[4:] != fmt.Sprintf("%02x", idc) {
				t.Errorf("the id's level byte %q does not match level_idc %#x", got[4:], idc)
			}
		})
	}
}

func TestFFmpegNameIsWhatFFmpegTakes(t *testing.T) {
	for profile, want := range map[Profile]string{
		Baseline: "baseline",
		Main:     "main",
		High:     "high",
	} {
		if got := profile.FFmpegName(); got != want {
			t.Errorf("%v.FFmpegName() = %q, want %q", profile, got, want)
		}
	}
}
