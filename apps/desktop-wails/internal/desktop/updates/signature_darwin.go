//go:build darwin && !ios

package updates

import (
	"errors"
	"os/exec"
	"path/filepath"
	"regexp"
)

func VerifyPlatformSignature(path, teamID string) error {
	if !regexp.MustCompile("^[A-Z0-9]{10}$").MatchString(teamID) {
		return errors.New("A pinned macOS signing Team ID is required")
	}
	if filepath.Base(path) != "BetterComms.app" {
		return errors.New("The macOS update must contain BetterComms.app")
	}
	requirement := `identifier "com.bettrcomms.wails" and anchor apple generic and certificate leaf[subject.OU] = "` + teamID + `"`
	if err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", requirement, path).Run(); err != nil {
		return errors.New("The macOS update requires a valid Developer ID signature")
	}
	if err := exec.Command("/usr/sbin/spctl", "--assess", "--type", "execute", path).Run(); err != nil {
		return errors.New("The macOS update requires notarization")
	}
	return nil
}
