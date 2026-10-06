package api

import (
	"encoding/binary"
	"errors"
	"math"
)

var errVoiceContainer = errors.New("invalid audio-only voice note")

// Recordings remain attachments, but their special playback UI is only enabled
// for bounded containers with actual audio track metadata, never a MIME claim.
func validateVoiceNote(data []byte, duration int) (string, error) {
	if duration < 1 || duration > 120000 || len(data) < 16 || len(data) > maxAttachmentBytes {
		return "", errVoiceContainer
	}
	var actual float64
	var e error
	var mime string
	if len(data) >= 4 && binary.BigEndian.Uint32(data[:4]) == 0x1a45dfa3 {
		actual, e = voiceWebM(data)
		mime = "audio/webm"
	} else {
		actual, e = voiceMP4(data)
		mime = "audio/mp4"
	}
	if e != nil || actual > 120250 || math.Abs(actual-float64(duration)) > 2500 {
		return "", errVoiceContainer
	}
	return mime, nil
}
func ebmlVInt(data []byte, id bool) (uint64, int, bool) {
	if len(data) == 0 || data[0] == 0 {
		return 0, 0, false
	}
	n := 1
	mask := byte(0x80)
	for data[0]&mask == 0 {
		n++
		mask >>= 1
	}
	if n > 8 || id && n > 4 || len(data) < n {
		return 0, 0, false
	}
	v := uint64(data[0])
	if !id {
		v &= uint64(mask - 1)
	}
	for i := 1; i < n; i++ {
		v = v<<8 | uint64(data[i])
	}
	return v, n, true
}
func ebmlUint(data []byte) (uint64, bool) {
	if len(data) == 0 || len(data) > 8 {
		return 0, false
	}
	var v uint64
	for _, b := range data {
		v = v<<8 | uint64(b)
	}
	return v, true
}
func voiceWebM(data []byte) (float64, error) {
	var tracks, blocks, codecs, headers, docTypes int
	var trackNumber uint64
	var scale uint64 = 1000000
	var duration, maxStamp float64
	var cluster int64
	elements := 0
	var walk func([]byte, int) error
	walk = func(body []byte, depth int) error {
		if depth > 8 {
			return errVoiceContainer
		}
		for len(body) > 0 {
			elements++
			if elements > 200000 {
				return errVoiceContainer
			}
			id, n, ok := ebmlVInt(body, true)
			if !ok {
				return errVoiceContainer
			}
			size, m, ok := ebmlVInt(body[n:], false)
			if !ok {
				return errVoiceContainer
			}
			head := n + m
			unknown := size == (uint64(1)<<uint(m*7))-1
			if unknown {
				if id != 0x18538067 && id != 0x1f43b675 {
					return errVoiceContainer
				}
				size = uint64(len(body) - head)
				if id == 0x1f43b675 {
					var err error
					size, err = unknownClusterSize(body[head:])
					if err != nil {
						return err
					}
				}
			}
			if size > uint64(len(body)-head) {
				return errVoiceContainer
			}
			part := body[head : head+int(size)]
			body = body[head+int(size):]
			switch id {
			case 0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae:
				if id == 0x1a45dfa3 {
					headers++
				}
				if e := walk(part, depth+1); e != nil {
					return e
				}
			case 0x1f43b675:
				cluster = 0
				if e := walk(part, depth+1); e != nil {
					return e
				}
			case 0x4282:
				if string(part) != "webm" && string(part) != "matroska" {
					return errVoiceContainer
				}
				docTypes++
			case 0xd7:
				v, ok := ebmlUint(part)
				if !ok || v < 1 || trackNumber != 0 {
					return errVoiceContainer
				}
				trackNumber = v
			case 0x83:
				v, ok := ebmlUint(part)
				if !ok || v != 2 {
					return errVoiceContainer
				}
				tracks++
			case 0x86:
				if string(part) != "A_OPUS" && string(part) != "A_VORBIS" {
					return errVoiceContainer
				}
				codecs++
			case 0x2ad7b1:
				v, ok := ebmlUint(part)
				if !ok || v < 1 || v > 1000000000 {
					return errVoiceContainer
				}
				scale = v
			case 0x4489:
				if len(part) == 4 {
					duration = float64(math.Float32frombits(binary.BigEndian.Uint32(part)))
				} else if len(part) == 8 {
					duration = math.Float64frombits(binary.BigEndian.Uint64(part))
				} else {
					return errVoiceContainer
				}
				if math.IsNaN(duration) || math.IsInf(duration, 0) || duration < 0 {
					return errVoiceContainer
				}
			case 0xe7:
				v, ok := ebmlUint(part)
				if !ok || v > 121000000000 {
					return errVoiceContainer
				}
				cluster = int64(v)
			case 0xa0:
				if e := walk(part, depth+1); e != nil {
					return e
				}
			case 0xa3, 0xa1:
				track, n, ok := ebmlVInt(part, false)
				if !ok || trackNumber == 0 || track != trackNumber || len(part) < n+4 {
					return errVoiceContainer
				}
				stamp := cluster + int64(int16(binary.BigEndian.Uint16(part[n:n+2])))
				if stamp < 0 {
					return errVoiceContainer
				}
				if float64(stamp) > maxStamp {
					maxStamp = float64(stamp)
				}
				blocks++
			}
		}
		return nil
	}
	if e := walk(data, 0); e != nil {
		return 0, e
	}
	if tracks != 1 || codecs != 1 || headers != 1 || docTypes != 1 || blocks == 0 {
		return 0, errVoiceContainer
	}
	if duration > maxStamp {
		maxStamp = duration
	}
	return maxStamp * float64(scale) / 1000000, nil
}
func unknownClusterSize(body []byte) (uint64, error) {
	position := 0
	for position < len(body) {
		id, n, ok := ebmlVInt(body[position:], true)
		if !ok {
			return 0, errVoiceContainer
		}
		switch id {
		case 0x1f43b675, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x114d9b74, 0x1254c367, 0x1941a469, 0x1043a770:
			return uint64(position), nil
		}
		size, m, ok := ebmlVInt(body[position+n:], false)
		if !ok || size == (uint64(1)<<uint(m*7))-1 || size > uint64(len(body)-position-n-m) {
			return 0, errVoiceContainer
		}
		position += n + m + int(size)
	}
	return uint64(position), nil
}

type mp4VoiceRun struct {
	count    uint32
	ticks    uint64
	explicit bool
}
type mp4VoiceFragment struct {
	track           uint32
	start           uint64
	hasStart        bool
	defaultDuration uint32
	runs            []mp4VoiceRun
}

func voiceMP4(data []byte) (float64, error) {
	handlers, media, headers, codecs, clockHeaders := 0, 0, 0, 0, 0
	var scale, audioTrack, trexTrack, trexDuration uint32
	var duration float64
	var fragments []mp4VoiceFragment
	boxes, samples := 0, uint64(0)
	var walk func([]byte, int, *mp4VoiceFragment) error
	walk = func(body []byte, depth int, fragment *mp4VoiceFragment) error {
		if depth > 8 {
			return errVoiceContainer
		}
		for len(body) > 0 {
			boxes++
			if boxes > 100000 || len(body) < 8 {
				return errVoiceContainer
			}
			size := uint64(binary.BigEndian.Uint32(body))
			head := 8
			kind := string(body[4:8])
			if size == 1 {
				if len(body) < 16 {
					return errVoiceContainer
				}
				size = binary.BigEndian.Uint64(body[8:16])
				head = 16
			}
			if size == 0 {
				size = uint64(len(body))
			}
			if size < uint64(head) || size > uint64(len(body)) {
				return errVoiceContainer
			}
			part := body[head:int(size)]
			body = body[int(size):]
			switch kind {
			case "ftyp":
				if len(part) < 8 {
					return errVoiceContainer
				}
				headers++
			case "moov", "trak", "mdia", "minf", "stbl", "moof", "mvex":
				if e := walk(part, depth+1, fragment); e != nil {
					return e
				}
			case "traf":
				if fragment != nil {
					return errVoiceContainer
				}
				f := mp4VoiceFragment{}
				if e := walk(part, depth+1, &f); e != nil {
					return e
				}
				if f.track == 0 || len(f.runs) == 0 {
					return errVoiceContainer
				}
				fragments = append(fragments, f)
			case "tkhd":
				var track uint32
				if len(part) >= 20 && part[0] == 0 {
					track = binary.BigEndian.Uint32(part[12:16])
				} else if len(part) >= 32 && part[0] == 1 {
					track = binary.BigEndian.Uint32(part[20:24])
				} else {
					return errVoiceContainer
				}
				if track == 0 || audioTrack != 0 {
					return errVoiceContainer
				}
				audioTrack = track
			case "hdlr":
				if len(part) < 12 || string(part[8:12]) != "soun" {
					return errVoiceContainer
				}
				handlers++
			case "mdat":
				if len(part) > 0 {
					media++
				}
			case "stsd":
				if len(part) < 16 || binary.BigEndian.Uint32(part[4:8]) != 1 {
					return errVoiceContainer
				}
				entrySize := int(binary.BigEndian.Uint32(part[8:12]))
				codec := string(part[12:16])
				if entrySize < 36 || entrySize != len(part)-8 || codec != "mp4a" && codec != "Opus" {
					return errVoiceContainer
				}
				codecs++
			case "mdhd":
				clockHeaders++
				var ticks uint64
				if len(part) >= 24 && part[0] == 0 {
					scale = binary.BigEndian.Uint32(part[12:16])
					ticks = uint64(binary.BigEndian.Uint32(part[16:20]))
				} else if len(part) >= 36 && part[0] == 1 {
					scale = binary.BigEndian.Uint32(part[20:24])
					ticks = binary.BigEndian.Uint64(part[24:32])
				} else {
					return errVoiceContainer
				}
				if scale == 0 {
					return errVoiceContainer
				}
				if ticks != 0 && ticks != math.MaxUint32 && ticks != math.MaxUint64 {
					duration = float64(ticks) * 1000 / float64(scale)
				}
			case "trex":
				if len(part) != 24 || trexTrack != 0 {
					return errVoiceContainer
				}
				trexTrack = binary.BigEndian.Uint32(part[4:8])
				trexDuration = binary.BigEndian.Uint32(part[12:16])
			case "tfhd":
				if fragment == nil || len(part) < 8 || fragment.track != 0 {
					return errVoiceContainer
				}
				fragment.track = binary.BigEndian.Uint32(part[4:8])
				flags := binary.BigEndian.Uint32(part[:4]) & 0xffffff
				offset := 8
				if flags&1 != 0 {
					offset += 8
				}
				if flags&2 != 0 {
					offset += 4
				}
				if flags&8 != 0 {
					if len(part) < offset+4 {
						return errVoiceContainer
					}
					fragment.defaultDuration = binary.BigEndian.Uint32(part[offset : offset+4])
					offset += 4
				}
				if flags&0x10 != 0 {
					offset += 4
				}
				if flags&0x20 != 0 {
					offset += 4
				}
				if len(part) != offset {
					return errVoiceContainer
				}
			case "tfdt":
				if fragment == nil || fragment.hasStart {
					return errVoiceContainer
				}
				if len(part) == 8 && part[0] == 0 {
					fragment.start = uint64(binary.BigEndian.Uint32(part[4:8]))
				} else if len(part) == 12 && part[0] == 1 {
					fragment.start = binary.BigEndian.Uint64(part[4:12])
				} else {
					return errVoiceContainer
				}
				fragment.hasStart = true
			case "trun":
				if fragment == nil || len(part) < 8 || part[0] > 1 {
					return errVoiceContainer
				}
				flags := binary.BigEndian.Uint32(part[:4]) & 0xffffff
				count := binary.BigEndian.Uint32(part[4:8])
				samples += uint64(count)
				if count == 0 || samples > 200000 {
					return errVoiceContainer
				}
				offset := 8
				if flags&1 != 0 {
					offset += 4
				}
				if flags&4 != 0 {
					offset += 4
				}
				width := 0
				for _, flag := range []uint32{0x100, 0x200, 0x400, 0x800} {
					if flags&flag != 0 {
						width += 4
					}
				}
				if offset > len(part) || uint64(offset)+uint64(count)*uint64(width) != uint64(len(part)) {
					return errVoiceContainer
				}
				run := mp4VoiceRun{count: count, explicit: flags&0x100 != 0}
				if run.explicit || flags&0x800 != 0 {
					for i := uint32(0); i < count; i++ {
						if run.explicit {
							ticks := binary.BigEndian.Uint32(part[offset+int(i)*width:])
							if ticks == 0 || run.ticks > math.MaxUint64-uint64(ticks) {
								return errVoiceContainer
							}
							run.ticks += uint64(ticks)
						}
						// AAC/Opus voice recordings do not reorder frames. Reject a
						// nonzero unsigned (v0) or signed (v1) composition offset,
						// which could otherwise hide a much longer presentation.
						if flags&0x800 != 0 && binary.BigEndian.Uint32(part[offset+int(i)*width+width-4:]) != 0 {
							return errVoiceContainer
						}
					}
				}
				fragment.runs = append(fragment.runs, run)
			}
		}
		return nil
	}
	if e := walk(data, 0, nil); e != nil {
		return 0, e
	}
	if headers != 1 || handlers != 1 || codecs != 1 || clockHeaders != 1 || media == 0 {
		return 0, errVoiceContainer
	}
	// Fragmented Safari recordings have mdhd duration zero. Their clock instead
	// comes from decode starts and sample durations; undeclared defaults fail shut.
	var next uint64
	for _, f := range fragments {
		if audioTrack == 0 || f.track != audioTrack || trexTrack != 0 && trexTrack != audioTrack {
			return 0, errVoiceContainer
		}
		start := next
		if f.hasStart {
			start = f.start
		}
		ticks := uint64(0)
		fallback := f.defaultDuration
		if fallback == 0 {
			fallback = trexDuration
		}
		for _, run := range f.runs {
			n := run.ticks
			if !run.explicit {
				if fallback == 0 {
					return 0, errVoiceContainer
				}
				n = uint64(run.count) * uint64(fallback)
			}
			if ticks > math.MaxUint64-n {
				return 0, errVoiceContainer
			}
			ticks += n
		}
		if start > math.MaxUint64-ticks {
			return 0, errVoiceContainer
		}
		next = start + ticks
		d := float64(next) * 1000 / float64(scale)
		if d > duration {
			duration = d
		}
	}
	if duration <= 0 {
		return 0, errVoiceContainer
	}
	return duration, nil
}
