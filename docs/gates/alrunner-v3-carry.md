# itest:alrunner-v3-carry

`LETHAL_ITEST_ALRUNNER_V3_CARRY=1 bun run itest:alrunner-v3-carry` is PR-340's gate. It tests the SingleInstance
carry walk of the al-runner-v3 backend (R1173): a survivor that would get the `[singleinstance-carry-unobservable]`
label is first run again with its covering test codeunits in ONE session, in order, on al-runner's sequential lane.
The pre-commitment is `docs/superpowers/specs/2026-11-22-pr340-v3-carry-walk.md` (section 7).

It needs no BC server and no lease. It is kept out of the update gate (`itest:alrunner-v3`) on purpose, so a build's
pins never depend on it. The first line it prints names the al-runner build it runs against: read it before calling a
difference a regression.

It runs `fixtures/sandbox-carry` and `fixtures/sandbox-carry-tests` (ids 71760 to 71779): a SingleInstance flag, a
logic codeunit, test codeunit A (writer, 71770), test codeunit B (reader, 71771) and a CPU burner (71772). One lane,
two sessions:

- The walk arm runs with `LETHAL_V3_CARRY_WALK` unset (on). Its per-mutant result is compared with
  `al-runner-v3.carry.baseline.json`.
- The off arm runs with `LETHAL_V3_CARRY_WALK=off` and is checked against the table below, not a file.

**The build must be carry-proven** (PR-340 amendment 1). The walk runs only when this session's contract probe reads
`batch-sequential-carry` `matches`, and the build's own gate record (`.gated` or the manifest row) does not record it as
anything else. A recorded `diverged` wins; a record without the fact does not block. On a build that ignores
`AL_STRICT_SEQUENTIAL`, the probe reads `diverged`, and the walk arm fails by name ("build not carry-proven").

## Frozen figures

```json gate-figures
{
  "gate": "itest:alrunner-v3-carry",
  "baselines": {
    "al-runner-v3.carry.baseline.json": { "killed": 8, "survived": 5 }
  }
}
```

**Not recorded yet.** `al-runner-v3.carry.baseline.json` waits in `PENDING_FIRST_RECORD`. The gate REFUSES to start
while the file is missing (R332) and prints the command that records it:

`LETHAL_ITEST_ALRUNNER_V3_CARRY=1 LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.carry.baseline.json bun run itest:alrunner-v3-carry`

Recording is deliberate and happens once: the run exits 3, a re-run without the variable must pass, then the diff is
reviewed and this page is updated in the same commit. The warning-code set of each arm (`GATE_WARNINGS`,
`al-runner-v3-carry/walk` and `al-runner-v3-carry/off`) is not recorded either: the first live run uses the observe
mode, and the sets are added by hand after each code is explained.

The walk arm, pre-committed per mutant (by mutant code now; the table is re-stated by site key before recording, since
the burner may move the numbering):

| Mutants | Verdict | Note |
|---|---|---|
| M0009, M0010, M0011 (the leak mutants) | killed by `ComputeIsPlain` | `[singleinstance-carry-killed]`, no unobservable label |
| M0001, M0002, M0003, M0005, M0013 | killed, as without the walk | none |
| M0004, M0006, M0007, M0008, M0012 | survived | no carry tag |

That is 8 killed, 5 survived and 0 errors over 13 mutants.

**After a walk on the same daemon.** The gate runs one lane, so M0012 and M0013 are scored on the same daemon after
the walks of M0009 to M0011. Pre-committed: M0012 survives and M0013 is killed, as without the walk. This pins that a
walk leaves the lane's daemon clean for the next ordinary request.

## The off arm

With `LETHAL_V3_CARRY_WALK=off` the table is today's: M0009, M0010 and M0011 are survived and each carries the
`[singleinstance-carry-unobservable]` label; M0001, M0002, M0003, M0005 and M0013 are killed; M0004, M0006, M0007,
M0008 and M0012 survive with no carry tag. That is 5 killed and 8 survived, 0 errors.

## The burner's id order

The burner (71772, a fixed 3,000,000 iterations, 234 ms at baseline) has an id ABOVE both test codeunit A (71770)
and test codeunit B (71771). Step 0b measured that a walk request that excludes it takes 2.6 to 4.8 ms of `testsMs`,
so excluded codeunits are skipped, not run hidden. The case that would matter more, an excluded codeunit sitting
BETWEEN the writer and the reader, is NOT tested by this fixture.

## The order difference against bcdev

On bcdev a session already carries state, and R1174 re-walks a survivor there in the NO-LEDGER order. The carry walk
uses al-runner's own sequential order (BC's codeunit order), never the kill ledger, and a walk kill never enters the
kill ledger (R1174's rule). A reader placed before its writer in one order and after it in the other can still
disagree between the two backends.

## History

2026-11-22 (PR-340): the gate and its fixture were built with the spec; no live run yet.
