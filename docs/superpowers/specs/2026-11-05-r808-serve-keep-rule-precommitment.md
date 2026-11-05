# R808 pre-commitment (R-808): the serve keep rule on today's al-runner texts

Written 2026-11-05 by lethal-bugs, before the build. Evidence: `/coord/handoff/R-808/probe.md`. `current` is alpha.12.

## 1. Widen the `http` entry of `V3_SERVE_SAFE_REFUSALS`
- The probe (R612's rule): about 60 requests per daemon on alpha.12 and alpha.7, in every shape. Every Reader answer equals
  a cold daemon's, the pid stays, and the refusal cannot be swallowed by a `[TryFunction]`.
- **The change:** add today's one wording as an alternative, exact and anchored at both ends, from
  `NotRun: out-of-scope: an outbound HTTP request that a test handler does not answer` to `... to get BC's error for it`.
  Keep alpha.2's wording. No wildcard, no prefix match.
- **Effect:** a project whose test hits this refusal keeps its daemon, and a warm-up that hits it no longer closes or
  falls back. That is speed only. The row itself is scored as before; a live differential proves it (below).

## 2. `serve-keep-reasons` reads `matches` again, keyed by the pin
- A standing `diverged` hides a real move, so the fact must read `matches` on what is expected of the build in use.
- A new optional pin field records what a build gives for the two moved entries, in the shared `READINGS_8078BCF49`:
  `commit`: a plain pass (no `notRun`); `onrun-failed`: no row for `Codeunit50673.Never`.
- Without the field (alpha.2, alpha.5, older edges) the fact judges as today.
- With the field, any OTHER reading of those two entries is still `diverged`. An unpinned build reads as today.
- The `http` entry today reads a plain fail on localhost, so its refusal is never exercised. `SERVE_TESTS_AL` gains a test
  on a public host in its own codeunit, whose row must match the `http` refusal. The localhost case stays.
- The fact stays a WARN fact: it never refuses a session or fails a gate.

## Also (no figure moves)
- **OnRun.** On alpha.12, a test codeunit whose OnRun fails gives no row. LethAL scores such a mutant `error` through
  `rowMissing`, never `survived`. That has no test today; the build adds one, red-checked, for serve and one-shot.
- **Upstream.** The OnRun answer is a runtime difference from alpha.7's plain fail row, and it silently drops tests. Filed upstream, and as a roadmap item.

## Predicted figures
On `current` alpha.12 at the head, and by `--regate` at the merge, and on alpha.7 by path at the head:
- `serve-keep-reasons` = `matches`; the `al-runner-v3-serve-keep-reason-moved` warn line is gone; `.gated`'s `warnFacts` reads `matches`.
- Every other leg, fact, verdict, killing test, note, refusal and counter is unchanged, per mutant, from R807's readings: C's 8
  pinned gone, N1E 36/0/0, O1 pass (18 apps on alpha.12, 17 on alpha.7), T 318/70/18 with 48 pinned rows, D1, D1c and K 0 differences.
  No gate fixture hits the http refusal under serve except the contract probe, so no counter moves.

**Live differential.** A scratch copy of `sandbox-app` with one test hitting the refusal, `lethal run` on `current` under
`one-shot` and `serve-entries`: per mutant equal, verdict and killing test. The serve run keeps one daemon.

## Judgement
Any verdict moving is a BLOCK. Any other reading off this file is a BLOCK until explained, in a dated addendum, never an
edit of this file.
