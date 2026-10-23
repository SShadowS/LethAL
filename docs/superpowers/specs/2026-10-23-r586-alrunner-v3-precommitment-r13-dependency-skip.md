# R-586 pre-commitment r13 (R590): a contract fact pins that v3 says when it leaves a dependency out

Master path: `docs/superpowers/specs/2026-10-23-r586-alrunner-v3-precommitment-r13-dependency-skip.md`
(docs/gates/alrunner-v3.md on `lethal/r537` names it).

The R-537 builder (lethal-code) wrote this on 2026-10-23, after the fact and the backend refusal were coded on
`lethal/r537` and unit-tested against fake v3s, and BEFORE any live leg-C run of that code. It is committed to
master before any `itest:alrunner-v3` run of a head that carries the fact, and before any `--regate`.

It is a delta on r12 (`2026-10-23-r586-alrunner-v3-precommitment-r12-message-prefix.md`) and the deltas before it.
Everything there stands, except what is below. A differing fact verdict in leg C is still a BLOCK.

## Why

v3 leaves out a dependency app whole when it finds no package holding its AL source, and writes
`dependency skipped: ...` on stderr. A mutant that then runs one of that app's codeunits by id gets a `fail` row with
BC's missing-object text, which LethAL scored as a kill; BC runs the call. Measured on alpha.2 (91253f2d6) and edge
(57f1e4f98) by R-537's probe (`/coord/handoff/R-537/probe/`, codeunit 50983 `ByIdReached`). R-537 makes the v3
backend refuse the session on that line (`AlRunnerV3DependencySkippedError`). The refusal trusts that the line is
written, so a build that stops writing it (rewords it, or moves it behind `--verbose`) would reopen the false kill
silently. This fact catches that by name.

## The new fact

**`dependency-skip-line`**, kind `contract`.

**The probe.** One new one-shot call: the probe's usual argv plus `--codeunit 50662`, with the probe's main app and a
new tests app `dep-skip-tests` (ids 50650-50699) that declares ONE dependency no package holds:
`LethAL R590 Absent` by LethAL, id `7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d2590`, version 1.0.0.0. Its only test:

```al
codeunit 50662 "Probe DepSkip"
{
    Subtype = Test;

    [Test]
    procedure Runs()
    begin
    end;
}
```

The call runs in leg C and in every session (no gate-only half): it needs no package the session lacks.

**The reading.**
- `matches` when stderr has a line that `v3DependencySkipLines` returns, that starts `dependency skipped:` and names
  `LethAL R590 Absent`.
- `unmeasurable` when the call could not run (exit -1).
- `diverged` otherwise (no such line, the words mid-line, a skip line for another app).

**Its classification** (the existing rules, `classifyLegC`): `matches` passes; `diverged` is `gate-fail`;
`unmeasurable` is `infra-fail`. In a session any reading other than `matches` (`unmeasurable` included) refuses the
session (`v3ContractRefusals`), as for every contract fact.

## Expected readings

| build | `dependency-skip-line` |
|---|---|
| alpha.2 (91253f2d6, `current`) | `matches` |
| edge 3.0.0-alpha.4+edge.20261022 (57f1e4f98) | `matches` |

Basis: MEASURED by R-537's probe, variant M (`probe/out/a2.M.stderr`, `edge.M.stderr`): both builds write
`dependency skipped: dependency \`R537 Dep\` by LethAL R537 (<id>) version 1.0.0.0 or higher was not found; ...` as
the first stderr line, without `--verbose`, on every run (cold and warm cache). INFERRED: the same for the probe's
`LethAL R590 Absent` declared by a tests app (R-537's was declared by the target app).

## New counts

- Leg C: **28 facts** (was 27): **9 defect, 18 contract, 1 warn**. `V3_LEG_C_FACTS = 28`. A run with 27 facts is
  `gate-fail`.
- `V3_DEFECT_FACTS` and `V3_WARN_FACTS` are unchanged.
- Cost: one extra one-shot call in leg C and in every session (the probe's main app plus a one-test tests app; its
  time is not measured).
- **The update gate** (`al-runner-v3-update.ts`, `--edge`, `--edge-rejudge`) reads leg C, so it now refuses a build
  whose reading is not `matches`.

## Other legs (the backend refusal)

R-537 checked every leg's own inputs on both builds with plain v3 and a real test codeunit
(`/coord/handoff/R-537/depcheck/summary.txt`): sandbox-app (MS deps and sandbox-tests/.alpackages), sandbox-data,
sandbox-names, sandbox-symbols and CDO (Cloud + Test, Test/.alpackages). 0 `dependency skipped` lines in all 12
runs. So no leg is refused by the new check, and no other figure, verdict, killing test, note set, refusal set,
Sleep index size or baseline moves.

## Live run (R-537, on its final head)

- **Code:** `lethal/r537` at **66ff337f** (`66ff337f3da0395bc04252107d20c9f4e7e1b35d`, master merged), clean tree. If the head moves, an addendum names the new one.
- **Run:** `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 bun run
  itest:alrunner-v3`, all 12 legs, on `current` (alpha.2). Every leg PASSES as frozen; leg C has 28 facts and
  `dependency-skip-line` reads `matches`.
- **Edge:** the same leg C with `LETHAL_ALRUNNER_V3_CANDIDATE=1` and `LETHAL_ALRUNNER_V3_PATH=<edge 57f1e4f98>`; only
  the new fact is judged (`matches`); the other facts keep their known edge readings.
- **Stop:** the new fact reading anything but `matches` on either build, leg C's count not 28, or any leg refused by
  `AlRunnerV3DependencySkippedError`.
