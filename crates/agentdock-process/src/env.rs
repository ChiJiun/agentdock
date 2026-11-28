//! Child environment allow-list (architecture.md: sanitized environment, no secrets logged).
//!
//! The child starts from an empty environment. Only [`ENV_ALLOWLIST`], the auth variable
//! *names* an adapter declares (values copied from the host) and non-secret `extra` pairs are
//! passed. Nothing in this module logs or formats values.

use crate::ProcessError;

/// Host variables every agent may see.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "USER",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "LANG",
    "LC_ALL",
    "TERM",
];

/// `^[A-Z_][A-Z0-9_]{0,63}$`
pub(crate) fn is_valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    match bytes.first() {
        Some(b) if b.is_ascii_uppercase() || *b == b'_' => {}
        _ => return false,
    }
    bytes.len() <= 64
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// Environment names are case-insensitive on Windows and exact elsewhere.
fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Builds the child environment from `host` (pass the process environment in production, a
/// list in tests). Host spelling of names is kept. `extra` replaces an earlier entry with the
/// same name.
pub fn child_env(
    host: &[(String, String)],
    auth_env_names: &[String],
    extra: &[(String, String)],
) -> Result<Vec<(String, String)>, ProcessError> {
    if !auth_env_names.iter().all(|n| is_valid_env_name(n)) {
        return Err(ProcessError::BadEnvName);
    }
    if !extra.iter().all(|(n, _)| is_valid_env_name(n)) {
        return Err(ProcessError::BadEnvName);
    }
    if extra.iter().any(|(_, v)| v.contains('\0')) {
        return Err(ProcessError::BadArgument);
    }

    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in host {
        let wanted = ENV_ALLOWLIST.iter().any(|a| same_name(a, name))
            || auth_env_names.iter().any(|a| same_name(a, name));
        if wanted && !out.iter().any(|(n, _)| same_name(n, name)) {
            out.push((name.clone(), value.clone()));
        }
    }
    for (name, value) in extra {
        out.retain(|(n, _)| !same_name(n, name));
        out.push((name.clone(), value.clone()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(n: &str, v: &str) -> (String, String) {
        (n.to_string(), v.to_string())
    }

    #[test]
    fn drops_everything_not_allowlisted() {
        let host = vec![
            pair("PATH", "/usr/bin"),
            pair("GITHUB_TOKEN", "x"),
            pair("AWS_SECRET_ACCESS_KEY", "y"),
        ];
        let env = child_env(&host, &[], &[]).unwrap();
        assert_eq!(env, vec![pair("PATH", "/usr/bin")]);
    }

    #[test]
    fn auth_env_names_are_passed_through() {
        let host = vec![pair("ANTHROPIC_API_KEY", "k")];
        let env = child_env(&host, &["ANTHROPIC_API_KEY".into()], &[]).unwrap();
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn rejects_bad_env_names() {
        assert!(matches!(
            child_env(&[], &["bad-name".into()], &[]),
            Err(ProcessError::BadEnvName)
        ));
        assert!(matches!(
            child_env(&[], &["A=B".into()], &[]),
            Err(ProcessError::BadEnvName)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn allowlist_is_case_insensitive_on_windows() {
        let host = vec![pair("Path", "C:\\bin")];
        assert_eq!(
            child_env(&host, &[], &[]).unwrap(),
            vec![pair("Path", "C:\\bin")]
        );
    }

    #[test]
    fn env_name_rules() {
        assert!(is_valid_env_name("_A1"));
        assert!(is_valid_env_name(&format!("A{}", "B".repeat(63))));
        assert!(!is_valid_env_name(&format!("A{}", "B".repeat(64))));
        assert!(!is_valid_env_name(""));
        assert!(!is_valid_env_name("1A"));
        assert!(!is_valid_env_name("lower"));
        assert!(!is_valid_env_name("A\0B"));
    }

    #[test]
    fn extra_env_is_validated_and_overrides() {
        let host = vec![pair("PATH", "/usr/bin")];
        let env = child_env(&host, &[], &[pair("NO_COLOR", "1"), pair("PATH", "/opt")]).unwrap();
        assert_eq!(env, vec![pair("NO_COLOR", "1"), pair("PATH", "/opt")]);
        assert!(matches!(
            child_env(&[], &[], &[pair("no color", "1")]),
            Err(ProcessError::BadEnvName)
        ));
        assert!(matches!(
            child_env(&[], &[], &[pair("NO_COLOR", "a\0b")]),
            Err(ProcessError::BadArgument)
        ));
    }

    #[test]
    fn missing_auth_variable_is_skipped() {
        let env = child_env(&[], &["OPENAI_API_KEY".into()], &[]).unwrap();
        assert!(env.is_empty());
    }
}
