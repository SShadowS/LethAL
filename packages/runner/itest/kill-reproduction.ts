/**
 * R577: the gate's check that "a kill must reproduce" RAN on an al-runner leg, and the one table of
 * exact figures it is held to.
 *
 * The verdicts cannot show it: a kill that reproduces is `killed` with or without the rule. So each
 * leg checks, from its own report and store:
 * - every `killed`/`timeout-killed` mutant carries `killReproduced: true` (the marker is written only
 *   by the reproduction, never wired from the first run or the confirm);
 * - no mutant is `kill-not-reproduced` (on these fixtures every kill is deterministic, so one would
 *   be a regression, a BLOCK);
 * - the exact mutated `test_results` rows for the killing test, per kill (I2: the kill plus its
 *   reproduction), which a marker wired without a reproduction run would not produce.
 * The cli-default leg also checks its `activate()` calls and the `runTests` requests written to the
 * daemon, the two figures the reproduction moves there.
 *
 * `REPRODUCTION_EXPECTED` is that table. A `null` figure is NOT YET MEASURED: the leg prints what it
 * measured and the gate fails at the end (`unmeasuredReproductionFigures`), so one run can measure
 * every leg and still never pass on a blank. Fill each figure from a measured run, pre-committed.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186), so the checks
 * can be unit-tested offline (`packages/runner/tests/itest-kill-reproduction.test.ts`).
 */
import type { SessionReport } from "../src/report";
import type { ResultsStore } from "../src/store";

export interface ReproductionFigures {
  /** Mutated `test_results` rows for the killing test, for EVERY killed mutant of the leg. */
  readonly killerRowsPerKill: number | null;
  /** cli-default only: the `activate()` calls the resource watcher saw. */
  readonly activations?: number | null;
  /** cli-default only: the `runTests` requests written to the daemon(s). */
  readonly serverSuiteRuns?: number | null;
}

/**
 * Leg names: `<fixture>/<transport>`, and `cli-default`. MEASURED at 102821df (itest:alrunner,
 * log /coord/handoff/R-577/scratch/itest-measure.log): every kill on every leg reproduced, none was
 * kill-not-reproduced. Killer rows are 2 per kill everywhere (the kill and its reproduction);
 * cli-default made 23 activations and 22 `runTests` requests.
 */
export const REPRODUCTION_EXPECTED: Readonly<Record<string, ReproductionFigures>> = {
  "sandbox/one-shot": { killerRowsPerKill: 2 },
  "sandbox/server": { killerRowsPerKill: 2 },
  "sandbox/resource": { killerRowsPerKill: 2 },
  "layout/one-shot": { killerRowsPerKill: 2 },
  "layout/server": { killerRowsPerKill: 2 },
  "multiobject/one-shot": { killerRowsPerKill: 2 },
  "multiobject/server": { killerRowsPerKill: 2 },
  "multiobject/resource": { killerRowsPerKill: 2 },
  "wrapped/one-shot": { killerRowsPerKill: 2 },
  "wrapped/server": { killerRowsPerKill: 2 },
  "wrapped/resource": { killerRowsPerKill: 2 },
  "symbols-LETHALA/one-shot": { killerRowsPerKill: 2 },
  "symbols-LETHALA/server": { killerRowsPerKill: 2 },
  "symbols-LETHALA/resource": { killerRowsPerKill: 2 },
  "symbols-LETHALB/one-shot": { killerRowsPerKill: 2 },
  "symbols-LETHALB/server": { killerRowsPerKill: 2 },
  "symbols-LETHALB/resource": { killerRowsPerKill: 2 },
  "cli-default": { killerRowsPerKill: 2, activations: 23, serverSuiteRuns: 22 },
};

/** Every figure a run measured against a `null` in the table, for the end-of-gate failure. */
const unmeasured: string[] = [];

/** The figures still `null` that this process measured, as `<leg> <figure>=<measured>`. */
export function unmeasuredReproductionFigures(): readonly string[] {
  return unmeasured;
}

/** Per killed mutant (`<batch>/<code>`), its killing test's mutated rows in `store`. */
export function killerRows(store: ResultsStore): Map<string, number> {
  const rows = store.db
    .query(
      `SELECT m.batch_index AS batch, m.mutant_code AS code,
         (SELECT COUNT(*) FROM test_results t
            WHERE t.mutant_row_id = m.id AND t.mutant_code IS NOT NULL
              AND t.method = m.killing_test) AS n
       FROM mutants m WHERE m.verdict IN ('killed', 'timeout-killed')`,
    )
    .all() as Array<{ batch: number | null; code: string; n: number }>;
  return new Map(rows.map((r) => [`${r.batch ?? 0}/${r.code}`, r.n]));
}

/**
 * The leg's failures, `[]` when it holds. `extra` carries the cli-default leg's two mechanism
 * figures; any other leg passes none.
 */
export function killReproductionFailures(
  leg: string,
  report: SessionReport,
  store: ResultsStore,
  extra: { readonly activations?: number; readonly serverSuiteRuns?: number } = {},
  /** Only a unit test passes another table. */
  table: Readonly<Record<string, ReproductionFigures>> = REPRODUCTION_EXPECTED,
): string[] {
  const expected = table[leg];
  if (expected === undefined) {
    throw new Error(
      `R577: leg "${leg}" has no row in REPRODUCTION_EXPECTED — caller-contract violation`,
    );
  }
  const out: string[] = [];
  const kills = report.mutants.filter(
    (m) => m.verdict === "killed" || m.verdict === "timeout-killed",
  );
  for (const m of kills) {
    if (m.killReproduced !== true) {
      out.push(
        `R577 ${leg}: ${m.batchIndex}/${m.mutantCode} is ${m.verdict} without killReproduced, so the reproduction did not run (or its marker was lost)`,
      );
    }
  }
  for (const m of report.mutants) {
    if (m.cause === "kill-not-reproduced") {
      out.push(
        `R577 ${leg}: ${m.batchIndex}/${m.mutantCode} is kill-not-reproduced on a fixture whose kills are deterministic: ${m.failureNote ?? ""}`,
      );
    }
  }
  const rows = killerRows(store);
  if (rows.size !== kills.length) {
    out.push(`R577 ${leg}: the store holds ${rows.size} kill row(s), the report ${kills.length}`);
  }
  const measuredRows = [...rows.values()];
  console.log(
    `  R577 ${leg}: ${kills.length} kill(s), killer rows per kill [${[...rows].map(([k, n]) => `${k}=${n}`).join(", ")}]${
      extra.activations !== undefined ? `, activations ${extra.activations}` : ""
    }${extra.serverSuiteRuns !== undefined ? `, runTests requests ${extra.serverSuiteRuns}` : ""}`,
  );
  const figure = (name: string, want: number | null | undefined, got: readonly number[]) => {
    if (want === undefined) return;
    if (want === null) {
      unmeasured.push(`${leg} ${name}=${got.join("/")}`);
      return;
    }
    const wrong = got.filter((n) => n !== want);
    if (wrong.length > 0 || got.length === 0) {
      out.push(`R577 ${leg}: ${name} expected ${want}, measured ${got.join(", ") || "nothing"}`);
    }
  };
  figure("killerRowsPerKill", expected.killerRowsPerKill, measuredRows);
  if (expected.activations !== undefined) {
    figure(
      "activations",
      expected.activations,
      extra.activations !== undefined ? [extra.activations] : [],
    );
  }
  if (expected.serverSuiteRuns !== undefined) {
    figure(
      "serverSuiteRuns",
      expected.serverSuiteRuns,
      extra.serverSuiteRuns !== undefined ? [extra.serverSuiteRuns] : [],
    );
  }
  return out;
}
