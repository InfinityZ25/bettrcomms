package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const maxAttachmentBytes = 10 << 20

type AttachmentStorage interface {
	Put(context.Context, string, io.Reader, int64, string) error
	URL(context.Context, string, string, string, bool) (string, error)
	Delete(context.Context, string) error
}

type S3AttachmentStorage struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func NewS3AttachmentStorage(config aws.Config, bucket string) *S3AttachmentStorage {
	client := s3.NewFromConfig(config)
	return &S3AttachmentStorage{client: client, presigner: s3.NewPresignClient(client), bucket: bucket}
}

func (s *S3AttachmentStorage) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: body, ContentLength: aws.Int64(size), ContentType: aws.String(contentType)})
	return err
}

func (s *S3AttachmentStorage) URL(ctx context.Context, key, filename, contentType string, inline bool) (string, error) {
	disposition := "attachment"
	if inline && (strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "audio/") || strings.HasPrefix(contentType, "video/")) {
		disposition = "inline"
	}
	result, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), ResponseContentDisposition: aws.String(mime.FormatMediaType(disposition, map[string]string{"filename": filename})), ResponseContentType: aws.String(contentType)}, s3.WithPresignExpires(5*time.Minute))
	if err != nil {
		return "", err
	}
	return result.URL, nil
}

func (s *S3AttachmentStorage) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	return err
}

func randomAttachmentID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:]), nil
}

func safeAttachmentName(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	value = strings.TrimSpace(value)
	if len([]rune(value)) > 180 {
		value = string([]rune(value)[:180])
	}
	return value
}

func allowedAttachment(name, sniffed string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".exe", ".dll", ".bat", ".cmd", ".com", ".ps1", ".sh", ".js", ".html", ".svg":
		return false
	}
	if strings.HasPrefix(sniffed, "image/") {
		return sniffed != "image/svg+xml"
	}
	if strings.HasPrefix(sniffed, "audio/") || strings.HasPrefix(sniffed, "video/") {
		return true
	}
	if strings.HasPrefix(sniffed, "text/plain") || sniffed == "application/pdf" {
		return true
	}
	return sniffed == "application/zip" && (ext == ".zip" || ext == ".docx" || ext == ".xlsx" || ext == ".pptx")
}

func (a *API) uploadAttachment(w http.ResponseWriter, r *http.Request, user User, room string) {
	if store, ok := a.Store.(*PostgresStore); ok {
		if err := store.CheckPosting(room, user.ID); err != nil {
			a.result(w, nil, err)
			return
		}
	}
	if a.Attachments == nil {
		a.fail(w, 503, "attachments_unavailable", "S3 attachments are not configured")
		return
	}
	if !a.limiter.allow("attachment-upload:"+user.ID, 12, time.Minute) {
		w.Header().Set("Retry-After", "60")
		a.fail(w, 429, "rate_limited", "too many uploads")
		return
	}
	if r.ContentLength > maxAttachmentBytes+(1<<20) {
		a.fail(w, 413, "file_too_large", "files must be 10 MB or less")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		a.fail(w, 400, "invalid_upload", "could not read upload")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		a.fail(w, 400, "invalid_upload", "choose a file")
		return
	}
	defer file.Close()
	name := safeAttachmentName(header.Filename)
	if name == "" || name == "." || header.Size < 1 || header.Size > maxAttachmentBytes {
		a.fail(w, 400, "invalid_upload", "choose a file up to 10 MB")
		return
	}
	var head [512]byte
	count, err := io.ReadFull(file, head[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		a.fail(w, 400, "invalid_upload", "could not read file")
		return
	}
	contentType := http.DetectContentType(head[:count])
	if !allowedAttachment(name, contentType) {
		a.fail(w, 415, "unsupported_file", "this file type is not supported")
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		a.fail(w, 400, "invalid_upload", "could not read file")
		return
	}
	id, err := randomAttachmentID()
	if err != nil {
		a.fail(w, 500, "internal", "could not prepare upload")
		return
	}
	key := "messages/" + id
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "attachments are unavailable")
		return
	}
	attachment := MessageAttachment{ID: id, Filename: name, ContentType: contentType, SizeBytes: header.Size}
	a.accessMu.RLock()
	session, authErr := a.Sessions.Resolve(r)
	if authErr != nil || session.UserID != user.ID || session.ID != sessionFrom(r) {
		a.accessMu.RUnlock()
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	err = store.SavePendingAttachment(room, user.ID, key, attachment)
	a.accessMu.RUnlock()
	if err != nil {
		a.result(w, nil, err)
		return
	}
	// Persist the pending key before S3 receives bytes. If the client drops or
	// S3 fails after storing the object, the periodic cleanup can still find it.
	if err = a.Attachments.Put(r.Context(), key, file, header.Size, contentType); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if a.Attachments.Delete(cleanupCtx, key) == nil {
			_ = store.RemovePendingAttachment(id)
		}
		cancel()
		a.fail(w, 502, "upload_failed", "could not store file")
		return
	}
	a.accessMu.RLock()
	session, authErr = a.Sessions.Resolve(r)
	if authErr != nil || session.UserID != user.ID || session.ID != sessionFrom(r) {
		_, _ = store.DB.Exec(context.Background(), `UPDATE message_attachments SET upload_state='ready',deleted_at=clock_timestamp() WHERE id=$1`, id)
		a.accessMu.RUnlock()
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	err = store.CompletePendingAttachment(id, room)
	a.accessMu.RUnlock()
	if err != nil {
		a.result(w, nil, err)
		return
	}
	a.json(w, 201, map[string]any{"attachment": attachment})
}

func (a *API) downloadAttachment(w http.ResponseWriter, r *http.Request, user User, room, id string) {
	if a.Attachments == nil {
		a.fail(w, 503, "attachments_unavailable", "S3 attachments are not configured")
		return
	}
	if !uuidPattern.MatchString(id) {
		a.fail(w, 404, "not_found", "attachment not found")
		return
	}
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "attachments are unavailable")
		return
	}
	key, attachment, err := store.AttachmentForMember(room, user.ID, id)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	url, err := a.Attachments.URL(r.Context(), key, attachment.Filename, attachment.ContentType, r.URL.Query().Get("inline") == "1")
	if err != nil {
		a.fail(w, 502, "download_failed", "could not open file")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if r.URL.Query().Get("link") == "1" {
		a.json(w, 200, map[string]string{"url": url})
		return
	}
	http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}
