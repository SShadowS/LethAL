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

## 5. Amendment 1 (2026-11-21, the spec-adversary, before any code): ALONE routing replaces §2's second entry
- **Why the second entry is dropped (two BLOCKs):**
  - **Request layer:** `selectedOnlyDecision` refuses `runSelectedOnly` for a gapped entry, and a tail entry is gapped by
    construction. A second entry for the same codeunit collides on its entry id (`${key}|${cu}`), and its rows would
    overwrite the head's (results and `rowsByCodeunit` are keyed per codeunit). Loosening the gap guard generally is a
    false-kill door: #8059 prefix gaps change state (R1094).
  - **Confirm context:** a tail kill's kill pair leaves T out (`cutAfterKiller` builds on `mutantLeftOutNames`), and the
    live NONE confirm runs T in the FULL codeunit order: a different context from the kill. The kill -> NONE -> M order
    (R653) would no longer hold.
  - **Packing:** a tail riding the flagged request would make the verdict depend on packing (PR-250 sends the cut only
    in flagged requests), and chunking must never be semantic.
- **The design now:** at `runRow`'s PR-250 early return (`baseline-refused-cut`), the one place prefetch, live, pairs and
  R612 re-sends all reach, a STABLE tail test, with the flag on, is run through `aloneCall`, R895's one-test-alone path,
  instead of scored `error`.
  - The verdict carries `selection: "alone"`, so the orchestrator's existing `aloneKill` confirms NONE alone and
    reproduces alone, after the kill, in the kill's own context.
  - Only T runs, so the refused tests never run under a mutant. The cost is one live alone request per cut mutant and
    stable T.
- **Stability, now per test and run alone:** at the end of the baseline phase (activation NONE), each green tail test T of
  a cut codeunit runs ONCE alone. Stable means its row is a pass.
  - A refused, failed, timed-out or missing row, or a closed daemon, marks T UNSTABLE. Unstable T keeps the PR-250 error;
    it is never retried and never treated as stable.
  - One result per session, held by the backend, shared by all lanes (the baseline runs before the lanes start).
  - This is the context every later alone call of T runs in. It also covers §3 test 3: there is no "reduced set" context.
- **H1 is NOT closed** (review SF1): a head test's setup can mask a mutant that T alone exposes. BC survives, T alone kills:
  a FALSE KILL. So:
  - every alone tail kill carries a note: `refused-cut tail: <T> measured alone, after a baseline refusal cut (PR-297)`;
  - §4(b) checks ALL error -> killed moves on BC, not a sample. "Reproduces" means BC kills the mutant AND T itself fails
    there. One that does not is a BLOCK.
- **§4's bound, completed (review SF4):**
  - (a) list every `killingTest` move too, not only verdicts (a tail test earlier in ledger order than today's killer);
  - (b) the measurement counts only if the cut FIRED in both arms (`refusedCutEntries > 0` and the
    `al-runner-v3-baseline-refused-cut` line), and with the flag on, tail alone calls > 0. Otherwise it is
    empty-vs-empty and void;
  - (c) the exact build is named (main-ccd0f823d, whose baseline refuses 68874's test).
- **Tests (replacing §3's 2-5; 1 and 6 stay):**
  - 2. On, stable T: `[A, B, R (refused), C (pass)]`. A mutant killed only by C scores `killed` by C with
    `selection: "alone"` and the note; one surviving every test scores `survived`. The stability run is sent once per
    session.
  - 3. On, unstable T (C fails alone in the stability run): C keeps the PR-250 error under every mutant, and a mutant
    covered by C is never `survived`.
  - 4. A tail with no green test: no stability run, today's behaviour.
  - 5. A stability run that is refused, cut, or lacks T's row marks T unstable (fail closed).
  - 7. The kill confirm of a tail kill runs NONE alone (the request carries T alone with no mutant), after the kill.
- **Red checks:**
  - the stability verdict ignored (every T used) turns test 3 red;
  - a stability failure read as stable turns test 5 red;
  - routing T to the live whole-codeunit call instead of `aloneCall` turns test 7 red;
  - the flag ignored turns test 1 red.
- **A gate (review SF6):** before the default flips, an offline v3 fixture leg with an unkept baseline refusal and a tail
  kill is added. That is not in this PR; it is a named follow-up.
- **Wording fix (review NIT):** v3 serve runs `testIsolation: "test"`, which resets tables per test. The state channel
  alone removes is the codeunit's GLOBALS (and the refused test's partial work), not table state.
