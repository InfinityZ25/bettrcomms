package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type MessageSearchFilters struct {
	Query, RoomID, AuthorID, Kind, BeforeID string
	From, To                                *time.Time
	Limit                                   int
}

func parseMessageSearchFilters(r *http.Request) (MessageSearchFilters, error) {
	q := r.URL.Query()
	f := MessageSearchFilters{Query: strings.TrimSpace(q.Get("q")), RoomID: strings.ToLower(q.Get("room_id")), AuthorID: strings.ToLower(q.Get("author_id")), Kind: q.Get("kind"), BeforeID: q.Get("before_id"), Limit: pageLimit(r)}
	length := utf8.RuneCountInString(f.Query)
	if !utf8.ValidString(f.Query) || strings.ContainsRune(f.Query, '\x00') || length > 200 || length == 1 || f.RoomID != "" && !uuidPattern.MatchString(f.RoomID) || f.AuthorID != "" && !uuidPattern.MatchString(f.AuthorID) {
		return f, fmt.Errorf("use 2–200 characters and valid conversation/author filters")
	}
	switch f.Kind {
	case "", "link", "image", "video", "audio", "file":
	case "document":
		f.Kind = "file"
	default:
		return f, fmt.Errorf("choose links, images, videos, audio or files")
	}
	for _, bound := range []struct {
		key string
		out **time.Time
	}{{"from", &f.From}, {"to", &f.To}} {
		if raw := q.Get(bound.key); raw != "" {
			at, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil || at.Year() < 1970 || at.Year() > 9999 {
				return f, fmt.Errorf("dates must be RFC3339 timestamps with a timezone")
			}
			utc := at.UTC()
			*bound.out = &utc
		}
	}
	if f.From != nil && f.To != nil && !f.From.Before(*f.To) {
		return f, fmt.Errorf("the end date must follow the start date")
	}
	if f.Query == "" && f.RoomID == "" && f.AuthorID == "" && f.Kind == "" && f.From == nil && f.To == nil {
		return f, fmt.Errorf("enter text or choose a search filter")
	}
	if f.BeforeID != "" && !uuidPattern.MatchString(f.BeforeID) {
		if _, err := decodeSearchCursor(f.BeforeID); err != nil {
			return f, err
		}
	}
	return f, nil
}

func (a *API) messageSearchFilters(w http.ResponseWriter, r *http.Request, user User) {
	if r.Method != http.MethodGet {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if !a.limiter.allow("message-search:"+user.ID, 90, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many searches")
		return
	}
	f, err := parseMessageSearchFilters(r)
	if err != nil {
		a.fail(w, 400, "invalid_search", err.Error())
		return
	}
	if store, ok := a.Store.(interface {
		SearchMessagesFiltered(context.Context, string, MessageSearchFilters) (MessagePage, error)
	}); ok {
		page, searchErr := store.SearchMessagesFiltered(r.Context(), user.ID, f)
		a.result(w, page, searchErr)
		return
	}
	if store, ok := a.Store.(MessagingStore); ok && f.Query != "" && f.Kind == "" && f.From == nil && f.To == nil && !strings.HasPrefix(f.BeforeID, "search:") {
		page, searchErr := store.SearchMessages(user.ID, f.RoomID, f.AuthorID, f.Query, f.BeforeID, f.Limit)
		a.result(w, page, searchErr)
		return
	}
	a.fail(w, 503, "unavailable", "filtered search is unavailable")
}

func encodeSearchCursor(sequence int64) string {
	return "search:" + base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(sequence, 10)))
}

func decodeSearchCursor(cursor string) (int64, error) {
	if !strings.HasPrefix(cursor, "search:") || len(cursor) > 40 {
		return 0, fmt.Errorf("invalid search cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, "search:"))
	if err != nil {
		return 0, fmt.Errorf("invalid search cursor")
	}
	sequence, err := strconv.ParseInt(string(data), 10, 64)
	if err != nil || sequence < 1 {
		return 0, fmt.Errorf("invalid search cursor")
	}
	return sequence, nil
}

var searchHiddenText = regexp.MustCompile("(?s)```.*?```|`[^`]*`|\\|\\|.*?\\|\\|")
var searchLinks = regexp.MustCompile(`(?i)https?://[^\s<>]+`)

func searchHasVisibleLink(body string) bool {
	for _, raw := range searchLinks.FindAllString(searchHiddenText.ReplaceAllString(body, " "), -1) {
		u, err := url.Parse(strings.TrimRight(raw, ".,;!?)\"'"))
		if err == nil && isHTTPScheme(u.Scheme) && u.Hostname() != "" && u.User == nil {
			return true
		}
	}
	return false
}

// A cursor carries only ordering, never authorization. Access is checked again
// on every page, and the sequence survives deletion of the last returned row.
func (s *PostgresStore) SearchMessagesFiltered(ctx context.Context, user string, f MessageSearchFilters) (MessagePage, error) {
	before := int64(9223372036854775807)
	if f.BeforeID != "" {
		if strings.HasPrefix(f.BeforeID, "search:") {
			var err error
			before, err = decodeSearchCursor(f.BeforeID)
			if err != nil {
				return MessagePage{}, ErrNotFound
			}
		} else if err := s.DB.QueryRow(ctx, `SELECT sequence FROM messages WHERE id=$1 AND can_access_room(room_id,$2)`, f.BeforeID, user).Scan(&before); err != nil {
			return MessagePage{}, norm(err)
		}
	}
	limit := f.Limit
	if limit < 1 || limit > 100 {
		limit = 50
	}
	out := MessagePage{Messages: []Message{}}
	// Shadow the attachment relation for this projection: a quarantined or
	// unfinished file must not appear even when another file matched the filter.
	query := `WITH message_attachments AS (
		SELECT * FROM message_attachments WHERE deleted_at IS NULL AND upload_state='ready' AND scan_state IN ('not_required','clean')
	) ` + messageSelect + ` WHERE m.deleted_at IS NULL AND m.sequence<$5
		AND can_access_room(m.room_id,$1)
		AND ($2='' OR m.room_id=NULLIF($2,'')::uuid)
		AND ($3='' OR m.author_id=NULLIF($3,'')::uuid)
		AND ($4='' OR to_tsvector('simple',m.body) @@ websearch_to_tsquery('simple',$4))
		AND ($6::timestamptz IS NULL OR m.created_at >= $6)
		AND ($7::timestamptz IS NULL OR m.created_at < $7)
		AND ($8='' OR ($8='link' AND m.body ~* 'https?://') OR EXISTS (
			SELECT 1 FROM message_attachments a WHERE a.room_id=m.room_id
			AND (a.message_id=m.id OR a.id IN (SELECT asset.attachment_id FROM message_asset_links link JOIN channel_media_assets asset ON asset.id=link.asset_id WHERE link.message_id=m.id))
			AND (($8='image' AND a.content_type LIKE 'image/%')
			OR ($8='video' AND a.content_type LIKE 'video/%')
			OR ($8='audio' AND a.content_type LIKE 'audio/%')
			OR ($8='file' AND a.content_type NOT LIKE 'image/%' AND a.content_type NOT LIKE 'video/%' AND a.content_type NOT LIKE 'audio/%'))
		)) ORDER BY m.sequence DESC LIMIT $9`
	batch := limit + 1
	if f.Kind == "link" {
		batch = 100
	}
	for scanned := 0; scanned < 2000; {
		rows, err := s.DB.Query(ctx, query, user, f.RoomID, f.AuthorID, f.Query, before, f.From, f.To, f.Kind, batch)
		if err != nil {
			return out, err
		}
		count := 0
		for rows.Next() {
			message, scanErr := scanMessage(rows)
			if scanErr != nil {
				rows.Close()
				return out, scanErr
			}
			count++
			scanned++
			before = message.Sequence
			if f.Kind != "link" || searchHasVisibleLink(message.Body) {
				out.Messages = append(out.Messages, message)
				if len(out.Messages) > limit {
					out.Messages = out.Messages[:limit]
					out.BeforeID = encodeSearchCursor(out.Messages[limit-1].Sequence)
					rows.Close()
					return out, nil
				}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
		if count < batch {
			return out, nil
		}
	}
	// Keep scans bounded while allowing the next page to progress past rows
	// whose apparent URLs were code, spoilers or credential-bearing links.
	out.BeforeID = encodeSearchCursor(before)
	return out, nil
}
