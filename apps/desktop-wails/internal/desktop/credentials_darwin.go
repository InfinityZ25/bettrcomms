//go:build darwin && cgo

package desktop

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <TargetConditionals.h>
#include <stdlib.h>

static CFMutableDictionaryRef bc_query(const char *target) {
    CFStringRef account = CFStringCreateWithCString(NULL, target, kCFStringEncodingUTF8);
    if (!account) return NULL;
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, CFSTR("com.bettrcomms.session"));
    CFDictionarySetValue(query, kSecAttrAccount, account);
    CFRelease(account);
    return query;
}

static OSStatus bc_save(const char *target, const void *bytes, size_t length) {
    CFMutableDictionaryRef query = bc_query(target);
    if (!query) return errSecParam;
    CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)length);
    if (!data) { CFRelease(query); return errSecAllocate; }
    CFMutableDictionaryRef update = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(update, kSecValueData, data);
    OSStatus status = SecItemUpdate(query, update);
    if (status == errSecItemNotFound) {
        CFDictionarySetValue(query, kSecValueData, data);
#if TARGET_OS_IPHONE
        CFDictionarySetValue(query, kSecAttrAccessible,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
#endif
        status = SecItemAdd(query, NULL);
    }
    CFRelease(update);
    CFRelease(data);
    CFRelease(query);
    return status;
}

static OSStatus bc_load(const char *target, CFDataRef *result) {
    CFMutableDictionaryRef query = bc_query(target);
    if (!query) return errSecParam;
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    OSStatus status = SecItemCopyMatching(query, (CFTypeRef *)result);
    CFRelease(query);
    return status;
}

static OSStatus bc_delete(const char *target) {
    CFMutableDictionaryRef query = bc_query(target);
    if (!query) return errSecParam;
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    return status;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func storeSecret(target string, secret []byte) error {
	if len(secret) == 0 {
		return fmt.Errorf("refusing an empty session credential")
	}
	name := C.CString(target)
	defer C.free(unsafe.Pointer(name))
	if status := C.bc_save(name, unsafe.Pointer(&secret[0]), C.size_t(len(secret))); status != C.errSecSuccess {
		return fmt.Errorf("Keychain could not save the session (status %d)", int(status))
	}
	return nil
}

func loadSecret(target string) ([]byte, error) {
	name := C.CString(target)
	defer C.free(unsafe.Pointer(name))
	var data C.CFDataRef
	status := C.bc_load(name, &data)
	if status == C.errSecItemNotFound {
		return nil, ErrNoSecret
	}
	if status != C.errSecSuccess {
		return nil, fmt.Errorf("Keychain could not load the session (status %d)", int(status))
	}
	defer C.CFRelease(C.CFTypeRef(data))
	return C.GoBytes(unsafe.Pointer(C.CFDataGetBytePtr(data)), C.int(C.CFDataGetLength(data))), nil
}

func deleteSecret(target string) error {
	name := C.CString(target)
	defer C.free(unsafe.Pointer(name))
	status := C.bc_delete(name)
	if status == C.errSecSuccess || status == C.errSecItemNotFound {
		return nil
	}
	return fmt.Errorf("Keychain could not delete the session (status %d)", int(status))
}

func credentialsAvailable() bool { return true }
