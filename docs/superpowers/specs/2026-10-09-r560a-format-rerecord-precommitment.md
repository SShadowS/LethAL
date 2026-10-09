# R-560 part A: re-record the 7 itest:alrunner baselines under R556's format (pre-commitment)

Committed to master BEFORE any record run (R332). Lane `lethal-preproc`, 2026-10-09.

## What changes, and what must not

This is a FORMAT-only re-record. A "row" below is one mutant entry in a baseline file.

- Each file changes from a bare array to R556's object `{ "identityScheme": <n>, "entries": [...] }`.
- Each row gains `mutatedTextSha256`, a sha256 hash of the mutant's mutated text. The text itself is never stored.
- Nothing else may change. In every row, `key`, `verdict`, `killingTest`, `errorClass` and `coverageFiltered`
  must be byte-identical to the committed file. The row count and the set of keys must also be unchanged. Any other
  difference is a BLOCK: report it, do not record it.
- `identityScheme` must be **38** (R-555's scheme). R-555 is already on master (d5a1650e), so the new files do not
  read "scheme changed" against the very next build.
- Row ORDER is compared too. An order-only difference is not a verdict change, but it is still reported in the
  submit note before anything is committed.
- Every row must carry a hash. A row without one means its text was clipped (longer than 600 characters) or not a
  string. That is a finding to report, not a pass.

## Files, with the figures that must come back unchanged

| file | rows | killed / survived / no-coverage | sha256 of the committed file (first 12 hex) |
|---|---|---|---|
| `al-runner.baseline.json` | 19 | 3 / 12 / 4 | a265c31fd531 |
| `al-runner.cli-default.baseline.json` | 19 | 3 / 16 / 0 | 92e85328eaad |
| `al-runner.layout.baseline.json` | 10 | 7 / 3 / 0 | d0ffe1199745 |
| `al-runner.multiobject.baseline.json` | 12 | 6 / 1 / 5 | 108405d11e68 |
| `al-runner.symbols-lethala.baseline.json` | 9 | 5 / 4 / 0 | 74d979b2558a |
| `al-runner.symbols-lethalb.baseline.json` | 9 | 5 / 4 / 0 | ca4efb25a30b |
| `al-runner.wrapped.baseline.json` | 98 | 58 / 37 / 3 | a4a4c2d8d143 |

All 7 are written by `itest:alrunner`. No BC server is needed.

## Procedure (R332)

1. Delete the 5 files named in run A. Leave the symbol pair in place: the gate refuses a missing baseline that is
   not armed for recording.
2. Record run A: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ITEST_RECORD_BASELINE=al-runner.baseline.json,al-runner.cli-default.baseline.json,al-runner.layout.baseline.json,al-runner.multiobject.baseline.json,al-runner.wrapped.baseline.json bun run itest:alrunner`.
   It must exit 3.
3. Delete the symbol pair, then record run B: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 bun run itest:alrunner`.
   It must exit 3. The two record variables are exclusive, so they run separately.
4. Check mechanically, per file: strip `mutatedTextSha256` from each new row and compare the result to the old array
   (`git show d5a1650e:<file>`), both sorted by `key` and with keys canonicalised by `jq -S`. They must be identical.
   Then compare them unsorted too, and report any order difference. Check that `identityScheme` is 38 and every row has a hash.
5. Confirm run: `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner`, with no record variable. It must PASS, and its
   output must contain no `UNVERIFIED` line for any of the 7 files.
6. Commit the 7 files with this document's sha in the message. In the same branch, R560's stage table changes to
   "a fresh live run" for all 6 stages. R560 stays open, because 6 gate baselines and 6 stages remain.

Each run prints the al-runner build it used as its first line. That line is copied into the submit note.

## Out of scope (by the orchestrator's ruling, 2026-10-09)

- The 6 campaign stages. All of them need a fresh live run. The two examples (gift-card rehearsal, credit-limit demo)
  are bcdev reports at report scheme 3 with no `coverageMode`, so `campaign freeze` refuses them (R355). R560's stage
  table is corrected in the R-560 branch to say so.
- The 6 BC gate baselines (bcdev, bcdev.wrapped, envtool, hang.single, harden, tables). They go in a later batch.
