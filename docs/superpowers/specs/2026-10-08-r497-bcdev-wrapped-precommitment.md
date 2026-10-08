# R-497 pre-commitment: `itest:bcdev-wrapped`, `fixtures/sandbox-wrapped` on Cronus28

Written 2026-10-08, BEFORE any live run of the R-497 build (branch `lethal/r497`, plan r2 adopted on
master). A difference in a live run is a finding and a STOP, never a re-record.

## 1. What runs
- Target `fixtures/sandbox-wrapped` and tests `fixtures/sandbox-wrapped-tests`, both unchanged.
- Config symbol `WRAPDEF`; the target's `app.json` defines `WRAPAPP`. alc compiles under both (bcdev
  has no "replaces" reading: LethAL passes the union to alc).
- Cronus28 over the dev endpoint, `runSession` as `itest:bcdev` does it, under the container lease
  (`coord.sh lease Cronus28 preproc`) and the session's own OData lease.
- Two legs, one session each: `coverageMode: "fenced"` and `coverageMode: "procedure"` (the hub).

## 2. Mutants (derived OFFLINE on the R-497 build: `generateMutationSet` under bcdev symbols, one batch)
The same 36 mutants, same codes, as the al-runner leg's table
(`docs/superpowers/specs/2026-10-08-r343-wrapped-leg-precommitment.md` §3). Expected shapes under the
BC rule: WrappedTop, WrappedPre, WrappedPairA admitted (one arm); WrappedArms admitted (two arms, `#if`
compiled, measured as Q's arm order); WrappedPairB compiled out (no mutant, no entry, no refusal).

## 3. Verdicts, per mutant, both legs

| codes | file | verdict, killing / covering test | reason |
|---|---|---|---|
| **M0001** | WrappedArms 7 empty-block Pick | **killed, ArmsPick** | `Pick(5)` returns 0, not 1; `ArmsPick` raises |
| **M0002** | WrappedArms 8 conditional-boundary Pick | **survived, covered by ArmsPick** | `X >= 0` still true for 5 |
| **M0003** | WrappedArms 9 return-value Pick | **killed, ArmsPick** | `exit(1)` mutated; `Pick(5) <> 1` |
| M0004-M0036 | as the al-runner table (§3 of the R-343 spec), "adds" reading | identical verdict, killing test and covering set per code | BC compiles the same arms; the twins' rows equal the wrapped files' rows |

So: **killed 26, survived 10, no-coverage 0** over 36 (the al-runner leg's 24 / 9 / 3 plus WrappedArms'
three rows, which al-runner refuses and BC scores).

Covering tests are `Wrapped Tests.<method>`; killing tests are bare method names (the report's form).

## 4. What the gate asserts (each leg)
1. One batch; a green baseline.
2. Every row of §3, per mutant: verdict, killing test, the complete covering set.
3. No `coverage refused` warning naming any sandbox-wrapped object; in particular none for
   `Codeunit:78905` (WrappedPairB's compiled-out key must not refuse WrappedPairA: plan r2 A1, live).
4. Strict twin parity both ways (WrappedTop vs WrappedTopTwin, WrappedPre vs WrappedPreTwin).
5. The procedure leg equals the fenced leg per mutant.
6. The fenced leg against `bcdev.wrapped.baseline.json`, recorded once by R332's procedure (record run
   exits 3), then a confirming run of both legs.

## 5. What would mean what
- WrappedArms' rows `no-coverage`: the two-arm admission is not in effect on that path.
- A WrappedArms kill or cover attributed to the inactive `#else` copy (a naming gap, `unplaceable`, or a
  survivor without `ArmsPick`): arm filtering failed on the instrumented text (plan r2 F3/A3).
- WrappedPairA's rows `no-coverage` with a 78905 refusal: A1 regressed.
- A twin difference: the wrapped files are numbered differently from their twins on BC: STOP.
- This leg cannot tell H1a from H1b (every admitted object is first in its file, base 1 under both);
  that is pinned offline against R-300b's measured numbers (`r497-bc-wrapped.test.ts`).
