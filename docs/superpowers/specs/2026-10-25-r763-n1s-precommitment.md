# R-763 pre-commitment (2026-10-25): leg N1S, serve-entries for N1's non-dot method names

Committed before the gate run that proves R-763. Fast track (owner ruling 2026-10-25): one observe run measured the
figures, and this file freezes them. Code: lethal/r763 from master cc9c0105. Binary: the pinned `current`, al-runner
3.0.0-alpha.5+edge.20261024 (dcdf9e821). Receipt: `/coord/handoff/R-763/observe-N1S.log`.

## Leg N1S (joins `V3_GATE_LEGS` and the default legs)
- **What it runs:** `fixtures/sandbox-names-tests`, copied at runtime with the `Dot.Step` test removed (exactly one
  `[Test]` cut; the leg fails closed otherwise), against `fixtures/sandbox-names`. It runs twice: explicit one-shot,
  then explicit serve-entries.
- **Pinned:**
  - both sessions **33 / 0 / 3** over 36 (the 3 no-coverage mutants were covered only by `Dot.Step`);
  - **0 per-mutant differences**, serve against one-shot (text verified 36);
  - serve baseline green, no refused test;
  - serve counters: pairRequests **33**, liveRequests **33**, boundChecks **35**, warmups **1**, entriesSent
    **200**, echoMismatches **0**;
  - `GATE_WARNINGS["al-runner-v3/N1S"]` = `[]`.
- **On a build with no serve-entries path** (alpha.2): "not applicable", as N1E and S1E.

## The widening this proves
`V3_SERVE_PROVEN_NAME_SHAPES.method` widens from `/^[A-Za-z_][A-Za-z0-9_]*$/` to `/^[A-Za-z0-9_ ()/&åæ-]+$/`. Those
are exactly the characters N1S's method names use: letters, digits, `_`, space, `-`, `(`, `)`, `/`, `&`, `å` and `æ`,
with a leading digit allowed.
- The dot stays out (#5798, N1E unchanged), and so does any character N1S never ran (for example `ø`, `'`, `:`).
- The codeunit shape is unchanged.

## Every other leg
Unchanged, with the same figures. K's sandbox-app names were already plain, so K is unaffected.
