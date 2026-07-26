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

// Both wires carry the ATTRIBUTION context the server measures outside the fence before the test
// runs: a session that could write the probe normally (`baselineWritePermission: true`) and whether
// codeunit 131006 is installed. Without those, a refused in-fence insert is unattributable — see
// `PermissionCanaryResult`'s doc comment.
const MOCKED_WIRE = {
  verdict: "mocked",
  observed: true,
  baselineReadPermission: true,
  baselineWritePermission: true,
  mockInstalled: true,
  readPermission: false,
  writePermission: false,
  insertSucceeded: false,
  detail: "Sorry, the current permissions prevented the action.",
};

const NOT_MOCKED_WIRE = {
  verdict: "not-mocked",
  observed: true,
  baselineReadPermission: true,
  baselineWritePermission: true,
  mockInstalled: false,
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
    // The attribution context survives onto the result, not just into the server's decision.
    expect(r.baselineWritePermission).toBe(true);
    expect(r.mockInstalled).toBe(true);
  });

  test('a complete "not-mocked" observation maps to not-mocked', async () => {
    const r = await runPermissionCanary(fakeProbe(NOT_MOCKED_WIRE));
    expect(r.verdict).toBe("not-mocked");
    expect(r.readPermission).toBe(true);
    expect(r.writePermission).toBe(true);
    expect(r.insertSucceeded).toBe(true);
    expect(r.baselineReadPermission).toBe(true);
    expect(r.mockInstalled).toBe(false);
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

  // The EXACT wire shape the first live proof produced (Cronus282, control app 1.0.0.3): the
  // canary's `Insert` was wrapped in a [TryFunction], the platform refused the call outright with
  // a contract error that the [TryFunction] did not catch, and the test method aborted before
  // recording anything. Two properties are being pinned here, both of which are what made that
  // defect diagnosable instead of a silent wrong answer: the client reports `inconclusive` rather
  // than the reassuring `not-mocked`, AND it carries the platform's own message through verbatim
  // instead of flattening it into a generic "could not determine".
  test("the live TryFunction-defect response maps to inconclusive with the platform message intact", async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        verdict: "inconclusive",
        observed: false,
        detail:
          "the canary test recorded no observation; the fenced test run returned: " +
          '{"testResults":[{"method":"ProbeInherentPermissions","result":1,"message":' +
          "\"Call to the function 'INSERT' is not allowed inside the call to 'RunTests' " +
          'when it is used as a TryFunction."}]}',
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("not allowed inside the call to 'RunTests'");
    expect(r.readPermission).toBeUndefined();
    expect(r.insertSucceeded).toBeUndefined();
    // The warning line an operator actually reads must not claim the server is clean.
    const line = permissionCanaryWarnings(r)[0] ?? "";
    expect(line).toContain("could not determine");
    expect(line).toContain("not allowed inside the call to 'RunTests'");
    expect(line).not.toContain("does NOT strip permissions");
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
        ...NOT_MOCKED_WIRE,
        insertSucceeded: undefined,
        // insertSucceeded omitted — the decisive fact is exactly the one missing.
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("insertSucceeded");
  });

  // An older control app (1.0.0.4 and earlier) answers without the attribution keys. It cannot
  // substantiate the claim it is making — a refused insert on a session that may never have had
  // write permission at all is not evidence of the mock — so it is demoted, exactly like a 404.
  test("a conclusive verdict with no attribution context at all is demoted (older control app)", async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        verdict: "mocked",
        observed: true,
        readPermission: false,
        writePermission: false,
        insertSucceeded: false,
        detail: "Sorry, the current permissions prevented the action.",
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("baselineWritePermission");
  });

  test("a conclusive verdict missing only mockInstalled is demoted", async () => {
    const r = await runPermissionCanary(fakeProbe({ ...MOCKED_WIRE, mockInstalled: undefined }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("mockInstalled");
  });

  test("a wrong-typed observation boolean (string 'true') is demoted, not coerced", async () => {
    const r = await runPermissionCanary(fakeProbe({ ...NOT_MOCKED_WIRE, insertSucceeded: "true" }));
    expect(r.verdict).toBe("inconclusive");
  });
});

// ————————————————————————————————————————————————————————————————————————
// COHERENCE. A payload can be complete and still not support the verdict it asserts. Before this
// guard existed, the first case below sailed through and printed "…reported read and write
// permission and a real insert succeeded…" while silently dropping a refusal detail that said the
// exact opposite — a reviewer ran it. Every case here must demote to `inconclusive`, and NONE may
// be converted into the other verdict: a payload that contradicts itself is not evidence for
// anything.
// ————————————————————————————————————————————————————————————————————————
describe("runPermissionCanary — a verdict its own payload contradicts", () => {
  test('"not-mocked" with a fully refused observation is DEMOTED, and the refusal is not dropped', async () => {
    const r = await runPermissionCanary(
      fakeProbe({
        ...MOCKED_WIRE,
        verdict: "not-mocked", // …but every value below still says the write was refused.
      }),
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("does not support it");
    expect(r.detail).toContain('"not-mocked" requires read, write and a completed insert');
    // The refusal text the old code discarded is still reachable in the payload echo.
    expect(r.detail).toContain("permissions prevented the action");
    // Demoted, never flipped to the opposite verdict.
    expect(r.verdict).not.toBe("mocked");
    const line = permissionCanaryWarnings(r)[0] ?? "";
    expect(line).toContain("could not determine");
    expect(line).not.toContain("a real insert succeeded");
  });

  test('"not-mocked" with only insertSucceeded false is demoted (partial contradiction still counts)', async () => {
    const r = await runPermissionCanary(fakeProbe({ ...NOT_MOCKED_WIRE, insertSucceeded: false }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("insert=false");
  });

  test('"mocked" claiming insertSucceeded:true is DEMOTED, never flipped to not-mocked', async () => {
    const r = await runPermissionCanary(fakeProbe({ ...MOCKED_WIRE, insertSucceeded: true }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("did NOT complete");
    expect(r.verdict).not.toBe("not-mocked");
  });

  test('"mocked" claiming writePermission:true is demoted', async () => {
    const r = await runPermissionCanary(fakeProbe({ ...MOCKED_WIRE, writePermission: true }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("requires a refused write flag");
  });

  // Important 1's whole point, enforced at the client too: naming codeunit 131006 as the cause
  // while reporting it is not installed is a claim the payload cannot support.
  test('"mocked" with mockInstalled:false is demoted — the named cause is not present', async () => {
    const r = await runPermissionCanary(fakeProbe({ ...MOCKED_WIRE, mockInstalled: false }));
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("131006");
  });

  // The permanently-red hazard: a session with no write permission ANYWHERE cannot attribute an
  // in-fence refusal to the test path. The server already refuses to call that `mocked`; the client
  // refuses to accept it if a server ever did.
  test("a conclusive verdict on a baseline that cannot write at all is demoted, either way", async () => {
    const asMocked = await runPermissionCanary(
      fakeProbe({ ...MOCKED_WIRE, baselineWritePermission: false }),
    );
    expect(asMocked.verdict).toBe("inconclusive");
    expect(asMocked.detail).toContain("out-of-fence baseline");
    const asNotMocked = await runPermissionCanary(
      fakeProbe({ ...NOT_MOCKED_WIRE, baselineWritePermission: false }),
    );
    expect(asNotMocked.verdict).toBe("inconclusive");
    expect(asNotMocked.detail).toContain("out-of-fence baseline");
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

  test("mocked names codeunit 131006 as installed — the attribution the verdict claims", () => {
    const lines = permissionCanaryWarnings({
      verdict: "mocked",
      baselineReadPermission: true,
      baselineWritePermission: true,
      mockInstalled: true,
      readPermission: false,
      writePermission: false,
      insertSucceeded: false,
    });
    expect(lines[0]).toContain("131006");
    expect(lines[0]).toContain("outside the fence");
  });

  test("not-mocked flags a mock that IS installed but is not stripping this path", () => {
    const lines = permissionCanaryWarnings({
      verdict: "not-mocked",
      baselineReadPermission: true,
      baselineWritePermission: true,
      mockInstalled: true,
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    });
    expect(lines[0]).toContain("IS installed here but is not stripping this path");
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
