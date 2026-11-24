# PR-410 pre-commitment (R1204): skip a carry walk a baseline-flagged pass dooms, stop one early, and say why a walk closes the daemon

**Source:** R1204, from PR-409's findings (`/coord/handoff/PR-409/findings.md`). On c4 (full DO, b1a0e6717,
main-bf3a3e863):
- All 129 PR-340 carry walks failed at request 1 on a pass al-runner flags. PR-340's B1 leftover rule makes such a pass
  "no sound pass".
- They made 0 kills and cost 12,197 s.
- 115 of them then closed the lane's daemon (`unkept-row`), and each close was followed by a full-DO warm-up (6,407 s).
- Together that is about 33% of the 56,873 s of lane time.

The orchestrator chose (B) plus (A) below, 2026-11-24.

## The premise, measured offline on c4 (`/coord/handoff/PR-410/premise.py`)
- In all 129 failed walks, the test that failed the walk was flagged in c4's own baseline (`flagged: true`, outcome pass).
- It was always in the walk's FIRST kept codeunit (position 0 in the ascending order the walk sends), in 129 of 129.
- The rule below (the first kept codeunit's FIRST baseline row is a pass with `flagged: true`) fires on all 129, and all
  129 walks failed on exactly that test.
- Walks covered 2 to 109 codeunits each.

## What is built

### (B) The skip, before anything is sent
In `carryWalkSend`, after today's checks (carry-proven, serve-entries, baseline rows, one isolation mode) and before the
first request, the walk is SKIPPED when all of the following hold:
1. The FIRST row of the first kept codeunit's baseline rows (`baselineRows.get(kept[0])[0]`, rows in run order) is a pass
   with `flagged === true`.
   - **`flagged === true` counts even when `flaggedUnknown` is also set.** The baseline daemon paths set `flaggedUnknown`
     on every daemon row, and a row al-runner flagged keeps `flagged: true` beside it (delta review).
   - `flaggedUnknown` WITHOUT `flagged: true` does not count, because unknown is not flagged.
   - It must be the first row (review SERIOUS 2). The walk runs in one session under `AL_STRICT_SEQUENTIAL` and
     `strictOrder`, where state carries (PR-340 step 0). So only kept[0]'s first test runs with no earlier covering
     test's state before it, as at baseline.
   - On c4 this rule fires on all 129 walks, and all 129 failed on exactly that test (`premise.py`).
2. Those rows were recorded under the same request mode AND the same transport the walk uses. `noteBaselineRows` now
   records each key's `modeKey(modeOfCall(key))` and whether the rows came from a serve daemon or a one-shot call. The
   skip needs the mode equal to the walk's `modeKey(mode)`, and the transport to be the daemon.
   - So a codeunit that R896's isolation-auto moved to method mode after its baseline is never skipped on the old mode's
     flags.
   - Nor is an R937 one-shot codeunit (review SERIOUS 3). A one-shot row's `flagged` is al-runner's own, while the
     walk's serve rows carry `flagged` only if the daemon writes it, so a one-shot flag does not say what the walk will
     see.
3. The first kept codeunit is not run per test (`perTest(kept[0])` false, no `--isolate-tests`). A per-test codeunit has
   no codeunit-keyed rows, so it is never skipped.
4. The skip is not turned off (`LETHAL_V3_CARRY_SKIP=off`, below).

**What the skip returns:** a skipped walk returns
`failed("skipped before request 1: <name> passed flagged at baseline, so the walk's requests would hold no sound pass (PR-410)")`.
`<name>` is that first row (`V3Row.name`, as `CodeunitN.Method`).
- **Where it is decided:** in `carryWalkSend`, right after its earlier failed returns (carry-proven, serve-entries,
  baseline rows, one isolation mode), which keep their own reasons. `carryWalkOn` counts a walk in `carryWalkStats.walks`
  only when it really sends (review MINOR 6). A skipped walk is never counted there.
- No request is sent, no resource file is written, and the daemon is not touched, so it is not closed.
- The mutant gets exactly today's verdict (survived) and today's tag, `[singleinstance-carry-walk-failed: ...]`. The
  orchestrator's ruling: only the reason text after the tag changes, because it must not claim a request was sent.

**Why the premise holds, and where it could break (each case is refused, not skipped):**
- **Why it holds.** The walk sends NONE as its second request. There the kept codeunits run unmutated, in one session.
  kept[0]'s first test runs first after the echo, with no earlier covering test's state, as its baseline did. So its
  baseline-flagged pass is expected to pass flagged again, and the walk fails at the latest at request 2, whatever the
  mutant does.
- **A later test's flag is NOT used,** neither a later test of kept[0] nor any test of a later codeunit, even though on
  c4 those flags doom the walk too. In the walk they run after earlier tests' state, so the path that hit the flagged
  assumption could differ. Using only kept[0]'s first test loses nothing on c4.
- **Refused cases:**
  - Another isolation mode (rule 2).
  - A per-test codeunit (rule 3).
  - A flag-unknown row (rule 1).
  - A build that does not flag: there is then no `flagged: true` row, so nothing is skipped.
  - The flags always come from this session's own build. `baselineRows` is filled only by this session's baseline calls
    and by a reused snapshot's re-check on this session's daemon (PR-21 L5).
- **What would break it:** a test that is flagged at baseline but not flagged when it runs first after the echo under
  NONE. That would be a flag that depends on the session around it.
- **How it is measured (review SERIOUS 1):** `judgeCarryWalk` reports only the first unsound request, and on c4 every
  walk failed at request 1, so today's output cannot show request 2. So with the knob off (arm A), a walk the skip WOULD
  have skipped records whether its request 2 (NONE) holds that same test as a pass with `flagged: true`. One stderr line
  at close, only when any such walk ran:
  `[lethal] al-runner-v3 carry premise (PR-410): the predicted test passed flagged under NONE in X of Y walks the skip would skip (misses: <mutant codes>); request 2 not reached in Z`.
  - Y counts only walks whose request 2 answered.
  - A walk that ended before request 2 (a request-1 timeout or error, a stop) is counted in Z, never as a miss (delta
    review).
  - That X equals Y is the DO check's hard premise claim.
- **The unit tests cannot** check the premise. Only the DO check can.
- **A pre-existing gap, filed (review SERIOUS 3, not changed here):**
  - The walk's own B1 check sees a flag only if the daemon writes `flagged` on serve rows. Walk rows do not get the
    `flaggedUnknown` that baseline daemon rows get (R949).
  - So on a build whose serve rows omit the flag, a flagged pass would read as sound inside the walk.
  - c4's walks saw flags, so main-bf3a3e863 writes them. Whether carry-proven should require that is filed as
    **R1206**.

### (A) Stop early, the second guard
For a walk that is not skipped, each answer is judged as it arrives, by the same per-request checks
`judgeCarryWalk` applies (echo, rows complete, B1 classification, flagged passes). The per-request part moves into one
function that both use, so the text is shared.
- When request n is already unsound, the walk stops: requests after n are not sent. It returns the same
  `failed(reason)`, byte for byte, that `judgeCarryWalk` would return over all three answers. That is the first unsound
  request's reason, because the earlier requests were sound.
  - Only `judgeCarryWalk`'s `answers.length !== 3` check stays out of the shared per-request function.
- The `unkept-row` close after it happens exactly as today, over the answers received.
- **What stopping early changes (review MINOR 6), on purpose:** today a LATER request can still fail or throw first.
  Examples: a timeout or request error, an unreadable row, `refuseDaemonDependencySkip`, an `assertBound` breach. With
  the stop, the request-n reason wins and those later sends never happen. A bound or dependency breach is then found at
  the lane's next send instead. A unit test pins that request n's reason wins.
- With the knob off, the walk sends all three requests as today.

### (C) Why a walk closes the daemon
The carry walk's `closeLane(lane, "unkept-row")` now carries the first unkept row's `unkeptRowReason`, as the baseline
path already does (`closeLaneIn(..., dirtyWhy)`).
- The `serve-daemon-closed` event keeps reason `unkept-row`, so the warm-up cause `after-unkept-row` does not move. It
  gains the optional `family`, `text` and `test` fields that refusal closes already carry, when the first unkept row is
  a refusal.
- No new event field, so no schema change.
- **On the event only (review MINOR 4).** The family is NOT passed through `closeLane`'s counting path. So
  `closeFamilies`, `refusalCloses`, the storm warning and the near-miss check do not see walk closes, and the close
  line's "refusal N (...)" still adds up to N.

### Counts and the knob
- **Counts:** one new stderr line, printed only when a walk was skipped, so no existing line moves:
  `[lethal] al-runner-v3 carry walks skipped (PR-410): N, before any request (a baseline-flagged pass in the first codeunit)`.
  A skipped walk is not counted in `carry walks (PR-340, R1173)`, which counts walks that reach the daemon.
- **The knob:** `LETHAL_V3_CARRY_SKIP=off` turns (B) and (A) off together, giving exactly today's walk. It exists for the
  DO check's arm A. Any other value is refused by name.
  - It goes in the fingerprint only when off (`v3CarrySkipOff`, like `v3CarryWalkOff`). So a resume never crosses a
    knob flip.
  - A run started before PR-410 and resumed after it CAN mix the "request n:" and "skipped before request 1:" reason
    texts, because the fingerprint holds no LethAL head (review MINOR 5). The tag and the verdict are the same either way.

## Pre-committed results

### Unit tests, each red-checked
All use the backend's fake daemon, with request counters:
- doomed: kept[0]'s first baseline row is a flagged pass from a daemon. 0 requests are sent, there is no close, the
  reason is the exact skip text, the skip line counts 1, and `carry walks` does not count it.
  - The fixture row is built through the real daemon-baseline path, or carries BOTH `flagged: true` and
    `flaggedUnknown: true` as that path writes them. A fake row without `flaggedUnknown` would pass for the wrong reason.
- a premise miss: request 2 not reached (request 1 times out) counts in Z, not as a miss.
- not doomed:
  - kept[0]'s flagged pass is its SECOND row: the walk is sent.
  - No flagged pass in the first codeunit, while a LATER codeunit has one: the walk is sent as today.
  - kept[0]'s first row came from a one-shot call: sent.
  - Only a `flaggedUnknown` row: sent.
  - The codeunit's mode changed after its baseline: sent.
  - A per-test codeunit: sent.
  - The knob off: sent, with exactly today's three requests.
- stop early: request 1 unsound gives 1 request sent; request 2 unsound gives 2 sent. Each reason equals
  `judgeCarryWalk` over the full three answers, byte for byte. Request 1 unsound AND request 2 set to time out gives
  request 1's reason, with 1 sent.
- the premise line: with the knob off, a predicted walk whose request 2 holds the test as a flagged pass counts X=1 of
  Y=1. One whose request 2 does not counts 0 of 1 and names the mutant.
- the close: an unkept refusal row in a walk's answers gives a `serve-daemon-closed` with reason `unkept-row` plus its
  family, text and test. The close line's refusal count and families do not change.
- the knob: an invalid value is refused. Off puts `v3CarrySkipOff` in the fingerprint, and absent leaves the digest
  unchanged.

### Gates
- **itest:alrunner-v3-carry** (sandbox-carry): unchanged. 8 killed / 5 survived per its baseline, and the three leak
  mutants are killed by the walk. 0 walks skipped: the fixture's baseline holds no flagged pass. The gate prints no skip
  line; if it prints one, that is a BLOCK.
- **itest:alrunner-v3:** 0 verdict, killingTest, note or warning moves on every leg. A leg whose walk is skipped would
  change a note's text, and none is expected (the v3 gate's fixtures flag no first walk codeunit). If one appears, it is
  listed, not passed.
- **BC legs,** as `selectLegs` picks them: no moves (a v3-only change).

### The DO check (its own run, after the gates)
- **Scope:** the files of c4's 129 walk mutants (`--only`, the list kept under `/coord/handoff/PR-410/`). Four arms,
  interleaved A1, B1, B2, A2 over two halves of those files, on the same head and binary, c4's settings, each with its
  own cold cache:
  - A = `LETHAL_V3_CARRY_SKIP=off`;
  - B = default.
- **V (hard, BLOCK on any miss):** per mutant on the full site key, A against B:
  - 0 verdict moves and 0 killingTest moves;
  - the note TAG sets are equal;
  - the reason text differs only on the skipped walks, from "request n: ..." to "skipped before request 1: ...".

  Every mutant A walked and B skipped is listed by name. A mutant B skipped that A KILLED by the walk is a BLOCK: the
  premise broke.
- **The premise (hard, BLOCK on any miss):** arm A's premise line must read X = Y with Y > 0 in both A1 and A2. Each miss
  is a walk where the predicted test was NOT a flagged pass under NONE, so the skip would have been unsafe there.
- **Counts (deterministic):**
  - B sends 0 walk requests for every skipped walk.
  - B's `after-unkept-row` warm-ups drop by the walks it skipped.
  - A reproduces c4's failures: all walks fail at request 1 on a flagged pass.
- **Also per mutant:** A against c4's own report on these mutants (verdict, killingTest, tag set) is reported, not
  judged.
- **Speed (reported, not judged):** walk time and restart warm-up time per arm, and the mutant-phase wall, between
  interleaved arms only (server1 is shared; owner's ruling, 2026-11-23). The known saving is deterministic (requests not
  sent, restarts not made), so the counts carry the claim, not the wall.
