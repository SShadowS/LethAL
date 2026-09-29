# R321 pre-commitment: `sandbox-symbols` under `[LETHALA]` and `[LETHALB]`, all three al-runner transports, and the `#else` build

Written **before** any al-runner session on this fixture. A verdict or killing test that differs
from this document is a finding and a stop. It is never re-recorded.

## The fixture

```al
codeunit 79600 "Symbol Logic"
{
    procedure Rate(X: Integer): Integer
    var
        ForA: Integer;
        ForB: Integer;
        ForNone: Integer;
    begin
        ForA := 10;
        ForB := 100;
        ForNone := 1;
#if LETHALA
        exit(X + ForA);
#elif LETHALB
        exit(X + ForB);
#else
        exit(X + ForNone);
#endif
    end;
}
```

The one test, `Symbol Tests.RateSmall`, calls `Rate(1)` and raises through bare `Error(...)` unless
it returns 11 (`LETHALA`), 101 (`LETHALB`) or 2 (no symbol). Every build has a green baseline, and
the test asserts that build's own value. The test app is compiled with the same symbols as the
target on every transport.

## The 13 mutants

From `lethal run --dry-run` at `b8e1d70c` and again at the fixture's commit. Site enumeration
ignores `#if` (R214, open), so all 13 exist in every build with the same codes and identity keys.

| code | line | operator | mutated line |
| --- | ---: | --- | --- |
| M0001 | 8 | `lethal.empty-block` | whole body; returns 0 |
| M0002 | 9 | `lethal.remove-assignment` | `ForA := 10` deleted |
| M0003 | 9 | `lethal.shift-integer` | `ForA := 11` |
| M0004 | 10 | `lethal.remove-assignment` | `ForB := 100` deleted |
| M0005 | 10 | `lethal.shift-integer` | `ForB := 101` |
| M0006 | 11 | `lethal.remove-assignment` | `ForNone := 1` deleted |
| M0007 | 11 | `lethal.shift-integer` | `ForNone := 2` |
| M0008 | 13 | `lethal.return-value` | `exit(0)`, `LETHALA` arm |
| M0009 | 13 | `lethal.swap-additive` | `exit(X - ForA)` |
| M0010 | 15 | `lethal.return-value` | `exit(0)`, `LETHALB` arm |
| M0011 | 15 | `lethal.swap-additive` | `exit(X - ForB)` |
| M0012 | 17 | `lethal.return-value` | `exit(0)`, `#else` arm |
| M0013 | 17 | `lethal.swap-additive` | `exit(X - ForNone)` |

Codes are the dry run's order. The gate keys its tables by line and operator, so a renumbering
alone is not a finding.

## Predicted verdict and killing test, per build

`K` = killed by `RateSmall`. `S` = survived, no killing test.

| code | line | operator | `[LETHALA]` | `[LETHALB]` | no symbol (`#else`) | why |
| --- | ---: | --- | --- | --- | --- | --- |
| M0001 | 8 | empty-block | K | K | K | returns 0, never 11, 101 or 2 |
| M0002 | 9 | remove-assignment | K | S | S | A: `Rate(1)` = 1. Elsewhere `ForA` is a dead store |
| M0003 | 9 | shift-integer | K | S | S | A: 12. Elsewhere dead store |
| M0004 | 10 | remove-assignment | S | K | S | B: 1. Elsewhere dead store |
| M0005 | 10 | shift-integer | S | K | S | B: 102. Elsewhere dead store |
| M0006 | 11 | remove-assignment | S | S | K | none: 1. Elsewhere dead store |
| M0007 | 11 | shift-integer | S | S | K | none: 3. Elsewhere dead store |
| M0008 | 13 | return-value | K | S | S | A: 0. Elsewhere compiled out |
| M0009 | 13 | swap-additive | K | S | S | A: -9. Elsewhere compiled out |
| M0010 | 15 | return-value | S | K | S | B: 0. Elsewhere compiled out |
| M0011 | 15 | swap-additive | S | K | S | B: -99. Elsewhere compiled out |
| M0012 | 17 | return-value | S | S | K | none: 0. Elsewhere compiled out |
| M0013 | 17 | swap-additive | S | S | K | none: 0. Elsewhere compiled out |

Every killed mutant's killing test is `RateSmall`; every survived mutant has none. A compiled-out
mutant is `survived`, not `no-coverage`: coverage is per procedure, `RateSmall` runs `Rate`, and the
mutated statement is simply not in the build. Measured, not reasoned: R-319's scratch repro
`s1-clean-rate` (same `#if` / `#else` split of a final `exit`, coverage on, al-runner v2.11.0)
scored every inactive-arm mutant `survived` on all three transports in every subset.

### Figures

| | `[LETHALA]` | `[LETHALB]` | no symbol |
| --- | ---: | ---: | ---: |
| killed | **5** | **5** | **5** |
| survived | **8** | **8** | **8** |
| no-coverage | **0** | **0** | **0** |
| mutants | **13** | **13** | **13** |
| baseline green | yes | yes | yes |

The counts are equal, and every pair of builds disagrees on exactly 8 of the 13 (the other build's
four and its own four; M0001 and the third build's four agree). A transport that compiled the wrong
build keeps every count and moves eight verdicts, so the gate compares per mutant.

## What the gate runs

`[LETHALA]` and `[LETHALB]`, each through one-shot, `--server` and server+resource. Every leg must
match its column above, verdict and killing test, and the two server legs must equal the one-shot
leg per mutant. The no-symbol column is not run by the gate: it is what a define-losing transport
measures, and the red-checks below must print it.

## The red-checks, predicted

**(a) Daemon.** Delete `...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),` from
`AlRunnerServer.start`. The sandbox legs pass. In each set the one-shot leg matches its column and
its committed baseline. Both server legs print the no-symbol column (baseline still green, since the
test app is also built without a symbol) and fail. The gate fails with four collected failures:
`R321 [LETHALA]: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`,
`R321 [LETHALA]: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`,
and the same two for `[LETHALB]`.

**(b) One-shot.** Delete `for (const symbol of req.preprocessorSymbols ?? []) argv.push("--define", symbol);`
from `buildAlRunnerArgv`. Run in record mode before any baseline exists. The sandbox legs pass. In
each set the one-shot leg prints the no-symbol column and fails
`R321 one-shot [LETHALA]: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`
(and `[LETHALB]`), so no baseline file is written. The daemon still defines the symbol, so both
server legs build the right arm, match their column, and fail the equality check against the wrong
one-shot leg. Six collected failures in all.

## What would count as a finding

- Any verdict or killing test differing from its column, on any transport, in either set.
- Any `no-coverage` verdict, or a red baseline.
- A red-check failing anywhere other than the named assertions, or not failing.
- A dry-run list different from the 13 rows above.

A finding is a stop. It is reported, not re-recorded.

## What will change this later

When R214 is fixed (skip inactive arms per the configured symbols), each build emits only its own
arm's mutants: M0010 to M0013 disappear from `[LETHALA]`, M0008, M0009, M0012 and M0013 from
`[LETHALB]`. **That fix will need a new pre-commitment and a re-freeze of both baselines here.** The
six assignment mutants (M0002 to M0007) sit outside the arms and keep discriminating the builds after
it.
