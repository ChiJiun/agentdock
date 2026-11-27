//! Typed IPC commands. The frontend only reaches Rust through these (docs/architecture.md line 28).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AppInfo {
    /// `CARGO_PKG_VERSION` of agentdock-desktop.
    pub app_version: String,
    /// `agentdock_core::crate_version()`.
    pub core_version: String,
    /// `agentdock_core::SCHEMA_VERSION`.
    pub schema_version: u32,
    /// `std::env::consts::OS`, e.g. "windows".
    pub platform: String,
}

/// Error shape returned by every command (later packets reuse it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IpcError {
    /// Stable machine code, e.g. "not_found".
    pub code: String,
    /// Human text; never contains secrets or env values.
    pub message: String,
}

/// Static build information only: no user paths, user names or environment values.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        core_version: agentdock_core::crate_version().to_string(),
        schema_version: agentdock_core::SCHEMA_VERSION,
        platform: std::env::consts::OS.to_string(),
    }
}

/// Fixed values shared with the TS contract fixture (`tests/fixtures/ipc/app_info.json`).
pub fn sample_app_info() -> AppInfo {
    AppInfo {
        app_version: "0.0.0-fixture".to_string(),
        core_version: "0.0.0-fixture".to_string(),
        schema_version: 1,
        platform: "fixture-os".to_string(),
    }
}
