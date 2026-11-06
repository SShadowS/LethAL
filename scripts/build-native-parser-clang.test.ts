// R834: no clang at all is a named refusal, not a stack trace; a real clang still passes.
import { describe, expect, test } from "bun:test";
import { ClangNotFoundError, clangCc } from "./build-native-parser";

const out = (s: string) => ({ exitCode: 0, stdout: Buffer.from(s), stderr: Buffer.from("") });

describe("clangCc", () => {
  test("a spawn that cannot start clang throws ClangNotFoundError naming the installer and LLVM_BIN", () => {
    const spawn = () => {
      throw new Error('Executable not found in $PATH: "clang"');
    };
    let err: unknown;
    try {
      clangCc(spawn, undefined);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClangNotFoundError);
    const msg = (err as Error).message;
    expect(msg).toContain("bash scripts/install-llvm.sh");
    expect(msg).toContain("export LLVM_BIN");
  });

  test("the pinned clang is accepted, and LLVM_BIN picks the folder", () => {
    const seen: string[][] = [];
    const cc = clangCc((cmd) => {
      seen.push(cmd);
      return out("clang version 23.1.2 (https://x)\n");
    }, "/opt/llvm/bin");
    expect(cc.startsWith("/opt/llvm/bin")).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test("a wrong clang is still the older plain refusal, not ClangNotFoundError", () => {
    expect(() => clangCc(() => out("clang version 17.0.0\n"), undefined)).toThrow(/is not clang/);
    expect(() => clangCc(() => out("clang version 17.0.0\n"), undefined)).not.toThrow(
      ClangNotFoundError,
    );
  });
});
