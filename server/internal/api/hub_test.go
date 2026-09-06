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
