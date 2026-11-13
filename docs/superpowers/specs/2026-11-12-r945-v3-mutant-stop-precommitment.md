# R-945 (R954) pre-commitment: a v3 mutant stop from the session's own baseline, not BC's 180 s floor

Written 2026-11-12 by lane preproc, before the build and before any measured run.

## The rule

On `--backend al-runner-v3`, when `--mutant-timeout-ms` is NOT given: after the baseline, the mutant stop is
**S = max(60 s, 20 x the largest green baseline duration among the session's tests + 5 s)**, one value for the session.
- Serve: the daemon is restarted after the baseline with `--test-timeout ceil(S / 1000)` (the baseline keeps today's
  `max(floor, --baseline-timeout-ms)` stop, so a slow baseline test is not cut).
- One-shot: each mutant call's budget is `max(2 x that test's baseline, S)`, as today with S in place of 180 s.
- An explicit `--mutant-timeout-ms` keeps today's meaning on every backend. bcdev is unchanged (the rule is v3's only).
- The report and the run header name the stop and where it came from.

## Measured basis (`/coord/handoff/R-945/study/README.md`)

60 al-runner-v3 run stores of coord R-925 to R-940; 41,521 mutant test calls that finished (pass or fail) with their own
duration (request wall times copied onto the rows of a stopped request excluded by a stated rule). Mutant time / the same test's
baseline: median 0.43, p99 6.34, max 44.5 (Cryptography Management, 817 ms -> 36.4 s, killed). For max(F, k x baseline + c), zero
finished calls are cut only from F = 60 s and k = 20 up; the session-wide form (k x the session's largest baseline) gives the same
bound. Estimated saving on the 2,972 s the data's 16 timeout rows cost: about 1,431 s (48%). Smaller floors cut real finishes.
Known limit: the bound rests on a few slow rows, so the margin at 60 s is thin; the v3 stop counts CPU time, the data wall time,
which errs on the safe side.

## Expected results

**Password** (BC.History System Application module, R-940's tree and config, the current pin), against R-940's run
(`/coord/handoff/R-940/password.run.*`; 143 decided, 48 left out by the one-hour window, 18 daemon closes on timeout):
- Its largest baseline test is 182 ms, so S = 60 s.
- All 191 mutants decided inside the hour (left out: 48 -> 0).
- Verdicts identical for every mutant decided in both runs, EXCEPT possibly the 16 whose calls took over 60 s in R-940's run
  (12 killed, 2 error, 2 timeout-killed). Any change there goes to `timeout-killed` or `error`, never to `survived` or
  `no-coverage`. A change outside those 16, or toward survived, is a BLOCK.

**The v3 gate:** no figure moves. Its fixtures' tests take milliseconds (S = 60 s), its baselines pin no v3 timeout kill, and the
one leg that sets the floor itself (`useMutantBudgetFloor(180_000, 120_000)`) keeps doing so.

**bcdev:** unchanged; the change is v3 only, which the gate table and the unit tests show.

## Amendment (2026-11-13, after the build and its review, before any measured run of the change)

- **The 16 Password mutants over 60 s are not real finishes.** Nine `TestVerifyStrongPasswordSequences` calls (baseline 97 ms) ended
  `pass`/`fail` at 181-184 s in R-940's run; re-run on master with a 600 s stop (`/coord/handoff/R-945/slow/`), the same calls ended
  `pass` at 611-673 s and the session did not finish in 2.5 h. They hang and are reported at whatever the stop is, so a 60 s stop
  cuts no real finish there. Prediction unchanged: verdicts identical except possibly those 16, and only toward `timeout-killed` or
  `error`. Whether al-runner reports a stopped test as `pass` or LethAL copies a request's wall onto a row whose own entry hung is
  being measured (`/coord/handoff/R-945/probe-stop2/`); a guard for it is a separate change, not part of this one.
- **Where the stop is named:** on stderr once per session (`[lethal] al-runner-v3 mutant stop N s (R954: ...)`), not in the report
  or the events file. Above, "the report and the run header" is withdrawn: a report field ripples through every schema and sample.
- **One value for the session** is withdrawn: S is a running maximum over the session's batches, and each batch's runs are judged
  with the stop they were sent.
- **The v3 gate:** still no figure moves. The baseline runs one-shot, and no serve daemon exists between the baseline and the
  stop being set, so S1E's pinned `warmups: 1` and every other serve counter are unchanged, and no `mutant-stop` close appears.
