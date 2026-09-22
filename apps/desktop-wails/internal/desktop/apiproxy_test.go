package desktop

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// recordedRequest is what the upstream saw, captured for assertions.
type recordedRequest struct {
	path   string
	query  string
	origin string
	auth   string
	cookie string
}

// post issues a write to the proxy carrying the headers a browser actually
// attaches. A test that omits them cannot tell whether the application can save
// anything, which is the only question that matters about a write.
func post(t *testing.T, url string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	// What Chromium sends from a page on one origin to a listener on another.
	request.Header.Set("Origin", "http://wails.localhost")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	request.Header.Set("Sec-Fetch-Mode", "cors")
	request.Header.Set("Sec-Fetch-Dest", "empty")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("request %s: %v", url, err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

// newUpstream returns a stub API and a pointer to the last request it received.
func newUpstream(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *recordedRequest) {
	t.Helper()
	last := &recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*last = recordedRequest{
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			origin: r.Header.Get("Origin"),
			auth:   r.Header.Get("Authorization"),
			cookie: r.Header.Get("Cookie"),
		}
		if handler != nil {
			handler(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server, last
}

func newProxy(t *testing.T, upstream string) *APIProxy {
	t.Helper()
	proxy, err := NewAPIProxy(upstream)
	if err != nil {
		t.Fatalf("NewAPIProxy: %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close() })
	// These tests establish sessions. Persisting them would leave an entry in
	// the real credential manager of whoever ran the suite, keyed by an
	// ephemeral port that will never be used again.
	proxy.sessions = &SessionStore{target: "test/session", secrets: newMemorySecrets()}
	return proxy
}

// get issues a request to the proxy without following redirects, so a 3xx can
// be asserted rather than chased.
func get(t *testing.T, url string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("request %s: %v", url, err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

func TestProxyRejectsRequestsWithoutTheLaunchToken(t *testing.T) {
	upstream, last := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	for _, name := range []string{"no token", "wrong token"} {
		headers := map[string]string{}
		if name == "wrong token" {
			headers["Authorization"] = "Bearer not-the-token"
		}
		response := get(t, proxy.Base()+"/api/v1/me", headers)
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401", name, response.StatusCode)
		}
	}
	if last.path != "" {
		t.Errorf("an unauthorised request reached upstream at %q", last.path)
	}
}

func TestProxyForwardsAuthorisedRequestsAndStripsTheToken(t *testing.T) {
	upstream, last := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	response := get(t, proxy.Base()+"/api/v1/rooms?limit=5", map[string]string{
		"Authorization": "Bearer " + proxy.Token(),
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if last.path != "/api/v1/rooms" {
		t.Errorf("upstream path = %q, want /api/v1/rooms", last.path)
	}
	if last.query != "limit=5" {
		t.Errorf("upstream query = %q, want limit=5", last.query)
	}
	if last.auth != "" {
		t.Errorf("the launch token travelled upstream as %q", last.auth)
	}
	// This process is a native client, and carries no Origin. Upstream's
	// same-origin check on writes and its WebSocket accept both pass a request
	// that has none; claiming one instead would only be right where the API and
	// the application share a host, which a development server does not.
	if last.origin != "" {
		t.Errorf("the proxy claimed Origin %q; a native client sends none", last.origin)
	}
}

// The proxy must never advertise credential support.
//
// It accepts none: the page holds no cookies for this listener, and the bearer
// token is the authorisation. Answering Access-Control-Allow-Credentials would
// be a claim about a mode this proxy does not implement, and the frontend reads
// its absence as the instruction to send no cookies. Adding the header to make
// a credentialed request work would put the page back on a path where it
// believes cookies matter here.
func TestProxyAdvertisesNoCredentialSupport(t *testing.T) {
	upstream, _ := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	preflight, err := http.NewRequest(http.MethodOptions, proxy.Base()+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	preflight.Header.Set("Origin", "http://wails.localhost")
	preflight.Header.Set("Access-Control-Request-Method", "GET")
	preflight.Header.Set("Access-Control-Request-Headers", "authorization")

	response, err := http.DefaultClient.Do(preflight)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "http://wails.localhost" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	if got := response.Header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("the proxy advertised credential support as %q; it accepts none", got)
	}
}

// The browser's fetch metadata must not reach upstream.
//
// The page and this listener are different origins, so every request the page
// makes is marked cross-site. Upstream reads that as a statement about itself
// and refuses the write — which is every write the application performs.
func TestProxyStripsTheBrowsersFetchMetadata(t *testing.T) {
	var seen map[string]string
	upstream, _ := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		seen = map[string]string{}
		for _, header := range []string{"Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"} {
			seen[header] = r.Header.Get(header)
		}
		w.WriteHeader(http.StatusOK)
	})
	proxy := newProxy(t, upstream.URL)

	response := post(t, proxy.Base()+"/api/v1/rooms", map[string]string{
		"Authorization":  "Bearer " + proxy.Token(),
		"Referer":        "http://wails.localhost/rooms",
		"Sec-Fetch-User": "?1",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	for header, value := range seen {
		if value != "" {
			t.Errorf("upstream saw %s: %q", header, value)
		}
	}
}

// The page's own Origin must not reach upstream either. The page is a different
// origin from both the proxy and the API, and forwarding it would turn every
// write into a cross-site request upstream refuses.
func TestProxyDoesNotForwardThePagesOrigin(t *testing.T) {
	upstream, last := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	response := get(t, proxy.Base()+"/api/v1/rooms", map[string]string{
		"Authorization": "Bearer " + proxy.Token(),
		"Origin":        "http://wails.localhost",
		"Referer":       "http://wails.localhost/rooms/7",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if last.origin != "" {
		t.Errorf("upstream saw Origin %q", last.origin)
	}
}

func TestProxyAcceptsTheTokenInTheQueryForWebSockets(t *testing.T) {
	upstream, last := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	// A WebSocket handshake cannot set headers from page script, so the secret
	// arrives in the URL and must not continue upstream.
	response := get(t, proxy.Base()+"/api/v1/rooms/7/ws?peer_id=abc&"+TokenQueryParam+"="+proxy.Token(), map[string]string{
		"Connection": "Upgrade",
		"Upgrade":    "websocket",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if last.path != "/api/v1/rooms/7/ws" {
		t.Errorf("upstream path = %q", last.path)
	}
	if strings.Contains(last.query, TokenQueryParam) {
		t.Errorf("the launch token travelled upstream in the query: %q", last.query)
	}
	if last.query != "peer_id=abc" {
		t.Errorf("upstream query = %q, want peer_id=abc", last.query)
	}
}

func TestProxyKeepsTheSessionCookieOutOfThePage(t *testing.T) {
	upstream, last := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/dev" {
			http.SetCookie(w, &http.Cookie{Name: "bettercomms_session", Value: "s3cret", Path: "/", HttpOnly: true})
		}
		w.WriteHeader(http.StatusOK)
	})
	proxy := newProxy(t, upstream.URL)
	authorised := map[string]string{"Authorization": "Bearer " + proxy.Token()}

	signIn := get(t, proxy.Base()+"/api/v1/auth/dev", authorised)
	if got := signIn.Header.Values("Set-Cookie"); len(got) != 0 {
		t.Errorf("the page was handed session cookies: %v", got)
	}
	if len(signIn.Cookies()) != 0 {
		t.Errorf("the page was handed cookies: %v", signIn.Cookies())
	}

	// The next request must still be authenticated, from the jar in this process.
	get(t, proxy.Base()+"/api/v1/me", authorised)
	if !strings.Contains(last.cookie, "bettercomms_session=s3cret") {
		t.Errorf("upstream Cookie = %q, want the captured session", last.cookie)
	}
}

func TestProxyForwardsOnlyAPIPaths(t *testing.T) {
	upstream, last := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	response := get(t, proxy.Base()+"/index.html", map[string]string{
		"Authorization": "Bearer " + proxy.Token(),
	})
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", response.StatusCode)
	}
	if last.path != "" {
		t.Errorf("a non-API path reached upstream at %q", last.path)
	}
}

func TestProxyPreflightAllowsTheCallerWithoutCredentials(t *testing.T) {
	upstream, _ := newUpstream(t, nil)
	proxy := newProxy(t, upstream.URL)

	request, err := http.NewRequest(http.MethodOptions, proxy.Base()+"/api/v1/me", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Origin", "http://wails.localhost")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want 204", response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "http://wails.localhost" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	// Cookies are never the page's to send. Allowing credentials would invite a
	// browser to attach some.
	if got := response.Header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want unset", got)
	}
}

func TestProxyReportsAnUnreachableUpstream(t *testing.T) {
	upstream, _ := newUpstream(t, nil)
	address := upstream.URL
	upstream.Close()
	proxy := newProxy(t, address)

	response := get(t, proxy.Base()+"/api/v1/me", map[string]string{
		"Authorization": "Bearer " + proxy.Token(),
	})
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(body), "could not reach the API") {
		t.Errorf("body = %q, want an explanation", body)
	}
}

func TestNewAPIProxyRequiresAnOrigin(t *testing.T) {
	if _, err := NewAPIProxy(""); err == nil {
		t.Error("an empty origin was accepted")
	}
	if _, err := NewAPIProxy("not-a-url"); err == nil {
		t.Error("a relative origin was accepted")
	}
}

func TestEachLaunchGetsItsOwnToken(t *testing.T) {
	upstream, _ := newUpstream(t, nil)
	first := newProxy(t, upstream.URL)
	second := newProxy(t, upstream.URL)

	if first.Token() == second.Token() {
		t.Error("two launches shared a token")
	}
	if len(first.Token()) < 32 {
		t.Errorf("token is %d characters, too short to be unguessable", len(first.Token()))
	}
	// One launch's token must not open another's listener.
	response := get(t, second.Base()+"/api/v1/me", map[string]string{
		"Authorization": "Bearer " + first.Token(),
	})
	if response.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", response.StatusCode)
	}
}

// A nil proxy is what a development build carries. The boot report reads its
// base and token unconditionally, so those must be safe to call.
func TestNilProxyReportsNothing(t *testing.T) {
	var proxy *APIProxy
	if proxy.Base() != "" || proxy.Token() != "" {
		t.Error("a nil proxy reported a base or token")
	}
	if err := proxy.Close(); err != nil {
		t.Errorf("closing a nil proxy: %v", err)
	}
}
