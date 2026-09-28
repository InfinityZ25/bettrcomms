package main

import "bettercomms/desktop-wails/internal/desktop"

// IOSCallAudioService manages the native audio session only while a call is
// active. The browser media graph remains responsible for actual audio tracks.
type IOSCallAudioService struct {
	gate *desktop.PageGate
}

func (s *IOSCallAudioService) CallAudioStart(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return iosCallAudioStart()
}

func (s *IOSCallAudioService) CallAudioStop(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return iosCallAudioStop()
}

func (s *IOSCallAudioService) ServiceShutdown() error {
	return iosCallAudioStop()
}
