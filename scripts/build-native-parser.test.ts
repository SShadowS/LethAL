import { describe, expect, it } from "bun:test";
import { cargoEnv } from "./build-native-parser";

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
