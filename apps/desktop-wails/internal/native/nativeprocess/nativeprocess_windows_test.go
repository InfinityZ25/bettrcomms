//go:build windows

package nativeprocess

import (
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestAttachRequiresAStartedProcess(t *testing.T) {
	if err := Attach(nil); err == nil {
		t.Error("a nil command was accepted")
	}
	if err := Attach(exec.Command("cmd.exe")); err == nil {
		t.Error("an unstarted command was accepted")
	}
}

// An attached child is in this application's job. Windows kills the job's
// members when the last handle closes, which is what keeps an FFmpeg process
// from outliving a crash and holding a capture device open.
func TestAttachPutsTheChildInTheApplicationJob(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "ping -n 30 127.0.0.1 >nul")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	if err := Attach(cmd); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatalf("open child: %v", err)
	}
	defer func() { _ = windows.CloseHandle(handle) }()

	job, err := processJob()
	if err != nil {
		t.Fatalf("processJob: %v", err)
	}
	assigned, err := inJob(handle, job)
	if err != nil {
		t.Fatalf("IsProcessInJob: %v", err)
	}
	if !assigned {
		t.Error("the child was not assigned to the application job")
	}
}

// The job is created once. A second attach must reuse it rather than build a
// job whose handle nothing keeps alive.
func TestTheJobIsCreatedOnce(t *testing.T) {
	first, err := processJob()
	if err != nil {
		t.Fatalf("processJob: %v", err)
	}
	second, err := processJob()
	if err != nil {
		t.Fatalf("processJob: %v", err)
	}
	if first != second {
		t.Errorf("job handles differ: %v then %v", first, second)
	}
}

// Attaching an already-exited process fails rather than reporting success.
func TestAttachRejectsAnExitedProcess(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	_ = cmd.Wait()
	// Give Windows a moment to release the PID's process object.
	time.Sleep(50 * time.Millisecond)

	if err := Attach(cmd); err == nil {
		t.Log("the exited process was still openable; Windows had not reaped it yet")
	}
}
