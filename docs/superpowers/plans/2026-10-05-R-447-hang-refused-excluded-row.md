# R-447 plan (r2): say in the report which loop-step sites R-196 refused

Branch `lethal/r447`, worktree `/work/lethal-wt/r447`, from master 776461b4.

## Changelog r1 -> r2 (adversarial review, verdict "adopt with changes")

- I1: added per-operator tests where an EARLIER check refuses and the hang check is non-null
  (5.1b), red-checked by replacing the split with the bare hang call.
- I2: dropped the whole-file de-duplication and its test (c). The row is pushed right after
  `visit`, like R144's declarative row, skipped only when `arms.kind === "undecided"`. New test
  (5.2c): a file whose only admitted-operator sites are hang-refused under `--operator` keeps
  its row.
- I3: FIXED HERE. `explain` withholds `unobservedBlock` for every gap in a file that has a
  `hang-refused` row with sites > 0 (2.6, test 5.5).
- I4: red-going tests for the inactive-`#if` clause and the `--lines` clause (5.2d, 5.2e).
- M1: removed the false "zero sites in every fixture" claim for loop-CONDITION refusals; the
  scope decision stays and is stated accurately (section 1).
- M2: reason renamed `hang-capable` -> `hang-refused` everywhere (reason, console line,
  `scoreDescribes` clause, mutation-elements text and `mutatorName`).
- M3: swap-additive's possible small over-count stated (2.2).
- M4: hang clause added to the barren-operator error (2.5, test 5.2f).
- M5: pre-commitment drafted with exact values for BOTH `itest:hang` legs:
  `/coord/handoff/R-447/2026-10-05-r447-hang-row-precommitment.md`.
- M6: CHANGELOG says plainly that `full` becomes rare on real projects (section 3, item 12).
- M7: the interface doc comment says plug-ins without `refusesHangCapable` are not counted.
- Everything the review said holds is unchanged: one decision function per operator, optional
  interface member, filters respected, no new `Caveat`, no version bumps, no sample regeneration.

## 1. What we add

One new `excludedSites` reason: **`hang-refused`**. Not `hang-capable`: that word already names
the per-mutant `hangCapable` tag and `hangCapableCount`, which mean something else (M2). One row
per file, with the count of refused sites. No per-site detail and no `detail` text. A row with
sites above zero makes `reliability` `narrowed`, the same way R399's rows do.

A "site" is one (node, operator) pair that an operator would have claimed if the hang check had
not refused it. This is the same unit `declarative` uses (one per spec), so two operators
refusing the same statement count as two. On `sandbox-hang` that is `Pending -= 1` at line 104:
one `remove-assignment` site and one `shift-integer` site, so the count is 2.

Only the refusals made by `hangCapableForMutatedNode` are counted. The R239 loop-CONDITION
literal refusals (`flip-boolean-literal`'s `isLoopCondition`, `shift-integer`'s
`inLoopCondition`) stay silent, like every other operator refusal. That is a scope decision, not
a claim that they are rare: `shift-integer`'s `inLoopCondition` refuses the `0` in
`until X.Next() = 0`, which occurs in `examples/gift-card` (`GiftCardMgt`, line 68),
`fixtures/sandbox-hang` (`HangLogic`, line 74) and four times in
`fixtures/sandbox-coverage-probe`. They stay out because they are refused on syntax before the
hang analysis runs (the split in 2.2 counts only nodes every earlier check admits), and this row
reports the hang analysis. If a reader needs them, that is a separate roadmap item. Neither
CHANGELOG nor the roadmap row may say these refusals have no sites.

## 2. Where the count comes from (one decision, not a second detector)

### 2.1 Interface

`MutationOperator` (`packages/engine/src/operator/interface.ts`) gains one optional member:
`refusesHangCapable?(node, ctx): boolean`. Optional, so plug-in operators are unchanged. No
operator-key whitelist exists, checked. Its doc comment says (M7): "An operator that does not
implement this is never counted. A plug-in that refuses hang-capable sites without it makes
those refusals invisible in `excludedSites`, and the run's `reliability` does not narrow for
them."

### 2.2 The four operators

Split each claim decision into "every check except the hang check" and the hang check.
`targets()`/`generate()` claim when the first passes and the hang check returns null.
`refusesHangCapable` returns true when the first passes and the hang check returns non-null.
Same function, same order, so the two cannot disagree about a node the first half admits.
- `remove-assignment.ts`: `targets()` body (rawKind, then `isStatementSlot`, then hang).
- `shift-integer.ts` (`shifted`), `swap-additive.ts` (`flipFor`), `flip-boolean-literal.ts`
  (`flipped`): the helper that ends in `if (hangCapableForMutatedNode(node, ctx) !== null)
  return null;` returns a tagged result (claim / hang-refused / no) instead of a second copy of
  the checks.

M3, stated: `swap-additive.generate` can still return `[]` after `flipFor` passes, when
`replaceOperatorToken` returns null. `refusesHangCapable` asks `flipFor` only, so a hang-refused
node whose token replacement would also have failed is counted, though it would never have
become a spec. This is a possible small over-count, bounded by such nodes (none known; the
census in section 6 counted post-`generate`, so its figures are unaffected). Not worth a second
`replaceOperatorToken` call in the refusal path; the operator's doc comment says so.

### 2.3 Generator

`generateMutationSet` (`packages/runner/src/orchestrator.ts`, the `visit` loop): when
`op.targets()` is false, ask `op.refusesHangCapable?.(node, ctx)`. Count it per file unless:
- the node starts in an inactive `#if` arm (compiled out, not refused): the same
  `startsInInactiveArm(inactive, node.startIndex)` test the spec path uses;
- the operator is not in `--operator`'s admitted set;
- the node is off every `--lines` range.
`--only`/`--exclude` files are never visited, so they need no clause.

### 2.4 The row (I2: no whole-file de-duplication)

Push `{ file, kinds: describeObjectKinds(root), sites }` RIGHT AFTER `visit`, beside R144's
declarative row and before the `specs.length === 0` bail, when the count is above zero. Skip it
only when `arms.kind === "undecided"`: that file's `preproc-undecided` row already stands for
every site in it, and with its arms unknown a count from it would be a guess.

No de-duplication against `not-instrumentable` or `instrumentation-refused` rows. r1's reason
was false: a hang-refused site never becomes a spec, so no other row's `sites` already counts
it, and `fileCount` counts distinct files, so two rows on one file do not inflate it. Two rows
on one file state two true things.

### 2.5 Barren-operator error (M4)

Track hang refusals per admitted operator per file (`Map<operator, Map<file, count>>`). In the
barren-operator throw (~`orchestrator.ts` 1136), add a clause the way R307's `refusedHere`
clause is added: for each barren operator with hang refusals, `"<op>" DID find site(s), but
every one writes a variable an enclosing loop's condition reads and was refused as hang-capable
(R196): <file> (<n>), ...`. Such an operator is then no longer described as matching no site.

### 2.6 Explain (I3: fixed here)

`explain.ts` (`withhold`, ~line 1267) reports `unobservedBlock` from `gaps.ts`'s "every recorded
row survived". In a file with a `hang-refused` row, the refused loop step has no row, so a block
can read "unobserved" while its loop step was never measured. Fix: build the set of files with a
`hang-refused` row and sites > 0 from `report.excludedSites` (absent on old reports: empty set),
and withhold `unobservedBlock` for a gap whose `r.file` is in that set. Per file, not per block:
the row has no spans. The field is already optional and already withheld on narrowed runs, so
there is no explain schema change and no `EXPLAIN_SCHEMA_VERSION` bump; one line in explain.ts's
version log comment says the field is now also withheld per file (R447).

## 3. Files to change (CLAUDE.md's ripple list)

1. `packages/engine/src/operator/interface.ts`: the optional member, with the M7 doc comment.
2. The four operators above. No operator version bump (the spec set does not change).
3. `packages/runner/src/orchestrator.ts`: count, filter, push the row (2.4), barren clause
   (2.5), pass `hangRefusedFiles` on `mutation-set-generated`, present only when non-empty (the
   R307 `refusedFiles` pattern, so an old stream folds to the same bytes).
4. `packages/runner/src/events.ts`: the optional `hangRefusedFiles?: readonly
   HangRefusedFile[]` field (`{ file, kinds, sites }`).
5. `packages/runner/src/excluded-sites.ts`: add `"hang-refused"` to `ExclusionReason`; an
   optional `hangRefused` input to `buildExcludedSites`, mapped field by field; fix the
   `fileCount` and `sites` doc comments (a hang row's file is usually ALSO a mutated file and
   may also carry a `not-instrumentable` or `instrumentation-refused` row; the count is
   post-filter and counts (node, operator) pairs).
6. `packages/runner/src/report-fold.ts`: read `e.hangRefusedFiles ?? []` and pass it on.
7. `packages/runner/src/report.ts`, `buildReport`: `hangRows = rows with reason hang-refused and
   sites > 0`; add `hangRows.length > 0` to `narrowed` (comment: R447); append
   `; N hang-refused site(s) in M file(s) not mutated` to `scoreDescribes`. `renderConsole`: one
   line, `HANG-REFUSED SITES: N site(s) in M file(s) write a variable an enclosing loop's
   condition reads; no mutant was made there (R196). They are absent from every count above.`
8. `packages/runner/src/mutation-elements.ts`: the per-file `Ignored` text says "they are not
   untested code", which is wrong here (the loop step is unmeasured). `hang-refused` gets its
   own sentence: `N mutation site(s) in this <kinds> write a variable an enclosing loop's
   condition reads, so LethAL made no mutant there (hang-refused, R196). They are unmeasured,
   not tested.` Its `mutatorName` uses `hang-refused`.
9. `packages/runner/src/explain.ts`: the per-file withhold (2.6).
10. `bun scripts/generate-schemas.ts`: regenerates `schemas/report-v3.schema.json` (one enum
    value) and `schemas/stream-v1.schema.json` (one optional event property).
11. `packages/runner/tests/schemas.test.ts`: the reason-enum pin (the R214 test) gains
    `"hang-refused"`.
12. `CHANGELOG.md` entry. It says plainly (M6): "Expect `reliability: full` to become rare on
    real projects. Measured: Microsoft BaseApp has 1,463 hang-refused sites and CDO Cloud 136,
    so any whole-project run over either now reads `narrowed`. That is the correct reading:
    those loop steps were never mutated, and until now the report did not say so." It names only
    the `hangCapableForMutatedNode` refusals and does NOT claim the loop-condition refusals have
    no sites anywhere (M1).
13. `docs/roadmap/R447.md` `done (<commit>)`, then `bun scripts/roadmap-index.ts`; run
    `bun test scripts/line-citations.test.ts` before submitting it.
14. `packages/runner/itest/hang.itest.ts` and the committed pre-commitment (section 6).

**No new `Caveat`.** A new caveat value moves `EXPLAIN_SCHEMA_VERSION` to 12 (R233 rule) plus a
new `explain-v12` schema, `CAVEAT_INTERPRETATIONS`, and the counts in
`interpretation.test.ts`/`report.test.ts`. The narrowing is stated in `scoreDescribes`, which
explain copies verbatim. If the reviewer wants a caveat, that is the cost.

## 4. Does the schema move?

- Report schema: **the file moves, the version does not.** The new enum value is regenerated in
  place. Precedent: R307 added `instrumentation-refused` this way (65d0b713). `excludedSites` is
  optional and not root-required. Old reports still validate (a value added, none removed).
- Stream schema: one optional property, regenerated in place, no `STREAM_SCHEMA_VERSION` bump.
- Explain schema: no change (2.6).
- Sample reports: **no regeneration.** No committed sample (gift-card) has a hang-refused site
  (measured: 0), so none gains a row, and each still validates.
- `report-equality` snapshot: expected unchanged. If it moves, that is a finding, not a snapshot
  update.
- `IDENTITY_SCHEME`: no. `EXPLAIN_SCHEMA_VERSION`: no. Report version: no (R307/R399 precedent).

## 5. Tests, each direction red-going, each red-check reported

1. Operators (`packages/builtin-tier1/tests/loop-hazard.test.ts` or each operator's test):
   a. `refusesHangCapable` is true at R-196's refused node and false at the claimed sibling in
      the same loop and at a non-candidate. Red-check: make the hang branch return false.
   b. (I1) Per operator, a node where an EARLIER check refuses AND
      `hangCapableForMutatedNode(node, ctx)` is non-null (the test asserts that too, so the case
      cannot pass vacuously); `refusesHangCapable` must be false:
      - swap-additive: `while S <> '' do S := S + 'x';` with `S: Text` (type check refuses);
      - shift-integer: `I := 2147483647` inside `while I <> 0 do` (`AL_MAX_INTEGER` refuses);
      - remove-assignment: an `assignment_statement` not in a statement slot whose target the
        loop condition reads (the implementer finds the shape; if no AL shape parses that way,
        say so in the test file and drop only this case);
      - flip-boolean-literal: a ceded `Insert(true)` run-trigger flag whose result feeds the
        loop's condition variable (`isCededRunTriggerFlag` refuses).
      Red-check: replace the split with the bare `hangCapableForMutatedNode(node, ctx) !== null`
      in each operator; each case goes red.
2. Generator (new `packages/runner/tests/r447-hang-refused.test.ts`, `generateMutationSet` on a
   temp project):
   a. A file with `while Pending > 0 do Pending -= 1;` yields one `hang-refused` row with
      `sites: 2`; a loop-free file in the same project yields NO row. Red-check: stop calling
      `refusesHangCapable`.
   b. `--operator lethal.negate-conditional` (with a deployable site, so not barren) yields no
      row. Red-check: drop the operator-filter clause.
   c. (I2) `--operator lethal.remove-assignment`: file A's only remove-assignment site is
      hang-refused (its spec list is empty, so the loop `continue`s), file B has a deployable
      remove-assignment site (so the run is not barren). File A's row survives with `sites: 1`.
      Red-check: move the push after the `specs.length === 0` bail.
   d. (I4) A refused loop step inside an inactive `#if` arm yields no row; the same file with
      the symbol defined yields the row. Red-check: delete the inactive-arm clause.
   e. (I4) `--lines` covering only a line away from the loop step yields no row; a range
      covering the loop step yields the row. Red-check: delete the `--lines` clause.
   f. (M4) `--operator lethal.remove-assignment` on a project whose ONLY remove-assignment sites
      are hang-refused throws, and the message names the hang clause with file and count.
      Red-check: delete the clause.
3. Report (same file, shaped like `r399-narrowing.test.ts`): a `hang-refused` row with sites > 0
   gives `reliability: narrowed` and the `scoreDescribes` clause; NO row gives `full` and no
   clause; a hand-built row with `sites: 0` does not narrow. Red-checks: remove the `narrowed`
   clause -> positive red; drop `sites > 0` -> zero-site test red.
4. Wiring: `report-fold.test.ts` gets one row through the fold (event -> `excludedSites`), and
   `mutation-elements.test.ts` one `Ignored` entry with the new text. Run `wiring-completeness`.
5. (I3) Explain: a report with a `hang-refused` row (sites > 0) for file A and survived-only gaps
   in files A and B: A's gap has no `unobservedBlock`, B's has `unobservedBlock: true`.
   Red-check: delete the per-file clause -> A's gap carries the field, red. A report with no
   `excludedSites` keeps today's output (control).

## 6. Fixture counts and gate impact (measured)

Census: the real operators vs the same operators with `hangCapableForMutatedNode` mocked to
null, pre-dedup, post-`validateSpec`/`isMutableSite`, all `#if` arms (scratch script, nothing
committed).

| project | hang-refused sites | file |
| --- | ---: | --- |
| `fixtures/sandbox-hang` | **2** | `src/HangLogic.Codeunit.al` (remove-assignment 1, shift-integer 1) |
| sandbox-app, -data, -symbols, -layout, -harden, -multiobject, -coverage-probe, -probes | 0 | |
| `examples/gift-card`, `examples/credit-limit` | 0 | |

These are hang-check refusals only. The loop-CONDITION refusals of section 1 are not in this
table, and they are not zero on gift-card, sandbox-hang or sandbox-coverage-probe.

**No frozen gate figure moves.** No mutant is added or removed anywhere (same spec set), so every
per-mutant baseline, count, `groupedCalls`, `warmKills` and `killPosition` is unchanged. No itest
asserts `reliability`, `scoreDescribes` or `excludedSites` reasons on `sandbox-hang`; the only
`reliability` assertion (`verify-agreement.itest.ts`, `full`) is on `sandbox-harden`, which has 0.

`itest:hang` gains assertions on BOTH legs (`assertOnLeg` and `assertOffLeg`), with exact values
pre-committed in `/coord/handoff/R-447/2026-10-05-r447-hang-row-precommitment.md`. The
implementer commits it unchanged as `docs/superpowers/specs/2026-10-05-r447-hang-row-precommitment.md`
BEFORE the live run. Then one live `itest:hang` (both legs, host). No other gate needs a run:
zero hang-refused sites on their fixtures, so nothing they read can move.
