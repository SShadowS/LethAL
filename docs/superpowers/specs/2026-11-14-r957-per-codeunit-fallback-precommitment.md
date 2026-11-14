# R-957 (R937) pre-commitment: no gate figure moves

Written 2026-11-14 by lane code, before any gate run of the change. Branch `lethal/r-957` at e0e42045.

## The change

R937: a test METHOD whose name serve-entries is not proven for makes only ITS codeunit run one-shot inside the serve session
(`oneShotCodeunits`), instead of dropping the whole default session to one-shot. The proven method shape
(`V3_SERVE_PROVEN_NAME_SHAPES.method`) widens to exactly the 15 shapes the invented app measured
(`/coord/handoff/R-957/shapes/result.md`), with a first `Ø`, `Æ` or `Å` admitted only before an ASCII letter or digit (delta
review). Each mutant call of a one-shot codeunit is preceded by an echo in a separate process on the same lane (a proxy check),
once per (lane, mutant), counted in the serve stats (`echoRequests`, `echoMismatches`); a mismatch refuses the call by name
(`entries-echo-mismatch`, never scored).

## Why no leg moves

- Every `[Test]` method name in `fixtures/` (208 names) was read against master's pattern and the branch's: 0 differ. The only
  name outside both is `Dot.Step` (`sandbox-names-tests`), which on `current` is read through the row fields (#5798 fixed,
  `serveRowFields`), not by the pattern. So no fixture codeunit becomes one-shot inside serve, and no gate session changes
  transport.
- With no one-shot codeunit inside a serve session, the echo never runs: `echoMismatches` stays 0 wherever it is pinned (MOE,
  WRE, N1E, N1S, D1, D1c, the serve-entries legs), and `echoRequests` is not pinned.
- `report.ts` changes only the `al-runner-v3-serve-default-fallback` caveat's text; no caveat is added or removed.

## Predictions

- **Full v3 gate** on the branch's final head, on whatever `current` is when it runs: every leg passes against its committed
  baseline and pins, unchanged.
- **BC legs** the gate table selects (the diff touches `packages/runner/**`): each passes unchanged. The v3 backend is not on their
  path; the caveat text is not a gate figure.
- **Live proof** (invented app, not a gate): `default` and `oneshot` per mutant equal (97 mutants), as in step 2, and the
  default run's serve stats show one echo request per mutant that reached the one-shot codeunit, 0 echo mismatches.

Any other difference is a BLOCK, to be read before anything is re-recorded.
