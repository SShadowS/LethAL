/**
 * PR-171 (R1122): confirm only the noted al-runner-v3 survivors on BC.
 *
 * Spec: docs/superpowers/specs/2026-11-18-pr169-r1122-confirm-noted-survivors.md, amendment 1.
 *
 * Three pieces, kept apart so each is pure and testable:
 *   1. SELECTION (`planConfirm`): from a v3 report, the keys `lethal run --confirm-from` deploys.
 *   2. NARROWING (`narrowToConfirmed`): applied to the generated set AFTER identity ordinals are
 *      numbered over the FULL set (amendment item 2), so a twin's ordinal is the one the v3 report
 *      holds. It must never run beside PR-144's `exactSites`, which filters BEFORE numbering.
 *   3. MERGE (`mergeConfirmation`): the `kind: "lethal-confirmation"` artifact `lethal confirm-merge`
 *      writes. It is NOT a SessionReport.
 *
 * Every refusal is a typed error that extends `Error` directly. Each is thrown before any deploy
 * (selection, narrowing) or before anything is written (merge).
 */
import { createHash } from "node:crypto";
import {
  type InstrumentedFile,
  dedupeSpecs,
  identityEntriesOf,
  identitySiteKey,
} from "@lethal/schemata";
import { V3_REFUSED_NEARBY_TAG } from "./al-runner-v3-backend";
import { type BackendKind, isBcdev } from "./backend";
import { SURVIVING_VERDICTS } from "./equivalence-marks";
import { keyOf } from "./mutant-key";
import { notRunLine, notRunSurvivors } from "./not-run-survivors";
import { failureTextMechanisms } from "./platform-artifact-kills";
import type { MutantOutcome, SessionReport } from "./report";

/** The lead of R609's `no-coverage` note (`unsupportedCoverageNote` in orchestrator.ts writes it
 *  from this constant, so the writer and this reader cannot drift). */
export const V3_NOCOV_REFUSAL_LEAD = "al-runner v3 refusal";

/** `noted`: a v3 survivor carrying `[v3-refused-test-nearby]`. `nocov-noted`: a v3 `no-coverage`
 *  mutant carrying R609's note. `sample`: a seeded draw of unnoted survivors. */
export type ConfirmGroup = "noted" | "nocov-noted" | "sample";

export const DEFAULT_CONFIRM_SAMPLE = 30;

export interface ConfirmSelectedKey {
  readonly key: string;
  readonly group: ConfirmGroup;
}

/** What `--confirm-from` was GIVEN and resolved to, before any generation. Rides on
 *  `run-configured.confirm`. */
export interface ConfirmGiven {
  readonly inputPath: string;
  readonly inputSha256: string;
  readonly sample: number;
  readonly seed: string;
  readonly selected: readonly ConfirmSelectedKey[];
}

/** `SessionReport.confirm`: the given half plus the LEARNED site count. Present only when
 *  `--confirm-from` was used, so an older report validates unchanged. */
export interface ConfirmRecord {
  // Flattened, not `extends ConfirmGiven`: scripts/generate-schemas.ts reads members, not heritage.
  readonly inputPath: string;
  readonly inputSha256: string;
  readonly sample: number;
  readonly seed: string;
  readonly selected: readonly ConfirmSelectedKey[];
  /** Post-dedup sites the confirm narrowing left out of the generated set. */
  readonly excludedSiteCount: number;
}

// --- refusals -----------------------------------------------------------------------------

export class ConfirmInputNotReportError extends Error {
  constructor(detail: string) {
    super(
      `confirm-input-not-a-report: --confirm-from file is not a SessionReport (${detail}). Give the JSON a \`lethal run --backend al-runner-v3 --out\` wrote.`,
    );
    this.name = "ConfirmInputNotReportError";
  }
}
export class ConfirmInputNotV3Error extends Error {
  constructor(backend: string) {
    super(
      `confirm-input-not-v3: the input report's run was backend "${backend}", not al-runner-v3. Only a v3 run's noted survivors are confirmed.`,
    );
    this.name = "ConfirmInputNotV3Error";
  }
}
export class ConfirmInputPartialError extends Error {
  constructor(why: string) {
    super(
      `confirm-input-partial: the report is a partial run (${why}). A mutant it never scored would read as absent, not as unconfirmed. Re-run it to the end.`,
    );
    this.name = "ConfirmInputPartialError";
  }
}
export class ConfirmFlagsMismatchError extends Error {
  constructor(diffs: readonly string[]) {
    super(
      `confirm-flags-mismatch: the two runs differ in what the identity key depends on: ${diffs.join("; ")}. A mismatch could shift keys and confirm a different mutant. Run both with the same --only, --exclude, --operator, --lines and preprocessor symbols.`,
    );
    this.name = "ConfirmFlagsMismatchError";
  }
}
export class ConfirmSuiteMismatchError extends Error {
  constructor(diffs: readonly string[]) {
    super(
      `confirm-suite-mismatch: the two runs used different suites: ${diffs.join("; ")}. A different suite on BC would credit kills to tests outside v3's scope.`,
    );
    this.name = "ConfirmSuiteMismatchError";
  }
}
export class ConfirmSourceMismatchError extends Error {
  constructor(diffs: readonly string[]) {
    super(
      `confirm-source-mismatch: the two runs did not see the same source or identity scheme: ${diffs.join("; ")}. Run both from one commit.`,
    );
    this.name = "ConfirmSourceMismatchError";
  }
}
export class ConfirmSkipKnownSurvivorsError extends Error {
  constructor() {
    super(
      "confirm-skip-known-survivors: --skip-known-survivors cannot be used with --confirm-from. A `known-survivor` row is not a measurement made in this run.",
    );
    this.name = "ConfirmSkipKnownSurvivorsError";
  }
}
export class ConfirmResumeError extends Error {
  constructor() {
    super(
      "confirm-resume: --resume and --resume-run cannot be used with --confirm-from. A resumed confirm run would need its own identity rules.",
    );
    this.name = "ConfirmResumeError";
  }
}
export class ConfirmExactSitesError extends Error {
  constructor() {
    super(
      "confirm-exact-sites: --confirm-from cannot run beside the withheld-kill recheck's exactSites. exactSites filters BEFORE identity ordinals are numbered, so a twin's key would name another mutant.",
    );
    this.name = "ConfirmExactSitesError";
  }
}
export class ConfirmEmptySetError extends Error {
  constructor() {
    super(
      "confirm-empty-set: nothing to confirm: the v3 run has no noted survivors and the sample is 0. The run does not start.",
    );
    this.name = "ConfirmEmptySetError";
  }
}
export class ConfirmDuplicateKeyError extends Error {
  constructor(where: string, keys: readonly string[]) {
    super(
      `confirm-duplicate-key: ${where} holds ${keys.length} key(s) shared by more than one mutant, so a key cannot name one: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}.`,
    );
    this.name = "ConfirmDuplicateKeyError";
  }
}
export class ConfirmKeyMatchError extends Error {
  constructor(
    readonly unmatched: readonly string[],
    readonly ambiguous: readonly string[],
  ) {
    super(
      `confirm-key-match: ${unmatched.length} selected key(s) match no mutant in this run's set and ${ambiguous.length} match more than one (the source may have changed between the two runs): ${[...unmatched.map((k) => `none: ${k}`), ...ambiguous.map((k) => `several: ${k}`)].join("; ")}.`,
    );
    this.name = "ConfirmKeyMatchError";
  }
}
export class ConfirmMergeNotConfirmRunError extends Error {
  constructor() {
    super(
      "confirm-merge-not-a-confirm-run: bc.json carries no `confirm` block, so it was not made with --confirm-from.",
    );
    this.name = "ConfirmMergeNotConfirmRunError";
  }
}
export class ConfirmMergeInputShaError extends Error {
  constructor(recorded: string, actual: string) {
    super(
      `confirm-merge-input-sha: bc.json was selected from a v3 report with sha256 ${recorded}, but v3.json has sha256 ${actual}.`,
    );
    this.name = "ConfirmMergeInputShaError";
  }
}
export class ConfirmMergeBcPartialError extends Error {
  constructor(why: string) {
    super(
      `confirm-merge-bc-partial: bc.json is a partial run (${why}), so a selected mutant may be missing for the wrong reason. Re-run it to the end.`,
    );
    this.name = "ConfirmMergeBcPartialError";
  }
}
export class ConfirmMergeMissingKeyError extends Error {
  constructor(keys: readonly string[]) {
    super(
      `confirm-merge-missing-key: ${keys.length} selected key(s) are missing from bc.json: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}.`,
    );
    this.name = "ConfirmMergeMissingKeyError";
  }
}
export class ConfirmMergeUnselectedKeyError extends Error {
  constructor(keys: readonly string[]) {
    super(
      `confirm-merge-unselected-key: bc.json holds ${keys.length} key(s) that were not selected: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}.`,
    );
    this.name = "ConfirmMergeUnselectedKeyError";
  }
}
export class ConfirmMergeSelectionMismatchError extends Error {
  constructor(differences: readonly string[]) {
    super(
      `confirm-merge-selection-mismatch: the selection bc.json recorded is not what v3.json gives with the sample size and seed bc.json recorded (${differences.length} difference(s)): ${differences.slice(0, 5).join("; ")}${differences.length > 5 ? "; ..." : ""}.`,
    );
    this.name = "ConfirmMergeSelectionMismatchError";
  }
}
export class ConfirmBackendNotBcdevError extends Error {
  constructor(backend: string) {
    super(
      `confirm-backend-not-bcdev: --confirm-from runs on --backend bcdev, not ${backend}. The point is BC's answer for what v3 could not measure.`,
    );
    this.name = "ConfirmBackendNotBcdevError";
  }
}
export class ConfirmMergeBcNotBcdevError extends Error {
  constructor(backend: string) {
    super(
      `confirm-merge-bc-not-bcdev: bc.json is a "${backend}" report, not a bcdev one. Only BC's verdicts may override v3's.`,
    );
    this.name = "ConfirmMergeBcNotBcdevError";
  }
}
export class ConfirmMergeBcRowNotMeasuredError extends Error {
  constructor(keys: readonly string[]) {
    super(
      `confirm-merge-bc-row-not-measured: ${keys.length} bc.json row(s) are \`known-survivor\`, which is not a measurement made in that run: ${keys.slice(0, 5).join(", ")}.`,
    );
    this.name = "ConfirmMergeBcRowNotMeasuredError";
  }
}

// --- input checks -------------------------------------------------------------------------

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Refuse anything that is not a SessionReport-shaped value. Not a schema check: it reads only the
 *  fields this feature uses, and refuses by name when one is missing. */
export function asSessionReport(v: unknown): SessionReport {
  if (!isObject(v)) throw new ConfirmInputNotReportError("not a JSON object");
  if (!Array.isArray(v.mutants)) throw new ConfirmInputNotReportError("no `mutants` array");
  if (typeof v.backend !== "string") throw new ConfirmInputNotReportError("no `backend` string");
  if (typeof v.schemaVersion !== "number") {
    throw new ConfirmInputNotReportError("no `schemaVersion` number");
  }
  return v as unknown as SessionReport;
}

function partialReason(r: SessionReport): string | undefined {
  if (r.quarantined !== undefined) return `quarantined: ${r.quarantined.reason}`;
  if (r.timeBudget !== undefined) return "the time budget ran out";
  const stranded = r.mutants.filter((m) => m.cause === "stranded").length;
  if (stranded > 0) return `${stranded} mutant(s) stranded`;
  return undefined;
}

/** The v3 report `--confirm-from` reads: a SessionReport, from al-runner-v3, finished. */
export function assertConfirmInput(v: unknown): SessionReport {
  const r = asSessionReport(v);
  if (r.backend !== "al-runner-v3") throw new ConfirmInputNotV3Error(r.backend);
  const why = partialReason(r);
  if (why !== undefined) throw new ConfirmInputPartialError(why);
  return r;
}

function duplicateKeys(r: SessionReport): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of r.mutants) {
    const k = keyOf(m);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup].sort();
}

// --- selection ----------------------------------------------------------------------------

/** A v3 survivor the refused-test note marks. */
export function isNotedSurvivor(m: MutantOutcome): boolean {
  return m.verdict === "survived" && (m.failureNote ?? "").startsWith(V3_REFUSED_NEARBY_TAG);
}

/** A v3 `no-coverage` mutant carrying R609's note: its only reaching tests were refused by v3. */
export function isNotedNoCoverage(m: MutantOutcome): boolean {
  return m.verdict === "no-coverage" && (m.failureNote ?? "").startsWith(V3_NOCOV_REFUSAL_LEAD);
}

/** The unnoted survivors the sample draws from. */
export function isUnnotedSurvivor(m: MutantOutcome): boolean {
  return m.verdict === "survived" && !isNotedSurvivor(m);
}

/**
 * The seeded draw: every candidate is ranked by sha256(seed|key) and the first `n` are kept. That
 * is uniform without replacement, deterministic, and independent of the report's row order.
 */
export function drawSample(keys: readonly string[], n: number, seed: string): string[] {
  const ranked = keys
    .map((k) => ({ k, h: sha256Hex(`${seed}|${k}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return ranked.slice(0, Math.max(0, n)).map((x) => x.k);
}

export interface ConfirmPlanInput {
  readonly inputPath: string;
  /** The parsed `--confirm-from` file. */
  readonly input: unknown;
  /** The file's bytes' sha256: the seed's default and the join key the merge checks. */
  readonly inputSha256: string;
  readonly sample?: number;
  readonly seed?: string;
  readonly skipKnownSurvivors: boolean;
  readonly resume: boolean;
  /** PR-144's `exactSites` is set on this session. */
  readonly exactSites: boolean;
}

export interface ConfirmPlan {
  readonly given: ConfirmGiven;
  /** The v3 report, kept for the scope check and for naming rows in a key refusal. */
  readonly report: SessionReport;
}

/** Every refusal that needs only the flags and the input file: all before any generation. */
export function planConfirm(p: ConfirmPlanInput): ConfirmPlan {
  if (p.skipKnownSurvivors) throw new ConfirmSkipKnownSurvivorsError();
  if (p.resume) throw new ConfirmResumeError();
  if (p.exactSites) throw new ConfirmExactSitesError();
  const report = assertConfirmInput(p.input);
  const dup = duplicateKeys(report);
  if (dup.length > 0) throw new ConfirmDuplicateKeyError("the v3 report", dup);
  const sample = p.sample ?? DEFAULT_CONFIRM_SAMPLE;
  const seed = p.seed ?? p.inputSha256;
  const selected: ConfirmSelectedKey[] = [];
  for (const m of report.mutants) {
    if (isNotedSurvivor(m)) selected.push({ key: keyOf(m), group: "noted" });
    else if (isNotedNoCoverage(m)) selected.push({ key: keyOf(m), group: "nocov-noted" });
  }
  const pool = report.mutants.filter(isUnnotedSurvivor).map(keyOf);
  for (const key of drawSample(pool, sample, seed)) selected.push({ key, group: "sample" });
  if (selected.length === 0) throw new ConfirmEmptySetError();
  selected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    report,
    given: { inputPath: p.inputPath, inputSha256: p.inputSha256, sample, seed, selected },
  };
}

// --- scope comparison (the confirm run, and the merge) --------------------------------------

/** What the identity key and the suite depend on, from either side of the comparison. */
export interface ScopeFacts {
  readonly only: readonly string[];
  readonly exclude: readonly string[];
  readonly operators: readonly string[];
  readonly lines: readonly string[];
  readonly preprocessorSymbols: readonly string[];
  readonly testsOnly: readonly string[];
  readonly excludeTests: readonly string[];
  readonly sourceSha256: string | undefined;
  readonly dependencySourceSha256: string | undefined;
  readonly identityScheme: number;
}

const sorted = (a: readonly string[] | undefined): string[] => [...(a ?? [])].sort();

/** The facts a finished report records. */
export function scopeOfReport(r: SessionReport): ScopeFacts {
  return {
    only: sorted(r.only?.patterns),
    exclude: sorted(r.exclude?.patterns),
    operators: sorted(r.operators?.names),
    lines: sorted(r.lines?.ranges.map((x) => `${x.file}:${x.start}-${x.end}`)),
    preprocessorSymbols: sorted(r.preprocessorSymbols),
    testsOnly: sorted(r.testsOnly),
    excludeTests: sorted(
      (r.excludedTests ?? []).filter((t) => t.reason === "exclude-test").map((t) => t.test),
    ),
    sourceSha256: r.sourceSha256,
    dependencySourceSha256: r.dependencySourceSha256,
    identityScheme: r.identityScheme ?? 1,
  };
}

/** The facts a run in progress holds (`runSession`, after generation, before any deploy). */
export function scopeOfRun(c: {
  readonly only?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly operators?: readonly string[] | undefined;
  readonly lines?: readonly { file: string; start: number; end: number }[] | undefined;
  readonly preprocessorSymbols?: readonly string[] | undefined;
  readonly testsOnly?: readonly string[] | undefined;
  readonly excludeTests?: readonly string[] | undefined;
  readonly sourceSha256: string;
  readonly dependencySourceSha256: string;
  readonly identityScheme: number;
}): ScopeFacts {
  return {
    only: sorted(c.only),
    exclude: sorted(c.exclude),
    operators: sorted(c.operators),
    lines: sorted(c.lines?.map((x) => `${x.file}:${x.start}-${x.end}`)),
    preprocessorSymbols: sorted(c.preprocessorSymbols),
    testsOnly: sorted(c.testsOnly),
    excludeTests: sorted(c.excludeTests),
    sourceSha256: c.sourceSha256,
    dependencySourceSha256: c.dependencySourceSha256,
    identityScheme: c.identityScheme,
  };
}

const show = (a: readonly string[]): string => `[${sorted(a).join(", ")}]`;

/** Refuse when the two sides differ in anything the key or the suite rests on. Applied by the
 *  confirm run (input report vs this run) and by the merge (v3 vs bc). A `sha256` missing on
 *  either side is a difference: an unknown source is not the same source. */
export function assertSameScope(a: ScopeFacts, b: ScopeFacts): void {
  const flags: string[] = [];
  for (const f of ["only", "exclude", "operators", "lines", "preprocessorSymbols"] as const) {
    if (show(a[f]) !== show(b[f])) flags.push(`${f} ${show(a[f])} vs ${show(b[f])}`);
  }
  if (flags.length > 0) throw new ConfirmFlagsMismatchError(flags);
  const suite: string[] = [];
  for (const f of ["testsOnly", "excludeTests"] as const) {
    if (show(a[f]) !== show(b[f])) suite.push(`${f} ${show(a[f])} vs ${show(b[f])}`);
  }
  if (suite.length > 0) throw new ConfirmSuiteMismatchError(suite);
  const source: string[] = [];
  if (a.sourceSha256 === undefined || a.sourceSha256 !== b.sourceSha256) {
    source.push(`sourceSha256 ${a.sourceSha256 ?? "absent"} vs ${b.sourceSha256 ?? "absent"}`);
  }
  // PR-177: `dependencySourceSha256` is NOT compared. A v3-versus-BC pair normally reads different
  // symbol builds; the merge records both and flags a difference (`dependency-symbols-differ`).
  if (a.identityScheme !== b.identityScheme) {
    source.push(`identityScheme ${a.identityScheme} vs ${b.identityScheme}`);
  }
  if (source.length > 0) throw new ConfirmSourceMismatchError(source);
}

// --- narrowing (runs AFTER numberIdentityOrdinals over the FULL set) ------------------------

export interface NarrowResult {
  readonly files: InstrumentedFile[];
  /** Post-dedup sites left out. */
  readonly excluded: number;
}

/**
 * Keep exactly the sites whose `keyOf` is selected. `ordinals` is `numberIdentityOrdinals` over the
 * FULL generated set (amendment item 2), so a twin keeps the ordinal the v3 report recorded; the
 * kept specs are the deduped survivors, in source order.
 *
 * Refuses (`ConfirmKeyMatchError`) a selected key that matches no site, or more than one.
 */
export function narrowToConfirmed(
  files: readonly InstrumentedFile[],
  ordinals: ReadonlyMap<string, number>,
  tierOf: Parameters<typeof dedupeSpecs>[1],
  selected: readonly ConfirmSelectedKey[],
): NarrowResult {
  const want = new Set(selected.map((s) => s.key));
  const matched = new Map<string, number>();
  const out: InstrumentedFile[] = [];
  let total = 0;
  let kept = 0;
  for (const f of files) {
    const deduped = dedupeSpecs(f.specs, tierOf);
    const entries = identityEntriesOf(f.path, f.source, deduped);
    total += deduped.length;
    const keep: (typeof deduped)[number][] = [];
    deduped.forEach((spec, i) => {
      const e = entries[i];
      if (e === undefined) throw new Error("narrowToConfirmed: entry and spec lists diverged");
      const ordinal = ordinals.get(
        identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName),
      );
      if (ordinal === undefined) {
        throw new Error(`narrowToConfirmed: ${e.file} @${e.startIndex} has no identity ordinal`);
      }
      const key = ordinal > 0 ? `${e.tuple}|${ordinal}` : e.tuple;
      if (!want.has(key)) return;
      matched.set(key, (matched.get(key) ?? 0) + 1);
      keep.push(spec);
    });
    kept += keep.length;
    if (keep.length > 0) out.push({ ...f, specs: keep });
  }
  const unmatched = [...want].filter((k) => !matched.has(k)).sort();
  const ambiguous = [...matched]
    .filter(([, n]) => n > 1)
    .map(([k]) => k)
    .sort();
  if (unmatched.length > 0 || ambiguous.length > 0) {
    throw new ConfirmKeyMatchError(unmatched, ambiguous);
  }
  return { files: out, excluded: total - kept };
}

// --- the merged artifact --------------------------------------------------------------------

export const CONFIRMATION_KIND = "lethal-confirmation";
// 2: PR-381 (R1197) added `totals.survivorsBesideUnrunTests` and the not-run text in `totals.provenance`.
export const CONFIRMATION_VERSION = 2;

export type ConfirmationGroup = ConfirmGroup | "unconfirmed";
export type ConfirmationMeasuredBy = "bcdev" | "al-runner-v3";
/** `linux-rdlc-stub`: R1121, copied from the killing failure text. `bc-error`: BC's verdict was
 *  `error`, which is not a measurement. */
export type ConfirmationFlag = "linux-rdlc-stub" | "bc-error";

export interface ConfirmationMutant {
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly v3Verdict: string;
  readonly group: ConfirmationGroup;
  /** Absent unless the mutant was confirmed on BC. */
  readonly bcVerdict?: string;
  readonly finalVerdict: string;
  readonly measuredBy: ConfirmationMeasuredBy;
  readonly flags: readonly ConfirmationFlag[];
  /** The BC test that killed it, when BC killed it. */
  readonly killingTest?: string;
  /** BC's own note, kept when the row is `bc-error`. */
  readonly note?: string;
}

export interface ConfirmationTotals {
  readonly byFinalVerdict: Readonly<Record<string, number>>;
  readonly byMeasuredBy: Readonly<Record<string, number>>;
  /** Of the final `killed` rows measured on BC: the R1121 platform-stub kills (kept as killed). */
  readonly bcStubKills: number;
  /** (killed + timeout-killed) / (killed + timeout-killed + survived) over the FINAL verdicts, or
   *  null. Never read without `provenance`. */
  readonly score: number | null;
  /** "N survivors, M of them measured on BC": printed beside every score. PR-381 (R1197): then, for an
   *  al-runner-v3 run with tests not run at baseline, `notRunSentence` over the survivors still
   *  measured by v3 (or "tests not run at baseline: not recorded in this report"). */
  readonly provenance: string;
  /** PR-381 (R1197): the counts behind that sentence; absent when it does not apply. */
  readonly survivorsBesideUnrunTests?: {
    readonly survivors: number;
    readonly notRunTests: number;
    readonly sharingACodeunit?: number;
  };
}

export interface ConfirmationSample {
  /** `n` the run was given. */
  readonly requested: number;
  /** Mutants the sample drew (the sample group of the recomputed selection). */
  readonly drawn: number;
  /** Drawn mutants BC scored `killed`, `timeout-killed` or `survived`. A BC `error` or
   *  `no-coverage` is not a measurement of the unnoted kill rate. */
  readonly measured: number;
  /** Unnoted v3 survivors in all. */
  readonly unnotedSurvivors: number;
  /** Sampled mutants BC killed, R1121 stub kills excluded. */
  readonly killedOnBc: number;
  /** Sampled mutants BC killed on a stub (R1121), counted apart. */
  readonly stubKilledOnBc: number;
  /** Rule of three, 3 / `measured`: only when nothing was killed and the number DRAWN is smaller
   *  than the unnoted set. Otherwise null. */
  readonly upperBound95: number | null;
  /** Every unnoted survivor was drawn (so there is no bound to print). */
  readonly allUnnotedDrawn: boolean;
  /** `none`: nothing measured. */
  readonly verdict: "agreement" | "disagreement" | "none";
  /** Keys that make a `disagreement`. */
  readonly disagreementKeys: readonly string[];
}

/** `dependency-symbols-differ`: the two runs read different dependency symbol builds (PR-177). */
export type ConfirmationArtifactFlag = "dependency-symbols-differ";

export interface Confirmation {
  readonly kind: "lethal-confirmation";
  readonly confirmationVersion: number;
  readonly v3Sha256: string;
  readonly bcSha256?: string;
  /** Artifact-level flags; empty when there is nothing to flag. */
  readonly flags: readonly ConfirmationArtifactFlag[];
  /** Each run's `dependencySourceSha256`; a side that recorded none is absent. */
  readonly dependencySourceSha256: { readonly v3?: string; readonly bc?: string };
  readonly seed: string;
  readonly mutants: readonly ConfirmationMutant[];
  readonly totals: ConfirmationTotals;
  readonly sample: ConfirmationSample;
}

const isKill = (v: string): boolean => v === "killed" || v === "timeout-killed";

export interface MergeInput {
  readonly v3: unknown;
  readonly v3Sha256: string;
  readonly bc: unknown;
  readonly bcSha256?: string;
}

export function mergeConfirmation(p: MergeInput): Confirmation {
  const v3 = assertConfirmInput(p.v3);
  const bc = asSessionReport(p.bc);
  if (!isBcdev(bc.backend as BackendKind)) throw new ConfirmMergeBcNotBcdevError(bc.backend);
  const dupV3 = duplicateKeys(v3);
  if (dupV3.length > 0) throw new ConfirmDuplicateKeyError("v3.json", dupV3);
  const dupBc = duplicateKeys(bc);
  if (dupBc.length > 0) throw new ConfirmDuplicateKeyError("bc.json", dupBc);
  const block = bc.confirm;
  if (block === undefined) throw new ConfirmMergeNotConfirmRunError();
  if (block.inputSha256 !== p.v3Sha256) {
    throw new ConfirmMergeInputShaError(block.inputSha256, p.v3Sha256);
  }
  const why = partialReason(bc);
  if (why !== undefined) throw new ConfirmMergeBcPartialError(why);
  const v3Scope = scopeOfReport(v3);
  const bcScope = scopeOfReport(bc);
  assertSameScope(v3Scope, bcScope);
  const v3Dep = v3Scope.dependencySourceSha256;
  const bcDep = bcScope.dependencySourceSha256;

  // Recompute the selection from v3.json with the n and seed bc.json recorded, and refuse unless it
  // is exactly the selection bc.json recorded. The recomputed groups are the ones used below, so a
  // relabelled group or a key added, dropped or changed cannot reach the artifact.
  const recomputed = planConfirm({
    inputPath: block.inputPath,
    input: p.v3,
    inputSha256: p.v3Sha256,
    sample: block.sample,
    seed: block.seed,
    skipKnownSurvivors: false,
    resume: false,
    exactSites: false,
  }).given.selected;
  const asPairs = (s: readonly ConfirmSelectedKey[]) =>
    new Set(s.map((x) => `${x.group} ${x.key}`));
  const recordedPairs = asPairs(block.selected);
  const recomputedPairs = asPairs(recomputed);
  const differ = [
    ...[...recomputedPairs].filter((x) => !recordedPairs.has(x)).map((x) => `not recorded: ${x}`),
    ...[...recordedPairs].filter((x) => !recomputedPairs.has(x)).map((x) => `not recomputed: ${x}`),
  ].sort();
  if (differ.length > 0) throw new ConfirmMergeSelectionMismatchError(differ);
  const groupOf = new Map(recomputed.map((s) => [s.key, s.group] as const));
  const bcByKey = new Map(bc.mutants.map((m) => [keyOf(m), m] as const));
  const unselected = [...bcByKey.keys()].filter((k) => !groupOf.has(k)).sort();
  if (unselected.length > 0) throw new ConfirmMergeUnselectedKeyError(unselected);
  const missing = [...groupOf.keys()].filter((k) => !bcByKey.has(k)).sort();
  if (missing.length > 0) throw new ConfirmMergeMissingKeyError(missing);
  const knownRows = [...bcByKey].filter(([, m]) => m.verdict === "known-survivor").map(([k]) => k);
  if (knownRows.length > 0) throw new ConfirmMergeBcRowNotMeasuredError(knownRows.sort());

  const mutants: ConfirmationMutant[] = v3.mutants.map((m) => {
    const key = keyOf(m);
    const group = groupOf.get(key);
    const base = {
      key,
      file: m.file,
      line: m.line,
      operatorName: m.operatorName,
      procedureName: m.procedureName || m.triggerName || "",
      v3Verdict: m.verdict,
    };
    const b = bcByKey.get(key);
    if (group === undefined || b === undefined) {
      return {
        ...base,
        group: "unconfirmed",
        finalVerdict: m.verdict,
        measuredBy: "al-runner-v3",
        flags: [],
      };
    }
    if (b.verdict === "error") {
      // A BC error is not a measurement, so it does not override v3's verdict.
      return {
        ...base,
        group,
        bcVerdict: "error",
        finalVerdict: m.verdict,
        measuredBy: "al-runner-v3",
        flags: ["bc-error"],
        ...(b.failureNote !== undefined ? { note: b.failureNote } : {}),
      };
    }
    const stub = isKill(b.verdict) && failureTextMechanisms(b.killingTestFailure).length > 0;
    return {
      ...base,
      group,
      bcVerdict: b.verdict,
      finalVerdict: b.verdict,
      measuredBy: "bcdev",
      flags: stub ? ["linux-rdlc-stub"] : [],
      ...(b.killingTest !== undefined ? { killingTest: b.killingTest } : {}),
    };
  });

  return {
    kind: CONFIRMATION_KIND,
    confirmationVersion: CONFIRMATION_VERSION,
    v3Sha256: p.v3Sha256,
    ...(p.bcSha256 !== undefined ? { bcSha256: p.bcSha256 } : {}),
    // An absent sha on either side is not "the same symbols": nothing is known, so it is flagged too.
    flags:
      v3Dep === undefined || bcDep === undefined || v3Dep !== bcDep
        ? ["dependency-symbols-differ"]
        : [],
    dependencySourceSha256: {
      ...(v3Dep !== undefined ? { v3: v3Dep } : {}),
      ...(bcDep !== undefined ? { bc: bcDep } : {}),
    },
    seed: block.seed,
    mutants,
    totals: totalsOf(mutants, v3),
    sample: sampleOf(mutants, block.sample, v3),
  };
}

function totalsOf(mutants: readonly ConfirmationMutant[], v3: SessionReport): ConfirmationTotals {
  const byFinalVerdict: Record<string, number> = {};
  const byMeasuredBy: Record<string, number> = {};
  for (const m of mutants) {
    byFinalVerdict[m.finalVerdict] = (byFinalVerdict[m.finalVerdict] ?? 0) + 1;
    byMeasuredBy[m.measuredBy] = (byMeasuredBy[m.measuredBy] ?? 0) + 1;
  }
  const killed = (byFinalVerdict.killed ?? 0) + (byFinalVerdict["timeout-killed"] ?? 0);
  const survived = byFinalVerdict.survived ?? 0;
  const survivorsOnBc = mutants.filter(
    (m) => m.finalVerdict === "survived" && m.measuredBy === "bcdev",
  ).length;
  // PR-381 (R1197): only a survivor still measured by v3 can hide a kill a refused test would make;
  // one BC measured is settled.
  const stillV3 = new Set(
    mutants
      .filter((m) => m.measuredBy === "al-runner-v3" && SURVIVING_VERDICTS.has(m.finalVerdict))
      .map((m) => m.key),
  );
  // The stored result counts the whole run: this subset is recomputed, so the field is left out.
  const { survivorsBesideUnrunTests: _stored, ...v3Rest } = v3;
  const view = { ...v3Rest, mutants: v3.mutants.filter((m) => stillV3.has(keyOf(m))) };
  const notRun = notRunSurvivors(view);
  const notRunText = notRunLine(view);
  return {
    byFinalVerdict,
    byMeasuredBy,
    bcStubKills: mutants.filter((m) => m.flags.includes("linux-rdlc-stub")).length,
    score: killed + survived === 0 ? null : killed / (killed + survived),
    // Known-survivors count as survivors, as the not-run sentence counts them.
    provenance: `${survived + (byFinalVerdict["known-survivor"] ?? 0)} survivors, ${survivorsOnBc} of them measured on BC${notRunText !== undefined ? `; ${notRunText}` : ""}`,
    ...(notRun !== undefined ? { survivorsBesideUnrunTests: notRun } : {}),
  };
}

function sampleOf(
  mutants: readonly ConfirmationMutant[],
  requested: number,
  v3: SessionReport,
): ConfirmationSample {
  const unnotedSurvivors = v3.mutants.filter(isUnnotedSurvivor).length;
  const drawn = mutants.filter((m) => m.group === "sample");
  const measured = drawn.filter((m) =>
    ["killed", "timeout-killed", "survived"].includes(m.bcVerdict ?? ""),
  );
  const kills = measured.filter((m) => isKill(m.bcVerdict ?? ""));
  const stub = kills.filter((m) => m.flags.includes("linux-rdlc-stub"));
  const real = kills.filter((m) => !m.flags.includes("linux-rdlc-stub"));
  const allUnnotedDrawn = drawn.length >= unnotedSurvivors;
  return {
    requested,
    drawn: drawn.length,
    measured: measured.length,
    unnotedSurvivors,
    killedOnBc: real.length,
    stubKilledOnBc: stub.length,
    upperBound95:
      real.length === 0 && measured.length > 0 && !allUnnotedDrawn ? 3 / measured.length : null,
    allUnnotedDrawn,
    verdict: measured.length === 0 ? "none" : real.length > 0 ? "disagreement" : "agreement",
    disagreementKeys: real.map((m) => m.key).sort(),
  };
}

/** The console banner: the same totals as the artifact, then each confirmed kill. */
export function renderConfirmation(c: Confirmation): string[] {
  const lines: string[] = [];
  const t = c.totals;
  lines.push(
    `confirm-merge: ${c.mutants.length} mutants; final ${Object.entries(t.byFinalVerdict)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  lines.push(
    `measured by: ${Object.entries(t.byMeasuredBy)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  lines.push(
    `score ${t.score === null ? "n/a" : `${(t.score * 100).toFixed(1)}%`} (${t.provenance}); of which ${t.bcStubKills} are R1121 platform-stub kills`,
  );
  if (c.flags.includes("dependency-symbols-differ")) {
    lines.push(
      `dependency-symbols-differ: v3 read dependency symbols ${c.dependencySourceSha256.v3 ?? "absent"}, BC ${c.dependencySourceSha256.bc ?? "absent"}; the two runs read different symbol builds, so a difference between them can come from that.`,
    );
  }
  const s = c.sample;
  if (s.verdict === "disagreement") {
    lines.push(
      `unnoted-disagreement: BC killed ${s.killedOnBc} sampled unnoted survivor(s): ${s.disagreementKeys.join(", ")}. Run the full scope on bcdev.`,
    );
  } else if (s.allUnnotedDrawn && s.unnotedSurvivors > 0) {
    lines.push(
      `sample: all unnoted survivors measured (${s.drawn} drawn, ${s.measured} scored by BC); none killed on BC`,
    );
  } else if (s.upperBound95 !== null) {
    lines.push(
      `sample: ${s.measured} of ${s.unnotedSurvivors} unnoted survivors measured, none killed on BC; one-sided 95% upper bound on the unnoted kill rate: ${(s.upperBound95 * 100).toFixed(1)}% (3 / ${s.measured})`,
    );
  }
  for (const m of c.mutants) {
    if (m.measuredBy === "bcdev" && isKill(m.finalVerdict) && m.v3Verdict !== m.finalVerdict) {
      if (m.flags.includes("linux-rdlc-stub")) continue;
      lines.push(`confirmed kill ${m.key} ${m.file}:${m.line} by ${m.killingTest ?? "?"}`);
    }
  }
  return lines;
}
