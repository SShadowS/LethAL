import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { cargoEnv, cargoTargetDir, isPinnedClang } from "./build-native-parser";
import { CRATE } from "./check-native-grammar";

describe("cargoEnv", () => {
  const stray = {
    PATH: "/bin",
    CC: "gcc",
    cc: "gcc",
    CC_x86_64_pc_windows_msvc: "cl.exe",
    "CC_x86_64-pc-windows-msvc": "cl.exe",
    cc_x86_64_unknown_linux_gnu: "gcc",
    TARGET_CC: "cl.exe",
    HOST_CC: "cl.exe",
    CFLAGS: "-O0",
    CFLAGS_x86_64_pc_windows_msvc: "/Od",
    TARGET_CFLAGS: "/Od",
    HOST_CFLAGS: "/Od",
    CCACHE_DIR: "/keep",
    LETHAL_GRAMMAR_INPUTS: "stale",
  };
  const env = cargoEnv(stray, "clang-cl.exe", "parser.c:x");

  it("sets CC to the checked clang and the grammar inputs", () => {
    expect(env.CC).toBe("clang-cl.exe");
    expect(env.LETHAL_GRAMMAR_INPUTS).toBe("parser.c:x");
  });
  it("drops every other compiler or C-flag override cc-rs would read", () => {
    expect(Object.keys(env).sort()).toEqual(["CC", "CCACHE_DIR", "LETHAL_GRAMMAR_INPUTS", "PATH"]);
  });
});

describe("isPinnedClang", () => {
  it("accepts LLVM clang 23.1.2 with or without a repository suffix", () => {
    expect(isPinnedClang("clang version 23.1.2")).toBe(true);
    expect(
      isPinnedClang("clang version 23.1.2 (https://github.com/llvm/llvm-project 85ac560)"),
    ).toBe(true);
  });
  it("refuses any other version, and Apple clang", () => {
    for (const b of [
      "clang version 23.1.1 (x)",
      "clang version 23.1.20",
      "Apple clang version 23.1.2",
      "",
    ])
      expect(isPinnedClang(b)).toBe(false);
  });
});

describe("cargoTargetDir", () => {
  it("resolves a relative CARGO_TARGET_DIR against the caller's cwd, not the crate dir", () => {
    const root = resolve("/repo");
    expect(cargoTargetDir({ CARGO_TARGET_DIR: "packages/engine/native/target" }, root)).toBe(
      join(root, "packages", "engine", "native", "target"),
    );
  });
  it("keeps an absolute one and defaults to the crate's target dir", () => {
    const abs = resolve("/shared/target");
    expect(cargoTargetDir({ CARGO_TARGET_DIR: abs }, resolve("/repo"))).toBe(abs);
    expect(cargoTargetDir({}, resolve("/repo"))).toBe(join(CRATE, "target"));
  });
});
