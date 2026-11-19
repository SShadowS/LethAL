/**
 * PR-209 round 2: the figures that only a record run can fill in. Every one of them is marked
 * with this sentinel (or listed in `PR209_PENDING`) so that a gate which meets one FAILS by name
 * instead of comparing a run against a guess. Delete the entry (and the sentinel) in the same
 * commit that records the real figure.
 */
export const PR209_UNRECORDED = "PR-209: verdict to be recorded" as const;

/** Per gate: the pinned figures that are still the OLD set's value and are to be recorded. */
export const PR209_PENDING: Readonly<Record<string, readonly string[]>> = {
  bcdev: ["BCDEV_FIGURES.killed/survived/noCoverage/groupedCalls (26 sites now)"],
  tables: [
    "TABLES_FIGURES.killed/survived/noCoverage (472 sites now)",
    "TABLES_FIGURES.groupedCalls",
    "TABLES_FIGURES.warmKills",
    "TABLES_FIGURES.platformArtifactKills",
  ],
  chunked: [
    "CHUNKED_FIGURES.control.positions",
    "CHUNKED_FIGURES.control.warmKills",
    "CHUNKED_FIGURES.control.groupedCalls",
    "CHUNKED_FIGURES.chunked.warmKills",
    "CHUNKED_FIGURES.chunked.groupedCalls",
  ],
  hang: [
    "HANG_FIGURES.warmKills",
    "HANG_FIGURES.coldConfirmsOn",
    "HANG_FIGURES.coldConfirmsSingle",
    "HANG_FIGURES.stoppedCallsOn",
  ],
  "al-runner-v3": [
    "DBM_FIGURES.killed/survived/noCoverage (126 sites now)",
    "the added rows of EXPECTED_LAYOUT (1/M0002) and the v3 legs' baselines (MO, WR, T, D1, S1...)",
  ],
  lend: ["LEND_MUTANTS' 4 added rows (M0005, M0014, M0016, M0022) and LEND_FIGURES' counts"],
  "bcdev-wrapped": ["EXPECTED_WRAPPED_BC / EXPECTED_WRAPPED: 14 added condition-true rows"],
  harden: ["harden's 2 added condition-true rows (verdicts)"],
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
