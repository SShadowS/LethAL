# R808 pre-commitment, addendum 2 (2026-11-05): a differential that can tell, and the OnRun outcome per transport

Adds to `2026-11-05-r808-serve-keep-rule-precommitment.md` (04465628) and addendum 1 (ea85530d). Written by lethal-bugs after
the opus build review of 64b2a503, before the runs below on the final head.

## 1. The first live differential proved nothing about the keep rule
Its refused test sat alone in a new codeunit. Baseline marked it failing, so it covered no mutant and never reached a serve
entry. Master, without the widening, gives the same "daemons 1, entries sent 44". It must not be read as evidence.

**It is replaced by:** a scratch `sandbox-tests` with the refused test INSIDE a covering codeunit, and a target with a guarded
HTTP call, so that a mutant newly reaches the refusal (the reviewer's fixture,
`/tmp/claude-1000/-work-lethal-wt-lane-bugs/42bbe1d1-6c93-426d-bdfa-21fd7ce46008/scratchpad/r808-review/`, measured there on 64b2a503).

**Predicted on `current` alpha.12, at the final head:**
- One-shot against `serve-entries`: 22 mutants, 0 differences on whole mutant objects with timing keys removed; `unsupportedTests` and counts equal.
- The serve run: daemons 1, echo mismatches 0, kill pairs 5 stored and 5 served.
- A mutant that newly reaches HTTP reads `error`, cause `runner-refused`, not a kill, on both transports; the next group reads as in one-shot.
- **The contrast that makes it a proof, on master without the widening:** explicit `serve-entries` stops with `al-runner-v3-entries-warmup-dirty`; the default transport falls back to one-shot (R786).
- The default transport, built against master: 22 mutants, 0 differences. So the widening changes speed only.

alpha.7 was not measured this way; it is not `current`. Its gate reading stands.

## 2. The OnRun outcome, corrected
Addendum 1 said a mutant that makes a test codeunit's OnRun fail reads `error` through `rowMissing`. That holds under `serve-entries`
only. On one-shot, alpha.12 exits 6 with no rows, and `callCodeunit` throws `AlRunnerV3SelectionError`, which STOPS the session,
naming "selected no test". Measured by the review on a scratch fixture. No verdict is at risk, because nothing is scored, but a
whole session is lost, and the stop names the wrong cause. This predates R808 and is not fixed here: it is a new roadmap item.
So a mutant of this kind is never `survived` on either transport: `error` under serve, a stopped session under one-shot.

## 3. Wording
On alpha.7 a raising OnRun gives a plain fail row named `Codeunit<n>.OnRun`, and no row for the test method. On alpha.12 it gives no
row at all. The pin field says "no row for the test method" (the fact checks `Codeunit50673.Never` only). A candidate with no
pin still reads `diverged` on this fact, which is expected.

Every gate figure of the original file is unchanged.
