import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationConfig, FetchFn } from "../src/activation";
import {
  PermissionCanaryClient,
  type PermissionCanaryProbe,
  type PermissionCanaryResult,
  PermissionCanaryUnavailableError,
  describeTestPermissionsRefusal,
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
    expect(line).not.toContain("CAN write its own app's tables");
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
  // The wording tracks the question the canary actually answers (can a codeunit declaring
  // `TestPermissions = Disabled` write here?), not the disproved fenced-path story. A 'mocked'
  // answer is now a PRECONDITION VIOLATION — the platform rule itself having changed — and must
  // not read as the everyday "your test codeunit omits the property" case.
  test("mocked reports a violated precondition, says the mutants are unscored, and names the probe failure", () => {
    const lines = permissionCanaryWarnings({
      verdict: "mocked",
      readPermission: false,
      writePermission: false,
      insertSucceeded: false,
      detail: "Sorry, the current permissions prevented the action.",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PRECONDITION VIOLATED");
    expect(lines[0]).toContain("R26");
    expect(lines[0]).toContain("TestPermissions = Disabled");
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

  // Codeunit 131006 being installed while writes still succeed is exactly what the A/B measurement
  // predicts, so the line must say the mock is NOT the culprit — otherwise the next operator to see
  // a refused write blames an installed app instead of the target codeunit's own declaration.
  test("not-mocked says an installed mock is not the reason any test fails to write", () => {
    const lines = permissionCanaryWarnings({
      verdict: "not-mocked",
      baselineReadPermission: true,
      baselineWritePermission: true,
      mockInstalled: true,
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    });
    expect(lines[0]).toContain("131006");
    expect(lines[0]).toContain("is not the reason any test fails to write");
    expect(lines[0]).toContain("TestPermissions");
  });

  test("not-mocked still says something — a silent report cannot distinguish 'clean' from 'nobody looked'", () => {
    const lines = permissionCanaryWarnings({
      verdict: "not-mocked",
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CAN write its own app's tables");
    expect(lines[0]).not.toContain("PRECONDITION VIOLATED");
  });

  // The weaker claim is the whole point of the R1 correction: a clean canary characterises the
  // SERVER's precondition and nothing about a particular suite, whose own `TestPermissions`
  // decides whether its tests may write. If this line ever promises target-suite scores are
  // unaffected, the canary is over-claiming again.
  test("not-mocked does NOT promise anything about a particular target suite", () => {
    const lines = permissionCanaryWarnings({
      verdict: "not-mocked",
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    });
    const line = lines[0] ?? "";
    expect(line).toContain("says nothing about any particular target suite");
    expect(line).toContain("TestPermissions");
    expect(line).not.toContain("are scored normally here");
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

// ————————————————————————————————————————————————————————————————————————
// describeTestPermissionsRefusal — the half operators actually hit. MEASURED A/B (2026-07-26): a
// test codeunit that omits `TestPermissions` runs Restrictive (the AL default) and is refused when
// it writes; `TestPermissions = Disabled` is not. That refusal is deterministic and one line to
// fix, yet it used to reach the user as `error cause=unstable` with a bare "fails at baseline
// confirmation". These tests pin the three properties that make the diagnosis trustworthy: it
// FIRES on BC's real refusal shape, it NAMES the property, and it stays SILENT on anything else —
// a diagnosis that fires on ordinary assertion failures would be worse than none.
// ————————————————————————————————————————————————————————————————————————

/** The exact text BC produced, verbatim, on the live suite that exposed this. */
const BC_REFUSAL =
  "Sorry, the current permissions prevented the action. " +
  "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";

describe("describeTestPermissionsRefusal", () => {
  test("names TestPermissions = Disabled and quotes BC verbatim, parenthetical included", () => {
    const d = describeTestPermissionsRefusal(BC_REFUSAL);
    expect(d).toBeDefined();
    expect(d).toContain("TestPermissions = Disabled");
    // Quoting rather than replacing: a reader who disagrees with the diagnosis still has the
    // platform's own words, including the part that names the table and the operation.
    expect(d).toContain(BC_REFUSAL);
    expect(d).toContain("TableData 79300 Data Main Insert");
    // It is a diagnosis, not a verdict — it must read as "most likely", never as a finding.
    expect(d).toContain("most likely");
  });

  test("fires on the bare sentence with no parenthetical (older/short BC messages)", () => {
    const d = describeTestPermissionsRefusal(
      "Sorry, the current permissions prevented the action.",
    );
    expect(d).toBeDefined();
    expect(d).toContain("Sorry, the current permissions prevented the action.");
    expect(d).toContain("TestPermissions = Disabled");
  });

  // `failureMessage` is `message` + "\n" + `stackTrace` (see `RunMutantTransport.failureTextOf`),
  // so the quote must stop at the line break — otherwise the diagnosis drags a stack frame into
  // the quoted text and the operator can no longer tell what BC actually said.
  test("quotes only BC's sentence when a stack trace follows", () => {
    const d = describeTestPermissionsRefusal(
      `${BC_REFUSAL}\n"Data Main Tests"(CodeUnit 79300).InsertDoublesAmountWeak line 4`,
    );
    expect(d).toBeDefined();
    expect(d).toContain(BC_REFUSAL);
    expect(d).not.toContain("line 4");
    expect(d).not.toContain("InsertDoublesAmountWeak");
  });

  test("is silent on an ordinary assertion failure — no diagnosis where there is no refusal", () => {
    expect(
      describeTestPermissionsRefusal("Assert.AreEqual failed. Expected: 200 Actual: 100"),
    ).toBeUndefined();
  });

  test("is silent on a permissions-adjacent message that is not the refusal", () => {
    expect(
      describeTestPermissionsRefusal(
        "You do not have the following permissions on TableData 79300: Insert.",
      ),
    ).toBeUndefined();
  });

  // A failing test line need not carry a message at all — that is a legitimate state, not a
  // caller-contract violation, so it answers "no diagnosis" rather than throwing or inventing one.
  test("absent text yields no diagnosis", () => {
    expect(describeTestPermissionsRefusal(undefined)).toBeUndefined();
    expect(describeTestPermissionsRefusal("")).toBeUndefined();
  });

  // The regex is used repeatedly against different messages within one session; a stateful (`/g`)
  // regex would answer correctly and then, on the very next call, silently miss.
  test("is stateless across calls — the same input answers the same way every time", () => {
    const first = describeTestPermissionsRefusal(BC_REFUSAL);
    const second = describeTestPermissionsRefusal(BC_REFUSAL);
    const third = describeTestPermissionsRefusal(BC_REFUSAL);
    expect(second).toBe(first as string);
    expect(third).toBe(first as string);
  });
});

// ————————————————————————————————————————————————————————————————————————
// The AL half, guarded from TypeScript because AL has no unit-test harness in this repo. Two
// declarations in `extensions/lethal-control` are load-bearing in a way a linter, a reviewer, or a
// future tidy-up will read as an oversight, and getting either wrong turns the canary into a
// confident liar rather than a broken one:
//
//   - codeunit 91010 MUST declare `TestPermissions = Disabled`. Without it the codeunit is
//     Restrictive (the AL default) and its write is refused on EVERY server, including ones where a
//     real suite writes fine — the canary would then be measuring its own declaration. That is the
//     defect control app 1.0.0.6 fixed, and it shipped for weeks reporting `mocked` about itself.
//   - table 91008 MUST NOT declare `InherentPermissions`. With it the write could never fail, and
//     the light could never turn red.
//
// COMMENT LINES ARE STRIPPED FIRST, deliberately. Both files' doc comments repeat these exact
// phrases many times (the DO-NOT banners quote them), so a naive substring search over the raw file
// would pass whether or not the declaration is actually there — the "test passes for the wrong
// reason" hazard, in the one place where nothing else would catch it.
// ————————————————————————————————————————————————————————————————————————

const CONTROL_SRC = join(import.meta.dir, "..", "..", "..", "extensions", "lethal-control", "src");

/** The file's CODE lines only — every `//`-prefixed line (incl. `///` doc comments) dropped. */
function codeLinesOf(file: string): string[] {
  return readFileSync(join(CONTROL_SRC, file), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));
}

describe("LethAL Control AL declarations the canary's meaning depends on", () => {
  test("codeunit 91010 declares `TestPermissions = Disabled` in CODE, not just in a comment", () => {
    const code = codeLinesOf("PermissionCanary.Codeunit.al");
    // Sanity: we are reading the right object, and reading it as code.
    expect(code).toContain('codeunit 91010 "LC Permission Canary"');
    expect(code).toContain("Subtype = Test;");
    expect(code).toContain("TestPermissions = Disabled;");
  });

  test("table 91008 declares no InherentPermissions in CODE — the omission is the measurement", () => {
    const code = codeLinesOf("PermissionProbe.Table.al");
    expect(code).toContain('table 91008 "LC Permission Probe"');
    expect(code.filter((l) => l.includes("InherentPermissions"))).toEqual([]);
  });
});
