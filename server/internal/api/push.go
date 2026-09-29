package api

import (
	"context"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
)

type pushSubscriptionInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	DND bool `json:"dnd"`
}

func validPushEndpoint(raw string) bool {
	if len(raw) == 0 || len(raw) > 2048 {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && (u.Port() == "" || u.Port() == "443") && u.User == nil && u.Fragment == "" && net.ParseIP(u.Hostname()) == nil
}

func validPushKey(value string, size int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != size {
		return false
	}
	if size == 65 {
		x, y := elliptic.Unmarshal(elliptic.P256(), decoded)
		return x != nil && y != nil
	}
	return true
}

func publicPushIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, reserved := range []string{"100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "2001:db8::/32"} {
		_, network, _ := net.ParseCIDR(reserved)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func (a *API) push(w http.ResponseWriter, r *http.Request, user User) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "push unavailable")
		return
	}
	if a.Config.VAPIDPublicKey == "" || a.Config.VAPIDPrivateKey == "" || a.Config.VAPIDSubject == "" {
		a.fail(w, 503, "push_unavailable", "Web Push is not configured")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.json(w, 200, map[string]string{"public_key": a.Config.VAPIDPublicKey})
	case http.MethodPost:
		var in pushSubscriptionInput
		if !a.decode(w, r, &in) {
			return
		}
		if !validPushEndpoint(in.Endpoint) || !validPushKey(in.Keys.P256dh, 65) || !validPushKey(in.Keys.Auth, 16) {
			a.fail(w, 400, "invalid_subscription", "Invalid browser push subscription")
			return
		}
		if !a.limiter.allow("push-subscribe:"+user.ID, 20, time.Hour) {
			a.fail(w, 429, "rate_limited", "Too many subscription changes")
			return
		}
		tx, err := store.DB.Begin(r.Context())
		if err != nil {
			a.result(w, nil, err)
			return
		}
		defer tx.Rollback(r.Context())
		// The same browser endpoint can be reused after a local account switch.
		// Drop its old user's queued deliveries before changing ownership.
		_, err = tx.Exec(r.Context(), `DELETE FROM push_deliveries WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint=$1)`, in.Endpoint)
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,dnd) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,dnd=EXCLUDED.dnd`, user.ID, in.Endpoint, in.Keys.P256dh, in.Keys.Auth, in.DND)
		}
		if err == nil {
			err = tx.Commit(r.Context())
		}
		a.result(w, map[string]bool{"ok": true}, err)
	case http.MethodDelete:
		var in struct {
			Endpoint string `json:"endpoint"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !validPushEndpoint(in.Endpoint) {
			a.fail(w, 400, "invalid_subscription", "Invalid browser push subscription")
			return
		}
		_, err := store.DB.Exec(r.Context(), `DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`, user.ID, in.Endpoint)
		a.result(w, map[string]bool{"ok": true}, err)
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	}
}

type pushDelivery struct {
	MessageID, SubscriptionID, Endpoint, P256dh, Auth, RoomID, Author string
}

// DispatchPush delivers a small batch from the durable queue. The row lock
// prevents duplicate deliveries from concurrent API processes. Each send is
// bounded, and revoked room access is checked again immediately before send.
func (s *PostgresStore) DispatchPush(ctx context.Context, config Config) (int, error) {
	if config.VAPIDPublicKey == "" || config.VAPIDPrivateKey == "" || config.VAPIDSubject == "" {
		return 0, nil
	}
	sent := 0
	for range 20 {
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return sent, err
		}
		var d pushDelivery
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT d.message_id::text,d.subscription_id::text,ps.endpoint,ps.p256dh,ps.auth,m.room_id::text,u.name,
			can_access_room(m.room_id,ps.user_id) AND NOT ps.dnd AND
			COALESCE(np.mode,'all')<>'mute' AND
			(COALESCE(np.mode,'all')<>'mentions' OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=ps.user_id))
			FROM push_deliveries d JOIN push_subscriptions ps ON ps.id=d.subscription_id
			JOIN messages m ON m.id=d.message_id JOIN users u ON u.id=m.author_id
			LEFT JOIN room_notification_preferences np ON np.room_id=m.room_id AND np.user_id=ps.user_id
			WHERE d.next_attempt_at<=now() ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`).Scan(
			&d.MessageID, &d.SubscriptionID, &d.Endpoint, &d.P256dh, &d.Auth, &d.RoomID, &d.Author, &allowed)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			break
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return sent, err
		}
		status := 0
		validEndpoint := validPushEndpoint(d.Endpoint)
		if allowed && validEndpoint {
			payload, _ := json.Marshal(map[string]string{"title": d.Author, "body": "New message in BetterComms", "room_id": d.RoomID})
			sendCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			status, err = sendWebPush(sendCtx, d, payload, config)
			cancel()
		}
		if !allowed || !validEndpoint || status == http.StatusGone || status == http.StatusNotFound || status == http.StatusForbidden {
			if !validEndpoint || status == http.StatusGone || status == http.StatusNotFound {
				_, _ = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE id=$1`, d.SubscriptionID)
			}
			_, err = tx.Exec(ctx, `DELETE FROM push_deliveries WHERE message_id=$1 AND subscription_id=$2`, d.MessageID, d.SubscriptionID)
		} else if err == nil && status >= 200 && status < 300 {
			sent++
			_, err = tx.Exec(ctx, `DELETE FROM push_deliveries WHERE message_id=$1 AND subscription_id=$2`, d.MessageID, d.SubscriptionID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE push_deliveries SET attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>LEAST(3600,POWER(2,LEAST(attempts+1,10))::integer)) WHERE message_id=$1 AND subscription_id=$2 AND attempts<8`, d.MessageID, d.SubscriptionID)
			if err == nil {
				_, err = tx.Exec(ctx, `DELETE FROM push_deliveries WHERE message_id=$1 AND subscription_id=$2 AND attempts>=8`, d.MessageID, d.SubscriptionID)
			}
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return sent, err
		}
		if err = tx.Commit(ctx); err != nil {
			return sent, err
		}
	}
	return sent, nil
}

func sendWebPush(ctx context.Context, d pushDelivery, payload []byte, config Config) (int, error) {
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, address := range addresses {
				ip := address.IP
				if publicPushIP(ip) {
					return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				}
			}
			return nil, fmt.Errorf("push endpoint does not resolve to a public address")
		},
	}}
	response, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{Endpoint: d.Endpoint, Keys: webpush.Keys{P256dh: d.P256dh, Auth: d.Auth}}, &webpush.Options{
		HTTPClient: client, Subscriber: config.VAPIDSubject, VAPIDPublicKey: config.VAPIDPublicKey, VAPIDPrivateKey: config.VAPIDPrivateKey, TTL: 120, Urgency: webpush.UrgencyNormal,
	})
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

func ValidVAPIDConfig(public, private, subject string) error {
	if public == "" && private == "" && subject == "" {
		return nil
	}
	if !validPushKey(public, 65) || !validPushKey(private, 32) || !(strings.HasPrefix(subject, "mailto:") || strings.HasPrefix(subject, "https://")) {
		return errors.New("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must form a valid Web Push configuration")
	}
	return nil
}
