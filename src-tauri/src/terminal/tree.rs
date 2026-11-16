use portable_pty::Child;

pub struct ProcessTree {
    #[cfg(windows)]
    _job: windows::Job,
    #[cfg(unix)]
    session: libc::pid_t,
}

impl ProcessTree {
    #[cfg(windows)]
    pub fn adopt(child: &dyn Child) -> Result<Self, String> {
        let process = child
            .as_raw_handle()
            .ok_or("terminal: shell has no process handle")?;
        let job = windows::Job::kill_on_close()?;
        job.assign(process)?;
        Ok(ProcessTree { _job: job })
    }

    #[cfg(unix)]
    pub fn adopt(child: &dyn Child) -> Result<Self, String> {
        let pid = child.process_id().ok_or("terminal: shell has no pid")?;
        let session = libc::pid_t::try_from(pid).map_err(|_| "terminal: pid out of range")?;
        Ok(ProcessTree { session })
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unix::terminate(self.session);
    }
}

#[cfg(windows)]
mod windows {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::RawHandle;
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const KILLED_EXIT_CODE: u32 = 1;

    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object reference, usable from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close() -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err(format!("terminal: CreateJobObject: {}", std::io::Error::last_os_error()));
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(format!("terminal: SetInformationJobObject: {}", std::io::Error::last_os_error()));
                }
                Ok(job)
            }
        }

        pub fn assign(&self, process: RawHandle) -> Result<(), String> {
            let ok = unsafe { AssignProcessToJobObject(self.0, process as HANDLE) };
            if ok == 0 {
                return Err(format!("terminal: AssignProcessToJobObject: {}", std::io::Error::last_os_error()));
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                TerminateJobObject(self.0, KILLED_EXIT_CODE);
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    use libc::pid_t;

    const HANGUP_GRACE: Duration = Duration::from_millis(400);
    const POLL: Duration = Duration::from_millis(25);

    pub fn terminate(session: pid_t) {
        signal_members(session, libc::SIGHUP);
        signal_members(session, libc::SIGCONT);
        let deadline = Instant::now() + HANGUP_GRACE;
        while Instant::now() < deadline && !members(session).is_empty() {
            sleep(POLL);
        }
        signal_members(session, libc::SIGKILL);
    }

    fn signal_members(session: pid_t, signal: libc::c_int) {
        for pid in members(session) {
            unsafe { libc::kill(pid, signal) };
        }
    }

    pub fn members(session: pid_t) -> Vec<pid_t> {
        let own = std::process::id() as pid_t;
        all_pids()
            .into_iter()
            .filter(|&pid| pid != own && pid > 0)
            .filter(|&pid| unsafe { libc::getsid(pid) } == session)
            .collect()
    }

    #[cfg(target_os = "linux")]
    fn all_pids() -> Vec<pid_t> {
        std::fs::read_dir("/proc")
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    fn all_pids() -> Vec<pid_t> {
        const HEADROOM: usize = 64;
        // proc_listallpids with a null buffer returns the current pid count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0 as pid_t; count as usize + HEADROOM];
        let bytes = (pids.len() * std::mem::size_of::<pid_t>()) as libc::c_int;
        let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(filled.max(0) as usize);
        pids
    }
}
