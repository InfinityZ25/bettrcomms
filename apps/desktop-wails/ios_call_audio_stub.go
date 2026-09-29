//go:build !ios

package main

import "errors"

func iosCallAudioStart() error { return errors.New("iOS call audio requires the iPhone app") }
func iosCallAudioStop() error  { return nil }
