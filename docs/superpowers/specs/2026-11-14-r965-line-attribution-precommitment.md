# R-965 pre-commitment: v3 trigger mutants decided by per-test line coverage (R975) — the gate figures that move

Committed before any gate ran on the change, 2026-11-14. Coord task R-965 (R975). Build: lethal/r-965 at eb61c6ce (a7d35069 the rule,
c219bac3 roadmap, eb61c6ce the review fixes). Gate on the gated `current` al-runner build.

**The rule.** A TRIGGER mutant with no exact member hit and a statement `reachLine` is decided by per-test LINE coverage when the
session's green baseline is line-complete (every green row's coverage granularity "line", every green row ran THIS session — no reused
snapshot — and the object has no line-less entry) and some green test's coverage includes the object: its covering tests are the tests
whose baseline hit that line (`coverageAttribution: "line"`); none → `no-coverage`. Otherwise R29's FALLBACK 1 / FALLBACK 2 and R140's
decline apply unchanged. Explain schema v27 (v26 frozen). Direction measured on Continia DO's stored run: of 11 kills, 7 have a
`reachLine` and every one is hit by 2-4 green tests (0 kills lose their covering tests); 4 have none (rule not applied).

**Predicted gate moves (`itest:alrunner-v3`, Opus review of the diff reading the baselines and fixtures):**
- **Leg T** (`al-runner-v3.tables.baseline.json`): exactly 6 mutants move `survived` → `no-coverage`, all in Data Main's `"No."` and
  `Processed` OnValidate (`Touched := Touched + 1`, which the only covering tests reach after an `asserterror` that raises first): key
  prefix `8037f4fe07` remove-assignment x2; `7b5887f1e8` delete-additive-right x2 and swap-additive x2. Every other trigger mutant
  keeps its verdict (attribution `object`/`all-green` → `line` where it applies). Leg T's comparison with BC's `tables.baseline.json`
  gains exactly these 6 as new BC-vs-v3 differences, so `TABLES_KNOWN_DIFFERENCES` (`al-runner-v3-tables-known.ts`) grows by these 6.
- **Leg WR** (`al-runner-v3.wrapped.baseline.json`): exactly 6 move `survived` → `no-coverage`, in the UNWRAPPED twins only (their
  fixture comments say never run): Wrapped View Twin, Wrapped Xtra Twin and Wrapped Y Band Twin (request page) OnOpenPage, each
  flip-boolean-literal and remove-assignment. The `#if`-wrapped originals have no `reachLine` and stay; any twin-parity check flags these
  6 as twin differences.
- **Legs MO, layout, symbols-lethala/b:** no trigger mutants: unchanged. Every other leg: unchanged.
- **No killed mutant moves** in any leg. A kill that moves is a BLOCK (the frame of `reachLine` vs line coverage would be wrong), not a
  re-record.
- **BC gates:** unchanged (bcdev reports procedure-grain coverage, so no session is line-complete).

**Procedure (R332).** Run the full v3 gate once on the final head: it must BLOCK at T and WR with exactly the moves above and nothing else.
Then delete `al-runner-v3.tables.baseline.json` and `al-runner-v3.wrapped.baseline.json`, add the 6 to `TABLES_KNOWN_DIFFERENCES`,
re-record both in record mode (`LETHAL_ITEST_RECORD_BASELINE`), re-run without it to a pass, review the diffs (only these 12 mutants
and their attribution fields), update the gate page. Any other difference: stop and report.
