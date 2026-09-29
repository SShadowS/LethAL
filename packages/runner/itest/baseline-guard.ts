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
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${baselinePath} holds no mutant rows. A committed baseline must be a non-empty array of mutant rows.\n${remedy}`,
    );
  }
  return parsed as NormalizedMutant[];
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
  const baseline = parseBaseline(baselineRaw, baselinePath, remedy);
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
): Promise<void> {
  const actual = sortedForDisk(normalizeForComparison(report));
  let baselineRaw: string | undefined;
  try {
    baselineRaw = await readFile(baselinePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (baselineRaw === undefined) {
    await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    console.log(
      `${label}: no committed baseline at ${baselinePath}, recorded this run's per-mutant verdicts as the new baseline. Review and commit this file.`,
    );
    return;
  }
  throwOnDiff(
    actual,
    baselineRaw,
    baselinePath,
    label,
    `If this difference is EXPECTED (the fixture or an operator legitimately changed), delete ${baselinePath}, re-run to record a new baseline, review the diff, then commit it.`,
  );
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
  "bcdev.baseline.json": gateHow("LETHAL_ITEST_BCDEV=1", "bcdev.baseline.json", "itest:bcdev"),
  "envtool.baseline.json": gateHow(
    "LETHAL_ITEST_ENVTOOL=1",
    "envtool.baseline.json",
    "itest:envtool",
  ),
  "harden.baseline.json": gateHow("LETHAL_ITEST_HARDEN=1", "harden.baseline.json", "itest:harden"),
  "tables.baseline.json": gateHow("LETHAL_ITEST_TABLES=1", "tables.baseline.json", "itest:tables"),
};

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
