//go:build android

package main

import "bettercomms/desktop-wails/internal/native/nativertc"

// Detach a stopped sender synchronously, but never close peer sockets on the
// Android main looper that delivered its JNI lifecycle callback.
func closeMetaHub(h *nativertc.Hub) { go h.Close() }
