#!/usr/bin/env bun
/**
 * Standalone live probe for Layer 5C-B1 (machine-global lease + two-phase RunMutant fence) against
 * the `LethAL Control` extension already published on Cronus281. NOT part of any package build,
 * NOT a `bun:test` file — run directly:
 *
 *   bun run scripts/probe-5cb1.ts
 *
 * WHY THIS EXISTS (see NEXT-SESSION-LAYER-5C-B1.md / docs/superpowers for the full plan): Tasks 1-5
 * added a machine-global lease (table 71006 "LC Lease") and a two-phase RunMutant fence to codeunits
 * 71002 "LC Control State" / 71003 "LC Control API", but the production TypeScript client
 * (packages/runner/src/harness.ts, run-mutant-transport.ts) has NOT been updated yet — Tasks 6-8 do
 * that. The v1 client cannot even construct a valid v2 `HarnessInfo`/`RunMutant` call (protocol v2
 * requires `clientProtocol`, `leaseEpoch` is now an Integer, not the reserved-empty-string v1
 * sends). So this script speaks the new protocol directly, as the only live proof the AL work is
 * correct before three more tasks get built on top of it.
 *
 * SOURCE OF TRUTH for every action name / parameter name / result key below:
 *   extensions/lethal-control/src/ControlApi.Codeunit.al   (the OData contract)
 *   extensions/lethal-control/src/ControlState.Codeunit.al (the decision logic + reason strings)
 *   extensions/lethal-control/src/RunMethod.Codeunit.al    (phase 2's actual test invocation)
 * Every body key here is the camelCase of the AL procedure's parameter name — read off the actual
 * `procedure X(Foo: Text; Bar: Integer)` signatures, never guessed.
 *
 * WIRE SHAPE (mirrors packages/runner/src/harness.ts / run-mutant-transport.ts, NOT imported — those
 * are the v1 client and will be rewritten in Task 6):
 *   - Unbound OData V4 actions, POST, named `LethALControl_<ProcedureName>`.
 *   - HTTP Basic auth.
 *   - `company` + `tenant` query params on every call.
 *   - The 2xx response is an OData scalar `{"value": "<json-string>"}` — for every action EXCEPT
 *     `RegisteredArtifact` (whose AL return type is a bare `Text`, not `JsonObject.WriteTo`'d), the
 *     codeunit's JSON result is a STRING living inside that `value` — i.e. parse TWICE.
 *     `RegisteredArtifact` needs only ONE parse (`value` IS the artifact id string, or "").
 *   - An AL `Error()` surfaces as a non-2xx HTTP response, never as a 2xx JSON body with a status
 *     key — every check below reports which shape it actually got, never assumes one.
 *
 * REGISTERARTIFACT IS READ-ONLY (important correction to the brief this probe was commissioned
 * under): ControlApi.Codeunit.al exposes `RegisteredArtifact` (read) but has NO OData write action
 * for the registry — its own doc comment says so explicitly: "No OData WRITE exists — the registry
 * is written only in-process by the target's install/upgrade codeunits (design §B2)." There is no
 * `RegisterArtifact` OData action to call. So this probe does not attempt to seed the registry —
 * it READS whatever artifact id the already-published sandbox target self-registered on its last
 * install/upgrade/publish, and uses that for every RunMutant call in section D/E. If that read
 * comes back empty, D1 (and everything after it) will fail loudly with that observation, which is
 * itself the correct, honest signal (see probe-author-report.md).
 */

// ---------------------------------------------------------------------------------------------
// Constants — every endpoint URL, credential, company/tenant, and target/test identifier lives
// here, named, per the brief.
// ---------------------------------------------------------------------------------------------

/** Verified live fact, not re-derived: BC's OData V4 base on this container. */
const ODATA_BASE = "http://Cronus281:7048/BC/ODataV4";
/** Verified live fact: exact company display name (URL-encodes to `CRONUS%20Danmark%20A%2FS`). */
const COMPANY = "CRONUS Danmark A/S";
const TENANT = "default";
const USERNAME = "sshadows";
const PASSWORD = "1234";
const AUTH_HEADER = `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`;

/** The `LethAL Control` extension's own app id (ControlApi.HarnessInfo's hardcoded `appId`). */
const CONTROL_APP_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701";

/**
 * Sandbox target app id + test codeunit ids — pulled from packages/runner/itest/bcdev.itest.ts
 * (TARGET_APP_ID / SANDBOX_TESTS_ID), which documents them as frozen against the fixture's
 * committed app.json / test codeunits. The sandbox target + its test codeunits are already
 * published on Cronus281 per the task brief, so this probe reads (never invents) its registered
 * artifact id at startup — see `readRegisteredArtifactId` below.
 */
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const SANDBOX_TESTS_CODEUNIT_ID = 79100; // "Sandbox Tests"
const OVER_BUDGET_METHOD = "OverBudgetDetected"; // fast, deterministic pass under baseline (mutantId="")

/**
 * D5's catchable-boundary probe: an existing AL object id that is NOT a Subtype=Test codeunit.
 * "LC Control API" itself (71003) — guaranteed to exist (this very script talks to it) and
 * guaranteed not to be a test codeunit. See probe-author-report.md for why the exact internal AL
 * mechanism this trips (RunMethod.Codeunit.al's own "expected exactly one method, found 0"
 * fail-closed return vs. a genuine platform throw caught by ControlApi.RunMutant's
 * `if Runner.Run() then ... else BuildRunError`) is a genuinely open question this probe answers
 * by OBSERVATION, not by assumption — both mechanisms are indistinguishable from the OData
 * caller's side (both land as `status: 'ran'` with an `{"error": ...}` codeunitResults), which is
 * exactly the client-observable contract D5 exists to check.
 */
const NOT_A_TEST_CODEUNIT_ID = 71003;

/**
 * D3 (duplicate-claim) / D4 (lock-release) timing. Checked fixtures/sandbox-tests,
 * fixtures/sandbox-probes, fixtures/sandbox-app/src: every test method is a handful of trivial
 * statements — nothing sleeps or loops long enough to GUARANTEE an overlap window purely
 * server-side. So both checks race on REAL request/response latency alone: the duplicate/status
 * call is dispatched before the first RunMutant's own fetch promise has settled (never after an
 * artificial sleep — the two `fetch()` calls are issued back-to-back, unawaited, then joined with
 * `Promise.all`). Whether that window is wide enough live is exactly the open question these
 * checks exist to answer; if it isn't, the checks report FAIL with both full response bodies
 * rather than a false PASS. This constant exists so a future, genuinely slow fixture test method
 * can be swapped in without touching the check logic.
 */
const RACE_TEST = { codeunitId: SANDBOX_TESTS_CODEUNIT_ID, method: OVER_BUDGET_METHOD };

/** D4's wall-clock bound: GetOperationStatus must return promptly while a RunMutant is in flight. */
const D4_STATUS_READ_BOUND_MS = 2_000;

/** B6's delayed renew — the one place besides D3/D4 where a real sleep is appropriate (per brief). */
const B6_RENEW_DELAY_MS = 500;

/** Distinguishes this run's client nonces/owners from any other invocation (live, shared container). */
const RUN_TAG = Date.now().toString(36);
const OWNER = `lethal-probe-5cb1-${RUN_TAG}`;

// ---------------------------------------------------------------------------------------------
// Wire helpers — one place that builds the URL, POSTs, and parses (once or twice). Never swallows
// a parse failure into a plausible empty default: every failure mode is reported as its own
// distinct `errorText`, and every check reads `httpOk`/`json`/`errorText` explicitly.
// ---------------------------------------------------------------------------------------------

function buildUrl(action: string): string {
  const q = `company=${encodeURIComponent(COMPANY)}&tenant=${encodeURIComponent(TENANT)}`;
  return `${ODATA_BASE}/LethALControl_${action}?${q}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Best-effort extraction of the AL/OData error message from a non-2xx body, never invented. */
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

interface ActionOutcome {
  readonly httpOk: boolean;
  readonly httpStatus: number;
  readonly rawText: string;
  /** Populated whenever something other than a clean double-parsed JSON object was obtained. */
  readonly errorText: string | undefined;
  /** The codeunit's own JSON result, present only when httpOk and both parses succeeded. */
  readonly json: Record<string, unknown> | undefined;
}

/** POST a double-JSON-parsed action (every action here except RegisteredArtifact). */
async function postActionJson(
  action: string,
  body: Record<string, unknown>,
): Promise<ActionOutcome> {
  const url = buildUrl(action);
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    rawText = await res.text();
  } catch (err) {
    return {
      httpOk: false,
      httpStatus: 0,
      rawText: "",
      errorText: `network error before/during dispatch: ${String(err)}`,
      json: undefined,
    };
  }
  if (!res.ok) {
    return {
      httpOk: false,
      httpStatus: res.status,
      rawText,
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
      rawText,
      errorText: `2xx body is not JSON (outer parse failed): ${rawText}`,
      json: undefined,
    };
  }
  const outerValue = isRecord(envelope) ? envelope.value : undefined;
  if (typeof outerValue !== "string") {
    return {
      httpOk: true,
      httpStatus: res.status,
      rawText,
      errorText: `2xx OData envelope has no string "value": ${describe(envelope)}`,
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
      rawText,
      errorText: `"value" string is not JSON (inner parse failed): ${outerValue}`,
      json: undefined,
    };
  }
  if (!isRecord(inner)) {
    return {
      httpOk: true,
      httpStatus: res.status,
      rawText,
      errorText: `parsed "value" is not a JSON object: ${describe(inner)}`,
      json: undefined,
    };
  }
  return { httpOk: true, httpStatus: res.status, rawText, errorText: undefined, json: inner };
}

interface StringActionOutcome {
  readonly httpOk: boolean;
  readonly httpStatus: number;
  readonly rawText: string;
  readonly errorText: string | undefined;
  /** RegisteredArtifact's bare string value — present only when httpOk and the single parse succeeded. */
  readonly value: string | undefined;
}

/** POST a SINGLE-JSON-parsed action. Today only RegisteredArtifact returns a bare `Text`, not a
 * JsonObject.WriteTo'd string — see the file-level doc comment. */
async function postActionRawString(
  action: string,
  body: Record<string, unknown>,
): Promise<StringActionOutcome> {
  const url = buildUrl(action);
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    rawText = await res.text();
  } catch (err) {
    return {
      httpOk: false,
      httpStatus: 0,
      rawText: "",
      errorText: `network error before/during dispatch: ${String(err)}`,
      value: undefined,
    };
  }
  if (!res.ok) {
    return {
      httpOk: false,
      httpStatus: res.status,
      rawText,
      errorText: extractODataError(rawText),
      value: undefined,
    };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    return {
      httpOk: true,
      httpStatus: res.status,
      rawText,
      errorText: `2xx body is not JSON (outer parse failed): ${rawText}`,
      value: undefined,
    };
  }
  const outerValue = isRecord(envelope) ? envelope.value : undefined;
  if (typeof outerValue !== "string") {
    return {
      httpOk: true,
      httpStatus: res.status,
      rawText,
      errorText: `2xx OData envelope has no string "value": ${describe(envelope)}`,
      value: undefined,
    };
  }
  return { httpOk: true, httpStatus: res.status, rawText, errorText: undefined, value: outerValue };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Pass/fail reporting — every check reports independently and the run continues past a failure.
// ---------------------------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;

function pass(id: string, what: string, observed: unknown): void {
  passCount++;
  console.log(`[${id}] PASS — ${what} — observed: ${describe(observed)}`);
}

function fail(id: string, what: string, observed: unknown): void {
  failCount++;
  console.log(`[${id}] FAIL — ${what} — observed: ${describe(observed)}`);
}

async function runCheck(id: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(id, "check threw an unexpected exception (bug in the probe itself, not a wire result)", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Shared lease-tuple type + small typed accessors onto the (loosely typed) parsed JSON, so checks
// read as assertions rather than repeated `typeof` noise. None of these coerce a bad shape into a
// plausible default — a missing/wrong-typed field comes back `undefined` and the caller reports it.
// ---------------------------------------------------------------------------------------------

interface LeaseTuple {
  readonly epoch: number;
  readonly token: string;
  readonly generation: string;
}

function numOf(json: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = json?.[key];
  return typeof v === "number" ? v : undefined;
}
function strOf(json: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = json?.[key];
  return typeof v === "string" ? v : undefined;
}
function boolOf(json: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = json?.[key];
  return typeof v === "boolean" ? v : undefined;
}

// ---------------------------------------------------------------------------------------------
// Mutable run context. Filled in as checks succeed; later checks that depend on earlier state
// check for `undefined` and report a precondition-failed FAIL rather than throwing, so one lost
// precondition never aborts the rest of the run.
// ---------------------------------------------------------------------------------------------

interface Ctx {
  serverGeneration: string | undefined;
  registeredArtifactId: string | undefined;
  // The currently-held lease (whichever section most recently acquired it), plus the
  // `lastCompletedOpSeq` counter AS OF that grant — every subsequent opSeq in that "session" is
  // computed as `lastCompletedOpSeq + 1` and `lastCompletedOpSeq` is bumped locally only when a
  // call actually recorded (RunMutant status 'ran', EndPublish ended, etc.), mirroring exactly
  // when the server's own "Last Completed Op Seq" advances. This local counter is always reset
  // from a FRESH AcquireLease grant response at the start of each lettered section (C, E) rather
  // than carried by hand across sections, so a wrong assumption anywhere upstream can't silently
  // corrupt opSeq bookkeeping downstream.
  lease: LeaseTuple | undefined;
  lastCompletedOpSeq: number | undefined;
}

const ctx: Ctx = {
  serverGeneration: undefined,
  registeredArtifactId: undefined,
  lease: undefined,
  lastCompletedOpSeq: undefined,
};

// ===================================================================================================
// A — Protocol v2 handshake (design §7)
// ===================================================================================================

async function checkA1(): Promise<void> {
  // Deliberately an empty body `{}` — no `clientProtocol` key at all. The open question this probe
  // exists to answer: does BC's OData layer reject a missing required action parameter before AL
  // ever runs, or does it silently bind Integer-missing to 0 and let ControlApi.HarnessInfo's own
  // `if ClientProtocol < 2 then Error(...)` fire? Both are HTTP-level failures from this caller's
  // point of view (an AL Error() surfaces as non-2xx, same as an OData binding rejection) — report
  // which one actually happened via the raw error text, don't just assert "it failed".
  const r = await postActionJson("HarnessInfo", {});
  if (r.httpOk) {
    fail("A1", "HarnessInfo with no clientProtocol key must be refused", {
      httpStatus: r.httpStatus,
      json: r.json,
    });
    return;
  }
  // Discriminate on text unique to each mechanism. Both messages mention `clientProtocol` — the
  // OData one names the parameter it wanted ("Expected a parameter with name 'clientProtocol' but
  // it wasn't provided"), so keying on that substring alone reports the wrong mechanism for a
  // passing check. Key on the AL error's own wording instead.
  const errorText = r.errorText ?? "";
  const mechanism = errorText.includes("server speaks protocolVersion")
    ? "AL ProtocolIncompatibleErr fired (OData bound the missing arg, presumably to 0)"
    : "an OData-layer rejection of the missing required parameter (never reached AL)";
  pass("A1", `HarnessInfo with no clientProtocol key was refused — mechanism: ${mechanism}`, {
    httpStatus: r.httpStatus,
    errorText: r.errorText,
  });
}

async function checkA2(): Promise<void> {
  const r = await postActionJson("HarnessInfo", { clientProtocol: 1 });
  if (r.httpOk) {
    fail("A2", "HarnessInfo with clientProtocol:1 must be refused", {
      httpStatus: r.httpStatus,
      json: r.json,
    });
    return;
  }
  const namesBoth = (r.errorText ?? "").includes("1") && (r.errorText ?? "").includes("2");
  if (namesBoth) {
    pass("A2", "HarnessInfo(clientProtocol:1) refused, error names both versions", {
      errorText: r.errorText,
    });
  } else {
    fail(
      "A2",
      "HarnessInfo(clientProtocol:1) refused but error does not clearly name both versions",
      {
        errorText: r.errorText,
      },
    );
  }
}

async function checkA3(): Promise<void> {
  const r = await postActionJson("HarnessInfo", { clientProtocol: 2 });
  if (!r.httpOk || r.json === undefined) {
    fail("A3", "HarnessInfo(clientProtocol:2) must succeed with a parsed JSON body", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const protocolVersion = numOf(r.json, "protocolVersion");
  const serverGeneration = strOf(r.json, "serverGeneration");
  const tenantCountReachable = boolOf(r.json, "tenantCountReachable");
  const appId = strOf(r.json, "appId");
  const isolationModes = r.json.isolationModes;
  const testTypes = r.json.testTypes;

  const genLooksValid =
    typeof serverGeneration === "string" && /^[0-9a-f]{32}$/.test(serverGeneration);
  const isolationOk = Array.isArray(isolationModes) && isolationModes.includes("Codeunit");
  const testTypesOk = Array.isArray(testTypes) && testTypes.includes("codeunit");

  const ok =
    protocolVersion === 2 &&
    genLooksValid &&
    tenantCountReachable === false &&
    appId === CONTROL_APP_ID &&
    isolationOk &&
    testTypesOk;

  if (ok && serverGeneration !== undefined) {
    ctx.serverGeneration = serverGeneration;
    pass(
      "A3",
      "HarnessInfo(clientProtocol:2) returns protocolVersion 2 + valid serverGeneration + expected keys",
      {
        protocolVersion,
        serverGeneration,
        tenantCountReachable,
        appId,
        isolationModes,
        testTypes,
      },
    );
  } else {
    fail("A3", "HarnessInfo(clientProtocol:2) missing/wrong an expected key", {
      protocolVersion,
      serverGeneration,
      tenantCountReachable,
      appId,
      isolationModes,
      testTypes,
    });
  }
}

// ===================================================================================================
// B — Lease lifecycle (design §4). Depends on ctx.serverGeneration from A3.
// ===================================================================================================

async function checkB1(): Promise<void> {
  if (ctx.serverGeneration === undefined) {
    fail(
      "B1",
      "8 concurrent AcquireLease -> exactly one granted",
      "precondition missing: no serverGeneration from A3",
    );
    return;
  }
  const generation = ctx.serverGeneration;
  const nonces = Array.from({ length: 8 }, (_, i) => `${OWNER}-b1-nonce-${i}`);
  // All 8 fetches are started here, back-to-back, unawaited — Promise.all joins them after the
  // fact. This is genuine client-side concurrency; whether BC actually overlaps their processing
  // is exactly what this check is probing.
  const outcomes = await Promise.all(
    nonces.map((clientNonce) =>
      postActionJson("AcquireLease", {
        owner: OWNER,
        ttlSeconds: 30,
        clientNonce,
        expectedGeneration: generation,
      }),
    ),
  );

  const granted: {
    nonce: string;
    epoch: number | undefined;
    token: string | undefined;
    expiresAt: unknown;
  }[] = [];
  const reasonCounts = new Map<string, number>();
  for (const [i, r] of outcomes.entries()) {
    const nonce = nonces[i] ?? `<index ${i}>`;
    if (!r.httpOk || r.json === undefined) {
      reasonCounts.set(
        `<non-2xx/unparseable: ${r.errorText}>`,
        (reasonCounts.get(`<non-2xx/unparseable: ${r.errorText}>`) ?? 0) + 1,
      );
      continue;
    }
    const grantedFlag = boolOf(r.json, "granted");
    if (grantedFlag === true) {
      granted.push({
        nonce,
        epoch: numOf(r.json, "epoch"),
        token: strOf(r.json, "token"),
        expiresAt: r.json.expiresAt,
      });
    } else {
      const reason = strOf(r.json, "reason") ?? "<no reason field>";
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  const reasonSummary = Object.fromEntries(reasonCounts);
  if (granted.length === 1) {
    const won = granted[0];
    if (won === undefined || won.epoch === undefined || won.token === undefined) {
      fail("B1", "the single granted response is missing epoch/token", { granted, reasonSummary });
      return;
    }
    ctx.lease = { epoch: won.epoch, token: won.token, generation };
    wonNonce = won.nonce; // B3 replays this exact nonce to prove the idempotent-nonce grant.
    pass("B1", "exactly one of 8 concurrent AcquireLease calls granted, rest refused", {
      grantedNonce: won.nonce,
      epoch: won.epoch,
      reasonDistribution: reasonSummary,
    });
  } else {
    fail("B1", `expected exactly 1 granted out of 8, got ${granted.length}`, {
      grantedCount: granted.length,
      grantedNonces: granted.map((g) => g.nonce),
      reasonDistribution: reasonSummary,
    });
  }
}

async function checkB2(): Promise<void> {
  if (ctx.lease === undefined) {
    fail("B2", "RenewLease extends expiresAt", "precondition missing: no granted lease from B1");
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  // Need the ORIGINAL grant's expiresAt to compare against — re-derive it via the idempotent-nonce
  // path is unnecessary; B1 already told us the grant succeeded, so just renew and compare against
  // "now" as a floor: a renewed expiresAt must be in the future relative to when we call.
  const before = Date.now();
  const r = await postActionJson("RenewLease", { epoch, token, generation, ttlSeconds: 60 });
  if (!r.httpOk || r.json === undefined) {
    fail("B2", "RenewLease must succeed for the held tuple", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const renewed = boolOf(r.json, "renewed");
  const expiresAt = r.json.expiresAt;
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (renewed === true && Number.isFinite(expiresAtMs) && expiresAtMs > before) {
    pass("B2", "RenewLease renewed:true with expiresAt strictly in the future", {
      renewed,
      expiresAt,
    });
  } else {
    fail("B2", "RenewLease did not renew, or expiresAt did not advance", { renewed, expiresAt });
  }
}

async function checkB3(): Promise<void> {
  if (ctx.lease === undefined || ctx.serverGeneration === undefined) {
    fail(
      "B3",
      "idempotent-nonce replay returns the SAME grant",
      "precondition missing: no held lease/generation",
    );
    return;
  }
  // Re-issue the EXACT SAME AcquireLease the winner of B1 used (same clientNonce) — B1 records
  // which nonce won into the module-level `wonNonce` (see its declaration below) as a side effect
  // of granting, specifically so B3 can replay it here.
  const winningNonce = wonNonce;
  if (winningNonce === undefined) {
    fail(
      "B3",
      "idempotent-nonce replay returns the SAME grant",
      "precondition missing: B1's winning nonce was not recorded",
    );
    return;
  }
  const r = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 30,
    clientNonce: winningNonce,
    expectedGeneration: ctx.serverGeneration,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("B3", "idempotent-nonce replay must succeed", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const granted = boolOf(r.json, "granted");
  const epoch = numOf(r.json, "epoch");
  const token = strOf(r.json, "token");
  if (granted === true && epoch === ctx.lease.epoch && token === ctx.lease.token) {
    pass(
      "B3",
      "re-AcquireLease with the same clientNonce returned the SAME {epoch, token}, not a new grant",
      {
        epoch,
        token,
      },
    );
  } else {
    fail(
      "B3",
      "re-AcquireLease with the same clientNonce did not echo the original {epoch, token}",
      {
        expectedEpoch: ctx.lease.epoch,
        expectedToken: ctx.lease.token,
        granted,
        epoch,
        token,
      },
    );
  }
}

async function checkB4(): Promise<void> {
  if (ctx.serverGeneration === undefined) {
    fail("B4", "blank clientNonce must fail loudly", "precondition missing: no serverGeneration");
    return;
  }
  const r = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 30,
    clientNonce: "",
    expectedGeneration: ctx.serverGeneration,
  });
  if (r.httpOk) {
    fail("B4", "blank clientNonce must be a caller-contract AL error, not a plausible grant", {
      httpStatus: r.httpStatus,
      json: r.json,
    });
    return;
  }
  const mentionsNonce = (r.errorText ?? "").toLowerCase().includes("nonce");
  if (mentionsNonce) {
    pass("B4", "blank clientNonce refused with an AL error naming clientNonce", {
      errorText: r.errorText,
    });
  } else {
    fail("B4", "blank clientNonce refused, but error text does not clearly name clientNonce", {
      errorText: r.errorText,
    });
  }
}

async function checkB5(): Promise<void> {
  if (ctx.lease === undefined) {
    fail(
      "B5",
      "wrong expectedGeneration -> generation-changed",
      "precondition missing: no held lease",
    );
    return;
  }
  // A well-formed but certainly-wrong 32-hex generation — the real one is a random GUID-derived
  // token, so this is astronomically unlikely to collide.
  const wrongGeneration = "0".repeat(32);
  const r = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 30,
    clientNonce: `${OWNER}-b5-nonce`,
    expectedGeneration: wrongGeneration,
  });
  if (!r.httpOk || r.json === undefined) {
    fail(
      "B5",
      "AcquireLease with wrong expectedGeneration must return a normal JSON refusal, not an HTTP error",
      {
        httpStatus: r.httpStatus,
        errorText: r.errorText,
      },
    );
    return;
  }
  const granted = boolOf(r.json, "granted");
  const reason = strOf(r.json, "reason");
  if (granted === false && reason === "generation-changed") {
    pass(
      "B5",
      "AcquireLease with wrong expectedGeneration -> granted:false, reason:generation-changed",
      { reason },
    );
  } else {
    fail("B5", "AcquireLease with wrong expectedGeneration did not report generation-changed", {
      granted,
      reason,
    });
  }
}

async function checkB6(): Promise<void> {
  if (ctx.lease === undefined) {
    fail(
      "B6",
      "ReleaseLease then delayed RenewLease must fail",
      "precondition missing: no held lease",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const rRelease = await postActionJson("ReleaseLease", { epoch, token, generation });
  if (!rRelease.httpOk || rRelease.json === undefined) {
    fail("B6", "ReleaseLease must succeed for the held tuple", {
      httpStatus: rRelease.httpStatus,
      errorText: rRelease.errorText,
    });
    return;
  }
  const released = boolOf(rRelease.json, "released");
  if (released !== true) {
    fail("B6", "ReleaseLease did not report released:true", { json: rRelease.json });
    return;
  }

  // The one deliberate real sleep besides D3/D4 (explicitly permitted by the brief) — B6 is
  // specifically ABOUT the passage of time after release, not about racing an in-flight call.
  await sleep(B6_RENEW_DELAY_MS);

  const rRenew = await postActionJson("RenewLease", { epoch, token, generation, ttlSeconds: 60 });
  if (!rRenew.httpOk || rRenew.json === undefined) {
    fail(
      "B6",
      "delayed RenewLease after release must return a normal JSON refusal, not an HTTP error",
      {
        httpStatus: rRenew.httpStatus,
        errorText: rRenew.errorText,
      },
    );
    return;
  }
  const renewed = boolOf(rRenew.json, "renewed");
  if (released === true && renewed === false) {
    pass(
      "B6",
      "ReleaseLease released:true; delayed RenewLease on the stale (epoch,token) -> renewed:false",
      {
        released,
        renewed,
      },
    );
  } else {
    fail("B6", "release did not invalidate renewal credentials as expected", { released, renewed });
  }
}

// Recorded by B1 for B3's replay (see B3's comment on why this lives outside `ctx`'s typed shape).
let wonNonce: string | undefined;

// ===================================================================================================
// C — Publish op state machine (design §4). Re-acquires a lease first (B6 released it).
// ===================================================================================================

async function acquireFreshLease(label: string): Promise<LeaseTuple | undefined> {
  if (ctx.serverGeneration === undefined) return undefined;
  const r = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 60,
    clientNonce: `${OWNER}-${label}`,
    expectedGeneration: ctx.serverGeneration,
  });
  if (!r.httpOk || r.json === undefined) return undefined;
  const granted = boolOf(r.json, "granted");
  const epoch = numOf(r.json, "epoch");
  const token = strOf(r.json, "token");
  const lastCompletedOpSeq = numOf(r.json, "lastCompletedOpSeq");
  if (
    granted !== true ||
    epoch === undefined ||
    token === undefined ||
    lastCompletedOpSeq === undefined
  ) {
    return undefined;
  }
  ctx.lease = { epoch, token, generation: ctx.serverGeneration };
  ctx.lastCompletedOpSeq = lastCompletedOpSeq;
  return ctx.lease;
}

let cAttemptId: string | undefined;
let cOpSeq: number | undefined;

async function checkC1(): Promise<void> {
  const lease = await acquireFreshLease("c-reacquire");
  if (lease === undefined || ctx.lastCompletedOpSeq === undefined) {
    fail(
      "C1",
      "BeginPublish at lastCompletedOpSeq+1 -> success",
      "precondition failed: could not re-acquire lease after B6's release",
    );
    return;
  }
  cAttemptId = `${OWNER}-c-publish`;
  cOpSeq = ctx.lastCompletedOpSeq + 1;
  const r = await postActionJson("BeginPublish", {
    epoch: lease.epoch,
    token: lease.token,
    generation: lease.generation,
    attemptId: cAttemptId,
    opSeq: cOpSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("C1", "BeginPublish must succeed", { httpStatus: r.httpStatus, errorText: r.errorText });
    return;
  }
  const begun = boolOf(r.json, "begun");
  if (begun === true) {
    pass("C1", "BeginPublish at exactly-next opSeq -> begun:true", { opSeq: cOpSeq });
  } else {
    fail("C1", "BeginPublish did not report begun:true", { json: r.json, opSeq: cOpSeq });
  }
}

async function checkC2(): Promise<void> {
  if (ctx.lease === undefined || ctx.serverGeneration === undefined) {
    fail(
      "C2",
      "AcquireLease while publish marker set -> operation-busy",
      "precondition missing: no lease/generation",
    );
    return;
  }
  // The marker BeginPublish (C1) set is a committed row — still active until EndPublish (C4).
  // No real concurrency needed here; the marker's presence is durable across sequential calls.
  const r = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 30,
    clientNonce: `${OWNER}-c2-nonce`,
    expectedGeneration: ctx.serverGeneration,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("C2", "AcquireLease while publish marker set must return a normal JSON refusal", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const granted = boolOf(r.json, "granted");
  const reason = strOf(r.json, "reason");
  if (granted === false && reason === "operation-busy") {
    pass(
      "C2",
      "concurrent AcquireLease while publish marker set -> granted:false, reason:operation-busy",
      { reason },
    );
  } else {
    fail("C2", "AcquireLease while publish marker set did not report operation-busy", {
      granted,
      reason,
    });
  }
}

async function checkC3(): Promise<void> {
  if (ctx.lease === undefined || cAttemptId === undefined || cOpSeq === undefined) {
    fail(
      "C3",
      "repeat BeginPublish (same attempt) -> idempotent success",
      "precondition missing: C1 did not establish state",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const r = await postActionJson("BeginPublish", {
    epoch,
    token,
    generation,
    attemptId: cAttemptId,
    opSeq: cOpSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("C3", "repeat BeginPublish must succeed", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const begun = boolOf(r.json, "begun");
  const alreadyCompleted = boolOf(r.json, "alreadyCompleted");
  if (begun === true && alreadyCompleted !== true) {
    pass(
      "C3",
      "repeat BeginPublish (same opSeq+attemptId) -> idempotent begun:true, not a refusal",
      { begun },
    );
  } else {
    fail("C3", "repeat BeginPublish did not idempotently succeed", { begun, alreadyCompleted });
  }
}

async function checkC4(): Promise<void> {
  if (ctx.lease === undefined || cAttemptId === undefined || cOpSeq === undefined) {
    fail(
      "C4",
      "EndPublish -> success, then GetOperationStatus reports completed:true",
      "precondition missing",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const rEnd = await postActionJson("EndPublish", {
    epoch,
    token,
    generation,
    attemptId: cAttemptId,
    opSeq: cOpSeq,
    outcome: "probe-outcome-ok",
  });
  if (!rEnd.httpOk || rEnd.json === undefined) {
    fail("C4", "EndPublish must succeed", {
      httpStatus: rEnd.httpStatus,
      errorText: rEnd.errorText,
    });
    return;
  }
  const ended = boolOf(rEnd.json, "ended");
  if (ended !== true) {
    fail("C4", "EndPublish did not report ended:true", { json: rEnd.json });
    return;
  }
  const rStatus = await postActionJson("GetOperationStatus", {
    epoch,
    token,
    generation,
    attemptId: cAttemptId,
    opSeq: cOpSeq,
  });
  if (!rStatus.httpOk || rStatus.json === undefined) {
    fail("C4", "GetOperationStatus after EndPublish must succeed", {
      httpStatus: rStatus.httpStatus,
      errorText: rStatus.errorText,
    });
    return;
  }
  const completed = boolOf(rStatus.json, "completed");
  if (completed === true) {
    ctx.lastCompletedOpSeq = cOpSeq;
    pass("C4", "EndPublish succeeded; GetOperationStatus reports completed:true", {
      ended,
      completed,
    });
  } else {
    fail("C4", "GetOperationStatus does not report completed:true after EndPublish", {
      json: rStatus.json,
    });
  }
}

async function checkC5(): Promise<void> {
  if (ctx.lease === undefined || cAttemptId === undefined || cOpSeq === undefined) {
    fail(
      "C5",
      "delayed duplicate BeginPublish on tombstoned attempt -> begun:false, alreadyCompleted:true",
      "precondition missing",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  // "Delayed" here means logically-after (the op is already tombstoned by C4) — no artificial
  // sleep needed since C4 already ran and committed before this call is dispatched.
  const r = await postActionJson("BeginPublish", {
    epoch,
    token,
    generation,
    attemptId: cAttemptId,
    opSeq: cOpSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("C5", "duplicate BeginPublish of a tombstoned attempt must return a normal JSON refusal", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const begun = boolOf(r.json, "begun");
  const alreadyCompleted = boolOf(r.json, "alreadyCompleted");
  if (begun === false && alreadyCompleted === true) {
    pass(
      "C5",
      "duplicate BeginPublish of a tombstoned attempt -> begun:false, alreadyCompleted:true (not reopened)",
      {
        begun,
        alreadyCompleted,
      },
    );
  } else {
    fail(
      "C5",
      "duplicate BeginPublish of a tombstoned attempt did not report the tombstone shape",
      {
        begun,
        alreadyCompleted,
      },
    );
  }
}

// ===================================================================================================
// D — The two-phase RunMutant fence (design §5). Reuses the SAME lease C acquired (still held —
// nothing in C released it). opSeq continues from ctx.lastCompletedOpSeq, which C4 advanced.
// ===================================================================================================

async function readRegisteredArtifactId(): Promise<void> {
  const r = await postActionRawString("RegisteredArtifact", { targetAppId: TARGET_APP_ID });
  if (r.httpOk && typeof r.value === "string" && /^[0-9a-f]{32}$/.test(r.value)) {
    ctx.registeredArtifactId = r.value;
    console.log(`[setup] RegisteredArtifact(${TARGET_APP_ID}) = ${r.value}`);
  } else {
    console.log(
      `[setup] RegisteredArtifact(${TARGET_APP_ID}) did NOT return a 32-hex artifact id — httpOk=${r.httpOk} value=${describe(r.value)} errorText=${describe(r.errorText)}. Every D/E check needing artifactId will report a precondition failure.`,
    );
  }
}

function nextOpSeq(): number | undefined {
  return ctx.lastCompletedOpSeq === undefined ? undefined : ctx.lastCompletedOpSeq + 1;
}

async function checkD1(): Promise<void> {
  if (ctx.lease === undefined || ctx.registeredArtifactId === undefined) {
    fail(
      "D1",
      "ordinary RunMutant -> status:'ran' with a real testResults array",
      "precondition missing: no lease/artifactId",
    );
    return;
  }
  const opSeq = nextOpSeq();
  if (opSeq === undefined) {
    fail(
      "D1",
      "ordinary RunMutant -> status:'ran' with a real testResults array",
      "precondition missing: no lastCompletedOpSeq",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const r = await postActionJson("RunMutant", {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId: `${OWNER}-d1`,
    mutantId: "",
    testCodeunitId: SANDBOX_TESTS_CODEUNIT_ID,
    testMethod: OVER_BUDGET_METHOD,
    leaseEpoch: epoch,
    leaseToken: token,
    serverGeneration: generation,
    opSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("D1", "RunMutant must return a normal 2xx JSON body", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const status = strOf(r.json, "status");
  const codeunitResults = strOf(r.json, "codeunitResults");
  if (status !== "ran" || codeunitResults === undefined) {
    fail("D1", "RunMutant did not report status:'ran' with codeunitResults — full body follows", {
      fullBody: r.json,
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(codeunitResults);
  } catch {
    fail("D1", "codeunitResults is not JSON — full body follows", { fullBody: r.json });
    return;
  }
  const testResults = isRecord(parsed) ? parsed.testResults : undefined;
  if (Array.isArray(testResults) && testResults.length === 1) {
    ctx.lastCompletedOpSeq = opSeq;
    pass(
      "D1",
      "ordinary RunMutant -> status:'ran' with a REAL testResults array (not an {error} payload)",
      {
        status,
        testResults,
      },
    );
  } else {
    fail(
      "D1",
      "codeunitResults did not contain a 1-element testResults array — full body follows",
      {
        fullBody: r.json,
        parsedCodeunitResults: parsed,
      },
    );
  }
}

async function checkD2(): Promise<void> {
  if (ctx.lease === undefined || ctx.registeredArtifactId === undefined) {
    fail(
      "D2",
      "stale leaseEpoch -> status:'lease-invalid'",
      "precondition missing: no lease/artifactId",
    );
    return;
  }
  const opSeq = nextOpSeq();
  if (opSeq === undefined) {
    fail(
      "D2",
      "stale leaseEpoch -> status:'lease-invalid'",
      "precondition missing: no lastCompletedOpSeq",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  // Deliberately epoch-1 UNLESS that would hit 0 (ValidateFenceCredentials fails loud on
  // Epoch<=0, a different, more fundamental check than the tuple-mismatch path this check
  // targets) — see the constant's doc comment above `NOT_A_TEST_CODEUNIT_ID`... actually see
  // inline: guard keeps this test targeting TryBeginRun step 1 (tuple mismatch), not
  // ValidateFenceCredentials's caller-contract guard.
  const staleEpoch = epoch > 1 ? epoch - 1 : epoch + 1;
  const r = await postActionJson("RunMutant", {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId: `${OWNER}-d2`,
    mutantId: "",
    testCodeunitId: SANDBOX_TESTS_CODEUNIT_ID,
    testMethod: OVER_BUDGET_METHOD,
    leaseEpoch: staleEpoch,
    leaseToken: token,
    serverGeneration: generation,
    opSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("D2", "stale leaseEpoch RunMutant must return a normal JSON refusal, not an HTTP error", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const status = strOf(r.json, "status");
  if (status === "lease-invalid") {
    // Refused at phase 1 step 1 (tuple mismatch) — nothing claimed, so this opSeq value is still
    // untouched; do NOT advance ctx.lastCompletedOpSeq.
    pass("D2", "RunMutant with a stale leaseEpoch -> status:'lease-invalid', nothing recorded", {
      status,
      opSeq,
    });
  } else {
    fail("D2", "RunMutant with a stale leaseEpoch did not report lease-invalid", {
      fullBody: r.json,
    });
  }
}

async function checkD3(): Promise<void> {
  if (ctx.lease === undefined || ctx.registeredArtifactId === undefined) {
    fail("D3", "duplicate-claim proof", "precondition missing: no lease/artifactId");
    return;
  }
  const opSeq = nextOpSeq();
  if (opSeq === undefined) {
    fail("D3", "duplicate-claim proof", "precondition missing: no lastCompletedOpSeq");
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const attemptId = `${OWNER}-d3`;
  const body = {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId,
    mutantId: "",
    testCodeunitId: RACE_TEST.codeunitId,
    testMethod: RACE_TEST.method,
    leaseEpoch: epoch,
    leaseToken: token,
    serverGeneration: generation,
    opSeq,
  };
  // Two genuinely un-awaited-between dispatches of the IDENTICAL body (same attemptId+opSeq) —
  // Promise.all joins them after both are already in flight. See RACE_TEST's doc comment: this
  // races on real request/response latency, not an artificial sleep, since no fixture test method
  // is slow enough to guarantee the overlap window by itself.
  const p1 = postActionJson("RunMutant", body);
  const p2 = postActionJson("RunMutant", body);
  const [r1, r2] = await Promise.all([p1, p2]);

  const results = [r1, r2].map((r) => ({
    httpOk: r.httpOk,
    status: r.json !== undefined ? strOf(r.json, "status") : undefined,
    reason: r.json !== undefined ? strOf(r.json, "reason") : undefined,
    body: r.json,
    errorText: r.errorText,
  }));

  const ranCount = results.filter((x) => x.status === "ran").length;
  const dupCount = results.filter(
    (x) => x.status === "lease-invalid" && x.reason === "op-in-flight",
  ).length;

  if (ranCount === 1 && dupCount === 1) {
    ctx.lastCompletedOpSeq = opSeq;
    pass(
      "D3",
      "of two concurrent RunMutant calls with the same attemptId+opSeq, exactly one ran and the other was refused as op-in-flight",
      {
        results,
      },
    );
  } else {
    // Genuinely open question per the brief: if the overlap window wasn't wide enough live, the
    // duplicate may instead have arrived after the original's phase 3 already tombstoned the
    // opSeq (plain 'lease-invalid' with no reason, not 'op-in-flight'). Report the actual shape,
    // never claim success.
    fail(
      "D3",
      "expected exactly one 'ran' and one 'lease-invalid'/'op-in-flight' — full pair follows",
      { results },
    );
    // If exactly one did land 'ran', the opSeq was still consumed server-side even though the
    // duplicate-claim shape wasn't observed — keep bookkeeping consistent for D4/D5/E.
    if (ranCount === 1) ctx.lastCompletedOpSeq = opSeq;
  }
}

async function checkD4(): Promise<void> {
  if (ctx.lease === undefined || ctx.registeredArtifactId === undefined) {
    fail(
      "D4",
      "concurrent GetOperationStatus returns promptly during an in-flight RunMutant",
      "precondition missing",
    );
    return;
  }
  const opSeq = nextOpSeq();
  if (opSeq === undefined) {
    fail(
      "D4",
      "concurrent GetOperationStatus returns promptly during an in-flight RunMutant",
      "precondition missing: no lastCompletedOpSeq",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const runPromise = postActionJson("RunMutant", {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId: `${OWNER}-d4`,
    mutantId: "",
    testCodeunitId: RACE_TEST.codeunitId,
    testMethod: RACE_TEST.method,
    leaseEpoch: epoch,
    leaseToken: token,
    serverGeneration: generation,
    opSeq,
  });

  const statusStart = Date.now();
  const statusResult = await postActionJson("GetOperationStatus", {
    epoch,
    token,
    generation,
    attemptId: `${OWNER}-d4-status-read`,
    opSeq: 0,
  });
  const statusElapsedMs = Date.now() - statusStart;

  const runResult = await runPromise;
  const runStatus = runResult.json !== undefined ? strOf(runResult.json, "status") : undefined;
  if (runStatus === "ran") ctx.lastCompletedOpSeq = opSeq;

  const statusOk = statusResult.httpOk && statusResult.json !== undefined;
  if (statusOk && statusElapsedMs < D4_STATUS_READ_BOUND_MS) {
    pass(
      "D4",
      `concurrent GetOperationStatus returned in ${statusElapsedMs}ms (< ${D4_STATUS_READ_BOUND_MS}ms bound) while RunMutant was in flight`,
      {
        statusElapsedMs,
        statusJson: statusResult.json,
        runStatus,
      },
    );
  } else {
    fail("D4", "concurrent GetOperationStatus was slow, or failed, while RunMutant was in flight", {
      statusElapsedMs,
      statusOk,
      errorText: statusResult.errorText,
      runStatus,
    });
  }
}

async function checkD5(): Promise<void> {
  if (ctx.lease === undefined || ctx.registeredArtifactId === undefined) {
    fail("D5", "catchable-boundary proof", "precondition missing: no lease/artifactId");
    return;
  }
  const opSeq = nextOpSeq();
  if (opSeq === undefined) {
    fail("D5", "catchable-boundary proof", "precondition missing: no lastCompletedOpSeq");
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const r = await postActionJson("RunMutant", {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId: `${OWNER}-d5`,
    mutantId: "",
    testCodeunitId: NOT_A_TEST_CODEUNIT_ID,
    testMethod: "ProbeBoundary",
    leaseEpoch: epoch,
    leaseToken: token,
    serverGeneration: generation,
    opSeq,
  });
  if (!r.httpOk || r.json === undefined) {
    fail("D5", "RunMutant against a non-test codeunit id must NOT surface as an HTTP error", {
      httpStatus: r.httpStatus,
      errorText: r.errorText,
    });
    return;
  }
  const status = strOf(r.json, "status");
  const codeunitResults = strOf(r.json, "codeunitResults");
  let hasErrorKey = false;
  if (codeunitResults !== undefined) {
    try {
      const parsed: unknown = JSON.parse(codeunitResults);
      hasErrorKey = isRecord(parsed) && typeof parsed.error === "string";
    } catch {
      hasErrorKey = false;
    }
  }
  if (status !== "ran" || !hasErrorKey) {
    fail(
      "D5",
      "expected status:'ran' with an {error} codeunitResults payload — full body follows",
      { fullBody: r.json },
    );
    return;
  }
  ctx.lastCompletedOpSeq = opSeq;

  // Second half: phase 3 must still have cleared the marker — a competing AcquireLease must NOT
  // be operation-busy (it must be a plain 'held' refusal against our still-live lease, proving
  // the error was captured and phase 3 ran to completion).
  if (ctx.serverGeneration === undefined) {
    fail("D5", "post-error AcquireLease check", "precondition missing: no serverGeneration");
    return;
  }
  const rAcquire = await postActionJson("AcquireLease", {
    owner: OWNER,
    ttlSeconds: 30,
    clientNonce: `${OWNER}-d5-check`,
    expectedGeneration: ctx.serverGeneration,
  });
  if (!rAcquire.httpOk || rAcquire.json === undefined) {
    fail("D5", "post-error AcquireLease must return a normal JSON refusal", {
      httpStatus: rAcquire.httpStatus,
      errorText: rAcquire.errorText,
    });
    return;
  }
  const reason = strOf(rAcquire.json, "reason");
  if (reason !== "operation-busy") {
    pass(
      "D5",
      "RunMutant caught the phase-2 error as status:'ran' with an {error} payload, AND phase 3 cleared the marker (post-error AcquireLease is NOT operation-busy)",
      {
        codeunitResultsStatus: status,
        postErrorAcquireReason: reason,
      },
    );
  } else {
    fail(
      "D5",
      "phase 3 apparently did NOT clear the marker — post-error AcquireLease reports operation-busy",
      {
        reason,
      },
    );
  }
}

async function checkD6(): Promise<void> {
  if (ctx.lease === undefined) {
    fail(
      "D6",
      "ReleaseLease after the D-series -> released:true",
      "precondition missing: no lease",
    );
    return;
  }
  const { epoch, token, generation } = ctx.lease;
  const r = await postActionJson("ReleaseLease", { epoch, token, generation });
  if (!r.httpOk || r.json === undefined) {
    fail("D6", "ReleaseLease must succeed", { httpStatus: r.httpStatus, errorText: r.errorText });
    return;
  }
  const released = boolOf(r.json, "released");
  if (released === true) {
    pass("D6", "ReleaseLease after the D-series -> released:true (no marker stranded)", {
      released,
    });
  } else {
    fail("D6", "ReleaseLease after the D-series did not report released:true", { json: r.json });
  }
}

// ===================================================================================================
// E — Cleanup. Leaves the lease FREE and the container unmutated. Re-acquires fresh (D6 released
// it) rather than reusing D's tuple, so this is a genuinely independent final verification rather
// than trusting the D-series' own bookkeeping.
// ===================================================================================================

async function checkE(): Promise<void> {
  if (ctx.registeredArtifactId === undefined) {
    fail(
      "E",
      "final baseline RunMutant + release, lease left free",
      "precondition missing: no registeredArtifactId",
    );
    return;
  }
  const lease = await acquireFreshLease("e-cleanup");
  if (lease === undefined || ctx.lastCompletedOpSeq === undefined) {
    fail(
      "E",
      "final baseline RunMutant + release, lease left free",
      "precondition failed: could not re-acquire lease after D6's release",
    );
    return;
  }
  const opSeq = ctx.lastCompletedOpSeq + 1;
  const rRun = await postActionJson("RunMutant", {
    targetAppId: TARGET_APP_ID,
    artifactId: ctx.registeredArtifactId,
    attemptId: `${OWNER}-e-baseline`,
    mutantId: "", // baseline — no mutant active, proving the container is unmutated
    testCodeunitId: SANDBOX_TESTS_CODEUNIT_ID,
    testMethod: OVER_BUDGET_METHOD,
    leaseEpoch: lease.epoch,
    leaseToken: lease.token,
    serverGeneration: lease.generation,
    opSeq,
  });
  let baselinePassed = false;
  if (rRun.httpOk && rRun.json !== undefined) {
    const status = strOf(rRun.json, "status");
    const codeunitResults = strOf(rRun.json, "codeunitResults");
    if (status === "ran" && codeunitResults !== undefined) {
      try {
        const parsed: unknown = JSON.parse(codeunitResults);
        const lines =
          isRecord(parsed) && Array.isArray(parsed.testResults) ? parsed.testResults : [];
        const line = lines.length === 1 ? lines[0] : undefined;
        baselinePassed = isRecord(line) && line.result === 2; // RESULT_SUCCESS, see run-mutant-transport.ts
      } catch {
        baselinePassed = false;
      }
    }
  }

  const rRelease = await postActionJson("ReleaseLease", {
    epoch: lease.epoch,
    token: lease.token,
    generation: lease.generation,
  });
  const released =
    rRelease.httpOk && rRelease.json !== undefined ? boolOf(rRelease.json, "released") : undefined;

  // Final lease-state read: GetOperationStatus deliberately does NOT gate on tuple match (see
  // ControlState.TryGetOperationStatus's doc comment), so this reads the CURRENT marker state
  // regardless of the now-stale credentials — a genuinely independent confirmation of the final
  // state, not a re-use of `lease`'s already-released tuple.
  const rFinal = await postActionJson("GetOperationStatus", {
    epoch: 0,
    token: "",
    generation: "",
    attemptId: "",
    opSeq: 0,
  });
  const finalOpKind = rFinal.json !== undefined ? strOf(rFinal.json, "opKind") : undefined;
  const finalLastCompleted =
    rFinal.json !== undefined ? numOf(rFinal.json, "lastCompletedOpSeq") : undefined;

  console.log(
    `[E] final lease state — opKind=${describe(finalOpKind)} lastCompletedOpSeq=${describe(finalLastCompleted)} released=${describe(released)}`,
  );

  if (baselinePassed && released === true) {
    pass(
      "E",
      "final baseline RunMutant passed (container unmutated) and ReleaseLease succeeded (lease left free)",
      {
        baselinePassed,
        released,
        finalOpKind,
      },
    );
  } else {
    fail("E", "cleanup did not fully succeed — see observed for which half failed", {
      baselinePassed,
      released,
      runBody: rRun.json,
      releaseBody: rRelease.json,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Main — sections run in the documented dependency order: A -> B -> C -> D -> E. Every check is
// independently try/caught (runCheck) so one failure never aborts the rest of the run.
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Layer 5C-B1 live probe — run tag ${RUN_TAG}, target ${ODATA_BASE}\n`);

  console.log("=== A: protocol v2 handshake ===");
  await runCheck("A1", checkA1);
  await runCheck("A2", checkA2);
  await runCheck("A3", checkA3); // must succeed for anything below to have a serverGeneration

  console.log(
    "\n[setup] reading currently-registered artifact id (RegisterArtifact is NOT an OData action — see file header)",
  );
  await readRegisteredArtifactId();

  console.log("\n=== B: lease lifecycle ===");
  await runCheck("B1", checkB1); // sets ctx.lease + module-level `wonNonce` as a side effect of granting
  await runCheck("B2", checkB2);
  await runCheck("B3", checkB3);
  await runCheck("B4", checkB4);
  await runCheck("B5", checkB5);
  await runCheck("B6", checkB6);

  console.log("\n=== C: publish op state machine ===");
  await runCheck("C1", checkC1);
  await runCheck("C2", checkC2);
  await runCheck("C3", checkC3);
  await runCheck("C4", checkC4);
  await runCheck("C5", checkC5);

  console.log("\n=== D: two-phase RunMutant fence ===");
  await runCheck("D1", checkD1);
  await runCheck("D2", checkD2);
  await runCheck("D3", checkD3);
  await runCheck("D4", checkD4);
  await runCheck("D5", checkD5);
  await runCheck("D6", checkD6);

  console.log("\n=== E: cleanup ===");
  await runCheck("E", checkE);

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `RESULT: ${passCount} passed, ${failCount} failed (of ${passCount + failCount} checks)`,
  );
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
