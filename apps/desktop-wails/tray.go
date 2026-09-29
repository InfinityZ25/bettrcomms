package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"

	"bettercomms/desktop-wails/internal/desktop"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// TrayService owns a device-wide opt-in preference. Hiding preserves the
// webview and its notification socket; Quit closes the process explicitly.
type TrayService struct {
	gate    *desktop.PageGate
	path    string
	enabled atomic.Bool
}

func newTrayService(gate *desktop.PageGate) *TrayService {
	service := &TrayService{gate: gate}
	if config, err := os.UserConfigDir(); err == nil {
		service.path = filepath.Join(config, "BetterComms", "tray.json")
		var saved struct {
			Enabled bool `json:"enabled"`
		}
		if bytes, err := os.ReadFile(service.path); err == nil && json.Unmarshal(bytes, &saved) == nil {
			service.enabled.Store(saved.Enabled)
		}
	}
	return service
}

func (s *TrayService) Enabled(pageToken string) (bool, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return false, err
	}
	return s.enabled.Load(), nil
}

func (s *TrayService) SetEnabled(pageToken string, enabled bool) error {
	if err := s.gate.Authorise(pageToken); err != nil {
		return err
	}
	if s.path == "" {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	bytes, err := json.Marshal(struct {
		Enabled bool `json:"enabled"`
	}{enabled})
	if err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, bytes, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	s.enabled.Store(enabled)
	return nil
}

func (s *TrayService) attach(app *application.App, window *application.WebviewWindow) {
	tray := app.SystemTray.New()
	tray.SetIcon(appIcon)
	tray.SetTooltip("BetterComms")
	tray.OnClick(func() { window.Show().Focus() })
	menu := app.NewMenu()
	menu.Add("Open BetterComms").OnClick(func(_ *application.Context) { window.Show().Focus() })
	menu.AddSeparator()
	var quitting atomic.Bool
	menu.Add("Quit BetterComms").OnClick(func(_ *application.Context) { quitting.Store(true); app.Quit() })
	tray.SetMenu(menu)
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if s.enabled.Load() && !quitting.Load() {
			event.Cancel()
			window.Hide()
		}
	})
}
