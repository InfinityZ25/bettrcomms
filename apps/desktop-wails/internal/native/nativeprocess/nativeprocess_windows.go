//go:build windows

package nativeprocess

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processJob is created once and never closed. Its lifetime is the process's:
// when the last handle to it goes away — including when this process is killed
// — Windows terminates everything assigned to it.
var (
	jobOnce sync.Once
	jobs    windows.Handle
	jobErr  error
)

func processJob() (windows.Handle, error) {
	jobOnce.Do(func() {
		handle, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			jobErr = fmt.Errorf("Could not create the native process job: %w", err)
			return
		}
		limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(
			handle,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&limits)),
			uint32(unsafe.Sizeof(limits)),
		); err != nil {
			_ = windows.CloseHandle(handle)
			jobErr = fmt.Errorf("Could not configure the native process job: %w", err)
			return
		}
		jobs = handle
	})
	return jobs, jobErr
}

// x/sys/windows does not wrap IsProcessInJob, which is what proves an
// assignment actually took effect rather than merely returning success.
var procIsProcessInJob = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

// inJob reports whether a process handle belongs to the given job.
func inJob(process, job windows.Handle) (bool, error) {
	var result int32
	ok, _, err := procIsProcessInJob.Call(
		uintptr(process),
		uintptr(job),
		uintptr(unsafe.Pointer(&result)),
	)
	if ok == 0 {
		return false, err
	}
	return result != 0, nil
}

func attach(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return errors.New("Native process ownership needs a started process")
	}
	job, err := processJob()
	if err != nil {
		return err
	}

	// os.Process keeps its handle private, so the child is reopened by PID.
	// Only the two rights the job assignment needs are requested.
	child, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return fmt.Errorf("Could not open the native helper process: %w", err)
	}
	defer func() { _ = windows.CloseHandle(child) }()

	if err := windows.AssignProcessToJobObject(job, child); err != nil {
		return fmt.Errorf("Could not own the native helper process: %w", err)
	}
	return nil
}
