//! Synchronization-only lifecycle regressions; no engine, compiler, provider or desktop process is launched.
use super::*;
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// Old cancellation ownership must disappear before the busy latch can admit a replacement run.
#[test]
fn execution_cleanup_clears_cancel_before_releasing_running() {
    let directory = tempfile::tempdir().unwrap();
    let (sender, receiver) = oneshot::channel();
    let state = Arc::new(ExecutionState {
        runs_directory: directory.path().join("runs"),
        market_data_directory: directory.path().join("data"),
        builds_directory: directory.path().join("builds"),
        running: true.into(),
        cancel: Some(sender).into(),
        last_good: None.into(),
        last_good_project: None.into(),
        retained_inputs: None.into(),
    });
    let running = state.running.lock().unwrap();
    let (observed, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let result = receiver.blocking_recv();
        observed.send(result.is_err()).unwrap();
    });
    let cleanup_state = state.clone();
    let cleanup = std::thread::spawn(move || drop(ExecutionGuard::new(&cleanup_state)));
    // Holding the busy mutex forces cleanup to prove cancel removal first; reverse ordering times out.
    let cancelled = completed.recv_timeout(Duration::from_secs(2));
    assert!(*running);
    drop(running);
    cleanup.join().unwrap();
    waiter.join().unwrap();
    assert!(cancelled.unwrap());
    assert!(!*state.running.lock().unwrap());
    assert!(state.cancel.lock().unwrap().is_none());
}
