// Package startup owns only BetterComms' opt-in OS login registration.
package startup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Status struct {
	Available        bool   `json:"available"`
	Enabled          bool   `json:"enabled"`
	ApprovalRequired bool   `json:"approvalRequired"`
	Detail           string `json:"detail"`
}

func StatusFor(development bool) (Status, error) {
	if development {
		return Status{Detail: "Install BetterComms to enable launch at login. Development executables are temporary."}, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return Status{}, err
	}
	return status(filepath.Clean(executable))
}
func SetEnabled(development, enabled bool) (Status, error) {
	if development {
		return Status{}, errors.New("Launch at login requires the installed app")
	}
	executable, err := os.Executable()
	if err != nil {
		return Status{}, err
	}
	return set(filepath.Clean(executable), enabled)
}

func command(executable string) (string, error) {
	if !filepath.IsAbs(executable) || strings.ContainsAny(executable, "\"\r\n\x00") {
		return "", errors.New("Invalid installed executable path")
	}
	value := "\"" + executable + "\""
	if len(value) > 260 {
		return "", errors.New("Installed executable path is too long for Windows launch at login")
	}
	return value, nil
}
