//go:build !android

package main

import "bettercomms/desktop-wails/internal/native/nativertc"

func closeMetaHub(h *nativertc.Hub) { h.Close() }
