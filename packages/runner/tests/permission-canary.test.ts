import { describe, expect, test } from "bun:test";
import type { ActivationConfig, FetchFn } from "../src/activation";
import {
  PermissionCanaryClient,
  type PermissionCanaryProbe,
  type PermissionCanaryResult,
  PermissionCanaryUnavailableError,
  permissionCanaryWarnings,
  runPermissionCanary,
} from "../src/permission-canary";

// ————————————————————————————————————————————————————————————————————————
// ROADMAP R26: the permission canary. The two things these tests are actually protecting are:
//
//  1. the mocked-vs-not verdict mapping — a `"mocked"` response must never read as `"not-mocked"`
//     or vice versa, since the whole point is that the two worlds legitimately score differently;
//  2. the inconclusive path — every way the measurement can fail to happen (missing action on an
//     older control app, transport failure, unparseable/incomplete response) must stay DISTINCT
//     from `"not-mocked"` and must never throw. Collapsing "we could not tell" into "everything is
//     fine" is this project's signature bug.
// ————————————————————————————————————————————————————————————————————————

/** Answers with one canned parsed-JSON object, or throws. */
function fakeProbe(answer: Record<string, unknown> | Error): PermissionCanaryProbe {
  return {
    probe: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const MOCKED_WIRE = {
  verdict: "mocked",
  observed: true,
  readPermission: false,
  writePermission: false,
  insertSucceeded: false,
  detail: "Sorry, the current permissions prevented the action.",
};

const NOT_MOCKED_WIRE = {
  verdict: "not-mocked",
  observed: true,
  readPermission: true,
  writePermission: true,
  insertSucceeded: true,
};

describe("runPermissionCanary — verdict mapping", () => {
  test('a complete "mocked" observation maps to mocked, carrying the refused-insert text', async () => {
    const r = await runPermissionCanary(fakeProbe(MOCKED_WIRE));
    expect(r.verdict).toBe("mocked");
    expect(r.readPermission).toBe(false);
    expect(r.writePermission).toBe(false);
    expect(r.insertSucceeded).toBe(false);
    expect(r.detail).toContain("permissions prevented the action");
  });

  test('a complete "not-mocked" observation maps to not-mocked', async () => {
    const r = await runPermissionCanary(fakeProbe(NOT_MOCKED_WIRE));
    expect(r.verdict).toBe("not-mocked");
    expect(r.readPermission).toBe(true);
    expect(r.writePermission).toBe(true);
    expect(r.insertSucceeded).toBe(true);
    // No detail invented where the server sent none.
    expect(r.detail).toBeUndefined();
  });

  test("the two worlds never collapse into each other", async () => {
    const mocked = await runPermissionCanary(fakeProbe(MOCKED_WIRE));
    const notMocked = await runPermissionCanary(fakeProbe(NOT_MOCKED_WIRE));
    expect(mocked.verdict).not.toBe(notMocked.verdict);
    expect(mocked.verdict).toBe("mocked");
    expect(notMocked.verdict).toBe("not-mocked");
  });

  test("the server's own inconclusive is passed through with its detail, never upgraded", async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        verdict: "inconclusive",
        observed: false,
        detail: "the canary test recorded no observation; the fenced test run returned: {}",
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("recorded no observation");
    // No observation is claimed for a run that did not take one.
    expect(r.readPermission).toBeUndefined();
    expect(r.writePermission).toBeUndefined();
    expect(r.insertSucceeded).toBeUndefined();
  });

  test("a server inconclusive with no detail still gets a reason (never a bare, unactionable verdict)", async () => {
    const r = await runPermissionCanary(fakeProbe({ verdict: "inconclusive", observed: false }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toBeDefined();
    expect(r.detail).toContain("no detail");
  });
});

describe("runPermissionCanary — inconclusive is never 'not mocked', and never throws", () => {
  test("a transport failure (older control app: HTTP 404) is inconclusive with the reason attached", async () => {
    const r = await runPermissionCanary(
      fakeProbe(
        new PermissionCanaryUnavailableError(
          "LethALControl_PermissionCanary failed: HTTP 404 — the published LethAL Control app has no PermissionCanary action",
        ),
      ),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("HTTP 404");
    expect(r.detail).toContain("could not run");
  });

  test("a non-Error throw is still inconclusive, not a crash", async () => {
    const probe: PermissionCanaryProbe = {
      probe: async () => {
        throw "socket exploded";
      },
    };
    const r = await runPermissionCanary(probe);
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("socket exploded");
  });

  test("an unrecognized verdict string is inconclusive, carrying the payload", async () => {
    const r = await runPermissionCanary(fakeProbe({ verdict: "probably-fine", observed: true }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("probably-fine");
  });

  test("a missing verdict key is inconclusive", async () => {
    const r = await runPermissionCanary(fakeProbe({ observed: true }));
    expect(r.verdict).toBe("inconclusive");
  });

  // The specific shape this project's signature bug would take here: a response that CLAIMS the
  // reassuring answer while reporting nothing measured. Demoting it is what keeps an empty result
  // from reading as a clean one.
  test('a "not-mocked" verdict with observed:false is DEMOTED to inconclusive, never trusted', async () => {
    const r = await runPermissionCanary(fakeProbe({ verdict: "not-mocked", observed: false }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("without a complete observation");
  });

  test('a "mocked" verdict with observed:false is likewise demoted', async () => {
    const r = await runPermissionCanary(fakeProbe({ verdict: "mocked", observed: false }));
    expect(r.verdict).toBe("inconclusive");
  });

  test('a "not-mocked" verdict missing one observation boolean is demoted', async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        verdict: "not-mocked",
        observed: true,
        readPermission: true,
        writePermission: true,
        // insertSucceeded omitted — the decisive fact is exactly the one missing.
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("insertSucceeded");
  });

  test("a wrong-typed observation boolean (string 'true') is demoted, not coerced", async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        verdict: "not-mocked",
        observed: true,
        readPermission: true,
        writePermission: true,
        insertSucceeded: "true",
      }),
    );
    expect(r.verdict).toBe("inconclusive");
  });
});

describe("permissionCanaryWarnings", () => {
  test("mocked says the mutants are silently unscored, and names the probe failure", () => {
    const lines = permissionCanaryWarnings({
      verdict: "mocked",
      readPermission: false,
      writePermission: false,
      insertSucceeded: false,
      detail: "Sorry, the current permissions prevented the action.",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CONFIRMED");
    expect(lines[0]).toContain("R26");
    expect(lines[0]).toContain("UNSCORED");
    expect(lines[0]).toContain("permissions prevented the action");
  });

  test("not-mocked still says something — a silent report cannot distinguish 'clean' from 'nobody looked'", () => {
    const lines = permissionCanaryWarnings({
      verdict: "not-mocked",
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("does NOT strip permissions");
    expect(lines[0]).not.toContain("CONFIRMED");
  });

  test("inconclusive explicitly disclaims being 'not mocked', and prints the reason", () => {
    const lines = permissionCanaryWarnings({
      verdict: "inconclusive",
      detail: "HTTP 404 — no PermissionCanary action",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not determine");
    expect(lines[0]).toContain('NOT the same as "not mocked"');
    expect(lines[0]).toContain("HTTP 404");
  });

  test("inconclusive with no detail still prints a line (never silently empty)", () => {
    const lines = permissionCanaryWarnings({ verdict: "inconclusive" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no detail");
  });

  test("every verdict produces exactly one line — none is silently dropped", () => {
    const verdicts: PermissionCanaryResult[] = [
      { verdict: "mocked" },
      { verdict: "not-mocked" },
      { verdict: "inconclusive" },
    ];
    for (const v of verdicts) expect(permissionCanaryWarnings(v)).toHaveLength(1);
  });
});

// ————————————————————————————————————————————————————————————————————————
// The client half: request shaping and the failure classification that feeds the inconclusive
// path above. A fake `fetch` keeps this entirely off the network.
// ————————————————————————————————————————————————————————————————————————

const CFG: ActivationConfig = {
  baseUrl: "http://cronus281:7048/BC",
  company: "CRONUS",
  username: "admin",
  password: "P@ssw0rd",
  tenant: "default",
};

/** A 200 whose OData scalar `value` is the (stringified) inner result JSON — the same wire shape
 *  `lease.test.ts`'s `okFetch` uses, and the one the live probe confirmed. */
function okFetch(inner: Record<string, unknown>): FetchFn {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 })) as FetchFn;
}

function statusFetch(status: number): FetchFn {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response("nope", { status })) as FetchFn;
}

/** A 200 whose OData envelope is whatever the caller says — for the malformed-body cases. */
function envelopeFetch(envelope: unknown): FetchFn {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify(envelope), { status: 200 })) as FetchFn;
}

describe("PermissionCanaryClient", () => {
  test("POSTs the LethALControl_PermissionCanary action with company/tenant and Basic auth", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth = "";
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method);
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.authorization);
      return new Response(JSON.stringify({ value: JSON.stringify(MOCKED_WIRE) }), { status: 200 });
    }) as FetchFn;
    const json = await new PermissionCanaryClient(CFG, fetchFn).probe();
    expect(json.verdict).toBe("mocked");
    expect(seenUrl).toContain("/ODataV4/LethALControl_PermissionCanary?");
    expect(seenUrl).toContain("company=CRONUS");
    expect(seenUrl).toContain("tenant=default");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe(`Basic ${btoa("admin:P@ssw0rd")}`);
  });

  test("a 404 throws PermissionCanaryUnavailableError naming the older-control-app cause", async () => {
    const client = new PermissionCanaryClient(CFG, statusFetch(404));
    await expect(client.probe()).rejects.toBeInstanceOf(PermissionCanaryUnavailableError);
    await expect(client.probe()).rejects.toThrow(/HTTP 404[\s\S]*predates ROADMAP R26/);
  });

  test("a non-404 non-2xx throws without inventing the republish hint", async () => {
    const client = new PermissionCanaryClient(CFG, statusFetch(500));
    await expect(client.probe()).rejects.toThrow(/HTTP 500/);
    await expect(client.probe()).rejects.not.toThrow(/republish/);
  });

  test("an unreachable server throws PermissionCanaryUnavailableError", async () => {
    const fetchFn = (async (_url: unknown, _init?: RequestInit): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as FetchFn;
    const client = new PermissionCanaryClient(CFG, fetchFn);
    await expect(client.probe()).rejects.toThrow(/unreachable[\s\S]*ECONNREFUSED/);
  });

  test('a 2xx with no string "value" throws rather than returning an empty object', async () => {
    const client = new PermissionCanaryClient(CFG, envelopeFetch({ notValue: 1 }));
    await expect(client.probe()).rejects.toThrow(/no string "value"/);
  });

  test('a "value" that is not JSON throws, quoting what came back', async () => {
    const client = new PermissionCanaryClient(CFG, envelopeFetch({ value: "<html>login</html>" }));
    await expect(client.probe()).rejects.toThrow(/not JSON[\s\S]*<html>login<\/html>/);
  });

  test("client failures reach runPermissionCanary as inconclusive, never as a throw", async () => {
    const r = await runPermissionCanary(new PermissionCanaryClient(CFG, statusFetch(404)));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("HTTP 404");
  });

  test("the happy path end-to-end through the real client maps to a verdict", async () => {
    const r = await runPermissionCanary(new PermissionCanaryClient(CFG, okFetch(NOT_MOCKED_WIRE)));
    expect(r.verdict).toBe("not-mocked");
  });
});
