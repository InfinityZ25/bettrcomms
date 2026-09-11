package desktop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func testBoot() BootReport {
	return BootReport{
		SchemaVersion:  1,
		Runtime:        "wails",
		HostVersion:    "0.0.1-wails",
		WindowControls: DefaultWindowControls(),
		Capabilities:   NewMediaCapabilities(),
	}
}

var bootScript = regexp.MustCompile(`window\.__BETTERCOMMS_DESKTOP__=JSON\.parse\((".*")\);`)

// parseInjected recovers the report from the injected script, which is also a
// check that the injected text is valid JSON inside a valid JavaScript string.
func parseInjected(t *testing.T, html string) BootReport {
	t.Helper()
	match := bootScript.FindStringSubmatch(html)
	if match == nil {
		t.Fatalf("no boot script in %q", html)
	}
	var inner string
	if err := json.Unmarshal([]byte(match[1]), &inner); err != nil {
		t.Fatalf("boot literal is not a JSON string: %v", err)
	}
	var report BootReport
	if err := json.Unmarshal([]byte(inner), &report); err != nil {
		t.Fatalf("boot payload is not a JSON object: %v", err)
	}
	return report
}

func TestInjectBootReportAfterHead(t *testing.T) {
	html := []byte("<!doctype html><html><head><title>t</title></head><body></body></html>")
	out, err := InjectBootReport(html, testBoot())
	if err != nil {
		t.Fatalf("inject: %v", err)
	}

	text := string(out)
	head := strings.Index(text, "<head>")
	script := strings.Index(text, "window."+bootGlobal)
	title := strings.Index(text, "<title>")
	if script < head || script > title {
		// The global has to exist before any bundle runs, so it goes first.
		t.Fatalf("script at %d is not between <head> at %d and <title> at %d", script, head, title)
	}
	if got := parseInjected(t, text); got.Runtime != "wails" {
		t.Errorf("runtime = %q, want wails", got.Runtime)
	}
}

func TestInjectBootReportEscapesScriptTerminator(t *testing.T) {
	report := testBoot()
	// A hostile value reaching the report must not be able to close the script
	// element and start executing.
	report.APIOriginError = `</script><img src=x onerror="alert(1)">`

	out, err := InjectBootReport([]byte("<html><head></head></html>"), report)
	if err != nil {
		t.Fatalf("inject: %v", err)
	}

	text := string(out)
	if strings.Count(strings.ToLower(text), "</script>") != 1 {
		t.Fatalf("the payload introduced an extra </script>: %q", text)
	}
	// The payload's text survives as data, but none of it can open a tag.
	if strings.Contains(text, "<img") {
		t.Fatalf("raw markup survived injection: %q", text)
	}
	if got := parseInjected(t, text).APIOriginError; got != report.APIOriginError {
		t.Errorf("round trip = %q, want %q", got, report.APIOriginError)
	}
}

func TestInjectBootReportWithoutHead(t *testing.T) {
	out, err := InjectBootReport([]byte("<p>no head</p>"), testBoot())
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	if !strings.HasPrefix(string(out), "<script>") {
		t.Errorf("expected a leading script, got %q", out)
	}
}

func newTestAssets(t *testing.T) http.Handler {
	t.Helper()
	dist := fstest.MapFS{
		"index.html":       {Data: []byte("<html><head></head><body>app</body></html>")},
		"assets/app.js":    {Data: []byte("console.log('app')")},
		"voicePlayback.js": {Data: []byte("// worklet")},
	}
	handler, err := NewAssetHandler(AssetOptions{Dist: dist, Boot: testBoot})
	if err != nil {
		t.Fatalf("NewAssetHandler: %v", err)
	}
	return handler
}

func TestAssetHandlerInjectsIntoHTMLOnly(t *testing.T) {
	handler := newTestAssets(t)

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if page.Code != http.StatusOK {
		t.Fatalf("index status = %d", page.Code)
	}
	if !strings.Contains(page.Body.String(), bootGlobal) {
		t.Error("index.html was served without the boot report")
	}

	script := httptest.NewRecorder()
	handler.ServeHTTP(script, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if body := script.Body.String(); body != "console.log('app')" {
		t.Errorf("JavaScript was rewritten: %q", body)
	}
}

func TestAssetHandlerFallsBackToIndexForRoutes(t *testing.T) {
	handler := newTestAssets(t)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/rooms/42", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want the SPA document", w.Code)
	}
	if !strings.Contains(w.Body.String(), "app") {
		t.Errorf("body = %q, want index.html", w.Body.String())
	}
}

// A packaged host has no API. Answering "/api" with the SPA document would make
// the client parse HTML as JSON and report a confusing failure.
func TestPackagedAssetHandlerRefusesAPIPathsLoudly(t *testing.T) {
	handler := newTestAssets(t)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/rooms", nil))

	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", w.Code)
	}
	// The client's way out is the loopback proxy, so name it.
	if !strings.Contains(w.Body.String(), "apiBase") {
		t.Errorf("body = %q, want the reason", w.Body.String())
	}
}

// Development proxies everything, so the Vite proxy keeps serving /api and its
// WebSocket upgrade.
func TestDevAssetHandlerLeavesAPIPathsToTheProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"rooms":[]}`))
	}))
	defer upstream.Close()

	handler, err := NewAssetHandler(AssetOptions{DevServer: upstream.URL, Boot: testBoot})
	if err != nil {
		t.Fatalf("NewAssetHandler: %v", err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/rooms", nil))

	if w.Code != http.StatusOK || w.Body.String() != `{"rooms":[]}` {
		t.Errorf("status %d body %q, want the proxied response", w.Code, w.Body.String())
	}
}

func TestAssetHandlerRequiresAssetsWhenNotProxying(t *testing.T) {
	if _, err := NewAssetHandler(AssetOptions{Boot: testBoot}); err == nil {
		t.Error("a host with neither a dist directory nor a dev server must fail loudly")
	}
}

func TestAssetHandlerProxiesDevServerAndInjects(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><head></head><body>vite</body></html>"))
	}))
	defer upstream.Close()

	handler, err := NewAssetHandler(AssetOptions{DevServer: upstream.URL, Boot: testBoot})
	if err != nil {
		t.Fatalf("NewAssetHandler: %v", err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "vite") {
		t.Errorf("dev server body was lost: %q", body)
	}
	if got := parseInjected(t, body); got.Runtime != "wails" {
		t.Errorf("runtime = %q, want wails", got.Runtime)
	}
}
