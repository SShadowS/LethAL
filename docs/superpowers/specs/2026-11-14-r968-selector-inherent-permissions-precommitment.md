# R-968 pre-commitment: the injected Mutation Selector grants itself Execute (R979)

Committed before any live run, 2026-11-14. Coord task R-968. Evidence goes to `/coord/handoff/R-968/`.

## The change

`emitMutationSelector`, `emitStaticSelector` and `emitResourceSelector` each emit `InherentPermissions = X;` as an object
property of the `Mutation Selector` codeunit (one line; branch `lethal/r968`, 5a221837). Nothing else in the emitted AL changes:
no guard, no mutant site, no identity (IDENTITY_SCHEME unchanged).

## Predictions

1. **No. Series on al-runner v3** (`/coord/handoff/R-962/src/noseries`, its test project, R-962's config with `packagesDir` the
   cached `bch-notrun-closure` pool; edge-c8fe56e05): the 35 baseline tests that failed with "the current permissions prevented the
   action ... Mutation Selector Execute" pass. Baseline green goes from 39/90 to at least 74/90; no test that was green turns red.
   Per mutant against R-962's report: moves may only be toward more evidence (no-coverage -> survived or killed, survived ->
   killed); a killed mutant does not move to survived or no-coverage. Any other move is a BLOCK and gets explained before submit.
2. **Gates, no figure moves:** the full v3 gate (`itest:alrunner-v3` with tables and CDO), and on a leased bc server
   `itest:bcdev`, `itest:bcdev-wrapped` and `itest:tables` (the table fixture's tests run under `TestPermissions = Disabled`, so
   nothing there narrows permissions). Per mutant, per verdict, per killing test: identical to the committed baselines.
   `compile:fixtures` passes (fixtures carry no selector).
3. **BC itself, measured, not predicted:** an invented probe on a leased bc server (ids in a range checked free first; unpublished
   after) answers, under `Permissions Mock.SetExactPermissionSet` of a set that lists only the caller: (a) is an unlisted codeunit
   in the same app denied Execute; (b) does `InherentPermissions = X` on it lift that; (c) can that codeunit then call a codeunit of
   another app that reads its own table (the shape of the selector calling `LethAL Control`'s `LC Control State`). If (c) is
   denied on BC, the fix also needs the control app, which is out of this task: I stop and report. If Permissions Mock is not
   installed on the server, or a publish is refused, I stop and report.
