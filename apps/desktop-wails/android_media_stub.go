//go:build !android

package main

import (
	"context"
	"encoding/json"
	"errors"
)

func androidCallAudio(bool) error { return errors.New("Android call audio requires the Android app") }
func androidScreenCommand(context.Context, string, json.RawMessage) (any, error) {
	return nil, errors.New("Android screen sharing requires the Android app")
}
func androidWatchSignaling(func() bool, func() uint64) {}
func androidSignalingClosed()                          {}
