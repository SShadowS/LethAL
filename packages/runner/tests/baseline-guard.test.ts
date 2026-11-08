import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import {
  BaselineRecordedError,
  DUMP_ONLY_KEY,
  GATE_BASELINES,
  NonCurrentRecordRefusedError,
  PinnedRecordRefusedError,
  RECORD_BASELINE_ENV,
  assertGateBaseline,
  assertMatchesBaseline,
  assertRecordOnCurrent,
  assertRecordPinned,
  expectedFileProblems,
  expectedPathFor,
  gitShowHead,
  parseGateBaseline,
  parseStageBaseline,
  preflightFrozenBaseline,
  preflightGateBaseline,
  preflightReadOnlyBaseline,
  readGateBaseline,
  recordRequested,
} from "../itest/baseline-guard";
import { type NormalizedMutant, mutatedTextSha256 } from "../itest/mutant-equality";
import { REDACTION_MARKER } from "../src/explain";
import type { MutantOutcome, SessionReport } from "../src/report";
import { removeScratchDir } from "./helpers/scratch";

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
afterEach(() => {
  removeScratchDir(dir);
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
        mutatedTextSha256: mutatedTextSha256(""),
      },
      {
        key: "hash-M0002|Sandbox Logic|Post|conditional-boundary|1",
        verdict: "survived",
        killingTest: null,
        coverageFiltered: false,
        errorClass: null,
        mutatedTextSha256: mutatedTextSha256(""),
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

  test("recordRequested throws on =1, a typo, a wrong case, a path, or a retired v2 file", () => {
    const p = join(dir, NAME);
    for (const bad of [
      "1",
      "bcdev.json",
      "BCDEV.baseline.json",
      "packages/runner/itest/bcdev.baseline.json",
      "al-runner.symbols-lethala.baseline.json",
      "al-runner.baseline.json",
    ]) {
      expect(() => recordRequested(p, arm(bad))).toThrow(/not a gate baseline/);
    }
  });

  // R654 S2: seventeen, with v3's layout and two symbol-set baselines (pre-committed 43115c78).
  // R654 S3: eleven, the six registered `al-runner.*` (v2) files gone with `itest:alrunner`.
  // R602: thirteen, with v3's multi-object and wrapped legs (pending their record run).
  test("the registry names thirteen gate baselines and their record commands", () => {
    expect(Object.keys(GATE_BASELINES).sort()).toEqual([
      "al-runner-v3.layout.baseline.json",
      "al-runner-v3.multiobject.baseline.json",
      "al-runner-v3.symbols-lethala.baseline.json",
      "al-runner-v3.symbols-lethalb.baseline.json",
      "al-runner-v3.tables.baseline.json",
      "al-runner-v3.wrapped.baseline.json",
      "bcdev.baseline.json",
      "bcdev.names.baseline.json",
      "bcdev.wrapped.baseline.json",
      "envtool.baseline.json",
      "hang.single.baseline.json",
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

  test("missing, record on: writes once in the R556 object form, then BaselineRecordedError", async () => {
    const p = join(dir, NAME);
    const ref = join(dir, "reference.json");
    await assertMatchesBaseline(r(), ref, "ref");
    const err = await assertGateBaseline(r(), p, "t", arm(NAME)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaselineRecordedError);
    expect((err as Error).message).toMatch(/NOT a pass/);
    const written = JSON.parse(await readFile(p, "utf8"));
    expect(written).toEqual({
      identityScheme: IDENTITY_SCHEME,
      entries: JSON.parse(await readFile(ref, "utf8")),
    });
    expect(typeof written.entries[0].mutatedTextSha256).toBe("string");
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

  /** Runs `fn` with console.log captured; returns what it printed. */
  async function logged(fn: () => Promise<unknown>): Promise<string> {
    const original = console.log;
    const seen: string[] = [];
    console.log = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return seen.join("\n");
  }
  const legacyRow = {
    key: "hash-M0001|Sandbox Logic|Post|conditional-boundary|1",
    verdict: "killed",
    killingTest: "RateSmall",
    coverageFiltered: false,
    errorClass: null,
  };
  const hashOf = (text: string) => mutatedTextSha256(text) ?? "unreachable";

  test("R556: a legacy bare-array baseline still passes and says it is UNVERIFIED", async () => {
    const p = join(dir, NAME);
    await writeFile(p, JSON.stringify([legacyRow]), "utf8");
    const out = await logged(() => assertGateBaseline(r(), p, "gate", none));
    expect(out).toContain(
      "gate: baseline predates R556 (no identity scheme, no mutated-text hash): a mutant changed under an unchanged key is UNVERIFIED",
    );
  });

  test("R556: the current scheme with matching hashes passes silently", async () => {
    const p = join(dir, NAME);
    const row = { ...legacyRow, mutatedTextSha256: hashOf("") };
    await writeFile(p, JSON.stringify({ identityScheme: IDENTITY_SCHEME, entries: [row] }), "utf8");
    const out = await logged(() => assertGateBaseline(r(), p, "gate", none));
    expect(out).not.toContain("UNVERIFIED");
    expect(out).not.toContain("identity scheme changed");
  });

  test("R556: a changed hash under an unchanged key fails, naming the key", async () => {
    const p = join(dir, NAME);
    const row = { ...legacyRow, mutatedTextSha256: hashOf("other();") };
    await writeFile(p, JSON.stringify({ identityScheme: IDENTITY_SCHEME, entries: [row] }), "utf8");
    const err = await assertGateBaseline(r(), p, "gate", none).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      `mutant ${legacyRow.key}: mutated text differs under an unchanged key`,
    );
  });

  test("R556: another recorded scheme is stated, never refused by itself", async () => {
    const p = join(dir, NAME);
    const row = { ...legacyRow, mutatedTextSha256: hashOf("") };
    await writeFile(p, JSON.stringify({ identityScheme: 12, entries: [row] }), "utf8");
    const out = await logged(() => assertGateBaseline(r(), p, "gate", none));
    expect(out).toContain(`gate: identity scheme changed (12 -> ${IDENTITY_SCHEME})`);
  });

  test("R556: a hashed baseline REFUSES an actual row without a hash (the check cannot switch itself off)", async () => {
    const p = join(dir, NAME);
    const row = { ...legacyRow, mutatedTextSha256: hashOf("") };
    await writeFile(p, JSON.stringify({ identityScheme: IDENTITY_SCHEME, entries: [row] }), "utf8");
    const redacted = report([
      outcome({
        mutantCode: "M0001",
        verdict: "killed",
        killingTest: "RateSmall",
        mutatedText: REDACTION_MARKER,
      }),
    ]);
    const err = await assertGateBaseline(redacted, p, "gate", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/no mutated-text hash/);
    expect((err as Error).message).toContain(p);
  });

  test("R556: an unknown baseline shape or a non-integer scheme is refused, naming the file", async () => {
    const p = join(dir, NAME);
    for (const body of [
      { rows: [legacyRow] },
      { identityScheme: 37, entries: [legacyRow], mutants: [] },
      { identityScheme: 1.5, entries: [legacyRow] },
      { identityScheme: "37", entries: [legacyRow] },
      { identityScheme: 37 },
      { identityScheme: 37, entries: [] },
      "text",
    ]) {
      await writeFile(p, JSON.stringify(body), "utf8");
      await expect(readGateBaseline(p)).rejects.toThrow(p);
      const err = await assertGateBaseline(r(), p, "gate", none).catch((e: unknown) => e);
      expect((err as Error).message).toContain(p);
    }
  });

  test("R556: readGateBaseline reads the legacy array and the object form", async () => {
    const p = join(dir, NAME);
    await writeFile(p, JSON.stringify([legacyRow]), "utf8");
    expect(await readGateBaseline(p)).toEqual({ entries: [legacyRow] });
    await writeFile(
      p,
      JSON.stringify({ identityScheme: 7, coverageMode: "fenced", entries: [legacyRow] }),
      "utf8",
    );
    expect(await readGateBaseline(p)).toEqual({
      identityScheme: 7,
      coverageMode: "fenced",
      entries: [legacyRow],
    });
  });

  test("BaselineRecordedError sets this.name, not just its constructor", async () => {
    const p = join(dir, NAME);
    const ref = join(dir, "reference2.json");
    await assertMatchesBaseline(r(), ref, "ref");
    const err = await assertGateBaseline(r(), p, "t", arm(NAME)).catch((e: unknown) => e);
    expect((err as Error).name).toBe("BaselineRecordedError");
  });
});

// R654 S3: R321's v2 symbol writer (`assertMatchesFrozenBaseline`) went with `itest:alrunner`; the
// v3 symbol baselines are ordinary gate baselines. Re-pointed to them: the preflight still covers
// both files before either is written.
describe("R332 finding C: a two-file record run is stopped before either file is written", () => {
  const SYM = "al-runner-v3.symbols-lethala.baseline.json";

  test("preflightFrozenBaseline covers both symbol files before either is written", async () => {
    const a = join(dir, SYM);
    const b = join(dir, "al-runner-v3.symbols-lethalb.baseline.json");
    await writeFile(b, "[]\n", "utf8");
    // record run, a absent, b present: the preflight must stop it before a is written
    expect(() => {
      for (const p of [a, b]) preflightFrozenBaseline(p, "t", true);
    }).toThrow(/refuses to overwrite/);
    expect(existsSync(a)).toBe(false);
    expect(() => preflightFrozenBaseline(a, "t", false)).toThrow(
      /LETHAL_ITEST_RECORD_BASELINE=al-runner-v3\.symbols-lethala\.baseline\.json/,
    );
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
  // Every committed campaign stage baseline still in the plain list form written before R355. Each
  // must still read, with its coverage mode UNKNOWN rather than assumed. None is rewritten by R355.
  // R560: credit-limit was re-frozen in the moded form (below); the four DO and swap stages are
  // retired by ruling and stay lists for good.
  const REPO = join(import.meta.dir, "..", "..", "..");
  const COMMITTED = [
    "docs/campaign/2026-08-03-do/rung1.baseline.json",
    "docs/campaign/2026-08-03-do/rung1.resumed-run.baseline.json",
    "docs/campaign/2026-08-03-do/rung2.baseline.json",
    "docs/campaign/2026-08-08-r85-swap-population/rung2.baseline.json",
    // R758: the gift-card stage is re-frozen in the moded form for the talk, so the list form is
    // read from a frozen copy of its scheme-3 baseline instead of the live campaign file.
    "packages/runner/tests/__fixtures__/gift-card-scheme3.baseline.json",
  ];

  test.each(COMMITTED)("%s still reads, as a list with its mode unknown", async (rel) => {
    const path = join(REPO, rel);
    const stage = parseStageBaseline(await readFile(path, "utf8"), path, "remedy");
    expect(stage.coverageMode).toBeUndefined();
    expect(stage.entries.length).toBeGreaterThan(0);
  });

  test("R560: examples/credit-limit/demo.baseline.json reads in the moded form, fenced, every row hashed", async () => {
    const path = join(REPO, "examples/credit-limit/demo.baseline.json");
    const stage = parseStageBaseline(await readFile(path, "utf8"), path, "remedy");
    expect(stage.coverageMode).toBe("fenced");
    expect(stage.identityScheme).toBe(45);
    expect(stage.entries).toHaveLength(45);
    expect(stage.entries.every((e) => e.mutatedTextSha256 !== undefined)).toBe(true);
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

  test("R556: a stage records an optional integer identityScheme; anything else is refused", () => {
    const rows = [
      { key: "k", verdict: "killed", killingTest: "T", coverageFiltered: false, errorClass: null },
    ];
    const read = (identityScheme: unknown) =>
      parseStageBaseline(
        JSON.stringify({ coverageMode: "none", identityScheme, entries: rows }),
        "p.json",
        "r",
      );
    expect(read(37).identityScheme).toBe(37);
    expect(read(undefined).identityScheme).toBeUndefined();
    expect(() => read(3.5)).toThrow(/p\.json is neither/);
    expect(() => read("37")).toThrow(/p\.json is neither/);
    // A stage still needs its coverage mode (R355); a gate-form object is not a stage.
    expect(() =>
      parseStageBaseline(JSON.stringify({ identityScheme: 37, entries: rows }), "p.json", "r"),
    ).toThrow(/p\.json is neither/);
  });
});

describe("R810: gitShowHead", () => {
  const real = join(import.meta.dir, "..", "itest", "bcdev.baseline.json");
  test("a file committed at HEAD returns its bytes", () => {
    const text = gitShowHead(real);
    expect(typeof text).toBe("string");
    expect(JSON.parse(text ?? "").entries.length).toBeGreaterThan(0);
  });
  test("a path not at HEAD is undefined", () => {
    expect(gitShowHead(join(import.meta.dir, "..", "itest", "no-such-file.baseline.json"))).toBe(
      undefined,
    );
  });
  test("a git failure (not a repository) throws and is not read as a missing file", () => {
    expect(() => gitShowHead(join(dir, "x.baseline.json"))).toThrow(/git show .* failed/);
  });
});

describe("R810: a record on a pinned build writes only the rows already committed", () => {
  const NAME = "al-runner-v3.layout.baseline.json";
  const arm: NodeJS.ProcessEnv = { [RECORD_BASELINE_ENV]: NAME };
  const mutants = (verdictOfB: "survived" | "killed" = "survived") =>
    report([
      outcome({ mutantCode: "M0001", astHash: "hash-A", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-B", verdict: verdictOfB }),
      outcome({ mutantCode: "M0003", astHash: "hash-C", verdict: "survived" }),
    ]);
  /** The committed file as HEAD holds it: the same rows at an older scheme. */
  async function committed(): Promise<{ raw: string; entries: Record<string, unknown>[] }> {
    const ref = join(dir, "ref", NAME);
    await mkdir(join(dir, "ref"));
    await assertGateBaseline(mutants(), ref, "ref", arm).catch((e: unknown) => {
      if (!(e instanceof BaselineRecordedError)) throw e;
    });
    const parsed = JSON.parse(await readFile(ref, "utf8"));
    parsed.identityScheme = IDENTITY_SCHEME - 1;
    return { raw: JSON.stringify(parsed, null, 2), entries: parsed.entries };
  }
  /** `raw` is the baseline at HEAD; `expected` (R849) the expected file at HEAD, undefined when none. */
  const head = (raw: string | undefined, calls: { n: number } = { n: 0 }, expected?: string) => ({
    readCommitted: (p: string) => {
      calls.n++;
      return p.includes(`${sep}expected${sep}`) ? expected : raw;
    },
  });
  const refused = async (run: Promise<void>, text: RegExp) => {
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PinnedRecordRefusedError);
    expect(err).not.toBeInstanceOf(BaselineRecordedError);
    expect((err as Error).message).toMatch(text);
    expect(existsSync(join(dir, NAME))).toBe(false);
  };

  test("equal rows: written at the current scheme, then BaselineRecordedError", async () => {
    const { raw, entries } = await committed();
    const p = join(dir, NAME);
    const err = await assertGateBaseline(mutants(), p, "t", arm, head(raw)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaselineRecordedError);
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({
      identityScheme: IDENTITY_SCHEME,
      entries,
    });
  });

  test("a moved row is refused, naming the key and field and the count", async () => {
    const { raw } = await committed();
    await refused(
      assertGateBaseline(mutants("killed"), join(dir, NAME), "t", arm, head(raw)),
      /1 row\(s\) differ, first row 1 \(hash-B\|[^)]*\), field verdict: committed "survived", run "killed"/,
    );
  });

  test("a changed order is refused even when every verdict is equal", async () => {
    const { entries } = await committed();
    const swapped = { identityScheme: IDENTITY_SCHEME - 1, entries: [...entries].reverse() };
    await refused(
      assertGateBaseline(mutants(), join(dir, NAME), "t", arm, head(JSON.stringify(swapped))),
      /2 row\(s\) differ, first row 0 \(hash-C\|[^)]*\), field key/,
    );
  });

  test("a different row count is refused", async () => {
    const { entries } = await committed();
    const short = { identityScheme: IDENTITY_SCHEME - 1, entries: entries.slice(0, 2) };
    await refused(
      assertGateBaseline(mutants(), join(dir, NAME), "t", arm, head(JSON.stringify(short))),
      /1 row\(s\) differ, first row count 2 committed, 3 in this run/,
    );
  });

  test("a changed field order inside a row is refused", async () => {
    const { entries } = await committed();
    const flipped = entries.map((e) => Object.fromEntries(Object.entries(e).reverse()));
    await refused(
      assertGateBaseline(
        mutants(),
        join(dir, NAME),
        "t",
        arm,
        head(JSON.stringify({ identityScheme: 1, entries: flipped })),
      ),
      /3 row\(s\) differ, first row 0 .*field /,
    );
  });

  test("no file at HEAD is refused by name", async () => {
    await refused(
      assertGateBaseline(mutants(), join(dir, NAME), "t", arm, head(undefined)),
      /no committed file at HEAD/,
    );
  });

  describe("R849: a pre-committed expected file", () => {
    /** An expected file whose B row is killed: the run (B killed) equals it, the baseline at HEAD does not. */
    function expectedKilled(raw: string): string {
      const entries: Record<string, unknown>[] = JSON.parse(raw).entries;
      const moved = entries.map((e) =>
        String(e.key).startsWith("hash-B") ? { ...e, verdict: "killed" } : e,
      );
      return JSON.stringify({ identityScheme: IDENTITY_SCHEME - 1, entries: moved });
    }
    const dumps = () => mkdtemp(join(tmpdir(), "r849-dump-"));
    const withWorking = (
      pinned: ReturnType<typeof head>,
      working: string | undefined,
      dumpDir: string,
    ) => ({ ...pinned, readWorking: () => working, dumpDir });

    test("expected at HEAD is what the run is checked against, not the baseline", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      const p = join(dir, NAME);
      // The run reads B killed: the old baseline would refuse it, the expected file lets it through.
      const err = await assertGateBaseline(
        mutants("killed"),
        p,
        "t",
        arm,
        withWorking(head(raw, { n: 0 }, exp), exp, d),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BaselineRecordedError);
      expect(JSON.parse(await readFile(p, "utf8")).entries[1].verdict).toBe("killed");
      await rm(d, { recursive: true });
    });

    test("expected at HEAD: a run that differs from it is refused, and the dump names the keys", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      // The run reads B survived (equal to the OLD baseline): the expected file refuses it.
      const err = await assertGateBaseline(
        mutants("survived"),
        join(dir, NAME),
        "t",
        arm,
        withWorking(head(raw, { n: 0 }, exp), exp, d),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PinnedRecordRefusedError);
      const message = (err as Error).message;
      expect(message).toMatch(/field verdict: committed "killed", run "survived"/);
      const named = /rows are in (\S+\.json)\./.exec(message);
      expect(named).not.toBeNull();
      const file = named?.[1] ?? "";
      expect(file.startsWith(d)).toBe(true);
      const dumped = JSON.parse(await readFile(file, "utf8"));
      const keys: string[] = dumped.entries.map((e: { key: string }) => e.key);
      expect(keys.some((k) => k.startsWith("hash-B"))).toBe(true);
      await rm(d, { recursive: true });
    });

    test("no expected file: the baseline at HEAD is used, as before", async () => {
      const { raw } = await committed();
      const d = await dumps();
      const err = await assertGateBaseline(
        mutants(),
        join(dir, NAME),
        "t",
        arm,
        withWorking(head(raw), undefined, d),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BaselineRecordedError);
      await rm(d, { recursive: true });
    });

    test("an expected file that is not committed (untracked) is refused, though it matches the run", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      await refused(
        assertGateBaseline(
          mutants("killed"),
          join(dir, NAME),
          "t",
          arm,
          withWorking(head(raw), exp, d),
        ),
        /untracked, not committed/,
      );
      await rm(d, { recursive: true });
    });

    test("an expected file modified after its commit is refused", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      // HEAD holds an older expected file; the working copy was edited to match the run.
      await refused(
        assertGateBaseline(
          mutants("killed"),
          join(dir, NAME),
          "t",
          arm,
          withWorking(head(raw, { n: 0 }, raw), exp, d),
        ),
        /modified but not committed/,
      );
      await rm(d, { recursive: true });
    });

    test("an expected file deleted from the working copy but still at HEAD is refused", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      await refused(
        assertGateBaseline(
          mutants("killed"),
          join(dir, NAME),
          "t",
          arm,
          withWorking(head(raw, { n: 0 }, exp), undefined, d),
        ),
        /deleted but not committed/,
      );
      await rm(d, { recursive: true });
    });

    test("the mirror: an expected file copied from the run itself is refused unless committed first", async () => {
      // The mirror is: run, copy the rows into expected, run again. The copy is not at HEAD, so the
      // guard refuses it by name, though the rows match the run exactly.
      const { raw } = await committed();
      const mirror = expectedKilled(raw);
      const d = await dumps();
      const p = join(dir, NAME);
      await refused(
        assertGateBaseline(mutants("killed"), p, "t", arm, withWorking(head(raw), mirror, d)),
        /a run cannot be checked against a file shaped after it/,
      );
      // The other half: the same file, committed first, is what the run is checked against.
      const ok = await assertGateBaseline(
        mutants("killed"),
        p,
        "t",
        arm,
        withWorking(head(raw, { n: 0 }, mirror), mirror, d),
      ).catch((e: unknown) => e);
      expect(ok).toBeInstanceOf(BaselineRecordedError);
      await rm(d, { recursive: true });
    });

    test("a refused run's dump is not a valid expected file", async () => {
      const { raw } = await committed();
      const exp = expectedKilled(raw);
      const d = await dumps();
      const err = await assertGateBaseline(
        mutants("survived"),
        join(dir, NAME),
        "t",
        arm,
        withWorking(head(raw, { n: 0 }, exp), exp, d),
      ).catch((e: unknown) => e);
      const file = /rows are in (\S+\.json)\./.exec((err as Error).message)?.[1] ?? "";
      const text = await readFile(file, "utf8");
      expect(JSON.parse(text)[DUMP_ONLY_KEY]).toBeDefined();
      expect(() => parseGateBaseline(text, file, "r")).toThrow(/unknown shape/);
      await rm(d, { recursive: true });
    });

    describe("on a real git repository (the production gitShowHead and default reader)", () => {
      const git = (repo: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-C",
            repo,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { encoding: "utf8" },
        );
      /** A repo whose HEAD holds the baseline (B survived); returns its paths and HEAD sha. */
      async function repoWithBaseline(raw: string) {
        const repo = join(dir, "repo");
        const itest = join(repo, "itest");
        await mkdir(itest, { recursive: true });
        git(repo, "init", "-q");
        await writeFile(join(itest, NAME), raw, "utf8");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "baseline");
        const sha = git(repo, "rev-parse", "HEAD").trim();
        const p = join(itest, NAME);
        const exp = expectedPathFor(p);
        await mkdir(dirname(exp), { recursive: true });
        return { repo, p, exp, sha };
      }
      const run = (p: string, rev: string, dumpDir: string) =>
        assertGateBaseline(mutants("killed"), p, "t", arm, {
          readCommitted: (f) => gitShowHead(f, rev),
          dumpDir,
        }).catch((e: unknown) => e);

      test("untracked, then modified, then committed: refused, refused, accepted", async () => {
        const { raw } = await committed();
        const { repo, p, exp, sha } = await repoWithBaseline(raw);
        const d = await dumps();
        const killed = expectedKilled(raw);
        await writeFile(exp, killed, "utf8");
        await rm(p);
        const first = await run(p, "HEAD", d);
        expect(first).toBeInstanceOf(PinnedRecordRefusedError);
        expect((first as Error).message).toMatch(/untracked, not committed/);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "expected");
        await writeFile(exp, `${killed}\n `, "utf8");
        const second = await run(p, "HEAD", d);
        expect(second).toBeInstanceOf(PinnedRecordRefusedError);
        expect((second as Error).message).toMatch(/modified but not committed/);
        await writeFile(exp, killed, "utf8");
        // The sha captured before the expected file was committed does not see the later commit.
        const early = await run(p, sha, d);
        expect(early).toBeInstanceOf(PinnedRecordRefusedError);
        expect((early as Error).message).toMatch(/untracked, not committed/);
        expect(existsSync(p)).toBe(false);
        const third = await run(p, "HEAD", d);
        expect(third).toBeInstanceOf(BaselineRecordedError);
        await rm(d, { recursive: true });
      });
    });

    test("expectedFileProblems: a misnamed file and a stale one are reported, a live one is not", async () => {
      const { raw } = await committed();
      const live = expectedKilled(raw);
      const v3 = NAME;
      expect(expectedFileProblems([{ name: v3, expected: live, baseline: raw }])).toEqual([]);
      expect(expectedFileProblems([{ name: v3, expected: raw, baseline: raw }])).toEqual([
        expect.stringMatching(/stale/),
      ]);
      expect(
        expectedFileProblems([{ name: "bcdev.baseline.json", expected: live, baseline: raw }]),
      ).toEqual([expect.stringMatching(/not named for a v3 baseline/)]);
      expect(
        expectedFileProblems([{ name: "x.baseline.json", expected: live, baseline: raw }]),
      ).toHaveLength(1);
    });

    test("the real itest/expected folder: every file is live (holds trivially while the folder is empty)", () => {
      const folder = join(import.meta.dir, "..", "itest", "expected");
      const names = existsSync(folder) ? readdirSync(folder) : [];
      const files = names.map((name) => ({
        name,
        expected: readFileSync(join(folder, name), "utf8"),
        baseline: gitShowHead(join(folder, "..", name)),
      }));
      expect(expectedFileProblems(files)).toEqual([]);
    });

    test("a stale expected file (the baseline at HEAD already equals it) is refused: delete it", async () => {
      const { raw } = await committed();
      const d = await dumps();
      await refused(
        assertGateBaseline(
          mutants(),
          join(dir, NAME),
          "t",
          arm,
          withWorking(head(raw, { n: 0 }, raw), raw, d),
        ),
        /is stale: the baseline at HEAD already equals it; delete the expected file/,
      );
      await rm(d, { recursive: true });
    });

    test("expectedPathFor is a subfolder the hook's real glob does not match", async () => {
      // The hook normalizes backslashes the same way, and Windows's `join` gives them.
      const p = expectedPathFor("/r/packages/runner/itest/a.baseline.json").replaceAll("\\", "/");
      expect(p).toBe("/r/packages/runner/itest/expected/a.baseline.json");
      // The regex is read out of the hook itself, not retyped here.
      const hook = await readFile(
        new URL("../../../.claude/hooks/baseline-guard.ts", import.meta.url),
        "utf8",
      );
      const lit = /isFrozenBaseline = \/(.+)\/i\.test\(/.exec(hook);
      expect(lit).not.toBeNull();
      const re = new RegExp(lit?.[1] ?? "", "i");
      expect(re.test("/r/packages/runner/itest/a.baseline.json")).toBe(true);
      expect(re.test(p)).toBe(false);
    });

    test("gitShowHead reads an expected path whose folder is not on disk", () => {
      const p = expectedPathFor(join(import.meta.dir, "..", "itest", "bcdev.baseline.json"));
      expect(gitShowHead(p)).toBe(undefined);
    });
  });

  describe("R849: a record on a build that is not current is refused", () => {
    const one = ["a.baseline.json"];
    test("a non-current binary is refused by name, naming both paths", () => {
      const run = () => assertRecordOnCurrent(one, "/t/alpha.2/al-runner", "/t/edge/al-runner");
      expect(run).toThrow(NonCurrentRecordRefusedError);
      expect(run).toThrow(/record-not-current.*a\.baseline\.json.*alpha\.2.*edge/);
    });
    test("current passes, and no record request passes on any binary", () => {
      expect(() =>
        assertRecordOnCurrent(one, "/t/edge/al-runner", "/t/edge/al-runner"),
      ).not.toThrow();
      expect(() =>
        assertRecordOnCurrent([], "/t/alpha.2/al-runner", "/t/edge/al-runner"),
      ).not.toThrow();
    });
    test("a record with no build pin is refused; with a pin, or no request, it is not", () => {
      const run = () => assertRecordPinned(one, false);
      expect(run).toThrow(NonCurrentRecordRefusedError);
      expect(run).toThrow(/record-unpinned.*a\.baseline\.json/);
      expect(() => assertRecordPinned(one, true)).not.toThrow();
      expect(() => assertRecordPinned([], false)).not.toThrow();
    });
    test("the itest calls both checks, with the resolved current binary, before any leg", async () => {
      const src = await readFile(
        new URL("../itest/al-runner-v3.itest.ts", import.meta.url),
        "utf8",
      );
      expect(src).toContain("resolveV3Binary(AL_RUNNER_V3_DEFAULT_PATH)");
      expect(src.indexOf("assertRecordOnCurrent(")).toBeLessThan(
        src.indexOf("for (const leg of LEGS)"),
      );
    });
  });

  test("undo: runs before the compare; a row not reading the pin is refused", async () => {
    const { raw } = await committed();
    // The run reads B killed (the pin); undo puts it back to survived, which is the committed row.
    const undo = (rows: NormalizedMutant[]) =>
      rows.map((r) => (r.key.startsWith("hash-B") ? { ...r, verdict: "survived" } : r));
    const p = join(dir, NAME);
    const ok = await assertGateBaseline(mutants("killed"), p, "t", arm, {
      ...head(raw),
      undo,
    }).catch((e: unknown) => e);
    expect(ok).toBeInstanceOf(BaselineRecordedError);
    const written = JSON.parse(await readFile(p, "utf8"));
    expect(written.entries[1].verdict).toBe("survived");
    await rm(p);
    await refused(
      assertGateBaseline(mutants("killed"), p, "t", arm, { ...head(raw), undo: () => undefined }),
      /a pinned key is absent, repeated, or does not read the pin/,
    );
  });

  test("an undo that leaves a verdict moved is still refused by the compare", async () => {
    const { raw } = await committed();
    await refused(
      assertGateBaseline(mutants("killed"), join(dir, NAME), "t", arm, {
        ...head(raw),
        undo: (rows) => rows,
      }),
      /field verdict/,
    );
  });

  test("record off: the pinned source is never read", async () => {
    const { raw } = await committed();
    const calls = { n: 0 };
    const p = join(dir, NAME);
    await writeFile(p, "sentinel\n", "utf8");
    await assertGateBaseline(mutants(), p, "t", {}, head(raw, calls)).catch(() => undefined);
    expect(calls.n).toBe(0);
  });

  test("an unpinned record is unchanged and the module calls git only in gitShowHead", async () => {
    const p = join(dir, NAME);
    const err = await assertGateBaseline(mutants(), p, "t", arm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaselineRecordedError);
    expect(JSON.parse(await readFile(p, "utf8")).identityScheme).toBe(IDENTITY_SCHEME);
    const src = await readFile(new URL("../itest/baseline-guard.ts", import.meta.url), "utf8");
    expect(src.match(/execFileSync\(/g)?.length).toBe(1);
    const fn = src.indexOf("export function gitShowHead");
    expect(src.indexOf("execFileSync(")).toBeGreaterThan(fn);
  });
});
