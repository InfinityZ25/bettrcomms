package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// desktopStore is the smallest store the sign-in handoff touches: it upserts the
// identity the provider returned and reads it back when the desktop claims.
type desktopStore struct {
	Store
	user User
}

func (s *desktopStore) UpsertUser(id, email, name string, _ *string) (User, error) {
	s.user = User{ID: id, Email: email, Name: name}
	return s.user, nil
}

func (s *desktopStore) UserByID(id string) (User, error) {
	if s.user.ID != id {
		return User{}, ErrNotFound
	}
	return s.user, nil
}

// stubProvider answers the token exchange so the flow can be driven end to end
// without reaching WorkOS.
type stubProvider struct{ body string }

func (p stubProvider) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(p.body)),
		Header:     http.Header{},
	}, nil
}

func newDesktopAPI(t *testing.T) (*API, Sessions) {
	t.Helper()
	sessions := newTestSessions(false)
	a := New(&desktopStore{}, sessions, Config{
		AppURL:            "http://localhost",
		WorkOSClientID:    "client_test",
		WorkOSAPIKey:      "sk_test",
		WorkOSRedirectURI: "http://localhost/api/v1/auth/callback",
	})
	a.HTTP = &http.Client{Transport: stubProvider{body: `{"user":{"id":"workos-user-1","email":"alice@example.test","first_name":"Alice","last_name":"Green"}}`}}
	return a, sessions
}

// pairing is what the desktop holds: a secret it keeps and an id it is willing
// to send through a browser.
type pairingHandle struct {
	id       string
	code     string
	verifier string
	confirm  string
}

func startPairing(t *testing.T, a *API) pairingHandle {
	t.Helper()
	verifier := "verifier-" + strings.Repeat("z", 32)
	digest := sha256.Sum256([]byte(verifier))
	body, err := json.Marshal(map[string]string{
		"verifier_hash": base64.RawURLEncoding.EncodeToString(digest[:]),
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "http://localhost/api/v1/auth/desktop/start", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("start returned %d: %s", response.Code, response.Body.String())
	}

	var out struct {
		PairingID   string `json:"pairing_id"`
		Code        string `json:"code"`
		ConfirmPath string `json:"confirm_path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.PairingID == "" || out.Code == "" {
		t.Fatalf("start returned no pairing: %s", response.Body.String())
	}
	// The verifier must never appear in anything the browser is given.
	if strings.Contains(response.Body.String(), verifier) {
		t.Fatal("the start response echoed the verifier")
	}
	if !strings.HasPrefix(out.ConfirmPath, "/api/v1/auth/desktop/confirm?") {
		t.Errorf("start returned an absolute or unexpected confirmation path %q", out.ConfirmPath)
	}
	return pairingHandle{id: out.PairingID, code: out.Code, verifier: verifier, confirm: out.ConfirmPath}
}

func claim(t *testing.T, a *API, pairing pairingHandle, verifier string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"pairing_id": pairing.id, "verifier": verifier})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://localhost/api/v1/auth/desktop/claim", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	return response
}

// approve walks the browser half: the confirmation page, the approval, and the
// provider's callback. It returns the callback's response.
func approve(t *testing.T, a *API, pairing pairingHandle) *httptest.ResponseRecorder {
	t.Helper()

	confirm := httptest.NewRecorder()
	a.Handler().ServeHTTP(confirm, httptest.NewRequest(http.MethodGet,
		"http://localhost/api/v1/auth/desktop/confirm?pairing="+url.QueryEscape(pairing.id), nil))
	if confirm.Code != http.StatusOK {
		t.Fatalf("the confirmation page returned %d", confirm.Code)
	}
	if !strings.Contains(confirm.Body.String(), pairing.code) {
		t.Error("the confirmation page does not show the code the desktop is displaying")
	}

	form := httptest.NewRecorder()
	approval := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
		strings.NewReader("pairing="+url.QueryEscape(pairing.id)))
	approval.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// A browser submitting this form sends the origin of the page it is on,
	// which is the host that served it — not APP_URL, which in development is
	// the front end rather than the API.
	approval.Header.Set("Origin", "http://127.0.0.1:8080")
	approval.Header.Set("Sec-Fetch-Site", "same-origin")
	a.Handler().ServeHTTP(form, approval)
	if form.Code != http.StatusSeeOther {
		t.Fatalf("approval returned %d: %s", form.Code, form.Body.String())
	}

	login := httptest.NewRecorder()
	a.Handler().ServeHTTP(login, httptest.NewRequest(http.MethodGet, "http://localhost"+form.Header().Get("Location"), nil))
	if login.Code != http.StatusFound {
		t.Fatalf("login returned %d: %s", login.Code, login.Body.String())
	}
	provider, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if provider.Host != "api.workos.com" {
		t.Fatalf("login did not send the browser to the provider: %s", provider)
	}
	state := provider.Query().Get("state")
	if state == "" {
		t.Fatal("login sent no state to the provider")
	}

	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet,
		"http://localhost/api/v1/auth/callback?state="+url.QueryEscape(state)+"&code=provider-code", nil)
	for _, cookie := range login.Result().Cookies() {
		request.AddCookie(cookie)
	}
	a.Handler().ServeHTTP(callback, request)
	return callback
}

func sessionCookie(response *httptest.ResponseRecorder) *http.Cookie {
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == "bettercomms_session" && cookie.Value != "" {
			return cookie
		}
	}
	return nil
}

// This is the acceptance test for the handoff: the browser signs in, the
// browser gets no session, and the desktop process gets one.
func TestTheDesktopClaimsTheSessionTheBrowserSignedInFor(t *testing.T) {
	a, sessions := newDesktopAPI(t)
	pairing := startPairing(t, a)

	if pending := claim(t, a, pairing, pairing.verifier); pending.Code != http.StatusAccepted {
		t.Fatalf("a claim before sign-in returned %d, want 202: %s", pending.Code, pending.Body.String())
	}

	callback := approve(t, a, pairing)
	if callback.Code != http.StatusFound {
		t.Fatalf("callback returned %d: %s", callback.Code, callback.Body.String())
	}
	if location := callback.Header().Get("Location"); location != "/api/v1/auth/desktop/done" {
		t.Errorf("the browser was sent to %q, want the desktop completion page", location)
	}
	if cookie := sessionCookie(callback); cookie != nil {
		t.Error("the browser was given a session for a desktop sign-in")
	}

	claimed := claim(t, a, pairing, pairing.verifier)
	if claimed.Code != http.StatusOK {
		t.Fatalf("claim returned %d: %s", claimed.Code, claimed.Body.String())
	}
	cookie := sessionCookie(claimed)
	if cookie == nil {
		t.Fatal("the claim did not carry a session cookie")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("the claimed session cookie is not protected: %#v", cookie)
	}

	// The session must actually work.
	authenticated := httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/me", nil)
	authenticated.AddCookie(cookie)
	if id, err := sessions.UserID(authenticated); err != nil || id == "" {
		t.Fatalf("the claimed session does not authenticate: %q %v", id, err)
	}

	var body struct {
		Status string `json:"status"`
		User   User   `json:"user"`
	}
	if err := json.Unmarshal(claimed.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "complete" || body.User.Email != "alice@example.test" {
		t.Errorf("the claim returned %#v", body)
	}
}

// The pairing id travels through a browser. On its own it must buy nothing.
func TestAClaimWithoutTheVerifierIsRefused(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)
	approve(t, a, pairing)

	stolen := claim(t, a, pairing, "not-the-verifier")
	if stolen.Code != http.StatusForbidden {
		t.Fatalf("a claim without the verifier returned %d, want 403", stolen.Code)
	}
	if sessionCookie(stolen) != nil {
		t.Fatal("a claim without the verifier was given a session")
	}

	// A wrong guess must not destroy the pairing the real desktop is waiting on.
	if legitimate := claim(t, a, pairing, pairing.verifier); legitimate.Code != http.StatusOK {
		t.Errorf("the real claim returned %d after a wrong one: %s", legitimate.Code, legitimate.Body.String())
	}
}

// A pairing is spent by its first successful claim, so a replayed request
// cannot mint a second session.
func TestAPairingCanOnlyBeClaimedOnce(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)
	approve(t, a, pairing)

	if first := claim(t, a, pairing, pairing.verifier); first.Code != http.StatusOK {
		t.Fatalf("the first claim returned %d", first.Code)
	}
	replay := claim(t, a, pairing, pairing.verifier)
	if replay.Code != http.StatusNotFound {
		t.Errorf("a replayed claim returned %d, want 404", replay.Code)
	}
	if sessionCookie(replay) != nil {
		t.Error("a replayed claim was given a session")
	}
}

// Nothing reaches the identity provider before a person has compared the code.
// Without this rule, a link to someone else's pairing would sign whoever
// follows it into that other person's application.
func TestSignInIsNotSentToTheProviderBeforeItIsConfirmed(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)

	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet,
		"http://localhost/api/v1/auth/login?desktop="+url.QueryEscape(pairing.id), nil))

	if response.Code == http.StatusFound {
		t.Fatalf("an unconfirmed pairing was sent to %s", response.Header().Get("Location"))
	}
	if response.Code != http.StatusNotFound {
		t.Errorf("an unconfirmed pairing returned %d", response.Code)
	}
}

// The confirmation page is the one thing standing between a stray link and an
// account, so it has to say what it is asking and carry no script of its own —
// the application's CSP allows none.
func TestTheConfirmationPageWarnsAndCarriesNoScript(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)

	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet,
		"http://localhost/api/v1/auth/desktop/confirm?pairing="+url.QueryEscape(pairing.id), nil))
	page := response.Body.String()

	if !strings.Contains(page, pairing.code) {
		t.Error("the page does not show the code")
	}
	if !strings.Contains(page, "do not match") {
		t.Error("the page does not say what to do when the codes differ")
	}
	if strings.Contains(strings.ToLower(page), "<script") {
		t.Error("the confirmation page carries script")
	}
}

// An abandoned sign-in must stop being claimable, whether or not anyone ever
// opened the browser page.
func TestAnExpiredPairingCannotBeUsed(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)

	a.pairingMu.Lock()
	a.pairings[pairing.id].expires = time.Now().Add(-time.Second)
	a.pairingMu.Unlock()

	if response := claim(t, a, pairing, pairing.verifier); response.Code != http.StatusNotFound {
		t.Errorf("an expired pairing answered a claim with %d", response.Code)
	}

	confirm := httptest.NewRecorder()
	a.Handler().ServeHTTP(confirm, httptest.NewRequest(http.MethodGet,
		"http://localhost/api/v1/auth/desktop/confirm?pairing="+url.QueryEscape(pairing.id), nil))
	if confirm.Code != http.StatusNotFound {
		t.Errorf("an expired pairing still offered a confirmation page (%d)", confirm.Code)
	}
}

// A pairing that was never started cannot be confirmed or claimed.
func TestAnUnknownPairingIsRefused(t *testing.T) {
	a, _ := newDesktopAPI(t)
	unknown := pairingHandle{id: "not-a-pairing", verifier: "anything"}

	if response := claim(t, a, unknown, unknown.verifier); response.Code != http.StatusNotFound {
		t.Errorf("an unknown pairing answered a claim with %d", response.Code)
	}
}

// The confirmation code is what a person compares across two screens, so it has
// to be readable and free of the characters that look alike.
func TestTheConfirmationCodeIsUnambiguous(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		code, err := newDesktopCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != 9 || code[4] != '-' {
			t.Fatalf("code %q is not two groups of four", code)
		}
		for _, c := range code {
			if c == '-' {
				continue
			}
			if !strings.ContainsRune(desktopCodeAlphabet, c) {
				t.Fatalf("code %q contains %q, which is not in the alphabet", code, c)
			}
		}
		seen[code] = true
	}
	if len(seen) < 190 {
		t.Errorf("only %d of 200 codes were distinct", len(seen))
	}
}

// The desktop host proxies as a native client: it sends no Origin and
// authenticates by cookie. The whole packaged transport depends on a write with
// no Origin being accepted, so the contract is pinned here rather than left to
// a reading of the middleware.
func TestAWriteWithNoOriginIsAcceptedAsANativeClient(t *testing.T) {
	a, _ := newDesktopAPI(t)

	body, err := json.Marshal(map[string]string{"verifier_hash": strings.Repeat("A", 43)})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://localhost/api/v1/auth/desktop/start", strings.NewReader(string(body)))
	if request.Header.Get("Origin") != "" {
		t.Fatal("the request already carries an Origin")
	}
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)

	if response.Code == http.StatusForbidden {
		t.Fatalf("a native client write was refused as cross-site: %s", response.Body.String())
	}
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
}

// A browser on another site must still be refused. The rule the proxy relies on
// is "no Origin", not "any Origin".
func TestAWriteFromAnotherSiteIsStillRefused(t *testing.T) {
	a, _ := newDesktopAPI(t)

	body, err := json.Marshal(map[string]string{"verifier_hash": strings.Repeat("A", 43)})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://localhost/api/v1/auth/desktop/start", strings.NewReader(string(body)))
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Errorf("a cross-site write returned %d, want 403", response.Code)
	}
}

// The confirmation page is served by this server and its form posts back to the
// same host. A browser sends that host as the Origin, and refusing it made the
// desktop hand-off impossible to complete anywhere the API and APP_URL are
// different hosts — which is every development setup.
func TestAFormPostedBackToTheHostThatServedItIsAccepted(t *testing.T) {
	a, _ := newDesktopAPI(t)
	pairing := startPairing(t, a)

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
		strings.NewReader("pairing="+url.QueryEscape(pairing.id)))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)

	if response.Code == http.StatusForbidden {
		t.Fatalf("the confirmation form was refused as cross-site: %s", response.Body.String())
	}
	if response.Code != http.StatusSeeOther {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
}

// Relaxing the check to "the host being addressed" must admit nothing else. A
// page on another site sends that site's origin, not this host's.
func TestOriginsThatAreNotTheHostOrTheAppAreStillRefused(t *testing.T) {
	a, _ := newDesktopAPI(t)

	for _, test := range []struct{ name, origin string }{
		{"another site", "https://evil.example"},
		{"a host with a shared prefix", "http://127.0.0.1:8080.evil.example"},
		{"another port on the same host", "http://127.0.0.1:9999"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
				strings.NewReader("pairing=x"))
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			request.Header.Set("Origin", test.origin)
			response := httptest.NewRecorder()
			a.Handler().ServeHTTP(response, request)

			if response.Code != http.StatusForbidden {
				t.Errorf("origin %q returned %d, want 403", test.origin, response.Code)
			}
		})
	}
}

// The scheme is not part of the host comparison, and that is a deliberate
// trade rather than an oversight: a server behind TLS termination sees a
// plaintext connection while the browser reports an https Origin, so inferring
// this server's own scheme would refuse every write in a deployment. What the
// gap costs is an http page on the same host and port as an https one, which
// cannot both exist. A scheme no browser page can have is still refused.
func TestTheHostComparisonIgnoresTheSchemeButNotTheKind(t *testing.T) {
	a, _ := newDesktopAPI(t)

	post := func(origin string) int {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
			strings.NewReader("pairing=x"))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, request)
		return response.Code
	}

	if code := post("https://127.0.0.1:8080"); code == http.StatusForbidden {
		t.Error("an https origin on the same host was refused; TLS termination makes that the deployment case")
	}
	for _, origin := range []string{"file://127.0.0.1:8080", "bettercomms://127.0.0.1:8080", "null"} {
		if code := post(origin); code != http.StatusForbidden {
			t.Errorf("origin %q returned %d, want 403", origin, code)
		}
	}
}

// A browser declaring the request cross-site is refused whatever its Origin
// says, and the application's own configured origin is still accepted.
func TestTheAppOriginAndCrossSiteDeclarationsStillDecide(t *testing.T) {
	a, _ := newDesktopAPI(t)

	// APP_URL is http://localhost in these tests, and a page there is the app.
	appOrigin := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
		strings.NewReader("pairing=x"))
	appOrigin.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	appOrigin.Header.Set("Origin", "http://localhost")
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, appOrigin)
	if response.Code == http.StatusForbidden {
		t.Error("the configured application origin was refused")
	}

	crossSite := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/auth/desktop/confirm",
		strings.NewReader("pairing=x"))
	crossSite.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	crossSite.Header.Set("Origin", "http://127.0.0.1:8080")
	crossSite.Header.Set("Sec-Fetch-Site", "cross-site")
	response = httptest.NewRecorder()
	a.Handler().ServeHTTP(response, crossSite)
	if response.Code != http.StatusForbidden {
		t.Errorf("a request declaring itself cross-site returned %d, want 403", response.Code)
	}
}
