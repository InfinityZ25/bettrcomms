package desktop

import (
	"errors"
	"strings"
	"testing"
)

func TestAGateAcceptsOnlyItsOwnToken(t *testing.T) {
	gate, err := NewPageGate()
	if err != nil {
		t.Fatalf("NewPageGate: %v", err)
	}
	if err := gate.Authorise(gate.Token()); err != nil {
		t.Errorf("the gate refused its own token: %v", err)
	}

	other, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(gate.Authorise(other.Token()), ErrUntrustedCaller) {
		t.Error("another launch's token was accepted")
	}
	for _, presented := range []string{"", " ", gate.Token() + "x", gate.Token()[:10]} {
		if !errors.Is(gate.Authorise(presented), ErrUntrustedCaller) {
			t.Errorf("%q was accepted", presented)
		}
	}
}

// A token that could be guessed is not a capability. It also has to be safe to
// carry in a JSON string and a URL without escaping.
func TestTheTokenIsLongAndURLSafe(t *testing.T) {
	gate, err := NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	token := gate.Token()
	if len(token) < 32 {
		t.Errorf("the token is %d characters", len(token))
	}
	const safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	for _, c := range token {
		if !strings.ContainsRune(safe, c) {
			t.Fatalf("the token contains %q", c)
		}
	}
}

// Two launches must not share a token, or a secret recovered from one session
// would still work in the next.
func TestEachLaunchGetsItsOwnPageToken(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		gate, err := NewPageGate()
		if err != nil {
			t.Fatal(err)
		}
		if seen[gate.Token()] {
			t.Fatal("two gates minted the same token")
		}
		seen[gate.Token()] = true
	}
}

// A host that could not mint a secret cannot tell its own page from anything
// else. Refusing is the safe reading of that; allowing would turn a failed
// initialisation into an open door.
func TestANilGateRefusesEverything(t *testing.T) {
	var gate *PageGate
	if gate.Token() != "" {
		t.Error("a nil gate reported a token")
	}
	if !errors.Is(gate.Authorise(""), ErrUntrustedCaller) {
		t.Error("a nil gate accepted an empty token")
	}
	if !errors.Is(gate.Authorise("anything"), ErrUntrustedCaller) {
		t.Error("a nil gate accepted a token")
	}
}

func TestMediaPermissionKindsAreNarrowed(t *testing.T) {
	for raw, want := range map[string]MediaPermissionKind{
		"microphone": MicrophonePermission,
		"Microphone": MicrophonePermission,
		" camera ":   CameraPermission,
	} {
		got, err := ParseMediaPermissionKind(raw)
		if err != nil || got != want {
			t.Errorf("%q parsed to %q (%v), want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "screen", "microphone camera", "geolocation"} {
		if _, err := ParseMediaPermissionKind(raw); err == nil {
			t.Errorf("%q was accepted", raw)
		}
	}
}

// Each capability has its own Windows privacy page, and sending someone to the
// wrong one is worse than sending them nowhere.
func TestEachCapabilityHasItsOwnPrivacyPage(t *testing.T) {
	if uri := MediaPermissionSettingsURI(MicrophonePermission); uri != "ms-settings:privacy-microphone" {
		t.Errorf("microphone opens %q", uri)
	}
	if uri := MediaPermissionSettingsURI(CameraPermission); uri != "ms-settings:privacy-webcam" {
		t.Errorf("camera opens %q", uri)
	}
}

// The policy report has to be honest about what this host cannot do, or the
// page will offer a control that silently does nothing.
func TestThePolicyReportsThatItCannotBeChangedHere(t *testing.T) {
	for _, kind := range []MediaPermissionKind{MicrophonePermission, CameraPermission} {
		policy := MediaPermission(kind)
		if policy.Kind != kind {
			t.Errorf("the policy is for %q, asked about %q", policy.Kind, kind)
		}
		if policy.Policy != "allow" {
			t.Errorf("%s policy is %q", kind, policy.Policy)
		}
		if policy.Managed {
			t.Errorf("%s is reported as changeable from here", kind)
		}
		if !strings.Contains(policy.Detail, "Windows") {
			t.Errorf("%s detail does not name where a refusal comes from: %q", kind, policy.Detail)
		}
	}
}

// OpenExternal is reachable from the page, and the shell will run whatever a
// scheme is registered to.
func TestOnlyTheSchemesThisAppNeedsCanBeOpened(t *testing.T) {
	for _, target := range []string{
		"file:///C:/Windows/System32/cmd.exe",
		"javascript:alert(1)",
		"ms-word:ofe|u|http://example.test/x.docx",
		"shell:startup",
		"not-a-uri",
		"",
	} {
		if err := OpenExternal(target); err == nil {
			t.Errorf("%q was opened", target)
		}
	}
}
