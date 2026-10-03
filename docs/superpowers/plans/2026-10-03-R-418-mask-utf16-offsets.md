Revised r2 after the Claude spec-adversary review (/coord/reviews/R-418-plan/claude-adversary-r1.md).

# R-418: `maskAlNonCode` indexes by UTF-16 unit, so an emoji cannot shift the blanking (short plan)

Task: `/coord/tasks/R-418/task.md`. Item: `docs/roadmap/R418.md`. Lane `bugs`, from master 9afd315a. Offline only: no live gate, no `.al` edit.

**Problem.** `maskAlNonCode` (`packages/engine/src/ast/mask.ts:51`) builds `out` with `Array.from(source)` (line 52), which has one element per CODE POINT. Everything else in the function (the scan at lines 66-116, `blank(from, to)` at lines 53-60, `endOfLine` at 61-64) uses UTF-16 indexes into `source`. A character outside the Basic Multilingual Plane (BMP: emoji, some CJK) is two UTF-16 units but one code point. So after such a character, `out[k]` is one place to the right of `source[k]`, and every later blank lands one place early. If the astral character is itself blanked, it becomes ONE space, so the output also gets one unit shorter.

Reproduced on 9afd315a with a scratch probe (no repo edit):

| Input | Policy | In / out length | Output today |
|---|---|---|---|
| `"x := '😀'; // note\nnext\n"` | attribution (`false`) | 24 / 24 | `"x := '😀'; /      \nnext\n"` (first `/` survives) |
| same | discovery (`true`) | 24 / 23 | `"x :=      /      \nnext\n"` |
| `"// 😀😀\n/* a */ codeunit 5 Foo\n"` | both | 31 / 29 | `"     \n *       odeunit 5 Foo\n"` (header gone) |
| `"x := '😀abc';\nnext\n"` | discovery | 19 / 18 | `"x :=        \nnext\n"` (`;` blanked) |

## 1. Callers, and which ones map masked offsets back to the source

`grep -rn "maskAlNonCode\|stripAlComments\|scanDeclaredObjects\|testsInAlSource" packages/*/src scripts`:

| Caller | Policy | Uses a masked OFFSET against the source? |
|---|---|---|
| `packages/schemata/src/project.ts:351-357` `stripAlComments` -> `objectHeadersOf` (393-418) | `false` | **YES.** `startIndex: m.index` (line 416) is an index into the MASKED text. `attributeHeader` (460-479) compares it with `spec.before.startIndex` (line 467), which is a SOURCE offset in UTF-16 units (the native addon halves tree-sitter's byte offsets, `packages/engine/native/src/lib.rs:72`, pinned by `offsets_are_utf16_code_units` at line 264). A shorter mask makes every later header start too early. |
| `packages/schemata/src/project.ts:489-496` `scanDeclaredObjects` (id-collision scan; called from `packages/runner/src/cli.ts:281`) | `false` | No offsets. A lost header means a declared object id is missed by the collision scan. |
| `packages/runner/src/discovery.ts:29-31` `maskNonCode` -> `testsInAlSource` (117-153; also `packages/runner/src/published-test-app.ts:97`) | `true` | No source offsets: it slices the MASKED text into codeunit sections (lines 135-139) and reads names from it. A lost header either refuses the file (`assertEveryTestAttributed`, line 46: measured, "lost 1 of 1 [Test]") or, in a file with an earlier test codeunit, puts the tests into the WRONG codeunit silently. |

No other caller exists (engine re-exports it at `packages/engine/src/index.ts:15`; tests only).

## 2. Blast radius: identity and `IDENTITY_SCHEME`

What feeds identity: `identityTupleOf` (`project.ts:74-88`) is `astHash|codeunitName|scope|operatorName|major`. `astHash`, `procedureName` and `triggerName` come from the AST and `f.source`, never from the mask (`procedureScopeOf(spec, f.source)`, line 652). But **`codeunitName` is `header.name`** (line 699, with `objectType: header.type` at 697), and `header` comes from `attributeHeader(headers, spec, ...)` (line 651), i.e. from the masked offsets. `identityOrdinalsOf` (128-146) numbers twins by that tuple, so moving one mutant between objects can also renumber its old object's twins (the R193 hazard).

So the fix CAN move an existing key for unchanged AL source, in one narrow shape: a file with TWO OR MORE objects and an astral character before a later header. The character can sit in a comment, or in a STRING. A string is not blanked under attribution (`false`), but the astral character in it still shifts `out` against `source`, so every LATER blank lands early. Today that has three effects:
- (a) a header inside a comment is erased (comment case);
- (b) a header's `startIndex` is early by N, so object-1 mutants within N units before it are attributed to object 2;
- (c) the **phantom header**: 30 emoji in a string in object A make a commented-out header survive the mask, e.g. `/*\ncodeunit 51 "Old Impl"\n*/` between A and B. The blank for that comment lands early and leaves its `codeunit 51 "Old Impl"` line standing, while the real `codeunit 52 B` is erased. `scanDeclaredObjects` then returns A plus a phantom "Old Impl" and misses B. B's mutants get `codeunitName` "Old Impl", and the collision scan sees a phantom id 51 and misses the real id 52.

A SINGLE-object file that hits the bug is refused today ("file has no AL object header"), so it has no recorded keys and nothing moves for it.

`IDENTITY_SCHEME` is 5 on master (`project.ts:112`). Its rule (lines 90-111) is "bump with any engine or operator change that can move an existing mutant's key for unchanged AL source", and scheme 4 (R318) was a bump for changed ATTRIBUTION alone. By that rule this fix needs a bump. Scheme 6 is held by R-307 (lane code, in flight) and 7 by R405.

**Orchestrator ruling (2026-10-03): bump.** "The moved keys came from a defect" is not an exemption. The rule exists so that a stored key never silently joins a different mutant, whatever the cause. R418 takes the NEXT FREE scheme number AT MERGE TIME, under the standing rule that whichever change merges second renumbers. R-307 holds 6 on its branch but is blocked, so if R418 merges first it takes 6 and R-307 renumbers to 7 (R405 then to 8). Do the bump as the LAST code task, and message the orchestrator before committing it, so the number is checked against master and the lane branches at that moment. Add an "R418" sentence to the doc comment at project.ts:90-111, worded like this: "N: R418, `codeunitName` and `objectType` can move in a file with two or more objects that holds a non-BMP character (an emoji) in a comment or a string before a later header: the mask no longer shifts, so an erased header is found, a phantom commented-out header is gone, and a header's offset matches the source." Bump every literal that must move with the scheme in the same commit: check how R318 and the scheme-5 bump did it (`git log -S "IDENTITY_SCHEME" -- packages/schemata/src/project.ts`) and whether the explain version or guide literals have to move too.

## 3. Tasks (TDD: each test written first, seen red on 9afd315a, then the fix)

### Task 1. Engine tests (red on current code)

File: `packages/engine/tests/ast/mask.test.ts`, new `describe("R418: offsets are UTF-16 units", ...)`. Expected strings are built with `" ".repeat(n)` so the counts are visible.

1. **Length**: for each policy, for each of the three R418 inputs plus `"a /* 😀 */ b\n"` and `"'😀'\n"`: `out.length === src.length`. Red: case 2 gives 29 vs 31.
2. **The three measured inputs, exact output**:
   - `"x := '😀'; // note\nnext\n"`: attribution -> `"x := '😀'; " + " ".repeat(7) + "\nnext\n"`; discovery -> `"x := " + " ".repeat(4) + "; " + " ".repeat(7) + "\nnext\n"`.
   - `"// 😀😀\n/* a */ codeunit 5 Foo\n"`, both policies -> `" ".repeat(7) + "\n" + " ".repeat(7) + " codeunit 5 Foo\n"`.
   - `"x := '😀abc';\nnext\n"`: discovery -> `"x := " + " ".repeat(7) + ";\nnext\n"`; attribution -> unchanged.
3. **A blanked surrogate pair becomes two spaces**: `maskAlNonCode("//😀\n", p) === "    \n"` for both policies, and an un-blanked one stays intact (`"'😀'\n"` under attribution is unchanged).
4. **Property test** (seeded, no new dependency; a 10-line mulberry32 PRNG inline): 2,000 strings of length 0-60 from the alphabet `/ * ' " \n \r a space é 中 😀 𝄞` (two BMP non-ASCII, two astral). For each policy check:
   - `out.length === src.length`;
   - for every index k, `out[k] === src[k]` or `out[k] === " "`, and `\n`/`\r` are always kept;
   - never half a pair: if `out[k]` is a high surrogate, `out[k+1] === src[k+1]`;
   - **oracle**: replace each astral character with the two ASCII letters `zz` (same UTF-16 length, BMP), mask that, and require the same set of blanked positions (positions where `out[k] === " " && src[k] !== " "`). BMP behaviour is already correct and pinned by the existing tests, so it is a sound oracle.
   On failure, print the seed and the input. Red: length fails on the first astral blanked inside a comment.

### Task 2. Caller tests (red on current code)

1. **Discovery**, `packages/runner/tests/discovery.test.ts`, next to the R79 block (line 140): `"// 😀😀\n/* a */ codeunit 79400 \"Emoji Suite\"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure Runs()\n    begin\n    end;\n}\n"` through `testsInAlSource` -> `[{ codeunitId: 79400, codeunitName: "Emoji Suite", method: "Runs", ... }]`. Measured red today: throws "Test discovery lost 1 of 1 [Test]". Add a second case with TWO test codeunits, the emoji comment before the second: today its test is silently filed under the first codeunit; expect it under the second.
2. **Schemata attribution**, `packages/schemata/tests/project.test.ts`, inside "a file declaring more than one AL object" (line 971): a copy of `TWO_INJECTABLE_OBJECTS` with `// 😀😀\n/* a */ ` before `codeunit 51051 "Second Obj"`. Through `writeInstrumentedProject`, the second mutant's manifest entry must have `codeunitName: "Second Obj"`, `objectType: "codeunit"`, `objectId: 51051`. Measured red today: `scanDeclaredObjects` on this source returns only the table, so the mutant goes to "First Obj".
3. **Header offset** (two parts, same file).
   - `stripAlComments` block (line 1249): for the source of 2.2, `stripAlComments(src).length === src.length`, and `scanDeclaredObjects(src)` lists both objects.
   - Boundary, through `writeInstrumentedProject` (`objectHeadersOf` is private, so there is no direct call). Use `TWO_INJECTABLE_OBJECTS` with `"// " + "😀".repeat(N) + "\n"` inserted between the `fields` line and `trigger OnInsert()`, in object 1. Work the offsets out from the source text: the first mutant is `FirstFlag := 1;`, and the text from its start to the start of `codeunit` is `FirstFlag := 1;\n    end;\n}\n\n` = 15+1+8+1+1+2 = **28 units**. A header erase is not needed here: the masked header sits N units early (each blanked pair makes the mask one unit shorter), so the wrong attribution needs a shift of at least 28. Choose **N = 40**. The test computes `const gap = source.indexOf("codeunit 51051") - firstMutant.before.startIndex` and asserts `expect(gap).toBeLessThan(N)` FIRST. That precondition is what stops the test passing vacuously if the fixture text is edited later. The first mutant must then be attributed to "First Obj" (red today: the second header's `startIndex` is 40 early, so it is at or before the mutant, and the mutant goes to "Second Obj").
4. **Phantom header**, same file, `scanDeclaredObjects` block. Source (build it with `"😀".repeat(30)`):
   ```
   codeunit 50 A
   {
       procedure P() begin Msg := '<30 emoji>'; end;
   }
   /*
   codeunit 51 "Old Impl"
   */
   codeunit 52 B
   {
   }
   ```
   Expect `scanDeclaredObjects(src)` to return A (id 50) and B (id 52), and NOT any object named "Old Impl" or id 51. Measure it RED on 9afd315a before the fix (the review measured: A plus phantom "Old Impl", B missing). Adjust the emoji count if the measurement does not go red, and keep the measured count in the test comment. Add a second assertion through `writeInstrumentedProject` only if a mutable site fits easily; the `scanDeclaredObjects` assertion is the required one.

### Task 3. The fix

`packages/engine/src/ast/mask.ts:52`: `const out = Array.from(source);` -> `const out = source.split("");` (`split("")` yields one element per UTF-16 unit), with a comment: indexes are UTF-16 units everywhere, matching tree-sitter's offsets; a surrogate pair in a blanked region becomes two spaces, so the output keeps `source.length` and every offset. A pair is never split, because every blank boundary is an ASCII character (`/`, `'`, `\n`, or just after `*/`). Add one line to the header comment (lines 1-4): "offset" means UTF-16 unit. Nothing else changes: the `\n`/`\r` check at line 58 already compares single units. Tasks 1-2 go green.

### Task 4. Red-checks (use the `mutation-red-checker` subagent)

Revert line 52 to `Array.from(source)` and confirm EACH new test goes red: Task 1.1-1.4, Task 2.1 (both cases), 2.2, 2.3 (both parts), 2.4. Restore and confirm green. Report each red line. A test that stays green under the revert is rewritten, not kept.

## 4. Evidence that nothing else moves

- **No tracked `.al` file contains a non-BMP character.** Scanned every `git ls-files '*.al'` file (257, including all of `fixtures/`, `extensions/lethal-control`, `examples/`, `docs/`, `scripts/fixtures`, `repro/`) for `/[\u{10000}-\u{10FFFF}]/u`: 0 hits. For BMP-only text `Array.from` and `split("")` give identical arrays, so the masked output, header offsets and attribution on every fixture are byte-identical. **No gate figure can move**, and no live gate is run.
- `compile:fixtures` is not needed: no `.al` is edited and no fixture is added.
- R80's 717-file corpus (Continia Document Output Cloud + Test) is host-only: it is not in the kraken container. R418 asks to re-run R80's equality check on it. It is NOT done in this lane (orchestrator ruling, 2026-10-03). The expected result would be "only files containing a non-BMP character change". The closing note says so (step 6), and the owner can still ask for it.

## 5. Build/test loop and close-out

1. `bun run typecheck`, then `rm -rf packages/*/dist`.
2. `bun scripts/verify.ts` (the full unit suite, `CI=true`, from the repo root).
3. `bunx biome check packages/engine/src/ast/mask.ts packages/engine/tests/ast/mask.test.ts packages/runner/tests/discovery.test.ts packages/schemata/tests/project.test.ts` (plus `project.ts` if the scheme is bumped).
4. Optional: `bun run mutate` does not cover `mask.ts`; skip.
5. Commit the fix and tests. The bump (ruled 2026-10-03) lands in the same commit. Below, `S` is the new scheme number, taken at merge time. The scheme-5 commit `35cb2c69` touched six files, and each literal that moves is listed here (re-read each line before editing; line numbers are from 9afd315a):
   - `packages/schemata/src/project.ts:112`: `export const IDENTITY_SCHEME = 5;` -> `S`. Plus the R418 sentence in the doc comment above it (lines 90-111).
   - `CHANGELOG.md`, under `## [Unreleased]` (line 12), above the "Identity scheme 5" entry: a new "Identity scheme S (R418)" entry. Word it like scheme 5's: keys can move in a file with two or more objects that holds a non-BMP character (an emoji) in a comment or a string before a later header, since the mask no longer shifts, so an erased header is found, a phantom commented-out header is gone, and a header offset matches the source. Marks files need `"identityScheme": S` after re-checking each mark against a fresh report; history and resume from older-scheme runs are refused by name (R325).
   - `docs/using-lethal-from-an-agent.md:532`: `{ "identityScheme": 5, ...` -> `S`.
   - `fixtures/sandbox-harden/lethal.equivalent.json:2`: `"identityScheme": 5,` -> `S`. It is read by `packages/runner/itest/harden-fixture.test.ts:132` (`expect(mark.identityScheme).toBe(IDENTITY_SCHEME)`). The marked key is the same after the bump, so the file needs NO re-recording of marks, only the number: `fixtures/sandbox-harden` has 0 astral characters (checked with `grep -P '[\x{10000}-\x{10FFFF}]' -rl fixtures/sandbox-harden`: no hit), and for BMP-only text the mask is byte-identical, so no key moves.
   - `packages/runner/tests/resume.test.ts:459`: the `PINNED` session fingerprint, which has `IDENTITY_SCHEME` in its digest. Recompute it (run the test, copy the new value) and extend the history comment at lines 455-458 with "It moved again for R418 (scheme S); it was ef3bb9d1...daf5 under scheme 5."
   - `packages/runner/tests/__snapshots__/report-equality.test.ts.snap:58`: `"identityScheme": 5,` -> `S`. Update it with `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`, then check that only that line changed.
   - These do NOT need editing: `named-mutants.test.ts` and `schemas.test.ts` use the constant; `r214-history.test.ts:443` only asserts `IDENTITY_SCHEME > old.scheme`. No test pins the number with `toBe(5)` any more (R214 removed that pin).
   - `EXPLAIN_SCHEMA_VERSION` (`packages/runner/src/explain.ts:199`, now 9) does NOT move. It versions the explain output's shape, and the shape does not change. The scheme only flows through as a value.
   - After editing, `grep -rn "identityScheme\": 5\|IDENTITY_SCHEME = 5" . --include=* ` over `docs fixtures packages CHANGELOG.md` (not `node_modules`) must show no stale 5 outside historic prose.
6. Close: in `docs/roadmap/R418.md` set `status: "done (<commit>)"`, then `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts`. The closing note in R418.md must say: "R80's corpus re-run (717 files, Continia Document Output Cloud + Test) was NOT done. The corpus is host-only and not in the kraken container (orchestrator ruling, 2026-10-03). The owner can still ask for it. Expected result: only files that contain a non-BMP character change." Commit.
