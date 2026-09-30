package desktop

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A room's voice call is a WebSocket, so the proxy has to carry one.
//
// The existing coverage only checked that the launch token is stripped from a
// handshake's query, against a stub that answered 200 and never upgraded.
// Everything after the request — the 101, the hijacked connection, the frames
// in both directions — went untested, which is exactly the part that failed in
// the packaged host while the browser, which reaches the API directly, was fine.
func TestProxyCarriesAWebSocket(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("upstream accept: %v", err)
			return
		}
		defer socket.CloseNow()
		kind, data, err := socket.Read(r.Context())
		if err != nil {
			t.Errorf("upstream read: %v", err)
			return
		}
		if err := socket.Write(r.Context(), kind, append([]byte("echo:"), data...)); err != nil {
			t.Errorf("upstream write: %v", err)
		}
	}))
	t.Cleanup(upstream.Close)

	proxy := newProxy(t, upstream.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	address := strings.Replace(proxy.Base(), "http://", "ws://", 1)
	socket, _, err := websocket.Dial(ctx, address+"/api/v1/rooms/7/ws?peer_id=abc&"+TokenQueryParam+"="+proxy.Token(), nil)
	if err != nil {
		t.Fatalf("the handshake did not reach upstream: %v", err)
	}
	defer socket.CloseNow()

	if err := socket.Write(ctx, websocket.MessageText, []byte("offer")); err != nil {
		t.Fatalf("write through the proxy: %v", err)
	}
	_, data, err := socket.Read(ctx)
	if err != nil {
		t.Fatalf("read through the proxy: %v", err)
	}
	if string(data) != "echo:offer" {
		t.Errorf("received %q, want %q", data, "echo:offer")
	}
}

// The handshake is a request like any other, so the rules the rest of the
// traffic follows apply to it too: no launch token upstream, no page origin.
func TestProxyHandshakeFollowsTheNativeClientContract(t *testing.T) {
	seen := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("upstream accept: %v", err)
			return
		}
		socket.CloseNow()
	}))
	t.Cleanup(upstream.Close)

	proxy := newProxy(t, upstream.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	address := strings.Replace(proxy.Base(), "http://", "ws://", 1)
	socket, _, err := websocket.Dial(ctx, address+"/api/v1/rooms/7/ws?"+TokenQueryParam+"="+proxy.Token(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://wails.localhost"}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer socket.CloseNow()

	select {
	case header := <-seen:
		if got := header.Get("Origin"); got != "" {
			t.Errorf("the page's origin reached upstream: %q", got)
		}
		if got := header.Get("Authorization"); got != "" {
			t.Errorf("the launch token reached upstream: %q", got)
		}
	case <-ctx.Done():
		t.Fatal("upstream never saw the handshake")
	}
}

// On iOS the call's signaling socket is the host's only view of whether the
// call is still up while the page is suspended; see ios_broadcast_ios.go.
func TestProxyReportsWhenTheLastCallSignalingSocketCloses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		_, _, _ = socket.Read(r.Context())
	}))
	t.Cleanup(upstream.Close)

	proxy := newProxy(t, upstream.URL)
	closed := make(chan struct{}, 4)
	proxy.OnCallSignalingClosed(func() { closed <- struct{}{} })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	address := strings.Replace(proxy.Base(), "http://", "ws://", 1)
	dial := func(path string) *websocket.Conn {
		socket, _, err := websocket.Dial(ctx, address+path+"?"+TokenQueryParam+"="+proxy.Token(), nil)
		if err != nil {
			t.Fatalf("dial %s: %v", path, err)
		}
		return socket
	}

	first, second := dial("/api/v1/rooms/7/ws"), dial("/api/v1/rooms/7/ws")
	relay := dial("/api/v1/rooms/7/voice-relay")
	waitFor(t, func() bool { return proxy.CallSignalingOpen() })
	// Only signaling sockets count, and each one that opens is counted once.
	if opens := proxy.CallSignalingOpens(); opens != 2 {
		t.Fatalf("counted %d signaling opens, want 2", opens)
	}

	first.Close(websocket.StatusNormalClosure, "")
	relay.Close(websocket.StatusNormalClosure, "")
	select {
	case <-closed:
		t.Fatal("reported closed while another signaling socket was still open")
	case <-time.After(300 * time.Millisecond):
	}
	second.Close(websocket.StatusNormalClosure, "")
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the last signaling socket closed without a report")
	}
	if proxy.CallSignalingOpen() {
		t.Fatal("signaling still counted as open")
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
