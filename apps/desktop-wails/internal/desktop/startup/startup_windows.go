//go:build windows

package startup

import (
	"errors"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const valueName = "BetterComms-Wails"

func status(executable string) (Status, error) {
	expected, err := command(executable)
	if err != nil {
		return Status{}, err
	}
	result := Status{Available: true}
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer key.Close()
	value, _, err := key.GetStringValue(valueName)
	if errors.Is(err, registry.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Enabled = value == expected
	if value != expected {
		result.Detail = "Another BetterComms installation owns launch at login. Disable it there first."
	}
	return result, nil
}
func set(executable string, enabled bool) (Status, error) {
	expected, err := command(executable)
	if err != nil {
		return Status{}, err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return Status{}, err
	}
	defer key.Close()
	existing, _, err := key.GetStringValue(valueName)
	if err != nil && !errors.Is(err, registry.ErrNotExist) {
		return Status{}, err
	}
	if err == nil && existing != expected {
		return Status{}, errors.New("Another installation owns this launch registration")
	}
	if enabled {
		err = key.SetStringValue(valueName, expected)
	} else {
		err = key.DeleteValue(valueName)
		if errors.Is(err, registry.ErrNotExist) {
			err = nil
		}
	}
	if err != nil {
		return Status{}, err
	}
	return Status{Available: true, Enabled: enabled}, nil
}
