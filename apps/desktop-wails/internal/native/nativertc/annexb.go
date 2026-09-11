// Package nativertc sends a natively encoded H.264 capture straight to WebRTC
// viewers.
//
// Encoded access units arrive from the encoder subprocess and are packetized
// here. No frame is decoded, re-encoded, or handed to a browser encoder, which
// is what lets one capture serve several viewers at a cost that does not grow
// with the frame size.
package nativertc

import (
	"errors"
	"fmt"
)

const (
	// MaxAccessUnitBytes bounds one access unit after configuration is
	// prepended. Anything larger is not something this pipeline produces.
	MaxAccessUnitBytes = 16 * 1024 * 1024
	// MaxParameterSetBytes bounds one SPS or PPS. A real one is tens of bytes;
	// this is generous enough to never reject a legitimate encoder.
	MaxParameterSetBytes = 64 * 1024
)

// NAL unit types this pipeline reasons about.
const (
	nalSliceNonIDR = 1
	nalSliceIDR    = 5
	nalSPS         = 7
	nalPPS         = 8
	nalAUD         = 9
)

// unit locates one NAL inside an Annex B buffer.
type unit struct {
	// start is the offset of the start code.
	start int
	// header is the offset of the NAL header byte, just past the start code.
	header int
	// end is the offset one past the last payload byte.
	end int
	// kind is the NAL unit type.
	kind byte
}

// startCodeLength reports the length of an Annex B start code at the front of
// bytes, or zero when there is none.
func startCodeLength(bytes []byte) int {
	switch {
	case len(bytes) >= 4 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0 && bytes[3] == 1:
		return 4
	case len(bytes) >= 3 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 1:
		return 3
	}
	return 0
}

// hasAnnexBStartCode reports whether bytes begins with a start code.
func hasAnnexBStartCode(bytes []byte) bool { return startCodeLength(bytes) != 0 }

// nalHeaderOffset is where the NAL header sits in a unit that begins with a
// start code.
func nalHeaderOffset(value []byte) (int, bool) {
	length := startCodeLength(value)
	return length, length != 0
}

// annexBUnits locates every NAL in an Annex B buffer.
//
// Scanning rather than splitting is what keeps a start-code-like byte sequence
// inside a payload from being mistaken for a boundary: a real boundary is only
// recognised where a start code actually begins.
func annexBUnits(bytes []byte) []unit {
	type boundary struct{ start, header int }
	var starts []boundary

	for index := 0; index+3 <= len(bytes); {
		length := startCodeLength(bytes[index:])
		if length == 0 {
			index++
			continue
		}
		// A start code with no header byte after it is a truncated tail, not a
		// unit.
		if index+length < len(bytes) {
			starts = append(starts, boundary{start: index, header: index + length})
		}
		index += length
	}

	units := make([]unit, 0, len(starts))
	for position, found := range starts {
		end := len(bytes)
		if position+1 < len(starts) {
			end = starts[position+1].start
		}
		units = append(units, unit{
			start:  found.start,
			header: found.header,
			end:    end,
			kind:   bytes[found.header] & 0x1f,
		})
	}
	return units
}

// annexBHasIDR reports whether the buffer carries a keyframe slice.
func annexBHasIDR(bytes []byte) bool {
	for _, found := range annexBUnits(bytes) {
		if found.kind == nalSliceIDR {
			return true
		}
	}
	return false
}

// parameterSets caches the most recent SPS and PPS.
//
// A viewer joining mid-stream, or one recovering from loss, needs decoder
// configuration attached to the keyframe it restarts on. Encoders do not always
// repeat SPS and PPS with every IDR, so they are remembered here and prepended
// when they are missing.
type parameterSets struct {
	sps []byte
	pps []byte
}

// spsDescriptor is the profile_idc, constraint flags, and level_idc of the
// cached SPS, which is what the diagnostics report.
func (p *parameterSets) spsDescriptor() ([3]byte, bool) {
	header, ok := nalHeaderOffset(p.sps)
	if !ok || header+3 >= len(p.sps) {
		return [3]byte{}, false
	}
	return [3]byte{p.sps[header+1], p.sps[header+2], p.sps[header+3]}, true
}

// ErrParameterSetTooLarge reports an SPS or PPS beyond what an encoder emits.
var ErrParameterSetTooLarge = errors.New("native screen H.264 parameter set exceeded 64 KiB")

// prepareAccessUnit caches the unit's parameter sets and, when it is a
// keyframe missing them, prepends the cached ones.
//
// This is what makes a late joiner decodable without asking the encoder for a
// new keyframe it cannot be asked for: the subprocess has no PLI channel.
func prepareAccessUnit(annexB []byte, cache *parameterSets) ([]byte, error) {
	units := annexBUnits(annexB)

	var hasSPS, hasPPS, hasIDR bool
	var incomingSPS []byte
	for _, found := range units {
		switch found.kind {
		case nalSPS:
			if !hasSPS {
				incomingSPS = annexB[found.header:found.end]
			}
			hasSPS = true
		case nalPPS:
			hasPPS = true
		case nalSliceIDR:
			hasIDR = true
		}
	}

	// A changed SPS can invalidate the old PPS. Drop it and wait for the
	// matching one rather than attaching stale decoder configuration to an IDR.
	if hasSPS && !hasPPS {
		var cachedSPS []byte
		if header, ok := nalHeaderOffset(cache.sps); ok {
			cachedSPS = cache.sps[header:]
		}
		if !equalBytes(incomingSPS, cachedSPS) {
			cache.pps = nil
		}
	}

	for _, found := range units {
		if found.kind != nalSPS && found.kind != nalPPS {
			continue
		}
		if found.end-found.start > MaxParameterSetBytes {
			return nil, ErrParameterSetTooLarge
		}
		value := append([]byte(nil), annexB[found.start:found.end]...)
		if found.kind == nalSPS {
			cache.sps = value
		} else {
			cache.pps = value
		}
	}

	// A delta frame needs nothing, and a keyframe that already carries both
	// sets is complete.
	if !hasIDR || (hasSPS && hasPPS) {
		return annexB, nil
	}

	var prefix []byte
	if !hasSPS && cache.sps != nil {
		prefix = append(prefix, cache.sps...)
	}
	if !hasPPS && cache.pps != nil {
		prefix = append(prefix, cache.pps...)
	}
	if len(prefix) == 0 {
		// Nothing cached yet. The frame goes out as it is; the next keyframe
		// carrying its own sets is what recovers.
		return annexB, nil
	}
	if len(prefix)+len(annexB) > MaxAccessUnitBytes {
		return nil, errors.New("native screen H.264 access unit exceeded its size after configuration")
	}

	// Configuration must precede the slice it configures. When the SPS is the
	// missing one it goes ahead of everything but the access unit delimiter;
	// when only the PPS is missing it goes just before the PPS's usual place.
	insertion := len(annexB)
	for _, found := range units {
		fits := found.kind != nalAUD
		if hasSPS {
			fits = found.kind == nalPPS ||
				(found.kind >= nalSliceNonIDR && found.kind <= nalSliceIDR)
		}
		if fits {
			insertion = found.start
			break
		}
	}

	configured := make([]byte, 0, len(prefix)+len(annexB))
	configured = append(configured, annexB[:insertion]...)
	configured = append(configured, prefix...)
	configured = append(configured, annexB[insertion:]...)
	return configured, nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// validateIdentifier bounds a session or peer id before it reaches anything
// that would use it as a key or a label.
func validateIdentifier(label, value string) error {
	if value == "" || len(value) > 128 {
		return fmt.Errorf("%s is invalid", label)
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		alphanumeric := (character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z')
		if !alphanumeric && character != '-' && character != '_' && character != '.' && character != ':' {
			return fmt.Errorf("%s is invalid", label)
		}
	}
	return nil
}

// publicError is what reaches the page.
//
// Configuration objects and SDP never appear here: both can carry TURN
// credentials, and an error string is the easiest place to leak them.
func publicError(err error) error {
	return fmt.Errorf("native screen WebRTC operation failed: %w", err)
}
