package api

import (
	"encoding/base64"
	"net"
	"testing"
)

func TestPushEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"http://push.example.test", "https://127.0.0.1/send", "https://user:pass@push.example.test/send", "https://push.example.test/send#fragment", "https://push.example.test:8080/send"} {
		if validPushEndpoint(endpoint) {
			t.Errorf("accepted unsafe endpoint: %s", endpoint)
		}
	}
	if !validPushEndpoint("https://fcm.googleapis.com/fcm/send/opaque") {
		t.Fatal("rejected a public HTTPS push endpoint")
	}
}

func TestPushRejectsInvalidCurveKey(t *testing.T) {
	invalid := make([]byte, 65)
	invalid[0] = 4
	if validPushKey(base64.RawURLEncoding.EncodeToString(invalid), 65) {
		t.Fatal("accepted an invalid subscriber public key")
	}
}

func TestPushRejectsInternalNetworkTargets(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "198.18.0.1", "::1"} {
		if publicPushIP(net.ParseIP(address)) {
			t.Errorf("accepted internal address %s", address)
		}
	}
	if !publicPushIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("rejected a public address")
	}
}
