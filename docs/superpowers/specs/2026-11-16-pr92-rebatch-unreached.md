# PR-92 (lever 6 of R1092): re-batch the groups a cut left unreached, instead of sending them one live request each

Status: NOT BUILT. Stopped by its spec-adversary review (2026-11-16). The review found no false-kill path, but four problems:
1. **§2(a) is false.** `resend` holds the cut group's own later entries: an unkept echo's whole group, the tail of a group
   with several entries, and the other mode's part (R896).
   - Read literally, the rule loops on an always-unkept echo.
   - Read the other way, it sends those parts live, where master batches them.
   - A two-class rule fixes it: re-send an unreached key without limit, a reached key's tail once. Progress then rests on
     `sent[0]`, which always stands.
2. **The work grows with the number of cuts.** A refusal does not stop a request's stream (only a timeout does, R895), so
   each cut re-runs the whole remainder: ~k x n/2 entries for k cuts.
   - On DO's runs of refusal closes this can be slower than master unless the re-sent work is capped.
3. **Guard (b) is vacuous.** `reached` is never empty for a non-empty request.
4. **The predictions lack a measured split.**
   - The t10 split of live requests by cause is not measured.
   - Under PR-89's lanes the gain shrinks or reverses.
   - The v3 gate pins serve counters (`S1E_PINS`), which a pre-commitment would have to name.

Expected gain before these: ~2% of a DO window. The one-mutant requests come from refusal closes, so lever 1 removes them at
the source. The design below is kept as the record.

Original draft (lethal-preproc):

## 1. The measured problem
- **A request's fixed cost.** Every serve request pays a fixed al-runner cost of ~0.7 s, whatever it carries. It is split
  into `setupMs` (~0.3-0.4 s, #8205) and the install baseline, which runs again because every LethAL entry carries
  `resources` (~0.3-0.4 s, #8206). Measured on PR-90's DO scope (`/coord/handoff/PR-92/result.md`, E1):
  - 14 mutants sent one per request: 16.3 s wall;
  - the same 14 in one request: 5.9 s;
  - saved: 0.74 s per mutant, with identical verdicts.
- **Where one-mutant requests come from.** R635 §7: at the first unkept entry of an answer (R612's rule), the daemon is
  closed. The entries before it, and that entry, stand. The groups after it are re-sent once on a fresh daemon. A group
  whose re-send is cut again by ANOTHER group's unkept row is not re-sent (`again = out.resend.filter((g) => !resent.has(...))`
  in `prefetchWindow`). It reaches the orchestrator's cold loop with no stored answer, and each of its calls becomes a
  one-group live request (`liveCall`).
- **Kill pairs** follow the same rule. `batchKillPairs` re-sends the kills after a cut once, then leaves them to
  `sendKillPairOn`, one live request per kill.
- **Size of it.** t10: 314 live requests:
  - 74 are batched kill pairs;
  - ~80 are single kill pairs (244 pairs, 164 served from the batch);
  - ~160 are other live calls.
  - PR-90's scope: 14 live requests for 69 covered mutants, after 3 refusal closes.

## 2. The change
In `prefetchWindow` (and the same in `batchKillPairs`), a group in `out.resend` is re-sent again, as part of a batch, while:
- **(a)** it was NOT REACHED in the request that returned it. Every group in `resend` is behind the cut entry by
  construction; the group that HOLDS the unkept entry is never in `resend`, because it stands. And
- **(b)** the request made progress: at least one entry stood (`reached` > 0, which R612's split guarantees, since the cut
  entry itself stands).

A group that reaches an unkept row of its own stands on its rows, exactly as today, and is never re-sent.

**Bound.** Each request stands at least one group (the cut one), so the re-sends of one window number at most its group
count. That is R635 §7's bound, without the "once". There is no loop: a group leaves `resend` either by standing or by the
window ending (budget, stop signal, memory gate: today's checks before every chunk stay as they are).

**Unchanged:**
- the encoder (every re-sent group carries its own echo again, first in its group, R635 §7);
- the daemon rules (each re-send is on a fresh daemon with PR-24's lazy proof);
- `groupsThatFit` chunking (R987);
- the batch-level refusal (§6 never re-sends);
- live calls for everything else (isolated tests, coverage windows, one-shot codeunits, a prefetch that gave no usable
  answer);
- PR-89's lanes: prefetch stays serial on lane 0, so no batch spans lanes, and OrderedCommit's per-mutant recording reads
  stored answers as today.

**Memory (lethal-code's check).** Re-sent groups join the window's `segments` and are cut into chunks when sent,
by `nextChunk`, from the costs measured so far (`groupsThatFit`, R987; PR-88's max-only readings shared across lanes). So:
- a re-send is never sent at the size of the request it came from;
- a cut on a grown daemon re-sends its groups in chunks sized by the newer, higher readings.

**Effect on PR-89's lanes (lethal-code).** PR-89's lanes 1..N-1 start only when live work remains after the prefetch. This
change moves exactly that work back into lane 0's prefetch, so fewer lanes start. The two savings do not multiply: if the
prefetch answers nearly everything, the parallel lever is R1093 (splitting the prefetch per codeunit across lanes), not
PR-89.

## 3. Why no verdict changes
- **The same answer either way.** A group that is today scored from a live request is, after the change, scored from a
  batched request on the same kind of daemon (fresh, lazily proven). It has the same entries (`mutantExcludes` and the
  echo) and is judged by the same code (`suiteMissing`, the echo check, R612 per entry).
- **Entries in one request are independent.** The carry-over probe of PR-24 (`/coord/handoff/PR-24/carry-probe/`) and
  PR-92 E1 (14 mutants: one per request against one batched, 0 differ) both show it. That independence is what prefetch
  already rests on.
- **Two places where the answer could differ, both handled:**
  1. A stored prefetch answer is consumed once. A re-activation (R577's reproduction) finds nothing and runs live, as
     today.
  2. A group stranded by several cuts in a row is answered on the Nth fresh daemon, not by a live request on the current
     one. Both are fresh, proven daemons, so the same.

## 4. Pre-commitment (DO)
- **Gates:** the v3 gate (`itest:alrunner-v3`) per mutant equal to its frozen figures; no BC gate (v3-only path).
- **PR-90's scope** (k1's run, master + this change):
  - verdicts per mutant equal k1's;
  - live requests fall from 14 to at most 3 + (kill pairs that did not batch);
  - mutant phase at most k1's minus 0.5 s x (14 - live after).
- **The next DO window** (lethal-bugs' R-984 rule):
  - 0 verdict moves by the window agreement rule against the previous window;
  - live requests at most ~120 (from ~314: the ~160 stranded calls and ~80 single pairs mostly batched);
  - saving ~150-170 s per window at ~0.7 s per avoided request.
  - Stated as a prediction; a miss is reported, not re-recorded.

## 5. Tests (each red-checked in both directions)
1. A window whose first re-send is cut by another group's unkept row re-sends the unreached groups again in a batch (the
   fake counts requests): red on master (they go live), green here.
2. A group whose own entry is unkept stands and is never re-sent (the bound): red if (a) is dropped.
3. A request that stands nothing (a fake that breaks R612's guarantee) stops the re-sending and leaves the groups live:
   red if (b) is dropped. The loop guard.
4. The same three for `batchKillPairs`.
4a. A re-send is chunked by the current costs: after a cut, a fake whose cost readings rose makes the re-send split into
    more chunks than the request it came from. Red if the re-send bypasses `nextChunk`.
5. Verdict identity on a stateful fake: the same mutants scored live (master) and re-batched (here) give equal verdicts.

## 6. Not in scope
- Lever 1 (fewer refusal closes) would shrink this further; it is its own task.
- The echo per request (measured: an echo pass is 0.10-0.125 s, ~28% of a batched mutant): dropping per-group echoes
  gives up the per-group proof that the resource took effect. That is a guarantee trade (owner, as PR-91's).
