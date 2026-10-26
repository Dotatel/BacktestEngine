//! Real bounded process/filesystem mechanics with explicitly synthetic workflow inputs, not economic validation.
use super::*;
use crate::full_validation::{self, tests as fixtures};

#[test]
fn real_output_create_delete_churn_does_not_hide_caps_or_missing_fixed_root() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("owned-output");
    fs::create_dir(&root).unwrap();
    let writer = root.clone();
    let thread = std::thread::spawn(move || {
        for index in 0..2000 {
            let path = writer.join(format!("compiler-{}.tmp", index % 8));
            fs::write(&path, b"temporary compiler output").unwrap();
            fs::remove_file(path).unwrap();
        }
    });
    let scan = (0..2000).try_for_each(|_| check_workspace_budget(&root));
    thread.join().unwrap();
    scan.unwrap();
    let huge = root.join("oversized.tmp");
    fs::File::create(&huge)
        .unwrap()
        .set_len(MAX_WORKSPACE_BYTES + 1)
        .unwrap();
    assert!(check_workspace_budget(&root)
        .unwrap_err()
        .contains("512 MiB"));
    fs::remove_file(&huge).unwrap();
    fs::remove_dir(&root).unwrap();
    assert!(check_workspace_budget(&root).is_err());
}

#[tokio::test]
async fn output_stream_bound_prevents_unbounded_accumulation() {
    assert_eq!(
        bounded_output(&b"within bound"[..]).await.unwrap(),
        b"within bound"
    );
    let large = vec![b'x'; MAX_STREAM_BYTES as usize + 1];
    assert!(bounded_output(&large[..])
        .await
        .unwrap_err()
        .contains("128 KiB"));
}

/// Compile an owned nontrading process fixture; the real validation host starts actual Python then dotnet descendants.
async fn lifecycle_fixture(directory: &Path) -> PathBuf {
    let tree = directory.join("fixture-tree");
    fs::create_dir(&tree).unwrap();
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("optimizer-host/ValidationLifecycleFixture.cs"),
        tree.join("Lifecycle.cs"),
    )
    .unwrap();
    fs::write(tree.join("ProofTree.csproj"),r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><UseAppHost>false</UseAppHost></PropertyGroup></Project>"#).unwrap();
    fs::write(tree.join("NuGet.Config"),"<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>").unwrap();
    let sdk = fixtures::runtime("runtimes/dotnet/dotnet.exe");
    let environment = [
        (
            "DOTNET_CLI_HOME",
            tree.join("cli-home").to_string_lossy().into(),
        ),
        (
            "NUGET_PACKAGES",
            tree.join("packages").to_string_lossy().into(),
        ),
        ("DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "true".into()),
        ("DOTNET_CLI_TELEMETRY_OPTOUT", "1".into()),
        ("DOTNET_GENERATE_ASPNET_CERTIFICATE", "false".into()),
    ];
    fixtures::process(
        &sdk,
        &[
            "build",
            "ProofTree.csproj",
            "-p:RestoreConfigFile=NuGet.Config",
            "-p:NuGetAudit=false",
            "-p:UseSharedCompilation=false",
            "-nodeReuse:false",
            "-v:q",
        ],
        &tree,
        &environment,
    )
    .await;
    let package = directory.join("synthetic-package/ValidationEngine");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("__init__.py"), b"").unwrap();
    fs::write(package.join("Cli.py"),r#"import os,subprocess,time
from pathlib import Path
root=Path.cwd()
(root/'python.pid').write_text(str(os.getpid()))
subprocess.Popen([str(Path(os.environ['DOTNET_ROOT'])/'dotnet.exe'),str(root/'fixture-tree/bin/Debug/net10.0/ProofTree.dll'),'parent',str(root)])
while True:time.sleep(1)
"#).unwrap();
    directory.join("synthetic-package")
}

/// Open synchronization handles while our exact recorded descendants are running; no process is terminated here.
#[cfg(windows)]
async fn owned_descendants(directory: &Path) -> Result<Vec<ProcessHandle>, String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !directory.join("grandchild.pid").is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ["python", "parent", "child", "grandchild"]
            .iter()
            .map(|name| {
                let pid: u32 = fs::read_to_string(directory.join(format!("{name}.pid")))
                    .unwrap()
                    .parse()
                    .unwrap();
                ProcessHandle::open(pid)
            })
            .collect()
    })
    .await
    .map_err(|_| "The actual synthetic Python/dotnet descendant tree did not start.".into())
}

/// Hold only an observed owned fixture PID's synchronization handle, preventing PID-reuse ambiguity.
#[cfg(windows)]
struct ProcessHandle(isize);

#[cfg(windows)]
impl ProcessHandle {
    /// Open a running owned process with synchronization access only.
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
        assert_ne!(
            handle, 0,
            "Owned fixture process {pid} could not be observed."
        );
        Self(handle)
    }
    /// Require termination immediately at native helper return; this is stronger than eventual PID polling.
    fn assert_terminated(&self) {
        assert_eq!(
            unsafe { WaitForSingleObject(self.0, 0) },
            0,
            "An owned descendant was still active when native validation returned."
        );
    }
}

#[cfg(windows)]
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, id: u32) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
}

/// Create empty real states; no successful numerical result or fake economic authority is injected.
fn engine_states(
    directory: &Path,
) -> (
    crate::validation::ValidationState,
    crate::execution::ExecutionState,
) {
    (
        crate::validation::ValidationState {
            validations_directory: directory.join("validations"),
            running: false.into(),
            cancel: None.into(),
            last_good: None.into(),
            last_good_project: None.into(),
            last_good_execution_run_id: None.into(),
        },
        crate::execution::ExecutionState {
            runs_directory: directory.join("runs"),
            market_data_directory: directory.join("market"),
            builds_directory: directory.join("builds"),
            running: false.into(),
            cancel: None.into(),
            last_good: None.into(),
            last_good_project: None.into(),
            retained_inputs: None.into(),
        },
    )
}

/// Exercise actual native cancellation/timeout and inspect descendants before releasing either engine latch.
#[cfg(windows)]
async fn lifecycle_case(cancel_job: bool) {
    let (_fixture, _frozen, prepared) = fixtures::prepared();
    let source = lifecycle_fixture(&prepared.directory).await;
    let compiler = fixtures::runtime("runtimes/dotnet/dotnet.exe")
        .canonicalize()
        .unwrap();
    let python = fixtures::runtime("runtimes/python/python.exe");
    let host = full_validation::runtime::verify_host(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/validation/host"),
    )
    .unwrap();
    let (validation, execution) = engine_states(&prepared.directory);
    let guard = full_validation::service::acquire_engine_job(&validation, &execution).unwrap();
    assert!(full_validation::service::acquire_engine_job(&validation, &execution).is_err());
    let (sender, mut cancel) = oneshot::channel();
    let observer = async {
        let handles = owned_descendants(&prepared.directory).await;
        let retained_sender = if cancel_job && handles.is_ok() {
            sender.send(()).unwrap();
            None
        } else {
            Some(sender)
        };
        (handles, retained_sender)
    };
    let run = run_full_validation(
        ValidationRuntime {
            compiler: &compiler,
            host: &host,
            python: &python,
            source: &source,
        },
        &prepared,
        &mut cancel,
        if cancel_job { 60 } else { 20 },
        guard.cleanup_marker(),
    );
    let (outcome, (handles, _retained_sender)) = tokio::join!(run, observer);
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/full-validation-lifecycle-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    fs::write(
        evidence.join("outcome.txt"),
        format!("syntheticLifecycleFixture=true\ncancel={cancel_job}\n{outcome:?}\n"),
    )
    .unwrap();
    let handles =
        handles.unwrap_or_else(|error| panic!("{error} Evidence: {}", evidence.display()));
    let error = outcome.unwrap_err();
    assert!(
        error.contains(if cancel_job {
            "canceled"
        } else {
            "exceeded 600 seconds"
        }),
        "{error}"
    );
    for handle in &handles {
        handle.assert_terminated();
    }
    assert!(*validation.running.lock().unwrap());
    assert!(*execution.running.lock().unwrap());
    drop(guard);
    assert!(!*validation.running.lock().unwrap());
    assert!(!*execution.running.lock().unwrap());
}

#[cfg(windows)]
#[tokio::test]
async fn real_native_cancel_stops_python_and_dotnet_descendants_before_latches_release() {
    lifecycle_case(true).await;
}

#[cfg(windows)]
#[tokio::test]
async fn real_native_timeout_stops_python_and_dotnet_descendants_before_latches_release() {
    lifecycle_case(false).await;
}

/// A real owned junction is rejected rather than followed; no external tree or recursive shell cleanup is used.
#[cfg(windows)]
#[test]
fn output_monitor_rejects_enumerated_junctions() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("job");
    let target = home.path().join("outside-job");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&target).unwrap();
    let link = root.join("redirect");
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = check_workspace_budget(&root);
    fs::remove_dir(&link).unwrap();
    assert!(result.unwrap_err().contains("reparse"));
    assert!(target.is_dir());
}
