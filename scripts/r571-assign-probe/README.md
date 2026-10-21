# R571 assign probe: does `:=` share a temporary table with another record variable?

R571's caller-side temp-flag skip (`r571TempSkip` in `packages/builtin-tier1/src/loop-hazard.ts`)
rests on one belief: a record ALIAS made by assignment (`A := R`) does not share R's table, so an
alias whose `temporary` flag differs from R's cannot consume R's rows. Microsoft Learn is silent on
`:=` record assignment; the Record.Copy page is consistent (ShareTable true shares; false makes them
fully independent). This probe measures the assignment half on a live server.

Measured 2026-10-10 on **Cronus28** (System symbols 28.0.53667.0, runtime 17.0):

| case | what it does | measured |
|---|---|---|
| (a) | Real holds {A,B}; `TempR := Real` on A; `TempR.Delete()` | TempR stays temporary, its table is empty (Count 0), Delete returns No, Real.Count 2 |
| (b) | TempR holds {X,Y}, Real only {A}; `Real := TempR` on X; `Real.Delete()` | Real stays real, Delete returns No, TempR.Count 2, Real 1 before and after |
| (b2) | as (b), the real table also holds X | Delete returns Yes and removes the DATABASE row X; TempR.Count 2, X still in TempR |
| (c) | control: `TempB.Copy(TempA, true)`; `TempB.Delete()` on X | shared: TempA.Count 1, X gone from TempA |
| (c2) | temp to temp: `TempC := TempA` | TempC.Count 0, Delete returns No, TempA.Count 1: not shared |

So an assignment alias acts on its OWN table, choosing the row by key value; only `Copy(X, true)`
shares one.

## Running it

The app is `LethAL R571 Assign Probe`, id `9a5e11ec-e895-41f8-a3c9-cb6a9c9cd0ba`, objects
`table 50990` and `codeunit 50991` (a test codeunit). No fixture or extension uses these ids.

1. Download the target container's symbols into `.alpackages/` and compile with `alc`
   (`/al-compile scripts/r571-assign-probe`), or let bc-dev's `bcdev_app_publish` build it.
2. Publish over the dev endpoint: `altool publishapp` with the built `.app`, or `bcdev_app_publish`.
3. Run codeunit 50991's tests: `bcdev_test_run` (or the test tool page).

**Every test FAILS by design.** Each one carries its facts out in one `Error('MEASURED <case>: ...')`
message. Read the message: `%1`-style fields print `Yes`/`No` for Booleans and numbers for counts.
A test that fails with any OTHER message did not reach its measurement: read it as a probe failure,
not a result.

## Afterwards

Uninstall with data deletion, then unpublish (`bcdev_app_uninstall` with `deleteData: true`, then
`bcdev_app_unpublish`; or `UnPublish-BcContainerApp` on the host), and check the app list no longer
shows the id.

Re-run scripts/r571-assign-probe if BC's record-assignment semantics are ever documented differently,
or when a BC major version moves.
