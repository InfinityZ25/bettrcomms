//! App-lifetime ownership for native helper processes.
//!
//! Every FFmpeg child must be attached immediately after `Command::spawn` and
//! before its pipes are handed to worker threads. Windows then terminates all
//! attached processes when the last job handle closes, including abnormal app
//! exits where Rust destructors do not run.

#[cfg(windows)]
mod platform {
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Child,
        sync::OnceLock,
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        },
    };

    struct ProcessJob {
        handle: OwnedHandle,
    }

    impl ProcessJob {
        fn create() -> Result<Self, String> {
            let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|error| format!("Could not create the native process job: {error}"))?;
            // SAFETY: CreateJobObjectW returned a new owned handle. OwnedHandle
            // closes it exactly once, including when a concurrent initializer
            // loses the OnceLock race below.
            let handle = unsafe { OwnedHandle::from_raw_handle(raw.0) };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    HANDLE(handle.as_raw_handle()),
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|error| format!("Could not configure the native process job: {error}"))?;
            Ok(Self { handle })
        }

        fn attach(&self, child: &Child) -> Result<(), String> {
            unsafe {
                AssignProcessToJobObject(
                    HANDLE(self.handle.as_raw_handle()),
                    HANDLE(child.as_raw_handle()),
                )
            }
            .map_err(|error| format!("Could not own the native helper process: {error}"))
        }
    }

    static PROCESS_JOB: OnceLock<ProcessJob> = OnceLock::new();

    fn process_job() -> Result<&'static ProcessJob, String> {
        if let Some(job) = PROCESS_JOB.get() {
            return Ok(job);
        }
        let candidate = ProcessJob::create()?;
        // Another caller may win this race. Dropping our unused candidate is
        // correct because no child has been assigned to it.
        let _ = PROCESS_JOB.set(candidate);
        PROCESS_JOB
            .get()
            .ok_or_else(|| "Native process ownership could not be initialized".to_owned())
    }

    pub fn attach(child: &Child) -> Result<(), String> {
        process_job()?.attach(child)
    }
}

#[cfg(windows)]
pub use platform::attach;

#[cfg(not(windows))]
pub fn attach(_child: &std::process::Child) -> Result<(), String> {
    Err("Native process ownership is available on Windows only".to_owned())
}
