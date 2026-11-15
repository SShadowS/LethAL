# R-998 pre-commitment: fewer serve daemon closes in the mutant phase

Committed before any gate run or DO window, 2026-11-14. Evidence: `/coord/handoff/R-998/`. Invented AL only. Source:
R-984's DO window t1 (`/coord/handoff/R-984/result.md`): 42 daemons, 35 closed by a refusal met in a MUTANT request, 3,625 s
of warm-ups (about a quarter of the 3.4 h window).

## What changes

1. **(a) Mutant entries leave out the baseline-refused tests R1004 leaves out of the warm-up.** R1004's rule (a test whose
   row in THIS batch's baseline is a named refusal the daemon cannot keep; only when no other test of its codeunit
   starts with its name, #8059's prefix match; never for a test run alone, R857/R896) moves into one method. Prefetch and
   live requests pass it to `encodeGroups` as `excludeTests`, as the warm-up does. `suiteMissing` accepts no row for a
   left-out test (a row that comes back anyway is read as before). Kill pairs, alone calls and coverage requests run one
   test and are unchanged.
   - Why no verdict moves: a mutant is scored only by its covering tests, which are green at baseline, so a refused
     test is never one. Serve runs `testIsolation: "test"` (the database rolls back after each test). The state that
     outlives a test (session language, event bindings, isolated storage, number sequences) is what v3's cascade
     refusals track: a test that stayed green after a refused one was judged by v3 not to be reached by it. That is an
     argument, not a measurement, so the DO window below compares per mutant.
2. **(b) `V3_SERVE_SAFE_REFUSALS` gains three entries**, each for exactly the texts measured:
   - `recordref-not-open`: `RecordRef.<M> on a RecordRef that is not open: BC's error text, and whether Get(RecordId)
     opens the table of the RecordId, are not pinned (docs/probes-needed.md)`, for M in FieldCount, FindSet,
     SetRecFilter, SetLoadFields (no other method).
   - `fieldref-never-assigned`: `FieldRef.Class on a FieldRef that was never assigned: what BC does (an error, or a
     no-op) is not pinned (docs/probes-needed.md)`.
   - `gettable-unassigned-variant`: `RecordRef.GetTable of an unassigned Variant`.
   - Basis: R-967's kit (`/coord/handoff/R-998/probe/`, edge-a184cfc79, `ALRUNNER_SEED=1`). One invented refuser per
     text (51000-51005), each doing R-937's standard writes first. One-shot texts are exactly DO's. On one kept daemon:
     20 refuser/reader rounds, entry batches, refuser+http+reader; 27 readers all equal to the control; 20 fresh
     daemons one answer equal to it; the pid unchanged; no panic text. All six: **CLEAN**.
3. **Leg C's `serve-keep-reasons`** (still one warn fact; leg C keeps 28 facts) runs six more invented test codeunits
   in its one serve request, one per measured text (FieldCount, FindSet, SetRecFilter, SetLoadFields, FieldRef.Class,
   GetTable of a Variant), each judged by its new entry. A build that rewords one reads `unkept` and fails the gate
   (R1000).

Not in this change: DO's 7 closes on `a stale Issued Reminder Header buffer from its own write, after a lock other
tha...`. LethAL's close summary cuts the text and no store holds it whole, so its trigger is not known and it cannot be
measured: filed as R1009.

## Predictions

- `itest:alrunner-v3` on `current` (edge-a184cfc79) passes every leg. Leg C's `serve-keep-reasons` reads `matches`,
  its `measured` naming the six new cases as `refusal`. No pinned verdict, figure or leg outcome moves. (a) changes only
  requests whose codeunit had a baseline refusal the daemon cannot keep; if a pinned serve counter of a leg moves, it is
  examined as a BLOCK, not accepted.
- One DO window on the R-998 head, of t1's length and config, run with lethal-bugs (R-984 owner):
  - daemon closes by a refusal in a mutant request: at most 16 (t1: 35; expected 13 = the 7 stale-buffer closes plus 6
    others);
  - warm-up wall time at most 1,800 s (t1: 3,625 s);
  - every mutant both windows score has the same verdict and killing test as in t1. Any difference is a BLOCK.

## Addendum 1 (2026-11-14, before any gate run or DO window): build review and t1's build

Committed after the Opus build review of cebb52ff and before the gate or the window.

1. **(a) is narrowed.** The review showed that leaving a refused test out where a test runs AFTER it is not
   verdict-neutral:
   - The refused test can change the codeunit's globals before v3 refuses it, and v3's cascades do not track that.
   - A failure after it reads today as an untrusted cascade refusal (`error`), and without it would read as a kill,
     while one-shot keeps the old verdict.
   
   So a MUTANT entry now leaves out only the run of R1004's left-out tests at the END of the codeunit's baseline order
   (`mutantLeftOutNames`). No test that still runs follows one of them. The warm-up keeps R1004's rule: it only
   compares, and a difference there fails loudly.
   
   DO: in codeunit 68978 the ten refused ZipArchive tests are positions 6-15 of 15, so they are left out. In 68922
   (12 of 18) and 68958 (14 of 19) the refused test stays in, as before.
2. **The §6 coverage window** (only where the Sleep rule is not retired) sends the same `excludeTests` as the entry it
   is compared with. Without it, the window ran the left-out test, disagreed with the entry, and the pass was never
   scored.
3. **Kill pairs** go through the same request path, so they leave the same tests out. The text above said they were
   unchanged.
4. **t1 ran on edge-847b1fa5a** (lethal-bugs' erratum, master 912e7e73), not a184cfc79. The DO window runs on
   847b1fa5a, like for like. The three families were re-measured with the same kit on 847b1fa5a
   (`/coord/handoff/R-998/probe/out-847b1fa5a/`): the one-shot texts are the same as a184cfc79's, and all six refusers
   are CLEAN.
5. **The window's comparison widens.** Every mutant BOTH windows report (`error` and `no-coverage` included, not only
   scored ones) must have t1's verdict and killing test. So a mutant that t1 refused and this window kills is a BLOCK,
   not unseen.

Predictions otherwise unchanged:
- refusal closes in mutant requests at most 16 (13 expected plus at most the 3 ZipArchive closes outside 68978);
- warm-up wall time at most 1,800 s;
- `itest:alrunner-v3` on `current` passes every leg, and `serve-keep-reasons` reads `matches` with the six new cases
  as `refusal`.
