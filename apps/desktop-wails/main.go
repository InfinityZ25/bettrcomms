// Command bettercomms-wails is the Wails v3 desktop host for BetterComms.
//
// It is deliberately thin. Its job is to open a native window over the shared
// apps/web frontend, serve that frontend, and expose a narrow Wails service
// for window controls. It
// contains no media code: see internal/desktop.NewMediaCapabilities for the
// list of native capabilities this host does not have, and docs/WAILS_MIGRATION.md
// for what the frontend does instead.
//
// The Tauri host in apps/desktop is unchanged and remains the only shell with
// native capture, native audio processing, and native recording.
package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"runtime"

	"bettercomms/desktop-wails/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// hostVersion tracks the Wails host separately from the Tauri host's version,
// so a report cannot imply Tauri's feature set.
const hostVersion = "0.0.1-wails"

// frontendAssets holds the staged copy of apps/web/dist. The build task copies
// it in; apps/web remains the single frontend source. The `all:` prefix keeps
// the checked-in .gitkeep matchable so this package compiles before a build.
//
//go:embed all:frontend/dist
var frontendAssets embed.FS

func main() {
	if err := run(); err != nil {
		log.Fatalf("bettercomms-wails: %v", err)
	}
}

func run() error {
	devServer := os.Getenv("BETTERCOMMS_DEV_SERVER")
	debug := devServer != ""

	apiOrigin, apiOriginErr := desktop.ResolveAPIOrigin(configuredAPIOrigin(debug), debug)
	if apiOriginErr != nil {
		// A bad origin is reported to the page rather than silently replaced,
		// so a misconfigured build fails visibly instead of talking to the
		// wrong host.
		log.Printf("desktop API origin unavailable: %v", apiOriginErr)
	}

	holder := &WindowService{}
	boot := func() desktop.BootReport {
		report := desktop.BootReport{
			SchemaVersion:  1,
			Runtime:        "wails",
			HostVersion:    hostVersion,
			Platform:       runtime.GOOS,
			Architecture:   runtime.GOARCH,
			APIOrigin:      apiOrigin,
			WindowControls: desktop.DefaultWindowControls(),
			Capabilities:   desktop.NewMediaCapabilities(),
			AuthReturn: desktop.Capability{
				State:  desktop.Unavailable,
				Detail: "The Wails host has no deep-link or loopback handoff, and no OS-protected storage. Sign-in works only where the frontend can reach the API origin from the page itself.",
			},
		}
		if apiOriginErr != nil {
			report.APIOriginError = apiOriginErr.Error()
		}
		return report
	}
	dist, err := fs.Sub(frontendAssets, "frontend/dist")
	if err != nil {
		return err
	}
	handler, err := desktop.NewAssetHandler(desktop.AssetOptions{
		Dist:      dist,
		DevServer: devServer,
		Boot:      boot,
	})
	if err != nil {
		return err
	}

	app := application.New(application.Options{
		Name:        "BetterComms",
		Description: "BetterComms desktop (Wails v3 host)",
		Assets: application.AssetOptions{
			Handler: handler,
		},
		Services: []application.Service{
			application.NewService(holder),
		},
		Windows: application.WindowsOptions{
			AdditionalBrowserArgs: []string{
				"--autoplay-policy=no-user-gesture-required",
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows",
			},
		},
	})

	controls := desktop.DefaultWindowControls()
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "BetterComms",
		Width:  1440,
		Height: 900,
		// The page draws its own title bar everywhere except macOS, matching
		// apps/web/src/features/shell/DesktopFrame.tsx.
		Frameless:        controls.Mode == "client-side",
		BackgroundColour: application.NewRGB(20, 20, 24),
		URL:              "/",
		// WebView2 owns caption dragging while Wails maps the frontend button
		// rectangles to HTMINBUTTON/HTMAXBUTTON/HTCLOSE. This preserves native
		// hit testing and Windows 11 Snap Layouts without better-gui.
		Windows: nativeWindowsWindowOptions(),
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionMicrophone:    application.PermissionDefault,
			application.PermissionCamera:        application.PermissionDefault,
			application.PermissionGeolocation:   application.PermissionDeny,
			application.PermissionNotifications: application.PermissionDeny,
			application.PermissionClipboardRead: application.PermissionDeny,
		},
	})
	holder.window = window

	return app.Run()
}

func nativeWindowsWindowOptions() application.WindowsWindow {
	return application.WindowsWindow{
		NonClientRegionSupport:     true,
		WebView2CompositionHosting: true,
	}
}

// configuredAPIOrigin returns the origin to validate. Development defaults to
// the loopback Go API; a release build defaults to the pinned hosted origin,
// the same one the Tauri host pins.
func configuredAPIOrigin(debug bool) string {
	if raw := os.Getenv("BETTERCOMMS_API_ORIGIN"); raw != "" {
		return raw
	}
	if debug {
		return "http://127.0.0.1:8080"
	}
	return desktop.ReleaseOrigin
}

// WindowService is the intentionally small Wails binding surface used by the
// shared title bar. It contains no media, filesystem, process, or auth APIs.
// Wails generates the matching TypeScript client into apps/web/src/desktop.
type WindowService struct {
	window *application.WebviewWindow
}

func (h *WindowService) Minimise() {
	if h.window != nil {
		h.window.Minimise()
	}
}

func (h *WindowService) ToggleMaximise() {
	if h.window == nil {
		return
	}
	if h.window.IsMaximised() {
		h.window.UnMaximise()
		return
	}
	h.window.Maximise()
}

func (h *WindowService) Close() {
	if h.window != nil {
		h.window.Close()
	}
}

func (h *WindowService) IsMaximised() bool {
	return h.window != nil && h.window.IsMaximised()
}

func (h *WindowService) IsFullscreen() bool {
	return h.window != nil && h.window.IsFullscreen()
}
