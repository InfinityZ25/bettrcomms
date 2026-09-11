package desktop

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

// A live check against a running API, so the cookie jar is exercised end to end
// rather than against a stub. Set BETTERCOMMS_LIVE_API to the origin to run it.
func TestLiveSessionSurvivesTheProxyJar(t *testing.T) {
	origin := os.Getenv("BETTERCOMMS_LIVE_API")
	if origin == "" {
		t.Skip("set BETTERCOMMS_LIVE_API to a running API origin")
	}

	proxy, err := NewAPIProxy(origin)
	if err != nil {
		t.Fatalf("NewAPIProxy: %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close() })

	ctx := context.Background()

	status, payload, err := proxy.Call(ctx, http.MethodGet, "/api/v1/me", nil)
	t.Logf("before sign-in: /me -> %d %s", status, payload)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}

	status, payload, err = proxy.Call(ctx, http.MethodPost, "/api/v1/auth/dev", map[string]string{
		"email": "probe@example.test", "name": "Probe",
	})
	if err != nil {
		t.Fatalf("dev sign-in: %v", err)
	}
	t.Logf("sign-in: -> %d", status)
	if status != http.StatusOK {
		t.Fatalf("dev sign-in returned %d: %s", status, payload)
	}

	status, payload, err = proxy.Call(ctx, http.MethodGet, "/api/v1/me", nil)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	t.Logf("after sign-in: /me -> %d", status)
	if status != http.StatusOK {
		t.Fatalf("the session did not survive the jar: /me returned %d: %s", status, payload)
	}

	var body struct {
		User struct{ Email string } `json:"user"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	t.Logf("signed in as %s", body.User.Email)
}
