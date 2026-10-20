//go:build ios

package main

/*
int bc_call_audio_start(int preferBuiltInMic);
void bc_call_audio_stop(void);
*/
import "C"

import "errors"

func iosCallAudioStart(preferBuiltInMic bool) error {
	prefer := C.int(0)
	if preferBuiltInMic { prefer = 1 }
	if C.bc_call_audio_start(prefer) == 0 {
		return errors.New("iOS could not activate the call audio session")
	}
	return nil
}

func iosCallAudioStop() error { C.bc_call_audio_stop(); return nil }
