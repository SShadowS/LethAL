/**
 * PR-209 round 2: the figures that only a record run can fill in. Every one of them is marked
 * with this sentinel (or listed in `PR209_PENDING`) so that a gate which meets one FAILS by name
 * instead of comparing a run against a guess. Delete the entry (and the sentinel) in the same
 * commit that records the real figure.
 */
export const PR209_UNRECORDED = "PR-209: verdict to be recorded" as const;

/** Per gate: the pinned figures that are still the OLD set's value and are to be recorded. */
export const PR209_PENDING: Readonly<Record<string, readonly string[]>> = {
  // tables and hang: RECORDED on bc2 (every figure assertion passed before the record wrote the baseline).
  "al-runner-v3": [
    "the WR and T baselines (R849 expected files) and leg T's hand-pin counts; O1 and D1 re-run with the CDO path",
  ],
};

/**
 * Called first by a gate that has pending figures. It throws, unless the run is a record run
 * (`LETHAL_ITEST_RECORD_BASELINE` set) or an observe run (`LETHAL_PR209_OBSERVE=1`), which exist
 * to read those figures off the live result.
 */
export function refuseIfPr209Pending(gate: string): void {
  const pending = PR209_PENDING[gate] ?? [];
  if (pending.length === 0) return;
  if (process.env.LETHAL_ITEST_RECORD_BASELINE || process.env.LETHAL_PR209_OBSERVE === "1") return;
  throw new Error(
    `${PR209_UNRECORDED}: ${gate} has ${pending.length} figure(s) PR-209 moved and a record run has not filled in: ${pending.join("; ")}. Run it in record or observe mode (LETHAL_PR209_OBSERVE=1), then pin the figures.`,
  );
}
