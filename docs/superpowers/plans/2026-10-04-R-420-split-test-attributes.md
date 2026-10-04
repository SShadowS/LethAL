# R-420: discovery finds a `[Test]` whose declaration the regex cannot read (short plan, r2)

Task: `/coord/tasks/R-420/task.md`. Item: `docs/roadmap/R420.md`. Branch `lethal/lane-preproc` at master 1d74be06.

## Revisions
**r2** answers `/coord/reviews/R-420-plan/claude-adversary-r1.md` (6 required changes):

| Point | r2 change | Where |
|---|---|---|
| 1. S10 breaks testpage-scan and test-digest | S10 is OUT OF SCOPE: it is not discovered, as today, but it is no longer silent. A named warning and a roadmap item | §2, §8 |
| 2. Handlers inside `#if` | `attributesOf` and the digest span collect attributes from a preceding `preproc_conditional` (every arm), in this change | §3 |
| 3. Nothing pins tree = regex | A test forces the tree finder on every fixture and example file and requires the regex's exact result, offsets included. Plus quoted names, `Subtype = Test` inside `#if`, and a codeunit inside `preproc_conditional_object` | §2, §6 |
| 4. R79's guard | Reworked to count `Test` attribute tokens consumed, so it covers tree candidates | §2 |
| 5. A test that passes on master | The mismatch tests assert WHICH side holds the test, and name it | §6 |
| 6. `tree-v1` and `armPolicyApplied` | Set whenever the tree found a test the regex did not, on every path | §5 |

## 1. Measured (scratch `<session scratchpad>/r420-shapes`, alc 18.0.41.45789, runtime 13.0)

Each shape was compiled as its own app under `[]` and `[X]`. "Compiled test" means the method carries the `Test` attribute in the package's `SymbolReference.json`. "Regex" is today's `testsInAlSource` on the same file.

| Shape | alc | Test under `[]` | Test under `[X]` | Regex today |
|---|---|---|---|---|
| S1 `[Test]` / `#if X` / `[HandlerFunctions]` / `#endif` / procedure | accepts | T1 (no handler) | T1 + MsgH | misses |
| S2 `#if X` / `[Test]` / `#endif` / procedure | accepts | none (plain procedure) | T2 | misses |
| S3 `[Test]` / handler A in `#if`, handler B in `#else` | accepts | T3 + ConfirmYes | T3 + MsgH | misses |
| S4 `[Test]` / `#pragma warning disable` / procedure | accepts | T4 | T4 | misses |
| S5 `[Test]` / `#region` / handler / `#endregion` / procedure | accepts | T5 + MsgH | T5 + MsgH | misses |
| S6 `[Test] internal procedure` | accepts | T6 | T6 | misses |
| S6b `[Test] local procedure` | REJECTS (AL0245) | | | |
| S7 `[Test, HandlerFunctions(...)]` | REJECTS (AL0104) | | | |
| S8 `[Test]` / `//` or `/* */` comment / procedure | accepts | T8 | T8 | finds |
| S9 `#if X` / `[Test]` / `#else` / `[Test]` + handler / `#endif` / procedure | accepts | T9 + MsgH | T9 | misses |
| S10 `[Test]` / procedure HEADER split by `#if X` / `#else` (T10a / T10b), one body | accepts | T10b | T10a | misses |

Three of the misses (S4, S5, S6) have no `#if` at all. `hasDirectiveLine` knows only the `#if` family and `#define`/`#undef`, so it does not see `#pragma` or `#region` either.

**The parser sees every accepted shape.** tree-sitter-al 4.4.1 produces no ERROR or MISSING node for any of them, and `evaluateArms` returns `decided` for all of them under both sets.
- Attributes are `attribute_item` siblings of `procedure` in `declaration_body`.
- `#if` around attributes is a sibling `preproc_conditional`, with the `attribute_item`s inside its arms (S1, S2, S3, S9).
- `#pragma` is a `pragma` sibling. `#region` and `#endregion` are `preproc_region` and `preproc_endregion` siblings (S4, S5).
- `internal` is a `procedure_modifier` inside an ordinary `procedure` (S6).
- S10 is a `preproc_split_procedure`: one name per arm, one shared body.
- S7 has an `ERROR` node inside its `attribute_item`.

## 2. Discovery: the parser, used exactly where the regex is blind

**Recommendation: the parser, not a wider regex** (acceptance 5). A wider regex would have to model `#if`/`#else`/`#endif`, `#pragma`, `#region` and modifiers, and it still could not say which arm a `[Test]` is in. The tree separates all of that already, and `evaluateArms` gives the arm ranges.

**When the tree is used.** For each test file, count the `[Test]` attribute tokens in the masked source (`/\[\s*Test\s*\]/gi`; comments and strings are already blanked) and compare them with the regex matches. The review confirmed this rule is sound: the two use the same mask, so matches can never outnumber tokens.
- **Equal:** the regex result stands, with R-403's arm filter as today. Every committed fixture is in this case, so its discovery is byte-identical and no parse is added (R-371's budget).
- **Different:** the file is parsed, and the tree finder replaces the regex for that whole file.

**Tree finder** (new, in `discovery.ts`, beside `testsWithOffsets`).
- **Codeunits.** It visits every codeunit, descending through `preproc_conditional_object` (a codeunit wrapped in `#if`).
- **What counts as a Test codeunit.** It decides this exactly as `SUBTYPE_TEST` does today: `Subtype = Test` in ANY arm counts. This keeps tree and regex equal. That an inactive-arm `Subtype` is still read as a test is the pre-existing R-403 edge, noted there and unchanged here.
- **The walk.** It goes through `declaration_body`'s children in order, keeping a list of pending attributes:
  - `attribute_item` is added to the list, with its start offset.
  - A `preproc_conditional` whose arms hold only attributes, directives and trivia has every `attribute_item` in it added, each with its own offset.
  - `pragma`, `preproc_region`, `preproc_endregion` and comments are skipped; the list is kept.
  - A `procedure` is a candidate test when a pending attribute is named `Test` (case-insensitive, no arguments). Its name is read as the regex reads it: quotes stripped, as at `discovery.ts:170`. The list is then cleared.
  - A `preproc_split_procedure` (S10) with a pending `Test` attribute is out of scope (§8). It is not a candidate, the file gets a `test-shape-unsupported` warning naming the file and both arm names, and its `Test` tokens count as accounted for (below).
  - Any other node clears the list.
  - An `attribute_item` with an `ERROR` child does not count (S7).
- **Arms.** A candidate is in the filtered suite when at least one of its `Test` attributes starts in an active range (S2, S9). In an undecided file every candidate is kept and recorded as `preproc-undecided-kept`, as in R-403 §3(d). Without `buildSymbols` (the old call shape), every candidate is returned: R-403's "unfiltered" means every arm.
- **Unchanged:** the `TestMethodRef` shape, and source order by offset.

**R79's guard, reworked** (review 4). `assertEveryTestAttributed` counts `TEST_METHOD` matches today, so it cannot see tree candidates. It is replaced by one count, on both paths: the number of `[Test]` tokens in the masked file must equal the tokens consumed. A token is consumed by a test attributed to a codeunit section, or by an S10 warning. A token that is neither (one outside every codeunit, or one before a node the walk does not accept) refuses with the existing "lost N of M" message. On the regex path this is today's check, because there every token is one regex match.

## 3. Handlers inside `#if` (review 2)

`testpage-scan.ts` `attributesOf` (≈:446) and the test-digest span start (`test-digest.ts`, R-278 span rule) collect attribute SIBLINGS only. In S1, S3 and S9 the `[HandlerFunctions]` is inside a `preproc_conditional`. So the TestPage scan never sees that handler, the digest never walks it, and verify would miss an edit to it. These tests are not discovered today, so R-420 would create the exposure. Fixed in this change:
- **`attributesOf`** also collects `attribute_item`s from a `preproc_conditional` that sits directly in the attribute run before the procedure, from EVERY arm (the union).
  - The union is the safe direction for both readers: the digest walks every handler a build might use, and the TestPage scan sees every TestPage a handler might touch.
  - Where the arm is decided, a narrower set would be possible, but nothing here needs it.
- **The digest's span** starts at the first node of that attribute run, the `preproc_conditional` included, so editing the handler list changes the digest.
- **[orchestrator, at adoption]** A test discovered TODAY can still carry a `preproc_conditional` in its attribute run when the `#if` block comes BEFORE `[Test]` (the regex finds `[Test]` directly before `procedure`). Its digest changes once with this fix, so `lethal verify` treats it as new on the first run after upgrading: more executions, never fewer, which is the safe direction. Say so in the CHANGELOG, and add one test that pins this shape: discovered both before and after, digest changed.
- **No digest scheme bump:** no committed fixture has these shapes, so every existing digest is byte-identical, and a test pins that. These tests were never discovered before, so no stored digest exists for them.

## 4. The bcdev message (acceptance 4)

These shapes no longer reach `test-app-differs`, because both sides now hold the test. For a shape nobody has seen yet, S10 included, the `published-only` half of the message gains a third cause: `or LethAL did not recognise a test declaration in the source (please report the shape; see R420)`. R-403's tests that pin the exact text are updated in the same commit.

## 5. Resume, identity, explain (acceptance 6)

- **Identity:** no change. A test's file and name are in no identity key, so there is no scheme bump.
- **Explain:** no change. There is no new caveat or report field. `test-shape-unsupported` is a warning code, and warning codes are free strings.
- **Fingerprint:** it does not include the discovered test list, so a run resumed across this change could mix a suite without T4 with one that has it. `testDiscovery` therefore gains `"tree-v1"`, set whenever the tree finder returned a test the regex did not. That holds on EVERY path, whether or not the arm policy was applied (review 6): the no-evidence bcdev path also gains the test. When both markers apply, the value is `"arms-v1+tree-v1"`. Every project where the regex already found everything keeps its fingerprint byte for byte, and a test pins that.

## 6. Tests (test-first, red on today's code, each red-checked)

- **Discovery:** S1 to S9 under `[]` and `[X]`, with exactly the table's expected set. S8 unchanged. S7 is not a test. S10 is not discovered and produces the `test-shape-unsupported` warning, naming T10a and T10b.
- **Tree = regex** (review 3): for EVERY `.al` file under every `fixtures/*` and `examples/*` project, the tree finder, forced on, returns exactly what `testsWithOffsets` returns: codeunit id, codeunit name, method and offset, in order. Plus three made-up cases:
  - quoted procedure and codeunit names (`procedure "My Test"()`);
  - `Subtype = Test` inside `#if`;
  - a codeunit inside `preproc_conditional_object`.
- **R79:** a `[Test]` outside every codeunit still refuses, on both paths. S10's tokens do not refuse.
- **Membership against the compiler:**
  - The measured `SymbolReference.json` method lists for S1 to S9 under both builds are committed as small JSON fixtures and fed to `buildFakeApp`.
  - R-403's compiled check must PASS for each build, with the derived set equal to that build's symbols.
  - For S2 and S9 under mismatched pairings, the test asserts the refusal names the test on the RIGHT side (review 5). Example: S2 published `[X]` with derived `[]` gives published-only T2; published `[]` with derived `[X]` gives source-only T2.
  - S10 published gives published-only T10a or T10b, and the message carries the new third cause.
- **Handlers:**
  - for S1, S3 and S9, the TestPage scan's attribute list includes every arm's `HandlerFunctions`;
  - the digest changes when the handler named only inside `#if` is edited;
  - every committed fixture's digests are unchanged.
- **Fast path:** all fixtures keep the regex path, asserted by a parse counter.
- **Fingerprint:**
  - unchanged where the regex finds everything;
  - `tree-v1` for S4 on al-runner AND on the bcdev no-evidence path;
  - `arms-v1+tree-v1` for S2 on al-runner.
- **Red-checks:**
  - drop the `preproc_conditional` attribute collection in discovery (S1, S2, S3, S9 go red);
  - stop skipping `pragma` or region nodes (S4, S5);
  - test the PROCEDURE's offset instead of the `Test` attribute's (S2, S9);
  - force the fast path (all shapes);
  - count an `ERROR` attribute (S7);
  - strip no quotes (the tree = regex test);
  - skip `preproc_conditional_object` (the tree = regex test);
  - return to the regex-only R79 count (the tree R79 test);
  - drop the arm attributes in `attributesOf` (the handler tests);
  - leave `tree-v1` out of the fingerprint, and gate it on `armPolicyApplied`.

## 7. Gates (acceptance 3)

- Re-run R-403's §4 check: master against branch discovery, on every `app.json` project under `fixtures/` and `examples/`, under every gate symbol set. It must be identical.
- The tree = regex test (§6) is the guard that §4 cannot be, because §4 never reaches the tree path.
- No fixture has these shapes, so no frozen figure can move. Running `itest:bcdev` and `itest:alrunner` once on the branch is cheap insurance.

## 8. Not in scope

- **S10:** a procedure header split by `#if`. Supporting it means teaching the TestPage-scan and digest models a split member (`testpage-scan.ts:602-616` keeps only `procedure` nodes; `analyzeTestPageModel` ≈:1926 and `walkTest` in `test-digest.ts` ≈:185 would refuse). Today it is dropped silently. After R-420 it is dropped with a `test-shape-unsupported` warning, and on bcdev it is refused by name with the new cause. I file it as its own roadmap item with the measured shape.
