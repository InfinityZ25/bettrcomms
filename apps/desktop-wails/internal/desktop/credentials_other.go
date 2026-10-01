//go:build !windows && !android && (!darwin || !cgo)

package desktop

// Platforms without an OS credential store keep sessions for this process only.

func storeSecret(string, []byte) error { return ErrNoCredentialStore }

func loadSecret(string) ([]byte, error) { return nil, ErrNoSecret }

func deleteSecret(string) error { return nil }

func credentialsAvailable() bool { return false }
