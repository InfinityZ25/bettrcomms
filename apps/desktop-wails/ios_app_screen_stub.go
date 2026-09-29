//go:build !ios

package main

import "errors"

func iosAppScreenStart() error { return errors.New("iPhone screen capture requires the iOS app") }
func iosAppScreenStop() error  { return nil }
