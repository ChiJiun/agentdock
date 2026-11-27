// Build scripts may use `expect`; the no-expect rule applies to crate code (CONVENTIONS §3).
#![allow(clippy::expect_used)]

fn main() {
    let attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["app_info"]));
    tauri_build::try_build(attrs).expect("tauri build script failed");
}
