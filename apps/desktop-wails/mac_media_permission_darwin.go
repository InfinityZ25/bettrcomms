//go:build darwin && !ios

package main

/*
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdbool.h>
#include <stdlib.h>

void bettercommsInstallMediaPermissionDelegate(void);
bool bettercommsMediaPermissionDelegateIsInstalled(void);
bool bettercommsTrustedMediaOrigin(const char *originScheme, const char *originHost,
    long originPort, bool mainFrame, const char *pageScheme, const char *pageHost,
    bool pageHasPort, long mediaType);
*/
import "C"

import "unsafe"

// Referencing the Objective-C translation unit also links its WKUIDelegate
// category into the macOS app. Wails owns the delegate object itself.
func init() {
	C.bettercommsInstallMediaPermissionDelegate()
}

func macMediaPermissionDelegateInstalled() bool {
	return bool(C.bettercommsMediaPermissionDelegateIsInstalled())
}

func trustedMacMediaOrigin(originScheme, originHost string, originPort int, mainFrame bool, pageScheme, pageHost string, pageHasPort bool, mediaType int) bool {
	scheme := C.CString(originScheme)
	host := C.CString(originHost)
	pageSchemeValue := C.CString(pageScheme)
	pageHostValue := C.CString(pageHost)
	defer C.free(unsafe.Pointer(scheme))
	defer C.free(unsafe.Pointer(host))
	defer C.free(unsafe.Pointer(pageSchemeValue))
	defer C.free(unsafe.Pointer(pageHostValue))
	return bool(C.bettercommsTrustedMediaOrigin(scheme, host, C.long(originPort),
		C.bool(mainFrame), pageSchemeValue, pageHostValue, C.bool(pageHasPort), C.long(mediaType)))
}
