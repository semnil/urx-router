//! The crate's `rust-version` is the highest one the locked dependencies declare, so a dependency
//! update that raises its own fails here, on the pull request that brings it.
//!
//! The dependencies' values come from `cargo metadata --locked`, which reads every package the
//! lockfile resolves — the other platforms' crates, build dependencies and dev dependencies
//! included — and refuses to run when the lockfile would have to change.

use std::process::Command;

/// A `rust-version` value as (major, minor, patch), a missing part read as 0.
fn parse(version: &str) -> (u64, u64, u64) {
    let mut parts = version.split('.').map(|part| {
        part.parse::<u64>()
            .unwrap_or_else(|_| panic!("rust-version {version:?} is not a dotted number"))
    });
    let major = parts.next().expect("a rust-version has a major part");
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    assert!(
        parts.next().is_none(),
        "rust-version {version:?} has more than three parts"
    );
    (major, minor, patch)
}

#[test]
fn rust_version_is_the_highest_the_locked_dependencies_declare() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--manifest-path",
            manifest,
        ])
        .output()
        .expect("cargo metadata runs");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata prints JSON");
    let packages = metadata["packages"]
        .as_array()
        .expect("cargo metadata lists packages");

    let own = env!("CARGO_PKG_NAME");
    let declared = env!("CARGO_PKG_RUST_VERSION");
    assert!(
        !declared.is_empty(),
        "src-tauri/Cargo.toml declares no rust-version"
    );

    let highest = packages
        .iter()
        .filter(|package| package["name"] != own)
        .filter_map(|package| {
            let version = package["rust_version"].as_str()?;
            Some((
                parse(version),
                version,
                package["name"].as_str()?,
                package["version"].as_str()?,
            ))
        })
        .max_by_key(|(parsed, ..)| *parsed)
        .expect("some locked dependency declares a rust-version");

    assert_eq!(
        parse(declared),
        highest.0,
        "src-tauri/Cargo.toml declares rust-version {declared}, while the highest any locked \
         dependency declares is {} ({} {})",
        highest.1,
        highest.2,
        highest.3
    );
}
