# R661: what does a hub-mode baseline overrun leave on BC?

The probe ran on bc3 on 2026-10-23, 08:10-08:11Z, under lane bugs' coord lease. Pre-commitment:
`docs/superpowers/specs/2026-10-23-r661-hub-baseline-overrun-probe-precommitment.md` (master 9a1f8999). Probe:
`scripts/r661-hub-probe/` at 5b9190b1 (tree 562db036). Readings: `bc3-probe.json`. Log:
`/coord/handoff/R-661/probe/drive.log`.

- **Server:** bc3, measured with LethAL Control 1.0.0.23, serverGeneration `2e655f83…`.
- **The app:** "LethAL R661 Hub Session Probe" (ids 92960-92969), sha256 `1ed257a9…` as pre-committed. It was read
  absent before the publish, and removed after the run (uninstall 204, unpublish 204, 0 rows).
- **The test:** the hang fixture's `Hang Z Baseline Tests.SleepsPastTheBaselineBudget` (`Sleep(25000)`), through
  `BcDevMcpBackend.run` with a 10 000 ms budget. Each case used its own bc-dev-mcp child.

## Results

| Case | Coverage | LethAL's verdict | `runBaselineTest` today | Hub test session | +5 s | +12 s | +16 s | +21 s | +35 s |
|---|---|---|---|---|---|---|---|---|---|
| C | `procedure` | `pass`, 4 250 ms | green | — | — | — | — | — | — |
| H-line | `line` | `deadline-exceeded`, `in-flight-unknown`, 10 089 ms | quarantine | 4924 (Web Client) | listed | listed | gone | gone | gone |
| H-procedure | `procedure` | `deadline-exceeded`, `in-flight-unknown`, 10 087 ms | quarantine | 4940 (Web Client) | listed | listed | gone | gone | gone |

- **The op marker was the same before and after:** `opKind none`, `lastCompletedOpSeq 711`. The final control-app
  acquire was granted and released. A hub run never touches LethAL Control.
- **The close.** `backend.close()` began at +13 s and returned at +15.0 s in both cases, because it waits for the
  bc-dev-mcp child to end. The pre-commitment named +13 s. The +16 s read still falls after the close and 9 s before
  the test's Sleep would end.
- **Reading the rows:** each H case's hub test session is the one `Web Client` row that appeared. It was listed while
  the hub was open, at +5 s and +12 s, after LethAL had already given up at about 10 s. It was gone at +16 s, after
  the close and before its own Sleep's end. So BC ended it when the hub connection closed.
  - The `Web Service` rows with negative ids (-4900, -4932, -4942) log in at the time of the probe's own reads. They
    are most likely the reading session itself under the opposite-sign id R53 measured. They are not the test.
- **Decision row E** (pre-commitment §7), in both H cases. The predictions held, including the low-confidence one
  (gone by +16 s).

## What it means for R661

- A hub baseline that outlives its budget keeps running while LethAL's bc-dev-mcp child keeps the hub open. LethAL
  already treats it as `in-flight-unknown`: it quarantines the tier and stops the session (F2). The hub connection
  closes when the session closes the backend, and BC then ends the test session. Nothing is left on the server, and
  the op marker is never involved.
- So the quarantine is conservative: it asks an operator to clear a server that is in fact clean. That is the safe
  direction, for a mode due for deletion after the first release (R059) and a mode, `line`, that no config can select
  (F1).
- R661 is closed by ruling (pre-commitment row E): docs only, no code.
