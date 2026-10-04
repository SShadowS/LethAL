/**
 * R-425: the gates' one assertion on the reach-filter fields of a verify JSON (`reachFilter` and
 * `results[].reachNarrowed`), against `docs/superpowers/specs/2026-10-04-r425-reach-fields-
 * precommitment.md`. It reads through `verify-read.ts`, so a missing field fails as "unknown" and
 * never passes as "off", and a v4 document fails however its fields look. Additions only: no R-384
 * pin goes through here.
 */
import assert from "node:assert/strict";
import type { VerifyOutput } from "../src/verify";
import { droppedNewTestsOf, reachFilterOf, reachNarrowingOf } from "../src/verify-read";

/** One row's predicted field: not narrowed, narrowed with this SET of dropped new tests, or no
 *  `reachNarrowed` at all (the filter never decided for it). */
export type ReachRowExpectation =
  | { readonly narrowed: false }
  | { readonly narrowed: true; readonly dropped: readonly string[] }
  | "absent";

export interface ReachFieldsExpectation {
  /** `"absent"`: verify refused before deciding, so the reader must say unknown, `not-decided`. */
  readonly filter:
    | "absent"
    | { readonly state: "on" }
    | { readonly state: "off"; readonly reason: string };
  /** By result id; must name exactly the output's rows. */
  readonly rows: Readonly<Record<string, ReachRowExpectation>>;
}

export function assertReachFields(
  step: string,
  out: VerifyOutput,
  expected: ReachFieldsExpectation,
): void {
  const reading = reachFilterOf(out);
  if (expected.filter === "absent") {
    assert.equal(
      "reachFilter" in out,
      false,
      `${step}: reachFilter absent (refused before deciding)`,
    );
    assert.deepEqual(
      reading,
      { state: "unknown", why: "not-decided" },
      `${step}: reachFilter reads not-decided (${JSON.stringify(reading)})`,
    );
  } else {
    assert.deepEqual(
      reading,
      expected.filter,
      `${step}: reachFilter (${JSON.stringify(out.reachFilter)}, read as ${JSON.stringify(reading)})`,
    );
  }

  assert.deepEqual(
    out.results.map((r) => r.id).sort(),
    Object.keys(expected.rows).sort(),
    `${step}: the rows the reach-field expectation names`,
  );
  for (const row of out.results) {
    const want = expected.rows[row.id];
    assert.ok(want !== undefined, `${step}: no expectation for ${row.id}`);
    if (want === "absent") {
      assert.equal("reachNarrowed" in row, false, `${step}: ${row.id} carries no reachNarrowed`);
      continue;
    }
    assert.equal(
      row.reachNarrowed,
      want.narrowed,
      `${step}: ${row.id} reachNarrowed (${JSON.stringify(row.reachNarrowed)})`,
    );
    assert.equal(
      reachNarrowingOf(out, row),
      want.narrowed ? "narrowed" : "not-narrowed",
      `${step}: ${row.id} reads ${want.narrowed ? "narrowed" : "not-narrowed"}`,
    );
    const dropped = droppedNewTestsOf(out, row);
    if (!want.narrowed) {
      assert.equal(dropped, undefined, `${step}: ${row.id} has no dropped list`);
      continue;
    }
    assert.ok(dropped !== undefined, `${step}: ${row.id} has a dropped list`);
    assert.deepEqual(
      [...dropped].sort(),
      [...want.dropped].sort(),
      `${step}: ${row.id} dropped new tests (${dropped.join(", ")})`,
    );
  }
}
