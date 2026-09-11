//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The session is kept in Windows Credential Manager.
//
// It is the operating system's own store: the blob is encrypted under the
// signed-in Windows account, other accounts on the machine cannot read it, and
// it survives a restart. Writing the session to a file beside the application
// would give none of that — any process running as this person could read it,
// and so could anything that later copied the directory.
//
// Only the session cookie goes in. The launch token and the page token are
// per-launch secrets that are meaningless in the next process, and the sign-in
// verifier exists for seconds.

var (
	advapi32         = windows.NewLazySystemDLL("advapi32.dll")
	procCredWriteW   = advapi32.NewProc("CredWriteW")
	procCredReadW    = advapi32.NewProc("CredReadW")
	procCredDeleteW  = advapi32.NewProc("CredDeleteW")
	procCredFree     = advapi32.NewProc("CredFree")
	errorNotFound    = syscall.Errno(1168)
	credTypeGeneric  = uint32(1)
	credPersistLocal = uint32(2)
)

// maxBlob is CRED_MAX_CREDENTIAL_BLOB_SIZE. A session cookie is a few hundred
// bytes; anything approaching this is a bug rather than a session, and failing
// here says so instead of letting Windows refuse with a bare error code.
const maxBlob = 2560

// credential is CREDENTIALW. The field order and types have to match the C
// declaration exactly: Windows reads this memory directly, and a wrong offset
// would hand it a pointer from the middle of another field.
type credential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

// storeSecret writes a secret under target, replacing whatever was there.
func storeSecret(target string, secret []byte) error {
	if len(secret) == 0 {
		return deleteSecret(target)
	}
	if len(secret) > maxBlob {
		return fmt.Errorf("the secret is %d bytes, past what Credential Manager stores", len(secret))
	}

	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	user, err := windows.UTF16PtrFromString("BetterComms")
	if err != nil {
		return err
	}

	entry := credential{
		Type:               credTypeGeneric,
		TargetName:         name,
		CredentialBlobSize: uint32(len(secret)),
		CredentialBlob:     &secret[0],
		Persist:            credPersistLocal,
		UserName:           user,
	}
	if ok, _, err := procCredWriteW.Call(uintptr(unsafe.Pointer(&entry)), 0); ok == 0 {
		return fmt.Errorf("Credential Manager refused the write: %w", err)
	}
	// secret is referenced by the structure Windows just copied from, so it has
	// to outlive the call rather than be collected during it.
	runtime.KeepAlive(secret)
	return nil
}

// loadSecret reads back what storeSecret wrote, or ErrNoSecret.
func loadSecret(target string) ([]byte, error) {
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return nil, err
	}

	// The out-parameter is declared as a pointer rather than a uintptr so no
	// integer ever holds the only reference to memory Windows allocated.
	var raw unsafe.Pointer
	ok, _, callErr := procCredReadW.Call(
		uintptr(unsafe.Pointer(name)),
		uintptr(credTypeGeneric),
		0,
		uintptr(unsafe.Pointer(&raw)),
	)
	if ok == 0 {
		if errors.Is(callErr, errorNotFound) {
			return nil, ErrNoSecret
		}
		return nil, fmt.Errorf("Credential Manager refused the read: %w", callErr)
	}
	defer procCredFree.Call(uintptr(raw))

	entry := (*credential)(raw)
	if entry.CredentialBlobSize == 0 || entry.CredentialBlob == nil {
		return nil, ErrNoSecret
	}
	if entry.CredentialBlobSize > maxBlob {
		return nil, fmt.Errorf("Credential Manager returned %d bytes", entry.CredentialBlobSize)
	}
	// Copied before CredFree runs: the slice below points into memory Windows
	// owns and is about to release.
	return append([]byte(nil), unsafe.Slice(entry.CredentialBlob, entry.CredentialBlobSize)...), nil
}

// deleteSecret removes a stored secret. Removing one that is not there
// succeeds, because the caller's intent — nothing stored under this name — is
// already true.
func deleteSecret(target string) error {
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	ok, _, callErr := procCredDeleteW.Call(uintptr(unsafe.Pointer(name)), uintptr(credTypeGeneric), 0)
	if ok == 0 && !errors.Is(callErr, errorNotFound) {
		return fmt.Errorf("Credential Manager refused the delete: %w", callErr)
	}
	return nil
}

// credentialsAvailable reports whether this platform has a store.
func credentialsAvailable() bool { return true }
