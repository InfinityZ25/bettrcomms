package main

import (
	"bettercomms/desktop-wails/internal/desktop"
	"bettercomms/desktop-wails/internal/desktop/startup"
)

type DesktopPreferencesService struct {
	gate        *desktop.PageGate
	development bool
}

func (s *DesktopPreferencesService) StartupStatus(pageToken string) (startup.Status, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return startup.Status{}, err
	}
	return startup.StatusFor(s.development)
}
func (s *DesktopPreferencesService) StartupSetEnabled(pageToken string, enabled bool) (startup.Status, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return startup.Status{}, err
	}
	return startup.SetEnabled(s.development, enabled)
}
