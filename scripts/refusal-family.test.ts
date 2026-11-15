import { describe, expect, test } from "bun:test";
import {
  BASE_ID,
  BC_UNAVAILABLE_TABLES,
  DOTNET_EXCEPTION,
  DOTNET_EXCEPTION_RSA,
  DOTNET_NO_OBJECT,
  FAMILIES,
  type Family,
  GET_URL,
  NO_CLIENT,
  PERMISSION_DENIAL,
  PLATFORM_TABLE_READ,
  PUBAPP_FLOWFIELD,
  TABLE_CONNECTION,
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
