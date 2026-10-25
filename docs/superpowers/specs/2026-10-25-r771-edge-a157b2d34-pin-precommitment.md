# R771 pre-commitment: pin edge-a157b2d34 (alpha.5's readings plus N1E), then re-gate it

Coord task R-771, branch `lethal/r771`. Committed to master BEFORE the pin lands and before any re-gate. Evidence:
`/work/tools/al-runner-v3/held/edge-a157b2d34/receipt.json`, `/coord/handoff/al-runner-v3-update/2026-10-25-b.log`,
`/coord/handoff/R-771/` (`regate.out`, `edge.out`).

## The build
`al-runner 3.0.0-alpha.5+edge.20261025 (a157b2d34)`, sha256
`d9429e53a6938dbafb58108f61ce5408f65389bd9604ff94b4788ef26c8d17fb`, HELD by the update gate at LethAL 55a1466b.

## What it measured
- Leg C, X (b) and T: IDENTICAL to `edge-dcdf9e821` (R756) and alpha.5's pin, including `sleep-is-noop` = `gone`:
  six facts `gone` (each as BC), `duplicate-key-insert-raises` `refused` (#5788), X (b) exit 3 / 0 / 0 (#5602), T the
  same seven keys `survived -> error/runner-refused`, 290 / 50 / 59 over 406.
- N1E, the only new held leg: #5798 is fixed upstream. The refused serve line now has `codeunit` and `method`:
  `{"codeunit":78850,"codeunitName":"Names Tests","durationMs":0,"entry":"NONE|78850","method":"Dot.Step","name":"Codeunit78850.Dot.Step","status":"pass","type":"test"}`.
  LethAL's `serveRow` parses the method from the name with `/^Codeunit(\d+)\.([^.]+)$/` and still refuses a dotted
  method, so the session fails closed by name. Safe: no row is scored.
- No move away from BC; nothing unexplained; nothing new owed upstream.

## The pin
`edge-a157b2d34` in `packages/runner/src/al-runner-v3-pins.ts`, keyed by the exact version line and sha256, spreading
`ALPHA5_READINGS`, plus the optional `n1e` field (`refusedLine` anchored to exactly the line above, `durationMs` any
number). `judgeN1Serve` passes only when the refused line has `codeunit`/`method` AND matches the pin's `n1e`; a
completed session, a non-matching line and an unpinned build read as before. The other two pins are unchanged (S5).

## The re-gate (the orchestrator times it: no other v3 job, no process under `/work/tools/al-runner-v3`)
1. `bun scripts/al-runner-v3-update.ts --regate <commit with the pin>`: the current build at that commit.
   Predicted `pass`, every `V3_GATE_LEGS` leg pass and K pass; `.gated` takes the commit.
2. `bun scripts/al-runner-v3-update.ts --edge-rejudge a157b2d34`. Predicted: `PIN edge-a157b2d34 applies`; the seven
   `C: pinned:` lines; X (b) pinned; `T: pinned 7 rows (pin edge-a157b2d34, #5788)`; N1E `pinned: #5798 fixed upstream`
   (pass); K `skipped (candidate build)`; every other leg as before; outcome `pass`. Then `current` moves to the edge
   build and `.gated` names it (unless a v3 process runs: "deferred: in use").
3. Right after `current` moves: `itest:alrunner-v3` once on the new current, K included. Predicted: every leg pass, K
   3 / 12 / 4 over 19 with 0 differences against `bcdev.baseline.json`, the pin applying. A K failure is a BLOCK: stop,
   report, file it; `current` never moves backwards (R723).
