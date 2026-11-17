# PR-81 pre-commitment: a non-terminal error met first is held like PR-51's timeout (R1066)

Coord PR-81 (2026-11-16). R1066, left out of PR-51/R1057 (`2026-11-16-pr51-timeout-class-stable.md`, "Not in scope").

## The problem
The covering walk (`runMutantsOnBackend`, orchestrator.ts, PR-51's held walk) ends a mutant at its first `error` that is not
a timeout. R197 orders the covering tests by the session's kill history. So a mutant with one test that errors and another that
fails is `error` in a session that meets the error first, and `killed` in one that meets the fail first. With a held timeout
before the error, PR-51 ends the walk at the error and scores the timeout. So error-vs-killed, and timeout-killed-vs-killed when
an error sits between the hang and the fail, still follow the order. Not yet seen in a pair of runs; it follows from the same
mechanism as R1057.

## The rule
For a mutant whose walk meets a NON-TERMINAL error before any confirmed kill:
- **killed** when a later covering test fails under it, and that kill is confirmed and reproduced (today's confirm, F1 included,
  unchanged);
- else **timeout-killed** when a timeout was held (before or after the error) and PR-51's replay of it scores timeout-killed;
- else **error**, the first held error, with its own fields. If a timeout was held and its replay ended as an error, that
  replay's outcome stands, as PR-51 records it today. The held error's test is then named in the note.

The class no longer depends on whether the error or the kill comes first. The cause of an `error` may still differ between
orders. That is accepted: the class is what the score reads.

## Non-terminal errors (a closed whitelist, by cause)
An error is held only when ALL of these hold:
- the step's handling ended the mutant with `verdict = "error"` and a `cause` in **N**. Each is described by what produces it
  (review L7):
  - `session-reused`, from R206's session guard: that call's session had already run other tests, so its state was another
    call's. It comes from both the walk site and the confirm site, and each later call is judged by its own `testRunsBefore`;
  - `unstable`, from a cold confirm whose unmutated run also FAILED (review M2: only a confirm with outcome `fail`; an `error`
    confirm, such as a `runner-test-error` row or a pre-dispatch rejection, is terminal). That includes the permission-refusal and
    runner-disagreement diagnoses, which are notes on `unstable`;
  - `warm-prefix-unstable`, `warm-timeout-unconfirmed`, `warm-confirmation-incomplete`, from `confirmWarm`'s replay that did not
    confirm (the last also from `reproduceKill`, and both of the last two from `confirmWarm`'s renaming of a replay's
    `stopped-after-completion` and of an op-in-flight-cleared answer). The code's own notes say the server is clean in each
    case (R203, `ownStopAsTimeout`);
  - `runner-refused` when not after a stop: al-runner refused a surface it does not run for that test (R534).
    `runner-refused` after a stop already continues (R639) and is unchanged. **This includes a `runner-refused` in a kill's
    REPRODUCTION** (review L3): R639's comment once said a refused row in a reproduction must end the mutant; it is now held.
  - **NOT `runner-test-error`** (review M4). It covers very different events:
    - al-runner contract violations;
    - a missing row;
    - an echo mismatch, where the request may not have run under the mutant's selector;
    - an unclassified error row;
    - R-435's untrusted timeout, whose comment says it must never let the walk go on.
    It stays terminal as a whole until its sub-kinds are split, each with a reason. DO's stored errors are all `runner-refused`
    (cost.md), so this costs nothing measured;
- the step set no `transportErrorRef` and no `abortAfterRecord`;
- `safety` is not latched unsafe after the step;
- the walk is not replaying a held timeout (`replaying` false).

Every other error ends the walk exactly as today. That covers:
- the causes `stranded`, `result-lost`, `deadline-exceeded`, `op-stopped`, `stopped-after-completion`,
  `stop-outcome-unconfirmed`, `confirm-stopped`, `group-run-error`, `group-answer-malformed`, `group-coverage-incomplete` and
  `runner-test-error`;
- a lease loss (no cause);
- a transport error or session abort;
- any cause added later (the whitelist is closed: a new cause is terminal until it is added here with a reason).

`op-stopped`, `stopped-after-completion` and `confirm-stopped` are server-clean too (R203, R658). They are terminal
CONSERVATIVELY, not because they are known to be unsound (review L7). Holding them is a later step, with its own reasons.

**What "terminal" does to something held (review M2).** A terminal answer stops a held ERROR: the walk ends, today's handling of
that answer stands, and the held error is named in the note (names only, after any `STRANDED_NOTE_PREFIX`). It does NOT
change how a held TIMEOUT is treated. After every answer, a held timeout is scored exactly as PR-51 scores it today. Only
PR-51's own terminal set (safety latched, `transportErrorRef` or `abortAfterRecord` set, `stranded`, `result-lost`,
`deadline-exceeded`) skips its replay. So after `confirm-stopped`, `op-stopped`, `stopped-after-completion` or a `group-*`
cause, the held timeout is still replayed, and can still score `timeout-killed`.

Causes the walk already continues past are unchanged: `kill-not-reproduced` (R577's I4) and R688's confirmed found-0
(`test-discovery-failed` is decided at the walk's end). `timeout-unconfirmed` and `reused-budget-stale` come only from
replaying a held timeout, which happens after the walk, so they never reach the hold.

## Where and how (orchestrator only; every backend)
1. **A snapshot at every step's start.** The mutant-level fields PR-51's `HeldTimeout.snap` lists (`verdict`, `cause`,
   `failureNote`, `permissionRefusedTest`, `runnerDisagreement`/`-Test`, `notReproduced`, `refusedPending`,
   `transportErrorRef`, `abortAfterRecord`) are copied before each step is handled.
2. **Hold.** When a step ends the mutant as an error that qualifies (above):
   - the error's own fields are kept as the held error (the FIRST one only; a later qualifying error is only named, like PR-51's
     noted timeouts);
   - the fields are restored from that step's start snapshot, so no part of the error reaches a later kill (R1066's "the error's
     fields kept off a later kill");
   - **safety is checked first** (review L8). If `safety.isUnsafe` after the step, the answer is terminal, and nothing is
     re-activated;
   - **the mutant is re-activated only when the step deactivated it** (review M3): when a cold confirm, `confirmWarm`, or
     the found-0 confirm ran. Errors met on the covering row itself (`session-reused` at the walk site, `runner-refused`)
     leave the mutant active, and re-activating then would throw away v3's prefetched rows. Before a re-activation after a
     cold confirm that did not pass, the backend's pending kill pair is dropped. Otherwise v3's `activateOn` takes the pair's
     reproduction branch: it counts a reproduction nobody asked for (`pairRequests`, `pairFallbacks*Passed`, R653's accounting,
     and the v3 gate's `pairRequests: killed` check) and installs the pair's rows. The new backend hook is
     `dropPendingPair?(mutantId)`, which v3 implements. bcdev has no pair and does not need it. **On v3 the hook is REQUIRED on
     `V3LaneView`, beside `sendKillPair`, and `laneView` forwards it to the lane's `dropPair`** (delta review, M1): an optional
     hook a lane view forgot would bring M3's accounting bug back on parallel runs only. A unit test on a lane view pins it;
   - the walk continues from the next covering test (the generator is pulled again, as after PR-51's hold).
   - **v3, F1 widened (review H1).** PR-51's F1 (`aloneKill`: confirm and reproduce a fail measured ALONE, alone, and send no
     kill pair) applies whenever the walk holds ANYTHING, a timeout or an error, not only a held timeout. The reason: a held
     error can follow a TIMEOUT ROW that LethAL scores as an error: the virtual-clock stop's `runner-refused`
     (al-runner-v3-backend.ts, about :5673-5689). (A stop-seconds mismatch is `runner-test-error`, which stays terminal, so it is
     never held; delta review, L3.) v3 then records the cut (`timedOutMutants`), so
     a later covering test of that codeunit runs alone. Without F1, its in-context confirm would pass, and a test that fails
     only when run alone would be scored `killed`, which is R1067's false kill on a walk PR-81 created. Widening it moves no
     verdict that exists today, because every such walk ends `error` today. Whether a FIRST kill measured alone, with nothing
     held, needs an alone confirm is still R1067 (PR-55), not this.
     **Coordination with PR-55 (lethal-preproc, 2026-11-16).** PR-55 replaces this condition with "every alone kill gets an
     alone confirm", with no held term: `(v.outcome === "fail" || v.outcome === "timeout") && v.selection === "alone"`, on
     lethal/pr55 at 64100794. That covers the held-error case by itself. If PR-55 lands first, PR-81 builds on it and does NOT
     edit that line. The review H1 requirement is then met by PR-55's condition, and PR-81's H1 test still runs, against it. If
     PR-81 landed first, PR-55 would rebase onto it and drop the `heldError` term. Either way, the second to land re-runs its
     red checks for that condition (PR-55's `pr55-alone-confirm.test.ts` A1-A10, and PR-51's P11b).
3. **Walk end, no kill:**
   - a held timeout exists: PR-51's replay runs unchanged. Its result stands, whatever it is. When it is not a kill, the held
     error's test is named in the note's "after the timeout:" clause (names only, as PR-51 does);
   - no held timeout: the held error is restored as the mutant's outcome (its verdict, cause, note and diagnosis fields,
     exactly as today's walk would have recorded it). The tests answered after it are named in one "after the error:" clause
     (names only).
4. **A kill found later** (confirmed and reproduced): `killed`, with that test. The held error and any held timeout are dropped
   and named in the note, as PR-51 drops a held timeout. The note gives names only, never the error's diagnosis text (review
   L8). A dropped `unstable` that carried `permissionRefusedTest` or `runnerDisagreement` no longer counts in the report's
   `permissionsRefused`/R59 figures. That loss is accepted: the mutant was measured killed, and the note and the counts cannot
   disagree. The kill ledger (R197) records the killing test.
5. **R198's attempted-set check, and survivors:** a mutant with a held error can never end `survived`: no kill means the held
   error or the timeout outcome. The attempted-set check runs only for `survived`, so it is unchanged. **A safety net**
   (delta review, L5): after the walk, where `notReproduced` and `refusedPending` are resolved, a verdict still `survived`
   while an error is held is replaced by the held error. Then no future replay path can make a survivor out of a held error.
   The late net is unreachable today (every replay that ends `survived` sets `notReproduced`), so no test can reach it. E10
   exercises the EARLY `adoptHeldError`, not the late net (review L5).
   **A held error at the last covering test with the clock then spent** is dropped as `budgetCut` (left to `--resume`), as
   PR-108 treats held timeouts; no verdict moves (review L2).

## A stated reliance, and its measurement (delta review, L4)
Holding a `runner-refused` that did not follow a stop means the walk goes on past it. R639 deliberately did not: after such a
refusal, "that partial state is unknown". That is safe only if v3 marks every later FAIL row of the same call as untrusted
(`V3_REFUSAL_PREFIX`, al-runner-rows.ts). LethAL checks this itself for timeouts (R-435), not for fails. Reading T2's row after
T1's refusal is not new: a walk that met T2 first read it before. But PR-81 makes it happen in every order, on DO's 1,670 refused
mutants. **Before the build**, the store data `cost.md` mines is counted: fail rows in the same call AFTER a `runner-refused`
row that do NOT carry the marker. The result goes in addendum A.
- **If the count is 0:** the reliance is stated in the code beside the hold.
- **If it is not 0:** a `runner-refused` row is held only when it is the LAST row of its call, so no row after it in the same
  call can become a kill. Otherwise it is terminal for that walk.

## What it costs (measured from DO's stored runs: `/coord/handoff/PR-81/cost.md`)
- Every `error` in DO's ten R-984 windows (t1-t10) is `runner-refused`: 1,670 mutants. No `session-reused`, `unstable` or
  warm error appears.
- Store rows (`test_results`) show 25-40% of each such mutant's covering set ran before the error, usually 2-5 tests. Walking
  on adds 13,146 test runs over the ten windows (upper bound 18,012).
- In time, on v3: about 150 s in total by the mutants' own per-test time (about 146 s per codeunit), at most about 930 s by
  per-test medians. Per window that is 3-133 s, under 1% of any window.
- Most of these refusals are al-runner's "an earlier test of this codeunit was refused" cascade, so tests of the SAME codeunit
  refuse again. Only tests in other codeunits can turn such an error into a kill.
- **Not in the stored runs:** v3 daemon restarts. A test after an unkept refusal row pays one (29-88 s on DO, R-984). Errors met
  on the covering row leave the mutant active (review M3, so no prefetch is thrown away), but a refusal's daemon close is
  today's behaviour, now followed by more requests. That cost is measured after the build on one DO window, before and after.
- **bcdev:** not measured. Tests take seconds there, so the cost is higher per walk.

## Predictions (pre-committed)
- **No gate figure moves** (argument corrected, review L6).
  - No frozen baseline holds an `error`. A mutant can still meet an N error and end NOT `error` in one case: under PR-51, a held
    timeout followed by an N error ends `timeout-killed`.
  - The only baseline with `timeout-killed` is `hang.single.baseline.json`. PR-51's predictions list every hang-gate walk after
    its held timeout, and those walks meet only further hangs or nothing.
  - The other ways a walk goes on cannot leave a `killed` mutant that met an N error: kill-not-reproduced, R639 and found-0.
  - So `itest:alrunner-v3`, `itest:hang` and the BC gates are unchanged per mutant and in their call counts.
  - The hang gate's stored ON and SINGLE test rows are checked for any N error before the build. The result goes in an
    addendum.
- **Unit tests** (each red when its part is reverted), in a new `pr81-held-error.test.ts` beside PR-51's:
  - error (each cause in N), then a fail: `killed` with the failing test. The error's fields do not appear on the kill
    (`cause` undefined, the note names the held error only as dropped). Red if the walk stops at the error, or if a field
    leaks;
  - fail, then a would-be error: `killed`, and the erroring test is never run (call counter);
  - error, then passes only: `error` with the held error's cause and note, as today. The later tests ran (call counter);
  - error, then a second qualifying error, then a fail: `killed`; with no fail, the FIRST error is the outcome, and the second
    is only named;
  - error, then a terminal step (each terminal kind): today's terminal handling, the held error dropped and named after any
    `STRANDED_NOTE_PREFIX`, no further call;
  - error, then a fail that does not reproduce: `error` (the held one);
  - timeout, then error, then fail: `killed`. Timeout, then error, no fail: the timeout's replay result. Error, then timeout, no
    fail: the same result (order independence);
  - the mutant is re-activated after a held error before the next step (an activation counter on the fake backend: red if the
    re-activation is removed);
  - an error whose step set `transportErrorRef`, or `abortAfterRecord`, or latched safety: terminal, not held;
  - the property (narrowed, review M5): the same mutant gives the same CLASS for every order of its covering tests when each
    test's answer is a FIXED property of the test (pass, fail, timeout, or an error that does not depend on the call's
    packing: `session-reused`, `runner-refused`, cold `unstable`). Like PR-51's property test. Warm errors
    (`warm-prefix-unstable`, `warm-confirmation-incomplete`, warm `unstable`) exist only at position k > 1, so they depend on
    the packing and stay packing-dependent. A test with a fake that derives warm errors from the replay pins that remaining
    difference, so it is stated, not hidden;
  - **review H1:** a held `runner-refused` timeout row, then a fail marked `selection: "alone"`: an alone confirm and
    reproduction, and NO kill pair. Red if the pair is sent or the confirm runs in context;
  - **review M2:** a timeout, then `confirm-stopped` (and `op-stopped`, `stopped-after-completion`, a `group-*` cause): the held
    timeout is replayed and scored as today. Red if the terminal cause wins;
  - **review M3:** no re-activation after an error met on the covering row (an activation counter); re-activation after a
    confirm's error; v3's pending pair dropped before it (no `pairRequests` increment). Red for each;
  - **review L8:** safety latched after an error: terminal, no re-activation;
  - `runner-test-error` before a fail: terminal, as today.
- **Red both ways**, per finding: the hold reverted (old behaviour) turns the order and kill tests red; a terminal cause wrongly
  added to N turns its terminal test red.

## Not in scope
- R1067 (PR-55): the confirm of a FIRST kill measured alone, with nothing held. Untouched here. The widening for held walks
  (H1) is covered by PR-55's condition when PR-55 lands first (delta review, L2).
- The cause stability of an `error` across orders (only the class is made stable).
- `group-*` causes stay terminal. They describe the group call itself, so walking on through the same call is not attempted.

## Addendum A (2026-11-16, before the build merged): the L4 count and the hang-gate check

**L4 measurement** (source: `/coord/handoff/PR-81/cost.md`, section L4; DO's stored R-984 runs). Marker: `V3_REFUSAL_PREFIX`.
- Scope: 1,670 mutants scored `error` (the walks a non-after-stop refusal ended), 1,848 refusal rows. Every error row in them carries the marker.
- Rows after a refusal, same mutant and codeunit (1,680): 1,483 pass; 197 error, refused again and marked; 0 fail without the marker; 0 fail with it. Widened to any codeunit of the same mutant: also 0 fail rows.
- The store has no call id, so "the same call" is approximated by mutant, codeunit and row order. It covers walks that ended as `error` only.
- **Result: the count is 0, but it is NOT evidence** (review M1): those walks broke at the refusal, so no later row was ever read, and 0 is true by construction. The basis for holding: a refusal is `notRun`, so the refused test never executed and left no state; a later test's plain FAIL in the same call is as trustworthy as any (R637 already scores it as a kill, with a note, when the walk meets it first). What can NOT be trusted is a row after an UNFINISHED test: v3 marks it (upstream #5776) and R-435 maps it to `runner-test-error`, which is terminal (never held). Leg C pins those markings: `refusal-cascade` and `dependent-fail-after-timeout-is-notrun` in `al-runner-v3-contract.ts`. The code comment beside the hold says so. `runner-refused` is held without the "last row of its call" restriction.

**Hang-gate row check.** No stored hang-gate store (ON or SINGLE) was found quickly, so no stored test row was checked for an N error. The prediction rests on the PR-51 argument: its list of every hang-gate walk after its held timeout shows only further hangs or nothing, and no frozen baseline holds an `error`.

**Build notes.**
- PR-51's `P5a`, `P5b` and `P11c` assert that the walk stops at a session-reused or unstable error that follows a held timeout (`nthOf(T3) === 0`). Under this rule that error is held and the walk goes on (`nthOf(T3) === 1`); the class (`timeout-killed`) is unchanged. These three assertions need updating by the owner of PR-51's file.
- **Moved under the owner's ruling q-20261117T160215-3631a110 (option a):** P5a, P5b and P11c (`nthOf(T3)` is now 1, the class
  unchanged), O3 (R639's stop reversed: `timeout-killed`, T2 run twice, once in the walk and once as the replay), and O7 (one
  activation: the re-activation after a held confirm is sent only just before a covering test runs, review L1).
- **Red checks on the rebased build:** E16, E17 and E18 were added for `warm-timeout-unconfirmed`, `warm-confirmation-incomplete` and
  `!replaying`. The `abortAfterRecord` clause, the `heldRounds` guard and the late L5 net are redundant or unreachable by
  construction, and say so beside them.
- The L5 net (a `survived` verdict still standing while an error is held) is defence in depth: no walk reaches it, because a replay ending with no verdict always leaves `notReproduced` set.
- A guard throws when a walk holds more errors than it has covering tests, so a walk that fails to advance stops by name instead of looping.
