//go:build ios

package desktop

import (
	"fmt"
	"net/url"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// shellOpen uses Wails' UIKit URL opener on iOS. There is no xdg-open (or
// desktop shell) in an iPhone app bundle.
func shellOpen(target string) error {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("could not open an invalid sign-in URL")
	}
	application.Mobile.OpenURL(target)
	return nil
}
