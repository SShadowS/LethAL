import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaselineRecordedError,
  GATE_BASELINES,
  RECORD_BASELINE_ENV,
  assertGateBaseline,
  assertMatchesBaseline,
  assertMatchesFrozenBaseline,
  parseStageBaseline,
  preflightFrozenBaseline,
  preflightGateBaseline,
  preflightReadOnlyBaseline,
  recordRequested,
} from "../itest/baseline-guard";
import type { MutantOutcome, SessionReport } from "../src/report";

function outcome(
  overrides: Partial<MutantOutcome> & Pick<MutantOutcome, "mutantCode">,
): MutantOutcome {
  return {
    file: "SandboxLogic.Codeunit.al",
    line: 10,
    operatorName: "conditional-boundary",
    verdict: "survived",
    batchIndex: 0,
    astHash: `hash-${overrides.mutantCode}`,
    codeunitName: "Sandbox Logic",
    operatorMajor: 1,
    runner: "fenced",
    durationMs: 0,
    procedureName: "Post",
    startIndex: 0,
    endIndex: 1,
    originalText: "Original();",
    mutatedText: "",
    coveringTests: [],
    ...overrides,
  };
}

function report(mutants: readonly MutantOutcome[]): SessionReport {
  const counts = {
    killed: mutants.filter((m) => m.verdict === "killed").length,
    survived: mutants.filter((m) => m.verdict === "survived").length,
    noCoverage: mutants.filter((m) => m.verdict === "no-coverage").length,
    timeoutKilled: mutants.filter((m) => m.verdict === "timeout-killed").length,
    knownSurvivors: mutants.filter((m) => m.verdict === "known-survivor").length,
    unstable: mutants.filter((m) => m.cause === "unstable").length,
    errors: mutants.filter((m) => m.verdict === "error").length,
    deadlineExceeded: mutants.filter((m) => m.cause === "deadline-exceeded").length,
  };
  return {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: mutants.length,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts,
    mutationScore: null,
    mutants,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
    unplaceableCount: 0,
    unplaceableMutants: [],
    untargetedTriggerCount: 0,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-baseline-guard-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertMatchesBaseline", () => {
  test("no committed baseline: records this run's verdicts as the new baseline and does not throw", async () => {
    const path = join(dir, "baseline.json");
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "OverBudgetDetected" }),
      outcome({ mutantCode: "M0002", astHash: "hash-M0002", verdict: "survived" }),
    ]);
    await assertMatchesBaseline(r, path, "test itest");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual([
      {
        key: "hash-M0001|Sandbox Logic|Post|conditional-boundary|1",
        verdict: "killed",
        killingTest: "OverBudgetDetected",
        coverageFiltered: false,
        errorClass: null,
      },
      {
        key: "hash-M0002|Sandbox Logic|Post|conditional-boundary|1",
        verdict: "survived",
        killingTest: null,
        coverageFiltered: false,
        errorClass: null,
      },
    ]);
  });

  test("a committed baseline that matches (mutantCode renumbered, semantic identity unchanged) does not throw", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest"); // records the baseline

    // A "second run" whose mutant got renumbered (M0099, not M0001) but keeps the same semantic
    // identity — must NOT be reported as a regression (mirrors mutant-equality.test.ts's own
    // "ignores fields outside the comparable set" case).
    const second = report([
      outcome({ mutantCode: "M0099", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).resolves.toBeUndefined();
  });

  test("a committed baseline that DIFFERS throws, naming the differing mutant", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest"); // records the baseline

    // Same mutant, verdict flipped killed -> survived: a real per-mutant regression.
    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "survived" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /per-mutant regression/,
    );
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /verdict killed -> survived/,
    );
  });

  test("a per-mutant swap with unchanged aggregate counts still throws (the whole point of this guard)", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-A", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-B", verdict: "survived" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest");

    // Aggregate counts (1 killed, 1 survived) are identical — only WHICH mutant holds which
    // verdict changed. An aggregate-only comparison (assertVerdictTable's counts) would see no
    // regression at all; this guard must still catch it.
    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-A", verdict: "survived" }),
      outcome({ mutantCode: "M0002", astHash: "hash-B", verdict: "killed", killingTest: "T1" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /per-mutant regression/,
    );
  });
});

describe("assertMatchesFrozenBaseline (R321)", () => {
  const r = () =>
    report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "RateSmall" })]);

  test("no committed baseline and no record mode: refuses, and writes nothing", async () => {
    const path = join(dir, "al-runner.symbols-lethala.baseline.json");
    await expect(assertMatchesFrozenBaseline(r(), path, "t", false)).rejects.toThrow(
      /never records one silently/,
    );
    expect(existsSync(path)).toBe(false);
  });

  test("record mode with no baseline: records it", async () => {
    const path = join(dir, "al-runner.symbols-lethala.baseline.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    expect(existsSync(path)).toBe(true);
  });

  test("record mode with a baseline present: refuses to overwrite it", async () => {
    const path = join(dir, "al-runner.symbols-lethala.baseline.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    const before = await readFile(path, "utf8");
    await expect(assertMatchesFrozenBaseline(r(), path, "t", true)).rejects.toThrow(
      /refuses to overwrite/,
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a committed baseline is compared, and a difference throws", async () => {
    const path = join(dir, "al-runner.symbols-lethala.baseline.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    await assertMatchesFrozenBaseline(r(), path, "t", false);
    const moved = report([outcome({ mutantCode: "M0001", verdict: "survived" })]);
    await expect(assertMatchesFrozenBaseline(moved, path, "t", false)).rejects.toThrow(
      /per-mutant regression/,
    );
  });
});

describe("R332: a frozen baseline never records itself", () => {
  const NAME = "bcdev.baseline.json"; // a registered gate basename, placed in a temp dir
  const r = () =>
    report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "RateSmall" })]);
  const arm = (v: string): NodeJS.ProcessEnv => ({ [RECORD_BASELINE_ENV]: v });
  const none: NodeJS.ProcessEnv = {};

  test("recordRequested: exact registered basenames only; either slash on Windows, only / on POSIX", () => {
    const p = join(dir, NAME);
    expect(recordRequested(p, none)).toBe(false);
    expect(recordRequested(p, arm(""))).toBe(false);
    expect(recordRequested(p, arm(NAME))).toBe(true);
    expect(recordRequested(p, arm(`tables.baseline.json, ${NAME}`))).toBe(true);
    expect(recordRequested(p, arm("tables.baseline.json"))).toBe(false);
    expect(recordRequested(`${dir.replace(/\\/g, "/")}/${NAME}`, arm(NAME))).toBe(true);
    // R411: a backslash separates path segments on Windows only. On POSIX it is an ordinary
    // file-name character, so the whole backslash string is ONE basename that names no gate file,
    // and arming NAME must not arm it.
    expect(recordRequested(`${dir.replace(/\//g, "\\")}\\${NAME}`, arm(NAME))).toBe(
      process.platform === "win32",
    );
  });

  test("recordRequested throws on =1, a typo, a wrong case, a path, or a symbol file", () => {
    const p = join(dir, NAME);
    for (const bad of [
      "1",
      "bcdev.json",
      "BCDEV.baseline.json",
      "packages/runner/itest/bcdev.baseline.json",
      "al-runner.symbols-lethala.baseline.json",
    ]) {
      expect(() => recordRequested(p, arm(bad))).toThrow(/not a gate baseline/);
    }
  });

  test("the registry names eight gate baselines and their record commands", () => {
    expect(Object.keys(GATE_BASELINES).sort()).toEqual([
      "al-runner.baseline.json",
      "al-runner.cli-default.baseline.json",
      "al-runner.layout.baseline.json",
      "al-runner.multiobject.baseline.json",
      "bcdev.baseline.json",
      "envtool.baseline.json",
      "harden.baseline.json",
      "tables.baseline.json",
    ]);
    for (const [name, how] of Object.entries(GATE_BASELINES)) {
      expect(how).toContain(`${RECORD_BASELINE_ENV}=${name} bun run itest:`);
    }
  });

  test("an unregistered basename is refused, not guessed", async () => {
    await expect(
      assertGateBaseline(r(), join(dir, "stray.baseline.json"), "t", none),
    ).rejects.toThrow(/not a registered frozen baseline/);
  });

  test("missing, record off: refused, names the command, writes nothing", async () => {
    const p = join(dir, NAME);
    const err = await assertGateBaseline(r(), p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/never records one silently/);
    expect((err as Error).message).toContain(GATE_BASELINES[NAME] ?? "unreachable");
    expect(existsSync(p)).toBe(false);
  });

  test("arming another file does not arm this one", async () => {
    const p = join(dir, NAME);
    await expect(assertGateBaseline(r(), p, "t", arm("tables.baseline.json"))).rejects.toThrow(
      /never records one silently/,
    );
    expect(existsSync(p)).toBe(false);
  });

  test("missing, record on: writes once, byte-identical to the old writer, then BaselineRecordedError", async () => {
    const p = join(dir, NAME);
    const ref = join(dir, "reference.json");
    await assertMatchesBaseline(r(), ref, "ref");
    const err = await assertGateBaseline(r(), p, "t", arm(NAME)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaselineRecordedError);
    expect((err as Error).message).toMatch(/NOT a pass/);
    expect(await readFile(p, "utf8")).toBe(await readFile(ref, "utf8"));
  });

  test("present, record on: the write itself refuses (wx), bytes unchanged", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "sentinel\n", "utf8");
    await expect(assertGateBaseline(r(), p, "t", arm(NAME))).rejects.toThrow(
      /refuses to overwrite/,
    );
    expect(await readFile(p, "utf8")).toBe("sentinel\n");
  });

  test("present, match, record off: passes", async () => {
    const p = join(dir, NAME);
    await assertMatchesBaseline(r(), p, "seed");
    await expect(assertGateBaseline(r(), p, "t", none)).resolves.toBeUndefined();
  });

  test("present, mismatch: throws, names the command and the pre-commitment, never re-records", async () => {
    const p = join(dir, NAME);
    await assertMatchesBaseline(r(), p, "seed");
    const before = await readFile(p, "utf8");
    const moved = report([outcome({ mutantCode: "M0001", verdict: "survived" })]);
    const err = await assertGateBaseline(moved, p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/per-mutant regression/);
    expect((err as Error).message).toMatch(/pre-commitment/);
    expect((err as Error).message).toContain(GATE_BASELINES[NAME] ?? "unreachable");
    expect(await readFile(p, "utf8")).toBe(before);
  });

  test("preflightGateBaseline: refuses missing (off) and present (on); allows the other two", async () => {
    const p = join(dir, NAME);
    expect(() => preflightGateBaseline(p, "t", none)).toThrow(/never records one silently/);
    expect(() => preflightGateBaseline(p, "t", arm(NAME))).not.toThrow();
    await writeFile(p, "[]\n", "utf8");
    expect(() => preflightGateBaseline(p, "t", none)).not.toThrow();
    expect(() => preflightGateBaseline(p, "t", arm(NAME))).toThrow(/refuses to overwrite/);
  });

  test("preflightReadOnlyBaseline: refuses a missing file with the OWNING gate's command, ignores record mode", async () => {
    const p = join(dir, NAME);
    expect(() => preflightReadOnlyBaseline(p, "verify itest")).toThrow(
      GATE_BASELINES[NAME] ?? "unreachable",
    );
    await writeFile(p, "[]\n", "utf8");
    expect(() => preflightReadOnlyBaseline(p, "verify itest")).not.toThrow();
  });

  test("preflightFrozenBaseline refuses an unregistered path in record mode too, naming it", () => {
    const p = join(dir, "stray.baseline.json");
    expect(() => preflightFrozenBaseline(p, "t", false)).toThrow(
      /not a registered frozen baseline/,
    );
    expect(() => preflightFrozenBaseline(p, "t", true)).toThrow(/not a registered frozen baseline/);
    expect(() => preflightFrozenBaseline(p, "t", true)).toThrow(p);
  });

  test("a baseline of [] never matches, even a zero-mutant report (empty-vs-empty)", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "[]\n", "utf8");
    const empty = report([]);
    const err = await assertGateBaseline(empty, p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/non-empty array/);
    expect((err as Error).message).toContain(p);
  });

  test("a baseline of {} is refused, naming the file", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "{}\n", "utf8");
    const err = await assertGateBaseline(r(), p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/non-empty array/);
    expect((err as Error).message).toContain(p);
  });

  test("a baseline of null is refused, naming the file", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "null\n", "utf8");
    const err = await assertGateBaseline(r(), p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/non-empty array/);
    expect((err as Error).message).toContain(p);
  });

  test("malformed JSON in the baseline is refused, naming the file and the record command", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "{not valid json\n", "utf8");
    const err = await assertGateBaseline(r(), p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not valid JSON/);
    expect((err as Error).message).toContain(p);
    expect((err as Error).message).toContain(GATE_BASELINES[NAME] ?? "unreachable");
  });

  test("record armed for a different registered gate prints a stderr warning naming both; verdict unchanged", async () => {
    const p = join(dir, NAME);
    await assertMatchesBaseline(r(), p, "seed");
    const originalError = console.error;
    const seen: string[] = [];
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      await expect(
        assertGateBaseline(r(), p, "t", arm("tables.baseline.json")),
      ).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }
    const warned = seen.join("\n");
    expect(warned).toContain("tables.baseline.json");
    expect(warned).toContain(NAME);
  });

  test("BaselineRecordedError sets this.name, not just its constructor", async () => {
    const p = join(dir, NAME);
    const ref = join(dir, "reference2.json");
    await assertMatchesBaseline(r(), ref, "ref");
    const err = await assertGateBaseline(r(), p, "t", arm(NAME)).catch((e: unknown) => e);
    expect((err as Error).name).toBe("BaselineRecordedError");
  });
});

describe("R332 finding C: the R321 symbol writer is exclusive too", () => {
  const SYM = "al-runner.symbols-lethala.baseline.json";
  const r = () => report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T" })]);

  test("record mode never overwrites a symbol file, even with no preflight in front of it", async () => {
    const p = join(dir, SYM);
    await writeFile(p, "sentinel\n", "utf8");
    await expect(assertMatchesFrozenBaseline(r(), p, "t", true)).rejects.toThrow(
      /refuses to overwrite/,
    );
    expect(await readFile(p, "utf8")).toBe("sentinel\n");
  });

  test("preflightFrozenBaseline covers both symbol files before either is written", async () => {
    const a = join(dir, SYM);
    const b = join(dir, "al-runner.symbols-lethalb.baseline.json");
    await writeFile(b, "[]\n", "utf8");
    // record run, a absent, b present: the preflight must stop it before a is written
    expect(() => {
      for (const p of [a, b]) preflightFrozenBaseline(p, "t", true);
    }).toThrow(/refuses to overwrite/);
    expect(existsSync(a)).toBe(false);
    expect(() => preflightFrozenBaseline(a, "t", false)).toThrow(
      /LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1/,
    );
  });

  test("assertMatchesFrozenBaseline refuses a gate basename, even though it is registered somewhere", async () => {
    const p = join(dir, "bcdev.baseline.json");
    await expect(assertMatchesFrozenBaseline(r(), p, "t", true)).rejects.toThrow(
      /not a registered symbol baseline/,
    );
    expect(existsSync(p)).toBe(false);
  });
});

describe("R296: a baseline mismatch reaches stderr with its difference lines", () => {
  // Bun drops an async-thrown Error's message from `.stack` when a GC runs before the first read
  // (oven-sh/bun#34398). A live gate collects plenty; here `Bun.gc(true)` forces it. The child
  // prints exactly as every gate's catch does, `err.stack ?? err.message`, and is a separate
  // process so stderr is captured the way a gate's is.
  test("the per-mutant line survives a GC between the throw and the gate's print", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r296-"));
    try {
      const baselinePath = join(dir, "tables.baseline.json");
      await writeFile(
        baselinePath,
        JSON.stringify([
          {
            key: "h1|CU|P|lethal.empty-block|1",
            verdict: "killed",
            killingTest: "T",
            coverageFiltered: false,
            errorClass: null,
          },
        ]),
      );
      const guard = join(import.meta.dir, "..", "itest", "baseline-guard.ts");
      const child = join(dir, "gate.ts");
      await writeFile(
        child,
        `import { assertGateBaseline } from ${JSON.stringify(guard)};
const report = { mutants: [{ astHash: "h1", codeunitName: "CU", procedureName: "P", triggerName: "", operatorName: "lethal.empty-block", operatorMajor: 1, identityOrdinal: 0, verdict: "survived", mutantCode: "M0001" }] };
async function main() {
  await assertGateBaseline(report as never, ${JSON.stringify(baselinePath)}, "tables itest", {});
}
main().catch((err: unknown) => {
  Bun.gc(true);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
`,
      );
      const run = Bun.spawnSync([process.execPath, child], { cwd: dir });
      const stderr = run.stderr.toString();
      expect(run.exitCode).toBe(1);
      expect(stderr).toContain("tables itest: per-mutant regression");
      expect(stderr).toContain(
        "  - mutant h1|CU|P|lethal.empty-block|1: verdict killed -> survived; killingTest T -> null",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("R355: stage baselines, list form and moded form", () => {
  // Every committed campaign stage baseline, as of R355. All six are the plain list form written
  // before R355, so each must still read, with its coverage mode UNKNOWN rather than assumed.
  // None is rewritten or re-frozen by R355.
  const REPO = join(import.meta.dir, "..", "..", "..");
  const COMMITTED = [
    "docs/campaign/2026-08-03-do/rung1.baseline.json",
    "docs/campaign/2026-08-03-do/rung1.resumed-run.baseline.json",
    "docs/campaign/2026-08-03-do/rung2.baseline.json",
    "docs/campaign/2026-08-08-r85-swap-population/rung2.baseline.json",
    "docs/campaign/2026-08-16-gift-card/rehearsal.baseline.json",
    "examples/credit-limit/demo.baseline.json",
  ];

  test.each(COMMITTED)("%s still reads, as a list with its mode unknown", async (rel) => {
    const path = join(REPO, rel);
    const stage = parseStageBaseline(await readFile(path, "utf8"), path, "remedy");
    expect(stage.coverageMode).toBeUndefined();
    expect(stage.entries.length).toBeGreaterThan(0);
  });

  test("the moded form reads its mode; an unknown mode or shape is refused, naming the file", () => {
    const rows = [
      { key: "k", verdict: "killed", killingTest: "T", coverageFiltered: false, errorClass: null },
    ];
    expect(
      parseStageBaseline(JSON.stringify({ coverageMode: "none", entries: rows }), "p.json", "r")
        .coverageMode,
    ).toBe("none");
    expect(() =>
      parseStageBaseline(JSON.stringify({ coverageMode: "bogus", entries: rows }), "p.json", "r"),
    ).toThrow(/p\.json is neither/);
    expect(() =>
      parseStageBaseline(JSON.stringify({ coverageMode: "none", entries: [] }), "p.json", "r"),
    ).toThrow(/p\.json holds no mutant rows/);
  });
});
