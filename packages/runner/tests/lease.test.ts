import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import { BcRedirectRefusedError } from "../src/bc-fetch";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import {
  type Lease,
  LeaseCallerContractError,
  LeaseClient,
  LeaseUnavailableError,
  MAX_ATTEMPT_ID_LENGTH,
  MAX_TTL_SECONDS,
} from "../src/lease";
import { deafBody, deafFetch, stalledBody } from "./helpers/lease-wire";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};

const LEASE: Lease = {
  epoch: 3,
  token: "tok-abc",
  serverGeneration: "0".repeat(32),
  lastCompletedOpSeq: 5,
  expiresAt: "2026-07-24T12:00:00.000Z",
};

/** A 200 whose OData scalar `value` is the (stringified) inner result JSON — mirrors
 * run-mutant-transport.test.ts's `okFetch` and the live-verified probe's wire shape. */
function okFetch(inner: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
}

/** Captures the URL + parsed JSON body of the single call made through it, then answers `inner`. */
function captureFetch(inner: Record<string, unknown>): {
  fetchFn: typeof fetch;
  seen: () => { url: string; body: Record<string, unknown> } | undefined;
} {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, seen: () => seen };
}

function client(fetchFn: typeof fetch): LeaseClient {
  return new LeaseClient(CFG, fetchFn);
}

describe("LeaseClient.acquire", () => {
  test("granted → parsed Lease", async () => {
    const inner = {
      granted: true,
      epoch: 4,
      token: "tok-xyz",
      serverGeneration: "a".repeat(32),
      lastCompletedOpSeq: 7,
      expiresAt: "2026-07-24T13:00:00.000Z",
    };
    const outcome = await client(okFetch(inner)).acquire("host:1:run1", 15, "nonce-1", "gen-0");
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) throw new Error("expected granted");
    expect(outcome.lease).toEqual({
      epoch: 4,
      token: "tok-xyz",
      serverGeneration: "a".repeat(32),
      lastCompletedOpSeq: 7,
      expiresAt: "2026-07-24T13:00:00.000Z",
    });
  });

  test("granted:false, reason:'held' → typed refusal carrying holder + expiresAt", async () => {
    const inner = {
      granted: false,
      reason: "held",
      holder: "host:2:run2",
      expiresAt: "2026-07-24T13:05:00.000Z",
    };
    const outcome = await client(okFetch(inner)).acquire("host:1:run1", 15, "nonce-1", "gen-0");
    expect(outcome.granted).toBe(false);
    if (outcome.granted) throw new Error("expected refusal");
    expect(outcome.reason).toBe("held");
    expect(outcome.holder).toBe("host:2:run2");
    expect(outcome.expiresAt).toBe("2026-07-24T13:05:00.000Z");
  });

  test("granted:false, reason:'operation-busy' → typed refusal carrying holder + expiresAt", async () => {
    const inner = {
      granted: false,
      reason: "operation-busy",
      holder: "host:2:run2",
      expiresAt: "2026-07-24T13:05:00.000Z",
    };
    const outcome = await client(okFetch(inner)).acquire("host:1:run1", 15, "nonce-1", "gen-0");
    if (outcome.granted) throw new Error("expected refusal");
    expect(outcome.reason).toBe("operation-busy");
  });

  test("granted:false, reason:'operation-orphaned' → typed refusal carrying opAttemptId + opStartedAt", async () => {
    const inner = {
      granted: false,
      reason: "operation-orphaned",
      opAttemptId: "dead-attempt",
      opStartedAt: "2026-07-24T11:00:00.000Z",
    };
    const outcome = await client(okFetch(inner)).acquire("host:1:run1", 15, "nonce-1", "gen-0");
    if (outcome.granted) throw new Error("expected refusal");
    expect(outcome.reason).toBe("operation-orphaned");
    expect(outcome.opAttemptId).toBe("dead-attempt");
    expect(outcome.opStartedAt).toBe("2026-07-24T11:00:00.000Z");
  });

  test("granted:false, reason:'generation-changed' surfaced with no holder/opAttemptId keys", async () => {
    const inner = { granted: false, reason: "generation-changed" };
    const outcome = await client(okFetch(inner)).acquire("host:1:run1", 15, "nonce-1", "stale-gen");
    if (outcome.granted) throw new Error("expected refusal");
    expect(outcome.reason).toBe("generation-changed");
    expect(outcome.holder).toBeUndefined();
    expect(outcome.opAttemptId).toBeUndefined();
  });

  test("ttlSeconds above the 15s bound is a caller-contract violation, never dispatched", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ granted: false }) }));
    }) as typeof fetch;
    expect(MAX_TTL_SECONDS).toBe(15);
    await expect(
      client(fetchFn).acquire("host:1:run1", MAX_TTL_SECONDS + 1, "nonce-1", "gen-0"),
    ).rejects.toThrow(/ttlSeconds/);
    expect(called).toBe(false);
  });
});

describe("LeaseClient.renew", () => {
  test("renewed:true carries expiresAt", async () => {
    const inner = { renewed: true, expiresAt: "2026-07-24T14:00:00.000Z" };
    const outcome = await client(okFetch(inner)).renew(LEASE, 15);
    expect(outcome).toEqual({ renewed: true, expiresAt: "2026-07-24T14:00:00.000Z" });
  });

  test("renewed:false carries no expiresAt", async () => {
    const inner = { renewed: false };
    const outcome = await client(okFetch(inner)).renew(LEASE, 15);
    expect(outcome).toEqual({ renewed: false });
  });
});

describe("LeaseClient.release", () => {
  test("released:true", async () => {
    const outcome = await client(okFetch({ released: true })).release(LEASE);
    expect(outcome).toEqual({ released: true });
  });

  test("released:false, reason:'op-in-flight'", async () => {
    const outcome = await client(okFetch({ released: false, reason: "op-in-flight" })).release(
      LEASE,
    );
    expect(outcome).toEqual({ released: false, reason: "op-in-flight" });
  });

  // t4 (5C-B2): TryRelease's only `Released := false` path (a non-idle "Op Kind") always sets
  // Reason := 'op-in-flight' before that exit — every other path sets Released := true. So a
  // released:false with no reason is a protocol violation, not a legitimate empty refusal.
  test("released:false missing reason → LeaseUnavailableError, not an empty-vs-empty match", async () => {
    const inner = { released: false }; // reason missing
    await expect(client(okFetch(inner)).release(LEASE)).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });
});

describe("LeaseClient.beginPublish / endPublish", () => {
  test("beginPublish begun:true, no alreadyCompleted key", async () => {
    const outcome = await client(okFetch({ begun: true })).beginPublish(LEASE, "attempt-1", 6);
    expect(outcome).toEqual({ begun: true });
  });

  test("beginPublish idempotent repeat: begun:true, alreadyCompleted absent (still-active replay)", async () => {
    const outcome = await client(okFetch({ begun: true })).beginPublish(LEASE, "attempt-1", 6);
    expect(outcome.begun).toBe(true);
    expect(outcome.alreadyCompleted).toBeUndefined();
  });

  test("beginPublish on a tombstoned opSeq: begun:false, alreadyCompleted:true", async () => {
    const outcome = await client(okFetch({ begun: false, alreadyCompleted: true })).beginPublish(
      LEASE,
      "attempt-1",
      6,
    );
    expect(outcome).toEqual({ begun: false, alreadyCompleted: true });
  });

  test("endPublish ended:true, no alreadyCompleted key", async () => {
    const outcome = await client(okFetch({ ended: true })).endPublish(LEASE, "attempt-1", 6, "ok");
    expect(outcome).toEqual({ ended: true });
  });

  test("endPublish idempotent repeat: ended:true, alreadyCompleted:true", async () => {
    const outcome = await client(okFetch({ ended: true, alreadyCompleted: true })).endPublish(
      LEASE,
      "attempt-1",
      6,
      "ok",
    );
    expect(outcome).toEqual({ ended: true, alreadyCompleted: true });
  });
});

describe("LeaseClient.getOperationStatus", () => {
  test("parses the full status shape", async () => {
    const inner = {
      opKind: "run",
      opAttemptId: "attempt-1",
      opSeq: 6,
      lastCompletedOpSeq: 5,
      completed: false,
    };
    const outcome = await client(okFetch(inner)).getOperationStatus(LEASE, "attempt-1", 6);
    expect(outcome).toEqual(inner);
  });

  test("attemptId may be empty (generic status read, per design §4)", async () => {
    const inner = {
      opKind: "none",
      opAttemptId: "",
      opSeq: 0,
      lastCompletedOpSeq: 5,
      completed: true,
    };
    const outcome = await client(okFetch(inner)).getOperationStatus(LEASE, "", 0);
    expect(outcome.completed).toBe(true);
  });
});

describe("LeaseClient.recoverOp", () => {
  test("refuses without terminalProof: true, never dispatches", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ recovered: true }) }));
    }) as typeof fetch;
    // A caller that has only a plain `boolean` (not the literal `true`) cannot satisfy the
    // parameter type at compile time either — this proves the runtime guard for anyone who
    // bypasses that (JS caller, `as true` cast, stale compiled output).
    const notProven = false as unknown as true;
    await expect(client(fetchFn).recoverOp(LEASE, "attempt-1", 6, notProven)).rejects.toThrow(
      /terminalProof/,
    );
    expect(called).toBe(false);
  });

  test("with terminalProof: true, dispatches and parses recovered:true", async () => {
    const outcome = await client(okFetch({ recovered: true })).recoverOp(
      LEASE,
      "attempt-1",
      6,
      true,
    );
    expect(outcome).toEqual({ recovered: true });
  });

  test("with terminalProof: true, alreadyCompleted:true is surfaced (tombstoned attempt)", async () => {
    const outcome = await client(okFetch({ recovered: false, alreadyCompleted: true })).recoverOp(
      LEASE,
      "attempt-1",
      6,
      true,
    );
    expect(outcome).toEqual({ recovered: false, alreadyCompleted: true });
  });
});

describe("LeaseClient.forceResetLease (5C-B2: lethal force-reset-lease)", () => {
  test("reset:true → parsed outcome with serverGeneration + epoch", async () => {
    const inner = { reset: true, serverGeneration: "c".repeat(32), epoch: 5 };
    const outcome = await client(okFetch(inner)).forceResetLease("a".repeat(32));
    expect(outcome).toEqual({ reset: true, serverGeneration: "c".repeat(32), epoch: 5 });
  });

  test("reset:false, reason:'generation-changed' → typed refusal, never thrown", async () => {
    const inner = { reset: false, reason: "generation-changed" };
    const outcome = await client(okFetch(inner)).forceResetLease("stale-gen");
    expect(outcome).toEqual({ reset: false, reason: "generation-changed" });
  });

  test("POSTs LethALControl_ForceResetLease with only expectedGeneration in the body", async () => {
    const { fetchFn, seen } = captureFetch({
      reset: true,
      serverGeneration: "d".repeat(32),
      epoch: 1,
    });
    await client(fetchFn).forceResetLease("a".repeat(32));
    expect(seen()?.url).toContain("/ODataV4/LethALControl_ForceResetLease");
    expect(seen()?.body).toEqual({ expectedGeneration: "a".repeat(32) });
  });

  // ControlState.Codeunit.al's TryForceResetLease Error()s on a blank ExpectedGeneration (a
  // non-2xx OData error) rather than returning a typed {reset:false} refusal — so this must be
  // caught client-side, before dispatch, mirroring assertAttemptId/assertTtlBound's existing
  // caller-contract-violation pattern in this same file.
  test("blank expectedGeneration is refused before dispatch", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ reset: false }) }));
    }) as typeof fetch;
    await expect(client(fetchFn).forceResetLease("")).rejects.toThrow(/expectedGeneration/);
    expect(called).toBe(false);
  });

  test("reset:true missing serverGeneration → LeaseUnavailableError, not a fake reset", async () => {
    const inner = { reset: true, epoch: 5 }; // serverGeneration missing
    await expect(client(okFetch(inner)).forceResetLease("a".repeat(32))).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  test("reset:false missing reason → LeaseUnavailableError, not an empty-vs-empty match", async () => {
    const inner = { reset: false };
    await expect(client(okFetch(inner)).forceResetLease("a".repeat(32))).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });
});

describe("LeaseClient — request shape (camelCase keys, generation on EVERY call)", () => {
  test("acquire POSTs LethALControl_AcquireLease with exact camelCase body", async () => {
    const { fetchFn, seen } = captureFetch({ granted: false, reason: "held" });
    await client(fetchFn).acquire("host:1:run1", 15, "nonce-1", "gen-0");
    expect(seen()?.url).toContain("/ODataV4/LethALControl_AcquireLease");
    expect(seen()?.url).toContain("tenant=default");
    expect(seen()?.body).toEqual({
      owner: "host:1:run1",
      ttlSeconds: 15,
      clientNonce: "nonce-1",
      expectedGeneration: "gen-0",
    });
  });

  test("renew POSTs generation (not serverGeneration) alongside epoch/token/ttlSeconds", async () => {
    const { fetchFn, seen } = captureFetch({ renewed: true, expiresAt: "x" });
    await client(fetchFn).renew(LEASE, 15);
    expect(seen()?.url).toContain("/ODataV4/LethALControl_RenewLease");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
      ttlSeconds: 15,
    });
  });

  test("release POSTs epoch/token/generation only", async () => {
    const { fetchFn, seen } = captureFetch({ released: true });
    await client(fetchFn).release(LEASE);
    expect(seen()?.url).toContain("/ODataV4/LethALControl_ReleaseLease");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
    });
  });

  test("beginPublish POSTs epoch/token/generation/attemptId/opSeq", async () => {
    const { fetchFn, seen } = captureFetch({ begun: true });
    await client(fetchFn).beginPublish(LEASE, "attempt-9", 6);
    expect(seen()?.url).toContain("/ODataV4/LethALControl_BeginPublish");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
      attemptId: "attempt-9",
      opSeq: 6,
    });
  });

  test("endPublish POSTs epoch/token/generation/attemptId/opSeq/outcome", async () => {
    const { fetchFn, seen } = captureFetch({ ended: true });
    await client(fetchFn).endPublish(LEASE, "attempt-9", 6, "publish-ok");
    expect(seen()?.url).toContain("/ODataV4/LethALControl_EndPublish");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
      attemptId: "attempt-9",
      opSeq: 6,
      outcome: "publish-ok",
    });
  });

  test("getOperationStatus POSTs epoch/token/generation/attemptId/opSeq", async () => {
    const { fetchFn, seen } = captureFetch({
      opKind: "none",
      opAttemptId: "",
      opSeq: 0,
      lastCompletedOpSeq: 5,
      completed: true,
    });
    await client(fetchFn).getOperationStatus(LEASE, "attempt-9", 6);
    expect(seen()?.url).toContain("/ODataV4/LethALControl_GetOperationStatus");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
      attemptId: "attempt-9",
      opSeq: 6,
    });
  });

  test("recoverOp POSTs epoch/token/generation/attemptId/opSeq (terminalProof is not on the wire)", async () => {
    const { fetchFn, seen } = captureFetch({ recovered: true });
    await client(fetchFn).recoverOp(LEASE, "attempt-9", 6, true);
    expect(seen()?.url).toContain("/ODataV4/LethALControl_RecoverOp");
    expect(seen()?.body).toEqual({
      epoch: LEASE.epoch,
      token: LEASE.token,
      generation: LEASE.serverGeneration,
      attemptId: "attempt-9",
      opSeq: 6,
    });
  });
});

describe("LeaseClient — LeaseUnavailableError (transport-level failure, distinct from a well-formed refusal)", () => {
  test("non-2xx → LeaseUnavailableError", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(client(five00).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  test("network error → LeaseUnavailableError", async () => {
    const throwing = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(client(throwing).release(LEASE)).rejects.toBeInstanceOf(LeaseUnavailableError);
  });

  test("2xx malformed body (no string value) → LeaseUnavailableError, never a plausible refusal", async () => {
    const malformed = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as typeof fetch;
    await expect(client(malformed).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  test("granted response missing a required field (epoch) → LeaseUnavailableError, not a fake grant", async () => {
    const inner = {
      granted: true,
      // epoch missing
      token: "tok",
      serverGeneration: "g",
      lastCompletedOpSeq: 1,
      expiresAt: "x",
    };
    await expect(client(okFetch(inner)).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  test("refusal missing the required reason key → LeaseUnavailableError, not an empty-vs-empty match", async () => {
    const inner = { granted: false };
    await expect(client(okFetch(inner)).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  // t1 (5C-B2): postLeaseAction double-parses the OData scalar `value` — outer envelope JSON,
  // then the codeunit's own JSON string inside it. The outer failure paths were already covered
  // above; these two exercise the INNER parse, previously untested.
  test("outer value is a string but not itself JSON (inner JSON.parse throws) → LeaseUnavailableError", async () => {
    const notJson = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: "not-json{" }), { status: 200 })) as typeof fetch;
    await expect(client(notJson).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });

  test("inner value parses to a non-object JSON value (an array) → LeaseUnavailableError, never a fake refusal", async () => {
    const arrayInner = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: JSON.stringify([1, 2, 3]) }), {
        status: 200,
      })) as typeof fetch;
    await expect(client(arrayInner).acquire("o", 15, "n", "g")).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );
  });
});

describe("LeaseClient — caller-contract bounds", () => {
  test("attemptId over MAX_ATTEMPT_ID_LENGTH is refused before dispatch (server Text[64] would truncate)", async () => {
    expect(MAX_ATTEMPT_ID_LENGTH).toBe(64);
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ begun: true }) }));
    }) as typeof fetch;
    const tooLong = "a".repeat(MAX_ATTEMPT_ID_LENGTH + 1);
    await expect(client(fetchFn).beginPublish(LEASE, tooLong, 6)).rejects.toThrow(/attemptId/);
    // t3 (5C-B2): a caller-contract violation is instanceof-distinguishable from any other bug.
    await expect(client(fetchFn).beginPublish(LEASE, tooLong, 6)).rejects.toBeInstanceOf(
      LeaseCallerContractError,
    );
    expect(called).toBe(false);
  });

  test("a GUID-length attemptId (36 chars) is accepted", async () => {
    const guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(guid.length).toBeLessThanOrEqual(MAX_ATTEMPT_ID_LENGTH);
    const outcome = await client(okFetch({ begun: true })).beginPublish(LEASE, guid, 6);
    expect(outcome.begun).toBe(true);
  });

  test("renew above the ttlSeconds bound is refused before dispatch", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ renewed: true }) }));
    }) as typeof fetch;
    await expect(client(fetchFn).renew(LEASE, MAX_TTL_SECONDS + 1)).rejects.toThrow(/ttlSeconds/);
    await expect(client(fetchFn).renew(LEASE, MAX_TTL_SECONDS + 1)).rejects.toBeInstanceOf(
      LeaseCallerContractError,
    );
    expect(called).toBe(false);
  });

  // The bound has a FLOOR too: a non-positive ttl grants a lease that is already expired, and
  // design §6's ttl/3 heartbeat then collapses to orchestrator.ts's `Math.max(1, …)` — a 1ms renew
  // loop against a lease that can never be held. A caller-contract violation, so it throws.
  test.each([0, -1, -15])(
    "ttlSeconds %p is refused before dispatch (non-positive)",
    async (ttl) => {
      let called = false;
      const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response(JSON.stringify({ value: JSON.stringify({ renewed: true }) }));
      }) as typeof fetch;
      await expect(client(fetchFn).renew(LEASE, ttl)).rejects.toThrow(
        new RegExp(`ttlSeconds must be greater than 0[\\s\\S]*Got ${ttl}$`),
      );
      await expect(client(fetchFn).renew(LEASE, ttl)).rejects.toBeInstanceOf(
        LeaseCallerContractError,
      );
      await expect(client(fetchFn).acquire("o", ttl, "n", "g")).rejects.toThrow(/greater than 0/);
      expect(called).toBe(false);
    },
  );

  test("the smallest positive ttlSeconds is still accepted", async () => {
    const outcome = await client(
      okFetch({ renewed: true, expiresAt: "2026-07-24T12:00:01Z" }),
    ).renew(LEASE, 1);
    expect(outcome.renewed).toBe(true);
  });
});

// t3 (5C-B2): assertAttemptId/assertTtlBound's caller-contract violations are covered with
// LeaseCallerContractError assertions above (in their own describe blocks, alongside the
// message-regex tests they extend). These two are the remaining caller-contract guards in this
// file — recoverOp's terminalProof literal and forceResetLease's blank-echo guard — which had no
// dedicated coverage at all before t3, let alone an instanceof one.
describe("LeaseClient — caller-contract violations are instanceof-distinguishable (t3, 5C-B2)", () => {
  test("recoverOp without terminalProof: true throws LeaseCallerContractError, never dispatches", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ recovered: true }) }));
    }) as typeof fetch;
    const notProven = false as unknown as true;
    await expect(client(fetchFn).recoverOp(LEASE, "attempt-1", 6, notProven)).rejects.toThrow(
      /terminalProof/,
    );
    await expect(
      client(fetchFn).recoverOp(LEASE, "attempt-1", 6, notProven),
    ).rejects.toBeInstanceOf(LeaseCallerContractError);
    expect(called).toBe(false);
  });

  test("forceResetLease with a blank expectedGeneration throws LeaseCallerContractError, never dispatches", async () => {
    let called = false;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify({ reset: false }) }));
    }) as typeof fetch;
    await expect(client(fetchFn).forceResetLease("")).rejects.toThrow(/expectedGeneration/);
    await expect(client(fetchFn).forceResetLease("")).rejects.toBeInstanceOf(
      LeaseCallerContractError,
    );
    expect(called).toBe(false);
  });

  // Transport/shape failures must NOT be conflated with caller-contract violations — the whole
  // point of the two typed classes is that a caller can tell them apart.
  test("a genuine transport failure (LeaseUnavailableError) is NOT a LeaseCallerContractError", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(client(five00).acquire("o", 15, "n", "g")).rejects.not.toBeInstanceOf(
      LeaseCallerContractError,
    );
  });
});

// R504: the lease client's timeout spans the headers AND the body. A missing bound goes red by
// the test timing out (bun's 5 s), never by a wall-clock assert.
describe("R504: every lease action is bounded through its response body", () => {
  const FAST: ActivationConfig = { ...CFG, timeoutMs: 20 };

  /** One row per `LeaseClient` action: its wire name, the call, a normal answer, and its check. */
  const ACTIONS: ReadonlyArray<
    readonly [
      string,
      (c: LeaseClient) => Promise<unknown>,
      Record<string, unknown>,
      (out: unknown) => void,
    ]
  > = [
    [
      "AcquireLease",
      (c) => c.acquire("host:1:run1", 15, "nonce-1", "gen-0"),
      { granted: false, reason: "held" },
      (o) => expect(o).toEqual({ granted: false, reason: "held" }),
    ],
    [
      "RenewLease",
      (c) => c.renew(LEASE, 15),
      { renewed: true, expiresAt: "x" },
      (o) => expect(o).toEqual({ renewed: true, expiresAt: "x" }),
    ],
    [
      "ReleaseLease",
      (c) => c.release(LEASE),
      { released: true },
      (o) => expect(o).toEqual({ released: true }),
    ],
    [
      "BeginPublish",
      (c) => c.beginPublish(LEASE, "a1", 6),
      { begun: true },
      (o) => expect(o).toEqual({ begun: true }),
    ],
    [
      "EndPublish",
      (c) => c.endPublish(LEASE, "a1", 6, "succeeded"),
      { ended: true },
      (o) => expect(o).toEqual({ ended: true }),
    ],
    [
      "GetOperationStatus",
      (c) => c.getOperationStatus(LEASE, "", 0),
      { opKind: "none", opAttemptId: "", opSeq: 5, lastCompletedOpSeq: 5, completed: true },
      (o) => expect(o).toMatchObject({ opKind: "none", lastCompletedOpSeq: 5, completed: true }),
    ],
    [
      "RecoverOp",
      (c) => c.recoverOp(LEASE, "a1", 6, true),
      { recovered: true },
      (o) => expect(o).toEqual({ recovered: true }),
    ],
    [
      "ForceResetLease",
      (c) => c.forceResetLease("0".repeat(32)),
      { reset: false, reason: "generation-changed" },
      (o) => expect(o).toEqual({ reset: false, reason: "generation-changed" }),
    ],
  ];

  async function rejection(p: Promise<unknown>): Promise<LeaseUnavailableError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof LeaseUnavailableError)) {
      throw new Error(`expected a LeaseUnavailableError, got ${String(err)}`);
    }
    return err;
  }

  // L1. Which of the abort and the race ends the call first is a timer race, so either label is
  // accepted; what is pinned is that the STREAM saw the abort, i.e. the timer stayed armed.
  test.each(ACTIONS)("L1 %s: a stalled body is aborted and rejects", async (action, call) => {
    const { fetchFn, aborted, abortSeen } = stalledBody();
    const err = await rejection(call(new LeaseClient(FAST, fetchFn)));
    expect(err.message).toContain(`LethALControl_${action}`);
    expect(err.message).toMatch(/body not read within 20 ms|gave no answer within 20 ms/);
    expect(err.beginPublishRefusal).toBeUndefined();
    // Not a timing assert: a bounded wait for an event the fix guarantees and the bug never sends.
    await Promise.race([abortSeen, Bun.sleep(1000)]);
    expect(aborted()).toBe(true);
  });

  test.each(ACTIONS)(
    "L2 %s: a body that ignores the abort is ended by the race",
    async (action, call) => {
      const err = await rejection(call(new LeaseClient(FAST, deafBody())));
      expect(err.message).toBe(`LethALControl_${action} gave no answer within 20 ms`);
    },
  );

  test.each(ACTIONS)(
    "L3 %s: a fetch that never resolves is ended by the race",
    async (action, call) => {
      const err = await rejection(call(new LeaseClient(FAST, deafFetch())));
      expect(err.message).toBe(`LethALControl_${action} gave no answer within 20 ms`);
    },
  );

  // L4, over-strict control: a slow but complete body is NOT cut.
  test.each(ACTIONS)(
    "L4 %s: a body that arrives in two chunks resolves normally",
    async (_action, call, inner, check) => {
      const text = JSON.stringify({ value: JSON.stringify(inner) });
      const half = Math.floor(text.length / 2);
      // Errors on the fetch's abort, as Bun's body does, so a cut at the headers would show.
      const fetchFn = (async (_url: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new Error("The operation was aborted.")),
              );
              controller.enqueue(new TextEncoder().encode(text.slice(0, half)));
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(text.slice(half)));
                controller.close();
              }, 5);
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      check(await call(new LeaseClient({ ...CFG, timeoutMs: 500 }, fetchFn)));
    },
  );

  test("L5: a 2xx body that is not JSON says so, with the parse error's text", async () => {
    const notJson = (async () =>
      new Response("<html>oops", { status: 200 })) as unknown as typeof fetch;
    const err = await rejection(new LeaseClient(FAST, notJson).release(LEASE));
    const prefix = "LethALControl_ReleaseLease 2xx body could not be read or parsed: ";
    expect(err.message).toStartWith(prefix);
    expect(err.message.length).toBeGreaterThan(prefix.length);
    expect(err.message).not.toContain("not read within");
  });

  // R507 R1 (replaces R504's L6): R-496's refusal leaves the lease client as ITSELF, naming the
  // request, with the original text kept.
  test.each(ACTIONS)(
    "R1 %s: an UnfilteredExtensionsQueryError from the fetch rejects as itself, naming the request",
    async (action, call) => {
      const refusal = new UnfilteredExtensionsQueryError(
        "refused: unfiltered extensions query R433",
      );
      const refusing = (async () => {
        throw refusal;
      }) as unknown as typeof fetch;
      const err = await call(new LeaseClient(FAST, refusing)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(err).not.toBeInstanceOf(LeaseUnavailableError);
      const message = (err as Error).message;
      expect(message).toStartWith(
        `LethALControl_${action} answered with a redirect that was not followed:`,
      );
      expect(message).toContain("refused: unfiltered extensions query R433");
    },
  );

  // R507 R2: any other refused redirect stays a LeaseUnavailableError, but is never "unreachable"
  // and never carries `rejectedStatus` (it may have been applied).
  test("R2: a BcRedirectRefusedError is a LeaseUnavailableError that names the redirect, not 'unreachable'", async () => {
    const refusing = (async () => {
      throw new BcRedirectRefusedError("BC answered with HTTP 302 redirect to elsewhere");
    }) as unknown as typeof fetch;
    const err = await rejection(new LeaseClient(FAST, refusing).release(LEASE));
    expect(err.message).toContain(
      "LethALControl_ReleaseLease answered with a redirect that was not followed",
    );
    expect(err.message).not.toContain("unreachable");
    expect(err.rejectedStatus).toBeUndefined();
  });

  test("an HTTP error status sets rejectedStatus; a connect error does not", async () => {
    const five00 = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect((await rejection(new LeaseClient(FAST, five00).release(LEASE))).rejectedStatus).toBe(
      500,
    );
    const refused = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      (await rejection(new LeaseClient(FAST, refused).release(LEASE))).rejectedStatus,
    ).toBeUndefined();
  });

  // L7: a body read that errors for a reason other than our abort keeps its own text and gets the
  // 'could not be read or parsed' wording, never a timeout wording. It pins `readJsonBody`'s
  // non-abort branch, not the deadline.
  test("L7: a body read that errors at once is not given the timeout wording", async () => {
    const erroring = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("boom"));
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const err = await rejection(new LeaseClient(FAST, erroring).renew(LEASE, 15));
    expect(err.message).toContain("boom");
    expect(err.message).toContain("could not be read or parsed");
    expect(err.message).not.toContain("gave no answer within");
    expect(err.message).not.toContain("not read within");
  });
});
