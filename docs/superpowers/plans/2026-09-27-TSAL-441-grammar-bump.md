# TSAL-441: vendored tree-sitter-al 4.3.0 -> 4.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r2 (2026-09-27).** Revised per gpt-6-sol review r1 (`H:/lethal-coord/reviews/TSAL-441-plan/review-r1.md`) and the orchestrator's rulings on the r1 open questions. What changed: the released wasm asset is vendored (a local build is only compared); the Task 6 empty-grammar-argument bug is fixed; the fixture check now covers #27's bare values and value-start names through a full tree diff; the fixture comparison uses the full `selection.ts` identity key; attribution is by commit bisection or enclosing construct; hand-written #24/#25 red/green controls are added; intermediate grammars are built only where attribution needs them; the landing gates are `itest:bcdev`, `itest:chunked` and `itest:alrunner` only; there is no `itest:tables` RUN 1 route; roadmap closures come after the landing gates; the directive-guard item is filed; and R283 closes as superseded.

**Revision r3 (2026-09-27), final.** Revised per review r2 (`H:/lethal-coord/reviews/TSAL-441-plan/review-r2.md`) and the orchestrator's rulings C, I1, I2 and I3. One variable, `BC281`, holds the selected BC 28.1 source path or is empty, and every optional use is guarded (C). The BC 28.1 search and fingerprint move BEFORE the spec commit, so P4 is stated for the recorded build; a build other than upstream's snapshot is labelled exploratory, not a gate (I2). The fixture tree check compares positioned nodes with their ancestry, and parse health (ERROR, and MISSING through the parser's `isMissing` flag) is checked separately (I1). The #27 bare-value control is its own test on `Image = Filter` / `ExternalAccess = Modify` and must fail under 4.3.0 on that assertion; the #24 follow-up asserts the expected continuation shape (I3).

**Goal:** Replace the vendored `packages/engine/vendor/tree-sitter-al.wasm` (4.3.0, `f7af22a`) with the released v4.4.1 asset (`7819df5`). Prove offline, then live, that every moved mutation site and every moved identity was predicted and traces to a named upstream change. Re-run the GH-06 cross-check to show which filed clusters are gone. Then move R283, R284, R288, R216 and R214 to match.

**Architecture:** No product code is expected to change. The work is a measured swap. The predictions are pre-committed first. The site set and the full mutant identity set are measured under 4.3.0 and 4.4.1. Intermediate grammars are built only to attribute a delta that the end-to-end diff shows. Then the cross-check runs, then the three landing gates, and only then the roadmap closures. The procedure is the 4.0.1 -> 4.3.0 bump's (`packages/engine/vendor/README.md` section "The 4.0.1 -> 4.3.0 bump (2026-09-09)", commits `a4435b2`, `9961c45`, `7b1e344`, `e1f1212`). The pre-commitment spec follows the GH-06 style (`docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md`), which the 4.3.0 bump did not have.

**Tech Stack:** Bun + TypeScript, `web-tree-sitter`, `gh` (release download), tree-sitter CLI 0.27.0 (`C:/Users/SShadowS/.cargo/bin/tree-sitter`, used for comparison and attribution builds only), the grammar checkout at `U:/Git/tree-sitter-al`, `alc` 18.x (the cross-check's compiler side), and the BC container Cronus28.

**Spec:** Task 1 writes it: `docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md`. Upstream facts come from `gh release view v4.4.1 -R SShadowS/tree-sitter-al`, `gh api repos/SShadowS/tree-sitter-al/compare/v4.3.0...v4.4.1` and the commit bodies in `U:/Git/tree-sitter-al`.

## What upstream changed (read once, every later task refers to it)

`v4.3.0..v4.4.1` is twelve commits. Only these change parse trees:

| step | commits, in order | issue | what moves | upstream's own corpus claim |
| --- | --- | --- | --- | --- |
| A: 4.3.0 -> v4.4.0 (`70f4239`) | `0791253` (#24, operator dangling before `#if`), `bc72141` (#25, `begin` opened in a branch that also contributes statements), `028cbdd` (#25, a block's `end` among later-branch statements, report braces split across branches, a `case` whose `end;` is inside each branch), `e0ab7a4` (#24 follow-up, any binary operator may open a `#if` continuation; previously `or` there parsed as a CALL named `or` with no ERROR) | #24, #25 | directive code only. New named kinds: `preproc_operand_prefix`, `preproc_split_case_end_branch`, `preproc_split_case_statement_end`, `preproc_split_report_brace_close`, `preproc_split_report_dataitem_header`, `preproc_split_report_dataitem_open_over_endif` | BC.History 15,358 trees byte-identical after each commit; BC 28.1 Base Application (8,073 files) 5 -> 0 files with ERROR |
| B: v4.4.0 -> `209d038` | `42d0848`, `0c4b5c4` (perf, trees byte-identical), `209d038` | #28 and #26, ONE commit | `asserterror_statement.body` is now `_statement_inner`: `asserterror X := 1` gives `assignment_statement` (was `assignment_expression`), `asserterror if/exit/case/repeat ...` attach as the body (were siblings), `asserterror Arr[1].M()` is one call (was `asserterror Arr` plus a `list_literal`-receiver call) | BC.History 44 files, 87 assignment bodies + 36 indexed receivers, 0 errors |
| C: `209d038` -> v4.4.1 (`7819df5`) | `551829e` | #27 | six value-start heads stop offering `keyword_as_identifier`, so a contextual keyword at the start of a property value lexes as a name: `Visible = Type = Type::Alpha;` is a `comparison_expression`; BARE values such as `ApplicationArea = All;`, `ExternalAccess = Modify;`, `Image = Filter;` move from `table_relation_value` to `identifier`; `Order` and `Table` are accepted as names at value start and in expressions | BC.History 185 files, one class: 812 bare values |

Issue attribution inside a step: step B is one commit that fixes two issues. Where it matters, a row is assigned to #26 or #28 by its construct (an indexed receiver after `asserterror` is #26; any other `asserterror` body is #28), not by commit.

`src/node-types.json`: no named kind removed; six added (step A); 33 kinds' child lists changed. Every value in LethAL's curated `ALNodeKind` (`packages/engine/src/ast/node-kinds.ts`) still exists.

**The v4.4.1 artifact.** The release publishes `tree-sitter-al.wasm`. At plan time the tag's checked-in wasm is 11,496,302 bytes, `sha256:cd6e347e8bf4171c4bd4302543bdb543451be307a34fd0c7f95ca56a085ed099`. The released asset is what gets vendored, and its SHA-256 is verified against this value. The stamp `tree-sitter-al.wasm.inputs.sha256` at the tag names `src/parser.c` `0b687fa1...` and `src/scanner.c` `346052d7...`.

## Why no fixture figure is expected to move, and what would refute it

The mutated fixture targets are `fixtures/sandbox-app/src` (`itest:bcdev`, `itest:alrunner`), `sandbox-data/src` (`itest:tables`, `itest:chunked`), `sandbox-hang/src`, `sandbox-harden/src` and `sandbox-coverage-probe/src`. `grep -n "asserterror\|#if\|#else\|#endif"` over them finds only comments, so steps A and B cannot touch them.

Step C DOES touch them. Almost every page, table and field in them carries bare property values (`ApplicationArea = All;`, `DataClassification = ...;`), and each of those subtrees changes from `table_relation_value` to `identifier`. So "no fixture tree changes" is false, and the plan does not predict it. What it predicts is narrower: every changed subtree lies inside a property value; no operator's `targets()` claims a node there before or after; and no mutated subtree contains a property, so no `astSubtreeHash` moves. Task 3 measures each part: a per-file tree diff, the per-site census, and the full identity-key listing.

## Global Constraints

- Plain English, short sentences, no em dashes (owner rule), in every file this plan writes.
- Vendor the RELEASED v4.4.1 `tree-sitter-al.wasm` asset, after verifying its SHA-256. A local build is made only to compare. Record any difference in the README. A difference never fails the bump.
- Only `packages/engine/vendor/tree-sitter-al.wasm` is vendored. There is no vendored scanner or parser source.
- The pre-commitment spec is committed ALONE, before any 4.4.1 census, tree diff, cross-check or live run is read. Nothing above its `## OUTCOME` line changes after a run. A prediction that fails is answered by an `## AMENDMENT` section, committed alone, before the next measurement that depends on it.
- Build/test loop, in this order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root.
- Gate on per-site and per-mutant equality, never on totals. A differing verdict is a BLOCK, never "close enough".
- Never re-record a baseline to make a gate pass. A re-record goes to the owner.
- Live gates run on Cronus28 only under a coord lease (owner authorization 2026-09-25), in the foreground, never polled.
- Landing gates for this bump (ruling Q1): `itest:bcdev`, `itest:chunked`, `itest:alrunner`. `itest:tables` is NOT run by this lane; it is verified in the combined check after the GH-24 re-record and R-236c.
- Roadmap closures (R283, R284, R288) and status moves (R216, R214) happen only after the three landing gates pass.
- Corpus identity is the fingerprint (`bun scripts/corpus-fingerprint.ts <dir>`), not the path (R187). `do-rel2/Cloud` must print `9a8e8831449208cc...` over 417 files (R013). If a fingerprint differs from the spec's table, stop: that corpus moved and the comparison against run 002 is void.
- No source text from `do-rel2`, `DC`, BC Base Application or any other non-public corpus goes into a committed file. File names, procedure names and counts are fine.
- `ROADMAP.md` is generated: edit `docs/roadmap/R<nnn>.md`, then run `bun scripts/roadmap-index.ts`. Re-check the next free id with `ls docs/roadmap/` immediately before filing.
- Commit with explicit paths (`git commit -- <paths>`), because other sessions commit here concurrently. Every edited file goes into the commit of the task that edited it.
- This lane does NOT commit unless the orchestrator says so. The commit commands below are what the lane runs when told to.

## Review Focus

1. **Identity drift with identical sites.** 4.0.0 kept every site and moved 32 hashes. Task 3 diffs the full identity key (`selection.ts`: `astHash`, object, enclosing member, operator, operator major, source-order ordinal), not the count and not the hash alone.
2. **Instrument noise read as a grammar change (R218).** Task 3 runs the 4.3.0 census twice on one corpus and requires zero difference before any A/B is read.
3. **The wrong artifact vendored.** Task 2 verifies the release asset's SHA-256 against the tag's checked-in wasm and records the local build's hash beside it.
4. **"Cluster gone" that is really an empty pipe.** Task 6 runs the 4.3.0 wasm over the same repro files through the same harness and requires the defect to still show there. Task 5's shape controls are red under 4.3.0 and green under 4.4.1.
5. **A step-level delta blamed on the wrong fix.** Task 3 attributes a moved row by single-commit bisection inside a step, or by its enclosing construct, never by "it is inside a `#if`" alone: #25's block and case fixes move rows AFTER `#endif` too.

---

## Sequencing with GH-24 and R-236c (ruling Q1)

State at plan time: `packages/runner/itest/tables.itest.ts` `EXPECTED.totalMutantSites` is 397, while GH-24's committed arm (`Data Reach Ops`) makes `sandbox-data` generate 407 raw specs (301 / 68 / 18; `docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md` section 5). The owner has not re-recorded yet. R-236c (`docs/superpowers/plans/2026-09-27-R-236c-testpage-pre-refusal.md`) will change the one-expected-baseline-failure assertion into "exactly one named TestPage refusal, not run".

This lane:

1. Lands the bump on `itest:bcdev`, `itest:chunked` and `itest:alrunner` (Task 7).
2. Does NOT run `itest:tables` in any form, including GH-24's RUN 1 protocol.
3. Writes into the spec a predicted-unchanged statement for `sandbox-data`: under 4.4.1 its raw spec list, deployed list and every identity key equal the 4.3.0 ones, so the bump adds nothing to GH-24's figures. That statement is proved offline in Task 3 and verified live by the combined `itest:tables` check that runs after the GH-24 re-record and R-236c. That check owes this bump: 0 differences attributable to the grammar.

If Task 3 finds `sandbox-data` CHANGED, the predicted-unchanged statement is false. Then the lane stops before Task 7, writes an AMENDMENT with the stacked figures (GH-24's plus this bump's delta), and hands the orchestrator a separate owner re-record to follow GH-24's. Two causes are never folded into one baseline recording. `itest:chunked` (`--only src/DataMain.Table.al`) is in the landing set, so a change to `DataMain.Table.al` would also block it until amended.

---

### Task 1: Pre-commitment spec, committed alone before any 4.4.1 measurement

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md`

**Interfaces:**
- Produces: the `BC281` variable and its recorded identity (Step 1), predictions P1 to P8, which Tasks 3 to 7 check, and an `## OUTCOME` section they fill.

- [ ] **Step 1: Find and fingerprint a BC 28.1 Base Application copy BEFORE writing the spec (rulings Q3, I2, C).** This reads source files and hashes them. It parses nothing, so it measures no grammar and does not spoil the pre-commitment. Search these places, in this order, and record each result (found / not found / version):

```bash
S=<session scratchpad>; cd /u/Git/LethAL
BC281=""   # the ONE variable: the selected source directory, or empty
# 1. BcContainerHelper artifact cache (28.1 sandbox artifacts exist at plan time)
ls /c/bcartifacts.cache/sandbox/ | grep '^28\.1\.'
find /c/bcartifacts.cache/sandbox/28.1.* \( -iname "*Base Application*.Source.zip" -o -iname "Microsoft_Base Application_28.1*.app" \) 2>/dev/null
# 2. al-runner and package caches
find /c/Users/SShadowS/.cache/al-runner /c/Users/SShadowS/.cache/pkg -iname "*Base Application*28.1*" 2>/dev/null | head
# 3. source trees under U:/Git (DO.Support* carry a BC/BaseApp tree; read its app.json version)
for d in /u/Git/DO.Support*/BC/BaseApp; do echo "$d"; find "$d" -maxdepth 3 -name app.json | xargs grep -h '"version"'; done
# 4. anywhere else under U:/Git, by a file upstream named
find /u/Git -maxdepth 9 -iname "FinanceChargeMemo.Report.al" -not -path "*/BC.History/*" 2>/dev/null
```

Selection rules:
- A source DIRECTORY whose Base Application `app.json` version is 28.1.x: set `BC281` to that directory, used directly, not copied.
- A source ZIP, or an `.app` that carries `.al` files: extract it into `$S/bc281` and set `BC281="$S/bc281"`.
- Prefer upstream's exact build, `28.1.49838.50268`; otherwise the newest 28.1.x found.
- Nothing found: leave `BC281` empty. Do NOT call the fingerprint script. Record "BC 28.1 Base Application: not measured, not found on this machine (searched: <the four places>)".

When `BC281` is set, record its path, its `app.json` version, and its fingerprint:

```bash
if [ -n "$BC281" ]; then bun scripts/corpus-fingerprint.ts "$BC281"; fi
```

Its label: **gate** if the version is `28.1.49838.50268`, else **exploratory** (a different build need not have upstream's five unhealthy files, so upstream's counts cannot gate it). Keep `BC281` for every later task, because shell state does not persist between calls:

```bash
printf 'BC281=%q\n' "$BC281" > "$S/bc281.env"   # every later use starts with: source "$S/bc281.env"
```

- [ ] **Step 2: Confirm nothing 4.4.1-shaped has been measured yet.** The scratchpad holds no `census-*`, `tree-*`, `ids-*` or `gh06r3-*` output. If one exists, the spec cannot pre-commit it; say so in the spec and do not use that output.

- [ ] **Step 3: Write the spec** with this structure (fill the bracketed HEAD hash and the bc281 row from Step 1):

```markdown
# TSAL-441 pre-commitment: tree-sitter-al 4.3.0 -> 4.4.1

Written and committed at HEAD <hash> before any census, tree diff, cross-check or live run under a
4.4.1 build or an intermediate build. Nothing above OUTCOME changes after a run.
Plan: docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md (r2).

## Grammars
| label | ref | use |
| --- | --- | --- |
| g430 | vendored at HEAD, sha256 c6e7fedb...f4d4 | before |
| g441 | released v4.4.1 asset, sha256 cd6e347e...d085ed099 | after, vendored |
| gLOCAL | local `tree-sitter build --wasm` at v4.4.1 | comparison only |
| g440, g209, per-commit builds | built only if an end-to-end delta needs attribution | instruments |

## Corpora (identity is the fingerprint)
| key | path | files | sha256 (first 16) |
| --- | --- | ---: | --- |
| do | U:/Git/do-rel2/Cloud | 417 | 9a8e8831449208cc |
| dc | U:/Git/DC/Cloud | 475 | dcad155c4ecdb38e |
| sentinel | U:/Git/BusinessCentral.Sentinel | 67 | 9363656ed52020e0 |
| bcf | U:/Git/BC.History/BusinessFoundation | 104 | a56a8435136fc21f |
| sysapp | U:/Git/BC.History/System Application | 1,718 | 7fae1831fda03a89 |
| baseapp | U:/Git/BC.History/BaseApp | 9,620 | 2afad2aa60b13958 |
| bc281 | `<BC281 path>` (app.json version `<v>`), label `<gate / exploratory>`; or "not measured, not found (searched: ...)" | `<n>` | `<sha256 first 16>` |
Fixture targets: fixtures/sandbox-app, sandbox-data, sandbox-hang, sandbox-harden,
sandbox-coverage-probe.

## P1. Fixture trees (positioned nodes with ancestry, g430 vs g441)
Each node is compared as (file, start, end, kind, named, ancestor-kind path). Every node present
under only one grammar has `property` in its ancestor path (or is itself a `property`), and each
such change is #27's class: `table_relation_value` -> `identifier` for a bare value, or a
value-start contextual name now read as a name. Zero changed nodes outside a property.
Parse health, checked separately with the cross-check's `parseHealth` (ERROR nodes by type, MISSING
nodes by the parser's `isMissing` flag): 0 / 0 in every fixture file under both grammars.

## P2. Fixture sites (scripts/census-operator-sites.ts, pre-isMutableSite)
Every fixture target: 0 rows moved.

## P3. Fixture identities
For every fixture target: the `probe-fixture-hashes.ts` listing is BYTE-IDENTICAL, and the
full identity-key listing (selection.ts `serializeKey(identityKeyOf(m))` over the real manifest:
astHash, object, enclosing member, operator, operator major, source-order ordinal, with file and
startLine) is BYTE-IDENTICAL, raw count and deployed count included.
**sandbox-data, predicted unchanged:** 407 raw specs and every identity key as under 4.3.0, so
this bump moves none of GH-24's section 5 figures (301 / 68 / 18). The combined itest:tables
check after the GH-24 re-record and R-236c verifies this live; any difference there that is not
GH-24's or R-236c's is this bump's and a BLOCK.

## P4. Corpus sites, g430 -> g441 end to end
- do, sentinel, bcf: 0 rows moved.
- sysapp: 0 rows (8 asserterror assignment bodies change kind; no operator claims them).
- dc: rows move only in `CDCPurchContractCard.Page.al` and `CDCPurchContrArchCard.Page.al`
  (P1 cluster, #27), and each such row is declarative (dropped by `isMutableSite`).
- baseapp: the 34 `lethal.void-method-call` rows whose before-text starts with `[` (R284's
  fragments) REMOVED, all under `BaseApp/Test`, attributed to #26. Additions only at those 34
  restored calls, and only from operators that gate on call kind rather than statement slot;
  none from `void-method-call` or `remove-assignment` (R216's slot is still missing). 0 rows at the
  87 asserterror assignment bodies. 0 rows anywhere else.
- bc281, label **gate** (build `28.1.49838.50268`, upstream's snapshot): parse health 5 files with
  ERROR under g430 (`PostedSalesShipmentUpdate.Page.al`, `FinanceChargeMemo.Report.al`,
  `SalesPost.Codeunit.al`, `Check.Report.al`, `SalesShipment.Report.al`, matched by file name),
  0 under g441. Every moved census row lies in one of those five files and is attributed to one
  step-A commit by bisection or by its enclosing directive construct.
- bc281, label **exploratory** (any other 28.1.x build): no gating prediction. Its parse health
  under both grammars and its moved rows are measured, attributed and reported as a first
  measurement; nothing about it can pass or fail this bump.
- bc281 not found: not measured.

## P5. Unit suite
`bun test` under g441 before any test edit: the same pass / skip / fail counts as under g430 at
the same HEAD. The new `grammar-shapes.test.ts`: under g430 the seven upstream-fix cases FAIL
(#27's bare-value case on its bare-value assertion) and the R216 case passes; under g441 all
eight pass.

## P6. Cross-check re-run (scripts/probe-grammar-crosscheck.ts), g441, same seven corpora
Buckets as guarded / explained / UNEXPLAINED, section 6 layout of
docs/measurements/2026-09-27-gh06-grammar-crosscheck.md:
- fixtures, do, sentinel, bcf: identical to run 002 (do keeps C2: 3 + 2 unexplained).
- dc: comparable 475 (was 473), tree-sitter unhealthy 0 (was 2 files, 6 ERROR). Unexplained stays
  8 (C3). The two re-admitted files add 0 unexplained records.
- sysapp: assignment probe compiler-only 0 / 8 / 0 (was 0 / 0 / 8).
- baseapp: kinds compiler-only UNEXPLAINED 34 -> 0 and tree-sitter-only UNEXPLAINED 34 -> 0
  (C1a, C1b gone); call probe compiler-only UNEXPLAINED 56 -> 22 (C5 20 + C6 2), the 34 moving to
  explained; call probe tree-sitter-only UNEXPLAINED 34 -> 0; assignment probe compiler-only
  UNEXPLAINED 82 -> 10 (C5 8 + C7 2), the 72 moving to explained.
- Total unexplained: 261 -> 45 (do 5, dc 8, sysapp 0, baseapp 32). C2, C3, C5, C6, C7 unchanged.

## P7. Cross-check controls
- g430 on scripts/lib/al-kind-mapping-asserterror-index.al: compiler-only call_expression
  [147,170] and [192,238]; tree-sitter-only [154,170] and [199,238].
- g430 on al-kind-mapping-asserterror-assign.al: assignment probe compiler-only UNEXPLAINED at 125.
- g430 on al-kind-mapping-type-property.al: comparable 0, tree-sitter unhealthy 1, exit 2.
- g441 on asserterror-index: no kind delta; call probe compiler-only at 147 and 192
  explained-asserterror; 0 unexplained.
- g441 on asserterror-assign: assignment compiler-only at 125 explained-asserterror; 0 unexplained.
- g441 on type-property: comparable 1, agree, exit 0.
- Controls A and B (v3.2.1 linkprobe, v4.0.1 continue; grammar repo's checked-in wasm at the tag):
  exactly as run 002 section 3.
- census-fixture-mutants on a directory holding only asserterror-index.al, under g441: no row
  whose before-text starts with `[`.

## P8. Landing gates
- itest:bcdev: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, screen `vacuous`, per-mutant equal.
- itest:alrunner: PASS, 3 / 12 / 4 on all four legs, per-mutant equal to one-shot.
- itest:chunked: PASS, both legs 17 / 7 / 2, control warmKills 9 / groupedCalls 33, chunked 5 / 57.
- No baseline is deleted, regenerated or edited.

A failed P1 to P4 stops the plan before the next dependent step: explain every row, file what is
new, and commit an AMENDMENT section to this spec, alone.

## OUTCOME
(Filled in after the runs.)
```

- [ ] **Step 4: Commit alone** (when the orchestrator allows commits):

```bash
git add docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md
git commit -m "spec(TSAL-441): pre-commit the 4.3.0 -> 4.4.1 census, identity, cross-check and gate predictions" -- docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md
```

---

### Task 2: Obtain the artifact and compare a local build (no repo change)

**Files:** none in the repo. Outputs go in `$S`, the session scratchpad.

**Interfaces:**
- Produces: `$S/g430.wasm`, `$S/g441.wasm` (the release asset), `$S/gLOCAL.wasm`, and the `use` helper.

- [ ] **Step 1: Save the current grammar.**

```bash
S=<session scratchpad>; cd /u/Git/LethAL
cp packages/engine/vendor/tree-sitter-al.wasm "$S/g430.wasm"
sha256sum "$S/g430.wasm"   # c6e7fedb0002f0ca902bd0fc36a10ef492f543aa4bdd2e4f465b1e258bf9f4d4
```

- [ ] **Step 2: Download and verify the released asset.**

```bash
gh release download v4.4.1 -R SShadowS/tree-sitter-al -p tree-sitter-al.wasm -D "$S/rel"
sha256sum "$S/rel/tree-sitter-al.wasm"; stat -c %s "$S/rel/tree-sitter-al.wasm"
git -C /u/Git/tree-sitter-al fetch --tags
git -C /u/Git/tree-sitter-al show v4.4.1:tree-sitter-al.wasm | sha256sum
cp "$S/rel/tree-sitter-al.wasm" "$S/g441.wasm"
```

Expected: the asset is `cd6e347e8bf4171c4bd4302543bdb543451be307a34fd0c7f95ca56a085ed099`, 11,496,302 bytes, equal to the tag's checked-in wasm. If the asset's hash differs from the tag's checked-in wasm, stop and ask: that is a release defect, not a toolchain difference.

- [ ] **Step 3: Local build, comparison only.**

```bash
tree-sitter --version      # record it; 0.27.0 expected
git -C /u/Git/tree-sitter-al worktree add --detach "$S/ts-v4.4.1" v4.4.1
( cd "$S/ts-v4.4.1" && tree-sitter build --wasm -o "$S/gLOCAL.wasm" && sha256sum src/parser.c src/scanner.c && cat tree-sitter-al.wasm.inputs.sha256 )
sha256sum "$S/gLOCAL.wasm"; stat -c %s "$S/gLOCAL.wasm"
git -C /u/Git/tree-sitter-al show v4.4.1:src/node-types.json > "$S/nt441.json"
git -C /u/Git/tree-sitter-al worktree remove "$S/ts-v4.4.1"
```

Record: the local hash and size, whether it equals the asset, and whether the stamp matches the worktree's `parser.c`/`scanner.c`. A difference is recorded in the README (Task 4), never a stop.

- [ ] **Step 4: Define the swap helper** (Tasks 3 to 6 use it):

```bash
use() { cp "$S/$1.wasm" /u/Git/LethAL/packages/engine/vendor/tree-sitter-al.wasm && sha256sum /u/Git/LethAL/packages/engine/vendor/tree-sitter-al.wasm; }
```

The BC 28.1 search is NOT here: it runs in Task 1 Step 1, before the spec is committed (ruling I2).

---

### Task 3: Offline measurement: fixture trees, sites and identities; corpus sites; attribution

**Files:** none in the repo. Outputs go in `$S`.

**Interfaces:**
- Consumes: `use`, `$S/g430.wasm`, `$S/g441.wasm`, `BC281` (from `$S/bc281.env`; empty means not found).
- Produces: `$S/nodes-<g>-<fixture>.tsv`, `$S/health-<g>-<fixture>.tsv`, `$S/census-<g>-<key>.json`, `$S/hashes-<g>-<fixture>.txt`, `$S/ids-<g>-<fixture>.txt`, and the attribution table Task 4 and the spec OUTCOME quote.

- [ ] **Step 1: Re-fingerprint the fixed corpora** (bc281 was fingerprinted in Task 1 Step 1; re-check it only when set).

```bash
cd /u/Git/LethAL; source "$S/bc281.env"
for d in U:/Git/do-rel2/Cloud U:/Git/DC/Cloud U:/Git/BusinessCentral.Sentinel U:/Git/BC.History/BusinessFoundation "U:/Git/BC.History/System Application" U:/Git/BC.History/BaseApp; do bun scripts/corpus-fingerprint.ts "$d"; done
if [ -n "$BC281" ]; then bun scripts/corpus-fingerprint.ts "$BC281"; fi
```

Expected: the spec's table, bc281's row included when set.

- [ ] **Step 2: Prove the census is stable (R218).** Under g430, run the baseapp census twice and diff:

```bash
use g430
bun scripts/census-operator-sites.ts U:/Git/BC.History/BaseApp "$S/census-g430-baseapp.json"
bun scripts/census-operator-sites.ts U:/Git/BC.History/BaseApp "$S/census-g430-baseapp-2.json"
bun scripts/probe-census-diff.ts "$S/census-g430-baseapp.json" "$S/census-g430-baseapp-2.json"
```

Expected: 0 only-in-A, 0 only-in-B. Anything else is instrument noise. Fix and red-check it (as R218 was) before any A/B is read.

- [ ] **Step 3: Write four scratch scripts** (not committed; they live in `$S`).

`$S/tree-dump.ts` writes every node of every fixture file as one POSITIONED line with its ancestry, plus a separate parse-health file (ruling I1):

```ts
// Usage: bun tree-dump.ts <project-dir> <nodes.tsv> <health.tsv>
// nodes.tsv: file \t start \t end \t kind \t named(n|a) \t ancestor kinds root>...>parent, sorted.
// health.tsv: file \t ERROR nodes \t MISSING nodes, via the cross-check's own parseHealth, which
// counts ERROR by type and MISSING by the parser's isMissing flag (a MISSING node has no kind
// named MISSING; it carries the kind of the token it stands in for).
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "U:/Git/LethAL/packages/engine/src/ast/parser";
import { parseHealth } from "U:/Git/LethAL/scripts/lib/grammar-crosscheck";
const [dir, nodesOut, healthOut] = process.argv.slice(2);
if (dir === undefined || nodesOut === undefined || healthOut === undefined)
  throw new Error("usage: tree-dump.ts <dir> <nodes.tsv> <health.tsv>");
await initParser();
type N = ReturnType<typeof parseAL>["rootNode"];
const nodes: string[] = [];
const health: string[] = [];
const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".al")).sort();
for (const rel of files) {
  const file = rel.replaceAll("\\", "/");
  const tree = parseAL(await readFile(join(dir, rel), "utf8"));
  const h = parseHealth(tree.rootNode);
  health.push(`${file}\t${h.errorNodes}\t${h.missingNodes}`);
  const walk = (n: N, path: string[]): void => {
    nodes.push(`${file}\t${n.startIndex}\t${n.endIndex}\t${n.type}\t${n.isNamed ? "n" : "a"}\t${path.join(">")}`);
    for (const c of n.children) if (c !== null) walk(c, [...path, n.type]);
  };
  walk(tree.rootNode, []);
}
await writeFile(nodesOut, `${nodes.sort().join("\n")}\n`);
await writeFile(healthOut, `${health.join("\n")}\n`);
```

`$S/tree-check.ts` decides P1 mechanically: a node line present under only one grammar is inside a property value exactly when its ancestor path contains `property` (the one generic property kind in 4.4.1's `node-types.json`; `property_name` and `property_expression` are its children) or its own kind is `property`:

```ts
// Usage: bun tree-check.ts before.tsv after.tsv. Exit 1 if any changed node lies outside a property.
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => readFileSync(p ?? "", "utf8").split("\n").filter(Boolean));
const count = (lines: string[] | undefined) => {
  const m = new Map<string, number>();
  for (const l of lines ?? []) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};
const [ma, mb] = [count(a), count(b)];
let inside = 0;
const outside: string[] = [];
const kinds = new Map<string, number>();
for (const k of new Set([...ma.keys(), ...mb.keys()])) {
  const d = (mb.get(k) ?? 0) - (ma.get(k) ?? 0);
  if (d === 0) continue;
  const [, , , kind = "", , path = ""] = k.split("\t");
  const tag = `${d < 0 ? "-" : "+"}${kind}`;
  kinds.set(tag, (kinds.get(tag) ?? 0) + Math.abs(d));
  if (kind === "property" || path.split(">").includes("property")) inside += Math.abs(d);
  else outside.push(`${d < 0 ? "-" : "+"} ${k}`);
}
console.log(`changed nodes inside a property: ${inside}, outside: ${outside.length}`);
console.log([...kinds].sort((x, y) => y[1] - x[1]).map(([t, c]) => `${t} ${c}`).join(", ") || "(none)");
for (const l of outside.slice(0, 40)) console.log(`   OUTSIDE ${l}`);
process.exit(outside.length > 0 ? 1 : 0);
```

`$S/identity-keys.ts` prints the real pipeline's identity key per mutant. It runs `generateMutationSet` and `writeInstrumentedProject`, exactly as the orchestrator does, then reads the emitted `mutant-manifest.json`, so `identityOrdinal` comes from the product's own `assignIdentityOrdinals`:

```ts
// Usage: bun identity-keys.ts <project-dir> <scratch-target-dir>
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateMutationSet, operatorTiers } from "U:/Git/LethAL/packages/runner/src/orchestrator";
import { identityKeyOf, serializeKey } from "U:/Git/LethAL/packages/runner/src/selection";
import { type MutantManifest, writeInstrumentedProject } from "U:/Git/LethAL/packages/schemata/src/project";
const [projectDir, targetDir] = process.argv.slice(2);
if (projectDir === undefined || targetDir === undefined) throw new Error("usage: identity-keys.ts <project> <target>");
const set = await generateMutationSet(projectDir);
await writeInstrumentedProject({
  targetDir,
  files: set.files,
  selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  artifactId: "0123456789abcdef0123456789abcdef",
  targetAppId: "00000000-0000-0000-0000-000000000000",
  operatorTiers,
});
const manifest = JSON.parse(await readFile(join(targetDir, "mutant-manifest.json"), "utf8")) as MutantManifest;
const raw = set.files.reduce((n, f) => n + f.specs.length, 0);
console.log(`raw ${raw} deployed ${manifest.mutants.length} skippedFiles ${set.skipped.length}`);
for (const m of [...manifest.mutants].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.mutantId.localeCompare(b.mutantId)))
  console.log(`${m.file}:${m.startLine}\t${m.mutantId}\t${serializeKey(identityKeyOf(m))}`);
```

If `MutantManifest` or a field name differs at run time, read `packages/schemata/src/project.ts` and adjust the script, not the product.

`$S/rows-diff.ts` lists every moved census row (`probe-census-diff.ts` prints only six per side):

```ts
// Usage: bun rows-diff.ts a.json b.json. Prints "- row" / "+ row", multiset semantics.
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p ?? "", "utf8")) as Record<string, unknown>[]);
const key = (r: Record<string, unknown>) => JSON.stringify([r.operator, r.file, r.line, r.column, r.before, r.after]);
const count = (rows: Record<string, unknown>[] | undefined) => {
  const m = new Map<string, number>();
  for (const r of rows ?? []) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
};
const [ma, mb] = [count(a), count(b)];
for (const k of new Set([...ma.keys(), ...mb.keys()])) {
  const d = (mb.get(k) ?? 0) - (ma.get(k) ?? 0);
  for (let i = 0; i < Math.abs(d); i++) console.log(`${d < 0 ? "-" : "+"} ${k}`);
}
```

- [ ] **Step 4: Measure the fixtures under both grammars.**

```bash
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
for g in g430 g441; do
  use $g
  for f in $F; do
    bun "$S/tree-dump.ts" "fixtures/$f/src" "$S/nodes-$g-$f.tsv" "$S/health-$g-$f.tsv"
    bun scripts/census-operator-sites.ts "fixtures/$f/src" "$S/census-$g-$f.json"
    bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-$g-$f.txt"
    rm -rf "$S/target-$g-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-$g-$f" > "$S/ids-$g-$f.txt"
  done
done
use g430
```

`identity-keys.ts` takes the fixture ROOT (the pipeline reads `app.json` layout and skips emitted files itself); `probe-fixture-hashes.ts` and the census take `src`.

- [ ] **Step 5: Check the fixture trees against P1.**

```bash
for f in $F; do echo "== $f"; bun "$S/tree-check.ts" "$S/nodes-g430-$f.tsv" "$S/nodes-g441-$f.tsv"; echo "exit $?"; done
for f in $F; do for g in g430 g441; do awk -F'\t' -v t="$g $f" '$2>0||$3>0{print t": "$0; bad=1} END{exit bad}' "$S/health-$g-$f.tsv"; done; done && echo "parse health 0/0 everywhere"
```

Expected: every fixture exits 0 with "outside: 0", and the kind tally is #27's class only (`-table_relation_value` / `+identifier` and their descendants, plus any value-start name). Parse health: no line printed. A changed node outside a property, a changed-kind class other than #27's, or any ERROR or MISSING node refutes P1: stop and amend. Note the tally is about KINDS inside properties; which changes are "#27's class" is read from it by name, and anything unexpected there is listed and explained before continuing.

Also list every fixture property whose value STARTS with a contextual name, so #27's second class is checked by name rather than assumed absent:

```bash
grep -nE "^\s*[A-Za-z]+\s*=\s*(Order|Table|Type|Filter|Modify|Insert|Delete|Codeunit|Page|Report|Query|XmlPort|Enum|Interface|Label|Option|Integer|Text|Code|Decimal|Boolean|Date|Time)\b" fixtures/sandbox-{app,data,hang,harden,coverage-probe}/src/*.al
```

For each hit, look up its value node in `nodes-g430-<f>.tsv` and `nodes-g441-<f>.tsv` by file and offset, and record whether it changed (a #27 change) or not. Either way it must not appear in the census diff.

- [ ] **Step 6: Check fixture sites and identities against P2 and P3.**

```bash
for f in $F; do
  echo "== $f"
  bun "$S/rows-diff.ts" "$S/census-g430-$f.json" "$S/census-g441-$f.json" | head -20
  diff "$S/hashes-g430-$f.txt" "$S/hashes-g441-$f.txt" && echo "hashes identical"
  diff "$S/ids-g430-$f.txt" "$S/ids-g441-$f.txt" && echo "identity keys identical"
done
head -1 "$S/ids-g430-sandbox-data.txt"   # expect "raw 407 deployed 387 ..."
```

Expected: no rows, both listings identical, `sandbox-data` at raw 407 / deployed 387 (GH-24's figures; if the pipeline counts differ from those, record it as a pipeline fact, not a bump delta, since g430 and g441 agree). Any difference refutes P2 or P3: stop, attribute (Step 8), amend, and apply the Sequencing section's stacked-figures rule.

- [ ] **Step 7: Corpus census, end to end only.**

```bash
declare -A C=([do]="U:/Git/do-rel2/Cloud" [dc]="U:/Git/DC/Cloud" [sentinel]="U:/Git/BusinessCentral.Sentinel" [bcf]="U:/Git/BC.History/BusinessFoundation" [sysapp]="U:/Git/BC.History/System Application" [baseapp]="U:/Git/BC.History/BaseApp")
source "$S/bc281.env"; if [ -n "$BC281" ]; then C[bc281]="$BC281"; fi
for g in g430 g441; do use $g; for k in "${!C[@]}"; do [ -f "$S/census-$g-$k.json" ] || bun scripts/census-operator-sites.ts "${C[$k]}" "$S/census-$g-$k.json"; done; done
use g430
for k in "${!C[@]}"; do echo "== $k"; bun scripts/probe-census-diff.ts "$S/census-g430-$k.json" "$S/census-g441-$k.json"; bun "$S/rows-diff.ts" "$S/census-g430-$k.json" "$S/census-g441-$k.json" > "$S/moved-$k.txt"; done
```

The census recurses and also reads `.dependencies` (the 4.3.0 bump's `do` count was 554 files for that reason). Record the parsed file count beside each fingerprint. Run it in the foreground; baseapp is the long one.

- [ ] **Step 8: Attribute every moved row, using intermediate grammars only where needed.** For a corpus whose `moved-<k>.txt` is empty, nothing more is done. For each moved row, in this order:

1. **Enclosing construct.** Find the row's line in the source and name its construct: an `asserterror` statement (step B; #26 if the body starts with an indexed receiver, else #28), a property value (step C, #27), or directive code. Directive code means the row is inside a `#if ... #endif` region OR its enclosing block, `case` or report dataitem crosses one (a block opened in a branch and closed after `#endif`, a `case` whose `end;` is inside the branches, a split brace). Rows AFTER `#endif` can still be #25's.
2. **Commit bisection,** for any row that step 1 does not settle, or when a corpus has directive rows from more than one construct. Build only the grammars that split the ambiguity, then re-run the census on THAT corpus only:

```bash
cd /u/Git/tree-sitter-al
b() { git worktree add --detach "$S/ts-$1" "$1" && ( cd "$S/ts-$1" && tree-sitter generate && tree-sitter build --wasm -o "$S/g-$1.wasm" ); git worktree remove --force "$S/ts-$1"; }
# step A is four commits; build only the ones needed, in order:
b 0791253; b bc72141; b 028cbdd; b e0ab7a4     # e0ab7a4 equals v4.4.0's grammar
# step B / C split, only if a row could be either:
b 209d038
cd /u/Git/LethAL
use g-0791253 && bun scripts/census-operator-sites.ts "<corpus>" "$S/census-0791253-<k>.json"   # and so on per built commit
use g430
```

A row belongs to the first commit at which it appears (or disappears). `tree-sitter generate` is needed because upstream regenerates `parser.c` only in the release chore commits. These wasms are instruments and are never vendored.

3. Write one line per cluster: step, commit, issue, operator, count, files, construct. A row that fits no upstream change is UNEXPLAINED: stop, minimise it to a hand-written `.al`, file it (next free id), and amend the spec before continuing.

- [ ] **Step 9: dc's declarative check (P4).** For every dc row moved by #27, confirm `isMutableSite` drops it: copy only the two dc page files into `$S/dcp/`, run `bun scripts/census-fixture-mutants.ts "$S/dcp"` under g441, and check that none of those rows appears (that script applies `isMutableSite`). Never copy those files into the repo.

- [ ] **Step 10: Parse health for bc281, only when `BC281` is set.** Reuse `tree-dump.ts`, whose health file uses the cross-check's `parseHealth` (ERROR by type, MISSING by `isMissing`); the nodes file is large, write it to scratch and delete it after:

```bash
source "$S/bc281.env"
if [ -n "$BC281" ]; then
  for g in g430 g441; do
    use $g
    bun "$S/tree-dump.ts" "$BC281" "$S/nodes-$g-bc281.tsv" "$S/health-$g-bc281.tsv"
    echo "$g: $(awk -F'\t' '$2>0||$3>0' "$S/health-$g-bc281.tsv" | wc -l) unhealthy files"
    awk -F'\t' '$2>0||$3>0{print "   "$1}' "$S/health-$g-bc281.tsv"
    rm -f "$S/nodes-$g-bc281.tsv"
  done
  use g430
fi
```

For a **gate** bc281, P4 predicts 5 named files under g430 and 0 under g441. For an **exploratory** bc281, record the counts and file names; they gate nothing. When `BC281` is empty, this step records "not measured".

No commit in this task; every output is scratch.

---

### Task 4: Vendor the released 4.4.1 asset and record the bump (on the lane branch, not merged)

**Files:**
- Modify: `packages/engine/vendor/tree-sitter-al.wasm` (replace)
- Modify: `packages/engine/vendor/README.md` (header, lines 7 to 28; a new section after the 4.3.0 one, before "## Bumping the vendored WASM"; one paragraph in "## How to reproduce / update")

**Interfaces:**
- Consumes: `$S/g441.wasm`, the local-build comparison (Task 2), the Task 3 results.
- Produces: the 4.4.1 grammar every later task runs against.

- [ ] **Step 1: Swap in the release asset.** `use g441`. The hash printed must be `cd6e347e...d085ed099`.

- [ ] **Step 2: Check `ALNodeKind` against the new `node-types.json`.**

```bash
bun -e 'import {ALNodeKind} from "./packages/engine/src/ast/node-kinds"; const nt=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const have=new Set(nt.filter(n=>n.named).map(n=>n.type)); const miss=Object.values(ALNodeKind).filter(v=>!have.has(v)); console.log("missing", miss); if (miss.length) process.exit(1);' "$S/nt441.json"
```

Expected: `missing []`.

- [ ] **Step 3: Unit suite, before any test edit.** Run it under g430 first if its counts at this HEAD are not already known, then under g441:

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
```

Expected: identical counts (P5). A grep at plan time found no test in `packages/{engine,builtin-tier1,builtin-tier2,schemata}/tests` that names `asserterror`, `assignment_expression`, `table_relation_value`, `link_value` or a `preproc_` kind. A new failure is a shape change: record which test and which step moved it; Task 5 owns the edit.

- [ ] **Step 4: Update the README header.** Replace the Version / Commit / Provenance / Artifact bullets with:

```markdown
- Version: `4.4.1`
- Commit: `7819df5` "chore: regenerate parser.c and rebuild tree-sitter-al.wasm
  for v4.4.1", tag `v4.4.1`
- Provenance: the RELEASED `tree-sitter-al.wasm` asset of GitHub release v4.4.1,
  downloaded with `gh release download`, SHA-256 verified. It equals the wasm
  checked in at the tag. A local build (tree-sitter CLI <version>, detached
  worktree at the tag) was made only to compare: <identical | differs: size,
  sha256>.
- Artifact: 11,496,302 bytes,
  `sha256:cd6e347e8bf4171c4bd4302543bdb543451be307a34fd0c7f95ca56a085ed099`
```

Move the 4.3.0 bullets into a "Previously `4.3.0` at commit `f7af22a` (10,428,350 bytes, `sha256:c6e7fedb...`), built locally at the tag" paragraph, the way the 4.0.1 entry was kept. In "## How to reproduce / update", add one paragraph: from 4.4.1 on, the release asset is vendored and the local build is a comparison (orchestrator ruling 2026-09-27), because under tree-sitter 0.27.0 the two have been byte-identical and the release is the artifact upstream verified.

- [ ] **Step 5: Add the section** `## The 4.3.0 -> 4.4.1 bump (<date>): <one-line result>` with, in order: the three-step upstream table; "Grammar-caused code changes needed: <none or list>"; the fixture results (tree diff classes and counts, census 0 rows, hash and identity-key listings identical, `sandbox-data` raw/deployed counts); the per-corpus census with every moved cluster attributed (Task 3 Step 8), including which intermediate grammars were built and why; the bc281 result, or "not measured, not found on this machine (searched: <list>)"; the `bun test` counts; the census-stability check; and a "What this bump does NOT prove" paragraph (the fixtures and `do` hold none of the #24/#25/#26/#28 shapes; the directive gain is measured only where bc281 was found). Leave a "### Landing gates" subsection with the line "Filled in by Task 7."

- [ ] **Step 6: Commit on the lane branch** (when allowed). The bump is not merged before Task 7 passes.

```bash
git add packages/engine/vendor/tree-sitter-al.wasm packages/engine/vendor/README.md
git commit -m "feat: vendor the released tree-sitter-al 4.4.1 wasm (sha256 verified)" -- packages/engine/vendor/tree-sitter-al.wasm packages/engine/vendor/README.md
```

The body states the fixture result, the census attribution per step, the local-build comparison, and that the landing gates are not part of this commit.

---

### Task 5: Pin the corrected shapes, with red/green controls for all five issues

**Files:**
- Create: `packages/engine/tests/ast/grammar-shapes.test.ts`
- Modify (only if Task 4 Step 3 found a failure): each failing test, named in the commit.

**Interfaces:**
- Consumes: the 4.4.1 grammar. Uses `initParser`, `parseAL`, `wrapRoot`, `visit`, `isStatementSlot` and the `ALSyntaxNode` type, all exported from `packages/engine/src` (`tree-walks.test.ts` imports them the same way).

Why this file: no existing test pins any corrected shape, so a later bump could undo one silently. The #24 and #25 cases are the only local positive evidence of the directive fixes if no BC 28.1 copy is found. The last case pins R216's LethAL side as it stands, so whoever closes R216 changes it on purpose.

- [ ] **Step 1: Write the test.** The #24 and #25 sources are the upstream issues' own minimal repros (hand-written, invented names).

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import { initParser, isStatementSlot, parseAL, visit, wrapRoot } from "../../src";

/**
 * Shapes tree-sitter-al 4.4.1 fixed after LethAL or a downstream user reported them (upstream #24,
 * #25, #26, #27, #28). Each upstream case is RED under the 4.3.0 wasm. If a bump turns one red, the
 * grammar regressed on a shape LethAL depends on: map it before editing this file.
 */
function ofKind(root: ALSyntaxNode, raw: string): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.rawKind === raw) out.push(n);
  });
  return out;
}

function hasError(root: ALSyntaxNode): boolean {
  return ofKind(root, "ERROR").length > 0;
}

/** Calls whose callee text is exactly `name`. */
function callsNamed(root: ALSyntaxNode, name: string): ALSyntaxNode[] {
  return ofKind(root, "call_expression").filter((c) => c.childForFieldName("function")?.text === name);
}

const codeunit = (body: string, vars = "Outcome: Integer;"): string =>
  `codeunit 50001 "Shape Probe"\n{\n    procedure Run()\n    var\n        ${vars}\n    begin\n${body}\n    end;\n}\n`;

describe("tree-sitter-al 4.4.1 shapes", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("#24: an operator dangling before #if parses without ERROR", () => {
    const root = wrapRoot(
      parseAL(codeunit("        B := (1 = 1) or\n#if X\n          (2 = 2) or\n#endif\n          (3 = 3);", "B: Boolean;")),
    );
    expect(hasError(root)).toBe(false);
    expect(ofKind(root, "preproc_operand_prefix").length).toBe(1);
  });

  it("#24 follow-up: `or` opening a #if continuation continues the assignment's expression", () => {
    const root = wrapRoot(
      parseAL(codeunit("        B := (1 = 1)\n#if X\n          or (2 = 2)\n#endif\n          or (3 = 3);", "B: Boolean;")),
    );
    expect(hasError(root)).toBe(false);
    expect(callsNamed(root, "or")).toEqual([]);
    // The expected shape, from upstream's test/corpus/preproc_expression_continuation_operators_test.txt:
    // ONE assignment whose right is `(1 = 1)` and which carries a preproc_conditional_expression_tail
    // holding both continuation operands. Under 4.3.0 the assignment ended at `(1 = 1)` and the
    // rest was two sibling calls named `or`.
    const assigns = ofKind(root, "assignment_statement");
    expect(assigns.length).toBe(1);
    expect(assigns[0]?.childForFieldName("right")?.text).toBe("(1 = 1)");
    const tails = ofKind(root, "preproc_conditional_expression_tail");
    expect(tails.length).toBe(1);
    expect(tails[0]?.parent?.rawKind).toBe("assignment_statement");
    const operands = (tails[0]?.namedChildren ?? []).filter((c) => c.fieldName === "operand").map((c) => c.text);
    expect(operands).toEqual(["(2 = 2)", "(3 = 3)"]);
  });

  it("#25: a begin opened inside a #if branch and closed after #endif parses without ERROR", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "#if not CLEAN27\n        if true then begin\n            Message('a');\n#endif\n            Message('b');\n        end;",
        ),
      ),
    );
    expect(hasError(root)).toBe(false);
    expect(callsNamed(root, "Message").map((c) => c.text)).toEqual(["Message('a')", "Message('b')"]);
  });

  it("#26: asserterror over a call on an array element is one statement whose body is the whole call", () => {
    const root = wrapRoot(
      parseAL(codeunit("        asserterror Buckets[1].Delete(true);", 'Buckets: array[3] of Record "Integer";')),
    );
    const stmts = ofKind(root, "asserterror_statement");
    expect(stmts.length).toBe(1);
    const body = stmts[0]?.childForFieldName("body");
    expect(body?.rawKind).toBe("call_expression");
    expect(body?.text).toBe("Buckets[1].Delete(true)");
    expect(ofKind(root, "list_literal")).toEqual([]);
  });

  it("#28: an assignment under asserterror is an assignment_statement, and if/exit attach as the body", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "        asserterror Outcome := 1;\n        asserterror if Outcome = 2 then Error('two');\n        asserterror exit;",
        ),
      ),
    );
    const bodies = ofKind(root, "asserterror_statement").map((s) => s.childForFieldName("body")?.rawKind);
    expect(bodies).toEqual(["assignment_statement", "if_statement", "exit_statement"]);
    expect(ofKind(root, "assignment_expression")).toEqual([]);
  });

  it("#27: `Visible = Type = Type::Alpha;` is a comparison, with no ERROR", () => {
    const src =
      'page 50006 "Mode Card Probe"\n{\n    PageType = Card;\n    SourceTable = "Mode Probe";\n\n    layout\n    {\n        area(Content)\n        {\n            field(Type; Rec.Type)\n            {\n                ApplicationArea = All;\n                Visible = Type = Type::Alpha;\n            }\n        }\n    }\n}\n';
    const root = wrapRoot(parseAL(src));
    expect(hasError(root)).toBe(false);
    expect(ofKind(root, "comparison_expression").map((c) => c.text)).toEqual(["Type = Type::Alpha"]);
  });

  it("#27, bare values: `Image = Filter;` and `ExternalAccess = Modify;` are identifiers, not table relations", () => {
    // Upstream's own examples of the class (551829e: 812 BC.History values moved from
    // table_relation_value to identifier, `ExternalAccess = Modify` 92 and `Image = Filter` 10 among
    // them); shape from test/corpus/value_start_keyword_name_test.txt.
    const root = wrapRoot(parseAL("page 50008 P\n{\n    ExternalAccess = Modify;\n    Image = Filter;\n}\n"));
    expect(hasError(root)).toBe(false);
    const values = ofKind(root, "property").map((p) => [
      p.childForFieldName("name")?.text,
      p.childForFieldName("value")?.rawKind,
      p.childForFieldName("value")?.text,
    ]);
    // THE bare-value assertion. Under 4.3.0 each value is a `table_relation_value`, so this fails.
    expect(values).toEqual([
      ["ExternalAccess", "identifier", "Modify"],
      ["Image", "identifier", "Filter"],
    ]);
  });

  it("R216 still open: a call that is an asserterror body is NOT a statement slot", () => {
    const root = wrapRoot(parseAL(codeunit("        asserterror Compute(8);")));
    const body = ofKind(root, "asserterror_statement")[0]?.childForFieldName("body");
    if (body === null || body === undefined) throw new Error("no asserterror body");
    expect(body.rawKind).toBe("call_expression");
    // Flip to true in the follow-on that closes R216 (add `asserterror_statement.body` to
    // SINGLE_STATEMENT_SLOTS in packages/engine/src/ast/tree-walks.ts), with its own census.
    expect(isStatementSlot(body)).toBe(false);
  });
});
```

The parser reads syntax only, so undeclared names (`Compute`, table `"Mode Probe"`) do not matter.

- [ ] **Step 2: Run it under 4.4.1.** `bun test packages/engine/tests/ast/grammar-shapes.test.ts`. Expected: 8 pass.

- [ ] **Step 3: Red-check with the old grammar** (the `mutation-red-checker` subagent, or by hand). `use g430` and run the same command. Expected: the seven upstream cases FAIL, each on the named assertion: #24 (ERROR at `#if`); #24 follow-up (`callsNamed(root, "or")` is not empty, and the assignment/tail shape assertions would fail too); #25 (ERROR over the procedure); #26 (body is an `identifier`, a `list_literal` exists); #28 (`assignment_expression`, and `if`/`exit` are siblings); #27 Type (ERROR present); #27 bare values (the `values` assertion, with `table_relation_value` in the kind column; the preceding `hasError` must PASS under g430, so the failure is the bare-value assertion and nothing else). The R216 case PASSES. Then `use g441` and re-run: 8 pass. Check that the vendored wasm hash equals the Task 4 commit again. Record both outputs for the commit body. If any upstream case is green under g430, or fails under g430 on an assertion other than the one named, it does not discriminate as intended: fix the case (never by weakening it) until it does.

- [ ] **Step 4: If Task 4 Step 3 had failures,** update each failing test to the new shape. Allowed: changing an expected kind or span to what upstream now produces, with the issue number in a comment. Not allowed: widening an assertion (`toContain` for `toEqual`, deleting a case, lowering a count bound). Red-check each changed test the same way (red under g430 where it pinned the old shape).

- [ ] **Step 5: Full loop, lint, commit** (when allowed). The commit includes every edited existing test.

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/engine/tests/ast/grammar-shapes.test.ts <each edited test path>
git add packages/engine/tests/ast/grammar-shapes.test.ts <each edited test path>
git commit -m "test(engine): red/green shape controls for tree-sitter-al 4.4.1's fixes (#24-#28) and R216's open slot" -- packages/engine/tests/ast/grammar-shapes.test.ts <each edited test path>
```

The body names each edited existing test with the upstream issue that moved it, or states "no existing test changed".

---

### Task 6: Re-run the GH-06 cross-check under 4.4.1

**Files:**
- Modify: `docs/measurements/2026-09-27-gh06-grammar-crosscheck.md` (append a section at the end; add one sentence to section 1)

**Interfaces:**
- Consumes: `$S/g430.wasm`, `$S/g441.wasm` (identical to the vendored file), the grammar repo's checked-in wasms at `v3.2.1` and `v4.0.1`.
- Produces: the per-cluster result Task 8 closes items on.

The harness signature is `probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm]`. An empty `alc-bin-dir` means "default". The grammar argument must be omitted or a REAL path: a defined but empty grammar argument makes the harness `readFile("")` and fail. So every call below passes an explicit wasm path.

- [ ] **Step 1: Controls first, before any corpus output is read.**

```bash
cd /u/Git/LethAL
git -C /u/Git/tree-sitter-al show v3.2.1:tree-sitter-al.wasm > "$S/g321-tag.wasm"
git -C /u/Git/tree-sitter-al show v4.0.1:tree-sitter-al.wasm > "$S/g401-tag.wasm"
x() { bun scripts/probe-grammar-crosscheck.ts "$1" "" "$2" > "$S/ctl-$3.txt" 2>&1; echo "$3 exit $?"; }
x scripts/lib/al-kind-mapping-linkprobe.al "$S/g321-tag.wasm" A-321
x scripts/lib/al-kind-mapping-continue.al "$S/g401-tag.wasm" B-401
for f in asserterror-index asserterror-assign type-property; do
  x "scripts/lib/al-kind-mapping-$f.al" "$S/g430.wasm" "$f-430"
  x "scripts/lib/al-kind-mapping-$f.al" "$S/g441.wasm" "$f-441"
done
```

Expected: P7 exactly. The g430 rows are what make an empty g441 result mean "fixed" rather than "harness blind". Then the R284 pipeline check (under the vendored g441):

```bash
mkdir -p "$S/r284" && cp scripts/lib/al-kind-mapping-asserterror-index.al "$S/r284/"
bun scripts/census-fixture-mutants.ts "$S/r284"
```

Expected: no line whose before-text starts with `[`.

- [ ] **Step 2: Corpora, foreground, one at a time,** with the run 002 command (measurement doc section 2), vendored grammar (no grammar argument):

```bash
run() { bun scripts/probe-grammar-crosscheck.ts "$1" --json "$S/gh06r3-$2.json" > "$S/gh06r3-$2.txt" 2>&1; echo "$2 exit $?"; head -3 "$S/gh06r3-$2.txt"; }
run fixtures fixtures
run U:/Git/do-rel2/Cloud do
run U:/Git/DC/Cloud dc
run U:/Git/BusinessCentral.Sentinel sentinel
run U:/Git/BC.History/BusinessFoundation bcf
run "U:/Git/BC.History/System Application" sysapp
run U:/Git/BC.History/BaseApp baseapp
```

Each first line is the fingerprint; it must match the spec. bc281 has no run 002 row, so it is not part of run 003's comparison. When it is set, run it and report it separately, labelled as a first measurement (and as exploratory when its label is):

```bash
source "$S/bc281.env"; if [ -n "$BC281" ]; then run "$BC281" bc281; fi
```

- [ ] **Step 3: Assign every unexplained record to a cluster** with run 002's mechanical rule (the tree-sitter node at the site offset, its field name, its parent's kind). Expected: C2 (do), C3 (dc), C5, C6, C7 (baseapp) only, with P6's counts. A record that fits no existing cluster is a new finding: minimise it to a hand-written `.al` under `scripts/lib/`, file it (next free id), and note it.

- [ ] **Step 4: Append** `## 10. Run 003: tree-sitter-al 4.4.1 (<date>)` with: the grammar line (4.4.1, `7819df5`, release asset sha256); the harness commit (unchanged from `b645a9b` unless it moved, and say which); the controls table (P7 predicted vs measured); the corpus table and per-corpus deltas in the section 4 and 6 layouts; a per-cluster table with a "4.3.0 -> 4.4.1" column (`C1a 34+34 -> 0`, `C1b 34+34 -> 0`, `C4 80 unexplained -> 80 explained`, `P1 2 files -> 0`, others as measured); one sentence per closed cluster naming the upstream commit (`209d038` for C1 and C4's kind; `551829e` for P1); the bc281 first measurement or "not measured"; and a "What this does not cover" note: R2's guard still knows only `preproc_conditional*` while 4.4.1 adds six more `preproc_*` kinds (the new roadmap item from Task 8), and C4's records are explained, not claimed, because R216's slot is still missing. In section 1, add one sentence pointing to section 10.

- [ ] **Step 5: Commit** (when allowed):

```bash
git commit -m "measure(issue-6): run 003 under tree-sitter-al 4.4.1; C1a, C1b and P1 gone, C4 now explained" -- docs/measurements/2026-09-27-gh06-grammar-crosscheck.md
```

---

### Task 7: Landing gates: itest:bcdev, itest:chunked, itest:alrunner

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md` (`## OUTCOME` only)
- Modify: `packages/engine/vendor/README.md` ("### Landing gates" subsection only)

**Interfaces:**
- Consumes: P8, the vendored 4.4.1 grammar, and Task 3's result (P1 to P3 held, or an amendment is committed).

Only these three gates (ruling Q1). `itest:tables` is not run here; see the Sequencing section. `itest:lease`, `itest:stale-publish`, `itest:hang`, `itest:harden` and `itest:envtool` are outside the ruling's landing set. The README's step 5 lists lease and stale-publish: record in the README section that they were not run for this bump, by ruling, and that neither pins a per-mutant baseline.

- [ ] **Step 1: Offline checks first.** `bun run typecheck && rm -rf packages/*/dist && bun test` is green. No `.al` changed, so no `compile:fixtures`.

- [ ] **Step 2: al-runner, locally (no container).**

```bash
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
```

Read and record the al-runner build line first. A new build is a tool change to note, not a bump regression.

- [ ] **Step 3: Take a coord lease on Cronus28** through the coord protocol. Record the control app version the container reports; this plan does not republish it.

- [ ] **Step 4: Container gates, foreground, one at a time.**

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_CHUNKED=1 bun run itest:chunked
```

- [ ] **Step 5: Release the lease.**

- [ ] **Step 6: Compare with P8.** Any differing verdict, any moved frozen figure, or any baseline difference is a BLOCK: stop, root-cause, file, and report to the orchestrator. Do not re-record, and do not proceed to Task 8.

- [ ] **Step 7: Record.** Fill the spec's `## OUTCOME` for P1 to P8 (verbatim counts, the gates' first lines, the al-runner build, the control app version) and add the line "itest:tables: not run by this lane (ruling Q1); owed by the combined check after the GH-24 re-record and R-236c, which must show 0 grammar-attributable differences (P3)". Fill the README's "### Landing gates" table in the 4.3.0 section's format. Commit each file separately (when allowed):

```bash
git commit -m "spec(TSAL-441): outcome" -- docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md
git commit -m "docs: record the 4.4.1 bump's landing gates" -- packages/engine/vendor/README.md
```

---

### Task 8: Roadmap, only after Task 7 passes

**Files:**
- Modify: `docs/roadmap/R283.md`, `R284.md`, `R288.md`, `R216.md`, `R214.md`
- Create: `docs/roadmap/R<next>.md` (widen the directive guard; ruling Q4)
- Modify (only if Task 6 moved their counts): `docs/roadmap/R285.md`, `R286.md`, `R287.md`
- Regenerate: `ROADMAP.md`

**Interfaces:**
- Consumes: the Task 4 commit (`<vendor>`), the Task 6 commit (`<run003>`), and Task 7's PASS.

Each edit changes the frontmatter `status` and appends a dated section with the evidence. Nothing already written is rewritten.

- [ ] **Step 1: R284 (the over-claim).** `status: "done (<vendor>), closed <date> by tree-sitter-al 4.4.1 (#26, upstream 209d038)"`. Section: the census no longer plants the `[1]...` fragment on the repro (Task 6 Step 1), the baseapp tree-sitter-only call and call-probe records went 34 -> 0 (run 003), the 34 fragment `void-method-call` rows left the census (Task 3), and the open question about compiling `asserterror Buckets;` is moot because that mutant no longer exists (not measured).

- [ ] **Step 2: R283 (the blind spot), ruling Q6.** `status: "closed <date>: superseded by R216"`. Section: the split is gone in 4.4.1 (#26, `209d038`, vendored at `<vendor>`), kind compiler-only 34 -> 0; the 34 call-probe records did not vanish, they are now explained-asserterror records, which is R216's gap. A "how many are open" count accepts this form (CLAUDE.md, the R77/R101 precedent).

- [ ] **Step 3: R288 (parse health).** `status: "done (<vendor>), closed <date> by tree-sitter-al 4.4.1 (#27, upstream 551829e)"`. Section: DC comparable 473 -> 475, unhealthy 0, the two files' new records (0 expected), and Task 3 Step 9's declarative check.

- [ ] **Step 4: R216 stays open.** New status: `"open, LOW; the grammar half (U3, tree-sitter-al #28) is fixed in 4.4.1 (<vendor>): an assignment under asserterror is now assignment_statement, so the LethAL half is one SINGLE_STATEMENT_SLOTS entry plus its census, a SEPARATE follow-on (orchestrator ruling Q2), not part of TSAL-441; run 003: C4's 80 records are explained, not claimed"`. Section: the kind fact the "WIDENED" section relied on no longer holds; `remove-assignment` would see these assignments once the slot is added; `grammar-shapes.test.ts` pins the current `false`; R283's residue now lives here.

- [ ] **Step 5: R214 stays open.** Append `## 4.4.1 (<date>)`: #24/#25 make directive code parse where it used to ERROR (upstream: BC 28.1 Base Application 5 -> 0 error files; locally: the bc281 result or "not measured"), so R214's exposure can only grow on such code; 4.4.1 adds six `preproc_*` kinds (list them) that `isStatementSlot` does not know; the census result on LethAL's corpora; and a pointer to the new guard item. Status: append `; re-checked under 4.4.1 <date>`.

- [ ] **Step 6: File the directive-guard item (ruling Q4).** Run `ls docs/roadmap/` immediately before writing and take the next free id. Content, following `docs/roadmap/_template.md`:
  - title: "The cross-check's directive guard (R2) recognises only `preproc_conditional*`, so directive code under `preproc_split_*`, `preproc_fragmented_*` and 4.4.1's six new `preproc_*` kinds reads as UNEXPLAINED instead of guarded"
  - section: `product-gaps`; status: `open, filed <date>`
  - body: the measurement doc's section 6 note (run 002 recorded it, R2 was fixed before the run so it was not widened after reading the output); the six new kinds; that widening changes the harness's rule, so it needs its own pre-commitment and a re-run of all seven corpora; links to R214, R285, R287 and the measurement doc.

- [ ] **Step 7: R285, R286, R287:** only if Task 6 moved their counts, append a dated line with the new count. Otherwise untouched.

- [ ] **Step 8: Regenerate, check, commit** (when allowed):

```bash
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts
git add ROADMAP.md docs/roadmap/R214.md docs/roadmap/R216.md docs/roadmap/R283.md docs/roadmap/R284.md docs/roadmap/R288.md docs/roadmap/R<next>.md
git commit -m "roadmap: tree-sitter-al 4.4.1 closes R284 and R288, R283 superseded by R216; R216 and R214 re-scoped; file the directive-guard item" -- ROADMAP.md docs/roadmap/R214.md docs/roadmap/R216.md docs/roadmap/R283.md docs/roadmap/R284.md docs/roadmap/R288.md docs/roadmap/R<next>.md
```

Add R285 to R287 to both lists if Step 7 touched them.

- [ ] **Step 9: Hand-off to the orchestrator.** Report: the three landing gates and their results; the local-build comparison; the bc281 search result and locations searched; that `itest:tables` is owed by the combined check after the GH-24 re-record and R-236c, with P3's predicted-unchanged statement for `sandbox-data`; that R216's slot fix is a separate follow-on; and the new guard item's id.

---

## Rulings applied (orchestrator, 2026-09-27)

- **Q1.** The bump lands on `itest:bcdev`, `itest:chunked` and `itest:alrunner`. There is no `itest:tables` RUN 1 route. The `itest:tables` verification waits for the combined check after the GH-24 re-record and R-236c, and the spec carries a predicted-unchanged statement for `sandbox-data` (P3). Roadmap closures happen only after the landing gates pass (Task 8 after Task 7).
- **Q2.** R216's slot fix is a separate follow-on, not part of TSAL-441.
- **Q3.** The lane searches this machine for a BC 28.1 Base Application copy (Task 1 Step 1 lists where). Otherwise it records "not measured".
- **C.** One variable, `BC281`, holds the selected source path or is empty; every optional use is guarded; a found directory is used directly; none found means "not measured" and no fingerprint call.
- **I1.** The fixture tree comparison uses positioned nodes with their ancestor path (`tree-dump.ts`, `tree-check.ts`), so "every change is inside a property value" is decided mechanically; parse health (ERROR, and MISSING through `isMissing`) is checked separately.
- **I2.** The BC 28.1 copy is found and fingerprinted before the spec is committed, and P4 is stated for that recorded build; a build other than upstream's snapshot is exploratory, not a gate.
- **I3.** The #27 bare-value control is its own test (`ExternalAccess = Modify`, `Image = Filter`) and must fail under 4.3.0 on the bare-value assertion; the #24 follow-up asserts the expected continuation shape.
- **Q4.** A roadmap item is filed for widening the directive guard (Task 8 Step 6).
- **Q5.** The RELEASED `tree-sitter-al.wasm` asset is vendored after verifying its SHA-256. A local build is only compared, any difference is recorded, and a difference never fails the bump.
- **Q6.** R283 closes as "closed <date>: superseded by R216".

## Remaining open questions for the orchestrator

1. (Answered by ruling I2: a different 28.1.x build is used, labelled exploratory, and gates nothing.)
2. `probe-fixture-hashes.ts` and the new `identity-keys.ts` scratch script overlap. If identity-key comparison should become a standing bump instrument (as `probe-fixture-hashes.ts` became one in `9961c45`), that is a small follow-on commit. The plan keeps it as scratch.
