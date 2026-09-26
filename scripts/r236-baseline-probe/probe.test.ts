import { describe, expect, test } from "bun:test";
import type { OperationStatus } from "../../packages/runner/src/lease";
import type { CallTrace } from "./fetch-trace";
// Imported WITH its extension: R186's importer check matches by basename, so a bare "./probe" is read as
// importing the unguarded `scripts/r126-server-probe/probe.ts`. This probe.ts is guarded by import.meta.main.
import {
  decideActionEnded,
  decideExit,
  gatherEvidence,
  parseContainerEvidence,
  sessionControl,
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

  test("the ran answer's session id, or an Active Session overlap, also proves it", () => {
    expect(sessionControl(ev({ nstSessions: [77] }), [], 77).idSpaceMatched).toBe(true);
    expect(sessionControl(ev({ nstSessions: [77] }), [], 77).ranAnswerListed).toBe(true);
    const viaTable = sessionControl(ev({ nstSessions: [5], activeSessionIds: [5, 6] }), [], null);
    expect(viaTable.activeTableOverlap).toEqual([5]);
    expect(viaTable.idSpaceMatched).toBe(true);
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

describe("decideExit", () => {
  const b = (testMethod: string, actionEnded: boolean) => ({ testMethod, actionEnded });
  const reason = "baseline test in-flight-unknown running PageActionComputesNonZero";

  test("0 only when every broken call ended and the quarantined test matches a broken call", () => {
    expect(decideExit({ thrown: null, quarantined: null, broken: [] }).exitCode).toBe(0);
    expect(
      decideExit({
        thrown: null,
        quarantined: reason,
        broken: [b("PageActionComputesNonZero", true)],
      }).exitCode,
    ).toBe(0);
  });

  test("review r1 minor: a quarantine whose test is not a broken call's stops (exit 3)", () => {
    expect(
      decideExit({ thrown: null, quarantined: reason, broken: [b("OtherTest", true)] }).exitCode,
    ).toBe(3);
    expect(decideExit({ thrown: null, quarantined: reason, broken: [] }).exitCode).toBe(3);
    expect(
      decideExit({ thrown: null, quarantined: "something else", broken: [b("X", true)] }).exitCode,
    ).toBe(3);
  });

  test("a broken call not proven ended stops (3); a throw stops (4)", () => {
    expect(decideExit({ thrown: null, quarantined: null, broken: [b("X", false)] }).exitCode).toBe(
      3,
    );
    expect(
      decideExit({ thrown: "boom", quarantined: null, broken: [b("X", false)] }).exitCode,
    ).toBe(4);
  });
});

describe("writeRecord (review r1 IMPORTANT 3)", () => {
  test("an unwritable --out never throws: the record goes to stdout and the caller learns it failed", () => {
    expect(writeRecord("C:/r236-no-such-dir-xyz/out.ndjson", { a: 1 })).toBe(false);
  });
});
