# PR-195: y2's "ordering of the character" refusals on the serve keep-list (pre-commitment)

Status: r1, committed to master before the family, the census and any keep-list change (coord PR-195, lethal-bugs, 2026-11-19).
Evidence: `/coord/handoff/PR-163/` (y2's events and store, read-only) and `/coord/handoff/PR-195/` (`bc3.md`, `chars.json`,
`v3.json`, `comment-8203.md`). Roadmap: R1092. Method: PR-191's (spec 2026-11-19-pr191-y2-xml-keeps-precommitment.md).

## 1. The measurement
- **y2:** 4 of its 59 refusal closes, 214.2 s of warm-up compile, on `ordering of the character U+516C (no collation weight)`,
  all in `CDO Azure Blob Folder Tests.Derivation_Explicit_NonLatinScript_CJK_FallsBackToCompany` (codeunit 68986).
- **Attribution** (`test_results`): the 4 mutants M39779, M39781, M39786 and M39788, each `lethal.toggle-blank-string` on a
  literal of `CDO Azure Blob Folder Mgt.IsAsciiAlphaNumeric`'s ASCII-range check. The baseline passes.
- **What the refusal is:** an unmodelled collation, not a state question. The mutant turns `Ch >= 'A'` into `Ch >= ''`, so a
  Char compare becomes a Text compare, and al-runner has no collation weight for the character.
  - BC (bc3, an invented pair, `bc3.md`): U+516C, U+4E2D, U+3042, U+D55C and U+0416 each sort after every ASCII letter, digit and
    `~`; al-runner refuses all five, and matches BC for é and Z.
  - Reported upstream as a comment on #8203 (the same refusal for æ, ø, Æ, queued with the collation work):
    https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8203#issuecomment-6998466107
- **Which characters the keep must cover** (`chars.ts`: every test of codeunit 68986 as its own serve entry, under each of the
  4 mutants, on edge-4ebfe7913 over PR-190's full instrumented build): under every mutant, exactly two collation texts,
  **U+516C** (the CJK test) and **U+041A** (`Derivation_Explicit_NonLatinScript_Cyrillic_FallsBackToCompany`, which y2 never
  reached: it followed the refused CJK test and was cascaded). Every other refused row is kept today (`FindSet on the Company
  table`, the same 22 tests as y2's baseline, and the cascade).
- **DO's state at the refusal:** a plain test (no handler functions, no TestPage, no Commit) calls
  `DeriveFolderFromCompanyName`, then `Sanitize` (an UpperCase and a TextBuilder being filled in a loop over the characters),
  then `IsAsciiAlphaNumeric`: depth 3, a TextBuilder local holding part of the result.

## 2. The change (built after this commit)
1. **A family `y2-collation`** in `scripts/refusal-family.ts`, invented AL: a non-SingleInstance codeunit whose procedure
   upper-cases a Text, loops over its characters filling a TextBuilder, and calls a local range check written in the mutated
   form (`(Ch >= '') and (Ch <= 'Z')`), at depth 3 from the test. Cells: an input starting with U+516C, one starting with
   U+041A; each also after a table insert, and one each behind a SingleInstance codeunit set first. A passing control cell
   (an ASCII-only input through the same path) shows the path runs.
2. **The census:** `keep-census.ts --family y2-collation --refusers 7` on edge-4ebfe7913, with PR-191's readers where they apply
   (the SingleInstance reader).
3. **Keep only if every class is CLEAN:** one entry, `ordering of the character U+%COLLCHAR% (no collation weight)`, slot
   `COLLCHAR` = `(?:516C|041A)`: the two measured characters, by name. No code-point pattern: other characters close.
4. **Tests:** each text kept by its own entry; near misses (other code points, lower case hex, a tail, a reworded text, a row
   that is not `notRun`).
5. **Red checks both ways:** the entry removed, each code point removed, and the slot opened to `[0-9A-F]{4}`: each turns a test red.

## 3. Predictions
- **P1:** every cell refuses with its exact text and both classes are CLEAN; the control passes. A class that is not CLEAN is
  not kept, and PR-195 says which.
- **P2 (exact, from y2's store and `chars.json`):** the keep covers y2's 4 closes on this family, 214.2 s of warm-up compile;
  with it, the 4 mutants' requests hold no unkept refused row.
- **P3 (the next DO window):** 0 closes on U+516C or U+041A. A close on another code point is named, not counted as a miss.
- **P4 (the next DO window, by full site key with y2):** the 4 mutants keep their y2 verdicts. Their newly run tests (the
  Cyrillic test and the rest of codeunit 68986 after it) give new rows, which are named; any verdict that moves is re-run on a
  fresh daemon, and if a fresh daemon disagrees with the kept one, the keep is withdrawn before the window is accepted.
- **The gates:** the al-runner-v3 gate on the final head shows that nothing else moved (no gate fixture produces these texts).
