# R1000 pre-commitment (coord R-989): the reworded cascade text, and a gate check for keep-list texts

Committed before any gate run, 2026-11-14. Evidence: `/coord/handoff/R-989/`. Invented AL only.

## What changes

1. **`V3_SERVE_SAFE_REFUSALS["cascade-existing-state"]`** accepts, besides the combined text of edge-736fc7677 and
   earlier, edge-847b1fa5a's two per-kind texts: `changed number sequence '<name>' ... (only a new NumberSequence.Insert
   is)` and `changed isolated storage key '<key>' ... (only a new key's IsolatedStorage.Set is)`, each anchored with its
   own tail. Basis: R-955's kept-daemon method re-run on 847b1fa5a for each kind (`/coord/handoff/R-989/restart/`):
   20 refusals on one kept daemon, 27 readers equal to the control, 20 fresh daemons one answer equal to it, the pid
   unchanged, no panic text: CLEAN.
2. **Leg C's `serve-keep-reasons`** (still a warn fact; leg C keeps 28 facts: 9 defect, 18 contract, 1 warn) runs three
   more invented codeunits in its one serve request: `cascade-existing-state` by sequence (50675) and by key (50676), and
   `company-findset` (50677); each may also come back as a plain pass. A row the runtime REFUSED with a text that no
   keep-list entry accepts reads the new verdict **`unkept`**, which `classifyLegC` makes **gate-fail**. Every other
   move (a plain fail or pass where a refusal was expected, no row) still only warns, as R612 decided. Reason: at a serve
   warm-up an unkept refusal sends the whole run to one-shot (R786); R-984's DO window then scored 35 covered mutants in
   an hour.

## Predictions

- On `current` (edge-847b1fa5a), `itest:alrunner-v3` passes every leg as before; leg C's `serve-keep-reasons` reads
  `matches`, its `measured` naming `cascade-existing-state: refusal` twice and `company-findset: refusal` (847b1fa5a
  refuses all three with the texts measured in `/coord/handoff/R-989/probe*.json` and `company-*.json`). No pinned
  figure, verdict or leg outcome moves.
- With the old keep-list entry (before change 1), the same leg C would read `unkept` on 847b1fa5a and gate-fail: the
  check this adds would have stopped edge-847b1fa5a at the update gate.
- DO's serve warm-up on 847b1fa5a (R-984's config, a short window) no longer falls back to one-shot.
