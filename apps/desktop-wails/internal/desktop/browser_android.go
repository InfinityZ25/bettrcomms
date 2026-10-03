//go:build android

package desktop

import (
	"errors"
	"github.com/wailsapp/wails/v3/pkg/application"
	"net/url"
)

func shellOpen(target string) error {
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("invalid external browser address")
	}
	application.Mobile.OpenURL(target)
	return nil
}
