//! Smoke mode: with `AGENTDOCK_SMOKE_REPORT=<path>` the app writes a JSON report once the main
//! window exists and then exits, so CI and installer tests can check that the app starts.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{Manager, Runtime};

const REPORT_ENV: &str = "AGENTDOCK_SMOKE_REPORT";
const WINDOW_LABEL: &str = "main";
const WINDOW_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// If `AGENTDOCK_SMOKE_REPORT` is set, spawn a thread that waits until the main window exists
/// (max 20 s), writes `{"ok":true,"app_version":...,"window":"main"}` to that path, then calls
/// `exit(0)`. If the window never appears, writes `{"ok":false,...}` and exits with 1.
pub(crate) fn install<R: Runtime>(app: &tauri::App<R>) {
    let Some(path) = std::env::var_os(REPORT_ENV).map(PathBuf::from) else {
        return;
    };
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + WINDOW_TIMEOUT;
        let mut window_found = false;
        while Instant::now() < deadline {
            if handle.get_webview_window(WINDOW_LABEL).is_some() {
                window_found = true;
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        let report = build_report(window_found);
        let write_ok = std::fs::write(&path, report.to_string()).is_ok();
        let code = if window_found && write_ok { 0 } else { 1 };
        handle.exit(code);
    });
}

fn build_report(window_found: bool) -> serde_json::Value {
    if window_found {
        serde_json::json!({
            "ok": true,
            "app_version": env!("CARGO_PKG_VERSION"),
            "window": WINDOW_LABEL,
        })
    } else {
        serde_json::json!({
            "ok": false,
            "app_version": env!("CARGO_PKG_VERSION"),
            "error": "main window did not appear within 20 seconds",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_ok_names_window_and_version() {
        let r = build_report(true);
        assert_eq!(r["ok"], true);
        assert_eq!(r["window"], "main");
        assert_eq!(r["app_version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn report_failure_is_not_ok() {
        assert_eq!(build_report(false)["ok"], false);
    }
}
