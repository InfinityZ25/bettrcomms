package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

type WatchQueueItem struct {
	ID       string       `json:"id"`
	AuthorID *string      `json:"author_id"`
	Video    YouTubeVideo `json:"video"`
}
type WatchQueueSnapshot struct {
	HostCandidates []string         `json:"host_candidates"`
	Items          []WatchQueueItem `json:"items"`
	Revision       int64            `json:"revision"`
	Viewers        int              `json:"viewers"`
	Votes          int              `json:"votes"`
	Voted          bool             `json:"voted"`
}
type WatchPlaylist struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Videos  []YouTubeVideo `json:"videos"`
	Version int64          `json:"version"`
}

const youtubeWatchSelect = `SELECT room_id::text,host_id::text,paused,position_seconds,revision,updated_at,clock_timestamp(),(host_id IS NULL OR NOT room_has_permission(room_id,host_id,'post') OR NOT room_has_permission(room_id,host_id,'join_voice') OR host_seen_at<clock_timestamp()-interval '60 seconds' OR NOT EXISTS(SELECT 1 FROM channel_watch_viewers v WHERE v.room_id=w.room_id AND v.user_id=w.host_id AND v.seen_at>clock_timestamp()-interval '60 seconds')),playback_id::text,youtube_id,youtube_title FROM channel_watch_sessions w`

func scanYouTubeWatch(row pgx.Row) (*WatchTogetherState, error) {
	v := &WatchTogetherState{SourceKind: "youtube", YouTube: &YouTubeVideo{}}
	err := row.Scan(&v.RoomID, &v.HostID, &v.Paused, &v.PositionSeconds, &v.Revision, &v.UpdatedAt, &v.ServerTime, &v.CanClaim, &v.PlaybackID, &v.YouTube.ID, &v.YouTube.Title)
	return v, norm(err)
}
func (s *PostgresStore) youtubeWatch(room, user string) (*WatchTogetherState, error) {
	return scanYouTubeWatch(s.DB.QueryRow(context.Background(), youtubeWatchSelect+` WHERE room_id=$1 AND source_kind='youtube' AND can_access_room(room_id,$2) AND room_has_permission(room_id,$2,'join_voice')`, room, user))
}
func presentWatchViewer(ctx context.Context, tx pgx.Tx, room, user string) error {
	var present bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM channel_watch_viewers v WHERE room_id=$1 AND user_id=$2 AND seen_at>clock_timestamp()-interval '60 seconds' AND can_access_room(room_id,user_id) AND room_has_permission(room_id,user_id,'join_voice'))`, room, user).Scan(&present)
	if err == nil && !present {
		return ErrForbidden
	}
	return err
}
func lockWatchTx(ctx context.Context, tx pgx.Tx, room string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,5))`, room)
	return err
}
func (s *PostgresStore) SetWatchViewing(room, user, device string, present bool) error {
	tx, err := s.activityTx(room, user, false, present)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return err
	}
	if present {
		_, err = tx.Exec(ctx, `INSERT INTO channel_watch_viewers(room_id,user_id,device_id) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id,device_id) DO UPDATE SET seen_at=clock_timestamp()`, room, user, device)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM channel_watch_viewers WHERE room_id=$1 AND user_id=$2 AND device_id=$3`, room, user, device)
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM channel_watch_viewers WHERE seen_at<clock_timestamp()-interval '1 day'`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) changeYouTubeWatch(room, user string, in WatchTogetherCommand) (*WatchTogetherState, error) {
	related := []string{}
	if in.Action == "transfer" && in.HostID != user {
		related = append(related, in.HostID)
	}
	tx, err := s.activityTx(room, user, true, true, related...)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return nil, err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return nil, err
	}
	if in.Action == "start" && in.SourceKind != "youtube" {
		var message, attachment string
		if err = tx.QueryRow(ctx, `SELECT m.id::text FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND a.id=$2 AND m.room_id=$1 AND m.deleted_at IS NULL FOR SHARE OF m`, room, in.AttachmentID).Scan(&message); err != nil {
			return nil, norm(err)
		}
		if err = tx.QueryRow(ctx, `SELECT a.id::text FROM message_attachments a WHERE a.room_id=$1 AND a.id=$2 AND a.message_id=$3 AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND a.deleted_at IS NULL AND a.content_type LIKE 'video/%' AND EXISTS(SELECT 1 FROM users WHERE id=a.uploader_id AND deleted_at IS NULL) FOR SHARE`, room, in.AttachmentID, message).Scan(&attachment); err != nil {
			return nil, norm(err)
		}
	}
	var host *string
	var revision int64
	var playback, source string
	var claim bool
	err = tx.QueryRow(ctx, `SELECT host_id::text,revision,playback_id::text,source_kind,(host_id IS NULL OR NOT room_has_permission(room_id,host_id,'post') OR NOT room_has_permission(room_id,host_id,'join_voice') OR host_seen_at<clock_timestamp()-interval '60 seconds' OR NOT EXISTS(SELECT 1 FROM channel_watch_viewers v WHERE v.room_id=w.room_id AND v.user_id=w.host_id AND v.seen_at>clock_timestamp()-interval '60 seconds')) FROM channel_watch_sessions w WHERE room_id=$1 FOR UPDATE`, room).Scan(&host, &revision, &playback, &source, &claim)
	if errors.Is(err, pgx.ErrNoRows) {
		if in.Action != "start" || in.Revision != 0 {
			return nil, ErrConflict
		}
	} else if err != nil {
		return nil, err
	} else {
		if revision != in.Revision || in.PlaybackID != playback {
			return nil, ErrConflict
		}
		owns := host != nil && *host == user
		if in.Action == "claim" {
			if !owns && !claim {
				return nil, ErrForbidden
			}
		} else if !owns {
			return nil, ErrForbidden
		}
	}
	switch in.Action {
	case "start":
		if in.SourceKind == "youtube" {
			if !validYouTubeVideo(YouTubeVideo{ID: in.YouTubeID, Title: in.Title}) {
				return nil, ErrForbidden
			}
			_, err = tx.Exec(ctx, `INSERT INTO channel_watch_sessions(room_id,source_kind,youtube_id,youtube_title,host_id) VALUES($1,'youtube',$2,$3,$4) ON CONFLICT(room_id) DO UPDATE SET attachment_id=NULL,source_kind='youtube',youtube_id=EXCLUDED.youtube_id,youtube_title=EXCLUDED.youtube_title,host_id=EXCLUDED.host_id,paused=true,position_seconds=0,revision=channel_watch_sessions.revision+1,playback_id=gen_random_uuid(),updated_at=clock_timestamp(),host_seen_at=clock_timestamp()`, room, in.YouTubeID, in.Title, user)
		} else if uuidPattern.MatchString(in.AttachmentID) {
			_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET attachment_id=$2,source_kind='attachment',youtube_id=NULL,youtube_title=NULL,playback_id=gen_random_uuid(),paused=true,position_seconds=0,revision=revision+1,updated_at=clock_timestamp(),host_seen_at=clock_timestamp() WHERE room_id=$1`, room, in.AttachmentID)
		} else {
			return nil, ErrForbidden
		}
	case "stop":
		_, err = tx.Exec(ctx, `DELETE FROM channel_watch_sessions WHERE room_id=$1`, room)
	case "heartbeat":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_seen_at=clock_timestamp() WHERE room_id=$1`, room)
	case "claim":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_id=$2,revision=revision+1,host_seen_at=clock_timestamp() WHERE room_id=$1`, room, user)
	case "transfer":
		if err = presentWatchViewer(ctx, tx, room, in.HostID); err != nil {
			return nil, err
		}
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT room_has_permission($1,$2,'post') AND room_has_permission($1,$2,'join_voice')`, room, in.HostID).Scan(&allowed)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, ErrForbidden
		}
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_id=$2,revision=revision+1,host_seen_at=clock_timestamp() WHERE room_id=$1`, room, in.HostID)
	case "play", "pause", "seek":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET position_seconds=$2,paused=CASE WHEN $3='play' THEN false WHEN $3='pause' THEN true ELSE paused END,revision=revision+1,updated_at=clock_timestamp(),host_seen_at=clock_timestamp() WHERE room_id=$1`, room, in.PositionSeconds, in.Action)
	default:
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if in.Action == "start" || in.Action == "stop" {
		if _, err = tx.Exec(ctx, `DELETE FROM channel_watch_skip_votes WHERE room_id=$1`, room); err != nil {
			return nil, err
		}
	}
	var value *WatchTogetherState
	if in.Action != "stop" {
		if in.Action == "start" && in.SourceKind != "youtube" {
			value, err = scanWatch(tx.QueryRow(ctx, watchSelect+` WHERE w.room_id=$1 AND `+watchSourceAvailable, room))
		} else {
			value, err = scanYouTubeWatch(tx.QueryRow(ctx, youtubeWatchSelect+` WHERE room_id=$1`, room))
		}
		if err != nil {
			return nil, err
		}
	}
	return value, tx.Commit(ctx)
}
func (s *PostgresStore) WatchQueue(room, user string) (WatchQueueSnapshot, error) {
	out := WatchQueueSnapshot{Items: []WatchQueueItem{}, HostCandidates: []string{}}
	if err := s.RoomPermission(room, user, "join_voice"); err != nil {
		return out, err
	}
	ctx := context.Background()
	err := s.DB.QueryRow(ctx, `SELECT COALESCE((SELECT revision FROM channel_watch_queue_state WHERE room_id=$1),1),(SELECT count(DISTINCT user_id) FROM channel_watch_viewers WHERE room_id=$1 AND seen_at>clock_timestamp()-interval '60 seconds' AND can_access_room(room_id,user_id) AND room_has_permission(room_id,user_id,'join_voice')),(SELECT count(*) FROM channel_watch_skip_votes v JOIN channel_watch_sessions w USING(room_id,playback_id) WHERE v.room_id=$1 AND can_access_room(v.room_id,v.user_id) AND room_has_permission(v.room_id,v.user_id,'join_voice') AND EXISTS(SELECT 1 FROM channel_watch_viewers p WHERE p.room_id=v.room_id AND p.user_id=v.user_id AND p.seen_at>clock_timestamp()-interval '60 seconds')),(SELECT EXISTS(SELECT 1 FROM channel_watch_skip_votes v JOIN channel_watch_sessions w USING(room_id,playback_id) WHERE v.room_id=$1 AND v.user_id=$2))`, room, user).Scan(&out.Revision, &out.Viewers, &out.Votes, &out.Voted)
	if err != nil {
		return out, err
	}
	if err = s.DB.QueryRow(ctx, `SELECT COALESCE(array_agg(DISTINCT user_id::text),'{}') FROM channel_watch_viewers WHERE room_id=$1 AND seen_at>clock_timestamp()-interval '60 seconds' AND can_access_room(room_id,user_id) AND room_has_permission(room_id,user_id,'join_voice') AND room_has_permission(room_id,user_id,'post')`, room).Scan(&out.HostCandidates); err != nil {
		return out, err
	}
	rows, err := s.DB.Query(ctx, `SELECT id::text,author_id::text,youtube_id,title FROM channel_watch_queue WHERE room_id=$1 AND can_access_room(room_id,$2) ORDER BY position,id LIMIT 100`, room, user)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item WatchQueueItem
		if err = rows.Scan(&item.ID, &item.AuthorID, &item.Video.ID, &item.Video.Title); err != nil {
			return out, err
		}
		out.Items = append(out.Items, item)
	}
	return out, rows.Err()
}
func queueRevision(ctx context.Context, tx pgx.Tx, room string, expected int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO channel_watch_queue_state(room_id) VALUES($1) ON CONFLICT DO NOTHING`, room)
	if err != nil {
		return err
	}
	var version int64
	err = tx.QueryRow(ctx, `SELECT revision FROM channel_watch_queue_state WHERE room_id=$1 FOR UPDATE`, room).Scan(&version)
	if err == nil && expected != version {
		return ErrConflict
	}
	return err
}
func queueBump(ctx context.Context, tx pgx.Tx, room string) error {
	_, err := tx.Exec(ctx, `UPDATE channel_watch_queue_state SET revision=revision+1 WHERE room_id=$1`, room)
	return err
}
func (s *PostgresStore) AddWatchQueue(room, user, nonce string, revision int64, video YouTubeVideo) (string, error) {
	tx, err := s.activityTx(room, user, true, true)
	if err != nil {
		return "", err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return "", err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return "", err
	}
	var id string
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT item_id::text,video FROM channel_watch_queue_receipts WHERE room_id=$1 AND user_id=$2 AND client_nonce=$3`, room, user, nonce).Scan(&id, &receipt)
	if err == nil {
		var previous YouTubeVideo
		if json.Unmarshal(receipt, &previous) != nil || previous != video {
			return "", ErrConflict
		}
		return id, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err = queueRevision(ctx, tx, room, revision); err != nil {
		return "", err
	}
	var count int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM channel_watch_queue WHERE room_id=$1`, room).Scan(&count)
	if err != nil {
		return "", err
	}
	if count >= 100 {
		return "", ErrWatchCapacity
	}
	err = tx.QueryRow(ctx, `INSERT INTO channel_watch_queue(room_id,author_id,youtube_id,title,position,client_nonce) SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,$5 FROM channel_watch_queue WHERE room_id=$1 RETURNING id::text`, room, user, video.ID, video.Title, nonce).Scan(&id)
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(video)
	if _, err = tx.Exec(ctx, `INSERT INTO channel_watch_queue_receipts(room_id,user_id,client_nonce,video,item_id) VALUES($1,$2,$3,$4,$5)`, room, user, nonce, raw, id); err != nil {
		return "", err
	}
	if err = queueBump(ctx, tx, room); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}
func watchOwner(ctx context.Context, tx pgx.Tx, room, user string) error {
	var owns bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM channel_watch_sessions WHERE room_id=$1 AND host_id=$2)`, room, user).Scan(&owns)
	if err == nil && !owns {
		return ErrForbidden
	}
	return err
}
func (s *PostgresStore) RemoveWatchQueue(room, user, id string, revision int64) error {
	tx, err := s.activityTx(room, user, true, true)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return err
	}
	if err = queueRevision(ctx, tx, room, revision); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM channel_watch_queue WHERE room_id=$1 AND id=$2 AND (author_id=$3 OR EXISTS(SELECT 1 FROM channel_watch_sessions WHERE room_id=$1 AND host_id=$3))`, room, id, user)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	if err = queueBump(ctx, tx, room); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) ReorderWatchQueue(room, user string, ids []string, revision int64) error {
	tx, err := s.activityTx(room, user, true, true)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return err
	}
	if err = watchOwner(ctx, tx, room, user); err != nil {
		return err
	}
	if err = queueRevision(ctx, tx, room, revision); err != nil {
		return err
	}
	var count int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM channel_watch_queue WHERE room_id=$1`, room).Scan(&count)
	if err != nil {
		return err
	}
	if count != len(ids) {
		return ErrConflict
	}
	seen := map[string]bool{}
	for i, id := range ids {
		if !uuidPattern.MatchString(id) || seen[id] {
			return ErrForbidden
		}
		seen[id] = true
		tag, err := tx.Exec(ctx, `UPDATE channel_watch_queue SET position=$3 WHERE room_id=$1 AND id=$2`, room, id, i)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrConflict
		}
	}
	if err = queueBump(ctx, tx, room); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func advanceWatch(ctx context.Context, tx pgx.Tx, room, user string) error {
	var id string
	var video YouTubeVideo
	err := tx.QueryRow(ctx, `SELECT id::text,youtube_id,title FROM channel_watch_queue WHERE room_id=$1 ORDER BY position,id LIMIT 1 FOR UPDATE`, room).Scan(&id, &video.ID, &video.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `DELETE FROM channel_watch_sessions WHERE room_id=$1`, room)
	} else if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO channel_watch_sessions(room_id,source_kind,youtube_id,youtube_title,host_id,paused) VALUES($1,'youtube',$2,$3,$4,true) ON CONFLICT(room_id) DO UPDATE SET attachment_id=NULL,source_kind='youtube',youtube_id=EXCLUDED.youtube_id,youtube_title=EXCLUDED.youtube_title,playback_id=gen_random_uuid(),position_seconds=0,paused=false,revision=channel_watch_sessions.revision+1,updated_at=clock_timestamp(),host_seen_at=clock_timestamp()`, room, video.ID, video.Title, user)
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM channel_watch_queue WHERE id=$1`, id)
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM channel_watch_skip_votes WHERE room_id=$1`, room); err != nil {
		return err
	}
	return queueBump(ctx, tx, room)
}
func (s *PostgresStore) NextWatchVideo(room, user, playback string, revision, queueVersion int64, vote bool) error {
	tx, err := s.activityTx(room, user, !vote, true)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return err
	}
	var current string
	var currentRevision int64
	err = tx.QueryRow(ctx, `SELECT playback_id::text,revision FROM channel_watch_sessions WHERE room_id=$1 FOR UPDATE`, room).Scan(&current, &currentRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		if vote || playback != "" || revision != 0 {
			return ErrConflict
		}
		if err = queueRevision(ctx, tx, room, queueVersion); err != nil {
			return err
		}
		if err = advanceWatch(ctx, tx, room, user); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if current != playback || currentRevision != revision {
		return ErrConflict
	}
	if vote {
		_, err = tx.Exec(ctx, `INSERT INTO channel_watch_skip_votes(room_id,user_id,playback_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, room, user, playback)
		if err != nil {
			return err
		}
		var viewers, votes int
		err = tx.QueryRow(ctx, `WITH present AS (SELECT DISTINCT user_id FROM channel_watch_viewers WHERE room_id=$1 AND seen_at>clock_timestamp()-interval '60 seconds' AND can_access_room(room_id,user_id) AND room_has_permission(room_id,user_id,'join_voice')) SELECT (SELECT count(*) FROM present),(SELECT count(*) FROM channel_watch_skip_votes v JOIN present p USING(user_id) WHERE room_id=$1 AND playback_id=$2)`, room, playback).Scan(&viewers, &votes)
		if err != nil {
			return err
		}
		if votes <= viewers/2 {
			return tx.Commit(ctx)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO channel_watch_queue_state(room_id) VALUES($1) ON CONFLICT DO NOTHING`, room); err != nil {
			return err
		}
	} else {
		if err = watchOwner(ctx, tx, room, user); err != nil {
			return err
		}
		if err = queueRevision(ctx, tx, room, queueVersion); err != nil {
			return err
		}
	}
	if err = advanceWatch(ctx, tx, room, user); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) WatchPlaylists(user string) ([]WatchPlaylist, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT id::text,name,videos,version FROM youtube_playlists p WHERE user_id=$1 AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL) ORDER BY updated_at DESC,id LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WatchPlaylist{}
	for rows.Next() {
		var v WatchPlaylist
		var raw []byte
		if err = rows.Scan(&v.ID, &v.Name, &raw, &v.Version); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v.Videos); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *PostgresStore) SaveWatchPlaylist(user, id, nonce, name string, videos []YouTubeVideo, version int64) (string, error) {
	if !activityText(name, 1, 100) || len(videos) > 100 {
		return "", ErrForbidden
	}
	for _, v := range videos {
		if !validYouTubeVideo(v) {
			return "", ErrForbidden
		}
	}
	raw, err := json.Marshal(videos)
	if err != nil {
		return "", err
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var active string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&active); err != nil {
		return "", norm(err)
	}
	if id == "" {
		var previousName string
		var previousRaw []byte
		err = tx.QueryRow(ctx, `SELECT id::text,name,videos FROM youtube_playlists WHERE user_id=$1 AND client_nonce=$2`, user, nonce).Scan(&id, &previousName, &previousRaw)
		if err == nil {
			var previousVideos []YouTubeVideo
			if json.Unmarshal(previousRaw, &previousVideos) != nil || previousName != name || len(previousVideos) != len(videos) {
				return "", ErrConflict
			}
			for i, v := range previousVideos {
				if v != videos[i] {
					return "", ErrConflict
				}
			}
			return id, tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM youtube_playlists WHERE user_id=$1`, user).Scan(&count); err != nil {
			return "", err
		}
		if count >= 100 {
			return "", ErrWatchCapacity
		}
		err = tx.QueryRow(ctx, `INSERT INTO youtube_playlists(user_id,name,videos,client_nonce) VALUES($1,$2,$3,$4) RETURNING id::text`, user, name, raw, nonce).Scan(&id)
	} else {
		tag, e := tx.Exec(ctx, `UPDATE youtube_playlists SET name=$3,videos=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND version=$5`, id, user, name, raw, version)
		err = e
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrConflict
		}
	}
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}
func (s *PostgresStore) DeleteWatchPlaylist(user, id string, version int64) error {
	tag, err := s.DB.Exec(context.Background(), `DELETE FROM youtube_playlists WHERE id=$1 AND user_id=$2 AND version=$3`, id, user, version)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return err
}

func (s *PostgresStore) AddPlaylistWatchQueue(room, user, playlist, nonce string, version, revision int64) error {
	tx, err := s.activityTx(room, user, true, true)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if err = lockWatchTx(ctx, tx, room); err != nil {
		return err
	}
	if err = presentWatchViewer(ctx, tx, room, user); err != nil {
		return err
	}
	fingerprint, _ := json.Marshal(map[string]any{"playlist": playlist, "version": version})
	var previous []byte
	err = tx.QueryRow(ctx, `SELECT video FROM channel_watch_queue_receipts WHERE room_id=$1 AND user_id=$2 AND client_nonce=$3`, room, user, nonce).Scan(&previous)
	if err == nil {
		var a, b any
		_ = json.Unmarshal(previous, &a)
		_ = json.Unmarshal(fingerprint, &b)
		first, _ := json.Marshal(a)
		second, _ := json.Marshal(b)
		if string(first) != string(second) {
			return ErrConflict
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err = queueRevision(ctx, tx, room, revision); err != nil {
		return err
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT videos FROM youtube_playlists WHERE id=$1 AND user_id=$2 AND version=$3 FOR SHARE`, playlist, user, version).Scan(&raw); err != nil {
		return norm(err)
	}
	var videos []YouTubeVideo
	if err = json.Unmarshal(raw, &videos); err != nil {
		return err
	}
	if len(videos) == 0 {
		return ErrForbidden
	}
	var count, position int
	if err = tx.QueryRow(ctx, `SELECT count(*),COALESCE(max(position),0) FROM channel_watch_queue WHERE room_id=$1`, room).Scan(&count, &position); err != nil {
		return err
	}
	if count+len(videos) > 100 {
		return ErrWatchCapacity
	}
	var firstID string
	for i, video := range videos {
		var id string
		if err = tx.QueryRow(ctx, `INSERT INTO channel_watch_queue(room_id,author_id,youtube_id,title,position,client_nonce) VALUES($1,$2,$3,$4,$5,gen_random_uuid()) RETURNING id::text`, room, user, video.ID, video.Title, position+i+1).Scan(&id); err != nil {
			return err
		}
		if i == 0 {
			firstID = id
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO channel_watch_queue_receipts(room_id,user_id,client_nonce,video,item_id) VALUES($1,$2,$3,$4,$5)`, room, user, nonce, fingerprint, firstID); err != nil {
		return err
	}
	if err = queueBump(ctx, tx, room); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
