package broadcastipc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

func TestConcurrentRepliesAndDisconnect(t *testing.T) {
	host, extension := net.Pipe()
	client := NewClient(host)
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Serve(ctx, extension, func(ctx context.Context, command string, args json.RawMessage) (any, error) {
		if command == "wait" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		var n int
		if err := json.Unmarshal(args, &n); err != nil {
			return nil, err
		}
		return n * 2, nil
	})
	var group sync.WaitGroup
	for n := 0; n < 8; n++ {
		group.Add(1)
		go func(n int) {
			defer group.Done()
			args, _ := json.Marshal(n)
			result, err := client.Call(ctx, "double", args)
			if err != nil {
				t.Error(err)
				return
			}
			var got int
			json.Unmarshal(result, &got)
			if got != n*2 {
				t.Errorf("reply mixed up: %d != %d", got, n*2)
			}
		}(n)
	}
	group.Wait()
	done := make(chan error, 1)
	go func() { _, err := client.Call(ctx, "wait", nil); done <- err }()
	client.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("disconnect must fail pending call")
		}
	case <-time.After(time.Second):
		t.Fatal("disconnect leaked pending call")
	}
}

func TestCancellationDoesNotConsumeLaterReply(t *testing.T) {
	host, extension := net.Pipe()
	client := NewClient(host)
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	go Serve(ctx, extension, func(ctx context.Context, command string, args json.RawMessage) (any, error) {
		if command == "slow" {
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return command, nil
	})
	short, stop := context.WithTimeout(ctx, 10*time.Millisecond)
	defer stop()
	if _, err := client.Call(short, "slow", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	close(release)
	result, err := client.Call(ctx, "next", nil)
	if err != nil || string(result) != `"next"` {
		t.Fatalf("late reply corrupted next call: %s %v", result, err)
	}
}

func TestOversizedPacketRejectedBeforeAllocation(t *testing.T) {
	var data bytes.Buffer
	binary.Write(&data, binary.BigEndian, uint32(MaxMessage+1))
	if _, err := read(&data); err == nil {
		t.Fatal("accepted oversized control message")
	}
}

func TestCanceledCallDoesNotSendCommand(t *testing.T) {
	host, extension := net.Pipe()
	client := NewClient(host)
	defer client.Close()
	defer extension.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Call(ctx, "start", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	extension.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	var packet [4]byte
	if n, err := extension.Read(packet[:]); n != 0 || err == nil {
		t.Fatalf("canceled request reached extension: n=%d err=%v", n, err)
	}
}
