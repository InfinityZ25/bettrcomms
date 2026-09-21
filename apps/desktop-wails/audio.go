package main

import (
	"errors"
	"math"
	"os"

	"bettercomms/desktop-wails/internal/native/audiostream"
	"bettercomms/desktop-wails/internal/native/deepfilter"
	"bettercomms/desktop-wails/internal/native/nvidiaaudio"
)

// AudioStreamStart creates one isolated DSP session for the existing binary
// Worker/AudioWorklet path. No PCM frames cross Wails' JSON binding channel.
func (s *NativeMediaService) AudioStreamStart(hostToken, engine string, intensity float32, vad bool, attenuationDB float32) (audiostream.Grant, error) {
	if err := s.authorise(hostToken); err != nil {
		return audiostream.Grant{}, err
	}
	if math.IsNaN(float64(intensity)) || math.IsInf(float64(intensity), 0) || intensity < 0 || intensity > 1 ||
		math.IsNaN(float64(attenuationDB)) || math.IsInf(float64(attenuationDB), 0) || attenuationDB < 0 || attenuationDB > 100 {
		return audiostream.Grant{}, errors.New("invalid native microphone processing settings")
	}
	var factory audiostream.Factory
	switch engine {
	case "nvidia":
		factory = func() (audiostream.Processor, int, error) {
			e := nvidiaaudio.NewEngine()
			samples, err := e.Start(intensity, vad)
			if err != nil {
				e.Close()
				return nil, 0, err
			}
			return e, int(samples), nil
		}
	case "deepfilter":
		factory = func() (audiostream.Processor, int, error) {
			e := deepfilter.NewEngine()
			if err := e.Load(attenuationDB); err != nil {
				e.Close()
				return nil, 0, err
			}
			return e, deepfilter.FrameSamples, nil
		}
	default:
		return audiostream.Grant{}, errors.New("unknown native microphone processor")
	}
	dev := os.Getenv("BETTERCOMMS_DEV_SERVER") != ""
	return s.streams.Start(factory, func(origin string) bool { return audioOriginAllowed(origin, dev) })
}

func (s *NativeMediaService) AudioStreamStop(hostToken, sessionID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	s.streams.Stop(sessionID)
	return nil
}

// Unlike an ordinary URL parser this accepts origins only, without paths,
// credentials, arbitrary ports or an opaque/null origin. The stream token is
// still required even for the exact allowed origin.
func audioOriginAllowed(origin string, development bool) bool {
	switch origin {
	case "http://wails.localhost", "https://wails.localhost", "wails://wails":
		return true
	case "http://localhost:5173", "http://127.0.0.1:5173":
		return development
	default:
		return false
	}
}
