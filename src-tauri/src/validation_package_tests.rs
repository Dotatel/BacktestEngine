//! Actual pinned interpreter and owned filesystem fixtures; none of these checks proves trading qualification.
use super::*;

/// Resolve only the already staged pinned runtime and original numerical producer.
fn assets() -> (PathBuf, PathBuf) {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    (
        resources.join("validation"),
        resources.join("runtimes/python/python.exe"),
    )
}

/// Copy the small original package to a fresh owned fixture; production and retained sources remain untouched.
fn source_fixture(root: &Path) -> PathBuf {
    let source = root.join("producer");
    for relative in retained_sources().unwrap().keys() {
        let target = source.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(assets().0.join(relative), target).unwrap();
    }
    source
}

/// Copy only the 37-file interpreter tree and its own staging manifest for negative mutation fixtures.
fn runtime_fixture(root: &Path) -> PathBuf {
    let runtime = root.join("runtimes/python");
    fs::create_dir_all(&runtime).unwrap();
    for name in PYTHON_FILES {
        fs::copy(assets().1.parent().unwrap().join(name), runtime.join(name)).unwrap();
    }
    fs::copy(
        assets()
            .1
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("manifest.json"),
        root.join("runtimes/manifest.json"),
    )
    .unwrap();
    runtime.join("python.exe")
}

/// Pinned full-tree identity and compile-time numerical hashes must agree before a native process can use the package.
#[cfg(windows)]
#[tokio::test]
async fn actual_pinned_python_imports_only_the_frozen_original_package_under_retained_locks() {
    let temporary = tempfile::tempdir().unwrap();
    let (source, python) = assets();
    let frozen =
        freeze_validation_package(&source, &temporary.path().join("python-package"), &python)
            .unwrap();
    assert_eq!(frozen.provenance.sources.len(), 27);
    assert_eq!(frozen.provenance.python_files.len(), 37);
    assert_eq!(frozen.provenance.python_tree_sha256, PYTHON_TREE);
    assert_eq!(
        frozen.provenance_sha256,
        replay_receipt::digest(&fs::read(frozen.root.join("producer-provenance.json")).unwrap())
    );
    let mut command = tokio::process::Command::new(&frozen.python);
    command.args(["-I", "-B", "-X", "utf8", "-c", "import sys,pathlib;sys.path.insert(0,sys.argv[1]);import ValidationEngine.Cli as cli;print(pathlib.Path(cli.__file__).resolve())"])
        .arg(&frozen.root).current_dir(temporary.path()).kill_on_drop(true).creation_flags(0x0800_0000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    assert_eq!(
        actual.canonicalize().unwrap(),
        frozen
            .root
            .join("ValidationEngine/Cli.py")
            .canonicalize()
            .unwrap()
    );
    assert!(fs::OpenOptions::new()
        .write(true)
        .open(frozen.root.join("ValidationEngine/Cli.py"))
        .is_err());
    assert!(fs::rename(
        frozen.root.join("ValidationEngine/Cli.py"),
        frozen.root.join("ValidationEngine/moved.py")
    )
    .is_err());
    let cli = frozen.root.join("ValidationEngine/Cli.py");
    drop(frozen);
    assert!(fs::OpenOptions::new().write(true).open(cli).is_ok());
}

/// Missing, changed or extra executable producer bytes cannot acquire original-source provenance.
#[cfg(windows)]
#[test]
fn missing_changed_and_extra_producer_files_fail_before_execution() {
    for mutation in ["missing", "changed", "extra", "bytecode"] {
        let temporary = tempfile::tempdir().unwrap();
        let source = source_fixture(temporary.path());
        mutate_source(&source, mutation);
        let result =
            freeze_validation_package(&source, &temporary.path().join("frozen"), &assets().1);
        assert!(result.is_err(), "{mutation}");
    }
}

/// Mutate only a known owned fixture, never the retained package or installed interpreter.
fn mutate_source(source: &Path, mutation: &str) {
    match mutation {
        "missing" => fs::remove_file(source.join("ValidationEngine/Cli.py")).unwrap(),
        "changed" => {
            fs::write(source.join("ValidationEngine/Cli.py"), "# altered fixture").unwrap()
        }
        "extra" => fs::write(
            source.join("ValidationEngine/Unexpected.py"),
            "# injected fixture",
        )
        .unwrap(),
        "bytecode" => fs::write(
            source.join("ValidationEngine/Cli.pyc"),
            b"unapproved bytecode",
        )
        .unwrap(),
        _ => panic!("Unknown owned source mutation"),
    }
}

/// Full interpreter verification binds the standard-library archive, companion set and official staging identity.
#[cfg(windows)]
#[test]
fn altered_runtime_zip_extra_module_and_staging_manifest_are_rejected() {
    for mutation in ["zip", "extra", "manifest"] {
        let temporary = tempfile::tempdir().unwrap();
        let python = runtime_fixture(temporary.path());
        mutate_runtime(&python, mutation);
        assert!(
            freeze_validation_package(&assets().0, &temporary.path().join("frozen"), &python)
                .is_err(),
            "{mutation}"
        );
    }
}

/// Produce deterministic faults only inside the test-owned interpreter copy.
fn mutate_runtime(python: &Path, mutation: &str) {
    let root = python.parent().unwrap();
    match mutation {
        "zip" => fs::write(root.join("python314.zip"), b"altered stdlib fixture").unwrap(),
        "extra" => fs::write(root.join("random.py"), "# unexpected runtime module").unwrap(),
        "manifest" => fs::write(root.parent().unwrap().join("manifest.json"), b"{}").unwrap(),
        _ => panic!("Unknown owned runtime mutation"),
    }
}

/// Existing destinations, relative roots and non-directory ancestors never become an accepted package.
#[cfg(windows)]
#[test]
fn destination_and_native_path_boundaries_preserve_existing_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("existing");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("keep.txt"), b"existing owned evidence").unwrap();
    let (source, python) = assets();
    assert!(freeze_validation_package(&source, &destination, &python).is_err());
    assert_eq!(
        fs::read(destination.join("keep.txt")).unwrap(),
        b"existing owned evidence"
    );
    assert!(freeze_validation_package(
        Path::new("relative"),
        &temporary.path().join("new"),
        &python
    )
    .is_err());
    assert!(
        freeze_validation_package(&source, &destination.join("keep.txt/child"), &python).is_err()
    );
}

/// Large empty directory trees are bounded by total examined entries rather than only the count of files.
#[test]
fn inventory_enumeration_is_bounded_for_empty_directories_too() {
    let temporary = tempfile::tempdir().unwrap();
    for index in 0..257 {
        fs::create_dir(temporary.path().join(format!("empty-{index}"))).unwrap();
    }
    let error = require_inventory(temporary.path(), std::iter::empty()).unwrap_err();
    assert!(error.contains("256 entries"), "{error}");
}

/// Structural source capture is fixed and deterministic, independent of each owned job's absolute path.
#[test]
fn original_source_inventory_and_runtime_archive_order_are_unique() {
    let expected = retained_sources().unwrap();
    assert_eq!(expected.len(), 27);
    assert!(expected.contains_key("ValidationEngine/Cli.py"));
    assert_eq!(
        PYTHON_FILES
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        37
    );
    assert_eq!(
        expected.values().filter(|hash| hash.len() == 64).count(),
        27
    );
}
