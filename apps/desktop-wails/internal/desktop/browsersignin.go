package desktop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Sign-in runs in the system browser, not in this window.
//
// The alternative is to navigate the application's own webview to the identity
// provider, and that webview is the one holding native capture, screen sharing,
// recording, and global input. Pointing it at a page this application does not
// control means every native call afterwards has to be re-checked against
// whatever origin the window ended up on — and this host cannot even read that
// origin. Running the flow where the person can see a real address bar, and
// keeping the window on its own origin throughout, removes the question instead
// of answering it.
//
// What comes back is a session cookie in this process, held by the API proxy's
// jar. It never enters the webview. See the server's desktopauth.go for the
// pairing that carries it across.

// SignInState is the stage the browser hand-off has reached.
type SignInState string

const (
	// SignInIdle means no sign-in is in progress.
	SignInIdle SignInState = "idle"
	// SignInWaiting means the browser has it and this process is polling.
	SignInWaiting SignInState = "waiting"
	// SignInComplete means the session is in this process's jar.
	SignInComplete SignInState = "complete"
	// SignInFailed means the attempt ended without a session, for the stated
	// reason.
	SignInFailed SignInState = "failed"
)

// SignInStatus is what the window shows while it waits.
type SignInStatus struct {
	State SignInState `json:"state"`
	// Code is the confirmation code the browser page will display. The person
	// compares the two before approving, which is what stops a link to someone
	// else's sign-in from signing them into it.
	Code string `json:"code,omitempty"`
	// ConfirmURL is the page the browser was sent to, so the window can offer
	// it again if the browser did not open or was closed.
	ConfirmURL string `json:"confirmUrl,omitempty"`
	// Detail explains the state in the words the window should show.
	Detail string `json:"detail"`
	// ExpiresAt is when this attempt stops being claimable, in Unix
	// milliseconds. Zero when nothing is pending.
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

// apiCaller is the API surface the hand-off needs. It is an interface so the
// flow is testable without a listener, a browser, or a server.
type apiCaller interface {
	Call(ctx context.Context, method, path string, body any) (int, []byte, error)
	Upstream() string
}

// BrowserSignIn drives one sign-in at a time through the system browser.
type BrowserSignIn struct {
	api  apiCaller
	open func(string) error
	// logf records how an attempt went. Sign-in is the one flow that leaves this
	// process, spends minutes in a browser, and comes back: when it does not
	// come back there is nothing else to look at, so each attempt says what it
	// did and how it ended.
	logf func(string, ...any)
	// poll is how often the pairing is claimed while waiting. The server
	// suggests an interval; this is the floor applied to it.
	poll time.Duration

	// starting serialises Begin. Two overlapping attempts would each cancel the
	// other's waiter, and a WaitGroup cannot be added to while another
	// goroutine is waiting on it.
	starting sync.Mutex

	mu      sync.Mutex
	status  SignInStatus
	cancel  context.CancelFunc
	waiting sync.WaitGroup
}

// NewBrowserSignIn returns a hand-off that talks to the API through proxy. A
// nil proxy yields one that refuses to start and says why, which is the honest
// answer in a development build where the page reaches the API directly and
// signs in there.
func NewBrowserSignIn(proxy *APIProxy) *BrowserSignIn {
	var api apiCaller
	if proxy != nil {
		api = proxy
	}
	return &BrowserSignIn{
		api:    api,
		open:   OpenExternal,
		logf:   log.Printf,
		poll:   time.Second,
		status: SignInStatus{State: SignInIdle, Detail: "No sign-in is in progress."},
	}
}

// Status is the current stage. The window polls it while waiting.
func (b *BrowserSignIn) Status() SignInStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.status
}

// Begin starts a sign-in: it opens a pairing, sends the system browser to the
// confirmation page, and starts claiming in the background.
//
// It returns as soon as the browser has been handed the URL. The window is
// expected to show the returned code and poll Status.
func (b *BrowserSignIn) Begin(ctx context.Context) (SignInStatus, error) {
	if b.api == nil {
		return SignInStatus{}, errors.New("this build signs in through the page itself; there is no browser hand-off")
	}
	b.starting.Lock()
	defer b.starting.Unlock()

	verifier, err := newVerifier()
	if err != nil {
		return SignInStatus{}, err
	}
	digest := sha256.Sum256([]byte(verifier))

	status, payload, err := b.api.Call(ctx, http.MethodPost, "/api/v1/auth/desktop/start", map[string]string{
		"verifier_hash": base64.RawURLEncoding.EncodeToString(digest[:]),
	})
	if err != nil {
		return SignInStatus{}, fmt.Errorf("could not reach the API to begin sign-in: %w", err)
	}
	if status != http.StatusCreated {
		return SignInStatus{}, errors.New(apiMessage(status, payload, "the API refused to begin a desktop sign-in"))
	}

	var started struct {
		PairingID    string `json:"pairing_id"`
		Code         string `json:"code"`
		ConfirmPath  string `json:"confirm_path"`
		ExpiresIn    int    `json:"expires_in"`
		PollInterval int    `json:"poll_interval"`
	}
	if err := json.Unmarshal(payload, &started); err != nil {
		return SignInStatus{}, fmt.Errorf("the API's sign-in response was not readable: %w", err)
	}
	if started.PairingID == "" || started.Code == "" {
		return SignInStatus{}, errors.New("the API began a sign-in without a pairing")
	}
	confirmURL, err := confirmURL(b.api.Upstream(), started.ConfirmPath)
	if err != nil {
		return SignInStatus{}, err
	}

	// Only one sign-in at a time: a second would leave the first polling a
	// pairing nobody is going to complete.
	b.Cancel()

	expires := time.Now().Add(time.Duration(max(started.ExpiresIn, 60)) * time.Second)
	pending := SignInStatus{
		State:      SignInWaiting,
		Code:       started.Code,
		ConfirmURL: confirmURL,
		Detail:     "Finish signing in in your browser, then return here. The browser will show this code.",
		ExpiresAt:  expires.UnixMilli(),
	}

	// The browser failing to open is not the end of the attempt: the pairing is
	// live and the window can offer the address for the person to open
	// themselves.
	if err := b.open(confirmURL); err != nil {
		pending.Detail = "Open this address in your browser to finish signing in: " + confirmURL
		b.log("sign-in: could not open a browser (%v); the address is %s", err, confirmURL)
	} else {
		b.log("sign-in: opened %s, waiting for code %s", confirmURL, started.Code)
	}

	waitCtx, cancel := context.WithDeadline(context.Background(), expires)
	b.mu.Lock()
	b.status, b.cancel = pending, cancel
	b.mu.Unlock()

	interval := claimInterval(started.PollInterval, b.poll)
	b.waiting.Add(1)
	go func() {
		defer b.waiting.Done()
		defer cancel()
		b.await(waitCtx, started.PairingID, verifier, interval)
	}()
	return pending, nil
}

// await claims the pairing until it completes, fails, or runs out of time.
func (b *BrowserSignIn) await(ctx context.Context, pairingID, verifier string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// A cancelled attempt has already had its status replaced by
			// whatever cancelled it. A deadline is this flow's own failure.
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				b.log("sign-in: gave up waiting; the browser never finished")
				b.finish(SignInStatus{
					State:  SignInFailed,
					Detail: "The sign-in was not finished in time. Try again.",
				})
			}
			return
		case <-ticker.C:
			status, payload, err := b.api.Call(ctx, http.MethodPost, "/api/v1/auth/desktop/claim", map[string]string{
				"pairing_id": pairingID,
				"verifier":   verifier,
			})
			switch {
			case err != nil:
				// A dropped connection mid-sign-in is not fatal: the pairing is
				// still live and the next tick will try again.
				b.log("sign-in: claim could not be sent (%v); retrying", err)
				continue
			case status == http.StatusAccepted:
				continue
			case status == http.StatusOK:
				b.log("sign-in: claimed; the session is in this process")
				b.finish(SignInStatus{
					State:  SignInComplete,
					Detail: "Signed in.",
				})
				return
			default:
				reason := apiMessage(status, payload, "the sign-in could not be completed")
				b.log("sign-in: claim refused with %d: %s", status, reason)
				b.finish(SignInStatus{State: SignInFailed, Detail: reason})
				return
			}
		}
	}
}

// log records a line about this attempt, if anything is listening.
func (b *BrowserSignIn) log(format string, args ...any) {
	if b.logf != nil {
		b.logf(format, args...)
	}
}

// finish records a terminal status, unless something already replaced this
// attempt.
func (b *BrowserSignIn) finish(status SignInStatus) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.status.State != SignInWaiting {
		return
	}
	b.status, b.cancel = status, nil
}

// Cancel stops waiting. A sign-in the person walked away from should not keep
// polling, and a window that is closing should not leave a goroutine claiming.
func (b *BrowserSignIn) Cancel() {
	b.mu.Lock()
	cancel := b.cancel
	if b.status.State == SignInWaiting {
		b.status = SignInStatus{State: SignInIdle, Detail: "The sign-in was cancelled."}
	}
	b.cancel = nil
	b.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	b.waiting.Wait()
}

// claimInterval is how often the pairing is claimed while waiting.
//
// The server's suggestion is honoured when it is slower than this host's floor
// and ignored when it is faster: a server asking to be polled twenty times a
// second is not a reason to do it.
func claimInterval(suggestedSeconds int, floor time.Duration) time.Duration {
	return max(time.Duration(suggestedSeconds)*time.Second, floor)
}

// newVerifier returns the secret that proves a claim comes from the process
// that started the sign-in. It never leaves this process.
func newVerifier() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("could not generate a sign-in verifier")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// confirmURL joins the validated upstream origin to the path the API returned.
//
// The path is checked rather than trusted. This process is about to hand the
// result to the operating system's browser, and a server that could put any
// absolute URL there — or a scheme-relative "//elsewhere" — would be choosing
// what page this application opens.
func confirmURL(upstream, path string) (string, error) {
	if upstream == "" {
		return "", errors.New("no API origin is configured for sign-in")
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", fmt.Errorf("the API returned an unusable sign-in path %q", path)
	}
	parsed, err := url.Parse(path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" {
		return "", fmt.Errorf("the API returned an unusable sign-in path %q", path)
	}
	return upstream + parsed.String(), nil
}

// apiMessage pulls the human-readable reason out of an error body.
//
// Two shapes reach here and both matter. The API answers with a nested
// {"error":{"code","message"}}, and the loopback proxy in front of it answers
// with a flat {"error":"..."} when it could not reach the API at all. Reading
// only the first shape is how a dead API — the single most likely thing to go
// wrong — turned into a sentence that named no cause.
//
// The status is kept whatever the shape, so a body this does not recognise
// still leaves something to act on rather than a bare refusal.
func apiMessage(status int, payload []byte, fallback string) string {
	var nested struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &nested); err == nil && nested.Error.Message != "" {
		return nested.Error.Message
	}

	var flat struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &flat); err == nil && flat.Error != "" {
		return flat.Error
	}

	if status != 0 {
		return fmt.Sprintf("%s (HTTP %d)", fallback, status)
	}
	return fallback
}
