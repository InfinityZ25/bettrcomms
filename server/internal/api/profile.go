package api

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const avatarInputLimit = 256 << 10

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// Decode dimensions before pixel allocation, discard metadata and emit only PNG.
func normalizeAvatar(data []byte) ([]byte, error) {
	if len(data) == 0 || len(data) > avatarInputLimit {
		return nil, errors.New("avatar size")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 4_000_000 {
		return nil, errors.New("avatar image")
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	side := config.Width
	if config.Height < side {
		side = config.Height
	}
	outSize := side
	if outSize > 256 {
		outSize = 256
	}
	// Crop centrally; nearest-neighbour scaling is bounded and needs no decoder dependency.
	dst := image.NewNRGBA(image.Rect(0, 0, outSize, outSize))
	bounds := src.Bounds()
	left := bounds.Min.X + (config.Width-side)/2
	top := bounds.Min.Y + (config.Height-side)/2
	if outSize == side {
		draw.Draw(dst, dst.Bounds(), src, image.Pt(left, top), draw.Src)
	} else {
		for y := 0; y < outSize; y++ {
			for x := 0; x < outSize; x++ {
				dst.Set(x, y, src.At(left+x*side/outSize, top+y*side/outSize))
			}
		}
	}
	var out bytes.Buffer
	err = png.Encode(&out, dst)
	if err != nil || out.Len() > avatarInputLimit {
		return nil, errors.New("avatar encoding")
	}
	return out.Bytes(), nil
}

func validPresence(status string) bool {
	return status == "online" || status == "idle" || status == "dnd" || status == "invisible"
}

func (a *API) profile(w http.ResponseWriter, r *http.Request, u User, path string) {
	store, ok := a.Store.(ProfileStore)
	if !ok {
		a.fail(w, 503, "unavailable", "profile unavailable")
		return
	}
	if path == "me/presence" {
		if r.Method == http.MethodGet {
			status, err := store.Presence(u.ID)
			a.result(w, map[string]string{"status": status}, err)
			return
		}
		if r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		var in struct {
			Status string `json:"status"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !validPresence(in.Status) {
			a.fail(w, 400, "invalid_presence", "choose online, idle, dnd or invisible")
			return
		}
		if !a.limiter.allow("presence:"+u.ID, 60, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many presence changes")
			return
		}
		a.presenceMu.Lock()
		err := store.SetPresence(u.ID, in.Status)
		if err == nil {
			a.Realtime.setPresence(u.ID, in.Status)
		}
		a.presenceMu.Unlock()
		a.result(w, map[string]string{"status": in.Status}, err)
		return
	}
	if !a.limiter.allow("profile:"+u.ID, 30, time.Hour) {
		a.fail(w, 429, "rate_limited", "too many profile changes")
		return
	}
	var updated User
	var err error
	switch {
	case path == "me" && r.Method == http.MethodPatch:
		var in struct {
			Name     *string `json:"name"`
			Username *string `json:"username"`
			Bio      *string `json:"bio"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if in.Name == nil && in.Username == nil && in.Bio == nil {
			a.fail(w, 400, "invalid_profile", "provide profile fields")
			return
		}
		if in.Name != nil {
			value := strings.TrimSpace(*in.Name)
			in.Name = &value
			if utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 80 {
				a.fail(w, 400, "invalid_name", "name must be 1-80 characters")
				return
			}
		}
		if in.Username != nil {
			value := strings.ToLower(strings.TrimSpace(*in.Username))
			in.Username = &value
			if !usernamePattern.MatchString(value) {
				a.fail(w, 400, "invalid_username", "username must have 3-32 lowercase letters, numbers or underscores")
				return
			}
		}
		if in.Bio != nil && utf8.RuneCountInString(*in.Bio) > 160 {
			a.fail(w, 400, "invalid_bio", "bio must be at most 160 characters")
			return
		}
		updated, err = store.UpdateProfile(u.ID, ProfileUpdate{in.Name, in.Username, in.Bio})
	case path == "me/avatar" && r.Method == http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, avatarInputLimit+8192)
		if err = r.ParseMultipartForm(avatarInputLimit + 8192); err != nil {
			a.fail(w, 400, "invalid_avatar", "upload one PNG or JPEG up to 256 KB")
			return
		}
		defer r.MultipartForm.RemoveAll()
		file, _, openErr := r.FormFile("file")
		if openErr != nil {
			a.fail(w, 400, "invalid_avatar", "choose an image")
			return
		}
		defer file.Close()
		data, readErr := io.ReadAll(io.LimitReader(file, avatarInputLimit+1))
		if readErr != nil {
			a.fail(w, 400, "invalid_avatar", "could not read image")
			return
		}
		data, err = normalizeAvatar(data)
		if err != nil {
			a.fail(w, 400, "invalid_avatar", "upload a valid PNG or JPEG up to 256 KB and 4 megapixels")
			return
		}
		updated, err = store.SetAvatar(u.ID, data)
	case path == "me/avatar" && r.Method == http.MethodDelete:
		updated, err = store.SetAvatar(u.ID, nil)
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if errors.Is(err, ErrUsernameTaken) {
		a.fail(w, 409, "username_taken", "username is already taken")
		return
	}
	if err == nil {
		rooms, _ := a.Store.ListRooms(u.ID)
		a.Realtime.publishProfile(updated, rooms)
		updated.PresenceStatus, _ = store.Presence(u.ID)
	}
	a.result(w, map[string]any{"user": updated}, err)
}

func (a *API) avatar(w http.ResponseWriter, r *http.Request, u User, target string) {
	store, ok := a.Store.(ProfileStore)
	if !ok {
		a.fail(w, 503, "unavailable", "avatar unavailable")
		return
	}
	if r.Method != http.MethodGet || !uuidPattern.MatchString(target) {
		a.fail(w, 404, "not_found", "avatar not found")
		return
	}
	data, err := store.Avatar(target, u.ID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	// Authorization can change after a block/logout; the client owns its
	// account-scoped blob cache and releases it on version or session changes.
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
