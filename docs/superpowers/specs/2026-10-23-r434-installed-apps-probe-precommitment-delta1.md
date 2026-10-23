# R-434 pre-commitment, delta 1: the driver's two fixes after run 1

Committed by lethal-bugs on 2026-10-23, after run 1 and before run 2. It amends
`2026-10-23-r434-installed-apps-probe-precommitment.md` (master 1b8a7973), which is not edited.

## What run 1 showed (`/coord/handoff/R-434/run1/`)

- **bc1:** 3 reads of 119 rows. AL took 6, 1 and 1 ms; HTTP took 133, 61 and 60 ms. The server still answered
  afterwards, and the probe was removed.
- **bc2:** 2 reads of 117 rows (AL 4 and 1 ms; HTTP 127 and 65 ms). The third read FAILED in the driver: AL formats a
  0 ms `Duration` as an empty string, so the header read `ms=` with no digits, and the driver's check refused it. The
  probe was removed. Both leases were released, and no server was marked.
- **bc3:** not run, because the loop stopped at bc2's exit 1.
- **Contrary to §5's prediction:** on both servers call 1's fingerprint differs from the later calls' (bc1: call 1
  against calls 2 and 3; bc2: call 1 against call 2). The driver kept only the last call's rows, so which row moved
  is not known.

## The fixes (probe head `7224e3b83c961c768c88a24f68f16bbc0af1d1dc`, tree `118ffd9b8589969ee0c59a91e60c881c19767b6f`)

1. The header check accepts an empty `ms=` and reads it as 0 ms.
2. Each call records the rows that differ from call 1's (`vsFirst`: `+` added, `-` gone, with id, version, publisher
   and name), and logs them.

The app is unchanged (same `probe.app`, sha256 `2c6a45ac…`). The readings, the STOP rule and the decision table of
the pre-commitment are unchanged.

## Run 2

bc1, bc2 and bc3 in turn, each under its own lease, as in §2.

**New prediction:** the row that moves between call 1 and the later calls is one whose state settles after the
probe's own install: most likely the probe app itself, or an app the platform touches when a new extension is
installed. If it is the probe, it does not count against stability. Any other moving row does count, and goes into
the ruling request.
