# R727 pre-commitment: warn before the first publish about the target's other dependents

Coord task R-727, lane lethal-code, branch `lethal/r727`. Committed to master before any live gate runs on the
branch.

## The change (option (b), decided with the orchestrator 2026-10-24)
Before a bcdev run first publishes the instrumented target, it makes one read-only call:
`backend.dependentCount(<target app id>)`, the control app's `DependentCount` (1.0.0.23). That counts the PUBLISHED
packages, any version, that declare the target as a dependency.
- **N > K** (K is 1 when the run's tests app depends on the target, else 0): warn with code `installed-dependents`
  on stderr and as a progress `warning` event.
- **A failed read** also warns that the check could not run.
- **It never refuses.** No SessionReport field and no caveat. al-runner backends make no call.

## Measured before the build (bc3, read-only, 2026-10-24)
`DependentCount`: Sandbox App 1, Sandbox Data 1, Sandbox Hang 1, Sandbox Harden 2 (presumably harden-tests and
harden-answers), Sandbox Tests 0.

## Predictions for the live gates (selectLegs on the final head)
- **Every frozen per-mutant row** (verdict, `killingTest`, note set, refusal set) and every total is
  **unchanged**, on every gate. The warning is stderr and a progress event only, and changes no verdict.
- **Gates whose target has exactly its tests app as a dependent print no R727 warning**: bcdev, lease, stale-publish,
  tables, chunked, hang, verify, testapp and agreement. Their N = 1 and K = 1, as measured on bc3 for app/data/hang;
  per server, as each server holds the fixtures.
- **`itest:harden` prints the R727 warning: 2 published dependents vs 1 accounted for.** harden-answers is a real
  second dependent of the harden target, so this is a true positive. Its figures are unchanged.
- **al-runner-v3:** no call and no warning (it publishes nothing to BC). Unchanged.

Any figure difference is a BLOCK. A warning where none is predicted, or none where one is predicted, is a finding to
explain before submit. If a server holds an extra published version of a fixture tests app, N can exceed 1 there;
that would be R727's known limit (published, not installed), named per server.
