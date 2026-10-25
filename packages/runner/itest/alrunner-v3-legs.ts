/**
 * R654 S2: the pure leg lists and judges of `itest:alrunner-v3`'s new legs. Pure on purpose: no IO
 * and no `src` import, so `scripts/agentflow` can import the leg list (as it does `alrunner-legs.ts`).
 *
 * Plan `docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md` §S2; pre-commitment
 * `docs/superpowers/specs/2026-10-22-r654-v3-gate-legs-precommitment.md` (43115c78).
 *
 * K (the CLI's own defaults) is OUT of the update gate's `V3_GATE_LEGS` by the orchestrator's
 * ruling, because the CLI's v3 config has no `candidate` key and a CLI-built backend refuses every
 * ungated build. Two conditions keep that honest:
 * 1. on a candidate build K is skipped with `V3_K_CANDIDATE_SKIP` in the itest's leg summary, never
 *    silently;
 * 2. on a gated build K that is anything but a pass (a skip included) FAILS the itest
 *    (`v3ItestFailures`), so K can never become an always-skipped leg.
 */

export const V3_K_LEG = "K";
/** Condition 1: K's leg-summary value on a candidate build. */
export const V3_K_CANDIDATE_SKIP = "skipped (candidate build)";

/**
 * R722: N1's dotted test name (`Dot.Step`) under serve-entries. A leg of the update gate
 * (`V3_GATE_LEGS`), so a build that fixes #5798 reads `held` there, never silence. alpha.2 has no
 * serve-entries path: `V3_NO_SERVE_ENTRIES` names it, and its refusal of `entries` is `pass`.
 */
export const V3_N1E_LEG = "N1E";

/** R763: N1's project without `Dot.Step`, one-shot then serve-entries (`legN1S`); in `V3_GATE_LEGS`. */
export const V3_N1S_LEG = "N1S";

/** The exact `--version` lines of builds that have no serve-entries path (alpha.2's `.gated`). */
export const V3_NO_SERVE_ENTRIES: readonly string[] = ["alrunner 3.0.0-alpha.2 (91253f2d6)"];

const UNKNOWN_ENTRIES_FIELD = 'the request was refused: "unknown field `entries` for runTests"';

/** R761: S1's project under serve-entries (`legS1E`); serve by construction, whatever the run's transport. */
export const V3_S1E_LEG = "S1E";

/** True when a build with no serve-entries path refused the `entries` field by name (N1E and S1E: not applicable). */
export function isNoServeRefusal(version: string, threw: string): boolean {
  return V3_NO_SERVE_ENTRIES.includes(version) && threw.includes(UNKNOWN_ENTRIES_FIELD);
}

/** What the N1E session did: it finished, or it threw this message. */
export type N1EReading = { readonly completed: true } | { readonly threw: string };

/**
 * R722, pre-committed (r19): on alpha.5 the serve request fails closed with `the entries answer is
 * invalid: a test line without v3's row shape: {...}` for `Codeunit<n>.Dot.Step`, a line that has no
 * `codeunit` and no `method` (upstream #5798). That is a `pass`. A finished session, or a line that
 * now has `codeunit` or `method`, is `held` (upstream may have fixed it: re-pre-commit), except (R771)
 * a line the build's pin records as its `n1e.refusedLine`, which is a `pass`. Any
 * other error, or the refusal for another test, is `gate-fail`. One exception: a build in
 * `V3_NO_SERVE_ENTRIES` that refuses the `entries` field by name is `pass` (not applicable); any
 * other build refusing `entries` is `gate-fail`.
 */
export function judgeN1Serve(
  r: N1EReading,
  version: string,
  pin?: { readonly refusedLine: RegExp },
): {
  readonly outcome: "pass" | "held" | "gate-fail";
  readonly lines: string[];
} {
  const held = (why: string) => ({
    outcome: "held" as const,
    lines: [`re-pre-commit: upstream may have fixed #5798 (${why})`],
  });
  if ("completed" in r) return held("the serve-entries session completed");
  if (isNoServeRefusal(version, r.threw)) {
    return {
      outcome: "pass",
      lines: ["N1E: not applicable: this build has no serve-entries path"],
    };
  }
  const m = /the entries answer is invalid: a test line without v3's row shape: (\{.*\})/.exec(
    r.threw,
  );
  const line = m?.[1];
  if (line === undefined) {
    return {
      outcome: "gate-fail",
      lines: [`N1E: not the pre-committed refusal (#5798): ${r.threw.slice(0, 300)}`],
    };
  }
  if (/"codeunit"|"method"/.test(line)) {
    // R771: a build whose pin names this exact line has #5798 fixed upstream; serveRow still refuses
    // the dotted name, so the session fails closed (safe, no row scored).
    if (pin?.refusedLine.test(line) === true) {
      return {
        outcome: "pass",
        lines: [
          "N1E: pinned: #5798 fixed upstream (the Dot.Step row carries codeunit and method); LethAL's serveRow still refuses a dotted method by name, so the session fails closed",
        ],
      };
    }
    return held(`the refused line now has codeunit or method: ${line}`);
  }
  if (!/Codeunit\d+\.Dot\.Step/.test(line)) {
    return { outcome: "gate-fail", lines: [`N1E: the refused line is not Dot.Step's: ${line}`] };
  }
  return { outcome: "pass", lines: [`N1E: failed closed as pre-committed (#5798): ${line}`] };
}

/** The legs the itest runs when `LETHAL_ITEST_V3_LEGS` is unset, in run order. */
export function v3DefaultLegs(o: { readonly cdo: boolean; readonly tables: boolean }): string[] {
  return [
    "C",
    "S1",
    V3_S1E_LEG,
    "S3",
    "N1",
    V3_N1E_LEG,
    V3_N1S_LEG,
    "X",
    "L1",
    "Y-A",
    "Y-B",
    // R602: coverage on for multi-object files (MO) and single-wrapper `#if` files (WR).
    "MO",
    "WR",
    V3_K_LEG,
    ...(o.cdo ? ["D1", "D1c"] : []),
    ...(o.tables ? ["T"] : []),
  ];
}

/** Agentflow's exact subleg list: the default set with no corpus leg and no tables leg. */
export const V3_AGENTFLOW_LEGS: readonly string[] = v3DefaultLegs({ cdo: false, tables: false });

/**
 * The legs that fail the itest, as `<leg>=<value>`. Every SELECTED leg must be in `legs` (a missing
 * one is `<leg>=missing`, so no leg drops out silently), and every leg in `legs` must be a pass,
 * except K on a candidate build, which must be exactly `V3_K_CANDIDATE_SKIP`. A run whose
 * selection leaves K out (`LETHAL_ITEST_V3_LEGS=T`, a record run of L1,Y-A,Y-B) is not judged on K.
 * Build review M2: a run in which NO leg passed (a candidate run of K alone, an empty selection)
 * is a failure, `no leg passed`: a PASS line must mean that something was measured.
 */
export function v3ItestFailures(
  legs: Readonly<Record<string, string>>,
  candidate: boolean,
  selected: readonly string[],
  /** R586c: K was asked to run on a candidate, so a skip is a failure there too. */
  kRuns = false,
): string[] {
  const out: string[] = [];
  for (const leg of selected) if (!(leg in legs)) out.push(`${leg}=missing`);
  for (const [leg, v] of Object.entries(legs)) {
    if (candidate && !kRuns && leg === V3_K_LEG && v === V3_K_CANDIDATE_SKIP) continue;
    if (v !== "pass") out.push(`${leg}=${v}`);
  }
  if (!Object.values(legs).includes("pass")) out.push("no leg passed");
  return out;
}

/**
 * R586c: `LETHAL_ITEST_V3_K_ON_CANDIDATE=1` runs K on a candidate build (the CLI-built backend gets
 * the test-only `alRunnerCandidate` seam). Unset: K is skipped there as before. Any other value is
 * refused by name.
 */
export function v3KOnCandidate(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.LETHAL_ITEST_V3_K_ON_CANDIDATE;
  if (v === undefined) return false;
  if (v !== "1") {
    throw new Error(
      `al-runner-v3-itest-k-on-candidate-refused: LETHAL_ITEST_V3_K_ON_CANDIDATE=${JSON.stringify(v)}; allowed: 1 or unset (R586c)`,
    );
  }
  return true;
}

/**
 * Build review M4: a record run exits 3 ("baselines recorded, not a pass") only when every leg it
 * did NOT record passed. The legs that recorded (`recorded`) count as passed here; any other leg's
 * failure is returned, and the run exits 1 naming it, so a failed table never hides behind a 3.
 */
export function v3RecordRunFailures(
  legs: Readonly<Record<string, string>>,
  recorded: ReadonlySet<string>,
  candidate: boolean,
  selected: readonly string[],
): string[] {
  const asPassed = Object.fromEntries(
    Object.entries(legs).map(([l, v]) => [l, recorded.has(l) ? "pass" : v]),
  );
  return v3ItestFailures(asPassed, candidate, selected);
}

/**
 * Build review M3: one of the backend's own mutant or baseline `test` calls (`v3CallArgv`: the
 * subcommand `test`, the session's test folder LAST), never the contract probe's or the
 * predefined-symbol probe's, which run against their own scratch projects. `testDirs` holds the
 * session's test folder as given and as resolved (the backend runs the real path).
 */
export function isSessionTestCall(argv: readonly string[], testDirs: readonly string[]): boolean {
  const last = argv.at(-1);
  return argv[1] === "test" && last !== undefined && testDirs.includes(last);
}

/**
 * R602 (durable killer check). A killer: `[mutantCode, file, line, operator, killing test]` of a
 * mutant that `--mode none` (the ground truth: every green test runs against every mutant) KILLS.
 * Legs MO and WR assert each is killed by the same test with coverage ON. They live in code, NOT in
 * the R332 baselines, so a re-record of a baseline can never absorb a lost kill. Built from
 * `/coord/handoff/R-602/measure/out/{multi,wrapped}.pin.none` (pin and edge identical), mutant
 * codes at identity scheme 42.
 */
export type V3Killer = readonly [
  code: string,
  file: string,
  line: number,
  operator: string,
  test: string,
];

/** `sandbox-multiobject`: the 6 kills of `none`. */
export const V3_MO_KILLERS: readonly V3Killer[] = [
  ["M0001", "src/MultiControl.Codeunit.al", 4, "empty-block", "ControlDoubles"],
  ["M0002", "src/MultiControl.Codeunit.al", 5, "return-value", "ControlDoubles"],
  ["M0006", "src/MultiPair.Codeunit.al", 12, "empty-block", "ReachedBothWays"],
  ["M0008", "src/MultiPair.Codeunit.al", 14, "return-value", "ReachedBothWays"],
  ["M0009", "src/MultiPair.Codeunit.al", 14, "swap-additive", "ReachedBothWays"],
  ["M0010", "src/MultiPair.Codeunit.al", 15, "return-value", "ReachedBothWays"],
];

/**
 * `sandbox-wrapped`: the 60 kills of `none` minus M0001 and M0003 (the two `WrappedArms` kills,
 * which the by-name refusal of a two-arm wrapper costs; `judgeWrArms` pins that refusal instead).
 */
export const V3_WR_KILLERS: readonly V3Killer[] = [
  ["M0004", "src/WrappedPairA.Codeunit.al", 10, "empty-block", "PairPick"],
  ["M0006", "src/WrappedPairA.Codeunit.al", 12, "return-value", "PairPick"],
  ["M0007", "src/WrappedPre.Codeunit.al", 9, "empty-block", "GrowPre"],
  ["M0009", "src/WrappedPre.Codeunit.al", 11, "return-value", "GrowPre"],
  ["M0010", "src/WrappedPre.Codeunit.al", 11, "swap-additive", "GrowPre"],
  ["M0012", "src/WrappedPre.Codeunit.al", 35, "empty-block", "TwicePre"],
  ["M0013", "src/WrappedPre.Codeunit.al", 36, "return-value", "TwicePre"],
  ["M0014", "src/WrappedPreTwin.Codeunit.al", 9, "empty-block", "GrowPreTwin"],
  ["M0016", "src/WrappedPreTwin.Codeunit.al", 11, "return-value", "GrowPreTwin"],
  ["M0017", "src/WrappedPreTwin.Codeunit.al", 11, "swap-additive", "GrowPreTwin"],
  ["M0019", "src/WrappedPreTwin.Codeunit.al", 35, "empty-block", "TwicePreTwin"],
  ["M0020", "src/WrappedPreTwin.Codeunit.al", 36, "return-value", "TwicePreTwin"],
  ["M0021", "src/WrappedTop.Codeunit.al", 7, "empty-block", "GrowTop"],
  ["M0023", "src/WrappedTop.Codeunit.al", 9, "return-value", "GrowTop"],
  ["M0024", "src/WrappedTop.Codeunit.al", 9, "swap-additive", "GrowTop"],
  ["M0026", "src/WrappedTop.Codeunit.al", 32, "empty-block", "TwiceTop"],
  ["M0027", "src/WrappedTop.Codeunit.al", 34, "remove-assignment", "TwiceTop"],
  ["M0028", "src/WrappedTop.Codeunit.al", 36, "return-value", "TwiceTop"],
  ["M0029", "src/WrappedTopTwin.Codeunit.al", 7, "empty-block", "GrowTopTwin"],
  ["M0031", "src/WrappedTopTwin.Codeunit.al", 9, "return-value", "GrowTopTwin"],
  ["M0032", "src/WrappedTopTwin.Codeunit.al", 9, "swap-additive", "GrowTopTwin"],
  ["M0034", "src/WrappedTopTwin.Codeunit.al", 32, "empty-block", "TwiceTopTwin"],
  ["M0035", "src/WrappedTopTwin.Codeunit.al", 34, "remove-assignment", "TwiceTopTwin"],
  ["M0036", "src/WrappedTopTwin.Codeunit.al", 36, "return-value", "TwiceTopTwin"],
  ["M0037", "src/WrappedTrigger.Table.al", 19, "empty-block", "ClampTrigger"],
  ["M0039", "src/WrappedTrigger.Table.al", 21, "remove-assignment", "ClampTrigger"],
  ["M0040", "src/WrappedTrigger.Table.al", 21, "shift-integer", "ClampTrigger"],
  ["M0041", "src/WrappedTrigger.Table.al", 35, "empty-block", "DoubledTrigger"],
  ["M0042", "src/WrappedTrigger.Table.al", 36, "return-value", "DoubledTrigger"],
  ["M0043", "src/WrappedTriggerTwin.Table.al", 19, "empty-block", "ClampTriggerTwin"],
  ["M0045", "src/WrappedTriggerTwin.Table.al", 21, "remove-assignment", "ClampTriggerTwin"],
  ["M0046", "src/WrappedTriggerTwin.Table.al", 21, "shift-integer", "ClampTriggerTwin"],
  ["M0047", "src/WrappedTriggerTwin.Table.al", 35, "empty-block", "DoubledTriggerTwin"],
  ["M0048", "src/WrappedTriggerTwin.Table.al", 36, "return-value", "DoubledTriggerTwin"],
  ["M0052", "src/WrappedView.Page.al", 32, "empty-block", "LabelView"],
  ["M0057", "src/WrappedViewTwin.Page.al", 32, "empty-block", "LabelViewTwin"],
  ["M0062", "src/WrappedXtra.PageExt.al", 19, "empty-block", "ScaledXtra"],
  ["M0064", "src/WrappedXtra.PageExt.al", 21, "return-value", "ScaledXtra"],
  ["M0068", "src/WrappedXtraTwin.PageExt.al", 19, "empty-block", "ScaledXtraTwin"],
  ["M0070", "src/WrappedXtraTwin.PageExt.al", 21, "return-value", "ScaledXtraTwin"],
  ["M0071", "src/WrappedYBand.Report.al", 22, "empty-block", "BandYRun"],
  ["M0072", "src/WrappedYBand.Report.al", 23, "remove-assignment", "BandYRun"],
  ["M0078", "src/WrappedYBand.Report.al", 53, "shift-integer", "BandYRun"],
  ["M0079", "src/WrappedYBand.Report.al", 57, "empty-block", "BandYDirect"],
  ["M0080", "src/WrappedYBand.Report.al", 58, "conditional-boundary", "BandYDirect"],
  ["M0081", "src/WrappedYBand.Report.al", 59, "return-value", "BandYDirect"],
  ["M0082", "src/WrappedYBand.Report.al", 60, "return-value", "BandYDirect"],
  ["M0083", "src/WrappedYBand.Report.al", 64, "empty-block", "BandYRun"],
  ["M0084", "src/WrappedYBand.Report.al", 65, "return-value", "BandYRun"],
  ["M0085", "src/WrappedYBandTwin.Report.al", 22, "empty-block", "BandYRunTwin"],
  ["M0086", "src/WrappedYBandTwin.Report.al", 23, "remove-assignment", "BandYRunTwin"],
  ["M0092", "src/WrappedYBandTwin.Report.al", 53, "shift-integer", "BandYRunTwin"],
  ["M0093", "src/WrappedYBandTwin.Report.al", 57, "empty-block", "BandYDirectTwin"],
  ["M0094", "src/WrappedYBandTwin.Report.al", 58, "conditional-boundary", "BandYDirectTwin"],
  ["M0095", "src/WrappedYBandTwin.Report.al", 59, "return-value", "BandYDirectTwin"],
  ["M0096", "src/WrappedYBandTwin.Report.al", 60, "return-value", "BandYDirectTwin"],
  ["M0097", "src/WrappedYBandTwin.Report.al", 64, "empty-block", "BandYRunTwin"],
  ["M0098", "src/WrappedYBandTwin.Report.al", 65, "return-value", "BandYRunTwin"],
];

/**
 * Leg WR's pre-committed `[v3-codeunit-state-possible]` notes, `<batchIndex>/<code>` sorted (#5611:
 * BandYRun and BandYRunTwin run after BandYDirect and BandYDirectTwin in one codeunit call). They are
 * kills that stay kills; the note changes no verdict. Measured on the pin and the edge build alike.
 * Every other leg, MO included, pre-commits none.
 */
export const V3_WR_STATE_NOTES: readonly string[] = [
  "0/M0071",
  "0/M0072",
  "0/M0078",
  "0/M0085",
  "0/M0086",
  "0/M0092",
];

/** One line when the run's state notes are not exactly `want` (both as `batch/code`); else none. */
export function judgeStateNotes(got: readonly string[], want: readonly string[]): string[] {
  const g = [...got].sort().join(",");
  const w = [...want].sort().join(",");
  return g === w ? [] : [`state notes [${g}], pre-committed [${w}]`];
}

/** R602: MO and WR were measured one-shot only. A named refusal for another transport, else undefined. */
export function moWrTransportRefusal(
  leg: string,
  transport: string | undefined,
): string | undefined {
  return transport === undefined || transport === "one-shot"
    ? undefined
    : `${leg}: al-runner-v3-itest-leg-transport-refused: legs MO and WR were measured on the one-shot transport only (R602), not ${transport}`;
}

/** The fields of a report row the judges read. */
export interface V3RowFacts {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly failureNote?: string;
}

/**
 * One line per killer that is not killed by its test at its site; empty is a pass. A missing
 * mutant, a moved site and a kill by another test each count: the list is the ground truth, so a
 * changed identity is a difference too, never a skip.
 */
export function judgeKillers(rows: readonly V3RowFacts[], killers: readonly V3Killer[]): string[] {
  const byCode = new Map(rows.map((r) => [r.mutantCode, r]));
  const out: string[] = [];
  for (const [code, file, line, op, test] of killers) {
    const r = byCode.get(code);
    if (r === undefined) {
      out.push(
        `${code} (${file}:${line} ${op}) is missing from the run, \`none\` killed it by ${test}`,
      );
      continue;
    }
    const at = `${r.file.replace(/\\/g, "/")}:${r.line} ${r.operatorName}`;
    if (at !== `${file}:${line} lethal.${op}`) {
      out.push(`${code} is at ${at}, the killer list has ${file}:${line} lethal.${op}`);
    } else if (r.verdict !== "killed" || r.killingTest !== test) {
      out.push(
        `${code} (${file}:${line} ${op}) is ${r.verdict}${r.killingTest !== undefined ? ` by ${r.killingTest}` : ""}, \`none\` killed it by ${test}`,
      );
    }
  }
  return out;
}

const WR_ARMS_FILE = "src/WrappedArms.Codeunit.al";

/**
 * Leg WR's by-name refusal: exactly three `WrappedArms` rows, each `no-coverage` with `refusal` as
 * its note, and no other row carrying that note. Empty is a pass.
 */
export function judgeWrArms(rows: readonly V3RowFacts[], refusal: string): string[] {
  const out: string[] = [];
  const arms = rows.filter((r) => r.file.replace(/\\/g, "/") === WR_ARMS_FILE);
  if (arms.length !== 3) out.push(`${arms.length} WrappedArms row(s), pre-committed 3`);
  for (const r of arms) {
    if (r.verdict !== "no-coverage" || r.failureNote !== refusal) {
      out.push(
        `${r.mutantCode} (WrappedArms) is ${r.verdict}, note ${JSON.stringify(r.failureNote)}; pre-committed no-coverage with the refusal`,
      );
    }
  }
  for (const r of rows) {
    if (r.file.replace(/\\/g, "/") !== WR_ARMS_FILE && r.failureNote === refusal) {
      out.push(`${r.mutantCode} (${r.file}) carries the WrappedArms refusal`);
    }
  }
  return out;
}

/**
 * K's `alRunnerV3` section: what a user writes when they rely on the defaults, so NO `coverage`
 * and NO `transport` key (R387/R394's question, asked of v3).
 */
export function legKSection(o: {
  readonly path: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly alcPath: string;
  readonly cacheDir: string;
}): Record<string, string> {
  return {
    path: o.path,
    packagesDir: o.packagesDir,
    bcVersion: o.bcVersion,
    alcPath: o.alcPath,
    cacheDir: o.cacheDir,
  };
}

/** The file whose 4 mutants no test reaches on `sandbox-app` (`ALRUNNER_FIGURES.noCoverageFile`). */
const NO_COVERAGE_FILE = "SandboxPricing.Codeunit.al";

/** What K measured, beside the per-mutant comparison with `bcdev.baseline.json`. */
export interface LegKFacts {
  /** The built backend's `capabilities().coverage`. */
  readonly coverage: string;
  /** `inRunStopIsBudget`: true on one-shot, false on serve-entries (R635). */
  readonly inRunStopIsBudget: boolean | undefined;
  /** Serve daemons the CLI-built backend spawned. */
  readonly serveSpawns: number;
  /** One-shot `test` calls it spawned. */
  readonly oneShotTestCalls: number;
  /** `AL_RUNNER_V3_NOT_AUTHORITATIVE` was printed while the backend was built. */
  readonly warned: boolean;
  /** The file of each `no-coverage` mutant. */
  readonly noCoverageFiles: readonly string[];
}

/** K's pre-committed facts; each that moved is one line. Empty is a pass. */
export function judgeLegK(f: LegKFacts): string[] {
  const out: string[] = [];
  if (f.coverage !== "al-runner")
    out.push(`K: coverage ${JSON.stringify(f.coverage)} by default, pre-committed "al-runner"`);
  // R761 (pre-commitment master a86927e1): the default is serve-entries where proven, and K's
  // sandbox-app is proven (plain names, no MO/WR shapes, no resume), so K serves: one daemon, and
  // one one-shot call (the baseline, which serve-entries keeps one-shot).
  if (f.inRunStopIsBudget !== false)
    out.push("K: the default transport is not serve-entries (inRunStopIsBudget is not false)");
  if (f.serveSpawns !== 1) out.push(`K: ${f.serveSpawns} serve daemon(s) spawned, pre-committed 1`);
  if (f.oneShotTestCalls !== 1)
    out.push(`K: ${f.oneShotTestCalls} one-shot test call(s), pre-committed 1 (the baseline)`);
  if (!f.warned) out.push("K: AL_RUNNER_V3_NOT_AUTHORITATIVE was not printed");
  const off = f.noCoverageFiles.filter((p) => !p.replace(/\\/g, "/").endsWith(NO_COVERAGE_FILE));
  if (f.noCoverageFiles.length !== 4 || off.length > 0)
    out.push(
      `K: ${f.noCoverageFiles.length} no-coverage mutant(s) (${off.length} outside ${NO_COVERAGE_FILE}), pre-committed 4, all in ${NO_COVERAGE_FILE}`,
    );
  return out;
}
