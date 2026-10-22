import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlRunnerArgv } from "../src/al-runner-transport";
import { ArtifactCompiler } from "../src/artifact";
import type { ArtifactIo } from "../src/artifact";
import { validatePreprocessorSymbols } from "../src/cli";
import {
  appJsonSymbols,
  effectiveBuildSymbols,
  sameBuildSymbols,
  validateSymbolList,
} from "../src/preprocessor-symbols";

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

describe("R214: the effective build symbols", () => {
  const snap = (json: unknown) => new Map([["app.json", Buffer.from(JSON.stringify(json))]]);

  test("app.json's symbols come from the snapshot when it has app.json", async () => {
    expect(
      await appJsonSymbols("/nowhere", snap({ preprocessorSymbols: ["BC20", "BC21"] })),
    ).toEqual(["BC20", "BC21"]);
    expect(await appJsonSymbols("/nowhere", snap({ name: "x" }))).toEqual([]);
  });

  test("R205: a snapshot without app.json means none and never reads the disk", async () => {
    const read: string[] = [];
    const disk = async (p: string) => {
      read.push(p);
      return JSON.stringify({ preprocessorSymbols: ["FROM_DISK"] });
    };
    expect(await appJsonSymbols("/p", new Map(), disk)).toEqual([]);
    expect(read).toEqual([]);
  });

  test("a MISSING app.json means none, and only a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-sym-"));
    try {
      expect(await appJsonSymbols(dir, undefined)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const denied = async (): Promise<string> => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    await expect(appJsonSymbols("/p", undefined, denied)).rejects.toThrow(/app\.json.*EACCES/);
  });

  test("app.json's list is validated like the config's, naming app.json", async () => {
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: "BC20" }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" must be an array of strings/,
    );
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: ["A B"] }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" entry "A B" contains whitespace or a separator/,
    );
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: [""] }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" contains a non-string or empty entry/,
    );
  });

  test("an app.json whose root is not an object is refused, never read as no symbols", async () => {
    for (const root of [[], null, 5, "x"]) {
      await expect(appJsonSymbols("/p", snap(root))).rejects.toThrow(
        /app\.json: the root must be a JSON object/,
      );
    }
  });

  test("an app.json that is not valid JSON throws naming app.json, on disk and in the snapshot", async () => {
    await expect(
      appJsonSymbols("/p", new Map([["app.json", Buffer.from("{ nope")]])),
    ).rejects.toThrow(/app\.json: not valid JSON/);
    await expect(appJsonSymbols("/p", undefined, async () => "{ nope")).rejects.toThrow(
      /app\.json: not valid JSON/,
    );
  });

  test("the effective set is the sorted union; case matters (alc, measured)", async () => {
    // Unsorted and duplicated input, so a broken sort or de-duplication goes red (ruling P7).
    expect(
      await effectiveBuildSymbols(
        "/p",
        ["bc20", "CLEAN27"],
        snap({ preprocessorSymbols: ["BC20"] }),
        { kind: "bcdev" },
      ),
    ).toEqual(["BC20", "CLEAN27", "bc20"]);
    expect(
      await effectiveBuildSymbols("/p", ["BC20", "BC20"], snap({ preprocessorSymbols: ["BC20"] }), {
        kind: "bcdev",
      }),
    ).toEqual(["BC20"]);
    expect(sameBuildSymbols(["B", "A"], ["A", "B", "A"])).toBe(true);
    expect(sameBuildSymbols(["A"], ["a"])).toBe(false);
    expect(sameBuildSymbols([], [])).toBe(true);
  });

  test("validateSymbolList keeps the config's exact messages", () => {
    expect(() => validateSymbolList("X", "lethal.config.json")).toThrow(
      'lethal.config.json: "preprocessorSymbols" must be an array of strings, got "X"',
    );
  });
});
