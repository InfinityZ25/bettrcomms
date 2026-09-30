//go:build ios

package main

/*
#include <stdlib.h>
char *bc_broadcast_group_path(void);
void bc_broadcast_picker_show(const char *session);
void bc_broadcast_picker_hide(const char *session);
void bc_broadcast_host_ended(const char *session);
*/
import "C"

import (
	"bettercomms/desktop-wails/internal/native/broadcastipc"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
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
	if command == "native_screen_cancel_pending" {
		// The page learns a session ID only when the start returns, so it cannot
		// name a broadcast still waiting in the picker. Close that one only.
		screenBroadcast.Lock()
		b := screenBroadcast.current
		screenBroadcast.Unlock()
		if b != nil {
			b.mu.Lock()
			pending := b.client == nil
			b.mu.Unlock()
			if pending {
				b.close()
			}
		}
		return nil, nil
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
	// Two single-use keys. The extension proves itself with token; the app then
	// proves itself with hostToken, so an app that binds this loopback port
	// after BetterComms exits cannot receive the screen from the extension.
	token := make([]byte, broadcastipc.KeySize)
	hostToken := make([]byte, broadcastipc.KeySize)
	_, err = rand.Read(token)
	if err == nil {
		_, err = rand.Read(hostToken)
	}
	if err != nil {
		cancel()
		listener.Close()
		screenBroadcast.Unlock()
		return nil, err
	}
	config, _ := json.Marshal(map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "token": hex.EncodeToString(token), "hostToken": hex.EncodeToString(hostToken), "session": b.id, "expires": time.Now().Add(2 * time.Minute).Unix()})
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
		hide := C.CString(b.id)
		C.bc_broadcast_picker_hide(hide)
		C.free(unsafe.Pointer(hide))
	}()
	value := C.CString(b.id)
	C.bc_broadcast_picker_show(value)
	C.free(unsafe.Pointer(value))
	wait, stopWait := context.WithTimeout(ctx, 2*time.Minute)
	defer stopWait()
	go func() { <-wait.Done(); listener.Close() }()
	// Verify each connection on its own goroutine: a local app opening idle
	// connections must not hold up the extension behind its read deadline.
	verified := make(chan net.Conn, 1)
	go func() {
		slots := make(chan struct{}, 8)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			select {
			case slots <- struct{}{}:
			default:
				conn.Close()
				continue
			}
			go func() {
				defer func() { <-slots }()
				if broadcastipc.AcceptExtension(conn, token, hostToken, 3*time.Second) != nil {
					conn.Close()
					return
				}
				select {
				case verified <- conn:
				default:
					conn.Close()
				}
			}()
		}
	}()
	var conn net.Conn
	select {
	case conn = <-verified:
	case <-wait.Done():
		return nil, errors.New("Screen broadcast did not start. Tap Start Broadcast in the iOS picker")
	}
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
