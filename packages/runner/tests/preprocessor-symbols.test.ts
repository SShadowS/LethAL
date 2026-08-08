import { describe, expect, test } from "bun:test";
import { buildAlRunnerArgv } from "../src/al-runner-transport";
import { ArtifactCompiler } from "../src/artifact";
import type { ArtifactIo } from "../src/artifact";
import { validatePreprocessorSymbols } from "../src/cli";

/**
 * R101(c) — AL preprocessor symbols, on BOTH compile paths.
 *
 * MEASURED 2026-08-09 (`scripts/r101c-define-probe/`): with a symbol undefined, `alc` does NOT fail.
 * It compiles the `#else` branch cleanly and emits a different artifact — four `/define:` variants
 * of one source produced four distinct hashes and four exit-zero compiles. So the failure mode this
 * closes is silent, not loud, which is why the tests below check that the flag REACHES both
 * compilers rather than merely that a config key parses.
 *
 * The row's own framing was wrong twice: it called this an al-runner gap, when the gap is in
 * LethAL's OWN `alc` step first, and al-runner 2.1.1 has had `--define` all along.
 */

const MANIFEST = {
  selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  artifactId: "a",
  mutants: [],
};

function fakeIo(calls: string[][]): ArtifactIo {
  return {
    spawn: async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readArtifact: async () => new Uint8Array([1, 2, 3]),
    writeArtifact: async () => {},
  };
}

async function alcArgv(preprocessorSymbols?: readonly string[]): Promise<string[]> {
  const calls: string[][] = [];
  const compiler = new ArtifactCompiler(
    {
      alcPath: "alc",
      packageCachePath: "/pkg",
      outputDir: "/out",
      ...(preprocessorSymbols !== undefined ? { preprocessorSymbols } : {}),
    },
    fakeIo(calls),
  );
  await compiler.compile({
    projectDir: "/proj",
    artifactId: "a",
    appId: "app",
    appVersion: "1.0.0.0",
    mutantManifest: MANIFEST,
    appManifest: {},
  });
  return calls[0] ?? [];
}

describe("preprocessor symbols reach LethAL's own alc step (R101(c))", () => {
  test("comma-joined into a single /define:, matching what was measured", async () => {
    const argv = await alcArgv(["DOSMTP", "CLOUD"]);
    expect(argv).toContain("/define:DOSMTP,CLOUD");
  });

  test("the flag is OMITTED entirely when nothing is configured", async () => {
    // `/define:` with no value is a different thing to say to a compiler than not saying it, and
    // the measurement shows the no-flag case is a real, distinct build rather than a neutral one.
    const argv = await alcArgv();
    expect(argv.some((a) => a.startsWith("/define"))).toBe(false);
  });

  test("an empty list is also omitted, not sent empty", async () => {
    const argv = await alcArgv([]);
    expect(argv.some((a) => a.startsWith("/define"))).toBe(false);
  });
});

describe("preprocessor symbols reach al-runner too (R101(c))", () => {
  test("one repeated --define per symbol", () => {
    // 2.1.1 has both `--define SYM` and `--preprocessor-symbols A,B,...`, and its own help says the
    // comma form's entries are "validated identically to --define". The repeated form is used
    // because it cannot be broken by a symbol that ever contains a comma.
    const argv = buildAlRunnerArgv("al-runner", {
      sourceDir: "/src",
      testDir: "/tests",
      qualifiedTest: "Codeunit1.T",
      preprocessorSymbols: ["DOSMTP", "CLOUD"],
    });
    expect(argv.filter((a) => a === "--define").length).toBe(2);
    expect(argv).toContain("DOSMTP");
    expect(argv).toContain("CLOUD");
  });

  test("absent when nothing is configured", () => {
    const argv = buildAlRunnerArgv("al-runner", {
      sourceDir: "/src",
      testDir: "/tests",
      qualifiedTest: "Codeunit1.T",
    });
    expect(argv).not.toContain("--define");
  });
});

describe("validatePreprocessorSymbols (R101(c))", () => {
  test("absent is an empty list, which is itself a real configuration", () => {
    expect(validatePreprocessorSymbols(undefined)).toEqual([]);
  });

  test("accepts a plain list", () => {
    expect(validatePreprocessorSymbols(["DOSMTP", "CLOUD"])).toEqual(["DOSMTP", "CLOUD"]);
  });

  test("refuses a non-array", () => {
    expect(() => validatePreprocessorSymbols("DOSMTP")).toThrow(/must be an array/);
  });

  test("refuses an empty or non-string entry", () => {
    expect(() => validatePreprocessorSymbols([""])).toThrow(/non-string or empty/);
    expect(() => validatePreprocessorSymbols([42])).toThrow(/non-string or empty/);
  });

  test("refuses a separator inside a symbol rather than splitting it", () => {
    // `alc`'s list form would split "A,B" into two symbols nobody wrote, and al-runner would take it
    // as one unusable token. Quietly picking either reading reproduces the defect this key closes:
    // a build compiled from a branch the author did not choose.
    expect(() => validatePreprocessorSymbols(["A,B"])).toThrow(/separator/);
    expect(() => validatePreprocessorSymbols(["A;B"])).toThrow(/separator/);
    expect(() => validatePreprocessorSymbols(["A B"])).toThrow(/separator/);
    expect(() => validatePreprocessorSymbols([" A"])).toThrow(/separator/);
  });
});
