use sha2::{Digest, Sha256};
use std::env;
use std::process::Command;

const SOURCES: [&str; 4] = ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"];

fn main() {
    napi_build::setup();
    let mut h = Sha256::new();
    for f in SOURCES {
        println!("cargo:rerun-if-changed={f}");
        let text = std::fs::read_to_string(f).unwrap_or_else(|e| panic!("cannot read {f}: {e}"));
        h.update(f.as_bytes());
        h.update(b"\n");
        h.update(text.replace('\r', "").as_bytes());
        h.update(b"\n");
    }
    println!("cargo:rustc-env=LETHAL_BINDING_SOURCE_SHA256={:x}", h.finalize());

    println!("cargo:rerun-if-env-changed=LETHAL_GRAMMAR_INPUTS");
    let grammar = env::var("LETHAL_GRAMMAR_INPUTS").unwrap_or_else(|_| {
        panic!("LETHAL_GRAMMAR_INPUTS is not set: build with `bun scripts/build-native-parser.ts`, which checks the grammar sources first")
    });
    println!("cargo:rustc-env=LETHAL_GRAMMAR_INPUTS={grammar}");

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let out = Command::new(rustc).arg("-V").output().expect("cannot run rustc -V");
    println!("cargo:rustc-env=LETHAL_RUSTC_VERSION={}", String::from_utf8_lossy(&out.stdout).trim());
    println!("cargo:rustc-env=LETHAL_TARGET={}", env::var("TARGET").expect("cargo sets TARGET"));
    // RUST-03: which C compiler built the grammar, from the same CC cc-rs will use.
    println!("cargo:rerun-if-env-changed=CC");
    let cc = env::var("CC").unwrap_or_else(|_| panic!("CC is not set: build with `bun scripts/build-native-parser.ts`, which selects clang"));
    let v = Command::new(&cc).arg("--version").output().unwrap_or_else(|e| panic!("cannot run {cc} --version: {e}"));
    let banner = String::from_utf8_lossy(&v.stdout).lines().next().unwrap_or("").trim().to_string();
    println!("cargo:rustc-env=LETHAL_C_COMPILER={banner}");
}
