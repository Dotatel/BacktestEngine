//! Build ownership synchronization only; no actual compiler, native window or source mutation is involved.
use super::*;
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// Preparation/approval cleanup must discard the old sender before another build can be admitted.
#[test]
fn build_cleanup_clears_cancel_before_releasing_running() {
    let directory = tempfile::tempdir().unwrap();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let state = Arc::new(WorkspaceState {
        session: workspace::SessionStore {
            path: directory.path().join("session.json"),
        },
        projects_directory: directory.path().join("projects"),
        builds_directory: directory.path().join("builds"),
        selected: Mutex::new(None),
        build_running: Mutex::new(true),
        build_cancel: Mutex::new(Some(sender)),
        build_flight: Mutex::new(None),
        last_successful_build: Mutex::new(None),
    });
    let running = state.build_running.lock().unwrap();
    let (observed, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let result = receiver.blocking_recv();
        observed.send(result.is_err()).unwrap();
    });
    let cleanup_state = state.clone();
    let cleanup = std::thread::spawn(move || {
        drop(WorkspaceBuildGuard {
            state: &cleanup_state,
            flight: Arc::new(build_process::BuildFlight::new()),
        })
    });
    let cancelled = completed.recv_timeout(Duration::from_secs(2));
    assert!(*running);
    drop(running);
    cleanup.join().unwrap();
    waiter.join().unwrap();
    assert!(cancelled.unwrap());
    assert!(!*state.build_running.lock().unwrap());
    assert!(state.build_cancel.lock().unwrap().is_none());
}

/// A dropped build future with unknown native cleanup keeps the state-owned flight and busy latch until restart.
#[test]
fn unconfirmed_build_cleanup_keeps_ownership_and_blocks_new_builds() {
    let home = tempfile::tempdir().unwrap();
    let flight = Arc::new(build_process::BuildFlight::new());
    flight
        .cleanup
        .store(false, std::sync::atomic::Ordering::Release);
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let state = WorkspaceState {
        session: workspace::SessionStore {
            path: home.path().join("session.json"),
        },
        projects_directory: home.path().join("projects"),
        builds_directory: home.path().join("builds"),
        selected: Mutex::new(None),
        build_running: Mutex::new(true),
        build_cancel: Mutex::new(Some(sender)),
        build_flight: Mutex::new(Some(flight.clone())),
        last_successful_build: Mutex::new(None),
    };
    drop(WorkspaceBuildGuard {
        state: &state,
        flight,
    });
    assert!(*state.build_running.lock().unwrap());
    assert!(state.build_cancel.lock().unwrap().is_none());
    assert!(state.build_flight.lock().unwrap().is_some());
}
