package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

type assetCleanupStorage struct {
	*multipartFixture
	attempted []string
	deleted   []string
	fail      bool
}

func (s *assetCleanupStorage) Delete(ctx context.Context, key string) error {
	s.attempted = append(s.attempted, key)
	if s.fail {
		return errors.New("temporary S3 deletion failure")
	}
	s.deleted = append(s.deleted, key)
	return s.multipartFixture.Delete(ctx, key)
}

func TestRegisteredAssetCleanupAfterAccountDeletionIntegration(t *testing.T) {
	for _, test := range []struct {
		name      string
		ownerless bool
		retry     bool
	}{{name: "account_deleted"}, {name: "ownerless", ownerless: true}, {name: "account_deleted_retry", retry: true}} {
		t.Run(test.name, func(t *testing.T) {
			store := conversationTestStore(t)
			ctx := context.Background()
			users := socialUsers(t, store, 3)
			owner, departing, outsider := users[0], users[1], users[2]
			community, err := store.CreateCommunity(owner.ID, "Keep healthy assets", "", "general")
			if err != nil {
				t.Fatal(err)
			}
			room := community.Channels[0].ID
			socialFriend(t, store, owner.ID, departing.ID)
			if err = store.AddCommunityMember(community.ID, owner.ID, departing.ID); err != nil {
				t.Fatal(err)
			}
			storage := &assetCleanupStorage{multipartFixture: newMultipartFixture()}
			api := New(store, Sessions{Store: store}, Config{AppURL: "http://localhost"})
			api.Attachments = storage
			ownerCookie, _ := issueAccountSession(t, api, owner)
			departingCookie, _ := issueAccountSession(t, api, departing)
			png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")
			if err != nil {
				t.Fatal(err)
			}
			upload := func(user User) (MessageAttachment, string) {
				t.Helper()
				cookie := ownerCookie
				if user.ID == departing.ID {
					cookie = departingCookie
				}
				var body bytes.Buffer
				writer := multipart.NewWriter(&body)
				file, err := writer.CreateFormFile("file", "sticker.png")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = file.Write(png); err != nil {
					t.Fatal(err)
				}
				if err = writer.Close(); err != nil {
					t.Fatal(err)
				}
				request := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room+"/attachments", &body)
				request.Header.Set("Content-Type", writer.FormDataContentType())
				request.Header.Set("Origin", "http://localhost")
				request.AddCookie(cookie)
				response := httptest.NewRecorder()
				api.Handler().ServeHTTP(response, request)
				if response.Code != 201 {
					t.Fatalf("upload: %d %s", response.Code, response.Body.String())
				}
				var result struct {
					Attachment MessageAttachment `json:"attachment"`
				}
				if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if err = store.CreateChannelMediaAsset(room, user.ID, result.Attachment.ID, "Registered sticker", "sticker", nil); err != nil {
					t.Fatal(err)
				}
				var asset string
				if err = store.DB.QueryRow(ctx, `SELECT id::text FROM channel_media_assets WHERE attachment_id=$1`, result.Attachment.ID).Scan(&asset); err != nil {
					t.Fatal(err)
				}
				return result.Attachment, asset
			}
			removed, removedAsset := upload(departing)
			healthy, healthyAsset := upload(owner)
			removedMessage, _, err := store.SendStickerMessage(room, owner.ID, removedAsset, "11111111-1111-4111-8111-111111111111")
			if err != nil {
				t.Fatal(err)
			}
			healthyMessage, _, err := store.SendStickerMessage(room, owner.ID, healthyAsset, "22222222-2222-4222-8222-222222222222")
			if err != nil {
				t.Fatal(err)
			}
			if err = store.UpdateRoomStorage(ctx, community.ID, owner.ID, removed.SizeBytes+healthy.SizeBytes, 1); err != nil {
				t.Fatal(err)
			}
			// Registered, healthy sources outlive both pending-upload and room retention limits.
			if _, err = store.DB.Exec(ctx, `UPDATE message_attachments SET created_at=clock_timestamp()-interval '48 hours'`); err != nil {
				t.Fatal(err)
			}
			if err = api.CleanStorageFeatures(ctx); err != nil {
				t.Fatal(err)
			}
			if err = store.CleanPendingAttachments(ctx, storage); err != nil || len(storage.attempted) != 0 {
				t.Fatalf("healthy registered sources were cleaned: attempted=%v error=%v", storage.attempted, err)
			}
			if test.ownerless {
				if _, err = store.DB.Exec(ctx, `UPDATE message_attachments SET uploader_id=NULL WHERE id=$1`, removed.ID); err != nil {
					t.Fatal(err)
				}
			} else {
				confirmation, _ := json.Marshal(map[string]string{"confirmation": "DELETE", "email": departing.Email})
				accountHTTP(t, api, departingCookie, "DELETE", "/me/account", string(confirmation), 200)
				accountHTTP(t, api, departingCookie, "GET", "/me", "", 401)
				if _, _, err = store.AttachmentForMember(room, owner.ID, removed.ID); !errors.Is(err, ErrNotFound) {
					t.Fatalf("deleted account source remained downloadable: %v", err)
				}
			}
			removedKey, healthyKey := "messages/"+removed.ID, "messages/"+healthy.ID
			if test.retry {
				storage.fail = true
				if err = store.CleanPendingAttachments(ctx, storage); err == nil {
					t.Fatal("failed S3 deletion was not reported")
				}
				var count int
				if err = store.DB.QueryRow(ctx, `SELECT count(*) FROM message_attachments WHERE id=$1 AND deleted_at IS NOT NULL`, removed.ID).Scan(&count); err != nil || count != 1 {
					t.Fatalf("failed cleanup lost its retry tombstone: count=%d error=%v", count, err)
				}
				if err = store.DB.QueryRow(ctx, `SELECT count(*) FROM message_asset_links WHERE asset_id=$1`, removedAsset).Scan(&count); err != nil || count != 1 {
					t.Fatalf("failed cleanup prematurely removed references: count=%d error=%v", count, err)
				}
				storage.fail = false
			}
			if err = store.CleanPendingAttachments(ctx, storage); err != nil {
				t.Fatal(err)
			}
			if len(storage.deleted) != 1 || storage.deleted[0] != removedKey {
				t.Fatalf("S3 cleanup deleted=%v wanted=[%s]", storage.deleted, removedKey)
			}
			for _, attempted := range storage.attempted {
				if attempted != removedKey {
					t.Fatalf("cleanup touched a healthy source: %s", attempted)
				}
			}
			storage.mu.Lock()
			_, removedPresent := storage.objects[removedKey]
			_, healthyPresent := storage.objects[healthyKey]
			storage.mu.Unlock()
			if removedPresent || !healthyPresent {
				t.Fatalf("object state after cleanup: removed=%v healthy=%v", removedPresent, healthyPresent)
			}
			var files, assets, links int
			if err = store.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM message_attachments),(SELECT count(*) FROM channel_media_assets),(SELECT count(*) FROM message_asset_links)`).Scan(&files, &assets, &links); err != nil || files != 1 || assets != 1 || links != 1 {
				t.Fatalf("cleanup failed to cascade: files=%d assets=%d links=%d error=%v", files, assets, links, err)
			}
			policy, err := store.RoomStorage(ctx, community.ID, owner.ID)
			if err != nil || policy.UsedBytes != healthy.SizeBytes || policy.ReservedBytes != 0 || policy.CleanupBytes != 0 || policy.Files != 1 {
				t.Fatalf("cleanup retained storage usage: %+v error=%v", policy, err)
			}
			if key, _, err := store.AttachmentForMember(room, owner.ID, healthy.ID); err != nil || key != healthyKey {
				t.Fatalf("healthy source lost download access: key=%s error=%v", key, err)
			}
			if _, _, err = store.AttachmentForMember(room, outsider.ID, healthy.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("outsider gained source access: %v", err)
			}
			if _, _, err = store.AttachmentForMember(room, owner.ID, removed.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("removed source remained downloadable: %v", err)
			}
			message, err := store.MessageByID(room, removedMessage.ID)
			if err != nil || len(message.Attachments) != 0 {
				t.Fatalf("removed source remained in sticker message: %+v error=%v", message, err)
			}
			message, err = store.MessageByID(room, healthyMessage.ID)
			if err != nil || len(message.Attachments) != 1 || message.Attachments[0].ID != healthy.ID {
				t.Fatalf("healthy sticker reference changed: %+v error=%v", message, err)
			}
			if err = api.CleanStorageFeatures(ctx); err != nil {
				t.Fatal(err)
			}
			if err = store.CleanPendingAttachments(ctx, storage); err != nil || len(storage.deleted) != 1 {
				t.Fatalf("repeat cleanup touched healthy assets: deleted=%v error=%v", storage.deleted, err)
			}
		})
	}
}
