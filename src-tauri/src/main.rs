#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

/// Run the desktop host; startup failures are surfaced by Tauri's error handler.
fn main() {
    dotatel_backtest_engine::run();
}
