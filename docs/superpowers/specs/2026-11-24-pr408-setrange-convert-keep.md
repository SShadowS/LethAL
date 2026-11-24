# PR-408 pre-commitment: keep edge e5176a9fd's reworded SetRange/SetFilter conversion refusal, then rejudge edge

Coord PR-408 (lethal-bugs, 2026-11-24), on the orchestrator's word. Committed before the merge and before the rejudge.
Build: branch lethal/pr-408 (5bd783b49). Evidence: `/coord/handoff/PR-408/`.

## Why
- After PR-403 (master f90f2777d), the re-gate of `current` main-bf3a3e863 at master f11300ce6 passed. The rejudge of edge
  e5176a9fd at f11300ce6 failed leg C on one fact: `serve-keep-reasons: unkept` (R1000).
- PR-363's leg-C family cases (landed after 5b3f27102) include `t10-refusals code-gl-to-biginteger` and `t12-refusals
  conversion-text-to-integer`. On edge those two cells refuse with a NEW text, which no keep entry accepts:
  - `NotRun: out-of-scope: SetRange or SetFilter of Code 'GL00000000' into a BigInteger field in a shape no cell measures
    (assumption setrange-other-type-convert)`
  - `NotRun: out-of-scope: SetRange or SetFilter of Text '=18' into a Integer field in a shape no cell measures
    (assumption setrange-other-type-convert)`
  - `current` refuses the same cells with the old, kept texts ("conversion of Code 'GL00000000' to BigInteger",
    "conversion of Text '=18' to Integer").
- So the same shapes are refused on both builds. No verdict moves, and nothing moves away from BC. Only the text moved,
  and an unkept text closes a serve daemon (R1000).

## The change
- Two EXACT rows in `PR56_KEPT` (`al-runner-server.ts`), the captured lines byte for byte, with no slot:
  `setrange-code-gl-to-biginteger` and `setrange-text-eq18-to-integer`. Another value, field type, source type, assumption
  or an appended tail still closes.
- **The kept-vs-fresh check** (`/coord/handoff/PR-408/keepcheck.ts`, output `kc/`), on edge's kept binary (sha256
  9b0e90bd…), with leg C's own requests (the family app, `testIsolation: "test"`, `--test-timeout 3`, `--environment saas`):
  - t10, t12, t10, t12 on ONE daemon, against a fresh daemon per request;
  - every row of every request is equal by name (13/6/13/6 rows);
  - the planted-difference self-test caught its one difference.
  - The compare sorts rows by name, because serve streams rows in completion order; the first run's by-position compare
    counted order alone as 4 differences.
- **On DO:** c4 (main-bf3a3e863, so the old texts) meets the Code-to-BigInteger shape in one mutant (9 test rows), never at
  baseline, and the Text-to-Integer shape never (`c4census.txt`). Whether that one mutant's conversion comes from
  SetRange/SetFilter, which edge would reword, cannot be read from c4.

## Tests (`packages/runner/tests/pr408-setrange-keep.test.ts`)
- Both lines kept, each by its own entry.
- Six near misses still close.
- A non-refusal row with the text is never kept.
- The old texts stay kept.
- Red checks: removing the rows turns the kept test red; a broad pattern turns all six near misses red.

## Predictions
- **VERIFY:** green.
- **The full v3 gate on `current`:** PASS, leg C's `serve-keep-reasons` unchanged (`diverged`, the known
  `setfilter-boolean-language-words` warn fact).
- **After the merge, two steps** (a rejudge runs at `.gated`'s commit, f11300ce6, which lacks this change):
  1. `--regate <new master>` of `current`: PASS.
  2. `--edge-rejudge e5176a9fd`: leg C's `serve-keep-reasons` is `diverged`, not `unkept`. The two PR-363 cases read
     MOVED (refused under the new entries, not their own), so the fact is a warn and not a gate-fail. Every other leg
     passes. The script moves `current` to edge-e5176a9fd.
     - Edge carries upstream's login replay; LethAL's PR-360 pin keeps it off; lethal-code is told (PR-402 step 2).
     - Any other leg moving is a STOP, named before anything else.

## Amendment 1 (2026-11-24, during the build): the two keep-list guards
- VERIFY's first run failed two guards that the plan above did not name; each requires every keep entry to be accounted for:
  - **PR-361** (`pr361-keep-real-lines.test.ts`): every entry is proven by a REAL al-runner line in
    `pr361-keep-real-lines.json`. Both captured edge lines are added under `proven`, from `PR-408/kc/kept.json`, checked equal
    byte for byte to the captured rows.
  - **PR-363** (`scripts/pr363-legc-keep-apps.test.ts`): every entry is judged by a leg-C case or pinned with a reason from a
    fixed set of categories.
    - A NEW category, **`edge-rewording-of-a-judged-case`**, holds both entries: the t10/t12 cells produce these texts only
      on edge, where they read MOVED under their old entries (kept, so a warn).
    - The pinned map grows from 72 to 74 rows.
- With both, VERIFY FULL passes (15,927 pass, 0 fail).
