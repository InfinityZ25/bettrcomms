//go:build ios

package main

/*
#include <stdlib.h>
char *bc_broadcast_group_path(void);
void bc_broadcast_picker_show(const char *session);
void bc_broadcast_picker_hide(void);
void bc_broadcast_host_ended(const char *session);
*/
import "C"

import (
	"bettercomms/desktop-wails/internal/native/broadcastipc"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"
)

type iosBroadcast struct {
	id       string
	listener net.Listener
	client   *broadcastipc.Client
	config   string
	cancel   context.CancelFunc
	mu       sync.Mutex
	once     sync.Once
	closed   bool
}

var screenBroadcast struct {
	sync.Mutex
	current *iosBroadcast
}

//export bc_broadcast_picker_cancel
func bc_broadcast_picker_cancel(session *C.char) {
	id := C.GoString(session)
	go func() {
		screenBroadcast.Lock()
		b := screenBroadcast.current
		screenBroadcast.Unlock()
		if b != nil && b.id == id {
			b.close()
		}
	}()
}

func (b *iosBroadcast) close() {
	b.once.Do(func() {
		b.cancel()
		b.listener.Close()
		b.mu.Lock()
		b.closed = true
		if b.client != nil {
			b.client.Close()
		}
		b.mu.Unlock()
		screenBroadcast.Lock()
		if screenBroadcast.current == b {
			screenBroadcast.current = nil
			_ = os.Remove(b.config)
		}
		screenBroadcast.Unlock()
		value := C.CString(b.id)
		C.bc_broadcast_host_ended(value)
		C.free(unsafe.Pointer(value))
	})
}

func iosBroadcastCommand(command string, raw json.RawMessage) (any, error) {
	if command == "native_screen_start" {
		return startIOSBroadcast(raw)
	}
	var args struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(raw, &args) != nil {
		return nil, errors.New("Invalid broadcast request")
	}
	screenBroadcast.Lock()
	b := screenBroadcast.current
	screenBroadcast.Unlock()
	if b == nil || b.id != args.SessionID {
		return nil, errors.New("Screen broadcast is no longer active")
	}
	if command == "native_screen_stop" {
		b.close()
		return nil, nil
	}
	b.mu.Lock()
	client := b.client
	b.mu.Unlock()
	if client == nil {
		return nil, errors.New("Screen broadcast is still starting")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return client.Call(ctx, command, raw)
}

func startIOSBroadcast(raw json.RawMessage) (any, error) {
	screenBroadcast.Lock()
	if screenBroadcast.current != nil {
		screenBroadcast.Unlock()
		return nil, errors.New("Screen broadcast already active")
	}
	path := C.bc_broadcast_group_path()
	if path == nil {
		screenBroadcast.Unlock()
		return nil, errors.New("This build needs the screen-broadcast provisioning profile")
	}
	group := C.GoString(path)
	C.free(unsafe.Pointer(path))
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		screenBroadcast.Unlock()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	b := &iosBroadcast{id: uuid.NewString(), listener: listener, config: filepath.Join(group, "broadcast.json"), cancel: cancel}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		cancel()
		listener.Close()
		screenBroadcast.Unlock()
		return nil, err
	}
	config, _ := json.Marshal(map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "token": hex.EncodeToString(token), "session": b.id, "expires": time.Now().Add(2 * time.Minute).Unix()})
	if err = os.WriteFile(b.config, config, 0600); err != nil {
		cancel()
		listener.Close()
		screenBroadcast.Unlock()
		return nil, err
	}
	screenBroadcast.current = b
	screenBroadcast.Unlock()
	success := false
	defer func() {
		if !success {
			b.close()
		}
		C.bc_broadcast_picker_hide()
	}()
	value := C.CString(b.id)
	C.bc_broadcast_picker_show(value)
	C.free(unsafe.Pointer(value))
	wait, stopWait := context.WithTimeout(ctx, 2*time.Minute)
	defer stopWait()
	go func() { <-wait.Done(); listener.Close() }()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return nil, errors.New("Screen broadcast did not start. Tap Start Broadcast in the iOS picker")
		}
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		got := make([]byte, 32)
		_, err = io.ReadFull(conn, got)
		if err != nil || subtle.ConstantTimeCompare(got, token) != 1 {
			conn.Close()
			continue
		}
		_ = conn.SetReadDeadline(time.Time{})
		client := broadcastipc.NewClient(conn)
		b.mu.Lock()
		if b.closed || wait.Err() != nil {
			b.mu.Unlock()
			client.Close()
			return nil, context.Canceled
		}
		b.client = client
		b.mu.Unlock()
		screenBroadcast.Lock()
		if screenBroadcast.current == b {
			_ = os.Remove(b.config) // single-use handoff
		}
		screenBroadcast.Unlock()
		listener.Close()
		result, err := client.Call(wait, "native_screen_start", raw)
		if err != nil {
			return nil, err
		}
		success = true
		go func() { <-client.Done(); b.close() }()
		return result, nil
	}
}
