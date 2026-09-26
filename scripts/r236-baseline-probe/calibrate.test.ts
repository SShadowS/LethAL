import { describe, expect, test } from "bun:test";
import {
  type RoundData,
  aggregate,
  calibrationScript,
  clientTypeMap,
  judgeRound,
  parseCalibration,
  readerIds,
} from "./calibrate";

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
  const live = { id: 77, user: "DOMAIN\\admin", login: T0 + 55_000, clientType: "10" };
  // the cmdlet's own view of the same session: its ClientType NAME is what says "OData"
  const liveNst = [{ id: 77, user: "admin", login: null, clientType: "ODataV4" }];

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

  test("live stays: sound only for an OData row (named so by the cmdlet) of OUR user logged in during the burst", () => {
    expect(judgeRound(base({ active: [live], nst: liveNst }), opts).liveStays).toBe("sound");
    const otherUser = { ...live, user: "someone" };
    expect(judgeRound(base({ active: [otherUser], nst: liveNst }), opts).liveStays).toBe(
      "not determinable",
    );
    const beforeBurst = { ...live, login: T0 };
    expect(judgeRound(base({ active: [beforeBurst], nst: liveNst }), opts).liveStays).toBe(
      "not determinable",
    );
  });

  test("calibration 2: the reader's own management session is never a live-stays proof", () => {
    // measured: sid -5024, Active Session Client Type 2, the cmdlet says "Windows", login in the burst
    const reader = { id: -5024, user: "admin", login: T0 + 51_000, clientType: "2" };
    const readerNst = [{ id: -5024, user: "admin", login: null, clientType: "Windows" }];
    const r = base({ active: [reader], nst: readerNst });
    expect(judgeRound(r, opts).liveStays).toBe("not determinable");
    expect(readerIds(r, opts.tolMs)).toEqual([-5024]);
    // an Active Session row the cmdlet does not list cannot be confirmed OData: not a proof either
    expect(judgeRound(base({ active: [live], nst: [] }), opts).liveStays).toBe("not determinable");
    expect(clientTypeMap(r)).toEqual([
      { sessionId: -5024, tableClientType: "2", cmdletClientType: "Windows" },
    ]);
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
      'R236-NST:[{"SessionID":41,"UserID":"admin","ClientType":"Windows","Login":"2026-09-26T09:59:59.0000000Z"}]',
      'R236-ACTIVE:{"sid":77,"user":"admin","ct":2,"login":"2026-09-26T10:00:55.000"}',
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
    expect(p.nst).toEqual([{ id: 41, user: "admin", login: T0 - 1_000, clientType: "Windows" }]);
    expect(p.active).toEqual([{ id: 77, user: "admin", login: T0 + 55_000, clientType: "2" }]);
    expect(p.finished).toEqual([{ sessionId: 41, attemptId: "a1", opSeq: 3, startedAt: T0 }]);
    expect(p.events).toBeNull();
  });
});

describe("calibration 2: Session Event is scoped by server instance ID", () => {
  test("the Session Event read never names a Server Instance Name column and prints its scope", () => {
    const text = calibrationScript("default");
    const evt = text.slice(text.indexOf("'R236-COLS:Session Event:'"));
    expect(evt).not.toContain("[Server Instance Name]");
    expect(evt).toContain("[Server Instance ID] = $instId");
    expect(evt).toContain("'R236-EVT-SCOPE:'");
  });
});
