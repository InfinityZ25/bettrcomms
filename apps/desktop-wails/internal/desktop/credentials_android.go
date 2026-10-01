//go:build android

package desktop

import "github.com/wailsapp/wails/v3/pkg/application"

// Wails dispatches these operations to Android Keystore-backed encrypted
// preferences. The session stays in the Go proxy jar, never WebView storage.
func storeSecret(target string, data []byte) error {
	return application.Mobile.SecureSet(target, string(data))
}
func loadSecret(target string) ([]byte, error) {
	value, found, err := application.Mobile.SecureGet(target)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNoSecret
	}
	return []byte(value), nil
}
func deleteSecret(target string) error { return application.Mobile.SecureDelete(target) }
func credentialsAvailable() bool {
	_, _, err := application.Mobile.SecureGet("BetterComms/store-probe")
	return err == nil
}
