# R-635 pre-commitment, addendum 5: the final head after R-647

Committed by lethal-code on 2026-10-22, before any run it names. It amends addendum 4 (82013b0e). Everything not
restated stands.

## Why
- **Master moved past addendum 4's head (9c78ca0c).** R-647 merged; it changed `al-runner-v3.itest.ts`,
  `al-runner-v3-gate.ts`, the r586-gate tests, and one export in `orchestrator.ts` (`BASELINE_TIMEOUT_DEFAULT`).
  All seven v3 legs run through that itest.
- **lethal/r635 merged master 77877316 as c913385a.** The only conflict was the generated ROADMAP.md.
  - Both behaviours are kept in the itest and the gate module: R-647's `judgeLegT`, `xbHeldFirst` and leg X (d) lines,
    and R-635's transport and second-echo flags, report and control dirs, and counters.
  - verify: FULL PASS, 9945 / 0.
- **Part A on 9c78ca0c was stopped at a leg boundary.** E0-S and E1 had passed, with 0 differences. They are history
  only.

## The amendment
- **Part A, all seven v3 legs, runs on lethal/r635 at c913385a,** into `/coord/handoff/R-635/live/run5/`, with
  addenda 2 to 4's figures and STOP rules unchanged.
  - R-647's leg T now judges through `judgeLegT`. Each figure is read from that leg's own output, and any leg-T
    assertion that fails on a row where its control fails the same way is an edge-binary difference, as before.
- **Parts B, C and D (itest:alrunner, itest:bcdev, itest:tables) stand on 9c78ca0c:**
  - between 9c78ca0c and c913385a, nothing on the v2, bcdev or tables path changed except the
    `BASELINE_TIMEOUT_DEFAULT` export, which is a visibility change only;
  - the orchestrator ruled that this delta does not affect them.
