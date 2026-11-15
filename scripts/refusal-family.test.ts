import { describe, expect, test } from "bun:test";
import {
  BASE_ID,
  BC_UNAVAILABLE_TABLES,
  DOTNET_NO_OBJECT,
  type Family,
  GET_URL,
  NO_CLIENT,
  PERMISSION_DENIAL,
  PLATFORM_TABLE_READ,
  UNTOUCHED_HANDLE,
  bcCheckApp,
  bcCheckFamily,
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

  test("PR-02: a DotNet member's refusal folds to its cause, over every type; another DotNet cause stays apart", () => {
    const t = (m: string, cause: string) => `DotNet ${m}: '${m}' ${cause}`;
    const none = "is an instance member and the variable holds no object";
    expect(classOf(t("System.Uri.Host", none))).toBe(`DotNet *: ${none}`);
    expect(classOf(t("System.Text.StringBuilder.Append", none))).toBe(`DotNet *: ${none}`);
    expect(classOf(t("System.Uri.Host", "is not found on System.Uri"))).toBe(
      "DotNet *: is not found on System.Uri",
    );
    // review: a DotNet text of another shape (no quoted member) stays its own class, so it reads NEW, never known
    const overload =
      "DotNet System.Text.RegularExpressions.Regex.IsMatch: System.Text.RegularExpressions.Regex.IsMatch has no overload taking 1 argument(s) of the given types (String)";
    expect(classOf(overload)).toBe("DotNet System.Text.RegularExpressions.Regex.IsMatch");
    const o = classify(DOTNET_NO_OBJECT, [
      row(0, "error", `NotRun: out-of-scope: ${overload}`, true),
    ]);
    expect(refusalClasses(DOTNET_NO_OBJECT, o)[0]?.known).toBe(false);
    const f = DOTNET_NO_OBJECT;
    const r = classify(f, [
      row(0, "error", `NotRun: out-of-scope: ${t("System.Regex.IsMatch", none)}`, true),
    ]);
    expect(refusalClasses(f, r)[0]?.known).toBe(true);
  });

  test("PR-02: the DotNet family is an OnPrem app; every handle type is declared; untouched-handle has no target", () => {
    const f = DOTNET_NO_OBJECT;
    for (const c of f.cells) expect(f.handles[c.type]).toBeDefined();
    expect(JSON.parse(emitApp(f)["app.json"] ?? "{}").target).toBe("OnPrem");
    expect(JSON.parse(emitApp(UNTOUCHED_HANDLE)["app.json"] ?? "{}").target).toBeUndefined();
  });

  test("PR-13: a platform table's no-provider text folds to one class, with or without `store error `; the issue's text is known", () => {
    const np = (t: string, id: number) => `platform table '${t}' (${id}) has no provider`;
    expect(classOf(np("Api Web Service", 2000000193))).toBe("platform table *: has no provider");
    expect(classOf(`store error ${np("Tenant Media Set", 2000000183)}`)).toBe(
      "platform table *: has no provider",
    );
    const f = PLATFORM_TABLE_READ;
    const r = classify(f, [
      row(0, "error", `NotRun: out-of-scope: store error ${np("Object", 2000000001)}`, true),
    ]);
    expect(refusalClasses(f, r)[0]?.known).toBe(true);
  });

  test("PR-13: a read's refusal drops `store error ` and the read verb, so IsEmpty and FindFirst on a table are one class", () => {
    const why = "BC holds rows here that an install trigger or Company-Initialize creates";
    expect(classOf(`IsEmpty on Power BI Blob: ${why}`)).toBe("* on Power BI Blob");
    expect(classOf(`store error FindFirst on Power BI Blob: ${why}`)).toBe("* on Power BI Blob");
    expect(classOf("FindSet on Media: x")).toBe("* on Media");
  });

  test("PR-13: the platform-table family reads every listed table twice; handles are declared; names are unique", () => {
    const f = PLATFORM_TABLE_READ;
    expect(f.cells.length).toBe(2 * 214);
    for (const c of f.cells) expect(f.handles[c.type]).toBeDefined();
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    expect(f.handles.TApiWebService).toBe('R: Record "Api Web Service";');
  });

  test("PR-16: a permission denial folds over the object it names; the issue's text is known for any table", () => {
    const deny = (id: number) =>
      `a permission denial (read permission on object type 1 id ${id}) whose error is not pinned yet (on a system table; probe P13 pins Tenant Media only); the test is not run`;
    expect(classOf(deny(2000000120))).toBe(classOf(deny(2000000005)));
    expect(classOf(deny(2000000120))).toContain("on object type * id *)");
    const f = PERMISSION_DENIAL;
    const r = classify(f, [row(0, "error", `NotRun: out-of-scope: ${deny(2000000120)}`, true)]);
    expect(refusalClasses(f, r)[0]?.known).toBe(true);
  });

  test("PR-16: a set's rows read through a system table fold to their reason, whichever table and set", () => {
    const why = "grants a whole object type (not listed row by row)";
    expect(classOf(`Permission: permission set 'All Objects': \`table * = X\` ${why}`)).toBe(
      `*: permission set *: ${why}`,
    );
    expect(
      classOf(`store error Metadata Permission: permission set 'Base': \`table * = X\` ${why}`),
    ).toBe(`*: permission set *: ${why}`);
  });

  test("PR-16: the permission-denial family depends on Permissions Mock; both sets are emitted; every cell sets one", () => {
    const f = PERMISSION_DENIAL;
    expect(f.cells.length).toBe(4 * 83);
    for (const c of f.cells) expect(f.handles[c.type]).toBeDefined();
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const files = emitApp(f);
    expect(JSON.parse(files["app.json"] ?? "{}").dependencies[0].name).toBe("Permissions Mock");
    const al = files["src/Cells.al"] ?? "";
    expect(al).toContain('permissionset 51000 "Cell No Grant"');
    expect(al).toContain('tabledata "User" = R');
    expect(f.cells.filter((c) => c.state === "denied").length).toBe(2 * 83);
    expect(
      f.cells.every((c) => /PermissionsMock\.Set\('Cell (No Grant|Grant Read)'\)/.test(c.call)),
    ).toBe(true);
  });

  test("PR-17: a cell's handlers are bound and emitted; a cell with no var has no var block", () => {
    const h =
      "    [ConfirmHandler]\n    procedure OnConfirm(Question: Text[1024]; var Reply: Boolean)\n    begin\n    end;\n";
    const f: Family = {
      name: "t",
      issue: "",
      known: [],
      support: "",
      handles: {},
      cells: [
        {
          type: "Dialog",
          method: "Confirm",
          state: "handler",
          call: "if Confirm('x') then;",
          handlers: [h],
        },
        { type: "Session", method: "GuiAllowed", state: "noclient", call: "if GuiAllowed() then;" },
      ],
    };
    const al = emitApp(f)["src/Cells.al"] ?? "";
    const [first, second] = al.split(/\ncodeunit /).slice(1);
    expect(first).toContain("[HandlerFunctions('OnConfirm')]\n    [Test]");
    expect(first).toContain("procedure OnConfirm(Question");
    expect(second).not.toContain("HandlerFunctions");
    expect(second).not.toContain("var");
  });

  test("PR-17: the no-client family runs with --no-client; every UI call has a cell without its handler; handlers are whole procedures", () => {
    const f = NO_CLIENT;
    expect(f.args).toEqual(["--no-client"]);
    for (const c of f.cells) {
      expect(
        f.handles[c.type] !== undefined || ["Session", "Dialog", "Report"].includes(c.type),
      ).toBe(true);
      for (const h of c.handlers ?? []) expect(h).toMatch(/^ {4}\[\w+\]\n {4}procedure \w+\(/);
    }
    const handled = new Set(
      f.cells.filter((c) => c.state === "handler").map((c) => `${c.type}.${c.method}`),
    );
    for (const k of handled)
      expect(f.cells.some((c) => `${c.type}.${c.method}` === k && c.state === "nohandler")).toBe(
        true,
      );
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("PR-17: a BC-check app has its own id per family and leaves out the tables BC 28 rejects", () => {
    const ids = [
      UNTOUCHED_HANDLE,
      DOTNET_NO_OBJECT,
      PLATFORM_TABLE_READ,
      PERMISSION_DENIAL,
      NO_CLIENT,
      GET_URL,
    ].map((f) => bcCheckApp(f).id);
    // review: pinned, because /coord/handoff/PR-17/bc-check hands these ids to lethal-bugs; a reordered FAMILIES must go red
    // (PR-26: get-url appended as 6, /coord/handoff/PR-26/bc-check)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6].map((n) => `51000000-0000-4000-8000-00000005100${n}`));
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const kept = bcCheckFamily(PLATFORM_TABLE_READ);
    expect(BC_UNAVAILABLE_TABLES.size).toBe(26);
    expect(kept.cells.length).toBe(2 * (214 - 26));
    expect(kept.cells.some((c) => c.type === "TNAVApp")).toBe(false);
    expect(kept.cells.some((c) => c.type === "TApiWebService")).toBe(true);
    expect(bcCheckFamily(NO_CLIENT).cells.length).toBe(NO_CLIENT.cells.length);
    const app = JSON.parse(emitApp(kept, bcCheckApp(PLATFORM_TABLE_READ))["app.json"] ?? "{}");
    expect(app.name).toBe("LethAL BC Check platform-table-read");
  });

  test("PR-26: the get-url family: 11 client types by 9 forms, each cell carries its URL out, unique names", () => {
    const f = GET_URL;
    expect(f.cells).toHaveLength(99);
    for (const c of f.cells) expect(c.call).toMatch(/^Error\('GETURL %1', GetUrl\(ClientType::\w+/);
    // a form with a record inserts it first; one with UseFilters also filters
    const filters = f.cells.find((c) => c.method === "PageFilters");
    expect(filters?.setup).toContain("Row.SetRange(Code, 'A');");
    expect(f.cells.filter((c) => c.method === "Plain").every((c) => c.setup === undefined)).toBe(
      true,
    );
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("PR-26: classOf folds a GetUrl text's client type, argument count and object type, keeping its reason", () => {
    const known = classOf(
      "GetUrl(ClientType::ODataV4; the call had 5 arguments): this object type or argument list (not pinned)",
    );
    expect(known).toBe("GetUrl(*): this object type or argument list");
    // edge-5a58a0f16 drops "(not pinned)": the same class
    expect(
      classOf(
        "GetUrl(ClientType::Api; the call had 4 arguments): this object type or argument list",
      ),
    ).toBe(known);
    expect(
      classOf(
        "GetUrl(ClientType::Default or Windows) of object type Codeunit with 4 arguments (only a page or a report are pinned)",
      ),
    ).toBe(
      classOf(
        "GetUrl(ClientType::Default or Windows) of object type Query with 4 arguments (only a page or a report are pinned)",
      ),
    );
    // a different reason is a different class
    expect(
      classOf("GetUrl(ClientType::SOAP; the call had 2 arguments): a company of other characters"),
    ).not.toBe(known);
  });
});
