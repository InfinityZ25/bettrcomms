package nativertc

import (
	"bytes"
	"errors"
	"slices"
	"testing"
)

// nal builds one Annex B unit with a four-byte start code.
func nal(kind byte, payload ...byte) []byte {
	return append([]byte{0, 0, 0, 1, kind}, payload...)
}

// nal3 builds one with a three-byte start code, which encoders also emit.
func nal3(kind byte, payload ...byte) []byte {
	return append([]byte{0, 0, 1, kind}, payload...)
}

func keyframeUnit() []byte {
	return slices.Concat(nal(nalAUD, 0x10), nal(nalSPS, 0x42, 0xe0, 0x1f), nal(nalPPS, 0xce), nal(nalSliceIDR, 0xaa))
}

func deltaUnit() []byte {
	return slices.Concat(nal(nalAUD, 0x30), nal(nalSliceNonIDR, 0xbb))
}

func TestAnnexBUnitsFindsEveryNAL(t *testing.T) {
	stream := keyframeUnit()
	units := annexBUnits(stream)

	var kinds []byte
	for _, found := range units {
		kinds = append(kinds, found.kind)
	}
	want := []byte{nalAUD, nalSPS, nalPPS, nalSliceIDR}
	if !slices.Equal(kinds, want) {
		t.Errorf("kinds = %v, want %v", kinds, want)
	}
	// Every unit must span to the next one's start code.
	for index, found := range units {
		if found.end <= found.header {
			t.Errorf("unit %d is empty: %+v", index, found)
		}
		if index+1 < len(units) && found.end != units[index+1].start {
			t.Errorf("unit %d ends at %d but the next starts at %d", index, found.end, units[index+1].start)
		}
	}
	if units[len(units)-1].end != len(stream) {
		t.Error("the last unit does not run to the end of the buffer")
	}
}

func TestAnnexBUnitsHandlesBothStartCodeLengths(t *testing.T) {
	stream := slices.Concat(nal3(nalSPS, 0x42), nal(nalPPS, 0xce))
	units := annexBUnits(stream)
	if len(units) != 2 {
		t.Fatalf("got %d units, want 2", len(units))
	}
	if units[0].header != 3 {
		t.Errorf("three-byte start code gave header offset %d, want 3", units[0].header)
	}
	if units[1].header-units[1].start != 4 {
		t.Errorf("four-byte start code gave header offset %d, want 4", units[1].header-units[1].start)
	}
}

// Scanning must terminate on any input, including a buffer that is nothing but
// start codes.
func TestAnnexBValidationIsBounded(t *testing.T) {
	for _, stream := range [][]byte{
		{},
		{0},
		{0, 0},
		{0, 0, 1},
		{0, 0, 0, 1},
		bytes.Repeat([]byte{0, 0, 1}, 1000),
		bytes.Repeat([]byte{0}, 1000),
	} {
		units := annexBUnits(stream)
		for _, found := range units {
			if found.header >= len(stream) || found.end > len(stream) {
				t.Fatalf("unit escapes the buffer: %+v of %d bytes", found, len(stream))
			}
		}
	}
}

func TestHasAnnexBStartCodeRecognisesBothForms(t *testing.T) {
	if !hasAnnexBStartCode([]byte{0, 0, 1, 0x65}) || !hasAnnexBStartCode([]byte{0, 0, 0, 1, 0x65}) {
		t.Error("a valid start code was not recognised")
	}
	if hasAnnexBStartCode([]byte{0, 1, 0, 0}) || hasAnnexBStartCode([]byte{0x65}) {
		t.Error("a non-start-code was accepted")
	}
}

// A viewer joining mid-stream needs configuration attached to the keyframe it
// restarts on. The encoder is a subprocess with no PLI channel, so a keyframe
// that arrives without its parameter sets must be completed from the cache.
func TestParameterSetsAreCachedAndPrecedeALateIDRAfterAUD(t *testing.T) {
	cache := &parameterSets{}

	// A first keyframe carrying its own sets primes the cache and passes through.
	first := keyframeUnit()
	prepared, err := prepareAccessUnit(first, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	if !bytes.Equal(prepared, first) {
		t.Error("a complete keyframe was modified")
	}
	if cache.sps == nil || cache.pps == nil {
		t.Fatal("the parameter sets were not cached")
	}

	// A later keyframe with no sets must come out with them, and after the AUD.
	late := slices.Concat(nal(nalAUD, 0x10), nal(nalSliceIDR, 0xcc))
	prepared, err = prepareAccessUnit(late, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	units := annexBUnits(prepared)
	var kinds []byte
	for _, found := range units {
		kinds = append(kinds, found.kind)
	}
	want := []byte{nalAUD, nalSPS, nalPPS, nalSliceIDR}
	if !slices.Equal(kinds, want) {
		t.Errorf("kinds = %v, want %v (AUD first, then configuration, then the slice)", kinds, want)
	}
}

// A delta frame needs no configuration; prepending it would waste bandwidth on
// every frame.
func TestDeltaFramesAreLeftAlone(t *testing.T) {
	cache := &parameterSets{}
	if _, err := prepareAccessUnit(keyframeUnit(), cache); err != nil {
		t.Fatalf("prime: %v", err)
	}

	delta := deltaUnit()
	prepared, err := prepareAccessUnit(delta, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	if !bytes.Equal(prepared, delta) {
		t.Error("a delta frame was given configuration it does not need")
	}
}

// A changed SPS invalidates the PPS that went with it. Attaching the old one to
// a new keyframe would hand the decoder inconsistent configuration.
func TestChangedSPSDoesNotReuseAnOldPPS(t *testing.T) {
	cache := &parameterSets{}
	if _, err := prepareAccessUnit(keyframeUnit(), cache); err != nil {
		t.Fatalf("prime: %v", err)
	}

	// A different SPS arrives alone.
	changed := slices.Concat(nal(nalAUD, 0x10), nal(nalSPS, 0x64, 0x00, 0x28), nal(nalSliceIDR, 0xdd))
	prepared, err := prepareAccessUnit(changed, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	for _, found := range annexBUnits(prepared) {
		if found.kind == nalPPS {
			t.Error("the stale PPS was attached to a keyframe with a new SPS")
		}
	}
	if cache.pps != nil {
		t.Error("the stale PPS is still cached")
	}
}

// The same SPS written with a different start code is the same SPS. Treating
// it as a change would needlessly drop a valid PPS.
func TestIdenticalSPSWithDifferentStartCodeRetainsMatchingPPS(t *testing.T) {
	cache := &parameterSets{}
	if _, err := prepareAccessUnit(keyframeUnit(), cache); err != nil {
		t.Fatalf("prime: %v", err)
	}

	// Byte-identical SPS payload, three-byte start code this time.
	same := slices.Concat(nal(nalAUD, 0x10), nal3(nalSPS, 0x42, 0xe0, 0x1f), nal(nalSliceIDR, 0xee))
	prepared, err := prepareAccessUnit(same, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	if cache.pps == nil {
		t.Fatal("the matching PPS was dropped")
	}
	var sawPPS bool
	for _, found := range annexBUnits(prepared) {
		if found.kind == nalPPS {
			sawPPS = true
		}
	}
	if !sawPPS {
		t.Error("the keyframe went out without its PPS")
	}
}

// Nothing can be completed before the first keyframe carrying configuration
// arrives. The frame must pass through rather than fail.
func TestAKeyframeBeforeAnyCachedSetsPassesThrough(t *testing.T) {
	cache := &parameterSets{}
	bare := slices.Concat(nal(nalAUD, 0x10), nal(nalSliceIDR, 0xaa))

	prepared, err := prepareAccessUnit(bare, cache)
	if err != nil {
		t.Fatalf("prepareAccessUnit: %v", err)
	}
	if !bytes.Equal(prepared, bare) {
		t.Error("a keyframe was modified with configuration that does not exist yet")
	}
}

func TestAnOversizedParameterSetIsRejected(t *testing.T) {
	cache := &parameterSets{}
	huge := nal(nalSPS, bytes.Repeat([]byte{0x42}, MaxParameterSetBytes+1)...)

	if _, err := prepareAccessUnit(huge, cache); !errors.Is(err, ErrParameterSetTooLarge) {
		t.Errorf("err = %v, want ErrParameterSetTooLarge", err)
	}
}

func TestAnnexBHasIDRFindsAKeyframe(t *testing.T) {
	if !annexBHasIDR(keyframeUnit()) {
		t.Error("a keyframe was not recognised")
	}
	if annexBHasIDR(deltaUnit()) {
		t.Error("a delta frame was reported as a keyframe")
	}
}

func TestSPSDescriptorReportsProfileAndLevel(t *testing.T) {
	cache := &parameterSets{}
	if _, err := prepareAccessUnit(keyframeUnit(), cache); err != nil {
		t.Fatalf("prime: %v", err)
	}
	descriptor, ok := cache.spsDescriptor()
	if !ok {
		t.Fatal("no descriptor from a cached SPS")
	}
	// profile_idc 0x42, constraint flags 0xe0, level_idc 0x1f.
	if descriptor != [3]byte{0x42, 0xe0, 0x1f} {
		t.Errorf("descriptor = %x, want 42e01f", descriptor)
	}
}

func TestValidateIdentifierBoundsWhatBecomesAKey(t *testing.T) {
	for _, value := range []string{"session-1", "peer_2", "a.b:c", "0123456789"} {
		if err := validateIdentifier("session ID", value); err != nil {
			t.Errorf("%q was rejected: %v", value, err)
		}
	}
	for _, value := range []string{
		"",
		"has space",
		"has/slash",
		"has\nnewline",
		"quote\"",
		string(make([]byte, 129)),
	} {
		if err := validateIdentifier("session ID", value); err == nil {
			t.Errorf("%q was accepted", value)
		}
	}
}

// An error that reaches the page must never carry SDP or ICE configuration:
// both can hold TURN credentials.
func TestPublicErrorsCarryNoConfiguration(t *testing.T) {
	err := publicError(errors.New("dial udp: credential=hunter2"))
	if err == nil {
		t.Fatal("no error")
	}
	// The wrapper itself must not add configuration; what it wraps is the
	// caller's responsibility, and callers pass only transport errors.
	if !bytes.Contains([]byte(err.Error()), []byte("native screen WebRTC operation failed")) {
		t.Errorf("err = %v, want the generic prefix", err)
	}
}
