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

/** The legs the itest runs when `LETHAL_ITEST_V3_LEGS` is unset, in run order. */
export function v3DefaultLegs(o: { readonly cdo: boolean; readonly tables: boolean }): string[] {
  return [
    "C",
    "S1",
    "S3",
    "N1",
    "X",
    "L1",
    "Y-A",
    "Y-B",
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
 */
export function v3ItestFailures(
  legs: Readonly<Record<string, string>>,
  candidate: boolean,
  selected: readonly string[],
): string[] {
  const out: string[] = [];
  for (const leg of selected) if (!(leg in legs)) out.push(`${leg}=missing`);
  for (const [leg, v] of Object.entries(legs)) {
    if (candidate && leg === V3_K_LEG && v === V3_K_CANDIDATE_SKIP) continue;
    if (v !== "pass") out.push(`${leg}=${v}`);
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
  if (f.inRunStopIsBudget !== true)
    out.push("K: the default transport is not one-shot (inRunStopIsBudget is not true)");
  if (f.serveSpawns !== 0) out.push(`K: ${f.serveSpawns} serve daemon(s) spawned, pre-committed 0`);
  if (f.oneShotTestCalls < 1) out.push("K: no one-shot test call was spawned");
  if (!f.warned) out.push("K: AL_RUNNER_V3_NOT_AUTHORITATIVE was not printed");
  const off = f.noCoverageFiles.filter((p) => !p.replace(/\\/g, "/").endsWith(NO_COVERAGE_FILE));
  if (f.noCoverageFiles.length !== 4 || off.length > 0)
    out.push(
      `K: ${f.noCoverageFiles.length} no-coverage mutant(s) (${off.length} outside ${NO_COVERAGE_FILE}), pre-committed 4, all in ${NO_COVERAGE_FILE}`,
    );
  return out;
}
