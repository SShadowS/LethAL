import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import { compareAppVersions } from "../src/app-version";
import {
  CONTROL_APP_ID,
  HarnessAuthError,
  HarnessVerificationError,
  HarnessVerifier,
  MIN_CONTROL_VERSION,
  MultiTenantContainerError,
  injectControlDependency,
  parseLeaseSnapshot,
  resetSingleTenantWarningForTests,
} from "../src/harness";

// R2: the "unenforced" warning is now a once-per-PROCESS latch (module-scope), not once per
// `HarnessVerifier` instance — reset it before every test so tests don't leak state into each
// other depending on execution order.
beforeEach(() => {
  resetSingleTenantWarningForTests();
});

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};

const SERVER_GENERATION = "b".repeat(32);

/**
 * A protocol-v2 `HarnessInfo` payload, shaped exactly like the deployed `LethAL Control`
 * one (`ControlApi.HarnessInfo`): protocolVersion 2, a 32-hex `serverGeneration`, and
 * `tenantCountReachable: false` — AL cannot enumerate tenants from an extension, so the live
 * server never reports a count (design §7).
 *
 * `semver` tracks `MIN_CONTROL_VERSION` rather than a frozen literal (R28): it used to be the
 * hardcoded `"1.0.0.0"` the AL side reported, which the version gate now REJECTS — leaving it
 * there would make every unrelated test in this file throw at the version check and pass its
 * `rejects` assertion for entirely the wrong reason.
 */
function info(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: CONTROL_APP_ID,
    semver: MIN_CONTROL_VERSION,
    protocolVersion: 2,
    serverGeneration: SERVER_GENERATION,
    tenantCountReachable: false,
    isolationModes: ["Codeunit"],
    testTypes: ["codeunit"],
    ...over,
  };
}

function okFetch(inner: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
}

function verifier(fetchFn: typeof fetch): HarnessVerifier {
  return new HarnessVerifier(CFG, fetchFn);
}

/** `verify()` warns (loudly, by design) whenever the tenant gate cannot be enforced — silence
 *  that here so it doesn't drown the suite, and let a test read what was warned. */
async function verifyQuiet(v: HarnessVerifier): Promise<{
  details: Awaited<ReturnType<HarnessVerifier["verify"]>>;
  warnings: string[];
}> {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const details = await v.verify();
    return { details, warnings: warnSpy.mock.calls.map((c) => String(c[0])) };
  } finally {
    warnSpy.mockRestore();
  }
}

describe("HarnessVerifier.verify", () => {
  test("accepts a matching, compatible v2 harness and returns its serverGeneration", async () => {
    const { details } = await verifyQuiet(verifier(okFetch(info())));
    expect(details.protocolVersion).toBe(2);
    expect(details.serverGeneration).toBe(SERVER_GENERATION);
  });

  test("accepts a forward-compatible newer protocol (v3)", async () => {
    const { details } = await verifyQuiet(verifier(okFetch(info({ protocolVersion: 3 }))));
    expect(details.protocolVersion).toBe(3);
  });

  // Layer 5C-B1 (design §7): protocol v2 is incompatible with v1 in BOTH directions. A v1 server
  // (no lease fence at all) must be refused before any publish — the 5C-A "forward-compatible,
  // a v1 server still runs our empty-lease calls" allowance is deliberately gone.
  test("rejects a v1 server outright", async () => {
    await expect(verifier(okFetch(info({ protocolVersion: 1 }))).verify()).rejects.toBeInstanceOf(
      HarnessVerificationError,
    );
  });

  test("sends the required clientProtocol argument (a v1 client's `{}` cannot reach a v2 server)", async () => {
    let seenBody = "";
    const capture = (async (_url: unknown, init?: RequestInit) => {
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ value: JSON.stringify(info()) }), { status: 200 });
    }) as typeof fetch;
    await verifyQuiet(verifier(capture));
    expect(JSON.parse(seenBody)).toEqual({ clientProtocol: 2 });
  });

  test("rejects a v2 payload with no serverGeneration — the lease could not be fenced without it", async () => {
    await expect(verifier(okFetch(info({ serverGeneration: undefined }))).verify()).rejects.toThrow(
      /serverGeneration/,
    );
  });

  test("rejects an EMPTY serverGeneration rather than sending it as expectedGeneration", async () => {
    await expect(verifier(okFetch(info({ serverGeneration: "" }))).verify()).rejects.toThrow(
      /serverGeneration/,
    );
  });

  // design §7's single-tenant gate. The shipped harness reports tenantCountReachable:false, so
  // the gate is UNENFORCED — and must say so out loud rather than emitting a silent pass.
  test("reports the tenant gate as unenforced (and warns) when the count is unreachable", async () => {
    const { details, warnings } = await verifyQuiet(verifier(okFetch(info())));
    expect(details.tenantGate).toBe("unenforced");
    expect(warnings.some((w) => w.includes("NOT ENFORCED"))).toBe(true);
  });

  // R2: a single gate run measured FOUR verify() calls printing the same paragraph — trains a
  // reader to scroll past it. Proven across TWO calls (including from a SECOND, freshly
  // constructed HarnessVerifier — the whole reason the latch is module-scope, not per-instance)
  // rather than just one, so a revert to "warn every call" is the thing that goes red.
  test("warns at most ONCE per process, even across multiple verify() calls and instances (R2)", async () => {
    const first = await verifyQuiet(verifier(okFetch(info())));
    expect(first.warnings.some((w) => w.includes("NOT ENFORCED"))).toBe(true);

    const second = await verifyQuiet(verifier(okFetch(info())));
    expect(second.details.tenantGate).toBe("unenforced"); // still reported correctly
    expect(second.warnings.some((w) => w.includes("NOT ENFORCED"))).toBe(false); // not reprinted
  });

  test("refuses a multi-tenant container when the count IS reachable", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: 2 }))).verify(),
    ).rejects.toBeInstanceOf(MultiTenantContainerError);
  });

  test("reports the tenant gate as enforced for a reachable single-tenant count", async () => {
    const { details, warnings } = await verifyQuiet(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: 1 }))),
    );
    expect(details.tenantGate).toBe("enforced");
    expect(warnings).toHaveLength(0);
  });

  test("refuses to gate a publish on an unreadable count that claims to be reachable", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: "lots" }))).verify(),
    ).rejects.toThrow(/tenantCount/);
  });

  test("rejects a payload with no tenantCountReachable at all", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: undefined }))).verify(),
    ).rejects.toThrow(/tenantCountReachable/);
  });

  test("rejects a wrong control app id", async () => {
    await expect(
      verifier(okFetch(info({ appId: "00000000-0000-0000-0000-000000000000" }))).verify(),
    ).rejects.toBeInstanceOf(HarnessVerificationError);
  });

  test("rejects an older/unknown protocol version", async () => {
    await expect(verifier(okFetch(info({ protocolVersion: 0 }))).verify()).rejects.toBeInstanceOf(
      HarnessVerificationError,
    );
  });

  test("rejects a harness missing Codeunit isolation", async () => {
    await expect(
      verifier(okFetch(info({ isolationModes: ["Function"] }))).verify(),
    ).rejects.toThrow(/isolationModes/);
  });

  test("rejects a harness missing the codeunit test type", async () => {
    await expect(verifier(okFetch(info({ testTypes: [] }))).verify()).rejects.toThrow(/testTypes/);
  });

  test("rejects an unreachable harness (pre-dispatch throw)", async () => {
    const throwing = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(verifier(throwing).verify()).rejects.toThrow(/unreachable/);
  });

  test("rejects a non-2xx harness response", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(verifier(five00).verify()).rejects.toThrow(/HTTP 500/);
  });

  // R25: hit live 2026-07-26 — a stale locally-built lethal-control.app (extensions/lethal-control
  // /lethal-control.app is gitignored, so it's a local build every machine makes for itself)
  // publishes and answers fine, then fails HarnessInfo with BC's own "clientProtocol is not a
  // valid parameter" 400. That reads like a protocol bug; the real cause is the stale build.
  test("names a stale local control-app build as the real cause of BC's clientProtocol 400 (R25)", async () => {
    const staleAppFetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response(
        "The parameter 'clientProtocol' in the request payload is not a valid parameter for " +
          "the operation 'LethALControl_HarnessInfo'",
        { status: 400 },
      )) as typeof fetch;
    let err: unknown;
    try {
      await verifier(staleAppFetch).verify();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessVerificationError);
    const message = err instanceof Error ? err.message : String(err);
    // Names the real cause and the fix...
    expect(message).toMatch(/stale/i);
    expect(message).toMatch(/rebuild extensions\/lethal-control and republish/);
    // ...without discarding BC's own original text as evidence.
    expect(message).toContain("clientProtocol");
    expect(message).toContain("not a valid parameter");
  });

  test("does NOT misdiagnose an unrelated 400 as a stale control app (R25)", async () => {
    const unrelated400 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("The parameter 'company' is required", { status: 400 })) as typeof fetch;
    let err: unknown;
    try {
      await verifier(unrelated400).verify();
    } catch (e) {
      err = e;
    }
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toMatch(/stale/i);
    expect(message).toContain("company");
  });

  test("accepts a control app NEWER than the client's minimum", async () => {
    const { details } = await verifyQuiet(verifier(okFetch(info({ semver: "9.9.9.9" }))));
    expect(details.protocolVersion).toBe(2);
  });

  test("POSTs LethALControl_HarnessInfo with company + tenant", async () => {
    let seenUrl = "";
    const capture = (async (url: unknown, _init?: RequestInit) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ value: JSON.stringify(info()) }), { status: 200 });
    }) as typeof fetch;
    await verifyQuiet(verifier(capture));
    expect(seenUrl).toContain("/ODataV4/LethALControl_HarnessInfo");
    expect(seenUrl).toContain("tenant=default");
    expect(seenUrl).toContain("company=CRONUS");
  });
});

/**
 * R28: the AL side used to report a hardcoded `semver '1.0.0.0'`, so a control app several builds
 * behind was indistinguishable from a current one in the handshake — and each new client action
 * was left to fail its own way (a 404 canary line, BC's `clientProtocol` 400) instead of the
 * harness naming the one cause. `ControlApi.CurrentAppVersion` now reports the module's real
 * `AppVersion`; these pin the client half of that.
 */
describe("HarnessVerifier control-app version gate (R28)", () => {
  /** Reads back whatever `verify()` threw, so a message can be asserted rather than only a class. */
  async function messageFrom(payload: Record<string, unknown>): Promise<string> {
    let err: unknown;
    try {
      await verifier(okFetch(payload)).verify();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessVerificationError);
    return err instanceof Error ? err.message : String(err);
  }

  test("refuses a control app older than the minimum, naming both versions and the fix", async () => {
    // "1.0.0.0" is exactly what a build from BEFORE this change reports, whatever its app.json said.
    const message = await messageFrom(info({ semver: "1.0.0.0" }));
    expect(message).toContain("1.0.0.0");
    expect(message).toContain(MIN_CONTROL_VERSION);
    expect(message).toContain("predates this client");
    expect(message).toMatch(/rebuild extensions\/lethal-control and republish/);
  });

  test("refuses a payload with no semver at all rather than assuming it is current", async () => {
    const message = await messageFrom(info({ semver: undefined }));
    expect(message).toMatch(/did not report a LethAL Control version/);
    expect(message).toContain(MIN_CONTROL_VERSION);
    expect(message).toMatch(/rebuild extensions\/lethal-control and republish/);
  });

  // The AL side returns '' when GetCurrentModuleInfo fails — deliberately, so the client refuses
  // rather than being handed an invented version. This is the branch that catches that.
  test("refuses an EMPTY semver (a control app that could not read its own module info)", async () => {
    const message = await messageFrom(info({ semver: "" }));
    expect(message).toMatch(/did not report a LethAL Control version/);
  });

  test("refuses a non-string semver", async () => {
    const message = await messageFrom(info({ semver: 7 }));
    // "semver 7", not bare "7" — the required minimum in the same sentence contains a 7, so a
    // bare substring check would pass without the reported value ever being quoted.
    expect(message).toContain("semver 7");
  });

  test("refuses an unparseable semver instead of treating it as new enough", async () => {
    const message = await messageFrom(info({ semver: "1.0" }));
    expect(message).toMatch(/not a parseable BC four-part version/);
    expect(message).toContain("1.0");
    expect(message).toMatch(/rebuild extensions\/lethal-control and republish/);
  });

  test("refuses a semver with a non-numeric component", async () => {
    const message = await messageFrom(info({ semver: "1.0.0.x" }));
    expect(message).toMatch(/not a parseable BC four-part version/);
    expect(message).toContain("1.0.0.x");
  });

  /**
   * The multi-digit hazard, aimed at the LIVE minimum rather than a frozen literal: give the
   * minimum's revision a smaller leading digit and one more digit, and the result is numerically
   * ABOVE the minimum yet lexically BELOW it. A `<` on the strings would therefore reject exactly
   * the newest builds. The two self-check assertions are load-bearing, not decoration — if a
   * future `MIN_CONTROL_VERSION` makes the constructed value stop exercising that hazard, this
   * fails and says so rather than passing vacuously.
   */
  // The hazard is a LEXICAL compare masquerading as a version compare. Pinned on a fixed canonical
  // pair rather than derived from MIN_CONTROL_VERSION: the derivation used to build its pair by
  // prefixing "1" to MIN's revision, which only produces the lexical/numeric disagreement while
  // that revision is a SINGLE DIGIT. Bumping the minimum to 1.0.0.10 silently destroyed the
  // property the test was named for — no value at that position is both numerically above "10" and
  // lexically below it — and the test failed rather than quietly passing, which is the only reason
  // it was noticed. Decoupled so the next bump cannot do it again.
  test("compares versions numerically, never as strings", () => {
    expect(compareAppVersions("1.0.0.10", "1.0.0.9")).toBeGreaterThan(0); // numerically above
    expect("1.0.0.10" < "1.0.0.9").toBe(true); // ...yet lexically below: the hazard is live
    expect(compareAppVersions("1.0.0.9", "1.0.0.10")).toBeLessThan(0);
  });

  test("accepts a control app whose version is above the minimum", async () => {
    const [major, minor, build, revision] = MIN_CONTROL_VERSION.split(".");
    if (
      major === undefined ||
      minor === undefined ||
      build === undefined ||
      revision === undefined
    ) {
      throw new Error(`MIN_CONTROL_VERSION is not four-part: ${MIN_CONTROL_VERSION}`);
    }
    const newer = `${major}.${minor}.${build}.${Number(revision) + 1}`;
    expect(compareAppVersions(newer, MIN_CONTROL_VERSION)).toBeGreaterThan(0);

    const { details } = await verifyQuiet(verifier(okFetch(info({ semver: newer }))));
    expect(details.protocolVersion).toBe(2);
  });

  /**
   * The lockstep the constant's own doc comment claims. A minimum raised without bumping
   * `app.json` would make a FRESHLY BUILT control app fail its own gate — an unfixable error
   * telling the operator to rebuild something they just rebuilt — and nothing else in this repo
   * connects the two files.
   */
  test("MIN_CONTROL_VERSION equals extensions/lethal-control/app.json's version", async () => {
    const appJsonPath = fileURLToPath(
      new URL("../../../extensions/lethal-control/app.json", import.meta.url),
    );
    const appJson = JSON.parse(await readFile(appJsonPath, "utf8")) as { version?: unknown };
    expect(appJson.version).toBe(MIN_CONTROL_VERSION);
  });
});

describe("HarnessAuthError (R20)", () => {
  const cfg = {
    baseUrl: "http://bc:7048/BC",
    company: "CRONUS",
    username: "u",
    password: "p",
  } as const;

  function respond(status: number, body: string) {
    return async () => new Response(body, { status });
  }

  test("a 401 is an auth error, NOT a HarnessVerificationError", async () => {
    // The distinction is load-bearing, not cosmetic: env-tool-session treats a
    // HarnessVerificationError as "the control app is missing" and REPUBLISHES it, which runs
    // install/upgrade codeunits while the machine-global lease lives in that app's own tables.
    // A transient auth blip must never trigger that.
    const verifier = new HarnessVerifier(cfg, respond(401, "unauthorized") as never);
    await expect(verifier.verify()).rejects.toBeInstanceOf(HarnessAuthError);
    await expect(verifier.verify()).rejects.not.toBeInstanceOf(HarnessVerificationError);
  });

  test("a 403 is treated the same way", async () => {
    const verifier = new HarnessVerifier(cfg, respond(403, "forbidden") as never);
    await expect(verifier.verify()).rejects.toBeInstanceOf(HarnessAuthError);
  });

  test("it extends Error directly, so instanceof cannot cross-match", () => {
    // Same rule as MultiTenantContainerError and the AlcCompileError family: a typed error that
    // extended its sibling would be caught by the very handler it must escape.
    const err = new HarnessAuthError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HarnessVerificationError);
    expect(err.name).toBe("HarnessAuthError");
  });

  test("the message says what to check and that no republish will happen", () => {
    // A bare "HTTP 401" sends the reader to look for a deployment problem, which is exactly the
    // wrong place and the reason R20 existed.
    const verifier = new HarnessVerifier(cfg, respond(401, "nope") as never);
    return verifier.verify().then(
      () => {
        throw new Error("expected a rejection");
      },
      (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        expect(m).toContain("AUTHENTICATION failure");
        expect(m).toContain("username/password");
        expect(m).toContain("does NOT republish");
      },
    );
  });

  test("a non-auth failure is still a HarnessVerificationError", () => {
    // The narrowing must not swallow the general case.
    const verifier = new HarnessVerifier(cfg, respond(500, "boom") as never);
    return expect(verifier.verify()).rejects.toBeInstanceOf(HarnessVerificationError);
  });
});

describe("injectControlDependency", () => {
  // The shared injection BcDevMcpBackend.stageForCompile and scripts/campaign/compile-only.ts
  // both apply to an instrumented target's app.json before compiling it — see harness.ts's doc
  // comment on why the delegating selector cannot resolve `Codeunit "LC Control State"` without
  // this dependency declared.

  test("adds the dependency when absent", () => {
    const appJson = { id: "target-app-id", version: "1.0.0.0", dependencies: [] };
    const result = injectControlDependency(appJson);
    expect(result.dependencies).toEqual([
      { id: CONTROL_APP_ID, name: "LethAL Control", publisher: "LethAL", version: "1.0.0.0" },
    ]);
  });

  test("adds the dependency when the app.json declares no dependencies array at all", () => {
    const appJson = { id: "target-app-id", version: "1.0.0.0" };
    const result = injectControlDependency(appJson);
    expect(result.dependencies).toEqual([
      { id: CONTROL_APP_ID, name: "LethAL Control", publisher: "LethAL", version: "1.0.0.0" },
    ]);
  });

  test("does not duplicate the dependency when already present", () => {
    // Re-staging an already-injected app.json (or a caller's app.json that already lists it by
    // hand) must not produce a SECOND entry for the same app id — alc treats two dependency
    // entries for one app id as a real conflict, not a harmless duplicate.
    const existing = {
      id: CONTROL_APP_ID,
      name: "LethAL Control",
      publisher: "LethAL",
      version: "1.0.0.0",
    };
    const appJson = { id: "target-app-id", version: "1.0.0.0", dependencies: [existing] };
    const result = injectControlDependency(appJson);
    expect(result.dependencies).toEqual([existing]);
  });

  test("leaves every other field untouched", () => {
    const appJson = { id: "target-app-id", version: "1.0.0.0", name: "Target App", idRanges: [] };
    const result = injectControlDependency(appJson);
    expect(result.id).toBe("target-app-id");
    expect(result.version).toBe("1.0.0.0");
    expect(result.name).toBe("Target App");
    expect(result.idRanges).toEqual([]);
  });
});

/**
 * R110 — the lease fields on `HarnessInfo`. Parsed strictly rather than defaulted: a control app
 * older than MIN_CONTROL_VERSION does not carry them, and substituting `""` for a missing
 * `leaseOwner` would render as "nothing holds the lease" — rebuilding the exact false-green the
 * withdrawn doctor check was withdrawn for, one layer down.
 */
describe("parseLeaseSnapshot (R110)", () => {
  test("reads owner, op kind, expiry and whether a live token exists", () => {
    expect(
      parseLeaseSnapshot({
        leaseOwner: "lethal-run-42",
        leaseOpKind: "run",
        leaseExpiresAt: "2026-08-07T12:05:00.000Z",
        leaseTokenPresent: true,
      }),
    ).toEqual({
      owner: "lethal-run-42",
      opKind: "run",
      expiresAt: "2026-08-07T12:05:00.000Z",
      tokenPresent: true,
    });
  });

  test("a RELEASED lease still names its previous owner — that is not 'held'", () => {
    // Measured live on Cronus281: `TryRelease` clears the token, the expiry and the client nonce
    // but deliberately LEAVES `Owner` populated. The parse carries that through faithfully;
    // deciding what it MEANS is `checkLease`'s job, and it keys on `tokenPresent`/`opKind`.
    expect(
      parseLeaseSnapshot({
        leaseOwner: "lethal-run-41",
        leaseOpKind: "none",
        leaseExpiresAt: "",
        leaseTokenPresent: false,
      }),
    ).toEqual({ owner: "lethal-run-41", opKind: "none", expiresAt: "", tokenPresent: false });
  });

  test("REFUSES an older control app that reports no lease fields, naming the version needed", () => {
    // The failure that matters: this is what an un-republished container answers, and defaulting
    // here would report it as "no lease held".
    expect(() => parseLeaseSnapshot({})).toThrow(HarnessVerificationError);
    expect(() => parseLeaseSnapshot({})).toThrow(/1\.0\.0\.16/);
    expect(() => parseLeaseSnapshot({})).toThrow(/republish/);
  });

  test("refuses a mistyped field rather than coercing it", () => {
    expect(() =>
      parseLeaseSnapshot({
        leaseOwner: 42,
        leaseOpKind: "none",
        leaseExpiresAt: "",
        leaseTokenPresent: false,
      }),
    ).toThrow(HarnessVerificationError);
    // A STRING "false" is not a boolean, and coercing it would read as "no live token" — the
    // false-green direction again.
    expect(() =>
      parseLeaseSnapshot({
        leaseOwner: "",
        leaseOpKind: "none",
        leaseExpiresAt: "",
        leaseTokenPresent: "false",
      }),
    ).toThrow(HarnessVerificationError);
  });

  test("refuses an EMPTY opKind — the option always formats to one of none/publish/run", () => {
    // Empty means "the field was not populated", which is a different fact from "no operation is
    // in flight" and must not read as the latter.
    expect(() =>
      parseLeaseSnapshot({
        leaseOwner: "",
        leaseOpKind: "",
        leaseExpiresAt: "",
        leaseTokenPresent: false,
      }),
    ).toThrow(/EMPTY leaseOpKind/);
  });
});
