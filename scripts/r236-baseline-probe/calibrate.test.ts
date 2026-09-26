import { describe, expect, test } from "bun:test";
import { type RoundData, aggregate, judgeRound, parseCalibration } from "./calibrate";

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const opts = { recentMs: 10 * 60_000, tolMs: 5_000 };
const base = (over: Partial<RoundData>): RoundData => ({
  at: T0 + 60_000,
  user: "admin",
  burst: { start: T0 + 50_000, end: T0 + 58_000, calls: 100, errors: 0 },
  nst: [],
  active: [],
  finished: [{ sessionId: 41, attemptId: "a1", opSeq: 3, startedAt: T0 }],
  events: [],
  ...over,
});

describe("judgeRound: pooling (a), from the cmdlet list", () => {
  test("a recently finished op's session listed with a login before the op: pooled", () => {
    const r = judgeRound(base({ nst: [{ id: 41, user: "ADMIN", login: T0 - 1_000 }] }), opts);
    expect(r.pooling).toBe("pooled");
  });
  test("not listed: not pooled; listed but logged in AFTER the op (id reused): not pooled", () => {
    expect(judgeRound(base({ nst: [{ id: 9, user: "x", login: T0 }] }), opts).pooling).toBe(
      "not pooled",
    );
    expect(
      judgeRound(base({ nst: [{ id: 41, user: "x", login: T0 + 30_000 }] }), opts).pooling,
    ).toBe("not pooled");
  });
  test("no recent finished op, an unread list, or a listed id with no login time: not determinable", () => {
    expect(judgeRound(base({ at: T0 + 60 * 60_000, nst: [] }), opts).pooling).toBe(
      "not determinable",
    );
    expect(judgeRound(base({ nst: null }), opts).pooling).toBe("not determinable");
    expect(judgeRound(base({ nst: [{ id: 41, user: null, login: null }] }), opts).pooling).toBe(
      "not determinable",
    );
  });
});

describe("judgeRound: the Active Session soundness criteria (b)", () => {
  const live = { id: 77, user: "DOMAIN\\admin", login: T0 + 55_000 };

  test("finished disappears: sound when the finished op's session is absent from a NON-empty scoped table", () => {
    expect(judgeRound(base({ active: [live] }), opts).finishedDisappears).toBe("sound");
    const stays = judgeRound(
      base({ active: [live, { id: 41, user: "admin", login: T0 - 1 }] }),
      opts,
    );
    expect(stays.finishedDisappears).toBe("not sound");
    // an empty table proves nothing: absent from nothing is not "disappeared"
    expect(judgeRound(base({ active: [] }), opts).finishedDisappears).toBe("not determinable");
    expect(judgeRound(base({ active: null }), opts).finishedDisappears).toBe("not determinable");
  });

  test("live stays: sound only when a row of OUR user logged in during the burst is present", () => {
    expect(judgeRound(base({ active: [live] }), opts).liveStays).toBe("sound");
    const otherUser = { ...live, user: "someone" };
    expect(judgeRound(base({ active: [otherUser] }), opts).liveStays).toBe("not determinable");
    const beforeBurst = { ...live, login: T0 };
    expect(judgeRound(base({ active: [beforeBurst] }), opts).liveStays).toBe("not determinable");
  });

  test("ids match: the latest Logon event for the finished op's session id, before the op, is our user", () => {
    const logon = (user: string) => ({ sessionId: 41, type: 0, at: T0 - 2_000, user });
    expect(judgeRound(base({ events: [logon("admin")] }), opts).idsMatch).toBe("sound");
    expect(
      judgeRound(base({ events: [logon("admin"), { ...logon("bob"), at: T0 - 500 }] }), opts)
        .idsMatch,
    ).toBe("not sound");
    expect(judgeRound(base({ events: [] }), opts).idsMatch).toBe("not determinable");
    const after = { ...logon("admin"), at: T0 + 60_000 };
    expect(judgeRound(base({ events: [after] }), opts).idsMatch).toBe("not determinable");
  });
});

describe("aggregate", () => {
  test("any 'not sound' wins, then any 'sound'; the control is sound only if all three are", () => {
    const s = {
      pooling: "not pooled",
      finishedDisappears: "sound",
      liveStays: "sound",
      idsMatch: "sound",
    } as const;
    expect(aggregate([s, { ...s, liveStays: "not determinable" }]).activeSessionControl).toBe(
      "sound",
    );
    expect(aggregate([s, { ...s, finishedDisappears: "not sound" }]).activeSessionControl).toBe(
      "not sound",
    );
    expect(aggregate([{ ...s, idsMatch: "not determinable" }]).activeSessionControl).toBe(
      "not determinable",
    );
    expect(aggregate([s, { ...s, pooling: "pooled" }]).pooling).toBe("pooled");
  });
});

describe("parseCalibration", () => {
  test("reads the tagged lines; server times without a zone are UTC; a failed read is null", () => {
    const out = [
      "noise",
      'R236-NST:[{"SessionID":41,"UserID":"admin","Login":"2026-09-26T09:59:59.0000000Z"}]',
      'R236-ACTIVE:{"sid":77,"user":"admin","login":"2026-09-26T10:00:55.000"}',
      'R236-FIN:[{"sid":41,"aid":"a1","seq":3,"started":"2026-09-26T10:00:00.000"}]',
      "R236-EVT-ERR:Invalid object name",
    ].join("\n");
    // bun test runs in UTC, where reading a zoneless time as local would pass by accident.
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Copenhagen";
    let p: ReturnType<typeof parseCalibration>;
    try {
      p = parseCalibration(out);
    } finally {
      if (tz === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = tz;
    }
    expect(p.nst).toEqual([{ id: 41, user: "admin", login: T0 - 1_000 }]);
    expect(p.active).toEqual([{ id: 77, user: "admin", login: T0 + 55_000 }]);
    expect(p.finished).toEqual([{ sessionId: 41, attemptId: "a1", opSeq: 3, startedAt: T0 }]);
    expect(p.events).toBeNull();
  });
});
