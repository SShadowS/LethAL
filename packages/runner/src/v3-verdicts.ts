/**
 * R-911 (owner ruling on R908): for a mutant whose only tests BC refuses, a bcdev run can show
 * al-runner v3's KILL, read from a finished v3 report (`--v3-verdicts`), labelled non-authoritative.
 * The row's verdict stays `no-coverage`, so no count and no score moves. Survived and every other
 * v3 verdict stay unlabelled and are only counted.
 *
 * A report that cannot be proven to describe the same mutants refuses the run by name, before
 * anything is deployed: a wrong or quietly empty join is the failure this module exists to prevent.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { IDENTITY_SCHEME, type MutantManifestEntry } from "@lethal/schemata";
import { hashTestDir } from "./baseline-snapshot";
import type { SessionOutcome, V3KillRow, V3VerdictsJoin } from "./report";
import { identityKeyOf } from "./selection";

/** Typed, and extends `Error` directly (project rule): the run is refused, nothing was sent. */
export class V3VerdictsError extends Error {
  constructor(
    readonly path: string,
    readonly reasons: readonly string[],
  ) {
    super(`--v3-verdicts ${path} cannot be used: ${reasons.join("; ")}`);
    this.name = "V3VerdictsError";
  }
}

interface ReportRow {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly procedureName?: string;
  readonly triggerName?: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly identityOrdinal?: number;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly mutatedText?: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly coveringTests?: readonly string[];
}

/** A v3 report that passed every check that does not need this run's facts. */
export interface V3VerdictsInput {
  readonly path: string;
  readonly reportSha256: string;
  readonly runnerBuild: string | undefined;
  readonly sourceSha256: string;
  readonly numberingDigest: string;
  readonly testSourceSha256: string;
  readonly rows: ReadonlyMap<string, ReportRow>;
  readonly unsupportedTests: ReadonlySet<string>;
  /** Absent: the report does not list its tests, so only `unsupportedTests` can say "not green". */
  readonly testNames: ReadonlySet<string> | undefined;
  /** Tests whose v3 baseline pass was flagged (`baselineFlagged`, R-907): green, but labelled. */
  readonly flaggedTests: ReadonlySet<string>;
}

const keyOf = (k: readonly unknown[]): string => JSON.stringify(k);

function manifestKey(m: MutantManifestEntry): string {
  const k = identityKeyOf(m);
  return keyOf([
    k.astHash,
    k.codeunitName,
    k.procedureName,
    k.operatorName,
    k.operatorMajor,
    k.ordinal,
  ]);
}

function rowKey(r: ReportRow): string {
  return keyOf([
    r.astHash,
    r.codeunitName,
    r.procedureName || r.triggerName || "",
    r.operatorName,
    r.operatorMajor,
    r.identityOrdinal ?? 0,
  ]);
}

/** The test app's identity for the join: its sources and the symbols it is built under. */
export async function testSourceSha256(
  testDir: string,
  buildSymbols: readonly string[],
): Promise<string> {
  const dir = await hashTestDir(testDir);
  return createHash("sha256")
    .update(`${dir}\0${JSON.stringify([...buildSymbols].sort())}`)
    .digest("hex");
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Reads and checks the report. Throws `V3VerdictsError`, every reason at once, on any problem. */
export async function loadV3Verdicts(path: string): Promise<V3VerdictsInput> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new V3VerdictsError(path, [`it cannot be read (${(e as Error).message})`]);
  }
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new V3VerdictsError(path, ["it is not JSON"]);
  }
  const reasons: string[] = [];
  if (r.backend !== "al-runner-v3") {
    reasons.push(`it is a report from backend "${String(r.backend)}", not al-runner-v3`);
  }
  if (r.identityScheme !== IDENTITY_SCHEME) {
    reasons.push(
      `its identity scheme is ${String(r.identityScheme)}, this build's is ${IDENTITY_SCHEME}: re-run v3`,
    );
  }
  if (r.coverageMode !== "al-runner" || r.coverageOffFiles !== undefined) {
    reasons.push("v3 coverage was off, so its report cannot say which tests reach a mutant");
  }
  if (r.quarantined !== undefined) {
    reasons.push("that v3 run was quarantined, so its rows may stop part-way");
  }
  if (Array.isArray(r.testsOnly) && r.testsOnly.length > 0) {
    reasons.push("it was narrowed by --tests-only, so a covering test can be missing from it");
  }
  const { sourceSha256, numberingDigest, testSourceSha256: testSha } = r;
  if (!isText(sourceSha256)) reasons.push("it has no sourceSha256");
  if (!isText(numberingDigest)) reasons.push("it has no numberingDigest");
  if (!isText(testSha)) reasons.push("it has no testSourceSha256: re-run v3 with this build");
  if (!Array.isArray(r.mutants)) reasons.push("it has no mutants");
  const rows = new Map<string, ReportRow>();
  let duplicates = 0;
  for (const row of (Array.isArray(r.mutants) ? r.mutants : []) as ReportRow[]) {
    const k = rowKey(row);
    if (rows.has(k)) duplicates++;
    rows.set(k, row);
  }
  if (duplicates > 0) reasons.push(`${duplicates} mutant identity key(s) repeat in it`);
  // R7: v3 must have run the non-GUI branch BC runs. `runnerBuild` marks a directly measured entry.
  const contexts = (
    r.validity as { executionContexts?: { runnerBuild?: string; noClient?: true }[] } | undefined
  )?.executionContexts;
  const measured = (contexts ?? []).filter((c) => c.runnerBuild !== undefined);
  if (measured.length === 0 || measured.some((c) => c.noClient !== true)) {
    reasons.push(
      'v3 did not run with --no-client (set "alRunnerV3.noClient"), so it ran the GUI branch BC does not',
    );
  }
  if (reasons.length > 0 || !isText(sourceSha256) || !isText(numberingDigest) || !isText(testSha))
    throw new V3VerdictsError(path, reasons);
  const methods = r.testMethods as readonly { name: string; baselineFlagged?: true }[] | undefined;
  return {
    path,
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    runnerBuild: contexts?.find((c) => c.runnerBuild !== undefined)?.runnerBuild,
    sourceSha256,
    numberingDigest,
    testSourceSha256: testSha,
    rows,
    unsupportedTests: new Set((r.unsupportedTests ?? []) as readonly string[]),
    testNames: methods === undefined ? undefined : new Set(methods.map((m) => m.name)),
    flaggedTests: new Set(
      (methods ?? []).filter((m) => m.baselineFlagged === true).map((m) => m.name),
    ),
  };
}

/** The refused tests this report did not see pass on v3. */
function notGreenOnV3(input: V3VerdictsInput, refused: readonly string[]): string[] {
  return refused.filter(
    (t) =>
      input.unsupportedTests.has(t) || (input.testNames !== undefined && !input.testNames.has(t)),
  );
}

export interface V3VerdictsRunFacts {
  readonly sourceSha256: string;
  readonly numberingDigest: string;
  readonly testSourceSha256: string;
  readonly refusedTests: readonly string[];
  /** How many mutants this run will deploy: the report must hold at least that many rows. */
  readonly deployedCount: number;
}

const NAMED = 5;
const listed = (xs: readonly string[]): string =>
  `${xs.slice(0, NAMED).join(", ")}${xs.length > NAMED ? ` and ${xs.length - NAMED} more` : ""}`;

/** After generation, before anything is deployed. Throws `V3VerdictsError` on any difference. */
export function checkV3Verdicts(input: V3VerdictsInput, run: V3VerdictsRunFacts): void {
  const reasons: string[] = [];
  if (input.sourceSha256 !== run.sourceSha256)
    reasons.push("its source differs from this run's (sourceSha256)");
  if (input.numberingDigest !== run.numberingDigest)
    reasons.push("it numbered different mutation sites (numberingDigest)");
  if (input.testSourceSha256 !== run.testSourceSha256)
    reasons.push("its test app differs from this run's (testSourceSha256)");
  // Before the batch loop, so a short report cannot stop a run after BC has measured part of it.
  if (input.rows.size < run.deployedCount)
    reasons.push(`it has ${input.rows.size} rows for this run's ${run.deployedCount} mutants`);
  if (
    run.refusedTests.length > 0 &&
    notGreenOnV3(input, run.refusedTests).length === run.refusedTests.length
  )
    reasons.push("none of the tests BC refuses passed on v3, so it can say nothing about them");
  if (reasons.length > 0) throw new V3VerdictsError(input.path, reasons);
}

/** v3 runs on Linux only, so a report's paths use `/` while a bcdev run on Windows has `\`. */
const slashes = (p: string): string => p.replaceAll("\\", "/");

/** One batch's manifest, before that batch is deployed: every row must be the same site. */
export function checkV3Rows(
  input: V3VerdictsInput,
  manifest: readonly MutantManifestEntry[],
): void {
  const reasons: string[] = [];
  const missing: string[] = [];
  const moved: string[] = [];
  for (const m of manifest) {
    const row = input.rows.get(manifestKey(m));
    if (row === undefined) missing.push(m.mutantId);
    else if (
      slashes(row.file) !== slashes(m.file) ||
      row.startIndex !== m.startIndex ||
      row.endIndex !== m.endIndex ||
      row.mutatedText !== m.mutatedText
    )
      moved.push(m.mutantId);
  }
  if (missing.length > 0) reasons.push(`it has no row for ${listed(missing)}`);
  if (moved.length > 0)
    reasons.push(`the same key names a different site or text for ${listed(moved)}`);
  if (reasons.length > 0) throw new V3VerdictsError(input.path, reasons);
}

/**
 * Eligible: BC read `no-coverage` for no other named reason (a refused or unplaceable object says
 * why it is uncovered, R298, R175), v3 has covering tests, and BC refused every one of them.
 */
export function joinV3Verdicts(
  input: V3VerdictsInput,
  outcomes: readonly SessionOutcome[],
  refusedTests: readonly string[],
  unplaceable: ReadonlySet<string>,
): V3VerdictsJoin {
  const refused = new Set(refusedTests);
  const kills: V3KillRow[] = [];
  const notShown = { survived: 0, timeoutKilled: 0, otherVerdict: 0 };
  for (const o of outcomes) {
    if (o.verdict !== "no-coverage" || o.failureNote !== undefined) continue;
    if (unplaceable.has(`${o.batchIndex}\0${o.mutant.mutantId}`)) continue;
    const row = input.rows.get(manifestKey(o.mutant));
    const covering = row?.coveringTests ?? [];
    if (row === undefined || covering.length === 0 || !covering.every((t) => refused.has(t)))
      continue;
    if (row.verdict === "killed" && row.killingTest !== undefined) {
      kills.push({
        batchIndex: o.batchIndex,
        mutantCode: o.mutant.mutantId,
        killingTest: row.killingTest,
        coveringTests: covering,
        // Ruling 2: a kill through a flagged (no-client-session) baseline pass is shown, labelled.
        ...(input.flaggedTests.has(row.killingTest) ? { killingTestNoClient: true as const } : {}),
      });
    } else if (row.verdict === "survived") notShown.survived++;
    else if (row.verdict === "timeout-killed") notShown.timeoutKilled++;
    else notShown.otherVerdict++;
  }
  return {
    reportSha256: input.reportSha256,
    ...(input.runnerBuild !== undefined ? { runnerBuild: input.runnerBuild } : {}),
    kills,
    notShown,
    refusedTestsNotGreenOnV3: notGreenOnV3(input, refusedTests),
  };
}
