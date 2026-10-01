//go:build android && cgo

package main

/*
#include <stdlib.h>
#include <android/log.h>
static void bc_android_log(const char* text) { __android_log_write(ANDROID_LOG_ERROR, "BetterComms", text); }
char* bc_android_command(const char* command);
*/
import "C"
import (
	"bettercomms/desktop-wails/internal/desktop"
	"errors"
	"log"
	"os"
	"time"
	"unsafe"
)

func init() {
	log.SetOutput(androidLogWriter{})
	desktop.AndroidMetaCameraAvailable = func() bool { return androidCommand("meta:available") == nil }
}

type androidLogWriter struct{}

func (androidLogWriter) Write(value []byte) (int, error) {
	message := C.CString(string(value))
	defer C.free(unsafe.Pointer(message))
	C.bc_android_log(message)
	return len(value), nil
}

func androidCommand(command string) error {
	arg := C.CString(command)
	defer C.free(unsafe.Pointer(arg))
	response := C.bc_android_command(arg)
	if response == nil {
		return errors.New("Android native host is unavailable")
	}
	defer C.free(unsafe.Pointer(response))
	if message := C.GoString(response); message != "" {
		return errors.New(message)
	}
	return nil
}

func metaCameraConnect() error { return androidCommand("meta:connect") }
func metaCameraStart() error   { return androidCommand("meta:start") }
func metaCameraStop() error    { stopMetaSender(nil); return androidCommand("meta:stop") }
func metaCameraSetPublishing(value bool) error {
	if value {
		return androidCommand("meta:publishing")
	}
	return androidCommand("meta:preview")
}
func metaCameraLog(string) {} // Never log signaling payloads through Android's shared log.

//export bc_android_home
func bc_android_home(path *C.char) { _ = os.Setenv("HOME", C.GoString(path)) }

//export bc_android_encoded
func bc_android_encoded(kind C.int, session *C.char, data unsafe.Pointer, size C.int, micros C.longlong) {
	if size <= 0 || size > 16*1024*1024 {
		return
	}
	frame := C.GoBytes(data, size)
	if kind == 0 {
		writeMetaVideo(frame, time.Duration(micros)*time.Microsecond)
	} else if kind == 1 {
		writeAndroidScreen(C.GoString(session), frame, time.Duration(micros)*time.Microsecond)
	}
}

//export bc_android_screen_stopped
func bc_android_screen_stopped(session *C.char) { stopAndroidScreen(C.GoString(session)) }

//export bc_android_encoder_control
func bc_android_encoder_control(kind C.int, force *C.int) C.int {
	control := metaEncoderControl()
	if kind != 0 {
		control = androidScreenEncoderControl()
	}
	*force = 0
	if control.ForceKeyframe {
		*force = 1
	}
	if control.Bitrate <= 0 {
		return 3_000_000
	}
	return C.int(control.Bitrate)
}

//export bc_android_stopped
func bc_android_stopped(kind C.int) {
	if kind == 0 {
		stopMetaSender(nil)
	}
}

//export bc_android_shutdown
func bc_android_shutdown() { stopMetaSender(nil); stopAndroidScreen("") }
