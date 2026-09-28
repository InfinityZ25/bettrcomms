package main

import (
	"bettercomms/desktop-wails/internal/desktop"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// MetaCameraService exposes the iOS-only glasses camera. The native SDK owns
// pairing and frames; the page may only start it with this host's page token.
type MetaCameraService struct {
	gate *desktop.PageGate
}

func (s *MetaCameraService) MetaConnect(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return metaCameraConnect()
}

func (s *MetaCameraService) MetaStart(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return metaCameraStart()
}

func (s *MetaCameraService) MetaStop(hostToken string) error {
	if err := s.gate.Authorise(hostToken); err != nil {
		return err
	}
	return metaCameraStop()
}

func (s *MetaCameraService) ServiceShutdown() error {
	return metaCameraStop()
}

func metaCameraService(gate *desktop.PageGate) application.Service {
	return application.NewService(&MetaCameraService{gate: gate})
}
