package api

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrStorageQuota = errors.New("room storage quota exceeded")
var ErrUploadOffset = errors.New("upload offset conflicts with stored progress")

type StoragePolicy struct {
	CommunityID   string `json:"community_id"`
	QuotaBytes    int64  `json:"quota_bytes"`
	RetentionDays int    `json:"retention_days"`
	UsedBytes     int64  `json:"used_bytes"`
	ReservedBytes int64  `json:"reserved_bytes"`
	CleanupBytes  int64  `json:"cleanup_bytes"`
	Files         int64  `json:"files"`
}
type ResumableUpload struct {
	ID                                                    string            `json:"id"`
	Attachment                                            MessageAttachment `json:"attachment"`
	Offset                                                int64             `json:"offset"`
	ChunkBytes                                            int64             `json:"chunk_bytes"`
	State                                                 string            `json:"state"`
	Fingerprint                                           string            `json:"fingerprint"`
	ExpiresAt                                             time.Time         `json:"expires_at"`
	Key, MultipartID, SessionID, ScanState, FinalizeToken string            `json:"-"`
}

func reserveAttachment(ctx context.Context, tx pgx.Tx, room, user, key string, attachment MessageAttachment, scanState string) error {
	if err := checkRoomPosting(ctx, tx, room, user, false); err != nil {
		return err
	}
	var community *string
	if err := tx.QueryRow(ctx, `SELECT community_id::text FROM rooms WHERE id=$1`, room).Scan(&community); err != nil {
		return norm(err)
	}
	if community != nil {
		if _, err := tx.Exec(ctx, `INSERT INTO community_storage_policies(community_id) VALUES($1) ON CONFLICT DO NOTHING`, *community); err != nil {
			return err
		}
		var quota, used int64
		if err := tx.QueryRow(ctx, `SELECT quota_bytes FROM community_storage_policies WHERE community_id=$1 FOR UPDATE`, *community).Scan(&quota); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(a.size_bytes),0)::bigint FROM message_attachments a JOIN rooms r ON r.id=a.room_id WHERE r.community_id=$1 AND a.deleted_at IS NULL`, *community).Scan(&used); err != nil {
			return err
		}
		if quota > 0 && (attachment.SizeBytes > quota || used > quota-attachment.SizeBytes) {
			return ErrStorageQuota
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO message_attachments(id,room_id,uploader_id,object_key,filename,content_type,size_bytes,voice_note,duration_ms,upload_state,scan_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading',$10)`, attachment.ID, room, user, key, attachment.Filename, attachment.ContentType, attachment.SizeBytes, attachment.VoiceNote, attachment.DurationMS, scanState)
	return err
}
func (s *PostgresStore) SavePendingAttachmentWithPolicy(room, user, key string, attachment MessageAttachment, scanState string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = reserveAttachment(ctx, tx, room, user, key, attachment, scanState); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) CreateResumableUpload(ctx context.Context, room, user, session, key, fingerprint string, attachment MessageAttachment, scanState string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = reserveAttachment(ctx, tx, room, user, key, attachment, scanState); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO attachment_uploads(id,session_id,fingerprint) VALUES($1,$2,$3)`, attachment.ID, session, fingerprint); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) CompleteResumable(ctx context.Context, id, room, user, session, token string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = checkRoomPosting(ctx, tx, room, user, false); err != nil {
		return err
	}
	var live string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE`, session, user).Scan(&live); err != nil {
		return ErrForbidden
	}
	var ready, state string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM message_attachments WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND deleted_at IS NULL FOR UPDATE`, id, room, user).Scan(&ready); err != nil {
		return norm(err)
	}
	if err = tx.QueryRow(ctx, `SELECT state FROM attachment_uploads WHERE id=$1 AND session_id=$2 AND finalize_token=$3 AND finalize_until>clock_timestamp() AND state IN('assembled','complete') FOR UPDATE`, id, session, token).Scan(&state); err != nil {
		return norm(err)
	}
	if state == "complete" {
		return tx.Commit(ctx)
	}
	err = tx.QueryRow(ctx, `UPDATE message_attachments a SET upload_state='ready' FROM attachment_uploads u WHERE a.id=$1 AND a.room_id=$2 AND a.uploader_id=$3 AND a.message_id IS NULL AND a.deleted_at IS NULL AND a.scan_state IN('not_required','clean') AND u.id=a.id AND u.session_id=$4 AND u.offset_bytes=a.size_bytes AND u.state IN('assembled','complete') RETURNING a.id::text`, id, room, user, session).Scan(&ready)
	if err != nil {
		return norm(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE attachment_uploads SET state='complete',updated_at=clock_timestamp() WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const uploadSelect = `SELECT u.id::text,a.filename,a.content_type,a.size_bytes,u.offset_bytes,u.state,u.fingerprint,u.expires_at,a.object_key,COALESCE(u.multipart_id,''),u.session_id::text,a.scan_state FROM attachment_uploads u JOIN message_attachments a ON a.id=u.id WHERE u.id=$1 AND a.room_id=$2 AND a.uploader_id=$3 AND u.session_id=$4 AND a.deleted_at IS NULL AND can_access_room(a.room_id,$3) AND (u.expires_at>clock_timestamp() OR u.state='complete')`

func scanResumable(row pgx.Row) (ResumableUpload, error) {
	var u ResumableUpload
	err := row.Scan(&u.ID, &u.Attachment.Filename, &u.Attachment.ContentType, &u.Attachment.SizeBytes, &u.Offset, &u.State, &u.Fingerprint, &u.ExpiresAt, &u.Key, &u.MultipartID, &u.SessionID, &u.ScanState)
	u.Attachment.ID = u.ID
	u.ChunkBytes = AttachmentChunkBytes
	return u, norm(err)
}
func (s *PostgresStore) ResumableUpload(ctx context.Context, room, user, session, id string) (ResumableUpload, error) {
	return scanResumable(s.DB.QueryRow(ctx, uploadSelect, id, room, user, session))
}
func (s *PostgresStore) ListResumableUploads(ctx context.Context, room, user, session string) ([]ResumableUpload, error) {
	rows, err := s.DB.Query(ctx, `SELECT u.id::text FROM attachment_uploads u JOIN message_attachments a ON a.id=u.id WHERE a.room_id=$1 AND a.uploader_id=$2 AND u.session_id=$3 AND a.deleted_at IS NULL AND a.message_id IS NULL AND u.expires_at>clock_timestamp() ORDER BY u.updated_at DESC LIMIT 20`, room, user, session)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	uploads := make([]ResumableUpload, 0, len(ids))
	for _, id := range ids {
		u, e := s.ResumableUpload(ctx, room, user, session, id)
		if e == nil {
			uploads = append(uploads, u)
		} else if !errors.Is(e, ErrNotFound) {
			return nil, e
		}
	}
	return uploads, nil
}
func (s *PostgresStore) RoomStorage(ctx context.Context, community, user string) (StoragePolicy, error) {
	var policy StoragePolicy
	policy.CommunityID = community
	var allowed bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2 AND role IN('owner','admin')) AND NOT EXISTS(SELECT 1 FROM community_bans WHERE community_id=$1 AND user_id=$2)`, community, user).Scan(&allowed); err != nil {
		return policy, err
	}
	if !allowed {
		return policy, ErrForbidden
	}
	err := s.DB.QueryRow(ctx, `SELECT COALESCE(p.quota_bytes,0),COALESCE(p.retention_days,0),COALESCE(sum(a.size_bytes) FILTER(WHERE a.deleted_at IS NULL AND a.upload_state='ready'),0)::bigint,COALESCE(sum(a.size_bytes) FILTER(WHERE a.deleted_at IS NULL AND a.upload_state='uploading'),0)::bigint,COALESCE(sum(a.size_bytes) FILTER(WHERE a.deleted_at IS NOT NULL),0)::bigint,count(a.id) FILTER(WHERE a.deleted_at IS NULL AND a.upload_state='ready') FROM communities c LEFT JOIN community_storage_policies p ON p.community_id=c.id LEFT JOIN rooms r ON r.community_id=c.id LEFT JOIN message_attachments a ON a.room_id=r.id WHERE c.id=$1 GROUP BY p.quota_bytes,p.retention_days`, community).Scan(&policy.QuotaBytes, &policy.RetentionDays, &policy.UsedBytes, &policy.ReservedBytes, &policy.CleanupBytes, &policy.Files)
	return policy, norm(err)
}
func (s *PostgresStore) UpdateRoomStorage(ctx context.Context, community, user string, quota int64, retention int) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, community, user, 3); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO community_storage_policies(community_id,quota_bytes,retention_days) VALUES($1,$2,$3) ON CONFLICT(community_id) DO UPDATE SET quota_bytes=EXCLUDED.quota_bytes,retention_days=EXCLUDED.retention_days,updated_at=clock_timestamp()`, community, quota, retention)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type LibraryFile struct {
	MessageAttachment
	RoomID     string    `json:"room_id"`
	MessageID  *string   `json:"message_id,omitempty"`
	AuthorID   *string   `json:"author_id,omitempty"`
	AuthorName string    `json:"author_name"`
	CreatedAt  time.Time `json:"created_at"`
}
type LibraryFilter struct {
	Kind, Author, Cursor string
	From, To             *time.Time
	Limit                int
}
type FileLibraryPage struct {
	Files  []LibraryFile `json:"files"`
	Cursor string        `json:"next_cursor,omitempty"`
}

func decodeLibraryCursor(cursor string) (*time.Time, string, error) {
	if cursor == "" {
		return nil, "", nil
	}
	if len(cursor) > 160 {
		return nil, "", errors.New("invalid file cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, "", errors.New("invalid file cursor")
	}
	parts := strings.Split(string(data), "\n")
	if len(parts) != 2 || !uuidPattern.MatchString(parts[1]) {
		return nil, "", errors.New("invalid file cursor")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, "", errors.New("invalid file cursor")
	}
	return &createdAt, parts[1], nil
}

func encodeLibraryCursor(file LibraryFile) string {
	return base64.RawURLEncoding.EncodeToString([]byte(file.CreatedAt.UTC().Format(time.RFC3339Nano) + "\n" + file.ID))
}

func (s *PostgresStore) ChannelFiles(ctx context.Context, room, user string, filter LibraryFilter) (FileLibraryPage, error) {
	page := FileLibraryPage{Files: []LibraryFile{}}
	if _, err := s.RoomForMember(room, user); err != nil {
		return page, err
	}
	cursorTime, cursorID, err := decodeLibraryCursor(filter.Cursor)
	if err != nil {
		return page, err
	}
	rows, err := s.DB.Query(ctx, `SELECT a.id::text,a.filename,a.content_type,a.size_bytes,a.room_id::text,a.message_id::text,a.uploader_id::text,COALESCE(u.name,'Deleted account'),a.created_at FROM message_attachments a LEFT JOIN users u ON u.id=a.uploader_id LEFT JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND can_access_room(a.room_id,$2) AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND a.deleted_at IS NULL AND ((a.message_id IS NOT NULL AND m.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id AND asset.room_id=a.room_id)) AND ($3='' OR a.content_type LIKE $3||'%' OR ($3='document' AND a.content_type NOT LIKE 'image/%' AND a.content_type NOT LIKE 'audio/%' AND a.content_type NOT LIKE 'video/%')) AND ($4='' OR a.uploader_id=NULLIF($4,'')::uuid) AND ($5::timestamptz IS NULL OR a.created_at>=$5) AND ($6::timestamptz IS NULL OR a.created_at<$6) AND ($7::timestamptz IS NULL OR (a.created_at,a.id)<($7,NULLIF($8,'')::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $9`, room, user, filter.Kind, filter.Author, filter.From, filter.To, cursorTime, cursorID, filter.Limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var f LibraryFile
		if err = rows.Scan(&f.ID, &f.Filename, &f.ContentType, &f.SizeBytes, &f.RoomID, &f.MessageID, &f.AuthorID, &f.AuthorName, &f.CreatedAt); err != nil {
			return page, err
		}
		page.Files = append(page.Files, f)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Files) > filter.Limit {
		page.Files = page.Files[:filter.Limit]
		page.Cursor = encodeLibraryCursor(page.Files[len(page.Files)-1])
	}
	return page, nil
}
func (s *PostgresStore) DeleteLibraryFile(ctx context.Context, room, user, id string) (string, string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)
	if err = lockRoomCommunity(ctx, tx, room); err != nil {
		return "", "", err
	}
	var key, message string
	// Match ordinary message mutations: lock the parent message before its
	// attachment, and bump its version so connected clients remove the preview.
	if err = tx.QueryRow(ctx, `SELECT m.id::text FROM messages m JOIN message_attachments a ON a.message_id=m.id WHERE a.id=$1 AND a.room_id=$2 AND m.deleted_at IS NULL FOR UPDATE OF m`, id, room).Scan(&message); err != nil {
		return "", "", norm(err)
	}
	err = tx.QueryRow(ctx, `UPDATE message_attachments a SET deleted_at=COALESCE(a.deleted_at,clock_timestamp()) WHERE a.id=$1 AND a.room_id=$2 AND a.message_id=$4 AND a.upload_state='ready' AND a.deleted_at IS NULL AND can_access_room(a.room_id,$3) AND (a.uploader_id=$3 OR room_has_permission(a.room_id,$3,'moderate')) AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id) RETURNING object_key`, id, room, user, message).Scan(&key)
	if err != nil {
		return "", "", norm(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET version=version+1 WHERE id=$1`, message); err != nil {
		return "", "", err
	}
	return key, message, tx.Commit(ctx)
}
