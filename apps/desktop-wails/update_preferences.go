package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func readAutomaticUpdates(config string) bool {
	bytes, err := os.ReadFile(filepath.Join(config, "BetterComms", "updates", "preferences.json"))
	if err != nil || len(bytes) > 1024 {
		return false
	}
	var value struct {
		Automatic bool `json:"automatic"`
	}
	if json.Unmarshal(bytes, &value) != nil {
		return false
	}
	return value.Automatic
}
func saveAutomaticUpdates(config string, enabled bool) error {
	path := filepath.Join(config, "BetterComms", "updates", "preferences.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	bytes, _ := json.Marshal(struct {
		Automatic bool `json:"automatic"`
	}{enabled})
	if err := os.WriteFile(path+".tmp", bytes, 0600); err != nil {
		return err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		_ = os.Remove(path + ".tmp")
		return err
	}
	return nil
}
