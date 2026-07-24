#!/usr/bin/env bun
/**
 * Env-gated LIVE integration probes for Layer 5C-B1's machine-global lease + two-phase `RunMutant`
 * fence (design §9 "Testing & the gate (blocking mid-run + lifecycle probes)"). NOT a `bun:test`
 * file — standalone script invoked via `bun run itest:lease` (root package.json), never picked up
 * by `bun test`. Skips cleanly (exit 0) when `LETHAL_ITEST_BCDEV` is unset — the SAME env var
 * `bcdev.itest.ts`/`stale-publish.itest.ts` gate on (this needs the same live infra, so it reuses
 * that var rather than inventing a second one, matching `stale-publish.itest.ts`'s precedent).
 *
 * Reads the same gitignored local files as the other bcdev itests:
 *   fixtures/sandbox-app/.vscode/launch.local.json
 *   fixtures/sandbox-app/lethal.config.local.json
 *
 * WHERE THIS FITS: `bcdev.itest.ts` proves the frozen 3/10/3 verdict table reproduces UNDER a held
 * lease (design §9's first bullet). This file proves the REST of §9 — the blocking mid-run and
 * lifecycle probes — by driving `LeaseClient` + `RunMutantTransport` directly (never through
 * `runSession`/the orchestrator), the same way `stale-publish.itest.ts` drives `ContainerDeployer`
 * directly to test what `runSession` would otherwise hide behind its own retry logic.
 *
 * REFERENCE (authoritative, live-verified 21/21 on Cronus281): `scripts/probe-5cb1.ts` proved every
 * request/response shape below over raw OData before Tasks 6-8 built the typed client on top of it.
 * Several probes here structurally mirror specific checks from that script (named per-probe below)
 * because they are still the correct live proof for that behaviour — this file does not re-invent
 * them, it re-expresses them against the typed `LeaseClient`/`RunMutantTransport` API design §9
 * requires, plus the lifecycle probes that script never attempted (contention, orphaning, recovery).
 *
 * FOUR DELIBERATE SUBSTITUTIONS this file makes, each documented again at its point of use:
 *   1. "Slow RunMutant" (P9): `RunMutant`'s phase 1-2-3 all execute inside ONE HTTP round trip
 *      (milliseconds for this fixture — see `scripts/probe-5cb1.ts`'s own comment on why no fixture
 *      test method sleeps or loops long enough to fake this) — it cannot be held open by the client
 *      for a controlled multi-second window. `BeginPublish`/`EndPublish`'s two-call op marker CAN,
 *      and from `AcquireLease`'s perspective a publish marker and a run marker are classified
 *      IDENTICALLY (`Op Kind <> none`, design §4; `ControlState.Codeunit.al:361-363` tests only
 *      `Op Kind <> none`, never the kind) — so P9 holds a publish marker open across a real sleep
 *      instead. IMPORTANT — what this substitution costs P9, see the P9-specific note below: it is
 *      NOT interchangeable with a genuinely slow, in-flight `RunMutant` call for every purpose §9
 *      asks this probe to serve.
 *   2. "Healthy contention" (P8): same substitution as #1, for the same reason (no fixture test
 *      method runs long enough to hold `RunMutant` open) — P8 also holds a `BeginPublish`/
 *      `EndPublish` marker in place of "session A runs". Defensible for the SAME reason as #1:
 *      `TryAcquire`'s busy/orphaned classification does not distinguish op kind
 *      (`ControlState.Codeunit.al:361-363`), so a publish marker exercises the identical
 *      busy/orphaned/no-quarantine contract a run marker would. Unlike P9 (see below), P8's claim
 *      — the classification treats a healthy, renewed marker as busy and writes no quarantine — does
 *      not depend on anything actually executing between begin and end, so this substitution does
 *      not weaken P8's proof.
 *   3. "Deterministic-rejected publish" (P7): a REAL live altool version-downgrade rejection is
 *      already exhaustively proven by `stale-publish.itest.ts`'s Probe A — but Probe A and P7 only
 *      jointly cover HALVES of the end-to-end rejected-publish path, not the whole thing; see the
 *      P7-specific note below for exactly what remains unproven by either. This file's job is the
 *      narrower, LEASE-layer claim design §5/§6 makes about it — `EndPublish` clears the marker on
 *      ANY confirmed terminal outcome, success or failure, because `ControlState.TryEndPublish`
 *      does not branch on the `outcome` string's content (it is not even a parameter to the state
 *      transition — `ControlState.Codeunit.al:552-554`) — so P7 reports a realistic rejection
 *      message through the SAME `EndPublish` call a real altool rejection would drive the runner
 *      through, without re-running the whole compile/publish pipeline `stale-publish.itest.ts`
 *      already owns.
 *   4. "Lost ack" (P5): a real dropped TCP ack cannot be forced client-side in-process. What IS
 *      provable, and is the actual property reconciliation depends on, is that `GetOperationStatus`
 *      — an INDEPENDENT second channel — reports the exact same state the direct response already
 *      claimed, at every step. If the direct ack had genuinely been lost, this is the call that
 *      would have recovered the truth.
 *
 * WHAT A GREEN P9 DOES AND DOES NOT PROVE — read this before trusting a green P9 as closing design
 * §9's "slow-run-under-renew" property. P9 traces to Round-1 finding sol#1 ("lock across run
 * starves renew/steal"), whose fix was "lock only in short critical sections": `TryBeginRun`/
 * `TryFinishRun` each take a short `LockTable()`, commit, and release BEFORE phase 2 runs, so phase
 * 2 holds no lease lock (`ControlState.Codeunit.al:632-635`). The property sol#1 exists to guarantee
 * is that WHILE A REAL `RunMutant` CALL IS GENUINELY IN FLIGHT (an AL test actually executing on the
 * container), a concurrent `RenewLease` can still land — i.e. phase 2's absence of a held lock does
 * not starve the heartbeat. P9 holds a `BeginPublish`/`EndPublish` marker (substitution #1 above) —
 * nothing is executing against BC between the two calls, and no lock is contended by anything during
 * the hold — so P9 cannot exercise that. What P9 DOES prove: the op-marker busy/orphaned
 * classification treats a long-held, continuously-renewed marker as busy for the WHOLE hold
 * regardless of op kind, and a competing acquire stays fenced throughout. What it does NOT prove:
 * sol#1's actual concern. A regression of "lock only in short critical sections" (e.g. someone
 * reintroducing a `LockTable()` held across phase 2) would NOT be caught by any probe in this file —
 * it would need a deliberately-slow AL fixture test method genuinely held open across a live
 * `RunMutant` call, which is out of scope here. Track this as a residual gap, not something a green
 * P9 closes.
 *
 * UPDATE (Layer 5C-B2): that fixture now exists — `fixtures/sandbox-probes/src/SlowRunProbe.Codeunit.al`
 * ("Slow Run Probe", codeunit 79212) sleeps ~23s inside a real `[Test]` method. `P9B` (below, after
 * P9) drives it through an actual `RunMutant` call and proves sol#1's real concern directly. This
 * paragraph and P9 itself are left as they were — P9B is additive, not a replacement.
 *
 * WHAT P7 + `stale-publish.itest.ts` PROBE A DO AND DO NOT JOINTLY PROVE about the rejected-publish
 * path. Probe A calls `ctx.deployer.publish(artifactA)` (`stale-publish.itest.ts:550`) directly
 * against a raw `ContainerDeployer` — no lease, no `BeginPublish`, no `EndPublish` — so it proves the
 * altool-level rejection mechanics (a real downgrade IS rejected) in complete isolation from the
 * lease/marker machinery. P7 calls `client.endPublish` directly with a synthetic rejection message,
 * bypassing the runner's own catch block entirely. The production glue that actually catches a
 * publish failure and calls `endPublish(attemptId, opSeq, "failed")` lives in
 * `orchestrator.ts:892-914` (`ContainerDeployer.publish`'s own try/catch) — and NEITHER probe
 * exercises that glue against a genuine live altool rejection; it is covered only by unit tests, not
 * by any live probe in this file or `stale-publish.itest.ts`. P7 proves `EndPublish` clears on any
 * outcome string; Probe A proves altool actually rejects a downgrade. Each proves one half of the
 * path; together they still leave the wiring between them live-unproven.
 *
 * WHAT P8 AND P10 PROVE ABOUT `acquireSessionLease`'S RETRY LOOP, AND WHAT THEY DON'T. Both probes
 * locally reimplement pieces of `orchestrator.ts`'s `acquireSessionLease` acquire-retry loop instead
 * of driving `acquireSessionLease`/`runSession` itself — required by this file's own design (drive
 * `LeaseClient`/`RunMutantTransport` directly, never through `runSession`), not a defect. P8 mirrors
 * the busy-retry half (treat "operation-busy" as expected, keep polling); P10 mirrors the
 * orphan-specific re-check-once half (compare this file's P10 loop against
 * `orchestrator.ts:646-658`: re-check exactly once on an unchanged (opAttemptId, opStartedAt) marker
 * before concluding it's stranded). Together they mean a green P8/P10 proves the SERVER's
 * busy/orphaned classification and reset contract, and that the re-check-once pattern is soundly
 * implementable against that contract — NOT that `orchestrator.ts`'s own copy of the pattern is
 * bug-free. A regression introduced only inside `acquireSessionLease` itself (e.g. dropping the
 * marker-unchanged comparison, or re-checking zero or three times instead of once) would pass every
 * probe in this file untouched.
 *
 * Every probe acquires its OWN fresh lease (own nonce/owner, own `serverGeneration` read) rather
 * than sharing state with another probe — see the task report for the one real ordering coupling
 * (P8 must run before P10: both share one local `QuarantineStore` file, and P8's "no record exists"
 * assertion is only a meaningful proof if nothing has written to it yet).
 *
 * CLEANUP STRATEGY: every probe past P2 (P1/P2 are pure reads — no lease is ever acquired) wraps
 * its body in `finally { await recoverContainerBestEffort(...) }` — an UNCONDITIONAL, idempotent
 * `ForceResetLease` against the live generation (design §8's own recovery mechanism). This is safe
 * to call even on a probe's happy path (every probe below re-reads `serverGeneration` fresh rather
 * than caching it, precisely so a mid-run generation bump from another probe's cleanup never
 * matters) and guarantees no probe can strand the container for whichever probe runs next,
 * regardless of exactly where inside it an assertion throws. It does not weaken the probes' power:
 * every meaningful claim (release/EndPublish/ForceResetLease actually doing what design §4/§5/§8
 * say) is asserted explicitly INSIDE each probe's own try body, before the finally ever runs — the
 * blanket reset only ever executes after a real failure is already recorded, or on an already-clean
 * happy path. `P10` (orphaned-op recovery) is the probe most likely to leave residue if it fails
 * before its own `finally` executes (e.g. the process is killed outright, or the finally's own
 * `ForceResetLease` call itself hits a network error) — see the task report.
 *
 * KNOWN LIVE-GATE NOISE (not a failure): `HarnessVerifier.verify()`'s `console.warn` about the
 * unenforced design §7 tenant gate fires on EVERY acquire+every cleanup call in this file (dozens of
 * times) — expected, per the brief; do not read a noisy stdout as a failure signal.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef } from "../src/backend";
import type { LethalConfigFile } from "../src/cli";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import { HarnessVerifier } from "../src/harness";
import type { Lease, LeaseTuple } from "../src/lease";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import type { QuarantineRecord } from "../src/quarantine-store";
import { QuarantineStore } from "../src/quarantine-store";
import { quarantineResourceKey } from "../src/resource-key";
import { RunMutantTransport } from "../src/run-mutant-transport";

if (!process.env.LETHAL_ITEST_BCDEV) {
  console.log(
    "skipped (set LETHAL_ITEST_BCDEV=1 and populate the gitignored launch.local.json / " +
      "lethal.config.local.json fixture files to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");

// Frozen sandbox target app id (fixtures/sandbox-app/app.json "id"), same constant bcdev.itest.ts /
// stale-publish.itest.ts already use.
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
/** P6's catchable-boundary target: "LC Control API" itself (71003) — guaranteed to exist, guaranteed
 *  not a Subtype=Test codeunit. Same trick as `scripts/probe-5cb1.ts`'s D5 check (already live-proven
 *  21/21 there): `RunMethod.Codeunit.al` fails closed against it, caught by `RunMutant`'s
 *  `if Runner.Run() then ... else BuildRunError` — a server-known terminal, never an HTTP error. */
const NOT_A_TEST_CODEUNIT_ID = 71003;
/** P9B's genuinely-slow target: `fixtures/sandbox-probes/src/SlowRunProbe.Codeunit.al`'s "Slow Run
 *  Probe" — a `[Test]` method that sleeps ~23s server-side, entirely inside `SleepsAcrossRenewWindow`
 *  itself. Requires `sandbox-probes` republished at `app.json` version >= 1.0.1.0. */
const SLOW_RUN_PROBE_CODEUNIT_ID = 79212;
const RUN_MUTANT_TIMEOUT_MS = 60_000;

/** Mirrors `ControlState.Codeunit.al`'s `local procedure RenewPeriodMs(): Integer` (5000ms,
 *  unreadable over the wire — see `lease.ts`'s `MAX_TTL_SECONDS` doc comment for the same citation). */
const SERVER_RENEW_PERIOD_MS = 5_000;
/** Mirrors `ControlState.Codeunit.al`'s `local procedure GraceMs(): Integer` = 3 x RenewPeriodMs().
 *  `AcquireLease` classifies an unresolved op marker as `operation-orphaned` only past
 *  `Expires At + GraceMs()` — everything within that window is `operation-busy`. */
const SERVER_GRACE_MS = 3 * SERVER_RENEW_PERIOD_MS;

/** P3's delayed-renew-after-release wait — mirrors `scripts/probe-5cb1.ts`'s `B6_RENEW_DELAY_MS`. */
const RELEASE_RENEW_DELAY_MS = 500;

const P8_TTL_SECONDS = 6;
const P8_HEARTBEAT_MS = 2_000;
const P8_POLL_INTERVAL_MS = 2_000;
const P8_CONTENTION_POLLS = 4;

const P9_TTL_SECONDS = 5;
const P9_HEARTBEAT_MS = 2_000;
const P9_POLL_INTERVAL_MS = 3_000;
/** Grace + one renew period + slack: the window a holder WITHOUT renewal would already have aged
 *  past `operation-orphaned` (mirrors `ControlState.Codeunit.al`'s own `RunClaimRunwayMs()`
 *  derivation). Holding+renewing across this window and staying `operation-busy` throughout is the
 *  actual proof that renewal — not mere marker presence — is what keeps a long op fenced. */
const P9_HOLD_MS = SERVER_GRACE_MS + SERVER_RENEW_PERIOD_MS + 3_000;

/** P9B: pacing only, NOT the overlap proof — see the probe body's comment on what actually proves
 *  overlap (observed promise-settlement ordering, never wall-clock timing). 500ms initial settle
 *  (let phase 1's short LockTable claim land) + 4 x 3000ms polls = ~12.5s total, comfortably inside
 *  Slow Run Probe's ~23s sleep. */
const P9B_INITIAL_SETTLE_MS = 500;
const P9B_RENEW_COUNT = 4;
const P9B_RENEW_POLL_MS = 3_000;

const P10_TTL_SECONDS = 3;
const P10_POLL_INTERVAL_MS = 3_000;
/** 16 x 3s = 48s ceiling — comfortably past the ~18-21s window an unrenewed `P10_TTL_SECONDS`-second
 *  lease needs to cross the orphan threshold TWICE (first sighting, then the unchanged re-check). */
const P10_MAX_POLL_ATTEMPTS = 16;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOf(json: Record<string, unknown>, key: string): number | undefined {
  const v = json[key];
  return typeof v === "number" ? v : undefined;
}
function strOf(json: Record<string, unknown>, key: string): string | undefined {
  const v = json[key];
  return typeof v === "string" ? v : undefined;
}
function boolOf(json: Record<string, unknown>, key: string): boolean | undefined {
  const v = json[key];
  return typeof v === "boolean" ? v : undefined;
}

function newAttemptId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Best-effort extraction of the AL/OData error message from a non-2xx body — mirrors
 *  `scripts/probe-5cb1.ts`'s `extractODataError`, already live-proven against this exact server. */
function extractODataError(rawText: string): string {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // rawText wasn't JSON at all — fall through and report it verbatim.
  }
  return rawText.length > 0 ? rawText : "(empty error body)";
}

interface RawActionResult {
  readonly httpOk: boolean;
  readonly httpStatus: number;
  readonly errorText: string | undefined;
  readonly json: Record<string, unknown> | undefined;
}

/**
 * POST one `LethALControl_<action>` OData action WITHOUT going through `LeaseClient` — needed for
 * the two calls `LeaseClient` deliberately does not expose: a genuinely v1-shaped `HarnessInfo`
 * (P1/P2) and `ForceResetLease` (P10 + the cleanup helper), which is an operator action outside
 * `LeaseApi`'s normal session surface. Double-JSON-parsed OData scalar `value`, same shape every
 * other action in this repo uses — mirrors `LeaseClient`'s own private `postLeaseAction` (not
 * exported) and `scripts/probe-5cb1.ts`'s `postActionJson`.
 */
async function postRawAction(
  cfg: ActivationConfig,
  action: string,
  body: Record<string, unknown>,
): Promise<RawActionResult> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    rawText = await res.text();
  } catch (err) {
    return {
      httpOk: false,
      httpStatus: 0,
      errorText: `network error: ${String(err)}`,
      json: undefined,
    };
  }
  if (!res.ok) {
    return {
      httpOk: false,
      httpStatus: res.status,
      errorText: extractODataError(rawText),
      json: undefined,
    };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    return {
      httpOk: true,
      httpStatus: res.status,
      errorText: `2xx body is not JSON: ${rawText}`,
      json: undefined,
    };
  }
  const outerValue = isRecord(envelope) ? envelope.value : undefined;
  if (typeof outerValue !== "string") {
    return {
      httpOk: true,
      httpStatus: res.status,
      errorText: `2xx envelope has no string "value": ${JSON.stringify(envelope)}`,
      json: undefined,
    };
  }
  let inner: unknown;
  try {
    inner = JSON.parse(outerValue);
  } catch {
    return {
      httpOk: true,
      httpStatus: res.status,
      errorText: `"value" is not JSON: ${outerValue}`,
      json: undefined,
    };
  }
  if (!isRecord(inner)) {
    return {
      httpOk: true,
      httpStatus: res.status,
      errorText: `parsed "value" is not an object: ${JSON.stringify(inner)}`,
      json: undefined,
    };
  }
  return { httpOk: true, httpStatus: res.status, errorText: undefined, json: inner };
}

/** Read-only: the artifact id `bcdev.itest.ts` (or any prior publish) registered for
 *  `TARGET_APP_ID` — single-parse OData scalar (see `RegisteredArtifact`'s doc comment: its AL
 *  return type is a bare `Text`, not a `JsonObject.WriteTo`'d string). Duplicated from
 *  `bcdev.itest.ts`'s identical helper, matching this repo's existing convention of small,
 *  independent itest-script helpers rather than sharing internals across `main()`-scripts. */
async function odataReadRegisteredArtifact(
  cfg: ActivationConfig,
  targetAppId: string,
): Promise<string> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/LethALControl_RegisteredArtifact?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetAppId }),
  });
  if (!res.ok) {
    throw new Error(`RegisteredArtifact read failed: HTTP ${res.status} ${await res.text()}`);
  }
  const value = ((await res.json()) as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly server?: string;
    readonly serverInstance?: string;
    readonly tenant?: string;
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * Universal cleanup safety net — see the file header's "CLEANUP STRATEGY". `ForceResetLease` is
 * design §8's own recovery mechanism: unconditional (clears "Op Kind"/the active row and mints a
 * fresh generation regardless of whether anything was actually stranded) and idempotent-safe to
 * call redundantly. Swallows its own failures (logged, never thrown) — a cleanup helper that itself
 * throws would replace a probe's real failure with a confusing secondary one.
 */
async function recoverContainerBestEffort(cfg: ActivationConfig, label: string): Promise<void> {
  try {
    const live = await new HarnessVerifier(cfg).verify();
    const reset = await postRawAction(cfg, "ForceResetLease", {
      expectedGeneration: live.serverGeneration,
    });
    if (!reset.httpOk || reset.json === undefined || boolOf(reset.json, "reset") !== true) {
      console.error(
        `  [${label}] cleanup: ForceResetLease did not confirm reset:true (httpStatus=${reset.httpStatus}, ` +
          `body=${JSON.stringify(reset.json)}, errorText=${reset.errorText}) — the container may need manual design §8 recovery`,
      );
    }
  } catch (err) {
    console.error(
      `  [${label}] cleanup: best-effort ForceResetLease failed — the container may still need manual ` +
        `design §8 recovery: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface FreshLease {
  readonly client: LeaseClient;
  readonly lease: Lease;
  /** The next exactly-next `opSeq` for a fenced call under this lease (design §4). */
  readonly nextOpSeq: () => number;
  readonly tuple: () => LeaseTuple;
}

/**
 * Acquires a brand-new lease with its OWN fresh nonce/owner/`serverGeneration` read. Every probe
 * calls this independently rather than sharing one lease across probes, so a probe's own failure
 * (or its cleanup's `ForceResetLease`, which mints a new generation) can never leave another probe
 * silently depending on stale state.
 */
async function acquireFresh(
  cfg: ActivationConfig,
  label: string,
  ttlSeconds: number,
): Promise<FreshLease> {
  const harness = await new HarnessVerifier(cfg).verify();
  const client = new LeaseClient(cfg);
  const outcome = await client.acquire(
    `${hostname()}:${process.pid}:lease-itest:${label}`,
    ttlSeconds,
    randomUUID(),
    harness.serverGeneration,
  );
  if (!outcome.granted) {
    throw new Error(
      `[${label}] AcquireLease was not granted (${JSON.stringify(outcome)}) — the container is held or has a stranded operation from a prior run; recover per design §8 before re-running this itest`,
    );
  }
  const lease = outcome.lease;
  let opSeq = lease.lastCompletedOpSeq;
  return {
    client,
    lease,
    nextOpSeq: () => ++opSeq,
    tuple: () => ({
      epoch: lease.epoch,
      token: lease.token,
      serverGeneration: lease.serverGeneration,
    }),
  };
}

// ===================================================================================================
// P1 — v1-vs-v2 handshake (design §7/§9). No lease acquired — pure reads, no cleanup needed.
// ===================================================================================================

async function probeV1V2Handshake(cfg: ActivationConfig): Promise<void> {
  const label = "P1 v1-vs-v2-handshake";

  // A genuinely v1-shaped call: no `clientProtocol` key at all. Design §7: the v2 server must
  // refuse this before any publish, whether the OData layer rejects the missing required
  // parameter outright or AL's own `if ClientProtocol < 2` check fires on a defaulted value —
  // either way this must be non-2xx.
  const empty = await postRawAction(cfg, "HarnessInfo", {});
  if (empty.httpOk) {
    throw new Error(
      `[${label}] HarnessInfo with NO clientProtocol key (a v1-shaped call) must be refused before any ` +
        `publish, got a 2xx: ${JSON.stringify(empty.json)}`,
    );
  }
  console.log(
    `  [${label}] v1-shaped (empty body) HarnessInfo refused: httpStatus=${empty.httpStatus} errorText=${empty.errorText}`,
  );

  // A supplied-but-too-low clientProtocol: AL's own explicit check must refuse it too, naming both
  // sides (design §7's `ProtocolIncompatibleErr`).
  const v1 = await postRawAction(cfg, "HarnessInfo", { clientProtocol: 1 });
  if (v1.httpOk) {
    throw new Error(
      `[${label}] HarnessInfo(clientProtocol:1) must be refused (below the v2 minimum), got a 2xx: ${JSON.stringify(v1.json)}`,
    );
  }
  const namesBoth = (v1.errorText ?? "").includes("1") && (v1.errorText ?? "").includes("2");
  assert.ok(
    namesBoth,
    `[${label}] HarnessInfo(clientProtocol:1)'s refusal should name both the caller's version and the ` +
      `server's protocolVersion, for diagnosability — got errorText=${JSON.stringify(v1.errorText)}`,
  );
  console.log(`  [${label}] clientProtocol:1 refused: errorText=${v1.errorText}`);
}

// ===================================================================================================
// P2 — multi-tenant refusal, documented not enforced (design §7/§9). No lease acquired.
// ===================================================================================================

async function probeMultiTenantRefusalNote(cfg: ActivationConfig): Promise<void> {
  const label = "P2 multi-tenant-refusal (documented, not enforced)";

  // A human has ruled this: single-tenant-only is a stated support constraint, not something this
  // container can be made to enforce — AL genuinely cannot enumerate tenants from an extension (see
  // ControlApi.HarnessInfo's doc comment: System Application codeunit 417 exposes only the CURRENT
  // tenant). There is therefore no live ">1 tenant" refusal a probe against this container could
  // ever provoke — asserting one would assert something structurally impossible here. Instead this
  // asserts what IS true: the server honestly reports it cannot count tenants, and the client
  // reflects that as "unenforced" rather than faking a pass.
  const details = await new HarnessVerifier(cfg).verify();
  assert.equal(
    details.tenantGate,
    "unenforced",
    `[${label}] expected HarnessVerifier to report tenantGate:"unenforced" against this ` +
      `(tenantCountReachable:false) container, got ${JSON.stringify(details)}`,
  );

  const raw = await postRawAction(cfg, "HarnessInfo", { clientProtocol: 2 });
  if (!raw.httpOk || raw.json === undefined) {
    throw new Error(
      `[${label}] a raw HarnessInfo(clientProtocol:2) read must succeed, got httpStatus=${raw.httpStatus} errorText=${raw.errorText}`,
    );
  }
  assert.equal(
    boolOf(raw.json, "tenantCountReachable"),
    false,
    `[${label}] expected the raw HarnessInfo body to report tenantCountReachable:false, got ${JSON.stringify(raw.json)}`,
  );
  console.log(
    `  [${label}] confirmed: tenantCountReachable:false live, HarnessVerifier surfaces tenantGate:"unenforced" — the single-tenant gate is a documented operational constraint (verify out of band via Get-BcContainerTenants / Get-NAVTenant), not something this container can make this client enforce`,
  );
}

// ===================================================================================================
// P3 — delayed renew after release cannot resurrect the lease (design §4/§9).
// ===================================================================================================

async function probeDelayedRenewAfterRelease(cfg: ActivationConfig): Promise<void> {
  const label = "P3 delayed-renew-after-release";
  const a = await acquireFresh(cfg, "p3", MAX_TTL_SECONDS);
  try {
    const released = await a.client.release(a.tuple());
    assert.equal(
      released.released,
      true,
      `[${label}] ReleaseLease must succeed for the just-granted tuple, got ${JSON.stringify(released)}`,
    );

    // "Delayed" is real wall-clock here (mirrors scripts/probe-5cb1.ts's B6) — the point is the
    // passage of time after release, not a request race.
    await sleep(RELEASE_RENEW_DELAY_MS);

    const renewed = await a.client.renew(a.tuple(), MAX_TTL_SECONDS);
    assert.equal(
      renewed.renewed,
      false,
      `[${label}] a delayed RenewLease using the RELEASED (epoch,token,generation) must report renewed:false — release invalidates renewal credentials (design §4) so a delayed renew cannot resurrect the lease. Got ${JSON.stringify(renewed)}`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P4 — a delayed EndPublish cannot clear a LATER op (design §4/§9).
// ===================================================================================================

async function probeDelayedEndPublishCannotClearLaterOp(cfg: ActivationConfig): Promise<void> {
  const label = "P4 delayed-EndPublish-cannot-clear-later-op";
  const a = await acquireFresh(cfg, "p4", MAX_TTL_SECONDS);
  try {
    const attemptN = newAttemptId("p4-n");
    const seqN = a.nextOpSeq();
    const beginN = await a.client.beginPublish(a.tuple(), attemptN, seqN);
    assert.equal(
      beginN.begun,
      true,
      `[${label}] setup: BeginPublish(op N) must succeed, got ${JSON.stringify(beginN)}`,
    );
    const endN = await a.client.endPublish(a.tuple(), attemptN, seqN, "ok");
    assert.equal(
      endN.ended,
      true,
      `[${label}] setup: EndPublish(op N) must succeed, got ${JSON.stringify(endN)}`,
    );

    const attemptN1 = newAttemptId("p4-n1");
    const seqN1 = a.nextOpSeq();
    const beginN1 = await a.client.beginPublish(a.tuple(), attemptN1, seqN1);
    assert.equal(
      beginN1.begun,
      true,
      `[${label}] setup: BeginPublish(op N+1) must succeed, got ${JSON.stringify(beginN1)}`,
    );

    // The DELAYED duplicate: op N's ORIGINAL EndPublish call, replayed now that op N+1 is active.
    // "Delayed" is logical here (op N is already tombstoned) — no sleep needed, mirrors
    // scripts/probe-5cb1.ts's C5.
    const delayedEnd = await a.client.endPublish(a.tuple(), attemptN, seqN, "ok");
    assert.equal(
      delayedEnd.ended,
      true,
      `[${label}] a delayed duplicate EndPublish(op N) is idempotent-true (op N is already resolved), got ${JSON.stringify(delayedEnd)}`,
    );
    assert.equal(
      delayedEnd.alreadyCompleted,
      true,
      `[${label}] the delayed duplicate must report alreadyCompleted:true — the tombstone branch, not a fresh clear — got ${JSON.stringify(delayedEnd)}`,
    );

    // Op N+1 must be COMPLETELY unaffected by the delayed duplicate targeting op N.
    const status = await a.client.getOperationStatus(a.tuple(), attemptN1, seqN1);
    assert.equal(
      status.opKind,
      "publish",
      `[${label}] op N+1 must still be the active marker after the delayed duplicate, got ${JSON.stringify(status)}`,
    );
    assert.equal(
      status.opAttemptId,
      attemptN1,
      `[${label}] op N+1's attemptId must be unchanged, got ${JSON.stringify(status)}`,
    );
    assert.equal(
      status.opSeq,
      seqN1,
      `[${label}] op N+1's opSeq must be unchanged, got ${JSON.stringify(status)}`,
    );
    assert.equal(
      status.completed,
      false,
      `[${label}] op N+1 must NOT be reported completed — a delayed duplicate of an OLDER op must never ` +
        `reclear a LATER one. Got ${JSON.stringify(status)}`,
    );

    const endN1 = await a.client.endPublish(a.tuple(), attemptN1, seqN1, "ok");
    assert.equal(
      endN1.ended,
      true,
      `[${label}] cleanup: EndPublish(op N+1) must succeed, got ${JSON.stringify(endN1)}`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P5 — lost-ack reconciliation via GetOperationStatus (design §4/§9).
// ===================================================================================================

async function probeLostAckReconciliation(cfg: ActivationConfig): Promise<void> {
  const label = "P5 lost-ack-reconciliation";
  const a = await acquireFresh(cfg, "p5", MAX_TTL_SECONDS);
  try {
    const attempt = newAttemptId("p5");
    const opSeq = a.nextOpSeq();
    const begun = await a.client.beginPublish(a.tuple(), attempt, opSeq);
    assert.equal(
      begun.begun,
      true,
      `[${label}] setup: BeginPublish must succeed, got ${JSON.stringify(begun)}`,
    );

    // See the file header's substitution #4: a real dropped ack can't be forced in-process. This
    // proves the property reconciliation depends on — GetOperationStatus, as an INDEPENDENT second
    // channel, agrees with the direct response at every step.
    const statusAfterBegin = await a.client.getOperationStatus(a.tuple(), attempt, opSeq);
    assert.equal(
      statusAfterBegin.opKind,
      "publish",
      `[${label}] independent GetOperationStatus must agree the op is active, got ${JSON.stringify(statusAfterBegin)}`,
    );
    assert.equal(
      statusAfterBegin.opAttemptId,
      attempt,
      `[${label}] independent GetOperationStatus must agree on the attemptId, got ${JSON.stringify(statusAfterBegin)}`,
    );
    assert.equal(
      statusAfterBegin.opSeq,
      opSeq,
      `[${label}] independent GetOperationStatus must agree on the opSeq, got ${JSON.stringify(statusAfterBegin)}`,
    );
    assert.equal(
      statusAfterBegin.completed,
      false,
      `[${label}] independent GetOperationStatus must agree the op is NOT completed yet, got ${JSON.stringify(statusAfterBegin)}`,
    );

    const ended = await a.client.endPublish(a.tuple(), attempt, opSeq, "ok");
    assert.equal(
      ended.ended,
      true,
      `[${label}] EndPublish must succeed, got ${JSON.stringify(ended)}`,
    );

    const statusAfterEnd = await a.client.getOperationStatus(a.tuple(), attempt, opSeq);
    assert.equal(
      statusAfterEnd.completed,
      true,
      `[${label}] independent GetOperationStatus must agree the op IS completed after EndPublish — the ` +
        `exact reconciliation a caller who lost EndPublish's own ack would need. Got ${JSON.stringify(statusAfterEnd)}`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P6 — a catchable runner error clears the marker; NO recycle (design §5/§9).
// ===================================================================================================

async function probeCatchableRunnerErrorNoRecycle(
  cfg: ActivationConfig,
  artifactId: string,
): Promise<void> {
  const label = "P6 catchable-runner-error";
  const a = await acquireFresh(cfg, "p6", MAX_TTL_SECONDS);
  try {
    const tx = new RunMutantTransport(cfg, TARGET_APP_ID, artifactId);
    const ref: TestMethodRef = {
      codeunitId: NOT_A_TEST_CODEUNIT_ID,
      codeunitName: "LC Control API (deliberately not a test codeunit)",
      method: "ProbeBoundary",
    };
    const verdict = await tx.run({
      ref,
      mutantId: "",
      attemptId: newAttemptId("p6"),
      timeoutMs: RUN_MUTANT_TIMEOUT_MS,
      lease: { ...a.tuple(), opSeq: a.nextOpSeq() },
    });
    // A server-known terminal (the AL test runner rejecting a non-test codeunit) is caught by
    // RunMutant's catchable phase-2 boundary (design §5) and reaches phase 3, which clears the
    // marker on ANY terminal outcome — pass, fail, or this kind of error. The transport maps it to
    // a plain typed error with `operation` UNSET (see RunMutantTransport.mapRanResult's "expected
    // exactly 1 test line" branch) — never `in-flight-unknown`, never `lease-lost`, which would
    // (wrongly) make the orchestrator quarantine or latch.
    assert.equal(
      verdict.outcome,
      "error",
      `[${label}] RunMutant against a non-test codeunit must map to a typed error, got ${JSON.stringify(verdict)}`,
    );
    assert.equal(
      verdict.operation,
      undefined,
      `[${label}] the error must be a plain confirmed terminal (operation unset) — NOT in-flight-unknown ` +
        `or lease-lost, which would incorrectly trigger quarantine/latch handling. Got ${JSON.stringify(verdict)}`,
    );

    // NO recycle: phase 3 cleared the marker, so a competing AcquireLease must be a plain "held"
    // refusal against our still-live lease — never "operation-busy" (which would mean the marker
    // survived). Mirrors scripts/probe-5cb1.ts's D5 second half.
    const competitor = new LeaseClient(cfg);
    const competing = await competitor.acquire(
      `${hostname()}:${process.pid}:lease-itest:p6-check`,
      MAX_TTL_SECONDS,
      randomUUID(),
      a.lease.serverGeneration,
    );
    if (competing.granted) {
      throw new Error(
        `[${label}] post-error AcquireLease unexpectedly GRANTED — our own lease should still be held, got ${JSON.stringify(competing)}`,
      );
    }
    assert.equal(
      competing.reason,
      "held",
      `[${label}] post-error AcquireLease must be a plain "held" refusal (proof phase 3 cleared the op ` +
        `marker) — "operation-busy" here would mean the marker was left stranded. Got ${JSON.stringify(competing)}`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P7 — a deterministically-rejected publish clears the marker; NO recycle (design §4/§9).
// ===================================================================================================

async function probeDeterministicRejectedPublishNoRecycle(cfg: ActivationConfig): Promise<void> {
  const label = "P7 deterministic-rejected-publish";
  const a = await acquireFresh(cfg, "p7", MAX_TTL_SECONDS);
  try {
    const attempt = newAttemptId("p7");
    const opSeq = a.nextOpSeq();
    const begun = await a.client.beginPublish(a.tuple(), attempt, opSeq);
    assert.equal(
      begun.begun,
      true,
      `[${label}] setup: BeginPublish must succeed, got ${JSON.stringify(begun)}`,
    );

    // See the file header's substitution #3: the REAL live altool-rejection mechanics are already
    // exhaustively proven by stale-publish.itest.ts's Probe A — but see the file header's "WHAT P7 +
    // Probe A DO AND DO NOT JOINTLY PROVE": Probe A drives a raw ContainerDeployer with no lease
    // involved at all, and this probe bypasses the runner's own failure-catching glue
    // (orchestrator.ts:892-914) entirely, so together they still don't cover that glue against a
    // real live rejection. This probe's narrower job is the LEASE layer's own guarantee —
    // EndPublish clears the marker on EVERY confirmed terminal outcome, success or a deterministic
    // failure, because ControlState.TryEndPublish's state transition does not branch on the
    // `outcome` string's content (only on the fence tuple + attemptId + opSeq matching) — so
    // reporting a realistic rejection message here drives the
    // SAME code path a real altool rejection would.
    const ended = await a.client.endPublish(
      a.tuple(),
      attempt,
      opSeq,
      "rejected: ALC0000 downgrade — a newer version is already installed",
    );
    assert.equal(
      ended.ended,
      true,
      `[${label}] EndPublish must clear the marker on a deterministic-failure outcome just as it would on success, got ${JSON.stringify(ended)}`,
    );

    // NO recycle: a competing AcquireLease is a plain "held" refusal, never operation-busy/orphaned.
    const competitor = new LeaseClient(cfg);
    const competing = await competitor.acquire(
      `${hostname()}:${process.pid}:lease-itest:p7-check`,
      MAX_TTL_SECONDS,
      randomUUID(),
      a.lease.serverGeneration,
    );
    if (competing.granted) {
      throw new Error(
        `[${label}] post-EndPublish AcquireLease unexpectedly GRANTED — our own lease should still be held, got ${JSON.stringify(competing)}`,
      );
    }
    assert.equal(
      competing.reason,
      "held",
      `[${label}] post-EndPublish AcquireLease must be a plain "held" refusal, got ${JSON.stringify(competing)} — "operation-busy" would mean the marker was left stranded despite EndPublish reporting ended:true`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P8 — healthy contention: B gets operation-busy, no durable quarantine (design §4/§8/§9).
// MUST run before P10 — both share one local QuarantineStore file, and this probe's "no record
// exists" assertion is only a meaningful proof if nothing has written to it yet.
// ===================================================================================================

async function probeHealthyContentionNoQuarantine(
  cfg: ActivationConfig,
  quarantineStore: QuarantineStore,
  resourceKey: string,
): Promise<void> {
  const label = "P8 healthy-contention-no-quarantine";
  const a = await acquireFresh(cfg, "p8-a", P8_TTL_SECONDS);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const attempt = newAttemptId("p8-marker");
    const opSeq = a.nextOpSeq();
    // See the file header's substitution #2: same substitution as P9 (no fixture test method holds
    // RunMutant open long enough), and defensible for the same reason — TryAcquire's busy/orphaned
    // classification does not distinguish op kind, so a publish marker exercises the identical
    // contract a run marker would.
    const begun = await a.client.beginPublish(a.tuple(), attempt, opSeq);
    assert.equal(
      begun.begun,
      true,
      `[${label}] setup: BeginPublish must succeed, got ${JSON.stringify(begun)}`,
    );

    heartbeat = setInterval(() => {
      void a.client.renew(a.tuple(), P8_TTL_SECONDS).catch(() => {});
    }, P8_HEARTBEAT_MS);

    const bOwner = `${hostname()}:${process.pid}:lease-itest:p8-b`;
    const bClient = new LeaseClient(cfg);
    for (let i = 1; i <= P8_CONTENTION_POLLS; i++) {
      const outcome = await bClient.acquire(
        bOwner,
        MAX_TTL_SECONDS,
        randomUUID(),
        a.lease.serverGeneration,
      );
      if (outcome.granted) {
        throw new Error(
          `[${label}] poll ${i}: B's competing AcquireLease unexpectedly GRANTED while A holds the marker+renews, got ${JSON.stringify(outcome)}`,
        );
      }
      assert.equal(
        outcome.reason,
        "operation-busy",
        `[${label}] poll ${i}: expected reason "operation-busy" (A is alive and renewing), got ${JSON.stringify(outcome)}`,
      );
      await sleep(P8_POLL_INTERVAL_MS);
    }

    clearInterval(heartbeat);
    heartbeat = undefined;
    const endResult = await a.client.endPublish(a.tuple(), attempt, opSeq, "ok");
    assert.equal(
      endResult.ended,
      true,
      `[${label}] EndPublish must succeed, got ${JSON.stringify(endResult)}`,
    );
    const releaseResult = await a.client.release(a.tuple());
    assert.equal(
      releaseResult.released,
      true,
      `[${label}] A's ReleaseLease must succeed, got ${JSON.stringify(releaseResult)}`,
    );

    const bOutcome = await bClient.acquire(
      bOwner,
      MAX_TTL_SECONDS,
      randomUUID(),
      a.lease.serverGeneration,
    );
    if (!bOutcome.granted) {
      throw new Error(
        `[${label}] B must be granted the lease once A releases with an idle marker, got ${JSON.stringify(bOutcome)}`,
      );
    }
    await bClient.release({
      epoch: bOutcome.lease.epoch,
      token: bOutcome.lease.token,
      serverGeneration: bOutcome.lease.serverGeneration,
    });

    const rec = await quarantineStore.read(resourceKey);
    assert.equal(
      rec,
      null,
      `[${label}] expected NO durable container-needs-recycle record after purely healthy contention ` +
        `(every refusal observed was "operation-busy", never "operation-orphaned"), found ${JSON.stringify(rec)}`,
    );
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P9 — slow run under renew: the heartbeat keeps a long op's lease fenced (design §6/§9).
// See P9B (below) for the fixture-backed proof of sol#1's actual concern — a genuinely in-flight
// RunMutant — which this probe's substitution #1 cannot reach (see the file header).
// ===================================================================================================

async function probeSlowRunUnderRenew(cfg: ActivationConfig): Promise<void> {
  const label = "P9 slow-run-under-renew";
  const a = await acquireFresh(cfg, "p9-a", P9_TTL_SECONDS);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const attempt = newAttemptId("p9-hold");
    const opSeq = a.nextOpSeq();
    // See the file header's substitution #1: this two-call op marker stands in for a slow
    // RunMutant, which cannot be held open by the client the way BeginPublish/EndPublish can. See
    // also the file header's "WHAT A GREEN P9 DOES AND DOES NOT PROVE" — this probe proves the
    // busy/orphaned classification holds for the WHOLE hold under renewal, not sol#1's actual
    // concern (a real RunMutant in flight not starving RenewLease); nothing executes against BC
    // between BeginPublish and EndPublish here.
    const begun = await a.client.beginPublish(a.tuple(), attempt, opSeq);
    assert.equal(
      begun.begun,
      true,
      `[${label}] setup: BeginPublish must succeed to establish the held marker, got ${JSON.stringify(begun)}`,
    );

    heartbeat = setInterval(() => {
      void a.client.renew(a.tuple(), P9_TTL_SECONDS).catch(() => {});
    }, P9_HEARTBEAT_MS);

    const bOwner = `${hostname()}:${process.pid}:lease-itest:p9-b`;
    const bClient = new LeaseClient(cfg);
    const deadline = Date.now() + P9_HOLD_MS;
    let polls = 0;
    while (Date.now() < deadline) {
      const outcome = await bClient.acquire(
        bOwner,
        MAX_TTL_SECONDS,
        randomUUID(),
        a.lease.serverGeneration,
      );
      polls++;
      if (outcome.granted) {
        throw new Error(
          `[${label}] poll ${polls}: a competing AcquireLease must NEVER succeed while A's marker is held+renewed, got ${JSON.stringify(outcome)}`,
        );
      }
      assert.equal(
        outcome.reason,
        "operation-busy",
        `[${label}] poll ${polls}: expected "operation-busy" — A is alive and renewing past its original ` +
          `${P9_TTL_SECONDS}s ttl, within ControlState's GraceMs()=${SERVER_GRACE_MS}ms grace. ` +
          `"operation-orphaned" here would mean A's heartbeat did not keep Expires At current. Got ${JSON.stringify(outcome)}`,
      );
      await sleep(P9_POLL_INTERVAL_MS);
    }
    assert.ok(
      polls >= 3,
      `[${label}] expected at least 3 contention polls across the ${P9_HOLD_MS}ms hold window, only completed ${polls}`,
    );

    clearInterval(heartbeat);
    heartbeat = undefined;
    const ended = await a.client.endPublish(a.tuple(), attempt, opSeq, "ok");
    assert.equal(
      ended.ended,
      true,
      `[${label}] EndPublish must succeed once the hold window completes, got ${JSON.stringify(ended)}`,
    );
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P9B — a slow RunMutant GENUINELY in flight: RenewLease lands without starving on phase 2's
// lock-free window (design §5/§6/§9, Round-1 sol#1). Closes the gap P9's own header documents (see
// "WHAT A GREEN P9 DOES AND DOES NOT PROVE" above): P9 holds a BeginPublish/EndPublish marker with
// nothing executing against BC between the two calls, so it cannot exercise sol#1's actual concern.
// This probe drives fixtures/sandbox-probes's "Slow Run Probe" (codeunit 79212,
// SLOW_RUN_PROBE_CODEUNIT_ID) — a [Test] method that sleeps ~23s server-side — through a REAL
// RunMutant call, so phase 2 (the AL test body, holding NO lease lock per
// ControlState.Codeunit.al's TryBeginRun/TryFinishRun) is genuinely still executing while this probe
// issues concurrent RenewLease calls and a competing AcquireLease. REQUIRES fixtures/sandbox-probes
// republished at app.json version >= 1.0.1.0 (the version that added Slow Run Probe) before this
// file runs — this itest does not publish anything itself.
// ===================================================================================================

async function probeSlowRunMutantGenuinelyInFlight(
  cfg: ActivationConfig,
  artifactId: string,
): Promise<void> {
  const label = "P9B slow-runmutant-genuinely-in-flight (sol#1 proof)";
  const a = await acquireFresh(cfg, "p9b", MAX_TTL_SECONDS);
  try {
    const tx = new RunMutantTransport(cfg, TARGET_APP_ID, artifactId);
    const ref: TestMethodRef = {
      codeunitId: SLOW_RUN_PROBE_CODEUNIT_ID,
      codeunitName: "Slow Run Probe",
      method: "SleepsAcrossRenewWindow",
    };

    // Dispatched WITHOUT awaiting — the whole point is to observe RenewLease/AcquireLease calls
    // while this promise is still pending. `runSettled` flips exactly once, the instant RunMutant's
    // HTTP response actually resolves (pass, fail, or error) — every check below reads it fresh,
    // which is what makes the overlap proof real rather than a timing guess.
    let runSettled = false;
    const runPromise = tx
      .run({
        ref,
        mutantId: "",
        attemptId: newAttemptId("p9b-slow"),
        timeoutMs: RUN_MUTANT_TIMEOUT_MS,
        lease: { ...a.tuple(), opSeq: a.nextOpSeq() },
      })
      .finally(() => {
        runSettled = true;
      });

    // Let phase 1's short LockTable claim land (milliseconds) before polling — pacing only, not
    // part of the overlap proof.
    await sleep(P9B_INITIAL_SETTLE_MS);
    if (runSettled) {
      throw new Error(
        `[${label}] the slow RunMutant call already settled after only ${P9B_INITIAL_SETTLE_MS}ms — Slow Run Probe (codeunit ${SLOW_RUN_PROBE_CODEUNIT_ID}) did not actually sleep the expected ~23s. Check that fixtures/sandbox-probes was republished at app.json version >= 1.0.1.0 and that its SleepsAcrossRenewWindow method is the one that ran, got verdict candidate ${JSON.stringify(await runPromise)}`,
      );
    }

    // A competing AcquireLease while the RUN marker (Op Kind = run) is active must take
    // AcquireLease's op-marker branch UNCONDITIONALLY (ControlState.Codeunit.al:361-363 tests only
    // `Op Kind <> none`, never which kind) BEFORE the plain-held branch — so this must be
    // "operation-busy", never "held". P9 already proves this classification for a PUBLISH marker;
    // this is the RUN-marker case P9's own header says it cannot reach. Asserted here unconditionally
    // (not gated on runSettled) — at only ~500ms into a ~23000ms sleep the run cannot possibly have
    // completed yet, so there is no false-pass path through this check.
    const competitor = new LeaseClient(cfg);
    const competing = await competitor.acquire(
      `${hostname()}:${process.pid}:lease-itest:p9b-check`,
      MAX_TTL_SECONDS,
      randomUUID(),
      a.lease.serverGeneration,
    );
    if (competing.granted) {
      throw new Error(
        `[${label}] competing AcquireLease unexpectedly GRANTED while the run marker should still be ` +
          `active, got ${JSON.stringify(competing)}`,
      );
    }
    assert.equal(
      competing.reason,
      "operation-busy",
      `[${label}] a competing AcquireLease against a genuinely in-flight RUN marker must be refused "operation-busy" (never "held", which is P9's already-proven PUBLISH-marker case, or "operation-orphaned"), got ${JSON.stringify(competing)}`,
    );
    console.log(
      `  [${label}] competing acquire correctly refused operation-busy against the live run marker`,
    );

    // THE sol#1 PROOF: several RenewLease calls, each checked immediately after its own await for
    // whether the run promise had already settled. If phase 2 still held the lease lock (a sol#1
    // regression), TryRenew's own LockTable() would block behind RunMutant's open transaction and
    // this renew could not return until the run itself finished — collapsing this check to true.
    // Requiring EVERY iteration's post-await check to be false is proof the renew genuinely raced
    // AHEAD of, not behind, the in-flight run — real observed promise-resolution ordering, never a
    // wall-clock sleep standing in for it.
    const overlapConfirmedAt: boolean[] = [];
    for (let i = 1; i <= P9B_RENEW_COUNT; i++) {
      if (runSettled) {
        throw new Error(
          `[${label}] renew ${i}/${P9B_RENEW_COUNT}: the slow RunMutant call already settled before this ` +
            `renew was even issued — Slow Run Probe's sleep is too short to span ${P9B_RENEW_COUNT} renews ` +
            `at ${P9B_RENEW_POLL_MS}ms spacing (plus the ${P9B_INITIAL_SETTLE_MS}ms initial settle); lengthen SlowSleepMs() in SlowRunProbe.Codeunit.al or shorten this loop.`,
        );
      }
      const renewed = await a.client.renew(a.tuple(), MAX_TTL_SECONDS);
      const stillPendingAfter = !runSettled;
      overlapConfirmedAt.push(stillPendingAfter);
      assert.equal(
        renewed.renewed,
        true,
        `[${label}] renew ${i}/${P9B_RENEW_COUNT} while RunMutant is genuinely in flight must return renewed:true ` +
          `— a sol#1 regression (the lease lock held across phase 2) would make this hang or fail. Got ${JSON.stringify(renewed)}`,
      );
      assert.ok(
        stillPendingAfter,
        `[${label}] renew ${i}/${P9B_RENEW_COUNT}'s response arrived AFTER the RunMutant promise had already settled — expected it to still be pending. This is the direct proof point for sol#1: a regression (renew serialized behind phase 2's lock instead of landing concurrently) would show up as exactly this condition. overlapConfirmedAt so far: ${JSON.stringify(overlapConfirmedAt)}`,
      );
      if (!runSettled) await sleep(P9B_RENEW_POLL_MS);
    }
    console.log(
      `  [${label}] all ${P9B_RENEW_COUNT} renews returned renewed:true while the run promise was ` +
        `still pending (overlapConfirmedAt=${JSON.stringify(overlapConfirmedAt)})`,
    );

    const verdict = await runPromise;
    assert.equal(
      verdict.outcome,
      "pass",
      `[${label}] the slow RunMutant call must complete with a real "pass" verdict once phase 2 ` +
        `finishes, got ${JSON.stringify(verdict)}`,
    );
    const minExpectedDurationMs = P9B_INITIAL_SETTLE_MS + (P9B_RENEW_COUNT - 1) * P9B_RENEW_POLL_MS;
    assert.ok(
      verdict.durationMs >= minExpectedDurationMs,
      `[${label}] expected the verdict's own durationMs to reflect the full slow sleep (at least the ` +
        `${minExpectedDurationMs}ms this probe spent polling before awaiting it), got durationMs=${verdict.durationMs} ` +
        `— a suspiciously short duration would mean SleepsAcrossRenewWindow (codeunit ${SLOW_RUN_PROBE_CODEUNIT_ID}) did not really run`,
    );
    console.log(
      `  [${label}] slow RunMutant completed: outcome=${verdict.outcome} durationMs=${verdict.durationMs}`,
    );
  } finally {
    await recoverContainerBestEffort(cfg, label);
  }
}

// ===================================================================================================
// P10 — orphaned op -> reconcilable quarantine -> ForceReset recovery -> stale-generation fence
// rejection (design §4/§8/§9). The riskiest probe in this file — see the file header's cleanup note.
// ===================================================================================================

async function probeOrphanedOpRecovery(
  cfg: ActivationConfig,
  quarantineStore: QuarantineStore,
  resourceKey: string,
): Promise<void> {
  const label = "P10 orphaned-op-recovery";
  const a = await acquireFresh(cfg, "p10-a", P10_TTL_SECONDS);
  const originalTuple = a.tuple();
  const originalGeneration = a.lease.serverGeneration;
  const attemptA = newAttemptId("p10-orphan");
  const opSeqA = a.nextOpSeq();

  let quarantined: QuarantineRecord | undefined;
  try {
    // A marks an op then goes genuinely silent — no renew, no EndPublish — simulating a session
    // that died mid-operation. NOTE on design §8 step 1 (restart the NST): there is no LIVE AL
    // invocation here to kill — BeginPublish already returned before A goes silent, so unlike a
    // real hung RunMutant (which design §5's catchable phase-2 boundary prevents from ever staying
    // unresolved server-side in the first place) there is nothing a restart would actually
    // terminate. This probe therefore exercises steps 2-4 of the recovery sequence (generation
    // echo, ForceResetLease, post-recovery clean probe, quarantine clear) — the parts an
    // in-process itest genuinely can prove.
    const begun = await a.client.beginPublish(originalTuple, attemptA, opSeqA);
    assert.equal(
      begun.begun,
      true,
      `[${label}] setup: BeginPublish must succeed, got ${JSON.stringify(begun)}`,
    );
    console.log(
      `  [${label}] A acquired+marked (attemptId=${attemptA}, opSeq=${opSeqA}, ttl=${P10_TTL_SECONDS}s) and will now go silent (no renew, no EndPublish) to simulate a dead session`,
    );

    // B polls toward orphaning, mirroring orchestrator.ts's acquireSessionLease re-check-once rule
    // (design §4): the FIRST operation-orphaned sighting only records the marker; only a SECOND
    // sighting with an UNCHANGED (opAttemptId, opStartedAt) writes a durable quarantine — a marker
    // that moved between checks would mean a live container making progress, not a stranded one.
    const bClient = new LeaseClient(cfg);
    const bOwner = `${hostname()}:${process.pid}:lease-itest:p10-b`;
    let orphanMarker: string | undefined;
    let sawBusy = false;
    for (let attempt = 1; attempt <= P10_MAX_POLL_ATTEMPTS; attempt++) {
      const outcome = await bClient.acquire(
        bOwner,
        MAX_TTL_SECONDS,
        randomUUID(),
        originalGeneration,
      );
      if (outcome.granted) {
        throw new Error(
          `[${label}] poll ${attempt}: AcquireLease unexpectedly GRANTED while A's marker should still be unresolved — either A's marker was cleared by something else during this run, or the orphan-classification timing assumption (ttl=${P10_TTL_SECONDS}s + GraceMs=${SERVER_GRACE_MS}ms) is wrong. Got ${JSON.stringify(outcome)}`,
        );
      }
      console.log(
        `  [${label}] poll ${attempt} (+${attempt * P10_POLL_INTERVAL_MS}ms): reason=${outcome.reason}`,
      );
      if (outcome.reason === "operation-busy") {
        sawBusy = true;
      } else if (outcome.reason === "operation-orphaned") {
        const marker = `${outcome.opAttemptId ?? ""}|${outcome.opStartedAt ?? ""}`;
        if (orphanMarker === marker) {
          quarantined = await quarantineStore.record({
            resourceKey,
            opKind: "container-needs-recycle",
            detail:
              `[${label}] AcquireLease reported operation-orphaned twice with an unchanged marker ` +
              `(opAttemptId=${outcome.opAttemptId ?? "<none>"}, opStartedAt=${outcome.opStartedAt ?? "<none>"}) ` +
              `after ${attempt} polls — design §4/§8's re-check-once rule, mirroring orchestrator.ts's acquireSessionLease.`,
            recordedAtIso: new Date().toISOString(),
          });
          break;
        }
        orphanMarker = marker; // first sighting — one more poll before concluding it's stranded
      } else {
        throw new Error(
          `[${label}] poll ${attempt}: expected reason "operation-busy" or "operation-orphaned" while A's marker resolves, got ${JSON.stringify(outcome)}`,
        );
      }
      await sleep(P10_POLL_INTERVAL_MS);
    }
    assert.ok(
      sawBusy,
      `[${label}] expected at least one "operation-busy" response before the marker aged into "operation-orphaned" — never observed one across ${P10_MAX_POLL_ATTEMPTS} polls`,
    );
    if (quarantined === undefined) {
      throw new Error(
        `[${label}] AcquireLease never settled into a STABLE operation-orphaned marker (same opAttemptId+opStartedAt on two consecutive polls) across ${P10_MAX_POLL_ATTEMPTS} polls (${P10_MAX_POLL_ATTEMPTS * P10_POLL_INTERVAL_MS}ms) — either GraceMs()'s live timing differs from ControlState.Codeunit.al's documented 15000ms, or A's marker was unexpectedly cleared`,
      );
    }
    console.log(`  [${label}] quarantine recorded: ${JSON.stringify(quarantined)}`);

    // Reconcilable-quarantine check (design §8): before recycling, confirm via GetOperationStatus
    // that the marker is STILL active and unresolved, not merely stale bookkeeping — a genuinely
    // reconcilable record (the marker cleared through some other path in the meantime) would be
    // clearable WITHOUT a recycle. GetOperationStatus does not gate on tuple match, so any tuple
    // works (mirrors scripts/probe-5cb1.ts's final section-E read).
    //
    // Ask about A'S OWN op, not opSeq 0. `completed` is `askedOpSeq <= Last Completed Op Seq`
    // (ControlState.Codeunit.al) — it answers "is the op I asked about already tombstoned?", NOT
    // "is the current marker resolved?". Passing 0 makes it trivially true on any container whose
    // Last Completed Op Seq has ever advanced, which asserts nothing about A. Live-caught: this
    // probe originally passed 0 and failed against a healthy container reporting the correct
    // still-stranded marker (opSeq 26 > lastCompletedOpSeq 25).
    const status = await bClient.getOperationStatus(
      { epoch: 0, token: "", serverGeneration: "" },
      attemptA,
      opSeqA,
    );
    assert.equal(
      status.opKind,
      "publish",
      `[${label}] reconciliation: expected the still-active marker's opKind "publish", got ${JSON.stringify(status)} — if this is "none" the record was reconcilable WITHOUT a recycle (a stale quarantine), contradicting this probe's setup`,
    );
    assert.equal(
      status.opAttemptId,
      attemptA,
      `[${label}] reconciliation: expected the still-active marker's opAttemptId to be A's ${attemptA}, got ${JSON.stringify(status)}`,
    );
    assert.equal(
      status.completed,
      false,
      `[${label}] reconciliation: expected completed:false for A's own opSeq ${opSeqA} (the op never resolved, so it was never tombstoned), got ${JSON.stringify(status)} — completed:true here would mean Last Completed Op Seq advanced past A's op, i.e. something DID resolve it`,
    );
    console.log(
      `  [${label}] reconciliation confirms the marker is genuinely still active — not stale — so a recycle really is required`,
    );

    // §8 recovery, steps 2-4: read the CURRENT Server Generation live, ForceResetLease against it,
    // confirm the container reads clean, then clear the local quarantine.
    const preReset = await new HarnessVerifier(cfg).verify();
    const reset = await postRawAction(cfg, "ForceResetLease", {
      expectedGeneration: preReset.serverGeneration,
    });
    if (!reset.httpOk || reset.json === undefined) {
      throw new Error(
        `[${label}] ForceResetLease must return a normal 2xx JSON body, got httpStatus=${reset.httpStatus} errorText=${reset.errorText}`,
      );
    }
    const resetDone = boolOf(reset.json, "reset");
    const newGeneration = strOf(reset.json, "serverGeneration");
    const newEpoch = numOf(reset.json, "epoch");
    if (resetDone !== true || newGeneration === undefined || newEpoch === undefined) {
      throw new Error(
        `[${label}] ForceResetLease(expectedGeneration=${preReset.serverGeneration}) must report reset:true ` +
          `with a serverGeneration+epoch, got ${JSON.stringify(reset.json)}`,
      );
    }
    assert.notEqual(
      newGeneration,
      originalGeneration,
      `[${label}] ForceResetLease must mint a NEW serverGeneration different from the pre-recovery one, got ${JSON.stringify(reset.json)}`,
    );
    console.log(
      `  [${label}] ForceResetLease succeeded: newGeneration=${newGeneration} newEpoch=${newEpoch}`,
    );

    // Post-recovery baseline probe (design §8 step 3): confirm the marker reads idle.
    const postResetStatus = await bClient.getOperationStatus(
      { epoch: 0, token: "", serverGeneration: "" },
      "",
      0,
    );
    assert.equal(
      postResetStatus.opKind,
      "none",
      `[${label}] post-recovery baseline: expected the marker to read idle ("none") after ForceResetLease, got ${JSON.stringify(postResetStatus)}`,
    );

    // Stale-generation fence rejection: A's ORIGINAL pre-recovery credentials must now be rejected
    // by every fence — proven here via RenewLease, which fails closed on ANY tuple mismatch
    // (design §4). ForceResetLease bumped Epoch and minted a new generation, and cleared Token, so
    // all three legs of the tuple are now stale.
    const staleRenew = await a.client.renew(originalTuple, P10_TTL_SECONDS);
    assert.equal(
      staleRenew.renewed,
      false,
      `[${label}] A's pre-recovery lease tuple must be rejected after ForceResetLease minted a new generation, got ${JSON.stringify(staleRenew)}`,
    );
    console.log(
      `  [${label}] confirmed: A's stale (pre-recovery) lease tuple is rejected by the new server generation`,
    );

    // Clear the local quarantine (mirrors `lethal clear-quarantine`) now that recovery is proven.
    const cleared = await quarantineStore.clear(resourceKey, quarantined.generation);
    assert.equal(
      cleared,
      "cleared",
      `[${label}] expected the quarantine record to clear at generation ${quarantined.generation}, got "${cleared}"`,
    );
    quarantined = undefined; // cleared — the finally must not try to clear it again

    // Leave the container demonstrably free under the NEW generation.
    const freeCheck = new LeaseClient(cfg);
    const freeOutcome = await freeCheck.acquire(
      `${hostname()}:${process.pid}:lease-itest:p10-verify`,
      MAX_TTL_SECONDS,
      randomUUID(),
      newGeneration,
    );
    if (!freeOutcome.granted) {
      throw new Error(
        `[${label}] post-recovery: AcquireLease under the NEW generation must succeed (the container should be genuinely free), got ${JSON.stringify(freeOutcome)}`,
      );
    }
    await freeCheck.release({
      epoch: freeOutcome.lease.epoch,
      token: freeOutcome.lease.token,
      serverGeneration: freeOutcome.lease.serverGeneration,
    });
    console.log(
      `  [${label}] confirmed the container is free under the new generation and released cleanly`,
    );
  } finally {
    // See the file header's "CLEANUP STRATEGY": unconditional and idempotent-safe even on the
    // happy path (where recovery already ran above) — the one guard against this probe (uniquely,
    // among this file's probes, one that DELIBERATELY induces a stranded marker) leaving the
    // container needing a manual design §8 recovery if it fails before reaching here.
    await recoverContainerBestEffort(cfg, label);
    if (quarantined !== undefined) {
      await quarantineStore.clear(resourceKey, quarantined.generation).catch(() => {});
    }
  }
}

// ===================================================================================================
// Z — final free-lease verification. Not one of design §9's named probes — a holistic sanity check
// that the whole file, taken together, left the container genuinely free and idle.
// ===================================================================================================

async function verifyLeaseIsFree(cfg: ActivationConfig): Promise<void> {
  const label = "Z final-free-lease-verification";
  const harness = await new HarnessVerifier(cfg).verify();
  const client = new LeaseClient(cfg);
  const outcome = await client.acquire(
    `${hostname()}:${process.pid}:lease-itest:z-verify`,
    MAX_TTL_SECONDS,
    randomUUID(),
    harness.serverGeneration,
  );
  if (!outcome.granted) {
    throw new Error(
      `[${label}] the lease must be genuinely free after every probe's own cleanup, got ${JSON.stringify(outcome)} — a prior probe left the container held or with a stranded marker`,
    );
  }
  const released = await client.release({
    epoch: outcome.lease.epoch,
    token: outcome.lease.token,
    serverGeneration: outcome.lease.serverGeneration,
  });
  assert.equal(
    released.released,
    true,
    `[${label}] final ReleaseLease must succeed, got ${JSON.stringify(released)}`,
  );
  console.log(
    `  [${label}] confirmed: the lease is free and this itest left the container unmutated`,
  );
}

// ---------------------------------------------------------------------------------------------
// Main — probes run in a SAFETY-ordered sequence (cheapest/most-isolated first, the slow/riskiest
// last — see the file header), not design §9's prose order. Sequential, fail-loud (matches
// bcdev.itest.ts / stale-publish.itest.ts convention): a probe's assertion failure aborts the run
// immediately after that probe's own `finally` has run, rather than continuing past a real failure.
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const launchLocal = await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json");
  const launchCfg = launchLocal.configurations[0];
  if (!launchCfg) {
    throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  }

  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const cfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };

  const artifactId = await odataReadRegisteredArtifact(cfg, TARGET_APP_ID);
  if (!/^[0-9a-f]{32}$/.test(artifactId)) {
    throw new Error(
      `LethALControl_RegisteredArtifact(${TARGET_APP_ID}) returned ${JSON.stringify(artifactId)}, not a 32-hex artifact id — run itest:bcdev first so the sandbox target self-registers before P6 (catchable-runner-error) can run`,
    );
  }

  // A SCRATCH quarantine dir, deliberately separate from defaultQuarantineDir() (~/.lethal/quarantine
  // — the REAL directory a live `lethal run` session durably writes to). P8/P10 must never touch
  // that real store: doing so could fabricate or clear a genuine operator-facing quarantine record.
  const quarantineScratchDir = await mkdtemp(join(tmpdir(), "lethal-itest-lease-quarantine-"));
  const quarantineStore = new QuarantineStore(quarantineScratchDir);
  const resourceKey = quarantineResourceKey({
    server: bcdev.server,
    serverInstance: bcdev.serverInstance,
  });

  try {
    console.log("\n=== P1: v1-vs-v2 handshake ===");
    await probeV1V2Handshake(cfg);

    console.log("\n=== P2: multi-tenant refusal (documented, not enforced) ===");
    await probeMultiTenantRefusalNote(cfg);

    console.log("\n=== P3: delayed renew after release cannot resurrect ===");
    await probeDelayedRenewAfterRelease(cfg);

    console.log("\n=== P4: delayed EndPublish cannot clear a later op ===");
    await probeDelayedEndPublishCannotClearLaterOp(cfg);

    console.log("\n=== P5: lost-ack reconciliation via GetOperationStatus ===");
    await probeLostAckReconciliation(cfg);

    console.log("\n=== P6: catchable runner error -> no recycle ===");
    await probeCatchableRunnerErrorNoRecycle(cfg, artifactId);

    console.log("\n=== P7: deterministic-rejected publish -> no recycle ===");
    await probeDeterministicRejectedPublishNoRecycle(cfg);

    console.log("\n=== P8: healthy contention -> no durable quarantine ===");
    await probeHealthyContentionNoQuarantine(cfg, quarantineStore, resourceKey);

    console.log("\n=== P9: slow run under renew ===");
    await probeSlowRunUnderRenew(cfg);

    console.log("\n=== P9B: slow RunMutant genuinely in flight (sol#1 proof) ===");
    await probeSlowRunMutantGenuinelyInFlight(cfg, artifactId);

    console.log(
      "\n=== P10: orphaned op -> reconcilable quarantine -> ForceReset recovery -> stale-generation rejection ===",
    );
    await probeOrphanedOpRecovery(cfg, quarantineStore, resourceKey);

    console.log("\n=== Z: final free-lease verification ===");
    await verifyLeaseIsFree(cfg);

    console.log("\nlease itest: PASS (P1-P10, P9B)");
  } finally {
    await rm(quarantineScratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
