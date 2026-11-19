# PR-195: y2's "ordering of the character" refusals on the serve keep-list (pre-commitment)

Status: r1, committed to master before the family, the census and any keep-list change (coord PR-195, lethal-bugs, 2026-11-19).
Evidence: `/coord/handoff/PR-163/` (y2's events and store, read-only) and `/coord/handoff/PR-195/` (`bc3.md`, `chars.json`,
`v3.json`, `comment-8203.md`). Roadmap: R1092. Method: PR-191's (spec 2026-11-19-pr191-y2-xml-keeps-precommitment.md).

**Amendment 2 (results and the standard, on the branch; no prediction changes).**
- **The standard (orchestrator, 2026-11-19):** from now on a serve keep needs BOTH a strict census AND a direct DO check (P5's
  shape: the refusing mutants' requests, then a request with no mutant, then other mutants of the same file, all on ONE daemon,
  every row equal to the same request on a fresh daemon) wherever DO reaches the text. A census alone is not enough, because it
  never changes the active mutant between entries.
- **The widened direct check** (`/coord/handoff/PR-195/p5/table.md`): every keep-list entry DO met in y2 (51 non-cascade entries,
  129 requests, PR-191's included): **129 of 129 equal**, each entry's own refusal exercised, a planted status change and a
  dropped row each caught. 75 entries are never reached by DO in y2 and cannot be checked there.
- **P5 for this keep** (`p5/plan195.json`): M39779, M39781, M39786, M39788 over codeunit 68986 (each holding both U+516C and
  U+041A refusals), then no mutant, then M39787, M39807, M39735, then no mutant: **9 of 9 equal** to fresh daemons.
- **The census** (`census/`, edge-4ebfe7913, family `y2-collation` as amended: a SingleInstance refuser with a global set, readers
  `y2single`, `y2cover`, `y2order`): **both classes CLEAN**, 3 refusers each; the readers' values are in every compared observation.
- **Red checks:** the entry removed, either code point removed, the slot opened to `[0-9A-F]{4}`, and lower-case hex allowed:
  each red (5 of 5).
- **The opus build review (no HIGH), and the re-run it led to:**
  - MED-1: the check cut messages at 300 characters (343 of 5,058 rows), which could hide a cascade row's cause. Now it keeps
    and compares full messages. Re-run: widened **129 of 129 equal**, PR-195's plan **9 of 9 equal**.
  - MED-2: no census reader read the table the "after an insert" cells write. Added reader `y2rows` (that table's count);
    census2 (`census2/`): **both classes CLEAN**, `y2rows=[0]` in the compared observations.
  - MED-3: the "exercised" count was loose for cut rows. Now each entry counts only rows its own regex matches on a full
    message: **51 of 51 exercised**.
  - L4: no killed y2 mutant has a killing test in codeunit 68986, so the plan keeps its survivors; a stale mutant still shows,
    because consecutive requests differ (8, 6, 8 and 12 passes under the four mutants, 14 with none).
  - L5: the check sends testIsolation "test" only; LethAL also sends "codeunit" with runSelectedOnly in some windows. Stated as a
    limit in `p5/table.md`.
  - L6: the parallel fresh chunks now use their own cwd and cache.

## 0. Amendment 1 (the opus spec-adversary's review of r1, 2026-11-19: not safe as specified; the fixes need no redesign)
Committed before the census and any keep-list change. The family was built in parallel with the review; it changes below.
- **HIGH-1: P4 restores PR-191's lane clause.** A close comes after the whole request has run, so the keep never changes the 4
  mutants' own rows; it changes what runs NEXT on that daemon. P4 now also requires: every mutant scored on that lane after a
  kept collation refusal, up to the lane's next close, keeps its y2 verdict and `killingTest` (full site key). Any difference is
  re-run on a fresh daemon; if the fresh daemon gives y2's answer and the kept one did not, the keep is withdrawn before the
  window is accepted.
- **HIGH-2: the census never changes the active mutant between entries** (its requests send `NONE` throughout), and DO's
  `MutationSelector` is a SingleInstance codeunit that caches `active-mutant.txt` on first use. A daemon that kept the previous
  mutant after a refusal would look clean to the census. **Added: a direct DO check (P5)**, as PR-139 did: on ONE daemon, the
  4 mutants' requests over codeunit 68986 (each test its own entry), then a request with no mutant, then requests for other
  mutants of `CDO Azure Blob Folder Mgt.` with a stable y2 verdict; every row compared with the same request on a fresh daemon.
  The same check is run for PR-191's 8 XML mutants (merged in f1148eb6), whose census had the same gap.
- **MED-1: DO's refusing codeunit is SingleInstance** (`CDO Azure Blob Folder Mgt.`, with a global tests set) and the refusal
  unwinds through it. The family's refusing codeunit becomes SingleInstance with a global set before the call, and a reader
  reads that global back.
- **MED-2: §1 was wrong about the Cyrillic test.** y2's store holds the U+041A refusal row for all 4 mutants: a close event
  names one text (the first), and both texts occur in the same request. Both are still needed; P4's "new rows" clause is dropped.
- **MED-3: a reader that orders text** (é against Z, a and z; `~` against letters; a FindSet over a Code-keyed table holding é
  and Z), so a half-built or cached collation table after a refusal would show.
- **L1:** P2's check covers every entry of the 4 closing requests (two prefetch requests held 19 and 9 entries of codeunit 68986
  from other mutants too); every refusal text in 68986's y2 rows is kept today or proposed here.
- **L2:** bc3.md measured U+0416 (Ж), not U+041A (К). The verdict is NotRun either way, so it changes nothing here.
- **L3:** the entry comment names that the same two code points from another operation (a key or record ordering) are kept
  unmeasured; today only codeunit 68986's two tests hold such characters in DO.
- **L4:** P3 is a shape check, not evidence the keep is safe; P4 and P5 are.
- **P5 (new):** the direct DO check shows every row of every request on the kept daemon equal to a fresh daemon's, for both this
  keep and PR-191's. A difference blocks this keep, and is reported against PR-191's.

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
1. **A family `y2-collation`** in `scripts/refusal-family.ts`, invented AL (superseded by amendment 1 MED-1: the refusing
   codeunit is SingleInstance, as DO's is): a non-SingleInstance codeunit whose procedure
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
