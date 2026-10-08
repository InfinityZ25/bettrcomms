package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/aws/smithy-go"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func (a *API) storageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrStorageQuota):
		a.fail(w, 409, "storage_quota_exceeded", "The room storage quota is full. Ask an administrator to remove files or increase the quota.")
	case errors.Is(err, ErrUploadOffset):
		a.fail(w, 409, "upload_offset_conflict", "Upload progress changed. Read the upload status and resume from its stored offset.")
	case errors.Is(err, ErrAttachmentInfected):
		a.fail(w, 415, "infected_file", "This file was rejected by the malware scanner.")
	case errors.Is(err, ErrScannerUnavailable):
		a.fail(w, 503, "scanner_unavailable", "The malware scanner is unavailable or cannot scan this file. The upload remains private.")
	default:
		a.result(w, nil, err)
	}
}
func (a *API) routeAttachmentFeatures(w http.ResponseWriter, r *http.Request, path string, user User) bool {
	p := strings.Split(path, "/")
	storageRoute := len(p) >= 3 && ((p[0] == "rooms" && (p[2] == "uploads" || p[2] == "files")) || (p[0] == "communities" && p[2] == "storage"))
	if !storageRoute {
		return false
	}
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "storage is unavailable")
		return true
	}
	if !uuidPattern.MatchString(p[1]) {
		a.fail(w, 404, "not_found", "room not found")
		return true
	}
	if p[0] == "communities" && len(p) == 3 {
		if r.Method == http.MethodGet {
			policy, err := store.RoomStorage(r.Context(), p[1], user.ID)
			a.result(w, map[string]any{"storage": policy, "scanner": a.scannerConfig()}, err)
			return true
		}
		if r.Method == http.MethodPatch {
			var body struct {
				Quota     int64 `json:"quota_bytes"`
				Retention int   `json:"retention_days"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.Quota < 0 || body.Quota > 8796093022208 || body.Retention < 0 || body.Retention > 3650 {
				a.fail(w, 400, "invalid_policy", "quota must be 0–8 TiB and retention 0–3650 days; zero disables a limit")
				return true
			}
			err := store.UpdateRoomStorage(r.Context(), p[1], user.ID, body.Quota, body.Retention)
			if err != nil {
				a.storageError(w, err)
			} else {
				policy, e := store.RoomStorage(r.Context(), p[1], user.ID)
				a.result(w, map[string]any{"storage": policy}, e)
			}
			return true
		}
	} else if p[0] == "rooms" && p[2] == "files" {
		if len(p) == 3 && r.Method == http.MethodGet {
			filter, err := parseLibraryFilter(r)
			if err != nil {
				a.fail(w, 400, "invalid_filter", err.Error())
				return true
			}
			page, err := store.ChannelFiles(r.Context(), p[1], user.ID, filter)
			a.result(w, page, err)
			return true
		}
		if len(p) >= 4 && !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "file not found")
			return true
		}
		if len(p) == 4 && r.Method == http.MethodDelete {
			key, messageID, err := store.DeleteLibraryFile(r.Context(), p[1], user.ID, p[3])
			if err != nil {
				a.storageError(w, err)
				return true
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if a.Attachments != nil && a.Attachments.Delete(ctx, key) == nil {
				_, _ = store.DB.Exec(ctx, `DELETE FROM message_attachments WHERE id=$1 AND deleted_at IS NOT NULL`, p[3])
			}
			if message, loadErr := store.MessageByID(p[1], messageID); loadErr == nil {
				a.publishChatUpdate(message)
			}
			w.WriteHeader(http.StatusNoContent)
			return true
		}
		if len(p) == 5 && p[4] == "preview" && r.Method == http.MethodGet {
			a.previewPDF(w, r, user, p[1], p[3], store)
			return true
		}
	} else if p[0] == "rooms" && p[2] == "uploads" {
		storage, ok := a.Attachments.(MultipartAttachmentStorage)
		if !ok {
			a.fail(w, 503, "resumable_unavailable", "resumable attachment storage is not configured")
			return true
		}
		if _, err := store.RoomForMember(p[1], user.ID); err != nil {
			a.storageError(w, err)
			return true
		}
		if len(p) == 3 && r.Method == http.MethodPost {
			a.startResumable(w, r, user, p[1], store)
			return true
		}
		if len(p) == 3 && r.Method == http.MethodGet {
			uploads, err := store.ListResumableUploads(r.Context(), p[1], user.ID, sessionFrom(r))
			a.result(w, map[string]any{"uploads": uploads}, err)
			return true
		}
		if len(p) >= 4 && !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "upload not found")
			return true
		}
		if len(p) == 4 && r.Method == http.MethodGet {
			upload, err := store.ResumableUpload(r.Context(), p[1], user.ID, sessionFrom(r), p[3])
			a.result(w, map[string]any{"upload": upload}, err)
			return true
		}
		if len(p) == 4 && r.Method == http.MethodDelete {
			upload, err := store.ResumableUpload(r.Context(), p[1], user.ID, sessionFrom(r), p[3])
			if err != nil {
				a.storageError(w, err)
				return true
			}
			a.cancelResumable(store, storage, upload)
			w.WriteHeader(http.StatusNoContent)
			return true
		}
		if len(p) == 5 && p[4] == "chunks" && r.Method == http.MethodPost {
			a.uploadChunk(w, r, user, p[1], p[3], store, storage)
			return true
		}
		if len(p) == 5 && p[4] == "complete" && r.Method == http.MethodPost {
			a.finishResumable(w, r, user, p[1], p[3], store, storage)
			return true
		}
	}
	a.fail(w, 405, "method_not_allowed", "method not allowed")
	return true
}
func parseLibraryFilter(r *http.Request) (LibraryFilter, error) {
	q := r.URL.Query()
	f := LibraryFilter{Author: q.Get("author"), Cursor: q.Get("cursor"), Limit: 50}
	switch q.Get("type") {
	case "":
	case "image", "audio", "video":
		f.Kind = q.Get("type") + "/"
	case "pdf":
		f.Kind = "application/pdf"
	case "document":
		f.Kind = "document"
	default:
		return f, errors.New("invalid file type")
	}
	if f.Author != "" && !uuidPattern.MatchString(f.Author) {
		return f, errors.New("invalid author")
	}
	if _, _, err := decodeLibraryCursor(f.Cursor); err != nil {
		return f, err
	}
	if q.Get("limit") != "" {
		value, err := strconv.Atoi(q.Get("limit"))
		if err != nil || value < 1 || value > 100 {
			return f, errors.New("limit must be 1–100")
		}
		f.Limit = value
	}
	for _, entry := range []struct {
		key    string
		target **time.Time
	}{{"from", &f.From}, {"to", &f.To}} {
		if q.Get(entry.key) != "" {
			value, err := time.Parse(time.RFC3339, q.Get(entry.key))
			if err != nil {
				return f, errors.New("dates must use RFC3339")
			}
			*entry.target = &value
		}
	}
	if f.From != nil && f.To != nil && !f.From.Before(*f.To) {
		return f, errors.New("end date must follow start date")
	}
	return f, nil
}
func (a *API) uploadSession(r *http.Request, user User) error {
	session, err := a.Sessions.Resolve(r)
	if err != nil || session.UserID != user.ID || session.ID != sessionFrom(r) {
		return errors.New("upload session revoked")
	}
	return nil
}
func (a *API) startResumable(w http.ResponseWriter, r *http.Request, user User, room string, store *PostgresStore) {
	if !a.limiter.allow("attachment-upload:"+user.ID, 12, time.Minute) {
		w.Header().Set("Retry-After", "60")
		a.fail(w, 429, "rate_limited", "too many uploads")
		return
	}
	var body struct {
		Filename    string `json:"filename"`
		Size        int64  `json:"size_bytes"`
		Fingerprint string `json:"fingerprint"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.Size < 1 || body.Fingerprint == "" || len(body.Fingerprint) > 160 {
		a.fail(w, 400, "invalid_upload", "provide a filename, size and file fingerprint")
		return
	}
	name := safeAttachmentName(body.Filename)
	if name == "" || name == "." || name == ".." {
		a.fail(w, 400, "invalid_upload", "invalid filename")
		return
	}
	if body.Size > a.attachmentMaxBytes() {
		a.fail(w, 413, "file_too_large", "file exceeds the configured size limit")
		return
	}
	if a.scanner() != nil && a.StorageFeatures.ScanMaxBytes > 0 && body.Size > a.StorageFeatures.ScanMaxBytes {
		a.storageError(w, ErrScannerUnavailable)
		return
	}
	id, err := randomAttachmentID()
	if err != nil {
		a.storageError(w, err)
		return
	}
	attachment := MessageAttachment{ID: id, Filename: name, ContentType: "application/octet-stream", SizeBytes: body.Size}
	scan := "not_required"
	if a.scanner() != nil {
		scan = "pending"
	}
	err = store.CreateResumableUpload(r.Context(), room, user.ID, sessionFrom(r), "messages/"+id, body.Fingerprint, attachment, scan)
	if err != nil {
		a.storageError(w, err)
		return
	}
	upload, err := store.ResumableUpload(r.Context(), room, user.ID, sessionFrom(r), id)
	a.resultStatus(w, map[string]any{"upload": upload}, err, http.StatusCreated)
}
func (a *API) uploadChunk(w http.ResponseWriter, r *http.Request, user User, room, id string, store *PostgresStore, storage MultipartAttachmentStorage) {
	if err := a.uploadSession(r, user); err != nil {
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	if err := store.CheckPosting(room, user.ID); err != nil {
		a.storageError(w, err)
		return
	}
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	checksum := strings.ToLower(r.Header.Get("X-Chunk-SHA256"))
	decoded, decodeErr := hex.DecodeString(checksum)
	if err != nil || offset < 0 || decodeErr != nil || len(decoded) != sha256.Size {
		a.fail(w, 400, "invalid_chunk", "provide a valid upload offset and SHA-256 checksum")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, AttachmentChunkBytes)
	defer r.Body.Close()
	file, err := os.CreateTemp("", "bettercomms-chunk-*")
	if err != nil {
		a.fail(w, 503, "upload_failed", "temporary storage unavailable")
		return
	}
	defer func() { file.Close(); os.Remove(file.Name()) }()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			a.fail(w, 413, "chunk_too_large", "chunks must be 8 MiB or less")
		} else {
			a.fail(w, 400, "invalid_chunk", "chunk was interrupted")
		}
		return
	}
	if size < 1 || hex.EncodeToString(hash.Sum(nil)) != checksum {
		a.fail(w, 400, "checksum_mismatch", "chunk checksum did not match its bytes")
		return
	}
	ctx := r.Context()
	tx, err := store.DB.Begin(ctx)
	if err != nil {
		a.storageError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	// Attachment then upload matches the FK cascade order. No room/ACL lock is
	// held across S3 I/O. A cancelled
	// request retains the last committed offset; a retry replaces the same S3 part.
	var locked string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM message_attachments WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		a.storageError(w, norm(err))
		return
	}
	upload, err := scanResumable(tx.QueryRow(ctx, uploadSelect+" FOR UPDATE OF u", id, room, user.ID, sessionFrom(r)))
	if err != nil {
		a.storageError(w, err)
		return
	}
	if offset < upload.Offset {
		var previousSize int64
		var previousHash string
		err = tx.QueryRow(ctx, `SELECT size_bytes,checksum_sha256 FROM attachment_upload_parts WHERE upload_id=$1 AND offset_bytes=$2`, id, offset).Scan(&previousSize, &previousHash)
		if err == nil && previousSize == size && previousHash == checksum {
			_ = tx.Commit(ctx)
			a.json(w, 200, map[string]any{"upload": upload})
			return
		}
		a.storageError(w, ErrUploadOffset)
		return
	}
	if offset != upload.Offset || upload.State != "creating" && upload.State != "uploading" || offset+size > upload.Attachment.SizeBytes || size != AttachmentChunkBytes && offset+size != upload.Attachment.SizeBytes {
		a.storageError(w, ErrUploadOffset)
		return
	}
	if offset == 0 {
		var head [attachmentSniffBytes]byte
		_, _ = file.Seek(0, io.SeekStart)
		n, e := io.ReadFull(file, head[:])
		if e != nil && e != io.EOF && e != io.ErrUnexpectedEOF {
			a.storageError(w, e)
			return
		}
		contentType := attachmentContentType(head[:n])
		if !allowedAttachment(upload.Attachment.Filename, contentType) {
			a.fail(w, 415, "unsupported_file", "this file type is not supported")
			return
		}
		upload.Attachment.ContentType = contentType
		if _, err = tx.Exec(ctx, `UPDATE message_attachments SET content_type=$2 WHERE id=$1 AND deleted_at IS NULL`, id, contentType); err != nil {
			a.storageError(w, err)
			return
		}
	}
	if upload.MultipartID == "" {
		upload.MultipartID, err = storage.BeginMultipart(ctx, upload.Key, upload.Attachment.ContentType)
		if err != nil {
			a.fail(w, 502, "upload_failed", "could not begin multipart upload")
			return
		}
		if _, err = tx.Exec(ctx, `UPDATE attachment_uploads SET multipart_id=$2,state='uploading' WHERE id=$1`, id, upload.MultipartID); err != nil {
			_ = storage.AbortMultipart(context.Background(), upload.Key, upload.MultipartID)
			a.storageError(w, err)
			return
		}
		if err = tx.Commit(ctx); err != nil {
			_ = storage.AbortMultipart(context.Background(), upload.Key, upload.MultipartID)
			a.storageError(w, err)
			return
		}
		tx, err = store.DB.Begin(ctx)
		if err != nil {
			a.storageError(w, err)
			return
		}
		defer tx.Rollback(ctx)
		if err = tx.QueryRow(ctx, `SELECT id::text FROM message_attachments WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			a.storageError(w, norm(err))
			return
		}
		upload, err = scanResumable(tx.QueryRow(ctx, uploadSelect+" FOR UPDATE OF u", id, room, user.ID, sessionFrom(r)))
		if err != nil {
			a.storageError(w, err)
			return
		}
		if upload.Offset != offset || upload.State != "uploading" {
			a.storageError(w, ErrUploadOffset)
			return
		}
	}
	_, _ = file.Seek(0, io.SeekStart)
	part := int32(offset/AttachmentChunkBytes + 1)
	etag, err := storage.PutPart(ctx, upload.Key, upload.MultipartID, part, file, size, checksum)
	if err != nil {
		a.fail(w, 502, "upload_failed", "could not store this chunk; retry to resume")
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO attachment_upload_parts(upload_id,part_number,offset_bytes,size_bytes,checksum_sha256,etag) VALUES($1,$2,$3,$4,$5,$6)`, id, part, offset, size, checksum, etag); err != nil {
		a.storageError(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE attachment_uploads SET offset_bytes=$2,state='uploading',updated_at=clock_timestamp() WHERE id=$1`, id, offset+size); err != nil {
		a.storageError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		a.storageError(w, err)
		return
	}
	upload.Offset = offset + size
	upload.State = "uploading"
	a.accessMu.RLock()
	authErr := a.uploadSession(r, user)
	postingErr := store.CheckPosting(room, user.ID)
	a.accessMu.RUnlock()
	if authErr != nil || postingErr != nil {
		a.cancelResumable(store, storage, upload)
		if authErr != nil {
			a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		} else {
			a.storageError(w, postingErr)
		}
		return
	}
	a.json(w, 200, map[string]any{"upload": upload})
}
func (a *API) finishResumable(w http.ResponseWriter, r *http.Request, user User, room, id string, store *PostgresStore, storage MultipartAttachmentStorage) {
	if err := a.uploadSession(r, user); err != nil {
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	if err := store.CheckPosting(room, user.ID); err != nil {
		a.storageError(w, err)
		return
	}
	upload, err := store.ResumableUpload(r.Context(), room, user.ID, sessionFrom(r), id)
	if err != nil {
		a.storageError(w, err)
		return
	}
	if upload.State == "complete" {
		a.json(w, 200, map[string]any{"attachment": upload.Attachment})
		return
	}
	if upload.Offset != upload.Attachment.SizeBytes || upload.MultipartID == "" {
		a.storageError(w, ErrUploadOffset)
		return
	}
	// A persisted lease keeps the cleanup key until every bounded finalization
	// request has finished, including an API restart or cancel during S3 I/O.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	token, err := randomAttachmentID()
	if err != nil {
		a.storageError(w, err)
		return
	}
	tag, leaseErr := store.DB.Exec(ctx, `UPDATE attachment_uploads u SET finalize_token=$2,finalize_until=clock_timestamp()+interval '6 minutes' FROM message_attachments a WHERE u.id=$1 AND a.id=u.id AND a.deleted_at IS NULL AND u.state IN('uploading','assembled') AND (u.finalize_token IS NULL OR u.finalize_until<=clock_timestamp())`, id, token)
	if leaseErr != nil {
		a.storageError(w, leaseErr)
		return
	}
	if tag.RowsAffected() == 0 {
		latest, e := store.ResumableUpload(ctx, room, user.ID, sessionFrom(r), id)
		if e == nil && latest.State == "complete" {
			a.json(w, 200, map[string]any{"attachment": latest.Attachment})
		} else if e != nil {
			a.storageError(w, e)
		} else {
			w.Header().Set("Retry-After", "5")
			a.fail(w, 409, "upload_finalizing", "This file is already being finalized. Retry after the current request completes.")
		}
		return
	}
	upload.FinalizeToken = token
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		_, _ = store.DB.Exec(releaseCtx, `UPDATE attachment_uploads SET finalize_token=NULL WHERE id=$1 AND finalize_token=$2`, id, token)
	}()
	if upload.State != "assembled" {
		rows, e := store.DB.Query(r.Context(), `SELECT part_number,etag,checksum_sha256 FROM attachment_upload_parts WHERE upload_id=$1 ORDER BY part_number`, id)
		if e != nil {
			a.storageError(w, e)
			return
		}
		var parts []AttachmentPart
		for rows.Next() {
			var part AttachmentPart
			if e = rows.Scan(&part.Number, &part.ETag, &part.Checksum); e != nil {
				rows.Close()
				a.storageError(w, e)
				return
			}
			parts = append(parts, part)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			a.storageError(w, e)
			return
		}
		if err = storage.CompleteMultipart(r.Context(), upload.Key, upload.MultipartID, parts); err != nil {
			size, headErr := storage.ObjectSize(r.Context(), upload.Key)
			if headErr != nil || size != upload.Attachment.SizeBytes {
				a.fail(w, 502, "upload_failed", "could not finalize upload; retry to resume")
				return
			}
		}
		tag, err = store.DB.Exec(r.Context(), `UPDATE attachment_uploads u SET state='assembled',updated_at=clock_timestamp() FROM message_attachments a WHERE u.id=$1 AND a.id=u.id AND a.deleted_at IS NULL AND u.state IN('uploading','assembled') AND u.finalize_token=$2 AND u.finalize_until>clock_timestamp()`, id, token)
		if err != nil {
			a.storageError(w, err)
			return
		}
		if tag.RowsAffected() == 0 {
			latest, e := store.ResumableUpload(ctx, room, user.ID, sessionFrom(r), id)
			if e == nil && latest.State == "complete" {
				a.json(w, 200, map[string]any{"attachment": latest.Attachment})
				return
			}
			a.cancelResumable(store, storage, upload)
			a.storageError(w, ErrNotFound)
			return
		}
	}
	if scanner := a.scanner(); scanner != nil {
		body, size, e := storage.Open(r.Context(), upload.Key)
		if e != nil {
			a.storageError(w, ErrScannerUnavailable)
			return
		}
		if size != upload.Attachment.SizeBytes {
			body.Close()
			a.storageError(w, ErrScannerUnavailable)
			return
		}
		err = scanner.Scan(r.Context(), body, size)
		body.Close()
		if err != nil {
			if errors.Is(err, ErrAttachmentInfected) {
				_, _ = store.DB.Exec(r.Context(), `UPDATE message_attachments a SET scan_state='rejected' FROM attachment_uploads u WHERE a.id=$1 AND u.id=a.id AND u.finalize_token=$2 AND u.finalize_until>clock_timestamp()`, id, token)
				a.cancelResumable(store, storage, upload)
			}
			a.storageError(w, err)
			return
		}
		if _, err = store.DB.Exec(r.Context(), `UPDATE message_attachments a SET scan_state='clean' FROM attachment_uploads u WHERE a.id=$1 AND a.deleted_at IS NULL AND u.id=a.id AND u.finalize_token=$2 AND u.finalize_until>clock_timestamp()`, id, token); err != nil {
			a.storageError(w, err)
			return
		}
	}
	a.accessMu.RLock()
	authErr := a.uploadSession(r, user)
	if authErr == nil {
		err = store.CompleteResumable(r.Context(), id, room, user.ID, sessionFrom(r), token)
	}
	a.accessMu.RUnlock()
	if authErr != nil {
		a.cancelResumable(store, storage, upload)
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	if err != nil {
		a.cancelResumable(store, storage, upload)
		a.storageError(w, err)
		return
	}
	a.json(w, 200, map[string]any{"attachment": upload.Attachment})
}
func (a *API) cancelResumable(store *PostgresStore, storage MultipartAttachmentStorage, upload ResumableUpload) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := store.DB.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	var locked string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM message_attachments WHERE id=$1 FOR UPDATE`, upload.ID).Scan(&locked); err != nil {
		return
	}
	tag, err := tx.Exec(ctx, `UPDATE attachment_uploads u SET state=CASE WHEN a.scan_state='rejected' THEN 'rejected' ELSE 'cancelled' END,updated_at=clock_timestamp() FROM message_attachments a WHERE u.id=$1 AND a.id=u.id AND a.message_id IS NULL AND ($2='' OR u.finalize_token=NULLIF($2,'')::uuid) AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id)`, upload.ID, upload.FinalizeToken)
	if err != nil || tag.RowsAffected() == 0 {
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE message_attachments a SET deleted_at=COALESCE(deleted_at,clock_timestamp()),upload_state='ready' WHERE a.id=$1 AND a.message_id IS NULL AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id)`, upload.ID); err != nil {
		return
	}
	if err = tx.Commit(ctx); err != nil {
		return
	}
	if upload.MultipartID != "" {
		if err = storage.AbortMultipart(ctx, upload.Key, upload.MultipartID); err == nil || missingMultipart(err) {
			_, _ = store.DB.Exec(ctx, `UPDATE attachment_uploads SET multipart_id=NULL WHERE id=$1 AND state IN('cancelled','rejected')`, upload.ID)
		}
	}
	// Keep the committed tombstone until the ordinary cleanup worker verifies
	// object deletion. This also closes complete/cancel races without key reuse.
	_ = storage.Delete(ctx, upload.Key)
}
func (a *API) previewPDF(w http.ResponseWriter, r *http.Request, user User, room, id string, store *PostgresStore) {
	storage, ok := a.Attachments.(MultipartAttachmentStorage)
	if !ok {
		a.fail(w, 503, "unavailable", "file previews are unavailable")
		return
	}
	key, file, err := store.AttachmentForMember(room, user.ID, id)
	if err != nil {
		a.storageError(w, err)
		return
	}
	if file.ContentType != "application/pdf" {
		a.fail(w, 415, "unsupported_preview", "only PDFs support this preview")
		return
	}
	if file.SizeBytes > 20<<20 {
		a.fail(w, 413, "preview_too_large", "PDF previews support files up to 20 MiB. Download the original file to view it.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	body, size, err := storage.Open(ctx, key)
	if err != nil {
		a.fail(w, 502, "preview_failed", "could not read PDF")
		return
	}
	defer body.Close()
	if size != file.SizeBytes {
		a.fail(w, 502, "preview_failed", "PDF size changed")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	_, _ = io.Copy(w, io.LimitReader(body, size))
}

// CleanStorageFeatures aborts durable stale multipart state before attachment
// cleanup removes its key, and applies opt-in retention to ordinary files only.
func (a *API) CleanStorageFeatures(ctx context.Context) error {
	store, ok := a.Store.(*PostgresStore)
	storage, storageOK := a.Attachments.(MultipartAttachmentStorage)
	if !ok || !storageOK {
		return nil
	}
	rows, err := store.DB.Query(ctx, `SELECT u.id::text,a.object_key,COALESCE(u.multipart_id,'') FROM attachment_uploads u JOIN message_attachments a ON a.id=u.id WHERE (u.state IN('cancelled','rejected') AND u.multipart_id IS NOT NULL) OR (u.state NOT IN('complete','cancelled','rejected') AND (u.expires_at<clock_timestamp() OR a.deleted_at IS NOT NULL OR a.room_id IS NULL OR a.uploader_id IS NULL OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=u.session_id AND s.expires_at>clock_timestamp()))) ORDER BY u.updated_at LIMIT 50`)
	if err != nil {
		return err
	}
	var stale []ResumableUpload
	for rows.Next() {
		var upload ResumableUpload
		if err = rows.Scan(&upload.ID, &upload.Key, &upload.MultipartID); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, upload)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, upload := range stale {
		a.cancelResumable(store, storage, upload)
	}
	_, err = store.DB.Exec(ctx, `UPDATE message_attachments a SET deleted_at=clock_timestamp() FROM rooms r,community_storage_policies p WHERE a.room_id=r.id AND r.community_id=p.community_id AND p.retention_days>0 AND a.upload_state='ready' AND a.deleted_at IS NULL AND a.created_at<clock_timestamp()-make_interval(days=>p.retention_days) AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id)`)
	return err
}

func missingMultipart(err error) bool {
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "NoSuchUpload"
}
