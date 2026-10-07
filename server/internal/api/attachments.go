package api

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	DefaultAttachmentMaxBytes   int64 = 500 << 20
	MaximumAttachmentMaxBytes   int64 = 2 << 30
	maxVoiceNoteBytes                 = 10 << 20
	attachmentSniffBytes              = 64 << 10
	attachmentMultipartOverhead       = 1 << 20
)

func (a *API) attachmentMaxBytes() int64 {
	if a.Config.AttachmentMaxBytes <= 0 {
		return DefaultAttachmentMaxBytes
	}
	if a.Config.AttachmentMaxBytes > MaximumAttachmentMaxBytes {
		return MaximumAttachmentMaxBytes
	}
	return a.Config.AttachmentMaxBytes
}

func (a *API) attachmentConfig() map[string]any {
	return map[string]any{
		"available":            a.Attachments != nil,
		"max_file_bytes":       a.attachmentMaxBytes(),
		"max_voice_note_bytes": maxVoiceNoteBytes,
		"max_per_message":      4,
	}
}

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
	case ".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".sh", ".js", ".mjs", ".cjs", ".vbs", ".jar", ".html", ".htm", ".shtml", ".xhtml", ".svg", ".svgz":
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
	switch sniffed {
	case "application/zip":
		return ext == ".zip" || ext == ".docx" || ext == ".xlsx" || ext == ".pptx" || ext == ".odt" || ext == ".ods" || ext == ".odp" || ext == ".epub"
	case "application/x-7z-compressed":
		return ext == ".7z"
	case "application/vnd.rar":
		return ext == ".rar"
	case "application/gzip", "application/x-gzip":
		return ext == ".gz" || ext == ".tgz"
	case "application/x-bzip2":
		return ext == ".bz2" || ext == ".tbz2"
	case "application/x-xz":
		return ext == ".xz" || ext == ".txz"
	case "application/x-tar":
		return ext == ".tar"
	}
	return false
}

// ISO BMFF variants commonly use a brand other than mp4 at the start of ftyp.
// Inspect both the major and compatible brands in a bounded, complete box;
// filenames and the multipart Content-Type never authorize inline playback.
func attachmentContentType(head []byte) string {
	if contentType := isoBMFFContentType(head); contentType != "" {
		return contentType
	}
	if len(head) >= 8 && string(head[4:8]) == "ftyp" {
		return "application/octet-stream"
	}
	switch {
	case len(head) >= 4 && string(head[:4]) == "fLaC":
		return "audio/flac"
	case len(head) >= 6 && string(head[:6]) == "7z\xbc\xaf\x27\x1c":
		return "application/x-7z-compressed"
	case len(head) >= 7 && string(head[:7]) == "Rar!\x1a\x07\x00", len(head) >= 8 && string(head[:8]) == "Rar!\x1a\x07\x01\x00":
		return "application/vnd.rar"
	case len(head) >= 3 && head[0] == 0x1f && head[1] == 0x8b && head[2] == 8:
		return "application/gzip"
	case len(head) >= 4 && string(head[:3]) == "BZh" && head[3] >= '1' && head[3] <= '9':
		return "application/x-bzip2"
	case len(head) >= 6 && string(head[:6]) == "\xfd7zXZ\x00":
		return "application/x-xz"
	case len(head) >= 262 && string(head[257:262]) == "ustar":
		return "application/x-tar"
	}
	return http.DetectContentType(head)
}

func isoBMFFContentType(head []byte) string {
	if len(head) > attachmentSniffBytes {
		head = head[:attachmentSniffBytes]
	}
	for len(head) >= 8 {
		size := uint64(binary.BigEndian.Uint32(head[:4]))
		kind := string(head[4:8])
		headerSize := uint64(8)
		if size == 1 {
			if len(head) < 16 {
				return ""
			}
			size = binary.BigEndian.Uint64(head[8:16])
			headerSize = 16
		}
		if size < headerSize || size > uint64(len(head)) {
			return ""
		}
		if kind != "ftyp" {
			if kind != "free" && kind != "skip" && kind != "wide" {
				return ""
			}
			head = head[int(size):]
			continue
		}
		brands := head[int(headerSize):int(size)]
		if len(brands) < 8 || (len(brands)-8)%4 != 0 {
			return ""
		}
		var audio, video, avif, quicktime, threeGP bool
		for offset := 0; offset < len(brands); offset += 4 {
			if offset == 4 { // Minor version is an integer, not a brand.
				continue
			}
			switch string(brands[offset : offset+4]) {
			case "M4A ", "M4B ", "F4A ", "F4B ":
				audio = true
			case "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp4 ", "mp41", "mp42", "avc1", "dash", "M4V ", "MSNV":
				video = true
			case "avif", "avis":
				avif = true
			case "qt  ":
				quicktime = true
			case "3gp4", "3gp5", "3gp6", "3gp7", "3g2a", "3g2b":
				threeGP = true
			}
		}
		switch {
		case avif:
			return "image/avif"
		case audio:
			return "audio/mp4"
		case quicktime:
			return "video/quicktime"
		case threeGP:
			return "video/3gpp"
		case video:
			return "video/mp4"
		}
		return ""
	}
	return ""
}

type attachmentUpload struct {
	file      *os.File
	name      string
	size      int64
	voiceNote string
	duration  string
}

func (upload *attachmentUpload) close() {
	if upload.file != nil {
		name := upload.file.Name()
		upload.file.Close()
		os.Remove(name)
	}
}

var (
	errAttachmentTooLarge = errors.New("attachment exceeds upload limit")
	errInvalidAttachment  = errors.New("invalid attachment multipart data")
)

// Spool directly to one private temporary file instead of loading large files
// into memory. Ownership transfers to the caller only after every part parses;
// malformed bodies, disconnects and disk failures remove the partial file here.
func readAttachmentUpload(r *http.Request, limit int64) (_ *attachmentUpload, err error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, errInvalidAttachment
	}
	upload := &attachmentUpload{}
	defer func() {
		if err != nil {
			upload.close()
		}
	}()
	fields := map[string]bool{}
	for parts := 0; ; parts++ {
		part, nextErr := reader.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return nil, nextErr
		}
		if parts >= 3 || fields[part.FormName()] {
			return nil, errInvalidAttachment
		}
		fields[part.FormName()] = true
		if part.FormName() == "file" {
			upload.name = safeAttachmentName(part.FileName())
			if upload.name == "" || upload.name == "." || upload.name == ".." {
				return nil, errInvalidAttachment
			}
			upload.file, err = os.CreateTemp("", "bettercomms-upload-*")
			if err != nil {
				return nil, err
			}
			fileLimit := limit
			if upload.voiceNote == "true" {
				fileLimit = maxVoiceNoteBytes
			}
			upload.size, err = io.Copy(upload.file, io.LimitReader(part, fileLimit+1))
			if err != nil {
				return nil, err
			}
			if upload.size > fileLimit {
				return nil, errAttachmentTooLarge
			}
			continue
		}
		if part.FileName() != "" || part.FormName() != "voice_note" && part.FormName() != "duration_ms" {
			return nil, errInvalidAttachment
		}
		value, readErr := io.ReadAll(io.LimitReader(part, 129))
		if readErr != nil {
			return nil, readErr
		}
		if len(value) > 128 {
			return nil, errInvalidAttachment
		}
		if part.FormName() == "voice_note" {
			upload.voiceNote = string(value)
		} else {
			upload.duration = string(value)
		}
	}
	if upload.file == nil || upload.size < 1 {
		return nil, errInvalidAttachment
	}
	return upload, nil
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
	limit := a.attachmentMaxBytes()
	spoolLimit := limit
	if spoolLimit < maxVoiceNoteBytes {
		spoolLimit = maxVoiceNoteBytes
	}
	tooLarge := func() {
		a.fail(w, 413, "file_too_large", fmt.Sprintf("files must be %.0f MiB or less; voice notes must be 10 MiB or less", float64(limit)/(1<<20)))
	}
	if r.ContentLength > spoolLimit+attachmentMultipartOverhead {
		tooLarge()
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, spoolLimit+attachmentMultipartOverhead)
	defer r.Body.Close()
	upload, err := readAttachmentUpload(r, spoolLimit)
	if err != nil {
		var bodyLimit *http.MaxBytesError
		var diskError *os.PathError
		switch {
		case errors.Is(err, errAttachmentTooLarge), errors.As(err, &bodyLimit):
			tooLarge()
		case errors.As(err, &diskError):
			a.fail(w, 503, "upload_failed", "could not prepare temporary file storage")
		default:
			a.fail(w, 400, "invalid_upload", "could not read upload")
		}
		return
	}
	defer upload.close()
	voiceNote := upload.voiceNote == "true"
	if voiceNote && upload.size > maxVoiceNoteBytes || !voiceNote && upload.size > limit {
		tooLarge()
		return
	}
	file, name := upload.file, upload.name
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		a.fail(w, 400, "invalid_upload", "could not read file")
		return
	}
	var head [attachmentSniffBytes]byte
	count, err := io.ReadFull(file, head[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		a.fail(w, 400, "invalid_upload", "could not read file")
		return
	}
	contentType := attachmentContentType(head[:count])
	var duration *int
	if voiceNote {
		value, parseErr := strconv.Atoi(upload.duration)
		if parseErr != nil {
			a.fail(w, 400, "invalid_voice_note", "provide recording duration")
			return
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			a.fail(w, 400, "invalid_upload", "could not read file")
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxVoiceNoteBytes+1))
		if readErr != nil {
			a.fail(w, 400, "invalid_upload", "could not read file")
			return
		}
		contentType, err = validateVoiceNote(data, value)
		if err != nil {
			a.fail(w, 415, "invalid_voice_note", "record an audio-only WebM or MP4 up to two minutes")
			return
		}
		duration = &value
	} else if upload.voiceNote != "" && upload.voiceNote != "false" || upload.duration != "" {
		a.fail(w, 400, "invalid_voice_note", "invalid recording metadata")
		return
	} else if !allowedAttachment(name, contentType) {
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
	attachment := MessageAttachment{ID: id, Filename: name, ContentType: contentType, SizeBytes: upload.size, VoiceNote: voiceNote, DurationMS: duration}
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
	if err = a.Attachments.Put(r.Context(), key, file, upload.size, contentType); err != nil {
		a.discardFailedAttachment(store, id, key)
		a.fail(w, 502, "upload_failed", "could not store file")
		return
	}
	if r.Context().Err() != nil {
		a.discardFailedAttachment(store, id, key)
		return
	}
	a.accessMu.RLock()
	session, authErr = a.Sessions.Resolve(r)
	if authErr != nil || session.UserID != user.ID || session.ID != sessionFrom(r) {
		a.accessMu.RUnlock()
		a.discardFailedAttachment(store, id, key)
		a.fail(w, 401, "unauthenticated", "session was revoked during upload")
		return
	}
	err = store.CompletePendingAttachment(id, room)
	a.accessMu.RUnlock()
	if err != nil {
		a.discardFailedAttachment(store, id, key)
		a.result(w, nil, err)
		return
	}
	if r.Context().Err() != nil {
		a.discardFailedAttachment(store, id, key)
		return
	}
	// Detect a response write failure as well as cancelled S3 I/O: the client
	// cannot attach an upload whose successful response it never received.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err = json.NewEncoder(w).Encode(map[string]any{"attachment": attachment}); err != nil {
		a.discardFailedAttachment(store, id, key)
	}
}

func (a *API) discardFailedAttachment(store *PostgresStore, id, key string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Preserve a tombstone for the worker if immediate S3 cleanup fails. Pending
	// rows are never attachable while uploading or after they have been discarded.
	_ = store.DiscardPendingAttachment(cleanupCtx, id)
	if a.Attachments.Delete(cleanupCtx, key) == nil {
		_ = store.removePendingAttachment(cleanupCtx, id)
	}
}

func (a *API) deletePendingAttachment(w http.ResponseWriter, r *http.Request, user User, room, id string) {
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
	key, err := store.CancelPendingAttachment(r.Context(), room, user.ID, id)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if a.Attachments.Delete(cleanupCtx, key) == nil {
		_ = store.removePendingAttachment(cleanupCtx, id)
	}
	// The committed tombstone immediately revokes further use. Failed storage
	// deletion remains discoverable by the existing periodic cleanup worker.
	w.WriteHeader(http.StatusNoContent)
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
