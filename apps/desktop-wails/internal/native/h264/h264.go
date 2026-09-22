// Package h264 holds the H.264 profile and level arithmetic shared by the
// native encoder and the native WebRTC sender.
//
// Both have to agree exactly. The level advertised in the SDP and the level the
// encoder is configured with come from the same computation here, so a receiver
// is never told to expect a stream the encoder is not producing.
package h264

import (
	"errors"
	"fmt"
)

// Profile is the H.264 profile a native capture is encoded in.
type Profile string

const (
	Baseline Profile = "baseline"
	Main     Profile = "main"
	High     Profile = "high"
)

// FFmpegName is the profile name FFmpeg's -profile:v takes.
func (p Profile) FFmpegName() string { return string(p) }

// Valid reports whether p is one this host encodes.
func (p Profile) Valid() bool {
	switch p {
	case Baseline, Main, High:
		return true
	}
	return false
}

// sdpPrefix is the profile_idc and constraint-flag pair that opens an
// SDP profile-level-id.
func (p Profile) sdpPrefix() (string, error) {
	switch p {
	case Baseline:
		return "42e0", nil
	case Main:
		return "4d00", nil
	case High:
		return "6400", nil
	}
	return "", fmt.Errorf("unknown H.264 profile %q", p)
}

// level is one row of the Annex A limits: level_idc, its name, MaxMBPS, MaxFS,
// and the baseline/main MaxBR in kbit/s.
type level struct {
	idc      uint8
	name     string
	maxMBPS  uint64
	maxFS    uint64
	maxBRKbs uint64
}

// levels are the Annex A limits, lowest first, so the first row that fits is
// the lowest level that can carry the stream. Announcing a higher level than
// needed turns away receivers that could have decoded it.
var levels = []level{
	{0x1f, "3.1", 108_000, 3_600, 14_000},
	{0x20, "3.2", 216_000, 5_120, 20_000},
	{0x28, "4.0", 245_760, 8_192, 20_000},
	{0x29, "4.1", 245_760, 8_192, 50_000},
	{0x2a, "4.2", 522_240, 8_704, 50_000},
	{0x32, "5.0", 589_824, 22_080, 135_000},
	{0x33, "5.1", 983_040, 36_864, 240_000},
	{0x34, "5.2", 2_073_600, 36_864, 240_000},
}

// ErrTooDemanding reports settings no level this host advertises can carry.
var ErrTooDemanding = errors.New("Native screen settings exceed H.264 level 5.2")

// Level returns the lowest level that can carry the given capture, as its
// level_idc and its FFmpeg name.
func Level(profile Profile, width, height, fps, bitrateMbps uint32) (uint8, string, error) {
	if !profile.Valid() {
		return 0, "", fmt.Errorf("unknown H.264 profile %q", profile)
	}
	if width == 0 || height == 0 {
		return 0, "", errors.New("Native screen dimensions must be positive")
	}
	if fps == 0 {
		return 0, "", errors.New("native screen frame rate must be positive")
	}

	// Computed in 64 bits so a hostile or mistaken size cannot wrap into a
	// level that looks satisfiable.
	macroblocks := uint64((width+15)/16) * uint64((height+15)/16)
	macroblocksPerSecond := macroblocks * uint64(fps)
	bitrateKbps := uint64(bitrateMbps) * 1_000

	for _, candidate := range levels {
		maxBR := candidate.maxBRKbs
		// High profile's MaxBR is 1.25x the baseline/main figure.
		if profile == High {
			maxBR = maxBR * 5 / 4
		}
		if macroblocksPerSecond <= candidate.maxMBPS &&
			macroblocks <= candidate.maxFS &&
			bitrateKbps <= maxBR {
			return candidate.idc, candidate.name, nil
		}
	}
	return 0, "", ErrTooDemanding
}

// FFmpegLevel is the level name FFmpeg's -level takes.
func FFmpegLevel(profile Profile, width, height, fps, bitrateMbps uint32) (string, error) {
	_, name, err := Level(profile, width, height, fps, bitrateMbps)
	return name, err
}

// ProfileLevelID is the SDP fmtp profile-level-id for the given capture. The
// SDP and the encoder must agree, so both come from Level.
func ProfileLevelID(profile Profile, width, height, fps, bitrateMbps uint32) (string, error) {
	prefix, err := profile.sdpPrefix()
	if err != nil {
		return "", err
	}
	idc, _, err := Level(profile, width, height, fps, bitrateMbps)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%02x", prefix, idc), nil
}
