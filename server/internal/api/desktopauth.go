package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Desktop sign-in handoff.
//
// The desktop app must not host the identity provider's UI. The webview that
// would show it is the same webview that holds native capture, screen sharing
// and recording, so every native call would have to be re-checked against
// whatever origin the window had ended up on. The standing advice for native
// apps — RFC 8252 — is the same: run the flow in the system browser, where the
// person can see the real address bar and their existing session.
//
// The browser and the desktop process do not share a cookie jar, so something
// has to carry the result back. That is a pairing:
//
//  1. The desktop generates a secret verifier, sends only its hash, and gets
//     back a pairing id and a short confirmation code.
//  2. It opens the system browser on the confirmation page for that pairing
//     and displays the same code while it waits.
//  3. The browser shows the code before anything is sent to the provider, so a
//     pairing someone else started cannot be signed into by mistake.
//  4. After the provider returns, the pairing holds a user id. It does not
//     hold a session, and no session cookie is set in that browser.
//  5. The desktop presents its verifier and receives a session of its own, in
//     its own process. The pairing is destroyed by that first claim.
//
// The pairing id is the only part that travels through the browser, and it is
// deliberately not enough to claim anything: a claim without the verifier is
// refused, so a pairing id read from browser history or a shoulder-surfed URL
// buys nothing.
const (
	// desktopPairingTTL bounds how long a half-finished sign-in stays claimable.
	// Long enough to find a password, short enough that an abandoned pairing is
	// not sitting there tomorrow.
	desktopPairingTTL = 10 * time.Minute

	// desktopPairingLimit bounds the table. Pairings are cheap, but the start
	// endpoint is reachable by anyone who can reach the API, and an unbounded
	// map is a memory target.
	desktopPairingLimit = 256
)

// desktopPairing is one desktop sign-in in progress.
type desktopPairing struct {
	verifierHash []byte
	code         string
	expires      time.Time
	// approved records that a person confirmed the code in the browser. A
	// pairing is not sent to the provider before that.
	approved bool
	// userID is set once the provider returned. Until then a claim is pending.
	userID string
}

// desktopCodeAlphabet excludes the characters people misread when comparing two
// codes on two screens: 0/O, 1/I/L, 5/S, 8/B.
const desktopCodeAlphabet = "ACDEFGHJKMNPQRTUVWXY2346789"

// newDesktopCode returns a short code in two groups, which is easier to compare
// at a glance than eight run-together characters.
func newDesktopCode() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	out := make([]byte, 0, 9)
	for index, b := range raw {
		if index == 4 {
			out = append(out, '-')
		}
		out = append(out, desktopCodeAlphabet[int(b)%len(desktopCodeAlphabet)])
	}
	return string(out), nil
}

// pairingsPrune drops expired pairings. It runs on every write so an abandoned
// sign-in does not need a background sweeper to disappear.
func (a *API) pairingsPrune(now time.Time) {
	for id, pairing := range a.pairings {
		if now.After(pairing.expires) {
			delete(a.pairings, id)
		}
	}
}

// livePairing returns an unexpired pairing under the pairing lock.
func (a *API) livePairing(id string) (*desktopPairing, bool) {
	pairing, ok := a.pairings[id]
	if !ok || time.Now().After(pairing.expires) {
		return nil, false
	}
	return pairing, true
}

// desktopAuthStart opens a pairing. The desktop sends only the hash of the
// verifier it keeps, so the server never holds anything that could claim the
// resulting session.
func (a *API) desktopAuthStart(w http.ResponseWriter, r *http.Request) {
	if a.Config.WorkOSClientID == "" || a.Config.WorkOSRedirectURI == "" {
		a.fail(w, 503, "auth_not_configured", "WorkOS authentication is not configured")
		return
	}

	var in struct {
		VerifierHash string `json:"verifier_hash"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		a.fail(w, 400, "invalid_request", "the desktop sign-in request was not valid JSON")
		return
	}
	hash, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(in.VerifierHash, "="))
	if err != nil || len(hash) != sha256.Size {
		a.fail(w, 400, "invalid_request", "verifier_hash must be a base64url SHA-256 digest")
		return
	}

	id, err := randomToken()
	if err != nil {
		a.fail(w, 500, "internal", "could not begin desktop sign-in")
		return
	}
	code, err := newDesktopCode()
	if err != nil {
		a.fail(w, 500, "internal", "could not begin desktop sign-in")
		return
	}

	now := time.Now()
	a.pairingMu.Lock()
	a.pairingsPrune(now)
	if len(a.pairings) >= desktopPairingLimit {
		a.pairingMu.Unlock()
		a.fail(w, 503, "too_many_pairings", "too many desktop sign-ins are already in progress")
		return
	}
	a.pairings[id] = &desktopPairing{
		verifierHash: hash,
		code:         code,
		expires:      now.Add(desktopPairingTTL),
	}
	a.pairingMu.Unlock()

	// The path is relative on purpose. The client is about to hand this to the
	// operating system's browser, and a client that opens whatever absolute URL
	// a server hands it has given the server a way to open any page at all.
	// The origin is the caller's own decision.
	a.json(w, 201, map[string]any{
		"pairing_id":    id,
		"code":          code,
		"confirm_path":  "/api/v1/auth/desktop/confirm?pairing=" + url.QueryEscape(id),
		"expires_in":    int(desktopPairingTTL / time.Second),
		"poll_interval": 1,
	})
}

// desktopAuthConfirm shows the confirmation page and records the approval.
//
// This interstitial is what stops the classic device-flow attack: without it,
// a link to a pairing someone else started would sign the person who follows
// it into that other person's application. Showing the code before anything
// reaches the provider gives them something to compare against their own
// window, and the page says plainly what to do when it does not match.
func (a *API) desktopAuthConfirm(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("pairing")
	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			a.desktopPage(w, 400, "Sign-in could not continue",
				"The confirmation could not be read. Start sign-in again from the BetterComms window.")
			return
		}
		id = r.PostFormValue("pairing")
	}

	a.pairingMu.Lock()
	pairing, ok := a.livePairing(id)
	if !ok {
		a.pairingMu.Unlock()
		a.desktopPage(w, 404, "This sign-in has expired",
			"Start sign-in again from the BetterComms window.")
		return
	}
	code := pairing.code
	if r.Method == http.MethodPost {
		pairing.approved = true
	}
	a.pairingMu.Unlock()

	if r.Method == http.MethodPost {
		http.Redirect(w, r, "/api/v1/auth/login?desktop="+url.QueryEscape(id), http.StatusSeeOther)
		return
	}
	a.desktopConfirmPage(w, id, code)
}

// desktopAuthClaim exchanges the verifier for a session in the caller's own
// cookie jar.
//
// A pending pairing answers 202 rather than an error: the desktop is waiting on
// a person, and waiting is not a failure.
func (a *API) desktopAuthClaim(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PairingID string `json:"pairing_id"`
		Verifier  string `json:"verifier"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		a.fail(w, 400, "invalid_request", "the desktop claim was not valid JSON")
		return
	}

	a.pairingMu.Lock()
	pairing, ok := a.livePairing(in.PairingID)
	if !ok {
		a.pairingMu.Unlock()
		a.fail(w, 404, "pairing_not_found", "this desktop sign-in has expired or was already completed")
		return
	}
	// The verifier is compared by its digest, in constant time, so a claim
	// cannot be found one character at a time.
	presented := sha256.Sum256([]byte(in.Verifier))
	if subtle.ConstantTimeCompare(presented[:], pairing.verifierHash) != 1 {
		a.pairingMu.Unlock()
		a.fail(w, 403, "pairing_verifier_invalid", "this desktop sign-in cannot be claimed by this client")
		return
	}
	userID := pairing.userID
	if userID == "" {
		a.pairingMu.Unlock()
		a.json(w, 202, map[string]any{"status": "pending"})
		return
	}
	// One claim only: the pairing is spent whether or not the session is
	// created below, so a replay finds nothing.
	delete(a.pairings, in.PairingID)
	a.pairingMu.Unlock()

	u, err := a.Store.UserByID(userID)
	if err != nil {
		a.fail(w, 401, "invalid_session", "session user no longer exists")
		return
	}
	if err := a.Sessions.Set(r, w, u.ID); err != nil {
		a.fail(w, 500, "internal", "could not create session")
		return
	}
	a.json(w, 200, map[string]any{"status": "complete", "user": u})
}

// completeDesktopPairing records the signed-in user against a pairing. It
// reports whether the pairing was still live, so the callback can say the
// sign-in expired rather than silently dropping it.
func (a *API) completeDesktopPairing(id, userID string) bool {
	a.pairingMu.Lock()
	defer a.pairingMu.Unlock()
	pairing, ok := a.livePairing(id)
	if !ok || !pairing.approved {
		return false
	}
	pairing.userID = userID
	return true
}

// approvedPairing reports whether a pairing may be sent to the provider.
func (a *API) approvedPairing(id string) bool {
	a.pairingMu.Lock()
	defer a.pairingMu.Unlock()
	pairing, ok := a.livePairing(id)
	return ok && pairing.approved && pairing.userID == ""
}

// desktopPage renders one of the small pages this flow shows in the browser.
//
// They are plain server-rendered HTML with no script: the application's own
// Content-Security-Policy allows no inline script, and a page whose entire job
// is to say "go back to the app" has no need of any.
func (a *API) desktopPage(w http.ResponseWriter, status int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, desktopPageShell(title, `<p class="lead">`+html.EscapeString(body)+`</p>`))
}

// desktopConfirmPage asks the person to compare the code before their identity
// provider is involved at all.
func (a *API) desktopConfirmPage(w http.ResponseWriter, id, code string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	body := `<p class="lead">Your BetterComms desktop window is showing a code. Check it matches the one below before you continue.</p>` +
		`<p class="code">` + html.EscapeString(code) + `</p>` +
		`<form method="post" action="/api/v1/auth/desktop/confirm">` +
		`<input type="hidden" name="pairing" value="` + html.EscapeString(id) + `">` +
		`<button type="submit">The codes match — continue</button>` +
		`</form>` +
		`<p class="warn">If the codes do not match, or you did not start a sign-in, close this tab. ` +
		`Continuing would sign you into someone else's copy of BetterComms.</p>`
	io.WriteString(w, desktopPageShell("Confirm this sign-in", body))
}

func desktopPageShell(title, body string) string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>` + html.EscapeString(title) + ` · BetterComms</title><style>` +
		`body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1310;color:#e4ffcb;` +
		`font:16px/1.6 system-ui,sans-serif}main{max-width:34rem;padding:2.5rem 1.5rem;text-align:center}` +
		`h1{font-size:1.4rem;margin:0 0 1rem}.lead{color:#c8d6c3}` +
		`.code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.18em;margin:1.5rem 0}` +
		`button{font:inherit;padding:.7rem 1.4rem;border:0;border-radius:.6rem;background:#c9f18d;color:#16210f;cursor:pointer}` +
		`.warn{color:#b6c4b5;font-size:.9rem;margin-top:2rem}` +
		`</style></head><body><main><h1>` + html.EscapeString(title) + `</h1>` + body + `</main></body></html>`
}
