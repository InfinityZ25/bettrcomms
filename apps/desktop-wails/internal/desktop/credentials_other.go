//go:build !windows

package desktop

// No credential store is ported off Windows.
//
// This host ships for Windows, and a stub that quietly wrote a file would be
// worse than an honest absence: the session would look protected without being
// so. The session simply does not persist here, and the boot report says it.

func storeSecret(string, []byte) error { return ErrNoCredentialStore }

func loadSecret(string) ([]byte, error) { return nil, ErrNoSecret }

func deleteSecret(string) error { return nil }

func credentialsAvailable() bool { return false }
