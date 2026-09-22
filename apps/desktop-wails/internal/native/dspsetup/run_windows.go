//go:build windows

package dspsetup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func requirePlainDirectory(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(name)
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errors.New("native setup directories must be plain directories, not reparse points")
	}
	return nil
}

type boundedOutput struct{ body []byte }

func (b *boundedOutput) Write(p []byte) (int, error) {
	remaining := 8192 - len(b.body)
	if remaining > len(p) {
		remaining = len(p)
	}
	if remaining > 0 {
		b.body = append(b.body, p[:remaining]...)
	}
	return len(p), nil
}

func runInstaller(ctx context.Context, args []string) error {
	systemRoot := os.Getenv("SystemRoot")
	if !filepath.IsAbs(systemRoot) {
		return errors.New("absolute SystemRoot is required")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(value), "PSMODULEPATH=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	var output boundedOutput
	cmd.Stderr = &output
	cmd.WaitDelay = 2 * time.Second
	// Killing the job on cancellation also terminates the extractor's children.
	cmd.Cancel = func() error {
		_ = windows.TerminateJobObject(job, 1)
		// Cancellation can race the assignment immediately after Start.
		return cmd.Process.Kill()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	child, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, child)
		_ = windows.CloseHandle(child)
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("installer failed: %s", strings.TrimSpace(string(output.body)))
	}
	return nil
}
