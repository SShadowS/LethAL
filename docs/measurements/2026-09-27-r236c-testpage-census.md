# R-236c: TestPage scan census over the GH-06 corpora

Task: `.superpowers/sdd/2026-09-27-R-236c-testpage-pre-refusal/task-2-brief.md`. Harness:
`scripts/r236c-testpage-census.ts`. Offline, no container.

This page carries corpus names, file paths, procedure and test names, counts and offsets only. No
source text is quoted.

## 1. Result in one paragraph

The first run (at `e7d397a`) scored nine corpora and **threw** on the tenth, `BC.History/BaseApp`
(9,620 `.al` files), with web-tree-sitter's `Aborted()`. The cause was the scanner keeping every parse
tree alive, which filled the wasm heap (section 2). After the fix (`e01e88c`, each tree deleted once
its facts are read), the second run completes on all ten corpora. Nine have zero loud errors. BaseApp
now scores 40,291 tests and refuses 11,098, but reports **127 loud errors**, all of one shape: a test
the discovery finds but the scanner does not see, because it sits in an `#if not CLEANnn` region the
grammar attaches to the codeunit's global `var` section (section 4). Those errors predate the fix
(section 4), and they are the brief's stop condition, so this goes back to the orchestrator.

## 2. Root cause of the first run's abort

Measured with a scratch probe that parses every BaseApp file in order and samples the wasm heap (the
module's `WebAssembly.Memory` buffer size) every 500 files.

| mode | heap at file 0 | file 4,000 | file 8,000 | file 9,000 | end |
| --- | --- | --- | --- | --- | --- |
| keep every tree (old scanner) | 32 MB | 591 MB | 1,263 MB | 2,048 MB | **aborts at file 9,007**, 164.6 M chars parsed |
| delete each tree after use | 32 MB | 32 MB | 32 MB | 32 MB | completes, 9,620 files, 196.3 M chars |

Kept trees cost about 12.5 bytes of wasm heap per source character, and 2,048 MB is the heap's hard
ceiling, so the abort is heap exhaustion, not a bad file. The fix extracts every fact the traversal
needs (procedures, scopes, call sites in source order, parse damage) into plain objects per file and
deletes the tree before the next file.

The operator-site census hit the same class on the same corpus (R292, filed on the TSAL-441 branch:
`scripts/census-operator-sites.ts` keeps every tree for one shared semantic context and aborts between
file 9,000 and 9,500). That item is a separate fix; only the TestPage scanner changed here.

## 3. Census table (second run, at `e01e88c`)

| corpus | files | tests | refused | loud errors | ms |
| --- | --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 68 | 1 | 0 | 39 |
| `fixtures/sandbox-tests` | 1 | 2 | 0 | 0 | 7 |
| `fixtures/sandbox-hang-tests` | 1 | 5 | 0 | 0 | 8 |
| `fixtures/sandbox-harden-tests` | 1 | 6 | 0 | 0 | 5 |
| `U:/Git/do-rel2/Cloud` | 554 | 0 (no tests) | 0 | 0 | 781 |
| `U:/Git/DC/Cloud` | 1135 | 0 (no tests) | 0 | 0 | 2471 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 54 | 0 | 0 | 65 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | 89 | 19 | 0 | 195 |
| `U:/Git/BC.History/System Application` | 1718 | 1889 | 209 | 0 | 6718 |
| `U:/Git/BC.History/BaseApp` | 9620 | 40291 | 11098 | **127** | 472935 |

Every corpus that the first run scored gives the same files, tests and refused counts in the second.
`do-rel2/Cloud` and `DC/Cloud` are the main app trees, not their `Test` siblings, so zero discovered
tests is expected there: recorded as "no tests", not as a pass. Refused/tests: BusinessFoundation
19/89 (21.3%), System Application 209/1,889 (11.1%), BaseApp 11,098/40,291 (27.5%).

## 4. BaseApp's 127 loud errors

All 127 read `<codeunit>.<test> (codeunit <id>) was discovered but the parser found it 0 time(s) as
a parameterless procedure`. By codeunit: 137308 (52), 136130 (51), 134393 (11), 134098 (7),
134395 (2), and one each in 134106, 134394, 134287 and 134605. First named examples: `ERM Sales
Subform.InvoiceAddingLinesUpdatesTotals` (134393), `ERM Document Totals
UT.SalesUpdateTotalsControlsUpdateTotals` (134395).

Shape, checked on 134393: the test sits inside an `#if not CLEAN26` region that begins right after the
codeunit's global `var` section. tree-sitter-al parses that region as a `preproc_conditional_var`
INSIDE the `var_section`, so the procedure's path is `codeunit_declaration > declaration_body >
var_section > var_body > preproc_conditional_var > procedure`, and the file has no parse error. The
scanner collects procedures only from the body's direct members (with `#if` wrappers flattened), so it
never sees these. It fails loud, which is the designed, safe outcome: nothing is sent unclassified.

These errors are not caused by the memory fix. On `BaseApp/Test` alone (1,600 files, which fits in the
heap under the old code), the old scanner (`e7d397a`) and the new one give byte-identical results:
40,291 tests, the same 11,098 refused keys with the same reasons, and the same 127 errors.

## 5. Decision (Step 3 of the brief)

BaseApp now completes, but `loudErrors` is 127 on a real corpus. That is the stop condition: the
table goes to the orchestrator, and Task 4 (wiring the scan into the run path) does not start until it
rules on the `var`-attached `#if` shape.

## 6. Notes

- BaseApp took 473 s, almost all of it after parsing: reading and parsing all 9,620 files takes
  16 s in the heap probe. The per-test walk is repeated for each of 40,291 tests. Fine for a census;
  worth a look before the scan runs on every `lethal run` of a project this size.
- The first run's raw output and this run's are in the session scratchpad (`r236c-census.txt`,
  `r236c-census-2.txt`).
