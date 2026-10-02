package api

import (
	"net/http"
	"strings"
)

func lifecycleMutation(method, path string) bool {
	if method == http.MethodGet || method == http.MethodHead {
		return false
	}
	return path == "me/account" || strings.HasPrefix(path, "me/sessions/") || strings.HasPrefix(path, "friends/") || strings.HasPrefix(path, "privacy/blocks/") || strings.HasPrefix(path, "dm-requests/") || strings.HasSuffix(path, "/ownership") || strings.Contains(path, "/members") || strings.Contains(path, "/moderation") || method == http.MethodDelete && strings.HasPrefix(path, "rooms/") && len(strings.Split(path, "/")) == 2
}
