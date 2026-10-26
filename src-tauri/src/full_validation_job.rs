//! One native-parent-owned validation job. Cleanup is confirmed by kernel accounting, never a sleep/PID guess.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_INVALID_PARAMETER,
        HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::JobObjects::{
        CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
        JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    },
};

/// Prefix distinguishes an unconfirmed cleanup from an ordinary failed/canceled workflow.
pub(crate) const CLEANUP_UNCONFIRMED: &str = "OWNED_VALIDATION_CLEANUP_UNCONFIRMED";

/// Win32 handles are process-wide; retaining the integer value avoids exposing an unowned raw pointer.
pub(crate) struct OwnedValidationJob {
    handle: isize,
    pub name: String,
    confirmed: Arc<AtomicBool>,
}

impl OwnedValidationJob {
    /// Create a unique parent job with original optimizer bounds before any host can spawn Python.
    #[cfg(windows)]
    pub fn create(confirmed: Arc<AtomicBool>) -> Result<Self, String> {
        let name = format!(
            "Local\\DotaTel.Validation.{}",
            uuid::Uuid::new_v4().simple()
        );
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe {
            SetLastError(0);
        }
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) };
        let error = unsafe { GetLastError() };
        if handle.is_null() {
            return Err(format!(
                "Owned validation job creation failed (Windows {error})."
            ));
        }
        if error == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            };
            return Err(
                "The random validation job name already exists; refusing to join foreign work."
                    .into(),
            );
        }
        let job = Self {
            handle: handle as isize,
            name,
            confirmed,
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        limits.BasicLimitInformation.ActiveProcessLimit = 16;
        limits.JobMemoryLimit = 2 * 1024 * 1024 * 1024;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(format!(
                "Owned validation job limits failed ({}).",
                std::io::Error::last_os_error()
            ));
        }
        job.confirmed.store(false, Ordering::Release);
        // Assignment happens only in the verified host, which immediately closes its temporary join handle.
        Ok(job)
    }

    /// Windows process-tree guarantees must not silently degrade on another platform.
    #[cfg(not(windows))]
    pub fn create(_confirmed: Arc<AtomicBool>) -> Result<Self, String> {
        Err("Full validation requires Windows parent-owned process containment.".into())
    }

    /// Request termination, then observe ActiveProcesses zero while the native parent still owns the job.
    #[cfg(windows)]
    pub async fn terminate_and_drain(&self) -> Result<(), String> {
        let members = self.member_handles()?;
        self.terminate()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.is_empty()? && members_signaled(&members)? {
                self.confirmed.store(true, Ordering::Release);
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("{CLEANUP_UNCONFIRMED}: owned process termination could not be confirmed; restart the application before running another engine job."));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[cfg(not(windows))]
    pub async fn terminate_and_drain(&self) -> Result<(), String> {
        Err("Windows validation cleanup is unavailable.".into())
    }

    /// Issue termination only to this exact private job handle, never to a global process name.
    #[cfg(windows)]
    fn terminate(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.handle as HANDLE, 1) } == 0 {
            return Err(format!("{CLEANUP_UNCONFIRMED}: owned job termination failed ({}); restart before running another engine job.",std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// Native accounting is authoritative; waiting on the job object itself does not mean empty.
    #[cfg(windows)]
    fn is_empty(&self) -> Result<bool, String> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.handle as HANDLE,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(format!("{CLEANUP_UNCONFIRMED}: owned job accounting failed ({}); restart before running another engine job.",std::io::Error::last_os_error()));
        }
        Ok(accounting.ActiveProcesses == 0)
    }
}

impl Drop for OwnedValidationJob {
    /// Future drop still terminates/drains the private job; last-handle close is a final OS backstop.
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            if !self.confirmed.load(Ordering::Acquire) {
                self.drain_on_drop();
            }
            unsafe {
                CloseHandle(self.handle as HANDLE);
            }
        }
    }
}

#[cfg(windows)]
impl OwnedValidationJob {
    /// Destructors cannot await; bound synchronous kernel observation to five seconds before fail-closed state.
    fn drain_on_drop(&self) {
        let Ok(members) = self.member_handles() else {
            let _ = self.terminate();
            return;
        };
        if self.terminate().is_err() {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self
                .is_empty()
                .and_then(|empty| Ok(empty && members_signaled(&members)?))
            {
                Ok(true) => {
                    self.confirmed.store(true, Ordering::Release);
                    return;
                }
                Err(_) => return,
                Ok(false) => {}
            }
            if Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Snapshot only PIDs reported by this exact bounded job, opening handles before requesting termination.
#[cfg(windows)]
impl OwnedValidationJob {
    fn member_handles(&self) -> Result<Vec<JobMemberHandle>, String> {
        let mut list = JobMembers::default();
        if unsafe {
            QueryInformationJobObject(
                self.handle as HANDLE,
                JobObjectBasicProcessIdList,
                (&mut list as *mut JobMembers).cast(),
                std::mem::size_of_val(&list) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(format!(
                "{CLEANUP_UNCONFIRMED}: owned job member query failed ({}).",
                std::io::Error::last_os_error()
            ));
        }
        if list.listed > 16 || list.assigned > 16 {
            return Err(format!(
                "{CLEANUP_UNCONFIRMED}: owned job exceeded its bounded member list."
            ));
        }
        let mut handles = Vec::new();
        for pid in list.pids.into_iter().take(list.listed as usize) {
            if let Some(handle) = open_job_member(self.handle as HANDLE, pid)? {
                handles.push(handle);
            }
        }
        Ok(handles)
    }
}

/// Native flexible-array list has room for the job's exact 16-process cap, including its host.
#[cfg(windows)]
#[derive(Default)]
#[repr(C)]
struct JobMembers {
    assigned: u32,
    listed: u32,
    pids: [usize; 16],
}

/// Synchronization handles preserve process identity through asynchronous kernel object rundown.
#[cfg(windows)]
struct JobMemberHandle(isize);
#[cfg(windows)]
impl Drop for JobMemberHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

/// A process can vanish after enumeration; otherwise require exact job membership before observing it.
#[cfg(windows)]
fn open_job_member(job: HANDLE, pid: usize) -> Result<Option<JobMemberHandle>, String> {
    let pid = u32::try_from(pid)
        .map_err(|_| format!("{CLEANUP_UNCONFIRMED}: invalid owned process identifier."))?;
    let handle = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    if handle.is_null() {
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(format!(
            "{CLEANUP_UNCONFIRMED}: owned process handle could not be opened ({}).",
            std::io::Error::last_os_error()
        ));
    }
    let handle = JobMemberHandle(handle as isize);
    let mut belongs = 0;
    if unsafe { IsProcessInJob(handle.0 as HANDLE, job, &mut belongs) } == 0 {
        return Err(format!(
            "{CLEANUP_UNCONFIRMED}: owned process membership could not be confirmed."
        ));
    }
    Ok((belongs != 0).then_some(handle))
}

/// ActiveProcesses zero alone precedes full process signaling on Windows; require both observations.
#[cfg(windows)]
fn members_signaled(members: &[JobMemberHandle]) -> Result<bool, String> {
    for member in members {
        match unsafe { WaitForSingleObject(member.0 as HANDLE, 0) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Ok(false),
            _ => {
                return Err(format!(
                    "{CLEANUP_UNCONFIRMED}: owned process termination observation failed."
                ))
            }
        }
    }
    Ok(true)
}
