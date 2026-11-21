# PR-297 spec-light: measure the green tests after a baseline-refusal cut in their own entry (R1160, the owner's option 2)

lethal-preproc, 2026-11-21. Pre-committed before any code. The owner chose option 2 (q-20261121T154129-8684c13c): "measure
the tests after the cut in their own entry; measure first whether verdicts move, then score. Keep #8596 as the upstream fix."

## 1. Today (PR-250, `refusedCut` in packages/runner/src/al-runner-v3-backend.ts)
- **The cut:** per codeunit, the first test in baseline order whose baseline row is an UNKEPT refusal, and every test after
  it that no earlier test name starts, are left out of every mutant entry of that codeunit (sent with `runSelectedOnly`).
- **The verdict:** each cut test that covers the mutant scores `error` (`baseline-refused-cut: ...`, held by the walk).
  The mutant is `error` unless another measured test kills it.
- **On DO:** one codeunit, 68874 (10 tests; the 6th is the first refused; 4 refused in all). In perf10c, 301 mutants were
  `error` through it: 89% of all error test time (R1160).

## 2. The change: a TAIL entry, off by default
- **The tail of `cu`:** the cut tests whose BASELINE row is a PASS (the green ones; a refused, failing or timed-out test is
  never a covering test). Order: baseline order.
- **The stability check (H1: state dependence):** once per codeunit per session, at the first mutant request that would
  carry the cut, one entry runs ONLY the tail tests (`runSelectedOnly`, no mutant active: NONE).
  - A tail test is STABLE if its row in that NONE tail entry is a pass, as in the main baseline.
  - An unstable test (it passes only after the tests before it) is never used, and keeps today's PR-250 error.
  - **Why:** in its own entry a tail test runs without the earlier tests' effects (codeunit globals, the refused test's
    partial work, shared table state within the codeunit's isolation). If it passes alone under NONE, its outcome does not
    depend on those effects with the code as it is.
- **Under a mutant:** each mutant entry cut by `refusedCut` gets a second entry for `cu`, in the same request after the
  first. It runs the stable tail tests only (`runSelectedOnly`, the mutant active). Their rows score those tests as
  ordinary rows: a fail can kill, a pass is a measured pass.
- **Unchanged:**
  - The head entry and its cut.
  - The refused tests themselves, never run under a mutant.
  - Unstable tail tests, which keep the PR-250 error.
  - The kill ledger's order (R197): a tail test keeps its baseline position.
  - Every mutant whose codeunits have no refused test.
- **Off by default:** `alRunnerV3.refusedCutTail: true` turns it on.
  - It enters the run fingerprint and the report's `executionContexts`, so `--resume` cannot mix runs with and without it.
  - It becomes the default only after §4's measurement meets its bound, by a separate ruling.

## 3. Pre-committed tests (unit; fake serve rig)
1. **Off (default):** requests and verdicts are byte-identical to today on a cut codeunit. No NONE tail entry is sent and
   no second entry appears.
2. **On, stable tail:**
   - a codeunit `[A, B, R (refused), C (pass), D (pass)]` with a mutant killed only by `D` scores `killed` by `D`, and
     one surviving every test scores `survived`;
   - the NONE tail entry is sent exactly once per codeunit per session;
   - the mutant request holds a second entry for the codeunit carrying `[C, D]` only, with `runSelectedOnly`.
3. **On, unstable tail test:** `C` fails in the NONE tail entry. `C` keeps the PR-250 error under every mutant, `D` is
   still measured, and a mutant covered by `C` is never `survived`.
4. **On, a tail with no green test:** no tail entry, no NONE run, today's behaviour.
5. **Kill ledger order:** a mutant that `B` (head) and `D` (tail) both kill reports `B`, in baseline order, as today.
6. **The fingerprint and report** carry the flag, so a resume with a different value refuses.
- **Red checks, both directions:**
  - the stability check skipped (all tail tests used) turns test 3 red;
  - the tail entry sent without `runSelectedOnly` turns test 2's request assertion red;
  - the flag ignored (always on) turns test 1 red.

## 4. The measurement first (on DO, after the combined run c2; a separate pre-commitment amendment with figures)
- **Tail stability:** for 68874, which tail tests are stable (their NONE tail-entry outcome against the main baseline's).
- **Verdict moves:** perf10c's 301 cut `error` mutants (and c2's), on the same `current`, run with the flag on against
  off. Counts by move (error -> killed, error -> survived, error stays), each named.
- **The bound that must hold before the default changes:**
  - (a) 0 verdict moves outside those 301 mutants (the flag touches only cut mutants);
  - (b) on a BC sample of the moved mutants (lethal-bugs, the full codeunit run in order on a bc server), 0 FALSE KILLS:
    a tail kill BC does not reproduce is a BLOCK;
  - (c) a tail survivor that BC kills is reported per mutant: the evidence is weaker than a full survivor, and it goes to
    the owner if more than about 5% of them.
- #8596 stays the upstream fix: once al-runner keeps that refusal, the cut and this tail retire.
