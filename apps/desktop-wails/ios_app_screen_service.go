package main

import "bettercomms/desktop-wails/internal/desktop"

// IOSAppScreenService captures the foreground BetterComms display. ReplayKit
// whole-device broadcasting needs a separate extension and transport.
type IOSAppScreenService struct {
	gate *desktop.PageGate
}

func (s *IOSAppScreenService) ScreenStart(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return iosAppScreenStart()
}

func (s *IOSAppScreenService) ScreenStop(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return iosAppScreenStop()
}

func (s *IOSAppScreenService) ServiceShutdown() error {
	return iosAppScreenStop()
}
