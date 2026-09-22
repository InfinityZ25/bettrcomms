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
