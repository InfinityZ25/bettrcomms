package desktop

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
)

// PageGate is how a native call proves it came from a document this host
// served.
//
// The Tauri host answers the same question by reading the window's current URL
// and checking it against TrustedAppOrigin. Wails exposes no way to read that
// URL, so this host answers it the other way round: it injects a per-launch
// secret into every document it serves, and native calls that matter must
// present it.
//
// This is possession-based authorisation, not a navigation allowlist or proof
// of the current URL. Ordinary navigation loses the document's in-memory token,
// but a copied token remains valid for this process lifetime. Per-document
// rotation/revocation and navigation restrictions remain separate requirements.
//
// It is deliberately separate from the API proxy's launch token. That one is
// sent on every API request and is a different blast radius; a leak of one must
// not grant the other.
type PageGate struct {
	token string
}

// ErrUntrustedCaller reports a native call from something that is not a
// document this host served.
var ErrUntrustedCaller = errors.New("native commands are restricted to the BetterComms app window")

// NewPageGate mints this launch's page secret.
func NewPageGate() (*PageGate, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, errors.New("desktop host could not generate a page token")
	}
	return &PageGate{token: base64.RawURLEncoding.EncodeToString(raw)}, nil
}

// Token is the secret to inject into the served document.
func (g *PageGate) Token() string {
	if g == nil {
		return ""
	}
	return g.token
}

// Authorise reports whether the caller holds this launch's page secret.
//
// A nil gate refuses everything rather than allowing everything: a host that
// could not mint a secret has no way to tell its own page from anything else,
// and the safe reading of that is no.
func (g *PageGate) Authorise(presented string) error {
	if g == nil || g.token == "" || presented == "" {
		return ErrUntrustedCaller
	}
	if subtle.ConstantTimeCompare([]byte(presented), []byte(g.token)) != 1 {
		return ErrUntrustedCaller
	}
	return nil
}
