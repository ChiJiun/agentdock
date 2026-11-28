//! Shared by the fixture-driven integration tests.
#![allow(dead_code)]

use std::{fs, path::PathBuf};

pub fn contracts() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts")
}

pub fn all_fixture_lines() -> Vec<(String, usize, String)> {
    let mut out = vec![];
    for dir in [
        contracts().join("fixtures"),
        contracts().join("fixtures/predelete"),
    ] {
        for entry in fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // JSON Lines are separated by `\n` only (contracts README); strip one trailing `\r`
            // so a CRLF checkout (core.autocrlf=true) still works.
            for (i, line) in fs::read_to_string(&p).unwrap().split('\n').enumerate() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                if !line.is_empty() {
                    out.push((p.display().to_string(), i + 1, line.to_string()));
                }
            }
        }
    }
    assert!(
        out.len() > 500,
        "expected the 13 fixtures (+ predelete) to have >500 lines"
    );
    out
}
