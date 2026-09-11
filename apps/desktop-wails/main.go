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
	"context"
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

	apiProxy := startAPIProxy(apiOrigin)
	if apiProxy != nil {
		defer func() { _ = apiProxy.Close() }()
	}

	// The ported native media stack. A failure here is reported rather than
	// fatal: the window still opens, and the capability report says what is
	// missing instead of the page discovering it at share time.
	media, mediaErr := NewNativeMediaService()
	if mediaErr != nil {
		log.Printf("native media unavailable: %v", mediaErr)
	}

	// Native calls prove they came from a document this host served by
	// presenting this launch's page token. It replaces the Tauri host's
	// per-call origin check, which cannot be made here: Wails exposes no way to
	// read the window's current URL. See internal/desktop/pagegate.go.
	gate, gateErr := desktop.NewPageGate()
	if gateErr != nil {
		// Without a gate every native call is refused, which is the safe
		// reading of "this host cannot tell its own page from anything else".
		log.Printf("desktop page gate unavailable: %v", gateErr)
	}

	// Sign-in leaves this window for the system browser and comes back as a
	// session in this process's jar. See internal/desktop/browsersignin.go.
	signIn := desktop.NewBrowserSignIn(apiProxy)
	defer signIn.Cancel()

	holder := &WindowService{}
	boot := func() desktop.BootReport {
		report := desktop.BootReport{
			SchemaVersion:  1,
			Runtime:        "wails",
			HostVersion:    hostVersion,
			Platform:       runtime.GOOS,
			Architecture:   runtime.GOARCH,
			APIOrigin:      apiOrigin,
			APIBase:        apiProxy.Base(),
			APIToken:       apiProxy.Token(),
			PageToken:      gate.Token(),
			WindowControls: desktop.DefaultWindowControls(),
			Capabilities:   desktop.NewMediaCapabilities(),
			AuthReturn:     authReturn(apiProxy),
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
		Services: services(holder, &AuthService{signIn: signIn}, media),
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
		// The window is allowed the microphone and camera outright rather than
		// prompting for them. This is the end state the Tauri host reaches by
		// writing WebView2's per-origin permission through Profile4, which is
		// not reachable from Go here. It is sound only because this window has
		// one origin and keeps it: sign-in runs in the system browser, so the
		// webview never navigates to a page this application did not build.
		// Windows' own privacy settings still govern, and are where a refusal
		// actually comes from — see internal/desktop/mediapermissions.go.
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionMicrophone:    application.PermissionAllow,
			application.PermissionCamera:        application.PermissionAllow,
			application.PermissionGeolocation:   application.PermissionDeny,
			application.PermissionNotifications: application.PermissionDeny,
			application.PermissionClipboardRead: application.PermissionDeny,
		},
	})
	holder.window = window
	if media != nil {
		// The window is how push-to-talk reports focus and publishes snapshots;
		// the gate is how a native call proves it came from this host's page.
		media.attach(app, window, gate)
	}

	return app.Run()
}

// startAPIProxy brings up the loopback proxy in front of a validated origin,
// or nil when there is no origin to proxy.
//
// Every build gets one, development included. A packaged build has no choice:
// its page origin serves no API and the upstream session cookie is
// SameSite=Lax. Development could reach the API through the Vite proxy instead,
// but then the two builds would differ in exactly the place that is hardest to
// test — who holds the session — and browser sign-in, which needs a cookie jar
// in this process, would work only in the build nobody runs while developing.
//
// A failure is reported rather than fatal: the window still opens, and the boot
// report says why the application cannot reach its API.
func startAPIProxy(apiOrigin string) *desktop.APIProxy {
	if apiOrigin == "" {
		return nil
	}
	started, err := desktop.NewAPIProxy(apiOrigin)
	if err != nil {
		log.Printf("desktop API proxy unavailable: %v", err)
		return nil
	}
	return started
}

// authReturn describes how far sign-in gets on this host.
//
// The loopback proxy carries the session and keeps it out of the webview, the
// hosted WorkOS round trip runs in the system browser and is claimed back into
// this process, and the result is kept in the operating system's own credential
// store so it survives closing the application.
func authReturn(proxy *desktop.APIProxy) desktop.Capability {
	if proxy == nil {
		return desktop.Capability{
			State:  desktop.Unavailable,
			Detail: "This host has no API proxy, so there is nowhere to put a session it obtains. Sign-in works only where the frontend can reach the API origin from the page itself, which is what a development build does.",
		}
	}
	stored := "The session is not persisted on this platform, so it ends with the process."
	if proxy.PersistsSession() {
		stored = "The session is kept in the operating system's credential store, encrypted under this Windows account, so it survives closing the application and is erased on sign-out."
	}
	return desktop.Capability{
		State: desktop.Experimental,
		Detail: "Hosted WorkOS sign-in runs in the system browser and is claimed back over a verifier-bound pairing, so the session lands in this host's loopback proxy rather than in the webview. " +
			stored + " A real sign-in has completed against a live WorkOS deployment; no packaged build has been through it yet.",
	}
}

// services registers the window and sign-in surfaces and, when it came up, the
// native media surface. Media is omitted rather than registered broken, so a
// page that probes for it gets a clear absence instead of methods that always
// fail.
func services(holder *WindowService, auth *AuthService, media *NativeMediaService) []application.Service {
	registered := []application.Service{
		application.NewService(holder),
		application.NewService(auth),
	}
	if media != nil {
		registered = append(registered, application.NewService(media))
	}
	return registered
}

// AuthService is the window's view of the browser sign-in hand-off.
//
// It is three methods on purpose. The window starts a sign-in, shows the code
// the browser will display, and polls until the host has a session; it never
// sees the verifier, the pairing, or the session cookie, all of which stay in
// this process.
type AuthService struct {
	signIn *desktop.BrowserSignIn
}

// BrowserSignInBegin opens the system browser on the confirmation page and
// starts waiting. The returned status carries the code to display.
func (a *AuthService) BrowserSignInBegin(ctx context.Context) (desktop.SignInStatus, error) {
	return a.signIn.Begin(ctx)
}

// BrowserSignInStatus is how far the sign-in has got. The window polls it while
// waiting, and reloads its session when it reports complete.
func (a *AuthService) BrowserSignInStatus() desktop.SignInStatus {
	return a.signIn.Status()
}

// BrowserSignInCancel stops waiting for a sign-in the person walked away from.
func (a *AuthService) BrowserSignInCancel() {
	a.signIn.Cancel()
}

// ServiceShutdown stops any sign-in still being polled, so no goroutine
// outlives the window.
func (a *AuthService) ServiceShutdown() error {
	a.signIn.Cancel()
	return nil
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
