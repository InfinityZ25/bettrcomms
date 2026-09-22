package audiostream

import (
	"errors"
	"testing"
	"time"
)

func TestManagerLimitsAndReclaimsSessions(t *testing.T) {
	m := NewManager()
	defer m.Close()
	factory := func() (Processor, int, error) { return &effect{}, 2, nil }
	allow := func(string) bool { return false }
	var first Grant
	for i := 0; i < 3; i++ {
		grant, err := m.Start(factory, allow)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = grant
		}
	}
	if _, err := m.Start(factory, allow); err == nil {
		t.Fatal("fourth GPU effect admitted")
	}
	m.Stop(first.SessionID)
	deadline := time.Now().Add(time.Second)
	for len(m.slots) != 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, err := m.Start(factory, allow); err != nil {
		t.Fatalf("slot not reclaimed: %v", err)
	}
	m.Close()
	if _, err := m.Start(factory, allow); err == nil {
		t.Fatal("closed manager accepted start")
	}
}

func TestFailedFactoryDoesNotConsumeSlots(t *testing.T) {
	m := NewManager()
	defer m.Close()
	for i := 0; i < 5; i++ {
		_, err := m.Start(func() (Processor, int, error) { return nil, 0, errors.New("unavailable") }, func(string) bool { return false })
		if err == nil {
			t.Fatal("failure lost")
		}
	}
	if len(m.slots) != 0 {
		t.Fatal("failed effects leaked slots")
	}
}

func TestCloseDuringStartupReleasesLateEffect(t *testing.T) {
	m := NewManager()
	entered, release := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	e := &effect{}
	go func() {
		_, err := m.Start(func() (Processor, int, error) { close(entered); <-release; return e, 2, nil }, func(string) bool { return false })
		result <- err
	}()
	<-entered
	m.Close()
	close(release)
	if err := <-result; err == nil {
		t.Fatal("late grant returned after shutdown")
	}
	deadline := time.Now().Add(time.Second)
	for e.closed.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if e.closed.Load() != 1 {
		t.Fatal("late effect leaked")
	}
}
