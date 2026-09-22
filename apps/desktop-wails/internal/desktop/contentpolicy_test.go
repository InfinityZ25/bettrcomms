package desktop

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestPackagedContentPolicyHashesTheActualBootScript(t *testing.T) {
	calls := 0
	handler, err := NewAssetHandler(AssetOptions{
		Dist: fstest.MapFS{"index.html": {Data: []byte("<html><head></head><body></body></html>")}},
		Boot: func() BootReport { calls++; report := testBoot(); report.PageToken = "test-only-token"; return report },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if calls != 1 {
		t.Fatalf("boot report read %d times; document and policy must match", calls)
	}
	body := response.Body.String()
	start := strings.Index(body, "<script>") + len("<script>")
	end := strings.Index(body, "</script>")
	if start < len("<script>") || end < start {
		t.Fatal("missing boot script")
	}
	digest := sha256.Sum256([]byte(body[start:end]))
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "'sha256-"+base64.StdEncoding.EncodeToString(digest[:])+"'") {
		t.Fatal("CSP does not authorise the actual boot script")
	}
	for _, required := range []string{"default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "worker-src 'self' blob:", "connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:*"} {
		if !strings.Contains(policy, required) {
			t.Errorf("missing restriction %s", required)
		}
	}
	for _, directive := range strings.Split(policy, ";") {
		if strings.HasPrefix(strings.TrimSpace(directive), "script-src ") {
			for _, forbidden := range []string{"'unsafe-inline'", "'unsafe-eval'", "https:", "http:"} {
				if strings.Contains(directive, forbidden) {
					t.Errorf("script policy permits %s", forbidden)
				}
			}
		}
	}
	for name, value := range map[string]string{"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"} {
		if response.Header().Get(name) != value {
			t.Errorf("%s missing", name)
		}
	}
}

func TestContentPolicyChangesWithBootDocumentAndKeepsDevRefresh(t *testing.T) {
	first := testBoot()
	second := first
	second.PageToken = "different-test-token"
	a, err := documentContentPolicy(first, false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := documentContentPolicy(second, false)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("boot script hash did not change with its contents")
	}
	dev, err := documentContentPolicy(first, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dev, "script-src") || strings.Contains(dev, "default-src") {
		t.Fatal("development policy must preserve Vite's refresh preamble")
	}
	if !strings.Contains(dev, "frame-src 'none'") || !strings.Contains(dev, "form-action 'none'") {
		t.Fatal("development lost document restrictions")
	}
}
