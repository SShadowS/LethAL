# R-273b plan: `lethal explain --suggest`, a labelled, opt-in suggested fix kind per gap

Base: master `14c9dbad`, worktree `/work/lethal-wt/r273b`. Roadmap R273, owner ruling 2026-10-06: a
suggested fix kind may appear ONLY in a distinct section, OFF by default, labelled as a suggestion
and not a measurement, outside the strings the banned-phrase and admissibility tests police. Those
tests and the default output stay unchanged.

## The evidence (already measured, already in explain's output)
Every survivor carries `reach` (`survivorReachOf`, report.ts), the one field that combines coverage
attribution with whether the mutant's own statement ran (`guardReached`, GH-24; R116 for older
reports). Its four values and what each one measured:
- `reached-unnoticed`: the statement began executing in a covering test (`reachedBy`), and every
  covering test still passed.
- `covered-but-unreached`: a test entered the procedure (exact member coverage), and the statement
  never ran in the mutant's runs.
- `unreached-and-uncovered`: the statement never ran, and coverage placed no test in the procedure.
- `not-decided`: nothing measured decides it (enclosing/unplaced grain, al-runner, a timeout, a
  carried row).

## Design
1. **Kind per member, from `reach` alone** (one table, `SUGGESTION_KIND_OF_REACH`, in the new
   module below, never in report.ts, so the interpretation registry is untouched):
   - `reached-unnoticed` -> `check-the-result`: the code ran under a test and no test noticed the
     change, so no assertion looks at what it changes. Carries `equivalenceRisk` verbatim when the
     row has one (an equivalent mutant reads the same; REACH_INTERPRETATIONS says so).
   - `covered-but-unreached` -> `cover-the-branch`: a test enters the procedure but none takes the
     path to this statement; a case that takes it would, or the path is unreachable.
   - `unreached-and-uncovered` -> `cover-the-code`: no test runs this code at all.
   - `not-decided` -> NO kind. The member is listed with `kind: "undecided"` and no text: the report
     cannot say which of the three applies, and a guess is exactly what the ruling keeps out.
   A reader mark (`readerMark`) is never re-suggested: the reader already judged it.
2. **Kind per gap:** the set of its members' kinds. One kind -> that kind; more than one -> `mixed`
   (members carry their own). A gap whose members are all `undecided` -> `undecided`.
3. **Output: a new optional top-level `suggestions` section**, present exactly when `--suggest` is
   given and the report has gap ids (`gaps` present). `--suggest` on a report without gap ids is
   REFUSED by name, never an empty list (empty-vs-empty is this repo's signature bug).
   ```
   suggestions: {
     label: SUGGESTIONS_LABEL,   // fixed: "SUGGESTIONS, not measurements: ..." (pinned by test)
     kinds: { <kind>: { suggestion, derivedFrom } },  // the registry, once, for the kinds used
     gaps: [{ gapId, kind, members: [{ mutantCode, kind, reach, equivalenceRisk? }] }]
   }
   ```
   `gaps` in the same order as `gaps[]`. Every string is either a report value or a member of one
   new registry `SUGGESTION_KINDS` (kind -> `{ suggestion, derivedFrom }`), in a NEW module
   `explain-suggest.ts`, deliberately NOT in `ADMISSIBLE_INTERPRETATIONS`.
4. **Gap evidence untouched.** `gaps[]`, `survivors[]` and every existing field are byte-identical
   with or without `--suggest`; the section sits beside them, never inside a gap.
5. **Flag:** `lethal explain <report> --suggest` (boolean, owned by `explain` alone in FLAG_OWNERS).
   Combines with `--top` and `--project`; `--top` does not shorten `suggestions.gaps`, as it does
   not shorten `gaps`.
6. **Schema:** `suggestions` is an optional additive field, so explain stays v13 under the written
   rule. Its description says it is the opt-in, non-contractual suggestion section (R273).
7. **Docs:** the agent guide's explain section (the flag, the label, that kinds are derived from
   `reach` only and `undecided` is a real answer); CHANGELOG; R273 done.

## Tests (each red in its own direction)
- Default output (no `--suggest`) has no `suggestions` key and deep-equals today's (red: section
  always emitted). The existing banned-phrase and admissibility tests are not edited and still pass.
- With `--suggest`: everything outside `suggestions` deep-equals the default output (red: a field
  leaks into a gap).
- Each reach maps to its kind, and `not-decided` gives `undecided` with no suggestion (red per arm:
  swap two arms; map `not-decided` to a kind).
- Gap kind: one kind, `mixed`, all-`undecided` (red: first member wins).
- A reader-marked survivor is not suggested (red: drop the filter).
- `--suggest` on a report without gap ids refuses by name (red: emits `[]`).
- Every string in `suggestions` is a report value, the label, or a `SUGGESTION_KINDS` member (red: an
  inline string).
- CLI: `--suggest` parsed only for explain (another subcommand refuses it).
- The leaf registry gains the `$.suggestions.*` paths (tagged `[suggestion]`), reached by a test.

## Changes since r1 (review r1, opus spec-adversary; `/coord/handoff/R-273b/review-r1.md`). These
OVERRIDE the text above and below.
- **B1, kind from (`reach`, `attribution`), not `reach` alone.** `survivorReachOf` returns
  `unreached-and-uncovered` for `object` attribution too, where a test may well enter the procedure
  (coverage could not place the member). Kinds:
  - `reached-unnoticed` -> `check-the-result` (any attribution);
  - `covered-but-unreached` (`exact`) -> `cover-the-branch`;
  - `unreached-and-uncovered` + `all-green` -> `cover-the-code`;
  - `unreached-and-uncovered` + `object` -> `cover-the-statement`: the statement did not run in this
    mutant's runs; whether a test enters its procedure was not measured;
  - `not-decided` -> `undecided` (no text).
  Every text is scoped to "in this mutant's runs", never "at all" (`guardReached: false` is not
  proof of absence). `cover-the-branch` says "or the path is unreachable" (Q2). `check-the-result`
  says in its own fixed text that an equivalent mutant reads the same and that the grain is the
  statement (for every row, not only rows with `equivalenceRisk`, whose absence proves nothing); it
  still carries `equivalenceRisk` verbatim when present.
- **B2, every member listed.** A reader-marked survivor stays a member with `kind: "reader-marked"`
  and no text. Gap kind over the members: one kind -> it; several -> `mixed`; all `undecided` ->
  `undecided`; all `reader-marked` -> `reader-marked`. Invariant, as a runtime throw and a test:
  `suggestions.gaps[i]` has the same `gapId` and the same `members` codes in the same order as
  `gaps[i]`.
- **Ruling question, resolved without editing a policed test (option b).** `ExplainOutput` and
  `explain()` are NOT changed. A new `explain-suggest.ts` exports
  `suggest(report, out): ExplainSuggestions` and the type `ExplainSuggestedOutput = ExplainOutput &
  { suggestions }`; the CLI composes `{ ...explain(report, opts), suggestions }` only under
  `--suggest`. So the default output is unchanged BY CONSTRUCTION, and the leaf pin, the leaf-type
  list, the dead-entry list, the string admissibility and the banned-phrase tests are not edited.
  The new section gets its OWN leaf pin and string-provenance test in a new test file. The
  hand-written explain-v13 schema gains the optional root `suggestions` (its root is
  `additionalProperties: false`); optional additive, so no bump.
- **Joining rows.** Each member's row is found among `validated.mutants` by (`gapId`, the gap's
  `batchIndex`, `mutantCode`, verdict `survived`), never by code alone and never from
  `out.survivors` (cut by `--top`). Not exactly one row -> throw.
- **Label** (fixed, pinned): suggestions, not measurements; derived only from each survivor's `reach`
  and coverage `attribution`; cover the RECORDED survivors of each gap (on a narrowed or quarantined
  run, not the whole block); no-coverage blocks are outside this section.
- **A report with gap ids and no survivors** gives `suggestions.gaps: []`, a true empty, pinned by a
  test. Without gap ids `--suggest` still refuses by name.
- **CLI:** the section stays inside the one stdout JSON document; `--suggest` is owned by `explain`
  alone in FLAG_OWNERS and the agent guide's flag table (agent-contract test).
- **Tests added:** one per kind arm including `object` + `guardReached: false` -> `cover-the-statement`
  (red: mapped to `cover-the-code`); all-reader-marked gap (red: `members: []`); the members
  invariant (red: filter marked rows); member join under two batches with the same code (red: join
  by code); `--top 1` leaves `suggestions` complete (red: built from `out.survivors`).

## Changes since r2 (review r2: one blocker, `/coord/handoff/R-273b/review-r2.md`). OVERRIDE above.
- **`cover-the-code` is deleted.** `all-green` is produced only by `selectCoveringTests`' fallback 2,
  for table triggers coverage cannot see though tests do reach them, so it measures procedure entry
  no better than `object`. The table is now total over (`reach`, `ExplainAttribution`) and throws on
  any combination that cannot occur, never a default:
  - `reached-unnoticed` + any attribution -> `check-the-result` (the marker proves the statement ran);
  - `covered-but-unreached` + `exact` -> `cover-the-branch` (text: "the procedure, or one of its
    coverage arms");
  - `unreached-and-uncovered` + `object` or `all-green` -> `cover-the-statement`;
  - `not-decided` + any -> `undecided`.
  Tests: `object` and `all-green` with `guardReached: false` each -> `cover-the-statement`.
- **One derivation of `reach`.** The reach expression in `survivorOf` moves into an exported helper
  (a pure refactor, output unchanged, pinned by the existing explain tests) that both `survivorOf`
  and `suggest` call, so the `coverageMode: "none"` arm cannot be re-derived differently.
- **schemas.test.ts is edited, deliberately (not a test the ruling froze):** "the explain schema
  describes exactly the leaves ExplainOutput declares" re-roots on the suggested-output type
  (an interface extending `ExplainOutput` if `typeLeafPaths` cannot read `&`), with an `enumAt` pin
  on the kind domain. The version-notes comment says a later new kind value bumps (R233).

## Open questions for the reviewer (answered in r1: Q1 no, Q2 say both, Q3 yes)
Q1. Is `reach` alone enough, or should killed siblings in the block (`gap.killed > 0`) or
`unobservedBlock` change a kind? (My view: no. They are shown in the gap already; folding them in
adds rules without new measurement.)
Q2. `cover-the-branch` cannot tell an untested branch from an unreachable one. Say both in its text
(planned), or a separate kind? (No measurement separates them.)
Q3. Members only from `survived` rows; `no-coverage` blocks get no suggestion (they are already a
location list). Right?
