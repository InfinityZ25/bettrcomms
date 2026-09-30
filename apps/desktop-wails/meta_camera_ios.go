//go:build ios

package main

/*
#include <stdlib.h>
void bc_meta_log(const char *message);
void bc_meta_connect(void);
void bc_meta_start(void);
void bc_meta_stop(void);
void bc_meta_set_publishing(int value);
*/
import "C"
import "unsafe"

func metaCameraConnect() error { C.bc_meta_connect(); return nil }
func metaCameraStart() error   { C.bc_meta_start(); return nil }
func metaCameraStop() error    { stopMetaSender(nil); C.bc_meta_stop(); return nil }

func metaCameraSetPublishing(value bool) error {
	n := 0
	if value {
		n = 1
	}
	C.bc_meta_set_publishing(C.int(n))
	return nil
}

//export bc_meta_video_encoded
func bc_meta_video_encoded(data unsafe.Pointer, size C.int) {
	if size <= 0 || size > 16*1024*1024 {
		return
	}
	writeMetaVideo(C.GoBytes(data, size))
}

//export bc_meta_sender_ended
func bc_meta_sender_ended() { stopMetaSender(nil) }

func metaCameraLog(message string) {
	value := C.CString(message)
	defer C.free(unsafe.Pointer(value))
	C.bc_meta_log(value)
}

//export bc_meta_encoder_control
func bc_meta_encoder_control(force *C.int) C.int {
	settings := metaEncoderControl()
	*force = 0
	if settings.ForceKeyframe {
		*force = 1
	}
	return C.int(settings.Bitrate)
}
