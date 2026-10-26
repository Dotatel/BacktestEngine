//! Actual contained-host tests over a compiled nontrading fixture. No successful backtest/profile authority is fabricated.
use super::*;
use std::{fs, path::PathBuf};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

/// Compile a real isolated tree fixture with the staged SDK, preserving all logs under ignored evidence storage.
async fn fixture() -> (PathBuf, crate::build_process::BuildRuntime, PathBuf) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/replay-process-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let runtime = crate::build_process::staged_test_runtime(&root.join("probes"));
    let project = root.join("WorkspaceCompile.csproj");
    fs::write(&project,r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><UseAppHost>false</UseAppHost></PropertyGroup></Project>"#).unwrap();
    fs::write(root.join("NuGet.Config"),"<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>").unwrap();
    fs::write(root.join("Directory.Build.props"), "<Project/>").unwrap();
    fs::write(root.join("Directory.Build.targets"), "<Project/>").unwrap();
    let source = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("optimizer-host/ValidationLifecycleFixture.cs"),
    )
    .unwrap()
    .replace(
        "string role = args[0];",
        "string role = args.Length == 0 ? \"parent\" : args[0];",
    )
    .replace(
        "string root = args[1];",
        "string root = args.Length < 2 ? Environment.CurrentDirectory : args[1];",
    );
    fs::write(root.join("Tree.cs"), source).unwrap();
    let args = vec![
        "build".into(),
        project.to_string_lossy().into_owned(),
        "-c".into(),
        "Release".into(),
        "-v:q".into(),
        "-p:RestoreConfigFile=NuGet.Config".into(),
        "-p:NuGetAudit=false".into(),
        "-p:UseSharedCompilation=false".into(),
        "-nodeReuse:false".into(),
    ];
    let environment = workspace_build::offline_build_environment(&root);
    let (_sender, mut cancel) = oneshot::channel();
    let cleanup = Arc::new(AtomicBool::new(true));
    let output = run_workspace_tool(
        ToolRequest {
            bootstrap: &runtime.bootstrap,
            host: &runtime.host,
            candidate: &runtime.bootstrap,
            mode: ToolMode::Build,
            arguments: &args,
            working: &root,
            environment: &environment,
            timeout_seconds: 180,
        },
        &mut cancel,
        cleanup.clone(),
    )
    .await;
    fs::write(
        root.join("compile.log"),
        format!("syntheticProcessFixture=true\n{output:?}"),
    )
    .unwrap();
    assert!(
        output.unwrap().status.success(),
        "Fixture compile failed; see {}",
        root.display()
    );
    assert!(cleanup.load(Ordering::Acquire));
    let working = root.join("bin/Release/net10.0");
    (root, runtime, working)
}

/// Keep exact process identities alive while observing teardown; this helper never kills by PID or process name.
struct ObservedProcess(isize);
impl ObservedProcess {
    /// Open only the fixture PID just written inside this test's private working directory.
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(
            !handle.is_null(),
            "Owned fixture process {pid} could not be observed."
        );
        Self(handle as isize)
    }
    /// Exit must already be signaled at native return/drop, without eventual-PID polling.
    fn assert_exited(&self) {
        assert_eq!(
            unsafe { WaitForSingleObject(self.0 as HANDLE, 0) },
            WAIT_OBJECT_0,
            "Owned descendant remained active at native completion."
        );
    }
}
impl Drop for ObservedProcess {
    /// Close the observation handle without mutating the observed process.
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0 as HANDLE) };
    }
}

/// Wait for all three actual descendants, then retain synchronization handles before asking the host to stop.
async fn descendants(working: &Path) -> Vec<ObservedProcess> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !working.join("grandchild.pid").is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ["parent", "child", "grandchild"]
            .iter()
            .map(|role| {
                ObservedProcess::open(
                    fs::read_to_string(working.join(format!("{role}.pid")))
                        .unwrap()
                        .parse()
                        .unwrap(),
                )
            })
            .collect()
    })
    .await
    .expect("The owned compiled synthetic descendant tree did not start.")
}

/// Actual host cancellation/timeout must finish every descendant before a caller can release frozen source handles.
async fn stopped_case(cancel_requested: bool, metadata: bool) {
    let (evidence, runtime, working) = fixture().await;
    let artifact = working
        .join("WorkspaceCompile.dll")
        .to_string_lossy()
        .into_owned();
    let arguments = if metadata {
        vec!["exec".into(), artifact]
    } else {
        vec![artifact]
    };
    let mode = if metadata {
        ToolMode::Metadata
    } else {
        ToolMode::Replay
    };
    let cleanup = Arc::new(AtomicBool::new(true));
    let (sender, mut cancel) = oneshot::channel();
    let observer = async {
        let handles = descendants(&working).await;
        let retained = if cancel_requested {
            sender.send(()).unwrap();
            None
        } else {
            Some(sender)
        };
        (handles, retained)
    };
    let run = run_workspace_tool(
        ToolRequest {
            bootstrap: &runtime.bootstrap,
            host: &runtime.host,
            candidate: &runtime.bootstrap,
            mode,
            arguments: &arguments,
            working: &working,
            environment: &[],
            timeout_seconds: if cancel_requested { 60 } else { 20 },
        },
        &mut cancel,
        cleanup.clone(),
    );
    let (outcome, (handles, _sender)) = tokio::join!(run, observer);
    fs::write(evidence.join("outcome.txt"),format!("syntheticProcessFixture=true\nmetadata={metadata}\ncancel={cancel_requested}\n{outcome:?}")).unwrap();
    let error = outcome.unwrap_err();
    assert!(
        error.contains(if cancel_requested {
            "canceled"
        } else {
            "did not respond within"
        }),
        "{error}"
    );
    for handle in &handles {
        handle.assert_exited();
    }
    assert!(cleanup.load(Ordering::Acquire));
}

/// Replay uses the production host mode and actual nested processes; cancellation is not inferred from killing one PID.
#[tokio::test]
async fn actual_replay_cancel_confirms_all_descendants_before_return() {
    stopped_case(true, false).await;
}

/// A deadline follows the same confirmed teardown path as an explicit cancellation.
#[tokio::test]
async fn actual_replay_timeout_confirms_all_descendants_before_return() {
    stopped_case(false, false).await;
}

/// Compiled metadata can create children, so reflection uses the same contained boundary.
#[tokio::test]
async fn actual_metadata_cancel_confirms_all_descendants_before_return() {
    stopped_case(true, true).await;
}

/// Abandoning a native future drains its real job but deliberately leaves caller ownership blocked until restart.
#[tokio::test]
async fn actual_replay_future_drop_stops_tree_and_keeps_cleanup_unconfirmed() {
    let (evidence, runtime, working) = fixture().await;
    let arguments = vec![working
        .join("WorkspaceCompile.dll")
        .to_string_lossy()
        .into_owned()];
    let cleanup = Arc::new(AtomicBool::new(true));
    let (_sender, mut cancel) = oneshot::channel();
    let mut run = Box::pin(run_replay(
        ReplayRuntime {
            compiler: &runtime.bootstrap,
            host: &runtime.host,
        },
        &arguments,
        &working,
        &mut cancel,
        60,
        cleanup.clone(),
    ));
    let handles = tokio::select! {result=&mut run=>panic!("Synthetic replay stopped before observation: {result:?}"),handles=descendants(&working)=>handles};
    drop(run);
    for handle in &handles {
        handle.assert_exited();
    }
    assert!(!cleanup.load(Ordering::Acquire));
    fs::write(evidence.join("outcome.txt"),"syntheticProcessFixture=true\nfutureDropped=true\nallObservedDescendantsExited=true\ncallerCleanupConfirmed=false\n").unwrap();
}
