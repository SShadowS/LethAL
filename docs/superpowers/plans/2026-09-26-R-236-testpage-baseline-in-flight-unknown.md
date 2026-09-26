# R236 / R225: the TestPage baseline test comes back in-flight-unknown, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** r3, answering `H:/lethal-coord/reviews/R-236-plan/review-r1.md` and `review-r2.md`. Per-finding answers are in "Review responses" at the end.

**Goal:** Find out, by measurement, why `Data Tests.PageActionComputesNonZero` sometimes comes back `in-flight-unknown` at baseline, and whether GH-24 (client reach markers plus control app 1.0.0.19) raised the rate. Fix only what the measurement confirms.

**Architecture:** Phase A builds a small env-gated probe that runs narrowed sandbox-data sessions on Cronus28. Per BC call it records the HTTP timeline (sent, headers, bytes received, body end or error). When a call breaks, it reads the control app's operation marker at once; after the session it reads the marker again and checks, on the BC server itself, whether the BC session that ran the call has ended. Only both together count as "the whole action ended"; anything less stops the probe for recovery. A pre-committed comparison separates the client change from the control-app change. Phase B holds one fix per confirmed hypothesis, each behind an owner decision where it changes policy. Phase C is acceptance and the roadmap.

**Tech Stack:** Bun + TypeScript (`packages/runner`), AL control app `extensions/lethal-control`, BcContainerHelper under the Windows docker context.

**Spec:** `docs/roadmap/R236.md`, `docs/roadmap/R225.md`. Background: design §5's lost-ack rules as implemented in `packages/runner/src/orchestrator.ts` (`LeaseSession.reconcileLostAck`, `classifyRetryRefusal`, `runFenced`, `LeaseSession.finish`), `extensions/lethal-control/src/ControlApi.Codeunit.al` (`RunMutant`, `RunMutantWithCoverage`), `.claude/skills/recover-tier/SKILL.md`, and `docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md` §3 and §5 for the pending `itest:tables` figures.

## Evidence already in hand (read before Task 1)

The fixture store `fixtures/sandbox-data/lethal.sqlite` keeps every baseline row, including the lost ones. Queried read-only on 2026-09-26:

| run | date | TestPage row | duration | failure_message |
| --- | --- | --- | ---: | --- |
| 339 | 2026-09-18 (R225, control 1.0.0.18) | `error` | 29 544 ms | `RunMutant 2xx body could not be read: Error: The socket connection was closed unexpectedly.` |
| 346 | 2026-09-26 (Cronus28, 1.0.0.19) | `deadline-exceeded` | 120 003 ms | `RunMutant timed out after headers: AbortError: The operation was aborted.` |
| 308 to 347, all others | | `fail` | 233 to 350 ms warm, 1 555 to 2 694 ms cold | `Unexpected CLR exception thrown.: System.NotSupportedException ... NavSession.CreateNavTestService()` |

What this settles, and what it does not:

1. **The client timer is not the cause.** The expected refusal takes about 0.3 s against a 120 s budget (`BASELINE_TIMEOUT_DEFAULT = 120_000`, `orchestrator.ts:156`; no gate overrides it). Run 339 ended at 29.5 s on a socket close, far from the timer. Raising the budget is ruled out. This contradicts R225's current account ("the timer won", "on a cold one it appears to take longer than the client budget") for run 339; Task 13 corrects R225's text.
2. **Both failures were raised in the body-read branch** of `RunMutantTransport.dispatch` (the `res.text()` catch: `abortedVerdict(err, "after headers")` and `"2xx body could not be read"`). So `fetch` had resolved: headers arrived. It does NOT show how many body bytes arrived, whether the fence ran to phase 3, whether the action ended, or why the socket or body failed.
3. **The baseline call is `RunMutantWithCoverage`, and the fence ends BEFORE the action does.** In `ControlApi.Codeunit.al`, `RunMutantWithCoverage` calls `StartApplicationCoverage`, then `RunMutant` (whose phase 3, `TryFinishRun`, tombstones the op marker and commits), then `StopApplicationCoverage`, `CoverageArray` (a scan of the `Code Coverage` table), JSON assembly and serialisation. So a tombstoned marker proves only that the FENCE completed. The rest of the action may still be running, or stuck, after it. The answer of a successful call carries `coverageRunMs` and `coverageSerializeMs`, which time exactly those post-fence stages.
4. **Why one lost reply costs a whole session is a code fact; why replies are lost is not known.** The mutant loop sends an unreadable answer through `runFenced`; the baseline loop in `scoreBatch` calls plain `runOnce` and goes straight to `quarantineInFlight`. Fixing that would fix the consequence, not the cause.
5. The quarantine detail drops `v.failureMessage`, so the `quarantined` event in `--progress-out` cannot say which exit fired. The chunked gate's store is a scratch file, so its hits today left nothing.

## Owner decisions needed before Task 1

Each is a separate yes/no. Phase A does not start until D1 to D4 are answered in writing (a `coord` reply is enough). D5 is asked only if Phase A licenses Task 8.

- **D1.** Do you require the COMBINED contrast (old client plus old app, against new client plus new app: GH-24 as a whole)? yes / no
- **D2.** Do you require the APP-ONLY contrast (same old client, control app 1.0.0.18 against 1.0.0.19)? yes / no
- **D3.** May the control app on Cronus28 be downgraded to 1.0.0.18 for arm B and then restored? It uninstalls the tests app and the sandbox-data target, unpublishes 1.0.0.19, installs 1.0.0.18, and blocks every other lane's use of Cronus28 until the restore check passes. yes / no
- **D4.** If BC refuses the 1.0.0.18 install as a data downgrade, may the control app be uninstalled with `-doNotSaveData`? That discards its tables: the lease row, the op marker, `LC Op Progress` and the target artifact registry. It is done only with no LethAL lease held on Cronus28 by any lane. yes / no
- **D5 (only if Task 8 is licensed).** May a fresh baseline call replace an unreadable one when the server proves the whole first action ended? The first result then stays unknown: it may have been a `fail` that the retry turns into a `pass`, which changes the green set, and a stall hidden behind a fast retry is still an incident. The lost attempt is kept as a store row and a warning. yes / no

**Arm gating.** Arm B (old client, 1.0.0.18) runs iff (D1 = yes OR D2 = yes) AND D3 = yes. Arms A and B' always run. With B skipped, the only contrast is A vs B' (the client half), and the OUTCOME says the combined and app-only questions were not measured.

**Standing authorization used by this plan** (coordinator, 2026-09-26): recovery that restarts BC or force-resets the lease is allowed ONLY as the full `recover-tier` sequence: restart the container, confirm it is Running, `force-reset-lease`, `clear-quarantine`. No other restart is used anywhere in this plan.

## Global Constraints

- Container: ONLY `Cronus28`, under `coord lease Cronus28 bugs`, heartbeat every 5 minutes, one live job at a time. Never Cronus281/282/283. Live runs go from the main checkout `U:\Git\LethAL` (it holds the gitignored configs). The lease is released only after Task 4's restore check passes.
- Every command block names its shell: **[bash]** is the Git-bash tool, **[pwsh]** is the PowerShell tool. In [pwsh], set `$env:DOCKER_CONTEXT='desktop-windows'` first.
- Build loop: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- Fail loudly. An `in-flight-unknown` must never become a kill, a pass, a fail or an `error` verdict. The only verdict that may ever replace a lost baseline result is a genuinely answered test `pass` or `fail` from a fresh server call; every other retry exit stops measurement and never enters the baseline set. The lost attempt stays on record.
- A tombstoned op marker alone never licenses anything: not continuing a probe arm, not a retry. "Whole action ended" needs the marker AND the BC session check (Task 2 requirement 7).
- No `!` non-null assertions; `exactOptionalPropertyTypes` spreads for optional props.
- No em dashes in any file written by this plan.
- Every fix is red-checked: revert the fix, the named test goes red, restore, report both outputs (`mutation-red-checker` subagent).
- The pre-commitment spec (Task 3) is committed BEFORE any live probe session. Nothing above its `## OUTCOME` line changes after that.

## Review Focus

- A lost body on a NON-TestPage baseline test: the fix keys on the verdict, not the method name. Pinned in Task 8.
- Every retry exit that is not an answered `pass`/`fail`: pre-dispatch rejected twice, a bare protocol error, a lease loss, a resync failure, a lost reply again. Each stops measurement and never enters the baseline set. One test each in Task 8.
- A fence that completed while the rest of the action did not: never read as "ended". Pinned by Task 2 requirement 7 and Task 8's precondition test.
- `not-started` and a late original: the baseline never retries on `not-started`. Pinned in Task 8.
- The probe's tracer changing transport behaviour (error identity, header shape, timing). Pinned in Task 1 and sanity-checked in Task 4 step 3.

---

## File map

- Create `scripts/r236-baseline-probe/fetch-trace.ts`: a fetch wrapper that records one `CallTrace` per request, counts body bytes as they stream, can hand the body text of chosen calls to a callback, and calls a FAST hook on a broken call. Pure, importable (`scripts/importable-scripts.test.ts`).
- Create `scripts/r236-baseline-probe/fetch-trace.test.ts`.
- Create `scripts/r236-baseline-probe/probe.ts`: the env-gated CLI.
- Create `scripts/r236-baseline-probe/reach-keys.ts`: prints the ten `Data Reach Ops` mutants' full comparison keys offline (Task 12).
- Create `docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md` (Task 3), OUTCOME filled in Task 5.
- Modify (Phase B, conditional) `packages/runner/src/orchestrator.ts`, `packages/runner/tests/orchestrator.test.ts` and its snapshot.
- Modify (Phase C) `docs/roadmap/R236.md`, `docs/roadmap/R225.md`, regenerate `ROADMAP.md`.

---

# Phase A: measurement

### Task 1: `traceFetch`, the recording wrapper

**Files:**
- Create: `scripts/r236-baseline-probe/fetch-trace.ts`
- Test: `scripts/r236-baseline-probe/fetch-trace.test.ts`

**Interfaces:**
- Consumes: `FetchFn` from `packages/runner/src/activation.ts` (`typeof fetch`).
- Produces: `traceFetch(inner: FetchFn, sink: CallTrace[], hooks?: TraceHooks): FetchFn`, `interface CallTrace`, `interface TraceHooks`.

Design rules:
- `init` passes through as the same object unless `freshConnection` is set (kept only for a later experiment; this plan runs no arm with it).
- Bytes are counted as they stream, through a counting `TransformStream` piped from `res.body`, so a broken body still reports `bytesReceived`. The returned `Response` is rebuilt with the same status, statusText and headers.
- The broken-call hook must be fast: one marker read, nothing else. A hook that throws never changes what the caller sees.
- `onBody(trace, text)` is synchronous and called with the full body text only on success, for the probe to extract `coverageRunMs` and `coverageSerializeMs`.

- [ ] **Step 1: Write the failing tests** **[bash]**

```ts
// scripts/r236-baseline-probe/fetch-trace.test.ts
import { describe, expect, test } from "bun:test";
import type { FetchFn } from "../../packages/runner/src/activation";
import { type CallTrace, traceFetch } from "./fetch-trace";

const URL_ = "http://Cronus28:7048/BC/ODataV4/LethALControl_RunMutantWithCoverage?company=X";
const BODY = JSON.stringify({ attemptId: "a7", opSeq: 12, testMethod: "PageActionComputesNonZero" });
const asFetch = (f: (i: unknown, init?: RequestInit) => Promise<Response>): FetchFn =>
  Object.assign(f, { preconnect: fetch.preconnect }) as FetchFn;

describe("traceFetch", () => {
  test("healthy call: body unchanged, status and headers kept, UTF-8 bytes counted, onBody sees the text", async () => {
    const sink: CallTrace[] = [];
    const bodies: string[] = [];
    const inner = asFetch(async () =>
      new Response("é{}", { status: 200, statusText: "OK", headers: { "x-probe": "1" } }));
    const res = await traceFetch(inner, sink, { onBody: (_t, text) => bodies.push(text) })(URL_, {
      method: "POST",
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("x-probe")).toBe("1");
    expect(await res.text()).toBe("é{}");
    expect(bodies).toEqual(["é{}"]);
    const [t] = sink;
    expect(t?.action).toBe("LethALControl_RunMutantWithCoverage");
    expect(t?.attemptId).toBe("a7");
    expect(t?.opSeq).toBe(12);
    expect(t?.bytesReceived).toBe(4);
    expect(t?.bodyEndAt).toBeDefined();
    expect(t?.error).toBeUndefined();
  });

  test("body breaks after the first chunk was CONSUMED: the SAME error reaches the caller, 3 bytes recorded, the hook ran first", async () => {
    const sink: CallTrace[] = [];
    const boom = new Error("The socket connection was closed unexpectedly");
    const order: string[] = [];
    let pulls = 0;
    // pull-based: the error is raised only on the SECOND pull, i.e. after the reader has taken
    // the first chunk, so the counting transform provably saw those bytes.
    const inner = asFetch(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            if (pulls === 1) c.enqueue(new Uint8Array([123, 34, 118]));
            else c.error(boom);
          },
        }),
        { status: 200 },
      ));
    const res = await traceFetch(inner, sink, {
      onBrokenCall: async (trace) => {
        order.push(`hook:${trace.errorPhase}:${trace.attemptId}:${trace.bytesReceived}`);
      },
    })(URL_, { method: "POST", body: BODY });
    const caught = await res.text().then(() => null, (e: unknown) => e);
    order.push("caller");
    expect(caught).toBe(boom);
    expect(order).toEqual(["hook:body:a7:3", "caller"]);
    expect(sink[0]?.errorPhase).toBe("body");
  });

  test("fetch throws before headers: same error rethrown, phase 'fetch', no headersAt", async () => {
    const sink: CallTrace[] = [];
    const boom = new Error("aborted");
    const f = traceFetch(asFetch(async () => { throw boom; }), sink);
    const caught = await f(URL_, { method: "POST", body: BODY }).then(() => null, (e: unknown) => e);
    expect(caught).toBe(boom);
    expect(sink[0]?.errorPhase).toBe("fetch");
    expect(sink[0]?.headersAt).toBeUndefined();
  });

  test("init passes through as the SAME object unless freshConnection is set", async () => {
    const seen: unknown[] = [];
    const inner = asFetch(async (_i, init) => {
      seen.push(init);
      return new Response("{}");
    });
    const init = { method: "POST", body: BODY, headers: { a: "b" } };
    await traceFetch(inner, [])(URL_, init);
    await traceFetch(inner, [], { freshConnection: true })(URL_, init);
    expect(seen[0]).toBe(init);
    expect(new Headers((seen[1] as RequestInit).headers).get("connection")).toBe("close");
    expect(new Headers((seen[1] as RequestInit).headers).get("a")).toBe("b");
  });

  test("a hook that throws never changes what the caller sees", async () => {
    const boom = new Error("x");
    const f = traceFetch(asFetch(async () => { throw boom; }), [], {
      onBrokenCall: async () => { throw new Error("hook failed"); },
    });
    const caught = await f(URL_, { method: "POST", body: BODY }).then(() => null, (e: unknown) => e);
    expect(caught).toBe(boom);
  });
});
```

- [ ] **Step 2: Run, confirm it fails** **[bash]** `bun test scripts/r236-baseline-probe/fetch-trace.test.ts`. Expected: FAIL, `Cannot find module './fetch-trace'`.

- [ ] **Step 3: Implement**

```ts
// scripts/r236-baseline-probe/fetch-trace.ts
/**
 * R236 probe: a fetch wrapper that records each BC call's timeline and counts body bytes as they
 * arrive, so a broken body still says how much came. Errors are rethrown as the SAME object; the
 * hook runs first, must be fast, and can never change what the caller sees.
 */
import type { FetchFn } from "../../packages/runner/src/activation";

export interface CallTrace {
  readonly action: string;
  readonly attemptId?: string;
  readonly opSeq?: number;
  readonly testMethod?: string;
  readonly dispatchedAt: number;
  headersAt?: number;
  status?: number;
  contentLength?: string | null;
  transferEncoding?: string | null;
  connection?: string | null;
  bytesReceived?: number;
  bodyEndAt?: number;
  errorPhase?: "fetch" | "body";
  errorAt?: number;
  error?: string;
}

export interface TraceHooks {
  readonly onBrokenCall?: (trace: CallTrace, requestBody: Record<string, unknown>) => Promise<void>;
  readonly onBody?: (trace: CallTrace, text: string) => void;
  readonly freshConnection?: boolean;
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function runHook(hooks: TraceHooks, trace: CallTrace, body: Record<string, unknown>) {
  try {
    await hooks.onBrokenCall?.(trace, body);
  } catch {
    // Diagnostics only: a failed hook must never replace the transport's own error.
  }
}

export function traceFetch(inner: FetchFn, sink: CallTrace[], hooks: TraceHooks = {}): FetchFn {
  const request = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = urlOf(input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const trace: CallTrace = {
      action: /ODataV4\/([^?]+)/.exec(url)?.[1] ?? url,
      dispatchedAt: Date.now(),
      ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
      ...(typeof body.opSeq === "number" ? { opSeq: body.opSeq } : {}),
      ...(typeof body.testMethod === "string" ? { testMethod: body.testMethod } : {}),
    };
    sink.push(trace);
    let sendInit = init;
    if (hooks.freshConnection === true) {
      const headers = new Headers(init?.headers);
      headers.set("connection", "close");
      sendInit = { ...init, headers };
    }
    let res: Response;
    try {
      res = await inner(input, sendInit);
    } catch (err) {
      trace.errorPhase = "fetch";
      trace.errorAt = Date.now();
      trace.error = String(err);
      await runHook(hooks, trace, body);
      throw err;
    }
    trace.headersAt = Date.now();
    trace.status = res.status;
    trace.contentLength = res.headers.get("content-length");
    trace.transferEncoding = res.headers.get("transfer-encoding");
    trace.connection = res.headers.get("connection");
    trace.bytesReceived = 0;
    if (res.body === null) return res;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        trace.bytesReceived = (trace.bytesReceived ?? 0) + chunk.byteLength;
        c.enqueue(chunk);
      },
      flush() {
        trace.bodyEndAt = Date.now();
      },
    });
    const counted = new Response(res.body.pipeThrough(counter), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    const text = counted.text.bind(counted);
    Object.defineProperty(counted, "text", {
      value: async () => {
        let t: string;
        try {
          t = await text();
        } catch (err) {
          trace.errorPhase = "body";
          trace.errorAt = Date.now();
          trace.error = String(err);
          await runHook(hooks, trace, body);
          throw err;
        }
        try {
          hooks.onBody?.(trace, t);
        } catch {
          // diagnostics only
        }
        return t;
      },
    });
    return counted;
  };
  return Object.assign(request, { preconnect: inner.preconnect });
}
```

   If the "SAME error" test fails because `pipeThrough` re-wraps the upstream error on Bun, do NOT loosen the test: switch to a manual reader loop over `res.body.getReader()` that counts and re-enqueues into a new `ReadableStream`, calling `controller.error(err)` with the original object.
- [ ] **Step 4:** `bun test scripts/r236-baseline-probe/fetch-trace.test.ts`: 5 pass. `bunx biome check scripts/r236-baseline-probe/`.
- [ ] **Step 5: Commit** **[bash]**

```bash
git add scripts/r236-baseline-probe/fetch-trace.ts scripts/r236-baseline-probe/fetch-trace.test.ts
git commit -m "measure(R236): traceFetch, streaming byte counts and a fast broken-call hook"
```

### Task 2: `probe.ts`, the env-gated session runner

**Files:** Create `scripts/r236-baseline-probe/probe.ts`.

**Interfaces:**
- Consumes: `traceFetch` (Task 1); from `packages/runner/src`: `runSession`, `BcDevMcpBackend`, `RunMutantTransport` (and its `getOperationStatus(lease, attemptId, opSeq)`; the control app deliberately does not gate that read on the tuple matching the current lease row, so it works after the session ends), `bcFetch`, `validateBcDevConfig`, `odataBaseUrl`, `ArtifactCompiler`, `defaultArtifactIo`, `ContainerDeployer`, `defaultAlToolPaths`, `defaultDeployerIo`, `DeploymentVerifier`, `HarnessVerifier` (`fetchControlVersion()`; `verify()`'s `HarnessDetails` has no version field), `LeaseClient`, `ResultsStore`, type `RunEvent`. Build the stack as `packages/runner/itest/tables.itest.ts` `runOnce` does (about lines 704 to 790). Copy that block, do not import it (the itest calls `main()` at top level).
- Produces: one NDJSON line per session in `--out` (`SessionRecord`), and an exit code Task 4 acts on.

CLI: `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm <label> --sessions <n> --out <file.ndjson> [--control-app <path.app>] [--no-trace]`

Requirements:

1. Refuse to run unless `LETHAL_R236_PROBE=1` (print `skipped`, exit 0). Refuse if `--out`'s directory does not exist (exit 2, name it).
2. Fixed absolute paths, so the same file runs from a worktree: `PROJECT_DIR = "U:/Git/LethAL/fixtures/sandbox-data"`, `TEST_DIR = "U:/Git/LethAL/fixtures/sandbox-data-tests"`, config `U:/Git/LethAL/fixtures/sandbox-data/lethal.config.local.json`. `--control-app` overrides the config's `controlSymbolPath`.
3. Per session: fresh scratch dir under `os.tmpdir()`, scratch `ResultsStore` and scratch `quarantineDir` there (never the fixture's `lethal.sqlite`, never `~/.lethal`), and `runSession({ ..., only: ["src/DataValueSource.Codeunit.al"], emit: [(e) => events.push(e)] })`. That selects the fixture's one `return-value` mutant, whose only covering test is the TestPage test, so a session is compile, publish, the 22-test baseline, and no mutant run. Task 4 step 2 verifies it.
4. Transport factory: `(targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId, fetchFn)` where `fetchFn` is `bcFetch` under `--no-trace`, else `traceFetch(bcFetch, calls, hooks)`.
5. `hooks.onBrokenCall` (fast path): only when `trace.action` starts with `LethALControl_RunMutant`, ONE `getOperationStatus` read through a separate `new RunMutantTransport(odataCfg, String(body.targetAppId), String(body.artifactId))` with `lease = { epoch: body.leaseEpoch, token: body.leaseToken, serverGeneration: body.serverGeneration, opSeq: body.opSeq }`. Keep the tuple and `(attemptId, opSeq)` in memory. Nothing else happens on the fetch path. (`GetOperationStatus` does NOT return the progress row's session id: `OperationProgress` in `lease.ts` has no such field and the AL answer does not add one. Requirement 7 reads it from SQL instead.)
6. `hooks.onBody`: for `LethALControl_RunMutantWithCoverage` calls, parse `JSON.parse(JSON.parse(text).value)` and keep `coverageRunMs`, `coverageSerializeMs`, `coverageScannedRows`, `coverageEmittedRows` per test method (the post-fence stage costs on successful calls). Parse failures are recorded, never thrown.
7. **After `runSession` returns (slow path), for every broken RunMutant call of this session:**
   (a) a second `getOperationStatus` read with the same tuple, recording `atMs` since the call broke;
   (b) **[pwsh via `Bun.spawn(["pwsh", "-NoProfile", "-Command", script])`, env `DOCKER_CONTEXT=desktop-windows`]** the call's BC session id from the control app's own `LC Op Progress` row, then the BC server's session list and event log. The session id is read with `Invoke-Sqlcmd` inside the container against the tenant database, from the table whose name matches `%LC Op Progress%` (find the exact name once with `SELECT name FROM sys.tables WHERE name LIKE '%LC Op Progress%'` and hard-code it after the smoke; `DataPerCompany = false`, so there is no company prefix), selecting `[Session Id]` where `[Attempt Id]` and `[Op Seq]` match this call. Then:

```powershell
Import-Module BcContainerHelper -DisableNameChecking
Invoke-ScriptInBcContainer -containerName Cronus28 -argumentList '<sinceIso>' -scriptblock { param($since)
  Get-NAVServerSession -ServerInstance BC | Select-Object SessionID,ClientType,UserID,LoginDatetime | ConvertTo-Json -Compress
  '----'
  Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]$since} -ErrorAction SilentlyContinue |
    Where-Object ProviderName -like 'MicrosoftDynamicsNav*' |
    Select-Object TimeCreated,Id,LevelDisplayName,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(2000,$_.Message.Length))}} |
    Format-List | Out-String -Width 300
}
```

   with `<sinceIso>` = the broken call's `dispatchedAt` minus 5 s. Keep stdout and stderr verbatim; parse the JSON part into a list of session ids.
   (c) **Whole-action-ended test.** `actionEnded` is true iff ALL hold: a marker read shows `completed: true` or `opSeq <= lastCompletedOpSeq` for this call's `opSeq`; the SQL read in (b) returned exactly one `Session Id` greater than 0 for this `(attemptId, opSeq)`; the `Get-NAVServerSession` list parsed successfully; and that `sessionId` is NOT in it. The BC session id of the call comes from the control app's own record (`LC Op Progress."Session Id"`), so the check is tied to THIS call, not to "some OData session". If BC keeps idle OData sessions alive after they answer, `actionEnded` comes out false and the probe stops more often: that is the safe direction, and it is itself a finding.
8. **Stop rule.** If any broken call of the session has `actionEnded` false, the probe writes the session record with `stopReason` and exits 3, running no further session. The operator follows Task 4's recovery procedure. If every broken call has `actionEnded` true, the next session runs and is recorded with `afterHit: true`.
9. If a session throws (for example `LeaseUnavailableError`), record it with `quarantined: "THREW: <message>"`, stop, exit 4. A thrown session is never an observation.
10. Per session, one line:

```ts
interface SessionRecord {
  readonly arm: string;
  readonly index: number;                // 1-based within this invocation
  readonly segment: number;              // incremented by the operator (--segment) after a recovery; default 1
  readonly startedAt: string;
  readonly endedAt: string;
  readonly traced: boolean;
  readonly afterHit: boolean;
  readonly controlVersion: string;       // HarnessVerifier.fetchControlVersion(), read before the session
  readonly clientCommit: string;         // `git rev-parse HEAD` of the tree the probe runs from
  readonly appVersion: string | null;    // store `runs.app_version`
  readonly quarantined: string | null;
  readonly hit: boolean;                 // reason contains "baseline test in-flight-unknown running PageActionComputesNonZero"
  readonly otherBaselineInFlight: boolean;
  readonly baseline: ReadonlyArray<{ method: string; outcome: string; durationMs: number; failureHead: string | null }>;
  readonly calls: readonly CallTrace[];
  readonly postFence: ReadonlyArray<{ method: string; coverageRunMs?: number; coverageSerializeMs?: number; coverageScannedRows?: number; coverageEmittedRows?: number; parseError?: string }>;
  readonly broken: ReadonlyArray<{ attemptId: string; opSeq: number; reads: ReadonlyArray<{ atMs: number; status?: unknown; error?: string }>; sessionId: number | null; nstSessions: number[] | null; actionEnded: boolean; nstEvidence: string }>;
  readonly warnings: ReadonlyArray<{ code: string; message: string }>;
  readonly stopReason: string | null;
}
```

   Add `--segment <n>` (default 1) to the CLI for requirement 10's `segment`.
11. Exit codes: 0 all sessions ran; 2 harness fault; 3 stopped because a broken call's action could not be confirmed ended; 4 stopped on a thrown session.

- [ ] **Step 1:** Write `probe.ts` to the eleven points. Every statement is inside `main()`; the file ends `if (import.meta.main) await main();`.
- [ ] **Step 2** **[bash]:** `bun run typecheck && rm -rf packages/*/dist && bun test scripts/`. `bunx biome check scripts/r236-baseline-probe/`.
- [ ] **Step 3** **[bash]:** `bun scripts/r236-baseline-probe/probe.ts --arm x --sessions 1 --out /dev/null` without the env var prints `skipped`, exit 0.
- [ ] **Step 4: Commit** **[bash]** `git add scripts/r236-baseline-probe/probe.ts && git commit -m "measure(R236): baseline probe, stops unless the broken call's whole action provably ended"`

### Task 3: pre-commit the measurement (BEFORE any live session)

**Files:** Create `docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md`.

- [ ] **Step 1:** Write the spec with these sections and values.

**§1 Unit and counting.** One probe session. A HIT is a session whose `quarantined` reason contains `baseline test in-flight-unknown running PageActionComputesNonZero`. An arm's rate counts every session that returned a report (hits and non-hits, including `afterHit` sessions); the rate is also reported without `afterHit` sessions. Thrown sessions (exit 4) are not observations. After a recovery, the arm continues as a new segment with the remaining count; segments are pooled for the arm, and the OUTCOME lists each segment's counts and timestamps. Priors (not part of any test, unaudited, not assumed independent): 1 hit in store runs 308 to 341, 1 in 342 to 347; gates on 2026-09-26 reported roughly half of sandbox-data sessions hitting.

**§2 Arms, in this order, one lease. Timestamps of every arm boundary, smoke, publish, swap and recovery go into the OUTCOME.**

| block | client tree | control app | planned sessions | runs when |
| --- | --- | --- | ---: | --- |
| A1 | main checkout HEAD | 1.0.0.19 | 15 | always |
| B'1 | worktree at `7b7fff3` (first parent of GH-24 merge `5b9e12a`) | 1.0.0.19 | 15 | always |
| B | same worktree | 1.0.0.18 | 30 | (D1 or D2) and D3 |
| B'2 | same worktree | 1.0.0.19 | 15 | always |
| A2 | main checkout HEAD | 1.0.0.19 | 15 | always |

A = A1 + A2, B' = B'1 + B'2. The HEAD client refuses 1.0.0.18 twice over (`MIN_CONTROL_VERSION = "1.0.0.19"` in `harness.ts`; the check that every `ran` answer carries a boolean `observedActive` in `run-mutant-transport.ts`), so B needs the old tree. The old tree's minimum is 1.0.0.18, so it accepts 1.0.0.19 (B'); it emits no `Reached` markers. The fixture is HEAD's in every arm.

What each contrast answers:
- **A vs B'** (always): same app, different client. GH-24's client half PLUS every other client commit between `7b7fff3` and HEAD; `git log --oneline 7b7fff3..HEAD -- packages/` goes into the OUTCOME as the confound list.
- **B' vs B** (if B ran; answers D2): same client, different app version.
- **A vs B** (if B ran; answers D1): the combined change.

**§3 Tests, thresholds, and short arms.** All tests are Fisher exact tests on the ACTUAL counts `(hits1, n1, hits2, n2)`, with p = the hypergeometric tail `P(X >= hits1)` where X counts hits in arm 1 given the pooled hits, n1 and n2. The read-out computes p; the tables below are convenience for the planned sizes only and are overridden by the formula on any other size.

- **Main contrasts (A vs B', B' vs B, A vs B):** one-sided, "the newer side has MORE hits", declared "raised" iff p < 0.05. Planned 30 vs 30: newer-side hits must be at least T.

  | older-side hits | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
  | --- | --: | --: | --: | --: | --: | --: | --: | --: |
  | T (30 vs 30) | 5 | 7 | 8 | 10 | 11 | 12 | 13 | 15 |

  Not met: "this measurement does not show an increase", never "no increase".
- **Drift (A1 vs A2; B'1 vs B'2):** two-sided, p = min(1, 2 x the one-sided tail in the direction observed), flagged iff p < 0.05. Planned 15 vs 15: the higher half must have at least D hits for a flag.

  | lower-half hits | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
  | --- | --: | --: | --: | --: | --: | --: | --: | --: |
  | D (15 vs 15, two-sided) | 5 | 7 | 9 | 10 | 11 | 12 | 13 | 14 |

  A drift flag on either split arm marks every contrast using that arm "confounded by drift".
- **Short arms.** Any arm that ends below two thirds of its planned sessions (below 20 of 30, or below 10 of a 15 half) is reported as "short: planned P, ran R", and every contrast using it is reported as "underpowered: not decided", whatever p is. Its counts are still published.
- **Non-reproduction.** If all arms together have at most 2 hits, run arm A3 (10 sessions, HEAD, 1.0.0.19, WITHOUT `only`, i.e. the full sandbox-data run); if A3 has at most 1 hit, Phase A ends "not reproduced" and no fix is built.

**§4 Mechanism, per hit.** Correlation uses the broken call's own `(attemptId, opSeq)` and the progress row's `sessionId`.

| evidence on the broken TestPage call | class |
| --- | --- |
| `actionEnded` true (Task 2 requirement 7c) | **H2-action**: the whole action ended on the server, the reply was lost on the way |
| marker completed, but `actionEnded` false or unknown | **H2-fence**: the fence completed; the post-fence stages (coverage stop, `CoverageArray`, serialisation) or the reply itself did not provably finish |
| both reads: `opKind: "run"` with OUR attemptId and opSeq, AND the progress row for our `(attemptId, opSeq)` in state `running` | **H3: hang inside the fence** |
| both reads idle with `lastCompletedOpSeq = opSeq - 1` | **H7-candidate**: not claimed as of the second read; not proof it never will be |
| `errorPhase: "fetch"` | wire failure before headers |
| anything else, or a failed read | unclassified, quoted verbatim |

A class is DECLARED only if at least 3 hits are classifiable AND at least 70 % of them share it; otherwise **inconclusive**. TestPage specificity: over all broken RunMutant calls, declared only with at least 5 broken calls AND at least 80 % on `PageActionComputesNonZero`. Post-fence cost: the OUTCOME reports the distribution of `coverageRunMs` and `coverageSerializeMs` for the TestPage call against the other 21 tests. **Truncation (H8)**: `bytesReceived < Content-Length` on a broken call shows the client saw a TRUNCATED body. It does not by itself show BC wrote a wrong length (the connection may have died mid-body); it is reported as "truncated as seen by the client" with its count, and declared only with at least 3 such calls.

**§5 What this measurement cannot say.** It does not reproduce R225's fresh-tenant bootstrap; the probe restarts nothing except inside the recovery procedure. It cannot tell a cold container from the first session after a swap or recovery; those sessions are flagged in the OUTCOME. It cannot establish keep-alive socket reuse: no per-request socket identity is recorded, so H7 can only be a candidate here. R225's cold-start claim stays open.

**§6 What each outcome licenses.**
- H2-action declared: Task 8a (a product-readable whole-action signal) and then Task 8, subject to D5. Also the cause question in Task 13 stays open unless the event log or truncation evidence explains WHY the reply was lost.
- H2-fence declared: no retry of any kind. The post-fence stages are the suspect: Task 9 (owner ruling), with the post-fence cost distribution and event log as evidence.
- H3 declared: Task 9.
- H7-candidate or wire failure declared: no code. File a roadmap item that needs a per-request socket-identity observable before any `Connection: close` change is proposed.
- A main contrast "raised" (not confounded, not underpowered): Task 11.
- Inconclusive: nothing; report to the owner.

**§7 `## OUTCOME`** (empty; filled in Task 5).

- [ ] **Step 2: Commit before any live run** **[bash]**

```bash
git add docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md
git commit -m "precommit(R236): arms, exact tests on actual counts, whole-action rule, mechanism minimums"
```

### Task 4: run the arms on Cronus28

No code. Output under `C:/Users/SShadowS/AppData/Local/Temp/r236/` (scratch, never committed). Log every command with its start time in `C:/Users/SShadowS/AppData/Local/Temp/r236/log.txt`.

**Recovery procedure** (whenever the probe exits 3 or 4, or a smoke or gate leaves a quarantine). Authorized only as this exact sequence:
1. **[pwsh]** `$env:DOCKER_CONTEXT='desktop-windows'; Restart-BcContainer -containerName Cronus28`
2. **[pwsh]** Poll `docker inspect -f '{{.State.Health.Status}}' Cronus28` until `healthy`, then **[bash]** `bun packages/runner/src/cli.ts doctor --config fixtures/sandbox-data/lethal.config.local.json --project fixtures/sandbox-data` must report the control app reachable. Only then step 3.
3. **[bash]** `bun packages/runner/src/cli.ts force-reset-lease --server http://Cronus28 --instance BC --config fixtures/sandbox-data/lethal.config.local.json`. Record the epoch and generation transition it prints.
4. **[bash]** `bun packages/runner/src/cli.ts clear-quarantine --server http://Cronus28 --instance BC`. `not-quarantined` is expected (the probe uses a scratch quarantine dir); delete that session's scratch dir too.
5. Resume the arm with the REMAINING count and `--segment <next>`. If the same arm stops three times, end the arm (it is then short, §3) and record why.

**Restore check and restoration** (mandatory before the lease is released, and after any block that changed installed apps, including after a failure or interruption).
1. **[pwsh]** `Get-BcContainerAppInfo -containerName Cronus28 -tenantSpecificProperties | Select Name,Version,IsInstalled`.
2. If `LethAL Control` 1.0.0.19 is not the installed version: uninstall the tests app, then the target, then `UnPublish-BcContainerApp -containerName Cronus28 -name 'LethAL Control' -version <installed> -unInstall`, then `Publish-BcContainerApp -containerName Cronus28 -appFile 'U:\Git\LethAL\extensions\lethal-control\LethAL_LethAL Control_1.0.0.19.app' -skipVerification -sync -install`.
3. Ensure the sandbox-data target and the tests app are installed: `Install-BcContainerApp -containerName Cronus28 -name '<name as listed>'` for each one not installed, target first.
4. **[bash]** Main-tree smoke: `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm restore-check --sessions 1 --out C:/Users/SShadowS/AppData/Local/Temp/r236/restore-check.ndjson`. Pass: `controlVersion` 1.0.0.19, 21 `pass` plus the TestPage row. A hit: recovery procedure, then repeat step 4.
5. Only then release the lease and clear the handoff note (step 7 below). If restoration cannot be completed, keep the lease and `coord ask` the owner with the recorded state.

Steps:

- [ ] **Step 1: Lease and state.** **[pwsh]** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`. Stopped: `coord ask`, never start it. **[bash]** `coord lease Cronus28 bugs`, heartbeat every 5 minutes. **[bash]** `mkdir -p C:/Users/SShadowS/AppData/Local/Temp/r236`. **[pwsh]** record the BC build `Invoke-ScriptInBcContainer -containerName Cronus28 -scriptblock { (Get-NAVServerInstance BC).Version }` and the installed apps (restore step 1's command) into `C:/Users/SShadowS/AppData/Local/Temp/r236/before-state.txt`. Expected: control 1.0.0.19 installed.
- [ ] **Step 2: Smoke, traced.** **[bash]** `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm smoke-traced --sessions 5 --out C:/Users/SShadowS/AppData/Local/Temp/r236/smoke-traced.ndjson`. Pass: every non-hit session has 22 baseline rows (21 `pass`, the TestPage row `fail` with the CLR text), zero `RunMutantMany` calls in `calls`, and `postFence` entries for all 22 tests. Mutants ran: the narrowing is wrong, fix Task 2 first.
- [ ] **Step 3: Smoke, untraced.** **[bash]** same with `--no-trace --arm smoke-untraced --out .../smoke-untraced.ndjson`. Sanity check only, not proof of neutrality for rare failures: the traced median `durationMs` over the 21 passing tests is within 20 % of the untraced one, and the TestPage row's outcome class matches. Worse: revisit Task 1 before going on.
- [ ] **Step 4: A1.** **[bash]** `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm A1 --sessions 15 --out C:/Users/SShadowS/AppData/Local/Temp/r236/A1.ndjson`. Exit 3 or 4: recovery procedure, then resume with the remainder as the next segment.
- [ ] **Step 5: Old-client worktree.** **[bash]**

```bash
git -C /u/Git/LethAL worktree add /u/Git/LethAL-r236-b 7b7fff3
cd /u/Git/LethAL-r236-b && bun install
mkdir -p scripts/r236-baseline-probe
cp /u/Git/LethAL/scripts/r236-baseline-probe/{fetch-trace.ts,probe.ts} scripts/r236-baseline-probe/
git -C /u/Git/LethAL-r236-b rev-parse HEAD                        # must start 7b7fff3
grep -n "MIN_CONTROL_VERSION =" packages/runner/src/harness.ts    # must read 1.0.0.18
```

   If `probe.ts` does not compile against the old API, adapt ONLY the worktree copy and save `diff -u /u/Git/LethAL/scripts/r236-baseline-probe/probe.ts scripts/r236-baseline-probe/probe.ts > C:/Users/SShadowS/AppData/Local/Temp/r236/b-tree.diff`. Smoke with 1 session (`--arm smoke-Bp`): pass as step 2, `controlVersion` 1.0.0.19, `clientCommit` starting 7b7fff3, and no `Reached(` in the session's scratch instrumented dir.
- [ ] **Step 6: B'1.** **[bash]** from the worktree, `--arm Bp1 --sessions 15`.
- [ ] **Step 7 (only if B runs, §2): swap to 1.0.0.18.** First post a handoff note that survives an interruption: **[bash]** `coord note Cronus28 "bugs lane: control app DOWNGRADED to 1.0.0.18 for R236 arm B. Do not use Cronus28 until the restore check in docs/superpowers/plans/2026-09-26-R-236-testpage-baseline-in-flight-unknown.md Task 4 passes. Before-state: C:/Users/SShadowS/AppData/Local/Temp/r236/before-state.txt"` (use the coord command the runbook names for a container note if `note` is not it). Verify the package: **[pwsh]** after publish, `Get-BcContainerAppInfo` must list `LethAL Control` 1.0.0.18. Then **[pwsh]** uninstall the tests app, then the target, then `UnPublish-BcContainerApp -containerName Cronus28 -name 'LethAL Control' -version 1.0.0.19 -unInstall`, then `Publish-BcContainerApp -containerName Cronus28 -appFile 'U:\Git\LethAL\extensions\lethal-control\LethAL_LethAL Control_1.0.0.18.app' -skipVerification -sync -install`. A data-downgrade refusal: only with D4 = yes, and only after `coord` confirms no lane holds a LethAL lease on Cronus28, uninstall with `-doNotSaveData` and retry; with D4 = no, skip B and run the restoration. Any other refusal: restoration, then `coord ask`.
- [ ] **Step 8 (only if B runs): B.** **[bash]** from the worktree, a 1-session smoke (`--arm smoke-B --control-app "U:/Git/LethAL/extensions/lethal-control/LethAL_LethAL Control_1.0.0.18.app"`; pass: `controlVersion` 1.0.0.18, tests app installed; a `StaleTestAppError` or `AL0185` means reinstall the tests app and retry once), then `--arm B --sessions 30` with the same `--control-app`. Then the restoration (it puts 1.0.0.19 back and runs the main-tree smoke).
- [ ] **Step 9: B'2 then A2.** **[bash]** worktree `--arm Bp2 --sessions 15`; `git -C /u/Git/LethAL worktree remove /u/Git/LethAL-r236-b`; main checkout `--arm A2 --sessions 15`.
- [ ] **Step 10: Restore check, then release.** Always, even when nothing was swapped. Then **[bash]** clear the step 7 note if one was posted, and `coord release Cronus28 bugs`.

Residual limit, stated rather than hidden: an interrupted process cannot run a prose "always" step. The handoff note, the before-state file and the held lease are what make an interrupted downgrade visible to the next operator; the restore check must pass before anyone else uses Cronus28.

### Task 5: read-out and ruling

- [ ] **Step 1:** Tabulate from the NDJSON with a one-off `bun -e` (not committed): actual n and hits per block and segment; each §3 contrast with its p on actual counts and its wording; drift and short-arm flags; §4 class per hit and the declared class or "inconclusive"; broken calls by `testMethod`; `headersAt - dispatchedAt`; `contentLength` vs `bytesReceived`; post-fence cost distributions; NST event text per hit; the timeline of arm boundaries, smokes, swaps and recoveries; the confound list.
- [ ] **Step 2:** Fill `## OUTCOME` word for word against §3 to §6. Quote one NST event log excerpt per class seen.
- [ ] **Step 3:** Append the measured facts to `docs/roadmap/R236.md` under a dated heading (status stays open). **[bash]** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`.
- [ ] **Step 4: Commit** **[bash]** `git add docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md docs/roadmap/R236.md ROADMAP.md && git commit -m "measure(R236): baseline TestPage in-flight-unknown, rate and mechanism measured"`

Stop and report to the owner before Phase B.

---

# Phase B: fixes, each only when its hypothesis is declared

## Hypotheses and how Phase A decides each

| id | hypothesis | declared by | refuted or weakened by |
| --- | --- | --- | --- |
| H1 | client timer fires before the server's refusal returns | a hit with no `headersAt`, duration equal to the budget, and the action ended long before | already contradicted for 339 and 346 (fetch resolved; 339 ended at 29.5 s) |
| H2-action | the whole action ends, the reply is lost on the way | §4, with minimums | `actionEnded` false |
| H2-fence | the fence ends, a post-fence stage or the reply stalls | §4, with minimums | `actionEnded` true |
| H3 | the TestPage path hangs inside the fence (R76 family) | §4, with minimums | marker completed |
| H4 | cold container or first TestPage after publish | not testable here (§5); first sessions after swaps and recoveries are flagged | hits on sessions that are not first after one |
| H5 | GH-24 made hits more likely | §3 "raised" on A vs B' (client half), B' vs B (app half) or A vs B (combined) | §3 not met, which does NOT prove no effect. The TestPage test fails at `OpenView` before target code, so a marker cannot fire inside it |
| H7 | a pooled keep-alive socket dies | not declarable here (§5); only a candidate | |
| H8 | the client receives a truncated body | §4's truncation minimum; the cause (BC's length or a dying connection) stays open | lengths agree, or chunked encoding |

### Task 6: the quarantine detail carries the failure message (lands with whichever fix is licensed, or alone if the owner asks)

Diagnostics only: no verdict moves.

**Files:** `packages/runner/src/orchestrator.ts` (the baseline `requiresUnsafeLatch` branch in `scoreBatch`, detail `baseline test in-flight-unknown running ${ref.method}`); `packages/runner/tests/orchestrator.test.ts`, the describe at line ~5128 whose name ends `latch+quarantine on in-flight-unknown at baseline and kill-confirm too`; the snapshot lines with `"baseline test in-flight-unknown running OverBudgetDetected"`.

- [ ] **Step 1: Failing test.** In `a BASELINE test returning in-flight-unknown records a durable quarantine ...`, give the fake's answer `failureMessage: "RunMutant timed out after headers: AbortError"` and assert `expect(sessionReport.quarantined?.reason).toBe("baseline test in-flight-unknown running OverBudgetDetected: RunMutant timed out after headers: AbortError")` (use the method name that test's fixture discovers).
- [ ] **Step 2** **[bash]:** `bun test packages/runner/tests/orchestrator.test.ts -t "BASELINE test returning in-flight-unknown"`: FAIL.
- [ ] **Step 3:** `detail: \`baseline test in-flight-unknown running ${ref.method}: ${v.failureMessage ?? "no failure message"}\``.
- [ ] **Step 4:** Pass. `bun test packages/runner/tests/orchestrator.test.ts --update-snapshots`; `git diff packages/runner/tests/__snapshots__` shows ONLY the two `OverBudgetDetected` baseline lines gaining `: no failure message`.
- [ ] **Step 5:** Red-check: revert the line, the assertion goes red, restore; record both.
- [ ] **Step 6:** Full loop; commit `fix(R236): a baseline in-flight quarantine names the exit that fired`.

### Task 7: (reserved) nothing for H1 or H4

H1 is contradicted by existing evidence. H4 is not measured here (§5); R225's warm-up remedy is orchestrator-side and is filed in Task 13, not built.

### Task 8a: H2-action declared, a whole-action signal the PRODUCT can read (separate plan)

The probe decides "action ended" with `Get-NAVServerSession` from inside the container. The product has no such access, and the op marker alone does not prove the action ended (Evidence 3). So Task 8 is NOT licensed by the marker. Before Task 8, write and land a separate plan (`docs/superpowers/plans/<date>-R-236-action-ended-signal.md`) for a control app change that lets `GetOperationStatus` report, for the op's progress row, whether its `Session Id` is still present in BC's `Active Session` table (a new boolean, e.g. `opSessionActive`), with a version bump, `MIN_CONTROL_VERSION` lockstep, `/al-probe` measurement first that `Active Session` sees another OData session's row and drops it when that request ends, and its own live gate. This plan builds none of it. If that measurement fails (the table does not reflect it reliably), Task 8 is abandoned and Task 9 applies.

### Task 8: H2-action declared, Task 8a landed, D5 yes: the baseline retries only an ENDED action, and only an answered test verdict replaces the lost one

Baseline-specific and narrower than `runFenced`. One fresh attempt only when BOTH the marker says completed AND the Task 8a signal says the op's session is gone. `not-started` is never retried at baseline (so a late original cannot race the retry). The retry's result replaces the lost one ONLY if it is a genuinely answered test verdict: outcome `pass` or `fail`, no `operation` field. Every other retry exit fails closed: it is recorded, it stops measurement for the session (the existing quarantine or lease path), and nothing is pushed into `baseline`.

**Files:** `packages/runner/src/orchestrator.ts` (`scoreBatch`'s baseline loop, plus a small helper `baselineRetryAllowed`); `packages/runner/tests/orchestrator.test.ts`, new describe after the one at line ~6954 whose name ends `a proven-complete lost ack earns one fresh attempt (design §5)`, reusing `leaseBackend`, `FakeLeaseClient`, `leaseCfg`, `runSessionForTest`, `QuarantineStore`, `freshTmpDir`; for the running-op case copy the fake setup from the test at line ~7043 (`an UNRESOLVED lost ack is NEVER retried`), for `not-started` from the R194 describe at line ~7192, and for a lease loss from the `Task 8: lease-lost invalidation` describe at line ~6151.

**Interfaces:**
- Consumes: `reconcileFencedLostAck(leaseSession, verdict): Promise<LostAckOutcome>`; from Task 8a, `LeaseSession.actionEnded(op: { attemptId: string; opSeq: number }): Promise<boolean>` (true only when the server reports the op's session is no longer active; false on any doubt or read failure); `runOnce`, `classifyLeaseVerdict`, `handleBaselineLeaseOutcome`, `quarantineInFlight`.
- Produces: `async function baselineRetryAllowed(leaseSession: LeaseSession | undefined, v: TestVerdict): Promise<boolean>` = `v.operation === "in-flight-unknown" && v.fencedOp !== undefined && leaseSession !== undefined && (await reconcileFencedLostAck(leaseSession, v)) === "completed" && (await leaseSession.actionEnded(v.fencedOp))`.

- [ ] **Step 1: Failing tests.** One test per exit, each asserting the baseline dispatch count, the quarantine-store record (present or `null`), the report's `quarantined` reason or lease outcome, and that `report.mutants` is empty whenever measurement stopped.

```ts
describe("runSession: R236, a lost reply on a BASELINE test", () => {
  const LOST_OP = { attemptId: "a1", opSeq: 1 } as const;
  const TIER = "http://cronus281|BC";
  const ATTESTED = { observedAny: true, identityMismatch: false };
  const LOST: Partial<TestVerdict> = {
    outcome: "deadline-exceeded",
    failureMessage: "RunMutant timed out after headers: AbortError: The operation was aborted.",
    operation: "in-flight-unknown",
    fencedOp: LOST_OP,
  };
  const tombstoned = (attemptId: string, opSeq: number): OperationStatus => ({
    opKind: "none", opAttemptId: attemptId, opSeq, lastCompletedOpSeq: opSeq, completed: true,
  });

  /** Baseline-phase runs (before the first non-null activate) answer from `answers` in order,
   *  last repeating, counted in `counter.n`; later runs pass uncounted. */
  function backendWith(answers: readonly Partial<TestVerdict>[], counter: { n: number }) {
    let baselinePhase = true;
    return leaseBackend({
      activate: async (id) => {
        if (id !== null) baselinePhase = false;
      },
      run: async (ref) => {
        if (!baselinePhase) return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
        const a = answers[Math.min(counter.n, answers.length - 1)] ?? LOST;
        counter.n++;
        return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED, ...a };
      },
    });
  }

  /** A lease client whose marker says completed and whose Task 8a signal says `ended`. */
  function endedClient(ended: boolean): FakeLeaseClient {
    const c = new FakeLeaseClient();
    c.reconcileStatus = tombstoned;
    c.actionEnded = ended; // the Task 8a fake field; name it after what 8a actually adds
    return c;
  }

  test("1. action ended + retry PASS: the retry's verdict is the baseline; the lost attempt is a store row and a warning", async () => {
    const dir = freshTmpDir();
    const client = endedClient(true);
    const { lease } = leaseCfg(client);
    const counter = { n: 0 };
    const events: RunEvent[] = [];
    const report = await runSessionForTest(backendWith([LOST, { outcome: "pass" }], counter), {
      quarantineDir: dir, lease, emit: [(e) => events.push(e)],
    });
    expect(counter.n).toBe(2);
    expect(report.quarantined).toBeUndefined();
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.baselineGreen).toBe(true);
    const w = events.find((e) => e.type === "warning" && e.code === "baseline-lost-reply-retry");
    expect(w?.type === "warning" ? w.message : "").toContain("RunMutant timed out after headers");
    // plus: the store holds TWO baseline rows for this test, the lost one first
  });

  test("2. action ended + retry FAIL: recorded as failing at baseline, not dropped, not passed", async () => {
    /* answers [LOST, { outcome: "fail", failureMessage: "refused" }]; counter.n 2; no quarantine; baselineGreen false */
  });
  test("3. marker completed but action NOT ended: no retry, quarantine as today", async () => {
    /* endedClient(false); answers [LOST]; counter.n 1; quarantine record present; mutants empty */
  });
  test("4. unresolved (status read throws): no retry, quarantine", async () => { /* counter.n 1; record present */ });
  test("5. not-started: no retry at baseline, quarantine", async () => { /* R194 fake; counter.n 1; record present */ });
  test("6. op ours and still running: no retry, quarantine", async () => { /* line-7043 fake; counter.n 1; record present */ });
  test("7. retry reply LOST again: stop, quarantine, nothing enters the baseline set", async () => {
    /* answers [LOST, LOST]; counter.n 2; record present; mutants empty */
  });
  test("8. retry pre-dispatch-rejected twice: stop, quarantine, nothing enters the baseline set", async () => {
    /* answers [LOST, PRE, PRE] with PRE = { outcome: "error", failureMessage: "connect refused", operation: "pre-dispatch-rejected" };
       counter.n 3 (runOnce's one pre-dispatch retry); record present with detail naming "unmeasured baseline retry"; mutants empty */
  });
  test("9. retry bare protocol error (no operation): stop, quarantine, nothing enters the baseline set", async () => {
    /* answers [LOST, { outcome: "error", failureMessage: "RunMutant answer malformed: no sessionId" }] (no operation);
       counter.n 2; record present; mutants empty; baseline row for the test is NOT outcome "error" in report's baseline */
  });
  test("10. retry lease loss: the existing lease path stops the session, never a verdict", async () => {
    /* answers [LOST, <the lease-lost verdict shape the line-6151 tests use>]; counter.n 2;
       assert exactly what those tests assert for a first-attempt lease loss (latch reason, NO durable quarantine record); mutants empty */
  });
  test("11. resync failure before the retry: no retry, quarantine, a lost-reply-resync-failed warning", async () => {
    /* endedClient(true) and a resyncOpSeq that throws (inject the way the runFenced resync-failure test does; find it with
       grep -n "lost-ack-resync-failed" packages/runner/tests/orchestrator.test.ts); counter.n 1; record present; mutants empty */
  });
});
```

   Write every commented body out in full before Step 2. If `runSessionForTest` does not accept `emit`, read the warning from what the existing lost-ack tests read, and say which.
- [ ] **Step 2** **[bash]:** `bun test packages/runner/tests/orchestrator.test.ts -t "R236"`. Expected FAIL: 1, 2, 7, 8, 9, 10 and 11 (today the first lost answer quarantines after one dispatch, and there is no retry, warning or resync call). 3, 4, 5 and 6 pass already; they pin that the fix does not loosen those cases.
- [ ] **Step 3: Implement** in `scoreBatch`'s baseline loop:

```ts
  for (const ref of reused !== undefined ? [] : tests) {
    const opts = { coverage: caps.coverage, timeoutMs: scope.baselineTimeoutMs };
    let v = await runOnce(backend, safety, ref, opts, scope.resyncOpSeq);
    let unmeasuredRetry: string | undefined;
    // R236: a lost reply at baseline earns ONE fresh attempt, and only when the server proves the
    // first ACTION ended (marker completed AND its session gone, Task 8a). The lost attempt is
    // recorded first, so the incident is never hidden behind the retry.
    if (await baselineRetryAllowed(leaseSession, v)) {
      store.recordTestResult(runId, null, null, ref, v.outcome, v.durationMs, v.failureMessage, undefined, v.sessionId);
      emit({
        type: "warning",
        code: "baseline-lost-reply-retry",
        message: `[lethal] baseline ${ref.method}: the reply was lost after ${v.durationMs} ms (${v.failureMessage ?? "no detail"}); the server confirms the whole action ENDED, so its result is unknown and one fresh attempt is made (R236)`,
      });
      let resynced = true;
      if (scope.resyncOpSeq !== undefined) {
        try {
          await scope.resyncOpSeq();
        } catch (err) {
          resynced = false;
          emit({
            type: "warning",
            code: "lost-reply-resync-failed",
            message: `[lethal] baseline ${ref.method}: the op-seq resync before the retry failed (${messageOf(err)}); not retrying on a counter that may be wrong`,
          });
          unmeasuredRetry = `resync failed: ${messageOf(err)}`;
        }
      }
      if (resynced) {
        v = await runOnce(backend, safety, ref, opts, scope.resyncOpSeq);
        const answered = (v.outcome === "pass" || v.outcome === "fail") && v.operation === undefined;
        if (!answered && classifyLeaseVerdict(v) === "none") {
          unmeasuredRetry = `retry answered ${v.outcome}${v.operation !== undefined ? ` (${v.operation})` : ""}: ${v.failureMessage ?? "no detail"}`;
        }
      }
    }
    store.recordTestResult(/* unchanged arguments, for v */);
    /* classifyLeaseVerdict branch: unchanged (it handles a lease loss on the first attempt AND on the retry) */
    if (unmeasuredRetry !== undefined || (v.operation !== undefined && requiresUnsafeLatch(v.operation))) {
      await quarantineInFlight({
        safety, quarantineStore, resourceKey, nowIso,
        detail:
          unmeasuredRetry !== undefined
            ? `baseline test ${ref.method}: unmeasured baseline retry, ${unmeasuredRetry}`
            : `baseline test in-flight-unknown running ${ref.method}: ${v.failureMessage ?? "no failure message"}`,
      });
      break;
    }
    baseline.push({ ref, verdict: v });
  }
```

   The resync catch is mandatory, mirroring `runFenced`'s `lost-ack-resync-failed` handling. `baselineRetryAllowed` returns false (no retry) whenever `leaseSession` is undefined, so the pre-existing baseline-quarantine test is unaffected.
- [ ] **Step 4:** `bun test packages/runner/tests/orchestrator.test.ts`: all green, including the existing `a BASELINE test returning in-flight-unknown ...` test. No snapshot may change; if one does, stop and explain it.
- [ ] **Step 5: Red-check** (`mutation-red-checker`), restoring after each and recording every output:
   (a) delete the whole `if (await baselineRetryAllowed(...)) { ... }` block: tests 1, 2 and 7 to 11 go red.
   (b) drop `&& (await leaseSession.actionEnded(v.fencedOp))` from `baselineRetryAllowed`: test 3 goes red.
   (c) change `=== "completed"` to `!== "unresolved"`: test 5 goes red.
   (d) replace `answered` with `true`: tests 8 and 9 go red.
   (e) remove the try/catch around `resyncOpSeq` (call it bare): test 11 goes red.
   (f) delete the first `store.recordTestResult` in the block: test 1's two-row assertion goes red.
- [ ] **Step 6:** Full loop; `bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts`.
- [ ] **Step 7: Commit** `fix(R236): a baseline retries only an ENDED lost action, and only an answered verdict replaces it`.

### Task 9: H2-fence or H3 declared, no code

Neither can be retried safely, and R53 deliberately never stops a baseline session. Write the measured facts into R236 (the class, durations, marker and progress row, the post-fence cost distribution, event log excerpts) and `coord ask` the owner with three options and no pre-made choice: (a) recognise a TestPage test before dispatch (its own spec, since it changes which tests reach the server); (b) classify a baseline in-flight on a known-refused test as `inconclusive` in the orchestrator (R225's home); (c) take it to the BC platform team with the event log. For H2-fence, also (d): a spec to make the post-fence stages observable (for example progress-row writes after `StopApplicationCoverage` and after `CoverageArray`). Build nothing until the owner rules.

### Task 11: a main contrast says "raised"

Record which half (client: A vs B'; app: B' vs B; combined: A vs B) and file a roadmap item naming the parts that can differ (client half: the generated `Reached` markers in `packages/schemata/src/dispatch.ts` and the other commits in the §2 confound list; app half: `ObservedActive` in `ControlState.Codeunit.al` and `RunMany.Codeunit.al`), with the probe as its measurement tool. If Task 8 landed, a raised rate no longer costs a gate, so this is a follow-up, not a blocker.

(Task 10 of r1/r2, the `Connection: close` change, is removed: §5 explains why this measurement cannot license it.)

---

# Phase C: acceptance and roadmap

### Task 12: live acceptance

All on Cronus28 under `coord lease Cronus28 bugs`, one at a time, from the main checkout, foreground. Any quarantine: the recovery procedure (Task 4) before the next run. The lease is released only after Task 4's restore check passes.

- [ ] **Step 1: Probe, post-fix (only if Task 8 landed).** **[bash]** `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm post --sessions 30 --out C:/Users/SShadowS/AppData/Local/Temp/r236/post.ndjson`. Pass: zero `hit` sessions AND at least one `baseline-lost-reply-retry` warning for `PageActionComputesNonZero` (the fix ran live; zero hits alone is non-reproduction). No such warning in 30 sessions: run 30 more; still none: record "fix not exercised live".
- [ ] **Step 2: `itest:chunked`, 5 consecutive passes as a regression gate.** **[bash]** `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` five times. Each as frozen (both legs 17 / 7 / 2, verdicts and `killingTest` identical, control `warmKills` 9 / `groupedCalls` 33, chunked 5 / 57). A failure resets the count. This checks nothing regressed; it is not evidence the cause is gone.
- [ ] **Step 3: `itest:tables`, 5 consecutive passes.** **[bash]** check `grep -n "totalMutantSites:" packages/runner/itest/tables.itest.ts` and `bun -e 'console.log(require("./packages/runner/itest/tables.baseline.json").length)'`.
   - 407 and 387 (owner has re-recorded): `LETHAL_ITEST_TABLES=1 bun run itest:tables` five times, pass as frozen.
   - 397 and 377 (the state on 2026-09-26): the committed gate stops at the site count before any session. Run **locally adapted acceptance runs**, labelled so in every record and never called passes of the committed gate.

   **The ten-entry oracle, built once and reviewed.** Write `scripts/r236-baseline-probe/reach-keys.ts` (importable, CLI body under `import.meta.main`): it runs `generateMutationSet` offline on `fixtures/sandbox-data` exactly as `tables.itest.ts` does for its site count, and prints, for every `Data Reach Ops` mutant, its line, operator, procedure and the FULL comparison key built the way `mutant-equality.ts`'s `keyOf` builds it (`astHash|codeunitName|procedureName|operatorName|operatorMajor[|ordinal]`; take `astHash`, `operatorMajor` and `identityOrdinal` from the same fields the report's `MutantOutcome` is filled from, found with `grep -n "astHash\|identityOrdinal" packages/runner/src/orchestrator.ts`). It must print exactly ten rows with ten distinct keys, or exit 1. Then write `C:/Users/SShadowS/AppData/Local/Temp/r236/gh24-s3.json`: ten entries `{ key, line, operator, verdict, killingTest }`, each joined BY LINE AND OPERATOR to one row of the GH-24 spec §3 table (M0240 to M0249). A second reader checks all ten joins against §3 before the first run and signs off in the log.

   Then per run **[bash]**:

```bash
cd /u/Git/LethAL
trap 'git checkout -- packages/runner/itest/tables.itest.ts' EXIT
SCR=C:/Users/SShadowS/AppData/Local/Temp/r236/tables-run-$N.baseline.json
rm -f "$SCR"
# working tree only: BASELINE_PATH to $SCR, EXPECTED to GH-24 §5's figures
sed -i "s#^const BASELINE_PATH = .*#const BASELINE_PATH = \"$SCR\";#" packages/runner/itest/tables.itest.ts
# edit EXPECTED's §5 fields by hand (totalMutantSites 407, killed 301, survived 68, noCoverage 18,
# groupedCalls 382, reach grain 380/7/0); confirm with git diff before running
LETHAL_ITEST_TABLES=1 bun run itest:tables
bun -e '
import { diffMutants } from "./packages/runner/itest/mutant-equality";
const committed = require("./packages/runner/itest/tables.baseline.json");
const run = require(process.argv[1]);
const want = require("C:/Users/SShadowS/AppData/Local/Temp/r236/gh24-s3.json");
const isReach = (m) => m.key.split("|")[1] === "Data Reach Ops";
const old = run.filter((m) => !isReach(m));
const reach = run.filter(isReach);
const problems = [];
if (want.length !== 10 || new Set(want.map((w) => w.key)).size !== 10) problems.push("oracle is not ten distinct keys");
if (old.length !== 377) problems.push(`old mutants ${old.length}, want 377`);
if (reach.length !== 10 || new Set(reach.map((m) => m.key)).size !== 10) problems.push("run does not have ten distinct Data Reach Ops keys");
problems.push(...diffMutants(committed, old));
// one-to-one: every oracle key appears exactly once in the run, and every run key is in the oracle
const byKey = new Map(reach.map((m) => [m.key, m]));
for (const w of want) {
  const m = byKey.get(w.key);
  if (m === undefined) { problems.push(`missing ${w.key}`); continue; }
  byKey.delete(w.key);
  if (m.verdict !== w.verdict) problems.push(`${w.key}: verdict ${m.verdict}, want ${w.verdict}`);
  if ((m.killingTest ?? null) !== (w.killingTest ?? null)) problems.push(`${w.key}: killingTest ${m.killingTest}, want ${w.killingTest}`);
}
for (const k of byKey.keys()) problems.push(`unexpected ${k}`);
if (problems.length > 0) { console.error(problems); process.exit(1); }
console.log("adapted acceptance run OK");
' "$SCR"
git checkout -- packages/runner/itest/tables.itest.ts
```

   Pass per run: the gate passes end to end AND the check prints `adapted acceptance run OK`. Discard each `$SCR` after review; commit neither it, `gh24-s3.json` nor `EXPECTED`. `reach-keys.ts` IS committed (it is a reusable offline tool): `git add scripts/r236-baseline-probe/reach-keys.ts && git commit -m "measure(R236): offline full keys for the GH-24 reach arm"`. Confirm `git status --short packages/runner/itest` is empty after every run, pass or fail.
- [ ] **Step 4: `itest:bcdev`, once.** **[bash]** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`. Pass as frozen: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, `assertionScreen.discrimination` `vacuous`, per-mutant equal to `bcdev.baseline.json`.
- [ ] **Step 5:** Task 4's restore check, then release the lease. Record every run's result in the spec's OUTCOME under "Acceptance".

### Task 13: roadmap

- [ ] **Step 1** **[bash]:** `ls docs/roadmap/` for the next free id immediately before filing.
- [ ] **Step 2: R236 is the ROOT-CAUSE item and stays open unless the cause is located.** Close it as `done (<commit>)` only if Phase A DECLARED a mechanism AND the evidence explains why the reply is lost (for example the event log names the failure, or the post-fence stage that stalls is identified), AND the fix for that cause landed and Task 12 passed. If only the consequence was fixed (Task 8, which stops a lost reply from costing a session), R236 stays open: add the fix and its commit to R236 as "consequence mitigated", and keep the title question open.
- [ ] **Step 3: R225.** Correct its "What `in-flight-unknown` means here" account with run 339's stored evidence (body read died at 29.5 s on a socket close; not the timer). Do not close it on this plan: its fresh-bootstrap claim was not retested (§5). Leave it open, narrowed to that claim, unless the owner rules otherwise.
- [ ] **Step 4: File what remains**, one file each: the fresh-bootstrap and warm-up question (if not kept in R225); Task 8a if H2-action was declared and 8a is not yet built; Task 9's owner ruling; Task 11's follow-up; an H7 item needing a per-request socket-identity observable, if H7-candidate or wire failures were seen; truncation (H8) if declared; and the `itest:hang` M0004 occurrence if broken calls were not TestPage-specific (the group path reconciles through `runFencedMany`, so file it as "measure", not "fix").
- [ ] **Step 5** **[bash]:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`; commit the roadmap files and `ROADMAP.md` together.

---

## Review responses

### Round 1 (`review-r1.md`), all accepted

1. Probe could strand Cronus28: stop rule after a hit, recover-tier-only recovery, segments. Tightened again in round 2 (whole-action test).
2. No guaranteed restoration: mandatory restore check before release; `-doNotSaveData` asked up front (now D4).
3. "Completed" is not the root cause: Evidence rewritten; R225's timer account corrected in Task 13. Extended in round 2.
4. Baseline retry safety: owner decision (now D5), `completed`-only, lost attempt kept. Extended in round 2.
5. Tracer not neutral, H8 unmeasurable: streaming byte count, pass-through `init`, fast hook, slow evidence after the session.
6. ABA mixed client and app: arm B' added, contrasts stated with their limits, versions verified. D questions fixed in round 2.
7. Rules overclaimed: wording, minimums, inconclusive outcome, segment rules, no restarts. Statistics fixed in round 2.
8. `Connection: close` not licensed: in round 2 the branch is removed entirely.
9. Acceptance overclaimed: luck calculation removed, gates are regression checks, R225 not closed.
10. Tables comparison: automated, labelled, restored on exit. Made one-to-one in round 2.
11. Operator detail: shells named, output dir created, versions and diffs recorded, `fetchControlVersion()`.

### Round 2 (`review-r2.md`), all accepted

1. **Critical, a tombstone is not the end of the action.** Evidence 3 states that `RunMutantWithCoverage` does coverage stop, `CoverageArray` and serialisation AFTER `RunMutant` tombstones the marker. The probe now tests whole-action completion: marker completed AND the call's own BC session (from `LC Op Progress."Session Id"`) absent from `Get-NAVServerSession`; otherwise it stops for recovery (Task 2 requirement 7 and 8). Task 8 is not licensed by the marker; it requires Task 8a, a separate plan for a product-readable session-ended signal.
2. **Critical, unmeasured retry exits.** Only an answered `pass`/`fail` with no `operation` replaces the lost result; pre-dispatch rejected twice, a bare protocol error, a lost reply again and a resync failure all quarantine with an "unmeasured baseline retry" detail and never enter `baseline`; a lease loss takes the existing lease path. The resync catch is in the code, not conditional. Tests 7 to 11 cover one exit each, with red-checks (d) and (e).
3. **H2 is not the root cause.** H2 split into H2-action and H2-fence; the probe records the post-fence stage costs (`coverageRunMs`, `coverageSerializeMs`) and NST evidence; H2-fence leads to Task 9, not a retry; Task 13 keeps R236 open when only the consequence is fixed.
4. **Statistics on actual sizes.** §3 now defines every test on actual counts by formula, one-sided for the main contrasts and two-sided for drift, with separate convenience tables for 30 vs 30 and 15 vs 15, and a short-arm rule ("underpowered: not decided" below two thirds of planned).
5. **Socket reuse not observable.** The arm C experiment and the `Connection: close` task are removed; §5 says H7 is only a candidate here, and Task 13 files an item that needs a per-request socket identity first. H8 is reworded as "truncated as seen by the client".
6. **D questions and B gating.** D1 to D5 are now separate yes/no questions (combined contrast, app-only contrast, downgrade, data discard, retry policy). B runs iff (D1 or D2) and D3; the HTTP-scope question is gone with Task 10.
7. **Ten-entry oracle.** `reach-keys.ts` derives the ten full comparison keys offline (they include `astHash` and the ordinal, so they identify the site); `gh24-s3.json` must hold exactly ten distinct keys joined to §3 by line and operator, reviewed by a second reader; the check matches one-to-one by key and reports missing and unexpected keys.
8. **Minor, stream test.** The partial-byte test now uses a pull-based stream that errors only on the second pull, after the first chunk was consumed; the smoke comparison is labelled a sanity check only.
9. **Minor, interruption.** A before-state file, a `coord` handoff note before the downgrade, and a held lease make an interrupted downgrade visible; the residual limit is stated in Task 4.

Not verified while revising (the executor checks each where the plan says): that Bun's `pipeThrough` keeps the upstream error object (Task 1 has a fallback); that the 7b7fff3 client accepts a 1.0.0.19 answer with the extra `observedActive` field; the exact SQL table name of `LC Op Progress` and that `Invoke-Sqlcmd` reaches the tenant database from `Invoke-ScriptInBcContainer` (if the session id cannot be read, `actionEnded` is always false and every hit stops the arm, which is safe but costly); that `Get-NAVServerSession` lists OData sessions by the same id the control app records; that `runSessionForTest` accepts `emit`; that `lethal doctor` answers while a stranded marker is set; the exact `coord` subcommand for a container note.
