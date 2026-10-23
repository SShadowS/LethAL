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
- **Reading the rows:** each H case's hub test session is taken to be the one `Web Client` row that appeared.
  - It was listed while the hub was open, at +5 s and +12 s, after LethAL had already given up at about 10 s.
  - It was gone at +16 s, before its own Sleep's end. So it ended between +12 s and +16 s, and the only event in
    that window was the close (+13 s to +15 s). That the close ended it is an inference, not a direct reading.
  - "Gone from `Active Session`" was not checked against a side effect of the AL code, such as a write after the
    Sleep.
- **The negative-id `Web Service` rows (-4900, -4932, -4942) are not identified.** -4900 logged in before the lease
  was taken, and only -4942 lines up with one of the probe's reads. Row E does not depend on which row is the test:
  every row that appeared in a case was gone by +16 s, -4942 included.
- **Not in the evidence file:** `lease.releasedAt` reads `null` in `bc3-probe.json`, because the driver writes the
  file before the wrapper releases the lease. The release happened at 08:11:18Z (`/coord/handoff/R-661/probe/lease.txt`).
- **Decision row E** (pre-commitment §7), in both H cases. The predictions held, including the low-confidence one
  (gone by +16 s).

## What it means for R661

- A hub baseline that outlives its budget keeps running while LethAL's bc-dev-mcp child keeps the hub open. LethAL
  already treats it as `in-flight-unknown`: it quarantines the tier and stops the session (F2). The hub connection
  closes when the session closes the backend (`cli.ts` calls `backend.close()` in a `finally`). The test session
  was then gone within seconds. Nothing was left on the server, and the op marker is never involved.
- So the quarantine is conservative: it asks an operator to clear a server that is in fact clean. That is the safe
  direction, for a mode due for deletion after the first release (R059).
- **F1, corrected by the build review:** `line` is not in the typed config, but it is not refused at runtime either.
  `validateBcDevConfig` returns the config section unchecked, so a hand-written `"coverageMode": "line"` reaches the
  hub. The ruling still holds, because `line` was measured and also fell in row E. The gap is filed as R681.
- R661 is closed by ruling (pre-commitment row E): docs only, no code.
