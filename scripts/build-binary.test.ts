// R834: build:binary refuses a target whose native parser addon is missing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAddonMissingError, requireNativeAddon } from "./build-binary";

describe("requireNativeAddon", () => {
  test("a missing addon throws the typed error, naming the install and the build command", () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-addon-"));
    try {
      let err: unknown;
      try {
        requireNativeAddon({ nativeKey: "linux-x64" }, dir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NativeAddonMissingError);
      const msg = (err as Error).message;
      expect(msg).toContain("lethal-parser.linux-x64.node");
      expect(msg).toContain("bun scripts/build-native-parser.ts");
      expect(msg).toContain("clang/LLVM 23.1.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a present addon passes, and only its own key counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-addon-"));
    try {
      writeFileSync(join(dir, "lethal-parser.linux-x64.node"), "x");
      expect(() => requireNativeAddon({ nativeKey: "linux-x64" }, dir)).not.toThrow();
      expect(() => requireNativeAddon({ nativeKey: "win32-x64" }, dir)).toThrow(
        NativeAddonMissingError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
