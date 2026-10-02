# R383 pre-commitment: `sandbox-multiobject` under the restored multi-object refusal

Written **before** the refusal is restored in code and before any al-runner run of it, and committed
alone. It replaces nothing: `docs/superpowers/specs/2026-10-02-r383-multiobject-precommitment.md`
(`bc2511ba`) stays as the prediction for the day upstream reports every object in the right frame.
bcdev has already matched that table exactly (killed 6, survived 1, no-coverage 5, every killing
and covering test equal), so it is the bcdev-validated FUTURE table. This file is the table the
al-runner legs must match TODAY. A verdict, killing test or covering test that differs from it is a
FINDING and a stop. It is reported, never edited into the table.

## Why the refusal comes back

The first live run of the R383 build (pinned al-runner `v2.12.0-main.c39ad5de`, one-shot and
`--server`, both identical) failed `bc2511ba`'s table on M0003, M0004 and M0005: `Multi A.Never`,
which no test calls, read `survived` with `ReachedBothWays` covering it. The cause is in al-runner,
not in LethAL's resolver. al-runner compiles LethAL's INSTRUMENTED bundle, but it finds the source
project with the same app id and labels coverage with the SOURCE path. For a file's first object
the lines are right. For every object after it, a line is reported as (the previous object's
closing-brace line in the SOURCE) + (its distance from that line in the INSTRUMENTED text). In
`MultiPair.Codeunit.al`, `Multi A` ends at source line 7 and instrumented line 24, so `Multi B`'s
instrumented lines 33, 35, 40, 45 and 50 come back as 16, 18, 23, 28 and 33, and the first three of
those lie inside `Multi A` in the instrumented frame LethAL indexes. The same bundle with a fresh
app id (no source project to find) reports the instrumented lines unchanged. Nothing in either
payload says which frame a line is in, so LethAL cannot undo it.

Ruling (option A): restore the whole-run refusal for any file declaring more than one object.
`alRunnerCoverageSupport` reports `supported: false`, the CLI guard falls back to coverage
`"none"` with one named warning, and the index skips the file. The R383 resolver, partition fix
and server procedure rule stay as infrastructure.

## What coverage "none" does here

`runSession`'s coverage step (`packages/runner/src/orchestrator.ts`, `caps.coverage === "none"`)
gives EVERY mutant EVERY green baseline test, and records no `coverageAttribution` for any mutant
("Empty on the `coverage: \"none\"` branch below, where every mutant runs every green test by
construction and no attribution happened at all"). `coverageFilter` (`selection.ts`) is not called,
so no mutant can be `no-coverage`. The report's `coverageMode` is `"none"`.

Both tests are green at baseline (the fixture is unchanged since `5daccc09`), so every mutant's
covering set is `{Multi Tests.ControlDoubles, Multi Tests.ReachedBothWays}`. Each kill fails in
exactly one of the two tests (`ControlDoubles` calls only `Multi Control.Double`;
`ReachedBothWays` calls only `Multi B.Reached`), so no test order can change a killing test.

## The prediction

The same twelve mutants and identity keys as `bc2511ba`'s table (code, file, line, operator,
procedure; one batch). Every al-runner leg: one-shot and `--server`, both requesting
`coverage: "al-runner"` through the CLI guard and receiving `"none"`. Each must equal this table per
mutant, covering tests included, and the two legs must equal each other. `killingTest` is the
method name; covering tests are qualified. No mutant carries `coverageAttribution`.

Covering tests for every row: `Multi Tests.ControlDoubles`, `Multi Tests.ReachedBothWays`.

| code | file:line | operator | procedure | verdict | killing test | why |
| --- | --- | --- | --- | --- | --- | --- |
| M0001 | MultiControl:4 | empty-block | Double | killed | ControlDoubles | Empty body returns 0; `Double(3)` must be 6. |
| M0002 | MultiControl:5 | return-value | Double | killed | ControlDoubles | `exit(0)`; 0 is not 6. |
| M0003 | MultiPair:4 | empty-block | Never | **survived** | - | No test calls `Multi A`; was no-coverage under `bc2511ba`. |
| M0004 | MultiPair:5 | return-value | Never | **survived** | - | As M0003. |
| M0005 | MultiPair:5 | swap-additive | Never | **survived** | - | As M0003. |
| M0006 | MultiPair:12 | empty-block | Reached | killed | ReachedBothWays | `Reached(20)` returns 0, not 21. |
| M0007 | MultiPair:13 | conditional-boundary | Reached | survived | - | `X >= 10` differs only at 10; the test uses 20 and 5. |
| M0008 | MultiPair:14 | return-value | Reached | killed | ReachedBothWays | `Reached(20)` returns 0, not 21. |
| M0009 | MultiPair:14 | swap-additive | Reached | killed | ReachedBothWays | `Reached(20)` returns 19, not 21. |
| M0010 | MultiPair:15 | return-value | Reached | killed | ReachedBothWays | `Reached(5)` returns 0, not 5. |
| M0011 | MultiPair:17 | empty-block | Unreached | **survived** | - | No test calls `Unreached`; was no-coverage under `bc2511ba`. |
| M0012 | MultiPair:18 | return-value | Unreached | **survived** | - | As M0011. |

Counts: killed **6**, survived **6**, no-coverage **0**, over 12. Against `bc2511ba`: the five
no-coverage rows (A's three, `Unreached`'s two) become survived, every covering set grows to both
tests, `coverageAttribution` disappears, and no killed verdict or killing test moves.

## What the legs also assert

- The refusal HAPPENED, not merely a coverage-none run: the CLI guard
  (`withAlRunnerCoverageGuard`) is handed `alRunner.coverage: "al-runner"`, returns `"none"`, and
  emits exactly one `al-runner-coverage-unsupported` warning naming
  `src/MultiPair.Codeunit.al (more than one object)` and not `src/MultiControl.Codeunit.al`.
- Each leg's report has `coverageMode: "none"`.
- One batch, green baseline.

## What each wrong behaviour would show

- **Refusal not restored** (the R383 admission still live): M0003 to M0005 read `survived` with
  `ReachedBothWays` alone and `coverageAttribution: "exact"`, M0011 and M0012 `no-coverage`, which
  is exactly the failed live run. The warning check fails first.
- **Index skip without the guard** (coverage left on, the file dropped): every `MultiPair` mutant
  has no entry, so all ten read `no-coverage`, killed ones included.
- **Guard naming the wrong file**: the warning check fails by name.

## The order

1. This document and the note on `bc2511ba`'s file, committed alone.
2. The refusal restored in code, with its unit tests, offline.
3. `itest:alrunner`'s multi-object legs, one-shot then `--server`, on the pinned build. Both must
   equal this table per mutant and each other.
4. `al-runner.multiobject.baseline.json` recorded once under R332, with the receipt. Until then it
   stays in `PENDING_FIRST_RECORD`.
