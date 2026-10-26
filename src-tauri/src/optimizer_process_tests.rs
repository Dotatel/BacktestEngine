//! Actual original optimizer process mechanics with a synthetic nontrading descendant fixture.
use super::*;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

/// Retain exact kernel process identities before interruption; never kill by PID or process name.
struct ObservedProcess(isize);
impl ObservedProcess {
    /// Open synchronization access only for a PID written by this test's isolated fixture.
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(
            !handle.is_null(),
            "Fixture process {pid} was unavailable before interruption."
        );
        Self(handle as isize)
    }
    /// The process must already be signaled at return/drop; no eventual-exit polling is accepted.
    fn assert_exited(&self) {
        assert_eq!(
            unsafe { WaitForSingleObject(self.0 as HANDLE, 0) },
            WAIT_OBJECT_0
        );
    }
}
impl Drop for ObservedProcess {
    /// Release the observation handle without changing the process.
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0 as HANDLE) };
    }
}

/// Reuse the existing actual child/grandchild fixture; only adapt its entry inputs to the optimizer runner CLI.
fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/optimizer-process-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let directory = crate::build_process::workflow_directory(&directory).unwrap();
    let source = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("optimizer-host/ValidationLifecycleFixture.cs"),
    )
    .unwrap()
    .replace(
        "string role = args[0];",
        "string role = args.Length == 2 && !args[0].StartsWith(\"--\") ? args[0] : \"parent\";",
    )
    .replace(
        "string root = args[1];",
        &format!(
            "string root = {};",
            serde_json::to_string(&directory.to_string_lossy()).unwrap()
        ),
    );
    let config = synthetic_optimizer_fixture(&directory, &source);
    let sdk =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtimes/dotnet/dotnet.exe");
    let host = verify_optimizer_host(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/optimizer"),
    )
    .unwrap();
    (directory, config, sdk, host)
}

/// Observe all three actual managed descendants while they are alive, before asking the host to terminate.
async fn descendants(directory: &Path) -> Vec<ObservedProcess> {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !directory.join("grandchild.pid").is_file() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        ["parent", "child", "grandchild"]
            .iter()
            .map(|role| {
                ObservedProcess::open(
                    fs::read_to_string(directory.join(format!("{role}.pid")))
                        .unwrap()
                        .parse()
                        .unwrap(),
                )
            })
            .collect()
    })
    .await
    .expect("The original optimizer must start the actual synthetic tree.")
}

/// A real cancel/deadline must finish kernel members before the shared cleanup marker permits input reuse.
async fn stopped_case(cancel_requested: bool) {
    let (directory, config, sdk, host) = fixture();
    let cleanup = Arc::new(AtomicBool::new(true));
    let (sender, mut cancel) = oneshot::channel();
    let observer = async {
        let handles = descendants(&directory).await;
        let retained = if cancel_requested {
            sender.send(()).unwrap();
            None
        } else {
            Some(sender)
        };
        (handles, retained)
    };
    let run = process::run_optimizer(
        &sdk,
        &host,
        &config,
        &directory,
        &mut cancel,
        if cancel_requested { 120 } else { 30 },
        cleanup.clone(),
    );
    let (outcome, (handles, _sender)) = tokio::join!(run, observer);
    fs::write(
        directory.join("outcome.txt"),
        format!("syntheticProcessFixture=true\ncancel={cancel_requested}\n{outcome:?}"),
    )
    .unwrap();
    let error = outcome.unwrap_err();
    assert!(
        error.contains(if cancel_requested {
            "was canceled"
        } else {
            "exceeded 30 seconds"
        }),
        "{error}"
    );
    for handle in handles {
        handle.assert_exited();
    }
    assert!(cleanup.load(Ordering::Acquire));
}

#[tokio::test]
async fn original_optimizer_cancel_confirms_child_and_grandchild_before_return() {
    stopped_case(true).await;
}

#[tokio::test]
async fn original_optimizer_timeout_confirms_child_and_grandchild_before_return() {
    stopped_case(false).await;
}

/// Dropping a native future synchronously drains the owned job while deliberately quarantining caller ownership.
#[tokio::test]
async fn original_optimizer_future_drop_stops_tree_and_keeps_cleanup_unconfirmed() {
    let (directory, config, sdk, host) = fixture();
    let cleanup = Arc::new(AtomicBool::new(true));
    let (_sender, mut cancel) = oneshot::channel();
    let mut run = Box::pin(process::run_optimizer(
        &sdk,
        &host,
        &config,
        &directory,
        &mut cancel,
        120,
        cleanup.clone(),
    ));
    let handles = tokio::select! {
        result = &mut run => panic!("Optimizer returned before synthetic descendants started: {result:?}"),
        handles = descendants(&directory) => handles,
    };
    drop(run);
    for handle in handles {
        handle.assert_exited();
    }
    assert!(!cleanup.load(Ordering::Acquire));
}
