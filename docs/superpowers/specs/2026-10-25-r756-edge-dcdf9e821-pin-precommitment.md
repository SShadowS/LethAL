# R756 pre-commitment: pin edge-dcdf9e821 with alpha.5's readings, then re-gate it

Coord task R-756, lane lethal-code, branch `lethal/r756`. Committed to master BEFORE the pin lands and before any
re-gate. Evidence: `/coord/handoff/R-756/` (`upd-edge.log`, `edge-gate.log`, `edge-receipt.json`, `plan.md`).

## The build
`al-runner 3.0.0-alpha.5+edge.20261024 (dcdf9e821)`, sha256
`0e3139359b37a7dd9c51377b64c0ae1acdcb208545f79075e4194571bbe03890`, HELD by the daily `--edge` gate on 2026-10-25
at `.gated`'s lethalCommit 82a73bd1.

## What it measured (identical to alpha.5's pinned readings)
Its gate log, against alpha.5's re-gate log at the same commit with timings and temp paths masked, differs only in
the version line, these held entries, and K (skipped on a candidate build, by design). Every other leg and every
other leg-C fact reads the same.
- Leg C, `defect-present -> gone`, each as BC: `none-selected-exit` (exit 6, stdout 0 rows), `quoted-name-unselectable`
  (exit 0), `refusal-cascade` (a plain Error() test fails with its own text, #5610), `sleep-is-noop` (verdict class
  only; the no-flag wall under 1000 ms), `upstream-compile-errors` (exit 3 null, #5602), `refusal-row-shape` (BC's hub
  text, #5700, R706/R712).
- Leg C, `duplicate-key-insert-raises`: `defect-present -> refused`. v3 declines by name; BC fails the test at its end
  (r639, bc1). A lost kill, never a wrong verdict (#5788, already filed). Its full measured text is the session
  warning line's; leg C's own line is cut at 300 characters.
- X (b): exit 3, passed 0, notRun 0 (v3 refuses an app that does not compile; BC never runs one; #5602).
- T: the 7 rows `Data Flag Ops.InsertTwiceWithKeyTrigger` (remove-assignment, toggle-blank-string, swap-modify-flag)
  and `Data Key Probe.OnInsert` (empty-block, negate-conditional, toggle-blank-string, remove-assignment) go
  `survived -> error/runner-refused`, killingTest null (#5788); counts 290 / 50 / 59, errors 7, over 406.
- No move away from BC; nothing unexplained; nothing new to file upstream.

## The pin
`edge-dcdf9e821` in `packages/runner/src/al-runner-v3-pins.ts`, keyed by the exact version line above and the
sha256, sharing alpha.5's leg C / T / X (b) readings (one constant; a later delta must split them first). alpha.5's
pin is unchanged in content (S5). No default table and no baseline is edited.

## The re-gate (the orchestrator times it: no other v3 job, no process under `/work/tools/al-runner-v3`)
1. `bun scripts/al-runner-v3-update.ts --regate <commit with the pin>`: alpha.5 (current) at that commit, its own
   pin applying. Predicted `pass`, every `V3_GATE_LEGS` leg pass and K pass (3 / 12 / 4 over 19, 0 differences);
   `.gated` takes the commit.
2. `bun scripts/al-runner-v3-update.ts --edge-rejudge dcdf9e821`. Predicted receipt: `PIN edge-dcdf9e821 applies`;
   the seven `C: pinned:` lines (six `gone`, five `(as BC)`, refusal-row-shape `(#5700)`, duplicate-key `refused
   (#5788)`); X (b) pinned; `T: pinned 7 rows (pin edge-dcdf9e821, #5788)`; T 290 / 50 / 59 errors 7 over 406;
   K `skipped (candidate build)`; every other leg as alpha.5's; outcome `pass`. Then `current` moves to
   `/work/tools/al-runner-v3/edge-dcdf9e821-dcdf9e821/` and `.gated` names this build with `rejudgedFrom`
   `.../held/edge-dcdf9e821` (unless a v3 process is running: "deferred: in use", which strands the build until a new
   `--regate` plus rejudge).
3. Right after `current` moves (orchestrator's condition): `itest:alrunner-v3` once on the new current, K included.
   Predicted: every leg pass, K 3 / 12 / 4 over 19 with 0 differences against `bcdev.baseline.json`, the pin applying.
   A K failure there is a BLOCK: stop, report, file it; `current` never moves backwards (R723).
