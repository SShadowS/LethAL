# R-601 live pre-commitment (lane bugs; committed to master before any live run)

This is an addendum to R618's pre-commitment, `docs/superpowers/specs/2026-10-22-r618-lend-precommitment.md`, and
to that file's own addendum.

- **Head:** `lethal/r601` at **524fd8d3**. The code commit is **f9002861**, the last fix round. It covers the review
  fixes and the revoke on every flip; 524fd8d3 adds docs only. A commit after 524fd8d3 may change only docs or the
  roadmap: nothing under `packages/` or `scripts/`. If code changes, this file is amended and committed again before
  the run.
- **Server:** `bc1` for both gates. Since R604, every BC gate is proven on all three servers under the control build
  that master pins. The proof table in `docs/gates/servers.md` lists bc1 for `itest:lend` (R618) and for
  `itest:bcdev`. LethAL Control must be at 1.0.0.23, read under the lease by `lethal doctor`'s `control-version`
  check before the first gate.
- **Lease:** `kraken coord lease bc1 bugs`. Take it only when `holder bc1` is null and `free -g` shows at least
  10 GB available. Heartbeat every 3 minutes or sooner, and release it as soon as the last run ends. bc2 and bc3
  stay free for the other lanes.
- **Rulings this rests on:**
  - Q1: accept the window, bounded to the same server.
  - Q2: R620 is closed as a duplicate.
  - Q3: the live gates are `itest:lend` and `itest:bcdev` on one proven server. `:verify` and `:testapp` are
    skipped by ruling.
  - Q5: lane bugs may edit `itest:lend`, so RN1 becomes RN1d plus RP.
  - I-A: revoke on every flip, scoped to the same server and the same project.
  - The lend owner's requirements (preproc, via the orchestrator): RN1d refuses at the test app before the lease,
    RC7 and RC7b are re-run live against RN1d, and RP keeps the "picked KP" check.

## Commands (foreground, from `/work/lethal-wt/r601`, never signal-stopped)

```
kraken coord lease bc1 bugs
bun packages/runner/src/cli.ts doctor --config fixtures/sandbox-app/lethal.config.bc1.json   # control-version 1.0.0.23
LETHAL_ITEST_LEND=1 LETHAL_ITEST_CONFIG=lethal.config.bc1.json bun run itest:lend 2>&1 | tee /coord/handoff/R-601/live/lend-bc1.log
# red checks LRC1..LRC4, RC7, RC7b: each from a scratch copy of the worktree (never the worktree
# with a running gate), one break, the same command, log to /coord/handoff/R-601/live/lend-rc-<id>.log
LETHAL_ITEST_LEND=1 LETHAL_ITEST_CONFIG=lethal.config.bc1.json bun run itest:lend 2>&1 | tee /coord/handoff/R-601/live/lend-bc1-clean.log   # clean confirm after the red checks
LETHAL_ITEST_BCDEV=1 LETHAL_ITEST_CONFIG=lethal.config.bc1.json bun run itest:bcdev 2>&1 | tee /coord/handoff/R-601/live/bcdev-bc1.log
kraken coord release bc1 bugs
```

The first line of each gate must read `[itest target] ... bc1 ...`.

## itest:lend: predictions per leg

The legs run in this order: L0, L1, R1, R2, R3, N0, N1, N5, RN3, RN1d, RN2, RN4, RP.

Names used below:
- **A** is L0's run.
- **H** is A's proven test-app hash. It contains `|closed-world:public` and is confirmed.
- **D** is A's dependency fingerprint.

### Unchanged legs

The figures come from `docs/gates/lend.md`, as at 7084eece and 03547bf6.
- **L0, N1, N5:** 3 killed / 12 survived / 4 no-coverage over 19, frozen per mutant, `groupedCalls` 15.
- **L1, N0:** 3 / 0 / 4, 12 known survivors (the frozen survivors, by key), `groupedCalls` 3.
- **R1:** 19 carryable, 19 carried, `groupedCalls` 0, no artifact, `resumedFrom` {F, 19, 0}.
- **R2:**
  - it resolves to K: 9 carryable, 1 error row, and 7 carried (KEPT minus its two uncovered rows);
  - `groupedCalls` 8;
  - the reused snapshot is run B's, and no baseline test ran here;
  - the sentinel M0004 is carried from K with `priorDurationMs` 987654.
- **R3:** `snapshot-backend-build-changed` exactly, 15 carried, `groupedCalls` 0, and the baseline re-ran as many
  tests as L0's.
- **RN3, RN2, RN4:** refused with today's heads, with no run row.
  - RN2's tail stays `none of its verdicts is carried (R247, R495)`. A revoked hash is not pending, so it gets no R601
    sentence.
  - RN2's message gains one sentence AFTER its pinned head (delta review I-1):
    ` Its identity was revoked: a closed-world check after execution, its own or a later run's on its server, answered differently (R389, R601).`
  - The itest checks the head by prefix and the tail by containment, so both pins hold unchanged.
- **Every leg that runs** records H and D on its own run row.

### RN1d (new, replaces RN1)

**Seed:** KPd, a clone of A with test-app hash `H'|pending`. H' is H with the closed tag swapped:
- if H ends `|closed-world:public`, then H' = H + `+internal`;
- if H ends `|closed-world:public+internal`, then H' drops the `+internal`.

**Command:** `--resume` (last).

**Expected:**
- It picks KPd. KV is another backend, so it is not picked.
- `assertSameTestApp` refuses it before `createRun` and before the lease, so no new run row exists.
- The message starts, exactly:
  `--resume: run <KPd> was measured against test app H'|pending, and this session's test app is H. Run <KPd> ended before its post-execution closed-world check, so its closed-world answer was never confirmed. Such a run is resumed only by a session on the same server whose test app and closed-world answer, asked now, are the same, and this session's differ.`
- The message contains `none of its verdicts is carried (R247, R495, R601)`.

### RP (new, last, after RN4)

**Seed:** KP, a clone of A in K's shape:
- KEPT plus M0003 as `error`, with codes and lines rotated;
- the sentinel M0004 at 987654 ms;
- test-app hash `H|pending`;
- `resource_key` copied from A, which is bc1's key.

KP is the newest unfinished run. **Command:** `--resume` (last).

**Expected:**
- The lend warnings are exactly `resume-reusing-run` and `resume-baseline-reused`.
- **This is the "picked KP" pin:** `resume-reusing-run` contains
  `reusing run <KP> — 9 mutant verdict(s) may be carried`,
  ` 1 prior 'error' verdict(s) will be re-executed.` and
  ` Run <KP> ended before its post-execution closed-world check (R389); this session's guard gave the same closed answer now, and this run's own check after execution will confirm or revoke everything it carries; if this run also ends early, it stays pending like the run it resumed (R601).`
- `resume-baseline-reused` names N5's run (`same as run <n5>'s batch 0,`). That is the newest snapshot owner
  recorded under H, because KP has no snapshot and pending owners are excluded.
- Carried, by key: exactly KEPT minus its no-coverage rows, which is 7.
  - `resumedFrom` {KP, 7, 0};
  - `groupedCalls` 8;
  - per mutant equal to `bcdev.baseline.json`;
  - the sentinel carried from KP with `priorDurationMs` 987654.
- RP's own run row records exactly H (not `H|pending`), proven, with D. That shows its own live re-ask after
  execution confirmed it.
- KP's row still reads `H|pending`.
- No baseline test ran here: `ranHere(rp.events) === 0`. The itest asserts it (review M-E).

**A deviation from the plan review's M4, stated here.** RP's batch reuses a confirmed snapshot (N5's). So RP deploys
and executes the 10 re-derived rows, but runs no baseline test itself. The confirm it brackets is of its identity
and digests, not of a snapshot of its own.

### Revoke on every flip moves no live figure

The I-A ruling changes only what a flipping post-execution re-ask revokes.
- **No leg of this gate flips.** On the fixture, every live session's guard gives the same closed answer before and
  after execution. So RP's figures and every other leg's figures above stand unchanged.
- **A fresh session that flips cannot happen here.** Nothing publishes a dependent of the test app between a
  session's two asks.
- **So this gate cannot show the new revoke.** It is pinned offline only, by `tests/resume.test.ts` D6, D4c,
  D4c-tag and D4c-nokey. Their red-checks are in `/coord/handoff/R-601/red-unit/`:
  `D6-resumed-pending-condition-restored`, `D4c-project-filter-dropped`, `D4c-server-filter-dropped`,
  `I1-flip-clause-dropped`, `M3-exact-hash-match` and `M7-nokey-term-dropped`.
- **The same holds for two other parts of the change:** the chain's second closed tag (M-3), and the
  `closed-world-changed` clause that names revoked runs (I-1). Neither is reached without a flip, so no live warning
  text changes.
- No D-leg is added.

**Gate end:** `lend itest: PASS`, with sublegs L0, L1, R1, R2, R3, N0, N1, N5, RN3, RN1d, RN2, RN4, RP.

## Live red checks

Each check is one break, made with the Edit tool in a SCRATCH copy, followed by a gate run. The gate stops at the
first red leg. After each check the break is restored, and the clean confirm run must pass.

| id | kind | break | first red leg, and how |
|---|---|---|---|
| RC7 | revert (R618's) | `assertSameTestApp`: `return;` as its first line | **RN1d**: still throws, but from the R496 recheck under the lease (`TestAppRepublishedError`, "the resumed run recorded test app H'\|pending, and that run's test app was not proven ..., or another one"), after a run row exists: the head check (and the no-run-row check) fails |
| RC7b | revert (R618's) | RC7 plus the R496 (F1) throw never fires | **RN1d**: the session completes, carrying KPd's 19 verdicts whole: `RN1d: the session must be refused` |
| LRC1 | planted | `resumableTestApp`: the pending case compares only up to `\|closed-world:` (the flags ignored) | **RN1d**: both sites accept KPd; the session completes: `RN1d: the session must be refused` |
| LRC2 | planted | the post-execution re-ask skipped when the resumed run's recorded identity is `<session>\|pending` (R1, R2, R3 resume exact identities and are untouched) | **RP**: completes, but its run row stays `H\|pending`: `RP: run <id> must record L0's proven test-app identity` |
| LRC3 | revert | `resumableTestApp` back to `recorded === session` | **RP**: refused before the lease by `assertSameTestApp` (`--resume: run <KP> was measured against test app H\|pending ...`), so the leg throws |
| LRC4 | revert | site 2 (R496 F1) back to `prior.testAppHash !== historyTestApp.hash`, site 1 kept | **RP**: `TestAppRepublishedError` under the lease ("the resumed run recorded test app H\|pending, and that run's test app was not proven ..., or another one") |

Offline, each of these breaks is already red in `packages/runner/tests/resume.test.ts`
(`/coord/handoff/R-601/red-unit/`).

## itest:bcdev (same head, same server, after lend)

The frozen figures are unchanged (`docs/gates/bcdev.md`):
- 19 sites: 3 killed / 12 survived / 4 no-coverage;
- `groupedCalls` 15, `warmKills` 0;
- per mutant equal to `bcdev.baseline.json`.

Why the change cannot reach it:
- It runs no resume, so the resume rule, which sits behind `resolvedResume !== undefined`, is not reached.
- The revoke on a flip no longer sits behind `resolvedResume`: it runs on any flip. But no leg's guard flips, so it
  is not reached either, and the re-ask confirms as before.

## Stop rule

Any difference from a prediction above is a BLOCK, and no explanation stands in for a pass. A BLOCK needs an
addendum to this file, committed, and then a re-run of the whole gate.
