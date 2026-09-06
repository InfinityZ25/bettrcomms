package api

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
)

const voiceUserA = "11111111-1111-4111-8111-111111111111"
const voiceUserB = "22222222-2222-4222-8222-222222222222"

func TestVoiceQueueDropsOldest(t *testing.T) {
	v := &voiceClient{send: make(chan queuedVoice, voiceQueueSize)}
	for sequence := int64(0); sequence <= voiceQueueSize; sequence++ {
		v.enqueue(voiceWire{Type: "voice", Sequence: sequence})
	}
	if got := (<-v.send).message.Sequence; got != 1 {
		t.Fatalf("oldest retained sequence=%d", got)
	}
}

func TestVoiceRelayRequiresExactActiveSignalAndRevokesWithIt(t *testing.T) {
	h := NewHub()
	owner := &client{user: voiceUserA, send: make(chan wire, 1)}
	targetSignal := &client{user: voiceUserB, send: make(chan wire, 1)}
	h.add("room", owner)
	h.add("room", targetSignal)
	target := &voiceClient{user: voiceUserB, owner: targetSignal, send: make(chan queuedVoice, voiceQueueSize)}
	if !h.addVoice("room", voiceUserB, target) {
		t.Fatal("active signaling owner was rejected")
	}
	stale := &voiceClient{user: voiceUserA, owner: &client{user: voiceUserA}, send: make(chan queuedVoice, voiceQueueSize)}
	if h.addVoice("room", voiceUserA, stale) {
		t.Fatal("stale signaling owner was accepted")
	}
	sender := &voiceClient{user: voiceUserA, owner: owner, send: make(chan queuedVoice, voiceQueueSize)}
	if !h.addVoice("room", voiceUserA, sender) {
		t.Fatal("sender voice relay was rejected")
	}
	if !h.relayVoice("room", sender, voiceUserB, voiceWire{Type: "voice", From: voiceUserA}) {
		t.Fatal("active same-room target was not relayed")
	}
	h.remove("room", targetSignal)
	if h.relayVoice("room", sender, voiceUserB, voiceWire{Type: "voice"}) {
		t.Fatal("voice relay survived its signaling owner")
	}
}

func TestVoicePacketValidation(t *testing.T) {
	valid := voiceWire{Type: "voice", To: voiceUserB, Epoch: "epoch", Sequence: 0, Data: base64.StdEncoding.EncodeToString(make([]byte, 32))}
	if !validVoice(valid) {
		t.Fatal("valid encrypted packet rejected")
	}
	for name, mutate := range map[string]func(*voiceWire){
		"target":     func(m *voiceWire) { m.To = "not-a-uuid" },
		"epoch":      func(m *voiceWire) { m.Epoch = string(make([]byte, 65)) },
		"sequence":   func(m *voiceWire) { m.Sequence = voiceSafeInteger + 1 },
		"ciphertext": func(m *voiceWire) { m.Data = "not base64" },
	} {
		m := valid
		mutate(&m)
		if validVoice(m) {
			t.Fatalf("invalid %s accepted", name)
		}
	}
}

func TestVoiceJSONRequiresSequenceAndSenderIsServerOwned(t *testing.T) {
	data := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if _, err := decodeVoiceMessage([]byte(`{"type":"voice","to":"` + voiceUserB + `","epoch":"e","data":"` + data + `"}`)); err == nil {
		t.Fatal("missing sequence accepted")
	}
	m, err := decodeVoiceMessage([]byte(`{"type":"voice","to":"` + voiceUserB + `","from":"spoofed","epoch":"e","sequence":1,"data":"` + data + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	m.From = voiceUserA
	if m.From != voiceUserA {
		t.Fatal("server sender identity was not applied")
	}
}

func TestVoiceRelayHTTPAuthorizationPrecedesUpgrade(t *testing.T) {
	u := User{ID: voiceUserA}
	for _, tc := range []struct {
		name   string
		store  Store
		origin string
		status int
	}{
		{"membership", testStore{user: u, roomErr: ErrNotFound}, "http://localhost", http.StatusForbidden},
		{"origin", testStore{user: u}, "https://attacker.example", http.StatusForbidden},
		{"signaling", testStore{user: u}, "http://localhost", http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := New(tc.store, newTestSessions(false), Config{})
			r := httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/rooms/room/voice-relay", nil)
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			a.voiceRelay(w, r, u, "room")
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d", w.Code, tc.status)
			}
		})
	}
}
