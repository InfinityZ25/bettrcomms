package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type multipartFixture struct {
	mu              sync.Mutex
	parts           map[string]map[int32][]byte
	objects         map[string][]byte
	starts          int
	failPart        bool
	started         chan struct{}
	release         chan struct{}
	completeStarted chan struct{}
	completeRelease chan struct{}
}

func newMultipartFixture() *multipartFixture {
	return &multipartFixture{parts: make(map[string]map[int32][]byte), objects: make(map[string][]byte)}
}
func (s *multipartFixture) Put(_ context.Context, key string, body io.Reader, _ int64, _ string) error {
	data, err := io.ReadAll(body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = data
	return err
}
func (*multipartFixture) URL(context.Context, string, string, string, bool) (string, error) {
	return "https://example.test/private", nil
}
func (s *multipartFixture) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}
func (s *multipartFixture) BeginMultipart(_ context.Context, key, _ string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.starts++
	s.parts[key] = make(map[int32][]byte)
	return "multipart-" + key, nil
}
func (s *multipartFixture) PutPart(ctx context.Context, key, _ string, part int32, body io.Reader, _ int64, checksum string) (string, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != checksum {
		return "", errors.New("bad storage checksum")
	}
	if s.started != nil {
		s.started <- struct{}{}
		select {
		case <-s.release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failPart {
		s.failPart = false
		return "", errors.New("network interrupted")
	}
	s.parts[key][part] = data
	return strconv.Itoa(int(part)), nil
}
func (s *multipartFixture) CompleteMultipart(_ context.Context, key, _ string, parts []AttachmentPart) error {
	s.mu.Lock()
	if _, exists := s.objects[key]; exists {
		s.mu.Unlock()
		return errors.New("already completed")
	}
	var data []byte
	for _, part := range parts {
		data = append(data, s.parts[key][part.Number]...)
	}
	s.mu.Unlock()
	if s.completeStarted != nil {
		s.completeStarted <- struct{}{}
		<-s.completeRelease
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = data
	delete(s.parts, key)
	return nil
}

func TestResumableFinalizationLeasePreservesCancelledCleanupKeyIntegration(t *testing.T) {
	store, a, user, room, cookie, storage := storageTestAPI(t)
	upload := startUploadTest(t, a, cookie, room.ID, 5)
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, []byte("hello")); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	storage.completeStarted = make(chan struct{}, 1)
	storage.completeRelease = make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(storage.completeRelease) }) }
	t.Cleanup(release)
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", strings.NewReader("{}"))
		r.AddCookie(cookie)
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, r)
		completed <- response
	}()
	select {
	case <-storage.completeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("finalization did not start")
	}
	// Another request cannot concurrently assemble/scan the same object.
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", 409)
	accountHTTP(t, a, cookie, "DELETE", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 204)
	if err := a.CleanStorageFeatures(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := store.CleanPendingAttachments(context.Background(), storage); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.DB.QueryRow(context.Background(), `SELECT count(*) FROM message_attachments WHERE id=$1 AND deleted_at IS NOT NULL`, upload.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("cleanup erased an in-flight finalization key", count, err)
	}
	release()
	select {
	case response := <-completed:
		if response.Code != 404 {
			t.Fatal("cancelled finalization returned success", response.Code, response.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled finalization did not finish")
	}
	storage.mu.Lock()
	_, exists := storage.objects["messages/"+upload.ID]
	storage.mu.Unlock()
	if exists {
		t.Fatal("late S3 completion recreated a cancelled object")
	}
	if _, _, err := store.AttachmentForMember(room.ID, user.ID, upload.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cancelled object remained downloadable", err)
	}
	if _, err := store.DB.Exec(context.Background(), `UPDATE attachment_uploads SET finalize_until=clock_timestamp()-interval '1 second' WHERE id=$1`, upload.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.CleanPendingAttachments(context.Background(), storage); err != nil {
		t.Fatal(err)
	}
	if err := store.DB.QueryRow(context.Background(), `SELECT count(*) FROM message_attachments WHERE id=$1`, upload.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("expired lease blocked successful cleanup", count, err)
	}
}
func (s *multipartFixture) AbortMultipart(_ context.Context, key, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.parts, key)
	return nil
}
func (s *multipartFixture) Open(_ context.Context, key string) (io.ReadCloser, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.objects[key]
	if !ok {
		return nil, 0, errors.New("missing object")
	}
	return io.NopCloser(bytes.NewReader(data)), int64(len(data)), nil
}
func (s *multipartFixture) ObjectSize(_ context.Context, key string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.objects[key]
	if !ok {
		return 0, errors.New("missing object")
	}
	return int64(len(data)), nil
}

type scannerFixture struct{ err error }

type gatedScannerFixture struct{ started, release chan struct{} }

func (*gatedScannerFixture) Ping(context.Context) error { return nil }
func (s *gatedScannerFixture) Scan(ctx context.Context, _ io.Reader, _ int64) error {
	s.started <- struct{}{}
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestResumableFinalizationReleasesSingleConnectionPoolDuringScanIntegration(t *testing.T) {
	store, a, _, room, cookie, _ := storageTestAPI(t)
	config := store.DB.Config()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store.DB = pool
	scanner := &gatedScannerFixture{started: make(chan struct{}, 1), release: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(scanner.release) }) }
	t.Cleanup(release)
	a.StorageFeatures = &StorageFeatureOptions{Scanner: scanner, ScanMaxBytes: 1 << 20}
	upload := startUploadTest(t, a, cookie, room.ID, 5)
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, []byte("hello")); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	requestCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", strings.NewReader("{}"))
		request = request.WithContext(requestCtx)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, request)
		completed <- response
	}()
	select {
	case <-scanner.started:
	case <-time.After(3 * time.Second):
		t.Fatal("single-connection completion blocked before reaching scanner")
	}
	queryCtx, queryCancel := context.WithTimeout(context.Background(), time.Second)
	defer queryCancel()
	var available int
	if err = store.DB.QueryRow(queryCtx, `SELECT 1`).Scan(&available); err != nil || available != 1 {
		t.Fatal("scanner retained the only database connection", err)
	}
	accountHTTP(t, a, cookie, "GET", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 200)
	release()
	select {
	case response := <-completed:
		if response.Code != 200 {
			t.Fatal("single-connection finalization failed", response.Code, response.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("single-connection finalization did not complete")
	}
	var token *string
	if err = store.DB.QueryRow(context.Background(), `SELECT finalize_token::text FROM attachment_uploads WHERE id=$1`, upload.ID).Scan(&token); err != nil || token != nil {
		t.Fatal("completed owner token was not released", token, err)
	}
}

func (s *scannerFixture) Ping(context.Context) error                   { return s.err }
func (s *scannerFixture) Scan(context.Context, io.Reader, int64) error { return s.err }

func startUploadTest(t *testing.T, a *API, cookie *http.Cookie, room string, size int64) ResumableUpload {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"filename": "notes.txt", "size_bytes": size, "fingerprint": "original-local-file"})
	response := accountHTTP(t, a, cookie, "POST", "/rooms/"+room+"/uploads", string(body), 201)
	var result struct {
		Upload ResumableUpload `json:"upload"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Upload
}
func chunkRequest(a *API, cookie *http.Cookie, room, id string, offset int64, data []byte) *httptest.ResponseRecorder {
	sum := sha256.Sum256(data)
	request := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room+"/uploads/"+id+"/chunks", bytes.NewReader(data))
	request.AddCookie(cookie)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Upload-Offset", strconv.FormatInt(offset, 10))
	request.Header.Set("X-Chunk-SHA256", hex.EncodeToString(sum[:]))
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	return response
}
func storageTestAPI(t *testing.T) (*PostgresStore, *API, User, Room, *http.Cookie, *multipartFixture) {
	t.Helper()
	store := conversationTestStore(t)
	user, err := store.UpsertDevUser("storage@example.test", "Uploader")
	if err != nil {
		t.Fatal(err)
	}
	room, err := store.CreateRoom(user.ID, "Storage room")
	if err != nil {
		t.Fatal(err)
	}
	a := New(store, Sessions{Store: store}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, user)
	storage := newMultipartFixture()
	a.Attachments = storage
	return store, a, user, room, cookie, storage
}

func TestFileLibraryPaginationSurvivesDeletedCursorIntegration(t *testing.T) {
	store, a, user, room, cookie, _ := storageTestAPI(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 10, 1, 12, 0, 0, 123456000, time.UTC)
	want := make(map[string]bool)
	for range 5 {
		upload := startUploadTest(t, a, cookie, room.ID, 5)
		if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, []byte("hello")); response.Code != http.StatusOK {
			t.Fatal(response.Body.String())
		}
		accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", http.StatusOK)
		if _, _, err := store.SendThreadMessage(room.ID, user.ID, "shared file", "", "", []string{upload.ID}, ""); err != nil {
			t.Fatal(err)
		}
		// Identical timestamps exercise the UUID tie-breaker as well as deletion.
		if _, err := store.DB.Exec(ctx, `UPDATE message_attachments SET created_at=$2 WHERE id=$1`, upload.ID, createdAt); err != nil {
			t.Fatal(err)
		}
		want[upload.ID] = true
	}
	readPage := func(cursor string) FileLibraryPage {
		t.Helper()
		response := accountHTTP(t, a, cookie, "GET", "/rooms/"+room.ID+"/files?limit=2&cursor="+url.QueryEscape(cursor), "", http.StatusOK)
		var page FileLibraryPage
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	first := readPage("")
	if len(first.Files) != 2 || first.Cursor == "" {
		t.Fatal("missing first page or cursor", first)
	}
	deletedID := first.Files[1].ID
	accountHTTP(t, a, cookie, "DELETE", "/rooms/"+room.ID+"/files/"+deletedID, "", http.StatusNoContent)
	var exists bool
	if err := store.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM message_attachments WHERE id=$1)`, deletedID).Scan(&exists); err != nil || exists {
		t.Fatal("cursor attachment was not physically deleted", exists, err)
	}
	second := readPage(first.Cursor)
	if len(second.Files) != 2 || second.Cursor == "" {
		t.Fatal("deleting the cursor lost older files", second)
	}
	third := readPage(second.Cursor)
	if len(third.Files) != 1 || third.Cursor != "" {
		t.Fatal("incorrect last page", third)
	}
	seen := make(map[string]bool)
	for _, page := range []FileLibraryPage{first, second, third} {
		for _, file := range page.Files {
			if !want[file.ID] || seen[file.ID] {
				t.Fatal("pagination returned an unknown or repeated attachment", file.ID)
			}
			seen[file.ID] = true
		}
	}
	if len(seen) != len(want) {
		t.Fatal("pagination omitted an attachment", seen, want)
	}
	accountHTTP(t, a, cookie, "GET", "/rooms/"+room.ID+"/files?cursor=invalid", "", http.StatusBadRequest)
}

func TestResumableUploadPersistsOffsetsAcrossAPIRestartIntegration(t *testing.T) {
	store, a, user, room, cookie, storage := storageTestAPI(t)
	first := bytes.Repeat([]byte("a"), int(AttachmentChunkBytes))
	last := []byte("last committed bytes")
	upload := startUploadTest(t, a, cookie, room.ID, int64(len(first)+len(last)))
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, first); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if _, _, err := store.AttachmentForMember(room.ID, user.ID, upload.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("unfinished upload was downloadable", err)
	}
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, first); response.Code != 200 {
		t.Fatal("idempotent duplicate failed", response.Body.String())
	}
	other := bytes.Repeat([]byte("b"), int(AttachmentChunkBytes))
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, other); response.Code != 409 {
		t.Fatal("different chunk overwrote committed bytes", response.Code)
	}
	// New API process, same durable database and private object storage.
	restarted := New(store, Sessions{Store: store}, Config{AppURL: "http://localhost"})
	restarted.Attachments = storage
	response := accountHTTP(t, restarted, cookie, "GET", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 200)
	var status struct {
		Upload ResumableUpload `json:"upload"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &status)
	if status.Upload.Offset != AttachmentChunkBytes {
		t.Fatal("restart lost upload offset")
	}
	storage.failPart = true
	if response := chunkRequest(restarted, cookie, room.ID, upload.ID, AttachmentChunkBytes, last); response.Code != 502 {
		t.Fatal(response.Code)
	}
	response = accountHTTP(t, restarted, cookie, "GET", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 200)
	_ = json.Unmarshal(response.Body.Bytes(), &status)
	if status.Upload.Offset != AttachmentChunkBytes {
		t.Fatal("failed chunk advanced offset")
	}
	if response := chunkRequest(restarted, cookie, room.ID, upload.ID, AttachmentChunkBytes, last); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	accountHTTP(t, restarted, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", 200)
	accountHTTP(t, restarted, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", 200)
	if storage.starts != 1 {
		t.Fatal("resume created a new multipart upload", storage.starts)
	}
	storage.mu.Lock()
	data := append([]byte(nil), storage.objects["messages/"+upload.ID]...)
	storage.mu.Unlock()
	if !bytes.Equal(data, append(first, last...)) {
		t.Fatal("stored bytes did not match original")
	}
	secondCookie, _ := issueAccountSession(t, restarted, user)
	accountHTTP(t, restarted, secondCookie, "GET", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 404)
	message, _, err := store.SendThreadMessage(room.ID, user.ID, "shared file", "", "", []string{upload.ID}, "")
	if err != nil {
		t.Fatal(err)
	}
	page, err := store.ChannelFiles(context.Background(), room.ID, user.ID, LibraryFilter{Limit: 50, Author: user.ID})
	if err != nil || len(page.Files) != 1 || page.Files[0].MessageID == nil || *page.Files[0].MessageID != message.ID {
		t.Fatal("file library did not include shared attachment", page, err)
	}
}
func TestStorageQuotaReservationAndScanQuarantineIntegration(t *testing.T) {
	store, a, user, room, cookie, _ := storageTestAPI(t)
	ctx := context.Background()
	if err := store.UpdateRoomStorage(ctx, *room.CommunityID, user.ID, 32, 0); err != nil {
		t.Fatal(err)
	}
	upload := startUploadTest(t, a, cookie, room.ID, 20)
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads", `{"filename":"second.txt","size_bytes":20,"fingerprint":"second"}`, 409)
	policy, err := store.RoomStorage(ctx, *room.CommunityID, user.ID)
	if err != nil || policy.ReservedBytes != 20 {
		t.Fatal("quota did not reserve full file size", policy, err)
	}
	accountHTTP(t, a, cookie, "DELETE", "/rooms/"+room.ID+"/uploads/"+upload.ID, "", 204)
	scanner := &scannerFixture{err: ErrScannerUnavailable}
	a.StorageFeatures = &StorageFeatureOptions{Scanner: scanner, ScanMaxBytes: 1 << 20}
	upload = startUploadTest(t, a, cookie, room.ID, 5)
	if response := chunkRequest(a, cookie, room.ID, upload.ID, 0, []byte("hello")); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", 503)
	if _, _, err = store.AttachmentForMember(room.ID, user.ID, upload.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("quarantine file became downloadable", err)
	}
	if _, _, err = store.SendThreadMessage(room.ID, user.ID, "", "", "", []string{upload.ID}, ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("quarantine file was attachable", err)
	}
	scanner.err = nil
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+upload.ID+"/complete", "{}", 200)
	if _, _, err = store.AttachmentForMember(room.ID, user.ID, upload.ID); err != nil {
		t.Fatal("clean file did not become ready", err)
	}
	infected := startUploadTest(t, a, cookie, room.ID, 3)
	if response := chunkRequest(a, cookie, room.ID, infected.ID, 0, []byte("bad")); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	scanner.err = ErrAttachmentInfected
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/uploads/"+infected.ID+"/complete", "{}", 415)
	var scan string
	var deleted *time.Time
	if err = store.DB.QueryRow(ctx, `SELECT scan_state,deleted_at FROM message_attachments WHERE id=$1`, infected.ID).Scan(&scan, &deleted); err != nil || scan != "rejected" || deleted == nil {
		t.Fatal("infected file lost its rejection tombstone", scan, deleted, err)
	}
}
func TestResumableUploadRevocationAndCommunityDeletionDoNotDeadlockIntegration(t *testing.T) {
	for _, scenario := range []string{"session revoked", "community deleted"} {
		t.Run(scenario, func(t *testing.T) {
			store, a, user, room, cookie, storage := storageTestAPI(t)
			current, _ := issueAccountSession(t, a, user)
			storage.started = make(chan struct{}, 1)
			storage.release = make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(storage.release) }) }
			t.Cleanup(release)
			upload := startUploadTest(t, a, cookie, room.ID, 5)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- chunkRequest(a, cookie, room.ID, upload.ID, 0, []byte("hello")) }()
			select {
			case <-storage.started:
			case <-time.After(3 * time.Second):
				t.Fatal("chunk did not reach object storage")
			}
			mutation := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				request := httptest.NewRequest("POST", "http://localhost/api/v1/me/sessions/revoke-others", strings.NewReader("{}"))
				if scenario == "community deleted" {
					request = httptest.NewRequest("DELETE", "http://localhost/api/v1/communities/"+*room.CommunityID, nil)
				}
				request.Header.Set("Content-Type", "application/json")
				request.AddCookie(current)
				response := httptest.NewRecorder()
				a.Handler().ServeHTTP(response, request)
				mutation <- response
			}()
			if scenario == "session revoked" {
				select {
				case response := <-mutation:
					if response.Code != 200 {
						t.Fatal(response.Code, response.Body.String())
					}
					mutation <- response
				case <-time.After(3 * time.Second):
					t.Fatal("session revocation waited on chunk I/O")
				}
			} else {
				deadline := time.NewTimer(3 * time.Second)
				ticker := time.NewTicker(5 * time.Millisecond)
				defer deadline.Stop()
				defer ticker.Stop()
				for a.accessMu.TryRLock() {
					a.accessMu.RUnlock()
					select {
					case <-ticker.C:
					case <-deadline.C:
						t.Fatal("community deletion did not enter its ACL boundary")
					}
				}
			}
			release()
			select {
			case response := <-mutation:
				if response.Code != 200 && response.Code != 204 {
					t.Fatal("mutation failed", response.Code, response.Body.String())
				}
			case <-time.After(5 * time.Second):
				t.Fatal("ACL mutation deadlocked with chunk SQL locks")
			}
			select {
			case response := <-done:
				if response.Code != 401 && response.Code != 403 && response.Code != 404 {
					t.Fatal("revoked chunk returned success", response.Code, response.Body.String())
				}
			case <-time.After(5 * time.Second):
				t.Fatal("chunk deadlocked after ACL mutation")
			}
			if err := a.CleanStorageFeatures(context.Background()); err != nil {
				t.Fatal(err)
			}
			storage.mu.Lock()
			_, object := storage.objects["messages/"+upload.ID]
			_, parts := storage.parts["messages/"+upload.ID]
			storage.mu.Unlock()
			if object || parts {
				t.Fatal("revoked private multipart bytes were retained")
			}
			var ready bool
			if err := store.DB.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM message_attachments WHERE id=$1 AND deleted_at IS NULL AND upload_state='ready')`, upload.ID).Scan(&ready); err != nil || ready {
				t.Fatal("revoked upload remained attachable", ready, err)
			}
		})
	}
}
