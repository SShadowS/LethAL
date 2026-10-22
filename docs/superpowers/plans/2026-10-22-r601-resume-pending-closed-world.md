# R-601 plan (r2): resume a crashed closed-world run when the guard, asked now, gives the same closed answer

## r2: the deep review (`review-plan-opus.md`, ADOPT with fixes) applied. These OVERRIDE r1 below.

- **I1, the same server.** `RunRow` gains `resourceKey` (read from `runs.resource_key`, already written by
  `createRun`). `resumableTestApp` accepts a pending prior only when the prior's and the session's resource keys are
  both defined and equal (undefined never matches). Refusal words name the two servers. `lend-seed.ts` copies
  `resource_key` into the clone. Unit tests T1/T2/D4 give their backend `resourceServer`/`resourceServerInstance`;
  new **D5**: same identity, different resource key → refused (break: drop the key comparison).
  **Stated limits** (R601.md and CHANGELOG): the key omits the tenant; a server RESTART inside the crash gap (the
  in-memory Linux servers lose every app, so a dependent could exist before and be gone after) is not detected. A
  probe item is filed for a readable server start time or boot id recorded at t0, and for whether dev-endpoint
  publishes appear in BC's install/operation history.
- **I2, revoke the chain.** When the re-ask flips in a session that ACCEPTED a pending prior, the same transaction
  that revokes this run also revokes every run of this project whose `test_app_hash` equals `<session hash>|pending`,
  with their snapshots. New **D4b**: after D4, a further `--resume` whose guard answers 0, 0 is refused (break: drop
  the extra revoke). Q4 is therefore split: reusing the prior's pending snapshots stays deferred; revoking the prior
  is DONE.
- **I3, the wording.** The R601 sentence fires only when `testAppHash !== undefined && row.testAppProven`.
  `testAppIdentity` passes the guard's own `why` out when the answer is open, and the refusal quotes it
  ("because: <why>") instead of a fixed cause list.
- **M1** `KilledAtConfirm` gets a "throw for the first N calls" switch (T2: throw, throw, pass). **M2** an offline
  refusal row for `H|...|pending|closed-world:revoked` via `--resume-run`. **M3** `resume-reusing-run` clause:
  "will confirm or revoke ... after execution; if this run also ends early, it stays pending like the run it
  resumed". **M4** RP becomes a pending clone of K (R2's partial shape), so the resumed run deploys, baselines,
  executes, records its own snapshot `|pending` and confirms it live. **M5** `itest:lend` is preproc's: its edits
  need preproc's agreement or an orchestrator ruling, recorded in the pre-commitment; LRC1/LRC2 are called
  "planted". **M6** Q3 needs an explicit orchestrator ruling for `:verify`/`:testapp`. **M7** D3(i) labelled
  defensive; the microsecond die-before-revoke window named in the stated limit.
- **R620** closes as R601's duplicate in the same commit; its closing text says this plan confirms the RESUMED run
  (the old row is never rewritten) and that equal identity strings imply equal open-world digests.

Lane bugs, worktree `/work/lethal-wt/r601`, base master 38cf6694 (+ bbb253c1, an unrelated deletion).
Candidate 1, plus candidate 2's wording for every case that still refuses.

**Duplicate.** R620 (filed by preproc during R618, 2026-10-22) is the same gap. Its option (a) is
this plan. Close R620 in the same commit as R601 (`done (<commit>)` on both); ruling Q2 below.

## 0. What happens today

- A closed-world session records its run's test-app identity as `<pkg>|closed-world:<tag>|pending`,
  and each baseline snapshot the same way. The record happens under the lease
  (`recordedTestAppHash`, `scoreBatch`). The post-execution block (`pendingClosedWorld.recheck()`)
  either confirms both in one transaction (`ResultsStore.confirmClosedWorld`) or revokes them
  (`revokeTestAppHash`, `closed-world-changed`).
- A run that throws before that block keeps `|pending`.
- `--resume` compares identities at TWO sites, and both use exact string equality:
  1. **Site 1, pre-lease:** `assertSameTestApp`, called inside `resolveResume`'s `lend` site checks,
     for both `--resume` and `--resume-run`. It compares `row.testAppHash` with
     `provenTestAppHash`, the session's GUARDED hash, which never has `|pending`.
  2. **Site 2, under the lease:** R496 F1, the block "a requested resume carries only from a run
     that proved the SAME identity". It compares `prior.testAppHash !== historyTestApp.hash`, plus
     the deps.

  The lend gate's RC7 shows that site 2 catches a pending prior on its own. So **both sites must
  change, through one helper**, or the fix does nothing.
- The env-tool post-hook check (`recorded !== proven`) is never closed-world: R389 keeps every
  env-tool session open. It stays as it is (see §2).

## 1. The guard's "closed answer", and what must be equal

The guard is `closedWorldOf`. Its answer is closed only when every one of these holds:
- the backend has `dependentCount` (bcdev only);
- the test `app.json` id equals the digested package's manifest id;
- `DependentCount(appId)` returns exactly **0**. Control older than 1.0.0.23 answers 404, which
  gives open. An error gives open plus `closed-world-unmeasured`. A count above 0 gives open.

The answer is `{ public: true, internal }`, where `internal` is true only when neither `app.json`
nor the manifest names `internalsVisibleTo`.

`guardedTestAppHash` binds that answer into the identity string:
`package:<sha256 of the served test app>|closed-world:public` or `...|closed-world:public+internal`.
An open answer leaves the bare hash.

So the closed answer is: **count = 0, both flags, and the package bytes**.
- **The control version is not in the identity, and need not be.** Any version that answers at all
  (1.0.0.23 or later) answers the same question. A control downgrade gives a 404, so the answer is
  open and the tag is absent, so the identities differ.
- **The dependent count needs no separate field.** Closed already means 0.

**Accept a pending prior only when ALL of these hold** (each one is already a check today, except
the first):
- (a) `row.testAppHash === session + "|pending"`, and the session's hash ends in a closed tag
  (`/\|closed-world:public(\+internal)?$/`). This means the same package sha256 and the same flags,
  asked NOW by this session. The guard must have answered closed at this session's start.
- (b) `row.testAppProven` (R495), at site 1.
- (c) the same dependency fingerprint under the lease (`test_app_deps`, R496 F1), at site 2.
- (d) everything `resolveResume` already checks: backend and build (`runMayLend` step 1), scheme,
  coverage mode, symbols, fingerprint, `carry_hidden`, and the R557 marks.

Anything else refuses, with words (§5). A revoked prior (`...|closed-world:revoked`, or
`...|pending|closed-world:revoked`) never satisfies (a).

**The helper** goes in `closed-world.ts`, next to `PENDING_SUFFIX`. It is one function, used at
site 1 and site 2:

```ts
/** R601: a resume may carry from `recorded` when it is this session's identity, or this session's
 *  CLOSED identity still pending: the prior run ended before its post-execution re-ask, this
 *  session's guard gave the same closed answer at its start, and this session's own re-ask
 *  confirms or revokes everything it carries. */
export function resumableTestApp(recorded: string | null, session: string | undefined): boolean {
  if (recorded === null || session === undefined) return false;
  return recorded === session || (CLOSED_TAG.test(session) && recorded === `${session}${PENDING_SUFFIX}`);
}
```

**The window (ruling Q1).** A carried verdict was measured between the prior run's first ask (t0)
and its crash (t1). This session asks at t2 and again at t3, after execution. A dependent that is
published and removed again inside [t0, t2] (0 -> 1 -> 0) is not seen. That is R389's stated
limit: two equal answers bracket the window, and a violation inside it is not detected. The window
is now longer, because it spans the crash gap, which may be hours. R389 put no bound on the length
of a long run's window either. **Recommendation: accept.**

## 2. Every resume consumer of the pending state

| Consumer | Today | After R-601 |
|---|---|---|
| Test-app identity carry, site 1 (`assertSameTestApp`, `--resume` and `--resume-run`) | exact equality: a pending prior is refused | `resumableTestApp`: accepted under §1 |
| Test-app identity carry, site 2 (R496 F1 under the lease) | exact equality: refused (`TestAppRepublishedError`) | `resumableTestApp`, then the deps check as today |
| Env-tool post-hook check (`recorded !== proven`) | equality | **unchanged.** An env-tool session is always open, so the rule could never accept there |
| Baseline-snapshot reuse (`findBaselineSnapshot`) | excludes `%\|pending` owners and keys on the session's unsuffixed hash | **unchanged: still refused.** The prior's own snapshots are not reused; a confirmed run's snapshots still are |
| History, `--skip-known-survivors` (`priorSurvivorKeys`, R618) | finished runs only, exact hash | **unchanged.** A pending run is never finished (the confirm block runs before `finishRun`; a quarantine confirms and does not finish), so there is no pending row here to accept. The resumed run lends to history only after its own confirm and finish |
| `lethal verify` (source run's digests) | a pending run has open-world digests | unchanged (not a resume consumer). The resumed run records and confirms its own digests |

**Why snapshot reuse stays refused (lazy and safe).**
- A batch whose every mutant carries (R192 half 1) needs no baseline, so only the batch that was
  open at the crash pays for one baseline.
- Accepting the prior's pending snapshots would take another `findBaselineSnapshot` key path (the
  prior's run id plus the pending key) and another set of tests.
- Deferred. It can be added if a real project's crash batch is costly.

## 3. Tests (offline, `packages/runner/tests/resume.test.ts`, the R389 block)

The tests use `GuardBackend(answer, abortFromDeploy)`. Its `asked` counts the calls, and
`answer(call)` scripts the count for each call. `KilledAtConfirm` is the existing store override
whose `confirmClosedWorld` throws.

**Rewrite** the test "interrupted before confirmation: nothing carries, no baseline is reused;
control: confirmed carries":
- It keeps its first half: the prior is `...|pending`, and so are its snapshots.
- It keeps its `findBaselineSnapshot(...pending key...) === null` half.
- Its resume half moves to T1.

Each test below is run for `--resume` (`"last"`) and for `--resume-run <prior>`.

| # | Direction | Setup | Expect | The single break that must turn it red |
|---|---|---|---|---|
| T1 | safe: pending accepted, same answer | prior killed at confirm (count 0); resume with count 0, 0 | carried > 0; the `resume-reusing-run` text has the R601 clause; `third.asked === 2`; the resumed row ends exactly `<H>\|closed-world:public+internal` (confirmed); the prior row is still `...\|pending` | `resumableTestApp` back to `recorded === session` (it refuses at site 1) |
| T1b | the same, site 2 alone | as T1 | as T1 | site 2 back to `!==`, with site 1 kept (throws `TestAppRepublishedError`) |
| D1 | unsafe: the guard now answers open | prior pending (0); resume with count 1 | refused, R601 wording "does not answer closed now"; deploys + baselines + mutant runs = 0 | the helper compares hashes with every `\|...` suffix stripped from both sides |
| D2 | unsafe: closed, different identity | prior pending, its row hand-set to `<H>\|closed-world:public\|pending` (flags differ); session closed `public+internal`. Second case: the package hash differs (`served` changed) | refused, R601 wording "differs"; nothing run | the helper compares only up to `\|closed-world:` (the flags are ignored); for the second case, ignoring the package part |
| D3 | unsafe: no guard asked | (i) a backend without `dependentCount` (plain `CountingBackend` with `served = PKG`) and the prior row hand-set to `<H>\|pending`, bare + pending, a shape production never writes; (ii) the same backend with the real prior `<H>\|closed-world:...\|pending` | both refused; nothing run | (i) drop the `CLOSED_TAG.test(session)` term. (ii) is held by equality, and is a control only |
| D4 | unsafe: the accepted resume skips its own re-ask | prior pending (0); resume with answer `call === 1 ? 0 : 1` | the resume is accepted; `closed-world-changed` is warned; the resumed row ends `<H>\|closed-world:...\|pending\|closed-world:revoked`; `asked === 2` | the post-execution block skipped when `resolvedResume` came from a pending prior, OR the resumed row recorded without `\|pending` (an early confirm). Both are red-checked |
| T2 | the chain: the resumed run also crashes | prior killed (0); resume #1 with `KilledAtConfirm` (0, 0) throws; resume #2 (0, 0) | #2 picks resume #1's run (the newest unfinished one, which holds carried rows) and carries; #2 ends confirmed; #1 and the prior are still `\|pending` | none of its own (it rests on T1's rule). This pins §4 |
| S1 | safe: a confirmed prior as before | the existing tests: the `--resume`/`--skip-known-survivors`/baseline-reuse flip matrix, "R618 Q1" in `orchestrator.test.ts`, R247's `resume.test.ts` blocks, `r619-one-lend.test.ts` | unchanged, green with no edit | none (a regression check) |

Red-check every row with the `mutation-red-checker` subagent: one break at a time, the named test
red, then restored green. Both outputs go to `/coord/handoff/R-601/redcheck.md`.

`r619-one-lend.test.ts`'s call-log spies must stay green. The helper runs inside the site checks,
so the order of `runMayLend` steps does not move.

## 4. What `|pending` becomes after a resume accepts it

- **The prior row is never rewritten.** It stays `...|pending` for good, and so do its snapshots.
  That is harmless:
  - it is unfinished, so history never reads it;
  - its snapshots stay excluded;
  - its verdicts reach later sessions only through the resumed run.
- **The resumed run R is a normal closed-world session.** Its own identity is recorded under the
  lease as `<H>|closed-world:...|pending`, and its own post-execution re-ask:
  - answers the same: confirms R (its digests, its identity and its snapshots, in one transaction);
  - answers otherwise: revokes R and warns `closed-world-changed`.
- **If R also crashes:** R is the newest unfinished run with carryable rows (its carried verdicts
  are copied into R's own rows), so the next `--resume` picks R and accepts it by the same rule.
  The chain works, and T2 pins it.
- **Unchanged, stated:** after R finishes, the prior run is again the newest unfinished run, so a
  later `--resume` could pick it again. That already happens today for an open-world crashed run
  that was resumed to completion. It carries only under the same identity, so it is no new hazard.
- **Not done:** revoking the prior when R's re-ask revokes R. It is one line, and fail-closed, but
  no direction needs it. It can be added if the ruling wants a flip seen after the window to taint
  the prior too.

## 5. The refusal wording (candidate 2)

The head of the R247 message is unchanged, so the existing head assertions hold. In
`assertSameTestApp`, when `row.testAppHash` ends in `|pending` and the helper refused, insert one
sentence after the hashes and before `TEST_APP_WHY`:

- **The session is closed, but differs** (D2):
  "Run N ended before its post-execution closed-world check, so its closed-world answer was never
  confirmed. Such a run is resumed only by a session whose test app and closed-world answer, asked
  now, are the same, and this session's differ."
- **The session is open, or the guard could not be asked** (D1, D3):
  "Run N ended before its post-execution closed-world check, so its closed-world answer was never
  confirmed, and this session's closed-world guard does not answer closed now (an app on the
  server depends on the test app, the deployed LethAL Control predates DependentCount, or the
  question failed), so that answer cannot be confirmed."

Then the tail, unchanged: "... so none of its verdicts is carried (R247, R495, R601). Drop the
resume flag to run from scratch."

**Site 2's reason** keeps its "or another one" text. It can be reached for a pending prior only
after site 1 accepted, that is, only on a deps change, which already has its own reason.

**An accepted resume says so.** The `resume-reusing-run` message gets a clause when the prior was
pending: "Run N ended before its post-execution closed-world check (R389); this session's guard
gave the same closed answer now, and this run's own check after execution confirms or revokes
everything it carries (R601)."

## 6. Ripples

- **No** SessionReport field, **no** new event type, **no** warning code (the codes are free
  strings, and only the message text of `resume-reusing-run` gains a clause), **no** Caveat and
  **no** schema. So CLAUDE.md's ripple list does not apply.
- `CHANGELOG.md` [Unreleased] → `### Changed`: "`--resume` and `--resume-run` now resume a
  closed-world run that ended before its post-execution check, when the closed-world guard gives
  the same answer now; other cases are refused in words (R601, R620)."
- Roadmap: R601 and R620 set to `done (<commit>)`, each with evidence, then
  `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts`.
- `docs/gates/lend.md`:
  - the RN1 row, the "A crashed closed-world run keeps `|pending`" paragraph, RC7's red-check text
    (RN1 is now accepted, and RC7's target moves to RN1d), and a History line;
  - `LEND_FIGURES` in `gate-expected.ts` only if RP needs a new figure. Its expected figures equal
    `resumeWhole`'s, so it reuses them.

## 7. Live

**Which gates run the touched paths.**
- **`itest:lend`** is the only BC gate that resumes (R618). Today its RN1 seeds a pending clone of A
  and asserts the refusal, so **RN1 turns red under this change, by design**, and the gate must be
  edited.
- **`itest:bcdev`, `:verify` and `:testapp`** run `runSession` fresh, with no `cfg.resume`. They
  reach the confirm block, which is unchanged. The changed code sits behind
  `resolvedResume !== undefined`, so they do not move by construction.
- **`itest:lease`** drives `LeaseClient` and `RunMutantTransport` directly, never `runSession`, so
  it does not reach the change.
- **Servers:** `docs/gates/servers.md` proves all of these on bc1, bc2 and bc3 under control
  1.0.0.23 (lend added and passed on all three on 2026-10-22).
- **Required on the final head:** `itest:lend` and `itest:bcdev` on one server (proposal: bc1),
  under a lease, foreground. `:verify` and `:testapp` are optional (ruling Q3).

**Does any gate do a crash and then a resume on a closed server?** No. RN1 seeds a crash's STATE (a
pending clone, without its snapshots or digests, per lend.md's "Clone fidelity"). No gate crashes a
run for real.

**The smallest live measurement** is a change to the lend gate. It needs no new gate and no new
full fixture run.
- **RN1d (a refusal, before any run row):** seed KPd, a pending clone of A whose tag is swapped
  (`public` ↔ `public+internal`). `--resume` picks KPd and is refused with the R601 "differs"
  sentence. No new run row.
- **RP (replaces RN1's refusal, placed last, after RN4):** seed KP, a pending clone of A
  (`H|pending`), as the newest unfinished run, then `--resume` (last). Expect:
  - it picked KP;
  - lend warnings are exactly `resume-reusing-run` (with the R601 clause) and
    `resume-batch-carried`;
  - all carried, as R1 does (`resumeWhole`: 19 carried, `groupedCalls` 0, no artifact);
  - `resumedFrom` is `{KP, 19, 0}`;
  - the result is per mutant equal to `bcdev.baseline.json` (`assertFrozen`);
  - the run row records H and D, **its hash ends exactly H (confirmed by its own live re-ask)**,
    and KP is still `H|pending`.
- **Not live:** "the guard now answers open" (it needs a dependent app published under the lease,
  as R389's probe did) and "the re-ask flips at the end". Offline D1 and D4 cover them. A real
  in-process crash (a store override that throws in `confirmClosedWorld` during a full run) would
  add one full fixture run. It would show only what the offline T1 and lend's SP1/SP2 (pending
  snapshot owners skipped live) already show, so it is left out.

**Pre-commitment shape.** The lane commits it itself: specs only, `[skip ci]`, to master, before
any live run. It goes in `docs/superpowers/specs/2026-10-2x-r601-lend-precommitment.md`, as an
addendum to R618's.
- the head sha; the server (bc1); control 1.0.0.23; the lease lane `bugs`;
- the legs that change: RN1 → RP, and RN1d (new), each with the predictions above, word for word
  (the message fragments and the exact hash strings in terms of H);
- every other leg: figures unchanged from `docs/gates/lend.md`;
- live red checks, each predicted to go red at a named leg:
  - LRC1: the helper accepts any pending prior whose package part matches (the flags ignored):
    RN1d goes red;
  - LRC2: the post-execution block skipped for a resumed session: RP goes red (its hash stays
    `H|pending`);
  - LRC3: the helper reverted to equality: RP goes red, refused at site 1;
  - LRC4: site 2 alone reverted: RP goes red with `TestAppRepublishedError`;
- red checks run from a scratch copy, never in a worktree with a running gate;
- the stop rule: any difference is a BLOCK, which needs an addendum and a re-run of the whole gate;
- then `itest:bcdev` on the same head and server: per mutant unchanged.

## Rulings wanted

- **Q1.** Accept the longer 0 -> 1 -> 0 window across the crash gap, as R389's stated limit (§1).
  Recommendation: yes.
- **Q2.** Close R620 as R601's duplicate, in the same commit.
- **Q3.** Final-head gates: `lend` and `bcdev` on bc1 required; `verify` and `testapp` optional,
  since they are unchanged by construction.
- **Q4 (deferred unless asked).** Reuse of the prior's pending snapshots (§2), and revoking the
  prior when the resumed run revokes (§4).

## Files touched

- `packages/runner/src/closed-world.ts`: `CLOSED_TAG` and `resumableTestApp`.
- `packages/runner/src/orchestrator.ts`: `assertSameTestApp` (the helper and the R601 sentence),
  site 2 (the helper), and the `resume-reusing-run` clause.
- `packages/runner/tests/resume.test.ts`: T1, T1b, D1-D4 and T2; the pinned test rewritten.
- `packages/runner/itest/lend.itest.ts` (RP, RN1d) and `docs/gates/lend.md`.
- `CHANGELOG.md`, `docs/roadmap/R601.md`, `docs/roadmap/R620.md`, `ROADMAP.md` (regenerated).
