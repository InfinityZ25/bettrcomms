package main

import (
	"bettercomms/desktop-wails/internal/desktop"
	"bettercomms/desktop-wails/internal/desktop/updates"
	"context"
	"errors"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// These public values are linked into a release build. Runtime environment and
// webview input cannot override the trust root or update endpoints.
var bakedUpdateFeed string
var bakedUpdatePublicKey string
var bakedUpdateDownloadHosts string
var bakedUpdateMacTeamID string

type DesktopUpdateStatus struct {
	Available      bool    `json:"available"`
	State          string  `json:"state"`
	CurrentVersion string  `json:"currentVersion"`
	Version        string  `json:"version"`
	Detail         string  `json:"detail"`
	Notes          string  `json:"notes"`
	Automatic      bool    `json:"automatic"`
	LastChecked    string  `json:"lastChecked"`
	Progress       float64 `json:"progress"`
}

type DesktopUpdateService struct {
	gate        *desktop.PageGate
	development bool
	updater     *updater.Updater
	provider    *updates.Provider
	window      *application.WebviewWindow
	operation   sync.Mutex
	mu          sync.Mutex
	status      DesktopUpdateStatus
	expires     time.Time
	digest      []byte
	cancel      context.CancelFunc
	busy        func() bool
	activities  map[string]time.Time
	stop        chan struct{}
	done        chan struct{}
	unsubscribe []func()
}

func newDesktopUpdateService(gate *desktop.PageGate, development bool, busy func() bool) *DesktopUpdateService {
	return &DesktopUpdateService{gate: gate, development: development, busy: busy, activities: map[string]time.Time{}, stop: make(chan struct{}), done: make(chan struct{}),
		status: DesktopUpdateStatus{State: "unavailable", CurrentVersion: strings.TrimSuffix(hostVersion, "-wails"), Detail: "Signed automatic updates are not configured for this build."}}
}

func (s *DesktopUpdateService) attach(app *application.App, window *application.WebviewWindow) {
	s.window = window
	if s.development {
		s.status.Detail = "Updates are disabled in development. Install a release build to update."
		close(s.done)
		return
	}
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		close(s.done)
		return
	}
	config, err := os.UserConfigDir()
	if err != nil {
		close(s.done)
		return
	}
	if runtime.GOOS == "darwin" && bakedUpdateMacTeamID == "" {
		s.status.Detail = "Updates require a build-time macOS signing Team ID."
		close(s.done)
		return
	}
	provider, err := updates.NewProvider(bakedUpdateFeed, bakedUpdatePublicKey, bakedUpdateDownloadHosts, filepath.Join(config, "BetterComms", "updates", "highest-version"))
	if err != nil {
		close(s.done)
		return
	}
	s.provider = provider
	s.updater = app.Updater
	if err := s.updater.Init(updater.Config{CurrentVersion: s.status.CurrentVersion, PublicKey: provider.PublicKey(), Providers: []updater.Provider{provider}, Window: updater.WindowNone}); err != nil {
		s.status.Detail = "Could not initialize verified updates."
		close(s.done)
		return
	}
	s.status.Available, s.status.State, s.status.Detail = true, "idle", "Checks require a signed release feed. Installing waits for you to choose Restart."
	s.status.Automatic = readAutomaticUpdates(config)
	s.unsubscribe = append(s.unsubscribe, app.Event.On(updater.EventDownloadProgress, func(event *application.CustomEvent) {
		progress, ok := event.Data.(updater.Progress)
		if ok && event.Sender == "" && progress.Total > 0 {
			s.mu.Lock()
			s.status.Progress = min(1, float64(progress.Written)/float64(progress.Total))
			s.mu.Unlock()
			s.emit()
		}
	}))
	go s.periodic()
}

func (s *DesktopUpdateService) emit() {
	if s.window != nil {
		s.mu.Lock()
		status := s.status
		s.mu.Unlock()
		s.window.EmitEvent("bc-desktop-updates", status)
	}
}
func (s *DesktopUpdateService) Status(pageToken string) (DesktopUpdateStatus, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return DesktopUpdateStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status, nil
}
func (s *DesktopUpdateService) Check(ctx context.Context, pageToken string) (DesktopUpdateStatus, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return DesktopUpdateStatus{}, err
	}
	if err := s.check(ctx); err != nil {
		return s.Status(pageToken)
	}
	return s.Status(pageToken)
}
func (s *DesktopUpdateService) check(ctx context.Context) error {
	if !s.operation.TryLock() {
		return errors.New("An update operation is already running")
	}
	defer s.operation.Unlock()
	if s.updater == nil {
		return errors.New("Verified updates are not configured")
	}
	// A periodic/manual check must not discard a package waiting for Restart.
	s.mu.Lock()
	ready := s.status.State == "ready" && s.expires.After(time.Now())
	restarting := s.status.State == "restarting"
	s.mu.Unlock()
	if ready || restarting {
		return nil
	}
	s.mu.Lock()
	s.status.State, s.status.Detail, s.status.Progress = "checking", "Checking for a signed update…", 0
	s.mu.Unlock()
	s.emit()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	release, err := s.updater.Check(ctx)
	s.mu.Lock()
	s.status.LastChecked = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		s.status.State, s.status.Detail = "error", err.Error()
	} else if release == nil {
		s.status.State, s.status.Detail, s.status.Version, s.status.Notes = "up-to-date", "You have the latest verified version.", "", ""
	} else {
		s.status.State, s.status.Detail, s.status.Version, s.status.Notes = "available", "A verified update is available.", release.Version, release.Notes
		if raw, ok := release.Metadata["expiresAt"].(string); ok {
			s.expires, _ = time.Parse(time.RFC3339Nano, raw)
		}
		s.digest = append([]byte(nil), release.Verification.Digest...)
	}
	s.mu.Unlock()
	s.emit()
	return err
}
func (s *DesktopUpdateService) Download(ctx context.Context, pageToken string) (DesktopUpdateStatus, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return DesktopUpdateStatus{}, err
	}
	if !s.operation.TryLock() {
		return DesktopUpdateStatus{}, errors.New("An update operation is already running")
	}
	defer s.operation.Unlock()
	if s.updater == nil {
		return DesktopUpdateStatus{}, errors.New("Verified updates are not configured")
	}
	s.mu.Lock()
	expires := s.expires
	available := s.status.State == "available"
	s.mu.Unlock()
	if !available {
		return DesktopUpdateStatus{}, errors.New("Check for an available update first")
	}
	if !expires.After(time.Now()) {
		return DesktopUpdateStatus{}, errors.New("Check for updates again; the release metadata expired")
	}
	s.mu.Lock()
	s.status.State, s.status.Detail = "downloading", "Downloading and verifying the update…"
	s.mu.Unlock()
	s.emit()
	ctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = cancel
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); s.cancel = nil; s.mu.Unlock() }()
	err := s.updater.DownloadAndInstall(ctx)
	if err == nil && runtime.GOOS == "windows" {
		err = updates.VerifyDigest(s.updater.DownloadedPath(), s.digest)
	}
	if err == nil {
		err = updates.VerifyPlatformSignature(s.updater.DownloadedPath(), bakedUpdateMacTeamID)
	}
	s.mu.Lock()
	if err != nil {
		s.status.State, s.status.Detail = "error", err.Error()
	} else {
		s.status.State, s.status.Detail = "ready", "Verified update downloaded. Leave calls and finish recordings/exports before restarting."
	}
	s.mu.Unlock()
	s.emit()
	return s.Status(pageToken)
}
func (s *DesktopUpdateService) Restart(ctx context.Context, pageToken string) error {
	if err := s.gate.Authorise(pageToken); err != nil {
		return err
	}
	if !s.operation.TryLock() {
		return errors.New("An update operation is already running")
	}
	locked := true
	defer func() {
		if locked {
			s.operation.Unlock()
		}
	}()
	if s.updater == nil {
		return errors.New("Verified updates are not configured")
	}
	s.mu.Lock()
	ready := s.status.State == "ready" && s.expires.After(time.Now())
	active := false
	for _, expiry := range s.activities {
		active = active || expiry.After(time.Now())
	}
	s.mu.Unlock()
	if !ready {
		return errors.New("Download a current verified update first")
	}
	if active || s.busy != nil && s.busy() {
		return errors.New("Leave the call and finish capture, recording and exports before restarting")
	}
	if runtime.GOOS == "windows" {
		if err := updates.VerifyDigest(s.updater.DownloadedPath(), s.digest); err != nil {
			return err
		}
	}
	if err := updates.VerifyPlatformSignature(s.updater.DownloadedPath(), bakedUpdateMacTeamID); err != nil {
		return err
	}
	// Wails Quit runs service shutdown synchronously on Windows. Release the
	// operation mutex before Quit so shutdown can wait for operations safely.
	s.mu.Lock()
	s.status.State, s.status.Detail = "restarting", "Restarting to install the verified update…"
	s.mu.Unlock()
	s.operation.Unlock()
	locked = false
	if err := s.updater.Restart(ctx); err != nil {
		s.mu.Lock()
		s.status.State, s.status.Detail = "ready", err.Error()
		s.mu.Unlock()
		s.emit()
		return err
	}
	return nil
}

func (s *DesktopUpdateService) Activity(pageToken, id string, active bool) error {
	if err := s.gate.Authorise(pageToken); err != nil {
		return err
	}
	if len(id) != 36 || strings.ContainsAny(id, "/\\") {
		return errors.New("Invalid activity lease")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, expiry := range s.activities {
		if !expiry.After(time.Now()) {
			delete(s.activities, token)
		}
	}
	if !active {
		delete(s.activities, id)
		return nil
	}
	if len(s.activities) >= 4 {
		if _, exists := s.activities[id]; !exists {
			return errors.New("Too many activity leases")
		}
	}
	s.activities[id] = time.Now().Add(10 * time.Second)
	return nil
}
func (s *DesktopUpdateService) SetAutomatic(pageToken string, enabled bool) (DesktopUpdateStatus, error) {
	if err := s.gate.Authorise(pageToken); err != nil {
		return DesktopUpdateStatus{}, err
	}
	if s.updater == nil {
		return DesktopUpdateStatus{}, errors.New("Verified updates are not configured")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return DesktopUpdateStatus{}, err
	}
	if err := saveAutomaticUpdates(config, enabled); err != nil {
		return DesktopUpdateStatus{}, err
	}
	s.mu.Lock()
	s.status.Automatic = enabled
	s.mu.Unlock()
	s.emit()
	return s.Status(pageToken)
}
func (s *DesktopUpdateService) periodic() {
	defer close(s.done)
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-s.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	for {
		select {
		case <-s.stop:
			return
		case <-timer.C:
			s.mu.Lock()
			automatic := s.status.Automatic
			s.mu.Unlock()
			if automatic {
				_ = s.check(ctx)
			}
			timer.Reset(6 * time.Hour)
		}
	}
}
func (s *DesktopUpdateService) ServiceShutdown() error {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	close(s.stop)
	<-s.done
	s.operation.Lock()
	defer s.operation.Unlock()
	for _, unsubscribe := range s.unsubscribe {
		unsubscribe()
	}
	return nil
}

func (s *DesktopUpdateService) Cancel(pageToken string) error {
	if err := s.gate.Authorise(pageToken); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	return nil
}
