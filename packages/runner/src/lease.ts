import type { ActivationConfig, FetchFn } from "./activation";

/**
 * OData client for the Layer 5C-B1 machine-global lease + operation-marker surface
 * (design §4/§6; `extensions/lethal-control/src/ControlApi.Codeunit.al`). Request-shaping
 * (Basic auth, `company`/`tenant` query params, manual AbortController timeout, single
 * double-parsed OData scalar `value`) mirrors `RunMutantTransport`/`HarnessVerifier` — it does
 * NOT reuse `postOData` (activation.ts) for the same reason `RunMutantTransport` doesn't: that
 * helper's non-2xx classification is `MutationControl`-specific.
 *
 * Scope (Task 6 of 10): this module shapes ONE call each — acquire/renew/release/beginPublish/
 * endPublish/getOperationStatus/recoverOp — and maps each response to a typed outcome. It does
 * NOT own the heartbeat loop, backoff-with-jitter, quarantine, or verdict invalidation (Task 8),
 * and it does NOT decide when `recoverOp`'s precondition (a parsed terminal response) actually
 * holds — see `recoverOp`'s own doc comment.
 *
 * Every request-body key below is the camelCase of the AL parameter name, read off
 * `ControlApi.Codeunit.al`'s actual procedure signatures — confirmed against the live,
 * already-verified `scripts/probe-5cb1.ts` (21/21 checks passing on Cronus281), not guessed.
 */

/** design §4: `LC Lease."Op Attempt Id"` is a Text[64] on the server — a longer `attemptId`
 * would be silently truncated on write, so a caller's own retry (which resends the FULL id)
 * could never match the stored, truncated value. Enforced here, before it ever reaches the
 * wire. A GUID (~36 chars) comfortably fits. */
export const MAX_ATTEMPT_ID_LENGTH = 64;

/** ControlState.Codeunit.al's `RenewPeriodMs()` is `local` (5000ms) and unreadable over the
 * wire — hardcoded mirror of its own documented client contract: "the client's ttlSeconds must
 * be at most 3 x RenewPeriodMs() (15s at the current 5000ms value) — a ttl/3 heartbeat on a
 * longer ttl would renew less often than this period requires." See that comment (and design
 * §6's ttl/3 heartbeat) for the full derivation; do not tighten or loosen this independently of
 * the server constant it mirrors. */
export const MAX_TTL_SECONDS = 15;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thrown when a lease-related OData call cannot be answered AT ALL — unreachable, a non-2xx
 * HTTP response, or a malformed/protocol-violating 2xx body (missing the OData scalar `value`,
 * or missing/wrong-typed a field the server contract guarantees). Distinct from a normal,
 * well-formed REFUSAL (e.g. `{granted:false, reason:"held"}`), which is returned as a typed
 * outcome, never thrown — the caller (Task 8) branches on `reason` for that. Task 8 also throws
 * THIS SAME class itself, separately, once its bounded backoff-with-jitter is exhausted (design
 * §8: "`LeaseUnavailableError` — acquire `held`/backoff-exhausted. Aborts.") — this module only
 * throws it for the transport/shape failures listed above.
 */
export class LeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseUnavailableError";
  }
}

/**
 * Thrown when a CALLER violates this module's own contract before any request is even shaped —
 * an `attemptId` over the server's `Text[64]` bound (`assertAttemptId`), a `ttlSeconds` outside
 * `(0, MAX_TTL_SECONDS]` (`assertTtlBound`), `recoverOp` invoked without its required
 * `terminalProof: true`, or `forceResetLease` invoked with a blank `expectedGeneration`. None of
 * these ever reach the wire.
 *
 * Distinct from `LeaseUnavailableError` (a transport/shape failure this module could not have
 * prevented, however carefully it was called) so a caller can `instanceof`-distinguish "you
 * called this wrong" from "the server/network failed" — see CLAUDE.md's typed-error-classes
 * convention: this extends `Error` directly, never `LeaseUnavailableError`, mirroring the
 * `AlcCompileError`/`ArtifactPrepareError`/`DeploymentError` separation elsewhere in this repo.
 */
export class LeaseCallerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseCallerContractError";
  }
}

/** The held lease's identity + bookkeeping, as returned by a granted `acquire()`. Carried by the
 * caller through every subsequent fenced call (design §6: "Every `RunMutant` passes `(epoch,
 * token, serverGeneration, attemptId)`" — the same tuple fences renew/release/beginPublish/
 * endPublish/getOperationStatus/recoverOp too). */
export interface Lease {
  readonly epoch: number;
  readonly token: string;
  readonly serverGeneration: string;
  readonly lastCompletedOpSeq: number;
  readonly expiresAt: string;
}

/** The 3-field identity tuple every fenced call after `acquire()` re-validates against the
 * server row (design §4). A full `Lease` satisfies this structurally — callers just pass the
 * lease they hold. */
export type LeaseTuple = Pick<Lease, "epoch" | "token" | "serverGeneration">;

/** Known `AcquireLease` refusal reasons (design §4) — not exhaustively enforced (a forward-
 * compatible server could add one), so `reason` is typed as `string`; these are what the wire
 * actually sends today. `"held"`/`"operation-busy"` carry `holder`+`expiresAt`;
 * `"operation-orphaned"` carries `opAttemptId`+`opStartedAt`; `"generation-changed"` carries
 * neither. */
export type AcquireRefusalReason =
  | "held"
  | "operation-busy"
  | "operation-orphaned"
  | "generation-changed";

export type AcquireOutcome =
  | { readonly granted: true; readonly lease: Lease }
  | {
      readonly granted: false;
      readonly reason: string;
      readonly holder?: string;
      readonly expiresAt?: string;
      readonly opAttemptId?: string;
      readonly opStartedAt?: string;
    };

export type RenewOutcome =
  | { readonly renewed: true; readonly expiresAt: string }
  | { readonly renewed: false };

/** `ControlState.Codeunit.al`'s `TryRelease` has exactly one `Released := false` path — a
 * non-idle `"Op Kind"` — and it always sets `Reason := 'op-in-flight'` before that `exit`; every
 * OTHER path (tuple match with an idle marker, or a no-match idempotent success) sets
 * `Released := true`. So `reason` is REQUIRED whenever `released` is `false`, never merely
 * possible — a response that says `released:false` with no `reason` is a protocol violation,
 * not a legitimate "no reason given" refusal (t4, 5C-B2). */
export type ReleaseOutcome =
  | { readonly released: true }
  | { readonly released: false; readonly reason: string };

export interface BeginPublishOutcome {
  readonly begun: boolean;
  readonly alreadyCompleted?: boolean;
}

export interface EndPublishOutcome {
  readonly ended: boolean;
  readonly alreadyCompleted?: boolean;
}

export interface OperationStatus {
  readonly opKind: string;
  readonly opAttemptId: string;
  readonly opSeq: number;
  readonly lastCompletedOpSeq: number;
  readonly completed: boolean;
}

export interface RecoverOpOutcome {
  readonly recovered: boolean;
  readonly alreadyCompleted?: boolean;
}

/** `ForceResetLease` (design §8, operator recovery). `ControlApi.Codeunit.al`'s doc comment pins
 * the wire shape: `{reset, serverGeneration?, epoch?, reason?}` — `serverGeneration`/`epoch` are
 * present only when `reset:true`, `reason` only when `reset:false`. */
export type ForceResetOutcome =
  | { readonly reset: true; readonly serverGeneration: string; readonly epoch: number }
  | { readonly reset: false; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(json: Record<string, unknown>, key: string, action: string): string {
  const v = json[key];
  if (typeof v !== "string") {
    throw new LeaseUnavailableError(
      `LethALControl_${action} response missing string "${key}": ${JSON.stringify(json)}`,
    );
  }
  return v;
}

function requireNumber(json: Record<string, unknown>, key: string, action: string): number {
  const v = json[key];
  if (typeof v !== "number") {
    throw new LeaseUnavailableError(
      `LethALControl_${action} response missing number "${key}": ${JSON.stringify(json)}`,
    );
  }
  return v;
}

function requireBoolean(json: Record<string, unknown>, key: string, action: string): boolean {
  const v = json[key];
  if (typeof v !== "boolean") {
    throw new LeaseUnavailableError(
      `LethALControl_${action} response missing boolean "${key}": ${JSON.stringify(json)}`,
    );
  }
  return v;
}

function optionalString(json: Record<string, unknown>, key: string): string | undefined {
  const v = json[key];
  return typeof v === "string" ? v : undefined;
}

function optionalBoolean(json: Record<string, unknown>, key: string): boolean | undefined {
  const v = json[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * The one `attemptId` bound for the WHOLE fenced surface — exported because `RunMutant` carries an
 * `attemptId` too (`run-mutant-transport.ts`) and must be held to the identical bound, not to a
 * second one that could drift: `ControlState.Codeunit.al`'s `TryBeginRun` stores
 * `CopyStr(AttemptId,1,64)` in phase 1 but `TryFinishRun` compares that TRUNCATED stored value
 * against the FULL incoming one in phase 3, so an over-long id makes phase 3 unmatchable →
 * `lease-invalid` with `Op Kind = run` left set → a durable `container-needs-recycle` needing the
 * manual operator recovery in `fixtures/README.md`.
 * Refusing before dispatch is strictly better than any of that.
 */
export function assertAttemptId(attemptId: string): void {
  if (attemptId.length > MAX_ATTEMPT_ID_LENGTH) {
    throw new LeaseCallerContractError(
      `attemptId must be at most ${MAX_ATTEMPT_ID_LENGTH} characters — the server stores it in a Text[64] and compares the stored (truncated) value against the full incoming one, so a longer id could never match its own retry (design §4). Got ${attemptId.length} chars: ${attemptId}`,
    );
  }
}

function assertTtlBound(ttlSeconds: number): void {
  // Lower bound first: a ttl of 0 or less is a caller-contract violation, not a short lease — it
  // grants something already expired, and design §6's ttl/3 heartbeat then degenerates to
  // `Math.max(1, …)` = a 1ms renew loop (orchestrator.ts). Fail loudly rather than accept it.
  if (!(ttlSeconds > 0)) {
    throw new LeaseCallerContractError(
      `ttlSeconds must be greater than 0 — the server grants a lease expiring ttlSeconds from now, so a non-positive ttl is born expired and its ttl/3 heartbeat degenerates to a 1ms renew loop (design §6). Got ${ttlSeconds}`,
    );
  }
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new LeaseCallerContractError(
      `ttlSeconds must be at most ${MAX_TTL_SECONDS}s — the server renews on a ${MAX_TTL_SECONDS}s grace derived from RenewPeriodMs() (ControlState.Codeunit.al), and design §6's ttl/3 heartbeat on a longer ttl would renew less often than that period requires. Got ${ttlSeconds}`,
    );
  }
}

/** POST one `LethALControl_<action>` OData action and return the codeunit's own parsed JSON
 * result (the string living inside the OData scalar `value`, parsed twice — see the file-level
 * doc comment). Throws `LeaseUnavailableError` for any failure that means the client cannot
 * even learn the lease's state: unreachable, non-2xx, or a malformed body. A well-formed
 * REFUSAL (e.g. `{granted:false, reason:"held"}`) is a normal 2xx JSON object and is returned
 * here like any other result — callers map it to a typed outcome, never treat it as failure. */
async function postLeaseAction(
  cfg: ActivationConfig,
  fetchFn: FetchFn,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;

  // AbortSignal.timeout() is unreliable in this Bun/Windows env (see activation.ts) — manual
  // AbortController + setTimeout instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LeaseUnavailableError(`LethALControl_${action} unreachable: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new LeaseUnavailableError(`LethALControl_${action} failed: HTTP ${res.status}`);
  }
  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    throw new LeaseUnavailableError(`LethALControl_${action} 2xx body is not JSON`);
  }
  const value = isRecord(envelope) ? envelope.value : undefined;
  if (typeof value !== "string") {
    throw new LeaseUnavailableError(`LethALControl_${action} returned no string "value"`);
  }
  let inner: unknown;
  try {
    inner = JSON.parse(value);
  } catch {
    throw new LeaseUnavailableError(`LethALControl_${action} "value" is not JSON: ${value}`);
  }
  if (!isRecord(inner)) {
    throw new LeaseUnavailableError(`LethALControl_${action} parsed "value" is not a JSON object`);
  }
  return inner;
}

/**
 * The lease surface `runSession` consumes (Task 8). Structural, and implemented by `LeaseClient`
 * without it having to declare so: the orchestrator depends on this shape rather than on the
 * concrete class, so a unit test can drive the whole acquire/heartbeat/fence/release lifecycle
 * against an in-memory fake with no HTTP anywhere. Every member is exactly `LeaseClient`'s own
 * signature — including `recoverOp`'s literal-`true` `terminalProof`, which must NOT be widened
 * to `boolean` here (that parameter's entire purpose is to make an unproven call impossible to
 * write by accident — see `LeaseClient.recoverOp`).
 */
export interface LeaseApi {
  acquire(
    owner: string,
    ttlSeconds: number,
    clientNonce: string,
    expectedGeneration: string,
  ): Promise<AcquireOutcome>;
  renew(lease: LeaseTuple, ttlSeconds: number): Promise<RenewOutcome>;
  release(lease: LeaseTuple): Promise<ReleaseOutcome>;
  beginPublish(lease: LeaseTuple, attemptId: string, opSeq: number): Promise<BeginPublishOutcome>;
  endPublish(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    outcome: string,
  ): Promise<EndPublishOutcome>;
  getOperationStatus(lease: LeaseTuple, attemptId: string, opSeq: number): Promise<OperationStatus>;
  recoverOp(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    terminalProof: true,
  ): Promise<RecoverOpOutcome>;
}

export class LeaseClient implements LeaseApi {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private post(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return postLeaseAction(this.cfg, this.fetchFn, action, body);
  }

  /** `AcquireLease` (design §4). `ttlSeconds` is bound to `MAX_TTL_SECONDS`. */
  async acquire(
    owner: string,
    ttlSeconds: number,
    clientNonce: string,
    expectedGeneration: string,
  ): Promise<AcquireOutcome> {
    assertTtlBound(ttlSeconds);
    const json = await this.post("AcquireLease", {
      owner,
      ttlSeconds,
      clientNonce,
      expectedGeneration,
    });
    const granted = requireBoolean(json, "granted", "AcquireLease");
    if (granted) {
      return {
        granted: true,
        lease: {
          epoch: requireNumber(json, "epoch", "AcquireLease"),
          token: requireString(json, "token", "AcquireLease"),
          serverGeneration: requireString(json, "serverGeneration", "AcquireLease"),
          lastCompletedOpSeq: requireNumber(json, "lastCompletedOpSeq", "AcquireLease"),
          expiresAt: requireString(json, "expiresAt", "AcquireLease"),
        },
      };
    }
    const reason = requireString(json, "reason", "AcquireLease");
    const holder = optionalString(json, "holder");
    const expiresAt = optionalString(json, "expiresAt");
    const opAttemptId = optionalString(json, "opAttemptId");
    const opStartedAt = optionalString(json, "opStartedAt");
    return {
      granted: false,
      reason,
      ...(holder !== undefined ? { holder } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(opAttemptId !== undefined ? { opAttemptId } : {}),
      ...(opStartedAt !== undefined ? { opStartedAt } : {}),
    };
  }

  /** `RenewLease` (design §4): a matching `(epoch, token, generation)` is honored even
   * momentarily past `expiresAt`. `ttlSeconds` is bound to `MAX_TTL_SECONDS`. */
  async renew(lease: LeaseTuple, ttlSeconds: number): Promise<RenewOutcome> {
    assertTtlBound(ttlSeconds);
    const json = await this.post("RenewLease", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      ttlSeconds,
    });
    const renewed = requireBoolean(json, "renewed", "RenewLease");
    if (renewed) {
      return { renewed: true, expiresAt: requireString(json, "expiresAt", "RenewLease") };
    }
    return { renewed: false };
  }

  /** `ReleaseLease` (design §4): invalidates renewal credentials on success; refused
   * (`reason: "op-in-flight"`) while an op marker is set. */
  async release(lease: LeaseTuple): Promise<ReleaseOutcome> {
    const json = await this.post("ReleaseLease", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
    });
    const released = requireBoolean(json, "released", "ReleaseLease");
    if (released) return { released: true };
    return { released: false, reason: requireString(json, "reason", "ReleaseLease") };
  }

  /** `BeginPublish` (design §4): the publish op-marker state machine's entry. */
  async beginPublish(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
  ): Promise<BeginPublishOutcome> {
    assertAttemptId(attemptId);
    const json = await this.post("BeginPublish", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      attemptId,
      opSeq,
    });
    const begun = requireBoolean(json, "begun", "BeginPublish");
    const alreadyCompleted = optionalBoolean(json, "alreadyCompleted");
    return { begun, ...(alreadyCompleted !== undefined ? { alreadyCompleted } : {}) };
  }

  /** `EndPublish` (design §4): tombstones the publish op. Called on EVERY confirmed terminal
   * outcome (success or a deterministic failure) — never on a genuinely-unknown result. */
  async endPublish(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    outcome: string,
  ): Promise<EndPublishOutcome> {
    assertAttemptId(attemptId);
    const json = await this.post("EndPublish", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      attemptId,
      opSeq,
      outcome,
    });
    const ended = requireBoolean(json, "ended", "EndPublish");
    const alreadyCompleted = optionalBoolean(json, "alreadyCompleted");
    return { ended, ...(alreadyCompleted !== undefined ? { alreadyCompleted } : {}) };
  }

  /** `GetOperationStatus` (design §4): lost-ack reconciliation read for any op (publish or
   * run). Deliberately does NOT gate on `(epoch, token, generation)` matching the current row
   * server-side — `attemptId`/`opSeq` may legitimately be empty/`0` for a generic status read
   * (see `scripts/probe-5cb1.ts` section E). */
  async getOperationStatus(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
  ): Promise<OperationStatus> {
    assertAttemptId(attemptId);
    const json = await this.post("GetOperationStatus", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      attemptId,
      opSeq,
    });
    return {
      opKind: requireString(json, "opKind", "GetOperationStatus"),
      opAttemptId: requireString(json, "opAttemptId", "GetOperationStatus"),
      opSeq: requireNumber(json, "opSeq", "GetOperationStatus"),
      lastCompletedOpSeq: requireNumber(json, "lastCompletedOpSeq", "GetOperationStatus"),
      completed: requireBoolean(json, "completed", "GetOperationStatus"),
    };
  }

  /**
   * `RecoverOp` (design §5/§8) — recovers the CALLER'S OWN stranded op marker.
   *
   * `terminalProof` is not a wire field: it exists ONLY to make misuse impossible to miss. The
   * design permits calling this action ONLY after a PARSED application-level terminal response
   * — an OData/JSON body the harness itself produced, proving the AL invocation actually
   * unwound (e.g. a phase-3 `lease-invalid`, or a `GetOperationStatus` read reporting the
   * attempt completed/tombstoned). It is NEVER permitted after a bare HTTP status (a proxy
   * 502/504), a connection error, or a client-side timeout — those are indistinguishable from
   * an AL op that is still genuinely running server-side, and calling `RecoverOp` there can
   * clear the marker while that op is still executing, letting a second session overlap it on
   * shared DB state (the exact false-verdict sequence design §5 exists to close).
   *
   * This method only SHAPES the request; it does not and cannot verify the precondition above
   * — that determination happens at the call site (Task 8), which must have an actual parsed
   * terminal response or tombstoned status in hand before it can even construct a literal
   * `true` to pass here. The parameter is typed as the literal `true` (not `boolean`) so a
   * caller holding only a plain boolean cannot satisfy it without an explicit, visible
   * assertion — and the runtime check below refuses anyone who bypasses that (a plain JS
   * caller, an `as true` cast, stale compiled output).
   */
  async recoverOp(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    terminalProof: true,
  ): Promise<RecoverOpOutcome> {
    if (terminalProof !== true) {
      throw new LeaseCallerContractError(
        "recoverOp requires terminalProof: true — RecoverOp may ONLY follow a PARSED " +
          "application-level terminal response (or a completed/tombstoned GetOperationStatus " +
          "read), NEVER a bare HTTP status, connection error, or client timeout (design §5) — " +
          "those are indistinguishable from a still-running AL op.",
      );
    }
    assertAttemptId(attemptId);
    const json = await this.post("RecoverOp", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      attemptId,
      opSeq,
    });
    const recovered = requireBoolean(json, "recovered", "RecoverOp");
    const alreadyCompleted = optionalBoolean(json, "alreadyCompleted");
    return { recovered, ...(alreadyCompleted !== undefined ? { alreadyCompleted } : {}) };
  }

  /**
   * `ForceResetLease` (design §8) — the operator recovery action for a wedged lease row left by a
   * dead session's unresolved op marker. Deliberately NOT part of `LeaseApi` (see that interface's
   * doc comment, and `lease.itest.ts`'s `postRawAction` comment): it is an operator-only recovery
   * step outside the normal fenced session lifecycle `runSession` drives, reached only via
   * `lethal force-reset-lease` (cli.ts's `performForceResetLease`).
   *
   * The reset's WHOLE authorization is `expectedGeneration` matching the row's CURRENT
   * "Server Generation" (replay protection across resets — `ControlState.Codeunit.al`'s
   * `TryForceResetLease` doc comment; this is NOT NST-incarnation binding, see that comment for
   * the full deviation). `TryForceResetLease` `Error()`s outright on a blank echo rather than
   * returning a typed `{reset:false}` refusal (`BlankExpectedGenerationErr`), so a blank value is
   * refused HERE, before dispatch — mirroring `assertAttemptId`/`assertTtlBound`'s existing
   * caller-contract-violation pattern in this file. A STALE (non-blank but mismatched) echo IS a
   * well-formed refusal (`reset:false, reason:"generation-changed"`) and is returned as a typed
   * outcome, never thrown.
   */
  async forceResetLease(expectedGeneration: string): Promise<ForceResetOutcome> {
    if (expectedGeneration === "") {
      throw new LeaseCallerContractError(
        "forceResetLease requires a non-blank expectedGeneration echoing the CURRENT " +
          '"Server Generation", read live via HarnessInfo(clientProtocol: 2) AFTER the ' +
          "container/NST restart (design §8) — the server rejects a blank echo outright with an " +
          "error rather than a typed refusal, so this must be caught before the call.",
      );
    }
    const json = await this.post("ForceResetLease", { expectedGeneration });
    const reset = requireBoolean(json, "reset", "ForceResetLease");
    if (reset) {
      return {
        reset: true,
        serverGeneration: requireString(json, "serverGeneration", "ForceResetLease"),
        epoch: requireNumber(json, "epoch", "ForceResetLease"),
      };
    }
    return { reset: false, reason: requireString(json, "reason", "ForceResetLease") };
  }
}
