// Package broadcastipc carries control messages between the iOS host and its
// broadcast extension. Video never crosses this connection.
package broadcastipc

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const MaxMessage = 512 * 1024

type Message struct {
	ID      uint64          `json:"id"`
	Command string          `json:"command,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

func read(r io.Reader) (Message, error) {
	var size uint32
	if err := binary.Read(r, binary.BigEndian, &size); err != nil {
		return Message{}, err
	}
	if size == 0 || size > MaxMessage {
		return Message{}, errors.New("Invalid broadcast control message size")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return Message{}, err
	}
	var m Message
	err := json.Unmarshal(data, &m)
	return m, err
}

func write(w io.Writer, m Message) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(data) > MaxMessage {
		return errors.New("Broadcast control message too large")
	}
	packet := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(packet, uint32(len(data)))
	copy(packet[4:], data)
	for len(packet) > 0 {
		n, err := w.Write(packet)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		packet = packet[n:]
	}
	return nil
}

type Client struct {
	conn    net.Conn
	writes  sync.Mutex
	mu      sync.Mutex
	pending map[uint64]chan Message
	next    atomic.Uint64
	once    sync.Once
	done    chan struct{}
}

func NewClient(conn net.Conn) *Client {
	c := &Client{conn: conn, pending: make(map[uint64]chan Message), done: make(chan struct{})}
	go func() {
		defer c.Close()
		for {
			m, err := read(conn)
			if err != nil {
				return
			}
			c.mu.Lock()
			reply := c.pending[m.ID]
			delete(c.pending, m.ID)
			c.mu.Unlock()
			if reply != nil {
				reply <- m
			}
		}
	}()
	return c
}
func (c *Client) Done() <-chan struct{} { return c.done }
func (c *Client) Close()                { c.once.Do(func() { close(c.done); _ = c.conn.Close() }) }
func (c *Client) Call(ctx context.Context, command string, args json.RawMessage) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := c.next.Add(1)
	reply := make(chan Message, 1)
	c.mu.Lock()
	if len(c.pending) >= 16 {
		c.mu.Unlock()
		return nil, errors.New("Too many broadcast requests")
	}
	c.pending[id] = reply
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	c.writes.Lock()
	if err := ctx.Err(); err != nil {
		c.writes.Unlock()
		return nil, err
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err := write(c.conn, Message{ID: id, Command: command, Args: args})
	c.writes.Unlock()
	if err != nil {
		c.Close()
		return nil, err
	}
	select {
	case m := <-reply:
		if m.Error != "" {
			return nil, errors.New(m.Error)
		}
		return m.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, errors.New("Screen broadcast ended")
	}
}

// Serve is called only after the private App Group handoff has authenticated.
func Serve(ctx context.Context, conn net.Conn, handler func(context.Context, string, json.RawMessage) (any, error)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close()
	go func() { <-ctx.Done(); _ = conn.Close() }()
	var writes sync.Mutex
	slots := make(chan struct{}, 8)
	for {
		m, err := read(conn)
		if err != nil {
			return err
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		go func(m Message) {
			defer func() { <-slots }()
			result, err := handler(ctx, m.Command, m.Args)
			r := Message{ID: m.ID}
			if err != nil {
				r.Error = err.Error()
			} else {
				r.Result, err = json.Marshal(result)
				if err != nil {
					r.Error = "Invalid broadcast result"
				}
			}
			writes.Lock()
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			err = write(conn, r)
			writes.Unlock()
			if err != nil {
				cancel()
			}
		}(m)
	}
}
