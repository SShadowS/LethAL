# R-424: tests and helpers whose procedure header is split by `#if` (short plan, r2)

Task: `/coord/tasks/R-424/task.md`. Item: `docs/roadmap/R424.md`. Branch `lethal/lane-preproc` at master e825409d.

## Revisions
**r2** answers `/coord/reviews/R-424-plan/claude-adversary-r1.md` (4 required changes):

| Point | r2 change | Where |
|---|---|---|
| 1. The V5 merge loses a return type, scope, handlers and subscriber | DROPPED. One `Proc` per arm, always; the code already handles same-name duplicates (calls ≈:1157, reachCalls ≈:1339, typesOf, declsOf) | §3(a) |
| 2. Today's account was wrong | A split-helper call is SILENTLY IGNORED today, not suspect. After the fix, a TestPage opened through a split helper is seen, and on bcdev that test is refused like any other TestPage test. This verdict-moving correction is RULED accepted; it goes in the CHANGELOG as a behaviour change, pinned before and after | §2, §4, §5 |
| 3. Cutting split members in `partsText` | DROPPED. Their text stays in the codeunit's parts hash, as today. Digests move only for tests that REACH a split member | §3(a), §4 |
| 4. Incomplete marker type | `testDiscovery`'s type and `testDiscoveryMarker` list all seven combinations; a split HELPER alone does not set `split-v1` | §4, §5 |

## 1. Measured (scratch `<session scratchpad>/r424-shapes`, alc 18.0.41.45789; tree-sitter-al 4.4.1)

| Variant | alc | Compiled under `[]` / `[X]` / `[Y]` |
|---|---|---|
| V1 = S10: `[Test]` / `#if X` T10a / `#else` T10b / `#endif` / body | accepts | T10b / T10a / T10b |
| V2 helper `H`: `(A)` under X, `(A; B)` otherwise | the split header is accepted (the probe's call site broke `[]`) | `H(A)` under `[X]` |
| V3 split header, `var` section after `#endif` | accepts | T3b / T3a / T3b |
| V4 `[Test]` INSIDE each arm | accepts | T4b / T4a / T4b |
| V5 helper `H(): Integer` under X, `H(): Decimal` otherwise | accepts | `Decimal` / `Integer` / `Decimal` |
| V6 three-way `#if X` / `#elif Y` / `#else` | accepts | T6z / T6x / T6y |
| V7 `internal` in arm 1 only | accepts | T7b / T7a / T7b |

**Tree.** Every variant has no ERROR or MISSING node, and `evaluateArms` decides every one.
- A split header is ONE flat `preproc_split_procedure` with these children in order:
  - `preproc_if`;
  - arm-1 pieces;
  - `preproc_elif` or `preproc_else`;
  - more arm pieces;
  - `preproc_endif`;
  - the SHARED tail: [`var_section`], `code_block`, `;`.
- A piece is `[attribute_item]* [procedure_modifier] procedure_keyword identifier ( [parameter_list] ) [: type_specification]`.
- There is no per-arm wrapper node. Arm membership is position between directive nodes.
- A `[Test]` before the `#if` is an `attribute_item` sibling BEFORE the split node (V1). A `[Test]` inside an arm is a child of the split node (V4).

## 2. Today, beyond R424's title (code map, HEAD e825409d)

The test-app model in `testpage-scan.ts` keeps only `procedure` and `trigger_declaration` nodes (≈:716 for codeunits, ≈:819 for other objects), so it skips every split member, not only split TESTS. Effects:
- A split TEST is not discovered (R-420 warns `test-shape-unsupported`). If it were discovered, `analyzeTestPageModel` (≈:2026-2036) would report "found 0 time(s)", and `walkTest` (`test-digest.ts` ≈:189) would throw `TestDigestError`. The orchestrator (≈:7035) then drops EVERY digest for the run.
- A split HELPER that a test calls is SILENTLY IGNORED (corrected in r2).
  - `sameCodeunitCall` (≈:1176-1186) records a reason only for an opening-method name or a call inside `with`.
  - The digest treats the call as a built-in, not an edge (`reachBare` ≈:1380-1390).
  - So a test that opens a TestPage through a split helper is NOT refused on bcdev today, and an edit to the helper's body moves no reach edge. The body text is in the codeunit's parts hash, so the edit is still seen, but only coarsely.
- The ancestor stops (`insideWithStatement` ≈:141, `withTargets` ≈:159), `addDeclarations`' `skipProcedures` (≈:392) and `procsInVarSection` (≈:415) also know only `procedure`. As a result, `addDeclarations` reads a split member's locals as globals today.
- The engine, schemata and line-map sites that filter on `procedure` are TARGET-side and already split-aware where it matters (`isProcedureLike`, symbol-table, dispatch, `CODE_KINDS`). A test app is never mutated, so R-424 changes none of them.

## 3. Changes

**(a) The model: one `Proc` per arm of a split member** (`testpage-scan.ts`).
- `procOf` gains a split reader. It walks the split node's children, cuts them into arms at the directive nodes, and builds one `Proc` per arm, each with:
  - the arm's own name, `params` (its `parameter_list`), `returnType` and `scope` (the arm's `procedure_modifier`);
  - the SHARED `var_section` and `code_block`, so `sites` is the same for every arm;
  - the handlers: the leading attribute run before the split node (R-420's `memberRun`), PLUS that arm's own `attribute_item`s (V4). This is a union, as R-420 does for `#if` attribute blocks;
  - the span: the leading attribute run plus the WHOLE split node (every arm's header and the shared tail). Every arm therefore has the same `spanHash`, and the digest covers both headers and the body (acceptance 2).
- **One `Proc` per arm, always, never merged** (r2). Arms that share a name and parameter count (V5) stay two `Proc`s, each with its own `returnType`, `scope`, handlers and `subscriber`. Same-name duplicates are already handled where it matters: `calls` resolves to all matches, and `reachCalls`, `typesOf` (a flatMap) and `declsOf` follow every one. So `H().Foo()` with `H(): Codeunit A` in one arm and `Codeunit B` in the other reaches both A and B.
- Like everything else in this model, it reads EVERY arm, the union, regardless of build symbols, which is R-403 §6's safe direction. A call to `H(1)` resolves to the arm with one parameter; `H(1, 2)` resolves to the other.
- **The collection loops (≈:716, ≈:819), the ancestor stops (≈:141, ≈:159), `skipProcedures` (≈:392) and `procsInVarSection` (≈:415)** also accept `preproc_split_procedure`.
- **`partsText` is NOT changed** (r2). A split member's text stays in the object's parts hash, as it is today. Cutting it would move the digest of every test that reaches that codeunit, and an unchanged project could then hit `too-many-new-tests` in verify. Its text is therefore hashed twice, once in the parts and once in the member's span, which costs nothing.
- **`preproc_split_procedure_preamble`** (the other kind discovery's `SPLIT_PROCEDURES` lists): the build's first step finds which source produces it, with a tree dump. If it fits the same arm reader, it is handled the same way. If not, it keeps R-420's warning (acceptance 3), and the plan's tests say which.

**(b) Discovery** (`discovery.ts`). On the tree path, a split member yields one candidate per arm that carries `Test`, through either the leading run or the arm's own attribute.
- The candidate is in the filtered suite when its NAME starts in an active range and at least one of its `Test` attributes does.
- An undecided file keeps every candidate, recorded as `preproc-undecided-kept` (R-403 §3(d)).
- The `test-shape-unsupported` warning no longer fires for these. It stays for anything else that reaches it, the preamble included if (a) says so.
- R79's token count: each arm's `[Test]` is consumed by that arm's candidate (V4). A leading `[Test]` is consumed by the split member as a whole (V1).
- `assertTreeHoldsRegex` is unaffected: the regex finds no split test.

**(c) `TreeDiscoveryMismatchError`** (acceptance 4). The message gains a second possible cause: "or the file uses a construct the parser (tree-sitter-al) does not read correctly yet; please report the file". "A syntax error" stays as the first cause.

## 4. Inputs that move (acceptance 6)

- **Identity:** none. A test's name is in no identity key.
- **Explain:** none. There is no new field or caveat.
- **Fingerprint:** R-420's `tree-v1` is already set whenever the tree finds a test the regex missed. But a project that also holds S4 had `tree-v1` under R-420's build too, while its suite now gains T10a or T10b. So the marker gains `split-v1`, set ONLY when a discovered TEST comes from a split member; a split helper alone does not set it.
  - The `testDiscovery` type in `resume.ts` (≈:336) and `testDiscoveryMarker` (≈:362-370) list all seven non-empty combinations, in fixed order: `arms-v1`, `tree-v1`, `split-v1`, `arms-v1+tree-v1`, `arms-v1+split-v1`, `tree-v1+split-v1`, `arms-v1+tree-v1+split-v1`.
  - Every split test is also a tree-only test, so `split-v1` normally comes with `tree-v1`. The type stays complete anyway, so that it cannot silently lose a combination.
  - A project with no split test keeps its fingerprint byte for byte, and a test pins that.
- **Digests:** they move once, only for tests that REACH a split member: the member now appears as a reach edge with its own span. The parts hash is unchanged (§3(a)). Every committed fixture is pinned unchanged against R-420's snapshot (`r420-handlers.test.ts`). The CHANGELOG states which tests change.
- **Verdicts (behaviour change, ruled accepted).** A test that opens a TestPage through a split helper is now seen by the TestPage scan. On bcdev it is refused like any other TestPage test (orchestrator ≈:4573). That changes its suite and `baselineGreenOverall` (≈:4844) where it applies. Today's silence is the bug. The CHANGELOG says so as a behaviour change, under "Changed".

## 5. Tests (test-first; each red on today's code; each red-checked)

- **Model:**
  - for V1 to V7, the scan's `procs` hold one declaration per arm (names, params, scope, return types), with V5 as TWO `Proc`s;
  - `sites` are shared;
  - V4 handlers are per arm plus the leading run;
  - spans cover both headers and the body;
  - a split member's locals are no longer read as globals.
- **Before and after, pinned** (r2). On today's code, a test that opens a TestPage only through a split helper is NOT seen: no TestPage reason, so on bcdev it is not refused. After the change it IS seen and refused, with its reason naming the helper. Both sides are pinned by the same fixture (the "before" written first, against HEAD).
- **Calls:**
  - in V2, `H(1)` and `H(1, 2)` each resolve;
  - a V5-style `H(): Codeunit A` / `H(): Codeunit B` call chain `H().Foo()` reaches BOTH A and B, in the scan and in the digest;
  - for these, the digest gains a reach edge instead of treating the call as a built-in.
- **Discovery:** V1, V3, V4, V6 and V7 under `[]`, `[X]` and `[Y]` give exactly §1's names, with no `test-shape-unsupported`. An undecided split file keeps both.
- **Compiler membership:** the measured `SymbolReference.json` method lists for V1, V3, V4, V6 and V7 per build go into R-420's fixture JSON. R-403's check PASSES for each build and REFUSES the mismatched pairings, naming the side.
- **Digests:**
  - the V1 test's digest changes when EITHER arm's header changes, and when the shared body changes;
  - no committed fixture's digest moves (R-420's snapshot);
  - a sibling test that does NOT reach the split member keeps its digest byte for byte (r2);
  - the object parts hash of a codeunit holding a split member is unchanged from HEAD (r2).
- **runSession:**
  - S10 runs on al-runner (the test under the active arm), `split-v1` is in the fingerprint, and there is no warning;
  - a project holding only a split HELPER does not set `split-v1` (r2);
  - `testDiscoveryMarker` returns each of the seven combinations from its inputs.
- **`TreeDiscoveryMismatchError`** names both causes.
- **Red-checks:**
  - keep skipping split nodes in the collection loops (model, calls and discovery tests go red);
  - take the attribute run without the arm's own attributes (V4);
  - merge equal name and params into one `Proc` (the `Codeunit A`/`B` reach test);
  - use the procedure-keyword offset of the wrong arm (arm tests);
  - cut split nodes in `partsText` (the unchanged-parts and sibling-digest tests);
  - leave `split-v1` out of the fingerprint, and set it for a split helper;
  - the old error message.

## 6. Gates

- R-420's tree = regex test and R-403's §4 master-vs-branch discovery check: identical on every fixture. No fixture has a split member, which the build checks with a grep.
- `itest:bcdev` and `itest:alrunner`, because discovery and the digest change (acceptance 6).
- Close R424 and regenerate the index.
