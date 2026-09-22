package desktop

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI stands in for the server, so the hand-off can be driven without a
// listener or a browser.
type fakeAPI struct {
	mu sync.Mutex

	upstream string
	// startStatus and startBody are what /desktop/start answers.
	startStatus int
	startBody   any
	// claims is the sequence of answers /desktop/claim gives, one per call. The
	// last one repeats.
	claims []claimAnswer
	// seen records what was actually sent.
	verifierHash string
	verifier     string
	pairingID    string
	claimCount   int
}

type claimAnswer struct {
	status int
	body   any
	err    error
}

func (f *fakeAPI) Upstream() string { return f.upstream }

func (f *fakeAPI) Call(_ context.Context, _, path string, body any) (int, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	fields, _ := body.(map[string]string)
	switch {
	case strings.HasSuffix(path, "/desktop/start"):
		f.verifierHash = fields["verifier_hash"]
		return f.startStatus, encode(f.startBody), nil
	case strings.HasSuffix(path, "/desktop/claim"):
		f.verifier, f.pairingID = fields["verifier"], fields["pairing_id"]
		f.claimCount++
		answer := f.claims[min(f.claimCount, len(f.claims))-1]
		return answer.status, encode(answer.body), answer.err
	}
	return http.StatusNotFound, nil, nil
}

func encode(body any) []byte {
	if body == nil {
		return nil
	}
	if raw, ok := body.([]byte); ok {
		return raw
	}
	out, _ := json.Marshal(body)
	return out
}

func startedBody() map[string]any {
	return map[string]any{
		"pairing_id":   "pairing-1",
		"code":         "ACDE-2346",
		"confirm_path": "/api/v1/auth/desktop/confirm?pairing=pairing-1",
		"expires_in":   600,
	}
}

// newTestSignIn wires a hand-off to a fake API and records the URL it opens.
func newTestSignIn(t *testing.T, api *fakeAPI) (*BrowserSignIn, func() string) {
	t.Helper()
	var mu sync.Mutex
	var opened string

	signIn := NewBrowserSignIn(nil)
	signIn.api = api
	signIn.poll = 5 * time.Millisecond
	signIn.logf = t.Logf
	signIn.open = func(target string) error {
		mu.Lock()
		defer mu.Unlock()
		opened = target
		return nil
	}
	t.Cleanup(signIn.Cancel)

	return signIn, func() string {
		mu.Lock()
		defer mu.Unlock()
		return opened
	}
}

func waitForState(t *testing.T, signIn *BrowserSignIn, want SignInState) SignInStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if status := signIn.Status(); status.State == want {
			return status
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the sign-in stayed in %q, want %q", signIn.Status().State, want)
	return SignInStatus{}
}

// This is the acceptance test for the host half: the browser is sent to the
// confirmation page, the verifier stays here, and a completed claim leaves the
// hand-off signed in.
func TestSignInOpensTheBrowserAndWaitsForTheClaim(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusCreated,
		startBody:   startedBody(),
		claims: []claimAnswer{
			{status: http.StatusAccepted, body: map[string]any{"status": "pending"}},
			{status: http.StatusAccepted, body: map[string]any{"status": "pending"}},
			{status: http.StatusOK, body: map[string]any{"status": "complete"}},
		},
	}
	signIn, opened := newTestSignIn(t, api)

	pending, err := signIn.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if pending.State != SignInWaiting {
		t.Fatalf("Begin returned %q, want waiting", pending.State)
	}
	if pending.Code != "ACDE-2346" {
		t.Errorf("the window was given code %q", pending.Code)
	}
	if pending.ExpiresAt == 0 {
		t.Error("the window was not told when the attempt expires")
	}

	want := "https://api.example.test/api/v1/auth/desktop/confirm?pairing=pairing-1"
	if opened() != want {
		t.Errorf("the browser was sent to %q, want %q", opened(), want)
	}
	if pending.ConfirmURL != want {
		t.Errorf("the status carries %q as the confirmation address", pending.ConfirmURL)
	}

	complete := waitForState(t, signIn, SignInComplete)
	if complete.Detail == "" {
		t.Error("the completed sign-in carries no explanation")
	}

	api.mu.Lock()
	defer api.mu.Unlock()
	if api.claimCount < 3 {
		t.Errorf("the hand-off claimed %d times, want it to have waited through the pending answers", api.claimCount)
	}
	if api.pairingID != "pairing-1" {
		t.Errorf("claimed pairing %q", api.pairingID)
	}
	// Only the digest may be sent when the pairing opens.
	digest := sha256.Sum256([]byte(api.verifier))
	if api.verifierHash != base64.RawURLEncoding.EncodeToString(digest[:]) {
		t.Error("the hash sent to open the pairing is not the hash of the verifier used to claim it")
	}
	if api.verifier == "" || len(api.verifier) < 32 {
		t.Errorf("the verifier is %d characters", len(api.verifier))
	}
}

// The server may ask to be polled less often, but not more.
func TestTheClaimIntervalHonoursTheSlowerOfTheTwo(t *testing.T) {
	if got := claimInterval(5, time.Second); got != 5*time.Second {
		t.Errorf("a server asking for 5s got %v", got)
	}
	if got := claimInterval(0, time.Second); got != time.Second {
		t.Errorf("a server suggesting nothing got %v, want this host's floor", got)
	}
	if got := claimInterval(-4, time.Second); got != time.Second {
		t.Errorf("a negative suggestion got %v", got)
	}
}

// A refused claim is terminal and must say why, in the API's own words.
func TestARefusedClaimReportsTheAPIsReason(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusCreated,
		startBody:   startedBody(),
		claims: []claimAnswer{{
			status: http.StatusNotFound,
			body: map[string]any{"error": map[string]string{
				"code": "pairing_not_found", "message": "this desktop sign-in has expired or was already completed",
			}},
		}},
	}
	signIn, _ := newTestSignIn(t, api)

	if _, err := signIn.Begin(context.Background()); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	failed := waitForState(t, signIn, SignInFailed)
	if !strings.Contains(failed.Detail, "already completed") {
		t.Errorf("the failure says %q, not what the API said", failed.Detail)
	}
}

// A dropped connection while the person is signing in is not the end of the
// attempt: the pairing is still live on the server.
func TestATransportFailureDoesNotEndTheAttempt(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusCreated,
		startBody:   startedBody(),
		claims: []claimAnswer{
			{err: errors.New("connection reset")},
			{err: errors.New("connection reset")},
			{status: http.StatusOK, body: map[string]any{"status": "complete"}},
		},
	}
	signIn, _ := newTestSignIn(t, api)

	if _, err := signIn.Begin(context.Background()); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	waitForState(t, signIn, SignInComplete)
}

// Cancelling must stop the polling, not merely change what Status says.
func TestCancellingStopsClaiming(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusCreated,
		startBody:   startedBody(),
		claims:      []claimAnswer{{status: http.StatusAccepted, body: map[string]any{"status": "pending"}}},
	}
	signIn, _ := newTestSignIn(t, api)

	if _, err := signIn.Begin(context.Background()); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	waitForState(t, signIn, SignInWaiting)
	signIn.Cancel()

	if state := signIn.Status().State; state != SignInIdle {
		t.Errorf("a cancelled sign-in is %q, want idle", state)
	}

	api.mu.Lock()
	before := api.claimCount
	api.mu.Unlock()
	time.Sleep(60 * time.Millisecond)
	api.mu.Lock()
	after := api.claimCount
	api.mu.Unlock()
	if after != before {
		t.Errorf("the hand-off kept claiming after it was cancelled (%d then %d)", before, after)
	}
}

// A build with no proxy has no jar to put a session in, so it must say so
// rather than opening a browser that leads nowhere.
func TestAHostWithNoProxyRefusesToStart(t *testing.T) {
	signIn := NewBrowserSignIn(nil)
	if _, err := signIn.Begin(context.Background()); err == nil {
		t.Error("a host with no API proxy began a browser sign-in")
	}
	if state := signIn.Status().State; state != SignInIdle {
		t.Errorf("status is %q, want idle", state)
	}
}

// The address handed to the operating system is built from the origin this host
// validated, never from whatever the API put in the response.
func TestTheConfirmationAddressCannotBeRedirectedByTheAPI(t *testing.T) {
	for _, test := range []struct{ name, path string }{
		{"an absolute URL", "https://evil.example/steal"},
		{"a scheme-relative URL", "//evil.example/steal"},
		{"a relative path", "api/v1/auth/desktop/confirm"},
		{"an empty path", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := confirmURL("https://api.example.test", test.path); err == nil {
				t.Errorf("%q was accepted", test.path)
			}
		})
	}

	got, err := confirmURL("https://api.example.test", "/api/v1/auth/desktop/confirm?pairing=x")
	if err != nil {
		t.Fatalf("a same-origin path was rejected: %v", err)
	}
	if got != "https://api.example.test/api/v1/auth/desktop/confirm?pairing=x" {
		t.Errorf("built %q", got)
	}
}

// A browser that will not open must not strand the attempt: the pairing is
// live, and the person can open the address themselves.
func TestAnUnopenableBrowserStillLeavesTheAttemptClaimable(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusCreated,
		startBody:   startedBody(),
		claims:      []claimAnswer{{status: http.StatusOK, body: map[string]any{"status": "complete"}}},
	}
	signIn, _ := newTestSignIn(t, api)
	signIn.open = func(string) error { return errors.New("no browser is registered") }

	pending, err := signIn.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if pending.State != SignInWaiting {
		t.Fatalf("Begin returned %q", pending.State)
	}
	if !strings.Contains(pending.Detail, "https://api.example.test") {
		t.Errorf("the window was not given the address to open: %q", pending.Detail)
	}
	waitForState(t, signIn, SignInComplete)
}

// An API that refuses to open a pairing must surface its reason, and nothing
// should be opened.
func TestARefusedStartOpensNoBrowser(t *testing.T) {
	api := &fakeAPI{
		upstream:    "https://api.example.test",
		startStatus: http.StatusServiceUnavailable,
		startBody: map[string]any{"error": map[string]string{
			"code": "auth_not_configured", "message": "WorkOS authentication is not configured",
		}},
	}
	signIn, opened := newTestSignIn(t, api)

	_, err := signIn.Begin(context.Background())
	if err == nil {
		t.Fatal("a refused start was reported as success")
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Errorf("the error says %q, not what the API said", err)
	}
	if opened() != "" {
		t.Errorf("a browser was opened at %q for a sign-in that never started", opened())
	}
}

// Whatever went wrong has to reach the person in words they can act on. Two
// shapes arrive here: the API's nested error, and the loopback proxy's flat one
// when it could not reach the API at all. Reading only the first is how a dead
// API became a sentence that named no cause.
func TestEveryErrorShapeReachesThePerson(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		payload string
		want    string
	}{
		{
			name:    "the API's own error",
			status:  503,
			payload: `{"error":{"code":"auth_not_configured","message":"WorkOS authentication is not configured"}}`,
			want:    "WorkOS authentication is not configured",
		},
		{
			name:    "the proxy failing to reach the API",
			status:  502,
			payload: `{"error":"the desktop host could not reach the API: connection refused"}`,
			want:    "the desktop host could not reach the API: connection refused",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := apiMessage(test.status, []byte(test.payload), "fallback"); got != test.want {
				t.Errorf("apiMessage = %q, want %q", got, test.want)
			}
		})
	}

	// A body this does not recognise still has to leave something to act on.
	for _, payload := range []string{"", "<html>502 Bad Gateway</html>", "{}", `{"error":{}}`} {
		got := apiMessage(502, []byte(payload), "the API refused")
		if !strings.Contains(got, "502") {
			t.Errorf("an unrecognised body gave %q, which names no status", got)
		}
	}
	if got := apiMessage(0, nil, "no transport"); got != "no transport" {
		t.Errorf("with no status the message is %q", got)
	}
}

// The most likely thing to go wrong is that the API is not running. Driving it
// through a real proxy rather than the fake is the point: this is the path that
// produced an unusable message.
func TestADeadAPIIsReportedAsSuch(t *testing.T) {
	// A server that has been closed leaves an address nothing is listening on.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := dead.URL
	dead.Close()

	proxy, err := NewAPIProxy(address)
	if err != nil {
		t.Fatalf("NewAPIProxy: %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close() })

	signIn := NewBrowserSignIn(proxy)
	t.Cleanup(signIn.Cancel)
	signIn.open = func(target string) error {
		t.Errorf("a browser was opened at %q for a sign-in that could not start", target)
		return nil
	}

	_, err = signIn.Begin(context.Background())
	if err == nil {
		t.Fatal("a sign-in started against an API that is not running")
	}
	if !strings.Contains(err.Error(), "could not reach the API") {
		t.Errorf("the error says %q, which does not name the cause", err)
	}
}
