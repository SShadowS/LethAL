# R-551 plan r2: `--test-exact` where the build accepts it, R488's path otherwise

Base: `origin/master` `97d295c7`. Measurements: `measure.md` (r2 corrections marked). Raw captures:
`captures/`. Review: `review-plan-opus.md` (REVISE; all findings accepted). Not implemented, not
committed.

## Changes from r1

1. **I1.** The probe's exit 6 is no longer called proof that the flag SELECTS. It shows only that
   the build parses `--test-exact` and counts it in its selection audit (al-runner `Program.cs`,
   `--test selection audit (#4055)`: the audit fires on `testExact.Count > 0`, and an empty bundle
   never reaches the executor). The whole-name guarantee now rests, explicitly, on `--test X` staying
   in the argv plus the exact-path refusal. Corrected in sections 1 and 2, in the code comment text
   (section 1) and in the docs/measurements entry (section 7). No behavioural probe, by ruling.
2. **I2.** The probe classifies on exit code and envelope only. `reason` = a short code plus the first
   non-blank stderr line, trimmed, at most 200 chars. N3 pins both `exit 2` and
   `Unknown option '--test-exact'`.
3. **I3.** The probe spawns through the backend's injected `this.spawn` (pinned by P8 and P9). The
   cli-default leg gets an emit hook asserting ZERO `al-runner-test-selector` events. It is made
   non-vacuous by also requiring at least one event of another kind in that leg.
4. **M1.** `exactTestSelector` is set in BOTH directions from the probe result
   (`= kind === "exact"`); every worker receives the boolean every time
   (`useExactTestSelector(on)`). New test B8 covers "not accepted after accepted resets".
5. **M2.** B3 is a NEW test, so R488's 14 tests keep their bodies unedited (U1 holds).
6. **M3.** The R149 contract argv does not carry `--test-exact`. Recorded in measure.md section 5 and as
   a code comment at the contract argv. No code move.
7. **M4.** The pre-commitment gains a re-run-on-base rule for run F too.
8. **M5.** One sentence for R551: a binary swapped mid-session is LOUD, not wrong (section 3).
9. **M6 and two follow-ups:** three roadmap items for the builder to file (section 10). R551 is
   retitled at landing so it does not claim retirement.
10. **runSession fakes checked:** none answers exit 6 with an empty envelope (section 6, "Existing
    fakes").
11. Wording: "proven" is now "accepted" throughout, because the probe proves parsing only.
12. Pre-commitment r2: the review's changes plus "identity comes from `--version`; the hashed file is
    the dotnet-tool shim".

## 0. What R488 does today (the fallback, kept byte for byte)

Why it exists: al-runner's `--test PATTERN` keeps every test whose qualified name CONTAINS
`PATTERN`, ignoring case. `--test Codeunit61510.Stone` also runs `StoneTwin` in the same process,
under one deadline, into one Cobertura (coverage) file (measure.md row 2, both builds). LethAL's
one-shot `run()` asks for one test and would credit the whole result to it.

What it does (`packages/runner/src/al-runner-backend.ts`, `al-runner-transport.ts`):
- `useDiscoveredTests(tests)` stores every discovered qualified name (all `#if` arms). `runSession`
  calls it on the session backend and on every worker.
- `siblingsOf(wanted)` = discovered names that contain `wanted` ignoring case, minus a name equal to
  it ignoring case (excluding that empties the run), plus names learned for `wanted`.
- `sendOneShot` sends them as `--exclude-test <name>`, one each (`AlRunnerRequest.excludeTests`,
  emitted by `buildAlRunnerArgv` right after `--test <name>`). `--exclude-test` matches a WHOLE name.
- `run()` loop: two rows equal to `wanted` (exactly or ignoring case) are refused (R491). Any other
  name: if not yet known, learn it and re-run; if already excluded, refuse by name with
  `outcome: "error"`, `operation: "completed-accepted"` (R491: the test was dispatched).

R488's red tests (in `packages/runner/tests/`; all stay unchanged, bodies and names, and green):

`al-runner-backend.test.ts`
1. `refuses loudly when the runner returns some other test, naming both sides`
2. `a hang from an undiscovered look-alike is deadline-exceeded, never a kill (R490)`
3. describe `AlRunnerBackend one-shot: a result naming any other test is never credited (R488)`:
   1. `the fake is as strict as al-runner: excluding the requested test itself drops it`
   2. `an excluded REQUESTED test is never learned: the run is not emptied by its own exclude`
   3. `coverage on: the credited coverage is the re-run's Cobertura, never the merged call's`
   4. `a result listing the requested test TWICE is refused by name, never credited (R491)`
   5. `two rows equal to the requested test IGNORING CASE are refused the same way (R491)`
   6. `a merged result is discarded and the test re-runs alone with --exclude-test per sibling`
   7. `with the discovered list, even the FIRST call excludes the look-alike and runs once`
   8. `a discovered name equal to the requested one IGNORING CASE is never excluded`
   9. `a result that still names another test after its excludes is refused by name`
   10. `an exact single-test result is credited from one call with today's argv`
4. `a sibling that hangs first is learned from the exit 3 and the wanted test re-runs alone`

`orchestrator.test.ts`
5. `the session backend and every worker get the discovered tests, look-alikes included (R488)`

That is 14 tests. They build the backend without the probe, so they run on the fallback path by
construction. **A backend nobody probed is an R488 backend.**

## 1. The probe

One al-runner call, once per session, one-shot transport only, spawned through the backend's own
injected `this.spawn` (so every unit and itest fake sees it):

```
<alRunnerPath> --output-json --test-exact Codeunit0.LethalR551NoSuchTest <E>
```

`<E>` = a fresh empty `mkdtemp` directory, removed afterwards (best-effort). No `--auto-provision`,
no `--package-cache`, no env, nothing compiled.

**Accepted** only when ALL hold:
- the call returned before its own deadline (a race, as `runAlRunnerContractProbe.run` does; 30 s);
- `isChildChosenExit(exitCode)` (existing, `al-runner-transport.ts`) and `exitCode === 6`;
- stdout holds the `--output-json` envelope (the transport's existing reader, exported for this)
  whose `tests` is an empty array and whose `exitCode` is `6`.

Nothing else is read for the decision: no stderr wording, no version.

**What acceptance means (I1). The code carries this comment:**

> Exit 6 with an empty envelope shows that this build PARSES `--test-exact` and counts it in its
> selection audit. It does not show that the flag selects, or that it matches whole names: on an
> empty bundle al-runner never reaches the executor. A build without the flag exits 2 before doing
> anything. The whole-name guarantee is NOT this probe: it is `--test <name>` kept in the argv (so a
> build that ignored `--test-exact` still selects no more than today's substring match) plus the
> exact-path refusal of any result naming another test (`run()`).

**`reason` on rejection (I2):** a short code, then `; stderr: <first non-blank stderr line, trimmed,
at most 200 chars>` when stderr has one. Codes: `exit <n>`, `deadline`, `spawn failed: <message>`,
`exit 6 but no readable envelope`, `exit 6 but envelope exitCode <n>`, `exit 6 but <n> test row(s)`,
`signal exit <n>`. On 43f76177: `exit 2; stderr: Unknown option '--test-exact'. Run with --help for
the supported flags.` The stderr line is for the reader only; the decision never reads it.

**Cost (measured, 5 reps):** c5bbaf89 1243-1276 ms; 43f76177 135-160 ms. Once per session, outside
every mutant's clock.

**Why not reuse an existing call** (measure.md section 5): `--version`/`--help` are honoured only as
the first argument. Provisioning, the R123 contract runs and the R392 probe do real work that an
`Unknown option` exit would destroy on 43f76177 and c39ad5de (the host pin). R407's frame probe does
not run every session. The R123 probe's result is not handed to backends.

**Where:** `AlRunnerBackend.probeExactTestSelector(): Promise<TestSelectorProbe>`, structural (like
`provisionOnce`, not on `ExecutionBackend`). Under `serverMode` it returns `{ kind: "not-applicable" }`
WITHOUT spawning. Otherwise it sets its own `exactTestSelector = (kind === "exact")`, in both
directions (M1). The classifier is a pure exported function `classifyTestExactProbe(res)`.

```ts
type TestSelectorProbe =
  | { readonly kind: "not-applicable" }                       // --server: never spawned
  | { readonly kind: "exact"; readonly elapsedMs: number }
  | { readonly kind: "substring"; readonly elapsedMs: number; readonly reason: string };
```

**In `runSession`:** right after the provisioning block, before the R392 probe, discovery and the
baseline:

```ts
let exactTestSelector = false;
const selector = cfg.backend as { probeExactTestSelector?: () => Promise<TestSelectorProbe> };
const probed = selector.probeExactTestSelector !== undefined;
if (probed) {
  const p = await selector.probeExactTestSelector();
  if (p.kind !== "not-applicable") {
    exactTestSelector = p.kind === "exact";
    emit({ type: "warning", code: "al-runner-test-selector", message: <below> });
  }
}
```

Messages (pinned by unit test; the pre-commitment reads them):
- `al-runner test selector: exact (--test-exact accepted by a one-call probe in <n> ms; R551)`
- `al-runner test selector: substring with R488 excludes (--test-exact not accepted: <reason>; probe <n> ms; R551)`

A warning on every healthy run is acceptable (review M7).

Workers: where `worker.useDiscoveredTests?.(...)` is called, and when the session backend had
`probeExactTestSelector`, call `useExactTestSelector(exactTestSelector)` on EVERY worker, true or
false (M1). A worker that lacks the method then makes `runSession` THROW, naming the worker, as the
R147 pin mismatch does. Workers never probe.

## 2. The argv, with and without

`AlRunnerRequest` gains `readonly testExact?: true` (doc comment: R551; absent = today's argv byte
for byte). `buildAlRunnerArgv` emits it right after `--test <name>`:

Fallback (not accepted; identical to today):
```
al-runner --output-json --isolation test --test Codeunit78950.GrowPre --exclude-test Codeunit78950.GrowPreTwin [--auto-provision | --package-cache <pin>] [--coverage --coverage-out <f>] ... <bundle> <tests>
```
Exact (accepted):
```
al-runner --output-json --isolation test --test Codeunit78950.GrowPre --test-exact Codeunit78950.GrowPre [--auto-provision | --package-cache <pin>] [--coverage --coverage-out <f>] ... <bundle> <tests>
```

Why `--test X --test-exact X`, not `--test-exact X` alone: on c5bbaf89 the two are the intersection
and select exactly X (measure.md row 10, Cobertura identical to rows 3 and 4). And this is what the
whole-name guarantee rests on (I1): a build that accepted `--test-exact` but ignored or mis-matched it
selects no more than `--test X`'s substring set, and any extra row is refused by name (section 4).
`--test-exact X` alone could, on such a build, run the whole suite under one test's deadline.

On the exact path `sendOneShot` sends NO `--exclude-test`. The discovered list is still stored, and
unused. Every other `buildAlRunnerArgv` caller (provisioning, R123 contract, R392 probe, R407 frame
probe) never sets `testExact` and is unchanged. M3: a comment at the contract probe's argv says it
deliberately does not carry `--test-exact`, and that the fields it reads were measured identical with
and without it (review M3).

## 3. Fail-closed rule

`exactTestSelector` defaults to `false`. It is `true` only after an accepting probe on this backend,
or after `useExactTestSelector(true)` from `runSession` once the session backend's probe accepted.
Anything else (deadline, spawn failure, signal, any exit other than 6, no envelope, a non-empty
`tests`, an envelope `exitCode` other than 6, server mode, a backend built outside `runSession`)
keeps the R488 path. "Not accepted" never refuses the session: the R488 path is correct on every
build measured.

No version table. No mid-session switching: the choice is made once, before the baseline, so the
baseline and every mutant run under the same selector.

M5, one sentence for R551: if the binary is swapped mid-session for one without the flag, every
exact-path call exits 2 and is a loud `error`, never a credited result; a swap the other way stays on
the R488 path, which is correct.

## 4. "A result naming another test" refused on both paths

In `run()`'s loop, unchanged order:
1. R491 duplicate check (two rows equal to `wanted`): refused, both paths. Unchanged, still first.
2. `extras` = names other than `wanted`; none: credit.
3. **Exact path:** refuse at once, no learn, no re-run:
   `al-runner ran tests other than the requested "<wanted>" (<extras>) despite --test-exact; a result naming another test is never credited (R488, R551)`,
   `outcome: "error"`, `operation: "completed-accepted"`.
4. **Fallback:** exactly today's learn-and-re-run, then refusal.

The `no test named` error after the loop is unchanged on both paths. A zero-test result is an error,
never scored (review: holds).

## 5. `--server`: no change

- `--server --test-exact X` is refused at startup on c5bbaf89 (exit 2, about 200 ms, "--test-exact is
  not supported with --server ... a startup --test-exact would be ignored") and is an unknown option
  on 43f76177. Neither starts a daemon.
- LethAL never sends it there: the daemon's argv is built in `al-runner-server.ts`, not by
  `buildAlRunnerArgv`, and `testExact` exists only on the one-shot request.
- LethAL's server path has no per-test selector to replace. `ensureServerSuite` sends `runTests`
  with no `test` field: one whole-suite run per activation, each row looked up by exact name,
  per-test coverage per test (clean, measured in R488).
- The probe is not spawned under `serverMode`. It would buy nothing there, and the cli-default leg's
  exact list of allowed one-shot commands would go red on an extra spawn.

## 6. Tests (a red-going test per direction)

Each line names the change that turns it red; the lane red-checks each by that revert and reports
both outputs.

Argv (`al-runner-transport.test.ts`):
- A1 `testExact: true` gives `--test X --test-exact X`, adjacent, once, no `--exclude-test`. Red: drop
  the `--test-exact` emission.
- A2 without `testExact` the argv equals today's (pin the whole array). Red: emit it unconditionally.

Probe (`al-runner-backend.test.ts` or a new `r551-test-exact-probe.test.ts`; captures from
`captures/` as fixtures, with scratch paths replaced):
- P1 c5bbaf89's capture (exit 6, envelope `tests: []`, `exitCode: 6`): `exact`. Red: a classifier
  that never says exact.
- P2 43f76177's capture (exit 2, empty stdout): `substring`, reason contains `exit 2` AND
  `Unknown option '--test-exact'`. Red: accept any child-chosen exit; or drop the stderr line from
  the reason.
- P2b a 300-char stderr line is cut to 200 chars; blank leading lines are skipped. Red: no trim, or no
  skip.
- P2c the decision does not change when stderr is replaced by arbitrary text (same exit and
  envelope), in both directions (an accepting and a rejecting case). Red: any stderr-wording check in
  the decision.
- P3 exit 0 with an empty-tests envelope: `substring`. Red: accept "envelope with no tests" without
  checking exit 6.
- P4 exit 6, empty stdout: `substring`. Red: accept exit 6 alone.
- P5 exit 6, envelope with one test row: `substring`. Red: drop the empty-`tests` check.
- P6 exit 6, envelope `exitCode: 0`: `substring`. Red: drop the envelope-exitCode check.
- P7 exit 143 (signal), the deadline, and a rejecting spawn: `substring`, never throws. Red: drop
  `isChildChosenExit`, the race, or the catch.
- P8 the probe calls the backend's INJECTED spawn exactly once, with argv exactly
  `[cfg.alRunnerPath, "--output-json", "--test-exact", "Codeunit0.LethalR551NoSuchTest", <dir>]`,
  and `<dir>` exists and is empty at spawn time. Red: any argv change, or spawning through
  `defaultSpawn` instead of `this.spawn`.
- P9 under `serverMode` the probe returns `not-applicable` and the injected spawn is called 0 times.
  Red: probing regardless of transport.

Backend (fakes: R488's `substringRunner`, plus an `exactRunner` that honours `--test-exact` by whole
name ignoring case and intersects it with `--test`, as c5bbaf89 does):
- B1 flag build uses it: after an accepting probe, with discovered look-alikes, `run(ref)` makes ONE
  call whose argv has `--test QUALIFIED --test-exact QUALIFIED` and no `--exclude-test`; credited.
  Red: the exact branch not taken.
- B2 no-flag build keeps R488: after a rejecting probe (43f76177 capture), the same setup's first argv
  has `--exclude-test TWIN` and no `--test-exact`. Red: set the flag on any probe result.
- B3 (NEW test, M2) a backend that was never probed, with discovered look-alikes: every argv has no
  `--test-exact` and the first has `--exclude-test TWIN`. Red: default `true`.
- B4 refusal on the exact path: accepting probe, then `substringRunner` (ignores `--test-exact`):
  `outcome: "error"`, message names TWIN and `--test-exact`, `operation: "completed-accepted"`,
  exactly 1 call. Red: delete the exact-path refusal (it falls into the learn loop: 2 calls, a
  credited pass), or credit the row.
- B5 refusal on the fallback: R488 test 3.9, unchanged.
- B6 R491 duplicate rows on the exact path: refused, 1 call. Red: put the exact-path return above
  the R491 check.
- B7 coverage on the exact path: Cobertura credited from the single call, procedures `["Reached"]`.
  Red: any merge.
- B8 (M1) accepting probe, then `useExactTestSelector(false)`, and separately a second, rejecting
  probe: in both cases the next argv has no `--test-exact` and carries `--exclude-test TWIN`. Red:
  set the flag only on acceptance (never reset it).

Orchestrator (`orchestrator.test.ts`):
- O1 the probe runs once per session, before the session backend's first `run()`; every worker gets
  `useExactTestSelector(<bool>)` before its own first `run()` (call counters on one shared log, as
  R488's orchestrator test does). Red: call it after the baseline, or skip a worker.
- O2 a rejecting probe: every worker receives `useExactTestSelector(false)`. Red: hand over only on
  acceptance, or hand over `true`.
- O3 a worker lacking `useExactTestSelector` while the session backend has a probe: `runSession`
  throws naming the worker. Red: optional-chain it.
- O4 exactly one `al-runner-test-selector` warning per probed session, with the messages above; none
  when the probe says `not-applicable`. Red: drop or duplicate the emit.

R488's 14 tests: unchanged and green. The lane re-runs three of R488's own red-checks once (revert
`siblingsOf` seeding: 3.7 red; delete the learn branch: 3.6 red; delete the refusal: 3.9 red).

**Existing fakes (coordinator's check).** I searched `packages/runner/tests/`, `itest/` and `src/`
for any fake answering exit 6. The only `exitCode: 6` literals are in `itest/verify-scale.test.ts`
and `itest/verify-reach-fields.test.ts`, and both are LethAL `verify` OUTPUT objects, not al-runner
spawn fakes. In the test files that build a real `AlRunnerBackend` and call `runSession`, the only
exit literals other than 0, 1 and 3 are 143 (`al-runner-platform-apps.test.ts`), 2
(`r534-runner-rows.test.ts`) and 9009 (`al-runner-backend.test.ts`). **No runSession-level fake
answers exit 6 with an empty envelope.** So every existing one-shot runSession test will see the
probe REJECTED and stay on the R488 path; it also sees one extra spawn and one extra warning. The
only spawn-count assertions found there are in `r407-admission.test.ts` (counts frame-probe and
provisioning calls, not all spawns) and `cli-envtool.test.ts` (resets its own counter). The lane
confirms with `bun scripts/verify.ts`. `orchestrator.test.ts` uses stub backends without
`probeExactTestSelector`, so no probe runs there. Consequence: the exact path is reached in unit
tests only by the new tests above, which is intended.

## 7. Report / schema ripple

None. The choice is a `warning` event (`code` is a free string in `events.ts`). It reaches the
`--progress-out` NDJSON and emit hooks. Warnings are not folded into `SessionReport`, so there is no
change to `report-fold.ts`, `report.ts`, schemas, snapshots, sample reports or the store. A
`SessionReport` field is follow-up item 2 (section 10).

Docs the lane updates:
- `docs/roadmap/R551.md`: status; RETITLE so it does not claim retirement (for example "al-runner
  one-shot: use `--test-exact` where the build accepts it; R488's path stays as the fallback"); the
  M5 sentence; the follow-ups' ids.
- `R488.md` status text (points at R551 and the retirement follow-up).
- `docs/measurements/README.md` §"al-runner v2": one entry, worded per I1: "`--test-exact NAME`
  (c5bbaf89): whole name, case-insensitive, repeatable, intersects `--test`, exit 6 when nothing is
  selected, refused with `--server`; unknown option (exit 2) on 43f76177 and earlier. LethAL's
  session probe shows only that a build PARSES the flag (exit 6 on an empty bundle comes from the
  selection audit, not the executor); the whole-name guarantee is `--test` kept in the argv plus the
  refusal of any other test's row."
- The R488 comment on `AlRunnerRequest.excludeTests` ("no `--test-exact`" is now build-dependent).
- Regenerate `ROADMAP.md`; run `bun test scripts/line-citations.test.ts`.

## 8. Live plan (the lane runs it; no BC)

itest changes first (`al-runner.itest.ts`):
- In the shared `runOnce` emit hook, collect `al-runner-test-selector` warnings; print the line per
  leg; assert exactly one on every one-shot leg and none on every `--server`/resource leg. The VALUE
  is printed, not asserted (asserting it would need a build table); the pre-commitment pins it for
  these two runs.
- I3: `runCliDefaultLeg`'s `runSession` call gains an `emit` hook that counts every event. Assert
  ZERO `al-runner-test-selector` warnings AND at least one event of another kind. With no events at
  all, the check FAILS ("hook received nothing; the zero is vacuous"). Red-check both: remove the
  `emit` wiring and the check must fail; force the probe to spawn under server mode and the check
  must fail.

Then:
1. Unit loop: typecheck, clean dist, `bun scripts/verify.ts`.
2. Run F: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<scratch>/r551/c5bbaf89/al-runner bun run itest:alrunner`
3. Run N: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<scratch>/r551/43f76177/al-runner bun run itest:alrunner`
   This is R488's regression shape on a build without the flag: the wrapped one-shot leg has 10
   look-alike pairs (measure.md section 6) and goes through the R488 path.

Use the scratch copies by path; check `--version` first (pre-commitment). Foreground, never polled.

## 9. Open questions

None blocking. The two r1 questions are ruled: event only now, with a follow-up item for a report
field; the gate prints the value and the pre-commitment pins it.

## 10. Roadmap items for the builder to file (check the next free id immediately before writing)

1. **Quoted AL test names are CLR-mangled by al-runner (review M6, pre-existing).** A test declared
   `procedure "Stone Quoted"()` is reported as `Stone_Quoted`, so LethAL's qualified name never
   matches and such a test never runs, on either path (`--test` or `--test-exact`). Needs its own
   measurement and fix; not R551's.
2. **Optional `executionContexts[].testSelector` in `SessionReport`** at the next schema ripple, so a
   report states which selector produced its verdicts (today only the event says it).
3. **Retire R488's exclude-and-learn path** once every supported build (the host pin and the
   container's gate build) carries `--test-exact`. Until then it is the fallback.
