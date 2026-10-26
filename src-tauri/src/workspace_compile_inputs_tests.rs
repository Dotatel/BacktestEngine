//! Actual bundled SDK membership proof; injected files are synthetic and remain only inside owned snapshots.
use super::*;
use crate::{replay_receipt, workspace, workspace_build};
use std::path::PathBuf;

/// Seed one real app-shaped source project without changing any retained engine file.
fn project() -> (tempfile::TempDir, workspace::ProjectRoot) {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("Source")).unwrap();
    fs::write(
        home.path().join("Source/ExampleStrategy.cs"),
        workspace::EXAMPLE_STRATEGY_TEMPLATE,
    )
    .unwrap();
    let root = workspace::ProjectRoot::open(home.path().to_str().unwrap()).unwrap();
    (home, root)
}

#[tokio::test]
async fn frozen_compile_membership_ignores_transient_runner_shim_and_child_policy_injections() {
    let (_home, root) = project();
    let snapshots = tempfile::tempdir().unwrap();
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engines/csharp/src");
    let staged = workspace_build::assemble(&root, &engine, snapshots.path()).unwrap();
    let original = replay_receipt::source_manifest(&staged.snapshot).unwrap();
    let _locks = replay_receipt::lock_source_manifest(&staged.snapshot, &original).unwrap();
    let runner = staged
        .snapshot
        .join("engine/BacktestEngine.Run/Injected.cs");
    let shim = staged
        .snapshot
        .join("engine/BacktestEngine.CAlgoShim/Injected.cs");
    fs::write(
        &runner,
        "public static class TransientRunnerInjectionProbe { public const bool WasCompiled=true; }",
    )
    .unwrap();
    fs::write(
        &shim,
        "public static class TransientShimInjectionProbe { public const bool WasCompiled=true; }",
    )
    .unwrap();
    let child_props = staged
        .snapshot
        .join("engine/BacktestEngine.CAlgoShim/Directory.Build.props");
    let child_targets = staged
        .snapshot
        .join("engine/BacktestEngine.CAlgoShim/Directory.Build.targets");
    fs::write(&child_props,"<Project><Target Name=\"InjectedProps\" BeforeTargets=\"CoreCompile\"><Error Text=\"Uncaptured child props loaded\"/></Target></Project>").unwrap();
    fs::write(&child_targets,"<Project><Target Name=\"InjectedTargets\" BeforeTargets=\"CoreCompile\"><Error Text=\"Uncaptured child targets loaded\"/></Target></Project>").unwrap();
    let compiler =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtimes/dotnet/dotnet.exe");
    assert!(
        compiler.is_file(),
        "The actual bundled SDK is required; this check cannot be skipped."
    );
    let project = staged.snapshot.join("WorkspaceCompile.csproj");
    let project = project.to_string_lossy().into_owned();
    let restore = format!(
        "-p:RestoreConfigFile={}",
        staged.snapshot.join("NuGet.Config").display()
    );
    let (_sender, mut cancel) = tokio::sync::oneshot::channel();
    let output = workspace_build::run_process(
        &compiler,
        &[
            "build",
            &project,
            "-c",
            "Release",
            "-p:UseSharedCompilation=false",
            "-nodeReuse:false",
            "-p:NuGetAudit=false",
            &restore,
            "-v:q",
        ],
        &staged.snapshot,
        &super::super::offline_build_environment(&staged.snapshot),
        &mut cancel,
        180,
    )
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for path in [runner, shim, child_props, child_targets] {
        fs::remove_file(path).unwrap();
    }
    assert_eq!(
        replay_receipt::source_manifest(&staged.snapshot).unwrap(),
        original,
        "A postscan alone cannot detect these removed injections."
    );
    let binary = staged.snapshot.join("bin/Release/net10.0");
    assert!(!contains(
        &fs::read(binary.join("WorkspaceCompile.dll")).unwrap(),
        b"TransientRunnerInjectionProbe"
    ));
    assert!(!contains(
        &fs::read(binary.join("BacktestEngine.CAlgoShim.dll")).unwrap(),
        b"TransientShimInjectionProbe"
    ));
    let fresh = workspace_build::assemble(&root, &engine, snapshots.path()).unwrap();
    assert_eq!(
        replay_receipt::source_manifest(&fresh.snapshot).unwrap(),
        original,
        "Generated policy bytes must not embed snapshot-specific absolute paths."
    );
}

/// CLR metadata keeps non-trimmed type names; presence proves an injected valid class reached Csc.
fn contains(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle)
}
