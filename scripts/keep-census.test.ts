import { describe, expect, test } from "bun:test";
import {
  KIT_AL,
  KIT_FROM,
  KIT_TO,
  STATE_VAR,
  WRITES,
  emitCensusApp,
  groupClasses,
  judge,
  pickRefusers,
  usesKitIds,
  withKit,
} from "./keep-census";
import { BASE_ID, type CellResult, FAMILIES, type Family } from "./refusal-family";

// PR-54: the census mode's pure parts. No al-runner runs here and nothing is written.
const ids = (al: string) =>
  [...al.matchAll(/^(?:table|codeunit|page|report)\s+(\d+)\s/gm)].map((m) => Number(m[1]));

describe("kit ids", () => {
  test("the kit's own objects sit inside 50940-50999", () => {
    const own = ids(KIT_AL);
    expect(own.length).toBe(4);
    for (const n of own) expect(n >= KIT_FROM && n <= KIT_TO).toBe(true);
  });
  test("no family's objects use a kit id, and every cell id is above the range", () => {
    for (const f of Object.values(FAMILIES)) {
      const al = emitCensusApp(f)["src/Cells.al"] ?? "";
      const all = ids(al.replace(KIT_AL, ""));
      expect(all.length).toBeGreaterThan(0);
      for (const n of all) expect(n > KIT_TO).toBe(true);
      expect(usesKitIds(al.replace(KIT_AL, ""))).toBe(false);
    }
  });
  test("usesKitIds sees an id in the range and ignores one outside it", () => {
    expect(usesKitIds('codeunit 50942 "X"\n{')).toBe(true);
    expect(usesKitIds('codeunit 51000 "X"\n{')).toBe(false);
  });
  test("app.json takes the kit's range and the resource folder", () => {
    const j = JSON.parse(emitCensusApp(Object.values(FAMILIES)[0] as Family)["app.json"] ?? "{}");
    expect(j.idRanges).toContainEqual({ from: KIT_FROM, to: KIT_TO });
    expect(j.resourceFolders).toContain("LethALResources");
  });
});

describe("writes", () => {
  test("every cell of every family starts with the standard writes, before its own setup", () => {
    for (const f of Object.values(FAMILIES)) {
      const k = withKit(f);
      expect(k.cells.length).toBe(f.cells.length);
      k.cells.forEach((c, i) => {
        expect(c.setup?.[0]).toBe(WRITES);
        expect(c.setup?.slice(1)).toEqual([...(f.cells[i]?.setup ?? [])]);
        expect(c.vars).toContain(STATE_VAR);
      });
    }
  });
  test("the emitted AL calls the writes before the cell's call", () => {
    const al = emitCensusApp(Object.values(FAMILIES)[0] as Family)["src/Cells.al"] ?? "";
    const at = al.indexOf(`codeunit ${BASE_ID + 1} `);
    const body = al.slice(at);
    expect(body.indexOf(WRITES)).toBeGreaterThan(-1);
    expect(body.indexOf(WRITES)).toBeLessThan(body.indexOf("end;"));
  });
});

describe("classes", () => {
  const cell = (m: string): CellResult => ({
    cell: { type: "T", method: "M", state: "s", call: "x" },
    outcome: "refused",
    message: m,
  });
  const pass: CellResult = {
    cell: { type: "T", method: "M", state: "s", call: "x" },
    outcome: "pass",
  };
  test("refusals group by the generator's class key, ids follow the cell index, passes drop out", () => {
    const g = groupClasses(
      [
        cell("RecordRef.FindSet on a RecordRef that is not open"),
        pass,
        cell("RecordRef.FieldCount on a RecordRef that is not open"),
        cell("Other thing: x"),
      ],
      BASE_ID,
    );
    expect([...g.keys()].sort()).toEqual([
      "Other thing",
      "RecordRef.* on a RecordRef that is not open",
    ]);
    expect(g.get("RecordRef.* on a RecordRef that is not open")?.map((c) => c.id)).toEqual([
      BASE_ID + 1,
      BASE_ID + 3,
    ]);
  });
  test("pickRefusers takes up to 3, different texts first", () => {
    const r = ["a", "a", "a", "b", "c"].map((text, i) => ({ text, i }));
    expect(pickRefusers(r).map((x) => x.i)).toEqual([0, 3, 4]);
    expect(pickRefusers(r.slice(0, 2)).map((x) => x.i)).toEqual([0, 1]);
  });
});

describe("judge", () => {
  const ctl =
    "OBS rows=0 txt=[] sb=[null] iso=absent seq=No workdate=x env=[] lang=1033 dotnet=[len=2 b64=QUI=]";
  const ok = {
    control: ctl,
    coldReader: ctl,
    keptReaders: [ctl, ctl],
    freshReaders: [ctl],
    refusedInServe: 3,
    pids: [7, 7],
    panics: [],
    keptAliveAtEnd: true,
  };
  test("equal readers, one pid, no panic is CLEAN", () => expect(judge(ok).verdict).toBe("CLEAN"));
  test("a differing kept reader is NOT CLEAN", () =>
    expect(judge({ ...ok, keptReaders: [ctl, `${ctl}x`] }).verdict).toBe("NOT CLEAN"));
  test("a differing fresh reader is NOT CLEAN", () =>
    expect(judge({ ...ok, freshReaders: ["OBS other"] }).verdict).toBe("NOT CLEAN"));
  test("a pid change, a panic or a dead daemon is NOT CLEAN", () => {
    expect(judge({ ...ok, pids: [7, 8] }).verdict).toBe("NOT CLEAN");
    expect(judge({ ...ok, panics: ["x: panicked"] }).verdict).toBe("NOT CLEAN");
    expect(judge({ ...ok, keptAliveAtEnd: false }).verdict).toBe("NOT CLEAN");
  });
  test("no refusal seen, or no control, is NOT MEASURED, never CLEAN", () => {
    expect(judge({ ...ok, refusedInServe: 0 }).verdict).toBe("NOT MEASURED");
    expect(judge({ ...ok, control: undefined }).verdict).toBe("NOT MEASURED");
    expect(judge({ ...ok, keptReaders: [] }).verdict).toBe("NOT MEASURED");
  });
});
