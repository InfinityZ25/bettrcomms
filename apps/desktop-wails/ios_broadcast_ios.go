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
	owner    string // the page load that started it
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

// callSignalingGrace is how long a broadcast survives with no call signaling.
// Calls deliberately keep running peer to peer through a short server outage
// while the page reconnects, so a blip must not end a share.
const callSignalingGrace = 30 * time.Second

// The call's signaling socket is carried by this process's API proxy, which
// keeps running while iOS suspends the page. The page cannot end a broadcast
// while suspended, and the extension would otherwise keep sending the whole
// screen to peers of a call this phone has left.
var callSignaling struct {
	sync.Mutex
	open  func() bool
	opens func() uint64
	timer *time.Timer
}

func iosBroadcastWatchSignaling(open func() bool, opens func() uint64) {
	callSignaling.Lock()
	callSignaling.open, callSignaling.opens = open, opens
	callSignaling.Unlock()
}

// iosBroadcastSignalingClosed runs whenever the last signaling socket closes.
func iosBroadcastSignalingClosed() { armSignalingCheck() }

// armSignalingCheck (re)starts the one grace timer. When it fires it ends
// whichever broadcast is streaming then, unless a signaling socket opened
// since it was armed: a reconnect that drops again re-arms it for a full
// grace period rather than being cut short by an older timer.
func armSignalingCheck() {
	callSignaling.Lock()
	defer callSignaling.Unlock()
	if callSignaling.open == nil {
		return
	}
	if callSignaling.timer != nil {
		callSignaling.timer.Stop()
	}
	open, opens := callSignaling.open, callSignaling.opens
	armed := opens()
	callSignaling.timer = time.AfterFunc(callSignalingGrace, func() {
		if open() || opens() != armed {
			return
		}
		screenBroadcast.Lock()
		b := screenBroadcast.current
		screenBroadcast.Unlock()
		if b == nil {
			return
		}
		// Only a share that is already streaming. One still in its picker or
		// handshake sends nothing yet, and when it finishes starting with
		// signaling down, checkSignalingAfterStart re-arms a full grace.
		b.mu.Lock()
		live := b.client != nil && !b.closed
		b.mu.Unlock()
		if live {
			b.close()
		}
	})
}

// A share can start while signaling is already down (the page is mid
// reconnect); nothing would close again to arm the check for it.
func checkSignalingAfterStart() {
	callSignaling.Lock()
	open := callSignaling.open
	callSignaling.Unlock()
	if open != nil && !open() {
		armSignalingCheck()
	}
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
	if command == "native_screen_active" {
		// The ended event is a script call into a webview iOS may have
		// suspended, so it can be lost. A resumed page reconciles with this.
		screenBroadcast.Lock()
		b := screenBroadcast.current
		screenBroadcast.Unlock()
		active := ""
		if b != nil {
			b.mu.Lock()
			if b.client != nil && !b.closed {
				active = b.id
			}
			b.mu.Unlock()
		}
		return map[string]string{"sessionId": active}, nil
	}
	if command == "native_screen_release_orphans" {
		// A freshly loaded page cannot see or stop a broadcast an earlier load
		// of the page started, so it asks for any such broadcast to end.
		var args struct {
			Owner string `json:"owner"`
		}
		if json.Unmarshal(raw, &args) != nil || args.Owner == "" {
			return nil, errors.New("Invalid broadcast request")
		}
		screenBroadcast.Lock()
		b := screenBroadcast.current
		screenBroadcast.Unlock()
		if b != nil && b.owner != args.Owner {
			b.close()
		}
		return nil, nil
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
	var owned struct {
		Owner string `json:"owner"`
	}
	_ = json.Unmarshal(raw, &owned)
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
	b := &iosBroadcast{id: uuid.NewString(), owner: owned.Owner, listener: listener, config: filepath.Join(group, "broadcast.json"), cancel: cancel}
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
	var handshakes sync.WaitGroup
	// Whatever becomes of this start, a connection that finishes its
	// handshake after the start has returned is closed rather than stranded
	// in the channel, where it would leave the extension serving nobody.
	defer func() {
		go func() {
			handshakes.Wait()
			close(verified)
			for conn := range verified {
				conn.Close()
			}
		}()
	}()
	handshakes.Add(1)
	go func() {
		defer handshakes.Done()
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
			handshakes.Add(1)
			go func() {
				defer handshakes.Done()
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
	checkSignalingAfterStart()
	return result, nil
}
