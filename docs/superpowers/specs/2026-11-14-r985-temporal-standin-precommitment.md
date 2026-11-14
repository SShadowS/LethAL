# R-971 pre-commitment: toggle-blank-temporal's Date and DateTime stand-ins move off 1753-01-01 (R985), and R984

Committed before any gate run, 2026-11-14. Coord task R-971, branch `lethal/r-971` (build at bafb1b91). Evidence:
`/coord/handoff/R-971/`.

## The change

- **R985.** `toggle-blank-temporal`'s non-blank stand-ins: Date `17530101D` -> `17530103D`; DateTime
  `CREATEDATETIME(17530101D, 000001T)` -> `CREATEDATETIME(17530103D, 000001T)`; Time `000001T` unchanged. BC refuses to write
  1753-01-01 to a table (SQL keeps `0D` there; #28's reporter, BC 28.0), so a mutant whose value reached a write died on the write.
  -03 rather than -02 because a DateTime is stored in UTC and `CREATEDATETIME` reads the user's time zone: two days clear stays
  storable at any offset (at most 14 hours).
- **Identity: operator MAJOR 1.0.0 -> 2.0.0, `IDENTITY_SCHEME` unchanged.** History's rule 2 carries a verdict by (file, tuple,
  member hash), and the tuple holds the operator major; a minor bump would carry a verdict measured on the old text (a kill by the
  refused write) onto the new mutation. No site enters or leaves and no ordinal moves, so the scheme does not change. Agreed with the
  orchestrator 2026-11-14.
- **R984.** `shift-integer` operands of `=`/`<>` carry R983's site risk `compared-value`: a manifest and report field only.

## Offline proof (done)

Every fixture emitted from master edd1ff6d and from the branch and diffed (`classify.ts`, `classify.out`): the only differences are
138 `shift-integer` comparison entries gaining `equivalenceRisk`, 8 temporal entries at 2.0.0 (4 with the new text), and 4 AL lines
that differ by the date alone. VERIFY FULL passes on the build.

## BC measurement (before any gate)

On `bc2`, under a lease, the invented probe `/coord/handoff/R-971/p/` (ids 91500-91516), Insert and Modify of a Date and a DateTime
field. Predicted: `17530101D` fails on both (BC's "Cannot write the value 01/01/1753 ..."); `17530103D` stores on both;
`CREATEDATETIME(17530103D, 000001T)` stores on both; `17530102D` and the 1753-01-01 DateTime recorded as found. If BC refuses
`17530103D` or its DateTime, nothing below runs and the stand-in is chosen again. (al-runner c8fe56e05, measured: 1753-01-01 Date
refused on Modify and failed on Insert, its DateTime refused on both; 1753-01-02 and -03 store on both.)

## Predicted gate figures

**`itest:tables` (`tables.baseline.json`) and the v3 gate's leg T (`al-runner-v3.tables.baseline.json`), both re-recorded by
R332's procedure.** Exactly the four `toggle-blank-temporal` rows change, and nothing else in either file:

| Procedure | key suffix | mutatedTextSha256 | verdict, killingTest |
|---|---|---|---|
| IsDueDateSet | `\|1` -> `\|2` | -> `c68b05a6...02b98` (`17530103D`) | unchanged |
| IsTimestampSet | `\|1` -> `\|2` | -> `1ff0dfce...1daa5` (`CREATEDATETIME(17530103D, 000001T)`) | unchanged |
| StampFixedDate | `\|1` -> `\|2` | unchanged (`0D`) | unchanged |
| IsCutoffSet | `\|1` -> `\|2` | unchanged (`000001T`) | unchanged |

The aggregate figures (killed 322, survived 73, no-coverage 23) do not move. Both changed rows are comparison sites: a test that
drives the blank value kills `X = 17530103D` exactly as it killed `X = 17530101D`.

**Every other gate:** no baseline holds a temporal row (checked: only the two above), and R984's field is not in any baseline, so
`itest:bcdev`, `-names`, `-wrapped`, `chunked`, `hang`, `harden`, `lend` and the v3 legs other than T read identical per-mutant
rows. They are not re-recorded.

A per-mutant difference beyond the table above is a BLOCK.

## Procedure

Delete both baseline files; run `itest:tables` on `bc2` with `LETHAL_ITEST_RECORD_BASELINE=tables.baseline.json`, and the full v3 gate
with `LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.tables.baseline.json`; re-run each without the variable to confirm PASS; diff each
new file against the old one and check it against the table above; update `docs/gates/tables.md` and `alrunner-v3.md`; commit.

## Amendment 1 (2026-11-14, before any gate run): the stand-in is 17540102D; R984 left; the v3 record goes by R849

**BC measured, and refused 17530103D**, as this file's "BC measurement" section allowed: three owner-approved probe runs on `bc2`
(`/coord/handoff/R-971/bc-probe-result.md`; each unpublished after its run, `lethal doctor` ok, lease released). BC 28.4 refuses to
write EVERY non-zero date in 1753, as a Date or a DateTime, by Insert and by Modify (1753-01-01 ... 1753-12-31 23:59:59, 17 values);
it stores 1754-01-01 (Date, and DateTime at 00:00:01), 1754-01-02, 1800-01-01, 1900-01-01, 2000-01-01, `0D` and `0DT`. al-runner
stores all the 1753 values BC refuses (upstream #8006).

**So the stand-ins are now:** Date `17530101D` -> `17540102D`; DateTime `CREATEDATETIME(17530101D, 000001T)` ->
`CREATEDATETIME(17540102D, 000001T)`; Time `000001T` unchanged. 1754-01-02 rather than -01 for the reason this file gave for -03: a
DateTime is stored in UTC and `CREATEDATETIME` reads the user's time zone, and a date one day clear of the bound stays storable at any
offset under a day. Operator MAJOR 2.0.0 and `IDENTITY_SCHEME` unchanged, as above.

**R984 is no longer part of R-971.** It landed from coord task R-978 (master 4dde9306); the branch takes master's R984 code as is.

**Offline proof, redone** on the branch (master 2ec65b05 merged): every fixture emitted from master and from the branch and diffed
(`/coord/handoff/R-971/classify.ts`): 8 temporal entries at 2.0.0, 4 of them with the new text, and 4 AL lines that differ by the date
alone; NO OTHER DIFFERENCE. The emit goldens move for the same three files only.

**Predicted gate figures, replacing the table above** (both baselines; verdicts, killing tests and every other row unchanged; the
aggregate figures do not move):

| Procedure | key suffix | mutatedTextSha256 | verdict, killingTest |
|---|---|---|---|
| IsDueDateSet | `\|1` -> `\|2` | `b32c785e...55c4` -> `f9a73ea9...54cd` (`17540102D`) | unchanged |
| IsTimestampSet | `\|1` -> `\|2` | `9fb81652...5db5` -> `bae33c5e...b2cc` (`CREATEDATETIME(17540102D, 000001T)`) | unchanged |
| StampFixedDate | `\|1` -> `\|2` | unchanged (`0D`) | unchanged |
| IsCutoffSet | `\|1` -> `\|2` | unchanged (`000001T`) | unchanged |

The key's leading hash does not move (no site's text before the mutation changes), so the rows keep their order.

**The v3 record goes by R849's route.** `al-runner-v3.tables.baseline.json` is a pinned build's baseline, and R810 lets a record write
only committed rows; the four keys change. So the expected file `packages/runner/itest/expected/al-runner-v3.tables.baseline.json`,
the committed baseline with exactly the four rows above changed, is committed to master before the record, and the record must equal
it. `tables.baseline.json` (BC, `itest:tables` on `bc2`) is deleted and recorded by R332, then checked against the same table. Merge
master into the branch before either run (the lethal-control R-988 bump may land first).
