# R-286: close R286 as a ruling, move R287's last case to R304, and pin the slot list against the grammar (R217) — short plan r3

**r3 (gpt-6.1-sol round 2, `/coord/handoff/R-286/sol-review-r2.md`; the last round), applied on top of r2 below:**
1. **Candidates** = every `(container, field)` and `container.children` whose allowed types include a `*_statement` kind, PLUS `preproc_guarded_statement.children`, listed by name: it carries only expression statements, so the type rule cannot see it. `preproc_split_call_statement.children` is NOT a candidate: it holds call fragments, not statements.
2. **Four classes,** each candidate in exactly one:
   - `SLOT` (`SINGLE_STATEMENT_SLOTS`);
   - `STATEMENT_LIST` (`statement_block`, `block`);
   - `CONDITIONAL` (`preproc_conditional_statement.children`, supported when the wrapper is itself in list position, per `isStatementPosition`);
   - `NOT_A_SLOT` (reason plus item), split into **unsupported** (`with` = R286 ruling, `asserterror` = R216, the split-`if` block containers, `preproc_fragmented_else_tail` and `preproc_guarded_statement` = R304 or a new item filed now) and **not executable** (declaration containers such as `declaration_body`, which qualify only through `empty_statement`; no item needed).
3. **Freshness:** `build-native-parser.ts` checks BEFORE its early returns. It compares the crate `node-types.json` sha256 AND regenerates the candidate list in memory, and refuses on any difference, so a hand-deleted candidate is caught too. Hosted CI runs this script on every build (`.github/workflows/ci.yml`), and release builds run it as well. Local `verify.ts` does not, which is stated.
4. **R286's ruling** says "deliberately unsupported", with the measured counts (0 in fixtures and CDO, 10 grep lines in the BaseApp corpus; DC's 8 are R286's own record) and no upper-bound claim: multi-line syntax can evade grep, and one body can hold several sites.

Task: `/coord/tasks/R-286/task.md`. Worktree `/work/lethal-wt/r286`, branch `lethal/r286`, from master 8c6dcf4b. r1 was reviewed by gpt-6.1-sol (`/coord/handoff/R-286/sol-review-r1.md`); r2 answers every point.

## Revisions (r1 to r2)

| sol finding | r2 |
|---|---|
| 1. Admitting `with` bodies requires an identity bump | `with_statement.body` is NOT admitted, so no key can move and no bump is needed |
| 2. Admitting the slot alone does not move guard placement: `findEnclosingStatement` uses `isStatementPosition` and skips `with_statement`, so the guard lands on the procedure | It is not admitted (see 1) |
| 3. "A child of `statement_block`" over-approximates: it includes expressions | Candidate = a `(container, field)` whose allowed types include a `*_statement` node kind. Every candidate is CLASSIFIED explicitly; none is admitted by rule |
| 4. Injected names (`MutationSelector`, the reach latch) can bind to a record field inside `with` | A second reason not to admit `with` bodies; recorded in the ruling |
| 5. A version-only freshness check passes a stale file | The committed file carries the sha256 of the crate's `node-types.json`; `build-native-parser.ts`, which must run on any grammar change and has Cargo access, refuses to finish when it differs |
| 6. Closing R287 must not imply C5/C6 corpus effects or the `empty-block` gap were validated | The R287 closing note says exactly what is closed and moves C7 (with its repros and counts) and the `empty-block` omission to R304 or a new item |

## 1. Measured

`with … do` statements, counted by grep:
- **0** in every gate fixture and example (one comment hit);
- **0** in the CDO copy at 5f2a71d;
- **10 lines** in the whole BaseApp history corpus (`/work/src/BC.History`).

`with` is obsolete in modern AL. DC is not on this machine, so R286's "DC: 8" is not re-measured; stated as a limit.

## 2. Changes

**(a) R286: close as a ruling, no code change.**

`with_statement.body` stays out of `SINGLE_STATEMENT_SLOTS`. Admitting it soundly would need four things:
- guard placement inside `with`, since `findEnclosingStatement` and `planPlacement` would otherwise wrap the whole procedure;
- protection of the injected `MutationSelector` and latch names against capture by the record's fields;
- the emptied-slot filler there;
- an identity scheme bump, because a newly admitted twin moves later keys.

All of that for at most about 10 sites in the corpus, and 0 on CDO and the fixtures. The pin records it as `NOT_A_SLOT` with this reason.

**(b) R217: the pin.**
- `scripts/statement-containers.ts` resolves the exact `tree-sitter-al` crate with `cargo metadata --manifest-path packages/engine/native/Cargo.toml` and reads its `node-types.json`. It writes `packages/engine/src/ast/statement-containers.json`, which holds the crate version, the file's sha256, and every candidate: each `(container, field)` and each `container.children` whose allowed types include a `*_statement` kind.
- In `tree-walks.ts`, an explicit `NOT_A_SLOT` map gives each excluded candidate its reason and item: `asserterror_statement.body` (R216), `with_statement.body` (R286 ruling), the split-`if` block containers and `preproc_fragmented_else_tail` (R304), and any other candidate the script lists that no item covers yet, under a new item filed now.
- A unit test reads only the committed JSON. Every candidate must be in `SINGLE_STATEMENT_SLOTS`, in the statement-position kinds (`statement_block`, `block`), or in `NOT_A_SLOT`. An unclassified candidate fails the test, naming it.
- `build-native-parser.ts` computes the sha256 of the crate's `node-types.json` and fails, naming the regeneration command, when it differs from the committed one. A grammar bump therefore cannot pass with a stale file.
- Runtime behaviour is unchanged: `isStatementSlot` keeps its explicit list, and nothing reads the grammar at runtime.
- **Limit, stated:** the pin works per container. It does not check context, such as a `#if` occupying an unbraced branch (the existing `isStatementPosition` doc comment).

**(c) R287: close it.** C5 and C6 were fixed in earlier commits; their corpus effects are as recorded there, and not re-validated here. C7 moves to R304, with its repros and counts copied over. The `empty-block` omission R287 notes moves to R304 or a new item, decided by reading it.

## 3. Identity and gates

No site is admitted or removed, so the mutant sets and keys are unchanged. The build confirms this with an empty capture diff (master vs branch, joined by file, span and operator, not by key) on every gate fixture and example. No live gate is needed. `verify.ts` and `compile:fixtures` do not apply, since no `.al` changes.

## 4. Tests

- **The pin test:**
  - green on the new tables;
  - red-check: delete one `SINGLE_STATEMENT_SLOTS` entry and the test names it;
  - red-check: delete one `NOT_A_SLOT` entry and the test names it.
- **The hash check:** red-check by editing one byte of the committed sha256, so `build-native-parser.ts` refuses.
- **No behaviour change:** the capture diff is empty.
