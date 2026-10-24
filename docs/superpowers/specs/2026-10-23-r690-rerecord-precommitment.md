# R-690 (roadmap R690): pre-commitment for re-recording the ten baselines at IDENTITY_SCHEME 42 (2026-10-23)

Written BEFORE any record run, on master 70955e86 (R-604b merged, `IDENTITY_SCHEME` 42). Any difference below is a
BLOCK: it is reported, never recorded.

## The ten files, their gates, and where they run

| baseline | recorded scheme | gate (record leg) | where |
|---|---|---|---|
| `bcdev.baseline.json` | 38 | `itest:bcdev` | bc1 |
| `bcdev.names.baseline.json` | 40 | `itest:bcdev-names` | bc1 |
| `bcdev.wrapped.baseline.json` | 38 | `itest:bcdev-wrapped` | bc1 |
| `tables.baseline.json` | 38 | `itest:tables` | bc2 |
| `harden.baseline.json` | 38 | `itest:harden` | bc2 |
| `hang.single.baseline.json` | 38 | `itest:hang` (single leg) | bc3 (the only server proven for hang at tests app 1.0.0.4) |
| `al-runner-v3.tables.baseline.json` | 40 | `itest:alrunner-v3` leg T (`LETHAL_ITEST_V3_TABLES=1`) | local |
| `al-runner-v3.layout.baseline.json` | 41 | `itest:alrunner-v3` leg L1 | local |
| `al-runner-v3.symbols-lethala.baseline.json` | 41 | `itest:alrunner-v3` leg Y-A | local |
| `al-runner-v3.symbols-lethalb.baseline.json` | 41 | `itest:alrunner-v3` leg Y-B | local |

Every server named is proven for that gate in `docs/gates/servers.md`. `envtool.baseline.json` stays on R683 (host
only).

**Correction to R690.md.** It says the two symbol baselines use `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`. That
variable belonged to the retired v2 gate and no longer exists in any itest. The v3 symbol legs record with
`LETHAL_ITEST_RECORD_BASELINE=<file>`, as R-654 S2 did. R690.md is corrected when it closes.

## The prediction, per file
- **Verdicts byte-identical.** Every entry's `key`, `verdict`, `killingTest`, `coverageFiltered` and `errorClass`
  equal the old file's, by mutant key, with `identityScheme` and `mutatedTextSha256` set aside. The same entry count,
  and no entry added or missing.
- **What moves:** only `identityScheme` (to 42), and `mutatedTextSha256` where a hash was missing or is now set.
- **The record run** writes the file and exits 3. The leg checks its pre-committed table before it writes.
- **The confirm run** (no record variable) passes and prints NO `identity scheme changed` line and NO text-UNVERIFIED
  count for that baseline, because the scheme now matches.

## The procedure (R332), per file
1. Delete the file in the branch worktree.
2. Run its gate once with `LETHAL_ITEST_RECORD_BASELINE=<file>`, which exits 3.
3. Re-run without the variable, and confirm the pass.
4. Diff old against new with the scheme and hashes stripped, using a script under `/coord/handoff/R-690/`. It must be
   identical.

The v3 legs record in one run: `LETHAL_ITEST_V3_LEGS=L1,Y-A,Y-B,T` with the four file names.

## Finally
- Remove the ten from `LAGGING_SCHEME` (`gate-pages.test.ts`); envtool stays on R683.
- Update each gate page's frozen-figures note, if it names the scheme.
- R690 becomes `done (<commit>)`.
- Verify, CI, submit.
