# PR-102 pre-commitment: a kill pair runs only the prefix through the killing test (R1097)

Coord PR-102 (lethal-code, 2026-11-17).

## Why
PR-101 measured the DO e-document slice: 864 mutants, `--workers 1`, c888648f, edge-4ebfe7913, `/coord/handoff/PR-101/`. On
that slice the kill pairs (R653: one live request with a NONE entry and a mutant entry for the killing test's codeunit) ran
1,248 entries and 5,986 tests, in 376 s.
- The NONE entry has no covering set, so `mutantExcludes` gives it no cut, and it runs the WHOLE codeunit: 301 s.
- The mutant entry is cut after the mutant's last covering test (PR-20), which can lie past the killer.

The confirm and the reproduction each read ONE row: the killing test's (`activate(null)` then `run(ref)`; `activate(mutantId)`
then `run(ref)`).

## The rule
- **Both entries of a pair are cut after the killer.** That covers a pair sent by `sendKillPairOn` and a batched pair from
  `batchKillPairs`. "After the killer" means every test after the killing method `ref.method` in the codeunit's baseline order.
- **The cut is built the way `cutAfterLastCovering` builds its own**, with the covering set replaced by `{ref.method}`: R998's
  left-out run as the base, #8059's prefix-name keep rule, and no cut when the killer or any discovered test of the codeunit is
  not in the baseline order.
- **The cut goes out only with the flag (adversary H1).** A `through` cut is sent only in a request that `selectedOnlyDecision`
  flags `runSelectedOnly`, so the tail does not run. When the decision does not flag the request, the pair groups are encoded
  WITHOUT `through` (today's request), and so is every PR-94 scan-gap re-send and every PR-56 drift re-send. Cases where the
  decision does not flag:
  - a `neverFlag` codeunit;
  - a #8059 gap;
  - a baseline/discovered mismatch.

  Without the flag, `excludeTests` only hides rows while v3 still runs the tests (R1094). R612's daemon close and PR-56's
  kept-refusal record read only the visible rows, so a hidden refusal or hang in the NONE tail would leave a dirty daemon
  unclosed. An unflagged cut also saves no time.
- **How it is carried.** `EntryGroup` gains an optional `through?: string` (the killer's method). `requestOne`'s `excluded`
  callback uses it when it is present, and does not go through `mutantExcludes`' counting, so the `l4*` stats do not move
  (adversary L4). Otherwise it falls back to today's `mutantExcludes`. Only the two pair builders set `through`.
  - It is ignored for isolated entries (`encodeGroups`' isolated branch, R896, `--isolate-tests`); see L2.
  - Names are compared in lower case against `baselineOrder`.
- **Soundness.**
  - al-runner's order is fixed, and state flows forward only (PR-20; R1094's measured prefix result). So the rows up to and
    including the killer are the same whether or not the tail runs.
  - The confirm and R577's reproduction read only the killer's row. Both still run in the kill's own context: every test
    before the killer runs first.
- **What is NOT cut:**
  - the echo entry (its proof is that the selection took effect, which is a different argument from the prefix one);
  - PR-55's alone confirm (R895 alone requests);
  - R937's one-shot codeunits (they never send a pair);
  - any live call or prefetch outside a pair.

## Guards that keep a cut row from being read as anything
- **Who reads the pair's rows (adversary M1, corrected).** The confirm (`activate(null)` + `run(ref)`, plus its `runFenced`
  retry of the same ref) reads `pair.none`. `pair.m` is read by the reproduction, and stays in `rowsByCodeunit` until the next
  activate. So two other readers reach it:
  - R577 I4: a failed reproduction continues the covering loop under the same mutant;
  - PR-51's held-timeout replay.

  A covering test after the killer is absent from the cut `pair.m`, but it is in `pair.m.excluded` (`requestOne` copies the
  entry's `excludeTests`). So the EXISTING L4 widen path in `runRow` sends it as a live call under the mutant, in context, cut
  after the last covering test.
  - The verdict is the same.
  - `l4Widened` and `liveRequests` rise.
  - A test there that hangs costs a live timeout and a daemon restart, where today it would read `pair.m`'s timeout row.
- **The mutant side is already covered and does not change (adversary M2).** The L4 widen path keeps its R998 exception and
  its `coveringOf` update.
- **Only a NONE branch is added.** Under `lastActivated === null`, a ref in a stored call's `excluded` that is not in R998's
  left-out run sends a live NONE call instead of reading the stored rows. Nothing reads `pair.none` past the confirm today, and
  `rowMissing` throws under NONE, so this is a fail-safe for a future reader, not a fix of a live hole.
- **A stored batched pair (adversary L1).** R778's `takeStoredPair` serves a stored CUT pair only if `ref.method` and `through`
  are both in `baselineOrder(cu)`, compared in lower case, and `ref` is at or before `through`. Otherwise it fails closed: the
  pair is refused, counted in `pairBatchRefused`, and sent fresh. An uncut stored pair is served as today. For per-test call
  ids, the check is skipped and the pair is not cut (L2).
- **Re-sends.** An R612 cut re-send of a pair keeps its `through` only if the re-sent request is flagged (H1).

## Predictions (pre-committed)
- **Zero verdict moves.** A per-mutant before/after on PR-94's slice: BEFORE is PR-100's run (`/coord/handoff/PR-94/pr100/`,
  c888648f); AFTER is the PR head, with the same flags. `scripts/report-diff.ts` must find 0 differences in verdict,
  `killingTest` and note set.
  - The one way a move could arise: a pair whose NONE tail held a hang or a refusal after the killer. Today it would be cut
    (R612, `pairFallbacks`); after this change the tail never runs. Any move is a BLOCK until explained per mutant.
- **The slice's live serve time falls** by at least 150 s of the 284 s PR-101 estimated. In PR-100's run, live was 579.9 s, in
  the TIMING section.
- **Stats (adversary L3, M1).**
  - `pairRequests` and the `l4*` stats are unchanged.
  - `selected-only requests` rises only by the pair requests whose M entry had no PR-20 cut before. A pair with an M cut was
    already flagged.
  - `l4Widened` and `liveRequests` may rise (I4 and held-replay reads past the killer).
  - These moves are expected, and any serve pin they touch is listed in the observe-gate addendum.
- **Gates.**
  - `itest:alrunner-v3` passes with every verdict, `killingTest` and note set unchanged. Any serve pin that moves (the gate's
    observe switch) is listed in an addendum before acceptance.
  - `itest:hang` passes unchanged on its proven server.
- **Unit tests, each red when its rule is reverted:**
  - a pair's NONE and M entries both carry the cut through the killer;
  - no cut when the killer is not in the baseline order;
  - the #8059 keep rule;
  - a `run()` of a test after the killer, under NONE after the confirm, runs live and never reads the stored pair rows (the R998
    exception holds);
  - the L4 widen path still serves a covering test after the killer under the mutant (a "still holds" test);
  - a stored batched pair whose `through` is before the actual `ref` is refused, and so is one whose `ref.method` or `through` is
    not in the baseline order;
  - a `neverFlag` codeunit's pair is sent UNCUT, and so are the scan-gap re-send and a #8059-gapped pair (H1);
  - a flagged re-send keeps `through`;
  - the pair request is flagged `runSelectedOnly`;
  - the `l4*` stats do not move from a pair's cut.

## Review record
A spec-adversary pass (opus, 2026-11-17) on the first draft found:
- H1 (an unflagged cut opens the hidden-tail door), fixed above;
- M1 (the other readers of `pair.m`), M2 (the guard wording), L1-L4, all folded in.

It confirmed as sound:
- the confirm and reproduction rows under a flagged prefix;
- the R778 ref checks;
- that `noteBaselineRows` never takes a cut answer;
- that PR-56 drift cannot falsely fire;
- that no tail hang or refusal can move a verdict once H1 is fixed;
- that the N = 1 gate verdicts are unchanged.

## Part 2 (upstream, R1098): filed as https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8210
File at aldevtools/BusinessCentral.AL.Runner:
- the ask: an opt-in request flag that stops a request (or an entry group) after its first failing test;
- the evidence: PR-101's numbers (193 s, 10.7% of serve, after a kill; 291 s with kill-first order);
- a minimal invented repro;
- a duplicate search first, in its own step.

## Addendum 1 (2026-11-17, after the build, the Opus review and the first observe gate)
- **A batched pair is cut after the LAST failing covering test of its codeunit,** not the first. The first observe gate refused
  stored pairs: `pairBatchRefused` was 35 (D1), 35 (D1c) and 7 (T), where 0 was pre-committed (R788). The cause: the kill
  ledger (R197) can make any failing covering test of the codeunit the killer, so a pair cut after the first in plan order
  refused a later killer. With the fix, every possible killer is inside the prefix.
  - The second observe gate (head 4816958c) shows no gate failure and no moved pin.
  - The unit test "A and B both fail ... the kill is B" goes red under the old rule.
  - Single pairs (`sendKillPairOn`) keep the actual `ref` as `through`: their killer is known.
- **The committed lane trace moves as predicted.** `packages/runner/tests/v3-lane-trace.expected.json`:
  - the two kill-pair requests whose killer is not the codeunit's last test (M0002, M0005) gain `runSelectedOnly: true`;
  - `selectedOnlyRequests` goes 0 -> 2 and `selectedOnlyTestsSkipped` 0 -> 4;
  - closes, steps, verdicts and the other stats are unchanged.

  M0001's pair is not flagged, because its killer is the last test, so there is nothing to cut.
- **One behaviour change on a lying daemon.** Today, a NONE answer that is missing the killer's row stops the session through
  `rowMissing`. Under this change, the cut request's missing kept row is PR-94's scan gap: the request is re-sent uncut, the
  codeunit joins `neverFlag`, and a clean re-sent answer is what the confirm reads. This is the same rule PR-94 applies to
  prefetches. Only a daemon that drops rows triggers it, and the unit test with a daemon that lies on the re-send too keeps
  today's `rowMissing`.
- **`itest:hang` is not run.** The diff touches only al-runner-v3 code, and the hang gate runs on bcdev. The owner's ruling of
  2026-10-25 skips BC legs for v3-only changes.
