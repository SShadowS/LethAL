# R-318 (r2): coverage attribution for a split-header procedure whose `#if` arms rename it

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A split-header procedure whose `#if` arms give it different names gets coverage attributed to it, so a public one's mutants stop reading `no-coverage` while its tests run it. This holds in EVERY build for fenced bcdev (the default) and for every al-runner leg (one-shot Cobertura, `--server`, resource). No identity key moves, no member borrows another member's coverage, and a `--resume` across the change cannot carry an old `no-coverage` forward.

**Architecture:** `procedureName` stays `""` for a renamed member, so identity keys are untouched. A new engine function, `renamedMemberCoverageNames`, lists the member's arm names minus any name another declaration of the same object also uses. The manifest carries that list as `coverageArmNames`. The line map spans the member under the list's first name, which fixes the two LINE-based sources (fenced bcdev, al-runner Cobertura) in every build. al-runner's `--server` path, which names procedures itself, re-keys a statement that lies inside a renamed member's span to that same name by POSITION, so it matches the one-shot leg in every build. `coverageFilter` looks the mutant up under every name in the list, which serves the NAME-only hub. Resume refuses to carry a `no-coverage` onto a renamed member and refuses to reuse a baseline snapshot for a batch holding one. Nothing in the emitted AL changes.

**Tech Stack:** Bun, TypeScript, tree-sitter-al through the native addon (`packages/engine/native`), `bun:test`, `alc` (offline compile), al-runner v2.12.0 (local, measured), and one live Cronus28 leg under `coord lease Cronus28`.

**Spec:** `docs/roadmap/R318.md`, `H:/lethal-coord/tasks/R-318/task.md`. Review: `H:/lethal-coord/reviews/R-318-plan/review-r1.md`. Background: `docs/roadmap/R301.md`, `R302.md`, `R316.md`, `R330.md`, `R214.md`, `R300.md`, `R323.md`; `docs/superpowers/plans/2026-09-28-R-316-preamble-member.md`.

**Measured at:** HEAD `b6562aba` (master `a0c7e3d9` merged, R-323 landed, `IDENTITY_SCHEME` 3), al-runner v2.12.0, 2026-09-29.

---

## Changes from r1

| finding (review r1, orchestrator) | what r2 does | where |
|---|---|---|
| C1: `--resume` carries a stale `no-coverage` | Two guards, both needed: `carriedVerdictFor` never carries a `no-coverage` onto a mutant with `coverageArmNames`; a batch holding such a mutant never reuses a baseline snapshot (the snapshot's coverage was attributed by the OLD line map, and its key cannot tell). The second guard is new: the carry guard alone re-scores the mutant against the stale snapshot and gets `no-coverage` again. | Decision 5, Task 6 |
| C2: `r3` build `[]` and `r4` server builds stay false `no-coverage` | Chose POSITION, not per-build evaluation. The server path re-keys a renamed member's statements by line, so every al-runner leg and fenced bcdev attribute in every build. No `#if` evaluator exists in the repo, and the effective symbol set is not fully known to LethAL (app.json symbols, file-level `#define`). What stays open is narrowed and named: the hub (`coverageMode: "procedure"`) and a member whose every arm name is taken. Counts both ways in Decision 4. | Decision 4, Task 4, Task 11 |
| I3: collision removal is one-sided | Stated plainly. On the hub the wrapped `Choose` still borrows the renamed member's coverage (predicted, measured in Task 9). On al-runner's server legs the position re-key removes that borrow for this shape, which is a consequence of R318's attribution, not an R214 fix. The R214 note is written only from measured numbers. | "What this plan does NOT fix", Task 11 |
| I4: the line proof tests the map, not the producer | Raw producer output MEASURED on al-runner (both legs, both builds, 12-line inactive first arm, `r7-lines`): line numbers equal source line numbers. Producer-level ownership check in Task 8 (per-mutant `tests=`) and a producer-level red-check. Fenced BC leg REQUIRED on Cronus28, planned with pre-committed predictions, never inferred from al-runner. | "Measured producer facts", Tasks 8 and 9 |
| I5: offline checks narrower than claimed | Every build counted by its own PASS line (20 builds), key digests compared to the 64-hex LITERALS in this plan, census log gains the fixtures row and a parse-error count. | Pre-commitment, Task 7 |
| I6: quoted names | Measured: al-runner `--server` sends `scope` `Pick Me` unquoted; the hub's name source (`SymbolReference.json` `Methods[].Name`, what `AppMethodIndex` reads) holds `Choose Me` unquoted. Pinned by tests; fenced BC gets no name from the wire (line-based). Live hub check on Cronus28 in Task 9. | "Measured producer facts", Tasks 4, 5, 9 |
| Minor: report and test-order still group renamed members under `""` | No `SessionReport` field now (ruling 2). Task 10 files a roadmap item with its cost. | Decision 6, Task 10 |
| Minor: R338 blocker stale | al-runner v2.12.0 is usable; the two-build probe (Task 8) runs in this task, and R318 does not close before it. | Task 8 |
| Orchestrator update: HEAD `b6562aba`, `IDENTITY_SCHEME` 3 | Every key pin and digest re-measured at `b6562aba`: all six r1 digests are unchanged. A repro with a named return value (`r9`) added: the return value's name is not an arm name. R-323 touched `resume.ts` only in tests; the C1 guards sit in `carriedVerdictFor` and the snapshot call site, which R-323 did not change. | Global Constraints, Pre-commitment, Task 1 |
| New finding while measuring | al-runner v2.12.0 reuses a build compiled under OTHER `--define`s for a byte-identical bundle pair. LethAL is protected by accident (the instrumented target embeds a random artifact id). Raw probes use `--no-cache`. Filed in Task 10. | "Measured producer facts", Task 10 |

---

## Global Constraints

- Identity keys must not move. `IDENTITY_SCHEME` stays `3`. This design never changes `procedureName`, `triggerName`, `astHash`, `codeunitName`, the operator, or ordinals, which are everything `identityTupleOf` and `assignIdentityOrdinals` read. Pinned by literal keys in Task 2 and by the Task 7 digest check against this plan's literals. If any key moves, STOP: the design is wrong, not the scheme.
- No wrong-member attribution. A coverage row reaches a renamed member's mutants only under a name that no other declaration of the same object carries in any arm, and no trigger of the object carries (Decision 2). The position re-key (Decision 3) only ever maps a line INTO the renamed member's own span. An object that did not parse cleanly gets no names. Fail toward "say less".
- No wrong-type class (R302, R330). No semantic resolution changes: `procedureLikeNameNode`, the symbol table, `uniqueProcedure`, `declaresProcedure` and every operator stay as they are. Nothing new is emitted; Task 7 proves the emitted AL byte-identical.
- Emitted AL byte-identical for every repro, fixture and corpus. Manifests byte-identical except `coverageArmNames` on renamed members' mutants.
- No `SessionReport` field (ruling 2). The stream schema gains one optional property, regenerated with `bun scripts/generate-schemas.ts`.
- No `!` non-null assertions. Optional props built as `...(v.length > 0 ? { k: v } : {})`.
- Build and test order (CLAUDE.md): native parser present (`LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts` only if missing or stale); `bun run typecheck`; `rm -rf packages/*/dist`; then `bun test` from the repo root. Biome only on touched files.
- al-runner runs are local and allowed (Task 8). The Cronus28 leg (Task 9) runs only under `coord lease Cronus28`, one gate at a time, and is REQUIRED before R318's status changes.
- Scratch lives under `$R` = `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318`. Nothing under `$R` is committed. Repros are hand-written with invented names; no corpus source is quoted.
- Plain English, short sentences, no em dash character anywhere. No `file:line` citations in roadmap text (`scripts/line-citations.test.ts`).
- Red-check every fix: revert the one change, show the named test go red, restore, show green. Report both outputs.

## Review Focus

1. **An arm name another declaration of the same object also uses** (a plain overload, a `#if`-wrapped procedure, another renamed member, a swallowed member, a trigger). Expected: that name is dropped, the others stay. Pinned by Task 1's collision tests.
2. **A renamed member's statement reported by `--server` under a name the collision rule dropped** (`r3` build `[]`: `scope` `Choose`). Expected: re-keyed by position to `Pick`, so the member is covered and the `#if`-wrapped `Choose(T)` is not. Pinned by Task 4's test and Task 8's `r3` server leg.
3. **A resume across the change.** Expected: a prior `no-coverage` on a renamed member is re-scored against a fresh baseline. Pinned by Task 6's runSession test, which goes red with EITHER guard removed.
4. **A coverage source reports a quoted member name** (`"Pick Me"`). Measured: no producer sends the quotes. Pinned by Task 4 and Task 5 tests using the measured strings.
5. **A manifest or event stream written before R318** (no `coverageArmNames`). Expected: exactly today's behaviour. Pinned by Task 5's "field absent" test.

---

## Design

### Decision 1: the names live in a new manifest field, not in `procedureName`

`procedureName` is part of the identity key (`astHash|codeunitName|procedureName-or-triggerName|operator|major`, then an ordinal among twins). A name there moves the member's keys and OTHER members' ordinals: `r4`'s second member holds `40277aa1...|Repro R||lethal.return-value|1|1`, ordinal 1 in the shared `""` group, which drops to 0 the moment either member leaves that group. That needs a scheme bump and breaks every stored history, resume and equivalence mark for the file.

So `procedureName` stays `""` and a new optional field carries what coverage needs:

```ts
readonly coverageArmNames?: readonly string[];
```

Written only on the mutants of a renamed member with at least one usable name. Absent everywhere else, so every other manifest is byte-identical.

### Decision 2: which names are in the list (the wrong-member guard)

`renamedMemberCoverageNames(member)` in `packages/engine/src/ast/tree-walks.ts`:

1. `[]` unless `member` is a split-header shape whose arms disagree (`procedureLikeNameNode` is `null`).
2. Walk up to the member's object declaration. `[]` if none, or if the object node `hasError`.
3. Collect every name any OTHER declaration of that object uses: every arm name of every other procedure-like in `allProcedureLikes(object)` (direct members, `#if`-wrapped ones, swallowed ones), and every trigger's name.
4. Return the member's own arm names (the `name` field of each arm; a named return value is the `return_value` field and is not an arm name, measured on `r9`), quotes stripped, deduplicated case-insensitively (first spelling kept), in source order, minus the collected names.

Why this cannot attribute a DIFFERENT procedure's coverage: in any one build exactly one arm of the member is compiled, so the member carries exactly one of its names. A name no other declaration of the object carries, in any arm, can only be this member in any build. A name that fails that test is dropped. Overloads count as collisions because name-keyed coverage cannot tell them apart.

### Decision 3: how each coverage source matches

| source | how it names a line | after R318 |
|---|---|---|
| fenced bcdev (the default) | our line map, from the EMITTED source | the member is spanned under `coverageArmNames[0]`; every build |
| al-runner one-shot, Cobertura | our line map, from the emitted source | same span; every build |
| al-runner `--server`, resource | the producer's `st.scope` (the compiled arm's name) | a statement whose `line` lies in a renamed member's span is re-keyed to that span's name; every other statement keeps `st.scope`; every build |
| hub (`coverageMode: "procedure"`) | `AppMethodIndex`, the compiled arm's name | `coverageFilter` unions every name in `coverageArmNames`; a build whose compiled name was dropped still misses (Decision 4) |

Attribution is reported `exact`. A local renamed member on the hub still misses by name (the hub cannot name locals) and takes the existing unnamed-local path, unchanged. On fenced and al-runner, which can name locals, a local renamed member read `no-coverage` at HEAD (measured, `r5`), and R318 fixes it like a public one.

The re-key is safe for the same reason the span is: the line map places a line in the member's span only when the line is inside the member's own node, whichever arm was compiled, and the span's name is one no other declaration carries. It needs the producer to number lines as the emitted source does, which is measured for al-runner below and measured for fenced BC in Task 9 before any status change.

### Decision 4: position, not per-build evaluation (C2)

R318 offers two closes: evaluate the build's preprocessor symbols, or use the name the source reports. r1 used names only and left `r3` build `[]` and every `r4` build false `no-coverage` on the server legs. r2 uses POSITION for every source that can give a line, and names only for the hub.

Why not evaluate the symbols per build:

- No `#if` evaluator exists in the repo. Both `artifact.ts` and `report.ts` say so in their doc comments: the AST layer does not evaluate `#if` at all. One would be new code in two places (manifest writer and line map), with `not`, `and`, `or` and parentheses.
- The session's `preprocessorSymbols` are not the whole symbol set. `alc` also reads `app.json`'s own `preprocessorSymbols`, al-runner reads a bundle's own `app.json` symbols (CLAUDE.md, R321), and AL allows `#define` and `#undef` at the top of a file. LethAL reads none of these today, so an evaluator fed only the session's list could pick the wrong arm, which is worse than no name.
- Position needs none of it and is already how the default source works.

Counts, measured or predicted per source, for the two shapes C2 names (false `no-coverage` mutants; a covered-and-killed or covered-and-survived mutant is not counted):

| shape, build | HEAD (measured, al-runner) | r1 design | r2 design | per-build evaluation |
|---|---|---|---|---|
| `r3` `[]`, one-shot | 10 | 0 | 0 | 0 |
| `r3` `[]`, server and resource | 10 each | 10 each | 0 | 0 |
| `r4` `[]` and `[R318A]`, one-shot | 8 each | 0 | 0 | 0 |
| `r4` each build, server and resource | 8 each | 4 each | 0 | 0 |
| `r3` `[]`, hub (Cronus28, Task 9) | 10 (predicted) | 10 | 10 | 0 |
| `r4` each build, hub | 8 (predicted) | 4 | 4 | 0 |

(HEAD figures: see the al-runner table in the Pre-commitment; hub figures are predictions Task 9 measures.)

So the r2 design leaves false `no-coverage` only on the hub, only where the compiled arm's name collides, plus the empty-list case (a member whose EVERY arm name is taken gets no span and no name, on every source). The hub is not the default mode. Census: 0 renamed members in fixtures and four corpora, so both remainders have 0 known sites. R318 stays OPEN for exactly these two shapes (Task 11), with the narrowed status naming them.

### Decision 5: resume (C1)

A renamed member's identity key does not move, so `carriedVerdictFor` would carry a `no-coverage` recorded before R318 (it is in `CARRYABLE_VERDICTS`). Two changes, both needed:

1. `carriedVerdictFor` returns `undefined` for a carried `no-coverage` when the mutant has `coverageArmNames`. Every carry decision routes through it (`batchCarriesEntirely`, the per-mutant carry in the batch loop, `replayCarriedBatch`), so they cannot disagree. Other verdicts still carry: a kill is a measurement whatever attributed it, and a pre-R318 `survived` on such a member came from coverage-off or object-grain scoring, which R318 does not make wrong.
2. A batch whose manifest holds any mutant with `coverageArmNames` never reuses a baseline snapshot on `--resume` (`allowReuse` at the one call site). The snapshot stores the baseline's coverage maps as the OLD line map named them (the member's lines as object-level rows), and its key hashes instrumented bytes and the test app, which R318 does not change. Without this, guard 1 re-scores the mutant against the stale coverage and gets `no-coverage` again.

Why not a version in `sessionFingerprint` (R325's pattern): it refuses every resume of every project across the upgrade, for a shape with 0 known sites, and it needs a new store column and two refusal messages to say why. It would also not reach the snapshot, which is found by hashes, not by fingerprint. Both guards cost a re-run only where a renamed member exists.

R-323 moved `IDENTITY_SCHEME` to 3, so a run recorded before R-323 already cannot be resumed (R325). The window these guards cover is a run recorded under scheme 3 before R318 lands, which exists from `b6562aba` on.

Not guarded, stated plainly: the server re-key also removes the `r3` build `[]` borrow for the `#if`-wrapped `Choose(T)` (Decision 3). A resume across the upgrade on a server leg can carry HEAD's `survived` for those two mutants. It is HEAD's own verdict, reproduced rather than introduced, and it needs a resume that spans the upgrade on that shape.

### Decision 6: what a report shows

Nothing new in the report shape (ruling 2). A public renamed member's row changes from `no-coverage` to a scored verdict with `coverageAttribution: "exact"` and `coveringTests` naming the tests that ran it. `procedureName` stays `""`, so `report.ts` still groups distinct renamed members of one file under `<object>` when they survive, and `test-order.ts` still pools their kills under the `""` procedure for killer-first ordering. Task 10 files that as a roadmap item with its cost.

Side effect on R175: at HEAD a fenced row inside a renamed member lands in no span, so its object is flagged as a naming gap (`unplaceable`). After R318 it lands in a span, so that flag goes away for such objects. 0 known sites.

### What this plan does NOT fix

- **The hub, when the compiled arm's name collides**, and **a member whose every arm name is taken**: still `no-coverage` (Decision 4). R318 stays open for them.
- **I3, the borrow in the other direction.** On the hub, in `r3` build `[]`, the `#if`-wrapped `Choose(T)` is not compiled, the renamed member is compiled as `Choose`, and the wrapped one's mutants (`procedureName` `Choose`) match the member's rows: 2 false `survived`, predicted, measured in Task 9. Pre-existing, R214's class reached by name. On al-runner's server legs R318's re-key removes this borrow for this shape (measured at HEAD: 2 false `survived`; predicted after: 2 `no-coverage`). That is a consequence of attributing the member by position; it is not an R214 fix, and the class remains wherever two declarations share a name.
- **R214's inactive-arm mutants** (`r5`'s `return-value` in `Caller`'s skipped arm, `r3`'s wrapped `Choose(T)` in build `[]`): deployed, not compiled, cannot be killed. Unchanged.
- **The al-runner cache defect** (measured below): LethAL is protected by the random artifact id in every instrumented target. Filed, not fixed (Task 10).

---

## Measured producer facts (I4, I6)

Tool: `$R/raw-producer.ts <repro> <tests> R318A <tests...>`, logs `$R/logs/raw-*.log`. It runs the UN-instrumented pair through al-runner's one-shot CLI with `--coverage` and through `--server` with `perTestCoverage`, prints every hit line with the source text of that line, and the verbatim `scope`. `--no-cache` on both legs (see the defect below).

**Line numbers (I4), `r7-lines`.** `Before` (lines 3-6), then a renamed PREAMBLE member whose FIRST arm (`#if R318A`, `Pick`) is 12 lines long and whose second arm (`#else`, `Choose`) is 3 lines, body at lines 25-29, then `After` (lines 31-34). In build `[]` the first arm is inactive; in `[R318A]` the second is.

| build | leg | `MemberOnly` | `BeforeOnly` | `AfterOnly` |
|---|---|---|---|---|
| `[]` | one-shot | 27 `K := X * 2;`, 28 `exit(K + 1);` | 5 | 33 |
| `[]` | server | 27, 28, `scope` `Choose` | 5, `Before` | 33, `After` |
| `[R318A]` | one-shot | 27, 28 | 5 | 33 |
| `[R318A]` | server | 27, 28, `scope` `Pick` | 5, `Before` | 33, `After` |

Both al-runner producers number lines as the source file does, in both builds, with an inactive arm of 12 lines or of 3 lines before the body. `r3` and `r4` agree (`raw-r3.log`, `raw-r4.log`): `r3` build `[]` reports the member's lines 11-15 with `scope` `Choose`, build `[R318A]` with `Pick`, and the wrapped `Choose(T)`'s line 21 with `Choose`; `r4` build `[]` names the first member `Beta`, build `[R318A]` names the second `Beta`. Fenced BC's `Line No.` is NOT inferred from this; Task 9 measures it.

**Quoted names (I6), `r8-quoted`** (`"Pick Me"` / `"Choose Me"`, plus `"Plain One"`):

- al-runner `--server` `scope`: `Choose Me` in `[]`, `Pick Me` in `[R318A]`, `Plain One`; no quote characters (`raw-r8-quoted.log`).
- The hub's name source, `SymbolReference.json` `Methods[].Name` as `AppMethodIndex` reads it, from an `alc` compile of the target per build (`$R/hub-names.ts`, `hub-names.log`): `Choose Me` / `Plain One` in `[]`, `Pick Me` / `Plain One` in `[R318A]`; no quote characters. Also `r1`: `Choose`/`Plain` and `Pick`/`Plain`; `r3` `[R318A]`: `Choose`, `Pick`, `Plain`; `r5`: `Caller`, `Unused` only (locals absent, as documented).
- Fenced BC and al-runner Cobertura carry no name; the name comes from our line map, which strips quotes.

So `memberKeyOf` (lowercases, does not strip quotes) meets unquoted names on every measured wire. No quote stripping is added. Task 9 confirms the hub live.

**al-runner v2.12.0 cache defect.** Running one byte-identical bundle pair under one `--define` set and then under another reuses the FIRST build: `r7-lines` compiled once with no symbols, then run with `--define R318A`, failed with AL0132 (`Pick` not found); a fresh copy with a changed comment compiled correctly under either define first and then failed under the other. `--no-cache` compiles correctly every time. `--print-cache-key` prints different keys for the two define sets on the target bundle, so the stale entry is keyed elsewhere (not isolated further). LethAL's pipeline is not exposed today because each instrumented target embeds a random artifact id, so its bytes, and the pair's key, differ per session. Task 8's pipeline runs therefore use the cache as a real session does; the raw probes use `--no-cache`.

---

## Pre-commitment (measured at HEAD `b6562aba`)

### Repros (`$R/repro/`)

Each is a target (`codeunit 50100 "Repro R"`) plus a test app (`codeunit 50150 "Repro Tests"`, `tests-<name>/`). Symbols: `R318A` (and `R318B` for `r6`).

| repro | shape |
|---|---|
| `r1-split-renamed` | `preproc_split_procedure` (shared `var`), public, `Pick` / `Choose`; plain `Plain`. Tests `PickFive`, `PickZero`, `PlainOnly`. |
| `r2-preamble-renamed` | the same body as a `preproc_split_procedure_preamble` (own `var` per arm, 3 and 5 lines). Same tests. |
| `r3-wrapped-collision` | `r1`'s member plus a `#if R318A`-wrapped plain `Choose(T: Text)`. Tests `PickFive`, `ChooseText` (calls the wrapped one under `R318A`, empty otherwise), `PlainOnly`. |
| `r4-cross-split` | two renamed members: `Alpha` / `Beta`, then `Beta` / `Gamma`. Tests `FirstMember`, `SecondMember`. |
| `r5-local-renamed` | a `local` renamed member `Pick` / `Choose`, called from public `Caller` through `#if` arms; public `Unused` no test calls. Test `CallerOne`. |
| `r6-elif-repeat` | three arms `#if R318A Pick` / `#elif R318B Choose` / `#else Pick`. Test `One`. |
| `r7-lines` (new, I4) | `Before`; a renamed PREAMBLE member, first arm 12 lines, second 3; `After`. Tests `MemberOnly`, `BeforeOnly`, `AfterOnly`. |
| `r8-quoted` (new, I6) | quoted arm names `"Pick Me"` / `"Choose Me"`; plain `"Plain One"`. Tests `MemberOnly`, `PlainOnly`. |
| `r9-named-return` (new, R-323) | a renamed member with a named return value `Result: Integer` in both arms; plain `Plain(X) Total: Integer`. Tests `PickFive`, `PickZero`, `PlainOnly`. |

Unit-only shapes (parse only, `$R/unit/`): `t1-trigger`, `t2-error`, `t3-swallowed`, `t4-quoted`, as in r1.

### Every build compiles (20 builds)

`bun $R/alc-pair.ts <repro> tests-<repro> <symbols>` compiles the UN-instrumented target, then the tests app against it, under EVERY subset of the symbol list it is given (it loops the subsets itself). `bun $R/alc-all.ts <repro> <symbols>` does the same for the INSTRUMENTED target. Logs `$R/logs/b656-alcpair-*.log`, `b656-alcall-*.log`. One PASS line per build:

| repro | builds | `alc-pair` lines `target=0 tests=0` | `alc-all` lines `exit=0 app=true` |
|---|---|---|---|
| `r1`, `r2`, `r3`, `r4`, `r5`, `r7`, `r8`, `r9` | `[]`, `[R318A]` | 2 each | 2 each |
| `r6` | `[]`, `[R318A]`, `[R318B]`, `[R318A,R318B]` | 4 | 4 |

20 builds, 40 un-instrumented compiles and 20 instrumented compiles, exit 0 each. Emitted dirs saved to `$R/emit-b656/<repro>/` (`r1` and `r3` byte-identical to r1's `emit-before`).

### Dry run and identity keys (`bun $R/members.ts <repro>`, logs `$R/logs/b656-members-*.log`)

Every mutant in a renamed member has `procedureName` `""`, no `coverageArmNames`, and line map `<unmapped>`. Key digest = `grep '^M0' <log> | sed 's/.* key=//' | sha256sum`, full value:

| repro | mutants | in renamed member(s) | key digest (sha256) |
|---|---|---|---|
| `r1` | 13 | 10 | `e162f7f823fcb6377c8c06203db7765f812ec3f5e0e718ff0943551adbb07eac` |
| `r2` | 13 | 10 | `e162f7f823fcb6377c8c06203db7765f812ec3f5e0e718ff0943551adbb07eac` |
| `r3` | 15 | 10 | `6c221c6a064720aed8aba534afd973b22819f73230e8391a7dcc5f97522ff93c` |
| `r4` | 8 | 4 + 4 | `c0bfc23d1a3faf39ca28094da533cbbabc736ed3471f21433022da134c0fe227` |
| `r5` | 10 | 4 | `14c9c85dc97624f7d1ec49e9e251bd583a6789972a57d6cc4bb84a5c8c8a0a8f` |
| `r6` | 4 | 4 | `3dd6039dfabe9016952bfc7d260230af3e1f5815cb82e3094df75630ab37f88c` |
| `r7` | 10 | 4 | `31a64d09dd88dad2bbd7706d8549a3ab09f4e7ace87801ce788c4e6c9bb3b6b0` |
| `r8` | 7 | 4 | `cb5a5078e107a0b88ce18be835b6acf78577e8856b95200ee1d200835d1657fc` |
| `r9` | 9 | 6 | `8cd57e4ece83d13b323933c44b47d457f2b1ce82a5ca59f748959579ae4edaa3` |

The six r1 digests (`r1` to `r6`, measured at `b184dd5d`) are unchanged at `b6562aba`: R-323 moved no key here.

### Predicted names after the change

Prototype `$R/names-proto.ts`, log `$R/logs/b656-names-proto.log`, already matches:

| repro / unit | member | `coverageArmNames` | line map names its lines |
|---|---|---|---|
| `r1`, `r2`, `r5`, `r6`, `r7`, `r9` | the renamed one | `["Pick","Choose"]` | `Pick` |
| `r3` | the renamed one | `["Pick"]` | `Pick` |
| `r3` | wrapped `Choose(T)` | absent | `Choose` (unchanged) |
| `r4` | first / second | `["Alpha"]` / `["Gamma"]` | `Alpha` / `Gamma` |
| `r8` | the renamed one | `["Pick Me","Choose Me"]` | `Pick Me` |
| `t1-trigger` | the renamed one | `["OnRun2"]` | |
| `t2-error` | the renamed one | `[]`, field absent | |
| `t3-swallowed` | the renamed one | `["Pick"]` | |
| `t4-quoted` | the renamed one | `["Pick","Choose Me"]` | |

`r9`'s list holds no `Result`: a named return value is not an arm name.

### Fixtures and corpora

`bun $R/renamed-census.ts <dir>` counts split members, renamed ones, and files whose tree has an ERROR or MISSING node (`errorFiles`), since a member hidden in an ERROR node is not counted as a split member. Log `$R/logs/b656-census.log`:

| corpus | `.al` files | split members | renamed | files with a parse error |
|---|---|---|---|---|
| `fixtures/` (all, `sandbox-symbols` included) | 70 | 0 | 0 | 0 |
| DC/Cloud | 1135 | 11 | 0 | 0 |
| System Application | 1718 | 0 | 0 | 0 |
| BusinessFoundation | 104 | 0 | 0 | 0 |
| BaseApp | 9620 | 11 | 0 | 0 |

No fixture or corpus manifest, emission, line map or key can change, and no frozen itest figure can move.

### al-runner, per repro, build and leg (Task 8's oracle and predictions)

HEAD columns MEASURED at `b6562aba` on al-runner v2.12.0 (`bash $R/ar-all.sh head`, logs `$R/logs/ar-head-<repro>-<leg>.log`). Counts are `killed / survived / no-coverage`, errors 0 and `baselineGreen=true` in every session. "after" is PREDICTED: the coverage-OFF column is the oracle (it runs every test, so it does not depend on attribution).

| repro | build | coverage OFF (oracle), HEAD | one-shot Cobertura, HEAD | `--server`, HEAD | resource, HEAD | every ON leg, after (predicted) |
|---|---|---|---|---|---|---|
| `r1` | `[]`, `[R318A]` | 12 / 1 / 0 | 3 / 0 / 10 | 3 / 0 / 10 | 3 / 0 / 10 | 12 / 1 / 0 |
| `r2` | `[]`, `[R318A]` | 12 / 1 / 0 | 3 / 0 / 10 | 3 / 0 / 10 | 3 / 0 / 10 | 12 / 1 / 0 |
| `r3` | `[R318A]` | 14 / 1 / 0 | 5 / 0 / 10 | 5 / 0 / 10 | 5 / 0 / 10 | 14 / 1 / 0 |
| `r3` | `[]` | 12 / 3 / 0 | 3 / 0 / 12 | 3 / 2 / 10 | 3 / 2 / 10 | 12 / 1 / 2 |
| `r4` | `[]`, `[R318A]` | 8 / 0 / 0 | 0 / 0 / 8 | 0 / 0 / 8 | 0 / 0 / 8 | 8 / 0 / 0 |
| `r5` | `[]`, `[R318A]` | 6 / 4 / 0 | 2 / 1 / 7 | 2 / 1 / 7 | 2 / 1 / 7 | 6 / 1 / 3 |
| `r6` | all four | 4 / 0 / 0 | 0 / 0 / 4 | 0 / 0 / 4 | 0 / 0 / 4 | 4 / 0 / 0 |
| `r7` | `[]`, `[R318A]` | 10 / 0 / 0 | 6 / 0 / 4 | 6 / 0 / 4 | 6 / 0 / 4 | 10 / 0 / 0 |
| `r8` | `[]`, `[R318A]` | 7 / 0 / 0 | 3 / 0 / 4 | 3 / 0 / 4 | 3 / 0 / 4 | 7 / 0 / 0 |
| `r9` | `[]`, `[R318A]` | 8 / 1 / 0 | 3 / 0 / 6 | 3 / 0 / 6 | 3 / 0 / 6 | 8 / 1 / 0 |

72 HEAD sessions. One threw: `r6` one-shot, build `[R318A]`, refused at the R123 wire-contract probe with exit 82 under the R147 pin. The coordinator filed it as R345 (two al-runner processes overlapping; `itest:alrunner` hit the same refusal at the same time). Re-run once, sequentially, with the coordinator's go: both `[]` and `[R318A]` PASS, 0 / 0 / 4 (`ar-head-r6-elif-repeat-cov-rerun.log`). Both attempts are recorded. Task 8 must run with no other al-runner process on the machine (ask the coordinator before each batch).

Two HEAD facts the hand derivation got wrong in r1 and the measurement corrects: `r5`'s LOCAL renamed member reads `no-coverage` at HEAD on every al-runner leg, not object-grain (the unnamed-local fallback needs `localsAreUnnameable`, which is true for the hub only), and `r5` HEAD is 2 / 1 / 7, not 6 / 1 / 3. So R318 changes `r5` too: its 4 member mutants go from `no-coverage` to killed, `exact`.

Per mutant after the change (every covered mutant `attr=exact`):

The after column is the same for one-shot, `--server` and resource, which is the point of Decision 3. Per mutant, after (from the OFF log's verdicts; `tests=` is the exact covering set):

- `r1`, `r2`, both builds: the member's 10 covered by exactly `PickFive,PickZero`; all killed except `conditional-boundary` (`X > 1` to `X >= 1`: no test passes 1), which survives. `Plain`'s 3 by exactly `PlainOnly`, killed (as at HEAD).
- `r3`, `[R318A]`: the member's 10 by exactly `PickFive` (9 killed, the boundary survives); the wrapped `Choose(T)`'s 2 by exactly `ChooseText`, killed; `Plain` as above.
- `r3`, `[]`: the member's 10 by exactly `PickFive` on EVERY leg (one-shot by the span, server and resource by the re-key). The wrapped `Choose(T)`'s 2 (M0011, M0012) are `no-coverage` on every leg: not compiled in this build. At HEAD the server and resource legs scored them `survived` by `PickFive` through `scope` `Choose` (the I3 borrow); after, no row carries `Choose` in this build.
- `r4`, both builds, every leg: the first member's 4 by exactly `FirstMember`, the second's 4 by exactly `SecondMember`, all killed. The negative control: `SecondMember` never covers the first member, and in `[]` the first member's `scope` is `Beta`, the name the second member carries in `[R318A]`.
- `r5`, both builds: the local member's 4 (M0004 to M0007) by exactly `CallerOne`, killed, `exact`. `Caller`'s 3 unchanged from HEAD (`empty-block` killed; the `return-value` in the compiled arm killed, the other survives, R214). `Unused`'s 3 `no-coverage`.
- `r6`, all four builds: 4 by exactly `One`, killed (`[R318B]` compiles `Choose`, the others `Pick`; both in the list).
- `r7`, both builds: `Before`'s 3 by exactly `BeforeOnly`, the member's 4 by exactly `MemberOnly`, `After`'s 3 by exactly `AfterOnly`, all killed. This is the producer-level ownership check for I4: a shifted line would show as `BeforeOnly` or `AfterOnly` in the member's `tests=`, or `MemberOnly` in theirs.
- `r8`, both builds: the member's 4 by exactly `MemberOnly`, `"Plain One"`'s 3 by exactly `PlainOnly`, all killed.
- `r9`, both builds: the member's 6 by exactly `PickFive,PickZero`, killed except `conditional-boundary` (survives); `Plain`'s 3 by exactly `PlainOnly`, killed.

Pass rule: every "after" count equals the table; every covered mutant's `tests=` equals the list above; every coverage-ON verdict equals its coverage-OFF verdict except the mutants named `no-coverage` above. Any difference is a STOP. A slip in this hand derivation (the OFF log disagrees with the table for a mutant R-318 does not touch) is reported with the OFF log and corrected in a dated addendum before the next step; a difference in a mutant R-318 touches is a defect.

---

## Files

- Modify: `packages/engine/src/ast/tree-walks.ts` (add `renamedMemberCoverageNames`), `packages/engine/src/index.ts` (export it).
- Modify: `packages/schemata/src/project.ts` (the `coverageArmNames` field and its writer).
- Modify: `packages/runner/src/line-map.ts` (`ProcedureSpan.renamed`, `spansOf`, `LineMap.renamedMemberAt`).
- Modify: `packages/runner/src/al-runner-coverage.ts` (`alRunnerCoverageFromServer`: the position re-key).
- Modify: `packages/runner/src/selection.ts` (`coverageFilter`'s member lookup).
- Modify: `packages/runner/src/resume.ts` (`carriedVerdictFor`), `packages/runner/src/orchestrator.ts` (`allowReuse` at the snapshot call site).
- Regenerate: `schemas/stream-v1.schema.json`.
- Tests: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`, `packages/runner/tests/selection.test.ts`, `packages/runner/tests/resume.test.ts`.
- Roadmap: `docs/roadmap/R318.md`, `docs/roadmap/R214.md` (a dated, measured note), two new items (Task 10), regenerated `ROADMAP.md`.

---

### Task 0: pre-commitment re-check and commit

**Files:** scratch only. Then commit THIS PLAN, unchanged, before Task 1's first edit.

- [ ] **Step 1: Confirm HEAD still matches the plan's literals.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
PLAN=/u/Git/LethAL-wt/lane-code/docs/superpowers/plans/2026-09-29-R-318-renamed-split-members.md
cd /u/Git/LethAL-wt/lane-code
test -f packages/engine/vendor/native/lethal-parser.win32-x64.node || LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts
grep -q "export const IDENTITY_SCHEME = 3;" packages/schemata/src/project.ts
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat r7-lines r8-quoted r9-named-return; do
  bun "$R/members.ts" "$r" > "$R/logs/t0-members-$r.log" 2>&1
  got=$(grep '^M0' "$R/logs/t0-members-$r.log" | sed 's/.* key=//' | sha256sum | cut -d' ' -f1)
  want=$(grep -o "^| \`${r%%-*}\` | [0-9]* | [^|]* | \`[0-9a-f]\{64\}\`" "$PLAN" | grep -o "[0-9a-f]\{64\}")
  test -n "$want" && test "$got" = "$want" || { echo "KEYS DIFFER FROM THE PLAN BEFORE CODE: $r got=$got want=$want"; exit 1; }
done
echo T0 OK
```

Expected: `T0 OK`. The `want` digest is read from THIS plan's key table, not from a scratch log. If a digest differs, STOP and re-measure before any code.

- [ ] **Step 2: Commit the plan** (the orchestrator does this for r2; skip if already committed).

---

### Task 1: `renamedMemberCoverageNames` (engine)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts` (directly after `procedureLikeNameNode`)
- Modify: `packages/engine/src/index.ts` (the `./ast/tree-walks` export list)
- Test: `packages/engine/tests/ast/tree-walks.test.ts`

**Interfaces:**
- Produces: `export function renamedMemberCoverageNames(member: ALSyntaxNode): string[]`, exported from `@lethal/engine`. `[]` for anything but a renamed split member with a usable name.

- [ ] **Step 1: Write the failing tests.** Add `renamedMemberCoverageNames` to the file's `../../src` import list, then append:

```ts
describe("R318: renamedMemberCoverageNames", () => {
  beforeAll(async () => {
    await initParser();
  });

  /** Every procedure-like node of `src`, in source order, with its coverage names. */
  const namesOf = (src: string): string[][] => {
    const out: string[][] = [];
    visit(wrapRoot(parseAL(src)), (n) => {
      if (isProcedureLike(n)) out.push(renamedMemberCoverageNames(n));
    });
    return out;
  };
  const obj = (body: string, id = 50100): string => `codeunit ${id} "Repro R${id}"\n{\n${body}\n}\n`;
  const split = (a: string, b: string, param = "X: Integer"): string =>
    `#if R318A\n    procedure ${a}(${param}): Integer\n#else\n    procedure ${b}(${param}): Integer\n#endif\n    begin\n        exit(1);\n    end;\n`;
  const plain = (name: string, param = "T: Text"): string =>
    `    procedure ${name}(${param}): Integer\n    begin\n        exit(2);\n    end;\n`;

  it("a plain procedure and an agreeing split member have none", () => {
    expect(namesOf(obj(plain("Solo") + split("Same", "same")))).toEqual([[], []]);
  });

  it("a renamed member lists each arm's name once, in source order, first spelling kept", () => {
    expect(namesOf(obj(split("Pick", "Choose")))).toEqual([["Pick", "Choose"]]);
    const three =
      "#if R318A\n    procedure Pick(X: Integer): Integer\n#elif R318B\n    procedure Choose(X: Integer): Integer\n#else\n    procedure PICK(X: Integer): Integer\n#endif\n    begin\n        exit(1);\n    end;\n";
    expect(namesOf(obj(three))).toEqual([["Pick", "Choose"]]);
  });

  it("quotes are stripped", () => {
    expect(namesOf(obj(split('"Pick"', '"Choose Me"')))).toEqual([["Pick", "Choose Me"]]);
  });

  it("a named return value is not an arm name (R323)", () => {
    const named =
      "#if R318A\n    procedure Pick(X: Integer) Result: Integer\n#else\n    procedure Choose(X: Integer) Result: Integer\n#endif\n    begin\n        Result := X;\n    end;\n";
    expect(namesOf(obj(named))).toEqual([["Pick", "Choose"]]);
  });

  it("a name a plain overload also uses is dropped, compared case-insensitively", () => {
    expect(namesOf(obj(split("Pick", "Choose") + plain("CHOOSE")))).toEqual([["Pick"], []]);
  });

  it("a name a #if-wrapped procedure uses is dropped", () => {
    const wrapped = `#if R318A\n${plain("Choose")}#endif\n`;
    expect(namesOf(obj(split("Pick", "Choose") + wrapped))).toEqual([["Pick"], []]);
  });

  it("two renamed members that share a name across builds each drop it", () => {
    expect(namesOf(obj(split("Alpha", "Beta") + split("Beta", "Gamma")))).toEqual([
      ["Alpha"],
      ["Gamma"],
    ]);
  });

  it("a member whose every arm name is taken gets none", () => {
    expect(namesOf(obj(split("Alpha", "Beta") + split("Beta", "Alpha")))).toEqual([[], []]);
  });

  it("a member swallowed by the global var section still sees a later overload (R327)", () => {
    const src = obj(`    var\n        Glob: Integer;\n\n${split("Pick", "Choose")}\n${plain("Choose")}`);
    expect(namesOf(src)).toEqual([["Pick"], []]);
  });

  it("a trigger's name is taken", () => {
    const src = obj(`    trigger OnRun()\n    begin\n    end;\n\n${split("OnRun2", "OnRun")}`);
    expect(namesOf(src)).toEqual([["OnRun2"]]);
  });

  it("an object that did not parse cleanly gives no names", () => {
    const src = obj(`${split("Pick", "Choose")}\n    procedure Broken(\n    begin\n    end;\n`);
    expect(namesOf(src)[0]).toEqual([]);
  });

  it("the rule is per object: another object in the same file does not collide", () => {
    const src = obj(split("Pick", "Choose")) + obj(plain("Choose"), 50101);
    expect(namesOf(src)).toEqual([["Pick", "Choose"], []]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/engine/tests/ast/tree-walks.test.ts -t R318`. Expected: FAIL, `renamedMemberCoverageNames` is not exported.

- [ ] **Step 3: Implement.** In `tree-walks.ts`, directly after `procedureLikeNameNode`:

```ts
/**
 * R318: the names coverage may attribute a RENAMED split member under (one whose `#if` arms give it
 * different names, so `procedureLikeNameNode` is `null`). Each arm's name once, quotes stripped,
 * compared as AL compares names (case-insensitive), first spelling kept, in source order, MINUS any
 * name another declaration of the same object uses: every arm of every other procedure-like
 * (`allProcedureLikes`, so `#if`-wrapped and swallowed ones count) and every trigger.
 *
 * Why that is safe: one arm is compiled per build, so the member carries exactly one of its names,
 * and coverage names the compiled member. A name no other declaration of the object carries, in any
 * arm, can only be this member in any build, so a coverage row under it is this member's row. A
 * shared name (an overload included, since name-keyed coverage cannot split overloads) is dropped.
 * An object that did not parse gets `[]`: a declaration inside an ERROR node could carry the name.
 * `[]` for anything that is not a renamed split member.
 */
export function renamedMemberCoverageNames(member: ALSyntaxNode): string[] {
  if (member.kind === ALNodeKind.procedure || procedureLikeNameNode(member) !== null) return [];
  let object: ALSyntaxNode | null = member;
  while (object !== null && !(object.parent !== null && isObjectContainer(object.parent))) {
    object = object.parent;
  }
  if (object === null || object.hasError) return [];
  const unquote = (t: string): string => t.replace(/^"|"$/g, "");
  const key = (t: string): string => unquote(t).toLowerCase();
  const armNames = (n: ALSyntaxNode): string[] =>
    n.children.filter((c) => c.fieldName === "name").map((c) => c.text);
  const taken = new Set<string>();
  for (const p of allProcedureLikes(object)) {
    if (p.startIndex === member.startIndex && p.endIndex === member.endIndex) continue;
    for (const t of armNames(p)) taken.add(key(t));
  }
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (c.kind === ALNodeKind.trigger) {
        const name = c.childForFieldName("name");
        if (name !== null) taken.add(key(name.text));
      } else if (!isProcedureLike(c)) {
        walk(c);
      }
    }
  };
  walk(object);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of armNames(member)) {
    const k = key(t);
    if (k === "" || seen.has(k) || taken.has(k)) continue;
    seen.add(k);
    out.push(unquote(t));
  }
  return out;
}
```

`allProcedureLikes` and `isObjectContainer` are defined later in the same file; function declarations are hoisted. In `packages/engine/src/index.ts`, add `renamedMemberCoverageNames,` after `procedureLikeNameNode,`.

- [ ] **Step 4: Run, expect PASS.** `bun test packages/engine/tests/ast/tree-walks.test.ts`. Expected: every test passes, the twelve R318 tests included.

- [ ] **Step 5: Red-checks.** Each: revert ONE piece, run `bun test packages/engine/tests/ast/tree-walks.test.ts -t R318`, record the red test, restore, record green.
  - Delete the `allProcedureLikes` loop: red on "plain overload", "#if-wrapped", "two renamed members", "every arm name is taken", "swallowed".
  - Delete the trigger `walk(object)` call: red on "a trigger's name is taken".
  - Delete `|| object.hasError`: red on "did not parse cleanly".
  - Collect arm names by `c.fieldName !== "parameters"` instead of `=== "name"` (a looser filter): red on "a named return value is not an arm name".
  - Remove the `seen` check: red on the three-arm case.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/engine/tests/ast/tree-walks.test.ts
git add packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/engine/tests/ast/tree-walks.test.ts
git commit -m "R-318: renamedMemberCoverageNames, a renamed split member's arm names that no other declaration of its object carries"
```

---

### Task 2: the manifest field `coverageArmNames`

**Files:**
- Modify: `packages/schemata/src/project.ts` (`MutantManifestEntry` after `procedureScope`; a helper beside `procedureNameOf`; the row literal in `writeInstrumentedProject`)
- Regenerate: `schemas/stream-v1.schema.json`
- Test: `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- Consumes: `renamedMemberCoverageNames` (Task 1).
- Produces: `MutantManifestEntry.coverageArmNames?: readonly string[]`, set only when non-empty.

- [ ] **Step 1: Write the failing tests.** Append to `preproc-instrumentation.test.ts`:

```ts
/** R318 repros, hand-written. `R318_R1`: a public renamed split member (lines 3-16) and `Plain`.
 *  `R318_R4`: two renamed members that share `Beta` across builds (lines 3-13 and 15-25). */
const R318_R1 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
const R318_R4 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Alpha(X: Integer): Integer
#else
    procedure Beta(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K);
    end;

#if R318A
    procedure Beta(X: Integer): Integer
#else
    procedure Gamma(X: Integer): Integer
#endif
    var
        L: Integer;
    begin
        L := X + 2;
        exit(L);
    end;
}
`;
const R318_R3 = R318_R1.replace(
  "    procedure Plain(",
  "#if R318A\n    procedure Choose(T: Text): Integer\n    begin\n        exit(StrLen(T) + 1);\n    end;\n#endif\n\n    procedure Plain(",
);

describe("R318: a renamed split member carries its coverage names, and no identity key moves", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("r1: the renamed member's mutants list both arm names; Plain's carry none", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R1 });
    const inMember = manifest.mutants.filter((m) => m.startLine >= 3 && m.startLine <= 16);
    expect(inMember).toHaveLength(10);
    for (const m of inMember) {
      expect(m.procedureName).toBe("");
      expect(m.coverageArmNames).toEqual(["Pick", "Choose"]);
    }
    for (const m of manifest.mutants.filter((x) => x.startLine > 16)) {
      expect(m.procedureName).toBe("Plain");
      expect(m.coverageArmNames).toBeUndefined();
    }
  });

  test("r4: each member keeps only the name the other never uses", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const got = manifest.mutants
      .sort((a, b) => a.startIndex - b.startIndex)
      .map((m) => `L${m.startLine} ${(m.coverageArmNames ?? []).join("/")}`);
    expect(got).toEqual([
      "L10 Alpha",
      "L11 Alpha",
      "L11 Alpha",
      "L12 Alpha",
      "L22 Gamma",
      "L23 Gamma",
      "L23 Gamma",
      "L24 Gamma",
    ]);
  });

  // The pre-commitment: exactly HEAD b6562aba's keys (identical to b184dd5d's), measured by the
  // R-318 plan's dry run. The renamed members stay in the "" group, so r4's second return-value
  // keeps ordinal 1.
  test("identity keys are HEAD's, byte for byte", async () => {
    const keysOf = async (src: string): Promise<string[]> => {
      const { manifest } = await instrument({ "Repro.Codeunit.al": src });
      return [...manifest.mutants]
        .sort((a, b) => a.startIndex - b.startIndex || a.mutantId.localeCompare(b.mutantId))
        .map((m) => serializeKey(identityKeyOf(m)));
    };
    expect(await keysOf(R318_R1)).toEqual([
      "1bdfa00ed4f9f5b66393ce5fa68726410673f75c945f991bd88595fd5bcc3bef|Repro R||lethal.empty-block|1",
      "8c55bdb8637a08951045fee707015dc789f78464ec2849c92df3f575da6ac6df|Repro R||lethal.remove-assignment|1",
      "bfde8a9e5399719cb19619ee057c24eedd9306fcf2d76c657c6b4a4378b24f00|Repro R||lethal.shift-integer|1",
      "42f3c401fde31149e055dfec5842326f020390b03c7018fe168a642644df6a58|Repro R||lethal.conditional-boundary|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "2f655ef42c7141d41be438ef0a09db0588720672f6a87a7d107927722cfa2e29|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Repro R||lethal.return-value|1",
      "78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89|Repro R||lethal.swap-additive|1",
      "d1f83cdca147307b5525047ab73ef3b96e89e7d274d898a8a0c3975ef32aa9ca|Repro R|Plain|lethal.empty-block|1",
      "cf8233fb4c95eb8f641cac7ecd90d8bfc2f40fd8ec1a247b4cc9bbbc601c6528|Repro R|Plain|lethal.return-value|1",
      "1c7f31c8ee6e40da96b0888e7c02e8a3484f8cf46ecf000ca6650d3453cfa251|Repro R|Plain|lethal.swap-additive|1",
    ]);
    expect(await keysOf(R318_R4)).toEqual([
      "13926bb4e72d79aead21ac9263d2735b6aacd45904fbe9b058371f9115262cb2|Repro R||lethal.empty-block|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1",
      "d25d06cde1e1a4a5557adb12f3773916f28b8e80b8c21b4a9f8a158463163c1e|Repro R||lethal.empty-block|1",
      "37276285a29d8c4a38baf6d602a495db9e97d227b9b18c9b00901b65b1d5e2ab|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1|1",
    ]);
  });
});
```

Also extend R301's existing test `"a renamed arm names neither arm: the writer cannot tell which one is compiled"`: inside its loop, after `expect(m.procedureName).toBe("");`, add `expect(m.coverageArmNames).toEqual(["AIf", "AElse"]);`. Its title stays true.

The keys test's sort order (`startIndex`, then `mutantId`) is the order the dry-run log lists them (`startLine`, then `mutantId`); they agree on both repros. If the first run shows only a reordering, compare as sets and say so in the commit; any differing KEY is a STOP.

- [ ] **Step 2: Run, expect FAIL.** `rm -rf packages/*/dist`, then `bun test packages/runner/tests/preproc-instrumentation.test.ts -t "R318|renamed arm"`: the two field tests and the R301 assertion fail (`undefined`); the keys test PASSES already, on purpose (it pins that the change does not move a key; Step 5 red-checks it).

- [ ] **Step 3: Implement.** In `packages/schemata/src/project.ts`, add `renamedMemberCoverageNames` to the `@lethal/engine` import. In `MutantManifestEntry`, directly after `procedureScope`:

```ts
  /**
   * R318: the names coverage may attribute this mutant under, set ONLY when its member is a
   * split-header procedure whose `#if` arms RENAME it (`procedureName` is then `""`): each arm's
   * name once, minus any name another declaration of the same object uses
   * (`renamedMemberCoverageNames`, engine). One arm is compiled per build and coverage names that
   * build's member, so a row under one of these names is this member's row in whichever build ran.
   * The line map spans the member under the FIRST name. `procedureName` stays `""` on purpose, so
   * identity keys do not move. Absent everywhere else and on manifests written before R318, which
   * read as before: no member hit, so a public renamed member is `no-coverage`.
   */
  readonly coverageArmNames?: readonly string[];
```

Beside `procedureNameOf`:

```ts
/** R318: see `MutantManifestEntry.coverageArmNames`. `[]` outside a renamed split member. */
function coverageArmNamesOf(spec: MutationSpec): string[] {
  const proc = enclosingProcedureLike(spec.before);
  return proc === null ? [] : renamedMemberCoverageNames(proc);
}
```

In `writeInstrumentedProject`'s loop, next to `const procedureScope = procedureScopeOf(spec, f.source);`, add `const coverageArmNames = coverageArmNamesOf(spec);`, and in the row literal directly after the `procedureScope` spread:

```ts
        ...(coverageArmNames.length > 0 ? { coverageArmNames } : {}),
```

Regenerate: `bun scripts/generate-schemas.ts`, then `bun scripts/generate-schemas.ts --check` exits 0. Expected diff: `coverageArmNames` (array of string) added as an optional property wherever `stream-v1.schema.json` describes a mutant entry (the same places as `procedureScope`), nothing else.

- [ ] **Step 4: Run, expect PASS.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/schemas.test.ts`.

- [ ] **Step 5: Red-checks.**
  - Delete the `coverageArmNames` spread: the two field tests and the R301 assertion go red. Restore.
  - Key pin: make `procedureNameOf` return `coverageArmNamesOf(spec)[0] ?? ""` for a member with no agreed name (the rejected Decision 1): the keys test goes red (`Pick` / `Alpha` in the procedure part, `r4`'s `|1|1` becomes `|1`). Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/schemata/src/project.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/schemata/src/project.ts schemas/stream-v1.schema.json packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "R-318: the manifest carries a renamed split member's coverage names (coverageArmNames); procedureName and every identity key unchanged"
```

---

### Task 3: the line map spans a renamed member under its first coverage name

**Files:**
- Modify: `packages/runner/src/line-map.ts` (`ProcedureSpan`, `spansOf`, a new `LineMap.renamedMemberAt`, the import list)
- Test: `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- Consumes: `renamedMemberCoverageNames` (Task 1). The span's name must equal `coverageArmNames[0]` (Task 2).
- Produces: `LineMap.lookup` returns that name for a renamed member's lines (fenced bcdev and al-runner Cobertura). `LineMap.renamedMemberAt(objectType, objectId, lineNo): string | undefined` returns it only when the containing span is a renamed member's (Task 4 consumes it).

- [ ] **Step 1: Write the failing tests, and flip R316's pin.** Append to the R318 describe from Task 2:

```ts
  test("both line maps, from the EMITTED target, name a renamed member by its first coverage name", async () => {
    // Line-based sources place a line by position, so this holds in EVERY build, a dropped name
    // included. The boundaries are the `#if R318A` / `procedure Plain(` lines of the emitted text.
    const cases: [string, string, string[]][] = [
      ["r1", R318_R1, ["Pick", "Plain"]],
      ["r3", R318_R3, ["Pick", "Choose", "Plain"]],
      ["r4", R318_R4, ["Alpha", "Gamma"]],
    ];
    for (const [label, src, owners] of cases) {
      const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": src });
      const text = emitted.get("Repro.Codeunit.al") ?? "";
      const dir = await mkdtemp(join(tmpdir(), "lethal-r318-"));
      try {
        await writeFile(join(dir, "Repro.Codeunit.al"), text);
        const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
        const alr = await buildAlRunnerCoverageIndex(dir);
        expect(alr.refusedFiles).toEqual([]);
        const out = text.split("\n");
        const starts = out.flatMap((l, k) =>
          l.startsWith("#if R318A") || l.startsWith("    procedure Plain(") ? [k + 1] : [],
        );
        expect([label, starts.length]).toEqual([label, owners.length]);
        const ends = [...starts.slice(1), out.length + 1];
        let checked = 0;
        for (const [i, who] of owners.entries()) {
          const renamed = who !== "Choose" && who !== "Plain";
          for (let n = starts[i] ?? 0; n < (ends[i] ?? 0); n++) {
            if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
            expect([label, n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            expect([label, n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            expect([label, n, alr.lineMap.renamedMemberAt("Codeunit", 50100, n)]).toEqual([
              label,
              n,
              renamed ? who : undefined,
            ]);
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(owners.length);
        for (const m of manifest.mutants) {
          const first = m.coverageArmNames?.[0];
          if (first !== undefined) expect(owners).toContain(first);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
```

In R316's test `"both line maps, built from the EMITTED target, name every dispatch line of a named split member and none of a renamed one"`: rename it to `"... name every dispatch line of a split member, a renamed one by its first coverage name (R318)"`, and replace both `x.name || undefined` with `x === renamed ? "Pick2" : x.name`. `Pick2` is that fixture's renamed member's `#if` arm name, and no other declaration there uses it or `Choose`.

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/preproc-instrumentation.test.ts -t "line maps"`: the new test fails on the first renamed line (`undefined`, want `Pick`), or on `renamedMemberAt` not existing; the flipped R316 test fails the same way.

- [ ] **Step 3: Implement.** In `line-map.ts`, add `renamedMemberCoverageNames` to the `@lethal/engine` import. In `ProcedureSpan`:

```ts
  /** R318: a split member whose `#if` arms rename it, spanned under its first coverage name. */
  readonly renamed?: true;
```

In `spansOf`, replace the comment and body of the `isProcedureLike` branch:

```ts
    // R301, R316: a split-header procedure, either shape, is one procedure (one shared body). Its
    // span starts at the `#if` line, which holds no code, so no covered line can land there.
    // R318: an arm that renames the procedure is spanned under its first coverage name, one no
    // other declaration of the object uses (`renamedMemberCoverageNames`), which the manifest
    // lists first in `coverageArmNames`. A line belongs to the member whichever arm was compiled,
    // so this holds in every build. No such name: no span, as before R318.
    if (isProcedureLike(n)) {
      const nameNode = procedureLikeNameNode(n);
      const name =
        nameNode === null ? (renamedMemberCoverageNames(n)[0] ?? null) : stripQuotes(nameNode.text);
      if (name !== null && name !== "") {
        // Measured: BC's rows span a procedure CONTIGUOUSLY from its declaration line through its
        // closing `end;`, so the node's own line extent is exactly the right range.
        procedures.push({ ...span(n, name), ...(nameNode === null ? { renamed: true as const } : {}) });
      }
      return; // do not descend: a nested construct belongs to this procedure, not its own span
    }
```

In `LineMap`, after `lookup`:

```ts
  /**
   * R318: the coverage name of the RENAMED split member whose span holds `lineNo`, else
   * `undefined`. For a source that names procedures itself (al-runner `--server`'s `st.scope`):
   * it reports the COMPILED arm's name, which the collision rule may have dropped and which, in
   * another build, can be another declaration's name. Re-keying such a statement by POSITION to
   * this name is what makes the server legs agree with the line-based ones in every build.
   */
  renamedMemberAt(objectType: string, objectId: number, lineNo: number): string | undefined {
    const key = keyOf(objectType, objectId);
    if (this.refused.has(key) || lineNo <= 0) return undefined;
    return this.byObject
      .get(key)
      ?.procedures.find((p) => p.renamed === true && lineNo >= p.firstLine && lineNo <= p.lastLine)
      ?.name;
  }
```

- [ ] **Step 4: Run, expect PASS.** `bun test packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/line-map.test.ts packages/runner/tests/al-runner-coverage.test.ts`.

- [ ] **Step 5: Red-checks.** Put back `const name = nameNode === null ? null : stripQuotes(nameNode.text);`: both line-map tests go red. Restore. Replace `[0]` with `.at(-1)`: the new test goes red on `r1` (`Choose`, want `Pick`). Restore. Drop the `renamed` spread: the `renamedMemberAt` assertions go red. Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/line-map.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/runner/src/line-map.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "R-318: the line map spans a renamed split member under its first coverage name and can say a line is inside one"
```

---

### Task 4: al-runner `--server` re-keys a renamed member's statements by position

**Files:**
- Modify: `packages/runner/src/al-runner-coverage.ts` (`alRunnerCoverageFromServer`)
- Test: `packages/runner/tests/preproc-instrumentation.test.ts` (it has `instrument` and `R318_R3`)

**Interfaces:**
- Consumes: `LineMap.renamedMemberAt` (Task 3).
- Produces: a server `CoverageEntry` whose `line` lies in a renamed member's span carries that span's name as `procedure`; every other entry is unchanged.

- [ ] **Step 1: Write the failing test.** Add `alRunnerCoverageFromServer` to the file's `../src/al-runner-coverage` import, then append to the R318 describe:

```ts
  test("--server: a renamed member's statements are re-keyed by position; others keep st.scope", async () => {
    // Scopes as MEASURED on al-runner 2.12.0 (R-318 plan, raw-r3 and raw-r8 logs): the compiled
    // arm's name, unquoted. In r3's build [] the member is compiled as `Choose`, a name its list
    // dropped because the #if-wrapped Choose(T) also carries it.
    const { emitted } = await instrument({ "Repro.Codeunit.al": R318_R3 });
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const dir = await mkdtemp(join(tmpdir(), "lethal-r318-srv-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), text);
      const index = await buildAlRunnerCoverageIndex(dir);
      const lines = text.split("\n");
      const at = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
      const member = at("Glob := Glob + 2;");
      const wrapped = at("exit(StrLen(T) + 1)");
      const plain = at("exit(X + 3)");
      expect([member, wrapped, plain].every((n) => n > 0)).toBe(true);
      const map = alRunnerCoverageFromServer(
        {
          test: "Codeunit50150.PickFive",
          coverage: [
            {
              file: "Repro.Codeunit.al",
              statements: [
                { scope: "Choose", line: member, hits: 1 },
                { scope: "Choose", line: wrapped, hits: 1 },
                { scope: "Plain", line: plain, hits: 1 },
                { scope: "Choose Me", hits: 1 },
              ],
            },
          ],
        },
        index,
      );
      expect(map.entries.map((e) => `${e.procedure ?? "-"}@${e.line ?? "-"}`)).toEqual([
        `Pick@${member}`,
        `Choose@${wrapped}`,
        `Plain@${plain}`,
        "Choose Me@-",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/preproc-instrumentation.test.ts -t "re-keyed by position"`: the first entry is `Choose@<member>`, want `Pick@<member>`.

- [ ] **Step 3: Implement.** In `alRunnerCoverageFromServer`, replace `const procedure = st.scope;` with:

```ts
      // R318: a statement inside a renamed split member takes the member's coverage name, by
      // POSITION, instead of `st.scope`. The server names the COMPILED arm, which the collision
      // rule may have dropped (`r3`, build `[]`: `Choose`) and which in another build can be
      // another declaration's name (`r4`: `Beta`). The line map places the line in the member's
      // own span whichever arm was compiled, which is what the one-shot Cobertura leg does, so
      // the two legs agree in every build. Every other statement keeps `st.scope` exactly.
      const renamed =
        st.line === undefined
          ? undefined
          : index.lineMap.renamedMemberAt(object.objectType, object.objectId, st.line);
      const procedure = renamed ?? st.scope;
```

Update the function's doc comment: after "here the producer answers directly", add one sentence: "Except inside a renamed split member (R318), where the producer's answer is the compiled arm's name and the line map's is the name the manifest looks up."

- [ ] **Step 4: Run, expect PASS.** `bun test packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/al-runner-coverage.test.ts`.

- [ ] **Step 5: Red-check.** Put back `const procedure = st.scope;`: the new test goes red on the first entry. Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/al-runner-coverage.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/runner/src/al-runner-coverage.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "R-318: al-runner --server re-keys a renamed split member's statements by position, so every build matches the one-shot leg"
```

---

### Task 5: `coverageFilter` looks a renamed member up under every coverage name

**Files:**
- Modify: `packages/runner/src/selection.ts` (the member-level lookup in `coverageFilter`)
- Test: `packages/runner/tests/selection.test.ts`

**Interfaces:**
- Consumes: `MutantManifestEntry.coverageArmNames` (Task 2).
- Produces: no new export. A renamed member's mutant is covered with attribution `exact` when any of its names has member-level coverage.

- [ ] **Step 1: Write the failing tests.** Append to `selection.test.ts` (it defines `entry`, `t1`, `t2`):

```ts
describe("R318: a renamed split member is attributed under its coverage names", () => {
  const covNaming = (procedure: string) => ({
    granularity: "procedure" as const,
    entries: [{ objectType: "Codeunit", objectId: 70000, procedure }],
  });
  const renamed = (arms: readonly string[] = ["Pick", "Choose"]) =>
    entry({ procedureName: "", procedureScope: "public", coverageArmNames: arms });

  test("either arm's name covers it, in any case, with exact attribution", () => {
    for (const compiled of ["Pick", "CHOOSE"]) {
      const index = buildCoverageIndex([
        { ref: t1, coverage: covNaming(compiled) },
        { ref: t2, coverage: covNaming("Plain") },
      ]);
      const split = coverageFilter([renamed()], index, [t1, t2], undefined, false);
      expect([compiled, split.covered.get("M0001")]).toEqual([compiled, [t1]]);
      expect(split.attribution.get("M0001")).toBe("exact");
    }
  });

  test("a quoted member's names match the unquoted names every producer sends (measured)", () => {
    // al-runner --server `scope` and SymbolReference `Methods[].Name` both send `Choose Me`,
    // measured on 2.12.0 and alc 18.0 (R-318 plan, raw-r8 and hub-names logs).
    const index = buildCoverageIndex([{ ref: t1, coverage: covNaming("Choose Me") }]);
    const split = coverageFilter([renamed(["Pick Me", "Choose Me"])], index, [t1, t2], undefined, false);
    expect(split.covered.get("M0001")).toEqual([t1]);
  });

  test("a name outside its list does not cover it (the negative control)", () => {
    const index = buildCoverageIndex([{ ref: t1, coverage: covNaming("Take") }]);
    const m = renamed();
    const split = coverageFilter([m], index, [t1, t2], undefined, false);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("without the field (a manifest from before R318) it reads as before: uncovered", () => {
    const index = buildCoverageIndex([{ ref: t1, coverage: covNaming("Pick") }]);
    const m = entry({ procedureName: "", procedureScope: "public" });
    const split = coverageFilter([m], index, [t1, t2], undefined, false);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/selection.test.ts -t R318`: the first two fail (`undefined`, want `[t1]`); the other two pass already (they pin what must NOT change; Step 5 red-checks them).

- [ ] **Step 3: Implement.** In `coverageFilter`, replace

```ts
    // Member-level first: precise, and correct for every ordinary procedure.
    let testKeys = index.byMember.get(
      memberKeyOf(m.objectType, m.codeunitId, m.procedureName, context),
    );
```

with

```ts
    // Member-level first: precise, and correct for every ordinary procedure. R318: a split member
    // whose `#if` arms rename it has `procedureName` "" and lists its coverage names instead; one
    // arm is compiled per build and no other declaration of the object carries any of them
    // (`MutantManifestEntry.coverageArmNames`), so the union is that build's member only. Without
    // the field, the "" key below is today's lookup exactly.
    const memberNames = m.procedureName !== "" ? [m.procedureName] : (m.coverageArmNames ?? [""]);
    let testKeys: ReadonlySet<string> | undefined;
    for (const name of memberNames) {
      const hit = index.byMember.get(memberKeyOf(m.objectType, m.codeunitId, name, context));
      if (hit === undefined) continue;
      testKeys = testKeys === undefined ? hit : new Set([...testKeys, ...hit]);
    }
```

If `tsc` rejects a later assignment to `testKeys` because the `byObject` maps' value type differs, widen the declared type to that union; no cast.

- [ ] **Step 4: Run, expect PASS.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test packages/runner/tests/selection.test.ts`.

- [ ] **Step 5: Red-checks.**
  - Put the old single lookup back: the first two R318 tests go red. Restore.
  - Replace `(m.coverageArmNames ?? [""])` with `(m.coverageArmNames ?? ["Pick"])`: the "without the field" test goes red. Restore.
  - Replace the `memberKeyOf` lookup with `index.byObject.get(objectKeyOf(m.objectType, m.codeunitId, context))`: the negative control goes red. Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/selection.ts packages/runner/tests/selection.test.ts
git add packages/runner/src/selection.ts packages/runner/tests/selection.test.ts
git commit -m "R-318: coverageFilter attributes a renamed split member under its coverage names (exact), never under a name outside the list"
```

---

### Task 6: resume never keeps a pre-R318 `no-coverage` on a renamed member (C1)

**Files:**
- Modify: `packages/runner/src/resume.ts` (`carriedVerdictFor`)
- Modify: `packages/runner/src/orchestrator.ts` (the `snapshot` argument of `scoreBatch`, `allowReuse`)
- Test: `packages/runner/tests/resume.test.ts`

**Interfaces:**
- Consumes: `MutantManifestEntry.coverageArmNames` (Task 2).
- Produces: `carriedVerdictFor` returns `undefined` for a `no-coverage` row on a mutant with `coverageArmNames`; a batch holding such a mutant never reuses a baseline snapshot.

- [ ] **Step 1: Write the failing tests.** Append to `resume.test.ts`, with `carriedVerdictFor` and `buildResumeIndex` imported from `../src/resume` if they are not already:

```ts
/** R318: a target whose public split member is renamed by its `#if` arms, and one test. */
const R318_TARGET = `codeunit 79000 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
const R318_TESTS = `codeunit 79100 "Repro Tests"
{
    Subtype = Test;

    [Test]
    procedure PickFive()
    begin
    end;
}
`;

/**
 * R318: a backend whose BASELINE coverage names the renamed member the way a pre-R318 line map
 * did (`pre`: an object-level row, no procedure, which is what an unmapped line becomes) or the way
 * R318's does (`post`: `Pick`). Every mutant run fails (a kill) and attests on the
 * `coverage: "none"` runs, as CountingBackend does (without it the attestation gate discards every
 * verdict). `abortAfter` strands the run the way CountingBackend's does, so it stays resumable.
 */
class R318Backend implements ExecutionBackend {
  baselineRuns = 0;
  mutantRuns = 0;
  private activations: Array<string | null> = [];
  constructor(
    private readonly naming: "pre" | "post",
    private readonly abortAfter?: number,
  ) {}
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const attest =
      opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {};
    if (active === null) {
      this.baselineRuns += 1;
      const member =
        this.naming === "pre"
          ? { objectType: "Codeunit", objectId: 79000 }
          : { objectType: "Codeunit", objectId: 79000, procedure: "Pick" };
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure" as const,
          entries: [member, { objectType: "Codeunit", objectId: 79000, procedure: "Plain" }],
        },
      };
    }
    this.mutantRuns += 1;
    if (this.abortAfter !== undefined && this.mutantRuns > this.abortAfter) {
      return {
        ref,
        ...attest,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
    return { ref, ...attest, outcome: "fail", durationMs: 5, failureMessage: "killed" };
  }
}

describe("R318: a resume across R318 re-scores a renamed member instead of keeping no-coverage", () => {
  test("carriedVerdictFor: a no-coverage row does not carry onto a mutant with coverageArmNames", () => {
    const index = buildResumeIndex(
      [row({ astHash: "h-r", procedureName: "", verdict: "no-coverage" })],
      false,
    );
    const base = { ...manifestEntry("h-r"), procedureName: "" };
    expect(carriedVerdictFor(index, { ...base, coverageArmNames: ["Pick", "Choose"] })).toBeUndefined();
    // Controls: the same row onto an entry without the field still carries, and a kill on a
    // renamed member still carries (a kill is a measurement whatever attributed it).
    expect(carriedVerdictFor(index, base)?.verdict).toBe("no-coverage");
    const killed = buildResumeIndex(
      [row({ astHash: "h-k", procedureName: "", verdict: "killed" })],
      false,
    );
    expect(
      carriedVerdictFor(killed, {
        ...manifestEntry("h-k"),
        procedureName: "",
        coverageArmNames: ["Pick"],
      })?.verdict,
    ).toBe("killed");
  });

  test("runSession: the member is scored exact against a FRESH baseline, not carried or snapshot-reused", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r318-resume-"));
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, "Repro.Codeunit.al"), R318_TARGET);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "ReproTests.Codeunit.al"), R318_TESTS);
    const store = new ResultsStore(":memory:");

    // Run 1 sees the member as a pre-R318 line map did: its 10 mutants read no-coverage, Plain's
    // first two are killed and its third strands, so the run stays resumable. Its completed
    // baseline is recorded as a snapshot. MEASURED at HEAD b6562aba (R-318 plan scratch): with
    // abortAfter 2, run 2 replays the WHOLE batch from the store (batchCarriesEntirely), the 10
    // member mutants carried as no-coverage, 0 baseline runs, 0 mutant runs. So this one shape
    // exercises both guards: guard 1 stops the replay, and guard 2 then stops the snapshot reuse.
    const first = new R318Backend("pre", 2);
    const firstReport = await runSession({ backend: first, store, ...dirs, selectorIds });
    expect(firstReport.quarantined).toBeDefined();
    const inMember = (r: typeof firstReport) =>
      r.mutants.filter((m) => m.line >= 3 && m.line <= 16);
    expect(inMember(firstReport).map((m) => m.verdict)).toEqual(Array(10).fill("no-coverage"));

    const second = new R318Backend("post");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(report.resumedFrom?.runId).toBeGreaterThan(0);
    // Guard 2: the snapshot recorded by run 1 was NOT reused; this session ran its own baseline.
    expect(second.baselineRuns).toBeGreaterThan(0);
    // Guard 1 and 2 together: every member mutant was scored now, exact, never carried.
    const member = inMember(report);
    expect(member).toHaveLength(10);
    for (const m of member) {
      expect([m.line, m.verdict]).toEqual([m.line, "killed"]);
      expect(m.coverageAttribution).toBe("exact");
      expect(m.carried).not.toBe(true);
    }
  });
});
```

If `row(...)`'s defaults (`codeunitName`, `operatorName`) do not produce a key equal to `manifestEntry(...)`'s with `procedureName: ""`, align them in the test the way the existing `manifestEntry` doc comment says ("the same codeunit, procedure and operator"); do not change product code to make a key match.

Add `RunOpts` to the file's `../src/backend` type import if it is not already there (it is, for CountingBackend).

- [ ] **Step 2: Run, expect FAIL.** `rm -rf packages/*/dist`, `bun test packages/runner/tests/resume.test.ts -t R318`: the unit test fails on the first `toBeUndefined` (the row carries); the runSession test fails on `baselineRuns` (0: the batch was replayed whole) and on the member verdicts (`no-coverage`, carried). This was measured at HEAD with a scratch copy of the test (`$R/unit-proto/r318-resume.test.ts`).

- [ ] **Step 3: Implement.** In `resume.ts`, replace `carriedVerdictFor`'s body:

```ts
export function carriedVerdictFor(
  index: ResumeIndex,
  m: MutantManifestEntry,
): CarriedVerdict | undefined {
  const carried = index.carryable.get(serializeKey(identityKeyOf(m)));
  // R318: a renamed split member's key did not move when R318 gave it coverage, so a
  // `no-coverage` recorded before R318 (when nothing could attribute coverage to it) would carry.
  // Re-scoring it costs one execution; carrying it keeps a verdict that was never a measurement.
  if (carried?.verdict === "no-coverage" && m.coverageArmNames !== undefined) return undefined;
  return carried;
}
```

Update its doc comment with one sentence naming the R318 exception. In `orchestrator.ts`, at the `scoreBatch` call, replace `snapshot: { batchDir, testDir: cfg.testDir, allowReuse: resumeState !== undefined },` with:

```ts
        snapshot: {
          batchDir,
          testDir: cfg.testDir,
          // R318: a snapshot stores the baseline's coverage as the line map of ITS day named it,
          // and before R318 a renamed split member's lines had no name. Its key (instrumented
          // bytes, test app) cannot tell, so a batch holding such a member never reuses one: the
          // baseline runs again. 0 known sites; the cost is that one baseline.
          allowReuse:
            resumeState !== undefined &&
            !manifest.mutants.some((m) => m.coverageArmNames !== undefined),
        },
```

- [ ] **Step 4: Run, expect PASS.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test packages/runner/tests/resume.test.ts packages/runner/tests/orchestrator.test.ts`. Every pre-existing R192 test stays green (no fixture there has a renamed member).

- [ ] **Step 5: Red-checks.** Each separately:
  - Remove the `if (carried?.verdict === "no-coverage" ...)` line: the unit test goes red, AND the runSession test goes red (the 10 carry `no-coverage`). Restore.
  - Put back `allowReuse: resumeState !== undefined`: the runSession test goes red on `baselineRuns` (0) and on the member verdicts (`no-coverage` from the reused `pre` coverage), with the carry guard in place. Restore. This is the proof that the carry guard alone is not enough.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/resume.ts packages/runner/src/orchestrator.ts packages/runner/tests/resume.test.ts
git add packages/runner/src/resume.ts packages/runner/src/orchestrator.ts packages/runner/tests/resume.test.ts
git commit -m "R-318: --resume re-scores a renamed split member's no-coverage and never reuses a baseline snapshot for its batch"
```

---

### Task 7: offline verification (keys, emission, every build, fixtures, corpora, full suite)

**Files:** scratch only.

- [ ] **Step 1: The dry run after the change, keys against the plan's literals.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
PLAN=/u/Git/LethAL-wt/lane-code/docs/superpowers/plans/2026-09-29-R-318-renamed-split-members.md
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat r7-lines r8-quoted r9-named-return; do
  bun "$R/members.ts" "$r" > "$R/logs/after-members-$r.log" 2>&1
  got=$(grep '^M0' "$R/logs/after-members-$r.log" | sed 's/.* key=//' | sha256sum | cut -d' ' -f1)
  row=$(grep "^| \`${r%%-*}\` | [0-9]* | [^|]* | \`[0-9a-f]\{64\}\`" "$PLAN")
  want=$(echo "$row" | grep -o "[0-9a-f]\{64\}")
  n=$(echo "$row" | cut -d'|' -f3 | tr -d ' ')
  test "$got" = "$want" || { echo "KEY MOVED: $r got=$got want=$want"; exit 1; }
  test "$(grep -c '^M0' "$R/logs/after-members-$r.log")" = "$n" || { echo "COUNT MOVED: $r"; exit 1; }
done
grep -h "^M0" "$R"/logs/after-members-*.log | sed -E 's/.* arms=([^ ]*) lm=([^ ]*) .*/\1 \2/' | sort | uniq -c | awk '{print $1, $2, $3}' | sort > "$R/logs/after-tally.txt"
sort > "$R/logs/want-tally.txt" <<'EOF'
3 - After
3 - Before
3 - Caller
2 - Choose
12 - Plain
3 - Plain_One
3 - Unused
4 Alpha Alpha
4 Gamma Gamma
10 Pick Pick
38 Pick/Choose Pick
4 Pick_Me/Choose_Me Pick_Me
EOF
diff "$R/logs/want-tally.txt" "$R/logs/after-tally.txt"
echo T7S1 OK
```

Expected: no `KEY MOVED`, no `COUNT MOVED` (89 mutants), no tally diff, then `T7S1 OK`. `members.ts` prints `arms=` and `lm=` with spaces as `_`. The line map reads the ORIGINAL source here, so `lm` for a renamed member is its first name. (`Pick/Choose`: 10 in `r1`, 10 in `r2`, 4 in `r5`, 4 in `r6`, 4 in `r7`, 6 in `r9`. `- Plain` 12: 3 each in `r1`, `r2`, `r3`, `r9`.) Any tally difference is a STOP: compare against the names table, find the cause, do not adjust the expectation.

- [ ] **Step 2: Emission unchanged, manifests changed only by the new field, every build compiles.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
cd "$R/repro"
builds=0
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat r7-lines r8-quoted r9-named-return; do
  syms=R318A; want=2; test "$r" = r6-elif-repeat && { syms=R318A,R318B; want=4; }
  bun "$R/alc-all.ts" "$r" "$syms" > "$R/logs/after-alc-$r.log" 2>&1 || true
  got=$(grep -c " exit=0 app=true" "$R/logs/after-alc-$r.log" || true)
  test "$got" = "$want" || { echo "ALC: $r passed $got of $want builds"; exit 1; }
  builds=$((builds + got))
  for f in "$R/emit-b656/$r"/*.al; do cmp "$f" "$R/emit-$r/$(basename "$f")"; done
  bun "$R/manifest-diff.ts" "$R/emit-b656/$r/mutant-manifest.json" "$R/emit-$r/mutant-manifest.json"
done
test "$builds" = 20 || { echo "BUILDS: $builds, want 20"; exit 1; }
echo T7S2 OK
```

Expected: 20 builds counted one PASS line each, every `cmp` silent, each `manifest-diff` lists exactly the renamed members' mutants with the arms from the names table and then `MANIFEST EQUAL apart from coverageArmNames`, then `T7S2 OK`.

- [ ] **Step 3: Fixtures and corpora, parse errors included.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
for d in U:/Git/LethAL-wt/lane-code/fixtures "U:/Git/DC/Cloud" "U:/Git/BC.History/System Application" "U:/Git/BC.History/BusinessFoundation" "U:/Git/BC.History/BaseApp"; do
  bun "$R/renamed-census.ts" "$d" | tail -1
done > "$R/logs/after-census.log"
diff "$R/logs/b656-census.log" "$R/logs/after-census.log"
if grep -v " renamed=0 errorFiles=0$" "$R/logs/after-census.log"; then echo "RENAMED MEMBER OR PARSE ERROR"; exit 1; fi
```

Expected: no diff against the plan-time log (five rows, the fixtures row included), every row `renamed=0 errorFiles=0`. With no renamed member and no parse error, `renamedMemberCoverageNames` returns `[]` everywhere, so no fixture or corpus manifest, emission, line map or key changes.

- [ ] **Step 4: Full suite in CLAUDE.md order.**

```bash
cd /u/Git/LethAL-wt/lane-code
bun run typecheck
rm -rf packages/*/dist
bun test
bun scripts/generate-schemas.ts --check
bunx biome check packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/schemata/src/project.ts packages/runner/src/line-map.ts packages/runner/src/al-runner-coverage.ts packages/runner/src/selection.ts packages/runner/src/resume.ts packages/runner/src/orchestrator.ts packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/selection.test.ts packages/runner/tests/resume.test.ts
```

Expected: typecheck clean, every test green (report the pass count), schemas fresh, biome clean. `bun run compile:fixtures` is not needed: no `.al` under `fixtures/` changed.

---

### Task 8: al-runner two-build probe, producer level (runs in this task; R318 does not change status before it)

**Files:** scratch only. `$R/alrunner-probe.ts` (each mutant line prints `attr=` and `tests=`), `$R/ar-all.sh <tag>` (all nine repros, four legs each, serially), `$R/raw-producer.ts`.

- [ ] **Step 1: Record the build.** `bash $R/ar-all.sh after` writes `$R/logs/ar-after-version.log` first. It must read `al-runner v2.12.0`. A different build: STOP and re-measure the HEAD columns on it before comparing.

- [ ] **Step 2: Run.** Before starting, write `AR-BATCH START ar-all after, est 75 minutes` to `$R/r2-status.txt`, send the same line to the coordinator, and wait for its go: two al-runner processes overlapping trip the R123 probe (exit 82, R345). The same rule holds for Steps 4 and 5, each its own batch. Then `bash $R/ar-all.sh after` (about two hours, foreground or `run_in_background`, never two at once). Logs `$R/logs/ar-after-<repro>-<leg>.log`. Every session must print `baselineGreen=true` and `errors=0`. A `THREW` or a red baseline is a STOP; do not re-run it into a pass.

- [ ] **Step 3: Compare with the pre-commitment.** Counts per the al-runner table, per-mutant verdicts and `tests=` per the per-mutant list, `attr=exact` on every covered renamed-member mutant. Write the comparison to `$R/logs/ar-after-compare.log`, one line per mutant per leg per build.

- [ ] **Step 4: Raw producer re-check (I4, I6).** `bun $R/raw-producer.ts r7-lines tests-r7-lines R318A MemberOnly,BeforeOnly,AfterOnly` and the same for `r8-quoted` (`MemberOnly,PlainOnly`). Expected: exactly the lines and scopes in "Measured producer facts". A differing line number is a STOP: the position re-key and the line map both depend on it.

- [ ] **Step 5: Producer-level red-check.** Revert Task 4's re-key (put back `const procedure = st.scope;`), run only the `r3` and `r4` server legs (`COV=1 SERVER=1 bun $R/alrunner-probe.ts r3-wrapped-collision tests-r3-wrapped-collision R318A`, same for `r4-cross-split`), and confirm the HEAD-like shortfall: `r3` build `[]` reads 10 member mutants `no-coverage`, `r4` reads 4 per build. Restore, re-run the same two, confirm the after counts. This is the red-check that fails on wrong TEST attribution at the producer, not on a map label.

---

### Task 9: fenced BC and hub on Cronus28 (REQUIRED, live, under `coord lease Cronus28`)

**Files:** scratch only, `$R/fenced/`. One gate at a time; hold the lease for the whole task and release it at the end.

Why: fenced is the default source, and its line numbers come from BC's `Code Coverage` table, not from al-runner. R300 records that how a compiled arm is numbered is unmeasured there. The hub is the one source R318 still leaves name-based.

- [ ] **Step 1: Lease and preflight.** `coord lease Cronus28`. `docker context use desktop-windows`. Confirm the control app on Cronus28 is 1.0.0.19 or later (`.claude/skills/control-app`). List Cronus28's published apps and their id ranges; if any overlaps 50100-50199, copy the repros to `$R/fenced/<repro>` and renumber (target 5xx00 to a free range, tests likewise) and record the mapping. Company `CRONUS Danmark A/S`.

- [ ] **Step 2: Configs.** For each repro used below, `$R/fenced/<repro>/lethal.config.json` holding the `bcdev` block of `fixtures/sandbox-app/lethal.config.local.json` (Cronus28), plus `"preprocessorSymbols"` for the build and `bcdev.coverageMode` `"fenced"`, `"procedure"` (hub) or `"none"` (the oracle). Never print or commit a credential from that file.

- [ ] **Step 3: Per build, publish the TEST app yourself.** LethAL publishes the target; the test app is the user's workflow, and these test apps have `#if` arms. For each build: `alc` the un-instrumented target with the build's symbols into the tests project's `.alpackages`, compile the tests app with the same symbols, and `altool publishapp` it. Follow the unpublish order in CLAUDE.md (tests app first) when switching builds, and the downgrade note (LethAL mints its own target version).

- [ ] **Step 4: Run.** `LETHAL_FENCED_COVERAGE_DUMP=$R/fenced/<repro>-<build>-<mode>.ndjson bun packages/runner/src/cli.ts run --project <repro dir> --tests <tests dir> --backend bcdev --config <cfg> --out $R/fenced/<repro>-<build>-<mode>.json --db $R/fenced/lethal.sqlite`. Repros and modes:

| repro | builds | modes |
|---|---|---|
| `r7-lines` (I4) | `[]`, `[R318A]` | fenced, none |
| `r3-wrapped-collision` | `[]`, `[R318A]` | fenced, procedure, none |
| `r4-cross-split` | `[]`, `[R318A]` | fenced, procedure, none |
| `r8-quoted` (I6) | `[]`, `[R318A]` | fenced, procedure |

18 sessions. Each must have a green baseline; a red baseline or an `error` verdict is a STOP.

- [ ] **Step 5: Compare with these predictions (pre-committed).**
  - **Raw fenced rows, `r7-lines`.** In each build, every row `MemberOnly` produces for codeunit 50100 has a `lineNo` inside the member's EMITTED span (the `#if R318A` line through its `end;`), and none inside `Before`'s or `After`'s; `BeforeOnly`'s rows lie only in `Before`'s span and `AfterOnly`'s only in `After`'s. Per mutant (fenced): the member's 4 covered by exactly `MemberOnly`, `Before`'s 3 by `BeforeOnly`, `After`'s 3 by `AfterOnly`, all killed, `attr=exact`; equal to mode `none`'s verdicts. 10 / 0 / 0 per build.
  - **`r3`, fenced:** `[R318A]` 14 / 1 / 0; `[]` 12 / 1 / 2 (the wrapped `Choose(T)` `no-coverage`). **Hub:** `[R318A]` 14 / 1 / 0; `[]` 3 / 2 / 10 (the member's 10 `no-coverage`, because the hub names it `Choose`, which its list dropped; the wrapped `Choose(T)`'s 2 covered by `PickFive` and `survived`, the I3 borrow). **None:** `[R318A]` 14 / 1 / 0; `[]` 12 / 3 / 0.
  - **`r4`, fenced:** 8 / 0 / 0 per build, first member by `FirstMember` only, second by `SecondMember` only. **Hub:** 4 / 0 / 4 per build (`[R318A]`: the second member, compiled `Beta`, `no-coverage`; `[]`: the first, compiled `Beta`, `no-coverage`). **None:** 8 / 0 / 0.
  - **`r8`, fenced and hub:** the member's 4 covered by exactly `MemberOnly` in both builds (the hub names it `Pick Me` / `Choose Me`, unquoted, both in its list), `"Plain One"`'s 3 by `PlainOnly`; 7 / 0 / 0.
  - At HEAD these same sessions would give the member's mutants `no-coverage` on fenced and hub; a HEAD run is not required, since mode `none` is the oracle.

  A difference in a raw row's line, or in any renamed-member mutant's verdict or covering tests on fenced, is a STOP and blocks Task 11: the default path would then be wrong in a way al-runner cannot show. A hub difference is recorded against the narrowed claim.

- [ ] **Step 6: Release the lease.** Unpublish the scratch test apps and targets (tests first), then release `coord lease Cronus28`.

---

### Task 10: file two roadmap items

**Files:** `docs/roadmap/R<nnn>.md` twice, regenerated `ROADMAP.md`.

- [ ] **Step 1: Re-check the next free id IMMEDIATELY before writing.** Across every worktree and every branch:

```bash
cd /u/Git/LethAL-wt/lane-code
for w in $(git worktree list | awk '{print $1}'); do ls "$w/docs/roadmap" 2>/dev/null; done | grep -o "^R[0-9]*" | sort -V | uniq | tail -1
git log --all --name-only --format= -- docs/roadmap | grep -o "R[0-9]\{3\}" | sort -V | uniq | tail -1
```

Take the next id above the larger of the two. At the r2 draft both said `R341`; two hours later both said `R346` (the coordinator had filed R345 meanwhile). Ids move fast here: re-run it immediately before writing each file.

- [ ] **Step 2: The report item.** Title: "A renamed split member reports and orders under the empty procedure name". Body, plain English: after R318 its mutants are attributed `exact`, but `procedureName` stays `""` so identity keys do not move. So `report.ts` groups distinct renamed members of one file under `<object>` when they survive, `lethal explain` cannot name the member, and `test-order.ts`'s killer-first order pools kills of distinct renamed members in one `""` bucket (order only, never a verdict). The fix is a report field carrying the arm names (they are already in the manifest and the event stream). Cost: a `SessionReport` field ripples through `events.ts`, `report-fold.ts`, `report.ts`, `generate-schemas.ts`, `schemas.test.ts`, the `report-equality` snapshot, and every committed sample report regenerated LIVE (CLAUDE.md). Size: 0 known sites (R318's census). Status `open, filed <date>`.

- [ ] **Step 3: The al-runner cache item.** Title: "al-runner 2.12.0 reuses a build compiled under other --define symbols for an identical bundle pair". Body: the measurement in this plan's "Measured producer facts". LethAL is protected because every instrumented target embeds a random artifact id; a tool or probe that runs one unchanged pair under two symbol sets is not, and needs `--no-cache`. Not a LethAL defect; worth reporting upstream (open question to the orchestrator). Status `open, filed <date>`.

- [ ] **Step 4: Regenerate and check.** `bun scripts/roadmap-index.ts`, `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`. Commit both items together.

---

### Task 11: R318 status and the R214 note (after Tasks 8 and 9)

**Files:** `docs/roadmap/R318.md`, `docs/roadmap/R214.md`, `ROADMAP.md` (generated).

- [ ] **Step 1: R318, narrowed, still open.** Only after Task 8 and Task 9 both passed. Set `status` to `open, NARROWED <date>: fenced bcdev and every al-runner leg attribute a renamed split member in every build (<first>..<last>); the hub (coverageMode procedure) when the compiled arm's name is taken, and a member whose every arm name is taken, still read no-coverage`. Append a dated record: the design (Decisions 1 to 5, one short paragraph each), the collision rule and the position re-key and why neither can borrow, "IDENTITY_SCHEME unchanged at 3, no key moved" with the Task 7 evidence, the resume guards, the 20-build `alc` and emission evidence, the census, the red-checks, Task 8's and Task 9's measured tables, and the two remaining shapes with their measured hub counts. Also correct R318's own text that an all-local renamed member takes the object-grain path: measured (`r5`), that holds only on the hub; on fenced and al-runner it read `no-coverage`, and R318 fixes it. No `file:line` citations.

- [ ] **Step 2: R214 note, measured only.** Append a dated paragraph stating only what Tasks 8 and 9 measured: on `r3` build `[]`, the `#if`-wrapped `Choose(T)` is not compiled; at HEAD al-runner's server and resource legs attributed its 2 mutants to `PickFive` through the compiled renamed member's `scope` `Choose`, scored `survived` (measured count); after R318 those legs read them `no-coverage` because the renamed member's statements are keyed by position; the hub still attributes them by name (Task 9's measured count). Say plainly that R318's change is not an R214 fix: the class remains wherever two declarations share a name.

- [ ] **Step 3: Regenerate and check.**

```bash
cd /u/Git/LethAL-wt/lane-code
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts
git add docs/roadmap/R318.md docs/roadmap/R214.md ROADMAP.md
git commit -m "roadmap(R318): narrowed, renamed split members attributed on fenced and every al-runner leg in every build; hub remainder open. R214: measured name-path note"
```

---

## Self-review notes

- Spec coverage: a truthful name in every build for the default and every al-runner leg (Decisions 2 to 4, Tasks 1 to 5); the hub remainder is named and left open, not claimed. Identity keys: Task 2's literals, Task 0 and Task 7 against this plan's digests. No wrong-type class: no semantic change, byte-identical emission, 20 builds compile. Two-build test: Tasks 8 and 9, with the first arm inactive and unequal arm lengths (`r7`).
- R318's two options: evaluating symbols is rejected with reasons (Decision 4); the reported-name option is used for the hub only, and position replaces it wherever a line exists.
- The coverage-differential skill's rule (coverage ON versus the `none` oracle, per mutant) is the pass rule of Tasks 8 and 9.
- C1 needs BOTH guards; Task 6's second red-check is the evidence.

## Open questions

1. The al-runner cache defect (Task 10): report it upstream as well as filing it here? The runner's author reads this repo, so the roadmap item may be enough.
