import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationStatus } from "../../packages/runner/src/lease";
import { calibrationScript } from "./calibrate";
import type { CallTrace } from "./fetch-trace";
// Imported WITH its extension: R186's importer check matches by basename, so a bare "./probe" is read as
// importing the unguarded `scripts/r126-server-probe/probe.ts`. This probe.ts is guarded by import.meta.main.
import {
  CONFIG_PATH,
  PROJECT_DIR,
  TEST_DIR,
  containerFromServer,
  containerScript,
  decideActionEnded,
  decideExit,
  gatherEvidence,
  guardThenConnect,
  parseContainerEvidence,
  preflight,
  sessionControl,
  shouldPreflight,
  writeCaptures,
  writeRecord,
} from "./probe.ts";

const status = (s: Partial<OperationStatus>): OperationStatus => ({
  opKind: "idle",
  opAttemptId: "a7",
  opSeq: 12,
  lastCompletedOpSeq: 11,
  completed: false,
  ...s,
});
const done = [{ atMs: 0, status: status({ completed: true }) }];

describe("decideActionEnded (R236 Task 2 requirement 7c)", () => {
  test("marker done, one session id, id space proven, session gone from a non-empty list: ended", () => {
    expect(decideActionEnded("a7", 12, done, [55], [1, 2], true)).toBe(true);
    const byLastCompleted = [{ atMs: 0, status: status({ opSeq: 13, lastCompletedOpSeq: 12 }) }];
    expect(decideActionEnded("a7", 12, byLastCompleted, [55], [9], true)).toBe(true);
  });

  test("the fence completed but the call's BC session is still alive: NOT ended", () => {
    expect(decideActionEnded("a7", 12, done, [55], [55], true)).toBe(false);
  });

  test("review r1 CRITICAL: an absent id proves nothing without a positive control", () => {
    // wrong tenant or wrong id space: the cmdlet answers @() or a list our ids never appear in
    expect(decideActionEnded("a7", 12, done, [55], [], true)).toBe(false);
    expect(decideActionEnded("a7", 12, done, [55], [1, 2], false)).toBe(false);
  });

  test("the marker does not show this op completed: NOT ended", () => {
    const running = [{ atMs: 0, status: status({ opKind: "run" }) }];
    expect(decideActionEnded("a7", 12, running, [55], [9], true)).toBe(false);
    const otherOpDone = [
      {
        atMs: 0,
        status: status({ completed: true, opAttemptId: "b9", opSeq: 3, lastCompletedOpSeq: 3 }),
      },
    ];
    expect(decideActionEnded("a7", 12, otherOpDone, [55], [9], true)).toBe(false);
    expect(decideActionEnded("a7", 12, [{ atMs: 0, error: "timeout" }], [55], [9], true)).toBe(
      false,
    );
  });

  test("session id not exactly one positive value, or the session list unread: NOT ended", () => {
    expect(decideActionEnded("a7", 12, done, null, [9], true)).toBe(false);
    expect(decideActionEnded("a7", 12, done, [], [9], true)).toBe(false);
    expect(decideActionEnded("a7", 12, done, [55, 56], [9], true)).toBe(false);
    expect(decideActionEnded("a7", 12, done, [0], [9], true)).toBe(false);
    expect(decideActionEnded("a7", 12, done, [55], null, true)).toBe(false);
  });
});

describe("sessionControl (review r1: the id-space positive control)", () => {
  const ev = (over: Partial<ReturnType<typeof parseContainerEvidence>>) => ({
    opSessionIds: new Map<string, number[]>(),
    finishedOps: [
      { sessionId: 40, attemptId: "broken", opSeq: 12 },
      { sessionId: 41, attemptId: "ok", opSeq: 11 },
    ],
    activeSessionIds: [] as number[] | null,
    nstSessions: [41, 77] as number[] | null,
    ...over,
  });

  test("the latest finished op NOT among the broken ones is the control; listed proves the id space", () => {
    const c = sessionControl(ev({}), ["broken"], null);
    expect(c.finishedOpSessionId).toBe(41);
    expect(c.finishedOpListed).toBe(true);
    expect(c.idSpaceMatched).toBe(true);
  });

  test("the ran answer's session id also proves it", () => {
    expect(sessionControl(ev({ nstSessions: [77] }), [], 77).idSpaceMatched).toBe(true);
    expect(sessionControl(ev({ nstSessions: [77] }), [], 77).ranAnswerListed).toBe(true);
  });

  test("review r2: an Active Session overlap is diagnostic only (the table read has no tenant filter)", () => {
    // wrong-tenant list [5] overlaps the unfiltered table but lists neither control
    const viaTable = sessionControl(ev({ nstSessions: [5], activeSessionIds: [5, 6] }), [], 77);
    expect(viaTable.activeTableOverlap).toEqual([5]);
    expect(viaTable.idSpaceMatched).toBe(false);
  });

  test("an empty or unread list, or no control listed, proves nothing", () => {
    expect(sessionControl(ev({ nstSessions: [] }), [], 41).idSpaceMatched).toBe(false);
    expect(sessionControl(ev({ nstSessions: null }), [], 41).idSpaceMatched).toBe(false);
    const none = sessionControl(ev({ nstSessions: [99] }), [], 77);
    expect(none.finishedOpListed).toBe(false);
    expect(none.ranAnswerListed).toBe(false);
    expect(none.idSpaceMatched).toBe(false);
  });
});

describe("parseContainerEvidence", () => {
  test("reads the tagged lines among container noise; one object or an array", () => {
    const out = [
      "BcContainerHelper version 6.1.15",
      'R236-SQL-OP:{"attemptId":"a7","opSeq":12,"ids":55}',
      'R236-SQL-FIN:{"sid":41,"attemptId":"ok","opSeq":11}',
      "R236-ACTIVE:[41,77]",
      'R236-NST:{"SessionID":7,"ClientType":1}',
      "----",
    ].join("\r\n");
    const ev = parseContainerEvidence(out);
    expect(ev.opSessionIds.get("a7:12")).toEqual([55]);
    expect(ev.finishedOps).toEqual([{ sessionId: 41, attemptId: "ok", opSeq: 11 }]);
    expect(ev.activeSessionIds).toEqual([41, 77]);
    expect(ev.nstSessions).toEqual([7]);
    const arr = parseContainerEvidence(
      'R236-NST:[{"SessionID":7},{"SessionID":9}]\nR236-SQL-FIN:[]',
    );
    expect(arr.nstSessions).toEqual([7, 9]);
    expect(arr.finishedOps).toEqual([]);
  });

  test("an error line, a missing line or junk is null, never an empty list", () => {
    const ev = parseContainerEvidence(
      "R236-SQL-ERR:expected one LC Op Progress table, found 0\nR236-NST:not json",
    );
    expect(ev.opSessionIds.size).toBe(0);
    expect(ev.finishedOps).toBeNull();
    expect(ev.activeSessionIds).toBeNull();
    expect(ev.nstSessions).toBeNull();
  });
});

describe("gatherEvidence (review r1 IMPORTANT 3: evidence failures never lose the record)", () => {
  const trace: CallTrace = {
    action: "LethALControl_RunMutantWithCoverage",
    dispatchedAt: 1_000,
    testMethod: "PageActionComputesNonZero",
  };
  const pending = [
    {
      trace,
      attemptId: "a7",
      opSeq: 12,
      reads: [],
      readMarker: async () => ({ atMs: 5, status: status({ completed: true }) }),
    },
  ];
  const input = {
    container: "Cronus284",
    tenant: "default",
    sessionStartedAt: "2026-09-26T10:00:00.000Z",
    ranAnswerSessionId: null,
  };

  test("the container call throwing (pwsh ENOENT) gives actionEnded false with the error, not a throw", async () => {
    const r = await gatherEvidence(pending, input, async () => {
      throw new Error("ENOENT: pwsh");
    });
    expect(r.broken).toHaveLength(1);
    expect(r.broken[0]?.actionEnded).toBe(false);
    expect(r.broken[0]?.testMethod).toBe("PageActionComputesNonZero");
    expect(r.broken[0]?.evidenceError).toContain("ENOENT");
    expect(r.control.idSpaceMatched).toBe(false);
  });

  test("an attempt id the script refuses to embed is recorded, not thrown", async () => {
    const bad = [{ ...pending[0], attemptId: "x'; DROP" }] as typeof pending;
    const r = await gatherEvidence(bad, input, async () => ({ stdout: "", stderr: "", code: 0 }));
    expect(r.broken[0]?.actionEnded).toBe(false);
    expect(r.broken[0]?.evidenceError).toContain("refusing");
  });

  test("review r2: a wrong-tenant list that overlaps the table but lists neither control: NOT ended", async () => {
    const stdout = [
      'R236-SQL-OP:{"attemptId":"a7","opSeq":12,"ids":[55]}',
      'R236-SQL-FIN:[{"sid":41,"attemptId":"ok","opSeq":11}]',
      "R236-ACTIVE:[5,6]",
      'R236-NST:[{"SessionID":5}]',
    ].join("\n");
    const r = await gatherEvidence(pending, input, async () => ({ stdout, stderr: "", code: 0 }));
    expect(r.control.activeTableOverlap).toEqual([5]);
    expect(r.control.idSpaceMatched).toBe(false);
    expect(r.broken[0]?.actionEnded).toBe(false);
  });

  test("a healthy read with a listed control and our session gone: ended", async () => {
    const stdout = [
      'R236-SQL-OP:{"attemptId":"a7","opSeq":12,"ids":[55]}',
      'R236-SQL-FIN:[{"sid":41,"attemptId":"ok","opSeq":11}]',
      "R236-ACTIVE:[]",
      'R236-NST:[{"SessionID":41}]',
    ].join("\n");
    const r = await gatherEvidence(pending, input, async () => ({ stdout, stderr: "", code: 0 }));
    expect(r.control.finishedOpListed).toBe(true);
    expect(r.broken[0]?.sessionId).toBe(55);
    expect(r.broken[0]?.actionEnded).toBe(true);
  });
});

describe("decideExit (ruling q-160433: an unproven action end is a counted hit, not a stop)", () => {
  const b = (testMethod: string, actionEnded: boolean) => ({ testMethod, actionEnded });
  const reason = "baseline test in-flight-unknown running PageActionComputesNonZero";
  const d = (
    quarantined: string | null,
    broken: ReturnType<typeof b>[],
    thrown: string | null = null,
  ) => decideExit({ thrown, quarantined, broken });

  test("no quarantine and no broken call: 0, no action-end class", () => {
    expect(d(null, [])).toEqual({ exitCode: 0, actionEnd: null, stopReason: null });
  });

  test("a hit whose broken call provably ended: 0, proven", () => {
    expect(d(reason, [b("PageActionComputesNonZero", true)])).toMatchObject({
      exitCode: 0,
      actionEnd: "proven",
    });
  });

  test('a Task 6 suffixed reason (method name followed by ": <message>") still proves the action ended, the same as the old unsuffixed reason', () => {
    const suffixed =
      "baseline test in-flight-unknown running PageActionComputesNonZero: RunMutant timed out after headers: AbortError";
    expect(d(suffixed, [b("PageActionComputesNonZero", true)])).toMatchObject({
      exitCode: 0,
      actionEnd: "proven",
    });
    expect(d(reason, [b("PageActionComputesNonZero", true)])).toMatchObject({
      exitCode: 0,
      actionEnd: "proven",
    });
  });

  test("an end that cannot be proven is 'unproven' and does NOT stop the arm (0)", () => {
    expect(d(reason, [b("PageActionComputesNonZero", false)])).toMatchObject({
      exitCode: 0,
      actionEnd: "unproven",
    });
    expect(d(reason, [])).toMatchObject({ exitCode: 0, actionEnd: "unproven" }); // untraced
    expect(d(reason, [b("OtherTest", true)])).toMatchObject({ exitCode: 0, actionEnd: "unproven" });
    expect(d(null, [b("X", false)])).toMatchObject({ exitCode: 0, actionEnd: "unproven" });
  });

  test("a throw still stops for recovery (4)", () => {
    expect(d(null, [b("X", false)], "boom").exitCode).toBe(4);
  });
});

describe("preflight (the gate before a session that follows an unproven hit)", () => {
  test("clean only when doctor exits 0 AND the harness check passes; never force-resets", async () => {
    const ok = await preflight({ doctor: async () => 0, harness: async () => {} });
    expect(ok).toEqual({ ok: true, reason: null });
    const dirty = await preflight({ doctor: async () => 1, harness: async () => {} });
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toContain("doctor exited 1");
    const harness = await preflight({
      doctor: async () => 0,
      harness: async () => {
        throw new Error("lease held");
      },
    });
    expect(harness.ok).toBe(false);
    expect(harness.reason).toContain("lease held");
    const spawnFails = await preflight({
      doctor: async () => {
        throw new Error("ENOENT bun");
      },
      harness: async () => {},
    });
    expect(spawnFails.ok).toBe(false);
  });
});

describe("shouldPreflight (every invocation preflights at its first session, not only after a hit in the same process; review r1)", () => {
  test("a fresh invocation's first session always gates, whatever afterUnprovenHit says", () => {
    expect(shouldPreflight(1, false)).toBe(true);
    expect(shouldPreflight(1, true)).toBe(true);
  });

  test("a later session in the same run gates only when the one before it was an unproven hit", () => {
    expect(shouldPreflight(2, true)).toBe(true);
    expect(shouldPreflight(2, false)).toBe(false);
    expect(shouldPreflight(9, false)).toBe(false);
  });
});

describe("writeRecord (review r1 IMPORTANT 3)", () => {
  test("an unwritable --out never throws: the record goes to stdout and the caller learns it failed", () => {
    expect(writeRecord("C:/r236-no-such-dir-xyz/out.ndjson", { a: 1 })).toBe(false);
  });

  test("review r2 nit: a record that cannot be serialised never throws either", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(writeRecord("C:/r236-no-such-dir-xyz/out.ndjson", cyclic)).toBe(false);
  });
});

describe("calibration 1: the SQL reads target the TENANT database", () => {
  // Measured on Cronus28 (multitenant): the server config's DatabaseName is the APP database
  // (CRONUS), which holds neither `Active Session` nor `LC Op Progress$...`. The tenant's own
  // database (here `default`) does, and only Get-NAVTenant names it.
  const scripts = {
    probe: containerScript(
      "Cronus284",
      "default",
      [{ attemptId: "a7", opSeq: 12 }],
      "2026-09-26T10:00:00.000",
      null,
    ),
    calibrate: calibrationScript("Cronus284", "default"),
  };
  for (const [name, text] of Object.entries(scripts)) {
    test(`${name}: resolves the DB with Get-NAVTenant, prints it, never uses the server's DatabaseName`, () => {
      expect(text).toContain("(Get-NAVTenant -ServerInstance BC -Tenant $tenant).DatabaseName");
      expect(text).toContain("'R236-DB:'");
      expect(text).toContain("Database = $db");
      expect(text).not.toContain("& $get 'DatabaseName'");
    });
  }
});

describe("the container comes from the config's server URL", () => {
  test("the host of bcdev.server, case kept, with or without a port or path", () => {
    expect(containerFromServer("http://Cronus284")).toBe("Cronus284");
    expect(containerFromServer("http://Cronus284:7048/BC/")).toBe("Cronus284");
    expect(containerFromServer("https://Cronus284/")).toBe("Cronus284");
  });
  test("an empty, missing or hostless server throws, naming the config field", () => {
    expect(() => containerFromServer("")).toThrow("bcdev.server");
    expect(() => containerFromServer(undefined)).toThrow("bcdev.server");
    expect(() => containerFromServer("Cronus284")).toThrow("bcdev.server");
  });
  test("both container scripts target the container they are given", () => {
    const probe = containerScript("Cronus284", "default", [], "2026-09-26T10:00:00.000", null);
    expect(probe).toContain("-containerName Cronus284 ");
    expect(calibrationScript("Cronus284", "default")).toContain("-containerName Cronus284 ");
  });
});

describe("writeCaptures (orchestrator ruling A: partial and full TestPage answer bytes)", () => {
  const trace = (bytesReceived: number): CallTrace => ({
    action: "LethALControl_RunMutantWithCoverage",
    dispatchedAt: 0,
    attemptId: "a7",
    opSeq: 12,
    testMethod: "PageActionComputesNonZero",
    bytesReceived,
  });

  test("each capture lands in <out>.partial/ with its offset, bytesReceived, path and sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "r236-cap-"));
    const out = join(dir, "A1.ndjson");
    const partial = new Uint8Array([123, 34, 118]);
    const full = new TextEncoder().encode('{"value":"x"}');
    const recs = writeCaptures(out, "A1-seg1-3", [
      { trace: trace(3), bytes: partial, complete: false },
      { trace: trace(full.byteLength), bytes: full, complete: true },
    ]);
    expect(recs[0]).toMatchObject({
      kind: "partial",
      attemptId: "a7",
      opSeq: 12,
      offset: 3,
      bytesReceived: 3,
    });
    expect(recs[0]?.path).toBe(join(`${out}.partial`, "A1-seg1-3-partial-a7-12.bin"));
    expect(recs[0]?.sha256).toBe(new Bun.CryptoHasher("sha256").update(partial).digest("hex"));
    expect(new Uint8Array(readFileSync(recs[0]?.path ?? ""))).toEqual(partial);
    expect(recs[1]).toMatchObject({ kind: "full", offset: full.byteLength });
    expect(new Uint8Array(readFileSync(recs[1]?.path ?? ""))).toEqual(full);
  });

  test("a write failure is recorded, never thrown", () => {
    const recs = writeCaptures("Q:/r236-no-such-drive/A1.ndjson", "x", [
      { trace: trace(3), bytes: new Uint8Array([1, 2, 3]), complete: false },
    ]);
    expect(recs[0]?.error).toBeDefined();
    expect(recs[0]?.path).toBeNull();
  });
});

describe("the project is this repo's fixture, not the main checkout's", () => {
  const fwd = (p: string) => p.replaceAll("\\", "/");
  test("PROJECT_DIR, TEST_DIR and CONFIG_PATH resolve under THIS tree, two levels above the script", () => {
    const root = fwd(join(import.meta.dir, "..", ".."));
    expect(fwd(PROJECT_DIR)).toBe(`${root}/fixtures/sandbox-data`);
    expect(fwd(TEST_DIR)).toBe(`${root}/fixtures/sandbox-data-tests`);
    expect(fwd(CONFIG_PATH)).toBe(`${root}/fixtures/sandbox-data/lethal.config.local.json`);
    for (const p of [PROJECT_DIR, TEST_DIR, CONFIG_PATH]) {
      expect(fwd(p)).not.toContain("U:/Git/LethAL/");
    }
  });
});

describe("the lease guard: no network call unless coord shows lane bugs holding the configured container", () => {
  const coord =
    (stdout: string, code = 0) =>
    async (_container: string) => ({ code, stdout, stderr: "" });
  const counting = () => {
    let calls = 0;
    const f = async () => {
      calls++;
      return "1.0.0.19";
    };
    return { f, calls: () => calls };
  };
  const bugs = JSON.stringify({ lane: "bugs", attempt: "0001", at: 1 });

  test("holder bugs: proceeds, and only then makes the first network call", async () => {
    const net = counting();
    expect(await guardThenConnect("Cronus284", coord(bugs), net.f)).toBe("1.0.0.19");
    expect(net.calls()).toBe(1);
  });

  const refusals: Array<[string, ReturnType<typeof coord>, string]> = [
    ["a null holder", coord("null\n"), "not leased"],
    [
      "another lane",
      coord(JSON.stringify({ lane: "orchestrator", attempt: "0002", at: 1 })),
      "orchestrator",
    ],
    ["coord failing (even with a bugs-looking stdout)", coord(bugs, 1), "coord"],
    ["garbage output", coord("Error: something"), "coord"],
  ];
  for (const [name, c, says] of refusals) {
    test(`${name}: refuses, naming the container and what it saw, before any network call`, async () => {
      const net = counting();
      const err = await guardThenConnect("Cronus284", c, net.f).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain("Cronus284");
      expect(String(err)).toContain(says);
      expect(net.calls()).toBe(0);
    });
  }

  test("coord that cannot even be spawned: refuses", async () => {
    const net = counting();
    const spawnFails = async () => {
      throw new Error("ENOENT deno");
    };
    const err = await guardThenConnect("Cronus284", spawnFails, net.f).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toContain("Cronus284");
    expect(net.calls()).toBe(0);
  });
});
