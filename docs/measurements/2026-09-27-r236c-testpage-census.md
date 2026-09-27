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

Update (third run, section 7): the shape is tree-sitter-al #29, the scanner now reads it, and BaseApp
has zero loud errors and runs in 55 s instead of 358 s.

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

## 7. Round 2: the `var`-section shape fixed, the lookup indexed (third run)

**The shape is a grammar defect.** The AL compiler's own parser (`Microsoft.Dynamics.Nav.CodeAnalysis`
18.0.41.45789, through `scripts/lib/dump-compiler-kinds.ps1` on a hand-written repro) makes a
procedure inside such a region a `MethodDeclaration` whose parent is `CodeunitObject`, and ends the
`GlobalVarSection` before the `#if`. tree-sitter-al 4.4.1 (`7819df5`) puts it under `var_section >
var_body > preproc_conditional_var` with no error node. Filed upstream as tree-sitter-al #29
(<https://github.com/SShadowS/tree-sitter-al/issues/29>). The second run (section 3) used grammar
4.3.0 and this third run used 4.4.1; under the OLD scanner, 4.3.0 (`e01e88c`) and 4.4.1 (`c7376f2`)
gave byte-identical results, so the grammar bump is not what changed BaseApp's count below. Until
it is fixed, the scanner collects
procedures from every branch of such a region, in source order, and keeps their locals out of the
codeunit's globals (`c7c5ea3`).

**The lookup is indexed.** A CPU profile of the BaseApp run put 349 of 415 s in one line: a linear
filter over every codeunit, run for each call site whose receiver is a codeunit. It is now a map by
id and by name that keeps the original order (`c9750b5`), so candidate lists, walk order and the
first reason found are unchanged. No per-procedure result is cached.

**Proof that the index changes nothing.** Both versions dumped every corpus's full refused map (test
key and reason text) and full error list to JSON: the index (`c9750b5`) against the unindexed scanner
at `c7c5ea3`. All ten dumps are byte-identical, BaseApp's included (2,759,172 bytes).

| corpus | files | tests | refused | loud errors | ms, unindexed (`c7c5ea3`) | ms, indexed (`c9750b5`) |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 68 | 1 | 0 | 43 | 41 |
| `fixtures/sandbox-tests` | 1 | 2 | 0 | 0 | 3 | 6 |
| `fixtures/sandbox-hang-tests` | 1 | 5 | 0 | 0 | 2 | 1 |
| `fixtures/sandbox-harden-tests` | 1 | 6 | 0 | 0 | 3 | 3 |
| `U:/Git/do-rel2/Cloud` | 554 | 0 (no tests) | 0 | 0 | 770 | 750 |
| `U:/Git/DC/Cloud` | 1135 | 0 (no tests) | 0 | 0 | 2348 | 2377 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 54 | 0 | 0 | 46 | 49 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | 89 | 19 | 0 | 144 | 156 |
| `U:/Git/BC.History/System Application` | 1718 | 1889 | 209 | 0 | 5162 | 2897 |
| `U:/Git/BC.History/BaseApp` | 9620 | 40291 | 11173 | **0** | 357937 | 55217 |

The indexed column is `scripts/r236c-testpage-census.ts` itself. The unindexed run shared the machine
with a full `bun test` for part of its time, so its small-corpus figures are noise; BaseApp's 6.5x is
not. BaseApp's 127 loud errors are gone, and its refused count moves from 11,098 to 11,173 (27.7%):
the 127 recovered tests are now classified, and 75 more tests are refused than before. Every other
corpus is unchanged from the second run. The stop condition of section 5 no longer holds.

## 8. Final review: comments are trivia (fourth run)

The final whole-branch review found a fail-open shape. The grammar makes `comment`,
`multiline_comment`, `pragma`, `preproc_region` and `preproc_endregion` NAMED children wherever
they sit, so `Helper(1 /* c */)` counted two arguments, no overload matched, and the call was
silently dropped; in `P . /*z*/ OpenView()` the comment was read as the member name. The scanner
now drops those kinds before counting arguments and before reading a member call's receiver and
member (`0e5a017`). No other read in the scanner indexes named children by position.

Same command, same corpora, run after `0e5a017`:

| corpus | files | tests | refused before (section 7) | refused after | loud errors | ms |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 68 | 1 | 1 | 0 | 43 |
| `fixtures/sandbox-tests` | 1 | 2 | 0 | 0 | 0 | 4 |
| `fixtures/sandbox-hang-tests` | 1 | 5 | 0 | 0 | 0 | 2 |
| `fixtures/sandbox-harden-tests` | 1 | 6 | 0 | 0 | 0 | 3 |
| `U:/Git/do-rel2/Cloud` | 554 | 0 (no tests) | 0 | 0 | 0 | 743 |
| `U:/Git/DC/Cloud` | 1135 | 0 (no tests) | 0 | 0 | 0 | 2266 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 54 | 0 | 0 | 0 | 50 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | 89 | 19 | 19 | 0 | 155 |
| `U:/Git/BC.History/System Application` | 1718 | 1889 | 209 | 209 | 0 | 2863 |
| `U:/Git/BC.History/BaseApp` | 9620 | 40291 | 11173 | **11179** | 0 | 57577 |

Loud errors stay 0 on every corpus. The only delta is BaseApp, +6 refused: six tests whose path to
an opening call runs through a call with a comment inside its argument list or between receiver and
member, which the old scanner dropped and so sent. The fixture pin still holds: in
`sandbox-data-tests` exactly `Data Tests.PageActionComputesNonZero` is refused.

## 9. Run 002: calls on non-plain receivers (fifth run)

Review r1 of run 001 found a second fail-open shape. A call on a receiver that is not a plain
declared name (an array element `Libs[1].Helper()`, a parenthesised `(L).Helper()`, a member chain
or a function's return value `GetLib().Helper()`) was dropped as safe unless its member was itself
`OpenView`, `OpenEdit`, `OpenNew` or `Trap`. The scanner now works out which type the receiver's
value can have (array element types, return types of test-app procedures, ternaries, `this`) and
walks the call into every test-app codeunit it can be. A literal, an operator's result, a built-in's
return, or a member of a record, a TestPage or a codeunit outside the test app is not a test-app
codeunit. A receiver EXPRESSION of a kind the scanner does not model is a loud error (`e484aa3`).
A receiver whose root is a NAME the scanner finds no declaration for (plain `X.Y()` or inside a
chain) is still treated as not a test-app codeunit, as the plain path always did; see section 10.

Same command, same corpora, run at `c87e7d3`:

| corpus | files | tests | refused before (section 8) | refused after | loud errors before | loud errors after | ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 68 | 1 | 1 | 0 | 0 | 84 |
| `fixtures/sandbox-tests` | 1 | 2 | 0 | 0 | 0 | 0 | 13 |
| `fixtures/sandbox-hang-tests` | 1 | 5 | 0 | 0 | 0 | 0 | 4 |
| `fixtures/sandbox-harden-tests` | 1 | 6 | 0 | 0 | 0 | 0 | 7 |
| `U:/Git/do-rel2/Cloud` | 554 | 0 (no tests) | 0 | 0 | 0 | 0 | 1016 |
| `U:/Git/DC/Cloud` | 1135 | 0 (no tests) | 0 | 0 | 0 | 0 | 2786 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 54 | 0 | 0 | 0 | 0 | 58 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | 89 | 19 | 19 | 0 | 0 | 179 |
| `U:/Git/BC.History/System Application` | 1718 | 1889 | 209 | 209 | 0 | 0 | 3121 |
| `U:/Git/BC.History/BaseApp` | 9620 | 40291 | 11179 | 11179 | 0 | 0 | 56623 |

No count moved, and the new loud error fired nowhere: every non-plain receiver any test reaches in
these corpora is a shape the scanner now models, and none of them adds a path to an opening call
that another path had not already found. The fixture pin still holds.

**The post-live fix `0e5a017` was not outcome-neutral in general.** It landed after the run 001 live
gates, and section 8 records that it added six BaseApp refusals (11,173 to 11,179). The fixture
`sandbox-data-tests` was unchanged by it (exactly `Data Tests.PageActionComputesNonZero` refused
before and after), so the live gate outcomes still hold for the fixture; they do not prove outcomes
for other test apps.

## 10. Run 002 re-review: named return values and undeclared roots (sixth run)

The re-review found that a named return value (`procedure H() R: Codeunit Lib`) was not in its
procedure's scope, so `R.Helper()` and `(R).Helper()` read as an undeclared name and were dropped.
It is now a variable of its procedure with the declared return type (this section's commit).

The re-review also asked that an undeclared root name stop being silently safe, except for names
that can legally be undeclared. That rule was built and measured with this allowlist: object types
with static methods (`Page`, `Report`, `Codeunit`, `Xmlport`, `Query`), system objects (`Database`,
`Session`, `SessionInformation`, `CompanyProperty`, `ProductName`, `NavApp`, `TaskScheduler`,
`NumberSequence`, `IsolatedStorage`, `ErrorInfo`, `Version`, `SecretText`, `Debugger`, `File`,
`System`), implicit variables (`Rec`, `xRec`, `CurrPage`, `CurrReport`, `CurrXMLport`,
`CurrFieldNo`, `RequestOptionsPage`), paren-less built-in functions (`Today`, `Time`, `WorkDate`,
`CurrentDateTime`, `UserId`, `UserSecurityId`, `CompanyName`, `TenantId`, `SerialNumber`,
`GuiAllowed`, `ServiceInstanceId`, `SessionId`, `CreateGuid`, `ApplicationPath`, the four
`GetLastError*`, `GlobalLanguage`, `WindowsLanguage`), and a paren-less call to a procedure of the
same codeunit. With it, System Application had 287 loud errors over 104 tests and BaseApp 6,087 over
2,944 tests. The shapes fall in three groups the list does not cover:

- data types with static methods: `XmlDocument` (ReadFrom), `XmlElement` and `XMLElement` (Create),
  `XmlText`, `XmlAttribute`, `Media`, `MediaSet`, `Text`, `Dialog` and `DIALOG`;
- enum type names used as receivers (`"Sales Document Type".FromInteger(...)`, `.Ordinals()`,
  `.Names()`): 60 distinct enum names across the two corpora, for example `"FA Ledger Entry FA
  Posting Type"` (1,336 errors), `"Gen. Journal Document Type"` (425), `"Excel Filter Node Type"`;
- a namespace-qualified path as the root: `Microsoft.Manufacturing.ProductionBOM...` (52).

Per the ruling for this case the loud rule is NOT committed: the allowlist is not widened by guess.
Everything else in this section is committed, and with it the census is unchanged from section 9:

| corpus | refused | loud errors |
| --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 0 |
| `fixtures/sandbox-tests`, `sandbox-hang-tests`, `sandbox-harden-tests` | 0 | 0 |
| `U:/Git/do-rel2/Cloud`, `U:/Git/DC/Cloud` (no tests) | 0 | 0 |
| `U:/Git/BusinessCentral.Sentinel` | 0 | 0 |
| `U:/Git/BC.History/BusinessFoundation` | 19 | 0 |
| `U:/Git/BC.History/System Application` | 209 | 0 |
| `U:/Git/BC.History/BaseApp` | 11179 | 0 |

## 11. Run 003: every `#if` arm's type of a name (seventh run)

Review r2 found that declarations were kept in a map from name to ONE type, the last one written.
A name declared as `Codeunit Opener` in one `#if` arm and `Codeunit Safe` in the other kept only
`Safe`, so a call through it walked only the safe arm and the test was sent. Every name now keeps
all its types, a call is walked on each, and a local declaration still hides every global of the
same name. The test's own codeunit is now found by every codeunit with its id, and a test declared
in two arms is walked in both instead of raising an error (`7e52ed8`).

Same command, same corpora, run at `7e52ed8`:

| corpus | refused before (section 10) | refused after | loud errors before | loud errors after |
| --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 1 | 0 | 0 |
| `fixtures/sandbox-tests`, `sandbox-hang-tests`, `sandbox-harden-tests` | 0 | 0 | 0 | 0 |
| `U:/Git/do-rel2/Cloud`, `U:/Git/DC/Cloud` (no tests) | 0 | 0 | 0 | 0 |
| `U:/Git/BusinessCentral.Sentinel` | 0 | 0 | 0 | 0 |
| `U:/Git/BC.History/BusinessFoundation` | 19 | 19 | 0 | 0 |
| `U:/Git/BC.History/System Application` | 209 | 209 | 0 | 0 |
| `U:/Git/BC.History/BaseApp` | 11179 | 11179 | 0 | 0 |

No count moved: none of these corpora declares one name with different types across `#if` arms on
a path a test reaches. The fixture pin still holds: in `sandbox-data-tests` exactly
`Data Tests.PageActionComputesNonZero` is refused.
