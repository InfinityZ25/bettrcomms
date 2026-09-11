package desktop

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// TokenQueryParam carries the launch secret on WebSocket handshakes.
//
// Page script cannot set request headers on a WebSocket, so the secret has to
// travel in the URL for those. It never leaves the loopback interface, and the
// proxy strips it before forwarding.
const TokenQueryParam = "__bc_token"

// APIProxy routes the packaged frontend's /api traffic to the validated
// upstream origin.
//
// A packaged host serves the page from its own origin, so the API is
// cross-site: the session cookie is SameSite=Lax and would not be sent, and the
// realtime WebSockets cannot traverse the webview's asset scheme at all. This
// proxy is the answer to both. It listens on loopback, forwards to the upstream
// origin, and keeps the session in this process.
//
// Two properties are deliberate:
//
//   - The session cookie never enters the webview. The jar lives here, and
//     Set-Cookie is stripped from every response the page sees. Page script
//     cannot read, copy, or leak session material that was never given to it.
//   - Every request must carry a per-launch secret. A loopback listener is
//     reachable by any process on the machine, so the secret — not the Origin
//     header — is what authorises a caller. That is strictly stronger than the
//     CSRF check it replaces upstream.
type APIProxy struct {
	upstream *url.URL
	token    string
	jar      *cookiejar.Jar
	proxy    *httputil.ReverseProxy
	listener net.Listener
	server   *http.Server
	client   *http.Client
	// sessions persists the session cookie in the operating system's credential
	// store, so signing in survives closing the application.
	sessions *SessionStore
}

// NewAPIProxy starts a loopback proxy in front of origin, which must already
// have passed ResolveAPIOrigin. It returns once the listener is accepting.
func NewAPIProxy(origin string) (*APIProxy, error) {
	if origin == "" {
		return nil, ErrMissingAPIOrigin
	}
	upstream, err := url.Parse(origin)
	if err != nil || !upstream.IsAbs() || upstream.Host == "" {
		return nil, fmt.Errorf("desktop API proxy needs an absolute origin, got %q", origin)
	}

	token, err := newLaunchToken()
	if err != nil {
		return nil, err
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("desktop API proxy cookie jar: %w", err)
	}
	// Binding to 127.0.0.1 rather than :0 keeps the listener off every other
	// interface, so it is not reachable from the network.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("desktop API proxy listener: %w", err)
	}

	p := &APIProxy{
		upstream: upstream, token: token, jar: jar, listener: listener,
		sessions: NewSessionStore(upstream.Scheme + "://" + upstream.Host),
	}
	// A session stored by an earlier launch goes back into the jar before the
	// listener is used, so the first request the page makes is already
	// authenticated and nobody is asked to sign in again.
	p.restoreSession()
	// The host's own calls go back through this proxy rather than straight
	// upstream, so a session they establish lands in the same jar the page's
	// traffic uses. Redirects are not followed: every response this host makes
	// on its own behalf is one it has to read, not chase.
	p.client = &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	p.proxy = &httputil.ReverseProxy{
		Director:       p.direct,
		ModifyResponse: p.captureCookies,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error": "the desktop host could not reach the API: " + err.Error(),
			})
		},
	}
	p.server = &http.Server{Handler: p}
	go func() { _ = p.server.Serve(listener) }()
	return p, nil
}

// Base is the origin the frontend must use for API and WebSocket URLs.
func (p *APIProxy) Base() string {
	if p == nil || p.listener == nil {
		return ""
	}
	return "http://" + p.listener.Addr().String()
}

// PersistsSession reports whether a session obtained here outlives the process.
//
// The boot report says which it is, because "you will have to sign in again
// next time" is something a person should be told rather than discover.
func (p *APIProxy) PersistsSession() bool {
	return p != nil && p.sessions.Available()
}

// Token is the per-launch secret the frontend must present on every request.
func (p *APIProxy) Token() string {
	if p == nil {
		return ""
	}
	return p.token
}

// Close stops the listener. Outstanding connections are closed with it.
func (p *APIProxy) Close() error {
	if p == nil || p.server == nil {
		return nil
	}
	return p.server.Close()
}

func (p *APIProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The page is a different origin from this listener, so it preflights.
	// Credentials are never allowed: the page holds no cookies for the API, and
	// authorisation is the bearer secret instead.
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if !p.authorised(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": "this desktop API proxy requires its launch token",
		})
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "the desktop API proxy forwards only /api requests",
		})
		return
	}
	p.proxy.ServeHTTP(w, r)
}

// authorised reports whether the caller presented this launch's secret, by
// header for ordinary requests or by query parameter for WebSockets.
func (p *APIProxy) authorised(r *http.Request) bool {
	presented := r.URL.Query().Get(TokenQueryParam)
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		presented = strings.TrimPrefix(header, "Bearer ")
	}
	if presented == "" || p.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(p.token)) == 1
}

func (p *APIProxy) direct(r *http.Request) {
	r.URL.Scheme = p.upstream.Scheme
	r.URL.Host = p.upstream.Host
	r.Host = p.upstream.Host

	// The launch secret authorises the hop to this process only. It must not
	// travel upstream, where it means nothing and would land in access logs.
	if query := r.URL.Query(); query.Has(TokenQueryParam) {
		query.Del(TokenQueryParam)
		r.URL.RawQuery = query.Encode()
	}
	r.Header.Del("Authorization")

	// This process is a native client, and the protocol's contract for one is
	// that it carries no Origin and authenticates by cookie: upstream's
	// same-origin check on writes, and its WebSocket accept, both pass a request
	// that has none. Claiming an origin instead only works where the API and the
	// application are served from the same host, which is true of the packaged
	// deployment and not of a development server.
	//
	// The check upstream makes is not weakened by this. authorised() already
	// gated the request on a per-launch secret the page cannot obtain from
	// another site, which is strictly stronger than the headers it replaces.
	//
	// The browser's fetch metadata goes with them. Those headers describe the
	// page's relationship to *this listener* — a different origin from the page,
	// so the browser marks every request Sec-Fetch-Site: cross-site — and
	// upstream reads them as a statement about itself. Forwarding them tells it
	// that a request from its own native client came from another site, and it
	// refuses every write: signing out, creating a room, sending a message.
	for _, header := range []string{
		"Origin", "Referer",
		"Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User",
	} {
		r.Header.Del(header)
	}

	// The page has no cookies for the API. This process does.
	r.Header.Del("Cookie")
	for _, cookie := range p.jar.Cookies(r.URL) {
		r.AddCookie(cookie)
	}
}

// captureCookies keeps every Set-Cookie upstream sends and hides it from the
// page, so the session lives in this process and nowhere else.
//
// A response that changes the session is also written through to the credential
// store. Signing out is a Set-Cookie like any other, so it persists as the
// absence of a session rather than needing its own path.
func (p *APIProxy) captureCookies(response *http.Response) error {
	if cookies := response.Cookies(); len(cookies) > 0 && response.Request != nil {
		p.jar.SetCookies(response.Request.URL, cookies)
		if carriesSession(cookies) {
			p.persistSession()
		}
	}
	response.Header.Del("Set-Cookie")
	return nil
}

// carriesSession reports whether a response changed the session, either by
// establishing one or by clearing it.
func carriesSession(cookies []*http.Cookie) bool {
	for _, cookie := range cookies {
		if cookie.Name == sessionCookieName {
			return true
		}
	}
	return false
}

// persistSession writes the jar's current session to the credential store.
//
// The jar is the authority: it has already applied whatever the response said,
// including an expiry that removed the cookie. Reading it back rather than
// interpreting the Set-Cookie again keeps one rule for what the session is.
func (p *APIProxy) persistSession() {
	if p.sessions == nil || !p.sessions.Available() {
		return
	}
	if err := p.sessions.Save(p.jar.Cookies(p.upstream)); err != nil {
		// A session that cannot be persisted still works for this launch, so
		// this is reported rather than fatal: the person stays signed in now and
		// signs in again next time.
		log.Printf("desktop session could not be stored: %v", err)
	}
}

// restoreSession loads a previous launch's session into the jar.
func (p *APIProxy) restoreSession() {
	if p.sessions == nil || !p.sessions.Available() {
		return
	}
	cookies, err := p.sessions.Load(p.upstream)
	if err != nil {
		if !errors.Is(err, ErrNoSecret) {
			log.Printf("desktop session could not be restored: %v", err)
		}
		return
	}
	p.jar.SetCookies(p.upstream, cookies)
}

func newLaunchToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("desktop API proxy could not generate a launch token")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Upstream is the validated origin this proxy forwards to. It is what the host
// prefixes onto a server-supplied path before handing it to anything else.
func (p *APIProxy) Upstream() string {
	if p == nil || p.upstream == nil {
		return ""
	}
	return p.upstream.Scheme + "://" + p.upstream.Host
}

// Call sends one request from this process to the upstream API, through this
// proxy.
//
// Going the long way round is the point: the proxy is where the cookie jar
// lives, so a session established by a host-side call is the same session the
// page's own requests will carry afterwards.
func (p *APIProxy) Call(ctx context.Context, method, path string, body any) (int, []byte, error) {
	if p == nil || p.listener == nil {
		return 0, nil, ErrMissingAPIOrigin
	}

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("desktop API request could not be encoded: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, p.Base()+path, payload)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := p.client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	// An API answer is small. Reading without a bound would let a wrong
	// upstream hand this process an unbounded allocation.
	answer, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, answer, nil
}
