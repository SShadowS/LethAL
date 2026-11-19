/**
 * PR-144: the recheck (on by default, PR-182) of "withheld kill" error rows (`withheldKillOf`, R1108) after an al-runner-v3
 * session's main pass (`alRunnerV3.recheckWithheldKills`).
 *
 * A withheld kill is an `error` row where a covering test FAILED under the mutant, but v3 did not trust the
 * failure: an earlier test of its codeunit was refused, failed or ran out of time. The recheck runs just those
 * mutants again under method isolation (one test per session) and may turn a row into `killed`.
 *
 * This file holds the pure verdict rules (a) to (e) and the driver. The nested run itself (a second backend, a
 * second `runSession`) is injected as `RecheckRunner`, built by `cli.ts` from the run's pinned config, so the
 * rules and the ordering are tested with fakes. Nothing here touches the store: a recovered row is a report
 * row, not a stored verdict, so `--resume` never carries it (it finds the stored `error` and re-derives).
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestOutcome } from "./backend";
import type { RunEvent, RunEventInput } from "./events";
import { type IsolatedRecheck, withheldKillOf } from "./report";

/** One main-pass withheld-kill row the recheck may re-run. */
export interface RecheckTarget {
  readonly mutant: MutantManifestEntry;
  readonly batchIndex: number;
  readonly verdict: string;
  readonly cause?: string;
  readonly failureNote?: string;
  /** `Codeunit.Method`, from the main pass. */
  readonly coveringTests: readonly string[];
}

/** What the recheck needs to know about the run it checks against (rule (d)). */
export interface RecheckIdentity {
  readonly version?: string;
  readonly binarySha256?: string;
  readonly sourceSha256?: string;
  readonly dependencySourceSha256?: string;
}

/** A nested-session row, as `SessionReport.mutants` gives it. */
export interface NestedRow {
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operatorName: string;
  readonly mutatedText: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly killingTestFailure?: string;
  readonly killPosition?: number;
  readonly reproducedFailure?: string;
  readonly killReproduced?: boolean;
  readonly coveringTests: readonly string[];
  readonly durationMs: number;
}

export interface NestedRecheckResult {
  readonly rows: readonly NestedRow[];
  /** The recheck baseline's own per-test verdicts, `Codeunit.Method`. */
  readonly baseline: readonly { readonly name: string; readonly outcome: TestOutcome }[];
  readonly baselineElapsedMs: number;
  readonly identity: RecheckIdentity;
}

export interface RecheckRequest {
  readonly targets: readonly RecheckTarget[];
  /** The targets' covering tests, `Codeunit.Method`, each once. The nested baseline is exactly these. */
  readonly tests: readonly string[];
  readonly budgetSeconds: number;
}

/** Runs the nested session: method isolation, fresh serve daemons, the pinned config. */
export type RecheckRunner = (req: RecheckRequest) => Promise<NestedRecheckResult>;

/** The key a nested mutant is matched back to its target by (the mutant numbering is not stable under narrowing). */
export function recheckSiteKey(s: {
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operatorName: string;
  readonly mutatedText: string;
}): string {
  return [
    s.file.replaceAll("\\", "/").toLowerCase(),
    s.startIndex,
    s.endIndex,
    s.operatorName,
    s.mutatedText,
  ].join("\0");
}

/** `Codeunit.Method` -> `Codeunit`. A method name has no dot; a codeunit name may. */
export function codeunitOfQualified(name: string): string {
  const at = name.lastIndexOf(".");
  return at < 0 ? name : name.slice(0, at);
}

/**
 * The killing test as `Codeunit.Method`. The row names the bare method; the nested covering list names the
 * codeunit. Two covering tests with that method name in different codeunits cannot be told apart, so
 * there is no killer to check, and the rules that need one fail.
 */
export function qualifiedKillerOf(row: NestedRow): string | undefined {
  if (row.killingTest === undefined) return undefined;
  const hits = row.coveringTests.filter((n) => n.slice(n.lastIndexOf(".") + 1) === row.killingTest);
  return hits.length === 1 ? hits[0] : undefined;
}

export type RecheckRule = "a" | "b" | "c" | "d" | "e";

/** (a): the main-pass row is a withheld kill. */
export function ruleAWithheldKill(t: RecheckTarget): string | undefined {
  return withheldKillOf(t.verdict, t.cause, t.failureNote) !== undefined
    ? undefined
    : "the main-pass row is not a withheld kill";
}

/** (b): the recheck verdict is `killed` and the kill reproduced. */
export function ruleBKilledReproduced(row: NestedRow | undefined): string | undefined {
  if (row === undefined)
    return "the recheck scored no row for this mutant (not reached, or not found once)";
  if (row.verdict !== "killed") return `the recheck verdict is ${row.verdict}, not killed`;
  if (row.killReproduced !== true) return "the recheck kill did not reproduce";
  return undefined;
}

/** (c): the killing test passed alone at the recheck baseline. */
export function ruleCKillerPassedAlone(
  recheckBaseline: ReadonlyMap<string, TestOutcome>,
  killer: string | undefined,
  recheckSet?: ReadonlySet<string>,
): string | undefined {
  if (killer === undefined)
    return "the killing test cannot be named (none, or two codeunits share its method name)";
  const outcome = recheckBaseline.get(killer);
  if (outcome === undefined)
    // PR-225: name why, when the set itself left the killer out (the owner's ruling: the report names these rows).
    return recheckSet !== undefined && !recheckSet.has(killer)
      ? `${killer} is not in the recheck baseline: ${LEFT_OUT_OF_SET}`
      : `${killer} is not in the recheck baseline`;
  if (outcome !== "pass")
    return `${killer} did not pass alone at the recheck baseline (${outcome})`;
  return undefined;
}

/** (d): the recheck ran the same al-runner binary and the same source as the main pass. */
export function ruleDSameBuild(
  main: RecheckIdentity,
  recheck: RecheckIdentity,
): string | undefined {
  for (const k of ["version", "binarySha256", "sourceSha256", "dependencySourceSha256"] as const) {
    const a = main[k];
    const b = recheck[k];
    // Empty-vs-empty must never match: a missing hash on either side is a mismatch.
    if (a === undefined || b === undefined) return `${k} is not known on both runs`;
    if (a !== b) return `${k} differs between the main pass and the recheck`;
  }
  return undefined;
}

/**
 * (e): every test of the killing test's codeunit that passed in the main baseline passes alone in the recheck
 * baseline; one that failed, was refused, or has no recheck result is lost. It cannot judge a test v3 refused
 * at baseline (it never "passed in the main baseline"), so it does not say whether that test's state mattered.
 * With no main baseline row for the
 * codeunit at all, nothing proves a test "passed in the main baseline", so the rule fails closed.
 */
export function ruleELosesNothing(
  mainBaseline: ReadonlyMap<string, boolean>,
  recheckBaseline: ReadonlyMap<string, TestOutcome>,
  killer: string | undefined,
): string | undefined {
  if (killer === undefined) return "the killing test cannot be named, so its codeunit is unknown";
  const cu = codeunitOfQualified(killer);
  let seen = 0;
  const lost: string[] = [];
  for (const [name, passedMain] of mainBaseline) {
    if (codeunitOfQualified(name) !== cu) continue;
    seen += 1;
    if (!passedMain) continue;
    const r = recheckBaseline.get(name);
    // No result counts as lost (fail closed): the recheck's test set holds every such test.
    if (r !== "pass") lost.push(name);
  }
  if (seen === 0) return `the main baseline has no row for codeunit ${cu}`;
  if (lost.length > 0)
    return `the recheck baseline lost ${lost.join(", ")}, which passed in the main baseline`;
  return undefined;
}

export type RecheckDecision =
  | {
      readonly kind: "recovered";
      readonly killingTest: string;
      readonly row: NestedRow;
      readonly isolatedRecheck: IsolatedRecheck;
    }
  | { readonly kind: "kept"; readonly failed: readonly RecheckRule[]; readonly note: string };

/** Every rule must hold for `recovered`; any other outcome keeps `error` and names the rules that failed. */
export function decideRecheck(a: {
  readonly target: RecheckTarget;
  readonly row: NestedRow | undefined;
  readonly mainBaseline: ReadonlyMap<string, boolean>;
  readonly recheckBaseline: ReadonlyMap<string, TestOutcome>;
  readonly main: RecheckIdentity;
  readonly recheck: RecheckIdentity;
  /** PR-225: the tests the recheck baseline was asked to run, so rule (c) can say a killer was left out. */
  readonly recheckSet?: ReadonlySet<string>;
}): RecheckDecision {
  const killer = a.row === undefined ? undefined : qualifiedKillerOf(a.row);
  const checks: readonly [RecheckRule, string | undefined][] = [
    ["a", ruleAWithheldKill(a.target)],
    ["b", ruleBKilledReproduced(a.row)],
    ["c", ruleCKillerPassedAlone(a.recheckBaseline, killer, a.recheckSet)],
    ["d", ruleDSameBuild(a.main, a.recheck)],
    ["e", ruleELosesNothing(a.mainBaseline, a.recheckBaseline, killer)],
  ];
  const failed = checks.filter(([, why]) => why !== undefined);
  const wk = withheldKillOf(a.target.verdict, a.target.cause, a.target.failureNote);
  if (failed.length === 0 && a.row !== undefined && killer !== undefined && wk !== undefined) {
    return {
      kind: "recovered",
      killingTest: a.row.killingTest ?? killer,
      row: a.row,
      isolatedRecheck: {
        withheldFailure: wk.failure,
        ...(wk.afterTest !== undefined ? { afterTest: wk.afterTest } : {}),
        killerGreenInMainBaseline: a.mainBaseline.get(killer) === true,
      },
    };
  }
  return {
    kind: "kept",
    failed: failed.map(([r]) => r),
    // Must not contain the phrase `withheldKillOf` searches for; it follows V3_NOT_RUN_SUFFIX in the note.
    note: `[recheck kept error: ${failed.map(([r, why]) => `rule (${r}): ${why}`).join("; ")}]`,
  };
}

/** The targets: this session's own `mutant-scored` rows that are withheld kills. Carried rows are never in here. */
export function recheckTargetsOf(events: readonly RunEvent[]): RecheckTarget[] {
  const out: RecheckTarget[] = [];
  for (const e of events) {
    if (e.type !== "mutant-scored") continue;
    if (withheldKillOf(e.verdict, e.cause, e.failureNote) === undefined) continue;
    out.push({
      mutant: e.mutant,
      batchIndex: e.batchIndex,
      verdict: e.verdict,
      ...(e.cause !== undefined ? { cause: e.cause } : {}),
      ...(e.failureNote !== undefined ? { failureNote: e.failureNote } : {}),
      coveringTests: e.coveringTests,
    });
  }
  return out;
}

/** Test name -> passed in EVERY main-baseline batch it ran in (the stricter reading keeps more rows `error`). */
export function mainBaselineOf(events: readonly RunEvent[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const e of events) {
    if (e.type !== "baseline-batch-finished") continue;
    for (const v of e.verdicts) m.set(v.name, (m.get(v.name) ?? true) && v.outcome === "pass");
  }
  return m;
}

/**
 * PR-225 (R1142, option A): the recheck baseline's tests. For each target, its candidate killers: the covering tests
 * whose main-pass outcome under that mutant was not `pass` (a withheld kill stores its distrusted failure as `error`).
 * Then every main-baseline test of those candidates' codeunits, because rule (e) reads the killer's whole codeunit.
 *
 * A killer outside this set has no recheck-baseline row, so rule (c) keeps the row `error` (unmeasured, never a kill).
 * On y3 this was 497 tests instead of 1,161, about 20 minutes less per DO run; 12 of 409 recovered rows stayed `error`
 * (spec docs/superpowers/specs/2026-11-19-pr225-r1142-recheck-set.md).
 */
export function recheckTestSetOf(
  targets: readonly RecheckTarget[],
  notPassOf: (t: RecheckTarget) => readonly string[],
  mainBaseline: ReadonlyMap<string, boolean>,
): Set<string> {
  const candidates = new Set<string>();
  for (const t of targets) {
    const covering = new Set(t.coveringTests);
    for (const n of notPassOf(t)) if (covering.has(n)) candidates.add(n);
  }
  const codeunits = new Set([...candidates].map(codeunitOfQualified));
  return new Set([
    ...candidates,
    ...[...mainBaseline.keys()].filter((n) => codeunits.has(codeunitOfQualified(n))),
  ]);
}

/** The reason rule (c) adds when option A left the killer out of the recheck set (the report names the row). */
export const LEFT_OUT_OF_SET =
  "unmeasured: it passed under the mutant in the main pass, so the recheck set left it out (R1142)";

export interface RecheckDeps {
  /** The session's events so far (`mutant-scored`, `baseline-batch-finished`). */
  readonly events: readonly RunEvent[];
  /**
   * PR-225: each target's covering tests whose main-pass outcome under the mutant was not `pass`, read from the
   * session's store. Required: a missing lookup must never fall back to the whole covering set silently.
   */
  readonly notPassOf: (t: RecheckTarget) => readonly string[];
  readonly emit: (e: RunEventInput) => void;
  readonly main: RecheckIdentity;
  readonly budgetSeconds: number;
  readonly runner: RecheckRunner;
  /** The backend's own facts, read after `decideTransport`. */
  readonly backend: {
    readonly methodIsolation?: boolean;
    readonly serveEntries?: boolean;
    readonly closeDaemons?: () => Promise<void>;
  };
}

export interface RecheckSummary {
  readonly targets: number;
  readonly recovered: number;
  readonly skipped?: string;
}

/**
 * Whether the session runs the recheck at all: it is configured, and the session is not quarantined (an
 * unsafe session's verdicts are not trusted, so nothing is built on them).
 */
export function shouldRunRecheck(a: {
  readonly recheck: unknown;
  readonly unsafe: boolean;
}): boolean {
  return a.recheck !== undefined && !a.unsafe;
}

/** The word the skip warning carries. */
export const RECHECK_SKIPPED_CODE = "withheld-recheck-skipped";
export const RECHECK_FAILED_CODE = "withheld-recheck-failed";

/**
 * Runs the recheck once, as its own step. Emits `recheck-baseline-finished` and one `mutant-rechecked` per
 * target. A skip (isolation is already `"method"`, or the transport is not serve) and a nested run that
 * throws each emit one warning and leave every row `error`: the main pass's results are never lost to the recheck.
 */
export async function runWithheldRecheck(d: RecheckDeps): Promise<RecheckSummary> {
  const targets = recheckTargetsOf(d.events);
  if (targets.length === 0) return { targets: 0, recovered: 0 };
  const skip = (why: string): RecheckSummary => {
    d.emit({
      type: "warning",
      code: RECHECK_SKIPPED_CODE,
      message: `[lethal] the withheld-kill recheck was skipped (${why}); ${targets.length} withheld kill(s) stay error (PR-144).`,
    });
    return { targets: targets.length, recovered: 0, skipped: why };
  };
  if (d.backend.methodIsolation === true) return skip('isolation is already "method"');
  if (d.backend.serveEntries !== true) return skip("the transport is not serve-entries");
  const mainBaseline = mainBaselineOf(d.events);
  // A session with no baseline results at all: nothing proves what passed, so (e) could recover nothing.
  // (A reused snapshot still emits baseline-batch-finished, so reuse alone never lands here.)
  if (mainBaseline.size === 0) return skip("the main pass has no baseline results at all");
  // PR-225: only the candidate killers and every main-baseline test of their codeunits (rule (e) reads the codeunit).
  const testSet = recheckTestSetOf(targets, d.notPassOf, mainBaseline);
  if (testSet.size === 0)
    return skip("no withheld kill has a covering test that did not pass under its mutant");
  const tests = [...testSet].sort();
  let result: NestedRecheckResult;
  try {
    // The main session's daemons would otherwise stay alive beside the nested session's.
    await d.backend.closeDaemons?.();
    result = await d.runner({ targets, tests, budgetSeconds: d.budgetSeconds });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    d.emit({
      type: "warning",
      code: RECHECK_FAILED_CODE,
      message: `[lethal] the withheld-kill recheck failed (${why}); ${targets.length} withheld kill(s) stay error (PR-144).`,
    });
    return { targets: targets.length, recovered: 0, skipped: `failed: ${why}` };
  }
  // As the main side: a test counts as passed only if it passed in EVERY batch it ran in.
  const recheckBaseline = new Map<string, TestOutcome>();
  for (const b of result.baseline) {
    const prev = recheckBaseline.get(b.name);
    if (prev === undefined || prev === "pass") recheckBaseline.set(b.name, b.outcome);
  }
  d.emit({
    type: "recheck-baseline-finished",
    tests: result.baseline.length,
    elapsedMs: result.baselineElapsedMs,
    verdicts: result.baseline,
  });
  const byKey = new Map<string, NestedRow[]>();
  for (const r of result.rows) {
    const k = recheckSiteKey(r);
    const list = byKey.get(k);
    if (list === undefined) byKey.set(k, [r]);
    else list.push(r);
  }
  let recovered = 0;
  for (const target of targets) {
    const found = byKey.get(recheckSiteKey(target.mutant));
    // Exactly one match: a twin site would make "its" row a guess.
    const row = found !== undefined && found.length === 1 ? found[0] : undefined;
    const decision = decideRecheck({
      target,
      row,
      mainBaseline,
      recheckBaseline,
      main: d.main,
      recheck: result.identity,
      recheckSet: testSet,
    });
    const durationMs = row?.durationMs ?? 0;
    if (decision.kind === "kept") {
      d.emit({
        type: "mutant-rechecked",
        mutant: target.mutant,
        batchIndex: target.batchIndex,
        durationMs,
        keptNote: decision.note,
      });
      continue;
    }
    recovered += 1;
    const r = decision.row;
    d.emit({
      type: "mutant-rechecked",
      mutant: target.mutant,
      batchIndex: target.batchIndex,
      durationMs,
      recovery: {
        killingTest: decision.killingTest,
        ...(r.killingTestFailure !== undefined ? { killingTestFailure: r.killingTestFailure } : {}),
        ...(r.killPosition !== undefined ? { killPosition: r.killPosition } : {}),
        ...(r.reproducedFailure !== undefined ? { reproducedFailure: r.reproducedFailure } : {}),
        coveringTests: r.coveringTests,
        isolatedRecheck: decision.isolatedRecheck,
      },
    });
  }
  return { targets: targets.length, recovered };
}
