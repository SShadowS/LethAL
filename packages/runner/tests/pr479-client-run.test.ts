import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevConfig, BcDevDeployment } from "../src/bcdev-backend";
import { type ClientDriverSession, startClientDriver } from "../src/client-driver";
import {
  type ClientRunCheckInput,
  ClientRunFailure,
  type ClientRunFailureReason,
  checkClientRun,
  parsePageResults,
} from "../src/client-run";
import {
  ClientAnswerShapeError,
  type ClientAttestationRow,
  parseActivateForClient,
  parseDeactivateForClient,
  parseReadClientAttestation,
} from "../src/client-transport";
import { RunMutantTransport } from "../src/run-mutant-transport";

/**
 * PR-479 (479a) round 3a: one client codeunit op. The driver is the FAKE (tests/fixtures/fake-client-driver.ts); the
 * control app is a stubbed fetch. Nothing here touches a server, dotnet or /coord.
 */

const FAKE = join(import.meta.dir, "fixtures", "fake-client-driver.ts");
const MUTANT = "M0001";
const BASE_DATE = "2026-10-01";

// ---------------------------------------------------------------------------------------------
// The row checks (pure)
// ---------------------------------------------------------------------------------------------

function row(over: Partial<ClientAttestationRow> = {}): ClientAttestationRow {
  return {
    attemptId: "a1",
    opSeq: 1,
    codeunitId: 50100,
    method: "M1",
    loaded: true,
    loadedGeneration: 7,
    loadedMutantId: MUTANT,
    observedAny: true,
    observedIdentityMismatch: false,
    observedActive: true,
    success: true,
    testMethodRuns: 1,
    sessionId: 42,
    serverGeneration: "g",
    databaseId: "d",
    ...over,
  };
}
const goodRows = (): ClientAttestationRow[] => [row(), row({ method: "M2", testMethodRuns: 2 })];
const page = (m2: "pass" | "fail" = "pass") => [
  { name: "M1", outcome: "pass" as const },
  { name: "M2", outcome: m2 },
];
function input(over: Partial<ClientRunCheckInput> = {}): ClientRunCheckInput {
  return {
    codeunitId: 50100,
    declared: ["M1", "M2"],
    pageResults: page(),
    rows: goodRows(),
    attemptId: "a1",
    opSeq: 1,
    boundSessionId: 42,
    generation: 7,
    mutantId: MUTANT,
    ...over,
  };
}
function reason(f: () => unknown): ClientRunFailureReason | "no failure" {
  try {
    f();
  } catch (e) {
    if (e instanceof ClientRunFailure) return e.reason;
    throw e;
  }
  return "no failure";
}

describe("PR-479 round 3a: the row checks", () => {
  test("a clean run returns one result per declared method, in declared order, with its row", () => {
    const r = checkClientRun(
      input({
        pageResults: page("fail"),
        rows: [row(), row({ method: "M2", testMethodRuns: 2, success: false })],
      }),
    );
    expect(r.map((m) => [m.method, m.outcome])).toEqual([
      ["M1", "pass"],
      ["M2", "fail"],
    ]);
    expect(r[1]?.row.method).toBe("M2");
  });

  test("a row from another session fails; the bound session passes", () => {
    const rows = [row(), row({ method: "M2", testMethodRuns: 2, sessionId: 43 })];
    expect(reason(() => checkClientRun(input({ rows })))).toBe("client-row-session");
    expect(reason(() => checkClientRun(input()))).toBe("no failure");
  });

  test("the wrong generation fails: a newer one always; an older one with an observation", () => {
    const newer = [row({ loadedGeneration: 8 }), row({ method: "M2", testMethodRuns: 2 })];
    expect(reason(() => checkClientRun(input({ rows: newer })))).toBe("client-row-generation");
    const older = [
      row({ loadedGeneration: 6, observedAny: true }),
      row({ method: "M2", testMethodRuns: 2 }),
    ];
    expect(reason(() => checkClientRun(input({ rows: older })))).toBe("client-row-generation");
  });

  test("an older generation with nothing observed is accepted (a login-time load)", () => {
    const older = [
      row({ loadedGeneration: 6, observedAny: false, observedActive: false }),
      row({ method: "M2", testMethodRuns: 2 }),
    ];
    expect(reason(() => checkClientRun(input({ rows: older })))).toBe("no failure");
  });

  test("the loaded mutant must equal the activated one (current generation)", () => {
    const rows = [row({ loadedMutantId: "M0002" }), row({ method: "M2", testMethodRuns: 2 })];
    expect(reason(() => checkClientRun(input({ rows })))).toBe("client-row-mutant");
    // a no-mutant op: a row that loaded a mutant is a failure; a blank one passes
    expect(reason(() => checkClientRun(input({ mutantId: "" })))).toBe("client-row-mutant");
    const blank = [
      row({ loadedMutantId: "" }),
      row({ method: "M2", testMethodRuns: 2, loadedMutantId: "" }),
    ];
    expect(reason(() => checkClientRun(input({ mutantId: "", rows: blank })))).toBe("no failure");
  });

  test("an observed identity mismatch fails", () => {
    const rows = [
      row({ observedIdentityMismatch: true }),
      row({ method: "M2", testMethodRuns: 2 }),
    ];
    expect(reason(() => checkClientRun(input({ rows })))).toBe("client-row-identity-mismatch");
  });

  test("Loaded = false passes with nothing observed and fails with an observation", () => {
    const quiet = {
      loaded: false,
      loadedGeneration: 0,
      loadedMutantId: "",
      observedAny: false,
      observedActive: false,
    };
    const ok = [row(quiet), row({ ...quiet, method: "M2", testMethodRuns: 2 })];
    expect(reason(() => checkClientRun(input({ rows: ok })))).toBe("no failure");
    const seen = [
      row({ ...quiet, observedAny: true }),
      row({ ...quiet, method: "M2", testMethodRuns: 2 }),
    ];
    expect(reason(() => checkClientRun(input({ rows: seen })))).toBe(
      "client-row-not-loaded-observed",
    );
  });

  test("a missing row fails, naming the method; an extra row fails; a duplicate fails", () => {
    expect(reason(() => checkClientRun(input({ rows: [row()] })))).toBe("client-incomplete");
    const extra = [...goodRows(), row({ method: "M3", testMethodRuns: 3 })];
    expect(reason(() => checkClientRun(input({ rows: extra })))).toBe("client-incomplete");
    const dup = [...goodRows(), row({ method: "M2", testMethodRuns: 3 })];
    expect(reason(() => checkClientRun(input({ rows: dup })))).toBe("client-incomplete");
    // a row of another op (another codeunit) is not silently ignored
    const other = [...goodRows(), row({ codeunitId: 50101, method: "M3", testMethodRuns: 3 })];
    expect(reason(() => checkClientRun(input({ rows: other })))).toBe("client-incomplete");
  });

  test("a page result missing or extra fails (the join runs both ways)", () => {
    expect(reason(() => checkClientRun(input({ pageResults: [page()[0] as never] })))).toBe(
      "client-incomplete",
    );
    const extra = [...page(), { name: "M3", outcome: "pass" as const }];
    expect(reason(() => checkClientRun(input({ pageResults: extra })))).toBe("client-incomplete");
  });

  test("testMethodRuns out of declared order fails", () => {
    const swapped = [row({ testMethodRuns: 2 }), row({ method: "M2", testMethodRuns: 1 })];
    expect(reason(() => checkClientRun(input({ rows: swapped })))).toBe("client-test-method-runs");
    const gap = [row(), row({ method: "M2", testMethodRuns: 3 })];
    expect(reason(() => checkClientRun(input({ rows: gap })))).toBe("client-test-method-runs");
  });

  test("a page/row disagreement fails in both directions", () => {
    // the page says fail, the row says success
    expect(reason(() => checkClientRun(input({ pageResults: page("fail") })))).toBe(
      "client-row-success",
    );
    // the page says pass, the row says failure
    const rows = [row(), row({ method: "M2", testMethodRuns: 2, success: false })];
    expect(reason(() => checkClientRun(input({ rows })))).toBe("client-row-success");
  });

  test("an OnRun row and an OnRun page result are matched by name and left out", () => {
    const rows = [row({ method: "OnRun", testMethodRuns: 0 }), ...goodRows()];
    const pageResults = [{ name: "OnRun", outcome: "pass" as const }, ...page()];
    expect(reason(() => checkClientRun(input({ rows, pageResults })))).toBe("no failure");
  });

  test("an empty run, and zero rows, fail before any join", () => {
    expect(reason(() => checkClientRun(input({ pageResults: [], rows: [] })))).toBe(
      "client-run-empty",
    );
    expect(reason(() => checkClientRun(input({ rows: [] })))).toBe("client-run-empty");
    expect(reason(() => checkClientRun(input({ pageResults: [] })))).toBe("client-run-empty");
    expect(reason(() => checkClientRun(input({ declared: [], pageResults: [], rows: [] })))).toBe(
      "client-run-empty",
    );
    // only an OnRun row is still zero rows
    const onlyOnRun = [row({ method: "OnRun", testMethodRuns: 0 })];
    expect(reason(() => checkClientRun(input({ rows: onlyOnRun })))).toBe("client-run-empty");
  });

  test("the page results reader refuses what it cannot read", () => {
    expect(
      parsePageResults({ results: ['{"name":"M1","result":"Failure","message":"x"}'] }),
    ).toEqual([{ name: "M1", outcome: "fail", message: "x" }]);
    expect(reason(() => parsePageResults(undefined))).toBe("client-page-result-unreadable");
    expect(reason(() => parsePageResults({ results: ["not json"] }))).toBe(
      "client-page-result-unreadable",
    );
    expect(reason(() => parsePageResults({ results: ['{"name":"M1","result":"Skipped"}'] }))).toBe(
      "client-page-result-unreadable",
    );
  });
});

describe("PR-479 round 3a: the answer readers fail loudly", () => {
  test("ActivateForClient", () => {
    expect(parseActivateForClient({ claimed: true, generation: 7 })).toEqual({
      claimed: true,
      generation: 7,
    });
    expect(parseActivateForClient({ claimed: false, reason: "stale" })).toEqual({
      claimed: false,
      reason: "stale",
    });
    expect(() => parseActivateForClient({ claimed: true })).toThrow(ClientAnswerShapeError);
    expect(() => parseActivateForClient({ claimed: true, generation: "7" })).toThrow(
      ClientAnswerShapeError,
    );
    expect(() => parseActivateForClient({ claimed: false })).toThrow(ClientAnswerShapeError);
    expect(() => parseActivateForClient({ claimed: true, generation: 7, extra: 1 })).toThrow(
      ClientAnswerShapeError,
    );
  });
  test("DeactivateForClient", () => {
    expect(
      parseDeactivateForClient({
        deactivated: false,
        reason: "client-session-alive",
        sessionId: 42,
      }),
    ).toEqual({
      deactivated: false,
      reason: "client-session-alive",
      sessionId: 42,
    });
    expect(() => parseDeactivateForClient({})).toThrow(ClientAnswerShapeError);
    expect(() => parseDeactivateForClient({ deactivated: "yes" })).toThrow(ClientAnswerShapeError);
    expect(() => parseDeactivateForClient({ deactivated: true, sessionId: "4" })).toThrow(
      ClientAnswerShapeError,
    );
  });
  test("ReadClientAttestation", () => {
    expect(parseReadClientAttestation({ read: true, rows: [row()] })).toEqual({
      read: true,
      rows: [row()],
    });
    expect(parseReadClientAttestation({ read: true, rows: [] })).toEqual({ read: true, rows: [] });
    expect(parseReadClientAttestation({ read: false, reason: "lease-invalid" })).toEqual({
      read: false,
      reason: "lease-invalid",
    });
    expect(() => parseReadClientAttestation({ read: true })).toThrow(ClientAnswerShapeError);
    const { databaseId: _drop, ...short } = row();
    expect(() => parseReadClientAttestation({ read: true, rows: [short] })).toThrow(
      ClientAnswerShapeError,
    );
    expect(() =>
      parseReadClientAttestation({ read: true, rows: [{ ...row(), success: "true" }] }),
    ).toThrow(ClientAnswerShapeError);
    expect(() =>
      parseReadClientAttestation({ read: true, rows: [{ ...row(), stray: 1 }] }),
    ).toThrow(ClientAnswerShapeError);
  });
});

// ---------------------------------------------------------------------------------------------
// The op through the backend: fake driver + stubbed control app
// ---------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;
interface Scenario {
  activate?: (body: Body) => unknown;
  deactivate?: (n: number, body: Body) => unknown;
  attestation?: (body: Body) => unknown;
  workDates?: string[];
}
const dirs: string[] = [];
const live: ClientDriverSession[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.abort();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(mode: string, sc: Scenario = {}, cfgOver: Partial<BcDevConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr479-client-run-"));
  dirs.push(dir);
  const logFile = join(dir, "stdin.log");
  const driverLog = (): string[] => {
    try {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.stringify(JSON.parse(l)));
    } catch {
      return [];
    }
  };
  const calls: string[] = [];
  const driverAtCall: Record<string, string[][]> = {};
  let deactivations = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const action = /LethALControl_(\w+)/.exec(String(url))?.[1] ?? "?";
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(action);
    driverAtCall[action] = [...(driverAtCall[action] ?? []), driverLog()];
    let answer: unknown;
    if (action === "ActivateForClient") {
      answer = sc.activate ? sc.activate(body) : { claimed: true, generation: 7 };
    } else if (action === "DeactivateForClient") {
      deactivations += 1;
      answer = sc.deactivate
        ? sc.deactivate(deactivations, body)
        : deactivations % 2 === 1
          ? { deactivated: false, reason: "client-session-alive", sessionId: 42 }
          : { deactivated: true };
    } else if (action === "ReadClientAttestation") {
      answer = sc.attestation
        ? sc.attestation(body)
        : {
            read: true,
            rows: [
              row({ attemptId: String(body.attemptId), opSeq: Number(body.opSeq) }),
              row({
                attemptId: String(body.attemptId),
                opSeq: Number(body.opSeq),
                method: "M2",
                testMethodRuns: 2,
              }),
            ],
          };
    } else {
      throw new Error(`unexpected action ${action}`);
    }
    return new Response(JSON.stringify({ value: JSON.stringify(answer) }), { status: 200 });
  }) as unknown as typeof fetch;

  const dates = [...(sc.workDates ?? [BASE_DATE, BASE_DATE])];
  let reads = 0;
  const deployment = {
    harnessVerifier: {
      verify: async () => {
        reads += 1;
        calls.push("HarnessInfo");
        return { workDate: dates.shift() ?? BASE_DATE };
      },
    },
  } as unknown as BcDevDeployment;
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: ["unused"],
      project: "/al",
      controlSymbolPath: "/unused/lethal-control.app",
      packageCachePath: "/unused/.alpackages",
      clientMode: true,
      webClientBaseUrl: "http://web/BC",
      clientConfigPath: "/nonexistent/lethal.config.json",
      clientDriverLauncher: (cmd) => {
        calls.push("driver-start");
        const s = startClientDriver(
          {
            ...cmd,
            deadlines: { openSeconds: 20, stepSeconds: 20, testSeconds: 20, goSeconds: 20 },
          },
          { argv: [process.execPath, FAKE, mode, logFile], marginMs: 0 },
        );
        live.push(s);
        return s;
      },
      ...cfgOver,
    },
    undefined,
    deployment,
  );
  const transport = new RunMutantTransport(
    { baseUrl: "http://odata/BC", company: "CRONUS", username: "u", password: "p" },
    "target-app",
    "0123456789abcdef0123456789abcdef",
    fetchFn,
  );
  (backend as unknown as { runMutantTransport: RunMutantTransport }).runMutantTransport = transport;
  backend.setLease({
    epoch: 1,
    token: "t",
    serverGeneration: "g",
    lastCompletedOpSeq: 0,
    expiresAt: "x",
  });
  const run = (over: Partial<Parameters<BcDevMcpBackend["runClientCodeunit"]>[0]> = {}) =>
    backend.runClientCodeunit({
      codeunitId: 50100,
      declaredMethods: ["M1", "M2"],
      mutantId: MUTANT,
      baselineWorkDate: BASE_DATE,
      company: "CRONUS",
      ...over,
    });
  return { backend, run, calls, driverLog, driverAtCall, reads: () => reads };
}

const failing = (p: Promise<unknown>, r: ClientRunFailureReason) =>
  expect(p).rejects.toMatchObject({ name: "ClientRunFailure", reason: r });

describe("PR-479 round 3a: one client codeunit op", () => {
  test("a clean op returns a typed result and runs the steps in order, one op at a time", async () => {
    const r = rig("ok");
    const res = await r.run();
    expect(res.boundSessionId).toBe(42);
    expect(res.generation).toBe(7);
    expect(res.workDates).toEqual({ before: BASE_DATE, after: BASE_DATE });
    expect(res.methods.map((m) => [m.method, m.outcome, m.row.sessionId])).toEqual([
      ["M1", "pass", 42],
      ["M2", "pass", 42],
    ]);
    expect(r.calls).toEqual([
      "HarnessInfo",
      "driver-start",
      "ActivateForClient",
      "DeactivateForClient",
      "DeactivateForClient",
      "ReadClientAttestation",
      "HarnessInfo",
    ]);
    // What the driver had been told when each call arrived: bind before the first Deactivate, no End yet;
    // End (no close) before the second; close before the attestation read (amendment 1 item 1, amendment 2 item 2).
    const goes = (a: string, n: number) =>
      (r.driverAtCall[a]?.[n] ?? []).map((l) => (JSON.parse(l) as { go?: string }).go);
    expect(goes("ActivateForClient", 0)).toEqual([undefined]); // only the command: not bound yet
    expect(goes("DeactivateForClient", 0)).toEqual([undefined, "bind"]);
    expect(goes("DeactivateForClient", 1)).toEqual([undefined, "bind", "end"]);
    expect(goes("ReadClientAttestation", 0)).toEqual([undefined, "bind", "end", "close"]);
  });

  test("a failing method is returned as a fail with its message, never as a verdict", async () => {
    const r = rig("fail-m2", {
      attestation: (b) => ({
        read: true,
        rows: [
          row({ attemptId: String(b.attemptId), opSeq: Number(b.opSeq) }),
          row({
            attemptId: String(b.attemptId),
            opSeq: Number(b.opSeq),
            method: "M2",
            testMethodRuns: 2,
            success: false,
          }),
        ],
      }),
    });
    const res = await r.run();
    expect(res.methods[1]).toMatchObject({
      method: "M2",
      outcome: "fail",
      failureMessage: "Assert.AreEqual failed",
    });
  });

  test("an OnRun page result is left out", async () => {
    const res = await rig("onrun").run();
    expect(res.methods.map((m) => m.method)).toEqual(["M1", "M2"]);
  });

  test("the WorkDate moved before the op: workdate-changed, and no driver is started", async () => {
    const r = rig("ok", { workDates: ["2026-10-02"] });
    await failing(r.run(), "workdate-changed");
    expect(r.calls).toEqual(["HarnessInfo"]);
  });

  test("the WorkDate moved during the op: workdate-changed, never a result", async () => {
    const r = rig("ok", { workDates: [BASE_DATE, "2026-10-02"] });
    await failing(r.run(), "workdate-changed");
  });

  test("a lost Activate answer is client-activation-unknown; the driver is closed without End", async () => {
    const r = rig("ok", {
      activate: () => {
        throw new Error("socket hang up");
      },
    });
    await failing(r.run(), "client-activation-unknown");
    expect(r.driverLog().some((l) => l.includes('"end"') || l.includes('"bind"'))).toBe(false);
    expect(r.calls).not.toContain("DeactivateForClient");
  });

  test("an Activate answer that cannot be read is also client-activation-unknown", async () => {
    const r = rig("ok", { activate: () => ({ claimed: true }) });
    await failing(r.run(), "client-activation-unknown");
  });

  test("a refused Activate is client-activation-refused, with its reason", async () => {
    const r = rig("ok", { activate: () => ({ claimed: false, reason: "lease-invalid" }) });
    await expect(r.run()).rejects.toMatchObject({ reason: "client-activation-refused" });
  });

  test("Deactivate-before-End not alive fails, and End is never sent", async () => {
    for (const answer of [
      { deactivated: true },
      { deactivated: true, reason: "client-session-alive", sessionId: 42 }, // only `deactivated` is wrong
      { deactivated: false, reason: "lease-invalid" },
      { deactivated: false, reason: "client-session-alive" }, // no bound id
    ]) {
      const r = rig("ok", { deactivate: () => answer });
      await failing(r.run(), "client-deactivate-before-end");
      expect(r.driverLog().some((l) => l.includes('"end"'))).toBe(false);
      expect(r.calls).not.toContain("ReadClientAttestation");
    }
  });

  test("the final Deactivate not deactivated fails", async () => {
    const r = rig("ok", {
      deactivate: (n) =>
        n === 1
          ? { deactivated: false, reason: "client-session-alive", sessionId: 42 }
          : { deactivated: false, reason: "client-session-alive", sessionId: 42 },
    });
    await failing(r.run(), "client-final-deactivate");
    expect(r.calls).not.toContain("ReadClientAttestation");
  });

  test("the rows' session must be the id Deactivate named before End", async () => {
    const r = rig("ok", {
      deactivate: (n) =>
        n === 1
          ? { deactivated: false, reason: "client-session-alive", sessionId: 99 }
          : { deactivated: true },
    });
    await failing(r.run(), "client-row-session");
  });

  test("an empty run (no page results) is client-run-empty", async () => {
    await failing(rig("empty-results").run(), "client-run-empty");
  });

  test("zero rows is client-run-empty; an unreadable attestation is named", async () => {
    await failing(
      rig("ok", { attestation: () => ({ read: true, rows: [] }) }).run(),
      "client-run-empty",
    );
    await failing(
      rig("ok", { attestation: () => ({ read: false, reason: "lease-invalid" }) }).run(),
      "client-attestation-unreadable",
    );
  });

  test("a missing row and a wrong generation surface through the op", async () => {
    await failing(
      rig("ok", {
        attestation: (b) => ({
          read: true,
          rows: [row({ attemptId: String(b.attemptId), opSeq: Number(b.opSeq) })],
        }),
      }).run(),
      "client-incomplete",
    );
    await failing(
      rig("ok", { activate: () => ({ claimed: true, generation: 8 }) }).run(),
      "client-row-generation",
    );
  });

  test("a stale config's stopHungSessions: true is refused by name, before anything starts", async () => {
    const r = rig("ok", {}, { stopHungSessions: true });
    await expect(r.run()).rejects.toMatchObject({
      reason: "bcdev-client-refused-stop-hung-sessions",
    });
    expect(r.calls).toEqual([]);
  });

  test("a second op cannot start while one is in flight", async () => {
    const r = rig("ok");
    const first = r.run();
    await expect(r.run()).rejects.toThrow(/still in flight/);
    await first;
    // after close returned, the next op may start (it consumes the next op sequence)
    await r.run();
  });

  test("a headless backend refuses a client op", async () => {
    const r = rig("ok", {}, { clientMode: false });
    await expect(r.run()).rejects.toThrow(/bcdev-client backend only/);
  });
});
