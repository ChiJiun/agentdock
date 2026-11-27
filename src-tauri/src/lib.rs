#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod commands;
mod smoke;

/// Builds the Tauri app and runs it. On failure prints the error and exits with code 1.
pub fn run() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .setup(|app| {
            smoke::install(app);
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("agentdock: failed to run the Tauri application: {err}");
        std::process::exit(1);
    }
}
