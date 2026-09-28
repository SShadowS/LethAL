import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRAMMAR_PIN,
  type NativeBinding,
  type NativeInfo,
  NativeParserLoadError,
  NativeParserMissingError,
  NativeParserPinError,
  NativeParserStaleError,
  checkBinding,
  initNativeParser,
  liveParseResults,
  loadBindingFor,
  localBindingSourceSha256,
  nativeInfo,
  parseALNative,
  parsesSinceStart,
} from "../../src/ast/native-parser";

const CRATE = join(import.meta.dir, "..", "..", "native");

describe("native parser binding", () => {
  it("was built from the crate sources in this working tree (rebuild: bun scripts/build-native-parser.ts)", () => {
    expect(nativeInfo().bindingSourceSha256).toBe(localBindingSourceSha256(CRATE));
  });

  it("matches the grammar pin, grammar input hashes included", () => {
    const info = nativeInfo();
    expect({
      grammarVersion: info.grammarVersion,
      treeSitterVersion: info.treeSitterVersion,
      languageAbi: info.languageAbi,
      kindTableSha256: info.kindTableSha256,
      grammarInputs: info.grammarInputs,
    }).toEqual(GRAMMAR_PIN);
  });

  it("names the platform and the fix when there is no binary", () => {
    expect(() => loadBindingFor("linux-riscv64")).toThrow(NativeParserMissingError);
    expect(() => loadBindingFor("linux-riscv64")).toThrow(/linux-riscv64.*build-native-parser/s);
  });

  it("reports a present but unloadable binary as a load failure, with the loader's error", () => {
    // A text file named like an addon: it resolves, then dlopen refuses it.
    const key = "test-unloadable";
    const file = join(import.meta.dir, "..", "..", "vendor", "native", `lethal-parser.${key}.node`);
    writeFileSync(file, "not a shared library");
    try {
      let err: unknown;
      try {
        loadBindingFor(key);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NativeParserLoadError);
      expect(err).not.toBeInstanceOf(NativeParserMissingError);
      expect(String((err as Error).message)).toMatch(/test-unloadable.*could not be loaded/s);
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect(((err as Error).cause as { code?: unknown }).code).toBe("ERR_DLOPEN_FAILED");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("a compiled binary without its embedded addon names the key it embeds, not the host's", () => {
    // `bun build --compile` defines __LETHAL_NATIVE_KEY__; defining one with no .node on disk is a
    // release binary that shipped without its addon.
    const loader = join(import.meta.dir, "..", "..", "src", "ast", "native-parser.ts");
    const r = Bun.spawnSync([
      "bun",
      "--define",
      '__LETHAL_NATIVE_KEY__="linux-riscv64"',
      "-e",
      `const { loadBindingFor } = require(${JSON.stringify(loader)});
       try { loadBindingFor("win32-x64"); } catch (e) { console.log(e.name, e.platformKey); }`,
    ]);
    expect(r.stdout.toString().trim()).toBe("NativeParserMissingError linux-riscv64");
  });

  it("parses after init", async () => {
    await initNativeParser();
    const parsed = parseALNative("codeunit 50100 X { }");
    expect(parsed.flat.kindNames[parsed.flat.kind[0] ?? -1]).toBe("source_file");
  });

  it("returns the layout FlatNode reads: exact typed-array types, 4 points per node, -1 for no sibling", async () => {
    await initNativeParser();
    const { flat } = parseALNative("codeunit 50100 X { procedure P() begin end; }");
    const types = Object.fromEntries(
      Object.entries(flat).map(([k, v]) => [k, (v as object).constructor.name]),
    );
    expect(types).toEqual({
      kindNames: "Array",
      kind: "Uint16Array",
      fieldNames: "Array",
      field: "Uint16Array",
      flags: "Uint8Array",
      childCount: "Uint32Array",
      nextSibling: "Int32Array",
      startIndex: "Uint32Array",
      endIndex: "Uint32Array",
      points: "Uint32Array",
    });
    expect(flat.kind.length).toBeGreaterThan(1);
    expect(flat.points.length).toBe(4 * flat.kind.length);
    expect(flat.nextSibling[0]).toBe(-1);
  });

  const real = () => nativeInfo();
  const fake = (over: Partial<NativeInfo>): NativeBinding => ({
    parseFlat: () => {
      throw new Error("not called");
    },
    nativeInfo: () => ({ ...real(), ...over }),
  });
  const crate = CRATE;
  const key = `${process.platform}-${process.arch}`;

  it("source mode refuses an addon built from other crate sources", () => {
    expect(() => checkBinding(fake({ bindingSourceSha256: "0".repeat(64) }), key, crate)).toThrow(
      NativeParserStaleError,
    );
  });
  it("compiled mode does not read the crate", () => {
    expect(() =>
      checkBinding(fake({ bindingSourceSha256: "0".repeat(64) }), key, null),
    ).not.toThrow();
  });
  it("refuses an addon built for another platform or arch", () => {
    expect(() =>
      checkBinding(fake({ target: "aarch64-unknown-linux-gnu" }), "win32-x64", crate),
    ).toThrow(NativeParserPinError);
  });
  it("the real addon passes every check", () => {
    expect(() => checkBinding(loadBindingFor(key), key, crate)).not.toThrow();
  });

  // The release rule: LLVM clang 23.1.2 exactly (build-native-parser.ts CLANG_VERSION, build.rs).
  const PINNED_CLANG = /^clang version 23\.1\.2(?: |$)/;
  it("was built by clang 23.1.2 (release rule)", () => {
    expect(nativeInfo().cCompiler).toMatch(PINNED_CLANG);
  });
  it("the compiler pin refuses any other version", () => {
    for (const b of [
      "clang version 23.1.1 (x)",
      "clang version 23.1.20",
      "Apple clang version 23.1.2",
    ])
      expect(b).not.toMatch(PINNED_CLANG);
  });

  it("counts live parse results and releases them after GC", async () => {
    await initNativeParser();
    const before = liveParseResults();
    const t0 = parsesSinceStart();
    (() => {
      for (let i = 0; i < 200; i++) parseALNative("codeunit 50100 X { }");
    })();
    expect(parsesSinceStart() - t0).toBe(200); // monotonic: a GC during the loop cannot lower it
    expect(liveParseResults()).toBeGreaterThanOrEqual(before + 1);
    for (let k = 0; k < 20 && liveParseResults() > before + 5; k++) {
      Bun.gc(true);
      await new Promise((r) => setImmediate(r));
    }
    expect(liveParseResults()).toBeLessThanOrEqual(before + 5);
  });
});
