/**
 * The I/O half of the rung-1 anchor gate: read a report and a pre-committed anchor config off
 * disk, run the cardinality assertion and then the anchors, and say — per anchor, including the
 * ones that passed — what happened.
 *
 * It exists because `campaign-anchors.ts` had no caller. Freeze got a driver
 * (`scripts/campaign/freeze.ts`), compile-only got a driver, and the anchors — "the entire
 * regression payload of rung 1" — got none, which left plan Task 6 step 4 with an operator running
 * them ad hoc against a live billed environment. That is where "I printed the results and they
 * looked fine" replaces a gate.
 *
 * The pure predicates stay in `campaign-anchors.ts` (no I/O, no clock, unit-testable). This module
 * owns the parts that touch the filesystem.
 *
 * Its caller is `runCampaignAnchors` (`campaign-subcommands.ts`), reached as
 * `lethal campaign anchors`. It used to be `scripts/campaign/anchors.ts`, a thin CLI over this
 * module; that script was DELETED when the subcommand landed, because a driver that reaches this
 * gate without the manifest — and so without the "records committed before the run" check — is a
 * second entry point routing around the check, which is the one thing this gate exists to stop.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AnchorConfig,
  type ProcedureRange,
  assertCardinality,
  checkAnchors,
  reconcileNotInstrumented,
} from "./campaign-anchors";
import type { SessionReport } from "./report";

/**
 * The on-disk anchor config, committed BEFORE the run it gates (plan Task 6 step 1).
 *
 * Every field is required and none has a default. In particular `expectedMutantCount` must not be
 * derivable from the report being checked: a count that defaulted to `report.mutants.length` would
 * make the cardinality assertion compare a report against itself and pass on every report ever
 * produced, including an empty one.
 */
export interface AnchorFileConfig extends AnchorConfig {
  readonly expectedMutantCount: number;
  /**
   * Rung 2 only (plan Task 7 step 3). When true, `--project` is REQUIRED and the reconciliation
   * runs as a gate item; when false the driver prints that it was not requested. A check that can
   * silently not run is not a gate, so this is pre-committed in the config rather than implied by
   * whether a flag happened to be passed.
   */
  readonly reconcileNotInstrumented: boolean;
}

function fail(configPath: string, what: string): never {
  throw new Error(
    `anchors: ${configPath} is not a valid anchor config — ${what}. Refusing to substitute a default: an anchor gate is only as good as the pre-commitment it reads.`,
  );
}

function parseRange(raw: unknown, configPath: string, i: number): ProcedureRange {
  if (typeof raw !== "object" || raw === null) {
    fail(configPath, `coveredProcedureRanges[${i}] is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const { name, startLine, endLine } = r;
  if (typeof name !== "string" || name === "") {
    fail(configPath, `coveredProcedureRanges[${i}].name must be a non-empty string`);
  }
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    fail(configPath, `coveredProcedureRanges[${i}].startLine/endLine must be numbers`);
  }
  if (endLine < startLine) {
    fail(
      configPath,
      `coveredProcedureRanges[${i}] ends (${endLine}) before it starts (${startLine})`,
    );
  }
  return { name, startLine, endLine };
}

export function parseAnchorConfig(raw: unknown, configPath: string): AnchorFileConfig {
  if (typeof raw !== "object" || raw === null) fail(configPath, "not a JSON object");
  const c = raw as Record<string, unknown>;
  const { expectedMutantCount, expectedBaselineTests, coveredProcedureRanges } = c;
  if (typeof expectedMutantCount !== "number" || !Number.isInteger(expectedMutantCount)) {
    fail(configPath, "expectedMutantCount must be an integer (the pre-committed mutant count)");
  }
  if (typeof expectedBaselineTests !== "number" || !Number.isInteger(expectedBaselineTests)) {
    fail(configPath, "expectedBaselineTests must be an integer");
  }
  if (!Array.isArray(coveredProcedureRanges)) {
    fail(configPath, "coveredProcedureRanges must be an array");
  }
  if (coveredProcedureRanges.length === 0) {
    fail(
      configPath,
      "coveredProcedureRanges is empty — anchor 2 would then fail every covered mutant, or (worse) be read as 'no constraint'",
    );
  }
  const reconcile = c.reconcileNotInstrumented;
  if (typeof reconcile !== "boolean") {
    fail(configPath, "reconcileNotInstrumented must be true or false, stated explicitly");
  }
  return {
    expectedMutantCount,
    expectedBaselineTests,
    coveredProcedureRanges: coveredProcedureRanges.map((r, i) => parseRange(r, configPath, i)),
    reconcileNotInstrumented: reconcile,
  };
}

export interface AnchorRunArgs {
  readonly reportPath: string;
  readonly configPath: string;
  /** Required when the config sets `reconcileNotInstrumented`; ignored otherwise. */
  readonly projectDir?: string;
  /**
   * Called as each phase of the gate STARTS, in order: `"cardinality"`, `"anchors"`, then
   * `"reconcile"` or `"reconcile-skipped"`. Exists so the ORDERING is checkable from outside
   * rather than only readable in this file — cardinality must precede every anchor, because an
   * empty or truncated report satisfies "for all mutants ..." vacuously (see `assertCardinality`).
   * The type system already enforces it (`checkAnchors` takes a `CardinalityVerifiedReport`, which
   * only `assertCardinality` produces), and this makes the same ordering fail a TEST rather than
   * only a compile — including for a caller who reaches these functions from plain JS.
   */
  readonly onStep?: (step: string) => void;
}

export interface AnchorRunOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

// `parseAnchorArgs` lived here and hand-rolled `--report`/`--config`/`--project` for the deleted
// `scripts/campaign/anchors.ts`. It went with the script: `lethal campaign anchors` parses those
// through `parseCliConfig` (cli.ts) like every other subcommand, and DERIVES `configPath` from the
// manifest's records directory plus `--rung` rather than taking it as a free-form flag — which is
// what makes the file the gate reads and the file the gate checks provably the same file.

/**
 * Runs the gate. Throws on anything that means the gate could not be evaluated at all (unreadable
 * report, invalid config, cardinality mismatch, a reconciliation asked for without `--project`);
 * returns `ok: false` when the gate ran and an anchor failed. The caller turns `ok` into an exit
 * code — both outcomes are non-zero, and the distinction is only about whether there is a per-
 * anchor result table to print.
 */
export async function runAnchorCheck(args: AnchorRunArgs): Promise<AnchorRunOutcome> {
  const report = JSON.parse(await readFile(args.reportPath, "utf8")) as SessionReport;
  const cfg = parseAnchorConfig(
    JSON.parse(await readFile(args.configPath, "utf8")),
    args.configPath,
  );
  const lines: string[] = [
    `[anchors] report: ${args.reportPath}`,
    `[anchors] config: ${args.configPath}`,
  ];

  // Throws on a mismatch — and is the ONLY way to obtain the token `checkAnchors` requires.
  args.onStep?.("cardinality");
  const verified = assertCardinality(report, cfg.expectedMutantCount, "anchors");
  lines.push(`[anchors] cardinality: ${cfg.expectedMutantCount} mutants, as pre-committed`);

  args.onStep?.("anchors");
  const results = checkAnchors(verified, cfg);
  let ok = true;
  for (const r of results) {
    if (!r.passed) ok = false;
    lines.push(`[anchors] ${r.passed ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);
  }

  if (cfg.reconcileNotInstrumented) {
    args.onStep?.("reconcile");
    const { projectDir } = args;
    if (projectDir === undefined) {
      throw new Error(
        `anchors: ${args.configPath} sets reconcileNotInstrumented, which needs --project <dir> to read the sources of the files the report lists. Refusing to skip a requested gate item.`,
      );
    }
    const sources = await Promise.all(
      report.notInstrumented.files.map(async (f) => ({
        path: f.file,
        source: await readFile(join(projectDir, f.file), "utf8"),
      })),
    );
    const rec = reconcileNotInstrumented(report, sources);
    if (!rec.passed) ok = false;
    lines.push(
      `[anchors] ${rec.passed ? "PASS" : "FAIL"} notinstrumented-reconciliation — ${rec.detail}`,
    );
  } else {
    args.onStep?.("reconcile-skipped");
    lines.push(
      "[anchors] SKIP notinstrumented-reconciliation — reconcileNotInstrumented: false in the config (rung-2 gate item; plan Task 7 step 3)",
    );
  }

  // Anchor 3 is not derivable from the report: M0013's branch depends on whether gate-0 item 6
  // confirmed the hosted hang-stop. Named here so a clean run of this driver is never mistaken for
  // "all four anchors held".
  lines.push(
    "[anchors] NOTE anchor 3 (M0013's branch) is NOT checked here — it is not derivable from the report. Assert it against the gate-0 probe result, per plan Task 6 step 1.",
  );
  lines.push(
    `[anchors] RESULT: ${ok ? "all checked anchors passed" : "AT LEAST ONE ANCHOR FAILED"}`,
  );
  return { ok, lines };
}
