# PR-344 pre-commitment: pack a mutant's refused-cut tail "alone" calls into one send (R1156)

Status: pre-commitment (coord PR-344, lethal-preproc, 2026-11-22), after the spec-adversary (4 BLOCKs, 6 SHOULD-FIXes,
4 NITs, all taken below), before the build. Sources: PR-341 part 2's design (`/coord/handoff/PR-341/part2-bound-design.md`),
PR-343's probe (`/coord/handoff/PR-343/result.md`), PR-302's t1 resume (34,619 bound checks at 282 ms, 9,777 s of lane
time). Related: [[R1156]], R652, PR-297, PR-250.

## The cost today
- Under `refusedCutTail`, each green tail test after a baseline-refusal cut runs ALONE under the mutant: one request, one
  entry, `runSelectedOnly` (PR-297, `aloneCall`). Each request is its own send, and each send is preceded by R652's bound
  check (every byte of the instrumented tree hashed).
- On DO t1 that was 29,864 alone calls over 1,590 mutants (about 19 per mutant), most of the 34,619 checks.

## What PR-343 measured (current main-bf3a3e863, al-runner's answers, `authoritative: false`)
- In ONE request, single-test entries of the SAME codeunit are independent: each starts fresh (no test-codeunit global, no
  SingleInstance state, no row carries), per-entry selection and per-entry `active-mutant.txt` are honoured, a failing entry
  does not taint the next, and rows come back per entry in request order. Under both `testIsolation` values and both
  `runSelectedOnly` values.
- **Not measured (adversary S2):** whether Random, CreateGuid and SystemId start fresh per entry. R807 seeds every serve
  REQUEST; if one stream runs across entries, entry k sees other values than a fresh alone request would. **A probe of this
  (PR-343's shape, two entries each printing all three) is a precondition of the DO re-check.** If entries do not start
  fresh, this design is withdrawn.

## The change (behind `refusedCutTail`; no new flag)
1. **When a pack is sent.** Only on the tail route: `runRow` decided `tailAlone` for test T of mutant M, and the call is not
   forced (`opts.alone` from a reproduction or any other forced alone call never packs and never reads the store, S1).
2. **The pack set.** T first (entry 0, B3), then every other test of M's covering set that `runRow` would route alone right
   now.
   - "Would route alone" is ONE predicate shared by `runRow` and the pack (extracted, not copied): `entries`, not in
     baseline, `lastActivated !== null`, not a one-shot codeunit, `refusedCut(cu)` defined, the method in
     `refusedCut(cu).methods`, `isStableTail(ref)`, the §6 Sleep rule retired (S4).
   - Test refs come from `this.discovered` (exact names), never from `coveringOf`'s lower-case keys (S4).
3. **The request.** One request, one send, ONE R652 bound check (R652 unchanged).
   - Each entry is exactly what `aloneCall` builds for its test today: `isolatedSelection`, `resources` `active-mutant.txt`
     = M, `runSelectedOnly` for the body.
   - Each test gets its own isolated call id (the negative-id route of `callId`/`isolatedIds`), so entry ids and the results
     map never collide for tests of one codeunit. `sendInFlight`'s single `alone` slot widens to a map from call id to
     selection, read at all five sites today's `alone.call` is read: the entry selection, `runSelectedOnly`, `requestBase`,
     `keptRefusalDrift` and the `suiteMissing` skip (S3).
4. **What is stored.** Per (lane, M, test), only the rows of entries strictly BEFORE any cut, and only a CallRows with no
   `refusal` and no `missing` (S5).
   - **A cut** is any row the daemon cannot be reused after: a timeout (`stopAtTimeout`) or an R939/R612 refusal family (B3).
     The cut entry and every entry after it are not stored; each is sent alone if the walk asks for it.
   - **The pack never records a cut in `timedOutMutants`** (or any other per-mutant routing state) for an entry other than
     entry 0 (B1). Only the walk's own read of a row may change routing, as today.
   - If entry 0 is itself the cut row, T's answer is exactly today's alone answer for T (its timeout, its `timedOutMutants`
     entry), because entry 0 is the same request today's alone call would have sent up to that row.
5. **A failed pack** (a deadline, a transport or protocol error, R1014's stop signal, a daemon death): nothing is stored, the
   pack's error is NOT returned for T, and T is sent alone exactly as today (B2). The failed pack is counted.
6. **Reading the store.** Only on the tail route of point 1. A stored row is deleted when read (read once). The store is
   cleared on every `activateOn` (as PR-256's `aloneAfterStop`), so the NONE confirm and every re-activation start empty.
7. **What does not change:** the walk (the orchestrator's order, R197's ledger, stop at the first confirmed kill, PR-81's
   held errors, PR-144's recheck, the NONE confirm and the reproduction), each row's reading (`runOn`'s `selection:"alone"`
   and the `[refused-cut tail ...]` note), the report shape, the fingerprint and the lending tag.
8. **Counts.** A new pack-send count and a failed-pack count in the end-of-run stats line (flag on only). `tailAloneCalls`
   keeps counting decisions.

## Why the verdicts are equal, and the named limits
- **Each stored row is the row the alone call would get:** the same entry, the same activation, a fresh start (PR-343, and
  S2's probe), read by the same walk in the same order. A row that could differ (after a cut, a refusal, a failed pack) is
  never stored, so its test is sent alone as today.
- **Limit 1 (cost, and under `--time-budget`, verdicts):** the pack runs M's tail tests after the one that kills M. A test that
  hangs only there costs a full stop (about 1,762 s on DO) and a daemon restart the unpacked walk never paid. With a time
  budget, that wall time can make a budget cut fire earlier, which moves later mutants' verdicts (S6). The DO re-check
  measures how often it happens (failed packs and pack cuts after entry 0).
- **Limit 2 (al-runner):** the equality rests on PR-343 and S2's probe of one build. No gate measures multi-entry freshness
  today (named, not built here).
- **Durations (NIT):** a stored row's test duration is its own row's time where al-runner reports one; otherwise the pack's
  wall is charged once (R963), never k times.
- **The saving is a lower bound (NIT):** every re-activation (NONE confirm, found-none) clears the store, and tests after a
  cut are sent singly.

## Tests (red before the build), on a rig with at least 2 tail tests whose rows depend on the mutant (B4)
1. **Per mutant, packed equals unpacked, per request log:** the same session with the pack and with it disabled (a test
   seam): equal per-mutant verdict, `killingTest`, notes, held errors; and the request logs differ only by the packed sends.
   Cases: a kill on a NON-first tail test; a walk order with a non-tail test of the same codeunit between two tail tests
   (B1); a timeout at entry j > 0 (B1, B3); a crash at entry j > 0 (B2).
2. **One send per mutant:** k tail tests give ONE request with k entries and k distinct ids; `boundChecks` lower by k-1.
3. **Read once and forced calls:** a tail kill's reproduction sends its own single-entry request, never a pack, and never
   reads the store (S1).
4. **Cleared on activation:** after the NONE confirm, M's stored rows are gone.
5. **A cut at entry j > 0:** entries before j are read from the store; j and later are sent alone when asked;
   `timedOutMutants` is unchanged by the pack (B1).
6. **A failed pack:** T is sent alone and gets its own row, not the pack's error; nothing stored (B2).
7. **A refusal or missing row in the pack:** not stored; sent alone when asked (S5).
8. **Flag off:** no pack; the request log equals today's.
- Each guard gets a red-going test in each direction.

## Predictions
- **Gates:** no gate turns `refusedCutTail` on, so no gate figure, warning set or code list moves (`itest:alrunner-v3` and
  the BC legs `selectLegs` names).
- **DO, a narrowed re-check against PR-302's t1** (after S2's probe; the mutants t1 scored with tail alone calls, flag on,
  same build and config): equal verdict and `killingTest` per mutant; bound checks at least about 6,300 (from 34,619; a
  lower bound, see above); bound time about 1,800 s (from 9,777). Test time may rise (Limit 1); failed packs and late cuts
  are reported. Any verdict difference is a BLOCK until explained.
