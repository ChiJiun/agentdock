use agentdock_desktop::commands::{app_info, sample_app_info};

#[test]
fn app_info_serializes_exactly_like_shared_fixture() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ipc/app_info.json")).unwrap();
    let actual = serde_json::to_value(sample_app_info()).unwrap();
    assert_eq!(
        actual, expected,
        "Rust AppInfo drifted from the TS contract fixture"
    );
}

#[test]
fn app_info_reports_real_versions() {
    let info = app_info();
    assert_eq!(info.schema_version, 1);
    assert_eq!(info.core_version, agentdock_core::crate_version());
    assert!(!info.platform.is_empty());
}

#[test]
fn capability_file_grants_no_shell_fs_or_http() {
    let text = include_str!("../capabilities/default.json");
    for forbidden in ["shell:", "fs:", "http:", "process:", "dialog:", "opener:"] {
        assert!(
            !text.contains(forbidden),
            "capability must not grant {forbidden}"
        );
    }
}

#[test]
fn csp_has_no_remote_sources_or_unsafe_eval() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let csp = conf["app"]["security"]["csp"].as_str().unwrap();
    assert!(!csp.contains("unsafe-eval"));
    assert!(!csp.contains("http://") || csp.contains("http://ipc.localhost"));
    assert!(!csp.contains("https:"));
    assert!(!csp.contains('*'));
}
