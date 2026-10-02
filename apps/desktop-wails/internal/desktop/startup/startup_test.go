package startup

import (
	"path/filepath"
	"testing"
)

func TestStartupCannotRegisterDevelopmentExecutable(t *testing.T) {
	state, err := StatusFor(true)
	if err != nil || state.Available || state.Enabled {
		t.Fatalf("development startup: %+v %v", state, err)
	}
	if _, err := SetEnabled(true, true); err == nil {
		t.Fatal("temporary development executable registered")
	}
}
func TestCommandUsesOneQuotedExecutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "With spaces", "BetterComms.exe")
	value, err := command(path)
	if err != nil || value != "\""+path+"\"" {
		t.Fatalf("command %q %v", value, err)
	}
	for _, bad := range []string{"relative.exe", path + "\" --evil", path + "\n"} {
		if _, err := command(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
