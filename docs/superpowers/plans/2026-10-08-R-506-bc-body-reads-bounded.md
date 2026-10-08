# R-506 plan (r2): bound every BC body read, no empty defaults (R506), and let R-496's refusal out of the lease path (R507)

[r2] r2 follows `/coord/handoff/R-506/review-r1-opus-adversary.md`: I1 to I4, M1 to M8, and its
"outside this plan" point (section 10). Changes are marked [r2].

Base: master `dc4a51ec` (R-504 merged; `bounded` lives in `packages/runner/src/bc-fetch.ts`, and
`postLeaseAction` in `lease.ts` already keeps its abort armed through the body). Source read at
`/work/lethal-wt/r504`, which has the same code. Build in your own worktree on task branch
`lethal/r506`.

Words used here:
- **body stall**: BC sends a 2xx status and headers, then never finishes the body.
- **deaf**: a fetch, or a body stream, that ignores its abort signal. Real Bun honours the abort
  during a body read (measured, R191); deaf fakes stand in for anything that does not.
- **empty default**: a value like `{}`, `[]` or `""` returned when nothing was read, so "nothing
  read" looks like "nothing there".

## 1. Census

Method: grep over `packages/runner/src` and `cli.ts` for `res.json(`, `.text()`, `.arrayBuffer(`,
`.blob(`, `catch(() => ({}))`, `catch(() => [])`, `catch(() => "")`, `?? {}`, `?? []`, every
`fetchFn(`/`fetch(` call and every `clearTimeout` near one. `cli.ts` makes no HTTP call of its own:
it reaches BC only through `HarnessVerifier`, `LeaseClient`, `DeploymentVerifier` and
`PermissionCanaryClient`. Other packages make no HTTP call. `scripts/` probes are EXCLUDED: no
product file imports from `scripts/` (checked), and they gain any fix through the classes they use.

### 1a. HTTP body reads

"Bounded" means: the abort timer is still armed while the body is read, AND/OR a `bounded(...)`
race covers the read.

| # | File, function | What it reads | Body read bounded today? | Empty default? | Who consumes the value | This plan |
|---|---|---|---|---|---|---|
| S1 | `harness.ts` `HarnessVerifier.fetchHarnessInfo` | 2xx `res.json()` of `LethALControl_HarnessInfo` | **No.** Timer cleared in the `finally` around `fetch` | No (a failed read becomes `undefined`, then throws "returned no string `value`"; so "unread" and "absent" share one message) | `verify()` (bcdev-backend deploy/attach readiness; lease `serverGeneration`, `cli.ts` session wiring; env-tool `verifyHarness`; `performForceResetLease`; hang teardown), `checkReachable()`, `fetchLease()`, `fetchControlVersion()` (doctor; digest-inputs bytes mode) | Fix |
| S2 | same | non-2xx `res.text()` (error text only) | **No** | `""` on failure, diagnostic only: the HTTP error is still thrown | same | Fixed by S1's change (the read moves inside the deadline) |
| S3 | `harness.ts` `HarnessVerifier.fetchApiRows` | 2xx `res.json()` of a BC API list (`companies`, `extensions?$filter=id eq <GUID>`) | **No** | No (unread → "returned no `value` array") | `fetchCompanies` (doctor `companies`; `fetchExtensionRows`), `fetchExtensionInstalled` (doctor `test-app`), `fetchInstalledVersions` (digest-inputs bytes mode) | Fix |
| S4 | same | non-2xx `res.text()` | **No** | `""`, diagnostic only | same | Fixed by S3's change |
| S5 | `activation.ts` `postOData` | 2xx `res.json()` of `MutationControl_<action>` | **No** | **YES: `res.json().catch(() => ({}))`** | `MutationControlClient.setActive`/`clearActive`. **No product caller:** the target no longer emits a `MutationControl` codeunit (`schemata/project.ts`); only tests and the `index.ts` re-export use it | [r2] (I1) **DELETE** (section 3a) |
| S6 | `deployment-verifier.ts` `DeploymentVerifier.readRegisteredArtifact` | 2xx `res.json()` of `LethALControl_RegisteredArtifact` | **No** | **YES: `res.json().catch(() => ({}))`**, then `value` undefined → `null` → `unavailable` "server did not report an artifact id". Not a false accept today, but the diagnosis is wrong | `verify()` → `bcdev-backend` `deploy` (`decidePublishOutcome`) and `attach` | Fix |
| S7 | `permission-canary.ts` `PermissionCanaryClient.probe` | 2xx `res.json()` of `LethALControl_PermissionCanary` | **No** (120 s timer cleared at the headers). Not named in R506; same class | No (throws `PermissionCanaryUnavailableError`) | `runPermissionCanary` → `orchestrator` `runPermissionCanaryQuietly` (bcdev runs, via `cli.ts` `permissionCanaryFor`) | Fix |
| S8 | `lease.ts` `postLeaseAction` / `readLeaseAnswer` | 2xx `res.json()` of every `LethALControl_<lease action>` | **Yes** (R504) | No | every `LeaseClient` action (section 4) | Move onto the shared helper; R507; review minors |
| S9 | `bcdev-backend.ts` `fetchPublishedAppPackage` | 2xx `res.arrayBuffer()` from `dev/packages` | Abort armed through the body (timer cleared after the read); no race | `null` on any failure, documented as "could not read". Not an empty confirmation: every consumer turns `null` into a refusal or `unavailable` (`digest-inputs` `openPackage` throws `DependencyUnreadableError`; `publishTestApp` throws `resident-unreadable` before the fence, or `unavailable` after it; a 0-byte body is refused by `openPackage` and cannot hash-match) | digest-inputs bytes mode (`readSystem`, `readControl`), R373 test-app read-back | Route through the helper for the deaf case only; keep `null` |
| S10 | `run-mutant-transport.ts` `postAction` (StopHungRun, StopHungRunAt, GetOperationStatus, GetOpAnswer) | 2xx `res.json()`; non-2xx `res.text().catch(() => "")` for the message | Yes: every caller passes `timeoutMs` (abort armed through the body, R236b) and races with `bounded` (R-204b, R503) | `""` only inside an error message | stop hook, watchdog, kept-answer read-back | Unchanged, except `bounded`'s timeout becomes a typed error |
| S11 | `run-mutant-transport.ts` `runMany` (RunMutantMany) | `res.text()` | Yes: the hard timer settles only after the body | No | grouped verdicts | Unchanged |
| S12 | `run-mutant-transport.ts` `execute` (RunMutant) | `res.text()`; on a 408 after our stop `res.text().catch(() => "")` | Yes (R191, `settleTimers` after the body) | `""` on the 408 path only makes `isAlStopResponse` false, which falls through to `in-flight-unknown` (fail closed) | single-test verdicts | Unchanged |

### 1b. Checked and excluded

- Subprocess output, not BC responses: `line-filter.ts`, `publisher.ts`, `campaign-subcommands.ts`
  (`new Response(proc.stdout).text()`), `al-runner-*.ts` and `env-tool.ts` timers.
- `?? {}` / `?? []` hits on data that is not a BC response (config, report, AST, local `app.json`
  in `test-app-publish.ts`), or on BC/MCP data that is checked and thrown on right after
  (`bcdev-backend.ts` `firstText` throws on no text; `idRanges` throws `ArtifactPrepareError`;
  `run-mutant-transport.ts` coverage rows throw on a bad field).
- So: **2 empty defaults (S5, S6)**; [r2] **6 sites change (S1, S3, S6, S7, S8, S9; S2/S4 come
  along) and 1 is deleted (S5).**

## 2. The shared helpers (bc-fetch.ts, next to `bounded`)

One new error class, two small functions, and a factory argument on `bounded`. Nothing else is new.

```ts
/** R506: a BC call whose answer was not read: no complete answer within the bound ("timeout"),
 *  or a 2xx body that could not be read or parsed ("unreadable"). Extends Error directly. */
export class BcAnswerUnreadError extends Error {      // [r2] (M4) r1 called it BcCallTimeoutError
  constructor(message: string, readonly kind: BcReadFailure) { super(message); this.name = "BcAnswerUnreadError"; }
}

export type BcReadFailure = "timeout" | "unreadable";
export type BcFailFactory = (message: string, kind: BcReadFailure) => Error;

/** R-204b; R-506: rejects with `onTimeout(msg)`, the CALLER's own error instance. */
export function bounded<T>(p, ms, what,
  onTimeout: (m: string) => Error = (m) => new BcAnswerUnreadError(m, "timeout")): Promise<T>
// message unchanged: `${what} gave no answer within ${ms} ms`

/** R506: ONE deadline over fetch + body read + parse. */
export async function withDeadline<T>(ms: number, what: string,
  call: (signal: AbortSignal) => Promise<T>, fail: BcFailFactory): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms); // armed BEFORE bounded's guard (R-503 order)
  const p = (async () => { try { return await call(controller.signal); } finally { clearTimeout(timer); } })();
  return bounded(p, ms, what, (m) => fail(m, "timeout"));
}

/** R506: the 2xx body as JSON. Never an empty value: an unread body THROWS. */
export async function readJsonBody(res: Response, signal: AbortSignal, what: string, ms: number,
  fail: BcFailFactory): Promise<unknown> {
  try { return await res.json(); }
  catch (err) {
    if (signal.aborted) throw fail(`${what} body not read within ${ms} ms`, "timeout");
    throw fail(`${what} 2xx body could not be read or parsed: ${String(err)}`, "unreadable");
  }
}
```

Rules:
- `withDeadline` never inspects or rewraps an error from `call`. The ONLY error it makes is the one
  `bounded` makes through the factory, so a timeout is told apart by identity (R-504 review
  minor 1), never by text, and no `settled` flag exists. Each site already turns its own failures
  into its own typed error inside `call`.
- `bounded`'s default makes `BcAnswerUnreadError(kind "timeout")`; `run-mutant-transport.ts`'s
  callers keep the default. None of them branches on the error's type or text today (they `catch`
  → "failed poll" / note text), so this changes no behaviour there.
- Same `ms` for the abort and the race at every site (each site's existing timeout). Which of the
  two ends a stalled body is a timer race; no test may depend on it (R-504 I2).

**Why one new class and not an existing one.** The lease and canary sites keep their own class
(`LeaseUnavailableError`, `PermissionCanaryUnavailableError`), because each one's callers already
handle it. The harness sites cannot: `env-tool-session.ts` reads a `HarnessVerificationError` as
"the control app is missing" and REPUBLISHES it, and a republish disturbs a concurrent session's
lease (that is why `HarnessAuthError` and `MultiTenantContainerError` extend `Error` directly).
A timeout is not evidence the app is missing, and a 2xx proves it answered, so neither is a reason
to republish. [r2] (M4: the routing fix is small, so it is taken) Both kinds get
`BcAnswerUnreadError`, which extends `Error` directly, so that catch rethrows it. It is also
`bounded`'s typed timeout, so it is one class, not two. `DeploymentVerifier` uses it too (its
`verify()` catch maps every error to `unavailable` anyway).

## 3. Per site: the change, and what the error now means

| # | Change | Timeout → | Unreadable / not JSON / empty → | What the caller does with it | Why it can never be a kill, a false verified/deployed, or an empty confirmation |
|---|---|---|---|---|---|
| S1 `fetchHarnessInfo` | Body of the method moves into `withDeadline(this.cfg.timeoutMs ?? 30_000, "HarnessInfo", …)`; the 2xx read uses `readJsonBody`; the non-2xx `text()` read runs under the same armed signal. [r2] (I2) The fetch `catch` (header phase) gains, after the R-496 rethrow: `if (signal.aborted) throw new BcAnswerUnreadError("HarnessInfo gave no answer within <ms> ms: <err>", "timeout")`; a NON-abort fetch error stays `HarnessVerificationError` "unreachable" | `BcAnswerUnreadError` in EVERY phase ([r2] I2: the class no longer depends on which timer fires first) | [r2] (M4) `BcAnswerUnreadError` kind `unreadable`, "HarnessInfo 2xx body could not be read or parsed: …". A PARSED body without a string `value` stays `HarnessVerificationError` (a wrong-build shape) | `verify()` and the other public methods throw it. bcdev deploy/attach and lease acquire fail (session fails before any publish or run). env-tool `verifyHarness` rethrows it (no republish). doctor: one failed check. digest-inputs: `DependencyUnreadableError`. `performForceResetLease`: fails before `ForceResetLease` is sent (plain wording, correct: nothing was sent) | `HarnessDetails` (and so `serverGeneration`, the lease's precondition) exists only from a parsed `HarnessInfo`. No verdict depends on it. The force-reset path is now fully bounded |
| S3 `fetchApiRows` | Same shape; `what` is the list name. [r2] (I2) Same `signal.aborted` line in the fetch `catch`. R433/R441 guards and the redirect branch unchanged and inside `call` | `BcAnswerUnreadError` | [r2] (M4) `BcAnswerUnreadError` kind `unreadable`. A parsed body with no `value` array stays `HarnessVerificationError` | doctor checks fail with the message; `fetchInstalledVersions` → digest-inputs `DependencyUnreadableError` | Rows exist only from a parsed `value` array. An unread body can no longer reach `fetchExtensionInstalled`'s "not installed" or `fetchInstalledVersions`' `[]` |
| S6 `readRegisteredArtifact` | Into `withDeadline(this.cfg.timeoutMs ?? 30_000, "LethALControl_RegisteredArtifact", …)` with `readJsonBody`; **the `{}` default is deleted** | `BcAnswerUnreadError` | `BcAnswerUnreadError` kind `unreadable` | `verify()`'s catch → `{status:"unavailable", detail}` (an `UnfilteredExtensionsQueryError` still escapes as itself). deploy: `decidePublishOutcome` → `indeterminate` → `DeploymentError` (session fails, the fence leaves the marker and records a recycle), or `failed` if the publish itself failed (as for any `unavailable` today). attach: `InstalledArtifactError("unavailable")` | `accepted` needs `reported === expected` where `reported` is a PARSED string and `expected` is validated 32-hex; an unread body produces no string at all. `mismatch` needs a parsed valid id. "No artifact registered" (`""`) can only come from a parsed `value: ""`. A valid JSON body with no `value` still gives `null` → "did not report", now the ONLY way to that message |
| S7 `PermissionCanaryClient.probe` | Into `withDeadline(this.timeoutMs, "LethALControl_PermissionCanary", …)` with `readJsonBody`. [r2] (M5) Test seam: an optional third constructor parameter `timeoutMs = PERMISSION_CANARY_TIMEOUT_MS` | `PermissionCanaryUnavailableError` | `PermissionCanaryUnavailableError` ("… could not be read or parsed: …") | `runPermissionCanary` → verdict `inconclusive` with the message | `mocked`/`not-mocked` need a parsed inner object; `inconclusive` is the measured-nothing answer. The canary never scores a mutant |
| S8 `postLeaseAction` | Replaced by `withDeadline(ms, "LethALControl_<action>", (signal) => readLeaseAnswer(…, signal, ms), (m) => new LeaseUnavailableError(m))`; `readLeaseAnswer` uses `readJsonBody`. Its `settled` flag and outer `catch` are deleted. R507 in section 4; `rejectedStatus` in section 5 | `LeaseUnavailableError` (R504 wording kept: "body not read within", "gave no answer within") | `LeaseUnavailableError` "… 2xx body could not be read or parsed: …" | unchanged from R504's section 3 table | unchanged from R504: no lease action produces a verdict; only a parsed `released:true` is a release, only a parsed `granted:true` an acquire |
| S9 `fetchPublishedAppPackage` | Wrap the existing `fetch` + `arrayBuffer` in `withDeadline(timeoutMs, "dev/packages", …, (m, k) => new BcAnswerUnreadError(m, k))`; the existing `catch` still returns `null` for everything except `UnfilteredExtensionsQueryError`. [r2] (M5) Test seam: a third parameter `timeoutMs = PUBLISHED_PACKAGE_TIMEOUT_MS` | `null` (documented "could not read") | `null` | see census | `null` is never bytes; every consumer refuses or reports `unavailable` on it |

Update each changed function's doc comment in one line ("R506: the bound spans the headers AND the
body; an unread body throws, never an empty value").

### 3a. [r2] (I1) Delete `postOData` and `MutationControlClient`

- `activation.ts`: delete `postOData`, `MutationControlClient`, `DEFAULT_TIMEOUT_MS` and the
  imports only they use. KEEP `FetchFn` and `ActivationConfig` (imported across `src/`, tests and
  itests). Reword `ActivationConfig.timeoutMs`'s comment so it no longer describes `postOData`.
  `ActivationFailure` (`failure-classes.ts`) and `isRetrySafe` (`operation-outcome.ts`) stay: other
  code uses them.
- Delete `tests/activation.test.ts` (it tests only the deleted class).
- `tests/extensions-query-refusal.test.ts`: delete the loop "an activation POST answered by a
  redirect (…) is dispatched, not retry-safe" and the `MutationControlClient` import. Keep every
  other test in that file. Drop `isRetrySafe`/`ActivationFailure` imports there only if they become
  unused.
- Doc comments that cite `postOData` (`lease.ts`, `run-mutant-transport.ts`,
  `permission-canary.ts`, `deployment-verifier.ts`): reword in one line each (e.g. "a manual
  AbortController, as every BC client here uses"); `grep -rn postOData packages` must be empty.
- `index.ts` keeps `export * from "./activation"` (the types remain).
- Why deletion is safe: no product caller (the target stopped emitting `MutationControl` in Layer
  5C-A). It was also the only site that turned R-496's refusal into another class.

## 4. R507: R-496's refusal on the lease path

### 4a. The change

`readLeaseAnswer`'s fetch `catch`:
- [r2] (I4a) `UnfilteredExtensionsQueryError` → rethrown as a NEW `UnfilteredExtensionsQueryError`
  (same class) with message "`LethALControl_<action> answered with a redirect that was not
  followed: <original message>`". The original names only the redirect's destination; this names
  the request. `withDeadline` passes it through untouched. This is the run-ending refusal
  everywhere else (harness, deployment verifier, canary, doctor, digest-inputs, and the transport's
  `refusalBoundary`).
- `BcRedirectRefusedError` → stays a `LeaseUnavailableError`, relabelled
  "`LethALControl_<action> answered with a redirect that was not followed: <err>`". On every other
  path a non-R433 refused redirect is that site's ordinary failure, not a run-ender, and keeping
  the class keeps every lease caller's fail-closed handling (and never sets `beginPublishRefusal`).
  Only the wrong word "unreachable" goes.
- Every other fetch error: unchanged ("unreachable: …").

### 4b. What changes for each caller when the refusal escapes

Today every one of them sees a `LeaseUnavailableError`. Now:

| Caller | Today's handling of a throw | With the refusal itself |
|---|---|---|
| `acquireSessionLease` (`acquire`) | no catch; the session fails | Same, but the session fails with `UnfilteredExtensionsQueryError`. No lease was learned of; no recycle |
| `LeaseSession.nextOpSeq` / `resyncOpSeq` (`getOperationStatus`) | no catch; the session fails, `finish` runs op-gated | Same, as itself |
| `publish` (`beginPublish`) → `runLeaseHook` | not `beginPublishRefusal` → latch + `after-lease-acquired-uncertain` + rethrow | Same branch (it is not a confirmed-terminal publish failure), rethrown as itself |
| `publish` (`beginPublish`) → `deployOnce` | the deploy error; `classifyDeployFailure` → `undefined` (no R90 row) | Same; its message has no BC version sentence, so no version-conflict retry |
| `pulse` (`renew`) | **swallowed**: one retry, then `lease-renew-unanswered` | **Would be swallowed. Fixed by 4c** |
| `onBeginPublishRefused` (`renew`, `getOperationStatus`) | **swallowed** into `noteLeaseLost` → `"lost"` | swallowed as before (fail-closed: nothing released) **+ 4c** |
| `endPublish` → `reconcileStrandedPublish` (`getOperationStatus`, `recoverOp`) | swallowed into latch + recycle (RecoverOp: original error rethrown) | same fail-closed handling **+ 4c**; a refused `recoverOp` is rethrown as itself (R361 path) |
| `reconcileLostAck`, `classifyRetryRefusal`, `pollUntilOpClears` | swallowed into `unresolved` / `genuine` / `false` + warning | same fail-closed values (never `completed`, never RecoverOp) **+ 4c** |
| `finish` (`getOperationStatus`, `renew` in `leaseProvablyNotOurs`, `release`) | swallowed into `lease-marker-read-failed` / `lease-ownership-unconfirmed` / `lease-release-failed` | same (no release on an unread marker; never "released" without a parsed `released:true`) **+ 4c** |
| `performForceResetLease` → `forceResetLeaseFromCli` | `LeaseUnavailableError` branch: "may have been applied" | [r2] (I4b) see 4d |
| hang `teardown` | generic catch → loud `teardown FAILED` | same |

### 4c. Never swallowed: record, latch, surface at teardown

One change in `LeaseSession` instead of edits to eleven `catch` blocks. In its constructor, wrap
`d.client` once (an explicit object with the seven `LeaseApi` methods, each
`(...a) => inner.x(...a).catch(note)`), where `note(err)`:
- if `err instanceof UnfilteredExtensionsQueryError`: keep the FIRST one in `#refusal`, latch
  `safety.latchUnsafe("refused unfiltered extensions query on the lease path: <msg>")` (no
  `lostBatchIndex`: this is not lease loss), and `console.warn` a later one (never dropped).
  [r2] (M1) Once `takeRefusal()` has run, a `#refusalTaken` flag is set and EVERY later refusal is
  `console.warn`ed instead of stored (a renew in flight at teardown must not lose it);
- always rethrows `err`, so every existing `catch` still does its fail-closed thing.

`takeRefusal()` returns and clears `#refusal` and sets `#refusalTaken`. `closeLeaseScope` takes the
lease session's refusal after `finish()`, then the backends' late refusals. [r2] (M2) It returns
the FIRST and `console.warn`s every other one it collected (today it returns at the first backend
hit and never asks the rest). `surfaceLateRefusal` throws it, or warns if the session is already
failing. [r2] (M3) Its warning must fit both sources: "a refused unfiltered extensions query (on
the lease path, or after the session's last call) while the session was already failing: <msg>".
When it throws while `safety.isUnsafe`, it first `console.warn`s "`[lethal] the session was
latched: <safety.reason>`", so a latch reason that is NOT the refusal (a quarantine, a lease loss)
is never hidden behind it. Pass `safety` (already an argument of `closeLeaseScope`) through.

A latched session is not "failing" (`SessionUnsafeError` is absorbed at the batch loop), so the run
ends by throwing the refusal ITSELF. So: the latch stops new work at the next guard, `finish` still
runs op-gated (it cannot release over an unreadable marker), and the session ends loudly with the
original type. A refusal that already propagated directly (acquire, nextOpSeq, beginPublish) is
also logged once more by `surfaceLateRefusal`'s warning; accepted.

### 4d. [r2] (I4b) force-reset-lease

- `performForceResetLease` wraps ONLY the `forceResetLease(...)` call: an
  `UnfilteredExtensionsQueryError` from it is rethrown as a new `UnfilteredExtensionsQueryError`
  whose message adds "ForceResetLease was sent and BC answered with a refused redirect, so the
  reset may have been applied; re-run `lethal force-reset-lease` (safe)" + the original text. A
  refusal from `HarnessVerifier.verify()` before it passes through untouched (nothing was sent to
  reset).
- `forceResetLeaseFromCli`'s catch: `if (err instanceof UnfilteredExtensionsQueryError) throw err;`
  first (never wrapped in a plain `Error`). Then the `LeaseUnavailableError` branch of 5.3.
- A non-extensions refused redirect on ForceResetLease is a `LeaseUnavailableError` without
  `rejectedStatus`, so it gets the same "may have been applied" wording (5.3).

## 5. R-504 build-review minors (`/coord/reviews/R-504`)

1. **Timeout by identity.** Done by section 2: `bounded` takes an error factory and rejects with
   the caller's own instance; `withDeadline` adds no catch; `postLeaseAction`'s `settled` flag and
   outer `catch` go. Transport callers get the typed default. Tests B1-B3.
2. **L7's comment** (`lease.test.ts`): replace with "L7: a body read that errors for a reason other
   than our abort keeps its own text and gets the 'could not be read or parsed' wording, never a
   timeout wording. It pins `readJsonBody`'s non-abort branch, not the deadline." Update its
   asserts to the new wording (the test keeps asserting neither timeout phrase).
3. [r2] (I3) **"May have been applied" unless provably not applied.** r1's `answerLost` flag leaned
   the unsafe way (a site that forgot to set it would silently drop the warning). Inverted: add
   `readonly rejectedStatus?: number` to `LeaseUnavailableError`, set ONLY in `readLeaseAnswer`'s
   non-2xx branch (BC answered with an error status). The cli branch becomes:
   `err instanceof LeaseUnavailableError && err.rejectedStatus !== undefined` → plain "could not
   complete the reset" wording; every OTHER `LeaseUnavailableError` → "may have been applied".
   Errors that are not `LeaseUnavailableError` (from `HarnessVerifier`, before anything was sent)
   keep the plain wording. Set it through the constructor's options (`exactOptionalPropertyTypes`).
   Tests C10, C10c, C10d, C10e.
4. **Wording.** A non-abort body-read error says "`<what>` 2xx body could not be read or parsed:
   `<err>`" at every site, through `readJsonBody`. Update the R504 test that pins "2xx body is not
   JSON" (`lease.test.ts`, the ReleaseLease not-JSON test).

## 6. Tests

No wall-clock asserts; a missing bound goes red by bun's 5 s test timeout. Use `timeoutMs: 20`
(or the [r2] M5 seams) per site. Reuse `tests/helpers/lease-wire.ts` (`stalledResponse`,
`stalledBody`, `deafBody`, `deafFetch`): they are not lease-specific. Add there `notJsonBody()`
(200, body `<html>`), [r2] `emptyBody()` (200, zero bytes) and `erroringBody()` (200, a stream that
errors at once). Each test names its red-check: one revert at a time with Edit/Write, confirm the
named test goes red, restore.

### 6a. Helpers (`bc-fetch.test.ts`)

| # | Case | Expect | Red-check / control |
|---|---|---|---|
| B1 | `bounded(never, 20, "x", () => sentinel)` | rejects with `toBe(sentinel)` | Ignore the factory → not the same object → red |
| B2 | `withDeadline` whose `call` rejects with a plain `Error("x gave no answer within 20 ms")` (an imposter) | the SAME error instance passes through; the factory is never called | Classify by message (or reintroduce a `settled`/catch that rewraps) → factory called → red |
| B3 | `bounded(never, 20, "x")` with no factory | `BcAnswerUnreadError`, kind `timeout`, message "x gave no answer within 20 ms" | Default back to `new Error` → red |
| B4 | `withDeadline` + `readJsonBody` over `stalledBody` | [r2] (M7) FIRST `await` the rejection, THEN assert `aborted()` true; factory kind `"timeout"`. A comment in the test says it relies on equal-delay timers firing in the order they were set (the abort is set before `bounded`'s guard), as R504's L1 does | Clear the timer when `fetch` resolves (inside `call`, before the read) → the stream never sees the abort → red |
| B5 | same over `deafBody` and `deafFetch` | kind `"timeout"`, "gave no answer within" | Drop the `bounded` race → test times out |
| B6 | `readJsonBody` over `notJsonBody`, `emptyBody` and `erroringBody` | kind `"unreadable"`, "could not be read or parsed", carries the parse/stream text | Map every failure to `"timeout"` → red; return `{}` on failure → no throw → red |
| B7 | Over-strict control: bound 500, a body sent in two chunks a few ms apart | resolves the parsed object | Abort at the headers → red. Proves the bound never cuts a slow valid body |

### 6b. Per site (stalled / deaf / unparseable, each through the real class)

| # | Site, file | Stalled body | Deaf body / deaf fetch | Unparseable or empty 2xx | Red-check |
|---|---|---|---|---|---|
| H1-H3 | S1 `fetchHarnessInfo`, `harness.test.ts` (via `verify()` and `checkReachable()`) | rejects `BcAnswerUnreadError`, NOT `HarnessVerificationError` | same | [r2] (M4) `BcAnswerUnreadError` kind `unreadable`, NOT `HarnessVerificationError` (both `notJsonBody` and `emptyBody`) | Revert S1 → stalled/deaf time out. Make the timeout or the unreadable kind a `HarnessVerificationError` → red |
| H4 | S1 via env-tool `startEnvToolSession` (`cli-envtool.test.ts` or its own file), `verifyHarness` = a real `HarnessVerifier` over `stalledBody`, then over `emptyBody` | the start rejects with `BcAnswerUnreadError`; the publisher's `publishFile` called **0** times (no control-app republish) | — | same, `publishFile` 0 | Map either kind to `HarnessVerificationError` → `publishFile` 1 → red |
| H8 [r2] (I2, M6) | S1 and S3: a fetch that never resolves but HONOURS its abort (a timeout before the headers) | rejects `BcAnswerUnreadError` kind `timeout`, NOT `HarnessVerificationError` "unreachable" | | | Remove the `signal.aborted` line in the fetch catch → `HarnessVerificationError` → red |
| H9 [r2] | control: a non-abort fetch error (connect refused) | still `HarnessVerificationError` "unreachable" | | | Over-strict control for H8: the new line keys on the abort, not on every fetch error |
| H5-H7 | S3 `fetchApiRows` via `fetchInstalledVersions` and `fetchExtensionInstalled` | `BcAnswerUnreadError`; never `[]`, never `{installed:false}` | same | `BcAnswerUnreadError` kind `unreadable` | Revert → time out. Return `[]` on an unread body → resolves → red |
| D1-D3 | S6 `DeploymentVerifier.verify`, `deployment-verifier.test.ts` | `{status:"unavailable"}`, detail names "RegisteredArtifact" and a timeout phrase; never `accepted`, never `mismatch` | same | `unavailable`, detail "could not be read or parsed", NOT "did not report an artifact id" | Revert → time out. Restore `.catch(() => ({}))` → D3's detail becomes "did not report" → red |
| D4 | control: 200 `{}` (valid JSON, no `value`) | `unavailable` "did not report an artifact id" | | | Over-strict control: a parsed body must not become a read failure |
| P1-P3 | S7 canary, `permission-canary.test.ts`, constructed with `timeoutMs: 20` ([r2] M5) | `runPermissionCanary` → `inconclusive`, detail has a timeout phrase | same | `inconclusive`, "could not be read or parsed" | Revert → time out |
| K1-K2 | S9 `fetchPublishedAppPackage` (the test file that already covers it; find with grep), called with `timeoutMs: 20` ([r2] M5) | — | deaf body → resolves `null` within the bound | — | Drop the `withDeadline` wrap → times out |
| L1-L7 | S8, existing R504 tests in `lease.test.ts` | unchanged and green: they are the refactor's witness | | L5/L7 new wording (minors 2, 4) | R504's red-checks re-run on the new shape: clear the timer after `fetch` → L1 red; drop `bounded` → L2/L3 time out |

[r2] (I1) A1-A4 are dropped with the deleted code.

### 6c. R507

| # | Case | Expect | Red-check |
|---|---|---|---|
| R1 | `lease.test.ts`: a fetch that throws `UnfilteredExtensionsQueryError`, each of the eight actions | rejects with that class (not `LeaseUnavailableError`); [r2] (I4a) message starts "LethALControl_<action> answered with a redirect that was not followed:" and contains the original text | Restore the wrapping → red; rethrow the bare original → prefix missing → red. (Replaces R504's L6) |
| R2 | a fetch that throws `BcRedirectRefusedError` | `LeaseUnavailableError` whose message has "answered with a redirect that was not followed" and NOT "unreachable"; `rejectedStatus` undefined | Keep "unreachable" → red |
| R3 | `orchestrator.test.ts`: a real `LeaseClient` over the router fetch; RenewLease in `pulse` throws the refusal twice; then the session runs to its end | `runSession` rejects with `UnfilteredExtensionsQueryError`; the safety was latched (no batch scheduled after the tick); `lostBatchIndex` undefined; `finish` ran (GetOperationStatus called at teardown) | Remove the `note` wrapper → the session resolves with only `lease-renew-unanswered` → red. Remove only the latch → a later batch is scheduled → red (one red test per direction) |
| R4 | refusal on GetOperationStatus in `finish` | rejects with the refusal; ReleaseLease **0** | Map the refusal to an idle status → ReleaseLease 1 → red |
| R5 | refusal on GetOperationStatus in `reconcileLostAck` | outcome `unresolved`; RecoverOp 0; no killed verdict; session ends with the refusal | Remove the wrapper → session resolves → red |
| R6 | refusal on AcquireLease | rejects with the refusal; no recycle recorded | Restore wrapping in `readLeaseAnswer` → `LeaseUnavailableError` → red |
| R7 | refusal on BeginPublish, hook path | `after-lease-acquired-uncertain`, latched, rejects with the refusal (not `after-lease-acquired-refused`) | — (pins today's branch with the new type) |
| R8 | `cli.test.ts`: refusal on ForceResetLease; and [r2] (I4b) separately a refusal on the HarnessInfo read before it | ForceResetLease: rejects `UnfilteredExtensionsQueryError`, message contains "may have been applied" and the original text. HarnessInfo: rejects `UnfilteredExtensionsQueryError` WITHOUT "may have been applied" | Rethrow the bare error → wording missing → red; wrap in plain `Error` → class red; widen the wrap to cover `verify()` → the HarnessInfo case gains the wording → red |
| R9 [r2] (M6) | an earlier error (e.g. a deploy throws) AND a lease-path refusal recorded by `pulse` | `runSession` rejects with the EARLIER error; a `console.warn` line names the refusal (capture `console.warn`) | Make `surfaceLateRefusal` throw the refusal regardless → red; drop the warn → red |
| R10 [r2] (M1, M6) | a refusal noted AFTER `takeRefusal()` (a renew answered during teardown) | `console.warn` names it | Drop the `#refusalTaken` branch → the refusal is stored and never surfaced → no warn → red |
| R11 [r2] (M2) | a lease refusal AND a backend late refusal at teardown | throws the lease one; `console.warn` names the backend one | Return at the first hit without warning the rest → red |
| R12 [r2] (M3) | a session latched for another reason that then gets a lease refusal | throws the refusal; a warn line "the session was latched: <reason>" comes first | Drop the latch-reason warn → red |

### 6d. Minor 3 [r2] (I3)

| # | Case | Expect | Red-check |
|---|---|---|---|
| C10 | (R504, kept) ForceResetLease body stalls | "may have been applied" | Give the timeout a `rejectedStatus` → plain wording → red |
| C10c | ForceResetLease answers HTTP 500 | plain "could not complete the reset"; NOT "may have been applied"; `rejectedStatus` 500 | Revert to `instanceof LeaseUnavailableError` alone → red |
| C10d | ForceResetLease fetch throws a non-abort connect error | "may have been applied" (only an error status proves it was not applied) | Set `rejectedStatus` in the fetch catch → plain wording → red |
| C10e | ForceResetLease answers 2xx with inner `{}` (no `reset` boolean) | "may have been applied" | Set `rejectedStatus` on the shape errors → red |

## 7. Live gates

What reaches the changed sites live:
- `HarnessVerifier.verify` (S1): every bcdev-backend session (`deploy` readiness), the lease's
  `serverGeneration`, the hang teardown.
- `DeploymentVerifier.verify` (S6): every bcdev-backend `deploy`.
- `LeaseClient` (S8, R507): every leased gate; the hang teardown's `forceResetLease`.
- S3 (`fetchApiRows`): only doctor and bytes-mode digests; no frozen gate configures bytes mode.
- S7 (canary): only `lethal run` through `cli.ts`; no itest wires `permissionCanary`. S9: bytes
  mode and `itest:testapp` only. [r2] S5 is deleted.
- Nothing in `al-runner*` uses these sites: `itest:alrunner` is not needed.

| Gate | Host | Needed? | Why |
|---|---|---|---|
| `itest:hang` | Cronus28 | **Required** | Harness verify, deployment verify, the whole lease path incl. reconcile and the teardown's force-reset. R504's witness, same role |
| `itest:bcdev` | Cronus28 | **Recommended** (second witness, cheap) | Same three sites on the authoritative backend with frozen per-mutant figures |
| `itest:tables` | Cronus284 | Optional | Same code paths as bcdev, many more deploys; no fixture-specific branch in any changed site. Figures from `tables.itest.ts` `EXPECTED` (310 / 70 / 22), not CLAUDE.md's older prose |
| `itest:chunked` | Cronus284 | Optional | Same; its point is the chunked group path, which this plan does not touch |
| `itest:envtool` | host-only | Not run | Same sites through the env tool; host-only (ask the owner). Unit test H4 covers the republish decision |
| `itest:lease`, `itest:testapp` | Cronus28 | Optional | Drive `LeaseClient`/`fetchPublishedAppPackage` directly; no frozen figures, all probes must PASS |
| [r2] `lethal doctor --config <the sandbox-app config>` | Cronus28 | Optional | The only live witness for S1 (`checkReachable`, `fetchControlVersion`, `fetchLease`) and S3 (`fetchCompanies`, `fetchExtensionInstalled`): every check reads as before. Run the CLI with the path; do not read the file |

No leg stalls a body live, so every gate is a NO-REGRESSION witness only: it shows the bound cuts
no live answer and R507 changes no live path. The unit tests are the evidence for the fix.
Pre-commitments for all four BC gates: `/coord/handoff/R-506/precommitment.md`, committed as
`docs/superpowers/specs/2026-10-<dd>-r506-body-bound-precommitment.md` BEFORE any live run. Take a
coord lease on each container. Any difference is a BLOCK, never a re-record.

## 8. Builder rules

- Edit/Write tools only, including every red-check revert and restore. No `sed -i`, `bun -e`,
  heredoc edits.
- Never read `lethal.config*.json`. No new config key: each site keeps its existing timeout (the
  [r2] M5 seams are constructor/parameter defaults, not config).
- Typed errors extend `Error` directly (`BcAnswerUnreadError` included). No `!`.
  `exactOptionalPropertyTypes` for `rejectedStatus`.
- Red-check every row of section 6 one revert at a time (`mutation-red-checker` subagent, model
  set), and report red and restored-green output, one red test per direction.
- Loop from the repo root: native parser if the worktree is fresh, `bun run typecheck`,
  `rm -rf packages/*/dist`, `bun scripts/verify.ts`. `bunx biome check` on touched files only.
- CHANGELOG `[Unreleased]`, **Fixed**: "A BC answer that starts but never finishes no longer holds
  LethAL forever on the harness check, the deployment check, the permission canary or a package
  read-back: each call's timeout now covers the response body as well as the headers, and an
  unread or unparseable body is an error, never an empty answer. A harness answer that times out
  or cannot be read no longer makes an env-tool session republish the control app. On the lease
  path, a refused redirect to BC's unfiltered extensions list now ends the session as itself
  instead of reading as 'unreachable', and `force-reset-lease` says the reset may have been
  applied unless BC answered with an error status (R506, R507)." [r2] **Removed**: "The unused
  `MutationControlClient` and `postOData`, left over from before the LethAL Control extension."
- [r2] **File section 10's roadmap item** (its own `docs/roadmap/R<nnn>.md`, `correctness-risks`)
  in the first commit; run `ls docs/roadmap/` immediately before writing it.
- Roadmap: after the commit, set `docs/roadmap/R506.md` and `R507.md` status to
  `fixed in <commit>, live gate pending`; after the gates pass, `done (<commit>)` with a short
  closing note (gate, date, container). Regenerate with `bun scripts/roadmap-index.ts` and run
  `bun test scripts/line-citations.test.ts` (names, not file:line) **before** the final
  `bun scripts/verify.ts`.
- An Opus review of the final build (the diff) before submit.
- Push only after green; WIP pushes carry `[skip ci]`; both CI jobs (Windows `check`,
  `unit-linux`) green on the branch; the run id goes in the submit note.

## 9. Not changed

`run-mutant-transport.ts` (beyond `bounded`'s typed default), `refuseRedirects`, R-496's guards,
the orchestrator's lease callers' `catch` blocks (section 4c wraps the client instead), the control
app, the resume path (section 10).

## 10. [r2] Outside this plan: can `--resume` carry a lease-lost batch? YES, by reading the code

Checked by reading `store.ts` `findResumableRun` and `invalidateBatch`, `resume.ts`
`buildResumeIndex`, and the end of `runSession` in `orchestrator.ts`:
- A lease loss latches the session (`noteLeaseLost` → `latchUnsafe`), so `runSession` skips
  `finishRun` (it runs only when `!safety.isUnsafe`) and the run stays `finished_at IS NULL`.
- The lost batch is invalidated ONLY by the `batch-invalidated` event (`emitLeaseLostInvalidation`),
  which corrects the folded REPORT. Stored rows are corrected only by `store.invalidateBatch`, whose
  sole caller is the attestation gate. So the lost batch's rows keep their recorded `killed`,
  `survived`, `timeout-killed` or `no-coverage`.
- `findResumableRun` picks the most recent unfinished run that holds a carryable verdict. A clean
  lease loss writes no durable quarantine (design §6), so nothing else refuses it.
  `buildResumeIndex` filters by verdict, identity ambiguity, stranded notes and the
  `timeout-killed` permission, never by batch or by a lease-loss mark.
- So `--resume` after a lease loss can carry exactly the verdicts design §6 says to discard.
  `store.invalidateBatch`'s own doc comment names this hazard for the attestation gate (R47); the
  lease-loss path never got the same durable half.

Not verified live, and not fixed in R-506. **The builder files a new `correctness-risks` roadmap
item** with this reasoning (names, not lines), the proposed fix (call
`store.invalidateBatch(runId, lostBatchIndex, note)` beside `emitLeaseLostInvalidation`, as the
attestation gate does; check both `runSession` and the named-mutants path, which both call
`emitLeaseLostInvalidation`), and a proposed pin (a lease-lost session, then `--resume`: the lost
batch's mutants are re-scored and none of them is carried).

## 11. Open questions (each has a default; the builder follows it unless told otherwise)

- [r2] Q1 is closed: deleted (I1). Q2 is closed: a HarnessInfo timeout before the headers is now
  `BcAnswerUnreadError` (I2). Q3 is closed: an unreadable 2xx is routed away from
  `HarnessVerificationError` (M4).
- **Q4. Latch on a lease-path refusal (4c)** stops new work early; without it the run would
  continue until teardown and then throw. Default: latch.
- [r2] **Q5. A NON-abort fetch error on HarnessInfo** (connect refused) is still
  `HarnessVerificationError` "unreachable", so an env-tool session still republishes on it.
  Pre-existing, and not a body read. Default: leave it.
