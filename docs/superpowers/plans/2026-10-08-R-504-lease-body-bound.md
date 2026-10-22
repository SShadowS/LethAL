# R-504 plan (r2): bound the lease client's response body read

[r2] r2 follows `/coord/handoff/R-504/review-r1-opus-adversary.md` (I1, I2, M1 to M7). Changes
are marked [r2].

Source read: `/work/lethal-wt/r504` (master 1afd1983, includes R-503). Build in your own worktree on
task branch `lethal/r504`.

## 1. The problem, in the code

`postLeaseAction` (`packages/runner/src/lease.ts`) arms an abort timer at `cfg.timeoutMs ??
DEFAULT_TIMEOUT_MS` (30 s), then clears it in the `finally` around `fetchFn(...)`. `fetch` resolves
on the HEADERS. So `await res.json()` runs with no abort and no race. A 2xx whose body BC starts and
never finishes holds the caller with no LethAL timer behind it: the R191 shape, on the lease
connection.

Every `LeaseClient` action goes through it: `acquire` (AcquireLease), `renew` (RenewLease),
`release` (ReleaseLease), `beginPublish`, `endPublish`, `getOperationStatus`, `recoverOp`,
`forceResetLease`. There is no other `LeaseClient` action and no other path to the wire in
`lease.ts`. One fix in `postLeaseAction` covers all eight.

## 2. The fix (one function)

1. Move `bounded` from `run-mutant-transport.ts` (module-private today) to `bc-fetch.ts`, exported,
   unchanged. Import it in both files. Reason: `lease.ts` cannot import from
   `run-mutant-transport.ts`, which already imports `lease.ts` (a cycle); both already import
   `bc-fetch.ts`. No new file, no second copy.
2. In `postLeaseAction`:
   - `const ms = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;` arm the abort as today.
   - Keep the abort armed through the body read: clear the timer in ONE outer `finally` that wraps
     fetch + `res.json()` + parse, not around the fetch alone (what R191 did for `RunMutant`, and
     what `RunMutantTransport.postAction` does when bounded).
   - Race the whole fetch-and-read with `bounded(..., ms, \`LethALControl_${action}\`)` for a
     fetch or body stream that ignores its abort. The abort timer is set BEFORE `bounded`'s guard,
     so at equal `ms` the abort usually fires first and a normal fetch settles itself (R-503's
     ordering). [r2] (I2) Which of the two ends a stalled body is a timer race; no test may depend
     on it.
   - The body-read `catch`: if `controller.signal.aborted`, throw
     `LeaseUnavailableError("LethALControl_<action> body not read within <ms> ms")`; otherwise
     [r2] (M2) `LeaseUnavailableError("LethALControl_<action> 2xx body is not JSON: <String(err)>")`.
     (Today an aborted read would be mislabelled "not JSON".)
   - [r2] (M1) Outer `catch`: a `LeaseUnavailableError` passes through unchanged. ONLY `bounded`'s
     own rejection gets the timeout wording,
     `LeaseUnavailableError("LethALControl_<action> gave no answer within <ms> ms")`. Tell it apart
     by identity, not by text: e.g. a local `let timedOut = false` set by a wrapper around the
     guard, or `bounded` given an optional error factory. Any other error (none is expected today)
     becomes `LeaseUnavailableError(\`LethALControl_${action} failed: ${String(err)}\`)`, never the
     timeout wording.
3. Update the doc comments on `postLeaseAction` and `LeaseUnavailableError` (one line each: the
   timeout spans headers AND body, R504).
4. [r2] (I1) `LeaseSession.pulse` (`orchestrator.ts`), two guards:
   - `if (this.#stopped) return;` after the first renew throws, before the retry;
   - the `renewed:false` branch calls `noteLeaseLost` only when `!this.#stopped`.
   Why: with the bound, a stalled renew now throws after 30 s, and `pulse` retries. If `finish()`
   ran in between (it calls `stop()`, then may release), the retry is answered `renewed:false`
   against our own release. Today's code then calls `noteLeaseLost`, which latches the session and
   sets `lostBatchIndex`: the last batch's valid verdicts are discarded and the cause is reported as
   a takeover. A renew already in flight when `finish()` releases can be answered `renewed:false`
   the same way, which is why the second guard is needed too. After `stop()`, a renew answer is
   never evidence of anything.

**Error type: `LeaseUnavailableError`, no new class.** Its documented meaning is "the call cannot
be answered at all: unreachable, non-2xx, malformed body". A timeout before the headers is ALREADY
this class today ("unreachable: AbortError"). An unread body is the same fact one step later.
Every caller already catches it (section 3), and a new class would need each catch site checked
for an `instanceof` it does not have. The timeout error never carries `beginPublishRefusal`
(that field is set only by a parsed `begun:false`), which is load-bearing in `runLeaseHook`.

**R-496's refusal.** `postLeaseAction` does NOT rethrow `UnfilteredExtensionsQueryError` today:
its fetch `catch` wraps every fetch error, that one included, into
`LeaseUnavailableError("... unreachable: <String(err)>")`. This plan keeps that exactly as it is
(same catch, same message). So nothing that propagates today stops propagating. [r2] (M5) It is
still a defect: the refusal's TYPE is lost on the lease path, and the label "unreachable" is a
wrong diagnosis (BC answered; LethAL refused the redirect). The builder files it as its own new
roadmap item (section 6); R504 does not fix it.

Bun's socket idle timeout stays unmeasured and is not relied on; the bound makes it irrelevant.

## 3. What a timed-out body read means, per caller

In every row below a timeout is a THROWN `LeaseUnavailableError`. Every caller already has a
`catch` for a thrown call (a fetch-phase timeout throws the same class today), so no caller code
changes, except [r2] (I1) the two `pulse` guards. What changes is that the throw now arrives after
at most `ms` instead of never.

| Action / caller | What the timeout now does | Why it is safe |
|---|---|---|
| `acquire` in `acquireSessionLease` | throws out of the acquire loop (no retry, as for any thrown acquire today); the session never starts | Never treated as acquired: `granted:true` needs a parsed body. The server MAY have granted a lease we never learned of. It has no heartbeat and no op marker (acquire sets none), so it lapses within `ttlSeconds` (at most 15 s). Another session sees `held` and backs off until then. No quarantine is written, correctly. |
| `renew` in `pulse` (heartbeat) | first throw → one retry [r2] (I1) unless `stop()` has run; second throw → `lease-renew-unanswered` warning; next tick retries | Design §6: only a parsed `renewed:false` is loss. A timeout never latches, never sets `lostBatchIndex`, never ends the session. Today a stalled renew holds `#ticking` true forever, so EVERY later tick is dropped and the lease silently lapses: the fix removes that. If the server did renew, our lease is just longer. [r2] (I1) After `stop()`, neither a retry nor a `renewed:false` can latch. |
| `renew` in `onBeginPublishRefused` | `catch` → `noteLeaseLost`, returns `"lost"` | Fail-closed, as for any throw today: "lost" means nothing is released. |
| `renew` in `leaseProvablyNotOurs` (finish) | `lease-ownership-unconfirmed` warning, returns `false` → the marker is treated as ours → `recordRecycle`, no release | Fail-closed: an unread answer never proves the marker is foreign. |
| `getOperationStatus` in `finish` | `lease-marker-read-failed`, returns before release | No release over a marker we could not read. |
| `release` in `finish` | `lease-release-failed`: "the lease will expire" | Never recorded as released: `{released:true}` needs a parsed `released:true`; `finish` keeps no "released" state at all and only warns. If the server DID release, we report the safe direction (looks held, is free). |
| `#keepLease` (R249 retained marker) | `finish` returns before `release` is ever called | Unchanged: the keep-lease branch sits before the release call; no timeout can reach a release there. |
| `beginPublish` in `publish`, reached two ways [r2] (M6) | throws before `run()`. (a) Hook publish: `runLeaseHook` sees a `LeaseUnavailableError` WITHOUT `beginPublishRefusal` → `after-lease-acquired-uncertain`, latch. (b) Batch deploy, `deployOnce` → `publish`: the error becomes the batch's `deployErr`; `parseVersionConflict` finds no BC sentence in it, and `classifyDeployFailure` returns `undefined`, so R90 records no row; the session fails. Either way `finish` runs op-gated | The server may have begun. Then `finish` sees our non-idle marker, renew proves it ours, the tier is quarantined and the lease kept. If it did not begin, the marker is idle and the release is honest. |
| `endPublish` in `endPublish` | → `reconcileStrandedPublish` | A thrown EndPublish is already "lost ack" there. A tombstoned op reads `completed` → done; else RecoverOp only after a PARSED status naming our publish op. |
| `getOperationStatus` in `reconcileStrandedPublish` | `leaveStrandedPublish`: latch + recycle, marker left set | Never a RecoverOp on an unread status. |
| `recoverOp` in `reconcileStrandedPublish` | latch + recycle, original error rethrown (R361) | If the server recovered anyway, we only over-quarantine. |
| `getOperationStatus` in `reconcileLostAck` (first read and settling re-read) | `lease-reconcile-failed`, returns `"unresolved"` | Never `"completed"` (that needs a parsed `completed` or `lastCompletedOpSeq`), never `"not-started"`, never RecoverOp. The verdict stays `in-flight-unknown` and the orchestrator quarantines as today. Never a kill. |
| `getOperationStatus` in `pollUntilOpClears` | `lease-poll-failed`, returns `false` | → `"unresolved"` / `"original-stuck"`. Never "cleared". |
| `getOperationStatus` in `classifyRetryRefusal` | returns `"genuine"` (lease loss) | Fail-closed: the batch's verdicts are invalidated, not scored. Never a kill. |
| `getOperationStatus` in `nextOpSeq` / `resyncOpSeq` | throws; the session fails; `finish` runs op-gated | No op is begun on a guessed seq. |
| `forceResetLease` in `performForceResetLease` (cli) and hang `teardown` | throws; the CLI fails non-zero; the hang teardown prints its loud FAILED block | Never reports `reset`/`refused` without a parsed body. [r2] (M3) The reset MAY HAVE BEEN APPLIED: the request reached the server and only its answer was lost. The CLI message for a body stall says so ("ForceResetLease may have been applied; re-run `lethal force-reset-lease` to read the current generation and reset again"). A re-run reads the NEW generation live and is safe. [r2] (M4) This path is only PARTLY bounded: `HarnessVerifier.verify()` runs first and has the same unbounded body read (section 6, new item). |

Other `LeaseClient` users (`scripts/c0204b-live-probe.ts`, `scripts/probe-r58-differential.ts`,
`scripts/r236-baseline-probe/probe.ts`) gain the same bound and need no change.

**Never a kill:** no lease action produces a verdict; every timeout lands on `unresolved`,
`genuine`, a latch, a recycle or a warning. **Never falsely released:** the only "released" answer is
a parsed `released:true`, and a timeout throws before any parse. **Never a false lease loss
[r2] (I1):** after `stop()`, `pulse` neither retries nor latches. **Never a lost refusal:** see
section 2.

## 4. Tests

No wall-clock asserts. A missing bound goes red by the test timing out (bun's 5 s); use
`timeoutMs: 20` in the test `ActivationConfig`.

Fakes (in `tests/lease.test.ts`, copied in shape from `run-mutant-transport.test.ts`'s R191
`stalledBody`):
- `stalledBody(action)`: 200 with a `ReadableStream` that sends `{"value":` and never closes; it
  errors on the fetch signal's abort (as Bun does). [r2] (I2) Like R191's helper it returns
  `{ fetchFn, aborted }`, where `aborted()` says the stream saw the abort.
- `deafBody(action)`: the same stream, but it ignores the abort.
- `deafFetch(action)`: a fetch that never resolves and ignores the abort.
- a router fetch: answers each other action with a normal body, stalls only the named one.

### 4a. `lease.test.ts`, the shared function (one `test.each` over all eight actions)

| # | Case | Expect | Red-check |
|---|---|---|---|
| L1 [r2] (I2) | `stalledBody` per action | rejects `LeaseUnavailableError` naming `LethALControl_<action>`; message contains EITHER "body not read within" OR "gave no answer within" (which one wins is a timer race); `aborted()` is `true`; `beginPublishRefusal` undefined | Clear the timer right after `fetch` again (today's placement, keeping `bounded`) → `bounded` still ends the call, but the stream never sees the abort → `aborted()` false → red |
| L2 | `deafBody` per action | rejects `LeaseUnavailableError` "gave no answer within" | Remove `bounded` only (keep the armed abort) → times out |
| L3 | `deafFetch` per action | same as L2 | Remove `bounded` only → times out |
| L4 | Over-strict control: `timeoutMs: 500`, a body that arrives in two chunks a few ms apart and completes | resolves the normal typed outcome for each action | Abort at the headers (timer `ms` = 0 after headers, or clear-then-abort) → red. Proves the bound does not cut a slow-but-valid body |
| L5 | A non-JSON 2xx (existing test) | [r2] (M2) still "2xx body is not JSON", now followed by the parse error's text | Map every body-read error to "not read within" → red |
| L6 | A fetch that throws `UnfilteredExtensionsQueryError` | `LeaseUnavailableError` whose message contains the refusal's text (today's behaviour, pinned so the change cannot alter it) | Let the outer catch wrap a `LeaseUnavailableError` a second time → message changes → red. [r2] (M5) It asserts the refusal text only, NOT the "unreachable" label, which the new item may correct |
| L7 [r2] (M1) | A fetch whose body read throws a plain non-abort `Error("boom")` after a valid start, signal not aborted (e.g. a stream that errors at once) | `LeaseUnavailableError` containing "boom"; NOT "gave no answer within" | Give every non-`LeaseUnavailableError` the timeout wording → red |

### 4b. Callers, through a real `LeaseClient` with the router fetch (`orchestrator.test.ts`, `cli.test.ts`)

Pass `new LeaseClient({ ...CFG, timeoutMs: 20 }, router)` as `lease.client` in the existing
`runSession` lease config (or drive `LeaseSession` through `runSession` as the existing lease tests
do). Count calls per action on the router.

| # | Stalled action / path | Expect | Wrong-fix red-check (each one revert or wrong mapping, in turn) |
|---|---|---|---|
| C1 | ReleaseLease at `finish` (status reads idle) | session ends; warning `lease-release-failed`; no `lease-release-refused`; ReleaseLease called once | Revert → times out. Map timeout to `{released:true}` → no warning → red |
| C2 | GetOperationStatus at `finish` | `lease-marker-read-failed`; ReleaseLease count 0 | Map timeout to an idle status → ReleaseLease 1 → red |
| C3 | Marker non-idle at finish, RenewLease stalls in `leaseProvablyNotOurs` | [r2] (M7) `lease-ownership-unconfirmed`; recycle recorded (quarantine store); ReleaseLease 0; no `lease-marker-foreign` | Map timeout to `renewed:false` → foreign warning, no recycle → red |
| C4 | R249 keep-lease: BeginPublish `begun:false`, renew ok, marker set; then every later action stalls | `lease-kept-under-marker`; ReleaseLease 0 | Revert → times out |
| C5 | RenewLease in the heartbeat (drive `pulse` via the fake timers) | `lease-renew-unanswered`; not latched; `lostBatchIndex` undefined; the NEXT pulse issues a RenewLease again | Revert → times out. Map to `renewed:false` → latched → red |
| C5b [r2] (I1) | RenewLease stalls; `finish()` runs while that tick's first renew is open (status idle, ReleaseLease answers `released:true`); afterwards any RenewLease answers `renewed:false` | no latch (`safety.isUnsafe` false); `lostBatchIndex` undefined; at most ONE RenewLease call; no `lease-lost` text anywhere | Remove the `#stopped` check before the retry → second RenewLease answered `renewed:false` → latched → red. Separately: keep that check but remove the `!this.#stopped` guard on `renewed:false`, and make the FIRST renew's late answer `renewed:false` (a stalled-then-answered body, released by the test after `finish()`) → latched → red. One red test per guard |
| C6 | AcquireLease | rejects `LeaseUnavailableError`; AcquireLease called once; no recycle recorded | Revert → times out |
| C7 | BeginPublish, hook path (`runLeaseHook`) | `after-lease-acquired-uncertain`, latched; error has no `beginPublishRefusal`; ReleaseLease only if the later status reads idle | Give the timeout error a `beginPublishRefusal` → `after-lease-acquired-refused` → red |
| C7b [r2] (M6) | BeginPublish, batch path (`deployOnce` → `publish`), later status reads idle | the session fails with the `LeaseUnavailableError`; no R90 deploy-history row; no version-conflict retry (BeginPublish called once); ReleaseLease 1 | Revert → times out |
| C8 | GetOperationStatus in `reconcileLostAck` (a RunMutant lost ack) | `lease-reconcile-failed`; outcome unresolved; RecoverOp 0; no killed verdict | Map timeout to `completed:true` → red |
| C9 | EndPublish, then the reconciling status read also stalls | latched, recycle recorded, RecoverOp 0 | Revert → times out |
| C10 | ForceResetLease in `performForceResetLease` (`cli.test.ts`) | rejects `LeaseUnavailableError`; never `{outcome:"reset"}`; [r2] (M3) the CLI-level message says the reset "may have been applied" | Revert → times out. Drop the "may have been applied" wording → red |

Existing `lease.test.ts` and orchestrator lease tests stay green unchanged (they answer at once).

## 5. itest:hang

It IS on the path: the gate's legs pass `new LeaseClient(odataCfg)` as `lease.client` (acquire,
heartbeat, BeginPublish/EndPublish, GetOperationStatus for `nextOpSeq`/`resyncOpSeq`/reconcile/
`finish`, ReleaseLease), the OFF leg reconciles its lost ack through `reconcileLostAck`, and its
`teardown` calls `forceResetLease`. Live lease answers come back well inside 30 s, so nothing
should move. [r2] (M7) No leg stalls a lease body live, so the gate is only a NO-REGRESSION
witness: it shows the bound cuts no live answer and the `pulse` guards change no figure. The unit
tests in section 4 are the evidence for the fix itself. Pre-commitment:
`/coord/handoff/R-504/hang-precommitment.md`, committed as
`docs/superpowers/specs/2026-10-08-r504-hang-lease-body-bound-precommitment.md` BEFORE the live run.
Run: `LETHAL_ITEST_HANG=1 bun run itest:hang` (foreground). Any difference is a BLOCK, never a
re-record.

`itest:bcdev` and `itest:tables` also lease through `LeaseClient`; not required for this item, but
a builder with time may run `itest:bcdev` (3 / 12 / 4) as a second witness.

## 6. Builder rules

- Edit/Write tools only, also for red-check reverts. No `sed -i`, `bun -e`, heredoc edits.
- Red-check every row of section 4 one revert at a time (`mutation-red-checker` subagent); report
  red and restored-green output. One red test per direction, [r2] (I1) and one per `pulse` guard.
- No new error class. `LeaseUnavailableError` already extends `Error` directly; keep it so. No `!`.
- Never read `lethal.config*.json`. No new config key (`timeoutMs` is the existing
  `ActivationConfig` field).
- Loop from the repo root: native parser if fresh worktree, `bun run typecheck`,
  `rm -rf packages/*/dist`, `bun scripts/verify.ts`. `bunx biome check` on touched files only.
- CHANGELOG `[Unreleased]`, Fixed: "A lease call whose answer BC starts but never finishes no
  longer holds the session forever. The lease client's 30 s timeout now covers the response body
  as well as the headers, and an unanswered call fails the way an unreachable one does: never a
  kill, and never a lease reported as released. A heartbeat renew answered after the session
  stopped no longer reports the lease as lost (R504)."
- [r2] (M4, M5) File TWO new roadmap items, each in its own file. Run `ls docs/roadmap/`
  immediately before writing EACH one (other sessions commit concurrently); cite names, not lines:
  - (M4) The same R191 class elsewhere: `HarnessVerifier`'s `HarnessInfo` reads in `harness.ts`
    (two sites), `postOData` in `activation.ts`, and `readRegisteredArtifact` in
    `deployment-verifier.ts`. The last two also do `res.json().catch(() => ({}))`, a plausible
    empty default (this project's signature bug). Note that `lethal force-reset-lease` stays only
    partly bounded until it lands, because `HarnessVerifier.verify()` runs first.
  - (M5) `postLeaseAction` wraps R-496's `UnfilteredExtensionsQueryError` into
    `LeaseUnavailableError` labelled "unreachable": the refusal's type is lost on the lease path,
    and the label is a wrong diagnosis.
  Then `bun scripts/roadmap-index.ts`.
- Roadmap: after the commit, set `docs/roadmap/R504.md` status to `fixed in <commit>, live gate
  pending`; after itest:hang passes, `done (<commit>)`. Run `bun scripts/roadmap-index.ts` and
  `bun test scripts/line-citations.test.ts` (names, not file:line).
- Push only after green; both CI jobs (Windows check, unit-linux) green; run id in the submit note.

## 7. Not changed

Callers' code in `orchestrator.ts` (except [r2] (I1) the two `pulse` guards) and `cli.ts` (except
[r2] (M3) the force-reset message for a body stall), `RunMutantTransport` (beyond importing the
moved `bounded`), `refuseRedirects`, R-496's wrapping of fetch errors in `postLeaseAction` (filed,
M5), `HarnessVerifier`/`postOData`/`readRegisteredArtifact` (filed, M4), the control app.
