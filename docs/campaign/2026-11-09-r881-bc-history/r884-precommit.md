# R-884 pre-commitment: no mutant during install or upgrade on al-runner v3 (R887)

Committed before any gate or comparison run, 2026-11-09. Coord task R-884. Evidence goes to `/coord/handoff/R-884/`.

**The change (branch `lethal/r884`, d78f93b3).** v3's two selectors, `emitResourceSelector` (serve-entries) and `emitStaticSelector`
(one-shot), answer false while `GetExecutionContext()` is not `Normal`, before they read the resource or test the id. BC's
`emitMutationSelector` is unchanged (its output's sha256 is pinned in a test). Probe on edge-05d692e5e: install triggers see `Install`,
tests see `Normal` (`/coord/handoff/R-884/probe/`). The invented fixture (`/coord/handoff/R-884/mech/`) moved as predicted: two kills
through install-written rows and one install `error` became `survived`, and nothing else moved.

## 1. The v3 gate: nothing moves

No fixture in `fixtures/` or `examples/` has a `Subtype = Install` or `Subtype = Upgrade` codeunit; LethAL's own register codeunits
are dropped from v3's staged batch. So **every leg passes, and every per-mutant verdict, killing test and note is unchanged.** Any
difference is a finding.

## 2. PaymentPractices one-shot, compared per mutant with R-881's `pp1`

The same project copies, packages and config as `pp1` (one-shot, no demo data, no `cacheDir`), al-runner edge-05d692e5e, this branch.
- The 6 `error` mutants of `pp1` leave `error`: M0661 to M0665 in `Payment Period.CheckDatePeriodConsistency`, and M0673 in
  `Payment Period.InsertPeriod`. Each becomes `killed` or `survived`. Which one is not predicted.
- Any other moved verdict must be in code that the app's install routine reaches; each one is named and traced. A moved verdict
  outside install reach is a finding.
- Cardinality 880. The baseline stays 31 of 36 with the same 5 failing tests.

## 3. PaymentPractices on the default transport (serve-entries)

R-881 round 1 stopped at the warm-up: "the install code read a resource file ...". The resource selector no longer reads the resource
outside a normal session, so **the warm-up refusal is predicted to go away and the run to complete.** Its verdicts are compared per
mutant with run 2. Equal verdicts are expected; each difference is reported with its reason. If the refusal stays, the reason is
reported (for example, al-runner deciding from the code's static reach rather than from what ran).
