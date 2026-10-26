//! Pure argument/capture/pre-dispatch regressions; synthetic paths never launch a host or numerical engine.
use super::*;

/// A real OS exit-status value can exercise readiness policy without creating any process.
fn exit_status(code: u32) -> std::process::ExitStatus {
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw((code as i32) << 8)
    }
}

/// Preserve each original argument byte-for-byte after the fixed host delimiter, including spaces and shell metacharacters.
#[test]
fn fixed_host_vector_preserves_original_replay_arguments() {
    let working = Path::new("C:/Synthetic evidence/replay-inputs/binary");
    let compiler = Path::new("C:/Synthetic SDK/dotnet.exe");
    let host = Path::new("C:/Synthetic resources/ValidationHost.dll");
    let runtime = ReplayRuntime { compiler, host };
    let arguments = vec![
        working
            .join("WorkspaceCompile.dll")
            .to_string_lossy()
            .into_owned(),
        "--param".into(),
        "Text=synthetic & `literal` $value ; argument".into(),
        "--end-utc".into(),
        "2026-04-01T00:00:00Z".into(),
    ];
    let vector =
        replay_arguments(&runtime, &arguments, working, "Local\\SyntheticOwnedJob").unwrap();
    assert_eq!(vector[0], host.as_os_str());
    assert_eq!(vector[1], "--replay");
    assert_eq!(vector[3], compiler.parent().unwrap().as_os_str());
    assert_eq!(vector[8], "--");
    assert_eq!(
        vector[9..],
        arguments
            .iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
    );
}

/// The host may run only the exact frozen assembly in its native working directory.
#[test]
fn missing_or_foreign_frozen_dll_is_rejected() {
    let runtime = ReplayRuntime {
        compiler: Path::new("C:/Synthetic SDK/dotnet.exe"),
        host: Path::new("C:/Synthetic/ValidationHost.dll"),
    };
    let working = Path::new("C:/Synthetic/binary");
    assert!(replay_arguments(&runtime, &[], working, "synthetic").is_err());
    assert!(replay_arguments(
        &runtime,
        &["C:/Foreign/WorkspaceCompile.dll".into()],
        working,
        "synthetic"
    )
    .is_err());
}

/// Exactly 128 KiB is representable; the first extra byte stops accumulation and rejects the run.
#[tokio::test]
async fn stdout_and_stderr_capture_is_bounded_before_accumulation() {
    let accepted = vec![b'x'; MAX_STREAM_BYTES as usize];
    assert_eq!(
        bounded_output(accepted.as_slice()).await.unwrap().len(),
        accepted.len()
    );
    let overflow = vec![b'x'; MAX_STREAM_BYTES as usize + 1];
    assert!(bounded_output(overflow.as_slice())
        .await
        .unwrap_err()
        .contains("128 KiB"));
}

/// Cancel already requested, or a dropped native owner, must return before touching even synthetic nonexistent executable paths.
#[tokio::test]
async fn pre_dispatch_cancellation_starts_no_host_and_preserves_cleanup_confirmation() {
    for send_cancel in [true, false] {
        let (sender, mut cancel) = oneshot::channel();
        if send_cancel {
            sender.send(()).unwrap();
        } else {
            drop(sender);
        }
        let confirmed = Arc::new(AtomicBool::new(true));
        let result = run_replay(
            ReplayRuntime {
                compiler: Path::new("synthetic-missing-sdk"),
                host: Path::new("synthetic-missing-host"),
            },
            &[],
            Path::new("synthetic-missing-working"),
            &mut cancel,
            1,
            confirmed.clone(),
        )
        .await;
        assert_eq!(result.unwrap_err(), workspace_build::CANCELLATION_MESSAGE);
        assert!(confirmed.load(Ordering::Acquire));
    }
}

/// Successful host dispatch needs its exact marker, while original nonzero exit statuses remain nonzero evidence.
#[test]
fn successful_exit_requires_owned_host_readiness() {
    let mut output = Output {
        status: exit_status(0),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    assert!(verify_ready(&output).is_err());
    output.stdout = format!("{HOST_READY}\nOriginal synthetic diagnostic\n").into_bytes();
    assert!(verify_ready(&output).is_ok());
    output.status = exit_status(7);
    output.stdout.clear();
    assert!(verify_ready(&output).is_ok());
    assert_eq!(output.status.code(), Some(7));
}

/// Compile, metadata and SDK probes have fixed disjoint vectors; no mode grants arbitrary command execution.
#[test]
fn build_metadata_and_probe_vectors_preserve_fixed_phase_inputs() {
    let working = Path::new("C:/Synthetic snapshot");
    let compiler = Path::new("C:/Synthetic candidate/dotnet.exe");
    let arguments = vec![
        "build".into(),
        working
            .join("WorkspaceCompile.csproj")
            .to_string_lossy()
            .into_owned(),
        "-c".into(),
        "Release".into(),
    ];
    let mut request = ToolRequest {
        bootstrap: Path::new("C:/Verified bootstrap/dotnet.exe"),
        host: Path::new("C:/Verified host/ValidationHost.dll"),
        candidate: compiler,
        mode: ToolMode::Build,
        arguments: &arguments,
        working,
        environment: &[],
        timeout_seconds: 1,
    };
    let vector = tool_arguments(&request, "synthetic-owned-job").unwrap();
    assert_eq!(vector[1], "--build");
    assert_eq!(vector[3], compiler.parent().unwrap().as_os_str());
    assert_eq!(
        vector[9..],
        arguments
            .iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
    );
    request.mode = ToolMode::Metadata;
    assert!(tool_arguments(&request, "synthetic").is_err());
    let metadata = vec![
        "exec".into(),
        working
            .join("WorkspaceCompile.dll")
            .to_string_lossy()
            .into_owned(),
    ];
    request.arguments = &metadata;
    assert_eq!(
        tool_arguments(&request, "synthetic").unwrap()[1],
        "--metadata"
    );
    request.mode = ToolMode::SdkProbe;
    assert!(tool_arguments(&request, "synthetic").is_err());
    request.arguments = &[];
    let vector = tool_arguments(&request, "synthetic").unwrap();
    assert_eq!(vector.len(), 8);
    assert_eq!(vector[1], "--sdk-probe");
    assert_eq!(vector[3], compiler.as_os_str());
}
