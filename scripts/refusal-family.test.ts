import { describe, expect, test } from "bun:test";
import {
  BASE_ID,
  type Family,
  UNTOUCHED_HANDLE,
  cellName,
  classOf,
  classify,
  emitApp,
  refusalClasses,
  refusalText,
} from "./refusal-family";

// PR-01: the generator's pure parts. No al-runner runs here.
const F: Family = {
  name: "t",
  issue: "https://example.invalid/1",
  known: ["RecordRef.FieldCount on a RecordRef that is not open"],
  support: "",
  handles: { RecordRef: "RR: RecordRef;", XmlElement: "E: XmlElement;" },
  cells: [
    {
      type: "RecordRef",
      method: "FieldCount",
      state: "untouched",
      vars: ["I: Integer;"],
      call: "I := RR.FieldCount();",
    },
    {
      type: "RecordRef",
      method: "FindSet",
      state: "untouched",
      vars: ["B: Boolean;"],
      call: "B := RR.FindSet();",
    },
    {
      type: "XmlElement",
      method: "InnerXml",
      state: "untouched",
      vars: ["T: Text;"],
      call: "T := E.InnerXml();",
    },
    {
      type: "RecordRef",
      method: "Number",
      state: "untouched",
      vars: ["I: Integer;"],
      call: "I := RR.Number();",
    },
  ],
};
const row = (i: number, status: string, message?: string, notRun?: boolean) => ({
  name: `Codeunit${BASE_ID + 1 + i}.Cell`,
  status,
  ...(message !== undefined ? { message } : {}),
  ...(notRun === true ? { notRun } : {}),
});
const NP = " (not pinned)";

describe("PR-01: the refusal-family generator", () => {
  test("the app holds one test codeunit per cell, each with its handle, vars and call, ids in the app's range", () => {
    const files = emitApp(F);
    const al = files["src/Cells.al"] ?? "";
    expect((al.match(/Subtype = Test;/g) ?? []).length).toBe(F.cells.length);
    expect(al).toContain(`codeunit ${BASE_ID + 1} "C0 RecordRef FieldCount"`);
    expect(al).toContain("RR: RecordRef;\n        I: Integer;");
    expect(al).toContain("I := RR.FieldCount();");
    const app = JSON.parse(files["app.json"] ?? "{}");
    expect(app.idRanges[0].to).toBeGreaterThanOrEqual(BASE_ID + F.cells.length);
  });

  test("a cell name fits AL's 30 characters; a non-untouched state is named", () => {
    expect(
      cellName({ type: "RecordRef", method: "SetLoadFields", state: "untouched", call: "" }, 53)
        .length,
    ).toBeLessThanOrEqual(30);
    expect(cellName({ type: "RecordRef", method: "Field", state: "closed", call: "" }, 1)).toBe(
      "C1 RecordRef Field closed",
    );
  });

  test("classify: pass, fail with its message, refused with v3's text, and a cell with no row is missing (never a pass)", () => {
    const r = classify(F, [
      row(
        0,
        "error",
        `NotRun: out-of-scope: RecordRef.FieldCount on a RecordRef that is not open: x${NP}`,
        true,
      ),
      row(1, "fail", "The record is not open."),
      row(3, "pass"),
    ]);
    expect(r.map((x) => x.outcome)).toEqual(["refused", "fail", "missing", "pass"]);
    expect(r[0]?.message).toBe("RecordRef.FieldCount on a RecordRef that is not open: x");
    expect(r[1]?.message).toBe("The record is not open.");
  });

  test("classOf: the method becomes *, the explanation after ': ' goes", () => {
    expect(
      classOf("RecordRef.FindSet on a RecordRef that is not open: BC's error text ... not pinned"),
    ).toBe("RecordRef.* on a RecordRef that is not open");
    expect(classOf("use of an unassigned XmlElement")).toBe("use of an unassigned XmlElement");
    expect(refusalText(`NotRun: out-of-scope: use of an unassigned XmlElement${NP}`)).toBe(
      "use of an unassigned XmlElement",
    );
  });

  test("a refusal whose class the issue names is known; another method of that class too; a new class is NEW", () => {
    const r = classify(F, [
      row(
        0,
        "error",
        "NotRun: out-of-scope: RecordRef.FieldCount on a RecordRef that is not open: x",
        true,
      ),
      row(
        1,
        "error",
        "NotRun: out-of-scope: RecordRef.FindSet on a RecordRef that is not open: y",
        true,
      ),
      row(2, "error", "NotRun: out-of-scope: use of an unassigned XmlElement", true),
      row(3, "pass"),
    ]);
    const c = refusalClasses(F, r);
    expect(c).toEqual([
      {
        text: "use of an unassigned XmlElement",
        known: false,
        cells: ["XmlElement.InnerXml (untouched)"],
      },
      {
        text: "RecordRef.* on a RecordRef that is not open",
        known: true,
        cells: ["RecordRef.FieldCount (untouched)", "RecordRef.FindSet (untouched)"],
      },
    ]);
  });

  test("review: v3's refusal marker in a plain fail row is a refusal; a timeout row is neither refusal nor score", () => {
    const r = classify(F, [
      row(0, "fail", "Runtime error: NotRun: out-of-scope: use of an unassigned XmlElement"),
      row(1, "error", "Test exceeded 60s timeout.", true),
    ]);
    expect(r[0]?.outcome).toBe("refused");
    expect(r[0]?.message).toBe("use of an unassigned XmlElement");
    expect(r[1]?.outcome).toBe("timeout");
    expect(refusalClasses(F, r).map((c) => c.text)).toEqual(["use of an unassigned XmlElement"]);
  });

  test("the untouched-handle family: every cell's handle type is declared, and names are unique", () => {
    const f = UNTOUCHED_HANDLE;
    for (const c of f.cells) expect(f.handles[c.type]).toBeDefined();
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });
});
