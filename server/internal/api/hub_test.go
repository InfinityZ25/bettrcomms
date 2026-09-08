package api

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestCallPresenceDefaultsMutedUpdatesAndCleansUp(t *testing.T) {
	hub := NewHub()
	client := &client{user: "user-1", name: "Alice", send: make(chan wire, 2)}
	hub.add("room-1", client)
	participants := hub.callPresence("room-1")
	if len(participants) != 1 || participants[0].Name != "Alice" || !participants[0].Muted || participants[0].Deafened {
		t.Fatalf("unsafe initial presence: %#v", participants)
	}
	if !hub.setPresence("room-1", client, false, false) {
		t.Fatal("active client presence was rejected")
	}
	if got := hub.callPresence("room-1")[0]; got.Muted || got.Deafened {
		t.Fatalf("presence update was not retained: %#v", got)
	}
	hub.remove("room-1", client)
	if participants := hub.callPresence("room-1"); len(participants) != 0 {
		t.Fatalf("disconnected participant retained: %#v", participants)
	}
	if hub.setPresence("room-1", client, false, false) {
		t.Fatal("disconnected client recreated presence")
	}
}

func TestPresencePayloadCompatibilityAndValidation(t *testing.T) {
	muted, deafened, err := decodePresence(json.RawMessage(`{"microphone":true}`))
	if err != nil || muted || deafened {
		t.Fatalf("legacy microphone presence rejected: muted=%v deafened=%v err=%v", muted, deafened, err)
	}
	muted, deafened, err = decodePresence(json.RawMessage(`{"muted":false,"deafened":true}`))
	if err != nil || !muted || !deafened {
		t.Fatalf("deafened presence was not normalized: muted=%v deafened=%v err=%v", muted, deafened, err)
	}
	for _, payload := range []string{`{}`, `{"muted":"yes"}`, `null`} {
		if _, _, err := decodePresence(json.RawMessage(payload)); err == nil {
			t.Fatalf("invalid presence accepted: %s", payload)
		}
	}
}

func TestSameUserCanJoinFromMultipleDevicesOrReplaceThem(t *testing.T) {
	hub := NewHub()
	first := &client{peer: "device-1", user: "user-1", name: "Alice", muted: true, send: make(chan wire, 8)}
	if peers, _, err := hub.addWithMode("room", first, false); err != nil || len(peers) != 0 {
		t.Fatalf("first join peers=%v err=%v", peers, err)
	}
	second := &client{peer: "device-2", user: "user-1", name: "Alice", muted: true, send: make(chan wire, 8)}
	peers, identities, err := hub.addWithMode("room", second, false)
	if err != nil || len(peers) != 1 || peers[0] != first.peer || identities[first.peer].UserID != first.user {
		t.Fatalf("second device did not discover first: peers=%v identities=%v err=%v", peers, identities, err)
	}
	if joined := <-first.send; joined.Type != "peer.joined" || joined.From != second.peer || joined.UserID != first.user {
		t.Fatalf("first device join event=%#v", joined)
	}
	if !hub.setPresence("room", second, false, true) {
		t.Fatal("second-device presence was rejected")
	}
	participants := hub.callPresence("room")
	if len(participants) != 1 || participants[0].DeviceCount != 2 || participants[0].Muted || participants[0].Deafened {
		t.Fatalf("multi-device presence was not grouped: %#v", participants)
	}

	replacement := &client{peer: "device-3", user: "user-1", name: "Alice", muted: true, send: make(chan wire, 8)}
	if peers, _, err = hub.addWithMode("room", replacement, true); err != nil || len(peers) != 0 {
		t.Fatalf("replacement retained old peers: peers=%v err=%v", peers, err)
	}
	participants = hub.callPresence("room")
	if len(participants) != 1 || participants[0].DeviceCount != 1 || !participants[0].Muted {
		t.Fatalf("replacement presence=%#v", participants)
	}
}

func TestConcurrentJoinersAlwaysDiscoverEachOther(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		hub := NewHub()
		const count = 8
		clients := make([]*client, count)
		snapshots := make([][]string, count)
		ready := make(chan struct{})
		var joined sync.WaitGroup
		for i := 0; i < count; i++ {
			clients[i] = &client{user: fmt.Sprint(i), send: make(chan wire, 32)}
			joined.Add(1)
			go func(i int) { defer joined.Done(); <-ready; snapshots[i] = hub.add("room", clients[i]) }(i)
		}
		close(ready)
		joined.Wait()
		for i, c := range clients {
			discovered := map[string]bool{}
			for _, id := range snapshots[i] {
				discovered[id] = true
			}
			for len(c.send) > 0 {
				event := <-c.send
				discovered[event.From] = true
			}
			if discovered[c.user] || len(discovered) != count-1 {
				t.Fatalf("joiner %d discovered %d other participants, expected %d", i, len(discovered), count-1)
			}
		}
	}
}

func TestResumedSignalingSocketDoesNotDisturbOtherPeers(t *testing.T) {
	hub := NewHub()
	watcher := &client{peer: "watcher", user: "user-1", name: "Alice", send: make(chan wire, 8)}
	if _, _, err := hub.addWithMode("room", watcher, false); err != nil {
		t.Fatalf("watcher join: %v", err)
	}
	original := &client{peer: "caller", user: "user-2", name: "Bob", send: make(chan wire, 8)}
	if _, _, err := hub.addWithMode("room", original, false); err != nil {
		t.Fatalf("caller join: %v", err)
	}
	if joined := <-watcher.send; joined.Type != "peer.joined" || joined.From != original.peer {
		t.Fatalf("watcher did not observe the caller joining: %#v", joined)
	}

	// The same participant reconnecting keeps its peer connections and media,
	// so the watcher must not be told to tear anything down and rebuild it.
	resumed := &client{peer: "caller", user: "user-2", name: "Bob", send: make(chan wire, 8)}
	peers, _, err := hub.addWithMode("room", resumed, false)
	if err != nil {
		t.Fatalf("resume was rejected: %v", err)
	}
	if len(peers) != 1 || peers[0] != watcher.peer {
		t.Fatalf("resumed socket did not rediscover the room: peers=%v", peers)
	}
	select {
	case unexpected := <-watcher.send:
		t.Fatalf("resuming disturbed an unrelated peer: %#v", unexpected)
	default:
	}

	// A genuinely different participant reusing a free peer identity is still
	// announced, and a departure is still reported when the room really loses one.
	hub.remove("room", resumed)
	if left := <-watcher.send; left.Type != "peer.left" || left.From != resumed.peer {
		t.Fatalf("watcher did not observe a real departure: %#v", left)
	}
}
