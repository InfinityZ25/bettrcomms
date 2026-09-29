//go:build !ios

package main

import "errors"

var errMetaCameraUnavailable = errors.New("Meta glasses camera requires the iOS app")

func metaCameraConnect() error { return errMetaCameraUnavailable }
func metaCameraStart() error   { return errMetaCameraUnavailable }
func metaCameraStop() error    { return nil }

func metaCameraSetPublishing(bool) error { return errMetaCameraUnavailable }

func metaCameraLog(message string) {}
