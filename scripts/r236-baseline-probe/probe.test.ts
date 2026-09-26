import { describe, expect, test } from "bun:test";
import type { OperationStatus } from "../../packages/runner/src/lease";
import { decideActionEnded, parseContainerEvidence } from "./probe";

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
  test("marker done, one session id from the progress row, and that session is gone: ended", () => {
    expect(decideActionEnded("a7", 12, done, [55], [1, 2])).toBe(true);
    const byLastCompleted = [{ atMs: 0, status: status({ opSeq: 13, lastCompletedOpSeq: 12 }) }];
    expect(decideActionEnded("a7", 12, byLastCompleted, [55], [])).toBe(true);
  });

  test("the fence completed but the call's BC session is still alive: NOT ended", () => {
    expect(decideActionEnded("a7", 12, done, [55], [55])).toBe(false);
  });

  test("the marker does not show this op completed: NOT ended", () => {
    const running = [{ atMs: 0, status: status({ opKind: "run" }) }];
    expect(decideActionEnded("a7", 12, running, [55], [])).toBe(false);
    const otherOpDone = [
      {
        atMs: 0,
        status: status({ completed: true, opAttemptId: "b9", opSeq: 3, lastCompletedOpSeq: 3 }),
      },
    ];
    expect(decideActionEnded("a7", 12, otherOpDone, [55], [])).toBe(false);
    expect(decideActionEnded("a7", 12, [{ atMs: 0, error: "timeout" }], [55], [])).toBe(false);
  });

  test("session id not exactly one positive value, or the session list unread: NOT ended", () => {
    expect(decideActionEnded("a7", 12, done, null, [])).toBe(false);
    expect(decideActionEnded("a7", 12, done, [], [])).toBe(false);
    expect(decideActionEnded("a7", 12, done, [55, 56], [])).toBe(false);
    expect(decideActionEnded("a7", 12, done, [0], [])).toBe(false);
    expect(decideActionEnded("a7", 12, done, [55], null)).toBe(false);
  });
});

describe("parseContainerEvidence", () => {
  test("reads the tagged lines among container noise; one session object or an array", () => {
    const out = [
      "BcContainerHelper version 6.1.15",
      'R236-SQL:{"table":"LC Op Progress$x","ids":55}',
      'R236-NST:{"SessionID":7,"ClientType":1}',
      "----",
    ].join("\r\n");
    expect(parseContainerEvidence(out)).toEqual({ sqlSessionIds: [55], nstSessions: [7] });
    const arr = 'R236-SQL:{"ids":[]}\nR236-NST:[{"SessionID":7},{"SessionID":9}]';
    expect(parseContainerEvidence(arr)).toEqual({ sqlSessionIds: [], nstSessions: [7, 9] });
  });

  test("an error line, a missing line or junk is null, never an empty list", () => {
    const out = "R236-SQL-ERR:expected one LC Op Progress table, found 0\nR236-NST:not json";
    expect(parseContainerEvidence(out)).toEqual({ sqlSessionIds: null, nstSessions: null });
    expect(parseContainerEvidence("")).toEqual({ sqlSessionIds: null, nstSessions: null });
  });
});
