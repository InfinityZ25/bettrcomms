// Package nativeprocess gives native helper processes app-lifetime ownership.
//
// Every FFmpeg child must be attached immediately after it starts and before
// its pipes are handed to worker goroutines. Windows then terminates all
// attached processes when the last job handle closes, including abnormal app
// exits where no Go deferred function runs.
package nativeprocess

import "os/exec"

// Attach binds a started child process to this application's lifetime.
//
// It must be called after the process exists and before anything long-running
// takes ownership of its pipes, so a crash between those two points cannot
// leave an orphan holding a capture device.
func Attach(cmd *exec.Cmd) error { return attach(cmd) }
