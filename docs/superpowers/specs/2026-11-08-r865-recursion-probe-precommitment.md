# R865 pre-commitment: what unbounded AL recursion does on BC

**DROPPED, 2026-11-08, by the owner's ruling. This probe was never run, and nothing was published on `bc1`.** The text below is kept as the record of what it would have measured. With no measurement, R865 is closed by R-871's narrow rule, the owner's choice: see `docs/roadmap/R865.md`.

Written 2026-11-08 by lethal-code, before any run, on the owner's word in the lane's session. Item: [[R865]]. Server: `bc1` (BC 28.4), named by the owner as the server that may crash. The rule that rests on the answer is R-871's, preproc's; it is held until this runs.

## The question

A mutant on a recursion's guard (`if Level < 10 then Self(Level + 1)` forced true) or on its depth argument recurses without bound. R826 records BC's service tier dying of a stack overflow (`0xc00000fd` in `coreclr.dll`) from a large instrumented method. Does a plain AL recursion end in a catchable AL error, run on, or take the service tier down?

## The probe

One scratch app, ids 91500-91599, checked free on `bc1` by app and object id first; no table. One codeunit, driven over a web-service call as LethAL's sessions are, under one coord lease on `bc1`:

- `Depth(N)`: recurses to depth N, then returns. Called with N = 1,000, then 10,000, then 100,000, stopping at the first that does not return normally.
- `Forever()`: recurses with no bound. Called once, last, and only if `Depth` reached 100,000 or ended in a clean AL error.

A frame holds one Integer and one call: the cheapest recursion, so the depth reached is an upper bound for real code.

Each call has a client-side timeout of 300 s. After each call: HarnessInfo answers, and a trivial call returns.

## What each answer means

| what happens | means | what R-871 does |
|---|---|---|
| **A** a catchable AL error, the session ends, the tier answers | recursion ends loudly; a recursion mutant is an `error` or a kill | a narrow rule: refuse only the new opt-in operators' self-call sites, as R-868 does; shipped operators unchanged |
| **B** the call runs past 300 s and the tier answers | recursion is a hang; LethAL's stop applies | refuse a recursion mutant like any loop hang, in every operator, shipped `swap-additive` included |
| **C** the service tier stops answering | recursion takes the server down | refuse it in every operator, before anything else ships; a bc-restart request to the owner |

A depth reached in A or B is recorded, with the error text. A and C can both happen at different depths: the worse one decides.

## Stop rules

- If the tier stops answering, stop: keep the lease, file `kraken coord ask --to owner --kind bc-restart --target bc1`, and run nothing more on `bc1`.
- If a call hangs, LethAL's `StopHungRun` is not used, because this probe is not a LethAL run: the client times out, and the probe checks whether the session still runs, reading the control app's own state only.
- Afterwards, if the tier answers: unpublish the scratch app, `lethal doctor` all ok, `itest:bcdev` passes, then release.

## What this does not settle

BC 29 (`bc4`) is not measured here. The depth a real procedure reaches with large frames is lower than the probe's. Whether instrumented code changes the depth: no. The R826 ladder, growing one method until the tier dies, is a separate step needing its own word.
