# R-407 itest:alrunner pre-commitment: multi-object admission through the frame probe

Written by lethal-code on 2026-10-09, BEFORE any `itest:alrunner` run of R-407's build (branch `lethal/r407`, on
master bcf4ca32). It is committed to master on its own (specs only, [skip ci]) before the run.

- Plan: `docs/superpowers/plans/2026-10-09-r407-multi-object-coverage-probe.md`.
- Measurement: `/coord/handoff/R-407/measure.md`.
- Build record: `/coord/handoff/R-407/build.md`.

## The build the gate runs on

The container's `/work/tools/al-runner/current`, `v2.12.0-main.43f76177`, which contains upstream #5249 (merge
3c350f65, closes #5222). The gate prints the build first. A different build is a stop, not a pass.

**The Windows host** still pins `c39ad5de`, which lacks #5249. There the frame probe REFUSES (measured: P4 in
`build.md`, all three oracles fail), and the multi-object legs fail on the probe line, by name. That is the intended
failure until the owner moves the host pin. This pre-commitment covers the container run only.

## The prediction

**The probe.** It is run by the coverage guard on each multi-object leg's own transport, and must print `admitted`
on BOTH legs (one-shot and `--server`). The expected Probe B lines are 45, 46 and 47, measured on 43f76177 on both
transports (`tests/fixtures/r407-frame-probe/`).

**The `sandbox-multiobject` legs** (one-shot and `--server`, `coverage: "al-runner"`, static selector) take the
FUTURE table of `docs/superpowers/specs/2026-10-02-r383-multiobject-precommitment.md` (bc2511ba), unedited, per
mutant, covering tests included. bcdev already matched that table exactly. Restated here:

| code | verdict | killing test | covering tests |
| --- | --- | --- | --- |
| M0001 | killed | ControlDoubles | Multi Tests.ControlDoubles |
| M0002 | killed | ControlDoubles | Multi Tests.ControlDoubles |
| M0003 | no-coverage | - | (none) |
| M0004 | no-coverage | - | (none) |
| M0005 | no-coverage | - | (none) |
| M0006 | killed | ReachedBothWays | Multi Tests.ReachedBothWays |
| M0007 | survived | - | Multi Tests.ReachedBothWays |
| M0008 | killed | ReachedBothWays | Multi Tests.ReachedBothWays |
| M0009 | killed | ReachedBothWays | Multi Tests.ReachedBothWays |
| M0010 | killed | ReachedBothWays | Multi Tests.ReachedBothWays |
| M0011 | no-coverage | - | (none) |
| M0012 | no-coverage | - | (none) |

- Counts: killed **6**, survived **1**, no-coverage **5**, over 12. A covered mutant's `coverageAttribution` is
  `exact`; a no-coverage mutant carries none. The `--server` leg equals the one-shot leg per mutant, every field.
- **What moves from today's refusal table**
  (`2026-10-02-r383-multiobject-refusal-precommitment.md`, killed 6 / survived 6 / no-coverage 0):
  - M0003, M0004, M0005 (`Multi A.Never`) and M0011, M0012 (`Multi B.Unreached`) go from `survived` to
    `no-coverage`;
  - every covered mutant's covering set shrinks from both tests to its one caller and gains attribution `exact`;
  - no killing test changes.
- **The discriminator, and what fails if the build is wrong.**
  - Under the old refusal, M0003 to M0005 and M0011 to M0012 read `survived` with both tests covering.
  - Under a wrong frame admitted silently (the c39ad5de defect), M0003 to M0005 gain `ReachedBothWays` (B's lines
    land in `Never`). The R-407 backstops throw first: the label check, and position-wins on `--server`.
  - Each of these is a row difference, so the table catches it per mutant.

## Every other leg is unchanged

Measured offline in the build (step 8), `sandbox-multiobject` is the only `itest:alrunner` fixture holding a
multi-object file. The guard runs the probe only for such a project, so these legs keep every figure and their
frozen baselines byte for byte:
- `sandbox-app` (3 / 12 / 4 on every leg);
- `sandbox-symbols` (both sets);
- `sandbox-layout`;
- `sandbox-wrapped`, which holds a wrapped file only.

## Baseline

`al-runner.multiobject.baseline.json` is re-frozen under R332:
1. delete it;
2. one record run with `LETHAL_ITEST_RECORD_BASELINE=al-runner.multiobject.baseline.json` (exit 3 by design);
3. a confirm run without the variable must PASS;
4. diff old against new;
5. commit.

The expected diff: the five rows above change from `survived` to `no-coverage`, and no other row changes.

## Block rule

Each of these is a BLOCK, recorded and not edited into this table:
- any verdict, killing test, covering-test set or attribution that differs;
- a probe answer other than `admitted` on the container build;
- any change on a non-multi-object leg.
