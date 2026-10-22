# R-635 plan r3: a serve + entries transport for the al-runner v3 backend

Status: plan only. Nothing is built or committed. r3 changes r2 only where `adversary-r2.md` asked (§B). r2
answered `adversary-r1.md` (8 items) and folded in the item-7 probe (`/coord/handoff/R-635/measure.md` §8) and
the compile-set probe (§9). §A maps each r1 finding to its fix; the sections after §B are the full plan.

## B. Delta review r2, finding by finding (the only changes from r2)

| # | Finding | r3 answer | Where |
|---|---|---|---|
| N1 | On `--resume` with a reused snapshot the baseline loop runs over `[]`, so the warm-up compares empty with empty | Refuse BY NAME (`al-runner-v3-entries-no-baseline-rows`) when any codeunit of the warm-up union has no baseline rows recorded by the backend. No empty-against-empty compare. Test 18 | §3 |
| N2 | What `warmup-disagrees` does to the batch when a daemon restarts mid-batch | The request that caused the restart is a `transportFailure`, never a pass. The session STOPS; verdicts already scored stand | §3, §6 |
| N3 | An install-time resource read is named `warmup-disagrees` | The batch-refused check runs on the warm-up answer FIRST, so it is named `al-runner-v3-entries-batch-refused` with its reason | §3, §6 |
| N4 | `cached:false` from rejected requests is not counted | Counted from every answer whose `summary` line was read, before the decoder accepts or rejects it | §3 |
| r1-2 | The scored entry's own read is not proven by the echo | Stated: it rests on measure.md §2's per-entry measurement | §3 |
| Q1 | Where the baseline bracket goes | A `finally` around `scoreBatch`'s baseline step, from `activateOnce(null)` through the `dispatchUnmutated` loop | §4 |
| Q2 | Is §5's echo enough? | Yes. An echo before step 2 is added as well, so the coverage read is bracketed | §5 |
| Proj. | Per-request range not measured on CDO; baseline compile left out | Both stated; the one-shot baseline's compile is in the estimate | §11 |
Evidence: `/coord/handoff/R-635/measure.md`, `edge.md`, `upstream.md`. Roadmap: `docs/roadmap/R635.md`, `R612.md`.

## A. Review r1, finding by finding

| # | Finding | r2 answer | Where |
|---|---|---|---|
| 1 | The confirm reads `NONE` from disk; the kill and reproduction go through the override path | The confirm is an ENTRY with an explicit override `{"active-mutant.txt":"NONE"}` plus an echo that expects `NONE`. Kill, confirm and reproduction all run the same way: entry + override + echo | §4, §8 |
| 2 | The echo is not tied to the entries it vouches for | The encoder THROWS unless every mutant in a request has exactly one echo in that same request (256-entry chunking and the §7 tail re-send included). The decoder attributes rows from the table of sent entries, and asserts each entry's id prefix equals its override text | §3, §4, §6, §7 |
| 3 | `CurrentId` breaks R222 selector parity | Dropped. The echo reads the resource itself and calls `Active(t)`, then errors `LETHAL-ECHO:%1:%2`. No new selector procedure, no edit under `packages/schemata`, v2's selector bytes unchanged, R222's parity test stays green | §2 |
| 4 | `lastActivated === null` is not "baseline" (confirm, Decision 11) | An explicit baseline-pass flag, set by the orchestrator around its baseline step. Tests for the confirm and Decision-11 null calls (coverage on: no throw; `baselineRefused` untouched) | §4, §9 tests 8, 14 |
| 5 | The §5 row check cannot fail for passes | Added an echo to §5's window, AND its basis is stated plainly | §5 |
| 6 | Wall-time projection ignores `cached:false` on codeunit-set switches | A union warm-up request per daemon; pre-committed `cached:false` count = daemons started; projection redone at about 6.5 s per extra compile | §3, §10, §11 |
| 7 | Measure CDO's install read before building | Done (§8 of measure.md): no install read, 0 refusals, 0 of 63 differences against bc3-A. Still: a refusal of the WHOLE batch on a reason outside `V3_SERVE_SAFE_REFUSALS` refuses by name and never re-sends | §6, §7 |
| 8 | Codeunit selection is a case-insensitive substring match | Named as a limitation; the decoder's per-entry codeunit check is the guard | §3 |

## 0. Base, build, scope

- Branch `lethal/r635` (worktree `/work/lethal-wt/r635`) is merged with master 88a16a50, so R612's keep rule
  (`serveDaemonReusable`, `V3_SERVE_SAFE_REFUSALS`) is in. CLAUDE.md re-read after the merge.
- Build under development and in every live leg: the edge build BY PATH AND SHA256,
  `/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner`,
  sha256 `0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720`,
  `al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)` (carries #5676, into which #5671 was folded). It is not
  gated, so it runs only under `LETHAL_ALRUNNER_V3_CANDIDATE=1`; `.gated` and `current` are untouched.
  - `AL_RUNNER_V3_VERSION` must accept the `+edge.20261022` build part. One unit test per direction: accepts the
    edge line; still refuses a v2 line and a line without the sha. (Review r1 checked: `checkGated` still pins
    version and sha256 unless the candidate flag is set, so this admits no ungated build by default.)
- Out of scope: v2 (`AlRunnerBackend`) behaviour unchanged; the default v3 path (one-shot, static selector)
  byte-identical; no `SessionReport` field (the transport and its counters go in `status().details` and a session
  warning line: no schema ripple); the update gate's leg set unchanged.

## 1. The option (default unchanged)

- `lethal.config.json` `alRunnerV3.transport`: `"one-shot"` (default, today's backend) or `"serve-entries"`. Added
  to `KEYS` in `al-runner-v3-config.ts`; any other value refused by name. `selectorMode` stays refused: the
  transport picks the selector (static for one-shot, resource for serve-entries).
- `AlRunnerV3Config.transport?: "one-shot" | "serve-entries"`. All new behaviour is behind
  `transport === "serve-entries"`. Test 1 pins that one-shot's argv, staging and selector bytes do not change
  when the field is absent.

## 2. Deploy in serve-entries mode: the resource selector and the echo

- `stage()` installs the resource selector exactly as v2's `installResourceSelector` does (the code moves to a
  shared helper; v2's output bytes do not change, pinned by v2's existing tests): `resourceFolders +=
  LethALResources`, `active-mutant.txt` = `NONE`, `MutationSelector.Codeunit.al` = `emitResourceSelector(...)`.
  R583's `assertResourceSelectorRuntime` runs on `active/app.json`.
- The echo: a test codeunit in `active/`, object id = the manifest's `selectorIds.controlId` (the register install
  codeunit's id, whose file v3 staging already drops), `Subtype = Test`, one `[Test] procedure Echo()`:
  ```al
  t := NavApp.GetResourceAsText('active-mutant.txt', TextEncoding::UTF8);
  if "Mutation Selector".Active(t) then r := 'true' else r := 'false';
  Error('LETHAL-ECHO:%1:%2', t, r);
  ```
  (`r` is set explicitly, so no Boolean formatting is involved.) It proves two things per request: which text the
  entry's override gave (`%1`), and that the selector's cached SingleInstance read agrees with it (`%2`).
  The emitter lives in the v3 backend module (its only user), not in `packages/schemata`: the selector emitters
  and R222's parity test are untouched (review r1 item 3).
- alc proves the whole staged batch (selector, echo, resource folder) as today. The coverage index treats the echo
  file as a control file (the `control` set in `coverageOf`).
- `assertBound()` in this mode also checks: the selector text is the resource selector for this artifact; the echo
  text is the emitted one; `active-mutant.txt` on disk is exactly `NONE` (except inside the §5 window).

## 3. The daemon, the encoder and the decoder

- `AlRunnerServer` with subcommand `"serve"` (exists), started lazily, argv `serve --test-timeout S
  --package-cache <deps> --bc-version <v> --no-download --define ...`, env `ALRUNNER_CACHE`.
- `S` comes from `useMutantBudgetFloor` exactly as v2 `--server` (R517): `S = max(1, ceil(max(floor, baseline)/1000))`;
  a daemon start before it throws (the v3 twin of `AlRunnerServerStopUnsetError`). In this mode the backend
  reports `inRunStopIsBudget = false` and `inRunStopMs = S * 1000`; `v3RowVerdict` gets `callStopSeconds = S`.
  One-shot is unchanged.
- **Union warm-up (review r1 item 6).** The first request on every daemon is one entries request with one
  `NONE`-override entry per covering codeunit of the batch, plus one `NONE|echo` entry. Upstream compiles the union
  of a request's selections once; every later request selects a subset and is `cached:true` (measure.md §9).
  The warm-up answer is checked in this order:
  1. **No baseline rows (N1).** Before sending: every codeunit of the union must have baseline rows recorded by
     this backend's one-shot baseline pass for this batch. If any has none (for example `--resume` reused the
     baseline snapshot, so the loop in `scoreBatch` ran over `[]`), refuse by name
     `al-runner-v3-entries-no-baseline-rows`, naming the codeunits. Never compare empty with empty.
  2. **Batch refused (N3).** If every entry's rows are `notRun` with one reason outside `V3_SERVE_SAFE_REFUSALS`
     (an install-time resource read refuses every override entry), refuse `al-runner-v3-entries-batch-refused`
     with that reason (§6).
  3. **Disagrees.** Its rows must equal the one-shot baseline's rows for those codeunits (status, notRun, message
     class), and its echo must read `LETHAL-ECHO:NONE:true`; otherwise `al-runner-v3-entries-warmup-disagrees`.
  - **On the first daemon of a batch** (inside `prefetchMutants`, before any mutant is scored) each of these
    refuses the batch and the session stops.
  - **On a restarted daemon mid-batch (N2)** (after an R612 split, or lazily for a live confirm or reproduction):
    the request that caused the restart is a `transportFailure` (`pre-dispatch-rejected`), never a pass, and the
    session STOPS. Verdicts already scored stand. Unscored mutants are not given `error`. The reason: a warm-up
    that disagrees with its own batch's baseline means the daemon's view of that batch moved, so no later entry
    on any daemon is trustworthy, and an `error` per mutant would hide one cause behind many rows. Stopping also
    matches how one-shot treats a failed retry.
  - **`cached:false` (N4)** is counted from every answer whose `summary` line was read, before the decoder accepts
    or rejects the request, so a rejected request's compile is counted too. The backend reports `cached:false` and
    daemons started in `status().details`.
- Closed at `deploy()`, at `close()`, after any request error or partial answer, and by R612's rule (§7). A closed
  daemon is restarted lazily, with its own warm-up.
- F4: a new `AlRunnerServer.runEntries(body, deadlineMs)` returns the raw lines grouped as
  `{ tests: (line + entry)[], entrySummaries[], summary }` and THROWS a typed `AlRunnerServerRequestError` on an
  untyped `{"error": ...}` line (today's `runTests` reads on until the deadline). v2's `runTests` unchanged.
- **The encoder** builds a request from a list of mutant GROUPS. A group is one mutant id `M` (or `NONE`), its echo
  entry FIRST, then one entry per covering codeunit. Ids: `M|echo`, `M|<codeunitId>`. Every entry of the group has
  `resources: {"active-mutant.txt": M}`, including `NONE` (explicit, never absent). It THROWS (caller-contract
  violation, session stops) when:
  - a `test` is not a string (an array is silently ignored upstream, #5702), or an `excludeTests` is not a list;
  - two entries share an id (upstream accepts duplicates, #5703);
  - an entry's id prefix (before `|`) is not its override text;
  - a mutant appears in the request without exactly one echo entry, or with entries in another group of the same
    request (review r1 item 2).
  Chunking at 256 entries cuts only between groups, so a group is never split across requests; a single group
  larger than 256 is sent alone (256 is our cap, not upstream's).
- **The decoder** never trusts the answer's own grouping. It holds the table of sent entries (position, id,
  mutant, codeunit or echo) and requires: `entrySummary` ids equal the sent ids in sent order; every test line's
  `entry` is a sent id; each entry's rows all belong to that entry's sent codeunit (the echo entry: exactly one row,
  of the echo codeunit); each `entrySummary`'s counts equal its rows; the `summary` equals the sums. Any miss
  invalidates the whole request (§6).
- **What the echo does not prove (r1 item 2, stated).** The echo proves the override text in ITS OWN entry of the
  same request. That each scored entry read its own override rests on measure.md §2's per-entry measurement: in one
  request, each entry read its own text (`M1`, `M2`, `M3`, `NONE`), and the SingleInstance cache did not leak
  between entries.
- **Limitation (review r1 item 8), named.** Upstream selects by a case-insensitive SUBSTRING match of the `test`
  pattern. LethAL sends `Codeunit<id>.`. With the fixed `Codeunit` prefix and the trailing dot, and v3's
  `Codeunit<n>.<method>` row name (a method name has no dot), the review's example (`Codeunit5.` against
  `Codeunit105.`) does not match in our reading. But upstream does not document the matching beyond "substring",
  so the plan does not rely on that reading: a row of another codeunit inside an entry invalidates the request
  (above), so a collision is never scored. Re-check when #5702 is fixed, since selection may change with it.

## 4. Where entries are used

- New optional seam `ExecutionBackend.baselinePhase?(on: boolean): void` (review r1 item 4; Q1). In `scoreBatch`
  the orchestrator calls `baselinePhase(true)` right before the baseline step's `activateOnce(..., null)` and
  `baselinePhase(false)` in a `finally` after the `dispatchUnmutated` baseline loop (also when a `--resume` snapshot
  stands in for the baseline and the loop runs over `[]`; N1 then refuses at the warm-up). No other null call sits
  inside that bracket, and workers are refused for v3 (`cli.ts`), so no worker backend misses it. Other backends do
  not implement it, so nothing else changes.
- In serve-entries mode the v3 backend keeps `inBaseline` from that seam ONLY. Coverage reading (`coverageOf`) and
  `baselineRefused` are gated on `inBaseline`, never on `lastActivated === null`. So the orchestrator's kill
  confirm (`confirmWarm` and the cold confirm), and Decision 11's rerun, are null activations OUTSIDE the
  baseline: they read no coverage (no "unavailable" throw) and add nothing to `baselineRefused` (no wrong
  "refused by v3 at baseline" survivor note). One-shot mode keeps today's `lastActivated === null` logic
  byte-for-byte (test 1).
- New optional `ExecutionBackend.prefetchMutants?(plans: readonly { mutantId: string; refs: readonly TestMethodRef[] }[]): Promise<void>`.
  The orchestrator calls it once at the top of the mutant loop, with every covered mutant of that shard and its
  covering refs, after `useSessionTests`. The backend sends the warm-up (§3), then the mutant groups in chunks,
  deadline `v3CallDeadlineMs(S, tests in the chunk)`. Only a fully valid answer is stored, as
  `prefetched: Map<mutantId, Map<codeunitId, CallRows>>` with that group's echo result.
- `activate(m)`: clears the rows FIRST (C2); then, if `prefetched` has `m`, MOVES those rows into `rowsByCodeunit`
  and deletes them (consumed once). A re-activation (the R577 reproduction) finds nothing and runs live.
- `run(ref)` without cached rows:
  - `inBaseline` true: today's ONE-SHOT call (coverage, Sleep index, `baselineRefused` unchanged). The one-shot
    reads the resource selector, whose file says `NONE`. A mutant activated while `inBaseline` throws.
  - otherwise (an unprefetched mutant, the unmutated confirm, Decision 11, the reproduction): a LIVE request with
    ONE group: the echo and the codeunit's entry, override = `lastActivated ?? "NONE"` (review r1 item 1). The
    confirm therefore runs exactly as the kill did: entry, override, echo.
- `deploy()` and `resetLayoutState()` drop `prefetched` (R349).

## 5. Coverage and Sleep (§6 of R586) under entries

- Coverage for selection stays the one-shot baseline pass (§4). Entries never carry coverage (upstream error).
- R586 §6 needs a covering PASS under a mutant checked on that call's raw coverage. Empty Sleep index: nothing
  changes. Non-empty (CDO: 3 target lines): every `pass` row under a mutant from an entries answer is confirmed in
  ONE window on the same daemon, per (mutant, codeunit):
  1. write `active-mutant.txt` = the mutant id;
  2. a plain request `test: "Codeunit<echo>."`: its one row must be `LETHAL-ECHO:<mutantId>:true` (Q2, optional
     bracket, adopted);
  3. a plain request `test: "Codeunit<cu>."`, `coverage` + `perTestCoverage`;
  4. a plain request `test: "Codeunit<echo>."`: again `LETHAL-ECHO:<mutantId>:true`;
  5. restore `NONE` in a `finally`.
  Step 3's rows must equal the entry's rows for that codeunit (status and notRun, per method), else every row of
  that call is `error` (`entries-coverage-disagreement`). A wrong echo in step 2 or 4 makes the same rows `error`
  (`entries-echo-mismatch`). Then §6 (`sleepJoinRefusal`, `blindNote`, `sleepPassRefusal`) runs on step 3's
  coverage as on a one-shot call.
- **Its basis, stated plainly (review r1 item 5; Q2).** The row comparison cannot fail for passes (a pass under the
  mutant and a pass under NONE look alike). Steps 2 and 4 prove the daemon read the mutant's text from the file
  just before and just after step 3. They bracket step 3's read but do not observe it. That rests on upstream's
  documented per-request resource read (#5671) and the measurements that the file is re-read per request (R-606,
  measure.md §2 and §9). If step 3's read were wrong, the worst case is a missed §6 refusal, which leaves a pass,
  never a kill. All three requests are subsets of the union, so all are `cached:true`.

## 6. Failure modes: each refuses or scores `error`, never a kill or a survive

| Case | Detection | Outcome |
|---|---|---|
| request error (`{"error"}`: unknown resource, coverage with entries, bad field) | `AlRunnerServerRequestError` | daemon closed; nothing of the request cached; a prefetch failure leaves its mutants to live requests; a live failure is `transportFailure` (`pre-dispatch-rejected`, retried once, then the session stops, as one-shot) |
| partial answer (EOF, deadline, no `summary`, fewer `entrySummary` than sent) | decoder | as a request error; a deadline is `deadline-exceeded` for the live ref |
| answer for an id not sent, summary order != sent order, a row of another codeunit in an entry, a duplicate `(entry, name)` row | decoder (sent-entries table) | whole request invalid, as a request error |
| per-entry or request counts disagree with the rows (higher or lower) | decoder | whole request invalid |
| an entry selected nothing (total 0, no upstream error, #5704) or lacks a suite test's row | "exactly one row per suite test", per entry | `rowMissing`: `error` under a mutant, never a survive; session stop outside a mutant |
| WRONG OVERRIDE: the group's echo is missing, `pass`, `notRun`, or its message is not exactly `LETHAL-ECHO:<M>:true` | decoder, exact string match | every row of that group is `error` (`runner-test-error`, note `entries-echo-mismatch`), never cached as a verdict |
| a group without its echo, a duplicate id, an id prefix != override | encoder throws before sending | caller-contract error, session stops |
| the WHOLE request refused for one reason outside `V3_SERVE_SAFE_REFUSALS` (for example the install baseline read the resource: every override entry `notRun` with that reason) | decoder: every entry's rows are `notRun` with the same unlisted reason; checked on the warm-up answer FIRST (N3) | `al-runner-v3-entries-batch-refused` names the reason; the batch stops; NOTHING is re-sent (review r1 item 7). Measured absent on the CDO slice (measure.md §8) |
| a codeunit of the warm-up union has no baseline rows recorded by the backend (`--resume` reused the baseline) | before the warm-up is sent (N1) | `al-runner-v3-entries-no-baseline-rows`, the session stops |
| the warm-up disagrees with the baseline | warm-up check (§3) | first daemon: the session stops before any mutant is scored. A restarted daemon mid-batch (N2): the request that caused the restart is a `transportFailure`, never a pass; the session stops; scored verdicts stand |
| `notRun` with pass/fail, non-boolean `notRun`, a timeout naming another stop than `S` | existing `v3RowVerdict` and server checks | `error` |

## 7. R612's keep rule on entry answers

- `serveDaemonReusable(rows, "v3")` applied per entry IN ENTRY ORDER. At the first entry the rule does not keep (a
  timeout, a panic, an unlisted refusal), the entries before it and that entry stand (scored as one-shot would
  score them: a timeout is `timeout`, a panic refusal `error`); the daemon is closed.
- The entries after it are re-sent on a fresh daemon (with its warm-up), as GROUPS through the encoder, so every
  re-sent mutant carries its own echo again. Because the echo is first in its group, an entry that stands always
  had its group's echo before it in the same request. If the unkept entry is an echo, its whole group is re-sent.
- No loop: a re-sent group that hits an unkept row again stands on its own rows (scored, not re-sent), and the
  batch-level refusal in §6 never re-sends. Re-sends are bounded by the number of groups.
- R612's duplicate-name throw applies per entry. Commit `notRun` rows (#5607) are kept (407 table entries ran on 1
  daemon, measure.md §6).

## 8. R577 (a kill must reproduce)

- `killsMustReproduce` stays true. Kill: a prefetched (or live) entry with override `M`. Confirm: a live one-group
  request with override `NONE` and its echo. Reproduction: re-activation finds no prefetched rows (consumed), so a
  new live one-group request with override `M` and its echo, at the same `S`. All three run the same way (review r1
  item 1). Each request starts from the post-install database (`M1again`, `entries-repeat`).

## 9. Tests, written first, each red-checked per direction (`mutation-red-checker`; Edit tool only)

Unit, `packages/runner/src/al-runner-v3-entries.test.ts`, scripted fake `ServerSpawnFn` and fake one-shot spawn,
call counters, no wall clock:
1. Default: no `transport` -> argv, staged files and selector bytes as today; `prefetchMutants` and
   `baselinePhase` change nothing. Red: default to `serve-entries`.
2. Config: both values accepted, others refused; `selectorMode` still refused. Red each way.
3. Version regex: accepts the edge line, refuses v2 and sha-less lines. Red per direction.
4. Encoder throws on: a `test` array; a duplicate id; an id prefix != override; a mutant without its echo; a
   mutant with two echoes; a group split across two chunks (257 entries); a re-sent tail without an echo. Red: drop
   each throw, one at a time.
5. Decoder, one test per row of §6's table, each asserting `error` (never pass/fail/timeout) and nothing cached;
   counts in both directions. Red: remove that one check.
6. Echo: exact `LETHAL-ECHO:M1:true` stands; `M10`, `M1:false`, missing, `pass`, `notRun` -> `error`. Red: skip
   the check; red: prefix match.
7. Selector parity: `packages/schemata` has no diff; R222's test runs unchanged; v2's staged selector bytes equal
   a fixed expected text. Red: add a procedure to the resource selector.
8. Baseline flag: `inBaseline` true -> one-shot call with coverage; a null activation with the flag false -> a
   live NONE group. Red: use `lastActivated === null` (test 14 goes red); red: always one-shot.
9. Prefetch consumption: first activation uses prefetched rows (no live request); re-activation sends one. Red: do
   not delete on consume.
10. R612 split: an unkept entry mid-request -> earlier entries and it stand, later groups re-sent with echoes on
    a NEW daemon (spawn counter 2, warm-up counter 2); all-kept -> 1 daemon. Red: keep after unsafe; red: drop the
    unsafe entry itself; red: re-send without the echo (encoder throws).
11. Batch-level refusal: every entry `notRun` with one unlisted reason -> `al-runner-v3-entries-batch-refused`,
    spawn counter 1, no re-send. Red: treat it as an R612 split (spawn counter grows).
12. Stop: `inRunStopIsBudget` false and `inRunStopMs = S*1000` in serve-entries, unchanged in one-shot; a daemon
    start before `useMutantBudgetFloor` throws. Red each.
13. §5: non-empty Sleep index -> per passing (mutant, codeunit): echo, coverage request, echo, file `NONE`
    afterwards (also when a request throws); disagreeing rows -> `error`; a wrong echo before OR after -> `error`;
    empty index -> no window. Red: skip the restore; skip the row comparison; skip each echo; always/never open the
    window.
14. Orchestrator, stateful fake backend, coverage on: `baselinePhase(true)` then `(false)` exactly once per batch,
    bracketing the baseline calls (call counters); the kill confirm and the Decision-11 rerun run with the flag
    false; on the v3 backend neither throws "coverage unavailable" and `survivorNote` gains no entry from confirm
    rows. Red: gate coverage on `lastActivated === null`.
15. Orchestrator: `prefetchMutants` once per mutant-loop call, with exactly the covered mutants and their refs.
    Red: call it per mutant; red: include an uncovered mutant.
16. F4: a `{"error"}` line ends `runEntries` at once with `AlRunnerServerRequestError` (deadline 1 h; the test
    finishes by a counter, not wall time). Red: revert to "skip untyped lines".
17. Warm-up: the first request on each daemon selects the union; its rows equal the one-shot baseline or the batch
    refuses (`al-runner-v3-entries-warmup-disagrees`). Red: skip the warm-up (the fake counts `cached:false` 2+).
18. N1: the baseline step ran over `[]` (a resumed snapshot), so the backend holds no baseline rows for a union
    codeunit -> `al-runner-v3-entries-no-baseline-rows` naming it, and no warm-up request is sent (request counter
    0). Also: one of two union codeunits missing -> refused. Red: compare whatever rows exist (empty equals empty
    passes).
19. N2: a daemon restarted mid-batch (an R612 split; separately, a lazy restart for a live confirm) whose warm-up
    disagrees -> the causing request is a `transportFailure`, the session stops, the verdicts scored before it are
    unchanged in the store. Red: score the causing ref from the restarted daemon's rows; red: rewrite scored
    verdicts.
20. N3: a warm-up where every entry is `notRun` with one unlisted reason -> `batch-refused` naming the reason, not
    `warmup-disagrees`. Red: swap the check order.
21. N4: a request whose answer the decoder rejects but whose `summary` says `cached:false` -> the counter grows by
    one. Red: count only accepted answers.

## 10. Pre-commitment (committed by the lane to master [skip ci] BEFORE any live run; sha sent)

File: `docs/superpowers/specs/2026-10-2x-r635-entries-precommitment.md`. A new env-gated itest
`itest:alrunner-v3-entries` (`LETHAL_ITEST_ALRUNNER_V3_ENTRIES=1`), separate from the update gate so its leg set
does not move. No BC call, no lease. No new frozen baseline file (no R332 record).

- **Build.** Every leg runs `/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner`, sha256
  `0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720`, under `LETHAL_ALRUNNER_V3_CANDIDATE=1`. The
  first line prints path, version and sha256; the leg refuses a binary whose sha256 differs.
- **Shape.** Each leg runs twice on that build, ONE-SHOT then SERVE-ENTRIES, fresh store each, never `--resume`,
  one worker. Entries verdicts must equal one-shot verdicts per mutant. Any difference is a BLOCK.
- **E-S, `fixtures/sandbox-app`**, per mutant against `packages/runner/itest/bcdev.baseline.json`: 3 killed / 12
  survived / 4 no-coverage, M0001-M0003 killed by `OverBudgetDetected`. Entries leg: kills reproduced 3/3, echo
  mismatches 0, errors 0, daemons 1, `cached:false` 1.
- **E-T, the table fixture `fixtures/sandbox-data`**, per mutant against the v3 tables record
  `packages/runner/itest/al-runner-v3.tables.baseline.json` (290 / 57 / 59 over 406; it already differs from
  `tables.baseline.json` by the 52 `TABLES_KNOWN_DIFFERENCES`): verdict, killing test and notes equal. If the edge
  one-shot leg itself differs from that alpha.2 record, that is a finding about edge; an addendum pre-names those
  moves before the entries leg is read (the entries leg never compares to a figure its one-shot leg did not
  reproduce). Daemons = 1 + the number of entries R612 does not keep; `cached:false` = daemons.
- **E-D, the CDO slice** (D1's slice and guard: 5f2a71d, fingerprint `aa47c61c1fcbb7e3`, `CDO_SLICE_SHA256`,
  `CDO_ALPACKAGES`, checkout `/work/lethal-wt/cdo-r396`), per mutant against
  `docs/measurements/r594/bc3-A.report.json`: 0 differences, 51 / 12 / 0, kills reproduced 51/51, Sleep index 3 +
  0, §6 refusals 0, echo mismatches 0, batch refusals 0, daemons 1, `cached:false` exactly 1. The §8 probe already
  read 0 of 63 differences and no refusal on this slice.
- **Killing tests.** Equal per mutant, entries against one-shot. Note (orchestrator, 2026-10-22): every entry
  selects one codeunit and v3 runs it whole, so the 25 ms per-entry table figure ran EVERY test of the codeunit
  (#5702 also ignores a `test` array). The killing-test equality must be re-checked when upstream fixes `test`,
  because selection may move with that fix.
- **Reported per leg** (not pass/fail figures): session wall time, daemons, requests (warm-up, prefetch, live
  confirm, live reproduction, §5 coverage, §5 echo), `cached` true/false, entries per request.

## 11. Wall time: the headline

**Headline: E-D's serve-entries session wall time, against bcdev's 53-80 s (R635.md) and one-shot's 378 s (D1 on
alpha.2, `/coord/handoff/R-586/gate/final/D1.log`).** The E-D one-shot leg on edge is reported beside it.

Projection, NOT pre-committed (redone for review r1 item 6):
- fixed, as D1: the alc proof and ONE one-shot baseline call (one test codeunit, 68933, 21 tests). That call
  compiles from cold, as every one-shot call does: at least the about 6.5 s CDO compile (R-586) plus its dependency
  load. It is now IN the estimate, at about 7-20 s, not measured separately for this plan;
- daemon cold start + union compile: 18.4 s (measured, §8 probe's warm-up);
- prefetch, 63 groups of 2 entries (echo + 68933): about 1.1-2 s (§8: 64 entries in 1.1 s, `cached:true`);
- live requests, `cached:true` (subsets of the union, §9): 51 confirms + 51 reproductions = 102;
- §5 windows, Sleep index non-empty: up to 3 requests per (mutant, codeunit) with a pass consulted (echo,
  coverage, echo), at most 63 x 3 = 189.
- At 0.05-0.3 s per warm one-codeunit request: about 15-87 s for the 291 live requests. That range was measured
  on sandbox-app and the table fixture, NOT on CDO; CDO's single-request cost is unmeasured (upstream says
  0.2-2 s), so the upper end may be higher.
- Total: 15-87 s + 18.4 s + 1-2 s + the one-shot baseline's 7-20 s, so roughly 41-127 s plus the alc proof.
  Inside or near bcdev's 53-80 s only at the low end.
- Without the warm-up, each switch between the 2-codeunit set (echo + 68933) and the 1-codeunit set (§5 step 2)
  could recompile at about 6.5 s: 100+ switches would cost minutes. That is why `cached:false` = 1 is
  pre-committed; any extra `cached:false` is reported with its count, never hidden.
- If E-D misses bcdev, the next step (its own pre-commitment, not in r2) prefetches the confirm (`NONE` group) and
  a second override group per killing mutant in the same chunk, so confirm and reproduction are prefetched too,
  and batches §5's windows per chunk.

## 12. Upstream gaps and their LethAL guards (posted, `upstream.md`)

- #5702, a `test` array is silently ignored, so every test runs: the encoder throws on a non-string `test`; and
  since v3 may run more than the selected tests, the decoder takes LethAL's own rows from the full answer per
  suite test and refuses a missing one (`rowMissing`), and refuses rows of another codeunit.
- #5703, duplicate entry ids accepted: the encoder throws on a duplicate id; the decoder matches by the sent table.
- #5704, an entry that selects nothing answers total 0 with no warning: per entry, "exactly one row per suite test"
  makes it `error`, never a survive.

## 13. Open questions

None. r2's two (the bracket's place, §5's echo) were answered by delta review r2 (Q1, Q2) and are folded into §4
and §5.
