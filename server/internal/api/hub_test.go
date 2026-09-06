package api

import (
	"fmt"
	"sync"
	"testing"
)

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
