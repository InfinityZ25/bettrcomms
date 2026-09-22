package audiostream

import (
	"errors"
	"sync"
)

// Manager bounds live and starting effects together: a call, a microphone test
// and temporary replacement overlap. Each grant owns independent model state.
type Manager struct {
	mu      sync.Mutex
	slots   chan struct{}
	streams map[string]*Stream
	closed  bool
}

func NewManager() *Manager {
	return &Manager{slots: make(chan struct{}, 3), streams: make(map[string]*Stream)}
}

func (m *Manager) Start(factory Factory, allowedOrigin func(string) bool) (Grant, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Grant{}, errors.New("audio manager is closed")
	}
	select {
	case m.slots <- struct{}{}:
	default:
		m.mu.Unlock()
		return Grant{}, errors.New("all native audio sessions are in use")
	}
	m.mu.Unlock()
	s, err := Start(factory, allowedOrigin)
	if err != nil {
		<-m.slots
		return Grant{}, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		s.Stop()
		go func() { <-s.Done(); <-m.slots }()
		return Grant{}, errors.New("audio manager closed during startup")
	}
	m.streams[s.Grant.SessionID] = s
	m.mu.Unlock()
	go func() {
		<-s.Done()
		m.mu.Lock()
		delete(m.streams, s.Grant.SessionID)
		<-m.slots
		m.mu.Unlock()
	}()
	return s.Grant, nil
}

func (m *Manager) Stop(id string) {
	m.mu.Lock()
	s := m.streams[id]
	m.mu.Unlock()
	if s != nil {
		s.Stop()
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	streams := make([]*Stream, 0, len(m.streams))
	for _, s := range m.streams {
		streams = append(streams, s)
	}
	m.mu.Unlock()
	for _, s := range streams {
		s.Stop()
	}
}
