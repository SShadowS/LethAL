# PR-362 pre-commitment (R1186): every BRANCH of a serve keep entry is tested against a real al-runner line

Written 2026-11-23, before the build. Measured first (`/coord/handoff/PR-362/branches.ts`, `draft.json`), on PR-361's mined
rows (`/coord/handoff/PR-361/mined6.json`: 2,347 distinct real row messages, al-runner rows only). Names and numbers only.

## Why
PR-361 proved each keep entry with ONE real line, but many entries hold alternations (a slot's named variants, a hand-written
`a|b`). A branch that never meets real output is R1153's failure shape. R1186 asks for a real line per branch.

## What a branch is (`packages/runner/tests/helpers/regex-branches.ts`, test helper only)
- One alternative of one non-capturing group in the entry's compiled regex. A `(?:a|b|c)` group gives a, b and c, and an
  optional `(?:x)?` gives x and the empty text.
- **Its regex is the entry's source with ONLY that group fixed;** every other group stays general.
- Lookaheads (`(?!`, `(?=`) are conditions, not branches, and are never split. Character classes and escapes are skipped
  when scanning.
- **Its key is stable:** `<entry> #<group number> <alternative's regex source>`, with `∅` for the empty alternative.
- This needs **no source change:** PR-56's slots are already expanded in the compiled regexes.

## The measurement
- **154 branches over the keep list. 151 match a real row of their own entry. 3 match none:**
  - `company-table-read-named #1 IsEmpty` and `#1 FindFirst` (only FindSet was met with the `--companies` hint text);
  - `evaluate-decimal-comparison #1 >1000`.
- R1153's 12 unproven entries hold no splittable group, so they add no branch.

## The fixture (`packages/runner/tests/pr362-keep-branch-lines.json`)
- **One real line per proven branch,** with `branch` and `from`. It prefers an invented-app source, and is copied byte for
  byte (`cmp` against `/coord/handoff/PR-362/fixture.json`) with ONE exception:
  - the payment reference in `saveas-layout-statement #1 The payment reference ...` is a DO data value. It becomes the
    invented `000000001234567`, which its `\d{15}` slot accepts.
- The other 12 corpus-sourced lines carry BaseApp text or JSON paths already in committed source
  (`al-runner-server.ts`'s `JSONPATH` slot), and no DO names.

## The test (`packages/runner/tests/pr362-keep-branch-lines.test.ts`)
1. Each proven line matches its branch's regex and its entry.
2. **The branch keys are pinned exactly:** the fixture's branches plus the pinned `UNPROVEN_BRANCHES` (the 3) equal
   `branchesOf` over the whole keep list, with no overlap.
   - A new branch with no real line goes red, and so does a removed or renamed alternative.
3. **The helper itself, on invented regexes:**
   - an alternation, an optional group and nested groups split as described;
   - a lookahead is not split;
   - `|` and parentheses inside a character class or escaped are not group syntax.
4. The names guard: no `Continia`, `Document Output`, `Document Capture`, `CDO`, `CDC`, 68xxx or 69xxx object numbers, and no
   15-digit number other than `000000001234567`.

## The limit (stated in R1186's status as well)
**A real line proves that a branch CAN match real output. It says nothing about over-matching:** a branch, or a general slot
such as `[^'\n]+`, may also accept texts that were never measured. "Proven" here never means "safe". Safety rests on each
entry's own kept-vs-fresh measurement.

## Red checks
- Rename one alternative in the source (`System\.FormatException` in `DOTNET_CLEAN_EXCEPTIONS`): test 2 goes red.
- Drop one proven line: test 2 goes red.
- Let the helper split a lookahead: test 3 goes red.
- Plant `Continia` in a line: test 4 goes red.

## Amendment 1 (the build, 2026-11-23): groups INSIDE a lookahead are not branches either
- The measured 154 included 35 false branches. The helper split the `(?:panic|timeout|...)` group that sits inside the
  negative lookahead of `cascade`, `onrun-failed`, `dotnet-exception`, `dotnet-assembly` and `cascade-manual-binding`.
  Each was "proven" by any line, which proves nothing.
- **As built,** the helper skips every group with a lookahead around it, as this spec meant. Test 3 pins it, with a red
  check.
- **The counts become 119 branches: 116 proven, the same 3 unproven.** The fixture is byte-identical to
  `/coord/handoff/PR-362/fixture.json`, except for the one payment-reference value.

## Checks
VERIFY full (one at a time beside the timed run), Opus review, CI. There are 0 moves: no `src` change. selectLegs decides
the gates.
