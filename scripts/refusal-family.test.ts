import { describe, expect, test } from "bun:test";
import {
  BASE_ID,
  BC_UNAVAILABLE_TABLES,
  type CellResult,
  DATES_FORMULAS,
  DOTNET_EXCEPTION,
  DOTNET_EXCEPTION_RSA,
  DOTNET_NO_OBJECT,
  FAMILIES,
  FIELDREF_CONVERT,
  FORMAT_EVALUATE,
  FORMAT_REGION,
  type Family,
  GET_URL,
  JSON_TEXT,
  LANGUAGE_REGION,
  NO_CLIENT,
  PERMISSION_DENIAL,
  PLATFORM_TABLE_READ,
  PUBAPP_FLOWFIELD,
  READ_TEST,
  RECORD_FILTERS,
  SET_TEST,
  T9_REFUSALS,
  T10_REFUSALS,
  T12_REFUSALS,
  TABLE_CONNECTION,
  UNTOUCHED_HANDLE,
  X2_REFUSALS,
  X3_REFUSALS,
  Y1_REFUSALS,
  Y2_COLLATION,
  Y2_XML,
  bcCheckApp,
  bcCheckFamily,
  cellName,
  checkReportCells,
  classOf,
  classify,
  emitApp,
  joinCells,
  joinCounts,
  joinTsv,
  normalizeMessage,
  parseBcTsv,
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
      TABLE_CONNECTION,
      DOTNET_EXCEPTION,
      DOTNET_EXCEPTION_RSA,
      PUBAPP_FLOWFIELD,
    ].map((f) => bcCheckApp(f).id);
    // review: pinned, because /coord/handoff/PR-17/bc-check hands these ids to lethal-bugs; a reordered FAMILIES must go red
    // (PR-26: get-url appended as 6; PR-30: table-connection is 8, as 7 is PR-27's hand-written number-sequence app; PR-32:
    // dotnet-exception is 9; PR-33: dotnet-exception-rsa 10, pubapp-flowfield 11)
    expect(ids).toEqual(
      [1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map(
        (n) => `51000000-0000-4000-8000-0000000510${String(n).padStart(2, "0")}`,
      ),
    );
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
    // `refusalText` strips "(not pinned)" before a run's texts reach classOf: the same class either way
    expect(
      classOf(
        "GetUrl(ClientType::Api; the call had 4 arguments): this object type or argument list",
      ),
    ).toBe(known);
    // edge-5a58a0f16's own Default/Windows text: one class whichever object type and count it names
    const dw = (o: string, n: number) =>
      `GetUrl(ClientType::Default or Windows) of object type ${o} with ${n} arguments (only a page or a report, and a page with a record and UseFilters false, or true for Default, are pinned)`;
    expect(classOf(dw("Codeunit", 4))).toBe(classOf(dw("Query", 4)));
    expect(classOf(dw("Page", 5))).toBe(classOf(dw("Codeunit", 4)));
    // a different reason is a different class
    expect(
      classOf("GetUrl(ClientType::SOAP; the call had 2 arguments): a company of other characters"),
    ).not.toBe(known);
  });

  test("PR-30: the table-connection family: 5 strings by 3 operations, 5 CRM row and 2 trigger cells, one control string", () => {
    const f = TABLE_CONNECTION;
    expect(f.cells).toHaveLength(22);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051008");
    // the exact marker is the pinned control; every other string differs from it
    const marker = f.cells.filter((c) => c.type === "Connection" && c.state === "Marker");
    expect(marker.map((c) => c.method)).toEqual(["Register", "SetDefault", "Unregister"]);
    for (const c of marker) expect([...(c.setup ?? []), c.call].join(" ")).toContain("'@@test@@'");
    // review: BC keeps a connection for the session and refuses a second registration of a name, so each cell registers
    // its own name, after unregistering a leftover of it; a CRM cell then sets that name as the default
    const registered = f.cells.map((c) => {
      const all = [...(c.setup ?? []), c.call].join("\n");
      const name = /RegisterTableConnection\(TableConnectionType::CRM, '(\w+)'/.exec(all)?.[1];
      expect(c.setup?.[0]).toBe(
        `if HasTableConnection(TableConnectionType::CRM, '${name}') then UnregisterTableConnection(TableConnectionType::CRM, '${name}');`,
      );
      if (c.type.startsWith("CRM")) {
        expect(c.setup?.[1]).toBe(
          `RegisterTableConnection(TableConnectionType::CRM, '${name}', '@@test@@');`,
        );
        expect(c.setup?.[2]).toBe(
          `SetDefaultTableConnection(TableConnectionType::CRM, '${name}');`,
        );
      }
      return name;
    });
    expect(new Set(registered).size).toBe(22);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("PR-30 review: every family's BC-check app id is unique and none takes 7 (PR-27's hand-written app)", () => {
    const ns = Object.values(FAMILIES).map((f) => Number(bcCheckApp(f).id.slice(-2)));
    expect(new Set(ns).size).toBe(ns.length);
    expect(ns).not.toContain(7);
  });

  test("PR-32: the dotnet-exception family: 14 sites in a guarded and a text shape, 3 controls", () => {
    const f = DOTNET_EXCEPTION;
    expect(f.cells).toHaveLength(31);
    expect(f.target).toBe("OnPrem");
    const guarded = f.cells.filter((c) => c.state === "guarded");
    const text = f.cells.filter((c) => c.state === "text");
    expect(guarded).toHaveLength(14);
    expect(text).toHaveLength(14);
    // guarded: asserterror alone, so the outcome cannot depend on the text; text: the same call, then the text carried out
    for (const [i, g] of guarded.entries()) {
      expect(g.call).toMatch(/^asserterror [^;]+;$/);
      expect(text[i]?.call).toBe(`${g.call} Error('DOTNET %1', GetLastErrorText());`);
      expect(text[i]?.setup).toEqual(g.setup);
    }
    expect(
      f.cells.filter((c) => c.state === "ok").every((c) => !c.call.includes("asserterror")),
    ).toBe(true);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("PR-32: classOf folds a .NET exception's text into one class, with or without its tail, and keeps other DotNet causes apart", () => {
    const cls = "DotNet * raised the .NET exception *";
    expect(
      classOf(
        "DotNet new System.UriBuilder raised the .NET exception System.UriFormatException: Invalid URI: Invalid port specified.; the text AL would see is not pinned (ADR-014 section 7)",
      ),
    ).toBe(cls);
    expect(
      classOf(
        "DotNet System.UriBuilder.Port raised the .NET exception System.ArgumentOutOfRangeException: value ('-5') must be greater than or equal to '-1'. (Parameter 'value')",
      ),
    ).toBe(cls);
    // review: a nested type's member (`Outer+Inner.Member`), as .NET names it
    expect(
      classOf(
        "DotNet Microsoft.Cell.Outer+Inner.Run raised the .NET exception System.InvalidOperationException: x; the text AL would see is not pinned (ADR-014 section 7)",
      ),
    ).toBe(cls);
    expect(classOf(DOTNET_EXCEPTION.known[0] ?? "")).toBe(cls);
    expect(
      classOf(
        "DotNet System.Uri.AbsoluteUri: 'System.Uri.AbsoluteUri' is an instance member and the variable holds no object",
      ),
    ).not.toBe(cls);
  });

  test("PR-33: the RSA family: 7 OpenSSL sites on both RSA paths in PR-32's two shapes, and a same-padding control per path", () => {
    const f = DOTNET_EXCEPTION_RSA;
    expect(f.cells).toHaveLength(16);
    const guarded = f.cells.filter((c) => c.state === "guarded");
    const text = f.cells.filter((c) => c.state === "text");
    expect(guarded.map((c) => `${c.type}.${c.method}`)).toEqual([
      "CSP.PkcsThenOaep",
      "CSP.OaepThenPkcs",
      "CSP.PublicOnlyDecrypt",
      "CSP.PublicOnlySignData",
      "RSA.PkcsThenOaep",
      "RSA.OaepThenPkcs",
      "RSA.PublicOnlyDecrypt",
    ]);
    for (const [i, g] of guarded.entries()) {
      expect(g.call).toMatch(/^asserterror [^;]+;$/);
      expect(text[i]?.call).toBe(`${g.call} Error('DOTNET %1', GetLastErrorText());`);
    }
    // a wrong-padding site decrypts with the other padding than it encrypted with; the control with the same one
    const padding = (c: (typeof f.cells)[number]) => [
      /Encrypt\(Data, (\w+(?:\.\w+)?)\)/.exec(c.setup?.join(" ") ?? "")?.[1],
      /Decrypt\(Bytes, (\w+(?:\.\w+)?)\)/.exec(c.call)?.[1],
    ];
    for (const c of guarded.filter((c) => /Then/.test(c.method))) {
      const [enc, dec] = padding(c);
      expect(enc).toBeDefined();
      expect(enc).not.toBe(dec);
    }
    for (const c of f.cells.filter((c) => c.state === "ok")) {
      const [enc, dec] = padding(c);
      expect(enc).toBeDefined();
      expect(enc).toBe(dec);
    }
    // the public-only sites act on a key made from the other's public part only
    for (const c of guarded.filter((c) => c.method.startsWith("PublicOnly")))
      expect(c.setup?.join(" ")).toMatch(/FromXmlString\(\w+\.ToXmlString\(false\)\)/);
  });

  test("PR-33: family 10 (pubapp-flowfield): 14 reads that touch Published Application's FlowFields, each under two sets, and a control", () => {
    const f = PUBAPP_FLOWFIELD;
    expect(f.cells).toHaveLength(30);
    expect(f.dependencies?.[0]?.name).toBe("Permissions Mock");
    for (const state of ["granted", "item only"]) {
      const set = state === "granted" ? "Cell Grant PubApp" : "Cell Grant Item";
      const cells = f.cells.filter((c) => c.state === state);
      expect(cells).toHaveLength(15);
      // BC review: a codeunit without TestPermissions runs Restrictive on BC, so an Item cell applies its set (which grants
      // Cell Item RIMD) before its own Insert; a Published Application cell applies it in the call, after its filters
      for (const c of cells) {
        const body = [...(c.setup ?? []), c.call].join("\n");
        const at = body.indexOf(`PermissionsMock.Set('${set}');`);
        expect(at).toBeGreaterThanOrEqual(0);
        if (c.type === "Item") expect(at).toBeLessThan(body.indexOf("Item.Insert();"));
        else expect(c.call.startsWith(`PermissionsMock.Set('${set}');`)).toBe(true);
      }
    }
    // only the 'granted' set grants Published Application
    expect(f.support).toMatch(/"Cell Grant PubApp"[^}]*tabledata "Published Application" = R/);
    expect(f.support).not.toMatch(/"Cell Grant Item"[^}]*Published Application/);
    // every read but the control touches one of the FlowFields over a system table
    const flowFields =
      /Tenant Visible|PerTenant Or Installed|Installed|Name TV|Exists TV|Count TV|Name PerTenant|Tenant Visible Of App/;
    for (const c of f.cells.filter((c) => c.method !== "FindFirstIdOnly"))
      expect([...(c.setup ?? []), c.call].join(" ")).toMatch(flowFields);
    // review: and the control touches none
    const controls = f.cells.filter((c) => c.method === "FindFirstIdOnly");
    expect(controls).toHaveLength(2);
    for (const c of controls)
      expect([...(c.setup ?? []), c.call].join(" ")).not.toMatch(flowFields);
    expect(classOf(f.known[0] ?? "")).not.toBe(classOf(f.known[1] ?? ""));
  });
});

describe("PR-52: the format-evaluate family and its BC join", () => {
  const f = FORMAT_EVALUATE;
  const find = (type: string, method: string, state = "") => {
    const c = f.cells.find((x) => x.type === type && x.method === method && x.state === state);
    if (c === undefined) throw new Error(`no cell ${type} ${method} ${state}`);
    return c;
  };

  test("cells: about 300, unique type/method/state, every one ends in Error('V:...')", () => {
    expect(f.cells.length).toBeGreaterThan(250);
    expect(f.cells.length).toBeLessThan(600);
    const keys = f.cells.map((c) => `${c.type}|${c.method}|${c.state}`);
    expect(new Set(keys).size).toBe(keys.length);
    // a two-test cell answers in its second test
    for (const c of f.cells)
      expect((c.reader ?? c).call).toMatch(/Error\('V:\[%1(\|%2)?(\|%3)?\]', .*\);$/);
  });

  test("value encoding: text as it is, other values through Format(.., 0, 9), Evaluate as [ok|value], all inside a closing marker", () => {
    expect(find("UpperCase", "ASCII").call).toBe("Error('V:[%1]', UpperCase('abc xyz'));");
    expect(find("StrPos", "found").call).toBe(
      "Error('V:[%1]', Format(StrPos('abcabc', 'ca'), 0, 9));",
    );
    expect(find("Split", "count").call).toBe(
      "Error('V:[%1]', Format(S.Split(',').Count(), 0, 9));",
    );
    expect(find("Decimal", "Format", "zero").call).toBe("Error('V:[%1]', Format(V));");
    const e = find("Integer", "Evaluate", "valid");
    expect(e.call).toBe(
      "Ok := Evaluate(X, '42'); Error('V:[%1|%2]', Format(Ok, 0, 9), Format(X, 0, 9));",
    );
    // L2: X holds a sentinel (not any valid text of the cell) before the Evaluate
    expect(e.setup).toEqual(["X := 77;"]);
    for (const c of f.cells.filter((x) => x.method.startsWith("Evaluate")))
      expect((c.setup ?? [""])[0]).not.toBe("");
    // L3: Error's own substitution control, and the time-zone probe
    expect(find("Error", "own substitution").call).toBe("Error('V:[%1]', '%1#1#\\x');");
    expect(find("TimeZone", "probe").call).toBe(
      "Error('V:[%1]', Format(CreateDateTime(DMY2Date(1, 1, 2000), 0T), 0, 9));",
    );
    expect(find("TimeZone", "probe").depends).toBe("tz");
    expect(find("Integer", "Evaluate 9", "valid").call).toContain("Evaluate(X, '42', 9)");
    // a text-function setup statement is a setup, not a var
    const sub = find("Substring", "from 3");
    expect(sub.vars).toEqual(["S: Text;"]);
    expect(sub.setup).toEqual(["S := 'abcdef';"]);
  });

  test("groups: every value type has Format cells; Evaluate covers valid, invalid and empty text per type", () => {
    for (const t of [
      "Decimal",
      "Integer",
      "BigInteger",
      "Boolean",
      "Date",
      "Time",
      "DateTime",
      "Duration",
      "Option",
      "Guid",
      "Code",
      "Text",
    ])
      expect(f.cells.some((c) => c.type === t && c.method === "Format 0,9")).toBe(true);
    for (const t of [
      "Integer",
      "Decimal",
      "Boolean",
      "Date",
      "Time",
      "DateTime",
      "Duration",
      "Guid",
      "Option",
      "Code",
    ])
      for (const s of ["invalid", "empty"])
        expect(f.cells.some((c) => c.type === t && c.method === "Evaluate" && c.state === s)).toBe(
          !(t === "Code" && s === "invalid"),
        );
  });

  test("emit: own app id (place 12 of FAMILIES), range covers every cell, codeunit per cell", () => {
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051012");
    const files = emitApp(bcCheckFamily(f), bcCheckApp(f));
    const json = JSON.parse(files["app.json"] ?? "") as {
      id: string;
      idRanges: { from: number; to: number }[];
    };
    expect(json.id).toBe("51000000-0000-4000-8000-000000051012");
    expect(json.idRanges).toEqual([{ from: BASE_ID, to: BASE_ID + 1 + f.cells.length }]);
    const al = files["src/Cells.al"] ?? "";
    // one per cell, plus PR-63's `LR Carry Mark` support codeunit
    expect((al.match(/^codeunit \d+ /gm) ?? []).length).toBe(f.cells.length + 1);
    expect(al).toContain(`codeunit ${BASE_ID + f.cells.length} `);
    // bcCheckFamily leaves every cell in (no table cells here), so a BC id is the v3 index + 51001
    expect(bcCheckFamily(f).cells).toHaveLength(f.cells.length);
  });

  test("depends: locale on default formats, tz on DateTime cells that read the zone, nothing on locale-free cells", () => {
    expect(find("Decimal", "Format", "zero").depends).toBe("locale");
    expect(find("Decimal", "Format picture", "zero").depends).toBe("locale");
    expect(find("Integer", "Evaluate", "valid").depends).toBe("locale");
    expect(find("StrSubstNo", "integer arg").depends).toBe("locale");
    expect(find("UpperCase", "non-ASCII").depends).toBe("locale");
    expect(find("DateTime", "Format 0,9", "normal").depends).toBe("tz");
    expect(find("DateTime", "Evaluate", "iso").depends).toBe("tz");
    expect(find("DateTime", "Evaluate", "iso z").depends).toBe("locale");
    expect(find("DateTime", "Evaluate 9", "iso z").depends).toBeUndefined();
    expect(find("Decimal", "Format 0,9", "zero").depends).toBeUndefined();
    expect(find("Integer", "Evaluate 9", "valid").depends).toBeUndefined();
    expect(find("StrPos", "found").depends).toBeUndefined();
    expect(find("UpperCase", "ASCII").depends).toBeUndefined();
    expect(f.cells.filter((c) => c.depends === "tz").length).toBeGreaterThan(3);
  });

  test("parseBcTsv: id, pass|fail, message; CRLF is tolerated; a bad row or a repeated id is refused", () => {
    const m = parseBcTsv("51001\tfail\tV:[1]\n51002\tpass\t\n");
    expect(m.get(51001)).toEqual({ outcome: "fail", message: "V:[1]" });
    expect(m.get(51002)).toEqual({ outcome: "pass", message: "" });
    // M1: a CRLF file leaves no \r on the message
    const crlf = parseBcTsv("51001\tfail\tV:[1]\r\n51002\tfail\tV:[2]\r\n");
    expect(crlf.get(51001)?.message).toBe("V:[1]");
    expect(crlf.get(51002)?.message).toBe("V:[2]");
    expect(() => parseBcTsv("51001\tmaybe\tx")).toThrow("bad BC row");
    expect(() => parseBcTsv("51001\tpass\t\n51001\tpass\t")).toThrow("twice");
  });

  const cell = (method: string, depends?: "locale" | "tz") => ({
    type: "T",
    method,
    state: "s",
    call: "x",
    ...(depends !== undefined ? { depends } : {}),
  });
  const r = (
    method: string,
    outcome: CellResult["outcome"],
    message?: string,
    depends?: "locale" | "tz",
  ): CellResult => ({
    cell: cell(method, depends),
    outcome,
    ...(message !== undefined ? { message } : {}),
  });
  const bcOf = (...lines: string[]) => parseBcTsv(lines.join("\n"));

  test("join: each class from a small fixture; the depends flag shows only on a differing cell", () => {
    const results: CellResult[] = [
      r("a", "fail", "V:[1]"), // 0 equal
      r("a", "refused", "reason"), // 1 v3 refused
      r("a", "fail", "V:[1]"), // 2 different value, no flag
      r("a", "fail", "V:[1]", "locale"), // 3 different value, locale
      r("a", "fail", "boom"), // 4 different error text
      r("a", "fail", "V:[1]"), // 5 one errors, one returns
      r("a", "fail", "V:[1]", "tz"), // 6 BC trimmed
      r("a", "fail", "boom"), // 7 equal error
      r("a", "timeout"), // 8 v3 not run
      r("a", "fail", "V:[1]", "tz"), // 9 equal with a flag: no flag shown
    ];
    const bc = bcOf(
      "51001\tfail\tV:[1]",
      "51002\tfail\tV:[1]",
      "51003\tfail\tV:[2]",
      "51004\tfail\tV:[2]",
      "51005\tfail\tother",
      "51006\tfail\tboom",
      "51007\tfail\tV:[1",
      "51008\tfail\tboom",
      "51009\tfail\tx",
      "51010\tfail\tV:[1]",
    );
    const rows = joinCells(results, bc);
    expect(rows.map((x) => x.cls)).toEqual([
      "equal",
      "v3 refused",
      "different value",
      "different value",
      "different error text",
      "one errors, one returns",
      "transport-trimmed",
      "equal",
      "v3 not run",
      "equal",
    ]);
    expect(rows.map((x) => x.depends)).toEqual([
      undefined,
      undefined,
      undefined,
      "locale",
      undefined,
      undefined,
      "tz",
      undefined,
      undefined,
      undefined,
    ]);
    expect(rows[0]?.id).toBe(51001);
    expect(joinCounts(rows)).toMatchObject({
      equal: 3,
      "different value": 1,
      "different value (locale?)": 1,
      "transport-trimmed (tz?)": 1,
    });
    expect(joinTsv(rows).split("\n")[3]).toBe(
      '51004\tT a s\tdifferent value\tlocale?\tfail: "V:[1]"\tfail: "V:[2]"',
    );
  });

  test("M1: line breaks and tabs are one space on BOTH sides, so a v3 newline equals BC's space", () => {
    const rows = joinCells(
      [r("a", "fail", "V:[a\r\nb\tc]"), r("a", "fail", "V:[a\nb]"), r("a", "fail", "V:[a b]")],
      bcOf("51001\tfail\tV:[a b c]", "51002\tfail\tV:[a b]\r", "51003\tfail\tV:[a\tb]"),
    );
    expect(rows.map((x) => x.cls)).toEqual(["equal", "equal", "equal"]);
    // M2: the joined text keeps the raw answer, escapes visible
    expect(rows[0]?.v3).toBe('fail: "V:[a\\r\\nb\\tc]"');
    expect(normalizeMessage("a\r\nb\rc\n\td")).toBe("a b c  d");
  });

  test("M3: a V: message that lost its closing marker is transport-trimmed, on either side, not a different value", () => {
    const rows = joinCells(
      [r("a", "fail", "V:[abc]"), r("a", "fail", "V:[abc")],
      bcOf("51001\tfail\tV:[ab", "51002\tfail\tV:[abc]"),
    );
    expect(rows.map((x) => x.cls)).toEqual(["transport-trimmed", "transport-trimmed"]);
  });

  test("L4: a BC id outside the family's range, or a cell with no BC row, is refused", () => {
    const results = [r("a", "fail", "V:[1]"), r("a", "fail", "V:[1]")];
    expect(() => joinCells(results, bcOf("51001\tfail\tV:[1]"))).toThrow(
      "no BC row for cell 51002",
    );
    expect(() =>
      joinCells(results, bcOf("51001\tfail\tV:[1]", "51002\tfail\tV:[1]", "51003\tfail\tV:[1]")),
    ).toThrow("outside the family's");
    expect(() =>
      joinCells(results, bcOf("51000\tfail\tV:[1]", "51001\tfail\tV:[1]", "51002\tfail\tV:[1]")),
    ).toThrow("outside the family's");
  });

  test("lang1030: 28 cells set Danish first, each locale-flagged and labelled; the Windows-language probe is not one of them", () => {
    const lang = f.cells.slice(0, 326).filter((c) => c.state.startsWith("lang1030"));
    expect(lang).toHaveLength(28);
    for (const c of lang) {
      expect((c.setup ?? [])[0]).toBe("GlobalLanguage(1030);");
      expect(c.depends).toBe("locale");
    }
    expect(lang.filter((c) => c.method.startsWith("Format"))).toHaveLength(14);
    expect(lang.filter((c) => c.method === "Evaluate")).toHaveLength(9);
    const w = find("WindowsLanguage", "probe");
    expect(w.setup).toEqual([]);
    // the lang cells come last, so the earlier cells keep their ids
    expect(f.cells.slice(0, 297).some((c) => c.state.startsWith("lang1030"))).toBe(false);
  });

  test("PR-63: the new language cells are appended after the 326, per language and group", () => {
    const added = f.cells.slice(326);
    const per = (code: number) => added.filter((c) => c.state.startsWith(`lang${code} `));
    const isName = (c: { call: string }) => /Month Text|Weekday Text/.test(c.call);
    for (const code of [1031, 1036, 1044, 1053]) {
      const set = per(code).filter((c) => !isName(c));
      expect(set.filter((c) => c.type === "Enum")).toHaveLength(3);
      expect(set.filter((c) => c.method.startsWith("Format picture"))).toHaveLength(4);
      expect(set.filter((c) => c.type === "Boolean" && c.method === "Evaluate")).toHaveLength(5);
      expect(set.some((c) => c.type === "Date" && c.state.endsWith("closing date"))).toBe(true);
    }
    // 1030 gets only what it lacked: Enum (3), pictures (4), Boolean "1" (1)
    expect(per(1030).filter((c) => !isName(c))).toHaveLength(3 + 4 + 1);
    // month and day names: 5 pictures x 2 dates under each of the five languages and English
    for (const code of [1030, 1031, 1036, 1044, 1053, 1033]) {
      expect(per(code).filter(isName)).toHaveLength(10);
      for (const c of per(code)) expect((c.setup ?? [])[0]).toBe(`GlobalLanguage(${code});`);
      expect(per(code).every((c) => c.depends === "locale")).toBe(true);
    }
    expect(f.support).toContain('enum 51000 "LR Color"');
  });

  test("PR-63: the carry-over cell is one two-test codeunit, A_SetLanguage then B_ReadLanguage", () => {
    const i = f.cells.findIndex((c) => c.reader !== undefined);
    expect(i).toBe(f.cells.length - 1);
    expect(f.cells.filter((c) => c.reader !== undefined)).toHaveLength(1);
    const src = emitApp(f)["src/Cells.al"] ?? "";
    const unit = src.slice(src.indexOf(`codeunit ${BASE_ID + 1 + i} `));
    expect(unit.match(/\[Test\]/g)).toHaveLength(2);
    const [a, b] = [
      unit.indexOf("procedure A_SetLanguage()"),
      unit.indexOf("procedure B_ReadLanguage()"),
    ];
    // declaration order AND alphabetical order agree
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(SET_TEST < READ_TEST).toBe(true);
    expect([SET_TEST, READ_TEST]).toEqual(["A_SetLanguage", "B_ReadLanguage"]);
    expect(unit).toContain("GlobalLanguage(1030); Mark.Increment();");
    expect(unit).toContain(
      "Error('V:[%1|%2|%3]', Format(GlobalLanguage(), 0, 9), Format(V), Format(Mark.Count(), 0, 9));",
    );
    expect(src).toContain('codeunit 51540 "LR Carry Mark"');
    expect(src).toContain("SingleInstance = true;");
    expect(f.cells.at(-1)?.depends).toBe("carry");
    // every other cell stays a single `Cell` test
    expect(src.match(/procedure Cell\(\)/g)).toHaveLength(f.cells.length - 1);
  });

  test("PR-63: classify reads the reader's row; a setter that did not pass or is missing is no answer", () => {
    const i = f.cells.findIndex((c) => c.reader !== undefined);
    const id = BASE_ID + 1 + i;
    const rows = (...rs: { n: string; status: string; message?: string }[]) =>
      rs.map(({ n, ...rest }) => ({ name: `Codeunit${id}.${n}`, ...rest }));
    const last = (rs: ReturnType<typeof rows>) => classify(f, rs).at(-1);
    const ok = last(
      rows(
        { n: "A_SetLanguage", status: "pass" },
        { n: "B_ReadLanguage", status: "fail", message: "V:[1033|x|1]" },
      ),
    );
    expect(ok).toMatchObject({ outcome: "fail", message: "V:[1033|x|1]" });
    expect(last(rows({ n: "B_ReadLanguage", status: "fail", message: "V:[1]" }))?.outcome).toBe(
      "missing",
    );
    const bad = last(
      rows(
        { n: "A_SetLanguage", status: "fail", message: "no 1030" },
        { n: "B_ReadLanguage", status: "fail", message: "V:[1033|x|0]" },
      ),
    );
    expect(bad?.message).toBe("A_SetLanguage did not pass: no 1030");
  });

  test("PR-63: a two-test cell still joins to exactly one BC answer, keyed by the reader's test", () => {
    const results = [{ ...r("a", "fail", "V:[1]"), cell: { ...cell("a"), reader: { call: "x" } } }];
    const two = (...l: string[]) => joinCells(results, bcOf(...l));
    const S = "51001.A_SetLanguage";
    const R = "51001.B_ReadLanguage";
    expect(two(`${S}\tpass\t`, `${R}\tfail\tV:[1]`)[0]?.cls).toBe("equal");
    expect(parseBcTsv(`${S}\tpass\t\n${R}\tfail\tV:[1]`).size).toBe(1);
    expect(() => bcOf(`${R}\tfail\tV:[1]`, "51001\tfail\tV:[1]")).toThrow("twice");
    expect(() => bcOf(`${R}\tfail\tV:[1]`, `${R}\tfail\tV:[1]`)).toThrow("twice");
    expect(() => bcOf("51001.Other\tfail\tV:[1]")).toThrow("bad BC row");
    // a two-test cell needs both rows: the setter's pass only, the reader without a setter, and the bare id are all refused
    expect(() => two(`${S}\tpass\t`)).toThrow("no B_ReadLanguage row");
    expect(() => two(`${R}\tfail\tV:[1]`)).toThrow("no A_SetLanguage row");
    expect(() => two("51001\tfail\tV:[1]")).toThrow("has two tests");
    // a one-test cell refuses a test suffix
    const one = [r("a", "fail", "V:[1]")];
    expect(() => joinCells(one, bcOf(`${R}\tfail\tV:[1]`))).toThrow("has one test");
    expect(() => joinCells(one, bcOf(`${S}\tpass\t`))).toThrow("has one test");
    expect(joinCells(one, bcOf("51001\tfail\tV:[1]"))[0]?.cls).toBe("equal");
    // a failed setter is the cell's answer, not the reader's value
    const failed = two(`${S}\tfail\tno 1030`, `${R}\tfail\tV:[1]`);
    expect(failed[0]?.cls).toBe("one errors, one returns");
    expect(failed[0]?.bc).toContain("A_SetLanguage did not pass: no 1030");
  });

  test("PR-63: the carry cell's difference is flagged carry, not locale", () => {
    const c = { ...cell("a", "locale"), depends: "carry" as const, reader: { call: "x" } };
    const rows = joinCells(
      [{ cell: c, outcome: "fail", message: "V:[1030|x|1]" }],
      bcOf("51001.A_SetLanguage\tpass\t", "51001.B_ReadLanguage\tfail\tV:[1033|x|0]"),
    );
    expect(rows[0]?.depends).toBe("carry");
    expect(joinTsv(rows)).toContain("carry?");
  });

  test("L6: a report whose cells are not the family's cells, in order, is refused", () => {
    const ok: CellResult[] = f.cells.map((c) => ({ cell: c, outcome: "fail" as const }));
    expect(() => checkReportCells(ok)).not.toThrow();
    expect(() => checkReportCells(ok.slice(1))).toThrow("cells");
    const swapped = [...ok];
    const [a, b] = [swapped[0], swapped[1]];
    if (a === undefined || b === undefined) throw new Error("cells");
    swapped[0] = b;
    swapped[1] = a;
    expect(() => checkReportCells(swapped)).toThrow("is not the family's cell 0");
  });
});

describe("PR-74: the t9-refusals family", () => {
  const f = T9_REFUSALS;
  // each cell's text as al-runner `current` gave it, some as a leading part only; the cell order is the codeunit
  // order. The full measured texts are pinned by packages/runner/tests/pr74-measured-refusals.json.
  const TEXTS = [
    "SetFilter: value expected after ..",
    "SetFilter: value expected after @",
    "Evaluate of `>100` into Decimal (form not pinned by the corpus)",
    "Evaluate of `>1000` into Decimal (form not pinned by the corpus)",
    "Evaluate of `<1000` into Decimal (form not pinned by the corpus)",
    "RecordRef.Duplicate on a RecordRef that is not open: ",
    "a parameters string without the XML declaration in this form, given to Report.RunRequestPage ",
    "a parameters string without the XML declaration in this form, given to Report.SaveAs ",
    "DotNet new System.IO.Compression.ZipArchive raised the .NET exception System.IO.InvalidDataException: Central Directory corrupt. ",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteEndObject raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path ''.",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path 'a'.",
    "DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state ArrayStart would result in an invalid JSON object. Path 'a'.",
    "conversion of Boolean false to BigInteger",
    "RecordRef.ClearMarks on a RecordRef that is not open: ",
    "FieldRef.SetFilter on a FieldRef that was never assigned: ",
  ];

  test("one cell per measured text, in order, each a distinct cell name, on an OnPrem app", () => {
    expect(f.cells).toHaveLength(TEXTS.length);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    expect(f.cells.map((c) => `${c.type}.${c.method}`)).toEqual([
      "Filter.SetFilterDots",
      "Filter.SetFilterAt",
      "Evaluate.Gt100",
      "Evaluate.Gt1000",
      "Evaluate.Lt1000",
      "RecordRef.Duplicate",
      "Report.RunRequestPage",
      "Report.SaveAs",
      "ZipArchive.Ctor",
      "JsonTextWriter.WriteEndObject",
      "JsonTextWriter.WriteStartObject",
      "JsonTextWriter.WritePropertyName",
      "Conversion.FieldValue",
      "RecordRef.ClearMarks",
      "FieldRef.SetFilter",
    ]);
  });

  test("the app declares what the cells call: a table, both reports, the DotNet types; cells start at BASE_ID + 1", () => {
    const al = emitApp(f)["src/Cells.al"] ?? "";
    for (const s of [
      'table 51000 "T9 Row"',
      'report 51000 "T9 Report"',
      'report 51001 "T9 Print Report"',
      "T9JsonTextWriter",
      "T9ZipArchive",
      `codeunit ${BASE_ID + 1} "C0 Filter SetFilterDots t9"`,
    ])
      expect(al).toContain(s);
    // the JSON cells reach the writer's state through setup, so the call under test is the one that raises
    const start = f.cells.find((c) => c.method === "WriteStartObject");
    expect(start?.setup?.at(-1)).toBe("JW.WriteValue('v');");
    expect(start?.call).toBe("JW.WriteStartObject();");
  });

  test("a run that gives the measured texts makes 10 refusal classes, none of them known", () => {
    const rows = f.cells.map((_, i) => ({
      name: `Codeunit${BASE_ID + 1 + i}.Cell`,
      status: "error",
      notRun: true,
      message: `NotRun: out-of-scope: ${TEXTS[i]}`,
    }));
    const results = classify(f, rows);
    expect(results.every((r) => r.outcome === "refused")).toBe(true);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    // SetFilter x2, the four .NET exceptions and the two RecordRef cells fold; the rest stand alone
    expect(classes).toHaveLength(10);
    expect(
      classes.find((c) => c.text === "DotNet * raised the .NET exception *")?.cells,
    ).toHaveLength(4);
  });

  test("last of FAMILIES (place 12, BC-check number 13, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(11);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051013");
  });
});

describe("PR-93: the t10-refusals family", () => {
  const f = T10_REFUSALS;
  // each cell's refusal text as al-runner `current` gave it (the cell order is the codeunit order); the RunRequestPage cell
  // inside a write transaction (R1078) gives no refusal on the plain runner: BC's own transaction error, so it has no text
  const TEXTS: (string | undefined)[] = [
    "CalcDate result outside 0001-9999 (error text not pinned)",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteEndArray raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path ''.; the text AL would see is not pinned (ADR-014 section 7)",
    "DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state Array would result in an invalid JSON object. Path 'message.toRecipients'.; the text AL would see is not pinned (ADR-014 section 7)",
    "DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state ArrayStart would result in an invalid JSON object. Path 'message.toRecipients'.; the text AL would see is not pinned (ADR-014 section 7)",
    "Evaluate of `<300` into Decimal (form not pinned by the corpus)",
    "FieldRef.EnumValueCount on a FieldRef that was never assigned: ",
    "FieldRef.Value on a FieldRef that was never assigned: ",
    "KeyRef.FieldCount on a KeyRef that was never assigned",
    "KeyRef.FieldIndex on a KeyRef that was never assigned",
    "Page.Run with RecordRef as the record",
    "Page.Run with an unassigned Variant as the record",
    "RecordRef.FindFirst on a RecordRef that is not open: ",
    "RecordRef.GetFilters on a RecordRef that is not open: ",
    "RecordRef.GetTable of Text 'Not a record'",
    "RecordRef.KeyIndex on a RecordRef that is not open: ",
    "Report.SaveAs#2 of id 0, which no report declares (error text not pinned)",
    "SetFilter: `GL00000000` is not a BigInteger",
    "SetFilter: `GU00000001` is not a BigInteger",
    "SetFilter: empty filter term",
    "SetFilter: text filter value `-1M` for Date: no form pinned for this language ",
    "SetFilter: text filter value `-2026-09-01` for Date: no form pinned for this language ",
    "SetFilter: unexpected `>` in filter `<-1M>..<CM>`",
    "SetFilter: value expected after `<>`",
    "XmlDocument.ReadFrom of something that is not an InStream",
    "a parameters string without the XML declaration in this form, given to Report.RunRequestPage ",
    undefined,
    "an OutStream was expected, got an untouched handle",
    "conversion of Code 'GL00000000' to BigInteger",
  ];

  test("one cell per text, an OnPrem app, distinct cell names, and RunRequestPage both inside and after a Commit", () => {
    expect(f.cells).toHaveLength(TEXTS.length);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const rrp = f.cells.filter((c) => c.method === "RunRequestPage");
    expect(rrp.map((c) => c.setup?.at(-1))).toEqual(["Commit();", "R.Insert();"]);
    expect(TEXTS.indexOf(undefined)).toBe(
      f.cells.findIndex((c) => c.state === "in write transaction"),
    );
  });

  test("a run that gives the measured texts makes 15 refusal classes, none of them known", () => {
    const rows = f.cells.flatMap((_, i) => {
      const t = TEXTS[i];
      return t === undefined
        ? []
        : [
            {
              name: `Codeunit${BASE_ID + 1 + i}.Cell`,
              status: "error",
              notRun: true,
              message: `NotRun: out-of-scope: ${t}`,
            },
          ];
    });
    const results = classify(f, rows);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(TEXTS.length - 1);
    expect(results.filter((r) => r.outcome === "missing")).toHaveLength(1);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    expect(classes).toHaveLength(15);
    expect(classes.find((c) => c.text === "SetFilter")?.cells).toHaveLength(7);
  });

  test("place 16, BC-check number 17, as 7 is skipped: its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(15);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051017");
  });
});

describe("PR-105: the t12-refusals family", () => {
  const f = T12_REFUSALS;
  const nul = (n: number) => "\u0000".repeat(n);
  // each cell's refusal text as al-runner `current` gave it (the cell order is the codeunit order). The three Evaluate texts are
  // runs of NUL characters, which the cells build in AL.
  const TEXTS = [
    "FieldRef.CalcField of a field that is not a FlowField",
    "SetFilter: `C10000` is not a BigInteger",
    `Evaluate of \`${nul(6)}\` into Decimal (form not pinned by the corpus)`,
    `Evaluate of \`${nul(5)}\` into Decimal (form not pinned by the corpus)`,
    `Evaluate of \`${nul(4)}\` into Decimal (form not pinned by the corpus)`,
    `conversion of Text '<?xml version="1.0" encoding="...' to Blob`,
    "an action left another row (another primary key) in Rec with changes to save",
    "conversion of Text '=18' to Integer",
    "conversion of Text '1=18' to Integer",
    "CopyStream from an untouched handle into a DotNet stream",
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path 'message.body.ccRecipients[0].emailAddress'.; the text AL would see is not pinned (ADR-014 section 7)",
    "Report.SaveAs#2 to an untouched handle, which is not an OutStream",
  ];

  test("one cell per text, an OnPrem app, distinct cell names, the Evaluate widths built as NULs", () => {
    expect(f.cells).toHaveLength(TEXTS.length);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const widths = f.cells.filter((c) => c.method === "NulDecimal");
    expect(widths.map((c) => c.setup?.at(-1))).toEqual([
      "for I := 1 to 6 do T += Format(Ch);",
      "for I := 1 to 5 do T += Format(Ch);",
      "for I := 1 to 4 do T += Format(Ch);",
    ]);
  });

  test("a run that gives the measured texts makes 12 refusal classes (one per text), none of them known", () => {
    const rows = f.cells.map((_, i) => ({
      name: `Codeunit${BASE_ID + 1 + i}.Cell`,
      status: "error",
      notRun: true,
      message: `NotRun: out-of-scope: ${TEXTS[i]}`,
    }));
    const results = classify(f, rows);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(TEXTS.length);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    expect(classes).toHaveLength(12);
    expect(classes.filter((c) => c.text.startsWith("Evaluate of"))).toHaveLength(3);
  });

  test("place 17 of FAMILIES, BC-check number 18, as 7 is skipped: its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(16);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051018");
  });
});

describe("PR-133: the x2-refusals family", () => {
  const f = X2_REFUSALS;
  // the third cell reaches the C* text through a card TestPage, a modal handler, a TryFunction and an OnValidate
  const TEXTS = [
    "SetFilter: `C*` is not a BigInteger",
    "RecordRef.GetTable of Integer 123",
    "SetFilter: `C*` is not a BigInteger",
  ];

  test("three cells, an OnPrem app, distinct cell names, the nested cell binds a modal handler", () => {
    expect(f.cells).toHaveLength(TEXTS.length);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    expect(f.cells.at(-1)?.handlers).toHaveLength(1);
  });

  test("a run that gives the measured texts makes 2 refusal classes (the nested cell shares the C* text), none of them known", () => {
    const rows = f.cells.map((_, i) => ({
      name: `Codeunit${BASE_ID + 1 + i}.Cell`,
      status: "error",
      notRun: true,
      message: `NotRun: out-of-scope: ${TEXTS[i]}`,
    }));
    const results = classify(f, rows);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(TEXTS.length);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    expect(classes).toHaveLength(2);
  });

  test("place 18 of FAMILIES (BC-check number 19, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(17);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051019");
  });
});

describe("PR-139: the x3-refusals family", () => {
  const f = X3_REFUSALS;
  const nul = (n: number) => "\u0000".repeat(n);
  const WIDTHS = [3, 10, 12, 14, 30, 37, 40];
  // amendment 1: the other NUL widths M28736's DO requests hold, appended after the state cells
  const WIDTHS_A1 = [7, 9, 11, 13, 16, 21, 25, 27];
  // 7 widths, then the width-10 array, TryFunction, nested-state and OnInsert cells, then amendment 1's 8 widths
  const WIDTH_OF = [...WIDTHS, 10, 10, 10, 10, ...WIDTHS_A1];
  const text = (n: number) =>
    `Evaluate of \`${nul(n)}\` into Decimal (form not pinned by the corpus)`;

  test("19 cells, an OnPrem app, distinct names, the NULs built in AL, the nested cell binds a handler", () => {
    expect(f.cells).toHaveLength(19);
    expect(f.cells).toHaveLength(WIDTH_OF.length);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    expect(f.cells.slice(0, 7).map((c) => c.setup?.at(-1))).toEqual(
      WIDTHS.map((n) => `for I := 1 to ${n} do T += Format(Ch);`),
    );
    expect(f.cells.slice(11).map((c) => c.setup?.at(-1))).toEqual(
      WIDTHS_A1.map((n) => `for I := 1 to ${n} do T += Format(Ch);`),
    );
    expect(f.cells[9]?.handlers).toHaveLength(1);
    expect(f.cells[8]?.call).toContain("Helper.EvalBare()");
    // the support codeunit sits after the last cell's codeunit, inside the family's id range
    expect(f.support).toContain(`codeunit ${BASE_ID + 1 + f.cells.length} "X3 Cache"`);
    expect(f.support).toContain("trigger OnInsert()");
    expect(f.support).toContain("SingleInstance = true;");
  });

  test("a run that gives the exact texts makes 15 refusal classes, the width-10 class with 5 cells, none known", () => {
    const rows = f.cells.map((_, i) => ({
      name: `Codeunit${BASE_ID + 1 + i}.Cell`,
      status: "error",
      notRun: true,
      message: `NotRun: out-of-scope: ${text(WIDTH_OF[i] ?? 0)}`,
    }));
    const results = classify(f, rows);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(WIDTH_OF.length);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    expect(classes).toHaveLength(15);
    expect(classes.find((c) => c.text === text(10))?.cells).toHaveLength(5);
  });

  test("place 19 of FAMILIES (BC-check number 20, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(18);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051020");
  });
});

describe("PR-159: the y1-refusals family", () => {
  const f = Y1_REFUSALS;
  const JSON_TEXT_Y1 =
    "DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path 'message.body.toRecipients[0].emailAddress'.; the text AL would see is not pinned (ADR-014 section 7)";
  const TEXTS = [
    "RecordRef.GetTable of Integer 12345",
    "RecordRef.GetTable of Integer 12345",
    JSON_TEXT_Y1,
  ];

  test("three cells, an OnPrem app, distinct names, the guard checks IsRecord before GetTable, the path is toRecipients[0]", () => {
    expect(f.cells).toHaveLength(3);
    expect(f.target).toBe("OnPrem");
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    expect(f.cells[1]?.call).toBe("Helper.GetLog(V);");
    expect(f.support).toContain("if VariantRecord.IsRecord then\n            exit;");
    expect(f.cells[2]?.setup).toContain("JW.WritePropertyName('toRecipients');");
    expect(f.cells[2]?.setup).not.toContain("JW.WritePropertyName('ccRecipients');");
  });

  test("a run that gives the measured texts makes 2 refusal classes (the 12345 class has 2 cells), none known", () => {
    const rows = f.cells.map((_, i) => ({
      name: `Codeunit${BASE_ID + 1 + i}.Cell`,
      status: "error",
      notRun: true,
      message: `NotRun: out-of-scope: ${TEXTS[i]}`,
    }));
    const results = classify(f, rows);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(TEXTS.length);
    const classes = refusalClasses(f, results);
    expect(classes.every((c) => !c.known)).toBe(true);
    expect(classes).toHaveLength(2);
    expect(classes.find((c) => c.text === TEXTS[0])?.cells).toHaveLength(2);
  });

  test("place 20 of FAMILIES (BC-check number 21, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(19);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051021");
  });
});

describe("PR-191: the y2-xml family", () => {
  const f = Y2_XML;

  test("21 cells (18 refusers, 3 passing controls), distinct names, support ids clear of every cell id, app.json range covers them", () => {
    expect(f.cells).toHaveLength(21);
    expect(f.cells.filter((c) => c.method.startsWith("Ctl")).map((c) => c.method)).toEqual([
      "CtlByVarSetterOnly",
      "CtlByValueSetOnly",
      "CtlDeepSetupOnly",
    ]);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const ids = [...f.support.matchAll(/^codeunit (\d+) /gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([51000, 51022, 51023, 51024, 51025]);
    const range = JSON.parse(emitApp(f)["app.json"] ?? "{}").idRanges[0];
    expect(range).toEqual({ from: 51000, to: 51000 + 1 + 21 + 4 });
    expect(Math.min(...ids.slice(1))).toBeGreaterThan(51000 + f.cells.length);
  });

  test("extraIds moves the idRanges end by exactly that much; a family without it is unchanged", () => {
    const end = (x: Family) => JSON.parse(emitApp(x)["app.json"] ?? "{}").idRanges[0].to;
    const n = f.cells.length;
    expect(end({ ...f, extraIds: 0 })).toBe(51000 + 1 + n);
    expect(end({ ...f, extraIds: 7 })).toBe(51000 + 1 + n + 7);
    const { extraIds: _drop, ...none } = f;
    expect(end(none)).toBe(51000 + 1 + n);
    const y1 = Y1_REFUSALS;
    expect(end(y1)).toBe(51000 + 1 + y1.cells.length);
  });

  test("the wrapper is not SingleInstance; the deep cells set the SingleInstance codeunit, bind, write a blob, then Commit", () => {
    expect(f.support.split('codeunit 51022 "Y2 Chain"')[0]).not.toContain("SingleInstance");
    const deep = f.cells.filter((c) => c.method.startsWith("Deep"));
    expect(deep).toHaveLength(2);
    for (const c of deep) {
      expect(c.setup).toEqual([
        "Single.SetValue('x');",
        "BindSubscription(Sub);",
        "W.WriteBlob();",
        "Commit();",
      ]);
    }
  });

  test("the by-var cell passes the target to a procedure that never sets it, then uses the target", () => {
    const c = f.cells.find((x) => x.method === "UnassignedNodeByVar");
    expect(c?.setup).toContain("W.SkipSetter(W2);");
    expect(c?.call).toBe("W2.UseNode();");
    expect(f.support).toContain('procedure SkipSetter(var Target: Codeunit "Y2 Xml Node")');
    // SkipSetter touches no XML value, so the first refusing statement is the caller's UseNode
    const body = /procedure SkipSetter[\s\S]*?\n {4}end;/.exec(f.support)?.[0] ?? "";
    expect(body).not.toMatch(/XmlNode|Unset|Is Xml|IsXml/);
  });

  test("the deep control sets up exactly as the deep refusers, runs the chain, and asserts the state", () => {
    const deep = f.cells.find((c) => c.method === "DeepNodeAsContent");
    const ctl = f.cells.find((c) => c.method === "CtlDeepSetupOnly");
    expect(ctl?.setup?.slice(0, 4)).toEqual([...(deep?.setup ?? [])]);
    expect(ctl?.setup).toContain("Chain.NoopDeep(W);");
    expect(ctl?.call).toBe("W.AssertDeepState(Single);");
  });

  test("place 21 of FAMILIES (BC-check number 22, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(20);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051022");
  });
});

describe("PR-195: the y2-collation family", () => {
  const f = Y2_COLLATION;

  test("7 cells (6 refusers, 1 passing control), distinct names, support ids clear of every cell id, app.json range covers them", () => {
    expect(f.cells).toHaveLength(7);
    expect(f.cells.filter((c) => c.method.startsWith("Ctl")).map((c) => c.method)).toEqual([
      "CtlAscii",
    ]);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const ids = [...f.support.matchAll(/^codeunit (\d+) /gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([51000, 51008, 51009]);
    const range = JSON.parse(emitApp(f)["app.json"] ?? "{}").idRanges[0];
    expect(range).toEqual({ from: 51000, to: 51000 + 1 + 7 + 2 });
    expect(Math.min(...ids.slice(1))).toBeGreaterThan(51000 + f.cells.length);
    expect(f.support).toMatch(/^table 51000 /m);
  });

  test("the refusing codeunit 51000 is SingleInstance with a global Override; so is the second support codeunit", () => {
    const first = f.support.split('codeunit 51008 "Y2C Single"')[0] ?? "";
    expect(first).toContain("SingleInstance = true;");
    expect(first).toContain("Override: Integer;");
    expect(first).toContain("procedure SetOverride(N: Integer)");
    expect(f.support.split("SingleInstance = true;")).toHaveLength(3);
  });

  test("every refuser calls SetOverride before Derive; the control does not", () => {
    for (const c of f.cells.slice(0, 6)) {
      expect(c.call.indexOf("W.SetOverride(")).toBeGreaterThanOrEqual(0);
      expect(c.call.indexOf("W.SetOverride(")).toBeLessThan(c.call.indexOf("W.Derive("));
    }
    expect(f.cells[6]?.call).not.toContain("SetOverride");
  });

  test("readers: y2single, y2cover (the Override global), y2order (text order and key order) and y2rows (the insert cells' table)", () => {
    expect((f.readers ?? []).map((r) => r.name)).toEqual([
      "y2single",
      "y2cover",
      "y2order",
      "y2rows",
    ]);
    expect(f.support).toMatch(
      /procedure RowCount\(\): Text[\s\S]*?Row: Record "Y2C Row";[\s\S]*?Row\.Count\(\)/,
    );
    expect(f.support).toContain("exit(Format(D.GetOverride()));");
    const order = /procedure OrderText[\s\S]*?\n {4}end;/.exec(f.support)?.[0] ?? "";
    for (const s of [
      "Acute > 'Z'",
      "Acute < 'a'",
      "Acute > 'z'",
      "Tilde > 'a'",
      "Tilde < 'Z'",
      "FindSet()",
    ])
      expect(order).toContain(s);
    expect(f.support).toMatch(/^table 51001 "Y2C Order Row"/m);
  });

  test("InRange has the mutated shape, three calls deep: Derive -> Clean -> InRange", () => {
    expect(f.support).toContain(
      "exit(((Ch >= '') and (Ch <= 'Z')) or ((Ch >= '0') and (Ch <= '9')));",
    );
    expect(f.support).toContain("exit(Clean(Name));");
    expect(f.support).toContain("if InRange(Ch) then");
    expect(f.cells.every((c) => c.call.includes("W.Derive("))).toBe(true);
  });

  test("the refusers use U+516C (20844) and U+041A (1050), each plain, after an insert, after a SingleInstance set", () => {
    const codes = f.cells.slice(0, 6).map((c) => c.setup?.[0]);
    expect(codes).toEqual([
      "Ch := 20844;",
      "Ch := 1050;",
      "Ch := 20844;",
      "Ch := 1050;",
      "Ch := 20844;",
      "Ch := 1050;",
    ]);
    expect(f.cells[2]?.setup).toContain("Row.Insert();");
    expect(f.cells[4]?.setup).toContain("Single.SetValue('x');");
  });

  test("the control errors only on a mismatch and expects the cleaned text", () => {
    const ctl = f.cells[6];
    expect(ctl?.call).toContain("Derive('ABC 12')");
    expect(ctl?.call).toContain("if Result <> 'ABC 12' then Error(");
  });

  test("place 22 of FAMILIES (BC-check number 23, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(21);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051023");
  });
});

describe("PR-373: the format-region family", () => {
  const f = FORMAT_REGION;

  test("209 cells: 5 regions x (with language, region only) x 19 values, plus 19 with no region; distinct names", () => {
    expect(f.cells).toHaveLength(209);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    const states = [...new Set(f.cells.map((c) => c.state))];
    expect(states).toEqual([
      "en-GB lang",
      "en-GB only",
      "de-DE lang",
      "de-DE only",
      "fr-FR lang",
      "fr-FR only",
      "da-DK lang",
      "da-DK only",
      "en-US lang",
      "en-US only",
      "none",
    ]);
    for (const s of states) expect(f.cells.filter((c) => c.state === s)).toHaveLength(19);
  });

  test("support: enum, table, holder codeunit and report all at 51000; app.json's range covers every cell", () => {
    for (const k of ["enum", "table", "codeunit", "report"])
      expect([...f.support.matchAll(new RegExp(`^${k} (\\d+) `, "gm"))].map((m) => m[1])).toEqual([
        "51000",
      ]);
    const range = JSON.parse(emitApp(f)["app.json"] ?? "{}").idRanges[0];
    expect(range).toEqual({ from: 51000, to: 51000 + 1 + 209 });
    expect(f.support).toContain("SingleInstance = true;");
  });

  test("the report sets the language only when one is given, the region only when asked, then formats and hands the text on", () => {
    const trig = /trigger OnAfterGetRecord\(\)[\s\S]*?\n {12}end;/.exec(f.support)?.[0] ?? "";
    expect(trig).toContain("if Lang <> 0 then\n                    CurrReport.Language := Lang;");
    expect(trig).toContain(
      "if SetRegion then\n                    CurrReport.FormatRegion := Region;",
    );
    expect(trig.indexOf("CurrReport.FormatRegion")).toBeLessThan(
      trig.indexOf("Answer := Compute();"),
    );
    expect(trig).toContain("Holder.Put(Answer);");
    // an unknown kind must fail loudly, never answer an empty text
    expect(f.support).toContain("Error('FR Report: no kind %1', Kind);");
  });

  test("every cell runs the report through SaveAs as Xml, then reports the held text with Error('V:[...]')", () => {
    for (const c of f.cells) {
      expect(c.setup?.[1]).toMatch(
        /^Rep\.SetCase\(\d+, '[a-zA-Z-]*', (true|false), \d+, DMY2Date\(17, \d+, 2026\)\);$/,
      );
      expect(c.setup?.[2]).toBe("Rep.SaveAs('', ReportFormat::Xml, OS);");
      expect(c.call).toBe("Error('V:[%1]', Holder.Get());");
    }
  });

  test("the region is set exactly when one is named; the language exactly in the 'lang' cells, and only those are not locale", () => {
    for (const c of f.cells) {
      const m = /^Rep\.SetCase\((\d+), '([a-zA-Z-]*)', (true|false),/.exec(c.setup?.[1] ?? "");
      expect(m).not.toBeNull();
      const [, lang, region] = m ?? [];
      expect(region === "").toBe(c.state === "none");
      expect(lang !== "0").toBe(c.state.endsWith(" lang"));
      expect(c.depends === "locale").toBe(!c.state.endsWith(" lang"));
    }
    const langOf = (s: string) =>
      /^Rep\.SetCase\((\d+),/.exec(f.cells.find((c) => c.state === s)?.setup?.[1] ?? "")?.[1];
    expect(["en-GB", "de-DE", "fr-FR", "da-DK", "en-US"].map((r) => langOf(`${r} lang`))).toEqual([
      "2057",
      "1031",
      "1036",
      "1030",
      "1033",
    ]);
  });

  test("the long date (format 4) runs in all 12 months; every Compute kind a cell names is a case of the report", () => {
    const months = f.cells
      .filter((c) => c.state === "en-GB lang" && c.method.startsWith("Date f4 "))
      .map((c) => /DMY2Date\(17, (\d+), 2026\)/.exec(c.setup?.[1] ?? "")?.[1]);
    expect(months).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    const kinds = new Set(f.cells.map((c) => /, (\d+), DMY2Date/.exec(c.setup?.[1] ?? "")?.[1]));
    expect([...kinds].sort()).toEqual(["0", "10", "11", "20", "30", "31", "4", "40"]);
    for (const k of kinds) expect(f.support).toContain(`\n            ${k}:\n`);
  });

  test("place 23 of FAMILIES (BC-check number 24, as 7 is skipped): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(22);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051024");
  });
});

describe("PR-374: the fieldref-convert family", () => {
  const f = FIELDREF_CONVERT;
  const FIELDS: Record<string, string> = {
    "FC BigInteger": "BigInteger",
    "FC Integer": "Integer",
    "FC Decimal": "Decimal",
    "FC Code": "Code[20]",
    "FC Text": "Text[50]",
    "FC Date": "Date",
    "FC Boolean": "Boolean",
    "FC Option": "Option",
    "FC Guid": "Guid",
  };

  test("288 cells: 9 field types x 8 values x 4 methods, each combination once; distinct names", () => {
    expect(f.cells).toHaveLength(288);
    const keys = f.cells.map((c) => `${c.type}|${c.state}|${c.method}`);
    expect(new Set(keys).size).toBe(288);
    expect(new Set(f.cells.map((c) => c.type)).size).toBe(9);
    expect(new Set(f.cells.map((c) => c.state)).size).toBe(8);
    expect([...new Set(f.cells.map((c) => c.method))]).toEqual([
      "SetRange",
      "SetFilter",
      "Value",
      "Validate",
    ]);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("each cell takes the field its type names: the field number's declared type in table 51000 matches", () => {
    const decl = new Map(
      [...f.support.matchAll(/field\((\d+); \w+; ([\w[\]]+)\)/g)].map((m) => [m[1], m[2]] as const),
    );
    for (const c of f.cells) {
      const no = /^FR := RecRef\.Field\((\d+)\);$/.exec(c.setup?.[1] ?? "")?.[1];
      expect(no).toBeDefined();
      expect(decl.get(no ?? "")).toBe(FIELDS[c.type]);
      expect(c.setup?.[0]).toBe("RecRef.Open(51000);");
    }
  });

  test("the value's declaration matches its name, and the read-back follows the method", () => {
    const declOf: Record<string, string> = {
      "Boolean false": "V: Boolean;",
      "Code ABC": "V: Code[20];",
      "Code 123": "V: Code[20];",
      "Text XY": "V: Text[30];",
      "Integer 5": "V: Integer;",
      "BigInteger 5": "V: BigInteger;",
      "Decimal 1.5": "V: Decimal;",
      Date: "V: Date;",
    };
    for (const c of f.cells) {
      expect(c.vars?.[2]).toBe(declOf[c.state]);
      const filter = c.method === "SetRange" || c.method === "SetFilter";
      expect(
        c.call.endsWith(
          filter ? "Error('V:[%1]', FR.GetFilter());" : "Error('V:[%1]', Format(FR.Value, 0, 9));",
        ),
      ).toBe(true);
    }
  });

  test("no cell writes a row", () => {
    for (const c of f.cells)
      expect([...(c.setup ?? []), c.call].join(" ")).not.toMatch(/\.(Insert|Modify|Delete)\(/);
  });

  test("place 24 of FAMILIES (BC-check number 25): its BC-check id", () => {
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(23);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051025");
  });
});

describe("PR-374: the language-region family", () => {
  const f = LANGUAGE_REGION;

  test("144 cells: 11 languages x 12 regions, then the 12 regions with no language; distinct names", () => {
    expect(f.cells).toHaveLength(144);
    const pairs = f.cells.map((c) =>
      /^Rep\.SetCase\((\d+), '([a-zA-Z-]+)'\);$/
        .exec(c.setup?.[2] ?? "")
        ?.slice(1)
        .join("|"),
    );
    expect(new Set(pairs).size).toBe(144);
    expect(f.cells.filter((c) => c.state === "no language")).toHaveLength(12);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
  });

  test("the holder is cleared before every run (PR-373's review), and only the no-language cells are locale", () => {
    for (const c of f.cells) {
      expect(c.setup?.[0]).toBe("Holder.Put('');");
      expect(c.setup?.[3]).toBe("Rep.SaveAs('', ReportFormat::Xml, OS);");
      expect(c.call).toBe("Error('V:[%1]', Holder.Get());");
      expect(c.depends === "locale").toBe(c.state === "no language");
    }
  });

  test("the report sets the language (when one is given) before the region, then formats", () => {
    const trig = /trigger OnAfterGetRecord\(\)[\s\S]*?\n {12}end;/.exec(f.support)?.[0] ?? "";
    expect(trig).toContain("if Lang <> 0 then\n                    CurrReport.Language := Lang;");
    expect(trig.indexOf("CurrReport.Language")).toBeLessThan(
      trig.indexOf("CurrReport.FormatRegion := Region;"),
    );
    expect(trig.indexOf("CurrReport.FormatRegion")).toBeLessThan(trig.indexOf("Answer := "));
    expect(trig).toContain("Holder.Put(Answer);");
  });

  test("last of FAMILIES (place 25, BC-check number 26): its BC-check id", () => {
    expect(Object.keys(FAMILIES).at(-1)).toBe("language-region");
    expect(Object.keys(FAMILIES).indexOf(f.name)).toBe(24);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051026");
  });
});

describe("PR-83: the record-filters family", () => {
  const f = RECORD_FILTERS;

  test("place 13 in FAMILIES, BC-check number 14", () => {
    expect(Object.keys(FAMILIES).indexOf("record-filters")).toBe(12);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051014");
  });

  test("every test codeunit has TestPermissions = Disabled (BC's restrictive default refused the seed's Insert); others do not", () => {
    const cells = emitApp(bcCheckFamily(f))["src/Cells.al"] ?? "";
    const tests = cells.match(/Subtype = Test;/g)?.length ?? 0;
    expect(tests).toBe(f.cells.length);
    expect(cells.match(/Subtype = Test;\n {4}TestPermissions = Disabled;/g)?.length ?? 0).toBe(
      tests,
    );
    const other = emitApp(FORMAT_EVALUATE)["src/Cells.al"] ?? "";
    expect(other).toContain("Subtype = Test;");
    expect(other).not.toContain("TestPermissions");
  });

  test("about 250 cells in 13 groups, each with its own codeunit and a unique name", () => {
    expect(f.cells.length).toBeGreaterThan(150);
    expect(f.cells.length).toBeLessThan(300);
    const groups = new Set(f.cells.map((c) => c.type));
    expect([...groups].sort()).toEqual(
      [
        "CalcFields",
        "CalcSums",
        "Count",
        "DeleteAll",
        "Danish",
        "FilterGroup",
        "FlowField",
        "GetFilters",
        "Mark",
        "ModifyAll",
        "Order",
        "SetFilter",
        "SetRange",
      ].sort(),
    );
    const keys = f.cells.map((c) => `${c.type}|${c.method}|${c.state}`);
    expect(new Set(keys).size).toBe(keys.length);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    // a name with a quote would cut an AL object name in two
    for (const n of names) expect(n).not.toContain('"');
    const al = emitApp(f)["src/Cells.al"] ?? "";
    const ids = [...al.matchAll(/^codeunit (\d+) /gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // the 51000 support codeunit plus one per cell
    expect(ids).toHaveLength(f.cells.length + 1);
  });

  test("every cell answers as V:[...], reloads the data first, and marks locale cells", () => {
    for (const c of f.cells) {
      expect((c.reader ?? c).call).toMatch(/Error\('V:\[%1(\|%2)?\]', .*\);$/);
      expect(c.reader?.setup ?? c.setup ?? []).toContain("Seed.Load();");
    }
    // Danish cells use the two-test form and are locale-dependent
    const danish = f.cells.filter((c) => c.type === "Danish");
    expect(danish.length).toBeGreaterThan(10);
    for (const c of danish) {
      expect(c.reader).toBeDefined();
      expect(c.depends).toBe("locale");
      expect(c.call).toBe("GlobalLanguage(1030);");
      expect(c.reader?.setup?.[0]).toBe("GlobalLanguage(1030);");
    }
    // date-text filters read the region; an Integer SetRange does not
    const sf = f.cells.find((c) => c.type === "SetFilter" && c.state === "150324");
    expect(sf?.depends).toBe("locale");
    const sr = f.cells.find((c) => c.type === "SetRange" && c.method === "Integer");
    expect(sr?.depends).toBeUndefined();
  });

  test("the support seeds with DeleteAll and has keys with ties and a two-field key", () => {
    expect(f.support).toContain("Hd.DeleteAll();");
    expect(f.support).toContain("key(ByRegion; Region)");
    expect(f.support).toContain("key(ByKindQty; Kind, Qty)");
    expect(f.support).toContain("CalcFormula = sum(");
    expect(f.support).toContain("FieldClass = FlowFilter;");
  });
});

describe("PR-86: the dates-formulas family", () => {
  const f = DATES_FORMULAS;

  test("place 14 of FAMILIES: BC-check number 15", () => {
    expect(Object.keys(FAMILIES).indexOf("dates-formulas")).toBe(13);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051015");
  });

  test("every test codeunit has TestPermissions = Disabled", () => {
    const cells = emitApp(bcCheckFamily(f))["src/Cells.al"] ?? "";
    const tests = cells.match(/Subtype = Test;/g)?.length ?? 0;
    expect(tests).toBe(f.cells.length);
    expect(cells.match(/Subtype = Test;\n {4}TestPermissions = Disabled;/g)?.length ?? 0).toBe(
      tests,
    );
  });

  test("about 300 cells in 13 groups; unique keys, unique names (no quote), unique codeunits", () => {
    expect(f.cells.length).toBeGreaterThan(200);
    expect(f.cells.length).toBeLessThan(400);
    expect([...new Set(f.cells.map((c) => c.type))].sort()).toEqual(
      [
        "CalcDate",
        "ClosingDate",
        "DMY2Date",
        "Date",
        "Date2DMY",
        "Date2DWY",
        "DateFormula",
        "DateTime",
        "DWY2Date",
        "Lang1030",
        "Lang1031",
        "Time",
        "WorkDate",
      ].sort(),
    );
    const keys = f.cells.map((c) => `${c.type}|${c.method}|${c.state}`);
    expect(new Set(keys).size).toBe(keys.length);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).not.toContain('"');
    const ids = [...(emitApp(f)["src/Cells.al"] ?? "").matchAll(/^codeunit (\d+) /gm)].map(
      (m) => m[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(f.cells.length);
  });

  test("a cell that evaluates an unbracketed formula without format 9 is flagged locale (letters follow the session language)", () => {
    // '<1Y>' reads as 1Y under 1030 and 1031 on BC, so the bracketed form is language-free.
    const languageBound = f.cells.filter((c) =>
      [...(c.setup ?? []), c.call, ...(c.reader?.setup ?? []), c.reader?.call ?? ""].some((s) =>
        /Evaluate\(DF, '(?!<)[^']*'\)/.test(s),
      ),
    );
    expect(languageBound.length).toBeGreaterThan(40);
    for (const c of languageBound)
      expect(`${c.type}|${c.method}|${c.state}|${c.depends}`).toEndWith("|locale");
  });

  test("answers use V:[...]; language cells are two-test and locale; WorkDate cells set WorkDate first", () => {
    for (const c of f.cells)
      expect((c.reader ?? c).call).toMatch(/Error\('V:\[%1(\|%2)?\]', .*\);$/);
    const langs = f.cells.filter((c) => c.type.startsWith("Lang"));
    expect(langs.length).toBeGreaterThan(30);
    for (const c of langs) {
      expect(c.reader).toBeDefined();
      expect(c.depends).toBe("locale");
      expect(c.reader?.setup?.[0]).toMatch(/^GlobalLanguage\(103[01]\);$/);
    }
    for (const c of f.cells.filter((x) => x.type === "WorkDate"))
      expect(c.setup?.[0]).toMatch(/^WorkDate\(/);
    const ev = f.cells.find((c) => c.type === "DateFormula" && c.method === "Evaluate");
    expect(ev?.depends).toBe("locale");
    expect(f.cells.find((c) => c.method === "Evaluate 9")?.depends).toBeUndefined();
    expect(f.cells.find((c) => c.state === "Format 9 evening")?.depends).toBe("tz");
  });
});

describe("PR-87: the json-text family", () => {
  const f = JSON_TEXT;

  test("place 15 of FAMILIES: BC-check number 16", () => {
    expect(Object.keys(FAMILIES).indexOf("json-text")).toBe(14);
    expect(bcCheckApp(f).id).toBe("51000000-0000-4000-8000-000000051016");
  });

  test("every test codeunit has TestPermissions = Disabled", () => {
    const cells = emitApp(bcCheckFamily(f))["src/Cells.al"] ?? "";
    const tests = cells.match(/Subtype = Test;/g)?.length ?? 0;
    expect(tests).toBe(f.cells.length);
    expect(cells.match(/Subtype = Test;\n {4}TestPermissions = Disabled;/g)?.length ?? 0).toBe(
      tests,
    );
  });

  test("250 to 420 cells; unique keys, unique names (no quote), unique codeunits", () => {
    expect(f.cells.length).toBeGreaterThan(250);
    expect(f.cells.length).toBeLessThan(420);
    const types = new Set(f.cells.map((c) => c.type));
    for (const t of [
      "JsonObject",
      "JsonArray",
      "JsonToken",
      "JsonValue",
      "JsonText",
      "TextBuilder",
    ])
      expect(types.has(t)).toBe(true);
    expect(types.has("TextCompare")).toBe(true);
    const keys = f.cells.map((c) => `${c.type}|${c.method}|${c.state}`);
    expect(new Set(keys).size).toBe(keys.length);
    const names = f.cells.map((c, i) => cellName(c, i));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).not.toContain('"');
    const ids = [...(emitApp(f)["src/Cells.al"] ?? "").matchAll(/^codeunit (\d+) /gm)].map(
      (m) => m[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(f.cells.length);
  });

  test("answers use V:[...]", () => {
    for (const c of f.cells) expect(c.call).toMatch(/^Error\('V:\[%1\]', .*\);$/);
  });

  test("a cell whose text holds a non-ASCII letter is flagged locale (case mapping and order follow the language)", () => {
    const nonAscii = f.cells.filter((c) =>
      /[^\u0020-\u007e]/.test([...(c.vars ?? []), ...(c.setup ?? []), c.call].join(" ")),
    );
    expect(nonAscii.length).toBeGreaterThan(80);
    for (const c of nonAscii)
      expect(`${c.type}|${c.method}|${c.state}|${c.depends}`).toEndWith("|locale");
    // an ASCII-only cell stays unflagged, and AsDateTime is a time-zone cell
    expect(
      f.cells.find((c) => c.type === "TextBuilder" && c.state === "once")?.depends,
    ).toBeUndefined();
    expect(f.cells.find((c) => c.method === "AsDateTime")?.depends).toBe("tz");
  });

  test("every text compare, and AsDate/AsTime/AsDecimal of JSON text, is flagged locale, ASCII or not", () => {
    const compares = f.cells.filter((c) => c.type === "TextCompare");
    expect(compares.length).toBeGreaterThan(30);
    for (const c of compares) expect(`${c.method}|${c.state}|${c.depends}`).toEndWith("|locale");
    const textConv = f.cells.filter(
      (c) => /^As(Date|Time|Decimal)$/.test(c.method) && c.state.startsWith("'"),
    );
    expect(textConv.length).toBeGreaterThan(5);
    for (const c of textConv) expect(`${c.method}|${c.state}|${c.depends}`).toEndWith("|locale");
  });

  test("only the two measured pairs share their AL", () => {
    const body = (c: (typeof f.cells)[number]) =>
      JSON.stringify([c.vars, c.setup, c.call, c.reader]);
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const c of f.cells) {
      const k = body(c);
      const first = seen.get(k);
      if (first !== undefined) dups.push(`${first} = ${c.method} ${c.state}`);
      else seen.set(k, `${c.method} ${c.state}`);
    }
    expect(dups.sort()).toEqual([
      "Keys count = Keys count DOC",
      "less a vs B = ordered a before B",
    ]);
  });
});
