# PR-47 pre-commitment: the GoToKey refusal joins the serve keep-list if measured clean; a resume that finds no stored baseline says so

Status: pre-commitment (coord PR-47, lethal-code, 2026-11-16), before any build. Cause found offline on R-984's t5/t6 events
(`/coord/handoff/R-984/`): DO window t6 ran about 65 s per new covered mutant against t5's 8.3 s. Option A and the named warnings
are approved by the orchestrator (2026-11-16); option B (leaving a mid-order refused test out of mutant entries) is out of scope.
Evidence: `/coord/handoff/PR-47/`. Invented AL only in anything committed.

## The cause (no merged change)

- t6 reached a part of DO that t5 never ran: t5's budget ended after the first 14 mutants of a page, all no-coverage, and t6 went
  on to its covered ones. Compared by file, line and operator: ids shifted by PR-37's 57 removed sites.
- Their covering tests are in one test codeunit. Its 17th test in baseline order is refused at baseline, identically in t5 and
  t6, with `GoToKey on a list that opened on the last row of its descending view, with more rows above the rows it holds than a
  window (not pinned)`. That text is not on `V3_SERVE_SAFE_REFUSALS`.
- R1004/R998 leave such a test out of MUTANT entries only at the tail of the codeunit's order (`mutantLeftOutNames`). The L4 cut
  drops only tests after the last covering test. So each request for those mutants runs the test and loses the daemon.
- In the window: 64 of 96 refusal closes; each costs a restart and a warm-up (about 37 s), against 105 to 158 warm-ups from t5 to
  t6. R987's entries cap (38 in t6) is a secondary cost and does not cause the closes.
- Separately, no `resume-baseline-not-reused` line was printed. PR-37 changed the emitted AL, so no stored snapshot matched the
  batch's tree hash, and that path is silent: the warning fires only when a found snapshot fails PR-21's recheck.

## What changes

1. **Keep-list (option A).** The refusal is reduced to an invented shape and measured with R-967's kit, as PR-29 did:
   - a refuser after R-937's standard writes;
   - on a kept daemon, every reader equal to the control;
   - fresh daemons give one answer, equal to it;
   - the pid is unchanged, and there is no panic text.
   Only if CLEAN, `V3_SERVE_SAFE_REFUSALS` gains an entry for exactly that text, anchored at both ends, and leg C's
   `serve-keep-reasons` gains the invented case. If it is not clean, or not reducible to invented AL, nothing is added, and an
   addendum says so before any build.
2. **Named warnings (lead c).** With `--resume` and a run to resume, the session warns `resume-baseline-not-reused` by name in two
   cases:
   - no stored snapshot matches this batch: "no stored baseline matches this batch's instrumented tree and test app (the emitted
     AL or the test app changed)";
   - a found snapshot is dropped because it lacks one of this session's tests (R-236c): "the stored baseline lacks <n> of this
     session's tests".
   No verdict or reuse decision moves; only the line is new.

## Predictions

1. Unit tests, red both ways:
   - the keep entry matches the measured text and refuses a reworded one;
   - each of the two warnings is raised in its case and not when a snapshot is found and reused.
2. `itest:alrunner-v3` passes every leg. Leg C's `serve-keep-reasons` reads `matches`, with the new case measured as a kept
   refusal (when A lands). No pinned verdict or frozen figure moves.
3. DO, the next window carrying it (t7): this family closes no daemon in a mutant request; warm-ups per new covered mutant fall
   back toward t5's; every mutant scored in both t6 and t7 has the same verdict and killing test (a difference is a BLOCK).

## Addendum 1 (2026-11-16, the measurement, before the keep-list build)

**Reduced.** The shape comes from the pinned build's source (`crates/al-vm/src/pages/rows.rs`: `opens_on_the_last_row_reading_up`,
`go_to_key_from_the_last_row_read_up`, WINDOW = 20). Earlier attempts (R982) missed the secondary key. The invented refuser:
- a list page with `SourceTableView = sorting(<a secondary key>) order(descending)`, declaring OnAfterGetRecord and
  OnAfterGetCurrRecord;
- opened modal with `Page.RunModal(0, <blank record>)` over a table of 60 rows;
- a ModalPageHandler that calls `GoToKey` once.
The one-shot and serve texts both equal DO's exactly.

**Measured CLEAN** with R-967's kit (`/coord/handoff/PR-47/`, edge-5a58a0f16, `ALRUNNER_SEED=1`; the refuser runs R-937's
standard writes first):
- all 47 refuser answers refused with that text;
- on one kept daemon, 27 readers all equal the control;
- 20 fresh daemons give one answer, equal to it;
- the pid is unchanged, and there is no panic text.
Not measured: a second GoToKey or a move after the refusal (other texts, not on the list), the real DO page, and a handler that
catches the error.

So item 1 goes ahead as written: the keep entry anchors exactly that text, and leg C's `serve-keep-reasons` gains the invented
case. The texts of the same function that were not measured stay off the list ("in a key other than the primary key, after a move
or a GoToKey", "for a key the view does not have", "whose top row held is gone").
