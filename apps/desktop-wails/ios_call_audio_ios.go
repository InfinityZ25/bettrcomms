//go:build ios

package main

/*
int bc_call_audio_start(void);
void bc_call_audio_stop(void);
*/
import "C"

import "errors"

func iosCallAudioStart() error {
	if C.bc_call_audio_start() == 0 {
		return errors.New("iOS could not activate the call audio session")
	}
	return nil
}

func iosCallAudioStop() error { C.bc_call_audio_stop(); return nil }
