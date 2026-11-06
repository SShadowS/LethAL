# R826B bc4 stop probe (GitHub #49)

Question: on BC 29 (bc4, 29.0.54011.57673, LethAL Control 1.0.0.25), what does BC answer on the held
`RunMutant` request when LethAL's `StopHungRun` ends a hung baseline test? The issue says HTTP 400
"begin transaction world not called CorrelationId: <guid>." where the stop path expects 408.

Shape copied from `scripts/r658-bc-probe/`. This is a probe driver, not `r658-hang-gate.sh`: it writes no
out-of-use marker and holds no gate lease.

- `drive.ts build | publish | run <labels> | remove`: runs only while lane `code` holds the coord lease on bc4.
- `lease.sh start | release`: takes, heartbeats and releases that lease. The token is never printed.
- `target/`, `tests/`: two scratch apps, ids 91500-91519. `tests/` has the hang shapes: busy loop (91511),
  Sleep in a loop (91512), database reads and writes in a loop (91513); each ends by itself after 120 s. 91515
  is a 25 s busy loop (ends by itself, no stop). 91510 is the clean test. 91514 (a session lister) proved
  useless: `Active Session` showed only one foreign session, so the driver no longer calls it.
- Cases: N1, N2 normal run; E1, E2 loop ends by itself, no stop fires; B, S, D (1 and 2) hang, 20 s budget, then the stop.
- Output: `/coord/handoff/R-826b/probe/bc4-probe.json` and `drive.log`.

Limit: the test runner rolls back everything a test writes, `Commit` included, so a hung session leaves no
mark in the database. "The session ended" is read from the control app's progress row (it must stop
moving, also past the 120 s the loop would have run) and from the next tests running clean. It is not a
view of the server's own session list.
