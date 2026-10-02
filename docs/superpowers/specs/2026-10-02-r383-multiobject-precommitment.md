# R383 pre-commitment: `sandbox-multiobject`, two codeunits in one file, on bcdev and al-runner

> **Note added 2026-10-02, after the first live runs. The table below is not edited.** bcdev matched
> it exactly. The al-runner legs did not (M0003 to M0005 read `survived`), because al-runner
> `v2.12.0-main.c39ad5de` reports every object after a file's first in a frame LethAL cannot undo.
> The multi-object refusal is restored, and the al-runner legs now match
> `2026-10-02-r383-multiobject-refusal-precommitment.md` instead. This table stays as the
> bcdev-validated FUTURE prediction for al-runner, for when upstream fixes that frame.

Written **before** any live run on this fixture (no bcdev run, no al-runner session), and committed
alone. Every row below is derived by hand from the AL and from the code at `5daccc09` (fixture and
offline guard) on top of `d607eaba` (the R383 build), checked against an offline instrumentation
of the fixture (see "How the mutants were derived"). A verdict, killing test or covering test that
differs from this table is a FINDING and a stop. It is reported, never edited into the table.

**Terms.** *File-relative* line: counted from the top of the file. *Object-relative* line: counted
from the object's *base line*, which is one past the previous object's last line (the first object
bases at 1; `LineMapEntry.baseLine`). al-runner reports file-relative lines on both transports
(measured on v2.12.0, `docs/roadmap/R383.md`); BC reports object-relative ones. *Covering tests*
are the tests whose baseline coverage reaches the mutant's procedure; only they run against it.

## The fixture

`fixtures/sandbox-multiobject` (ids 79800 to 79849, no dependencies, runtime 13.0), two files.

`src/MultiPair.Codeunit.al`, 20 lines (the `// line N` markers are for this document only):

```al
codeunit 79800 "Multi A"                        // line 1
{
    procedure Never(X: Integer): Integer        // line 3
    begin
        exit(X + 7);                            // line 5
    end;
}                                               // line 7
                                                // line 8, B's base line
codeunit 79801 "Multi B"                        // line 9
{
    procedure Reached(X: Integer): Integer      // line 11
    begin
        if X > 10 then                          // line 13
            exit(X + 1);                        // line 14
        exit(X); end;                           // line 15
    procedure Unreached(X: Integer): Integer    // line 16
    begin
        exit(X * 3);                            // line 18
    end;
}                                               // line 20
```

`src/MultiControl.Codeunit.al`, one object, `codeunit 79802 "Multi Control"` with
`Double(X): Integer` returning `X * 2` (line 5).

`fixtures/sandbox-multiobject-tests` (ids 79850 to 79899, depends on the target), one codeunit,
`codeunit 79850 "Multi Tests"`, two tests, each raising through bare `Error(...)`:

| test | calls | raises unless |
| --- | --- | --- |
| `ReachedBothWays` | `Multi B.Reached(20)`, then `Multi B.Reached(5)` | the results are 21 and 5 |
| `ControlDoubles` | `Multi Control.Double(3)` | the result is 6 |

Neither test calls `Multi A` or `Multi B.Unreached`. Both pass on the unmutated code, so the
baseline is green.

## How the mutants were derived

Offline, no al-runner and no BC: `generateMutationSet` over the project, `planArtifacts` with the
default batching (one batch holding both files), `writeInstrumentedProject` with selector ids
79847-79849, then the written `mutant-manifest.json`. The same derivation is now a unit test,
`packages/runner/tests/multiobject-fixture.test.ts`, which also checks that each baseline line of
the EMITTED pair resolves to its own object and procedure through `buildAlRunnerCoverageIndex`.
Twelve mutants, one batch:

| code | file:line | operator | object | procedure |
| --- | --- | --- | --- | --- |
| M0001 | MultiControl:4 | empty-block | codeunit 79802 | Double |
| M0002 | MultiControl:5 | return-value (`exit(0)`) | codeunit 79802 | Double |
| M0003 | MultiPair:4 | empty-block | codeunit 79800 | Never |
| M0004 | MultiPair:5 | return-value (`exit(0)`) | codeunit 79800 | Never |
| M0005 | MultiPair:5 | swap-additive (`X - 7`) | codeunit 79800 | Never |
| M0006 | MultiPair:12 | empty-block | codeunit 79801 | Reached |
| M0007 | MultiPair:13 | conditional-boundary (`X >= 10`) | codeunit 79801 | Reached |
| M0008 | MultiPair:14 | return-value (`exit(0)`) | codeunit 79801 | Reached |
| M0009 | MultiPair:14 | swap-additive (`X - 1`) | codeunit 79801 | Reached |
| M0010 | MultiPair:15 | return-value (`exit(0)`) | codeunit 79801 | Reached |
| M0011 | MultiPair:17 | empty-block | codeunit 79801 | Unreached |
| M0012 | MultiPair:18 | return-value (`exit(0)`) | codeunit 79801 | Unreached |

## The prediction

Every leg: bcdev (the authority, once), and `itest:alrunner`'s one-shot and `--server` legs, both
with `coverage: "al-runner"`. The same table for all three, per mutant, covering tests included.
`killingTest` is the method name; covering tests are qualified. A covered mutant's
`coverageAttribution` is `exact`; a `no-coverage` mutant carries none.

| code | verdict | killing test | covering tests | why |
| --- | --- | --- | --- | --- |
| M0001 | killed | ControlDoubles | Multi Tests.ControlDoubles | An empty body returns the default 0; `Double(3)` must be 6. |
| M0002 | killed | ControlDoubles | Multi Tests.ControlDoubles | `exit(0)`; 0 is not 6. |
| M0003 | no-coverage | - | (none) | No test calls `Multi A`; every A line has 0 hits. |
| M0004 | no-coverage | - | (none) | As M0003. |
| M0005 | no-coverage | - | (none) | As M0003. |
| M0006 | killed | ReachedBothWays | Multi Tests.ReachedBothWays | An empty body returns 0; `Reached(20)` must be 21. |
| M0007 | survived | - | Multi Tests.ReachedBothWays | `X >= 10` differs from `X > 10` only at X = 10; the test uses 20 and 5. |
| M0008 | killed | ReachedBothWays | Multi Tests.ReachedBothWays | `Reached(20)` returns 0, not 21. |
| M0009 | killed | ReachedBothWays | Multi Tests.ReachedBothWays | `Reached(20)` returns 19, not 21. |
| M0010 | killed | ReachedBothWays | Multi Tests.ReachedBothWays | `Reached(20)` is still 21, but `Reached(5)` returns 0, not 5. |
| M0011 | no-coverage | - | (none) | No test calls `Unreached`; it shares object 79801 with `Reached`, which IS covered, so this row is what separates procedure-level from object-level attribution inside the second object. |
| M0012 | no-coverage | - | (none) | As M0011. |

Counts: killed **6**, survived **1**, no-coverage **5**, over 12. Each covered procedure has one
covering test, so killer-first ordering (R197) cannot change a killing test.

## What each wrong behaviour would show

- **The pre-R383 refusal** (a multi-object file turns al-runner coverage off for the run): every
  mutant runs every green test, so M0003, M0004, M0005, M0011 and M0012 read `survived` with both
  tests covering, and the covered mutants' covering sets grow to both tests.
- **No frame conversion** (file-relative lines read as object-relative): B's baseline lines in the
  emitted text land 25 lines further down B, several of them inside `Unreached`, so M0011 and M0012
  gain `ReachedBothWays` and read `survived` (`Unreached` is never called, so nothing kills them).
  Red-checked offline (`.superpowers/r383-redcheck.log`, RC16).
- **The wrong object** (a row resolved to A instead of B, or by a procedure name alone): A's
  mutants gain a covering test.
- **A base exactly one line off: NOT visible on this fixture live, stated rather than hidden.** In
  the SOURCE, `Unreached` starts on the line right after `Reached`'s last statement, so a base one
  line off moves that statement into `Unreached` (pinned offline, RC17). But coverage is read from
  the INSTRUMENTED text, where the emitter puts two closing lines (`end`, `end;`) after `Reached`'s
  last baseline statement and two header lines before its first, so no covered line is adjacent to
  another procedure and a one-line error cannot move a verdict (measured offline, RC16b). The exact
  conversion is pinned by the offline resolver and transport tests instead (RC5, RC11).

## The order, and what is not decided here

1. This document, committed alone.
2. `bun run compile:fixtures`, then publish the pair on Cronus28 under a lease, then ONE bcdev run.
   A bcdev difference from this table is reported as a finding, not edited in.
3. `itest:alrunner`'s new legs, one-shot then `--server`, on the build the gate is pinned to (the
   gate prints it first). Both must equal this table per mutant and each other.
4. The baseline `al-runner.multiobject.baseline.json` is recorded once under R332, with the receipt.

Not decided here: which al-runner build the live legs run on. The plan measured v2.12.0; master now
pins the source build `v2.12.0-main.c39ad5de`, on which the R383 probe has not been re-run (plan
Task 0). A frame or result difference between builds is a stop.
