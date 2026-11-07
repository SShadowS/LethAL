# R855: pre-commitment for the operator batch (#35, #41, with R-856's #33 and #42)

Committed before any live run of the batch's code. Branch `lethal/r855`, code at 474e672e. Plan: `/coord/handoff/R-834/plan.md`. Every added row's predicted verdict: [predictions](2026-11-07-r855-predictions.md).

## What is built

Four Tier-1 operators, each 1.0.0: `lethal.delete-logical-right`, `-left`, `lethal.delete-additive-right`, `-left`. R-856 adds `swap-call-arguments` 1.1.0 and the opt-in `swap-workdate-today`.

Rulings, as given:

1. **The left of `and` is mutated.** AL does not short-circuit. Measured on bc3 (BC 28.4, `/coord/handoff/R-855/probe/bc3-reading.txt`): `false and Bump()` runs `Bump()`, and `(C > 0) and (T / C > 1)` raises at `C = 0` in the original.
2. **A constant left over is refused.** Wider than ruled: not only a bare literal, but anything with no name in it (`3 * 100`, `-(300)`, `'a'`), because each of those failed `alc` with AL0369.
3. **An array index stays in**, and so does a call argument such as `CopyStr(S, A - B)` or `Power(2, A - B)`: ordinary changed behaviour (R163). A raised error is a real kill if a test sees it.

Refused with no ruling needed: a site in a divisor, at any depth, including `/=`; a loop's exit parts; a deleted operand holding a call the loop's progress needs; a site controlling such a call, through `if`, `case` or a `for` bound, or a `continue`; an argument of such a call; equal operands; a chain's left. Known limit, named in `docs/using-lethal-from-an-agent.md`: anything behind a callee ([[R837]]), and progress ended by an `Error` inside a callee. `negate-conditional` and `swap-additive` have those exposures today.

## The whole-batch dump, at 474e672e

Production dump on all five sets, every operator, dedup and dispatch included. Logs: `/coord/handoff/R-855/diff-*.log`.

| set | specs | added | hang-refused | removed | tuples moved | ordinals moved |
|---|---|---|---|---|---|---|
| fixtures (25) | 693 > 738 | 45 | 0 > 0 | 0 | 0 | 0 |
| CDO | 57,138 > 58,179 | 1,041 | 539 > 589 | 0 | 0 | 0 |
| DO | 80,646 > 81,973 | 1,327 | 639 > 701 | 0 | 0 | 0 |
| DC | 198,780 > 204,167 | 5,387 | 2,831 > 3,220 | 0 | 0 | 0 |
| BC.History (519) | 2,275,749 > 2,320,454 | 44,705 | 66,817 > 72,084 | 0 | 0 | 0 |

**No bump.** Add-only on every set. `IDENTITY_SCHEME` stays. Project-wide M-codes of existing mutants DO shift (`mutantId` is positional): baselines key on the identity tuple, so that moves no row, but the hand tables that quote M-codes moved, and those edits are in the branch. `numberingDigest` changes for a project that gains a site, so a mark without `fileSingleton` reads `renumbered` and stays a survivor. That goes in the CHANGELOG, with ruling 3.

By operator (logical-right, logical-left, additive-right, additive-left): CDO 480, 425, 88, 5. DO 612, 522, 141, 6. DC 2,355, 1,928, 704, 121. BC.History 16,207, 13,256, 9,000, 2,541.

The two new hang shapes were scanned as part of this dump: the refused sites are the `hang-refused` column.

## Compile, with every mutant in

`exit0` true on both the control and the instrumented build, at ed725872 (`/coord/handoff/R-855/real-compile.out`, `compile-DC-stub/`):

- DO/Cloud: 45,090 specs, 0 errors.
- DC/Cloud: 122,287 specs, 0 errors, on a scratch copy with 28 missing JS resource files stubbed. Without them `alc` stops at AL0327 in both builds.
- A typed probe, 117 specs, 0 errors: Byte, BigInteger, Decimal, Option, Enum, unary minus, array index, case selector.

These are repeated on the final head before submit.

## Rows that move, per project

The added rows and their predicted verdicts are in the predictions file. Instrumented counts: `sandbox-app` +3, `sandbox-names` +12, `sandbox-wrapped` +4, `sandbox-data` +12, `sandbox-codefree` +8, `sandbox-coverage-probe` +3, `sandbox-layout` +1, `sandbox-multiobject` +2, `sandbox-symbols` +2, `examples/credit-limit` +3. `sandbox-hang` and `sandbox-harden`: 0, so no hang-capable site enters a gate and harden's answer key stands. `examples/gift-card`: 0 from #35 and #41.

Every other row of every baseline must stay as it is, per mutant. Any change there is a BLOCK.

## Other expected changes

- `sandbox-layout`'s `Layout Beta` now has 8 guards against the leg's budget of 7, so L1 prints the oversized-batch warning. Pre-committed, not a surprise. The two-batch split stands. The leg's `expected warnings` gain that one code if the leg demands it.
- `line-map.test.ts`'s GH-09 rows are measured BC coverage rows. Two new `ClampPercent` arms move them, so they are re-measured from `LETHAL_FENCED_COVERAGE_DUMP` of the bcdev record, not derived. Until then that test stays red.
- `itest/verify-gaps.ts`: the `ClampPercent` gap keeps id G82da08c0d8a7 and gains `delete-logical-left` and `delete-logical-right`.
- `V3_WR_KILLERS` shifts and gains the four wrapped kills, length 58 to 62.
- `itest:chunked`'s `CHUNKED_FIGURES`, `itest:lend`'s frozen keys and `verify-scale` move with the added rows on `sandbox-app`. Each gate's page is updated with its figures.
- `examples/credit-limit/demo.baseline.json` gains 3 rows: a deliberate re-freeze. The gift-card sample re-freezes once for the batch, on bc-demo, for #42's row.
- `envtool.baseline.json` is host only: the owner runs it, through `UNVERIFIED_MOVES`.

## Record order

One branch, one change, one record, on BC 28 only.

1. BC by R332, on one server, bc3: `bcdev`, `bcdev.names`, `bcdev.wrapped`, `tables`. Delete, record, confirm by a second run, and read every added row against the predictions.
2. v3 by R849's route: commit `itest/expected/<basename>` first, with each added row's verdict and killing test from this pre-commitment or the BC row, never from a dump. Delete, record on `current`, confirm, delete the expected files in the commit that lands the baselines. Where v3 differs from BC on a new row, that is filed upstream.
3. Leg T's pins and `v3ReadingsDigest` move with the v3 record, through the update gate, with lethal-code.
4. All gates on the final head. `itest:hang` on two servers, because `loop-hazard.ts` changed. CI read as its own step.

The gate's first line names the v3 build it ran: `current` may move at 07:47.

A row that differs from its prediction is read and explained before anything lands. If the explanation is that the prediction was wrong, this file stays as it is, and the submit note says which rows.

## Addendum, 2026-11-07: legs this file did not name

This addendum was written after lethal-code's full v3 gate at 88f67370 stopped on these legs, so the v3 figures below were seen first. It is a statement of what happens next, not a prediction of v3. Nothing else in this file moves.

- **Leg K.** 3 / 14 / 5 over 22, with 5 no-coverage, all in `SandboxPricing.Codeunit.al`. The fifth is the row already predicted above. Its count of 4 was a stale pin, and it compared 0 differences with `bcdev.baseline.json`.
- **S1E and N1S `entriesSent`:** 44 to 48, and 200 to 266. Cost figures, read from that run, not derived.
- **Legs D1 and D1c, the CDO slice.** This file left them out, which was a gap: DO's `CDORecipientMgt.Codeunit.al` gains 2 rows, both in `MoveRecipientFromHeaderToTable` at line 60, `delete-logical-right` and `delete-logical-left`. v3 reads D1 53 / 12 / 0 over 65, and D1c 53 / 8 / 4 over 65, so it read both as killed. Those legs compare per mutant with a BC report (`docs/measurements/r594/`), which has no such rows.

**BC decides, not v3.** Before those figures move, both legs of `scripts/r594/run-leg.sh` run on bc3 at this branch, and their reports replace `bc3-A.report.json` and `bc3-B.report.json`, redacted. Pre-committed outcome: leg A 53 / 12 / 0 over 65, leg B 53 / 8 / 4 over 65, the 63 existing rows equal to the current reports on verdict and killing test, and both new rows `killed`. If BC reads a new row otherwise, that is a v3 difference and is filed upstream, and leg D's figures take BC's reading.

## Addendum 2026-11-07: the manifest rows

Leg T's counts moved, so the hand pins' digest moved from `18793d7f161dba8071a394cab44b98dd3f59fb15e47cb1b057a4fa227030ccef` to `f3d2aede5f3d8273b616237d80b7c0a72e18be71acf4f169999fb6882066872e` (`--pin-digests`), and `r814-gated-builds.test.ts` fails until a person deals with the rows. No scripted route does that before a merge: [[R859]]. Written before any row is edited. The `current` pin itself does not move.

Each row changes only after its own full v3 gate passes at 88f673709002fbcf0769ad5d3108404ee59e1d57, with the row's binary. A row whose gate does not pass is not edited, and comes back to the orchestrator. Edited with the Edit tool, in `packages/runner/src/al-runner-v3-gated-builds.json`.

| row | readingsDigest, old | readingsDigest, new | lethalCommit, old | lethalCommit, new | gate |
|---|---|---|---|---|---|
| `alpha.12-d4bc8d3a5` | 18793d7f | f3d2aede | a7ac7f500c | 88f67370 | its kept binary, candidate mode with K, by its own hand pin |
| `alpha.13-23e7631be` | 18793d7f | f3d2aede | 25a2f95fbe | 88f67370 | its kept binary, candidate mode with K, `LETHAL_V3_PIN_FROM=edge-d72d3197d` |
| `edge-a0825f1d9` (`current`) | 18793d7f | f3d2aede | 25a2f95fbe | 88f67370 | the same gate, on `current` |
| `edge-a0189c004` | 18793d7f | row removed | 25a2f95fbe | row removed | none: an old edge row can only be removed |

`gatedAt` takes each pass's time, and `version`, `binarySha256`, `tag`, `track`, `readingsFrom` and `warnFacts` stay.
