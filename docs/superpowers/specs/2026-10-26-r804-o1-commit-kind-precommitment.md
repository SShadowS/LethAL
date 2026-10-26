# R804 pre-commitment, part 2 (R-804): a commit kind in update-gate leg O1

Written 2026-10-26 by lethal-bugs, before the build. Orchestrator's ruling: the commit-isolation probe on 8078bcf49
was clean (`/coord/handoff/R-804/commit-probe/result.md`), so make it permanent in O1. Then a later build cannot break
commit isolation unseen. R778's kill-pair batching and serve daemon reuse rest on that isolation.

## The change
- **New codeunit.** `fixtures/sandbox-order-tests` gains a separate codeunit `CommitWriter`. Each of its tests writes
  one kind and then calls `Commit()`: a local table row, a dependency-app table row, the local SingleInstance, the
  dependency-app SingleInstance, a NumberSequence, IsolatedStorage. Each test re-reads its own value after the Commit.
  - It is separate from the existing Writer, because on builds that refuse a Commit the refusal cascades to the rest of
    its codeunit.
- **New requests.** O1 appends commit requests to the SAME daemon, after the five existing ones: `[C, R]`, `[R, C]`,
  `[C1, R1, C2, R2]`, then a new request `[R]`. `O1_PLAN` and its request-count and shape check grow to match. The
  existing five requests and their judgement are unchanged.
- **Judging by build.** The verdict keys off the build's pin: the leg-C fact `commit-under-test-isolation` pinned `gone`
  (today only `edge-8078bcf49`).
  - **Flagged build:** every CommitWriter test passes, and every Reader entry in the commit requests reads the defaults
    on all kinds. A writer value is CARRY-OVER: `gate-fail`. A CommitWriter test that does not pass: `gate-fail`.
  - **Any other build:** every CommitWriter test is refused with text matching `V3_SERVE_SAFE_REFUSALS.commit`, and the
    Reader entries read the defaults. A CommitWriter test that passes on an unflagged build is `held` (re-pre-commit:
    upstream may have fixed it). Any other row is `gate-fail`.
- Both package sets (own, CDO 17 apps), as O1 already runs.

## Predicted figures
- **On `edge-8078bcf49`** (the flagged build): O1 passes. All 6 CommitWriter tests pass, and every Reader entry in the
  four commit requests reads `ROWS=0 DEPROWS=0 MARK=DEFAULT DEPMARK=DEFAULT NUMSEQ=ABSENT ISO=ABSENT`, with WorkDate and
  language as O1 already judges them (the CDO WorkDate 2026-08-01 per the pin). This is the probe's measured result.
- **On `edge-a157b2d34` and `edge-dcdf9e821`:** O1 passes. Every CommitWriter test is refused with the commit refusal
  text, and the Readers read the defaults.
- **Every other leg and figure is unchanged.** The fixtures corpus dump may differ only in `sandbox-order-tests` if that
  project is counted; its target app `sandbox-order` is unchanged.
- No gate baseline moves.

## Judgement
Any other reading is a BLOCK until explained, in a dated addendum, never an edit of this file.
