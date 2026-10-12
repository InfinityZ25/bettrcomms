package desktop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeRuntimeGateRejectsUntrustedCallsBeforeDispatch(t *testing.T) {
	gate, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, method, path, proof, origin, site, destination, body string
		status                                                     int
	}{
		{"main SDK POST", "POST", "/wails/runtime", gate.Token(), "http://wails.localhost", "same-origin", "empty", `{"object":6,"method":2}`, 204},
		{"legacy SDK GET", "GET", "/wails/runtime?object=6&method=2", gate.Token(), "http://wails.localhost", "same-origin", "", "", 204},
		{"opaque native origin", "POST", "/wails/runtime", gate.Token(), "null", "", "", `{}`, 204},
		{"native absent origin", "POST", "/wails/runtime", gate.Token(), "", "", "", `{}`, 204},
		{"foreign frame Window.Close", "POST", "/wails/runtime", "", "https://player.bettrcomms.com", "cross-site", "empty", `{"object":6,"method":2}`, 403},
		{"foreign frame AuthService", "POST", "/wails/runtime", "", "https://player.bettrcomms.com", "", "", `{"object":0,"method":0,"args":{"methodName":"main.AuthService.BrowserSignInBegin","call-id":"foreign"}}`, 403},
		{"foreign frame copied proof", "POST", "/wails/runtime", gate.Token(), "https://player.bettrcomms.com", "", "", `{}`, 403},
		{"hosted app is not native asset origin", "POST", "/wails/runtime", gate.Token(), ReleaseOrigin, "", "", `{}`, 403},
		{"opaque origin without proof", "POST", "/wails/runtime", "", "null", "", "", `{}`, 403},
		{"absent origin without proof", "POST", "/wails/runtime", "", "", "", "", `{}`, 403},
		{"wrong proof", "POST", "/wails/runtime", "another-launch", "http://wails.localhost", "", "", `{}`, 403},
		{"cross-site with proof", "POST", "/wails/runtime", gate.Token(), "", "cross-site", "", `{}`, 403},
		{"navigation cannot dispatch", "GET", "/wails/runtime?object=6&method=2", gate.Token(), "", "none", "document", "", 403},
		{"image cannot dispatch", "GET", "/wails/runtime?object=6&method=2", gate.Token(), "", "", "image", "", 403},
		{"encoded alias", "POST", "/wails%2Fruntime", gate.Token(), "", "", "", `{}`, 403},
		{"trailing slash", "POST", "/wails/runtime/", gate.Token(), "", "", "", `{}`, 403},
		{"malformed origin", "POST", "/wails/runtime", gate.Token(), "http://wails.localhost/path", "", "", `{}`, 403},
		{"origin host mismatch", "POST", "/wails/runtime", gate.Token(), "https://wails.localhost:443", "", "", `{}`, 403},
		{"HEAD cannot dispatch", "HEAD", "/wails/runtime", gate.Token(), "", "", "", "", 405},
		{"OPTIONS cannot dispatch", "OPTIONS", "/wails/runtime", gate.Token(), "", "", "", "", 405},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			expectedURL, _ := url.Parse(tc.path)
			handler := NativeRuntimeMiddleware(gate, false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Method != tc.method || r.URL.RawQuery != expectedURL.RawQuery {
					t.Error("SDK method or query changed")
				}
				if r.Header.Get(nativeRuntimeProofHeader) != "" {
					t.Error("proof reached framework/bindings")
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != tc.body {
					t.Error("SDK body changed")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			r := httptest.NewRequest(tc.method, "http://wails.localhost"+tc.path, strings.NewReader(tc.body))
			if tc.proof != "" {
				r.Header.Set(nativeRuntimeProofHeader, tc.proof)
			}
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			r.Header.Set("Sec-Fetch-Dest", tc.destination)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status || called != (tc.status == 204) {
				t.Fatalf("status=%d dispatch=%v, want %d", w.Code, called, tc.status)
			}
			if strings.Contains(w.Body.String(), gate.Token()) {
				t.Fatal("error disclosed the launch proof")
			}
		})
	}
}

func TestNativeRuntimeGateLeavesOtherTransportsUntouched(t *testing.T) {
	for _, path := range []string{"/api/v1/me", "/api/v1/rooms/42/ws", "/wails/runtime.js", "/wails/transport.js", "/wails/stream/poll", "/assets/app.js"} {
		t.Run(path, func(t *testing.T) {
			called := false
			handler := NativeRuntimeMiddleware(nil, false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Header.Get("Authorization") != "Bearer unrelated-test-proof" {
					t.Error("unrelated authentication changed")
				}
				w.WriteHeader(204)
			}))
			r := httptest.NewRequest("GET", path, nil)
			r.Header.Set("Authorization", "Bearer unrelated-test-proof")
			r.Header.Set("Origin", "https://player.bettrcomms.com")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if !called || w.Code != 204 {
				t.Fatal("unrelated route was blocked")
			}
		})
	}
	blocked := NativeRuntimeMiddleware(nil, false)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("nil gate dispatched") }))
	w := httptest.NewRecorder()
	blocked.ServeHTTP(w, httptest.NewRequest("GET", "/wails/runtime?object=6&method=2", nil))
	if w.Code != 403 {
		t.Fatal("nil gate did not fail closed")
	}
}

func TestNativeRuntimeGateAcceptsOnlyExactNativeAssetAuthorities(t *testing.T) {
	gate, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, host, origin string
		development, allow bool
	}{
		{"Darwin/Linux asset origin", "localhost", "wails://localhost", false, true},
		{"Darwin/Linux opaque origin", "localhost", "null", false, true},
		{"Darwin/Linux absent origin", "localhost", "", false, true},
		{"legacy repository asset authority", "wails", "wails://wails", false, true},
		{"Windows virtual origin", "wails.localhost", "http://wails.localhost", false, true},
		{"Windows HTTPS virtual origin", "wails.localhost", "https://wails.localhost", false, true},
		{"development server", "localhost:5173", "http://localhost:5173", true, true},
		{"development server in release", "localhost:5173", "http://localhost:5173", false, false},
		{"foreign wails authority", "foreign", "wails://foreign", false, false},
		{"foreign authority with opaque origin", "foreign", "null", false, false},
		{"foreign authority with absent origin", "foreign", "", false, false},
		{"localhost lookalike", "localhost.example.com", "wails://localhost.example.com", false, false},
		{"localhost explicit port", "localhost:80", "wails://localhost:80", false, false},
		{"legacy alias explicit port", "wails:80", "wails://wails:80", false, false},
		{"foreign origin on native host", "localhost", "wails://foreign", false, false},
		{"foreign helper origin on native host", "localhost", "https://player.bettrcomms.com", false, false},
		{"native origin on other native host", "wails.localhost", "wails://localhost", false, false},
		{"native origin credentials", "localhost", "wails://user@localhost", false, false},
		{"native origin path", "localhost", "wails://localhost/", false, false},
		{"native origin query", "localhost", "wails://localhost?native=1", false, false},
		{"native origin fragment", "localhost", "wails://localhost#main", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			guard := NativeRuntimeMiddleware(gate, tc.development)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			r := httptest.NewRequest("POST", "http://"+tc.host+nativeRuntimePath, strings.NewReader(`{"object":6,"method":2}`))
			r.Header.Set(nativeRuntimeProofHeader, gate.Token())
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			w := httptest.NewRecorder()
			guard.ServeHTTP(w, r)
			if called != tc.allow || (tc.allow && w.Code != http.StatusNoContent) || (!tc.allow && w.Code != http.StatusForbidden) {
				t.Fatalf("status=%d dispatch=%v, want allowed=%v", w.Code, called, tc.allow)
			}
		})
	}
}

func TestNativeRuntimeGateRejectsAmbiguousHeadersAndPreviousLaunch(t *testing.T) {
	gate, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	previous, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	guard := NativeRuntimeMiddleware(gate, false)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("ambiguous or expired launch proof reached native dispatch")
	}))
	for _, name := range []string{"duplicate proof", "duplicate origin", "previous launch"} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://wails.localhost/wails/runtime", strings.NewReader(`{"object":6,"method":2}`))
			r.Header.Set(nativeRuntimeProofHeader, gate.Token())
			r.Header.Set("Origin", "http://wails.localhost")
			switch name {
			case "duplicate proof":
				r.Header.Add(nativeRuntimeProofHeader, "foreign")
			case "duplicate origin":
				r.Header.Add("Origin", "https://player.bettrcomms.com")
			case "previous launch":
				r.Header.Set(nativeRuntimeProofHeader, previous.Token())
			}
			w := httptest.NewRecorder()
			guard.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden {
				t.Fatalf("status=%d, want forbidden", w.Code)
			}
		})
	}
}

// Execute the actual installed SDK caller, not a duplicate of its request
// implementation. This checks ordinary, legacy, JSON binding and chunked RPCs
// against the gate while retaining native SDK semantics.
func TestNativeRuntimeProofWithInstalledSDK(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node is required to execute the installed frontend SDK")
	}
	sdk, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "node_modules", "@wailsio", "runtime", "dist"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(sdk, "runtime.js")); err != nil {
		t.Skip("Install npm workspaces to include the native SDK compatibility check")
	}
	fixture, err := os.ReadFile("runtime_fetch_test.mjs")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, pageOrigin, requestOrigin string
		development                     bool
	}{
		{"Windows virtual host", "http://wails.localhost", "http://wails.localhost", false},
		{"Darwin/Linux native authority", "wails://localhost", "wails://localhost", false},
		{"Darwin/Linux opaque request origin", "wails://localhost", "null", false},
		{"Darwin/Linux absent request origin", "wails://localhost", "", false},
		{"legacy repository native authority", "wails://wails", "wails://wails", false},
		{"development server", "http://localhost:5173", "http://localhost:5173", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gate, err := NewPageGate()
			if err != nil {
				t.Fatal(err)
			}
			var dispatches atomic.Int32
			guard := NativeRuntimeMiddleware(gate, tc.development)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				dispatches.Add(1)
				if r.Header.Get(nativeRuntimeProofHeader) != "" {
					t.Error("private proof was not stripped")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"accepted":true}`))
			}))
			page, _ := url.Parse(tc.pageOrigin)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// The asset adapter preserves the virtual request host while
				// clearing URL scheme/host. Replace only that native transport.
				r.Host = page.Host
				guard.ServeHTTP(w, r)
			}))
			defer server.Close()
			report := testBoot()
			report.PageToken = gate.Token()
			source, err := bootReportScript(report)
			if err != nil {
				t.Fatal(err)
			}
			input, _ := json.Marshal(map[string]string{
				"sdk": sdk, "server": server.URL, "source": string(source),
				"pageOrigin": tc.pageOrigin, "requestOrigin": tc.requestOrigin,
			})
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", string(fixture))
			cmd.Stdin = strings.NewReader(string(input))
			if output, err := cmd.CombinedOutput(); err != nil {
				// Node assertions intentionally never print the source/proof.
				t.Fatalf("native SDK fixture failed: %v\n%s", err, strings.ReplaceAll(string(output), gate.Token(), "[redacted proof]"))
			}
			// Window.Close, JSON binding, two large-call chunks, legacy GET.
			if got := dispatches.Load(); got != 5 {
				t.Fatalf("accepted RPCs=%d, want 5", got)
			}
		})
	}
}
