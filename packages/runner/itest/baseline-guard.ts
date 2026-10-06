/**
 * Per-mutant healthy-path regression guard, wired into the live env-gated itests (Task 15,
 * design spec §14). `mutant-equality.ts`'s `normalizeForComparison`/`diffMutants` already do the
 * pure comparison work (semantic-identity-keyed — astHash/codeunitName/operatorName/
 * operatorMajor, never mutantCode or file:line, ignoring nondeterministic fields like duration/
 * runId/version/artifactId); this module adds the one piece those pure functions deliberately
 * don't own — durable storage of a COMMITTED baseline on disk, so a live itest run compares
 * against a known-good history, not just against itself.
 *
 * `bcdev.itest.ts`/`al-runner.itest.ts` already run the session twice per invocation and assert
 * `shape(first) === shape(second)` — that only proves same-PROCESS determinism (two runs THIS
 * invocation agree). It says nothing about a real regression introduced since the last time the
 * itest was run: two runs of a silently-broken build could still agree with each other. This
 * closes that gap by diffing against a file committed to the repo.
 *
 * R332: an itest never records a frozen baseline silently. `assertGateBaseline` refuses a missing
 * file and records only when `LETHAL_ITEST_RECORD_BASELINE` names it; every write is exclusive
 * (`wx`), so nothing is ever overwritten; a record run always fails, with exit 3 in the gate.
 * `assertMatchesBaseline` still records an absent file, which is `campaign freeze`'s job alone.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CoverageMode } from "../src/backend";
import type { SessionReport } from "../src/report";
import { canonical, diffMutants, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";

/**
 * Deterministic on-disk ordering — a baseline file's diff must never depend on report order.
 *
 * Key alone is not a total order: a semantic identity legitimately repeats (see `diffMutants`'s
 * multiset comparison — `tables.baseline.json` holds one six-deep group), and `Array#sort` is
 * stable, so within such a group the file would otherwise inherit report order verbatim. Two
 * re-records of the same verdicts could then differ as text while comparing equal. `canonical`
 * breaks the tie on the compared fields themselves.
 */
function sortedForDisk(mutants: readonly NormalizedMutant[]): NormalizedMutant[] {
  return [...mutants].sort(
    (a, b) => a.key.localeCompare(b.key) || canonical(a).localeCompare(canonical(b)),
  );
}

/**
 * Parses a committed baseline's raw JSON. Refuses a baseline that is not a non-empty array: an
 * empty (or non-array) baseline would silently match an empty-mutant report, which is this
 * project's signature bug (empty-vs-empty "matches"). A parse failure is also wrapped with the
 * file's path and the remedy, instead of surfacing a bare, unlabelled SyntaxError.
 */
function parseBaseline(
  baselineRaw: string,
  baselinePath: string,
  remedy: string,
): NormalizedMutant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(baselineRaw);
  } catch (err) {
    throw new Error(`${baselinePath} is not valid JSON (${(err as Error).message}).\n${remedy}`);
  }
  return rowsOf(parsed, baselinePath, remedy);
}

function rowsOf(parsed: unknown, baselinePath: string, remedy: string): NormalizedMutant[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${baselinePath} holds no mutant rows. A committed baseline must be a non-empty array of mutant rows.\n${remedy}`,
    );
  }
  return parsed as NormalizedMutant[];
}

/** R355: the closed set a stage baseline's `coverageMode` may hold. Exhaustive by type. */
const COVERAGE_MODES: Record<CoverageMode, true> = {
  none: true,
  procedure: true,
  line: true,
  fenced: true,
  "al-runner": true,
};

export function isCoverageMode(value: unknown): value is CoverageMode {
  return typeof value === "string" && Object.hasOwn(COVERAGE_MODES, value);
}

/**
 * R355: a campaign stage baseline. Two on-disk forms, both read:
 *   - a plain list of rows: frozen before R355, so the coverage mode it was measured under is
 *     UNKNOWN (`coverageMode: undefined`), never assumed;
 *   - `{ "coverageMode": <mode>, "entries": [rows] }`: what `campaign freeze` writes from R355 on.
 * Gate baselines (`assertGateBaseline`) stay plain lists and never go through this.
 */
export interface StageBaseline {
  readonly coverageMode: CoverageMode | undefined;
  readonly entries: NormalizedMutant[];
}

export function parseStageBaseline(
  baselineRaw: string,
  baselinePath: string,
  remedy: string,
): StageBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(baselineRaw);
  } catch (err) {
    throw new Error(`${baselinePath} is not valid JSON (${(err as Error).message}).\n${remedy}`);
  }
  if (Array.isArray(parsed)) {
    return { coverageMode: undefined, entries: rowsOf(parsed, baselinePath, remedy) };
  }
  const obj = parsed as { coverageMode?: unknown; entries?: unknown } | null;
  if (obj === null || typeof obj !== "object" || !isCoverageMode(obj.coverageMode)) {
    throw new Error(
      `${baselinePath} is neither a list of mutant rows nor {"coverageMode": <one of ${Object.keys(COVERAGE_MODES).join(", ")}>, "entries": [...]}. Refusing to read a stage baseline of unknown shape.\n${remedy}`,
    );
  }
  return { coverageMode: obj.coverageMode, entries: rowsOf(obj.entries, baselinePath, remedy) };
}

/**
 * R355: the refusal when a stage was frozen under one coverage mode and the report ran under
 * another. An unreached mutant is `no-coverage` in one mode and `survived` in the other, so a
 * per-mutant match across modes proves nothing.
 */
export function coverageModeMismatch(
  what: string,
  stage: string,
  stageMode: CoverageMode,
  reportMode: CoverageMode,
): Error {
  return new Error(
    `${what}: stage ${stage} was frozen under coverageMode "${stageMode}" and this report ran under coverageMode "${reportMode}". Refusing to compare across coverage modes (R355): an unreached mutant is no-coverage in one mode and survived in another, so a per-mutant match would prove nothing. Re-run under "${stageMode}", or freeze a new stage under "${reportMode}".`,
  );
}

/** R355: the statement a stage frozen before R355 carries wherever it is compared. */
export function stageModeUnverified(stage: string): string {
  return `coverage mode UNVERIFIED: stage ${stage} predates coverageMode in its baseline (frozen before R355), so the mode it was measured under is unknown. A matching no-coverage or survived verdict proves nothing across coverage modes. Re-freeze the stage under the intended mode to make this comparison strict.`;
}

/**
 * R296: reads `err.stack` once, where the error is made. Bun builds the stack string on the first
 * read, and if a garbage collection runs before that read, an async-thrown Error's stack comes out
 * as a bare `Error` plus frames, with no message (oven-sh/bun#34398). Every gate prints
 * `err.stack ?? err.message`, so on a long live run the per-mutant difference lines were lost.
 * One read here fixes the string before a later collection can drop the message.
 */
function withStack<E extends Error>(err: E): E {
  void err.stack;
  return err;
}

/** Throws when `actual` differs from the committed baseline text. Never writes. */
function throwOnDiff(
  actual: readonly NormalizedMutant[],
  baselineRaw: string,
  baselinePath: string,
  label: string,
  remedy: string,
): void {
  throwOnRowDiff(
    actual,
    parseBaseline(baselineRaw, baselinePath, remedy),
    baselinePath,
    label,
    remedy,
  );
}

function throwOnRowDiff(
  actual: readonly NormalizedMutant[],
  baseline: readonly NormalizedMutant[],
  baselinePath: string,
  label: string,
  remedy: string,
): void {
  const diffs = diffMutants(baseline, actual);
  if (diffs.length > 0) {
    throw withStack(
      new Error(
        `${label}: per-mutant regression against the committed baseline at ${baselinePath} (${diffs.length} mutant(s) differ):\n${diffs.map((d) => `  - ${d}`).join("\n")}\n${remedy}`,
      ),
    );
  }
}

/**
 * Record-or-diff. `campaign freeze` ONLY, where writing an absent `<stage>.baseline.json` is the
 * verb's job. R332: no itest may call it; `tests/baseline-wiring.test.ts` enforces that.
 */
export async function assertMatchesBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  coverageMode?: CoverageMode,
): Promise<void> {
  const actual = sortedForDisk(normalizeForComparison(report));
  let baselineRaw: string | undefined;
  try {
    baselineRaw = await readFile(baselinePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (baselineRaw === undefined) {
    // R355: `campaign freeze` passes the report's mode and the stage records it. Without one (the
    // seeding use in baseline-guard.test.ts) this writes the plain list a gate baseline uses.
    const body = coverageMode === undefined ? actual : { coverageMode, entries: actual };
    await writeFile(baselinePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    console.log(
      `${label}: no committed baseline at ${baselinePath}, recorded this run's per-mutant verdicts as the new baseline. Review and commit this file.`,
    );
    return;
  }
  const remedy = `If this difference is EXPECTED (the fixture or an operator legitimately changed), delete ${baselinePath}, re-run to record a new baseline, review the diff, then commit it.`;
  if (coverageMode === undefined) {
    throwOnDiff(actual, baselineRaw, baselinePath, label, remedy);
    return;
  }
  const stage = parseStageBaseline(baselineRaw, baselinePath, remedy);
  if (stage.coverageMode !== undefined && stage.coverageMode !== coverageMode) {
    throw coverageModeMismatch(`${label} freeze`, label, stage.coverageMode, coverageMode);
  }
  throwOnRowDiff(actual, stage.entries, baselinePath, label, remedy);
  if (stage.coverageMode === undefined) console.log(`${label}: ${stageModeUnverified(label)}`);
}

/** R332: lists the gate baselines a record run may write, by basename, comma-separated. */
export const RECORD_BASELINE_ENV = "LETHAL_ITEST_RECORD_BASELINE";

const gateHow = (enable: string, name: string, script: string): string =>
  `${enable} ${RECORD_BASELINE_ENV}=${name} bun run ${script}`;

/**
 * R332: every gate baseline, by basename, and the command that records it. The basename is the
 * whole contract: all frozen baselines live in `packages/runner/itest/`, so a basename names one
 * file, and `tests/baseline-wiring.test.ts` pins every gate's path to `join(HERE, <this key>)`.
 */
export const GATE_BASELINES: Readonly<Record<string, string>> = {
  "al-runner.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.baseline.json",
    "itest:alrunner",
  ),
  "al-runner.layout.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.layout.baseline.json",
    "itest:alrunner",
  ),
  "al-runner.multiobject.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.multiobject.baseline.json",
    "itest:alrunner",
  ),
  "al-runner.cli-default.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.cli-default.baseline.json",
    "itest:alrunner",
  ),
  "al-runner.wrapped.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.wrapped.baseline.json",
    "itest:alrunner",
  ),
  "bcdev.baseline.json": gateHow("LETHAL_ITEST_BCDEV=1", "bcdev.baseline.json", "itest:bcdev"),
  "envtool.baseline.json": gateHow(
    "LETHAL_ITEST_ENVTOOL=1",
    "envtool.baseline.json",
    "itest:envtool",
  ),
  "harden.baseline.json": gateHow("LETHAL_ITEST_HARDEN=1", "harden.baseline.json", "itest:harden"),
  "hang.single.baseline.json": gateHow(
    "LETHAL_ITEST_HANG=1",
    "hang.single.baseline.json",
    "itest:hang",
  ),
  "tables.baseline.json": gateHow("LETHAL_ITEST_TABLES=1", "tables.baseline.json", "itest:tables"),
};

/**
 * Registered gate baselines that have never been recorded. Its gate still REFUSES to start without
 * the file (R332); this list only lets the offline wiring test tell "pre-committed, waiting for its
 * one record run" from "missing". The commit that records a file removes it from here, and the
 * wiring test fails while a listed file exists. R387's CLI-default leg was recorded 2026-10-01
 * (al-runner.cli-default.baseline.json), and R383's multi-object leg 2026-10-02
 * (al-runner.multiobject.baseline.json, per mutant as pre-committed in
 * docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md). R-204b's
 * single-path hang leg (`hang.single.baseline.json`) was recorded 2026-10-06 on Cronus28 (record
 * exit 3, confirm PASS), per docs/superpowers/specs/2026-10-06-r204b-hang-single-path-precommitment.md.
 * R-300b's wrapped leg (`al-runner.wrapped.baseline.json`) waits for its first record run, which
 * needs its pre-commitment committed under docs/superpowers/specs/ first
 * (2026-10-06-r300b-wrapped-leg-precommitment.md).
 */
export const PENDING_FIRST_RECORD: readonly string[] = ["al-runner.wrapped.baseline.json"];

/** R321's symbol baselines. Recorded only through `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`. */
export const SYMBOL_BASELINES: readonly string[] = [
  "al-runner.symbols-lethala.baseline.json",
  "al-runner.symbols-lethalb.baseline.json",
];
const SYMBOL_HOW =
  "LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe> bun run itest:alrunner";

/** R332: thrown after a gate record run wrote its baseline. The gate exits 3: never a pass. */
export class BaselineRecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineRecordedError";
  }
}

/** The command that records this baseline. Throws for a file that is not registered. */
export function recordHowFor(baselinePath: string): string {
  const name = basename(baselinePath);
  const gate = GATE_BASELINES[name];
  if (gate !== undefined) return gate;
  if (SYMBOL_BASELINES.includes(name)) return SYMBOL_HOW;
  throw new Error(
    `${baselinePath} is not a registered frozen baseline. Register its basename in GATE_BASELINES or SYMBOL_BASELINES (baseline-guard.ts).`,
  );
}

/** True when `LETHAL_ITEST_RECORD_BASELINE` lists this file's basename. Any unknown entry throws. */
export function recordRequested(
  baselinePath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RECORD_BASELINE_ENV];
  if (raw === undefined || raw === "") return false;
  const listed = raw.split(",").map((s) => s.trim());
  for (const entry of listed) {
    if (GATE_BASELINES[entry] === undefined) {
      throw new Error(
        `${RECORD_BASELINE_ENV} lists ${JSON.stringify(entry)}, which is not a gate baseline. It takes exact basenames from: ${Object.keys(GATE_BASELINES).join(", ")}. The symbol baselines use LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1.`,
      );
    }
  }
  const name = basename(baselinePath);
  const armed = listed.includes(name);
  if (!armed) {
    console.error(
      `${RECORD_BASELINE_ENV}=${raw} does not name ${name}; this gate still compares ${baselinePath} against its committed baseline as usual (verdict unchanged). Named instead: ${listed.join(", ")}.`,
    );
  }
  return armed;
}

function overwriteRefusal(baselinePath: string, label: string): Error {
  return withStack(
    new Error(
      `${label}: record mode refuses to overwrite the committed baseline at ${baselinePath}. Recording is one-time: a change needs a new pre-commitment, then the file deleted deliberately, then one record run.`,
    ),
  );
}

function missingRefusal(baselinePath: string, label: string): Error {
  return withStack(
    new Error(
      `${label}: no committed baseline at ${baselinePath}. This gate never records one silently; after a pre-commitment, record once with:\n  ${recordHowFor(baselinePath)}\nthen re-run without the record variable to confirm a pass, review the file and commit it.`,
    ),
  );
}

/** Startup check shared by every preflight: missing (record off) or present (record on) throws. */
export function preflightFrozenBaseline(
  baselinePath: string,
  label: string,
  record: boolean,
): void {
  recordHowFor(baselinePath);
  const exists = existsSync(baselinePath);
  if (record && exists) throw overwriteRefusal(baselinePath, label);
  if (!record && !exists) throw missingRefusal(baselinePath, label);
}

/** First line of every writing gate's `main()`: fails in seconds, before any live work. */
export function preflightGateBaseline(
  baselinePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  preflightFrozenBaseline(baselinePath, label, recordRequested(baselinePath, env));
}

/** First line of every READER's `main()`. Readers never record, so record mode is ignored. */
export function preflightReadOnlyBaseline(baselinePath: string, label: string): void {
  preflightFrozenBaseline(baselinePath, label, false);
}

/** The ONLY baseline write an itest performs. `wx`: the OS refuses if the file exists. */
async function writeBaselineOnce(
  actual: readonly NormalizedMutant[],
  baselinePath: string,
  label: string,
): Promise<void> {
  try {
    await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw overwriteRefusal(baselinePath, label);
    throw err;
  }
}

async function compareWithCommitted(
  actual: readonly NormalizedMutant[],
  baselinePath: string,
  label: string,
): Promise<void> {
  if (!existsSync(baselinePath)) throw missingRefusal(baselinePath, label);
  throwOnDiff(
    actual,
    await readFile(baselinePath, "utf8"),
    baselinePath,
    label,
    `If this difference is EXPECTED, write a pre-commitment, delete ${baselinePath}, record once with:\n  ${recordHowFor(baselinePath)}\nthen re-run without the record variable to confirm a pass, review the diff and commit it.`,
  );
}

/** R332: compare, or (record mode naming this file) write once and throw BaselineRecordedError. */
export async function assertGateBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  recordHowFor(baselinePath);
  const actual = sortedForDisk(normalizeForComparison(report));
  if (!recordRequested(baselinePath, env)) {
    await compareWithCommitted(actual, baselinePath, label);
    return;
  }
  await writeBaselineOnce(actual, baselinePath, label);
  throw new BaselineRecordedError(
    `${label}: RECORDED ${baselinePath}; NOT a pass. Review it against the pre-commitment, re-run without ${RECORD_BASELINE_ENV} to confirm it passes, then commit it.`,
  );
}

/**
 * R321's symbol legs. Same refusals, exclusive write (finding C). Recording returns instead of
 * throwing, so one record run writes BOTH symbol files; al-runner.itest.ts then exits 3.
 */
export async function assertMatchesFrozenBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  record: boolean,
): Promise<void> {
  const name = basename(baselinePath);
  if (!SYMBOL_BASELINES.includes(name)) {
    throw new Error(
      `${baselinePath} is not a registered symbol baseline (SYMBOL_BASELINES: ${SYMBOL_BASELINES.join(", ")}). A gate baseline belongs to assertGateBaseline instead.`,
    );
  }
  const actual = sortedForDisk(normalizeForComparison(report));
  if (!record) {
    await compareWithCommitted(actual, baselinePath, label);
    return;
  }
  await writeBaselineOnce(actual, baselinePath, label);
  console.log(
    `${label}: recorded ${baselinePath}. Review it against the pre-commitment and commit it.`,
  );
}
