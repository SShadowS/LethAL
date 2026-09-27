# GH-06: tree-sitter-al 4.3.0 against the AL compiler parser, seven corpora

Issue: GitHub #6. Pre-commitment: `docs/superpowers/specs/2026-09-27-gh06-crosscheck-precommitment.md`
(committed at `8f1d2e8`, before any control or corpus run). Plan:
`docs/superpowers/plans/2026-09-27-GH-06-tree-sitter-vs-compiler-ast.md`.

This page carries counts, file paths, node kinds, offsets and hand-written AL only. Every AL block
below is a hand-written reproduction with invented names. No text from any corpus is quoted.

## 1. Result in one paragraph

On the six audited families (comparison, additive, multiplicative, logical, unary, call) and two
context probes (call and assignment in statement position), over 12,467 comparable files of 12,469
listed across seven corpora, every delta between tree-sitter-al 4.3.0 and the AL compiler parser is
either explained by a pre-committed rule (directive spans, R214; `asserterror` bodies, R216) or is
one of 261 unexplained site records. All 261 fall into seven clusters (C1 to C7), each reproduced by
a hand-written file. An eighth cluster, P1, is parse health: two files tree-sitter cannot read
cleanly and the compiler can. Four corpora have unexplained records (do-rel2, DC, System Application,
BaseApp); three have none (fixtures, BusinessCentral.Sentinel, BC.History BusinessFoundation). Two
clusters are grammar defects (C1, one construct seen from both sides, and P1), for which two upstream
issues are drafted; C4 is a LethAL gap AND, re-assessed at review, a third grammar issue (U3). A ninth finding, C0 (`UnaryPlusExpression`), was a mapping gap in LethAL's own
audit, fixed in `b645a9b` before the final runs. The other six clusters (C2 to C7) are LethAL's
statement-slot predicate or its directive handling; of those, only C4 also has a grammar cause. Filed: R283, R284,
R285, R286, R287 and R288, plus R216 widened (C4). Predictions: the controls and the fixtures held
exactly; "over-claims only under R2" held for BusinessFoundation and System Application but NOT for
BaseApp (C1); "no reference corpus produces an over-claim that survives the filtered pipeline" did
NOT hold (C1 in BaseApp, C2 in do-rel2).

Run 003 (section 10) repeats this under tree-sitter-al 4.4.1: C1a, C1b and P1 are gone, C4's 80
records are now explained rather than unexplained, and the unexplained total falls from 261 to 45.

## 2. Instrument

| item | value |
| --- | --- |
| harness | `scripts/probe-grammar-crosscheck.ts` with `scripts/lib/grammar-crosscheck.ts`, `scripts/lib/al-kind-mapping.ts`, `scripts/lib/dump-compiler-kinds.ps1` |
| harness commits | logic as pre-committed at `ab2d2fc`; first runs at `8f1d2e8`; compiler dump streamed at `2d2ece1` (proven byte-identical, see below); `UnaryPlusExpression` mapped at `b645a9b`. Every number on this page is from the final runs at `b645a9b` |
| grammar | tree-sitter-al 4.3.0, vendored (`packages/engine/vendor/tree-sitter-al.wasm`), upstream commit `f7af22a`, tag `v4.3.0` |
| compiler parser | `Microsoft.Dynamics.Nav.CodeAnalysis` v18.0.41.45789, through `SyntaxTree.ParseObjectText` (syntax only, no symbols, no preprocessor symbols defined) |
| alc bin | `C:\Users\SShadowS\.vscode\extensions\ms-dynamics-smb.al-18.0.2732683\bin` |

The command, per corpus, foreground, one at a time:

```bash
run() { bun scripts/probe-grammar-crosscheck.ts "$1" --json "$S/gh06-$2.json" > "$S/gh06-$2.txt" 2>&1; echo "$2 exit $?"; head -3 "$S/gh06-$2.txt"; }
run fixtures fixtures
run U:/Git/do-rel2/Cloud do
run U:/Git/DC/Cloud dc
run U:/Git/BusinessCentral.Sentinel sentinel
run U:/Git/BC.History/BusinessFoundation bcf
run "U:/Git/BC.History/System Application" sysapp
run U:/Git/BC.History/BaseApp baseapp
```

`$S` is the session scratchpad. No harness output is committed.

**The streaming change.** The first whole-BaseApp attempt was killed by the host's low-memory
reaper. A split attempt (BaseApp/Test alone, 1,600 files) was stopped at 16 GB private in the
PowerShell compiler dump, which held every syntax node of every file before writing one JSON blob,
so splitting the corpus did not fix it. `2d2ece1` streams the dump as NDJSON instead. It was accepted
only on byte-identical output: 10 of 10 `--json` files and 8 of 8 `.txt` files identical to the
`ab2d2fc` outputs (both controls, both 4.3.0 control rows, the six finished corpora). PowerShell
peaked at 188 MB on System Application afterwards. BaseApp then ran whole in one foreground call.

**Run 002 changes (review r1), and why no number on this page moved.** Three harness changes:
- The compiler dump's FILE IDENTITIES are checked against the list, not only its count
  (`assertDumpCoversList`). The summary's `fileCount` is the list's length, so a file the PowerShell
  loop skipped used to pass the count check; its tree-sitter sites then read as over-claims. Now the
  run throws naming the file. `dump-compiler-kinds.ps1` writes every file record BEFORE parsing, so a
  file whose parse returns null still has its record (no nodes) and is named in `parseErrorFiles`,
  which excludes it as unhealthy: it counts as listed, not as missing.
- The duplicate context-key check runs AFTER the health filter (`checkContextKeys`, pre-commitment
  R1/R5): a duplicate made by error recovery in an excluded file is a warning, one in a comparable
  file still throws.
- The per-run `%TEMP%/gh06-*` list directory is removed on exit, on a thrown error too.

All seven corpora were re-run with these changes. Every `--json` and `.txt` output is byte-identical
to the final run 001 outputs, except `fixtures`, whose JSON differs only in the absolute path of the
worktree it ran from (identical after substituting it). No check threw.

**Tests.** The comparison logic is unit-tested in `scripts/lib/grammar-crosscheck.test.ts`. One test
there, the real PowerShell round trip (a path with backslashes, an apostrophe, a space, non-ASCII
letters and an emoji written by `dump-compiler-kinds.ps1` and read back, no BOM), needs the AL
compiler's DLL and so is OPT-IN: it runs only when `LETHAL_ALC_BIN` names the AL extension's `bin`
directory, and is skipped in the normal `bun test` run.

## 3. Positive controls

Run before any corpus result was read, and re-run at `b645a9b` (neither control file contains a `+`,
so the mapping change cannot touch them; the re-run agrees).

| grammar | file | predicted | measured |
| --- | --- | --- | --- |
| v3.2.1 | `al-kind-mapping-linkprobe.al` | comparable 1; tree-sitter-only UNEXPLAINED `comparison_expression` [218,247] and `call_expression` [235,247]; nothing else; disagree | exactly that, exit 1. Control A PROVEN |
| v4.0.1 | `al-kind-mapping-continue.al` | comparable 1; compiler-only UNEXPLAINED `call_expression` [89,104]; call probe compiler-only at 89; nothing else | exactly that, exit 1. Control B PROVEN |
| 4.3.0 | `al-kind-mapping-linkprobe.al` | agree, exit 0 | agree, exit 0 |
| 4.3.0 | `al-kind-mapping-continue.al` | agree, exit 0 | agree, exit 0 |

Both old grammars produce their known defect through the whole chain, in each direction. So an
empty result from this harness is not an empty pipe.

## 4. Corpus table

"Comparable" is files both parsers read without error (rule R1). Every run's verdict is DISAGREE
(exit 1): the verdict rule counts explained deltas too, so agreement is literal.

| corpus | files | sha256 (first 16) | comparable | tree-sitter unhealthy files (ERROR / MISSING nodes) | compiler parse-error files | unexplained records |
| --- | ---: | --- | ---: | --- | ---: | ---: |
| `fixtures/` | 68 | 7641ce5c9470c8d4 | 68 | 0 (0 / 0) | 0 | 0 |
| `U:/Git/do-rel2/Cloud` | 417 | 9a8e8831449208cc | 417 | 0 (0 / 0) | 0 | 5 |
| `U:/Git/DC/Cloud` | 475 | dcad155c4ecdb38e | 473 | 2 (6 / 0) | 0 | 8 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 9363656ed52020e0 | 67 | 0 (0 / 0) | 0 | 0 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | a56a8435136fc21f | 104 | 0 (0 / 0) | 0 | 0 |
| `U:/Git/BC.History/System Application` | 1,718 | 7fae1831fda03a89 | 1,718 | 0 (0 / 0) | 0 | 8 |
| `U:/Git/BC.History/BaseApp` | 9,620 | 2afad2aa60b13958 | 9,620 | 0 (0 / 0) | 0 | 240 |
| **total** | **12,469** | | **12,467** | **2** | **0** | **261** |

File counts come from `corpusEntries()` (the fingerprint's list, `.dependencies` excluded), and the
harness asserts both parsers parsed exactly that many.

## 5. Per-kind totals, comparable files only (tree-sitter / compiler)

| kind | fixtures | do | dc | sentinel | bcf | sysapp | baseapp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| additive | 20 / 20 | 987 / 987 | 506 / 506 | 5 / 5 | 161 / 161 | 1144 / 1144 | 37975 / 37974 |
| call | 703 / 703 | 14291 / 14289 | 13538 / 13459 | 725 / 725 | 3092 / 3092 | 55961 / 55961 | 1099736 / 1099655 |
| comparison | 117 / 117 | 1780 / 1780 | 2229 / 2219 | 16 / 16 | 201 / 201 | 2451 / 2451 | 71697 / 71696 |
| logical | 3 / 3 | 600 / 600 | 687 / 676 | 2 / 2 | 42 / 42 | 675 / 675 | 18054 / 18054 |
| multiplicative | 12 / 12 | 33 / 33 | 90 / 90 | 0 / 0 | 7 / 7 | 124 / 124 | 16247 / 16247 |
| unary | 32 / 32 | 1024 / 1023 | 1406 / 1396 | 21 / 21 | 94 / 94 | 2100 / 2099 | 32832 / 32829 |
| call in statement position (probe) | 482 / 491 | 8269 / 8267 | 7543 / 7522 | 540 / 541 | 1534 / 1569 | 32955 / 33255 | 801918 / 808378 |
| assignment in statement position (probe) | 207 / 207 | 5291 / 5291 | 5020 / 5016 | 188 / 188 | 398 / 398 | 11042 / 11050 | 201896 / 201993 |

Totals are summaries. Two equal totals are not evidence of agreement; the site diff below is.

## 6. Deltas per corpus

Each cell is guarded / explained / UNEXPLAINED. Guarded is R2 (inside a tree-sitter
`preproc_conditional*` span, i.e. R214). Explained is R3 (an `asserterror` body, i.e. R216).

| corpus | kinds, compiler only | kinds, tree-sitter only | call probe, compiler only | call probe, tree-sitter only | assignment probe, compiler only | assignment probe, tree-sitter only |
| --- | --- | --- | --- | --- | --- | --- |
| fixtures | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 9 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| do | 0 / 0 / 0 | 0 / 0 / **3** | 0 / 0 / 0 | 0 / 0 / **2** | 0 / 0 / 0 | 0 / 0 / 0 |
| dc | 0 / 0 / 0 | 110 / 0 / 0 | 3 / 0 / **8** | 32 / 0 / 0 | 1 / 0 / 0 | 5 / 0 / 0 |
| sentinel | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 1 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| bcf | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 35 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| sysapp | 0 / 0 / 0 | 1 / 0 / 0 | 9 / 291 / 0 | 0 / 0 / 0 | 0 / 0 / **8** | 0 / 0 / 0 |
| baseapp | 0 / 0 / **34** | 86 / 0 / **34** | 394 / 6078 / **56** | 34 / 0 / **34** | 17 / 0 / **82** | 2 / 0 / 0 |

The fixtures row is the pre-commitment's prediction to the digit: six kinds agree, and the 9-site
call-probe gap is 9 explained, 0 unexplained.

**"Guarded" is understated in every corpus, in both directions.** The R2 guard recognises only
`preproc_conditional*` spans. tree-sitter-al 4.x also builds `preproc_split_*` and
`preproc_fragmented_*` containers for directive code (C2, C5, C6, C7 below). Recorded, not fixed: R2
was defined by `preproc_conditional*` before the run, and changing it after reading the output would
be editing the rule to fit the data. A future run should widen it under a new pre-commitment.

## 7. Clusters

Every one of the 261 unexplained records was assigned by a mechanical rule: the tree-sitter node
that starts at the site offset, its field name in its parent, and its parent's kind (for C1, plus
the token before the site). That covers every site, not a sample. Nothing was left over, and no
cluster is UNRESOLVED: all eight minimised to a hand-written file. Each reproduction is committed
under `scripts/lib/` and reproduces with `bun scripts/probe-grammar-crosscheck.ts <file>`; the
offsets below are that file's.

| cluster | direction | kinds / probe | records | corpora | cause | item |
| --- | --- | --- | ---: | --- | --- | --- |
| C0 | tree-sitter only | unary | (6 before the fix) | baseapp | LethAL mapping | none, fixed `b645a9b` |
| C1a | compiler only | call kind + call probe | 34 + 34 | baseapp | grammar | R283 |
| C1b | tree-sitter only | call kind + call probe | 34 + 34 | baseapp | grammar | R284 |
| C2 | tree-sitter only | unary + call kinds, call probe | 3 + 2 | do | LethAL directive framing (R214) | R285 |
| C3 | compiler only | call probe | 8 | dc | LethAL slot list | R286 |
| C4 | compiler only | assignment probe | 80 | sysapp 8, baseapp 72 | LethAL slot list (R216) | R216, widened |
| C5 | compiler only | call + assignment probes | 20 + 8 | baseapp | LethAL slot list | R287 |
| C6 | compiler only | call probe | 2 | baseapp | LethAL slot list | R287 |
| C7 | compiler only | assignment probe | 2 | baseapp | LethAL slot list | R287 |
| P1 | parse health | tree-sitter ERROR | 2 files, 6 nodes | dc | grammar | R288 |

The record total is 5 (do) + 8 (dc) + 8 (sysapp) + 240 (baseapp) = 261.

### C0. `UnaryPlusExpression` was unmapped (a mapping gap, no item)

The first whole BaseApp run printed one UNRULED compiler kind, `UnaryPlusExpression`, and exited 3
(rule R4). `f11a9fc` ruled it a DEFERRAL in `DELIBERATELY_UNMAPPED`. That was wrong: `unary_expression`
is one of the six audited families, `UnaryNotExpression` and `UnaryMinusExpression` were already
mapped to it, and tree-sitter gives `unary_expression` for `+X` too. Leaving one spelling of an
audited family unmapped manufactures a tree-sitter-only "over-claim" at every unary plus. `b645a9b`
maps it, replacing the deferral. It is a correction inside an audited family, not a widening.

Red and green check on a hand-written file (four unary sites, two of them `+`): with the deferral,
unary 4 / 2 and DISAGREE; with the mapping, 4 / 4 and AGREE.

Effect: all seven corpora were re-run at `b645a9b`. Only BaseApp changed. Its six tree-sitter-only
unexplained `unary_expression` sites all began with a unary plus and all vanished; tree-sitter-only
guarded fell 94 to 86 (eight unary-plus sites inside directive spans, now matched on both sides);
unary totals went from 32832 / 32815 to 32832 / 32829. The other six corpora are byte-identical in
every bucket.

### C1a and C1b. `asserterror` before a call on an array element (grammar, U1)

One construct, two directions, so two items (the triage key includes direction). tree-sitter-al
4.3.0 reads `asserterror Buckets[1].Delete(true);` as `asserterror Buckets` followed by a separate
statement `[1].Delete(true)` whose receiver is a list literal. No ERROR or MISSING node. The compiler
reads one call on an indexed receiver. Same end offset, different start: a matched pair per site.

`scripts/lib/al-kind-mapping-asserterror-index.al`:

```al
codeunit 50001 "Indexed Receiver Probe"
{
    procedure Run()
    var
        Buckets: array[3] of Record "Integer";
    begin
        asserterror Buckets[1].Delete(true);
        asserterror Buckets[2].Validate(Number, Buckets[1].Number);
        Buckets[3].Delete(true);
    end;
}
```

Harness: compiler-only `call_expression` [147,170] and [192,238]; tree-sitter-only
`call_expression` [154,170] and [199,238]; the call probe shows the same four positions. Line 9,
with no `asserterror`, agrees.

Corpus: BaseApp 34 pairs, all under `BaseApp/Test` (ERMDeleteDocuments 12, ERMRSPackageBaseOperations
8, MarketingContacts 4, ERMPurchaseBlanketOrder 3, ERMSalesBlanketOrder 3, ServiceWarrantyandDiscounts
2, PriceListsUI 1, ERMFixedAssets 1).

- **C1a, BLIND SPOT** (compiler only): all 34 compiler-only sites are inside a procedure body, so
  executable. Filed as **R283** (product-gaps).
- **C1b, OVER-CLAIM** (tree-sitter only): the census on the reproduction plants
  `lethal.void-method-call` deleting `[1].Delete(true)` (line 7) and
  `[2].Validate(Number, Buckets[1].Number)` (line 8), each an exact before-text match with the
  tree-sitter-only site, with no DISPLACED or NOT-CARRIER mark. Other census lines on those lines:
  `flip-boolean-literal` on `true` (a literal inside the site, a different span) and `empty-block`
  on line 6 (the whole body). The pipeline check SURVIVES. Filed as **R284** (correctness-risks).
  OPEN: the mutant leaves `asserterror Buckets;`, and whether `alc` rejects that or it compiles and
  scores was not measured.

Both are low cost today: `asserterror` is test-only in Microsoft's source, and LethAL mutates the
target app, not its tests.

### C2. A `case` label split by `#if` / `#else` (LethAL directive framing)

When the `#if` and `#else` arms of a `case` share one branch body, tree-sitter builds
`preproc_split_case_extended`. The inactive arm's statements are ordinary nodes under it, so they are
claimed. The R2 guard only knows `preproc_conditional*`, so they are UNEXPLAINED rather than guarded.
Not a grammar defect: parsing both arms is by design; the risk is R214's.

`scripts/lib/al-kind-mapping-split-case.al`:

```al
codeunit 50002 "Split Case Probe"
{
    procedure Route(Mode: Integer; Ready: Boolean)
    begin
        case Mode of
#if FASTPATH
            1:
                begin
                    if not Ready then
                        Prepare(Mode)
                    else
                        Launch(Mode);
                end;
            2:
#else
            1, 2:
#endif
                begin
                    Launch(Mode);
                end;
            3:
                Prepare(Mode);
        end;
    end;

    local procedure Prepare(Mode: Integer)
    begin
    end;

    local procedure Launch(Mode: Integer)
    begin
    end;
}
```

Harness: tree-sitter-only `unary_expression` [191,200], `call_expression` [230,243] and [293,305];
call probe tree-sitter-only at 230 and 293; guarded 0. Container `preproc_split_case_extended`
[118,450].

Corpus: do-rel2 `Al/Codeunit/Codeunit 6175280 CDO E-Mail.al`, [5764,5784] (unary), [5815,5856] and
[5908,5933] (call), call probe at 5815 and 5908. App code.

Pipeline check: SURVIVES. `remove-not` on line 9, `void-method-call` on lines 10 and 12, each an exact
before-text match. The census also plants `empty-block` on the inactive arm's `begin ... end` (line
8): not an audited kind, same risk. All four sit in code the compiler does not build, so they can
never be killed. Filed as **R285** (correctness-risks), linking R214.

### C3. A call that is the body of `with ... do` (LethAL slot list)

`with_statement.body` is not in `SINGLE_STATEMENT_SLOTS`. tree-sitter shapes it correctly.

`scripts/lib/al-kind-mapping-with-body.al`:

```al
codeunit 50003 "With Body Probe"
{
    procedure Tag(var Bin: Record "Integer")
    begin
        with Bin do
            Stamp(Number);
        if Bin.Number > 0 then
            with Bin do
                Stamp(Number);
    end;

    local procedure Stamp(Value: Integer)
    begin
    end;
}
```

Harness: call probe compiler-only at 122 and 208; kinds agree.

Corpus: DC `Modules/Approvals/Codeunits/CDCApprovalManagement.Codeunit.al`, offsets 19114, 22211,
25726, 30082, 99105, 100071, 106819, 136893. App code, so real lost sites. Filed as **R286**
(product-gaps), linking R217.

### C4. An assignment that is the body of `asserterror` (R216, widened)

Same container as R216, `asserterror_statement.body`. The new facts: assignments are lost too, and
tree-sitter spells that body `assignment_expression`, not `assignment_statement`. That is an
upstream grammar issue as well as a LethAL gap (drafted as U3, assessed at review in run 002, see
below). For the audit, rule R3 matches the probe's kind
(`assignment_statement`), so it cannot explain these, and `remove-assignment` targets
`assignment_statement` only, so adding the slot alone would still miss them.

`scripts/lib/al-kind-mapping-asserterror-assign.al`:

```al
codeunit 50004 "Assert Assign Probe"
{
    procedure Check()
    var
        Outcome: Integer;
    begin
        asserterror Outcome := Compute(7);
        asserterror Compute(8);
        Outcome := Compute(9);
    end;

    local procedure Compute(Seed: Integer): Integer
    begin
        exit(Seed);
    end;
}
```

Harness: assignment probe compiler-only UNEXPLAINED at 125; the call beside it is
explained-asserterror 1, as R3 expects.

Corpus: System Application 8 (HttpExceptionTests 5, CustomDimensionsTest 2, RetentionPeriodTest 1);
BaseApp 72 across 30 files, all under `BaseApp/Test`, none in `Source`.

**Upstream assessment (run 002).** The first submission called the kind difference "structurally
right". Review asked for it to be checked, and it does not hold. tree-sitter-al 4.3.0 (`f7af22a`)
defines `asserterror_statement.body` as `choice($._expression, $.code_block)`; `node-types.json`
lists no statement kind for that field. Elsewhere an assignment is `assignment_statement` (through
`_statement_inner`); `assignment_expression` exists in `_expression` "for asserterror and other
contexts". The AL compiler's `AssertErrorStatement` holds a statement. A hand-written repro shows
the second symptom of the same rule: `asserterror if Outcome = 2 then Error('two');` and
`asserterror exit;` each parse as an `asserterror_statement` with NO body followed by a sibling
`if_statement` / `exit_statement`, with no ERROR node, where the compiler's parser builds
`AssertErrorStatement > IfStatement` / `> ExitStatement` with no error. That symptom was not seen
in any corpus: no `asserterror` in the 16,898 BC.History files is followed by `if`, `exit`, `case`,
`repeat`, `while`, `for`, `foreach`, `with` or `begin`, and the cross-check cannot see it (run on the
repro, the harness reports only the assignment; the detached `if` keeps its position, so the call in
its `then` branch agrees on both sides). Drafted as upstream
issue U3; R216 records it. R216 stays open for the LethAL side: a fixed grammar still needs the
slot in `SINGLE_STATEMENT_SLOTS`.

**A stated departure from "one new item per cluster".** C4 WIDENS **R216** rather than filing a new
row. The pre-commitment says one item per container, and the container is R216's; a second row would
split one fix across two places. The cost: C4 is less visible than a new row would be.

### C5, C6, C7. Split-directive `if` containers (LethAL slot list)

BaseApp retires code by putting `#if not CLEAN<n>` around an `if` header while the last branch
statement sits after `#endif`, shared by both builds. tree-sitter builds split containers whose
fields are not statement slots:

- C5: `preproc_split_if_else_statement.then_branch` / `.else_branch`. BaseApp 20 call + 8 assignment.
- C6: `preproc_split_if_statement.then_branch`. BaseApp 2 call.
- C7: statements as direct children of `preproc_fragmented_else_tail`. BaseApp 2 assignment.

`scripts/lib/al-kind-mapping-split-if.al` (C5):

```al
codeunit 50005 "Split If Probe"
{
    procedure Apply(Legacy: Boolean; var Total: Integer)
    begin
#if not RETIRED
        if Legacy then
            Notify(Total)
        else
#endif
            Notify(Total + 1);
#if not RETIRED
        if Legacy then
            Total := 1
        else
#endif
            Total := 2;
    end;

    local procedure Notify(Value: Integer)
    begin
    end;
}
```

Harness: call probe compiler-only at 152 and 198; assignment probe compiler-only at 268 and 311.

`scripts/lib/al-kind-mapping-split-if-no-else.al` (C6):

```al
codeunit 50008 "Split If No Else Probe"
{
    procedure Apply(Legacy: Boolean; Total: Integer)
    begin
#if not RETIRED
        if Legacy then
#endif
            Notify(Total);
    end;

    local procedure Notify(Value: Integer)
    begin
    end;
}
```

Harness: call probe compiler-only at 163.

`scripts/lib/al-kind-mapping-split-else-tail.al` (C7):

```al
codeunit 50009 "Split Else Tail Probe"
{
    procedure Apply(Legacy: Boolean; var Total: Integer; var Extra: Integer)
    begin
#if not RETIRED
        if Legacy then begin
            Total := 1;
            Extra := 1;
        end else begin
#endif
            Total := 2;
            Extra := 2;
#if not RETIRED
        end;
#endif
    end;
}
```

Harness: assignment probe compiler-only at 263 and 287. The `then` arm's two assignments are in a
`statement_block` and agree.

Corpus: all 32 are under `BaseApp/Source/Base Application`, none in tests. C5: WhseProductionRelease
8, MfgCreateInvtPickMovement 4, ProductionOrder 2, MfgCreateInventoryPutaway 2,
MfgGetOutboundSourceDocs 2, MfgWhseSourceCreateDocument 2 (calls); AccScheduleOverview 4,
CalcConsumption 2, ProductionJournalMgt 2 (assignments). C6: ServiceStatistics.Page.al [37449],
XMLBufferWriter.Codeunit.al [9520]. C7: ProdOrderComponent.Table.al [19760], [20088], in a field
trigger. Every site is inside a procedure or trigger body. One container family, so ONE item:
**R287** (product-gaps), linking R214 and R217.

### P1. `Type = Type::X` as a page property value (grammar, U2)

A page control property whose value is a comparison starting with the bare identifier `Type` takes
the `link_value` path and emits an ERROR node spanning `Type::`. `Kind` or a qualified
`Rec.Type` parse clean, as `comparison_expression`; no other names were tried. Close to the inverse of closed upstream #20.

`scripts/lib/al-kind-mapping-type-property.al`:

```al
page 50006 "Mode Card Probe"
{
    PageType = Card;
    SourceTable = "Mode Probe";

    layout
    {
        area(Content)
        {
            field(Kind; Rec.Kind)
            {
                ApplicationArea = All;
                Enabled = Kind = Kind::Alpha;
            }
            field(Type; Rec.Type)
            {
                ApplicationArea = All;
                Visible = Type = Type::Alpha;
            }
        }
    }
}
```

Harness: listed 1, comparable 0, the file excluded with tree-sitter ERROR 1 MISSING 0, compiler
clean, verdict inconclusive (exit 2). Scratch variants (not committed) also error on
`Editable = Type <> Type::Beta;` and do not error on `Visible = Rec.Type = Rec.Type::Alpha;` or
`Visible = Kind = Kind::Beta;`.

Corpus: DC `Modules/Purchase Contracts/Base/src/Pages/CDCPurchContractCard.Page.al` (4 ERROR) and
`CDCPurchContrArchCard.Page.al` (2 ERROR). Zero unhealthy files elsewhere. Filed as **R288**
(correctness-risks).

### Upstream

C1 and P1 are grammar defects. Issues for `SShadowS/tree-sitter-al` are drafted as U1 (C1) and U2
(P1) in GH-06's submit note, checked against open #24 and #25 and closed #20 to #23; neither
duplicates them. Numbers are assigned at filing. C4 has a grammar cause too (the `asserterror` body
takes an expression, not a statement), drafted as U3 in run 002 and checked against the same issue
list. C2, C3 and C5 to C7 are not grammar defects.

## 8. Corrections to earlier claims

- **D1, stale compiler path.** The harness hard-coded AL extension 18.0.2668733, which is no longer
  installed, and died looking for the compiler DLL. It now finds `alc` newest first (R167).
- **D2, MISSING nodes invisible.** The harness counted only ERROR nodes. A MISSING node carries the
  type of the token it stands in for, never the name `MISSING`, so `probe-grammar-corpus.ts`'s
  MISSING column was always 0. Both now read `isMissing` through one `parseHealth()` helper.
- **D3, `.dependencies` included.** Both parsers recursed into `.dependencies`, while the corpus
  fingerprint excludes it, so the harness measured a different file set than the hash named
  (do-rel2/Cloud: 554 files, 137 under `.dependencies`; DC/Cloud: 1,135, 660 under it). Both parsers
  now read the fingerprint's list, and the harness asserts both parsed exactly that many (and, since
run 002, that the compiler dump recorded exactly those files).
- **D4, no corpus identity.** The harness now prints the fingerprint first (R187).
- **D5, one-sided directive split.** Only tree-sitter-only deltas were checked against `#if` spans,
  so a compiler-only site inside a directive was reported as a blind spot. Containment now applies in
  both directions.
- **The ASCII-only offset limit was false.** `dump-compiler-kinds.ps1` said offsets match tree-sitter
  only for ASCII source. web-tree-sitter parsing a JS string reports UTF-16 code-unit offsets, and
  .NET `TextSpan` is UTF-16 too, so they agree on non-ASCII source (measured: a comment holding
  Danish letters and an emoji gave `startIndex` 83, `indexOf` 83, byte offset 88). A unit test pins it.
- **The r1 plan compared context per file, by totals.** That cancels: a lost site and an extra site
  in the same file sum to zero and read as agreement. R217 had already seen the same cancellation at
  corpus level. r2 compares context at matched site POSITIONS (`file|probe|start`), and per-file and
  per-corpus totals are summaries only. Start, not end: the compiler's `AssignmentStatement` span
  includes the trailing `;` and tree-sitter's does not.
- **Task 6 said BaseApp had one unexplained `unary_expression`.** Its own JSON held six. All six
  began with a unary plus and were C0.
- **`f11a9fc` ruled `UnaryPlusExpression` a deferral.** Wrong; replaced by the mapping in `b645a9b`
  (C0).

## 9. What this does not cover

**Compiler kinds deliberately not compared** (`DELIBERATELY_UNMAPPED` in `scripts/lib/al-kind-mapping.ts`).
The executable ones, which a mutation operator could care about:
- Deferrals, named as such in the file: `InListExpression` (`X in [...]`), `ArrayIndexExpression`,
  `ThisExpression`, `AsExpression`, `IsExpression`, `ConditionalExpression`.
- Also executable and not compared: `MemberAccessExpression`, `LiteralExpression`,
  `ParenthesizedExpression`, `OptionAccessExpression`, and the statement kinds `AssignmentStatement`,
  `IfStatement`, `ExitStatement` (assignments are covered by the context probe only).

The rest are refusals on the declarative surface (table relations, filters, `CalcFormula`, report and
query links, sorting and ordering, and two compiler-internal name-or-literal wrappers), where R135
refuses mutation sites anyway.

**Files not compared.** The two DC pages in P1 were removed from both sides by R1, so none of their
sites were compared, in any family or probe. No other file in any corpus was excluded.

**Other limits.**
- Only the no-symbols build was measured. Every "inactive arm" above is inactive because no
  preprocessor symbol was defined; a project that defines `CLEAN<n>` symbols builds different arms.
- "Guarded" counts are understated (section 6), so some R214 exposure sits in the unexplained
  clusters above rather than in the guarded column.
- The compile of C1b's planted mutant (`asserterror Buckets;`) was not measured.
- Every "zero" and "agree" on this page is scoped to the six audited families and two context probes,
  on comparable files. It is never "zero operator losses".

## 10. Run 003: tree-sitter-al 4.4.1 (2026-09-27)

Pre-commitment: `docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md`, P6 and P7
(its AMENDMENT 1 leaves P6 unchanged). Plan: `docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md`,
Task 6.

| item | value |
| --- | --- |
| grammar | tree-sitter-al 4.4.1, vendored, upstream commit `7819df5` (tag `v4.4.1`), release asset sha256 `cd6e347e8bf4171c4bd4302543bdb543451be307a34fd0c7f95ca56a085ed099` |
| harness | unchanged since run 002: last touched at `3e6ce66` (run 002's review changes), mapping as at `b645a9b` |
| compiler parser | unchanged: `Microsoft.Dynamics.Nav.CodeAnalysis` v18.0.41.45789, alc bin `ms-dynamics-smb.al-18.0.2732683` |
| command | run 002's (section 2), outputs named `gh06r3-<corpus>`, vendored grammar, no grammar argument |

### 10.1 Controls (run and read before any corpus output)

Each control passes an explicit grammar path. The 4.3.0 rows are what make an empty 4.4.1 row mean
"fixed" and not "the harness cannot see it".

| grammar | file | predicted (P7) | measured |
| --- | --- | --- | --- |
| v3.2.1 (tag's wasm) | `al-kind-mapping-linkprobe.al` | as run 002: tree-sitter-only UNEXPLAINED `comparison_expression` [218,247], `call_expression` [235,247] | exactly that, exit 1 |
| v4.0.1 (tag's wasm) | `al-kind-mapping-continue.al` | as run 002: compiler-only UNEXPLAINED `call_expression` [89,104]; call probe compiler-only at 89 | exactly that, exit 1 |
| 4.3.0 | `al-kind-mapping-asserterror-index.al` | compiler-only `call_expression` [147,170], [192,238]; tree-sitter-only [154,170], [199,238] | exactly that (kinds and call probe), exit 1 |
| 4.3.0 | `al-kind-mapping-asserterror-assign.al` | assignment probe compiler-only UNEXPLAINED at 125 | exactly that, exit 1 |
| 4.3.0 | `al-kind-mapping-type-property.al` | comparable 0, tree-sitter unhealthy 1, exit 2 | exactly that (ERROR 1, MISSING 0), exit 2 |
| 4.4.1 | `al-kind-mapping-asserterror-index.al` | no kind delta; call probe compiler-only at 147 and 192 explained-asserterror; 0 unexplained | exactly that (offsets read from `--json`), exit 1 |
| 4.4.1 | `al-kind-mapping-asserterror-assign.al` | assignment compiler-only at 125 explained-asserterror; 0 unexplained | exactly that, exit 1 |
| 4.4.1 | `al-kind-mapping-type-property.al` | comparable 1, agree, exit 0 | comparable 1, `comparison_expression` 2 / 2, AGREE, exit 0 |

R284 pipeline check: `census-fixture-mutants.ts` on a directory holding only
`al-kind-mapping-asserterror-index.al`, under 4.4.1, plants 4 mutants (`empty-block` on the body,
`flip-boolean-literal` on lines 7 and 9, `void-method-call` on line 9's un-asserted
`Buckets[3].Delete(true)`). No row's before-text starts with `[`. Under 4.3.0 it planted the two
`[...]` fragments (section 7, C1b).

### 10.2 Corpus table (section 4 layout)

Every fingerprint equals the pre-commitment's table and run 002's. Every verdict is DISAGREE (exit 1).

| corpus | files | sha256 (first 16) | comparable | tree-sitter unhealthy files | compiler parse-error files | unexplained records (run 002 -> run 003) |
| --- | ---: | --- | ---: | --- | ---: | ---: |
| `fixtures/` | 68 | 7641ce5c9470c8d4 | 68 | 0 | 0 | 0 -> 0 |
| `U:/Git/do-rel2/Cloud` | 417 | 9a8e8831449208cc | 417 | 0 | 0 | 5 -> 5 |
| `U:/Git/DC/Cloud` | 475 | dcad155c4ecdb38e | **475** (was 473) | **0** (was 2, 6 ERROR) | 0 | 8 -> 8 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 9363656ed52020e0 | 67 | 0 | 0 | 0 -> 0 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | a56a8435136fc21f | 104 | 0 | 0 | 0 -> 0 |
| `U:/Git/BC.History/System Application` | 1,718 | 7fae1831fda03a89 | 1,718 | 0 | 0 | 8 -> **0** |
| `U:/Git/BC.History/BaseApp` | 9,620 | 2afad2aa60b13958 | 9,620 | 0 | 0 | 240 -> **32** |
| **total** | **12,469** | | **12,469** | **0** | **0** | **261 -> 45** |

BaseApp ran whole, in one call (625 s). The census's wasm-memory limit (R292) did not apply to the
cross-check.

Per-kind totals (section 5) moved in two places only. DC, because its two re-admitted pages are now
compared: additive 507 / 507, call 13589 / 13510, comparison 2249 / 2239, logical 711 / 700,
multiplicative 90 / 90, unary 1413 / 1403, call probe 7574 / 7553, assignment probe 5040 / 5036.
BaseApp's call probe, tree-sitter side, 801918 -> 801884 (the 34 fragment calls of C1b are gone).
Every other BaseApp total is unchanged.

### 10.3 Deltas per corpus (section 6 layout)

Each cell is guarded / explained / UNEXPLAINED, run 003. A cell that moved shows run 002's value in
brackets.

| corpus | kinds, compiler only | kinds, tree-sitter only | call probe, compiler only | call probe, tree-sitter only | assignment probe, compiler only | assignment probe, tree-sitter only |
| --- | --- | --- | --- | --- | --- | --- |
| fixtures | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 9 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| do | 0 / 0 / 0 | 0 / 0 / **3** | 0 / 0 / 0 | 0 / 0 / **2** | 0 / 0 / 0 | 0 / 0 / 0 |
| dc | 0 / 0 / 0 | 110 / 0 / 0 | 3 / 0 / **8** | 32 / 0 / 0 | 1 / 0 / 0 | 5 / 0 / 0 |
| sentinel | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 1 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| bcf | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 35 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| sysapp | 0 / 0 / 0 | 1 / 0 / 0 | 9 / 291 / 0 | 0 / 0 / 0 | 0 / 8 / 0 [0 / 0 / 8] | 0 / 0 / 0 |
| baseapp | 0 / 0 / 0 [0 / 0 / 34] | 86 / 0 / 0 [86 / 0 / 34] | 394 / 6112 / **22** [394 / 6078 / 56] | 34 / 0 / 0 [34 / 0 / 34] | 17 / 72 / **10** [17 / 0 / 82] | 2 / 0 / 0 |

The comparison against run 002 was made on the records, not on these counts. For every corpus and
every bucket, the set of `file|kind|start|end` records was diffed against run 002's `--json`. No
record was added to any bucket in any corpus. The only records that left a bucket are the ones in
brackets above, and each one that left UNEXPLAINED for EXPLAINED is the same record (sysapp 8
assignment; baseapp 34 call and 72 assignment, set-equal). DC's two re-admitted pages added no
record to any bucket.

### 10.4 Clusters, 4.3.0 -> 4.4.1

The remaining 45 records were re-assigned with run 002's mechanical rule (the tree-sitter node at the
site offset, its field name, its parent's kind, parsed under 4.4.1). All 45 fit an existing cluster.
No record fits none, so there is no new finding and no new reproduction.

| cluster | records, 4.3.0 -> 4.4.1 | cause | item |
| --- | --- | --- | --- |
| C1a | 34 + 34 -> **0** | grammar, fixed upstream | R283 |
| C1b | 34 + 34 -> **0** | grammar, fixed upstream | R284 |
| C2 | 3 + 2 -> 3 + 2 | LethAL directive framing | R285 |
| C3 | 8 -> 8 | LethAL slot list | R286 |
| C4 | 80 unexplained -> **80 explained** (sysapp 8, baseapp 72) | grammar kind fixed upstream; LethAL slot still missing | R216 |
| C5 | 20 + 8 -> 20 + 8 | LethAL slot list | R287 |
| C6 | 2 -> 2 | LethAL slot list | R287 |
| C7 | 2 -> 2 | LethAL slot list | R287 |
| P1 | 2 files, 6 ERROR -> **0** | grammar, fixed upstream | R288 |

- **C1a and C1b are gone** through upstream `209d038` (issues #26 and #28). `asserterror_statement.body`
  is now a statement, so `asserterror Buckets[1].Delete(true);` is one call on an indexed receiver.
  The compiler-only call becomes explained-asserterror (rule R3), and the tree-sitter-only fragment no
  longer exists.
- **C4 is now explained, not claimed**, through the same commit `209d038`. The body of
  `asserterror X := 1` is now an `assignment_statement`, the kind rule R3 matches. The records did
  not disappear. They moved to the explained column, because LethAL still has no statement slot for
  `asserterror_statement.body` (R216), so no operator claims them yet.
- **P1 is gone** through upstream `551829e` (issue #27). A contextual keyword at the start of a
  property value lexes as a name, so `Visible = Type = Type::Alpha;` is a `comparison_expression` with
  no ERROR node.

### 10.5 bc281, a first measurement (exploratory, gates nothing)

The W1 Base Application source of BC build `28.1.49838.50244` (not upstream's `28.1.49838.50268`),
extracted to the session scratchpad: 8,024 files, sha256 `b019f94027818d93`, equal to the
pre-commitment's table. It has no run 002 row, so it is not part of the comparison above.

Comparable 8,024 of 8,024, tree-sitter unhealthy 0, compiler parse errors 0. Kinds: compiler-only
0 / 0 / 0, tree-sitter-only 80 / 0 / 0. Call probe: compiler-only 364 / 0 / 22, tree-sitter-only
34 / 0 / 0. Assignment probe: compiler-only 17 / 0 / 10, tree-sitter-only 2 / 0 / 0. The 32
unexplained records are C5 (20 call + 8 assignment), C6 (2) and C7 (2) by the same mechanical rule,
in the same file names as BaseApp's. The corpus holds no tests, so the explained-asserterror column
is 0 everywhere.

### 10.6 What this does not cover

- The R2 guard still recognises only `preproc_conditional*` spans. 4.4.1 adds six more `preproc_*`
  kinds (`preproc_operand_prefix`, `preproc_split_case_end_branch`,
  `preproc_split_case_statement_end`, `preproc_split_report_brace_close`,
  `preproc_split_report_dataitem_header`, `preproc_split_report_dataitem_open_over_endif`), so the
  "guarded" column is understated for the same reason as in section 6, now for more containers.
  Recorded, not fixed: widening R2 needs its own pre-commitment. The roadmap item for it is filed by
  this plan's Task 8.
- C4's 80 records are explained, not claimed. R216's statement slot is still missing, so no
  mutation operator plants a mutant at an `asserterror` assignment body yet.
- Everything in section 9 still holds, apart from the two DC pages, which are now compared.
