import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevConfig, BcDevDeployment } from "../src/bcdev-backend";
import {
  type ClientDriverCommand,
  type ClientDriverSession,
  startClientDriver,
} from "../src/client-driver";
import {
  CLIENT_ATTESTATION_PAGE_ROWS,
  type ClientRunCheckInput,
  ClientRunFailure,
  type ClientRunFailureReason,
  checkClientRun,
  parsePageResults,
  readAllAttestationPages,
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
    serverGeneration: "g",
    databaseId: "d",
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

  // N2. Red: drop the stale-server loop in `checkClientRun`: both rows below pass.
  test("a row from another server generation or database fails, each on its own", () => {
    const gen = [row({ serverGeneration: "other" }), row({ method: "M2", testMethodRuns: 2 })];
    expect(reason(() => checkClientRun(input({ rows: gen })))).toBe("client-row-stale-server");
    const db = [row(), row({ method: "M2", testMethodRuns: 2, databaseId: "other" })];
    expect(reason(() => checkClientRun(input({ rows: db })))).toBe("client-row-stale-server");
    expect(reason(() => checkClientRun(input({ databaseId: "other" })))).toBe(
      "client-row-stale-server",
    );
    expect(reason(() => checkClientRun(input()))).toBe("no failure");
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

  // The measured shape (PR-478 bcwin, client-op-result.md): one TestResultJson per codeunit, result 2 / 1.
  const cuText = (testResults: unknown[], codeUnit = 79100) =>
    JSON.stringify({
      name: "Sandbox Tests",
      codeUnit,
      codeunitName: "Sandbox Tests",
      applicationID: "{x}",
      applicationName: "Sandbox Tests",
      startTime: "s",
      finishTime: "f",
      result: 2,
      testResults,
    });
  const entry = (method: string, result: unknown, extra: Record<string, unknown> = {}) => ({
    method,
    startTime: "s",
    finishTime: "f",
    result,
    ...extra,
  });

  test("the page results reader reads the measured shape: one codeunit text, result 2 a pass and 1 a failure", () => {
    expect(
      parsePageResults(
        {
          results: [
            cuText([
              entry("OverBudgetDetected", 1, { message: "x" }),
              entry("ClampPercentRuns", 2),
            ]),
          ],
        },
        79100,
      ),
    ).toEqual([
      { name: "OverBudgetDetected", outcome: "fail", message: "x" },
      { name: "ClampPercentRuns", outcome: "pass" },
    ]);
  });

  test("a failing entry's text is message, else errorMessage, else none", () => {
    const read = (extra: Record<string, unknown>) =>
      parsePageResults({ results: [cuText([entry("M1", 1, extra)])] }, 79100)[0];
    expect(read({ errorMessage: "e" })).toEqual({ name: "M1", outcome: "fail", message: "e" });
    expect(read({ message: "m", errorMessage: "e" })).toEqual({
      name: "M1",
      outcome: "fail",
      message: "m",
    });
    expect(read({})).toEqual({ name: "M1", outcome: "fail" });
    expect(read({ message: 7 })).toEqual({ name: "M1", outcome: "fail" });
  });

  test("the page results reader refuses what it cannot read", () => {
    const bad = (detail: Record<string, unknown> | undefined) =>
      reason(() => parsePageResults(detail, 79100));
    expect(bad(undefined)).toBe("client-page-result-unreadable");
    expect(bad({ results: ["not json"] })).toBe("client-page-result-unreadable");
    // any result other than 2 or 1 (the old string form included)
    for (const r of [0, 3, "Success", "Failure", null]) {
      expect(bad({ results: [cuText([entry("M1", r)])] })).toBe("client-page-result-unreadable");
    }
    expect(bad({ results: [cuText([{ result: 2 }])] })).toBe("client-page-result-unreadable");
    expect(bad({ results: [JSON.stringify({ codeUnit: 79100 })] })).toBe(
      "client-page-result-unreadable",
    );
    expect(bad({ results: [JSON.stringify({ testResults: [] })] })).toBe(
      "client-page-result-unreadable",
    );
    // the old per-method shape is not a codeunit text
    expect(bad({ results: ['{"name":"M1","result":"Success"}'] })).toBe(
      "client-page-result-unreadable",
    );
  });

  test("a result for another codeunit is an extra codeunit: client-incomplete", () => {
    expect(
      reason(() => parsePageResults({ results: [cuText([entry("M1", 2)], 79101)] }, 79100)),
    ).toBe("client-incomplete");
    expect(
      reason(() => parsePageResults({ results: [cuText([entry("M1", 2)], 79100)] }, 79100)),
    ).toBe("no failure");
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
    expect(parseReadClientAttestation({ read: true, total: 1, from: 0, rows: [row()] })).toEqual({
      read: true,
      total: 1,
      from: 0,
      rows: [row()],
    });
    expect(parseReadClientAttestation({ read: true, total: 0, from: 0, rows: [] })).toEqual({
      read: true,
      total: 0,
      from: 0,
      rows: [],
    });
    // Amendment 8: a read without total or from is a 1.0.0.31 answer, refused by shape
    expect(() => parseReadClientAttestation({ read: true, rows: [] })).toThrow(
      ClientAnswerShapeError,
    );
    expect(() => parseReadClientAttestation({ read: true, total: 0, rows: [] })).toThrow(
      ClientAnswerShapeError,
    );
    expect(() =>
      parseReadClientAttestation({ read: false, reason: "lease-invalid", total: 0 }),
    ).toThrow(ClientAnswerShapeError);
    expect(parseReadClientAttestation({ read: false, reason: "lease-invalid" })).toEqual({
      read: false,
      reason: "lease-invalid",
    });
    expect(() => parseReadClientAttestation({ read: true })).toThrow(ClientAnswerShapeError);
    const { databaseId: _drop, ...short } = row();
    // total and from are valid here, so only the row's own shape can refuse
    const page = { read: true, total: 1, from: 0 };
    expect(() => parseReadClientAttestation({ ...page, rows: [short] })).toThrow(
      ClientAnswerShapeError,
    );
    expect(() =>
      parseReadClientAttestation({ ...page, rows: [{ ...row(), success: "true" }] }),
    ).toThrow(ClientAnswerShapeError);
    expect(() => parseReadClientAttestation({ ...page, rows: [{ ...row(), stray: 1 }] })).toThrow(
      ClientAnswerShapeError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Amendment 8 (R1244): the paged attestation read
// ---------------------------------------------------------------------------------------------

describe("PR-479 amendment 8: readAllAttestationPages", () => {
  const rowsN = (n: number) => Array.from({ length: n }, (_, i) => row({ method: `M${i + 1}` }));
  // A correct 1.0.0.32 server over `all`, with one page answer replaceable per call (0-based call number).
  const server = (all: ClientAttestationRow[], over: Record<number, unknown> = {}) => {
    const asks: [number, number][] = [];
    const page = async (fromIndex: number, maxRows: number) => {
      const n = asks.length;
      asks.push([fromIndex, maxRows]);
      if (n in over)
        return over[n] as Awaited<ReturnType<Parameters<typeof readAllAttestationPages>[0]>>;
      return {
        read: true as const,
        total: all.length,
        from: fromIndex,
        rows: all.slice(fromIndex, fromIndex + maxRows),
      };
    };
    return { page, asks };
  };
  const reason = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    if (!(e instanceof ClientRunFailure)) throw new Error(`not a ClientRunFailure: ${String(e)}`);
    return [e.reason, e.inFlight];
  };

  test("25 rows come in pages of 10, 10 and 5, each asked from the rows held so far", async () => {
    const s = server(rowsN(25));
    const r = await readAllAttestationPages(s.page);
    expect(r.read && r.rows.map((x) => x.method)).toEqual(rowsN(25).map((x) => x.method));
    expect(s.asks).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
  });

  // R1244: the page bound in BYTES. On bcwin the smallest answer that never arrived was about 29.7 KB of decoded body
  // (68 rows); 67 rows (29,256 bytes) arrived. The wire body is never larger than the decoded text: measured uncompressed
  // it is the same UTF-8 bytes, and with the client's default Accept-Encoding bcwin sends it Brotli-compressed. So a
  // page bounded in decoded bytes is bounded on the wire. The worst page here: every text field at its maximum length,
  // a 128-character non-ASCII method name escaped as \uXXXX, then escaped again inside OData's `value` string.
  test("the worst-case page is under 16 KiB of OData body, about half the smallest answer bcwin never delivered", () => {
    const esc = (s: string) =>
      s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const worst = row({
      attemptId: "a".repeat(64),
      opSeq: Number.MAX_SAFE_INTEGER,
      codeunitId: 2147483647,
      method: "æ".repeat(128),
      loadedGeneration: Number.MAX_SAFE_INTEGER,
      loadedMutantId: "M".repeat(64),
      testMethodRuns: 2147483647,
      sessionId: 2147483647,
      serverGeneration: "g".repeat(32),
      databaseId: "d".repeat(32),
    });
    const page = {
      read: true,
      total: 2147483647,
      from: 2147483647,
      rows: Array.from({ length: CLIENT_ATTESTATION_PAGE_ROWS }, () => worst),
    };
    const inner = esc(JSON.stringify(page));
    const body = JSON.stringify({
      "@odata.context": `http://192.168.2.99:7048/BC/ODataV4/$metadata#Edm.String${"x".repeat(200)}`,
      value: inner,
    });
    const bytes = Buffer.byteLength(body);
    expect(bytes).toBeLessThan(16 * 1024);
    expect(bytes * 1.8).toBeLessThan(29_700); // a clear margin under the smallest measured failure
  });

  test("an exact multiple stops at total; total 0 is one page and an empty read", async () => {
    const s = server(rowsN(20));
    await readAllAttestationPages(s.page);
    expect(s.asks.length).toBe(2);
    const z = server([]);
    expect(await readAllAttestationPages(z.page)).toEqual({ read: true, rows: [] });
    expect(z.asks.length).toBe(1);
  });

  test("a first page that is refused is returned as it is (the caller names it unreadable)", async () => {
    const s = server(rowsN(5), { 0: { read: false, reason: "lease-invalid" } });
    expect(await readAllAttestationPages(s.page)).toEqual({ read: false, reason: "lease-invalid" });
  });

  // Each case is its own test, so a red check names the one that went red. Every scripted page is wrong in ONE way.
  const all = rowsN(25);
  const again = [...all.slice(10, 19), all[0] ?? row()];
  const cases: [string, Record<number, unknown>][] = [
    ["a refusal after an earlier read", { 1: { read: false, reason: "lease-invalid" } }],
    [
      "the total moves between pages",
      { 1: { read: true, total: 26, from: 10, rows: all.slice(10, 20) } },
    ],
    [
      "the page says it starts elsewhere (right rows)",
      { 1: { read: true, total: 25, from: 11, rows: all.slice(10, 20) } },
    ],
    [
      "a short page before total",
      { 1: { read: true, total: 25, from: 10, rows: all.slice(10, 19) } },
    ],
    ["an empty page before total", { 1: { read: true, total: 25, from: 10, rows: [] } }],
    [
      "a page of 11 rows for a page of 10",
      { 0: { read: true, total: 25, from: 0, rows: all.slice(0, 11) } },
    ],
    [
      "a row repeated across pages (right count)",
      { 1: { read: true, total: 25, from: 10, rows: again } },
    ],
  ];
  for (const [what, over] of cases) {
    test(`client-attestation-pages, never in flight: ${what}`, async () => {
      expect(await reason(readAllAttestationPages(server(all, over).page))).toEqual([
        "client-attestation-pages",
        false,
      ]);
    });
  }

  test("a lost page answer propagates as it is (the backend names it unreadable)", async () => {
    const s = server(rowsN(25));
    const lost = async (f: number, m: number) => {
      if (f === 10) throw new Error("ReadClientAttestation gave no answer within 30000 ms");
      return s.page(f, m);
    };
    await expect(readAllAttestationPages(lost)).rejects.toThrow("gave no answer");
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
  /** HarnessInfo's databaseId (default "d", the rows' default). */
  databaseId?: string;
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
  let currentMode = mode;
  const cmds: ClientDriverCommand[] = [];
  const activateBodies: Body[] = [];
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
      activateBodies.push(body);
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
      // Amendment 8: a whole read (no `total`) is paged as 1.0.0.32 does; an answer with `total` is a scripted page.
      const a = answer as { read?: boolean; total?: unknown; rows?: unknown[] };
      if (a.read === true && !("total" in a) && Array.isArray(a.rows)) {
        const from = Number(body.fromIndex);
        answer = {
          read: true,
          total: a.rows.length,
          from,
          rows: a.rows.slice(from, from + Number(body.maxRows)),
        };
      }
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
        return {
          workDate: dates.shift() ?? BASE_DATE,
          serverGeneration: "g",
          databaseId: sc.databaseId ?? "d",
        };
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
        cmds.push(cmd);
        const s = startClientDriver(
          {
            ...cmd,
            deadlines: { openSeconds: 20, stepSeconds: 20, testSeconds: 20, goSeconds: 20 },
          },
          { argv: [process.execPath, FAKE, currentMode, logFile], marginMs: 0 },
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
  type Req = Parameters<BcDevMcpBackend["runClientCodeunit"]>[0];
  // A key given as undefined is left OUT of the request (round 3b's optional baselineWorkDate and company).
  const run = (over: { [K in keyof Req]?: Req[K] | undefined } = {}) =>
    backend.runClientCodeunit(
      Object.fromEntries(
        Object.entries({
          codeunitId: 50100,
          declaredMethods: ["M1", "M2"],
          mutantId: MUTANT,
          baselineWorkDate: BASE_DATE,
          company: "CRONUS",
          ...over,
        }).filter(([, v]) => v !== undefined),
      ) as unknown as Req,
    );
  return {
    backend,
    run,
    calls,
    driverLog,
    driverAtCall,
    reads: () => reads,
    cmds,
    activateBodies,
    setMode: (m: string) => {
      currentMode = m;
    },
  };
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

  test("round 3b: a failing entry's errorMessage reaches the method's failureMessage", async () => {
    const r = rig("fail-m2-error-message", {
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
    expect((await r.run()).methods[1]).toMatchObject({
      outcome: "fail",
      failureMessage: "Assert.IsTrue failed",
    });
  });

  // Amendment 6 item 4. The attestation is the default (both rows), so ONLY the page-result join can catch this.
  // Red: skip the page-result assertJoin in checkClientRun.
  test("amendment 6: a declared method the page never ran is client-incomplete AFTER the op, End and Deactivate sent", async () => {
    const r = rig("hidden-run-false");
    await failing(r.run(), "client-incomplete");
    expect(r.driverLog().some((l) => l.includes('"end"'))).toBe(true);
    expect(r.calls.filter((c) => c === "DeactivateForClient")).toHaveLength(2);
  });

  test("round 3b: the page ran another codeunit: client-incomplete", async () => {
    await failing(rig("other-codeunit").run(), "client-incomplete");
  });

  // Round 3b: what is in flight. Red: drop `inFlight = true` before Activate, or the classify call in the catch.
  test("round 3b: a failure after Activate is in flight; one before it, or after the final Deactivate, is not", async () => {
    const caught = async (p: Promise<unknown>) => {
      const e = await p.catch((x: unknown) => x);
      if (!(e instanceof ClientRunFailure)) throw new Error(`not a ClientRunFailure: ${String(e)}`);
      return [e.reason, e.inFlight];
    };
    // the driver's own deadline after bind: an overrun, the op did not End
    expect(await caught(rig("driver-deadline").run())).toEqual(["client-in-flight-unknown", true]);
    // a named check inside the window keeps its reason and is marked in flight
    expect(await caught(rig("ok", { deactivate: () => ({ deactivated: true }) }).run())).toEqual([
      "client-deactivate-before-end",
      true,
    ]);
    // a lost Activate answer may have claimed the op
    expect(
      await caught(
        rig("ok", {
          activate: () => {
            throw new Error("socket hang up");
          },
        }).run(),
      ),
    ).toEqual(["client-activation-unknown", true]);
    // a refused Activate claimed nothing
    expect(
      await caught(rig("ok", { activate: () => ({ claimed: false, reason: "x" }) }).run()),
    ).toEqual(["client-activation-refused", false]);
    // a read-back refusal comes before Activate: no op exists
    expect(await caught(rig("wrong-company").run())).toEqual(["client-driver-failed", false]);
    // a row check after the final Deactivate: the op ended
    expect(
      await caught(rig("ok", { attestation: () => ({ read: true, rows: [] }) }).run()),
    ).toEqual(["client-run-empty", false]);
    // amendment 8: an inconsistent page reaches the caller as client-attestation-pages, not renamed unreadable
    // (red: drop `if (err instanceof ClientRunFailure) throw err;` from runClientCodeunit's page read)
    expect(
      await caught(
        rig("ok", {
          attestation: (body) => ({
            read: true,
            total: 3,
            from: Number(body.fromIndex),
            rows: [row({ attemptId: String(body.attemptId), opSeq: Number(body.opSeq) })],
          }),
        }).run(),
      ),
    ).toEqual(["client-attestation-pages", false]);
    // leg 4: a lost attestation read after the final Deactivate is named, and the op ended
    expect(
      await caught(
        rig("ok", {
          attestation: () => {
            throw new DOMException("The operation was aborted.", "AbortError");
          },
        }).run(),
      ),
    ).toEqual(["client-attestation-unreadable", false]);
  });

  test("leg 4: a control call our own timer aborts names the action and the bound, never a bare AbortError", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const t = new RunMutantTransport(
      { baseUrl: "http://odata/BC", company: "CRONUS", username: "u", password: "p" },
      "target-app",
      "0123456789abcdef0123456789abcdef",
      hang,
    );
    const lease = { epoch: 1, token: "t", serverGeneration: "g", opSeq: 1 };
    const e = await t
      .readClientAttestation({ attemptId: "a1", lease, fromIndex: 0, maxRows: 10, timeoutMs: 20 })
      .catch((x: unknown) => x);
    expect(String(e)).toContain("ReadClientAttestation gave no answer within 20 ms");
    expect(String(e)).toContain("no response headers arrived");
  });

  // R1244: bcwin's Docker port forward stalled a chunked answer mid-body. Red: drop the byte count from postAction's
  // abort message (or stop reading the body yourself), and the message no longer says it was cut short.
  test("R1244: an answer that stalls mid-body names the bytes received and that it was chunked", async () => {
    const stall = ((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`{"value":"${"x".repeat(990)}`));
          init?.signal?.addEventListener("abort", () =>
            c.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "transfer-encoding": "chunked" } }),
      );
    }) as unknown as typeof fetch;
    const t = new RunMutantTransport(
      { baseUrl: "http://odata/BC", company: "CRONUS", username: "u", password: "p" },
      "target-app",
      "0123456789abcdef0123456789abcdef",
      stall,
    );
    const lease = { epoch: 1, token: "t", serverGeneration: "g", opSeq: 1 };
    const e = await t
      .readClientAttestation({ attemptId: "a1", lease, fromIndex: 0, maxRows: 10, timeoutMs: 50 })
      .catch((x: unknown) => x);
    expect(String(e)).toContain("ReadClientAttestation gave no answer within 50 ms");
    // `{"value":"` (10 bytes) plus 990
    expect(String(e)).toContain("stopped after 1000 body byte(s) (chunked): response truncated");
  });

  test("round 3b: with no baselineWorkDate the op's own start read sets it, and the end read must equal it", async () => {
    const first = rig("ok", { workDates: ["2026-10-05", "2026-10-05"] });
    expect((await first.run({ baselineWorkDate: undefined })).workDates).toEqual({
      before: "2026-10-05",
      after: "2026-10-05",
    });
    const moved = rig("ok", { workDates: ["2026-10-05", "2026-10-06"] });
    await failing(moved.run({ baselineWorkDate: undefined }), "workdate-changed");
  });

  test("round 3b: the company defaults to the bcdev section's", async () => {
    const r = rig("ok", {}, { company: "CRONUS" });
    await r.run({ company: undefined });
    expect(r.driverLog()[0]).toContain('"company":"CRONUS"');
    const none = rig("ok");
    await expect(none.run({ company: undefined })).rejects.toThrow(
      /needs the bcdev section's company/,
    );
  });

  // S1. The control accepts only `Last Completed Op Seq + 1`. Red: take the op number before the driver starts (the
  // read-back refusal on the first op then burns 1, and the second op's Activate is refused for opSeq 2).
  test("review S1: a read-back refusal burns no op number, so the next op's Activate is accepted", async () => {
    let expected = 1;
    const r = rig("wrong-company", {
      activate: (b) => {
        if (Number(b.opSeq) !== expected)
          return { claimed: false, reason: `op-seq ${String(b.opSeq)}` };
        expected += 1;
        return { claimed: true, generation: 7 };
      },
    });
    await failing(r.run(), "client-driver-failed");
    expect(r.calls).not.toContain("ActivateForClient");
    r.setMode("ok");
    const res = await r.run();
    expect(res.methods.length).toBe(2);
    expect(r.activateBodies.map((b) => b.opSeq)).toEqual([1]);
    expect(expected).toBe(2);
  });

  // S2. Red: kill the driver at once in `mapError` (no `waitForClosed`): the rejection comes before the close.
  test("review S2: an error before Activate waits for the driver's close before the op ends", async () => {
    const r = rig("error-slow-close");
    await failing(r.run(), "client-driver-failed");
    expect(r.driverLog().some((l) => l.includes("closed-sent"))).toBe(true);
  });

  // S3. Red: drop the try/catch around `session.close()`: the failure reads "before Activate" and is not in flight.
  test("review S3: a failed close after the final Deactivate is client-close-failed, in flight, never 'before Activate'", async () => {
    const e = await rig("close-dies")
      .run()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClientRunFailure);
    const f = e as ClientRunFailure;
    expect(f.reason).toBe("client-close-failed");
    expect(f.inFlight).toBe(true);
    expect(f.message).not.toContain("before Activate");
  });

  // S4. Red: set CLIENT_RUN_BOUND_MS back to 300_000 (or drop `deadlines` from the command).
  test("review S4: the control's bound is its 600 s cap and the driver's one total deadline is that minus 60 s", async () => {
    const r = rig("ok");
    await r.run();
    expect(r.activateBodies[0]?.runBoundMs).toBe(600_000);
    expect(r.cmds[0]?.deadlines?.testSeconds).toBe(540);
  });

  // N2 through the op. Red: drop `serverGeneration`/`databaseId` from the `checkClientRun` call in `runClientCodeunit`.
  test("review N2: rows from another server generation, or another database than HarnessInfo's, fail", async () => {
    await failing(
      rig("ok", {
        attestation: (b) => ({
          read: true,
          rows: [
            row({ attemptId: String(b.attemptId), opSeq: Number(b.opSeq), serverGeneration: "x" }),
            row({
              attemptId: String(b.attemptId),
              opSeq: Number(b.opSeq),
              method: "M2",
              testMethodRuns: 2,
              serverGeneration: "x",
            }),
          ],
        }),
      }).run(),
      "client-row-stale-server",
    );
    await failing(rig("ok", { databaseId: "other" }).run(), "client-row-stale-server");
  });

  test("a headless backend refuses a client op", async () => {
    const r = rig("ok", {}, { clientMode: false });
    await expect(r.run()).rejects.toThrow(/bcdev-client backend only/);
  });
});
