# PR-256 pre-commitment (R1146): per-entry stop groups on v3 mutant requests, behind `alRunnerV3.stopGroups` (default off)

Status: pre-commitment (coord PR-256, lethal-preproc, 2026-11-22), after the spec-adversary (2 BLOCKs and 4 SHOULD-FIXes,
all taken below), before the build. The build does not need #8564 in `current`. The `stop-groups` probe, the gates with the
flag on and the DO measurement follow bugs' gate of a main build that carries it. Sources: `/coord/handoff/PR-256/plan.md`,
`/coord/handoff/PR-257/` (PERF-18, master 9e71211c6). Names and numbers only.

## What upstream gives (PR-257, measured)
- A request with `stopAfterFirstFailure: true`, and `stopGroup` on every entry. After the first failing test in a group, its
  later tests are not run. Mixing grouped and ungrouped entries is refused, and so is a group with the stop off.
- **A skipped row** comes back as status `error`, `notRun: true`, with the message `NotRun: out-of-scope: the test
  <Codeunit>.<Method> failed before it, and stopAfterFirstFailure (--stop-after-first-failure) ...`.

## The rules
1. **One group per ENTRY,** `<mutant>|<codeunit>`. The echo entry is its own group, `<mutant>|echo`. (Adversary BLOCK 2: one
   group per mutant lets a failure in one codeunit's entry skip a test in another entry, which today reads as a refusal.)
2. **Only on mutant requests:** prefetch (packed) and live calls, an alone call under a mutant (PR-297's tail route), and
   the R897 alone re-run. NEVER on baseline, warm-up, coverage, the PR-144 recheck, PR-297's tail stability pass, a NONE
   confirm, or a **kill-pair request** (NONE and M share one request; pairs are a confirm path and are sent with the stop
   off; adversary S1).
3. **Recognising a skipped row,** strict, and otherwise it stays a refusal as today (fail closed). A row is "skipped by the
   stop" only when all hold:
   - the request carried `stopAfterFirstFailure: true` and the row's entry carried a `stopGroup`;
   - its message matches the pinned text, naming test F;
   - F is an earlier row of the SAME entry whose status is a plain `fail` (not a timeout, not a refusal-marked fail,
     R639 K1(a));
   - F is a covering test of this mutant and was green, and not refused, at baseline (adversary BLOCK 1: a test red at
     baseline, declared before a covering test, must never be credited with a kill).
4. **What a recognised skip does:** no verdict, no kill, no error, no refusal, no daemon close, no cut. It is counted
   (`stopSkipped`).
   - The recognition sits in the mutant-row reuse check (`serveDaemonReusable`'s mutant-entry use) and its two companions
     (`unkeptRowReason`, `cutRow`), never in the shared rule the baseline uses (adversary S3).
5. **A skipped ref the walk still needs** (the kill ledger's preferred killer, a later covering test after a kill that does
   not stand, a ref in another entry) is re-run ALONE under the same mutant without the stop, the R897 `aloneAfterStop`
   pattern. It is never `rowMissing` or `error`.
   - So the walk, the R197 kill order and `killingTest` are exactly today's. A skip only saves the tests nobody asks for
     (adversary BLOCK 2, S2).
6. **Shape errors** are refused BY NAME before sending, with a typed error that is not swallowed by the pair-skip catch:
   grouped and ungrouped entries mixed, or a grouped entry with the stop off.
7. **Flag and capability:**
   - `alRunnerV3.stopGroups`, default OFF. With the flag off, requests are byte-identical to today (pinned by a test).
   - With the flag on, a build fact `stop-groups` is required, otherwise the run is refused by name.
   - The fingerprint and the lending tag gain ` stop-groups`, so `--resume` across flag states is refused.

## Tests (red before the build)
1. a skip after a plain fail of a green covering test in the same entry: no refusal, no close, `stopSkipped` 1, the mutant
   killed by F;
2. a skip naming a test red at baseline: a refusal, as today;
3. a skip naming a test of ANOTHER entry: a refusal (cannot happen with per-entry groups; pinned anyway);
4. the pinned text on a request sent without the stop, or on an entry without a group: a refusal (N1);
5. a skip after a timeout row: a refusal;
6. the walk asks for a skipped ref: it is re-run alone without the stop, and the killing test equals the flag-off one;
7. a kill-pair request with the flag on carries no stop and no groups;
8. a mixed request is refused by name (the typed error, not `pair-skipped`);
9. flag off: requests byte-identical.

## Predictions
- **Flag off** (every gate's default): nothing moves; no gate sets the flag.
- **The probe** (`stop-groups`, on the first build with #8564):
  - two grouped entries, the first failing, must skip the second with the pinned text;
  - a timeout row and a refusal row as the first failure must NOT produce the pinned skip text on a later row, or, if
    they do, rule 3 keeps them refusals;
  - the daemon is reusable after a skip (adversary S4).
- **DO measurement (later, its own pre-commitment):** flag on against off, per mutant. Verdicts and `killingTest` must be
  equal (rule 5 keeps the walk). The saving: R1098's ~10.7% of serve test time after a kill is an upper bound; per-entry
  groups and alone re-runs make it smaller. (Superseded for `killingTest` by amendment 1, change 3.)

## Amendment 1 (2026-11-22, the Opus build review of 2a4763b3b: 1 BLOCK, 2 SHOULD-FIXes; before any build gets the fact)
1. **The stop needs the §6 Sleep rule retired** (review B1). A mutant request carries the stop only when
   `sleepRuleRetiredForParallel()` holds, as R895's cut and PR-297's tail do. Otherwise the flag is refused in `status()` by
   name. On a build with the fact but the rule in force, the coverage window would read the skipped tests as missing rows
   (a wrong `error`), and an alone re-run would reach the cut guard and throw.
   - Test: the fact present, the rule not retired: refused, and no stop sent.
2. **An unrecognised skip is never a refusal** (review S1; this replaces rule 3's "otherwise it stays a refusal").
   - Every row with the pinned skip text, on a request that carried the stop and an entry that carried a group, is
     "skipped": no refusal, no daemon close, no cut, and nothing credited from it. This applies whether or not F is this
     mutant's covering, baseline-green, plain-fail test.
   - F's own row is still scored as itself, as any row is.
   - Rule 5 is unchanged: any skipped ref the walk needs is re-run alone without the stop.
   - So rule 3's strict conditions now decide only whether the skip is COUNTED as a saving (`stopSkipped`), never whether
     the row is a refusal.
   - A pinned skip text on a request WITHOUT the stop, or an entry without a group, or naming no earlier failed row of its
     entry, is still a refusal (a contract violation, fail closed).
   - **Tests red at baseline are left out of stop-grouped entries** (as R998's are), so they cannot fire the stop at all.
   - Tests: a baseline-red test before a covering one under the flag: no refusal, no close, and the covering test measured
     as with the flag off; a non-covering state-dependent failure (test 2b's shape) likewise.
3. **`killingTest` may differ, verdicts may not** (review S2). The walk reads covering tests in R197's order.
   - With the flag off, a later test P failing after F is "not trusted" (R978), so F becomes the killer.
   - With the flag on, P is skipped and re-run alone, where its fail is real, confirmed and reproduced alone, so P becomes
     the killer.
   - Both are real kills. The DO measurement's rule: verdicts equal per mutant; a `killingTest` difference is allowed only
     when the flag-on killer is a covering test whose alone run failed and reproduced. Each is listed. Any other difference
     is a BLOCK.
4. **NITs:**
   - `stopSkipped` must not count the same skips twice on a re-sent request (scan gap, drift, R612): pinned by a test;
   - a comment where `dropStopSkips` reads `coveringOf`, saying a mutant never registered fails closed.

## Amendment 2 (2026-11-22, the build's one departure from amendment 1, accepted)
- **Amendment 1 item 2 said:** leave baseline-red tests OUT of stop-grouped entries, as R998's are.
  - R998 leaves out only a run of tests at the END of a codeunit. A red test BEFORE a covering one is a gap, so the request
    cannot carry `runSelectedOnly`.
  - Without it, a left-out test still runs hidden (R1094). It could still fire the stop, and the skip would name a test with
    no row.
- **As built:** an entry that would run a baseline-red test gets no group. A request must be all grouped or none, so the whole
  request goes WITHOUT the stop: exactly today's request.
  - It costs saving, never a verdict. Such requests are counted (`heldForRed`) and shown with the flag on.
- **For the DO measurement:** report `heldForRed` against the requests sent. If it turns the stop off for most of DO, true
  exclusion needs a ruling on sending `runSelectedOnly` with gaps, which changes the state later tests start from.
- Everything else in amendment 1 is built as written (B1's Sleep gate and `status()` refusal; skips never refusals; the N1
  counts, pinned). Build: `lethal/pr-256` 2281acb4e.

## Amendment 3 (2026-11-24, lethal-bugs, after PR-359; the orchestrator's "amendment 2" for R1203): a second allowed kind
- **Why:** PR-359's ABBA run (R1203) moved 5 `killingTest`s in codeunit 68861 ("CDO eSeal Setup UI Tests") with B's killer
  P BEFORE A's killer F in R197's order. Amendment 1's change 3 allows only P after F, so each was a BLOCK. R1203's reading
  (master 845051787; `/coord/handoff/R1203/rows.txt`, `cov.txt`) explains them:
  - the walk starts at F (DisableService) in both arms;
  - in A's whole-codeunit run, F fails only because an earlier covering test P (EnableService or OpenPage) failed under the
    mutant before closing the codeunit-GLOBAL TestPage ("The TestPage is already open.");
  - B's stop groups run them apart, so F passes and P fails on its own assertion;
  - A's killer carries `[v3-codeunit-state-possible]` naming P as an earlier FAILED covering test.
  - B's killers are what LethAL's one-method bcdev path would report (R156). BC cannot be asked: they are TestPage tests.
- **The rule (added to change 3; it changes no default, and `alRunnerV3.stopGroups` stays off until a later A/B passes
  both V and speed):** a `killingTest` move with P BEFORE F is the allowed kind only when ALL of these hold:
  1. A's killer F carries `[v3-codeunit-state-possible]`, and its note names P as an earlier covering test with outcome
     `fail` in the same v3 codeunit run;
  2. B's P fails on its own and its kill reproduces (the mutant fails, NONE passes, the mutant fails);
  3. the verdict is equal (both `killed`);
  4. each such move is listed by mutant and site key in the result.
  - Anything else with P before F stays a BLOCK.
- **The five it covers** (PR-359 half 1, A1 against B1): M4774, M4775, M4789, M4791, M4796, all in
  `src/Features/ESeal/CDOeSealServiceSetup.Page.al` (lines 109, 110, 137, 138, 145; site keys in R1203).
- **M12932 is a different shape, NOT covered by this rule, and stays listed on its own** (`src/Features/HandledState/
  CDOUnhandledServicePagesMgt.Codeunit.al`:40 remove-not 963-989):
  - In R197's order P comes AFTER F, so amendment 1's change 3 is the kind that applies.
  - In A, P (GetLogInfo_WhenMovedLogExists_ExcludesIt) is `error`: a cascade after a REFUSED earlier test
    (GetLogInfo_WhenNonRecordVariant_ReturnsZero, a `RecordRef.GetTable` refusal), so A's walk went on to F
    (GetLogInfo_WhenMultipleLogEntries_ReturnsCount).
  - In B, P fails on its own assertion ("should exclude moved log entries"), and its kill reproduces.
  - Change 3's checks:
    - **same entry: holds.** P and F are both in codeunit 68910, and one entry is one codeunit's call, so every request
      that carries the call carries both (PR-359's `serve-request-sized` names codeunit calls);
    - **keepcheck (P alone under the mutant fails twice, alone without it passes, on a fresh daemon): PENDING.** It needs
      the full instrumented DO build at the run's head. It runs as part of the next stop-groups A/B on a fresh head
      (the orchestrator, 2026-11-24).

## Amendment 4 (2026-11-25, coord PR-452, lethal-preproc): the orchestrator's ruling on R1203, which supersedes amendment 3's rule
- **The ruling (orchestrator, 2026-11-25), verbatim in substance:** an earlier-killer move (B's killer P BEFORE A's killer F
  in R197's order) is acceptable ONLY if all three hold:
  - **(i)** A's killer F carries the codeunit-state note `[v3-codeunit-state-possible]`.
  - **(ii)** B's earlier killer P, run ALONE on a FRESH daemon:
    - under the mutant, fails on its OWN assertion, twice;
    - with no mutant (NONE), passes.
  - **(iii)** The verdict is equal (both `killed`).
  - Anything else with P before F stays a BLOCK.
- **What (ii) means in practice:**
  - "Its own assertion": the failure message is the one P's own body raises. It is NOT a cascade text ("The TestPage is
    already open."), NOT a refusal (`NotRun: out-of-scope: ...`), and NOT a timeout.
  - "Twice": two separate requests, each on a fresh daemon, both fail with that kind of message.
  - "Alone": the request selects only P (the entry's `test` names P's method exactly; `runSelectedOnly`).
- **How it supersedes amendment 3:**
  - (ii) is stricter than amendment 3's item 2 (a fresh daemon per run, and P's own assertion).
  - Amendment 3's item 1 (the note names P as an earlier FAILED covering test) is kept as part of (i).
  - Amendment 3's item 4 (each move listed by mutant and site key) is kept.
- **The six checked (orchestrator: "all 5 moves plus M12932"):**
  - **M4774, M4775, M4789, M4791, M4796:** `CDOeSealServiceSetup.Page.al`; codeunit 68861 "CDO eSeal Setup UI Tests".
    Their P is EnableService_FieldsNotEditable or OpenPage_NewRecord_DefaultValuesSet, as R1203's table pairs them.
  - **M12932:** `CDOUnhandledServicePagesMgt.Codeunit.al`:40; codeunit 68910; P = GetLogInfo_WhenMovedLogExists_ExcludesIt.
    It is P AFTER F (amendment 1's kind). The orchestrator asks that its (ii) check be run too: amendment 3 left it pending.
- **Where (ii) runs:**
  - PR-411's kept-vs-fresh kit in fresh mode (a daemon per request), on `current` (edge-e5176a9fd, sha 9b0e90bd...).
  - The instrumented DO workspace is PR-190's (`/coord/handoff/PR-190/full/active`), the one c5 and PR-431 used.
  - PR-359's mutant codes map onto its manifest by the full site key (file, line, operator, start, end). A code that does
    not map is reported as unmeasured, never guessed.
  - Per mutant: [P under M], [P under NONE], [P under M]. Each is its own fresh daemon, `testIsolation` test (c5's mode).
- **Pre-committed prediction (from R1203's reading):** all six satisfy (i), (ii) and (iii).
  - (i) and (iii) are already read from PR-359's A1/B1 stores (`/coord/handoff/R1203/rows.txt`).
  - Any one that fails any of the three is a BLOCK on the flag, and is filed in R1203.
- **What follows only if all six hold** (each pre-committed in its own section before it runs):
  - the flag-on gates (PR-371's method on `current`);
  - the leg-C fact (with lethal-bugs);
  - a DO speed series with interleaved arms.
  - Turning the default on is a separate ruling.

## Amendment 5 (2026-11-25, coord PR-452): the six checked, and the flag-on gates on `current`, pre-committed
- **Amendment 4's checks: all six hold** (`/coord/handoff/PR-452/alone/RESULT.md`).
  - On edge-e5176a9fd, with PR-190's workspace, each P alone on a fresh daemon failed twice under its mutant, with the same
    message both times, and passed under NONE. None of the failures is a cascade, a refusal or a timeout.
  - The five TestPage moves have F's note naming P as an earlier FAILED covering test.
  - All six verdicts are equal (killed).
  - So R1203's BLOCK is lifted for these six.
- **The flag-on gates.** PR-371's method, repeated on `current` (edge-e5176a9fd; its `.gated` records
  `stop-groups: matches`), from ONE master commit:
  - **two runs of `itest:alrunner-v3`** (V3_TABLES, the CDO leg), each with `LETHAL_ITEST_V3_REPORT_DIR`, in sequence on
    CPUs 12-21:
    1. control: master as it is;
    2. forced: PR-371's uncommitted scratch edit, re-applied by the Edit tool. The stop is forced on where supported (flag
       not explicitly false, fact present, Sleep rule retired), the stop counts print with it, and the report is kept
       before the warning check (R1196).
  - **Judged per mutant** on the full site key, forced against control, leg by leg (PR-371's `compare.py`). The gate's own
    pass or fail is recorded, but is not the judge.
- **Predictions (a difference is a BLOCK on the flag):**
  1. Verdicts are equal in every leg.
  2. A `killingTest` moves only of amendment 1's kind (P after F, re-run alone) or amendment 4's kind (P before F, all three
     conditions). Each move is listed, and an amendment-4 kind is checked by (i)-(iii) before it counts. PR-371 saw 0 moves
     on main-bf3a3e863, so 0 is the expectation here too.
  3. No new refusal, error class, cut or close from the stop.
  4. The stop is forced ON in every session (the print). The stop counts are reported per leg.
- **Still to be pre-committed, each in its own section before it runs:** the leg-C (or session) fact with lethal-bugs, and
  the DO speed series.

## Amendment 6 (2026-11-25, coord PR-452): the leg-C fact for amendment 4's kind, and the DO speed series, pre-committed
### The fact `stop-groups-earlier-killer` (agreed with lethal-bugs: gate-only, no BC claim; lethal-preproc builds it)
- **Why this fact.** Amendment 4's kind rests on three al-runner behaviours. R1203 measured them on DO; this fact pins them
  on invented AL, so a build that changes any one of them is seen:
  - (a) A codeunit-GLOBAL `TestPage` that an earlier test leaves open (it fails before `Close()`) makes a later test of
    the same codeunit, in the same plain request, fail with "The TestPage is already open." That cascade is why the flag-off
    killer is F, and why F carries `[v3-codeunit-state-possible]`.
  - (b) In a stop-grouped request, the earlier test's failure skips the later test with PR-256's pinned stop text
    (`STOP_SKIP_TEXT`) naming the earlier test.
  - (c) The later test, run ALONE in its own request (the alone re-run), passes.
- **The probe.** Invented AL in its own id block, beside PR-342's (ids 5079x):
  - a table, a Card page on it, and a test codeunit whose `TestPage` is a codeunit GLOBAL;
  - test A opens the page and raises an `Error` before `Close()`;
  - test B opens the page, asserts a field, and closes it.
  - One fresh daemon, `testIsolation` test, three requests:
    1. plain, the whole codeunit;
    2. one stop group holding the codeunit;
    3. B alone (`runSelectedOnly`).
- **The judge:** `matches` only when (a), (b) and (c) all hold; `diverged` when any differs, or the build refuses the
  request; `unmeasurable` when there is no answer.
- **The gate rule:** GATE-ONLY, like PR-342's fact. A `diverged` never fails the gate; it prints
  `al-runner-v3-stop-groups-earlier-killer-moved`. `unmeasurable` is an infra-fail, as for every fact.
  - **It is NOT a precondition of `alRunnerV3.stopGroups` now.** The flag keeps reading `stop-groups` alone. Whether the
    default-on ruling requires this fact is that ruling's call.
- **The notes check stays in unit tests**, because it is LethAL's, not al-runner's: a unit test pins that a flag-off F
  after an earlier failed covering test P carries `[v3-codeunit-state-possible]` naming P (bugs' condition 1). Leg C
  judges raw al-runner output only.
- **Predictions:**
  - on `current` (edge-e5176a9fd) the fact reads `matches`;
  - leg C's fact count moves 52 -> 53 (24 -> 25 capability-kind), pinned with `V3_LEG_C_FACTS` in the P10 test;
  - every other fact and leg figure is unchanged;
  - red tests both ways: each of (a), (b) and (c) altered in a fake answer reads `diverged`; all three hold reads `matches`.

### The DO speed series (measure; the default is a separate ruling)
- **Four scoped DO runs on master, interleaved A, B, A, B:**
  - c5's settings (`isolation: test`) on `current`;
  - `--only` three files:
    - `src/Features/Email/Sending/CDOEMailHandler.Codeunit.al` (busy);
    - `src/Features/ESeal/CDOeSealServiceSetup.Page.al` (R1203's five);
    - `src/Features/HandledState/CDOUnhandledServicePagesMgt.Codeunit.al` (M12932);
  - `--workers 5`, CPUs 0-11, heavy-slot `--peak 22`;
  - PR-437's arm driver (LethAL's own pid; the watchdog TERMs only it);
  - a fresh store per arm;
  - A: the config as c5's; B: the same with `alRunnerV3.stopGroups: true`.
- **Judged per mutant on the full site key (any difference not named here is a BLOCK on the flag):**
  - verdicts are equal across all four arms;
  - a `killingTest` may differ between A and B only by amendment 1's kind or amendment 4's kind. Each such move is listed,
    and a P-before-F move must satisfy (i)-(iii), with (ii) run by `/coord/handoff/PR-452/alone/alone.ts`;
  - A1 must equal A2, and B1 must equal B2, per mutant (verdict and killingTest): run-to-run stability;
  - the receipts show the stop ON in B (PR-256's counts line) and OFF in A.
- **Speed:**
  - the mutants phase of each B, against the mean of the A arms beside it;
  - the fork's measurement predicts 77-80% (a 20-23% cut);
  - reported with load per arm, never as a bar: the default-on ruling reads it.

## Amendment 7 (2026-11-25, coord PR-452; the orchestrator's ruling after the spec-adversary, `/coord/handoff/PR-452/spec-review-a4-6.md`)
- **Why amendments 3 and 4's "P before F" is replaced:** it was ill-defined.
  - R1203's order was al-runner's run order inside the codeunit, not LethAL's walk. By B's walk, M4774, M4789 and M4796
    have P AFTER F.
  - M4775 and M4791 moved because R197's first sort key ("already killed in this procedure") put P first after the
    preceding mutant's kill. That is history order, not the TestPage cascade.
  - So no script could apply the old rule, and a real history-order move whose F does not name P would have been a false
    BLOCK.
- **The rule (replaces amendment 4's (i)-(iii), and amendment 1 change 3's ordering test):** a `killingTest` move between
  two runs is allowed only when ALL of these hold:
  1. **the verdict is equal** (both `killed`).
     - It is not independent evidence: when P's failure is an al-runner defect, both arms are wrong together. Only (ii)
       carries the weight.
  2. **(ii), on B's killer P, defined mechanically:**
     - P alone (`runSelectedOnly`, the entry's `test` naming P exactly), on a FRESH daemon, under the mutant, twice;
     - P is the ONLY row each time, with status `fail` (not `notRun`), matching neither `V3_TIMEOUT_MESSAGE` nor
       `STOP_SKIP_TEXT`, and the SAME message both times;
     - P alone under NONE: `pass`.
  3. **one of two forms on A's killer F, and the form is recorded per move:**
     - **(a) cascade:** F's `[v3-codeunit-state-possible]` note names P as an earlier covering test with outcome `fail` in
       the same v3 codeunit run;
     - **(b) both real:** F alone under the mutant (the same mechanical check as (ii)) also fails on a fresh daemon. Both
       are killers, and the move is only history order.
  - Anything else is a BLOCK.
- **The six (`/coord/handoff/PR-452/alone/RESULT.md`): all six allowed.**
  - **(a):** M4774, M4789, M4791 and M4796. F passes alone under the mutant, and its note names P as `fail`.
  - **(b):** M4775 and M12932. F fails alone under the mutant on its own message.
  - **(ii)** holds for all six. These checks ran on edge-e5176a9fd with PR-190's workspace: they SUPPORT the moves measured
    on main-bf3a3e863. B1's own session showed P's M/NONE/M rows on the moves' build too, on a warm daemon.
- **The three additions (ruled to keep):**
  - **The stop must actually fire.**
    - Each B arm of the series, and each forced gate leg with a multi-test entry and a kill, must show `skipped > 0` and
      `reruns > 0` in PR-256's counts line.
    - `heldForRed` is reported against the mutant requests sent.
    - A leg or arm with `skipped == 0` reads "not exercised", never "pass".
  - **The (ii)/(b) kit is bound to each arm's own build:**
    - its workspace (the arm's `active/`), binary and mutant ids are passed as arguments;
    - each mutant's `mutatedText` in the arm's report is checked against the workspace manifest before sending;
    - any mismatch stops the kit.
  - **The fact is required:** in the series, a move of form (a) counts only when the gate record of the arm's build reads
    `stop-groups-earlier-killer: matches`. Form (b) does not depend on the cascade.
- **Amendment 5's flag-on gates are judged by this rule.** Prediction 4 reads "the stop forced ON (the print) AND, per leg
  with a multi-test entry and a kill, `skipped > 0`".

## Amendment 8 (2026-11-26, coord PR-459, lethal-preproc): a speed A/B with concurrent arms on disjoint cores, pre-committed
- **Why:** PR-452's sequential series was confounded. Both B arms ran at about twice the box load of the A arms. Here A and B
  run AT THE SAME TIME on disjoint, equal core sets, then swap sets, so both arms of a pair see the same outside load and
  each set is used once by each kind.
- **The runs:**
  - two pairs, from ONE master commit (a clean scratch worktree; its sha is recorded);
  - `current` (edge-e5176a9fd), c5's settings (`isolation: test`), PR-452's three `--only` files (1121 mutants);
  - **pair 1:** A on CPUs 0-5, B on CPUs 6-11, started together;
  - **pair 2:** A on CPUs 6-11, B on CPUs 0-5, started together;
  - each arm `--workers 3` (6 cores each), a fresh store, and its OWN copy of the warm al-runner cache (no shared cache
    writes);
  - A: stopGroups unset (off); B: `alRunnerV3.stopGroups: true`;
  - each pair under ONE heavy-slot admission (`--peak 24`: two arms that peaked at about 10 GiB each at 5 workers);
  - each arm's own LethAL pid; a watchdog TERMs only that pid.
- **Correctness (any difference is a BLOCK on the flag):**
  - verdicts equal across all four arms;
  - killingTest: A = A and B = B across the pairs;
  - each A-B move is checked by amendment 7 with the arm's own build. A form-(a) move counts only once `current`'s gate
    record reads `stop-groups-earlier-killer: matches` (the re-gate after PR-452 lands);
  - the stop fired in each B (`skipped > 0`, `reruns > 0`) and is absent from each A.
- **The speed read, per pair:** B/A = B's mutants phase divided by A's, the two arms of the same pair only.
- **The claim rule (pre-committed):**
  - **"stop groups make the run faster"** only when B/A < 0.90 in BOTH pairs;
  - **"stop groups make the run slower"** only when B/A > 1.10 in BOTH pairs;
  - **otherwise "no speed effect shown"** (inconclusive).
  - Load is recorded per arm, but the pairing is the control. No pair is re-run toward the bar.

