//go:build !ios

package main

import (
	"encoding/json"
	"errors"
)

func iosBroadcastCommand(string, json.RawMessage) (any, error) {
	return nil, errors.New("Screen broadcast requires the iPhone app")
}

func iosBroadcastWatchSignaling(func() bool, func() uint64) {}
func iosBroadcastSignalingClosed()                          {}
