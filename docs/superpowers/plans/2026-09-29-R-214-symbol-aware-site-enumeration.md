# R-214: site enumeration honours the build's preprocessor symbols Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3.** Corrects r2's task instructions and tests per the orchestrator's ruling "Orchestrator, 2026-09-30: plan r2 reviewed" in `H:/lethal-coord/tasks/R-214/task.md` (binding) and its review `H:/lethal-coord/reviews/R-214-plan/review-r2.md`. The design r2 set out is accepted and is not re-opened. r2 is commit `f069033d` of this file (frozen copy: `H:/lethal-coord/reviews/R-214-plan/plan-r2.md`). Every code fact r3 touches was re-read on this branch at `f0fe038a` (master `17ac3388` merged in): `IDENTITY_SCHEME = 3` on both, the report schema is v3 (`schemas/report-v3.schema.json`, `REPORT_SCHEMA_VERSION = 3`, v2 frozen), the explain schema is v6. r3's probes live in `H:/lethal-scratch/R-214/plan-r3/` (`$T` below): `scheme-race.sh` (C1's check, run against this branch: `pre` prints `OK: Task 2 sets N=4`, `post` prints `RACE`, as it must before Task 2) and `r321-key-diff.txt` (I8's diff, read from the committed baselines).

## Revision r3: what changed, correction by correction

| correction (task.md, 2026-09-30) | where r3 addresses it |
| --- | --- |
| **C1** scheme race, blocking, before product code and before handoff | Decision 4 ("The scheme race"); Global Constraints (the check after every master merge from Task 2 on); Task 2 Step 0 (`pre`, before the first product commit); Task 2 Step 6 (the re-bump procedure: constant, CHANGELOG, harden marks file, agent guide together, then the transition, capture and gate re-runs); Task 11 Step 4 (`post`, blocking, before `coord submit`). The exact commands are in Task 2 Step 0 |
| **I2** transition tests on the OLD engine's L13 key; red-check against the pre-committed starting scheme | Decision 4 ("The transition tests"); Task 1 Step 5b (commits `before/fixture-sandbox-symbols.txt`, master's own capture, and `before/scheme.json`, the starting scheme); Task 8 Step 1 (`oldEngineKey`, `oldEngineRun`: a record written through the store API with master's L13 key and line, never a relabelled new-engine run; `storedRun` no longer takes a scheme); Task 8 Step 7 (f) and Task 2 Step 4 (revert to the starting scheme `S`, not `IDENTITY_SCHEME - 1`); Global Constraints (the literal rule) |
| **I3** fresh full twin and fresh `presence.ts` from the AFTER capture; `UNCLASSIFIED = EXTRA = 0`; that result to `--listing` | Task 9 Step 4 (the full command block); Task 1 Step 2 (`presence.ts` always prints both counts); Decision 6 ("The committed corpus listing", last paragraph) |
| **I4** after-change RSS with exactly master's flags, its own run | Task 9 Step 4 (run (1), output discarded) and Step 5 (reads that run only); Decision 6 ("Peak memory gate") |
| **I5** zero-site undecidable file keeps a `preproc-undecided` row, `sites: 0`, pinned apart from `p12-refused` | Decision 2 (refusal paragraph); Task 6 Step 3 (no `specs.length > 0` condition); Task 6 Step 1 (test "a refused file with NO site still gets its row"); Task 6 Step 8 (h); Task 7 Step 1 (Run 1 exact rows, Run 2) and Step 5 (e) |
| **I6** project-relative paths `src/Refused.Codeunit.al`, `src/Plain.Codeunit.al` | Task 6 Step 1 and Task 7 Step 1 (exact assertions, after normalising `\` to `/`, because `readdir` on Windows returns `src\...`, measured) |
| **I7** `schemas/report-v3.schema.json` only; v2 frozen | File structure; Task 7 Files and Step 3.7 (the expected generated diff, and `git diff --exit-code schemas/report-v2.schema.json`) |
| **I8** pre-committed NORMALIZED-KEY diff of both R321 baselines | Decision 7 ("The baseline diff, by key"); Task 1 Step 10 (the spec pins it); Task 10 Step 4 (checked key by key; the per-line table check stays in Step 2) |
| **Minor a** a named Caveat for a refused file, with its interpretation and count updates | Decision 9; Task 7 (Files, Step 1 runs 1 to 3, Step 3.11, Step 5 (d) and (e)): `preproc-files-refused`, `CAVEAT_INTERPRETATIONS`, `interpretation.test.ts` and `report.test.ts` 20 to 21 (both measured at 20 today), and the explain schema v6 to v7 that R233's pin requires (precedent: R-236c, `87faa6ac`) |
| **Minor b** runner-level test for legal bare `#if and` | Task 6 Step 1 (test "a legal bare `#if and` refuses its file", red-checked by Step 8 (i)) and Task 7 Step 1 (run 1: `unparsed-condition at line 5`, no mutant from the file, its counted report row) |
| **Minor c** no "before any backend call" claim for the marks warning | Task 8 Step 4, last bullet (the warning is computed after `buildSymbols`, which is after `backend.status()`; the symbol read is not moved earlier) |
| Approvals (1) to (4) | Recorded, no change needed: (1) Decision 6 with I3's fresh computation; (2) Decision 2 with minor b's test; (3) and (4) Decision 5. r2's two open questions are answered, so that section now says so |

---

**Revision r2 (2026-09-29).** Written by `lethal-preproc` (coord-only lane) on `lethal/lane-preproc` at `ba4ebabe` (master merged in). r1 is frozen at `H:/lethal-coord/reviews/R-214-plan/plan-r1.md`; its review is `H:/lethal-coord/reviews/R-214-plan/review-r1.md`; the rulings are in `H:/lethal-coord/tasks/R-214/task.md` ("Orchestrator, 2026-09-29" and its Addendum). No product code was written or prototyped. r1's tools live in `H:/lethal-scratch/R-214/plan/` (`$P` below); r2's new probes live in `H:/lethal-scratch/R-214/plan-r2/` (`$Q` below). Task 1 turns the predictions into the committed PRE-COMMITMENT, alone, before any product code.

## Revision r2: what changed, finding by finding

| finding | ruling (task.md) | where r2 addresses it |
| --- | --- | --- |
| **C1** cross-symbol carry | scope history and resume to the identical effective symbol set, refused by name; pin a marks rule; same-key different-site tests with controls, red-checked | Decision 5 (the rule); Task 8 (store column, history, `--resume last`, `--resume-run`, marks, verify); Task 8 Steps 1 and 6 (tests on the measured L13/L15 key, each with a control); Task 8 Step 7 (red-checks) |
| **C2** undecided expressions | evaluate with alc's precedence, measured; still undecidable means refuse the whole FILE, warned and counted; no known-uncertain arm scored | "alc's precedence, measured" table (plan time, 99 compiles); Decision 2 (a text parser with alc's grammar, never the tree's expression nodes); Decision 2's refusal list; Task 4 (the table as test data); Task 6 (whole-file refusal); Task 7 (counted in `excludedSites`) |
| **I3** narrow the claim | say what "no active site lost" covers; C7, R304, R343 stay open as named exclusions; R214 closes NARROWED | Goal (narrowed); Decision 1 (six named exclusions); Decision 6 (every exclusion is measured and classified per corpus, not assumed); Task 11 Step 1 (R214 status `open, narrowed`) |
| **I4** transition tests for four paths | scheme N-1 to N for history, `--resume-run`, `--resume last`, marks, on the L13/L15 key, each with a current-scheme control; pinned to `IDENTITY_SCHEME` and `IDENTITY_SCHEME - 1` (Addendum) | Decision 4; Task 8 Step 1 (eight tests); Task 2 (no literal scheme numbers in new tests) |
| **I5** durable corpus listing, presence and absence | per-file, per-mutant listing, no source text, committed | Decision 6 ("The committed corpus listing"); Task 1 Steps 6 to 9; Task 9 Step 4 (the check reads only committed files) |
| **I6** `appJsonSymbols` read errors | only a missing file means none; other errors throw; validate like configured symbols; red-check the error path | Decision 3; Task 3 (a shared validator, `ENOENT` only); Task 3 Step 5 (red-checks (c) and (d)) |
| **I7** no crash, then RAM | skip the walk for files without directive tokens; pre-commit a peak-RSS gate | Decision 2 (the text pre-check is the skip); Task 4 test "a file with no directive line is never walked"; Decision 6 ("Peak memory gate"); Task 1 Step 7 (master peaks); Task 9 Step 5 (the gate) |
| **I8** gates not re-run | list them, re-record none, test the C02 harden marks file under the new scheme | Decision 10 (the list); Task 2 Step 2 (harden marks file); Task 8 Step 5 (the harden mark test) |
| Minor: `assertSymbolBuild` message | point at the new pre-commitment | Task 10 Step 1 |
| Minor: red-check error path and same-text transitions | | Task 3 Step 5; Task 8 Step 7 |
| Minor: warning is not a durable account | counted `excludedSites` reason | Task 7 (Q1) |
| **Q1** warning or report field | both: counted `compiled-out` reason in `excludedSites`, keep the warning, follow the ripple list | Decision 9; Task 7 (every file on CLAUDE.md's ripple list, in order) |
| **Q2** read `app.json` | yes, unioned, from the snapshot | Decision 3; Task 3; Task 6 Step 3 |
| **Q3** `placeReach` | no change for the specified shape | Decision 1 (unchanged from r1) |
| **Q4** R321 re-freeze | separate owner-approved step before either baseline is deleted | Decision 7; Task 10 Steps 3 and 4 |

Other r2 changes: master moved (`ba4ebabe`); every code fact cited below was re-read there. R-318 has not merged; IDENTITY_SCHEME is still 3 on master, so the plan says "the next scheme" throughout. r1's `p9-undecided` is gone: its expression is decidable under alc's measured precedence, so it becomes `p9-precedence`. Two repros are new: `p12-refused` (a file that must be refused whole) and `p13-exclusions` (one repro per named exclusion). The `ATTR` ruling for `p11-tier2` is unchanged.

**Goal:** A mutant is never generated in a `#if` / `#elif` / `#else` arm that the build's effective preprocessor symbols compile out, for every directive container the grammar has. A file whose directives LethAL cannot evaluate exactly as `alc` does is not mutated at all, and that refusal is named in a warning and counted in the report. A statement directly inside an active arm of a statement-level `#if` that sits in a statement list is a mutation site like any other statement. **Not covered, named, and left open:** a `#if` in a single-statement slot, R287's C7 (`preproc_fragmented_else_tail`), R304's split-block statements, R305 (`preproc_split_declaration`), R339 (a split that the grammar turns into `ERROR`) and R343 (typed operators in a wrapped object). Each is measured per corpus by Task 1 and pinned as a count.

**Architecture:** One evaluator in `@lethal/engine` (`evaluateArms`) takes a file's tree and its text. It first checks the text for a directive line and returns at once when there is none, so a directive-free file costs one regex scan and no walk. Otherwise it collects the directive MARKER nodes in document order, checks their number against the directive lines in the text, and evaluates each condition by parsing the marker's TEXT with a small parser that follows `alc`'s measured grammar (never the tree's expression nodes, which scope `not` differently). It returns the byte ranges the build compiles out, or "undecided" with a reason code. `generateMutationSet` drops every spec that starts in such a range, and drops every spec of an undecided file. The effective symbol set is the config's `preprocessorSymbols` unioned with `app.json`'s (from the source snapshot), with each file's own `#define` / `#undef` applied, which is what `alc` does (measured). History, resume and equivalence marks are scoped to runs with the identical effective set, recorded on every run row. Separately, `isStatementPosition` treats a direct child of a `preproc_conditional_statement` that itself sits in a statement list as a statement position. `IDENTITY_SCHEME` moves to the next scheme, because both halves move identity keys for unchanged source (measured).

**Tech Stack:** Bun, TypeScript, tree-sitter-al 4.4.1 through the native parser addon, `bun:test`, `alc` 18.0.41.45789 (offline compile, `~/.vscode/extensions/ms-dynamics-smb.al-18.0.2732683/bin/alc.exe`; the multi-platform `bin/win32/` layout is not installed, probed), al-runner (the symbol legs), BC container Cronus28 under a coord lease (bcdev, tables, chunked gates).

**Spec:** `H:/lethal-coord/tasks/R-214/task.md` (binding) and `H:/lethal-coord/tasks/R-214/audit.md` (measured state). Items: `docs/roadmap/R214.md`, `R285.md`, `R287.md`, `R304.md`, `R305.md`, `R306.md`, `R325.md` (the identity scheme rule), `R339.md`, `R342.md`, `R343.md`. The frozen gate this changes: `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`.

---

## What was measured at plan time

### alc's precedence, measured (r2, alc 18.0.41.45789, `$Q/prec/`)

**Method.** `$Q/prec/probe.sh <id> <defines> <file> [app.json symbols]` writes a runtime-16 project with no dependency and compiles it. Every arm of a probe is `exit(ARM<n>);`, and no `ARM<n>` exists, so `alc` reports `AL0118 The name 'ARM<n>' does not exist` for exactly the arms it BUILT and for no other. One compile therefore names the built arms. Any other error code is printed. The battery is `$Q/prec/battery.sh` and `battery2.sh` (commands and every case file are there); outputs `$Q/prec/battery.txt` and `battery2.txt`. A two-arm probe is `#if <cond>` / `exit(ARM1);` / `#else` / `exit(ARM2);` / `#endif` inside a procedure. One harness note: `TRUE-lit`, `True-lit` and `true-lit` share one case file on this case-insensitive file system; each probe ran right after its own file was written, so each result stands, but the file on disk holds only the last.

| # | condition (or shape) | `/define` | alc built | what it pins |
| ---: | --- | --- | --- | --- |
| 1 | `A` | `A` / none | ARM1 / ARM2 | baseline |
| 2 | `A` | `a` | ARM2 | symbols are case-SENSITIVE |
| 3 | `NOT A`, `Not A` | `A` / none | ARM2 / ARM1 | keywords are case-insensitive |
| 4 | `A AND B`; `A Or B` | `A,B` / `A`; `B` / none | ARM1 / ARM2; ARM1 / ARM2 | the same |
| 5 | `UNDEFINEDSYM` | none | ARM2 | an undefined symbol is false, no error |
| 6 | `CLEAN_27x` | `CLEAN_27x` / none | ARM1 / ARM2 | underscores and digits in a symbol |
| 7 | `A or B and C` | `A`; `B,C`; `C` | ARM1; ARM1; ARM2 | `and` binds tighter than `or` |
| 8 | `A and B or C` | `C`; `A` | ARM1; ARM2 | the same |
| 9 | `not A and B` | none; `A`; `B`; `A,B` | ARM2; ARM2; ARM1; ARM2 | `not` takes the next operand only: `(not A) and B`. The tree reads `not (A and B)`, which would build ARM1 with no define |
| 10 | `not A or B` | none; `A,B`; `B` | ARM1; ARM1; ARM1 | `(not A) or B`; the tree's `not (A or B)` would build ARM2 under `A,B` |
| 11 | `A and not B or C` | `A,B,C`; `A` | ARM1; ARM1 | `(A and (not B)) or C`; the tree's `A and not (B or C)` would build ARM2 under `A,B,C` |
| 12 | `not not A` | `A` / none | ARM1 / ARM2 | `not` nests |
| 13 | `not (A and B)` | none / `A,B` | ARM1 / ARM2 | parentheses group |
| 14 | `(A or B) and C` | `A`; `B,C` | ARM2; ARM1 | parentheses override precedence |
| 15 | `((A))` | `A` / none | ARM1 / ARM2 | nested parentheses |
| 16 | `(A)and(B)`; `not(A)` | `A,B` / `A`; `A` / none | ARM1 / ARM2; ARM2 / ARM1 | no spaces needed around parentheses |
| 17 | `A and (B or not C)` | `A`; `A,C`; `A,B,C` | ARM1; ARM2; ARM1 | mixed |
| 18 | `true`, `TRUE`, `True`; `false`; `not true` | none | ARM1; ARM2; ARM2 | `true` / `false` are literals, case-insensitive |
| 19 | `true` | `true` | ARM1 | a literal, not a symbol |
| 20 | `X or false` | `X` / none | ARM1 / ARM2 | literal inside an expression |
| 21 | `and` (a bare keyword) | none | ARM2, no error | compiles, meaning unknown: **refused** (Decision 2) |
| 22 | `A // note` | `A` / none | ARM1 / ARM2 | a trailing `//` comment is ignored |
| 23 | `!A` | none | `AL0629`, `AL0631` | not AL syntax |
| 24 | `A && B`; `A \|\| B` | | `AL0631` | not AL syntax (the grammar accepts them) |
| 25 | `A == B` | | `AL0629` | not AL syntax |
| 26 | `A and`; `A or`; empty `#if`; `#elif` with no condition | | `AL0629` | incomplete |
| 27 | `A B`; `1A` | | `AL0631`; `AL0629`, `AL0631` | not one expression |
| 28 | `#if A` / `#elif B` / `#elif C` / `#else` (ARM1..4) | none; `A`; `B`; `C`; `B,C`; `A,C` | ARM4; ARM1; ARM2; ARM3; ARM2; ARM1 | the first true arm is built, only it |
| 29 | `#if A` { `#if B` ARM1 `#else` ARM2 `#endif` } `#else` { `#if B` ARM3 `#endif` ARM4 } `#endif` | none; `A`; `B`; `A,B` | ARM4; ARM2; ARM3 ARM4; ARM1 | nesting: an inner arm counts only inside a built outer arm |
| 30 | `#elif` after `#else`; `#if` never closed | | `AL0623` | unbalanced |
| 31 | `#endif` with no `#if` | | `AL0624` | unbalanced |
| 32 | `#IF` / `#Else` / `#ENDIF`; indented directives; `# if` / `# else` / `# endif` | `A` | ARM1 | directive keywords are case-insensitive; leading blanks and a blank after `#` are allowed |
| 33 | `#else // c` and `#endif // c` | none | ARM2 | a comment after `#else` / `#endif` is ignored |
| 34 | `#endif A` | | `AL0631` | text after `#endif` is an error |
| 35 | `exit(ARM1); #if A` (a directive after code on one line) | | `AL0620` | a directive must start its line |
| 36 | `#define L` at the top of the file, `#if L` | none | ARM1 | a file-level define counts |
| 37 | `#undef L` at the top, `/define:L` | `L` | ARM2 | a file-level undef removes a configured symbol |
| 38 | `#undef L` at the top, `app.json` declares `L` | none | ARM2 | it removes an `app.json` symbol too |
| 39 | `#define l` at the top, `#if L` | none | ARM2 | defines are case-sensitive |
| 40 | `#if Q` / `#define L` / `#endif` at the top | none / `Q` | ARM2 / ARM1 | a define in a compiled-out region is not applied; in a built one it is |
| 41 | `#define L` / `#define M` / `#undef L` at the top, `#if L` | none | ARM2 | applied in order |
| 42 | `// comment`, then `#define L` | none | ARM1 | a comment before a define is allowed |
| 43 | `#region R` / `#define L` / `#endregion` | none | ARM1 | a define inside a region is allowed |
| 44 | `#define L // why` | none | ARM1 | a trailing comment on a define is ignored |
| 45 | `#define L M` | | `AL0631` | one symbol per define |
| 46 | `#define L` inside a procedure; `#define L` after a whole object | | `AL0625` | a define after the first token is an error |
| 47 | `app.json` `L`, `/define:M`, `#if L and M` | `M` | ARM1 | `app.json` and `/define` are UNIONED |
| 48 | `app.json` `L, M`, `#if L and M` | none | ARM1 | `app.json` alone |
| 49 | `/*` / `#if A` / `*/` ... `/*` / `#endif` / `*/` | none | ARM1, no error | a directive line inside a block comment is not a directive |

r1's own measurements (`$P/sym/`: case sensitivity, `AL0631` for `&&` and `||`, `and` over `or`, `not` binding, no predefined `CLEAN*` / `CLEANSCHEMA*` / `BC28` symbol, `app.json` read and unioned, file-level `#define` / `#undef`) are all reproduced above by independent probes, so they are not repeated.

**The grammar this implies**, which Decision 2 implements and nothing else:

```text
condition := or
or        := and ( "or" and )*
and       := unary ( "and" unary )*
unary     := "not" unary | primary
primary   := "(" or ")" | "true" | "false" | symbol
symbol    := [A-Za-z_][A-Za-z0-9_]*   (not "and", "or", "not"; compared case-sensitively)
keywords  := and, or, not, true, false (case-insensitive)
```

### What tree-sitter-al 4.4.1 does with the same text (r1 `$P/cond.ts`, r2 `$Q/tree/markers.ts`)

The grammar's condition nodes scope `not` wider than alc (rows 9 to 11): `#if not A and B` parses as `(preproc_not_expression (preproc_and_expression A B))`. So the product reads a condition from the marker's TEXT, never from those nodes. The marker nodes themselves are sound for every shape above that alc accepts (`$Q/tree/markers.ts` over the case files): `# if A`, indented directives, `#IF` / `#Else` / `#ENDIF`, `#if True`, `#if (A)and(B)`, `#if not(A)`, a trailing `//` comment, and a file-level `#define` each give one marker per directive line. A `preproc_if` marker's text is the whole line, including its newline (`"#if not A and B\n"`); a `preproc_else` or `preproc_endif` marker stops before a trailing comment. The block-comment case (row 49) gives ZERO markers for two directive-looking lines, which matches alc; the cross-check in Decision 2 refuses that file rather than guess.

**Container shapes** (r1, unchanged): every visible rule that holds a marker holds `preproc_if` and `preproc_endif` as direct children, except `preproc_split_if_then_begin_else_shared` (an `#if` with no `#endif` inside it) and `preproc_fragmented_else_tail` (an `#endif` with no `#if`). So the evaluator walks markers in document order over the whole file, never per container.

### The corpora's directives, re-measured (r2, `$Q/tree/corpus-check.ts`, output `$Q/tree/corpus-check.txt`)

One file at a time: count the directive lines in the text (`^[ \t]*#[ \t]*(if|elif|else|endif|define|undef)\b`, case-insensitive, after stripping a leading BOM), parse, count the marker nodes, and list every condition's shape with each symbol replaced by `S`.

| corpus | root | `.al` files | files with a directive line | markers | text / tree mismatches | condition shapes | peak RSS |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| DC | `U:/Git/DC/Cloud` | 1135 | 88 | 551 | 0 | `not S` 199, `S` 59 | 136 MB |
| System Application | `U:/Git/BC.History/System Application` | 1718 | 54 | 226 | 0 | `not S` 109 | 130 MB |
| BusinessFoundation | `U:/Git/BC.History/BusinessFoundation` | 104 | 20 | 40 | 0 | `not S` 20 | 92 MB |
| BaseApp | `U:/Git/BC.History/BaseApp` | 9620 | 671 | 4983 | 0 | `not S` 2364, `S` 50 | 198 MB |

Two corrections to r1: r1 counted BusinessFoundation 19 and BaseApp 666 files with `#if`, because six files start with a BOM directly followed by `#if` and r1's line match missed them. A first r2 run without the BOM strip reported exactly those six as mismatches, which is how the product's check must read the text too (Decision 2). No corpus has a compound condition, a literal, a `#define` or a `#undef`, and no corpus file would be refused.

### The repros and what master does with them (r1, unchanged except where marked)

Hand-written, invented names. `$P/repro/<name>/` holds `app.json` (runtime 16, no dependency), the AL, and `symbol-sets.json`. Every r1 repro compiles un-instrumented under every set (`$P/alc-plain.sh`, 25 of 25 builds, 0 errors).

| repro | shape | sets | master deployed |
| --- | --- | --- | ---: |
| `p-r214` | R214's own: a whole procedure in `#if CLEAN25` / `#else`, and a statement-level `#if CLEAN25` / `Helper(A);` / `#else` / `Helper(A + 1);` | `[]`, `[CLEAN25]` | 7 |
| `p-r285` | R285's split case label (`preproc_split_case_extended`), `#if FASTPATH` | `[]`, `[FASTPATH]` | 7 |
| `p-r306` | R306 case 3: `#if not SYM` around one assignment | `[]`, `[SYM]` | 5 |
| `p-r306b` | the same with an `#else` arm | `[]`, `[SYM]` | 6 |
| `p5-elif-nested` | `#if A` (holding a nested `#if B` / `#else`) / `#elif B` / `#else` | `[]`, `[A]`, `[B]`, `[A,B]` | 7 |
| `p6-define` | `#define LOCALSYM` and `#undef DROPSYM` at the top of the file | `[]`, `[DROPSYM]` | 2 |
| `p7-appjson` | `app.json` declares `APPSYM`; `#if APPSYM` / `#else` | `[]` | 2 |
| `p8-slot` | a `#if` in an un-braced `then` slot | `[]`, `[SLOTSYM]` | 5 |
| `p9-precedence` (r2, replaces `p9-undecided`) | row 9, 7 and 18's shapes, below | `[]`, `[UA]`, `[UB]`, `[UA,UB]`, `[UB,UC]` | Task 1 |
| `p10-case` | `#if Foo`, config `FOO` or `Foo` | `[]`, `[FOO]`, `[Foo]` | 2 |
| `p11-tier2` | a table and a codeunit: `Commit();` then `#if T2SYM` / `Rec.SetRange(Code, C);` / `Codeunit.Run(50013);` / `#else` / `Rec.Amt := 5;` / `Rec.Modify(true);` | `[]`, `[T2SYM]` | 7 (raw 8) |
| `p12-refused` (r2, new) | two files, below: one refused whole, one ordinary | `[]`, `[R12SYM]` | Task 1 |
| `p13-exclusions` (r2, new) | one file per named exclusion (C7, R304, R343), below | `[]`, `[P13SYM]` | Task 1 |
| `fixtures/sandbox-symbols` | the R321 fixture | `[]`, `[LETHALA]`, `[LETHALB]` | 13 |

`p9-precedence/src/Precedence.Codeunit.al`:

```al
codeunit 50009 "P9 Precedence"
{
    procedure Run(X: Integer)
    begin
#if not UA and UB
        Helper(X);
#else
        Helper(X + 1);
#endif
#if UA or UB and UC
        Helper(X + 2);
#endif
#if TRUE
        Helper(X + 3);
#else
        Helper(X + 4);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
```

`p12-refused/src/Refused.Codeunit.al` (the directive lines sit in block comments, so alc builds everything and the tree has no marker for them; Decision 2 refuses the file):

```al
codeunit 50012 "P12 Refused"
{
    procedure Run(X: Integer)
    begin
/*
#if R12SYM
*/
        Helper(X + 1);
/*
#endif
*/
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
```

`p12-refused/src/Plain.Codeunit.al`:

```al
codeunit 50013 "P12 Plain"
{
    procedure Run(X: Integer)
    begin
#if R12SYM
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
```

`p13-exclusions/src/ElseTail.Codeunit.al` (R287's C7 input, renamed symbol), `SplitBlock.Codeunit.al` (the audit's `b/r304-sym`, renamed symbol) and `Wrapped.Codeunit.al` (the audit's `c/r298/src/Wrapped.Codeunit.al`, plus a second statement so `swap-additive` has a site):

```al
codeunit 50014 "P13 Else Tail"
{
    procedure Apply(Legacy: Boolean; var Total: Integer; var Extra: Integer)
    begin
#if not P13SYM
        if Legacy then begin
            Total := 1;
            Extra := 1;
        end else begin
#endif
            Total := 2;
            Extra := 2;
#if not P13SYM
        end;
#endif
    end;
}
```

```al
codeunit 50015 "P13 Split Block"
{
    procedure P(C: Boolean; var X: Integer)
    begin
#if not P13SYM
        if C then begin
#endif
            X := 1;
            Helper();
#if not P13SYM
        end;
#endif
    end;

    local procedure Helper()
    begin
    end;
}
```

```al
#if not P13SYM
codeunit 50016 "P13 Wrapped"
{
    procedure AIf(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;
}
#endif
```

### The predictor, run on every r1 repro (plan time; Task 1 re-runs and commits it)

r1's plan-time outputs stand for every r1 repro except `p9-undecided` (removed): see r1's table (`H:/lethal-coord/reviews/R-214-plan/plan-r1.md`, "The predictor, run on every repro"), reproduced in Task 1 Step 4's STOP check. The three key facts the rest of this plan depends on:

- `sandbox-symbols`: after the fix each build has 9 deployed mutants (the seven outside the arms and its own arm's pair); `[LETHALB]`'s L15 `return-value` and `swap-additive` move from ordinal 1 to 0 and take the exact key text master gives L13's pair in the `LETHALA` arm (`$P/keymoves.ts`). Under the fixed engine, `[LETHALA]`'s L13 pair and `[LETHALB]`'s L15 pair carry IDENTICAL key text (all three arms share one `astHash`, because locals canonicalise to positional ids). This is C1's collision and I4's same-text key.
- `p-r285` `[]`: L19 and L22 `void-method-call` move from ordinal 1 to 0 and take the dropped L12 and L10 keys.
- `p-r214` `[CLEAN25]`: the lifted L18 `void-method-call` takes ordinal 0 and pushes L22's identical call to 1.

**alc proof on the r1 predictions** (`$P/poison.ts`): for every repro and set, the source with every DROPPED mutant's span overwritten by the identifier `R214POISON` compiles (27 of 27): each dropped span sat in code alc did not build. The control, one KEPT span poisoned, is rejected with `AL0118` in 26 of 28; the two exceptions were r1's `p9-undecided`, which r2 removes.

**The `p11-tier2` ruling (r1, unchanged).** L10 `remove-commit`: master `plat=write-txn-codeunit-run`, twin `plat=-`. `isConsumedCodeunitRun` (`packages/builtin-tier2/src/write-txn-codeunit-run.ts:41`) treats a call as consumed when it is NOT in statement position. After Task 5 the bare in-arm `Codeunit.Run(50013);` is a statement position in both builds (the analysis reads the whole member, arms included), so the pre-commitment records `plat=-` for L10 in both sets.

---

## Decisions

### 1. Scope: two halves, six named exclusions

In scope: (a) no mutant in an arm the build compiles out, for every directive container the grammar has, because the evaluator walks MARKERS, not container kinds; (b) no mutant at all in a file whose directives cannot be evaluated as alc does; (c) a statement directly inside an active arm of a `preproc_conditional_statement` that itself sits in a statement list is a statement position.

**What "no site lost in the active arm" covers, exactly.** It covers statements that are direct children of a `preproc_conditional_statement` whose parent is a `statement_block` or `block`, at any nesting depth of such statements, in every build. It does NOT cover six shapes, each of which keeps master's loss and stays open under its own item:

| exclusion | shape | item | measured on |
| --- | --- | --- | --- |
| `slot` | a `#if` in a single-statement slot (`if X then #if S ... #endif;`) | new, filed by Task 11 | `p8-slot` |
| `R287-C7` | statements directly under `preproc_fragmented_else_tail` | R287 | `p13-exclusions` `ElseTail` |
| `R304` | statements under `preproc_split_if_then_begin*` / `preproc_split_if_begin_asymmetric` | R304 | `p13-exclusions` `SplitBlock` |
| `R305` | an object whose root is `preproc_split_declaration` (skipped whole, a named refusal today) | R305 | none of the repros; counted per corpus |
| `R339` | a site inside an `ERROR` node the directive split causes | R339 | none of the repros; counted per corpus |
| `R343` | a typed operator (for example `swap-additive`) in an object wrapped by a directive, which `symbol-table.ts` does not index | R343 | `p13-exclusions` `Wrapped` |

These are not assumed to be the only gaps. Decision 6's full twin finds every active site the compiled build has; each one missing from the fixed engine's output must fall into exactly one of these six, by a mechanical rule, or Task 1 STOPs. Each exclusion's count is pinned per corpus and set.

**`placeReach` needs no new rule** (r1, confirmed by Q3): its P2 case (`packages/schemata/src/dispatch.ts:280`) already places a statement-grain marker when `isStatementPosition(s)` holds. R342 closes through the `tree-walks.ts` hunk alone; `fixtures/sandbox-symbols` joins `reach-grain-fixtures.test.ts`, which red-checks that hunk. This says nothing about C7 or R304.

**Also out, and filed by Task 11:** member-wide analyses that read inactive arms (the write-transaction and hang tags); al-runner's predefined `CLEANSCHEMA1..25`; `scripts/campaign/compile-only.ts` enumerating with no config symbols; R256, R293, R298, R300, R308 (not touched).

### 2. The arm evaluator: tree markers, text conditions, alc's grammar, refuse the file otherwise

`evaluateArms(root, source, symbols)` in a new `packages/engine/src/ast/preproc-arms.ts`:

- **Fast path (I7).** If `source` has no directive line (the regex above, BOM-tolerant, multiline), return `{ kind: "decided", inactive: [] }` without touching the tree. 11744 of the 12577 corpus files (93%) take this path (BaseApp: 8949 of 9620).
- Collect every `preproc_if`, `preproc_elif`, `preproc_else`, `preproc_endif`, `preproc_define` and `preproc_undef` node in document order, at any depth.
- **Cross-check.** The number of markers must equal the number of directive lines in the text. If not, the file is undecided (`marker-mismatch`): a directive in a comment (row 49), or one the grammar missed or invented. 0 corpus files hit it.
- Keep a stack of `{ outer, taken, active }` frames: `#if` pushes, `#elif` activates only when the outer region is active and no earlier arm was taken, `#else` likewise, `#endif` pops (rows 28, 29).
- A condition is the marker text after `#if` / `#elif`, with a trailing `//` comment removed, parsed by the grammar above (rows 1 to 22). It is evaluated only when its outer region is active, so dead code can never refuse a file.
- `#define` / `#undef` are applied only in an active region (row 40), in order (row 41), case-sensitively (row 39).
- Returns the inactive byte ranges, from the end of the marker that closes the active region to the start of the marker that reopens it.

**Undecided means the whole file is refused.** The evaluator returns `{ kind: "undecided", reason }`, where `reason` is a code plus a line number and NEVER source text: `unparsed-condition at line <n>` (rows 21, 23 to 27: a bare keyword, `!`, `&&`, `||`, `==`, an incomplete or doubled expression, a leading digit); `unbalanced at line <n>` (rows 30, 31: an `#elif` / `#else` after `#else`, an `#elif` / `#else` / `#endif` with no open `#if`, an `#if` never closed); `bad-define at line <n>` (row 45); `marker-mismatch (<t> directive lines, <m> markers)` (row 49). Then `generateMutationSet` generates NO mutant in that file (the file is still copied into the build uninstrumented), warns `preproc-arms-undecided` naming the file and the reason, and records the file's pre-filter site count under the `preproc-undecided` reason in `excludedSites` (Decision 9). **The row is recorded even when that count is 0** (r3, I5): a valid, otherwise empty codeunit with `#if` text in a block comment has no site, and without its row the report would read as if every file had been checked.

Why the whole file, not "keep every arm" (r1): keeping every arm plants mutants in code alc drops, and the R321 measurement shows such a mutant scores `survived` (review C2). Why not throw: every case alc rejects (rows 23 to 31, 34, 35, 45, 46) fails the compile anyway, so no mutant would be scored; the two alc accepts (rows 21 and 49) are legal source, and a throw would stop a run that works today. Refusing one file by name is R303's pattern. The corpora refuse 0 files (measured above), and Task 1 pins that.

Why a text parser and not the tree's expression nodes: they disagree with alc on rows 9 to 11, and a wrong reading there picks the wrong arm with no error. The marker nodes are kept because they give exact byte offsets for the ranges and they already ignore comments (row 49).

`#define` after the first token (row 46) is not modelled: alc rejects it with `AL0625`, so the build fails before any mutant runs.

### 3. The symbols: config plus `app.json`, from the snapshot; only a missing file means none

alc unions `app.json`'s `preprocessorSymbols` with `/define` (rows 47, 48), and DC's `app.json` declares `BC20` to `BC27`, so the config list alone would drop DC's 48 real `#if BC22/24/25/26` arms. So a new `packages/runner/src/preprocessor-symbols.ts` holds:

- `validateSymbolList(raw, source)`: the rules `validatePreprocessorSymbols` (`packages/runner/src/cli.ts:2088`) applies today, moved here and parameterised by the file it names. `validatePreprocessorSymbols` becomes a one-line call with `"lethal.config.json"`, so its messages stay byte-identical (the tests in `packages/runner/tests/preprocessor-symbols.test.ts` pin them).
- `appJsonSymbols(projectDir, snapshot)`: reads `app.json` from `snapshot.get("app.json")` when the snapshot has it (`readTargetSource` always adds it, `packages/runner/src/baseline-snapshot.ts`), else from disk. **Only `ENOENT` means "no `app.json` symbols"** (several callers pass a `src` directory). Any other read error, a JSON error, or a list that fails `validateSymbolList(raw, "<path>")` throws, naming the file.
- `effectiveBuildSymbols(projectDir, configSymbols, snapshot)`: the sorted, de-duplicated union. ONE function, so the generation filter, the session fingerprint, the run row and the marks all use the same set.

"Symbols not given" means `[]`: the empty set is what LethAL compiles with no config (`ArtifactCompiler` sends no `/define`). Per-file `#define` / `#undef` are applied by the evaluator, not here: they are part of the source, so the same source always applies them the same way.

Every caller of `generateMutationSet`, and what it passes:

| caller | passes | why |
| --- | --- | --- |
| `runSession` (`packages/runner/src/orchestrator.ts:4183`) | `cfg.preprocessorSymbols ?? []` and the snapshot (`source`, already passed) | the config list, which the compile and report receive; the function adds `app.json`'s |
| `lethal run --dry-run` (`printDryRun`, `cli.ts:2982`, called at `cli.ts:5079`) | `validatePreprocessorSymbols(dryRunConfig?.preprocessorSymbols)` | a dry run answers for the real run's scope |
| `scripts/campaign/compile-only.ts` | nothing (`[]`, plus `app.json`'s) | its alc step sends no `/define`; filed by Task 11 |
| `scripts/measure-gui-guarded.ts`, `measure-testpage-exclusive.ts`, `probe-alrunner-tables.ts` | nothing | projects with no directives |
| itests `bcdev`, `tables`, `envtool`, `growth`, `stale-publish`, `harden-fixture`, `al-runner` (sandbox-app count) | nothing | fixtures with no directives, byte-identical (Task 9) |
| itest `al-runner` symbol legs | through `runSession` | the leg's set |
| unit tests | nothing, or the set a test names | Task 6 Step 6 |

### 4. The next identity scheme (R325's rule, numbered by merge order)

R325's rule: bump the scheme with any change that can move an existing mutant's key for unchanged source. Measured three ways (above). The Addendum rules that R-214 and R-318 both bump, and whichever merges first takes 4. So this plan never writes the new number into a test: the new scheme is "the next scheme", `IDENTITY_SCHEME` after Task 2. Four places carry the literal, because they must: the constant itself, the CHANGELOG entry, the harden marks file and the agent guide's marks example (`docs/using-lethal-from-an-agent.md:490`). Task 2 Step 1 reads the current value on the merged branch and writes the next.

**The scheme race (r3, C1).** Two lanes that each bump `3` to `4` make the SAME one-line edit, so `git merge` joins them silently, and an R-318 scheme-4 key could then match an R-214 scheme-4 key made by a different pipeline. So a blocking check, `scheme-race`, compares master's `IDENTITY_SCHEME` with this branch's: once before the first product commit (Task 2 Step 0, mode `pre`: the branch must equal master, and Task 2 writes master's value plus one), after every later `git merge master` (mode `post`), and once more before handoff (Task 11 Step 4, mode `post`). In mode `post`, if master's value is equal to or above the branch's, the branch bumps again to master's value plus one, changing the four literals together, and re-runs the transition, capture and gate checks (Task 2 Step 6). It is never left to a handoff note.

**The transition tests (I4, corrected by r3 I2).** For each of the four cross-session paths (history, `--resume-run`, `--resume last`, marks), the OLD record is one the old engine actually made: master's own L13 `return-value` key and line from the committed BEFORE capture (`packages/runner/tests/fixtures/r214/before/fixture-sandbox-symbols.txt`), under the starting scheme `S` the pre-commitment recorded (`before/scheme.json`). It is written through the store API, not by running the new engine and relabelling its run: the new engine's L15 has ordinal 0 where the old L15 had ordinal 1, so a relabelled run is not an old record (review r2, I2). Its key text equals the new engine's L15 key under `[LETHALB]` (measured; a pin test asserts it), which is exactly the collision a carry would exploit. Each path is refused by name; each has a current-scheme control made by a real current-engine run. The constant red-check sets `IDENTITY_SCHEME` to `S`, read from the committed file, never to `IDENTITY_SCHEME - 1`, which would move with the revert and, after a re-bump, name R-318's scheme rather than one any old record was made under. Task 8 Step 1.

### 5. History, resume and marks are scoped to the identical effective symbol set (C1)

After the fix a key names a site WITHIN one build: `[LETHALA]`'s L13 `return-value` and `[LETHALB]`'s L15 `return-value` carry the same key text. Today:

- `priorSurvivorKeys` (`packages/runner/src/store.ts:1183`) reads the latest finished run for the project with no symbol condition, and `filterHistory` (`packages/runner/src/selection.ts:70`) skips on the key alone;
- `--resume last` and `--resume-run` are scoped by `sessionFingerprint` (`packages/runner/src/resume.ts`), which holds the CONFIG symbols but not `app.json`'s, so two runs whose `app.json` differs share a fingerprint;
- a mark (`packages/runner/src/equivalence-marks.ts:217`) matches on key and scheme.

**The rule.** Every run row records its effective build symbols (config plus `app.json`, sorted, de-duplicated), in a new `runs.build_symbols` column (JSON text). NULL (a row written before this column) reads as "unknown" and never matches anything.

- **History.** `priorSurvivorKeys(projectPath, buildSymbols, on)` still reads the LATEST finished run for the project (as R325 does). If its scheme differs, R325's refusal as today. If its symbols differ (or are NULL), no key is returned and the caller warns `history-build-symbols-changed`, naming the run, its symbols and this build's. Why the latest and not "the latest with the same symbols": it is R325's shape, one query, and a project that alternates builds loses a skip, never a verdict. Selecting per set is a later optimisation (Task 11 files it only if asked).
- **Resume.** The fingerprint's `preprocessorSymbols` key receives the EFFECTIVE set instead of the config list, so an `app.json` change breaks the match too. `--resume-run <id>` compares the row's `build_symbols` with this build's BEFORE the fingerprint and refuses by name. `--resume last`, when it finds nothing, looks for the latest unfinished run of the same project, backend and scheme under OTHER symbols and names it, as R325's `unfinishedRunUnderOtherScheme` does for the scheme.
- **Marks.** A mark gains an optional `preprocessorSymbols` array (validated like configured symbols). It applies only to a build whose effective set equals it, compared sorted and de-duplicated. **Absent means `[]`: the mark applies only to a build with no effective symbols.** A mark under another set is stale, with one warning `equivalence-marks-build-symbols` naming the count and this build's set. The same rule is used by the report (`buildReport`), the run's warning, and `lethal verify` (which reads the source run's `build_symbols`).
- **Verify.** `VerifySource` gains `buildSymbols` from the source run's row; its run row records the same; its marks use the rule above.

`createRun` requires `buildSymbols`, exactly as R325 made `identityScheme` required, so a caller that records keys must say which build made them. The migration adds the column; old rows stay NULL.

**Consequence for existing marks files.** A marks file for a project whose effective set is not empty (DC: `BC20` to `BC27` from `app.json`) needs `"preprocessorSymbols"` on each mark after re-checking it. The scheme bump already requires re-checking every mark, so this is one CHANGELOG line, not a second migration. The harden fixture's mark has none, and that fixture builds with `[]`, so it keeps matching (Task 8 Step 5 pins it).

### 6. The pre-commitment, the predictor, the committed corpus listing, and the memory gate

Task 1 commits, alone: `docs/superpowers/specs/2026-09-29-r214-precommitment.md`; the lifted repros under `packages/runner/tests/fixtures/r214/`; one expected capture per repro and set under `packages/runner/tests/fixtures/r214/expected/`; the corpus listings under `docs/superpowers/specs/r214-corpus/`; and `scripts/r214-capture.ts`, the capture tool, so the check needs nothing on `H:`. A difference later is a finding and a STOP, never an edit.

**The capture tool, `scripts/r214-capture.ts`** (lifted from `$P/sites.ts`, SHA-256 prefix `6f95c8b1`, with two flags added). `bun scripts/r214-capture.ts <project> [--symbols A,B] [--listing <dir> --label <c>.<i> --regions <regions.json>]`: runs `generateMutationSet` on whatever engine is checked out (passing `--symbols` through an intersection-typed options object, so the same file runs on master, where the option does not exist yet and is ignored), then an offline `writeInstrumentedProject`, and prints one row per DEPLOYED mutant: `file:line`, operator, `proc=`, `hang=`, the serialized identity key, `start-end`, `grain=`, `plat=`; header `raw N deployed M skippedFiles K`. On stderr: the skipped list, `maxRSS_KB` (from `process.resourceUsage().maxRSS` at exit), and with `--listing` it writes the three listing files below. No source text is printed anywhere: keys hold an AST hash and names only.

**The predictor.** Inputs: a project, one symbol set. It runs master's pipeline only (the fix is never built at Task 1).

1. `pp.ts <project> <set> <twin-dir> <regions.json> [--full <full-twin-dir>]` (r1's tool with three r2 changes: its condition parser follows the measured grammar above, with no `not` refusal and with `true` / `false`; it strips a BOM before matching directive lines; and `--full` writes the full twin). It unions `app.json`'s symbols, walks directive LINES with its own parser, refuses exactly Decision 2's cases, and writes per file `inactive`, `lifted`, `blankedDirectives`, `undecided` and the line / marker cross-check. The **lift twin** (r1) blanks, with spaces and EOLs kept so every offset is unchanged, the directive lines and inactive lines of each `preproc_conditional_statement` in a statement list only: master on it is the fixed engine's view of those arms. The **full twin** (r2) blanks EVERY directive line and every inactive line in the file: it is the source alc actually compiles, so master on it lists every site the compiled build has.
2. `r214-capture.ts` on the ORIGINAL (the BEFORE capture), on the lift twin and on the full twin.
3. `predict.ts <before> <lift-twin> <regions> <before.raw> <lift-twin.raw>` (r1): keep every BEFORE row whose start is in neither `inactive` nor `lifted`; add every lift-twin row whose start is in `lifted`; renumber ordinals per tuple in (file, start) order; drop every row of an undecided file. It reports `removed`, `added`, `approxKeys` and `attrDiffs` (r1's meanings, each ruled by hand).
4. `presence.ts <expected> <full-twin> <regions> <project>` (r2, new): joins the expected rows and the full-twin rows of each directive file on `(file, start, end, operator)`. A full-twin row with no expected row is an EXCLUSION, classified by the smallest directive node of the ORIGINAL parse that contains its start, in this order: inside an `ERROR` node, `R339`; `preproc_split_declaration`, `R305`; `preproc_fragmented_else_tail`, `R287-C7`; `preproc_split_if_then_begin*` or `preproc_split_if_begin_asymmetric`, `R304`; a `preproc_conditional_statement` not in a statement list, `slot`; any directive node whose parent is the file root (a wrapped object), `R343`; anything else, `UNCLASSIFIED`, which is a STOP. An expected row with no full-twin row is `EXTRA`, also a STOP. It prints the exclusion counts per reason.
5. `keymoves.ts <before> <expected>` (r1): every surviving row whose key moved.

The rule it encodes is the product rule stated independently: "a site starting in a compiled-out arm is gone; an undecided file has no site; inside a statement-level active arm, a statement is a statement". It shares no code with `evaluateArms` (text lines against tree markers, its own condition parser).

**The committed corpus listing (I5).** For each corpus `c` and set `i`, `r214-capture.ts --listing` writes, and Task 1 commits under `docs/superpowers/specs/r214-corpus/`:

- `<c>.<i>.files.tsv`: one line per `.al` file with at least one expected row: `path`, row count, SHA-256 of that file's expected rows. This pins every file WITHOUT a directive by digest, which is byte-identical by construction and is too large to list row by row (BaseApp: about 1.7 million rows).
- `<c>.<i>.rows.tsv.gz`: every expected row of every file WITH a directive line, in the capture's format, plus one `EXCLUDED <reason>` row per classified exclusion (the full-twin row's `file:line`, operator and `start-end`, no key) and one `INACTIVE <file> <startLine>-<endLine>` row per inactive range. So presence (the rows, and the exclusions by reason) and absence (the inactive ranges) are both in the file.
- A header line in each: corpus name, the set, `hashTargetSource(root, [])` of the corpus (the SHA-256 over every `.al` and `app.json`, `packages/runner/src/baseline-snapshot.ts`), and `git -C <root> rev-parse HEAD` or `none`. A reviewer with the same source reproduces the check from the repo alone.

**How the after-change listing is made (r3, I3).** Task 9 never feeds the committed `EXCLUDED` or `INACTIVE` rows back in, which would make their comparison circular. It regenerates the regions and the full twin from the corpus text with `pp.ts`, captures the full twin with the branch engine, runs `presence.ts` on the AFTER capture against that fresh full-twin capture, requires `UNCLASSIFIED 0` and `EXTRA 0`, and only then writes the listing from the AFTER capture, that fresh presence result and those fresh regions. The committed files are read only by the final `cmp`.

No source text is in any of them (the ruling of 2026-09-09: paths, object, procedure and test names are fine to publish, source is not). **Size ceiling:** the four corpora's `rows.tsv.gz` files together must be at most 20 MB; above that is a STOP and a question (the fallback would be rows only for members holding a directive), never a silent trim.

**Peak memory gate (I7).** Each capture records `maxRSS_KB`. Task 1 Step 7 measures master's peak for each corpus and set with `r214-capture.ts` at the pre-commitment commit, sequentially, nothing else heavy running, and commits the numbers in the spec. Task 9 measures the branch the same way: the SAME command (`r214-capture.ts <root> --symbols <set>`, stdout to `/dev/null`), in its own run, before and apart from the capture that writes the listing (r3, I4). The listing run builds extra structures in the capture tool, so its peak is not comparable with master's and is never read by the gate; it is only a no-crash and equality check. **Gate: every capture exits 0, and every after-change peak is at most 110% of master's for the same corpus and set.** A crash or a breach is a STOP: report the numbers, do not tune in the same step. r1's plan-time reference: full BaseApp took 391 s and a 480 MB capture (R-323).

**Sets.** For each corpus, `S0 = []` (DC's effective set is then its `app.json`'s `BC20` to `BC27`) and `S1` = every symbol its conditions name that starts with `CLEAN` (DC: `CLEAN27, CLEAN28`; System Application: `CLEAN26, CLEAN27, CLEAN28, CLEANSCHEMA27, CLEANSCHEMA29, CLEANSCHEMA31`; BusinessFoundation: `CLEAN27, CLEAN28, CLEANSCHEMA27`; BaseApp: `CLEAN26, CLEAN27, CLEAN28, CLEAN29, CLEANSCHEMA25, CLEANSCHEMA26, CLEANSCHEMA27, CLEANSCHEMA28, CLEANSCHEMA29, CLEANSCHEMA30, CLEANSCHEMA31`). The spec pins per corpus and set: raw and deployed totals, removed, added, key moves, the `ATTR` rulings, `undecidedFiles` (must be 0), `approxKeys` (must be 0 or ruled per row), the exclusion counts per reason, the listing files' SHA-256, and master's peak memory.

### 7. The R321 re-freeze: a new pre-commitment, then an owner-approved re-record (Q4)

The frozen symbol legs contain compiled-out mutants scored `survived` (audit finding 3, and the old pre-commitment's own line 80). After the fix each build has 9 mutants. The new tables (the surviving mutants' verdicts do not move; the in-arm pair's grain becomes `statement`, which scoring does not read for a killed mutant):

| line | operator | `[LETHALA]` | `[LETHALB]` | `[]` (`#else`, no gate leg) |
| ---: | --- | --- | --- | --- |
| 8 | `empty-block` | K | K | K |
| 9 | `remove-assignment` | K | S | S |
| 9 | `shift-integer` | K | S | S |
| 10 | `remove-assignment` | S | K | S |
| 10 | `shift-integer` | S | K | S |
| 11 | `remove-assignment` | S | S | K |
| 11 | `shift-integer` | S | S | K |
| 13 | `return-value` | K | (none) | (none) |
| 13 | `swap-additive` | K | (none) | (none) |
| 15 | `return-value` | (none) | K | (none) |
| 15 | `swap-additive` | (none) | K | (none) |
| 17 | `return-value` | (none) | (none) | K |
| 17 | `swap-additive` | (none) | (none) | K |
| | **killed / survived / no-coverage** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** |

`K` is killed by `Symbol Tests.RateSmall`, `S` is survived with no killing test. Codes are the dry run's order: M0001 to M0007 as before, then M0008 / M0009 are the build's own arm pair.

**The baseline diff, by key (r3, I8).** The committed baselines hold neither a source line nor a grain: each row is a normalized identity key, a verdict and a killing test (`packages/runner/itest/mutant-equality.ts:26-32,64-73`). Read at `f0fe038a` (`$T/r321-key-diff.txt`), with `SA` = `78d263bd173e364a976eff1b96889af14e53935f69c469b7e16442192ca2f93e|Symbol Logic|Rate|lethal.swap-additive|1` and `RV` = `c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Symbol Logic|Rate|lethal.return-value|1`: the old engine gave the three arm pairs ordinals 0 (L13), 1 (L15) and 2 (L17), written `SA`, `SA|1`, `SA|2` and the same for `RV`. After R214 each build keeps only its own pair, at ordinal 0. So the expected diff of each re-recorded baseline against the deleted one is exactly:

| baseline | keys removed | keys whose row changes | keys unchanged |
| --- | --- | --- | --- |
| `al-runner.symbols-lethala.baseline.json` (13 to 9 rows) | `SA\|1`, `SA\|2`, `RV\|1`, `RV\|2` | none (`SA` and `RV` were L13, killed by `RateSmall`, and still are) | the other 9, verdict and killing test identical |
| `al-runner.symbols-lethalb.baseline.json` (13 to 9 rows) | `SA\|1`, `SA\|2`, `RV\|1`, `RV\|2` | `SA` and `RV`: `survived` / `null` becomes `killed` / `RateSmall`, because the key that named the compiled-out L13 now names the built L15 | the other 7, verdict and killing test identical |

The `[LETHALB]` change at `SA` and `RV` is a predicted verdict change at an unchanged key, not a regression; any other added, removed or changed key is a STOP. Task 1's spec pins this table with the full keys, and Task 10 Step 4 checks it key by key.

**The red-checks, re-predicted.** (a) Dropping the daemon's `--define` (`AlRunnerServer.start`): LethAL still generates the configured arm, the daemon compiles `#else`, and both server legs print L8 K, L9 S S, L10 S S, L11 K K, the arm pair S S: 3 killed / 6 survived, failing the four named equality assertions. (b) Dropping `buildAlRunnerArgv`'s `--define`: the one-shot leg prints the same 3 / 6 and fails `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed table (...)`; six failures in all. Both are now caught by the COUNT too.

**Recording (Q4).** This moves a frozen figure (CLAUDE.md: killed 5 / survived 8 / no-coverage 0 over 13). The lane may not re-record on its own authority. So Task 10 transcribes the tables (a unit-tested change), runs the gate in normal mode to show it fails only on the baseline comparison of the two symbol sets, then checkpoints `--wait owner --note "R321 re-freeze ready"`. Only after the owner approves, through a `coord answer` or a `task.md` revision, are the two baselines deleted, recorded with `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` (exit 3 by design), each re-recorded baseline checked key by key against the pre-committed key diff (below, r3 I8), and the gate re-run normally to a pass. Never a hand edit. CLAUDE.md's figure moves to 5 / 4 / 0 over 9; the orchestrator edits CLAUDE.md, not the lane.

### 8. alc proof per build

For each repro and `sandbox-symbols`, per set, on the branch after Task 7: (1) the instrumented project compiles (`$P/alc-emit.ts`: the real pipeline with the set, `writeInstrumentedProject`, `injectControlDependency`, the Control app's `.alpackages`, `alc /define:<set>`), which proves every kept mutant, marker and selector compiles in that build; (2) the poison proof on the AFTER capture: every mutant master had and the branch dropped, poisoned, compiles under that set; (3) the control: one kept span poisoned is rejected with `AL0118`. `p12-refused`'s `Refused.Codeunit.al` has no kept span; its control is `Plain.Codeunit.al`'s. There is no expected exception any more (r1's two were `p9-undecided`).

### 9. Observability: a warning AND a counted report reason (Q1)

Two warnings, as r1: `compiled-out-sites` once per run (total, file count, the effective symbols, the first five files with counts) and `preproc-arms-undecided` once per refused file (file, reason code). Plus the durable record: `ExclusionReason` gains `"compiled-out"` and `"preproc-undecided"`, each file a row in `excludedSites.files` with its pre-filter site count (the rule `declarative` already uses) and `detail` set to `symbols: <sorted list or none>` for `compiled-out` and to the reason code for `preproc-undecided`. `detail` never carries source text (`excluded-sites.ts`'s own rule). The report banner prints one line per reason when its count is above 0. The ripple follows CLAUDE.md's list in order (Task 7).

**One caveat, for refused files only (r3, minor a).** `validity.reliability` depends on filters and baseline errors, not on `excludedSites` (`packages/runner/src/report.ts`, `reliability`), so a consumer reading only `validity` would miss a refused file. So a new `Caveat`, `preproc-files-refused`, is pushed when `excludedSites` has at least one `preproc-undecided` row. It is pushed on the FILE count, not the site count, because a refused file can have 0 sites (I5). Like `uninstrumentable-files` and `declarative-sites-dropped`, it does not change `reliability`. A `compiled-out` row gets no caveat: it is the correct build, not a gap. Adding a `Caveat` grows the explain schema's `caveat` value domain, which R233's literal pin (`packages/runner/tests/schemas.test.ts`, "every enum value set in the published explain schema is pinned") only accepts with an explain version bump, so `EXPLAIN_SCHEMA_VERSION` moves from 6 to 7 exactly as R-236c moved it from 5 to 6 for one caveat (`87faa6ac`). The report schema v3 grows its enums in place, as report v2 did in `87faa6ac`.

### 10. Live gates: which run, which do not (I8)

**Run** (Task 10): `itest:alrunner` (every leg; the symbol legs move as pre-committed, every other leg unchanged per mutant), then `itest:bcdev`, `itest:tables`, `itest:chunked` on Cronus28 under `coord lease Cronus28 preproc`, one at a time. Their fixtures hold no directive and Task 9 proves them byte-identical offline, so any moved verdict there is a BLOCK.

**Not run, and why; none of their baselines is re-recorded, and none may be:**

| gate | fixture | why not run | what stands in for it |
| --- | --- | --- | --- |
| `itest:hang` | `fixtures/sandbox-hang` | exercises the control app's stop, which this plan does not touch | Task 9 Step 3: its mutant set and instrumented target are byte-identical offline |
| `itest:envtool` | `fixtures/sandbox-app` via an external environment | needs a provisioned environment that does not exist (deleted 2026-09-01) | Task 9 Step 3 (sandbox-app byte-identical) and `itest:bcdev` on the same fixture |
| `itest:harden` | `fixtures/sandbox-harden` | a gate the lane has no lease plan for; its only input this plan changes is the marks file's scheme field | Task 9 Step 3 (byte-identical) and Task 8 Step 5 (the committed mark still matches under the new scheme and `[]`) |
| `itest:growth`, `itest:lease`, `itest:stale-publish`, `itest:testapp`, `itest:verify`, `itest:agreement`, `itest:verify-scale` | no directive fixtures | not frozen per mutant by this change; `verify` reads the new `build_symbols` through unit tests (Task 8) | the unit suite |

So the claim this plan can make is: byte-identical site captures for every named fixture, and a passing live run for the four gates above. It cannot claim the other frozen live results were re-checked.

---

## Global Constraints

- Plain English, short sentences, no em dashes anywhere (code comments and strings included).
- Build loop, in this order: `LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts` on a fresh worktree or after any change under `packages/engine/native/` (none planned); `bun run typecheck`; `rm -rf packages/*/dist` AFTER typecheck and BEFORE any `bun test`; `bun test` from the repo root (the preload hides the real home, R264). R335's known 5 s timeouts (`campaign-subcommands.test.ts`, `gate-receipt.test.ts`) must pass when run alone.
- `bunx biome check <touched files>` only; never `biome check .`.
- No `!` non-null assertions; `exactOptionalPropertyTypes` (`...(v !== undefined ? { k: v } : {})`); a typed error class extends `Error` directly; fail loudly on a caller-contract violation (a malformed or unreadable `app.json` throws; `createRun` requires `buildSymbols`).
- No new test writes a scheme NUMBER (Addendum). New tests use `IDENTITY_SCHEME` for the current scheme and, for the old one, the starting scheme `S` read from the committed `packages/runner/tests/fixtures/r214/before/scheme.json` (r3, I2); never `IDENTITY_SCHEME - 1`. Only the constant, the CHANGELOG line, `fixtures/sandbox-harden/lethal.equivalent.json` and the agent guide's example carry the new number, and `before/scheme.json` carries `S`, which never changes.
- **Scheme race, blocking (r3, C1).** Before Task 2's first product edit, run the check in mode `pre` (Task 2 Step 0). After every later `git merge master`, and before handoff (Task 11 Step 4), run it in mode `post`; exit 2 means do Task 2 Step 6 now, before any other step.
- The pre-commitment (Task 1) is committed alone before any product code. A capture that differs from it is a STOP and a report, never an edit of the expectation.
- Corpus captures run on `H:` (outputs under `H:/lethal-scratch/R-214/`), one at a time, nothing else heavy running, peak memory recorded. Full BaseApp runs alone. No crash, then memory (the 110% gate), then speed.
- No source text in anything committed: listings hold paths, lines, offsets, operator names, object and procedure names and AST hashes only. `excludedSites.detail` and warnings hold symbols and reason codes only.
- Never hand-edit a baseline. `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` only after the owner approves (Decision 7). A moved frozen figure goes to the owner; CLAUDE.md is edited by the orchestrator.
- Containers: Cronus28 only, under `coord lease Cronus28 preproc`, heartbeat every 5 minutes, release right after, one gate at a time.
- Coord-only lane: replies go in `coord checkpoint --note`, `coord submit`, `coord ask`; merge `master` before each task; re-check the next free roadmap id immediately before writing one.
- Red-check every product hunk (the `mutation-red-checker` subagent): revert that hunk alone, confirm its named test goes red, restore, confirm green. Record both outputs.

## Review Focus

1. **`#if not A and B`** (tree and alc disagree). Expected: evaluated as `(not A) and B`, the arm alc builds. Pinned by Task 4's table rows 9 to 11 and `p9-precedence` in every set.
2. **A file LethAL cannot read as alc does** (a directive line in a comment). Expected: no mutant in that file, one warning naming it, one `preproc-undecided` row in `excludedSites`; the other file in the project unaffected. Pinned by `p12-refused` (Task 6) and Task 7's report test.
3. **Same key, different site, across two builds** (`sandbox-symbols` L13 under `[LETHALA]`, L15 under `[LETHALB]`). Expected: no history skip, no resume, no mark carries across; each refused by name; the same record under the same set is carried. Pinned by Task 8 Steps 1 and 6, red-checked in Step 7.
4. **A project whose `app.json` declares symbols** (DC). Expected: those arms are the build, and an unreadable `app.json` throws instead of reading as none. Pinned by `p7-appjson`, Task 3's `EACCES` test and DC's `S0` listing.
5. **An active site the fix still misses.** Expected: every one is in exactly one named exclusion, counted per corpus; an unclassified one stops Task 1. Pinned by `presence.ts` and `p13-exclusions`.
6. **Memory.** Expected: no corpus capture crashes, and no after-change peak exceeds 110% of master's, measured with the identical command. Pinned by Task 9 Step 5 against Task 1 Step 7's committed numbers.
7. **Two lanes bump to the same scheme** (r3). Expected: the branch never hands off, and never builds on, a scheme number master already holds. Pinned by the `scheme-race` check (Task 2 Step 0, after each merge, Task 11 Step 4).

---

## File structure

- Create `packages/engine/src/ast/preproc-arms.ts`: `evaluateArms`, `startsInInactiveArm`. One responsibility: which bytes a build compiles out, or why it cannot say.
- Create `packages/runner/src/preprocessor-symbols.ts`: `validateSymbolList`, `appJsonSymbols`, `effectiveBuildSymbols`, `sameBuildSymbols`.
- Modify `packages/engine/src/ast/tree-walks.ts:33` (`isStatementPosition`) and `packages/engine/src/index.ts` (export).
- Modify `packages/runner/src/orchestrator.ts`: `MutationSetOptions.preprocessorSymbols`, the filter and refusal in `generateMutationSet`, `MutationSetResult.preprocExcluded`, the two warnings, `runSession` (effective symbols, fingerprint, `createRun`, history, both statics assemblies, marks warning), `resolveResume`.
- Modify `packages/runner/src/cli.ts`: `validatePreprocessorSymbols` delegates; `printDryRun`'s `paths.preprocessorSymbols` and its caller.
- Modify `packages/runner/src/store.ts` (column, `createRun`, `getRun`, `RunRow`, `priorSurvivorKeys`, `unfinishedRunUnderOtherSymbols`), `packages/runner/src/resume.ts` (doc comment only), `packages/runner/src/equivalence-marks.ts`, `packages/runner/src/verify.ts`, `packages/runner/src/report.ts`, `packages/runner/src/report-fold.ts`, `packages/runner/src/events.ts`, `packages/runner/src/excluded-sites.ts`, `packages/runner/src/mutation-elements.ts`.
- Modify `packages/schemata/src/project.ts:105` (`IDENTITY_SCHEME`), `CHANGELOG.md`, `fixtures/sandbox-harden/lethal.equivalent.json`, `docs/using-lethal-from-an-agent.md`, `schemas/report-v3.schema.json` and `schemas/stream-v1.schema.json` (both generated; `schemas/report-v2.schema.json` is frozen and must not change).
- Minor a: modify `packages/runner/src/report.ts` (`Caveat`, `CAVEAT_INTERPRETATIONS`, the push), `packages/runner/src/explain.ts` (`EXPLAIN_SCHEMA_VERSION` 6 to 7 and its doc line), `schemas/README.md` (the v7 row; v6 becomes a kept row); create `schemas/explain-v7.schema.json` (hand-written: v6 plus the caveat value; v6 stays as published).
- Modify `packages/runner/itest/symbol-fixture.ts` (tables, header, failure message), `fixtures/README.md` (§ sandbox-symbols).
- Tests: create `packages/engine/tests/ast/preproc-arms.test.ts`, `packages/runner/tests/r214-compiled-out.test.ts`, `packages/runner/tests/r214-history.test.ts`; modify `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/reach-grain-fixtures.test.ts`, `packages/runner/tests/cli.test.ts`, `packages/runner/tests/preprocessor-symbols.test.ts`, `packages/runner/tests/symbol-fixture.test.ts`, `packages/runner/tests/schemas.test.ts`, `packages/runner/tests/interpretation.test.ts`, `packages/runner/tests/report.test.ts`, `packages/runner/itest/harden-fixture.test.ts`, and the scheme and preproc tests Tasks 2 and 6 name.
- Test data and listings: `packages/runner/tests/fixtures/r214/<repro>/` (13 repros), `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt`, `packages/runner/tests/fixtures/r214/before/fixture-sandbox-symbols.txt` and `before/scheme.json` (r3, I2), `docs/superpowers/specs/r214-corpus/`, `scripts/r214-capture.ts`.

---

### Task 1: The pre-commitment, committed alone

**Files:**
- Create: `docs/superpowers/specs/2026-09-29-r214-precommitment.md`
- Create: `packages/runner/tests/fixtures/r214/{p-r214,p-r285,p-r306,p-r306b,p5-elif-nested,p6-define,p7-appjson,p8-slot,p9-precedence,p10-case,p11-tier2,p12-refused,p13-exclusions}/` (each with `app.json`, its `.al` files and `symbol-sets.json`)
- Create: `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt` (one per repro and set, plus `fixture-sandbox-symbols.0.txt`, `.1.txt`, `.2.txt`)
- Create: `packages/runner/tests/fixtures/r214/before/fixture-sandbox-symbols.txt` (master's own capture of the R321 fixture) and `packages/runner/tests/fixtures/r214/before/scheme.json` (the starting scheme), r3 I2
- Create: `docs/superpowers/specs/r214-corpus/<c>.<i>.files.tsv`, `<c>.<i>.rows.tsv.gz` for `c` in `dc sysapp bcf baseapp`, `i` in `0 1`
- Create: `scripts/r214-capture.ts`

**Interfaces:**
- Produces: the expected captures Task 6's test compares against, in the capture's row format (forward-slash paths, header `raw N deployed M skippedFiles K`), named `<name>.<set index>.txt` (the index, not the symbols: `FOO` and `Foo` collide on a case-insensitive file system, measured).
- Produces: the corpus listings Task 9 compares against, and master's peak memory per corpus and set.
- Produces: the new R321 tables (Decision 7) that Task 10 transcribes.

- [ ] **Step 1: Merge master, set up.** `git merge master`. `P=H:/lethal-scratch/R-214/plan; Q=H:/lethal-scratch/R-214/plan-r2`. Confirm the r1 tools' SHA-256 prefixes (`sites.ts 6f95c8b1`, `pp.ts b012da98`, `predict.ts 8a56b31a`, `poison.ts ab3f70cf`, `keymoves.ts 92d3bdf4`, `run-predict.sh 174d89d2`, `before.sh 50dc5da1`, `prove.sh a1e78e2c`); a tool that moved is re-reviewed before use. Re-read `IDENTITY_SCHEME` in `packages/schemata/src/project.ts` and record it in the spec as "the scheme this pre-commitment was made on".

- [ ] **Step 2: Build the r2 predictor.** Copy `pp.ts` to `$Q/pp.ts` and make exactly Decision 6's three changes: (a) replace its condition parser with the grammar in "alc's precedence, measured" (no `not`-over-binary refusal; `true` / `false` literals; a bare keyword as an operand, `!`, `&&`, `||`, `==`, any other character, or leftover tokens refuse as `unparsed-condition`); (b) strip a leading `\uFEFF` before matching directive lines; (c) `--full <dir>` writes the full twin. Write `$Q/presence.ts` per Decision 6 item 4; its output always ends with the two lines `UNCLASSIFIED <n>` and `EXTRA <n>`, printed even when `<n>` is 0, so Task 9 Step 4 can check them mechanically (r3, I3). Copy `$P/sites.ts` to `scripts/r214-capture.ts` and add `--symbols` and `--listing` per Decision 6. Then check the new parser against every row of the measured table: `bun $Q/pp.ts --self-test $Q/prec/battery.txt $Q/prec/battery2.txt` evaluates each probe's condition under its defines and must agree with the built arm on every row alc compiled, and must refuse every row alc rejected, plus row 21. Any disagreement is a STOP. Record every tool's SHA-256 in the spec.

- [ ] **Step 3: Lift the repros.** Copy each r1 `$P/repro/<name>/` (not `p9-undecided`) into `packages/runner/tests/fixtures/r214/<name>/` without `.alpackages` or build output. Create `p9-precedence`, `p12-refused` and `p13-exclusions` from the AL above, each with the r1 `app.json` shape (runtime `16.0`, no dependency, id range `50000..50100`, a fresh GUID) and `symbol-sets.json` (`[[],["UA"],["UB"],["UA","UB"],["UB","UC"]]`, `[[],["R12SYM"]]`, `[[],["P13SYM"]]`). Run `bash $P/alc-plain.sh <dir>` on every lifted directory. Expected: 32 builds, `errors=0` each. A repro that does not compile is a STOP (fix the repro, never the expectation).

- [ ] **Step 4: Repros and `sandbox-symbols` through the predictor.**

```bash
set -euo pipefail
P=H:/lethal-scratch/R-214/plan; Q=H:/lethal-scratch/R-214/plan-r2; R=$(pwd); F="$R/packages/runner/tests/fixtures/r214"
mkdir -p "$Q/out"
for d in "$F"/p*/ "$R/fixtures/sandbox-symbols/"; do
  n=$(basename "${d%/}"); [ "$n" = sandbox-symbols ] && n=fixture-sandbox-symbols
  bash "$P/before.sh" "$n" "${d%/}"
  PP="$Q/pp.ts" PRESENCE="$Q/presence.ts" CAPTURE="$R/scripts/r214-capture.ts" bash "$P/run-predict.sh" "$n" "${d%/}"
done
for d in "$F"/p*/; do bash "$P/prove.sh" "$(basename "$d")" "${d%/}"; done > "$Q/out/prove-t1.txt"
bash "$P/prove.sh" fixture-sandbox-symbols "$R/fixtures/sandbox-symbols" >> "$Q/out/prove-t1.txt"
```

(`run-predict.sh` reads `PP`, `PRESENCE` and `CAPTURE` from the environment when set; Step 2 adds those three lines to a copy at `$Q/run-predict.sh` if the r1 script hard-codes paths, and the command above then calls `$Q/run-predict.sh`.)

Expected: every r1 repro's totals and changes equal r1's plan-time table (for `sandbox-symbols`, 9 / 9 per set); `approxKeys 0` everywhere; `undecidedFiles 1` for `p12-refused` in both sets and 0 elsewhere; the one `ATTR` pair in `p11-tier2`; exclusions `slot` 1 in `p8-slot` (the active arm's `Helper(...)`), and in `p13-exclusions` `R287-C7` (the two tail assignments, in both sets), `R304` (in both sets) and `R343` (`swap-additive` at `exit(A + B)`, under `[]` only; under `[P13SYM]` the object is inactive and has no rows); `UNCLASSIFIED 0` and `EXTRA 0` everywhere; `prove-t1.txt` has every `dropped ... COMPILES` and every `control` REJECTED. Any other result is a STOP: report it, do not tune a tool to it.

- [ ] **Step 5: Write the expected files.** For each `$Q/out/expect/<name>.<i>[<set>].txt`, copy to `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt`. Apply the one ruling by hand: in both `p11-tier2` files, L10 `lethal.remove-commit`'s last column `plat=write-txn-codeunit-run` becomes `plat=-`. Record every file's SHA-256 (after the ruling).

- [ ] **Step 5b: Commit the old engine's own record (r3, I2).** Task 8's transition tests need an old record that the OLD engine made, not a relabelled new-engine run. So:

```bash
set -euo pipefail
P=H:/lethal-scratch/R-214/plan; R=$(pwd); D="$R/packages/runner/tests/fixtures/r214/before"
mkdir -p "$D"
cp "$P/cap/before/fixture-sandbox-symbols.txt" "$D/fixture-sandbox-symbols.txt"
S=$(sed -n 's/^export const IDENTITY_SCHEME = \([0-9][0-9]*\);$/\1/p' packages/schemata/src/project.ts)
printf '{ "identityScheme": %s, "engineCommit": "%s" }\n' "$S" "$(git rev-parse HEAD)" > "$D/scheme.json"
# The L13 return-value row is master's; its key must be the frozen [LETHALB] baseline's survived RV row.
grep -c $'^src/SymbolLogic.Codeunit.al:13\tlethal.return-value\t' "$D/fixture-sandbox-symbols.txt"
grep -c 'c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Symbol Logic|Rate|lethal.return-value|1"' packages/runner/itest/al-runner.symbols-lethalb.baseline.json
```

Expected: `before.sh` ran in Step 4 at THIS commit, on master's engine (so the file is master's capture now, not r1's); its header is `raw 13 deployed 13 skippedFiles 0`; `S` is the value Step 1 recorded; both counts print `1`; and the L13 row's key field is `c9159b46...|Symbol Logic|Rate|lethal.return-value|1` with no ordinal, the key the frozen `[LETHALB]` baseline scores `survived`. Master ignores the symbols, so one BEFORE capture serves every set. Any other result is a STOP.

- [ ] **Step 6: The six gate fixtures and the two examples, BEFORE captures.** For `sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe` under `fixtures/`, and `gift-card credit-limit` under `examples/`: `bun scripts/r214-capture.ts <dir> > $Q/cap/gate/<name>.txt`, `bun scripts/probe-fixture-hashes.ts <dir>/src > $Q/cap/gate/<name>.hashes`, and confirm `grep -rlE '^\s*#\s*(if|define|undef)' <dir>` is empty. Expected: empty for all seven, so the expected capture of each IS its BEFORE capture. Record each header line.

- [ ] **Step 7: The corpora, one at a time, with master's peak memory.** For each corpus `c` in `dc sysapp bcf baseapp` (roots in "The corpora's directives"), with nothing else heavy running:

```bash
set -euo pipefail
P=H:/lethal-scratch/R-214/plan; Q=H:/lethal-scratch/R-214/plan-r2; O=H:/lethal-scratch/R-214/corpus; R=$(pwd)
mkdir -p "$O" "$R/docs/superpowers/specs/r214-corpus"
# $root is the corpus root, $s1 its S1 set (comma-separated, Decision 6)
bun "$R/scripts/r214-capture.ts" "$root" --raw-out "$O/before-$c.raw" > "$O/before-$c.txt" 2> "$O/before-$c.err"
for i in 0 1; do s=$([ $i = 0 ] && echo "" || echo "$s1")
  bun "$Q/pp.ts" "$root" "$s" "$O/twin-$c-$i" "$O/regions-$c-$i.json" --full "$O/full-$c-$i"
  bun "$R/scripts/r214-capture.ts" "$O/twin-$c-$i" --raw-out "$O/twin-$c-$i.raw" --raw-files "$O/regions-$c-$i.json" > "$O/twin-$c-$i.txt" 2> "$O/twin-$c-$i.err"
  bun "$R/scripts/r214-capture.ts" "$O/full-$c-$i" > "$O/full-$c-$i.txt" 2> "$O/full-$c-$i.err"
  bun "$P/predict.ts" "$O/before-$c.txt" "$O/twin-$c-$i.txt" "$O/regions-$c-$i.json" "$O/before-$c.raw" "$O/twin-$c-$i.raw" > "$O/expect-$c-$i.txt" 2> "$O/predict-$c-$i.log"
  bun "$Q/presence.ts" "$O/expect-$c-$i.txt" "$O/full-$c-$i.txt" "$O/regions-$c-$i.json" "$root" > "$O/presence-$c-$i.txt"
  bun "$P/keymoves.ts" "$O/before-$c.txt" "$O/expect-$c-$i.txt" > "$O/keymoves-$c-$i.txt"
  # master's peak for THIS set, the reference for Task 9's 110% gate (the engine is master here)
  bun "$R/scripts/r214-capture.ts" "$root" --symbols "$s" > /dev/null 2> "$O/master-peak-$c-$i.err"
done
```

Record per corpus and set: BEFORE's header, the expected header, `removed`, `added`, `approxKeys`, `attrDiffs`, `undecidedFiles`, the exclusion counts by reason, `UNCLASSIFIED`, `EXTRA`, the `moves` line, and `maxRSS_KB` from `master-peak-$c-$i.err`. STOP conditions: `pp.ts` exits 3; `undecidedFiles` above 0; `UNCLASSIFIED` or `EXTRA` above 0; `approxKeys` above 0 without a per-row ruling; `attrDiffs` above 20 in one corpus (ask before ruling that many); any capture exits non-zero (a crash is a STOP, never a retry with more memory).

- [ ] **Step 8: Rule every `ATTR` line.** For each, read the product analysis that sets the attribute (`hangCapable`: `packages/builtin-tier1/src/loop-hazard.ts`; `platformKillMechanism`: the operator's own tag function) and decide whether the product after Task 5 reads it as master does or as the twin does. Write the ruling per row in the spec and apply it to `expect-$c-$i.txt`.

- [ ] **Step 9: Write the corpus listings.** For each corpus and set: `bun scripts/r214-capture.ts --listing docs/superpowers/specs/r214-corpus --label $c.$i --from-expected $O/expect-$c-$i.txt --presence $O/presence-$c-$i.txt --regions $O/regions-$c-$i.json --root "$root"` writes `$c.$i.files.tsv` and `$c.$i.rows.tsv.gz` (Decision 6) from the ruled expected capture, the classified exclusions and the inactive ranges. Then check: `du -cb docs/superpowers/specs/r214-corpus/*.gz | tail -1` at most 20000000 (else STOP and ask); `zcat docs/superpowers/specs/r214-corpus/*.gz | grep -ciE 'begin|:=|exit\('` is 0 (no source text leaked); record each file's SHA-256.

- [ ] **Step 10: Write the spec.** `docs/superpowers/specs/2026-09-29-r214-precommitment.md`, sections: "What is pre-committed" (Decision 6's rule in five lines); "Symbols" (the measured table, by reference to this plan plus the grammar); "Repros" (the repro table, each expected file and its SHA-256, the `p11-tier2` ruling, each exclusion row by reason); "Gate fixtures" (the seven headers, byte-identical, and `sandbox-symbols` per set); "R321, new tables" (Decision 7's table, codes, killing test, re-predicted red-checks, and "The baseline diff, by key" with the full `SA` and `RV` keys, per baseline: removed, changed with old and new verdict and killing test, and the count unchanged); "Corpora" (Step 7's numbers per corpus and set, the `ATTR` rulings, exclusion counts by reason, the listing files' SHA-256, each corpus's `hashTargetSource` and git head); "Memory" (master's `maxRSS_KB` per corpus and set, and the 110% gate); "Identity scheme" (the scheme it was made on, `S`, as committed in `before/scheme.json`; "the next scheme", numbered by the scheme-race rule; the measured key moves; and the old-engine record Task 8 uses: the L13 row of `before/fixture-sandbox-symbols.txt`); "What would count as a finding" (any capture not byte-identical to its expected file; any listing mismatch; `UNCLASSIFIED` or `EXTRA` above 0 after the change; any verdict or killing test off Decision 7's table; any R321 baseline key diff other than the pre-committed one; any gate-fixture byte that moves; a peak above 110%; a crash; a red-check red anywhere else, or not red); "Tools" (paths and SHA-256 of each tool, `$P` and `$Q`). No corpus source text.

- [ ] **Step 11: Commit ALONE, and checkpoint.**

```bash
git add docs/superpowers/specs/2026-09-29-r214-precommitment.md docs/superpowers/specs/r214-corpus packages/runner/tests/fixtures/r214 scripts/r214-capture.ts
git commit -m "spec(R214): pre-commitment: per-mutant sites per build for 13 repros, the gate fixtures, per-file corpus listings with exclusions and inactive ranges, master's peak memory, and the R321 re-freeze, before any product code"
```

Then `coord checkpoint --task R-214 --wait review --note "pre-commitment <sha>"`. No product code until it is reviewed.

---

### Task 2: The next identity scheme, before the engine changes (R325's rule)

**Why first.** Tasks 5 and 6 move keys for unchanged source (Decision 4). Every cross-session consumer must already refuse keys of the previous scheme when that lands.

**Files:**
- Modify: `packages/schemata/src/project.ts:100-105`, `CHANGELOG.md`, `fixtures/sandbox-harden/lethal.equivalent.json`, `docs/using-lethal-from-an-agent.md`
- Test: `packages/runner/tests/resume.test.ts`, `packages/runner/tests/named-return.test.ts`, `packages/runner/tests/__snapshots__/report-equality.test.ts.snap`, and any test Step 1 names

**Interfaces:**
- Produces: `IDENTITY_SCHEME` one above its value on the merged branch (call it `N`), read by `store.ts`, `resume.ts`, `report.ts`, `equivalence-marks.ts`, `verify.ts` as today.

- [ ] **Step 0: Scheme race check, mode `pre` (r3, C1, blocking).** Merge master, then, from the worktree root:

```bash
set -euo pipefail
scheme_of() { sed -n 's/^export const IDENTITY_SCHEME = \([0-9][0-9]*\);$/\1/p'; }
M=$(git show master:packages/schemata/src/project.ts | scheme_of)
B=$(scheme_of < packages/schemata/src/project.ts)
echo "master $(git rev-parse --short master) IDENTITY_SCHEME=$M; branch $(git rev-parse --short HEAD) IDENTITY_SCHEME=$B"
[ -n "$M" ] && [ -n "$B" ] || { echo "STOP: IDENTITY_SCHEME line not found"; exit 1; }
[ "$B" = "$M" ] || { echo "STOP: the branch is not at master's scheme before the bump"; exit 1; }
echo "OK: Task 2 sets N=$((M + 1))"
```

(`master` is the local branch the orchestrator merges into; the lane never reads `origin/master` for this.) Expected: `OK`. `N` is `M + 1`. A `STOP` is reported, not worked around.

**The mode `post` check**, run after every later `git merge master`, and in Task 11 Step 4 (the same first four lines, then):

```bash
if [ "$M" -ge "$B" ]; then echo "RACE: master holds $M, branch holds $B: re-bump to $((M + 1)) (Task 2 Step 6)"; exit 2; fi
fail=0
[ "$(grep -c "^- \*\*Identity scheme $B\*\* (R214)" CHANGELOG.md)" = 1 ] || { echo "MISMATCH: CHANGELOG has no 'Identity scheme $B (R214)' entry"; fail=1; }
grep -q "\"identityScheme\": $B," fixtures/sandbox-harden/lethal.equivalent.json || { echo "MISMATCH: harden marks file is not at $B"; fail=1; }
grep -q "\"identityScheme\": $B," docs/using-lethal-from-an-agent.md || { echo "MISMATCH: agent guide example is not at $B"; fail=1; }
[ "$fail" = 0 ] || exit 1
echo "OK: branch scheme $B is above master's $M, and the literals agree"
```

Both modes are `$T/scheme-race.sh pre|post`, run against this branch at plan time (`pre` gives `OK: Task 2 sets N=4`; `post` gives `RACE`, correctly, since nothing is bumped yet). Exit 2 means Step 6 now, before any other step. Exit 1 is a STOP.

- [ ] **Step 1: Know what the bump touches.** Read the current value `N - 1` from `project.ts` (Step 0's `M`). Set the constant to `N`, then `bun run typecheck && rm -rf packages/*/dist && bun test > $Q/logs/t2-scheme.txt 2>&1`. Expected failures, and nothing else: `resume.test.ts` (the `PINNED` fingerprint, and `expect(IDENTITY_SCHEME).toBe(3)` at line 1781 while master holds 3); `named-return.test.ts` (the guards `expect(IDENTITY_SCHEME).toBe(3)` at lines 561 and 663, and the controls that relabel a record to scheme 3 and expect it carried); `report-equality` (the snapshot's `"identityScheme"`); `packages/runner/itest/harden-fixture.test.ts` ("the committed mark names exactly the planted equivalent": the marks file still says `N - 1`). A failure anywhere else is a STOP: something reads the scheme as a literal.

- [ ] **Step 2: Update each by meaning.**
  - `project.ts`: the value is `N`; the doc comment gains `N: R214, a mutant in an #if arm the build compiles out is no longer generated, a file whose directives cannot be evaluated as alc does is not mutated, and a statement directly inside a statement-level #if became a statement position (measured moves in the R-214 plan).`
  - `resume.test.ts`: the new `PINNED` value from the red output, its comment extended `It moved again for R214 (the next scheme after R323's).`; line 1781's literal guard is deleted, and line 1782 (`expect(report.identityScheme).toBe(IDENTITY_SCHEME)`) stays.
  - `named-return.test.ts`: its comment says a later bump must revisit, not re-aim. Its n14 project holds no directive, so its key text is unchanged under `N` and the collision it exercises still holds. Each guard becomes `expect(IDENTITY_SCHEME).toBeGreaterThanOrEqual(3)` with the comment `R214: n14 holds no directive, so its keys are identical under every later scheme; these tests still mean "a scheme-2 record never reaches a current-scheme mutant".`; each control that relabels to 3 relabels to `IDENTITY_SCHEME` and its title says "the current scheme"; the refusal side keeps its literal 2, the measured older scheme.
  - `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`; the diff must be that one line.
  - `fixtures/sandbox-harden/lethal.equivalent.json`: `"identityScheme": N`. It holds no directive; Task 9 proves its keys byte-identical and Task 8 Step 5 proves the mark still matches.
  - `docs/using-lethal-from-an-agent.md`: the example's `identityScheme` reads `N`.
  - `CHANGELOG.md`, under `[Unreleased]` / `### Changed`, above the scheme 3 entry (with `N` written as the number):

```markdown
- **Identity scheme N** (R214): keys can move in any object that holds a `#if`. A mutant in an arm
  the build's preprocessor symbols compile out is no longer generated, a file whose directives
  LethAL cannot evaluate as alc does is not mutated at all, and a statement directly inside a
  statement-level `#if` is now a mutation site, so twin mutants renumber. Runs now record their
  effective preprocessor symbols (config plus `app.json`), and history, resume and equivalence
  marks apply only within the same set. Existing marks files need `"identityScheme": N` after
  re-checking each mark against a fresh report, and a mark for a project whose `app.json` or config
  defines symbols needs `"preprocessorSymbols"` naming them. History and resume from older-scheme
  runs are refused by name (R325).
```

- [ ] **Step 3: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. `bunx biome check packages/schemata/src/project.ts packages/runner/tests/resume.test.ts packages/runner/tests/named-return.test.ts`.

- [ ] **Step 4: Red-check.** Revert the constant alone to the starting scheme `S` (the value `before/scheme.json` holds, which is `N - 1` only on this first bump): `resume.test.ts`'s `PINNED` test, the snapshot and the harden mark test go red; restore: green. Record in `$Q/logs/t2-redcheck.txt`. (The same-text transitions are pinned in Task 8, where the moved keys exist.)

- [ ] **Step 5: Commit.** `git commit -m "fix(R214): the next identity scheme; dropping compiled-out arms, refusing undecidable files and lifting in-arm statements move keys for unchanged source (R325's rule)"`. Then run the mode `post` check (Step 0): expected `OK: branch scheme N is above master's N - 1`.

- [ ] **Step 6: The re-bump, only when a mode `post` check exits 2 (r3, C1).** Master now holds `M >= B`: another lane (R-318) took this branch's number. Set `N' = M + 1`, and in ONE commit:
  - `packages/schemata/src/project.ts`: `IDENTITY_SCHEME = N'`; the R214 doc line's number becomes `N'`, placed after master's own line for `M` (keep that line as master wrote it).
  - `CHANGELOG.md`: this branch's entry heading becomes `**Identity scheme N'** (R214)`, with `N'` also in its body, and it sits ABOVE master's entry for `M`.
  - `fixtures/sandbox-harden/lethal.equivalent.json` and `docs/using-lethal-from-an-agent.md:490`: `"identityScheme": N'`.
  - `resume.test.ts`'s `PINNED` fingerprint and the `report-equality` snapshot: re-derived exactly as Step 2 did (the red output, then `--update-snapshots`; the diff is the one line).
  - `before/scheme.json` does NOT change: `S` is the scheme the pre-commitment was made on.
  - Commit `fix(R214): identity scheme N', since master took M (R-318); keys of the two pipelines must never share a scheme`.

  Then re-run, in order, and record each in `$Q/logs/rebump-<N'>.txt`: the mode `post` check (expected `OK`); `bun run typecheck && rm -rf packages/*/dist && bun test` (the whole suite, which holds the transition tests of Task 8 and Task 2's pins); Task 2 Step 4's red-check against `S`; and, if the tasks exist yet, Task 8 Step 7 (f), Task 9 Steps 1, 3 and 6 (the captures), and Task 10 Steps 2 and 6 (the live gates, since master's engine changed under them). A capture that no longer equals its pre-committed file after merging R-318's engine is a STOP and a question to the orchestrator (the pre-commitment may need an amendment), never an edit of the expectation.

---

### Task 3: The symbol helpers: one validator, `app.json` read strictly, one effective set (I6, Q2)

**Files:**
- Create: `packages/runner/src/preprocessor-symbols.ts`
- Modify: `packages/runner/src/cli.ts:2079-2112` (`SYMBOL_SEPARATOR_RE`, `validatePreprocessorSymbols`)
- Test: `packages/runner/tests/preprocessor-symbols.test.ts`

**Interfaces:**
- Produces, exactly:

```ts
export function validateSymbolList(raw: unknown, source: string): readonly string[];
export function appJsonSymbols(
  projectDir: string,
  snapshot: ReadonlyMap<string, Buffer> | undefined,
  readFileFn?: (path: string) => Promise<string>,
): Promise<readonly string[]>;
export function effectiveBuildSymbols(
  projectDir: string,
  configSymbols: readonly string[],
  snapshot: ReadonlyMap<string, Buffer> | undefined,
): Promise<readonly string[]>;
export function sameBuildSymbols(a: readonly string[], b: readonly string[]): boolean;
```

- [ ] **Step 1: Write the failing tests.** Append to `packages/runner/tests/preprocessor-symbols.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appJsonSymbols,
  effectiveBuildSymbols,
  sameBuildSymbols,
  validateSymbolList,
} from "../src/preprocessor-symbols";

describe("R214: the effective build symbols", () => {
  const snap = (json: unknown) => new Map([["app.json", Buffer.from(JSON.stringify(json))]]);

  test("app.json's symbols come from the snapshot when it has app.json", async () => {
    expect(await appJsonSymbols("/nowhere", snap({ preprocessorSymbols: ["BC20", "BC21"] }))).toEqual([
      "BC20",
      "BC21",
    ]);
    expect(await appJsonSymbols("/nowhere", snap({ name: "x" }))).toEqual([]);
  });

  test("a MISSING app.json means none, and only a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-sym-"));
    try {
      expect(await appJsonSymbols(dir, undefined)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const denied = async (): Promise<string> => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    await expect(appJsonSymbols("/p", undefined, denied)).rejects.toThrow(/app\.json.*EACCES/);
  });

  test("app.json's list is validated like the config's, naming app.json", async () => {
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: "BC20" }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" must be an array of strings/,
    );
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: ["A B"] }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" entry "A B" contains whitespace or a separator/,
    );
    await expect(appJsonSymbols("/p", snap({ preprocessorSymbols: [""] }))).rejects.toThrow(
      /app\.json: "preprocessorSymbols" contains a non-string or empty entry/,
    );
  });

  test("the effective set is the sorted union; case matters (alc, measured)", async () => {
    expect(
      await effectiveBuildSymbols("/p", ["CLEAN27", "BC20", "bc20"], snap({ preprocessorSymbols: ["BC20"] })),
    ).toEqual(["BC20", "CLEAN27", "bc20"]);
    expect(sameBuildSymbols(["B", "A"], ["A", "B", "A"])).toBe(true);
    expect(sameBuildSymbols(["A"], ["a"])).toBe(false);
    expect(sameBuildSymbols([], [])).toBe(true);
  });

  test("validateSymbolList keeps the config's exact messages", () => {
    expect(() => validateSymbolList("X", "lethal.config.json")).toThrow(
      'lethal.config.json: "preprocessorSymbols" must be an array of strings, got "X"',
    );
  });
});
```

- [ ] **Step 2: Run, expect red.** `bun test packages/runner/tests/preprocessor-symbols.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** `packages/runner/src/preprocessor-symbols.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * R214: the build's preprocessor symbols, as alc 18.0.41 computes them (measured, the R-214 plan):
 * the `/define` list LethAL passes (the config's `preprocessorSymbols`) UNIONED with `app.json`'s own
 * `preprocessorSymbols`. Symbol names are case-sensitive. A file's own `#define` / `#undef` are
 * applied per file by `evaluateArms` (@lethal/engine), not here.
 */

// A symbol carrying a comma, a semicolon or whitespace would either be split by alc's `/define:A,B`
// list form into things nobody wrote, or reach al-runner as one unusable token.
const SYMBOL_SEPARATOR_RE = /[,;\s]/;

/** The one validation rule for a symbol list, wherever it is read from. `source` names the file
 *  in every message. Absent means `[]`. */
export function validateSymbolList(raw: unknown, source: string): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${source}: "preprocessorSymbols" must be an array of strings, got ${JSON.stringify(raw)}`,
    );
  }
  const symbols: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `${source}: "preprocessorSymbols" contains a non-string or empty entry (${JSON.stringify(entry)}) \u2014 every entry must be an AL preprocessor symbol`,
      );
    }
    if (SYMBOL_SEPARATOR_RE.test(entry)) {
      throw new Error(
        `${source}: "preprocessorSymbols" entry ${JSON.stringify(entry)} contains whitespace or a separator \u2014 list each symbol as its own array entry`,
      );
    }
    symbols.push(entry);
  }
  return symbols;
}

/**
 * `app.json`'s `preprocessorSymbols`, from the source snapshot when it holds `app.json` (so the
 * symbols are read from the bytes the build compiles), else from disk. Only a MISSING `app.json`
 * reads as none, because several callers pass a `src` directory. Any other read error, bad JSON,
 * or a list the config would refuse throws, naming the file: alc would read a list we did not.
 */
export async function appJsonSymbols(
  projectDir: string,
  snapshot: ReadonlyMap<string, Buffer> | undefined,
  readFileFn: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<readonly string[]> {
  const path = join(projectDir, "app.json");
  const bytes = snapshot?.get("app.json");
  let text: string;
  if (bytes !== undefined) {
    text = bytes.toString("utf8");
  } else {
    try {
      text = await readFileFn(path);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw new Error(
        `${path}: cannot be read (${err instanceof Error ? err.message : String(err)}), so its preprocessor symbols are unknown`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)}), so its preprocessor symbols are unknown`,
    );
  }
  const raw =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { preprocessorSymbols?: unknown }).preprocessorSymbols
      : undefined;
  return validateSymbolList(raw, path);
}

/** The build's effective symbols: sorted and de-duplicated, so two equal sets compare equal. */
export async function effectiveBuildSymbols(
  projectDir: string,
  configSymbols: readonly string[],
  snapshot: ReadonlyMap<string, Buffer> | undefined,
): Promise<readonly string[]> {
  const fromApp = await appJsonSymbols(projectDir, snapshot);
  return [...new Set([...fromApp, ...configSymbols])].sort();
}

/** Whether two symbol lists name the same build. Order and repeats do not matter; case does. */
export function sameBuildSymbols(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((s, i) => s === y[i]);
}
```

Two of the messages keep the character the existing config messages print at that spot, written as the escape `\u2014` so the source holds no em dash while the output stays byte-identical to what `preprocessor-symbols.test.ts` pins today. In `cli.ts`, delete `SYMBOL_SEPARATOR_RE` and replace `validatePreprocessorSymbols`'s body with `return validateSymbolList(raw, "lethal.config.json");`, keeping its doc comment and export, and import `validateSymbolList` from `./preprocessor-symbols`.

- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/preprocessor-symbols.test.ts packages/runner/tests/cli.test.ts`. `bunx biome check packages/runner/src/preprocessor-symbols.ts packages/runner/src/cli.ts packages/runner/tests/preprocessor-symbols.test.ts`.

- [ ] **Step 5: Red-check each part alone**, in `$Q/logs/t3-redcheck.txt`: (a) the snapshot branch removed (always read disk): the snapshot test goes red; (b) `validateSymbolList(raw, path)` replaced by `Array.isArray(raw) ? raw : []`: the validation test goes red; (c) the `ENOENT` condition removed (every read error returns `[]`): the `EACCES` test goes red; (d) the `ENOENT` check replaced by a bare `return []` in the catch: the same test goes red; (e) `.sort()` removed from `effectiveBuildSymbols`: the union test goes red.

- [ ] **Step 6: Commit.** `git commit -m "feat(R214): one validator for symbol lists; app.json symbols read from the snapshot, and only a missing app.json reads as none"`.

---

### Task 4: The arm evaluator (engine), with alc's measured grammar (C2, I7)

**Files:**
- Create: `packages/engine/src/ast/preproc-arms.ts`
- Modify: `packages/engine/src/index.ts` (export next to the `tree-walks` block)
- Test: `packages/engine/tests/ast/preproc-arms.test.ts`

**Interfaces:**
- Produces, exactly (Task 6 imports these names from `@lethal/engine`):

```ts
export type ArmEvaluation =
  | { readonly kind: "decided"; readonly inactive: readonly (readonly [number, number])[] }
  | { readonly kind: "undecided"; readonly reason: string };
export function evaluateArms(
  root: ALSyntaxNode,
  source: string,
  symbols: readonly string[],
): ArmEvaluation;
export function startsInInactiveArm(
  inactive: readonly (readonly [number, number])[],
  offset: number,
): boolean;
```

- [ ] **Step 1: Write the failing tests.** `packages/engine/tests/ast/preproc-arms.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type ALSyntaxNode,
  evaluateArms,
  initParser,
  parseAL,
  startsInInactiveArm,
  wrapRoot,
} from "../../src/index";

beforeAll(async () => {
  await initParser();
});

const run = (src: string, symbols: readonly string[]) =>
  evaluateArms(wrapRoot(parseAL(src)), src, symbols);

/** The code lines (directive lines skipped) of `src` whose first non-blank byte is in an inactive
 *  range, 1-based; or the refusal. */
function inactiveLines(src: string, symbols: readonly string[]): number[] | string {
  const r = run(src, symbols);
  if (r.kind === "undecided") return `undecided: ${r.reason}`;
  const out: number[] = [];
  let start = 0;
  src.split("\n").forEach((line, i) => {
    const code = line.trim() !== "" && !line.trimStart().startsWith("#");
    if (code && startsInInactiveArm(r.inactive, start + line.search(/\S/))) out.push(i + 1);
    start += line.length + 1;
  });
  return out;
}

const body = (directives: string): string =>
  `codeunit 50001 "P"\n{\n    procedure A(X: Integer)\n    begin\n${directives}\n    end;\n}\n`;

/** A two-arm probe as alc was probed: line 6 is ARM1 (`#if`), line 8 is ARM2 (`#else`). */
const twoArm = (cond: string) => body(`#if ${cond}\n        X := 1;\n#else\n        X := 2;\n#endif`);
const built = (cond: string, symbols: readonly string[]): string => {
  const r = inactiveLines(twoArm(cond), symbols);
  if (typeof r === "string") return r;
  if (r.length !== 1) return `bad: ${r.join(",")}`;
  return r[0] === 8 ? "ARM1" : "ARM2";
};

/**
 * The measured table (alc 18.0.41.45789, H:/lethal-scratch/R-214/plan-r2/prec/battery*.txt, and
 * the R-214 plan's table "alc's precedence, measured"): condition, /define set, the arm alc built.
 */
const MEASURED: readonly [string, readonly string[], "ARM1" | "ARM2"][] = [
  ["A", ["A"], "ARM1"],
  ["A", [], "ARM2"],
  ["A", ["a"], "ARM2"],
  ["NOT A", ["A"], "ARM2"],
  ["Not A", [], "ARM1"],
  ["A AND B", ["A", "B"], "ARM1"],
  ["A AND B", ["A"], "ARM2"],
  ["A Or B", ["B"], "ARM1"],
  ["UNDEFINEDSYM", [], "ARM2"],
  ["CLEAN_27x", ["CLEAN_27x"], "ARM1"],
  ["A or B and C", ["A"], "ARM1"],
  ["A or B and C", ["B", "C"], "ARM1"],
  ["A or B and C", ["C"], "ARM2"],
  ["A and B or C", ["C"], "ARM1"],
  ["A and B or C", ["A"], "ARM2"],
  ["not A and B", [], "ARM2"],
  ["not A and B", ["A"], "ARM2"],
  ["not A and B", ["B"], "ARM1"],
  ["not A and B", ["A", "B"], "ARM2"],
  ["not A or B", [], "ARM1"],
  ["not A or B", ["A", "B"], "ARM1"],
  ["A and not B or C", ["A", "B", "C"], "ARM1"],
  ["A and not B or C", ["A"], "ARM1"],
  ["not not A", ["A"], "ARM1"],
  ["not not A", [], "ARM2"],
  ["not (A and B)", [], "ARM1"],
  ["not (A and B)", ["A", "B"], "ARM2"],
  ["(A or B) and C", ["A"], "ARM2"],
  ["(A or B) and C", ["B", "C"], "ARM1"],
  ["((A))", ["A"], "ARM1"],
  ["(A)and(B)", ["A", "B"], "ARM1"],
  ["(A)and(B)", ["A"], "ARM2"],
  ["not(A)", ["A"], "ARM2"],
  ["not(A)", [], "ARM1"],
  ["A and (B or not C)", ["A"], "ARM1"],
  ["A and (B or not C)", ["A", "C"], "ARM2"],
  ["A and (B or not C)", ["A", "B", "C"], "ARM1"],
  ["true", [], "ARM1"],
  ["TRUE", [], "ARM1"],
  ["false", [], "ARM2"],
  ["not true", [], "ARM2"],
  ["true", ["true"], "ARM1"],
  ["X or false", ["X"], "ARM1"],
  ["X or false", [], "ARM2"],
  ["A // note", ["A"], "ARM1"],
  ["A // note", [], "ARM2"],
];

describe("R214: evaluateArms follows alc's measured grammar", () => {
  for (const [cond, symbols, arm] of MEASURED) {
    test(`#if ${cond} under [${symbols.join(",")}] builds ${arm}`, () => {
      expect(built(cond, symbols)).toBe(arm);
    });
  }

  test("refused: every condition alc rejects, and a bare keyword alc accepts without meaning", () => {
    // Some of these the grammar itself cannot parse, and then the file is refused earlier, by the
    // marker cross-check; either way it is refused, never evaluated.
    for (const cond of ["!A", "A == B", "A and", "A or", "A B", "1A"])
      expect(built(cond, ["A", "B"])).toMatch(/^undecided: /);
    // These the grammar parses (measured: `and` gives 3 markers; r1: && and || parse), so the
    // refusal must come from the condition parser itself.
    for (const cond of ["and", "A && B", "A || B"])
      expect(built(cond, ["A", "B"])).toBe("undecided: unparsed-condition at line 5");
  });

  test("#if / #elif / #elif / #else: the first true arm is built, and only it (row 28)", () => {
    const chain = body(
      "#if A\n        X := 1;\n#elif B\n        X := 2;\n#elif C\n        X := 3;\n#else\n        X := 4;\n#endif",
    );
    expect(inactiveLines(chain, [])).toEqual([6, 8, 10]);
    expect(inactiveLines(chain, ["A", "C"])).toEqual([8, 10, 12]);
    expect(inactiveLines(chain, ["B", "C"])).toEqual([6, 10, 12]);
    expect(inactiveLines(chain, ["C"])).toEqual([6, 8, 12]);
  });

  test("nesting: an inner arm counts only inside a built outer arm (row 29)", () => {
    const src = body(
      "#if A\n#if B\n        X := 1;\n#else\n        X := 2;\n#endif\n#else\n#if B\n        X := 3;\n#endif\n        X := 4;\n#endif",
    );
    expect(inactiveLines(src, [])).toEqual([7, 9, 13]);
    expect(inactiveLines(src, ["B"])).toEqual([7, 9]);
    expect(inactiveLines(src, ["A", "B"])).toEqual([9, 13, 15]);
  });

  test("unbalanced markers refuse the file (rows 30, 31)", () => {
    expect(inactiveLines(body("#if A\n        X := 1;\n#else\n        X := 2;\n#elif B\n        X := 3;\n#endif"), ["B"])).toMatch(/^undecided: unbalanced at line 9$/);
    expect(inactiveLines(body("        X := 1;\n#endif"), [])).toMatch(/^undecided: unbalanced at line 6$/);
    expect(inactiveLines(body("#if A\n        X := 1;"), [])).toMatch(/^undecided: /);
  });

  test("#define and #undef count where active, in order, case-sensitively (rows 36 to 41)", () => {
    const src = `#define LOCAL\n#undef DROP\n#if OUTER\n#define LATE\n#endif\n#define l\n${body("#if LOCAL\n        X := 1;\n#endif\n#if DROP\n        X := 2;\n#endif\n#if LATE\n        X := 3;\n#endif\n#if L\n        X := 4;\n#endif")}`;
    expect(inactiveLines(src, ["DROP"])).toEqual([15, 18, 21]);
    expect(inactiveLines(src, ["DROP", "OUTER"])).toEqual([15, 21]);
  });

  test("a directive-looking line in a block comment refuses the file (row 49)", () => {
    expect(inactiveLines(body("/*\n#if A\n*/\n        X := 1;\n/*\n#endif\n*/"), [])).toMatch(
      /^undecided: marker-mismatch \(2 directive lines, 0 markers\)$/,
    );
  });

  test("a BOM before the first #if is still a directive line (six corpus files start so)", () => {
    // Counts only: tree offsets are bytes and a BOM is three of them, so no string index is used.
    const src = `\uFEFF#if A\n${body("        X := 1;")}#endif\n`;
    const off = run(src, []);
    const on = run(src, ["A"]);
    expect(off.kind === "decided" ? off.inactive.length : off.reason).toBe(1);
    expect(on.kind === "decided" ? on.inactive.length : on.reason).toBe(0);
  });

  test("a node that STARTS in active code but contains a compiled-out arm is not in a range", () => {
    const src = body("#if A\n        X := 1;\n#endif");
    const r = run(src, []);
    if (r.kind !== "decided") throw new Error("decided expected");
    expect(startsInInactiveArm(r.inactive, src.indexOf("begin"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("#if"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("X := 1"))).toBe(true);
  });

  test("a refused condition inside a compiled-out arm refuses nothing (it is never evaluated)", () => {
    expect(inactiveLines(body("#if A\n#if B && C\n        X := 1;\n#endif\n#endif"), [])).toEqual([7]);
  });

  test("a file with no directive line is never walked (I7)", () => {
    const untouchable = new Proxy({} as ALSyntaxNode, {
      get: () => {
        throw new Error("walked a directive-free file");
      },
    });
    expect(evaluateArms(untouchable, 'codeunit 50001 "P" { }\n', ["A"])).toEqual({
      kind: "decided",
      inactive: [],
    });
  });
});
```

- [ ] **Step 2: Run, expect red.** `bun test packages/engine/tests/ast/preproc-arms.test.ts`. Expected: FAIL, `evaluateArms` is not exported.

- [ ] **Step 3: Implement.** `packages/engine/src/ast/preproc-arms.ts`:

```ts
import type { ALSyntaxNode } from "./syntax-node";

/**
 * R214: which bytes of one file a build compiles out, given that build's preprocessor symbols.
 *
 * alc's rules, measured with alc 18.0.41 (docs/superpowers/plans/2026-09-29-R-214-symbol-aware-
 * site-enumeration.md, "alc's precedence, measured"): `not` binds to the next operand, then `and`,
 * then `or`; parentheses group; `true` and `false` are literals; keywords are case-insensitive and
 * symbols are not; an undefined symbol is false; `#define` / `#undef` count where they sit in an
 * active region. A condition is read from the marker's TEXT: tree-sitter-al 4.4.1 scopes `not` over a
 * following `and` / `or`, and trusting its expression nodes would pick the wrong arm with no error.
 *
 * The walk is over every directive marker in document order, never per container:
 * `preproc_split_if_then_begin_else_shared` holds an `#if` whose `#endif` is outside it, and
 * `preproc_fragmented_else_tail` the reverse.
 *
 * Anything it cannot evaluate exactly as alc does is `undecided` with a reason code (never source
 * text), and the caller then generates no mutant in the file.
 */
export type ArmEvaluation =
  | { readonly kind: "decided"; readonly inactive: readonly (readonly [number, number])[] }
  | { readonly kind: "undecided"; readonly reason: string };

const DIRECTIVE_KINDS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
  "preproc_define",
  "preproc_undef",
]);
/** A directive line as alc reads one: first on its line, a BOM allowed before the first. */
const DIRECTIVE_LINE = /^\uFEFF?[ \t]*#[ \t]*(?:if|elif|else|endif|define|undef)\b/gim;
const CONDITION_HEAD = /^#[ \t]*(?:if|elif)\b/i;
const SYMBOL_DIRECTIVE = /^#[ \t]*(define|undef)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\/\/.*)?$/i;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\(|\)|\S/g;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATOR_WORDS: ReadonlySet<string> = new Set(["and", "or", "not"]);

/** Internal: never leaves `evaluateArms`. */
class UndecidedArm extends Error {}

function lineOf(n: ALSyntaxNode): number {
  return n.startPosition.row + 1;
}

/** alc's grammar over one condition's text. Throws `UndecidedArm` on anything else. */
function holds(text: string, defined: ReadonlySet<string>, line: number): boolean {
  const toks = text.match(TOKEN) ?? [];
  let i = 0;
  const fail = (): never => {
    throw new UndecidedArm(`unparsed-condition at line ${line}`);
  };
  const isWord = (t: string | undefined, w: string): boolean => t?.toLowerCase() === w;
  const primary = (): boolean => {
    const t = toks[i++];
    if (t === "(") {
      const v = or();
      if (toks[i++] !== ")") fail();
      return v;
    }
    if (t === undefined || !IDENT.test(t) || OPERATOR_WORDS.has(t.toLowerCase())) return fail();
    if (isWord(t, "true")) return true;
    if (isWord(t, "false")) return false;
    return defined.has(t);
  };
  const unary = (): boolean => {
    if (isWord(toks[i], "not")) {
      i++;
      return !unary();
    }
    return primary();
  };
  const and = (): boolean => {
    let v = unary();
    while (isWord(toks[i], "and")) {
      i++;
      const r = unary();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (isWord(toks[i], "or")) {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  if (i !== toks.length) fail();
  return v;
}

function conditionText(marker: ALSyntaxNode): string {
  const text = marker.text.trim();
  const head = CONDITION_HEAD.exec(text);
  if (head === null) throw new UndecidedArm(`unparsed-condition at line ${lineOf(marker)}`);
  return text
    .slice(head[0].length)
    .replace(/\/\/.*$/s, "")
    .trim();
}

function markersOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_KINDS.has(n.rawKind)) {
      out.push(n);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

export function evaluateArms(
  root: ALSyntaxNode,
  source: string,
  symbols: readonly string[],
): ArmEvaluation {
  // R214 I7: a file with no directive line costs one scan and no walk (93% of corpus files, measured).
  const lines = source.match(DIRECTIVE_LINE)?.length ?? 0;
  if (lines === 0) return { kind: "decided", inactive: [] };
  const defined = new Set(symbols);
  /** One open `#if`: whether its outer region is built, whether an arm was taken, whether the
   *  current arm is built, whether its `#else` was seen (row 30), and its line for a refusal. */
  const frames: { outer: boolean; taken: boolean; active: boolean; closed: boolean; line: number }[] =
    [];
  const inactive: [number, number][] = [];
  const active = (): boolean => frames.at(-1)?.active ?? true;
  let closedAt: number | null = null;
  try {
    const markers = markersOf(root);
    if (markers.length !== lines) {
      throw new UndecidedArm(
        `marker-mismatch (${lines} directive lines, ${markers.length} markers)`,
      );
    }
    for (const d of markers) {
      const before = active();
      if (d.rawKind === "preproc_define" || d.rawKind === "preproc_undef") {
        if (!before) continue;
        const m = SYMBOL_DIRECTIVE.exec(d.text.trim());
        if (m === null) throw new UndecidedArm(`bad-define at line ${lineOf(d)}`);
        const [, verb = "", name = ""] = m;
        if (verb.toLowerCase() === "define") defined.add(name);
        else defined.delete(name);
        continue;
      }
      if (d.rawKind === "preproc_if") {
        const v = before && holds(conditionText(d), defined, lineOf(d));
        frames.push({ outer: before, taken: v, active: v, closed: false, line: lineOf(d) });
      } else {
        const f = frames.at(-1);
        if (f === undefined) throw new UndecidedArm(`unbalanced at line ${lineOf(d)}`);
        if (d.rawKind === "preproc_endif") {
          frames.pop();
        } else {
          if (f.closed) throw new UndecidedArm(`unbalanced at line ${lineOf(d)}`);
          if (d.rawKind === "preproc_elif") {
            const v = f.outer && !f.taken && holds(conditionText(d), defined, lineOf(d));
            f.active = v;
            f.taken = f.taken || v;
          } else {
            f.active = f.outer && !f.taken;
            f.taken = true;
            f.closed = true;
          }
        }
      }
      const after = active();
      if (before && !after) closedAt = d.endIndex;
      else if (!before && after && closedAt !== null) {
        inactive.push([closedAt, d.startIndex]);
        closedAt = null;
      }
    }
    const open = frames.at(-1);
    if (open !== undefined) throw new UndecidedArm(`unbalanced at line ${open.line}`);
  } catch (err) {
    if (err instanceof UndecidedArm) return { kind: "undecided", reason: err.message };
    throw err;
  }
  return { kind: "decided", inactive };
}

/** Whether `offset` lies inside one of `evaluateArms`'s inactive ranges. ponytail: linear over a
 *  file's ranges (a few dozen at most in BaseApp); a binary search if a file ever holds thousands. */
export function startsInInactiveArm(
  inactive: readonly (readonly [number, number])[],
  offset: number,
): boolean {
  return inactive.some(([from, to]) => from <= offset && offset < to);
}
```

An `#if` never closed is reported at its own line.

Export from `packages/engine/src/index.ts`: `export { evaluateArms, startsInInactiveArm } from "./ast/preproc-arms";` and `export type { ArmEvaluation } from "./ast/preproc-arms";`. If `ALSyntaxNode` has no `startPosition`, use the same row accessor `tree-walks.ts` uses for lines (the plan-time probe `$Q/tree/markers.ts` read `n.startPosition.row`, so it exists on the wrapped node).

- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/engine`. `bunx biome check packages/engine/src/ast/preproc-arms.ts packages/engine/src/index.ts packages/engine/tests/ast/preproc-arms.test.ts`.

- [ ] **Step 5: Red-check each part alone** (`mutation-red-checker`), in `$Q/logs/t4-redcheck.txt`: (a) `unary` reads `not` over a whole `and` (replace `return !unary();` with `return !and();`): the rows `not A and B` under `[]` and `not A or B` under `[A,B]` go red; (b) `and` and `or` swapped in precedence (`or` calls `unary`, `and` calls `or`): `A or B and C` under `[C]` goes red; (c) the `true` / `false` branches removed: `true` under `[]` goes red; (d) `OPERATOR_WORDS` check removed: the refusal test goes red on `and`; (e) the marker-mismatch check removed: the block-comment test goes red; (f) the `\uFEFF?` removed from `DIRECTIVE_LINE`: the BOM test goes red (mismatch); (g) `before &&` removed from `preproc_if`: "a refused condition inside a compiled-out arm" goes red; (h) the define branch's `if (!before) continue;` removed: the define test goes red; (i) `f.taken = f.taken || v` replaced by `f.taken = v`: the chain test goes red under `[A,C]`; (j) `defined.has(t)` replaced by a lowercase comparison: `A` under `[a]` goes red; (k) the fast path removed: the Proxy test goes red; (l) the `closed` check removed: the unbalanced test goes red.

- [ ] **Step 6: Commit.** `git commit -m "feat(R214): evaluateArms reads conditions from the marker text by alc's measured grammar, skips directive-free files, and refuses by reason code what it cannot evaluate"`.

---

### Task 5: A statement directly inside a statement-level `#if` is a statement position (closes R342's cause)

Unchanged from r1's Task 4, which the review did not contest.

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts:33-37`
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/reach-grain-fixtures.test.ts`

**Interfaces:**
- Produces: `isStatementPosition(node)` true for a direct child of a `preproc_conditional_statement` that is itself in statement position; `isStatementSlot` follows (it calls it first).

- [ ] **Step 1: Write the failing tests.** In `tree-walks.test.ts`, a new describe:

```ts
describe("R214: a statement directly inside a statement-level #if", () => {
  const src = `codeunit 50001 "P"
{
    procedure A(X: Integer)
    begin
#if S
        Helper(X);
#if T
        X := 2;
#endif
#endif
        if X > 0 then
#if S
            Helper(X)
#endif
        ;
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
  const callAt = (root: ALSyntaxNode, needle: string): ALSyntaxNode => {
    const at = src.indexOf(needle);
    const hit = findAll(root, ALNodeKind.procedure_call).find((n) => n.startIndex === at);
    if (hit === undefined) throw new Error(`no call at ${needle}`);
    return hit;
  };
  it("an arm of a #if in a statement list is a statement list, nested arms too", () => {
    const root = wrapRoot(parseAL(src));
    expect(isStatementPosition(callAt(root, "Helper(X);"))).toBe(true);
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    expect(isStatementPosition(assign)).toBe(true);
    expect(isStatementSlot(assign)).toBe(true);
  });
  it("an arm of a #if in a single-statement slot is not (a named exclusion, unchanged)", () => {
    const root = wrapRoot(parseAL(src));
    const inSlot = callAt(root, "Helper(X)\n#endif");
    expect(isStatementPosition(inSlot)).toBe(false);
    expect(isStatementSlot(inSlot)).toBe(false);
  });
});
```

(The file already imports `findFirst`, `ALNodeKind`, `isStatementPosition` and `isStatementSlot`; add `findAll` from `../../src`. The file uses `it`, not `test`.)

In `reach-grain-fixtures.test.ts`, add `"fixtures/sandbox-symbols"` to `PROJECTS`. Until Task 6 the call passes no symbols and every arm is generated, which is the strongest check of this hunk (all 13 must have a grain).

- [ ] **Step 2: Run, expect red.** `bun test packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/reach-grain-fixtures.test.ts`. Expected: the first new test FAILS (`false` for `Helper(X);`), the slot test passes (a pin), and the grain test FAILS listing six `sandbox-symbols` `unplaced` entries (`M0008` to `M0013`, lines 13, 15, 17).

- [ ] **Step 3: Implement.**

```ts
export function isStatementPosition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.kind === ALNodeKind.statement_block || parent.kind === ALNodeKind.block) return true;
  // R214: an arm of a `#if` that sits in a statement list is itself a statement list. A `#if` in a
  // single-statement slot is not: only its first statement would fill the slot, so it stays out.
  return parent.rawKind === "preproc_conditional_statement" && isStatementPosition(parent);
}
```

Extend the doc comment above it by one paragraph saying the same, and naming the three consumers whose output this moves: `wrapIfSingleStatementSlot` (`packages/schemata/src/compile.ts`, no `begin ... end` wrap for an in-arm statement, correct because the arm is a list), `placeReach`'s P2 (statement grain, R342), and `isConsumedCodeunitRun` (a bare in-arm `Codeunit.Run` is bare).

- [ ] **Step 4: Green where expected.** `bun test packages/engine packages/builtin-tier1 packages/builtin-tier2 packages/schemata`. The tree-walks tests pass. The grain test passes for `sandbox-symbols` (the six are `statement`). List every OTHER red test in `$Q/logs/t5-reds.txt`. Expected: only tests that pin emitted text or grain for a mutant inside a `preproc_conditional_statement` arm (candidates: `packages/schemata/tests/compile.test.ts`, `packages/builtin-tier2/tests/write-txn-codeunit-run.test.ts`). Rule each by meaning in the log: an emitted `begin ... end` around an in-arm statement that is no longer there, an `enclosing` grain that is now `statement`, or a write-transaction tag that is gone, is the pre-committed change and its expectation is updated with an `R214` comment; anything else is a STOP.

- [ ] **Step 5: Red-check.** Revert the hunk alone: the first tree-walks test and the grain test go red; restore, green. Record in `$Q/logs/t5-redcheck.txt`.

- [ ] **Step 6: Commit.** `git commit -m "fix(R214, R342): a statement directly inside a statement-level #if is a statement position; the six unplaced sandbox-symbols mutants get statement grain"`.

---

### Task 6: `generateMutationSet` drops compiled-out sites and refuses undecided files; the symbols are threaded

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (`MutationSetOptions` at `:372`, `MutationSetResult`, `generateMutationSet` at `:629`, `runSession`'s call at `:4183`)
- Modify: `packages/runner/src/cli.ts` (`printDryRun` at `:2982`, its caller at `:5079`)
- Modify: `packages/runner/src/excluded-sites.ts` (the `PreprocExcludedFile` type only; the report wiring is Task 7)
- Create: `packages/runner/tests/r214-compiled-out.test.ts`
- Modify: `packages/runner/tests/cli.test.ts` (the C02-06 describe), `packages/runner/tests/reach-grain-fixtures.test.ts` (per set), and the tests Step 6 names

**Interfaces:**
- Consumes: `evaluateArms`, `startsInInactiveArm` (Task 4); `effectiveBuildSymbols` (Task 3).
- Produces: `MutationSetOptions.preprocessorSymbols?: readonly string[]`; `MutationSetResult.preprocExcluded: readonly PreprocExcludedFile[]` and `MutationSetResult.buildSymbols: readonly string[]`; warnings `compiled-out-sites` and `preproc-arms-undecided`; `printDryRun`'s `paths.preprocessorSymbols?: readonly string[]`.

```ts
// packages/runner/src/excluded-sites.ts
/** R214: a file whose sites the build's preprocessor symbols decided. `detail` is the effective
 *  symbols for `compiled-out` and the reason code for `preproc-undecided`; never source text. */
export interface PreprocExcludedFile {
  readonly file: string;
  readonly kinds: string;
  readonly sites: number;
  readonly reason: "compiled-out" | "preproc-undecided";
  readonly detail: string;
}
```

- [ ] **Step 1: Write the failing runner test.** `packages/runner/tests/r214-compiled-out.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutantManifest, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R214's pre-commitment (docs/superpowers/specs/2026-09-29-r214-precommitment.md), per repro and
 * per build: the deployed mutants, in the capture's row format, must equal the committed file byte
 * for byte. A difference is a finding and a stop: never edit an expected file to match.
 */
const HERE = import.meta.dir;
const R214 = join(HERE, "fixtures", "r214");
const REPO = resolve(HERE, "../../..");
const norm = (p: string): string => p.replaceAll("\\", "/");

/** r3, I5: a valid codeunit with no site whose one directive-looking line is in a block comment. */
export const EMPTY_REFUSED = 'codeunit 50018 "P12 Empty"\n{\n/*\n#if R12SYM\n*/\n}\n';

/** r3, minor b: `#if and` compiles (alc builds ARM2, measured row 21), and its meaning is unknown,
 *  so the file is refused. Line 5 is the `#if`. */
export const BARE_AND = `codeunit 50017 "P12 Bare And"
{
    procedure Run(X: Integer)
    begin
#if and
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;

async function capture(projectDir: string, symbols: readonly string[]) {
  const warnings: { code: string; message: string }[] = [];
  const set = await generateMutationSet(projectDir, {
    preprocessorSymbols: symbols,
    emit: (e) => {
      if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
    },
  });
  const out = await mkdtemp(join(tmpdir(), "lethal-r214-"));
  try {
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "00000000-0000-0000-0000-000000000000",
      operatorTiers,
    });
    const m = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8")) as MutantManifest;
    const raw = set.files.reduce((n, f) => n + f.specs.length, 0);
    const rows = [...m.mutants]
      .sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.startLine - b.startLine ||
          a.operatorName.localeCompare(b.operatorName) ||
          a.startIndex - b.startIndex,
      )
      .map((e) =>
        [
          `${e.file.replaceAll("\\", "/")}:${e.startLine}`,
          e.operatorName,
          `proc=${e.procedureName === "" ? "<none>" : e.procedureName}`,
          `hang=${e.hangCapable ?? "-"}`,
          serializeKey(identityKeyOf(e)),
          `${e.startIndex}-${e.endIndex}`,
          `grain=${e.reachGrain ?? "-"}`,
          `plat=${e.platformKillMechanism ?? "-"}`,
        ].join("\t"),
      );
    const head = `raw ${raw} deployed ${m.mutants.length} skippedFiles ${set.skipped.length}`;
    return { text: `${[head, ...rows].join("\n")}\n`, warnings, set };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function setsOf(dir: string): Promise<string[][]> {
  return JSON.parse(await readFile(join(dir, "symbol-sets.json"), "utf8")) as string[][];
}

beforeAll(async () => {
  await initParser();
});

// Listed at module load (top-level await), so each repro is its own named test.
const CASES: [string, string][] = [
  ...(await readdir(R214))
    .filter((n) => n !== "expected" && n !== "before")
    .map((n): [string, string] => [n, join(R214, n)]),
  ["fixture-sandbox-symbols", join(REPO, "fixtures", "sandbox-symbols")],
];

describe("R214: the pre-committed sites, per repro and per build", () => {
  test("every lifted repro is here (13) and has an expected file per set", async () => {
    expect(CASES).toHaveLength(14);
    for (const [name, dir] of CASES)
      for (const [i] of (await setsOf(dir)).entries())
        expect(await Bun.file(join(R214, "expected", `${name}.${i}.txt`)).exists()).toBe(true);
  });
  for (const [name, dir] of CASES) {
    test(`${name}: every build matches its expected capture`, async () => {
      for (const [i, symbols] of (await setsOf(dir)).entries()) {
        const want = await readFile(join(R214, "expected", `${name}.${i}.txt`), "utf8");
        const got = await capture(dir, symbols);
        expect(`[${symbols.join(",")}]\n${got.text}`).toBe(`[${symbols.join(",")}]\n${want}`);
      }
    }, 60_000);
  }
});

describe("R214: every drop is named and counted", () => {
  test("compiled-out sites are counted per file, with the effective symbols", async () => {
    const { warnings, set } = await capture(join(R214, "p-r214"), []);
    const w = warnings.filter((x) => x.code === "compiled-out-sites");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("R214Probe.Codeunit.al (2)");
    expect(w[0]?.message).toContain("symbols: none");
    expect(set.preprocExcluded).toEqual([
      { file: "R214Probe.Codeunit.al", kinds: "codeunit_declaration", sites: 2, reason: "compiled-out", detail: "symbols: none" },
    ]);
  });

  test("an undecidable file gets NO mutant, one warning, one counted row; its sibling is untouched", async () => {
    const { warnings, set, text } = await capture(join(R214, "p12-refused"), ["R12SYM"]);
    // Project-relative paths (r3, I6). `readdir` on Windows spells them `src\...` (measured), so
    // the actual path is normalised before an EXACT comparison; the capture text already is.
    expect(text).not.toContain("src/Refused.Codeunit.al");
    expect(text).toContain("src/Plain.Codeunit.al:6\tlethal.void-method-call");
    const w = warnings.filter((x) => x.code === "preproc-arms-undecided");
    expect(w).toHaveLength(1);
    expect(norm(w[0]?.message ?? "")).toContain("src/Refused.Codeunit.al: ");
    expect(w[0]?.message).toContain("marker-mismatch (2 directive lines, 0 markers)");
    expect(w[0]?.message).not.toContain("Helper(");
    const refused = set.preprocExcluded.filter((f) => f.reason === "preproc-undecided");
    expect(refused.map((f) => [norm(f.file), f.detail])).toEqual([
      ["src/Refused.Codeunit.al", "marker-mismatch (2 directive lines, 0 markers)"],
    ]);
    expect(refused[0]?.sites).toBeGreaterThan(0);
  });

  test("a refused file with NO site still gets its row, sites 0 (r3, I5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-empty-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
      // A valid, otherwise empty codeunit: the directive-looking line sits in a block comment.
      await Bun.write(join(dir, "src", "Empty.Codeunit.al"), EMPTY_REFUSED);
      const warnings: string[] = [];
      const set = await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning" && e.code === "preproc-arms-undecided") warnings.push(e.message);
        },
      });
      expect(set.preprocExcluded.map((f) => [norm(f.file), f.sites, f.reason, f.detail])).toEqual([
        ["src/Empty.Codeunit.al", 0, "preproc-undecided", "marker-mismatch (1 directive lines, 0 markers)"],
      ]);
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a legal bare `#if and` refuses its file: unparsed-condition, no mutant, one row (r3, minor b)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-and-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
      await Bun.write(join(dir, "src", "BareAnd.Codeunit.al"), BARE_AND);
      const set = await generateMutationSet(dir);
      expect(set.files.flatMap((f) => f.specs)).toHaveLength(0);
      const rows = set.preprocExcluded.map((f) => [norm(f.file), f.reason, f.detail]);
      expect(rows).toEqual([["src/BareAnd.Codeunit.al", "preproc-undecided", "unparsed-condition at line 5"]]);
      expect(set.preprocExcluded[0]?.sites).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("app.json's own preprocessorSymbols count", async () => {
    const { text, set } = await capture(join(R214, "p7-appjson"), []);
    expect(text).toContain("AppSym.Codeunit.al:6\tlethal.void-method-call");
    expect(text).not.toContain("AppSym.Codeunit.al:8\tlethal.swap-additive");
    expect(set.buildSymbols).toEqual(["APPSYM"]);
  });

  test("a malformed app.json symbol list throws, naming app.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r214-bad-"));
    try {
      await Bun.write(join(dir, "app.json"), JSON.stringify({ preprocessorSymbols: "APPSYM" }));
      await Bun.write(join(dir, "A.Codeunit.al"), 'codeunit 50001 "A" { }\n');
      await expect(generateMutationSet(dir)).rejects.toThrow(/app\.json: "preprocessorSymbols" must be an array/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

(The expected `kinds` string is what `describeObjectKinds` returns for a lone codeunit; if Step 2's red output shows a different spelling for that function, the test takes that spelling, since it is existing product output and not a prediction. If `generateMutationSet` refuses a project with no site at all, the two r3 tests each add `p12-refused/src/Plain.Codeunit.al` as a sibling and filter `preprocExcluded` to `preproc-undecided` before the exact comparison; the assertions on the refused file do not change. `EMPTY_REFUSED` and `BARE_AND` are exported for Task 7's report test.)

In `cli.test.ts`'s C02-06 describe, a second test built exactly like the first (same `PassingBackend`, same `app.json`), whose `Logic.Codeunit.al` is:

```al
codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
#if X
        exit(Amount > Budget);
#else
        exit(Amount >= Budget);
#endif
    end;
}
```

with config `{ "preprocessorSymbols": ["X"] }`, asserting `report.mutants.some((m) => m.line === 6)` is true and `report.mutants.some((m) => m.line === 8)` is false. And a dry-run test in the same file: `printDryRun` over the same project with `paths.preprocessorSymbols: ["X"]`, capturing `console.log`, asserting the printed site count equals the count with `["X"]` from `generateMutationSet` and differs from the count with `[]`.

- [ ] **Step 2: Run, expect red.** `bun test packages/runner/tests/r214-compiled-out.test.ts packages/runner/tests/cli.test.ts`. Expected: every repro case FAILS with inactive-arm rows present; the drop tests FAIL (`preprocExcluded` undefined); the `cli.test.ts` tests FAIL (line 8's mutants present).

- [ ] **Step 3: Implement in `orchestrator.ts`.** In `MutationSetOptions`:

```ts
  /**
   * R214: the build's preprocessor symbols as the config gives them (C02-06), the list the compile
   * step receives. `app.json`'s own `preprocessorSymbols` are added (`effectiveBuildSymbols`), because
   * alc unions the two (measured, alc 18.0.41), and each file's `#define` / `#undef` apply. A site in
   * an arm that build compiles out is not generated, and a file whose directives cannot be evaluated
   * as alc does is not mutated. Absent means `[]`: what alc builds with no `/define`, not "keep every
   * arm", which would re-open R214 for any caller that forgets it.
   */
  readonly preprocessorSymbols?: readonly string[];
```

In `MutationSetResult`: `readonly preprocExcluded: readonly PreprocExcludedFile[];` and `/** R214: the effective set generation used. */ readonly buildSymbols: readonly string[];`.

In `generateMutationSet`, after `ctx` is built:

```ts
  const buildSymbols = await effectiveBuildSymbols(
    projectDir,
    options.preprocessorSymbols ?? [],
    snapshot,
  );
  const preprocExcluded: PreprocExcludedFile[] = [];
  const symbolsDetail = `symbols: ${buildSymbols.length > 0 ? buildSymbols.join(", ") : "none"}`;
```

In the per-file loop, after `buildSpanIndex` and before `visit`:

```ts
    // R214: sites in an arm this build compiles out are not generated, and a file whose directives
    // cannot be evaluated exactly as alc does is not mutated at all: no known-uncertain arm is scored.
    const arms = evaluateArms(root, source, buildSymbols);
    const inactive = arms.kind === "decided" ? arms.inactive : [];
    let compiledOutHere = 0;
```

As the first statement inside `for (const spec of op.generate(node, ctx)) {`:

```ts
            if (startsInInactiveArm(inactive, spec.before.startIndex)) {
              compiledOutHere++;
              continue;
            }
```

After the R144 `declarativeInThisFile` block (so a refused file's declarative sites stay in the declarative row, counted once) and BEFORE the `if (specs.length === 0) continue;` bail (so a file whose only sites were compiled out or refused is still recorded):

```ts
    if (arms.kind === "undecided") {
      warn(
        "preproc-arms-undecided",
        `[lethal] ${rel}: a preprocessor directive could not be evaluated exactly as alc does (${arms.reason}), so no mutant is generated in this file (${specs.length} site(s)). It is still compiled and published unchanged. R214.`,
      );
      // r3, I5: recorded even at 0 sites, so a refused file never vanishes from the report.
      preprocExcluded.push({
        file: rel,
        kinds: describeObjectKinds(root),
        sites: specs.length,
        reason: "preproc-undecided",
        detail: arms.reason,
      });
      continue;
    }
    if (compiledOutHere > 0) {
      preprocExcluded.push({
        file: rel,
        kinds: describeObjectKinds(root),
        sites: compiledOutHere,
        reason: "compiled-out",
        detail: symbolsDetail,
      });
    }
```

After the loop, before the `nonExecutableSites` warning:

```ts
  const compiledOut = preprocExcluded.filter((f) => f.reason === "compiled-out");
  if (compiledOut.length > 0) {
    const total = compiledOut.reduce((n, f) => n + f.sites, 0);
    const listed = compiledOut.slice(0, 5).map((f) => `${f.file} (${f.sites})`);
    warn(
      "compiled-out-sites",
      `[lethal] ${total} site(s) in ${compiledOut.length} file(s) sit in #if arms this build compiles out (${symbolsDetail}), so no mutant was generated there (R214): ${listed.join(", ")}${compiledOut.length > 5 ? ", ..." : ""}.`,
    );
  }
```

Return `preprocExcluded` and `buildSymbols` with the result. Import `evaluateArms`, `startsInInactiveArm` from `@lethal/engine`, `effectiveBuildSymbols` from `./preprocessor-symbols`, and `PreprocExcludedFile` from `./excluded-sites`. In `runSession`'s call (`:4183`), add `preprocessorSymbols: sourceSymbols,` (the `source` snapshot is already passed).

- [ ] **Step 3b: The grain test per build.** In `reach-grain-fixtures.test.ts`, run each project once per set of its `symbol-sets.json` when it has one, else once with `[]`:

```ts
    for (const rel of PROJECTS) {
      const setsPath = join(REPO, rel, "symbol-sets.json");
      const sets: readonly (readonly string[])[] = existsSync(setsPath)
        ? (JSON.parse(await readFile(setsPath, "utf8")) as string[][])
        : [[]];
      for (const symbols of sets) {
        const set = await generateMutationSet(join(REPO, rel), { preprocessorSymbols: symbols });
        // The existing body runs here unchanged over `set`, with `[${symbols.join(",")}]` added to
        // the `[GH-24 grain]` log line and to each `unplaced` entry it reports.
      }
    }
```

Import `existsSync` from `node:fs`. Expected: `sandbox-symbols` logs 9 mutants and `{"statement":9,"enclosing":0,"unplaced":0}` under each of its three sets.

- [ ] **Step 4: Implement in `cli.ts`.** `printDryRun`'s `paths` gains `/** R214: the config's symbols, so a dry run answers for the build the real run compiles. */ readonly preprocessorSymbols?: readonly string[];`, passed to `generateMutationSet` as `...(paths.preprocessorSymbols !== undefined ? { preprocessorSymbols: paths.preprocessorSymbols } : {})`. The caller at `:5079` adds `...(dryRunConfig?.preprocessorSymbols !== undefined ? { preprocessorSymbols: validatePreprocessorSymbols(dryRunConfig.preprocessorSymbols) } : {})`.

- [ ] **Step 5: (moved to Task 8.)** The scheme and symbol transitions need Task 8's store column, so they are written there.

- [ ] **Step 6: Know what the filter touches.** `bun run typecheck && rm -rf packages/*/dist && bun test > $Q/logs/t6-reds.txt 2>&1`. Expected reds: only tests that call `generateMutationSet` on AL holding a `#if` and assert a mutant in an arm the no-symbol build compiles out (candidates: `preproc-instrumentation.test.ts`, `line-map.test.ts`, `named-return.test.ts`), and the type errors Task 7 resolves (`preprocExcluded` not yet folded). Rule each in the log, never deleting a test: if its point is instrumenting that arm's shape (R-297, R-302, R303, R316), it passes the symbols that make that arm the build (for example `preprocessorSymbols: ["CLEAN27"]`), so the shape stays covered; if it only counted mutants, its expectation drops the compiled-out ones with an `R214` comment. More than 15 reds, or a red outside those files, is a STOP.

- [ ] **Step 7: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. `bunx biome check` on every touched file.

- [ ] **Step 8: Red-check each hunk alone**, in `$Q/logs/t6-redcheck.txt`: (a) the `startsInInactiveArm` drop removed: every repro case goes red (inactive rows back); (b) the undecided `continue` removed (the file's specs kept): `p12-refused` and its drop test go red; (c) `effectiveBuildSymbols` replaced by `options.preprocessorSymbols ?? []`: `p7-appjson` and the `app.json` test go red; (d) `runSession`'s `preprocessorSymbols: sourceSymbols` removed: the new `cli.test.ts` session test goes red; (e) the dry-run threading removed: the dry-run test goes red; (f) the undecided warning removed: its test goes red; (g) the compiled-out warning removed: its test goes red; (h) the undecided row pushed only when `specs.length > 0` (r2's condition, r3 I5): "a refused file with NO site still gets its row" goes red while the `p12-refused` test stays green, which shows the two are pinned apart; (i) the bare-keyword refusal removed (in `primary`, drop the `OPERATOR_WORDS` condition, so `and` reads as an undefined symbol and the file is decided and mutated): the bare `#if and` test goes red (minor b; Task 4's (d) is the same revert seen from the engine).

- [ ] **Step 9: Commit.** `git commit -m "fix(R214): generateMutationSet drops sites in #if arms the build compiles out and refuses files it cannot evaluate as alc does (config plus app.json symbols, per-file #define/#undef); named warnings; symbols threaded through runSession and --dry-run"`.

---

### Task 7: `compiled-out` and `preproc-undecided` in `excludedSites` (Q1, CLAUDE.md's ripple list)

**Files (in CLAUDE.md's order):**
- Modify: `packages/runner/src/events.ts` (`mutation-set-generated`)
- Modify: `packages/runner/src/report-fold.ts` (accumulator; `FoldStatics.buildSymbols`)
- Modify: `packages/runner/src/excluded-sites.ts` (`ExclusionReason`, `buildExcludedSites`)
- Modify: `packages/runner/src/report.ts` (banner)
- Modify: `packages/runner/src/mutation-elements.ts` (description per reason)
- Modify: `packages/runner/src/orchestrator.ts` (the event's new field)
- Modify (minor a): `packages/runner/src/report.ts` (`Caveat`, `CAVEAT_INTERPRETATIONS`, the push in `buildReport`), `packages/runner/src/explain.ts` (`EXPLAIN_SCHEMA_VERSION`), `schemas/README.md`, `docs/using-lethal-from-an-agent.md` (the explain link and `explainSchemaVersion`)
- Create (minor a): `schemas/explain-v7.schema.json` (hand-written; `explain-v6.schema.json` stays as published)
- Generate: `schemas/report-v3.schema.json` and `schemas/stream-v1.schema.json` (`bun scripts/generate-schemas.ts`); `schemas/report-v2.schema.json` is frozen and must not change (r3, I7)
- Test: `packages/runner/tests/r214-compiled-out.test.ts`, `packages/runner/tests/schemas.test.ts`, `packages/runner/tests/interpretation.test.ts`, `packages/runner/tests/report.test.ts`, `packages/runner/tests/__snapshots__/report-equality.test.ts.snap`

**Interfaces:**
- Produces: `ExclusionReason = "not-instrumentable" | "declarative" | "compiled-out" | "preproc-undecided"`; `mutation-set-generated.preprocExcludedFiles: readonly PreprocExcludedFile[]` (required, empty when none); `FoldStatics.buildSymbols?: readonly string[]` (consumed by Task 8's marks, never written to the report); `Caveat` gains `"preproc-files-refused"` (r3, minor a).

- [ ] **Step 1: Write the failing test.** Append to `r214-compiled-out.test.ts` a describe that runs `runSession` (the `SurvivingBackend` pattern of `named-return.test.ts`, coverage entry `{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }`) with `preprocessorSymbols: ["R12SYM"]` over three temp copies of `p12-refused`:

  - **Run 1**, the copy plus `src/BareAnd.Codeunit.al` (`BARE_AND`) and `src/Empty.Codeunit.al` (`EMPTY_REFUSED`), both written by the test:

```ts
    const norm = (p: string) => p.replaceAll("\\", "/");
    const rows = (report.excludedSites?.files ?? [])
      .filter((f) => f.reason === "compiled-out" || f.reason === "preproc-undecided")
      .map((f) => [norm(f.file), f.reason, f.detail])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // Project-relative paths (r3, I6); the bare `#if and` file's own row (r3, minor b); the
    // zero-site refused file's row (r3, I5).
    expect(rows).toEqual([
      ["src/BareAnd.Codeunit.al", "preproc-undecided", "unparsed-condition at line 5"],
      ["src/Empty.Codeunit.al", "preproc-undecided", "marker-mismatch (1 directive lines, 0 markers)"],
      ["src/Plain.Codeunit.al", "compiled-out", "symbols: R12SYM"],
      ["src/Refused.Codeunit.al", "preproc-undecided", "marker-mismatch (2 directive lines, 0 markers)"],
    ]);
    const empty = report.excludedSites?.files.find((f) => norm(f.file) === "src/Empty.Codeunit.al");
    expect(empty?.sites).toBe(0);
    expect(report.excludedSites?.siteCount).toBe(
      report.excludedSites?.files.reduce((n, f) => n + f.sites, 0),
    );
    expect(report.excludedSites?.fileCount).toBe(
      new Set(report.excludedSites?.files.map((f) => f.file)).size,
    );
    // No mutant from any refused file (minor b: the bare `#if and` file included).
    const refusedFiles = ["src/BareAnd.Codeunit.al", "src/Empty.Codeunit.al", "src/Refused.Codeunit.al"];
    expect(report.mutants.filter((m) => refusedFiles.includes(norm(m.file)))).toEqual([]);
    // Minor a: a consumer reading only `validity` sees the refusal.
    expect(report.validity.caveats).toContain("preproc-files-refused");
    // No source text in the durable record.
    expect(JSON.stringify(report.excludedSites)).not.toMatch(/Helper|begin|:=/);
```

  - **Run 2**, the copy with `src/Refused.Codeunit.al` deleted and `src/Empty.Codeunit.al` added: every `preproc-undecided` row has 0 sites, and `report.validity.caveats` still contains `"preproc-files-refused"` (the caveat counts files, not sites).
  - **Run 3**, the control, the copy with `src/Refused.Codeunit.al` deleted and nothing added: the `compiled-out` row for `src/Plain.Codeunit.al` is present, and `report.validity.caveats` does NOT contain `"preproc-files-refused"` (a compiled-out site is the correct build, not a refusal).

(If `report.mutants[]` names its path field other than `file`, use that field; it is existing product output.)

And in `schemas.test.ts`: one assertion that the published report schema's `excludedSites.files.items.properties.reason.enum` equals `["not-instrumentable", "declarative", "compiled-out", "preproc-undecided"]`; and, per the explain schema bump in Step 3.11, its R233 pinned list for `#/properties/caveats/items/properties/caveat` gains `"preproc-files-refused"` after `"session-warm"`, loaded from `explain-v7.schema.json`.

In `interpretation.test.ts`, "every caveat has an interpretation" moves from `toBe(20)` to `toBe(21)`; in `report.test.ts`'s "Caveat union", the `all` object gains `"preproc-files-refused": true` and the count moves from `toBe(20)` to `toBe(21)` (both read 20 today, `interpretation.test.ts:44` and `report.test.ts:277`, re-read at `f0fe038a`).

- [ ] **Step 2: Run, expect red.** `bun test packages/runner/tests/r214-compiled-out.test.ts packages/runner/tests/schemas.test.ts packages/runner/tests/interpretation.test.ts packages/runner/tests/report.test.ts`. Expected: every new assertion FAILS (the reasons, the caveat and `explain-v7.schema.json` do not exist), and `interpretation.test.ts`'s count fails at 20. `report.test.ts`'s `all` object is a compile-time pin (`Record<Caveat, true>`): its red is `bun run typecheck` naming the unknown key `"preproc-files-refused"`, while `bun test` passes it; both are recorded.

- [ ] **Step 3: Implement, in the ripple's order.**
  1. `events.ts`, in `mutation-set-generated` after `declarativeSiteFiles`: `/** R214: files whose sites the build's symbols decided (compiled out) or that were refused because their directives could not be evaluated as alc does. Required, and empty on a project with neither: an absent list and a measured zero must not look alike. */ readonly preprocExcludedFiles: readonly PreprocExcludedFile[];`
  2. `orchestrator.ts`, where the event is emitted (beside `declarativeSiteFiles` at `:4182`'s destructuring): destructure `preprocExcluded` from the result and emit `preprocExcludedFiles: preprocExcluded`.
  3. `report-fold.ts`: `let preprocExcludedFiles: readonly PreprocExcludedFile[] = [];`, set beside `declarativeSiteFiles = e.declarativeSiteFiles;`, and passed as `preproc: preprocExcludedFiles` to `buildExcludedSites`. `FoldStatics` gains `/** R214: the effective build symbols, for matching equivalence marks. Carried only in-process, like R325's scheme; not a report field. */ readonly buildSymbols?: readonly string[];`.
  4. `excluded-sites.ts`: `ExclusionReason` gains the two reasons; `buildExcludedSites`' input gains `readonly preproc: readonly PreprocExcludedFile[]`, mapped field by field (never a spread, the module's own rule):

```ts
    ...input.preproc.map((f) => ({
      file: f.file,
      kinds: f.kinds,
      sites: f.sites,
      reason: f.reason,
      detail: f.detail,
    })),
```

   Extend `detail`'s doc comment: "R214's two reasons carry one: the effective symbols, or a reason code. Neither is source text."
  5. `report.ts`, beside the `DECLARATIVE SITES REFUSED` banner at `:2745`:

```ts
  const byReason = (reason: string) =>
    (r.excludedSites?.files ?? []).filter((f) => f.reason === reason);
  const compiledOut = byReason("compiled-out");
  if (compiledOut.length > 0) {
    lines.push(
      `COMPILED OUT: ${compiledOut.reduce((n, f) => n + f.sites, 0)} site(s) in ${compiledOut.length} file(s) sit in #if arms this build does not compile (${compiledOut[0]?.detail ?? ""}). No mutant was made there; they are not untested code (R214).`,
    );
  }
  const undecided = byReason("preproc-undecided");
  if (undecided.length > 0) {
    lines.push(
      `PREPROCESSOR DIRECTIVES REFUSED: ${undecided.length} file(s) hold a directive LethAL cannot evaluate exactly as alc does, so none of their ${undecided.reduce((n, f) => n + f.sites, 0)} site(s) was mutated (R214):`,
    );
    for (const f of undecided) lines.push(`  ${f.file} (${f.detail})`);
  }
```

   (`lines` is the banner's own accumulator at that point; use its existing name there.)
  6. `mutation-elements.ts`: the `description` becomes reason-aware: `row.reason === "compiled-out" ? \`${row.sites} mutation site(s) in this ${row.kinds} are in #if arms this build does not compile (${row.detail ?? ""}). They are not in the program under test.\` : <the existing sentence>`.
  7. `bun scripts/generate-schemas.ts` (after item 11, so the caveat is in the type). It writes `schemas/report-v3.schema.json` (the current `REPORT_SCHEMA_VERSION`) and `schemas/stream-v1.schema.json`, never v2 (r3, I7). The expected diff, and nothing else: in `report-v3.schema.json`, `excludedSites.files.items.properties.reason.enum` gains `"compiled-out"` and `"preproc-undecided"`, and `validity.caveats.items.enum` gains `"preproc-files-refused"`; in `stream-v1.schema.json`, the `mutation-set-generated` event gains the required `preprocExcludedFiles` array (a field added to an event, which `schemas/README.md` says does not bump a version; R-236c's `87faa6ac` changed `stream-v1` the same way). Then `git diff --exit-code schemas/report-v2.schema.json` must exit 0, and `bun scripts/generate-schemas.ts --check` must pass.
  8. `schemas.test.ts`: the pinned root-required list does not change (`excludedSites` is optional and its shape is unchanged apart from the enum); the older-reports expectation does not change (an older report never holds the new values). Add Step 1's enum assertion. Every `loadSchema("explain-v6.schema.json")` that reads the CURRENT explain schema (today lines 232 and 1051) reads `explain-v7.schema.json`; the per-file required-list map (today line 864) gains an `"explain-v7.schema.json"` entry equal to v6's; v6's own entries stay, since v6 is kept.
  9. `bun test packages/runner/tests/report-equality.test.ts --update-snapshots` only if it goes red; its fixtures hold no directive, so the expected diff is none.
  10. Sample reports: `examples/credit-limit/demo.report.json` and gift-card's hold no directive and still validate against a superset enum, so they are NOT regenerated; `bun test packages/runner/tests/schemas.test.ts` proves it. If it goes red, that is a STOP (it would mean the change is not a superset).
  11. **The caveat (r3, minor a)**, done BEFORE item 7 so the generator sees it. In `report.ts`: `Caveat` gains `| "preproc-files-refused"` after `"session-warm"`; `CAVEAT_INTERPRETATIONS` gains

```ts
  "preproc-files-refused": {
    meaning:
      "At least one file holds a preprocessor directive LethAL cannot evaluate exactly as alc " +
      "does, so NO mutant was generated anywhere in that file. It is still compiled and " +
      "published unchanged. `excludedSites.files` names each such file with the reason " +
      "`preproc-undecided` and a reason code; `mutationScore` is computed only over the other files.",
    entailedNegative:
      "Not a gap in the target's tests and not a failed run: the refused files were never " +
      "measured, in either direction. A refused file can have 0 sites, so count its rows, not " +
      "its `sites`.",
    basis: "R214",
  },
```

   and `buildReport` pushes it next to the `declarative-sites-dropped` push: `// R214 - see CAVEAT_INTERPRETATIONS["preproc-files-refused"]. Pushed on the FILE count: a refused file can have 0 sites (r3, I5).` then `if (input.excludedSites.files.some((f) => f.reason === "preproc-undecided")) caveats.push("preproc-files-refused");` (`input.excludedSites` is the value `buildReport` already reads for `notInstrumentedView` and `declarativeSitesView`, `report.ts:2125-2126`). `reliability` is not changed. In `explain.ts`: `EXPLAIN_SCHEMA_VERSION = 7`, and its doc comment gains `7: R214 added the caveat value preproc-files-refused.` Create `schemas/explain-v7.schema.json` as a copy of `explain-v6.schema.json` with its `$id` and `explainSchemaVersion` const set to 7 and `"preproc-files-refused"` appended to the `caveat` enum; `explain-v6.schema.json` is not edited. `schemas/README.md`: a v7 row as the current explain schema, and v6 moves to a kept row ("from builds before R214; kept so a stored v6 document stays checkable (v7 added the caveat `preproc-files-refused`)"), with the file count in the paragraph below it updated to match. `docs/using-lethal-from-an-agent.md`: the explain link (line 207) and `explainSchemaVersion: 6` (line 252) read 7. This is the precedent R-236c set for one caveat (`87faa6ac`), step for step.

- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. `bunx biome check` on every touched file.

- [ ] **Step 5: Red-check**, in `$Q/logs/t7-redcheck.txt`: (a) `preproc: preprocExcludedFiles` replaced by `preproc: []` in the fold: the `runSession` test goes red; (b) the event's `preprocExcludedFiles` emitted as `[]`: the same test goes red; (c) the schema regenerated without the two enum values (revert `ExclusionReason` alone and regenerate): the schema test goes red; (d) the caveat push removed: Run 1's and Run 2's caveat assertions go red, Run 3 stays green; (e) the push made on the site count (`siteCount` of the `preproc-undecided` rows above 0) instead of the file count: Run 2 goes red while Runs 1 and 3 stay green, which is the I5 case seen from `validity`.

- [ ] **Step 6: Commit.** `git commit -m "feat(R214): excludedSites counts compiled-out and preproc-undecided files, with symbols or a reason code and no source text; a refused file raises the preproc-files-refused caveat (explain schema v7); banner and report schema v3"`.

---

### Task 8: History, resume and marks scoped to the identical effective symbol set; the four transitions (C1, I4, I8)

**Files:**
- Modify: `packages/runner/src/store.ts` (migration, `createRun`, `RunRow`, `getRun`, `priorSurvivorKeys`, new `unfinishedRunUnderOtherSymbols`)
- Modify: `packages/runner/src/orchestrator.ts` (`runSession`: effective symbols before the fingerprint; `createRun`; history call; both statics assemblies; marks warning; `resolveResume`)
- Modify: `packages/runner/src/resume.ts` (the `preprocessorSymbols` doc comment only)
- Modify: `packages/runner/src/equivalence-marks.ts` (`EquivalenceMark.preprocessorSymbols`, parse, `applyEquivalenceMarks`, `marksUnderOtherSymbols`, `marksSymbolsWarning`)
- Modify: `packages/runner/src/report.ts` (`buildReport`'s marks call)
- Modify: `packages/runner/src/verify.ts` (`VerifySource.buildSymbols`, its marks, its `createRun`)
- Modify: `scripts/c0204b-live-probe.ts` (its `createRun` passes `buildSymbols: []`, a probe on a directive-free fixture)
- Create: `packages/runner/tests/r214-history.test.ts`
- Modify: `packages/runner/itest/harden-fixture.test.ts`, and every test `createRun` / `priorSurvivorKeys` caller the typecheck names

**Interfaces:**
- Produces: `createRun({ ..., buildSymbols: readonly string[] })` (required); `RunRow.buildSymbols: readonly string[] | null`; `priorSurvivorKeys(projectPath, buildSymbols, on?)` with `on: { schemeChanged?, symbolsChanged? }`; `EquivalenceMark.preprocessorSymbols?: readonly string[]`; `applyEquivalenceMarks(marks, mutants, identityScheme, buildSymbols)`; warnings `history-build-symbols-changed`, `equivalence-marks-build-symbols`.

- [ ] **Step 1: Write the failing tests.** `packages/runner/tests/r214-history.test.ts`. Its helpers are `named-return.test.ts`'s (`SurvivingBackend` with coverage entry `{ objectType: "Codeunit", objectId: 79600, procedure: "Rate" }`, `reportKey`, a temp copy of `fixtures/sandbox-symbols` plus `fixtures/sandbox-symbols-tests`, `selectorIds`), and:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import { ResultsStore } from "../src/store";

const HERE = import.meta.dir;
const R214 = join(HERE, "fixtures", "r214");
const REPO = resolve(HERE, "../../..");
type ReportMutant = SessionReport["mutants"][number];

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A private copy of the R321 fixture pair, so a run never writes next to the committed one. */
async function makeSymbolsProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r214-hist-"));
  roots.push(root);
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await cp(join(REPO, "fixtures", "sandbox-symbols"), projectDir, { recursive: true });
  await cp(join(REPO, "fixtures", "sandbox-symbols-tests"), testDir, { recursive: true });
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** The pre-committed key text of the arm pair's `return-value` under `set`, read from the committed
 *  expected capture, never typed here. Under the new scheme it is the SAME text for L13 under
 *  [LETHALA] and L15 under [LETHALB] (measured, the R-214 plan). */
async function armKey(index: 1 | 2): Promise<string> {
  const text = await readFile(join(R214, "expected", `fixture-sandbox-symbols.${index}.txt`), "utf8");
  const row = text.split("\n").find((l) => l.includes("\tlethal.return-value\t"));
  const key = row?.split("\t")[4];
  if (key === undefined) throw new Error("no return-value row");
  return key;
}

function armOf(report: SessionReport, line: 13 | 15): ReportMutant {
  const hits = report.mutants.filter((m) => m.line === line && m.operatorName === "lethal.return-value");
  if (hits.length !== 1 || hits[0] === undefined) throw new Error(`no single L${line} return-value`);
  return hits[0];
}

/** A real CURRENT-engine run under `symbols`, at the current scheme, as it was recorded;
 *  `finished: false` clears its finish so it is resumable. It never takes a scheme: an old-scheme
 *  record is `oldEngineRun`'s, never a relabelled current-engine run (r3, I2). */
async function storedRun(opts: { symbols: string[]; finished: boolean }) {
  const dirs = await makeSymbolsProject();
  const store = new ResultsStore(":memory:");
  await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: opts.symbols });
  const run = store.db.query("SELECT id FROM runs").get() as { id: number };
  if (!opts.finished) store.db.run("UPDATE runs SET finished_at = NULL WHERE id = ?", [run.id]);
  return { dirs, store, runId: run.id };
}

/** The OLD engine's record, from committed files only (Task 1 Step 5b): master's own L13
 *  `return-value` key and line from the BEFORE capture, and the starting scheme `S`. Neither is
 *  derived from IDENTITY_SCHEME, so reverting the constant cannot move both sides (r3, I2). */
async function oldEngineKey(): Promise<{ scheme: number; key: string; line: number }> {
  const { identityScheme } = JSON.parse(
    await readFile(join(R214, "before", "scheme.json"), "utf8"),
  ) as { identityScheme: number };
  const text = await readFile(join(R214, "before", "fixture-sandbox-symbols.txt"), "utf8");
  const row = text
    .split("\n")
    .find((l) => l.startsWith("src/SymbolLogic.Codeunit.al:13\tlethal.return-value\t"));
  const key = row?.split("\t")[4];
  if (key === undefined) throw new Error("no L13 return-value row in the BEFORE capture");
  return { scheme: identityScheme, key, line: 13 };
}

/**
 * A run the OLD engine made under [LETHALB]: one row, master's L13 `return-value` key and line,
 * verdict `survived` (the frozen R321 [LETHALB] baseline scores that compiled-out mutant exactly
 * so). Written through the store API, beside one real current-engine run whose project path and
 * backend it copies, so it is found as the same project. It is created AFTER that run, so it is
 * the latest. `buildSymbols` is B by default, so the scheme is its ONLY difference from the
 * current-scheme control; `null` is the shape a real pre-R214 row has.
 */
async function oldEngineRun(opts: { finished: boolean; buildSymbols?: readonly string[] | null }) {
  const old = await oldEngineKey();
  const dirs = await makeSymbolsProject();
  const store = new ResultsStore(":memory:");
  await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B });
  const real = store.db.query("SELECT project_path, backend FROM runs").get() as {
    project_path: string;
    backend: string;
  };
  const buildSymbols = opts.buildSymbols === undefined ? B : opts.buildSymbols;
  const runId = store.createRun({
    projectPath: real.project_path,
    backend: real.backend,
    appVersion: "1.0.0.0",
    identityScheme: old.scheme,
    buildSymbols: buildSymbols ?? [],
    configFingerprint: sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: real.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: old.scheme,
      preprocessorSymbols: B,
    }),
  });
  if (buildSymbols === null) store.db.run("UPDATE runs SET build_symbols = NULL WHERE id = ?", [runId]);
  const [astHash = "", codeunitName = "", procedureName = "", operatorName = "", major = ""] =
    old.key.split("|");
  store.recordMutant(runId, {
    mutantCode: "M0010",
    astHash,
    codeunitName,
    procedureName,
    operatorName,
    operatorMajor: Number(major),
    identityOrdinal: 0,
    file: "src/SymbolLogic.Codeunit.al",
    line: old.line,
    verdict: "survived",
    durationMs: 1,
    batchIndex: 0,
  });
  if (opts.finished) store.finishRun(runId, { batchCount: 1, baselineGreen: true });
  return { dirs, store, runId, old };
}

const B = ["LETHALB"];

describe("R214 C1: the same key text names a different site in another build", () => {
  test("pin: L13 under [LETHALA] and L15 under [LETHALB] carry identical key text", async () => {
    expect(await armKey(1)).toBe(await armKey(2));
  });

  test("history: a [LETHALA] survivor is not skipped in a [LETHALB] run, and the run says why", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: true });
    const events: RunEvent[] = [];
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, skipKnownSurvivors: true, emit: [(e) => events.push(e)] });
    expect(armOf(report, 15).verdict).toBe("survived");
    const w = events.flatMap((e) => (e.type === "warning" && e.code === "history-build-symbols-changed" ? [e.message] : []));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${runId}`);
    expect(w[0]).toContain("LETHALA");
    expect(w[0]).toContain("LETHALB");
  });

  test("history control: a [LETHALB] survivor IS skipped in a [LETHALB] run", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: true });
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, skipKnownSurvivors: true });
    expect(armOf(report, 15).verdict).toBe("known-survivor");
  });

  test("--resume-run of a [LETHALA] run is refused by name in a [LETHALB] session", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: false });
    await expect(runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: runId }))
      .rejects.toThrow(new RegExp(`--resume-run ${runId} was built with preprocessor symbols LETHALA.*LETHALB.*R214`));
  });

  test("--resume-run control: the same set resumes", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: B, finished: false });
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: runId });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  test("--resume last names the [LETHALA] run instead of reporting none found", async () => {
    const { dirs, store, runId } = await storedRun({ symbols: ["LETHALA"], finished: false });
    await expect(runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: "last" }))
      .rejects.toThrow(new RegExp(`run ${runId}, .*preprocessor symbols LETHALA.*LETHALB.*R214`));
  });

  test("--resume last control: the same set resumes", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: false });
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: "last" });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  async function markedRun(markSymbols: string[] | undefined) {
    const dirs = await makeSymbolsProject();
    return runSession({
      backend: new SurvivingBackend(),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      preprocessorSymbols: B,
      equivalenceMarks: [{ key: await armKey(2), reason: "same either way", identityScheme: IDENTITY_SCHEME, ...(markSymbols !== undefined ? { preprocessorSymbols: markSymbols } : {}) }],
    });
  }

  test("marks: a mark made under [LETHALA] does not mark [LETHALB]'s L15 (stale)", async () => {
    const report = await markedRun(["LETHALA"]);
    expect(armOf(report, 15).readerMark).toBeUndefined();
    expect(report.readerMarkedEquivalent?.stale).toEqual([await armKey(2)]);
  });

  test("marks: a mark with no symbols applies only to a build with none (stale here)", async () => {
    const report = await markedRun(undefined);
    expect(armOf(report, 15).readerMark).toBeUndefined();
  });

  test("marks control: the same mark under [LETHALB] marks it", async () => {
    const report = await markedRun(B);
    expect(armOf(report, 15).readerMark).toBeDefined();
  });
});

describe("R214 I4: an old-engine record never reaches a current-scheme mutant with the same key text", () => {
  // The old side is master's own record (oldEngineKey); the new side is IDENTITY_SCHEME. No number
  // is written here (task.md Addendum), and IDENTITY_SCHEME - 1 is never used (r3, I2).

  test("pin: the old engine's L13 key is the text the new engine gives L15 under [LETHALB]; the scheme moved", async () => {
    const old = await oldEngineKey();
    expect(old.key).toBe(await armKey(2));
    expect(IDENTITY_SCHEME).toBeGreaterThan(old.scheme);
  });

  test("history: the old L13 survivor is not skipped at the new L15, and the run names the scheme", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: true });
    const events: RunEvent[] = [];
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, skipKnownSurvivors: true, emit: [(e) => events.push(e)] });
    expect(armOf(report, 15).verdict).toBe("survived");
    const w = events.flatMap((e) => (e.type === "warning" && e.code === "history-identity-scheme-changed" ? [e.message] : []));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${runId}`);
    expect(w[0]).toContain(`identity scheme ${old.scheme}`);
  });

  test("history: the real pre-R214 row shape (build_symbols NULL) is not skipped either", async () => {
    const { dirs, store } = await oldEngineRun({ finished: true, buildSymbols: null });
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, skipKnownSurvivors: true });
    expect(armOf(report, 15).verdict).toBe("survived");
  });

  test("history control: a current-engine, current-scheme survivor IS skipped (the key collides)", async () => {
    const { dirs, store } = await storedRun({ symbols: B, finished: true });
    const report = await runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, skipKnownSurvivors: true });
    expect(armOf(report, 15).verdict).toBe("known-survivor");
  });

  test("--resume-run of the old run is refused, naming both schemes and R325", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: false });
    await expect(runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: runId }))
      .rejects.toThrow(new RegExp(`--resume-run ${runId} was keyed under identity scheme ${old.scheme}.*scheme ${IDENTITY_SCHEME}.*R325`));
  });

  test("--resume last names the old run", async () => {
    const { dirs, store, runId, old } = await oldEngineRun({ finished: false });
    await expect(runSession({ backend: new SurvivingBackend(), store, ...dirs, selectorIds, preprocessorSymbols: B, resume: "last" }))
      .rejects.toThrow(new RegExp(`run ${runId}, .*identity scheme ${old.scheme}.*scheme ${IDENTITY_SCHEME}.*R325`));
  });

  test("marks: an old-scheme mark on the old key is stale; control: the current scheme marks it", async () => {
    const dirs = await makeSymbolsProject();
    const old = await oldEngineKey();
    const key = old.key;
    const run = (identityScheme: number) =>
      runSession({
        backend: new SurvivingBackend(),
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        preprocessorSymbols: B,
        equivalenceMarks: [{ key, reason: "same either way", identityScheme, preprocessorSymbols: B }],
      });
    expect(armOf(await run(old.scheme), 15).readerMark).toBeUndefined();
    expect(armOf(await run(IDENTITY_SCHEME), 15).readerMark).toBeDefined();
  });
});
```

(The `--resume-run` and `--resume last` controls for I4 are the C1 describe's controls, which are real current-engine runs at `IDENTITY_SCHEME` on the same key text; they are not duplicated. `oldEngineRun` fills `recordMutant`'s row from the BEFORE key's five fields; if the typecheck names a further required `MutantRow` field, it takes the value `recordMutant`'s existing test callers give it, and the key fields, `file`, `line` and `verdict` stay as written. Why the old row is `survived` at L13: that is what the old engine's own `[LETHALB]` run scored there, in the committed baseline Task 1 Step 5b checks.)

- [ ] **Step 2: Run, expect red.** `bun test packages/runner/tests/r214-history.test.ts`. Expected: both pins pass (they read committed files, and Task 2 already moved the scheme); every C1 refusal test FAILS (history skips L15; resume carries; the `LETHALA` mark matches); the I4 tests on the old record PASS already (R325's scheme checks exist, and `createRun` ignores the not-yet-typed `buildSymbols` at run time), except "the real pre-R214 row shape", which FAILS because the `build_symbols` column does not exist yet. `bun run typecheck` fails on `createRun`'s unknown `buildSymbols` until Step 3.

- [ ] **Step 3: Implement in `store.ts`.** In `migrate`'s C02-06 column list, after `identity_scheme`: `// R214: NULL on an older row, and read as "unknown", which matches no build. ["runs", "build_symbols TEXT", runCols],`. In `createRun`'s info: `/** R214: the effective preprocessor symbols (config plus app.json) the run's keys were made under. Required for the reason identityScheme is. */ buildSymbols: readonly string[];`, inserted as `JSON.stringify([...new Set(info.buildSymbols)].sort())` into a new `build_symbols` column of the INSERT. `RunRow` gains `readonly buildSymbols: readonly string[] | null;` and `getRun` selects `build_symbols` and parses it (`null` stays `null`). `priorSurvivorKeys`:

```ts
  priorSurvivorKeys(
    projectPath: string,
    /** R214: this build's effective symbols. A latest run built under another set yields no keys. */
    buildSymbols: readonly string[],
    on: {
      /** R325: the latest finished run was keyed under another identity scheme. */
      readonly schemeChanged?: (info: { runId: number; identityScheme: number }) => void;
      /** R214: the latest finished run was built under other symbols (or before they were recorded). */
      readonly symbolsChanged?: (info: { runId: number; buildSymbols: readonly string[] | null }) => void;
    } = {},
  ): Set<string> {
    const run = this.db
      .query(
        "SELECT id, COALESCE(identity_scheme, 1) AS scheme, build_symbols FROM runs WHERE project_path = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(projectPath) as { id: number; scheme: number; build_symbols: string | null } | null;
    if (!run) return new Set();
    if (run.scheme !== IDENTITY_SCHEME) {
      on.schemeChanged?.({ runId: run.id, identityScheme: run.scheme });
      return new Set();
    }
    const recorded = run.build_symbols === null ? null : (JSON.parse(run.build_symbols) as string[]);
    if (recorded === null || !sameBuildSymbols(recorded, buildSymbols)) {
      on.symbolsChanged?.({ runId: run.id, buildSymbols: recorded });
      return new Set();
    }
    // ... the existing row query and mapping, unchanged ...
  }
```

And a sibling of `unfinishedRunUnderOtherScheme`:

```ts
  /** R214: the latest unfinished run for this project, backend and scheme that holds something to
   *  carry but was built under OTHER preprocessor symbols. `--resume last` names it. */
  unfinishedRunUnderOtherSymbols(q: {
    projectPath: string;
    backend: string;
    buildSymbols: readonly string[];
    carryableVerdicts: readonly string[];
  }): { runId: number; buildSymbols: readonly string[] | null } | null {
    const placeholders = q.carryableVerdicts.map(() => "?").join(", ");
    const row = this.db
      .query(
        `SELECT id, build_symbols FROM runs WHERE project_path = ? AND backend = ? AND COALESCE(identity_scheme, 1) = ? AND (build_symbols IS NULL OR build_symbols <> ?) AND finished_at IS NULL AND EXISTS (SELECT 1 FROM mutants m WHERE m.run_id = runs.id AND m.verdict IN (${placeholders})) ORDER BY id DESC LIMIT 1`,
      )
      .get(q.projectPath, q.backend, IDENTITY_SCHEME, JSON.stringify([...new Set(q.buildSymbols)].sort()), ...q.carryableVerdicts) as {
      id: number;
      build_symbols: string | null;
    } | null;
    return row === null ? null : { runId: row.id, buildSymbols: row.build_symbols === null ? null : (JSON.parse(row.build_symbols) as string[]) };
  }
```

Import `sameBuildSymbols` from `./preprocessor-symbols`.

- [ ] **Step 4: Implement in `orchestrator.ts`.**
  - Move the `readTargetSourceHash` call and `sourceSnapshot` (now after `createRun`, `:4165`) to just before the `sessionFingerprint` call (`:4090`), unchanged, and then compute `const buildSymbols = await effectiveBuildSymbols(cfg.projectDir, cfg.preprocessorSymbols ?? [], sourceSnapshot);`. (It must precede the fingerprint, which now holds the effective set. If any test pins that the source is read after the resume check, that is a STOP and a question, not an edit.)
  - The fingerprint's spread becomes `...(buildSymbols.length > 0 ? { preprocessorSymbols: buildSymbols } : {})`, with the comment `C02-06, R214: the EFFECTIVE symbols (config plus app.json), so an app.json change also breaks a resume.` Update `SessionFingerprintInput.preprocessorSymbols`'s doc comment in `resume.ts` to say the same.
  - `createRun` passes `buildSymbols`.
  - `resolveResume` gains a `buildSymbols` parameter. In the `"last"` branch, after the scheme lookup and before the generic error:

```ts
      const otherBuild = cfg.store.unfinishedRunUnderOtherSymbols({
        projectPath: cfg.projectDir,
        backend: backendName,
        buildSymbols,
        carryableVerdicts: [...CARRYABLE_VERDICTS],
      });
      if (otherBuild !== null) {
        throw new Error(
          `--resume found an unfinished run for this project and backend, run ${otherBuild.runId}, but it was built with preprocessor symbols ${symbolList(otherBuild.buildSymbols)} and this build uses ${symbolList(buildSymbols)}. An identity key names a site within one build, so a key can name a different site in another (R214). Drop --resume to run from scratch.`,
        );
      }
```

   In the `--resume-run` branch, after the scheme check and before the fingerprint check:

```ts
    if (row.buildSymbols === null || !sameBuildSymbols(row.buildSymbols, buildSymbols)) {
      throw new Error(
        `--resume-run ${cfg.resume} was built with preprocessor symbols ${symbolList(row.buildSymbols)}, but this build uses ${symbolList(buildSymbols)}. An identity key names a site within one build, so a key can name a different site in another (R214). Drop --resume-run to run from scratch.`,
      );
    }
```

   with, at module level, `const symbolList = (s: readonly string[] | null): string => (s === null ? "(not recorded)" : s.length === 0 ? "(none)" : s.join(", "));`.
  - The history call becomes `cfg.store.priorSurvivorKeys(cfg.projectDir, buildSymbols, { schemeChanged: <the existing callback>, symbolsChanged: (old) => { ... } })`, where `symbolsChanged` warns once per session (a `historySymbolsWarned` flag, like `historySchemeWarned`), only under `--skip-known-survivors`, code `history-build-symbols-changed`, message `[lethal] --skip-known-survivors: the latest finished run, run ${old.runId}, was built with preprocessor symbols ${symbolList(old.buildSymbols)}, and this build uses ${symbolList(buildSymbols)}. An identity key names a site within one build, so a key can name a different site in another, and no survivor from it is skipped: every mutant is executed (R214).`
  - Both statics assemblies (the one at `:5440` and the quarantine/early-report one) gain `buildSymbols`.
  - Beside the R325 marks warning (`:3886`): `const symbolsWarning = marksSymbolsWarning(marksUnderOtherSymbols(cfg.equivalenceMarks ?? [], buildSymbols), buildSymbols); if (symbolsWarning !== undefined) emit({ type: "warning", code: "equivalence-marks-build-symbols", message: symbolsWarning });`. That block runs before `buildSymbols` exists today, so the new warning is computed just below the `buildSymbols` line, where it is in scope. That point is after `backend.status()` and any al-runner provisioning (`orchestrator.ts:3914-3971`), and this plan does not move the source read earlier, so the plan makes no claim about when, relative to backend calls, the warning appears; it is emitted once per run (r3, minor c). The existing R325 marks warning stays where it is.

- [ ] **Step 5: Implement marks and verify.** In `equivalence-marks.ts`: `EquivalenceMark` gains

```ts
  /**
   * R214: the effective preprocessor symbols (config plus app.json) the key was made under. After
   * R214 a key names a site within one build, so a mark applies only to a build with exactly this
   * set. ABSENT means `[]`: the mark applies only to a build with no symbols.
   */
  readonly preprocessorSymbols?: readonly string[];
```

  `parseEquivalenceMarks` reads `e.preprocessorSymbols` per mark: absent stays absent; present goes through `validateSymbolList(e.preprocessorSymbols, `${at}`)` (so a malformed list throws, as every other malformed field does) and is stored sorted and de-duplicated. `marksUnderOtherSymbols(marks, buildSymbols)` returns `marks.filter((m) => !sameBuildSymbols(m.preprocessorSymbols ?? [], buildSymbols))`; `marksSymbolsWarning(stale, buildSymbols)` returns `undefined` for none, else `[lethal] ${stale.length} equivalence mark(s) were made under other preprocessor symbols than this build's (${symbols or "none"}). An identity key names a site within one build, so each is reported stale and none is matched or contradicted. Re-check each mark against this run's report, then set its "preprocessorSymbols" in ${EQUIVALENCE_MARKS_FILENAME} (R214).` `applyEquivalenceMarks` gains a fourth parameter `buildSymbols: readonly string[]`, and its first check becomes `if (mark.identityScheme !== identityScheme || !sameBuildSymbols(mark.preprocessorSymbols ?? [], buildSymbols))`. In `report.ts`'s `buildReport`, the call passes `statics.buildSymbols ?? []`. In `verify.ts`: `VerifySource` gains `/** R214: the source run's effective build symbols, or null when not recorded (then no mark applies). */ readonly buildSymbols: readonly string[] | null;` set from `run.buildSymbols`; the plan's `staleMarks` becomes `marks.filter((m) => m.identityScheme !== source.identityScheme || source.buildSymbols === null || !sameBuildSymbols(m.preprocessorSymbols ?? [], source.buildSymbols))`; a source run with `buildSymbols === null` (recorded before this column) is refused before anything is built, with `VerifyError("source-predates-verify", "run <id> recorded no build symbols (before R214), so its keys cannot be tied to one build; run lethal run again, then verify")`, never read as `[]`; and its `createRun` passes `buildSymbols: source.buildSymbols` with the comment `R214: the rows carry the SOURCE run's keys, so they carry its build too.` Add one test to the verify suite for that refusal (a source row with `build_symbols` set to NULL).
  In `packages/runner/itest/harden-fixture.test.ts`'s "the committed mark names exactly the planted equivalent", after the existing checks (I8):

```ts
    // R214: the mark still applies under the new scheme to the build the harden gate runs, which
    // has no preprocessor symbols. A mark that went stale here would lose the planted equivalent.
    const applied = applyEquivalenceMarks(
      marks,
      m.mutants.map((e) => ({ mutantCode: e.mutantId, identity: serializeKey(identityKeyOf(e)), verdict: "survived" })),
      IDENTITY_SCHEME,
      [],
    );
    expect(applied.matched.map((x) => x.key)).toEqual([mark.key]);
    expect(applied.stale).toEqual([]);
```

  Then `bun run typecheck`: every `createRun(` and `priorSurvivorKeys(` caller the compiler names (tests included) gains `buildSymbols: []` or `, []`; each test that stores a run with symbols passes them. Record the list in `$Q/logs/t8-callers.txt`.

- [ ] **Step 6: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. Add one assertion to `r214-history.test.ts`: after a `runSession` under `[LETHALB]`, `store.getRun(id)?.buildSymbols` equals `["LETHALB"]` (the row records the effective set, not NULL). `bunx biome check` on every touched file.

- [ ] **Step 7: Red-check each hunk alone**, in `$Q/logs/t8-redcheck.txt`: (a) `priorSurvivorKeys`'s symbol check removed: "history: a [LETHALA] survivor is not skipped" goes red (L15 is `known-survivor`), its control stays green; (b) `--resume-run`'s symbol check removed: its test goes red (the fingerprint refuses with the generic "scoped differently" message, which the regex does not accept); (c) the fingerprint fed `cfg.preprocessorSymbols` again and `unfinishedRunUnderOtherSymbols` returning `null`: "--resume last names the [LETHALA] run" goes red; (d) `applyEquivalenceMarks`'s symbol condition removed: "marks: a mark made under [LETHALA]" goes red, its control green; (e) `preprocessorSymbols ?? []` in the mark check replaced by `buildSymbols` (absent matches anything): "a mark with no symbols" goes red; (f) `IDENTITY_SCHEME` set, alone, to the starting scheme `S` that `before/scheme.json` holds (r3, I2; never "one less than the constant", which moves with the revert): the I4 pin, "history: the old L13 survivor", "--resume-run of the old run", "--resume last names the old run" and the old-scheme half of the marks test go red, because the old record now matches on scheme and symbols; "the real pre-R214 row shape" stays green (its NULL symbols still refuse, which shows the two guards are independent), and the current-scheme controls stay green; (g) `createRun` inserting `build_symbols` as NULL: the history control and the `getRun` assertion go red; (h) the harden test's new block with `[]` replaced by `["X"]`: it goes red, which shows it reads the symbol rule rather than passing either way.

- [ ] **Step 8: Commit.** `git commit -m "fix(R214): runs record their effective build symbols; history, --resume last, --resume-run, marks and verify apply only within the same set, refused by name; scheme transitions pinned on the same-text key"`.

---

### Task 9: Offline proof against the pre-commitment

**Files:** scratch only (`$Q`, `H:/lethal-scratch/R-214/corpus/`). On the branch with Tasks 2 to 8 committed.

- [ ] **Step 1: Repros and `sandbox-symbols`.** `bun test packages/runner/tests/r214-compiled-out.test.ts` is green (it IS the per-mutant comparison). Also `bun scripts/r214-capture.ts <dir> --symbols <set>` for each, `cmp` against the committed expected file. Expected: identical, all of them (the unit test's capture and the script's are two readings of one format; both must match).

- [ ] **Step 2: alc per build.** Write `$Q/alc-emit.ts` from R-323's `alc-all.ts` recipe (`C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323/alc-all.ts`), repointed to this worktree, taking one explicit set: `generateMutationSet(dir, { preprocessorSymbols })`, `writeInstrumentedProject`, copy the files with no mutant, `injectControlDependency`, the Control app and its `.alpackages` from `U:/Git/LethAL/extensions/lethal-control`, then `alc /define:<set>` (omitted for `[]`). Run it for every repro and set and for `sandbox-symbols`. Then `bash $P/prove.sh` with the AFTER captures in place of the predictions. Expected: every instrumented build `exit=0 app=true`; every `dropped` COMPILES; every `control` REJECTED. Any other result is a STOP.

- [ ] **Step 3: Gate fixtures byte-identical.** For the seven of Task 1 Step 6: the AFTER capture equals the BEFORE capture (`cmp`), `probe-fixture-hashes.ts` equals, and `diff -r` of the instrumented targets (built with the capture's settings into two directories) is empty apart from `app.json`. Expected: all identical. This is what stands in for the gates Decision 10 does not run.

- [ ] **Step 4: Corpora against the committed listings, one at a time (r3, I3 and I4).** First confirm the corpus is the pre-committed one: `hashTargetSource` of `$root` and `git -C "$root" rev-parse HEAD` equal the committed listing header's (else STOP: the corpus moved, not the engine). Then, for each corpus `c` and set `i`, with `$root` and `$s` as in Task 1 Step 7, nothing else heavy running, full BaseApp alone:

```bash
set -euo pipefail
Q=H:/lethal-scratch/R-214/plan-r2; O=H:/lethal-scratch/R-214/corpus; A="$O/after"; R=$(pwd)
mkdir -p "$A"
# (1) The memory run: EXACTLY master's command from Task 1 Step 7, in its own run, output discarded (I4).
bun "$R/scripts/r214-capture.ts" "$root" --symbols "$s" > /dev/null 2> "$A/peak-$c-$i.err"
# (2) The AFTER capture, a separate run.
bun "$R/scripts/r214-capture.ts" "$root" --symbols "$s" > "$A/after-$c-$i.txt" 2> "$A/after-$c-$i.err"
# (3) Fresh regions and a fresh full twin from the corpus text, and the full twin captured by THIS engine.
rm -rf "$A/twin-$c-$i" "$A/full-$c-$i"
bun "$Q/pp.ts" "$root" "$s" "$A/twin-$c-$i" "$A/regions-$c-$i.json" --full "$A/full-$c-$i"
bun "$R/scripts/r214-capture.ts" "$A/full-$c-$i" > "$A/full-$c-$i.txt" 2> "$A/full-$c-$i.err"
# (4) A fresh presence result from the AFTER capture; both counts must be 0 (I3).
bun "$Q/presence.ts" "$A/after-$c-$i.txt" "$A/full-$c-$i.txt" "$A/regions-$c-$i.json" "$root" > "$A/presence-$c-$i.txt"
u=$(sed -n 's/^UNCLASSIFIED //p' "$A/presence-$c-$i.txt"); x=$(sed -n 's/^EXTRA //p' "$A/presence-$c-$i.txt")
[ "$u" = 0 ] && [ "$x" = 0 ] || { echo "STOP: $c.$i UNCLASSIFIED=$u EXTRA=$x"; exit 1; }
# (5) The listing from THAT result and those regions; the committed rows are never an input.
bun "$R/scripts/r214-capture.ts" --listing "$A/listing" --label "$c.$i" --from-expected "$A/after-$c-$i.txt" --presence "$A/presence-$c-$i.txt" --regions "$A/regions-$c-$i.json" --root "$root"
# (6) Only now are the committed files read.
cmp "docs/superpowers/specs/r214-corpus/$c.$i.files.tsv" "$A/listing/$c.$i.files.tsv"
cmp <(zcat "docs/superpowers/specs/r214-corpus/$c.$i.rows.tsv.gz") <(zcat "$A/listing/$c.$i.rows.tsv.gz")
```

Expected: every command exits 0, both counts are 0, and both `cmp` are silent. The `EXCLUDED` rows (from the fresh presence result) and the `INACTIVE` rows (from the fresh regions) are part of that equality, so presence and absence are both checked independently of what Task 1 committed. The full twin holds no directive, so both engines should read it alike; if Task 1's `$O/full-$c-$i.txt` is still on `H:`, `cmp` it with `$A/full-$c-$i.txt` too, and a difference is a STOP.

- [ ] **Step 5: The memory gate.** For each corpus and set, read `maxRSS_KB` from `$A/peak-$c-$i.err` ONLY (run (1): master's exact command) and the committed master peak from the spec's "Memory" section. Runs (2) to (5) are no-crash and equality checks; their peaks are recorded in the log but never compared (r3, I4). Expected: every run of Step 4 exited 0, and every `peak` is at most 110% of master's. A crash or a breach is a STOP: report the numbers per corpus and set; do not change code in this step.

- [ ] **Step 6: Whole suite.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the root. Green (R335's timeouts aside, each passing alone).

---

### Task 10: The R321 re-freeze (owner-approved) and the live gates

**Files:**
- Modify: `packages/runner/itest/symbol-fixture.ts` (the three tables, the header comment, the failure message at `:172`), `packages/runner/tests/symbol-fixture.test.ts` (the non-vacuity test), `fixtures/README.md` (§ sandbox-symbols)
- Delete then re-record (after owner approval only): `packages/runner/itest/al-runner.symbols-lethala.baseline.json`, `al-runner.symbols-lethalb.baseline.json`

- [ ] **Step 1: Transcribe the pre-committed tables.** In `symbol-fixture.ts`, replace `EXPECTED_BY_SET` and `EXPECTED_NO_DEFINE` with Decision 7's table, the header's "All three builds score 5 killed / 8 survived and each pair differs on 8 of 13 mutants" with "Since R214 each build has 9 mutants, 5 killed / 4 survived: the seven outside the arms plus its own arm's two. Two builds share seven rows and differ on 4 of their verdicts, and each has two rows the others lack, so a transport that compiled the wrong build fails on the rows AND on the count. Pre-committed in docs/superpowers/specs/2026-09-29-r214-precommitment.md.", and the failure message at `:172` so it names the new document (minor 1):

```ts
    `R321 ${leg} ${label}: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r214-precommitment.md, "R321, new tables"; before R214: docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`,
```

```ts
export const EXPECTED_BY_SET: Readonly<Record<string, readonly SymbolRow[]>> = {
  "[LETHALA]": [k(8, EB), k(9, RA), k(9, SI), s(10, RA), s(10, SI), s(11, RA), s(11, SI), k(13, RV), k(13, SA)],
  "[LETHALB]": [k(8, EB), s(9, RA), s(9, SI), k(10, RA), k(10, SI), s(11, RA), s(11, SI), k(15, RV), k(15, SA)],
};

export const EXPECTED_NO_DEFINE: readonly SymbolRow[] = [
  k(8, EB), s(9, RA), s(9, SI), s(10, RA), s(10, SI), k(11, RA), k(11, SI), k(17, RV), k(17, SA),
];
```

In `symbol-fixture.test.ts`, the non-vacuity test becomes:

```ts
  test("non-vacuity: three builds, 9 mutants each, 5/4 each, seven shared rows differing pairwise on 4", () => {
    const tables = [rowsOf("[LETHALA]"), rowsOf("[LETHALB]"), EXPECTED_NO_DEFINE];
    const key = (r: SymbolRow) => `${r.line}|${r.operatorName}`;
    for (const t of tables) {
      expect(t).toHaveLength(9);
      expect(t.filter((r) => r.verdict === "killed")).toHaveLength(5);
    }
    const shared = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      x.filter((r) => y.some((o) => key(o) === key(r)));
    const differ = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      shared(x, y).filter((r) => y.find((o) => key(o) === key(r))?.verdict !== r.verdict).length;
    const [ta, tb, tn] = tables;
    if (ta === undefined || tb === undefined || tn === undefined) throw new Error("missing table");
    expect([shared(ta, tb).length, shared(ta, tn).length, shared(tb, tn).length]).toEqual([7, 7, 7]);
    expect([differ(ta, tb), differ(ta, tn), differ(tb, tn)]).toEqual([4, 4, 4]);
  });
```

Add one assertion to the same file that the failure message names `2026-09-29-r214-precommitment.md` (drive `assertSymbolBuild` with a wrong row and match the thrown message). `fixtures/README.md`: the paragraph says 5 / 4 / 0 over 9 per build since R214, and "compiles out four of them" becomes "LethAL no longer generates the other builds' arm mutants (R214)". `bun test packages/runner/tests/symbol-fixture.test.ts` green. Commit: `test(R214): the sandbox-symbols tables per the R214 pre-commitment (9 mutants per build); the gate's message names it`.

- [ ] **Step 2: Run the al-runner gate in normal mode.** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner > $Q/logs/t10-alrunner-1.txt 2>&1`, foreground. Read its first line (the al-runner build). Expected: the sandbox-app legs PASS per mutant (3 / 12 / 4, unchanged); every symbol leg's printed table equals Decision 7's column; the run fails ONLY on the committed baselines' comparison for the two symbol sets (they hold 13 rows). Anything else is a STOP.

- [ ] **Step 3: Owner checkpoint (Q4).** `coord checkpoint --task R-214 --wait owner --note "R321 re-freeze ready: frozen 5/8/0 over 13 moves to 5/4/0 over 9 per set as pre-committed (<spec sha>); the gate run shows only the two symbol baselines' comparison failing (<log>); approve deleting and re-recording al-runner.symbols-lethala.baseline.json and al-runner.symbols-lethalb.baseline.json?"`. Nothing below runs, and neither baseline is touched, until an approving `coord answer` or `task.md` revision.

- [ ] **Step 4: Re-record, inspect, then pass.** `git rm packages/runner/itest/al-runner.symbols-lethala.baseline.json packages/runner/itest/al-runner.symbols-lethalb.baseline.json`; `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` (exits 3 by design, a failed receipt, never a pass). Inspect each new baseline against Decision 7's pre-committed key diff ("The baseline diff, by key"), key by key (r3, I8): `git diff --no-index <(git show HEAD:packages/runner/itest/al-runner.symbols-lethala.baseline.json) packages/runner/itest/al-runner.symbols-lethala.baseline.json > $Q/logs/t10-baseline-diff-lethala.txt`, and the same for `-lethalb`. The baselines hold keys, verdicts and killing tests only, no line and no grain, so the check is by key: under `[LETHALA]`, exactly the four keys `SA|1`, `SA|2`, `RV|1`, `RV|2` are gone and the other nine rows are byte-identical; under `[LETHALB]`, the same four keys are gone, the rows at `SA` and `RV` change from `survived` / `null` to `killed` / `RateSmall` (the key now names L15, which is built, instead of the compiled-out L13; predicted, not a regression), and the other seven rows are byte-identical. Any other added, removed or changed key is a STOP, even if the gate's per-line table check (Step 2, which runs before recording) passed. Re-run without the variable: PASS. Commit: `test(R214, R321): re-record the two symbol baselines per the R214 pre-commitment (owner-approved <ref>)`.

- [ ] **Step 5: The red-checks of R321, re-run** (Decision 7): (a) delete the daemon's `--define` line in `AlRunnerServer.start`, run the gate, expect the server legs to print 3 killed / 6 survived and fail the four equality assertions; restore. (b) delete `buildAlRunnerArgv`'s `--define` loop, run in normal mode, expect the one-shot legs to fail against the table with 3 / 6, six failures in all; restore. Record both in `$Q/logs/t10-r321-redcheck.txt`.

- [ ] **Step 6: The container gates, one at a time.** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`; `coord lease Cronus28 preproc`; heartbeat every 5 minutes. Then `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`, `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked`, each foreground, each log in `$Q/logs/`. Expected: each PASS against its committed baseline, per mutant. Release the lease right after. A moved verdict is a BLOCK, reported to the owner. `itest:hang`, `itest:envtool` and `itest:harden` are NOT run (Decision 10), and none of `envtool.baseline.json`, `harden.baseline.json` or any other baseline is touched.

---

### Task 11: Roadmap, and hand-off

**Files:** `docs/roadmap/R214.md`, `R285.md`, `R306.md`, `R342.md`, `R325.md`, `R287.md`, `R304.md`, `R343.md`, new items, `ROADMAP.md` (generated).

- [ ] **Step 1: Narrow, close and cross-link.** `R214`: status `open, narrowed 2026-MM-DD (<Task 4 commit>..<Task 8 commit>): no mutant in a compiled-out arm, undecidable files refused and counted; six named exclusions stay open` (NOT `done`: the orchestrator's ruling), with a section stating exactly what is closed (Decision 1's first paragraph), the six exclusions with their per-corpus counts from the pre-commitment and their items, the scheme bump and its measured key moves, the history / resume / marks scoping, the alc proofs, the red-checks and the gates run and not run. `R342` `done (<Task 5 commit>)`. `R285` `done (<Task 6 commit>)` for its four inactive-arm mutants (its block-body `empty-block` loss stays, pointed at R304). `R306`: case 1 closed by R214; case 3's prediction was wrong (unplaced) and is now right (statement, since the Task 5 hunk); case 2 remains R300's. `R287`, `R304`, `R343`: one line each naming their per-corpus exclusion count from R214's pre-commitment. One line in `R325`: "Scheme <N>: R214 (compiled-out arms, refused files, in-arm statements), measured key moves in the R-214 plan; runs also record their effective build symbols."

- [ ] **Step 2: File the follow-ups.** Re-check the next free id across every worktree and branch immediately before writing (`for w in U:/Git/LethAL-wt/*/ H:/LethAL-wt/*/; do ls "$w/docs/roadmap"; done | sort -u | tail -3` and `git for-each-ref refs/heads --format='%(refname:short)' | while read b; do git ls-tree --name-only "$b" docs/roadmap/; done | sort -u | tail -3`). File, one per id:
  1. A `#if` in a single-statement slot (`p8-slot`): its arm statements are still no sites (exclusion `slot`, with its corpus counts).
  2. al-runner predefines `CLEANSCHEMA1..25` and alc does not, so on al-runner a `#if not CLEANSCHEMA<n>` arm (n up to 25; 35 in BaseApp) is still generated and compiled out; measure against the current al-runner first.
  3. Member-wide analyses read compiled-out arms: the write-transaction and hang tags.
  4. `scripts/campaign/compile-only.ts` compiles and enumerates with no config symbols.
  5. Upstream: tree-sitter-al scopes `not` over a following `and` / `or` (the note below; LethAL no longer depends on it, since it reads condition text).
  6. `SessionReport` records the config symbols but not the effective set; `excludedSites` carries the effective set only when a site was compiled out.
- [ ] **Step 3: Regenerate and commit.** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, commit `roadmap(R214): narrowed, not done; R285, R342 done; R306 narrowed; exclusions cross-linked; follow-ups filed`.
- [ ] **Step 4: Scheme race check before handoff (r3, C1, blocking), then report.** `git merge master`, then run Task 2 Step 0's mode `post` check. Exit 2: do Task 2 Step 6 now (re-bump, re-run the transition, capture and gate checks), then run this step again from the merge. Exit 1: STOP. Only on `OK` does the lane write the submit note and call `coord submit`; a race is never left for someone else to resolve. The note reports: (a) the check's `OK` line, naming master's scheme and this branch's, and every re-bump made (from which number to which, and the logs of the re-runs); (b) CLAUDE.md's `itest:alrunner` paragraph moves from "killed 5 / survived 8 / no-coverage 0 over 13" to "5 / 4 / 0 over 9 per set, since R214", and its sentence "R214's fix will need a new pre-commitment and a re-freeze here" is now history; (c) the prose sweep of `README.md`, `docs/measurements/README.md` and `.claude/skills/live-gate/SKILL.md` for the old figure (`grep -rn "5 / 8\|5/8\|over 13" README.md docs/measurements/README.md .claude/skills`), listed for the orchestrator where the lane may not edit; (d) the gates NOT run (Decision 10). Then `coord submit`.

---

## Self-review

- **task.md, "Orchestrator, 2026-09-29".** C1: Decision 5, Task 8 (history, `--resume last`, `--resume-run`, marks, verify), each with a control on the measured L13/L15 key, red-checked in Task 8 Step 7 (a) to (e). C2: the measured table (49 rows, 99 compiles), Decision 2, Task 4 (the table as test data), Task 6 (whole-file refusal), Task 7 (counted); no arm the evaluator is unsure of is ever kept. I3: the Goal, Decision 1's six exclusions, R214 `open, narrowed` in Task 11. I4: Task 8 Step 1's second describe, on the old engine's own record since r3 (below), red-checked in Step 7 (f). I5: Decision 6's committed listing, Task 1 Steps 9 to 11, Task 9 Step 4. I6: Decision 3, Task 3, red-checked in Task 3 Step 5 (c) and (d). I7: Task 4's fast path and its test, Decision 6's 110% gate, Task 1 Step 7, Task 9 Step 5. I8: Decision 10, Task 8 Step 5's harden test, Task 10 Step 6. Minors: Task 10 Step 1 (message), Task 3 Step 5 and Task 8 Step 7 (f) (red-checks). Q1: Decision 9, Task 7 in the ripple's order. Q2: Decision 3. Q3: Decision 1. Q4: Decision 7, Task 10 Steps 3 and 4.
- **Addendum.** "The next scheme" throughout; four files carry the new number because they must (constant, CHANGELOG, harden marks file, agent guide example), and `before/scheme.json` carries the starting one; every new test reads `IDENTITY_SCHEME` or that file; since r3 a moved master is handled by the blocking scheme-race check, not reported.
- **task.md, "Orchestrator, 2026-09-30" (r3), item by item.**
  - C1: the check's exact commands are in Task 2 Step 0 (both modes, tested at plan time as `$T/scheme-race.sh`); it blocks before the first product commit (Step 0, `pre`), after every later merge (Global Constraints), and before handoff (Task 11 Step 4); a race triggers Task 2 Step 6, which changes the constant, CHANGELOG, harden marks file (and the agent guide) in one commit and re-runs the transition tests (whole suite), Task 8 Step 7 (f), the captures (Task 9 Steps 1, 3, 6) and the live gates (Task 10 Steps 2, 6). No step leaves the bump to a note.
  - I2: no test builds an old record by relabelling a new-engine run (`storedRun` lost its `scheme` option; `oldEngineRun` writes master's L13 key and line through the store API). All four paths use it (history, `--resume-run`, `--resume last`, marks). The constant red-check (Task 8 Step 7 (f), Task 2 Step 4) targets `S` from `before/scheme.json`, which Task 1 commits; no test or step uses `IDENTITY_SCHEME - 1`.
  - I3: Task 9 Step 4 regenerates regions, the full twin, its capture and `presence.ts` from the AFTER capture, requires both counts 0, and only then writes the listing; the committed rows enter only at `cmp`.
  - I4: Task 9 Step 4 run (1) is master's command byte for byte, output discarded, its own run; Step 5 reads only it.
  - I5: Task 6 Step 3 pushes the row unconditionally; the zero-site test (Task 6) and Run 2 (Task 7) pin it apart from `p12-refused`, red-checked by Task 6 Step 8 (h) and Task 7 Step 5 (e).
  - I6: every exact assertion on a `p12-refused` path says `src/...`, after normalising separators, which is needed on Windows (`readdir` returns `src\SymbolLogic.Codeunit.al` for `fixtures/sandbox-symbols`, measured on this machine).
  - I7: the report schema touched is `report-v3.schema.json` only; Task 7 Step 3.7 asserts v2 unchanged with `git diff --exit-code`.
  - I8: Decision 7's key-diff table, pinned by Task 1's spec, checked in Task 10 Step 4; the `[LETHALB]` verdict change at `SA` and `RV` is predicted.
  - Minor a: `preproc-files-refused`, its interpretation, the push on the file count, the two counts 20 to 21, and the explain v7 that R233's pin forces, all in Task 7.
  - Minor b: Task 6's generation-level test and Task 7's Run 1 (report row, no mutant from the file).
  - Minor c: Task 8 Step 4's last bullet makes no timing claim.
  - Approvals: nothing in r2's design changed; no approved point was re-opened.
- **task.md step 2 (the original plan requirements).** Pre-commitment committed alone (Task 1); repros, gate fixtures and corpora as exact counts and now per-file listings (Task 1); the scheme decision (Decision 4); the R321 re-freeze through `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, never a hand edit (Task 10); alc proof per build (Decision 8, Task 9 Step 2); red-checks per hunk (every product task).
- **Placeholder scan.** Values left open are ones a run produces and the spec then pins (repro and corpus counts for the three new repros and the corpora, the new fingerprint, SHA-256s, master's peaks, the scheme number `N`); each has the command that produces it and a STOP rule for a surprise. The `kinds` string in Task 6's test is existing product output, taken from the red run.
- **Type consistency.** `evaluateArms(root, source, symbols)` / `startsInInactiveArm` / `ArmEvaluation` (Task 4) are what Task 6 calls; `effectiveBuildSymbols`, `sameBuildSymbols`, `validateSymbolList` (Task 3) are what Tasks 6 and 8 call; `PreprocExcludedFile` (Task 6) is what Task 7's event, fold and `buildExcludedSites` carry; `buildSymbols` is the name on `MutationSetResult`, `createRun`, `RunRow`, `priorSurvivorKeys`, `FoldStatics`, `VerifySource` and `resolveResume`; the mark's field is `preprocessorSymbols`, like the config's.
- **No source text.** The listings, `excludedSites.detail`, the refusal reasons and the warnings hold paths, lines, names, hashes, symbols and reason codes only; Task 1 Step 9 and Task 7 Step 1 each assert it.

## Notes: upstream grammar observation (draft, not filed)

tree-sitter-al 4.4.1: `preproc_not_expression` is `seq('not', _preproc_expression)` with no precedence, so `#if not A and B` parses as `not (A and B)` and `#if A and not B or C` as `A and not (B or C)`. alc 18.0.41 binds `not` to the next operand (rows 9 to 11 of the measured table). Suggested fix: `prec(3, seq('not', _preproc_expression))`, above `and` (2) and `or` (1). Zero occurrences in the four corpora. Since r2 LethAL reads condition text with its own parser, so the product does not depend on the fix.

## Open questions for the orchestrator

None. r2's two questions were answered on 2026-09-30: history keeps the latest-finished-run shape, scoped to an identical effective symbol set (approval 3), and an absent mark `preprocessorSymbols` means `[]`, so DC's marks go stale until re-checked and labelled with `BC20` to `BC27` (approval 4).
