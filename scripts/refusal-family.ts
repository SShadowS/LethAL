#!/usr/bin/env bun
/**
 * PR-01 (process review item 5): a generator per refusal family. It emits one invented AL app whose cells are type x method x
 * state, each in its own test codeunit (a refusal in one test of a codeunit cascades to the tests after it), runs it on an
 * al-runner build, and lists every cell al-runner refuses, grouped into classes by its refusal text.
 *
 *   bun scripts/refusal-family.ts --family untouched-handle [--bin <al-runner>] [--out <dir>] [--json <report.json>]
 *
 * Each test only makes its call: a pass means the call returned, a fail that it raised an error (its message is kept), a
 * refusal that al-runner would not run it. What BC does in each cell is not known here (an error or a no-op): only a later BC
 * differential measures it, so the report lists refusals, never "differs from BC". A class is NEW when no text of the family's
 * upstream issue names it (`known`, by its stable part).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_TIMEOUT_MESSAGE, isV3RefusalText } from "../packages/runner/src/al-runner-rows";

export interface Cell {
  readonly type: string;
  readonly method: string;
  readonly state: string;
  /** AL `var` lines the call needs (besides the handle). */
  readonly vars?: readonly string[];
  /** AL statements that put the handle in its state (none: untouched). */
  readonly setup?: readonly string[];
  /** The one AL statement under test. */
  readonly call: string;
  /** PR-17: whole handler procedures the cell binds (`[HandlerFunctions]`), for a call that shows UI. */
  readonly handlers?: readonly string[];
  /** PR-52: what the answer depends on besides the call: the session's language and region, or its time zone. */
  readonly depends?: "locale" | "tz" | "carry";
  /**
   * PR-63: a second test in the same codeunit, run after the first. The cell's own body becomes `SetLanguage` (it must pass);
   * this becomes `ReadLanguage`, and its failure message is the cell's answer.
   */
  readonly reader?: {
    readonly vars?: readonly string[];
    readonly setup?: readonly string[];
    readonly call: string;
  };
}

/** PR-63: the two test names of a two-test cell. */
// the A_/B_ prefixes make alphabetical and declaration order agree
export const SET_TEST = "A_SetLanguage";
export const READ_TEST = "B_ReadLanguage";

export interface Family {
  readonly name: string;
  readonly issue: string;
  /** Stable parts of refusal texts the family's issue already names. */
  readonly known: readonly string[];
  /** AL objects the cells need besides the test codeunits (a table to open). */
  readonly support: string;
  /** The handle's declaration, per type. */
  readonly handles: Readonly<Record<string, string>>;
  readonly cells: readonly Cell[];
  /** PR-02: the app's `target` when the cells need one (DotNet needs `OnPrem`). */
  readonly target?: "OnPrem";
  /** PR-17: al-runner arguments the family's run needs (`--no-client`), put before the app. */
  readonly args?: readonly string[];
  /** PR-16: apps the cells call (Microsoft's Permissions Mock), as app.json `dependencies`. */
  readonly dependencies?: readonly {
    readonly id: string;
    readonly name: string;
    readonly publisher: string;
    readonly version: string;
  }[];
}

const untouched = (type: string, method: string, call: string, vars: string[] = []): Cell => ({
  type,
  method,
  state: "untouched",
  vars,
  call,
});
const closedRef = (method: string, call: string, vars: string[] = []): Cell => ({
  type: "RecordRef",
  method,
  state: "closed",
  vars,
  setup: ['RR.Open(Database::"Cell Row");', "RR.Close();"],
  call,
});

/** #7760's family: a handle used before anything assigned, created or opened it. */
export const UNTOUCHED_HANDLE: Family = {
  name: "untouched-handle",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7760",
  known: [
    "an InStream was expected, got an untouched handle",
    "an OutStream was expected, got an untouched handle",
    "use of an InStream that was never created",
    "use of an OutStream that was never created",
    "RecordRef.FieldCount on a RecordRef that is not open",
    "FieldRef.Class on a FieldRef that was never assigned",
    "KeyRef.FieldCount on a KeyRef that was never assigned",
    "CopyStream from an untouched handle into a DotNet stream",
  ],
  support:
    'table 51000 "Cell Row"\n{\n    fields\n    {\n        field(1; "Code"; Code[10]) { }\n    }\n    keys { key(PK; "Code") { Clustered = true; } }\n}\n',
  handles: {
    InStream: "InS: InStream;",
    OutStream: "OutS: OutStream;",
    XmlElement: "E: XmlElement;",
    KeyRef: "K: KeyRef;",
    FieldRef: "FR: FieldRef;",
    RecordRef: "RR: RecordRef;",
  },
  cells: [
    untouched("InStream", "EOS", "B := InS.EOS();", ["B: Boolean;"]),
    untouched("InStream", "ReadText", "InS.ReadText(T);", ["T: Text;"]),
    untouched("InStream", "Read", "InS.Read(T);", ["T: Text;"]),
    untouched("InStream", "Length", "I := InS.Length();", ["I: BigInteger;"]),
    untouched("InStream", "Position", "I := InS.Position();", ["I: BigInteger;"]),
    untouched("InStream", "ResetPosition", "InS.ResetPosition();"),
    untouched("OutStream", "WriteText", "OutS.WriteText('x');"),
    untouched("OutStream", "Write", "OutS.Write('x');"),
    untouched("OutStream", "CopyStream", "CopyStream(OutS, InS);", ["InS: InStream;"]),
    untouched("XmlElement", "Name", "T := E.Name();", ["T: Text;"]),
    untouched("XmlElement", "InnerText", "T := E.InnerText();", ["T: Text;"]),
    untouched("XmlElement", "InnerXml", "T := E.InnerXml();", ["T: Text;"]),
    untouched("XmlElement", "Add", "E.Add(XmlText.Create('x'));"),
    untouched("XmlElement", "SetAttribute", "E.SetAttribute('a', 'b');"),
    untouched("XmlElement", "GetChildElements", "L := E.GetChildElements();", ["L: XmlNodeList;"]),
    untouched("XmlElement", "Attributes", "A := E.Attributes();", ["A: XmlAttributeCollection;"]),
    untouched("XmlElement", "AsXmlNode", "N := E.AsXmlNode();", ["N: XmlNode;"]),
    untouched("XmlElement", "WriteTo", "E.WriteTo(T);", ["T: Text;"]),
    untouched("KeyRef", "FieldCount", "I := K.FieldCount();", ["I: Integer;"]),
    untouched("KeyRef", "Active", "B := K.Active();", ["B: Boolean;"]),
    untouched("KeyRef", "FieldIndex", "F := K.FieldIndex(1);", ["F: FieldRef;"]),
    untouched("KeyRef", "Record", "R := K.Record();", ["R: RecordRef;"]),
    untouched("FieldRef", "Class", "C := FR.Class();", ["C: FieldClass;"]),
    untouched("FieldRef", "Name", "T := FR.Name();", ["T: Text;"]),
    untouched("FieldRef", "Number", "I := FR.Number();", ["I: Integer;"]),
    untouched("FieldRef", "Type", "Y := FR.Type();", ["Y: FieldType;"]),
    untouched("FieldRef", "Length", "I := FR.Length();", ["I: Integer;"]),
    untouched("FieldRef", "Caption", "T := FR.Caption();", ["T: Text;"]),
    untouched("FieldRef", "Value", "V := FR.Value();", ["V: Variant;"]),
    untouched("FieldRef", "SetRange", "FR.SetRange();"),
    untouched("FieldRef", "GetFilter", "T := FR.GetFilter();", ["T: Text;"]),
    untouched("FieldRef", "Active", "B := FR.Active();", ["B: Boolean;"]),
    untouched("FieldRef", "Relation", "I := FR.Relation();", ["I: Integer;"]),
    untouched("FieldRef", "Record", "R := FR.Record();", ["R: RecordRef;"]),
    untouched("RecordRef", "Number", "I := RR.Number();", ["I: Integer;"]),
    untouched("RecordRef", "Name", "T := RR.Name();", ["T: Text;"]),
    untouched("RecordRef", "FieldCount", "I := RR.FieldCount();", ["I: Integer;"]),
    untouched("RecordRef", "KeyCount", "I := RR.KeyCount();", ["I: Integer;"]),
    untouched("RecordRef", "FindSet", "B := RR.FindSet();", ["B: Boolean;"]),
    untouched("RecordRef", "FindFirst", "B := RR.FindFirst();", ["B: Boolean;"]),
    untouched("RecordRef", "IsEmpty", "B := RR.IsEmpty();", ["B: Boolean;"]),
    untouched("RecordRef", "Count", "I := RR.Count();", ["I: Integer;"]),
    untouched("RecordRef", "SetRecFilter", "RR.SetRecFilter();"),
    untouched("RecordRef", "GetFilters", "T := RR.GetFilters();", ["T: Text;"]),
    untouched("RecordRef", "ReadPermission", "B := RR.ReadPermission();", ["B: Boolean;"]),
    untouched("RecordRef", "WritePermission", "B := RR.WritePermission();", ["B: Boolean;"]),
    untouched("RecordRef", "Close", "RR.Close();"),
    untouched("RecordRef", "IsTemporary", "B := RR.IsTemporary();", ["B: Boolean;"]),
    untouched("RecordRef", "Reset", "RR.Reset();"),
    untouched("RecordRef", "Field", "F := RR.Field(1);", ["F: FieldRef;"]),
    untouched("RecordRef", "KeyIndex", "K := RR.KeyIndex(1);", ["K: KeyRef;"]),
    untouched("RecordRef", "Caption", "T := RR.Caption();", ["T: Text;"]),
    untouched("RecordRef", "Init", "RR.Init();"),
    untouched("RecordRef", "SetLoadFields", "RR.SetLoadFields(1);"),
    closedRef("Number", "I := RR.Number();", ["I: Integer;"]),
    closedRef("FieldCount", "I := RR.FieldCount();", ["I: Integer;"]),
    closedRef("FindSet", "B := RR.FindSet();", ["B: Boolean;"]),
    closedRef("IsEmpty", "B := RR.IsEmpty();", ["B: Boolean;"]),
    closedRef("Field", "F := RR.Field(1);", ["F: FieldRef;"]),
  ],
};

const noObject = (type: string, method: string, call: string, vars: string[] = []): Cell => ({
  type,
  method,
  state: "no object",
  vars,
  call,
});

/**
 * PR-02, #8036's family: a member of a DotNet variable that holds no object (declared, never constructed or assigned; a mutant
 * that removes the line making the object leaves exactly this), over .NET types BC apps use. Properties and methods; each
 * statement only makes the one access.
 */
export const DOTNET_NO_OBJECT: Family = {
  name: "dotnet-no-object",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8036",
  target: "OnPrem",
  known: [
    // #8036 item 1, as worded upstream now (still a refusal): a member of a DotNet variable that holds no object (Uri.AbsoluteUri, UriBuilder.Query).
    "DotNet System.Uri.AbsoluteUri: 'System.Uri.AbsoluteUri' is an instance member and the variable holds no object",
  ],
  support: `dotnet
{
    assembly(System)
    {
        type(System.Uri; GenUri) { }
        type(System.UriBuilder; GenUriBuilder) { }
        type(System.Text.RegularExpressions.Regex; GenRegex) { }
    }
    assembly(mscorlib)
    {
        type(System.Text.StringBuilder; GenStringBuilder) { }
        type(System.TimeZoneInfo; GenTimeZoneInfo) { }
        type(System.Globalization.CultureInfo; GenCultureInfo) { }
        type(System.IO.MemoryStream; GenMemoryStream) { }
        type(System.Text.Encoding; GenEncoding) { }
    }
    assembly(System.Xml)
    {
        type(System.Xml.XmlDocument; GenXmlDocument) { }
    }
}
`,
  handles: {
    Uri: "U: DotNet GenUri;",
    UriBuilder: "UB: DotNet GenUriBuilder;",
    Regex: "RX: DotNet GenRegex;",
    StringBuilder: "SB: DotNet GenStringBuilder;",
    TimeZoneInfo: "Z: DotNet GenTimeZoneInfo;",
    CultureInfo: "CI: DotNet GenCultureInfo;",
    MemoryStream: "MS: DotNet GenMemoryStream;",
    Encoding: "EN: DotNet GenEncoding;",
    XmlDocument: "XD: DotNet GenXmlDocument;",
  },
  cells: [
    noObject("Uri", "AbsoluteUri", "T := U.AbsoluteUri;", ["T: Text;"]),
    noObject("Uri", "Host", "T := U.Host;", ["T: Text;"]),
    noObject("Uri", "Port", "I := U.Port;", ["I: Integer;"]),
    noObject("Uri", "IsAbsoluteUri", "B := U.IsAbsoluteUri;", ["B: Boolean;"]),
    noObject("Uri", "ToString", "T := U.ToString();", ["T: Text;"]),
    noObject("UriBuilder", "Query", "T := UB.Query;", ["T: Text;"]),
    noObject("UriBuilder", "Host", "T := UB.Host;", ["T: Text;"]),
    noObject("UriBuilder", "ToString", "T := UB.ToString();", ["T: Text;"]),
    noObject("Regex", "IsMatch", "B := RX.IsMatch('a');", ["B: Boolean;"]),
    noObject("Regex", "Replace", "T := RX.Replace('a', 'b');", ["T: Text;"]),
    noObject("Regex", "ToString", "T := RX.ToString();", ["T: Text;"]),
    noObject("StringBuilder", "Append", "SB.Append('x');"),
    noObject("StringBuilder", "ToString", "T := SB.ToString();", ["T: Text;"]),
    noObject("StringBuilder", "Length", "I := SB.Length;", ["I: Integer;"]),
    noObject("StringBuilder", "Clear", "SB.Clear();"),
    noObject("TimeZoneInfo", "Id", "T := Z.Id;", ["T: Text;"]),
    noObject("TimeZoneInfo", "DisplayName", "T := Z.DisplayName;", ["T: Text;"]),
    noObject("TimeZoneInfo", "GetUtcOffset", "Z.GetUtcOffset(CurrentDateTime());"),
    noObject("CultureInfo", "Name", "T := CI.Name;", ["T: Text;"]),
    noObject("CultureInfo", "DisplayName", "T := CI.DisplayName;", ["T: Text;"]),
    noObject("CultureInfo", "ToString", "T := CI.ToString();", ["T: Text;"]),
    noObject("MemoryStream", "Length", "L := MS.Length;", ["L: BigInteger;"]),
    noObject("MemoryStream", "Position", "L := MS.Position;", ["L: BigInteger;"]),
    noObject("MemoryStream", "Close", "MS.Close();"),
    noObject("Encoding", "WebName", "T := EN.WebName;", ["T: Text;"]),
    noObject("Encoding", "EncodingName", "T := EN.EncodingName;", ["T: Text;"]),
    noObject("XmlDocument", "OuterXml", "T := XD.OuterXml;", ["T: Text;"]),
    noObject("XmlDocument", "InnerText", "T := XD.InnerText;", ["T: Text;"]),
    noObject("XmlDocument", "LoadXml", "XD.LoadXml('<a/>');"),
  ],
};

/**
 * PR-13: #7415's family, the ledger's largest open one (3,054 sightings, nearly all `Api Web Service`): a read of a platform
 * table al-runner's store has no provider for. One cell per platform table and read: `IsEmpty` and `FindFirst` of each
 * non-temporary table of BC 28.4's System app (`refusal-family-platform-tables.json`, read from al-runner's own artifact),
 * so every table without a provider shows up before a corpus meets it.
 */
const PLATFORM_TABLES = (await Bun.file(
  join(import.meta.dir, "refusal-family-platform-tables.json"),
).json()) as readonly (readonly [number, string])[];
const tableType = (name: string) => `T${name.replace(/[^A-Za-z0-9]/g, "")}`;
export const PLATFORM_TABLE_READ: Family = {
  name: "platform-table-read",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7415",
  target: "OnPrem",
  known: ["store error platform table 'All Control Fields' (2000000202) has no provider"],
  support: "",
  handles: Object.fromEntries(
    PLATFORM_TABLES.map(([, name]) => [tableType(name), `R: Record "${name}";`]),
  ),
  cells: PLATFORM_TABLES.flatMap(([, name]) => [
    { type: tableType(name), method: "IsEmpty", state: "fresh", call: "if R.IsEmpty() then;" },
    { type: tableType(name), method: "FindFirst", state: "fresh", call: "if R.FindFirst() then;" },
  ]),
};

/**
 * PR-16: #7854's family, the ledger's largest open one after #7415 (843 sightings; its own permission denials 493): a read of a
 * system table under permission sets a test assigned with Microsoft's Permissions Mock (as Library - Lower Permissions
 * does). One pair of cells per platform table whose plain read runs on al-runner (PR-13's run on edge-5a58a0f16): the read
 * under a set that does not grant the table, and under one that grants it Read.
 */
const READABLE = new Set(
  (
    "PermissionSet Permission Date Session Integer AllObj Printer Field WindowsLanguage CodeCoverage LanguageSelection " +
    "AccessControl AllObjWithCaption Key RecordLink UserPersonalization WebService Chart PageDataPersonalization " +
    "TenantProfileSetting APIWebhookSubscription APIWebhookNotification APIWebhookNotificationAggr ActiveSession " +
    "ServerInstance DocumentService DocumentServiceScenario User UserProperty Device EntityText TableSynchSetup " +
    "TableMetadata CodeUnitMetadata PageMetadata ReportMetadata EventSubscription TableRelationsMetadata QueryMetadata " +
    "IntelligentCloud NAVAppInstalledApp NAVAppExtra DataSensitivity TimeZone TenantPermissionSet TenantPermission " +
    "AggregatePermissionSet TenantWebService ConfigurationPackageFile ScheduledTask TenantProfile AllProfile " +
    "ODataEdmType MediaResources TenantMedia TenantProfilePageMetadata TenantLicenseState PageControlField " +
    "WebhookNotification ObjectOptions WebhookSubscription NAVAppSetting ReportDataItems ObjectAccessIntentOverride " +
    "PublishedApplication FeatureKey InstalledApplication ReportSettingsOverride TenantReportLayout " +
    "TenantReportLayoutSelection ReportLayoutList PrivacyNotice PrivacyNoticeApproval MetadataPermissionSet " +
    "MetadataPermissionSetRel TenantPermissionSetRel SignupContext XmlPortMetadata CodeCoverageTestLookup " +
    "CodeCoverageTestsRun MCPConfiguration MCPConfigurationTool AgentCreationControl"
  ).split(" "),
);
const READABLE_TABLES = PLATFORM_TABLES.filter(([, name]) =>
  READABLE.has(tableType(name).slice(1)),
);
// IsEmpty and FindFirst: BC allows an IsEmpty without Read permission on an ordinary table (#7854, measured upstream),
// while FindFirst reads a row
const underSet = (name: string, set: string, method: "IsEmpty" | "FindFirst") => ({
  type: tableType(name),
  method,
  state: set === "Cell No Grant" ? "denied" : "granted",
  vars: ['PermissionsMock: Codeunit "Permissions Mock";'],
  call: `PermissionsMock.Set('${set}');\n        if R.${method}() then;`,
});
export const PERMISSION_DENIAL: Family = {
  name: "permission-denial",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7854",
  target: "OnPrem",
  dependencies: [
    {
      id: "40860557-a18d-42ad-aecb-22b7dd80dc80",
      name: "Permissions Mock",
      publisher: "Microsoft",
      version: "28.0.0.0",
    },
  ],
  known: [
    "a permission denial (read permission on object type 1 id 2000000183) whose error is not pinned yet (on a system table; probe P13 pins Tenant Media only); the test is not run",
    "ReadPermission on a system table under sets that do not grant it is not pinned (ADR-062 probe P19)",
  ],
  // ids 51000/51001: BASE_ID (declared below), the first id of the app's range; codeunits start at BASE_ID + 1
  support: `table 51000 "Perm Cell Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

permissionset 51000 "Cell No Grant"
{
    Assignable = true;
    Permissions = tabledata "Perm Cell Row" = R;
}

permissionset 51001 "Cell Grant Read"
{
    Assignable = true;
    Permissions = tabledata "Perm Cell Row" = R${READABLE_TABLES.map(([, name]) => `,\n        tabledata "${name}" = R`).join("")};
}
`,
  handles: Object.fromEntries(
    READABLE_TABLES.map(([, name]) => [tableType(name), `R: Record "${name}";`]),
  ),
  cells: READABLE_TABLES.flatMap(([, name]) =>
    (["IsEmpty", "FindFirst"] as const).flatMap((m) => [
      underSet(name, "Cell No Grant", m),
      underSet(name, "Cell Grant Read", m),
    ]),
  ),
};

/**
 * PR-17: #8028's family, the ledger's largest open one after #7854 (429 sightings over six causes, every one "... in a session
 * without a client (--no-client): what BC does there is not pinned"). LethAL runs al-runner with `--no-client` because BC's
 * web-service path, where LethAL runs tests on BC, has no client. One cell per call that asks the client something or shows
 * UI, with its handler bound and without (BC's answer may differ: a handler can take the UI, or a session with no client
 * can answer without one).
 */
const handler = (attr: string, sig: string, body = "") =>
  `    [${attr}]\n    procedure ${sig}\n    begin\n${body ? `        ${body}\n` : ""}    end;\n`;
const H = {
  confirm: handler(
    "ConfirmHandler",
    "OnConfirm(Question: Text[1024]; var Reply: Boolean)",
    "Reply := true;",
  ),
  message: handler("MessageHandler", "OnMessage(Msg: Text[1024])"),
  strMenu: handler(
    "StrMenuHandler",
    "OnStrMenu(Options: Text[1024]; var Choice: Integer; Instruction: Text[1024])",
    "Choice := 1;",
  ),
  page: handler("PageHandler", 'OnPage(var P: TestPage "Cell Card")', "P.Close();"),
  modal: handler("ModalPageHandler", 'OnModal(var P: TestPage "Cell Card")', "P.OK().Invoke();"),
  request: handler(
    "RequestPageHandler",
    'OnRequest(var R: TestRequestPage "Cell Report")',
    "R.OK().Invoke();",
  ),
  report: handler("ReportHandler", 'OnReport(var R: Report "Cell Report")'),
  notify: handler("SendNotificationHandler", "OnNotify(var N: Notification): Boolean"),
  link: handler("HyperlinkHandler", "OnLink(Link: Text[1024])"),
};
const insertRow = ["Row.Code := 'A';", "if Row.Insert() then;"];
const ui = (
  type: string,
  method: string,
  call: string,
  h: string | undefined,
  extra: Partial<Cell> = {},
): Cell[] => [
  ...(h !== undefined ? [{ type, method, state: "handler", call, handlers: [h], ...extra }] : []),
  { type, method, state: "nohandler", call, ...extra },
];
export const NO_CLIENT: Family = {
  name: "no-client",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8028",
  args: ["--no-client"],
  known: [
    "CurrentClientType in a session without a client (--no-client): what BC does there is not pinned (probe wanted, docs/probes-needed.md P1)",
    // the text names the report; the family's report is always "Cell Report"
    'the request page of report "Cell Report" with a RequestPageHandler or ReportHandler bound in a session without a client (--no-client): what BC does there is not pinned',
    "Page.Run with a record or a page name in a session without a client (--no-client): what BC does there is not pinned",
    "Page.RunModal with a record or a page name in a session without a client (--no-client): what BC does there is not pinned",
  ],
  // ids 51000: BASE_ID, the first id of the app's range (codeunits start at BASE_ID + 1)
  support: `table 51000 "Cell Client Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

page 51000 "Cell Card"
{
    PageType = Card;
    SourceTable = "Cell Client Row";
    layout { area(Content) { field(Code; Rec.Code) { } } }
}

report 51000 "Cell Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "Cell Client Row") { } }
    requestpage { layout { area(Content) { } } }
}
`,
  handles: {
    Page: 'Row: Record "Cell Client Row";',
    TestPage: 'P: TestPage "Cell Card";',
    Dialog: "D: Dialog;",
    Notification: "N: Notification;",
  },
  cells: [
    {
      type: "Session",
      method: "CurrentClientType",
      state: "noclient",
      call: "if CurrentClientType() = ClientType::Web then;",
    },
    {
      type: "Session",
      method: "DefaultClientType",
      state: "noclient",
      call: "if DefaultClientType() = ClientType::Web then;",
    },
    { type: "Session", method: "GuiAllowed", state: "noclient", call: "if GuiAllowed() then;" },
    ...ui("Dialog", "Confirm", "if Confirm('Go on?') then;", H.confirm),
    ...ui("Dialog", "Message", "Message('Done.');", H.message),
    ...ui("Dialog", "StrMenu", "if StrMenu('One,Two') = 1 then;", H.strMenu),
    ...ui("Dialog", "Open", "D.Open('Working');\n        D.Close();", undefined),
    ...ui("Page", "Run", 'Page.Run(Page::"Cell Card");', H.page),
    ...ui("Page", "RunRecord", 'Page.Run(Page::"Cell Card", Row);', H.page, { setup: insertRow }),
    ...ui(
      "Page",
      "RunModal",
      'if Page.RunModal(Page::"Cell Card", Row) = Action::LookupOK then;',
      H.modal,
      {
        setup: insertRow,
      },
    ),
    ...ui("TestPage", "OpenView", "P.OpenView();\n        P.Close();", undefined),
    ...ui("Report", "Run", 'Report.Run(Report::"Cell Report");', H.request),
    ...ui("Report", "RunModal", 'Report.RunModal(Report::"Cell Report");', H.request),
    ...ui(
      "Report",
      "RunRequestPage",
      "if Report.RunRequestPage(Report::\"Cell Report\") <> '' then;",
      H.request,
    ),
    {
      type: "Report",
      method: "Run",
      state: "reporthandler",
      call: 'Report.Run(Report::"Cell Report");',
      handlers: [H.report],
    },
    ...ui("Notification", "Send", "N.Message('Note');\n        N.Send();", H.notify),
    ...ui("Session", "Hyperlink", "Hyperlink('https://example.invalid/');", H.link),
  ],
};

/**
 * PR-26: #7586's family, the largest coherent open one after families 1-5 (213 standing sightings over all v3 stores after
 * R1036, 292 in PR-13's run): `GetUrl` in a form al-runner does not pin ("GetUrl(ClientType::<x>; the call had N arguments):
 * this object type or argument list (not pinned)"). One cell per client type and argument form: the client type alone, with the
 * company, with an object type and id (each object type), with a record, and with a record and UseFilters. Each cell fails on
 * purpose with `GETURL <url>`, so a run shows the URL each runtime builds (al-runner's and BC's hosts differ; the form is the
 * comparison), not only whether the call returned.
 */
const GETURL_CLIENTS = [
  "Current",
  "Default",
  "Web",
  "Windows",
  "Tablet",
  "Phone",
  "Desktop",
  "SOAP",
  "OData",
  "ODataV4",
  "Api",
] as const;
const INSERT_A = ["Row.Code := 'A';", "if Row.Insert() then;"];
const GETURL_FORMS: readonly (readonly [string, string, (readonly string[])?])[] = [
  ["Plain", ""],
  ["Company", ", CompanyName()"],
  ["Page", ', CompanyName(), ObjectType::Page, Page::"Cell Url Card"'],
  ["Report", ', CompanyName(), ObjectType::Report, Report::"Cell Url Report"'],
  ["Codeunit", ', CompanyName(), ObjectType::Codeunit, Codeunit::"Cell Url Service"'],
  ["Query", ', CompanyName(), ObjectType::Query, Query::"Cell Url Query"'],
  ["Table", ', CompanyName(), ObjectType::Table, Database::"Cell Url Row"'],
  ["PageRecord", ', CompanyName(), ObjectType::Page, Page::"Cell Url Card", Row', INSERT_A],
  [
    "PageFilters",
    ', CompanyName(), ObjectType::Page, Page::"Cell Url Card", Row, true',
    [...INSERT_A, "Row.SetRange(Code, 'A');"],
  ],
];
export const GET_URL: Family = {
  name: "get-url",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7586",
  // the issue's own text (the ledger's two #7586 keys). al-runner prints it with "(not pinned)", which `refusalText` strips
  // before classOf sees it; classOf folds both forms.
  known: [
    "GetUrl(ClientType::ODataV4; the call had 5 arguments): this object type or argument list (not pinned)",
  ],
  // ids 51000: BASE_ID (object types share ids; the cells' codeunits start at BASE_ID + 1)
  support: `table 51000 "Cell Url Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

page 51000 "Cell Url Card"
{
    PageType = Card;
    SourceTable = "Cell Url Row";
    layout { area(Content) { field(Code; Rec.Code) { } } }
}

report 51000 "Cell Url Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "Cell Url Row") { } }
}

codeunit 51000 "Cell Url Service"
{
    procedure Ping(): Text
    begin
        exit('pong');
    end;
}

query 51000 "Cell Url Query"
{
    elements { dataitem(Row; "Cell Url Row") { column(Code; Code) { } } }
}
`,
  handles: { GetUrl: 'Row: Record "Cell Url Row";' },
  cells: GETURL_CLIENTS.flatMap((client) =>
    GETURL_FORMS.map(
      ([form, args, setup]): Cell => ({
        type: "GetUrl",
        method: form,
        state: client,
        ...(setup !== undefined ? { setup } : {}),
        call: `Error('GETURL %1', GetUrl(ClientType::${client}${args}));`,
      }),
    ),
  ),
};

/**
 * PR-30: #7837's family, the largest coherent open one after families 1-7 under R1036's count (380 standing sightings in 11
 * stores, Field Service Integration's): a Dataverse table connection. The app builds `Url=%1; UserName=%2; ...` around the
 * test marker `@@test@@`, and al-runner pins only the exact string `@@test@@` ("RegisterTableConnection with a connection string
 * other than @@test@@"). One cell per connection string and operation (register; register and set as default; register and
 * unregister), and one per operation on a TableType = CRM table after the exact marker is registered (the family's second
 * cause, "Insert on a TableType = CRM table through a table connection").
 */
const TC_STRINGS: readonly (readonly [string, string])[] = [
  ["Marker", "@@test@@"],
  ["UrlMarker", "Url=@@test@@"],
  ["AppShape", "Url=@@test@@; UserName=cell; Password=cell; ProxyVersion=9; AuthType=Office365"],
  ["MarkerUpper", "@@TEST@@"],
  ["RealUrl", "Url=https://cell.example.invalid; AuthType=Office365"],
];
// Review (PR-30): BC keeps a table connection for the whole session and refuses a second registration of the same name ("...
// has already been registered"), while al-runner starts each codeunit fresh. So every cell uses its own connection name, and
// first unregisters a leftover of it, so no cell meets another's connection on BC.
const TC_FRESH = (name: string) =>
  `if HasTableConnection(TableConnectionType::CRM, '${name}') then UnregisterTableConnection(TableConnectionType::CRM, '${name}');`;
const TC_REGISTER = (name: string, s: string) =>
  `RegisterTableConnection(TableConnectionType::CRM, '${name}', '${s}');`;
export const TABLE_CONNECTION: Family = {
  name: "table-connection",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7837",
  known: [
    "RegisterTableConnection with a connection string other than @@test@@ (no Dataverse in the runtime)",
    "Insert on a TableType = CRM table through a table connection: whether the database trigger runs is not pinned",
  ],
  // ids 51000: BASE_ID (the cells' codeunits start at BASE_ID + 1)
  support: `table 51000 "Cell CRM Row"
{
    TableType = CRM;
    ExternalName = 'cell_row';
    fields
    {
        field(1; "Id"; Guid) { ExternalName = 'cell_rowid'; ExternalType = 'Uniqueidentifier'; ExternalAccess = Insert; }
        field(2; "Name"; Text[100]) { ExternalName = 'cell_name'; ExternalType = 'String'; }
    }
    keys { key(PK; "Id") { Clustered = true; } }
}

table 51001 "Cell CRM Trigger Row"
{
    // the second cause: a CRM table with a database trigger
    TableType = CRM;
    ExternalName = 'cell_trigger_row';
    fields
    {
        field(1; "Id"; Guid) { ExternalName = 'cell_trigger_rowid'; ExternalType = 'Uniqueidentifier'; ExternalAccess = Insert; }
        field(2; "Name"; Text[100]) { ExternalName = 'cell_name'; ExternalType = 'String'; }
    }
    keys { key(PK; "Id") { Clustered = true; } }

    trigger OnInsert()
    begin
        Name := 'set by OnInsert';
    end;
}
`,
  handles: {
    CRMRow: 'Row: Record "Cell CRM Row";',
    CRMTriggerRow: 'Row: Record "Cell CRM Trigger Row";',
  },
  cells: [
    ...TC_STRINGS.flatMap(([name, s]): Cell[] => [
      {
        type: "Connection",
        method: "Register",
        state: name,
        setup: [TC_FRESH(`${name}Register`)],
        call: TC_REGISTER(`${name}Register`, s),
      },
      {
        type: "Connection",
        method: "SetDefault",
        state: name,
        setup: [TC_FRESH(`${name}SetDefault`), TC_REGISTER(`${name}SetDefault`, s)],
        call: `SetDefaultTableConnection(TableConnectionType::CRM, '${name}SetDefault');`,
      },
      {
        type: "Connection",
        method: "Unregister",
        state: name,
        setup: [TC_FRESH(`${name}Unregister`), TC_REGISTER(`${name}Unregister`, s)],
        call: `UnregisterTableConnection(TableConnectionType::CRM, '${name}Unregister');`,
      },
    ]),
    ...(
      [
        ["Insert", ["Row.Id := CreateGuid();", "Row.Name := 'A';"], "Row.Insert();"],
        ["FindFirst", [], "if Row.FindFirst() then;"],
        ["IsEmpty", [], "if Row.IsEmpty() then;"],
        [
          "Modify",
          ["Row.Id := CreateGuid();", "Row.Name := 'A';", "Row.Insert();", "Row.Name := 'B';"],
          "Row.Modify();",
        ],
        [
          "Delete",
          ["Row.Id := CreateGuid();", "Row.Name := 'A';", "Row.Insert();"],
          "Row.Delete();",
        ],
      ] as const
    ).map(
      ([method, more, call]): Cell => ({
        type: "CRMRow",
        method,
        state: "marker",
        setup: [
          TC_FRESH(`CRM${method}`),
          TC_REGISTER(`CRM${method}`, "@@test@@"),
          `SetDefaultTableConnection(TableConnectionType::CRM, 'CRM${method}');`,
          ...more,
        ],
        call,
      }),
    ),
    // the same with a database trigger: OnInsert sets a field, read back
    ...(
      [
        ["Insert", "Row.Insert(true);"],
        ["InsertNoTrigger", "Row.Insert(false);"],
      ] as const
    ).map(
      ([method, call]): Cell => ({
        type: "CRMTriggerRow",
        method,
        state: "marker",
        setup: [
          TC_FRESH(`CRMT${method}`),
          TC_REGISTER(`CRMT${method}`, "@@test@@"),
          `SetDefaultTableConnection(TableConnectionType::CRM, 'CRMT${method}');`,
          "Row.Id := CreateGuid();",
          "Row.Name := 'A';",
        ],
        call,
      }),
    ),
  ],
};

/**
 * PR-32: #7924's family, the largest open coherent one after families 1-8 under R1036's count (265 standing sightings, 18 ledger
 * keys): a .NET exception raised inside AL ("DotNet <member> raised the .NET exception <type>: <message>; the text AL would see is
 * not pinned"). One site per .NET member the ledger names (invented calls that raise the same exception type), each in two
 * shapes: `guarded`, under asserterror alone, so the test's outcome does not depend on the text (the issue's claim); and `text`,
 * which carries the text AL sees (GetLastErrorText) out through Error, so BC's run gives upstream the texts. Plus three controls
 * that raise nothing. Left out: the BC-internal QR-code and PDF converters (a TypeInitializationException of the environment) and
 * XmlDocument.Validate (needs a schema set).
 */
interface DotnetSite {
  type: string;
  method: string;
  vars?: string[];
  setup?: string[];
  stmt: string;
}
/** PR-32: a throwing site in two shapes: under asserterror alone, and with GetLastErrorText carried out through Error. */
const guardedAndText = (s: DotnetSite): Cell[] =>
  (["guarded", "text"] as const).map((state) => ({
    type: s.type,
    method: s.method,
    state,
    ...(s.vars !== undefined ? { vars: s.vars } : {}),
    ...(s.setup !== undefined ? { setup: s.setup } : {}),
    call:
      state === "guarded"
        ? `asserterror ${s.stmt}`
        : `asserterror ${s.stmt} Error('DOTNET %1', GetLastErrorText());`,
  }));
const DOTNET_SITES: readonly DotnetSite[] = [
  { type: "Uri", method: "Ctor", stmt: "U := U.Uri('not a uri');" },
  { type: "UriBuilder", method: "Ctor", stmt: "UB := UB.UriBuilder('http://cell.example:port/');" },
  {
    type: "UriBuilder",
    method: "Port",
    setup: ["UB := UB.UriBuilder('http://cell.example/');"],
    stmt: "UB.Port := -5;",
  },
  {
    type: "UriBuilder",
    method: "Scheme",
    setup: ["UB := UB.UriBuilder('http://cell.example/');"],
    stmt: "UB.Scheme := '1 bad';",
  },
  { type: "CultureInfo", method: "Ctor", stmt: "CI := CI.CultureInfo('xx-NOPE-zz');" },
  {
    type: "ZipArchive",
    method: "Ctor",
    vars: ["MS: DotNet GenMemoryStream;"],
    setup: ["MS := MS.MemoryStream();"],
    stmt: "ZA := ZA.ZipArchive(MS);",
  },
  {
    type: "XmlTextWriter",
    method: "WriteEndDocument",
    vars: ["MS: DotNet GenMemoryStream;", "EN: DotNet GenEncoding;"],
    setup: ["MS := MS.MemoryStream();", "XW := XW.XmlTextWriter(MS, EN.UTF8);"],
    stmt: "XW.WriteEndDocument();",
  },
  {
    type: "DataTable",
    method: "RowsItem",
    vars: ["DR: DotNet GenDataRow;"],
    setup: ["DT := DT.DataTable();"],
    stmt: "DR := DT.Rows.Item(0);",
  },
  {
    type: "DataTable",
    method: "ColumnsItem",
    vars: ["DC: DotNet GenDataColumn;"],
    setup: ["DT := DT.DataTable();"],
    stmt: "DC := DT.Columns.Item(0);",
  },
  {
    type: "DataTable",
    method: "RowItem",
    vars: ["DR: DotNet GenDataRow;", "V: Variant;"],
    setup: ["DT := DT.DataTable();", "DR := DT.NewRow();"],
    stmt: "V := DR.Item('nope');",
  },
  {
    type: "JObject",
    method: "AddTwice",
    vars: ["JO2: DotNet GenJObject;"],
    setup: ["JO := JO.JObject();", "JO2 := JO2.JObject();", "JO.Add('a', JO2);"],
    stmt: "JO.Add('a', JO2);",
  },
  {
    type: "X509Certificate2",
    method: "Ctor",
    vars: ["Conv: DotNet GenConvert;"],
    stmt: "C := C.X509Certificate2(Conv.FromBase64String('AAAA'));",
  },
  {
    type: "RSACryptoServiceProvider",
    method: "Decrypt",
    vars: ["Conv: DotNet GenConvert;", "Bytes: DotNet GenArray;"],
    setup: ["RSA := RSA.RSACryptoServiceProvider();"],
    stmt: "Bytes := RSA.Decrypt(Conv.FromBase64String('AAAA'), false);",
  },
  {
    type: "Aes",
    method: "TransformFinalBlock",
    vars: ["D: DotNet GenICryptoTransform;", "Conv: DotNet GenConvert;", "Bytes: DotNet GenArray;"],
    setup: ["A := A.Create();", "D := A.CreateDecryptor();"],
    stmt: "Bytes := D.TransformFinalBlock(Conv.FromBase64String('AAAA'), 0, 3);",
  },
];
export const DOTNET_EXCEPTION: Family = {
  name: "dotnet-exception",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [
    "DotNet System.Data.DataRowCollection.Item raised the .NET exception System.IndexOutOfRangeException: <message>; the text AL would see is not pinned (ADR-014 section 7)",
  ],
  support: `dotnet
{
    assembly(System)
    {
        type(System.Uri; GenUri) { }
        type(System.UriBuilder; GenUriBuilder) { }
        type(System.Security.Cryptography.X509Certificates.X509Certificate2; GenX509Certificate2) { }
    }
    assembly(mscorlib)
    {
        type(System.Globalization.CultureInfo; GenCultureInfo) { }
        type(System.IO.MemoryStream; GenMemoryStream) { }
        type(System.Text.Encoding; GenEncoding) { }
        type(System.Convert; GenConvert) { }
        type(System.Array; GenArray) { }
        type(System.Security.Cryptography.RSACryptoServiceProvider; GenRSACryptoServiceProvider) { }
        type(System.Security.Cryptography.ICryptoTransform; GenICryptoTransform) { }
    }
    assembly(System.Core)
    {
        type(System.Security.Cryptography.Aes; GenAes) { }
    }
    assembly(System.IO.Compression)
    {
        type(System.IO.Compression.ZipArchive; GenZipArchive) { }
    }
    assembly(System.Xml)
    {
        type(System.Xml.XmlTextWriter; GenXmlTextWriter) { }
    }
    assembly(System.Data)
    {
        type(System.Data.DataTable; GenDataTable) { }
        type(System.Data.DataRow; GenDataRow) { }
        type(System.Data.DataColumn; GenDataColumn) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.Linq.JObject; GenJObject) { }
    }
}
`,
  handles: {
    Uri: "U: DotNet GenUri;",
    UriBuilder: "UB: DotNet GenUriBuilder;",
    CultureInfo: "CI: DotNet GenCultureInfo;",
    ZipArchive: "ZA: DotNet GenZipArchive;",
    XmlTextWriter: "XW: DotNet GenXmlTextWriter;",
    DataTable: "DT: DotNet GenDataTable;",
    JObject: "JO: DotNet GenJObject;",
    X509Certificate2: "C: DotNet GenX509Certificate2;",
    RSACryptoServiceProvider: "RSA: DotNet GenRSACryptoServiceProvider;",
    Aes: "A: DotNet GenAes;",
  },
  cells: [
    ...DOTNET_SITES.flatMap(guardedAndText),
    // controls: the same members with arguments that raise nothing
    { type: "Uri", method: "Ctor", state: "ok", call: "U := U.Uri('https://cell.example/');" },
    {
      type: "UriBuilder",
      method: "Ctor",
      state: "ok",
      call: "UB := UB.UriBuilder('http://cell.example/');",
    },
    { type: "CultureInfo", method: "Ctor", state: "ok", call: "CI := CI.CultureInfo('en-US');" },
  ],
};

/**
 * PR-33: R1044's uncovered form, the OpenSSL one of #7924's two largest keys (RSAWrapper.Decrypt 43, RSACryptoServiceProvider.Decrypt
 * 38 standing sightings, all Microsoft's crypto test apps): "raised the .NET exception Interop+Crypto+OpenSslCryptographicException".
 * The stored texts name three OpenSSL causes: "oaep decoding error" (PKCS1 ciphertext decrypted with OAEP), "padding check failed"
 * (OAEP ciphertext decrypted with PKCS1) and "value missing" (a key holding only its public part used to decrypt or sign). Each on
 * both RSA paths (RSACryptoServiceProvider; RSA.Create(), whose type is RSAWrapper), in PR-32's guarded and text shapes, plus a
 * control per path that decrypts with the padding it encrypted with.
 */
const CSP_VARS = ["EN: DotNet GenEncoding;", "Data: DotNet GenArray;", "Bytes: DotNet GenArray;"];
const WRAP_VARS = [...CSP_VARS, "P: DotNet GenRSAEncryptionPadding;"];
const CSP = (s: Omit<DotnetSite, "type" | "vars">): DotnetSite => ({
  type: "CSP",
  vars: CSP_VARS,
  ...s,
});
const WRAP = (s: Omit<DotnetSite, "type" | "vars">): DotnetSite => ({
  type: "RSA",
  vars: WRAP_VARS,
  ...s,
});
const CSP_KEY = ["R := R.RSACryptoServiceProvider();", "Data := EN.UTF8.GetBytes('cell');"];
const CSP_PUBLIC = [
  ...CSP_KEY,
  "R2 := R2.RSACryptoServiceProvider();",
  "R2.FromXmlString(R.ToXmlString(false));",
];
const WRAP_KEY = ["W := W.Create();", "Data := EN.UTF8.GetBytes('cell');"];
const WRAP_PUBLIC = [...WRAP_KEY, "W2 := W2.Create();", "W2.FromXmlString(W.ToXmlString(false));"];
const RSA_SITES: readonly DotnetSite[] = [
  CSP({
    method: "PkcsThenOaep",
    setup: [...CSP_KEY, "Bytes := R.Encrypt(Data, false);"],
    stmt: "Bytes := R.Decrypt(Bytes, true);",
  }),
  CSP({
    method: "OaepThenPkcs",
    setup: [...CSP_KEY, "Bytes := R.Encrypt(Data, true);"],
    stmt: "Bytes := R.Decrypt(Bytes, false);",
  }),
  CSP({
    method: "PublicOnlyDecrypt",
    setup: [...CSP_PUBLIC, "Bytes := R2.Encrypt(Data, false);"],
    stmt: "Bytes := R2.Decrypt(Bytes, false);",
  }),
  CSP({
    method: "PublicOnlySignData",
    setup: CSP_PUBLIC,
    stmt: "Bytes := R2.SignData(Data, 'SHA256');",
  }),
  WRAP({
    method: "PkcsThenOaep",
    setup: [...WRAP_KEY, "Bytes := W.Encrypt(Data, P.Pkcs1);"],
    stmt: "Bytes := W.Decrypt(Bytes, P.OaepSHA1);",
  }),
  WRAP({
    method: "OaepThenPkcs",
    setup: [...WRAP_KEY, "Bytes := W.Encrypt(Data, P.OaepSHA1);"],
    stmt: "Bytes := W.Decrypt(Bytes, P.Pkcs1);",
  }),
  WRAP({
    method: "PublicOnlyDecrypt",
    setup: [...WRAP_PUBLIC, "Bytes := W2.Encrypt(Data, P.Pkcs1);"],
    stmt: "Bytes := W2.Decrypt(Bytes, P.Pkcs1);",
  }),
];
export const DOTNET_EXCEPTION_RSA: Family = {
  name: "dotnet-exception-rsa",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: DOTNET_EXCEPTION.known,
  support: `dotnet
{
    assembly(mscorlib)
    {
        type(System.Text.Encoding; GenEncoding) { }
        type(System.Array; GenArray) { }
        type(System.Security.Cryptography.RSACryptoServiceProvider; GenRSACryptoServiceProvider) { }
        type(System.Security.Cryptography.RSA; GenRSA) { }
        type(System.Security.Cryptography.RSAEncryptionPadding; GenRSAEncryptionPadding) { }
    }
}
`,
  handles: {
    CSP: "R: DotNet GenRSACryptoServiceProvider;\n        R2: DotNet GenRSACryptoServiceProvider;",
    RSA: "W: DotNet GenRSA;\n        W2: DotNet GenRSA;",
  },
  cells: [
    ...RSA_SITES.flatMap(guardedAndText),
    // controls: decrypt with the padding the data was encrypted with
    {
      type: "CSP",
      method: "SamePadding",
      state: "ok",
      vars: CSP_VARS,
      setup: [...CSP_KEY, "Bytes := R.Encrypt(Data, true);"],
      call: "Bytes := R.Decrypt(Bytes, true);",
    },
    {
      type: "RSA",
      method: "SamePadding",
      state: "ok",
      vars: WRAP_VARS,
      setup: [...WRAP_KEY, "Bytes := W.Encrypt(Data, P.OaepSHA1);"],
      call: "Bytes := W.Decrypt(Bytes, P.OaepSHA1);",
    },
  ],
};

/**
 * PR-33: family 10, #8038's, the largest open coherent one after families 1-9 under R1036's count (133 standing sightings, one
 * key): "a permission denial (read permission on object type 0 id 2000000157) whose error is not pinned yet (a FlowField over a
 * system table)". Published Application's own FlowFields read system tables the caller never names: Tenant Visible and PerTenant
 * Or Installed look up NAV App Extra (2000000157), Installed checks Installed Application. Upstream has pinned two shapes (a
 * FindFirst with ID and Tenant Visible; an app table's FlowField over Published Application with ID and Tenant Visible); four
 * Extension Management tests still meet the refusal. One cell per read that makes such a FlowField read, under a set that grants
 * Published Application and under one that grants only the app's own table, plus a plain FindFirst as the control.
 */
const PUBAPP_READS: readonly (readonly [
  type: "PubApp" | "Item",
  method: string,
  setup: string[],
  read: string,
])[] = [
  [
    "PubApp",
    "FindFirstIdTenantVisible",
    ["PA.SetRange(ID, Me.Id());", 'PA.SetRange("Tenant Visible", true);'],
    "if PA.FindFirst() then;",
  ],
  [
    "PubApp",
    "FindFirstTenantVisible",
    ['PA.SetRange("Tenant Visible", true);'],
    "if PA.FindFirst() then;",
  ],
  [
    "PubApp",
    "FindFirstIdPerTenant",
    ["PA.SetRange(ID, Me.Id());", 'PA.SetRange("PerTenant Or Installed", true);'],
    "if PA.FindFirst() then;",
  ],
  [
    "PubApp",
    "FindFirstIdInstalled",
    ["PA.SetRange(ID, Me.Id());", "PA.SetRange(Installed, true);"],
    "if PA.FindFirst() then;",
  ],
  [
    "PubApp",
    "CalcTenantVisible",
    ["PA.SetRange(ID, Me.Id());"],
    'if PA.FindFirst() then PA.CalcFields("Tenant Visible");',
  ],
  [
    "PubApp",
    "CalcPerTenant",
    ["PA.SetRange(ID, Me.Id());"],
    'if PA.FindFirst() then PA.CalcFields("PerTenant Or Installed");',
  ],
  [
    "PubApp",
    "CalcInstalled",
    ["PA.SetRange(ID, Me.Id());"],
    "if PA.FindFirst() then PA.CalcFields(Installed);",
  ],
  [
    "PubApp",
    "IsEmptyTenantVisible",
    ['PA.SetRange("Tenant Visible", true);'],
    "if PA.IsEmpty() then;",
  ],
  [
    "PubApp",
    "CountTenantVisible",
    ['PA.SetRange("Tenant Visible", true);'],
    "if PA.Count() = 0 then;",
  ],
  ["Item", "LookupNameTenantVisible", [], 'Item.CalcFields("Name TV");'],
  ["Item", "ExistTenantVisible", [], 'Item.CalcFields("Exists TV");'],
  ["Item", "CountTenantVisible", [], 'Item.CalcFields("Count TV");'],
  ["Item", "LookupNamePerTenant", [], 'Item.CalcFields("Name PerTenant");'],
  ["Item", "LookupTenantVisible", [], 'Item.CalcFields("Tenant Visible Of App");'],
];
const PUBAPP_SETS = [
  ["granted", "Cell Grant PubApp"],
  ["item only", "Cell Grant Item"],
] as const;
const PUBAPP_VARS = ["Me: ModuleInfo;", 'PermissionsMock: Codeunit "Permissions Mock";'];
const PUBAPP_ITEM = ["Item.Code := 'A';", 'Item."Extension ID" := Me.Id();', "Item.Insert();"];
export const PUBAPP_FLOWFIELD: Family = {
  name: "pubapp-flowfield",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8038",
  target: "OnPrem",
  dependencies: PERMISSION_DENIAL.dependencies ?? [],
  known: [
    "a permission denial (read permission on object type 0 id 2000000157) whose error is not pinned yet (a FlowField over a system table); the test is not run",
    // family 4's (#7854): under the set without Published Application, the read of Published Application itself
    ...(PERMISSION_DENIAL.known[0] !== undefined ? [PERMISSION_DENIAL.known[0]] : []),
  ],
  support: `table 51000 "Cell Item"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; "Extension ID"; Guid) { }
        field(3; "Name TV"; Text[250])
        {
            FieldClass = FlowField;
            CalcFormula = lookup("Published Application".Name where(ID = field("Extension ID"), "Tenant Visible" = const(true)));
        }
        field(4; "Exists TV"; Boolean)
        {
            FieldClass = FlowField;
            CalcFormula = exist("Published Application" where(ID = field("Extension ID"), "Tenant Visible" = const(true)));
        }
        field(5; "Count TV"; Integer)
        {
            FieldClass = FlowField;
            CalcFormula = count("Published Application" where("Tenant Visible" = const(true)));
        }
        field(6; "Name PerTenant"; Text[250])
        {
            FieldClass = FlowField;
            CalcFormula = lookup("Published Application".Name where(ID = field("Extension ID"), "PerTenant Or Installed" = const(true)));
        }
        field(7; "Tenant Visible Of App"; Boolean)
        {
            FieldClass = FlowField;
            CalcFormula = lookup("Published Application"."Tenant Visible" where(ID = field("Extension ID")));
        }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

permissionset 51000 "Cell Grant PubApp"
{
    Assignable = true;
    Permissions = tabledata "Cell Item" = RIMD,
        tabledata "Published Application" = R;
}

permissionset 51001 "Cell Grant Item"
{
    Assignable = true;
    Permissions = tabledata "Cell Item" = RIMD;
}
`,
  handles: {
    PubApp: 'PA: Record "Published Application";',
    Item: 'Item: Record "Cell Item";',
  },
  cells: [
    ...PUBAPP_READS.flatMap(([type, method, filters, read]) =>
      PUBAPP_SETS.map(
        ([state, set]): Cell => ({
          type,
          method,
          state,
          vars: PUBAPP_VARS,
          // BC review (lethal-bugs, bc2): a test codeunit without TestPermissions runs Restrictive on BC, so an Item cell's own
          // Insert is refused before the set is applied; an Item cell applies its set (which grants Cell Item RIMD) first
          setup:
            type === "Item"
              ? [
                  "NavApp.GetCurrentModuleInfo(Me);",
                  `PermissionsMock.Set('${set}');`,
                  ...PUBAPP_ITEM,
                ]
              : ["NavApp.GetCurrentModuleInfo(Me);", ...filters],
          call: type === "Item" ? read : `PermissionsMock.Set('${set}');\n        ${read}`,
        }),
      ),
    ),
    // control: a read of Published Application that touches none of its FlowFields
    ...PUBAPP_SETS.map(
      ([state, set]): Cell => ({
        type: "PubApp",
        method: "FindFirstIdOnly",
        state,
        vars: PUBAPP_VARS,
        setup: ["NavApp.GetCurrentModuleInfo(Me);", "PA.SetRange(ID, Me.Id());"],
        call: `PermissionsMock.Set('${set}');\n        if PA.FindFirst() then;`,
      }),
    ),
  ],
};

/**
 * PR-52: Format, Evaluate and the text functions. Every cell makes ONE call and ends in `Error('V:%1', <result>)`: a text result
 * goes in as it is, any other value through `Format(<value>, 0, 9)` (the XML format: fixed, locale-free), and an Evaluate cell
 * reports `V:<ok>|<value>`. So a cell's answer is its failure message (or "refused"); nothing is asserted. A message that does
 * not start with `V:` is an error the call itself raised.
 */
type FmtValue = {
  readonly type: string;
  readonly decl: string;
  readonly picture?: string;
  readonly states: readonly (readonly [string, string])[];
};
const FMT_VALUES: readonly FmtValue[] = [
  {
    type: "Decimal",
    decl: "Decimal",
    picture: "<Precision,2:2><Standard Format,0>",
    states: [
      ["zero", "V := 0;"],
      ["negative", "V := -1234.5;"],
      ["large", "V := 123456789012.345;"],
      ["many decimals", "V := 1.23456789;"],
      ["half cent", "V := 0.005;"],
    ],
  },
  {
    type: "Integer",
    decl: "Integer",
    picture: "<Sign><Integer,6><Filler Character,0>",
    states: [
      ["zero", "V := 0;"],
      ["negative", "V := -42;"],
      ["max", "V := 2147483647;"],
      ["min", "V := -2147483647;\nV -= 1;"],
    ],
  },
  {
    type: "BigInteger",
    decl: "BigInteger",
    states: [
      ["zero", "V := 0;"],
      // no constant above the Integer range compiles, so the limits are built (2^63 - 1 and -2^63)
      [
        "max",
        "V := 2147483647;\nV := V * 65536;\nV := V * 65536;\nV += 2147483647;\nV += 2147483647;\nV += 1;",
      ],
      [
        "min",
        "V := -2147483647;\nV := V * 65536;\nV := V * 65536;\nV -= 2147483647;\nV -= 2147483647;\nV -= 2;",
      ],
    ],
  },
  {
    type: "Boolean",
    decl: "Boolean",
    states: [
      ["true", "V := true;"],
      ["false", "V := false;"],
    ],
  },
  {
    type: "Date",
    decl: "Date",
    picture: "<Day,2>/<Month,2>/<Year4>",
    states: [
      ["undefined", "V := 0D;"],
      ["normal", "V := DMY2Date(15, 3, 2024);"],
      ["closing date", "V := ClosingDate(DMY2Date(31, 12, 2023));"],
    ],
  },
  {
    type: "Time",
    decl: "Time",
    picture: "<Hours24>:<Minutes,2>",
    states: [
      ["undefined", "V := 0T;"],
      ["afternoon", "V := 143015T;"],
    ],
  },
  {
    type: "DateTime",
    decl: "DateTime",
    picture: "<Day,2>/<Month,2>/<Year4> <Hours24>:<Minutes,2>",
    states: [
      ["undefined", "V := 0DT;"],
      ["normal", "V := CreateDateTime(DMY2Date(15, 3, 2024), 143015T);"],
    ],
  },
  {
    type: "Duration",
    decl: "Duration",
    states: [
      ["zero", "V := 0;"],
      ["day and more", "V := 90061001;"],
    ],
  },
  {
    type: "Option",
    decl: "Option Alpha,Beta,Gamma",
    states: [
      ["first", "V := V::Alpha;"],
      ["third", "V := V::Gamma;"],
    ],
  },
  {
    type: "Guid",
    decl: "Guid",
    states: [
      ["null", "Evaluate(V, '{00000000-0000-0000-0000-000000000000}');"],
      ["set", "Evaluate(V, '{12345678-1234-1234-1234-123456789ABC}');"],
    ],
  },
  {
    type: "Code",
    decl: "Code[10]",
    states: [
      ["lower", "V := 'abc';"],
      ["empty", "V := '';"],
    ],
  },
  {
    type: "Text",
    decl: "Text",
    states: [
      ["plain", "V := 'Hello';"],
      ["empty", "V := '';"],
      ["padded", "V := '  x  ';"],
    ],
  },
];
const FMT_VARIANTS: readonly (readonly [string, string])[] = [
  ["Format", "Format(V)"],
  ["Format 0,9", "Format(V, 0, 9)"],
];
const FMT_EXTRA: readonly (readonly [string, string])[] = [
  ["Format len6", "Format(V, 6)"],
  ["Format 0,0", "Format(V, 0, 0)"],
  ["Format 0,1", "Format(V, 0, 1)"],
  ["Format 0,2", "Format(V, 0, 2)"],
];

/** Evaluate cells: the type, its declaration, and (state, text) pairs. */
const EVAL_TYPES: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  [
    "Integer",
    "Integer",
    [
      ["valid", "42"],
      ["padded", " 42 "],
      ["negative", "-7"],
      ["plus sign", "+5"],
      ["decimal text", "4.2"],
      ["comma text", "4,2"],
      ["invalid", "abc"],
      ["empty", ""],
      ["overflow", "2147483648"],
      ["thousands", "1,234"],
    ],
  ],
  [
    "Decimal",
    "Decimal",
    [
      ["dot", "1.5"],
      ["comma", "1,5"],
      ["thousands", "1,234.56"],
      ["padded", " 12.5 "],
      ["exponent", "1e3"],
      ["invalid", "abc"],
      ["empty", ""],
      ["two dots", "1.2.3"],
    ],
  ],
  [
    "Boolean",
    "Boolean",
    [
      ["true", "true"],
      ["upper", "TRUE"],
      ["yes", "Yes"],
      ["one", "1"],
      ["no", "No"],
      ["zero", "0"],
      ["invalid", "maybe"],
      ["empty", ""],
    ],
  ],
  [
    "Date",
    "Date",
    [
      ["iso", "2024-03-15"],
      ["dotted", "15.03.2024"],
      ["slashed", "03/15/2024"],
      ["short", "150324"],
      ["invalid", "99.99.2024"],
      ["empty", ""],
      ["padded", " 2024-03-15 "],
      ["text", "abc"],
    ],
  ],
  [
    "Time",
    "Time",
    [
      ["hms", "14:30:15"],
      ["hm", "14:30"],
      ["pm", "2:30 PM"],
      ["millis", "14:30:15.123"],
      ["invalid", "25:00:00"],
      ["empty", ""],
      ["text", "abc"],
    ],
  ],
  [
    "DateTime",
    "DateTime",
    [
      ["iso", "2024-03-15T14:30:15"],
      ["iso z", "2024-03-15T14:30:15.000Z"],
      ["date only", "15.03.2024"],
      ["date and time", "15.03.2024 14:30:15"],
      ["invalid", "abc"],
      ["empty", ""],
    ],
  ],
  [
    "Duration",
    "Duration",
    [
      ["millis", "1500"],
      ["days", "1 day"],
      ["hours", "2 hours"],
      ["compound", "1 day 2 hours"],
      ["invalid", "abc"],
      ["empty", ""],
    ],
  ],
  [
    "Guid",
    "Guid",
    [
      ["braced", "{12345678-1234-1234-1234-123456789ABC}"],
      ["bare", "12345678-1234-1234-1234-123456789ABC"],
      ["lower", "{12345678-1234-1234-1234-123456789abc}"],
      ["short", "{1234}"],
      ["invalid", "abc"],
      ["empty", ""],
    ],
  ],
  [
    "Option",
    "Option Alpha,Beta,Gamma",
    [
      ["name", "Beta"],
      ["lower name", "beta"],
      ["index", "2"],
      ["out of range", "7"],
      ["invalid", "Delta"],
      ["empty", ""],
      ["padded", " Gamma "],
    ],
  ],
  [
    "Code",
    "Code[5]",
    [
      ["lower", "abc"],
      ["too long", "abcdefgh"],
      ["padded", " ab "],
      ["empty", ""],
    ],
  ],
];
/** Evaluate cells that also run with format number 9 (the XML text each type reads). */
const EVAL_XML = new Set([
  "Decimal|dot",
  "Decimal|comma",
  "Boolean|true",
  "Boolean|one",
  "Date|iso",
  "Date|dotted",
  "Time|hms",
  "DateTime|iso",
  "DateTime|iso z",
  "Integer|valid",
  "Integer|decimal text",
  "Guid|braced",
]);

const withDepends = (d: Cell["depends"]) => (d !== undefined ? { depends: d } : {});
/** Evaluate cells start with X set to this, so a failed Evaluate shows whether X was kept or reset. */
const EVAL_SENTINEL: Readonly<Record<string, string>> = {
  Integer: "X := 77;",
  Decimal: "X := 7.25;",
  Boolean: "X := true;",
  Date: "X := DMY2Date(1, 1, 2000);",
  Time: "X := 120000T;",
  DateTime: "X := CreateDateTime(DMY2Date(1, 1, 2000), 120000T);",
  Duration: "X := 5000;",
  Guid: "Evaluate(X, '{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}');",
  Option: "X := X::Gamma;",
  Code: "X := 'zz';",
};
/** A value cell's dependence: the DateTime built with CreateDateTime reads the time zone; default formats read language and region. */
const fmtDepends = (v: FmtValue, state: string, method: string): Cell["depends"] =>
  v.type === "DateTime" && state === "normal"
    ? "tz"
    : ["Text", "Code", "Guid"].includes(v.type) || method === "Format 0,9"
      ? undefined
      : "locale";
const fmtCell = (
  v: FmtValue,
  state: string,
  setup: string,
  method: string,
  expr: string,
): Cell => ({
  type: v.type,
  method,
  state,
  vars: [`V: ${v.decl};`],
  setup: setup.split("\n"),
  call: `Error('V:[%1]', ${expr});`,
  ...withDepends(fmtDepends(v, state, method)),
});
/** A text-function cell; a `vars` entry holding `:=` is a setup statement. */
const textCell = (
  type: string,
  method: string,
  expr: string,
  text = true,
  vars: string[] = [],
  depends?: Cell["depends"],
): Cell => ({
  type,
  method,
  state: "",
  vars: vars.filter((v) => !v.includes(":=")),
  setup: vars.filter((v) => v.includes(":=")),
  call: `Error('V:[%1]', ${text ? expr : `Format(${expr}, 0, 9)`});`,
  ...withDepends(depends),
});
/** A text-function cell whose answer reads the session's language and region. */
const localeCell = (
  type: string,
  method: string,
  expr: string,
  text = true,
  vars: string[] = [],
): Cell => textCell(type, method, expr, text, vars, "locale");
const evalCell = (
  [type, decl]: readonly [string, string],
  state: string,
  text: string,
  n9: boolean,
): Cell => ({
  type,
  method: n9 ? "Evaluate 9" : "Evaluate",
  state,
  vars: [`X: ${decl};`, "Ok: Boolean;"],
  setup: [EVAL_SENTINEL[type] ?? ""],
  call: `Ok := Evaluate(X, '${text}'${n9 ? ", 9" : ""}); Error('V:[%1|%2]', Format(Ok, 0, 9), Format(X, 0, 9));`,
  ...withDepends(
    type === "DateTime" && ["iso", "date only", "date and time"].includes(state)
      ? "tz"
      : n9
        ? undefined
        : "locale",
  ),
});

const S_ABCDEF = ["S: Text;", "S := 'abcdef';"];
const S_ABAN = ["S: Text;", "S := 'banana';"];
const S_CSV = ["S: Text;", "S := 'a,b,,c';"];
const FORMAT_EVALUATE_CELLS: Cell[] = [
  ...FMT_VALUES.flatMap((v) =>
    v.states.flatMap(([state, setup], si) => [
      ...FMT_VARIANTS.map(([m, e]) => fmtCell(v, state, setup, m, e)),
      ...(si === 0 ? FMT_EXTRA.map(([m, e]) => fmtCell(v, state, setup, m, e)) : []),
      ...(v.picture !== undefined && si < 2
        ? [fmtCell(v, state, setup, "Format picture", `Format(V, 0, '${v.picture}')`)]
        : []),
    ]),
  ),
  ...EVAL_TYPES.flatMap(([type, decl, states]) =>
    states.flatMap(([state, text]) => [
      evalCell([type, decl], state, text, false),
      ...(EVAL_XML.has(`${type}|${state}`) ? [evalCell([type, decl], state, text, true)] : []),
    ]),
  ),
  textCell("CopyStr", "start 0", "CopyStr('abcdef', 0, 2)"),
  textCell("CopyStr", "start past end", "CopyStr('abcdef', 9, 2)"),
  textCell("CopyStr", "length past end", "CopyStr('abcdef', 4, 99)"),
  textCell("CopyStr", "negative length", "CopyStr('abcdef', 2, -1)"),
  textCell("CopyStr", "length 0", "CopyStr('abcdef', 2, 0)"),
  textCell("CopyStr", "no length", "CopyStr('abcdef', 3)"),
  textCell("CopyStr", "start negative", "CopyStr('abcdef', -2, 2)"),
  textCell("PadStr", "pad longer", "PadStr('ab', 5)"),
  textCell("PadStr", "pad filler", "PadStr('ab', 5, 'xy')"),
  textCell("PadStr", "cut shorter", "PadStr('abcdef', 3)"),
  textCell("PadStr", "negative length", "PadStr('ab', -1)"),
  textCell("PadStr", "length 0", "PadStr('ab', 0)"),
  textCell("PadStr", "empty filler", "PadStr('ab', 5, '')"),
  textCell("SelectStr", "second", "SelectStr(2, 'a,b,c')"),
  textCell("SelectStr", "out of range", "SelectStr(4, 'a,b,c')"),
  textCell("SelectStr", "zero", "SelectStr(0, 'a,b,c')"),
  textCell("SelectStr", "negative", "SelectStr(-1, 'a,b,c')"),
  textCell("SelectStr", "empty item", "SelectStr(2, 'a,,c')"),
  textCell("SelectStr", "empty text", "SelectStr(1, '')"),
  textCell("ConvertStr", "equal lengths", "ConvertStr('abcabc', 'ab', 'xy')"),
  textCell("ConvertStr", "to shorter", "ConvertStr('abcabc', 'abc', 'x')"),
  textCell("ConvertStr", "to longer", "ConvertStr('abcabc', 'a', 'xyz')"),
  textCell("ConvertStr", "empty from", "ConvertStr('abc', '', '')"),
  ...["<", ">", "="].map((w) => textCell("DelChr", `where ${w}`, `DelChr('  a b  ', '${w}', ' ')`)),
  textCell("DelChr", "no where", "DelChr('  a b  ')"),
  textCell("DelChr", "several chars", "DelChr('a.b-c', '=', '.-')"),
  textCell("DelChr", "empty set", "DelChr(' a ', '<>', '')"),
  textCell("IncStr", "no digits", "IncStr('ABC')"),
  textCell("IncStr", "nine", "IncStr('9')"),
  textCell("IncStr", "letter nine", "IncStr('A9')"),
  textCell("IncStr", "Z99", "IncStr('Z99')"),
  textCell("IncStr", "leading zeros", "IncStr('A007')"),
  textCell("IncStr", "empty", "IncStr('')"),
  textCell("IncStr", "digits then text", "IncStr('12AB')"),
  textCell("IncStr", "negative", "IncStr('-5')"),
  textCell("StrSubstNo", "missing arg", "StrSubstNo('%1 %2', 'a')"),
  textCell("StrSubstNo", "extra arg", "StrSubstNo('%1', 'a', 'b')"),
  textCell("StrSubstNo", "percent ten", "StrSubstNo('%10', 'a')"),
  textCell("StrSubstNo", "hash slots", "StrSubstNo('#1###', 'ab')"),
  textCell("StrSubstNo", "no slot", "StrSubstNo('plain', 'a')"),
  textCell("StrSubstNo", "slot twice", "StrSubstNo('%1-%1', 'a')"),
  localeCell("StrSubstNo", "integer arg", "StrSubstNo('%1', 12)"),
  localeCell("StrSubstNo", "boolean arg", "StrSubstNo('%1', true)"),
  localeCell("StrSubstNo", "decimal arg", "StrSubstNo('%1', 1.5)"),
  localeCell("StrSubstNo", "date arg", "StrSubstNo('%1', DMY2Date(15, 3, 2024))"),
  localeCell("UpperCase", "non-ASCII", "UpperCase('äöüßé')"),
  localeCell("LowerCase", "non-ASCII", "LowerCase('ÄÖÜÉ')"),
  textCell("UpperCase", "ASCII", "UpperCase('abc xyz')"),
  textCell("LowerCase", "ASCII", "LowerCase('ABC XYZ')"),
  textCell("StrPos", "found", "StrPos('abcabc', 'ca')", false),
  textCell("StrPos", "not found", "StrPos('abcabc', 'zz')", false),
  textCell("StrPos", "empty needle", "StrPos('abc', '')", false),
  textCell("StrPos", "empty hay", "StrPos('', 'a')", false),
  textCell("StrPos", "case differs", "StrPos('abc', 'B')", false),
  textCell("StrLen", "padded", "StrLen('  ab  ')", false),
  textCell("StrLen", "empty", "StrLen('')", false),
  textCell("MaxStrLen", "text var", "MaxStrLen(C)", false, ["C: Text[7];"]),
  textCell("Substring", "from 1", "S.Substring(1)", true, S_ABCDEF),
  textCell("Substring", "from 3", "S.Substring(3)", true, S_ABCDEF),
  textCell("Substring", "from 3 len 2", "S.Substring(3, 2)", true, S_ABCDEF),
  textCell("Substring", "from 0", "S.Substring(0)", true, S_ABCDEF),
  textCell("Substring", "past end", "S.Substring(9)", true, S_ABCDEF),
  textCell("Substring", "length past end", "S.Substring(3, 99)", true, S_ABCDEF),
  textCell("Split", "count", "S.Split(',').Count()", false, S_CSV),
  textCell("Split", "second", "S.Split(',').Get(2)", true, S_CSV),
  textCell("Split", "empty item", "S.Split(',').Get(3)", true, S_CSV),
  textCell("Split", "no separator", "S.Split(',').Count()", false, ["S: Text;", "S := 'abc';"]),
  textCell("Split", "empty text", "S.Split(',').Count()", false, ["S: Text;", "S := '';"]),
  textCell("Split", "several seps", "S.Split(',', ';').Count()", false, [
    "S: Text;",
    "S := 'a,b;c';",
  ]),
  textCell("Split", "get past end", "S.Split(',').Get(9)", true, ["S: Text;", "S := 'a,b';"]),
  textCell("Replace", "all", "S.Replace('a', 'x')", true, S_ABAN),
  textCell("Replace", "empty old", "S.Replace('', 'x')", true, S_ABAN),
  textCell("Trim", "both ends", "S.Trim()", true, ["S: Text;", "S := '  a b  ';"]),
  textCell("TrimStart", "chars", "S.TrimStart('x')", true, ["S: Text;", "S := 'xxaxx';"]),
  textCell("TrimEnd", "chars", "S.TrimEnd('x')", true, ["S: Text;", "S := 'xxaxx';"]),
  textCell("IndexOf", "found", "S.IndexOf('na')", false, S_ABAN),
  textCell("IndexOf", "from 4", "S.IndexOf('na', 4)", false, S_ABAN),
  textCell("IndexOfAny", "set", "S.IndexOfAny('nb')", false, S_ABAN),
  textCell("PadLeft", "pad", "S.PadLeft(5, '0')", true, ["S: Text;", "S := '12';"]),
  textCell("PadRight", "pad", "S.PadRight(5, '0')", true, ["S: Text;", "S := '12';"]),
  textCell("PadLeft", "shorter", "S.PadLeft(1, '0')", true, ["S: Text;", "S := '12';"]),
  localeCell("ToUpper", "non-ASCII", "S.ToUpper()", true, ["S: Text;", "S := 'äöüß';"]),
  localeCell("ToLower", "non-ASCII", "S.ToLower()", true, ["S: Text;", "S := 'ÄÖÜ';"]),
  textCell("StartsWith", "case differs", "S.StartsWith('AB')", false, ["S: Text;", "S := 'abc';"]),
  textCell("EndsWith", "empty", "S.EndsWith('')", false, ["S: Text;", "S := 'abc';"]),
  textCell("Contains", "case differs", "S.Contains('B')", false, ["S: Text;", "S := 'abc';"]),
  textCell("Format", "text literal", "Format('abc')"),
  textCell("Format", "text literal len 2", "Format('abc', 2)"),
  textCell("Format", "text literal 0,9", "Format('a<b&c', 0, 9)"),
  // the control for Error's own substitution: a `%1`, a `#1#` and a backslash inside the argument, passed through unchanged?
  textCell("Error", "own substitution", "'%1#1#\\x'"),
  // the time-zone probe: local midnight 2000-01-01 printed as UTC, so the answer IS the session's UTC offset
  textCell(
    "TimeZone",
    "probe",
    "Format(CreateDateTime(DMY2Date(1, 1, 2000), 0T), 0, 9)",
    true,
    [],
    "tz",
  ),
];

/** The same cell under Danish (GlobalLanguage 1030), set before the one call; each is its own codeunit, so nothing is restored. */
const inLang = (c: Cell, code = 1030): Cell => ({
  ...c,
  state: `lang${code} ${c.state}`.trim(),
  setup: [`GlobalLanguage(${code});`, ...(c.setup ?? [])],
  depends: "locale",
});
const fmtIn = (type: string, state: string, method: string, expr: string, code = 1030): Cell => {
  const v = FMT_VALUES.find((x) => x.type === type);
  const s = v?.states.find(([n]) => n === state);
  if (v === undefined || s === undefined) throw new Error(`no value ${type} ${state}`);
  return inLang(fmtCell(v, state, s[1], method, expr), code);
};
const LANG_FORMATS: readonly (readonly [string, string, string])[] = [
  ["Boolean", "true", "6"],
  ["Decimal", "negative", "12"],
  ["Decimal", "large", ""],
  ["Date", "normal", "12"],
  ["Date", "closing date", ""],
  ["Time", "afternoon", "10"],
  ["DateTime", "normal", "20"],
  ["Option", "third", "8"],
];
const LANG_CELLS: Cell[] = [
  ...LANG_FORMATS.flatMap(([type, state, len]) => [
    fmtIn(type, state, "Format", "Format(V)"),
    ...(len !== "" ? [fmtIn(type, state, `Format len${len}`, `Format(V, ${len})`)] : []),
  ]),
  ...["Ja", "Nej", "Yes", "true"].map((t) => inLang(evalCell(["Boolean", "Boolean"], t, t, false))),
  ...["1,5", "1.5"].map((t) => inLang(evalCell(["Decimal", "Decimal"], t, t, false))),
  ...["15.03.2024", "15-03-2024", "2024-03-15"].map((t) =>
    inLang(evalCell(["Date", "Date"], t, t, false)),
  ),
  inLang(textCell("StrSubstNo", "decimal arg", "StrSubstNo('%1', 1234.5)")),
  inLang(textCell("StrSubstNo", "date arg", "StrSubstNo('%1', DMY2Date(15, 3, 2024))")),
  inLang(textCell("UpperCase", "Danish letters", "UpperCase('æøåé')")),
  inLang(textCell("LowerCase", "Danish letters", "LowerCase('ÆØÅÉ')")),
  // the session probes: the language the set took, and the Windows language (read-only; no AL call sets a region or format)
  inLang(textCell("GlobalLanguage", "probe", "GlobalLanguage()", false)),
  textCell("WindowsLanguage", "probe", "WindowsLanguage()", false, [], "locale"),
];

/**
 * PR-63: the same language set under German, French, Norwegian and Swedish, then what Danish lacked, then month and day names
 * under all five and English, then the GlobalLanguage carry-over. All appended after the 326 PR-52 cells, so their ids stay.
 */
const LR_ENUM: FmtValue = {
  type: "Enum",
  decl: 'Enum "LR Color"',
  states: [
    // the captions are the enum's default ones: no translation files, so these cells are no evidence about translated captions
    ["first default caption", 'V := "LR Color"::Red;'],
    ["third default caption", 'V := "LR Color"::Blue;'],
  ],
};
const ENUM_SUPPORT = `enum 51000 "LR Color"
{
    Extensible = false;

    value(0; Red) { Caption = 'Red'; }
    value(1; Green) { Caption = 'Green'; }
    value(2; Blue) { Caption = 'Blue'; }
}

codeunit 51540 "LR Carry Mark"
{
    SingleInstance = true;

    var
        Counter: Integer;

    procedure Increment()
    begin
        Counter += 1;
    end;

    procedure Count(): Integer
    begin
        exit(Counter);
    end;
}
`;
const PICTURES: readonly (readonly [string, string])[] = [
  ["precision", "<Precision,2:2><Standard Format,0>"],
  ["thousands", "<Integer Thousand><Decimals>"],
];
const LANG_WORDS: Readonly<
  Record<number, { yes: string; no: string; lower: string; upper: string }>
> = {
  1031: { yes: "Ja", no: "Nein", lower: "äöüßé", upper: "ÄÖÜÉ" },
  1036: { yes: "Oui", no: "Non", lower: "éèçœ", upper: "ÉÈÇŒ" },
  1044: { yes: "Ja", no: "Nei", lower: "æøåé", upper: "ÆØÅÉ" },
  1053: { yes: "Ja", no: "Nej", lower: "åäöé", upper: "ÅÄÖÉ" },
};
/** What every language gets: Enum, the two Decimal pictures, and the Boolean text "1". */
const langExtras = (code: number): Cell[] => [
  ...LR_ENUM.states.flatMap(([state, setup]) => [
    inLang(fmtCell(LR_ENUM, state, setup, "Format", "Format(V)"), code),
    ...(state.startsWith("third")
      ? [inLang(fmtCell(LR_ENUM, state, setup, "Format len8", "Format(V, 8)"), code)]
      : []),
  ]),
  ...["negative", "large"].flatMap((state) =>
    PICTURES.map(([name, pic]) =>
      fmtIn("Decimal", state, `Format picture ${name}`, `Format(V, 0, '${pic}')`, code),
    ),
  ),
  inLang(evalCell(["Boolean", "Boolean"], "1", "1", false), code),
];
/** The Danish cells' counterpart under another language. */
const langSet = (code: number): Cell[] => {
  const w = LANG_WORDS[code];
  if (w === undefined) throw new Error(`no words for ${code}`);
  return [
    ...LANG_FORMATS.flatMap(([type, state, len]) => [
      fmtIn(type, state, "Format", "Format(V)", code),
      ...(len !== "" ? [fmtIn(type, state, `Format len${len}`, `Format(V, ${len})`, code)] : []),
    ]).map((c) =>
      // an Option variable has no captions: its cells are no evidence about translated captions
      c.type === "Option" ? { ...c, state: `${c.state} default caption` } : c,
    ),
    ...[w.yes, w.no, "Yes", "true"].map((t) =>
      inLang(evalCell(["Boolean", "Boolean"], t, t, false), code),
    ),
    ...["1,5", "1.5"].map((t) => inLang(evalCell(["Decimal", "Decimal"], t, t, false), code)),
    ...["15.03.2024", "15-03-2024", "2024-03-15"].map((t) =>
      inLang(evalCell(["Date", "Date"], t, t, false), code),
    ),
    inLang(textCell("StrSubstNo", "decimal arg", "StrSubstNo('%1', 1234.5)"), code),
    inLang(textCell("StrSubstNo", "date arg", "StrSubstNo('%1', DMY2Date(15, 3, 2024))"), code),
    inLang(textCell("UpperCase", "language letters", `UpperCase('${w.lower}')`), code),
    inLang(textCell("LowerCase", "language letters", `LowerCase('${w.upper}')`), code),
    inLang(textCell("GlobalLanguage", "probe", "GlobalLanguage()", false), code),
    ...langExtras(code),
  ];
};
const NAME_DATES: readonly (readonly [string, string])[] = [
  ["15 March 2024", "V := DMY2Date(15, 3, 2024);"],
  ["6 August 2024", "V := DMY2Date(6, 8, 2024);"],
];
const NAME_PICTURES: readonly (readonly [string, string])[] = [
  ["month", "<Month Text>"],
  ["month 3", "<Month Text,3>"],
  ["weekday", "<Weekday Text>"],
  ["weekday 2", "<Weekday Text,2>"],
  ["day month year", "<Day,2>. <Month Text> <Year4>"],
];
const nameCells = (code: number): Cell[] =>
  NAME_DATES.flatMap(([state, setup]) =>
    NAME_PICTURES.map(([name, pic]) =>
      inLang(
        {
          type: "Date",
          method: `Format ${name}`,
          state,
          vars: ["V: Date;"],
          setup: [setup],
          call: `Error('V:[%1]', Format(V, 0, '${pic}'));`,
        },
        code,
      ),
    ),
  );
/** Two tests, one codeunit: Danish is set in the first; the second reads the language back and Formats a closing date. */
const CARRY_CELL: Cell = {
  type: "GlobalLanguage",
  method: "carry-over",
  state: "set 1030 then read",
  // the counter says whether the setter ran first in the same session (1) or not (0)
  vars: ['Mark: Codeunit "LR Carry Mark";'],
  call: "GlobalLanguage(1030); Mark.Increment();",
  reader: {
    vars: ["V: Date;", 'Mark: Codeunit "LR Carry Mark";'],
    setup: ["V := ClosingDate(DMY2Date(31, 12, 2023));"],
    call: "Error('V:[%1|%2|%3]', Format(GlobalLanguage(), 0, 9), Format(V), Format(Mark.Count(), 0, 9));",
  },
  depends: "carry",
};
const LANGUAGES_1031_1053 = [1031, 1036, 1044, 1053];
const LANGUAGE_CELLS: Cell[] = [
  ...LANGUAGES_1031_1053.flatMap(langSet),
  ...langExtras(1030),
  ...[1030, ...LANGUAGES_1031_1053, 1033].flatMap(nameCells),
  CARRY_CELL,
];

export const FORMAT_EVALUATE: Family = {
  name: "format-evaluate",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues",
  known: [],
  support: ENUM_SUPPORT,
  handles: {},
  cells: [...FORMAT_EVALUATE_CELLS, ...LANG_CELLS, ...LANGUAGE_CELLS],
};

/**
 * PR-74: the refusal texts DO window t9 met that PR-56 does not keep, each driven by an invented cell (no corpus source text).
 * Cell i is codeunit BASE_ID + 1 + i; the support objects (a table and a report) share id 51000 as in the other families.
 */
const t9 = (
  type: string,
  method: string,
  state: string,
  call: string,
  extra: Partial<Cell> = {},
): Cell => ({
  type,
  method,
  state,
  call,
  ...extra,
});
const JSON_VARS = ["SW: DotNet T9StringWriter;", "JW: DotNet T9JsonTextWriter;"];
const JSON_SETUP = ["SW := SW.StringWriter();", "JW := JW.JsonTextWriter(SW);"];
export const T9_REFUSALS: Family = {
  name: "t9-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `table 51000 "T9 Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Decimal) { }
        field(3; Count; BigInteger) { }
        field(4; Blob; Blob) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

report 51000 "T9 Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "T9 Row") { } }
    requestpage { layout { area(Content) { } } }
}

report 51001 "T9 Print Report"
{
    dataset { dataitem(Row; "T9 Row") { column(CodeCol; "Code") { } } }
}

dotnet
{
    assembly(mscorlib)
    {
        type(System.IO.MemoryStream; T9MemoryStream) { }
        type(System.IO.StringWriter; T9StringWriter) { }
    }
    assembly(System.IO.Compression)
    {
        type(System.IO.Compression.ZipArchive; T9ZipArchive) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.JsonTextWriter; T9JsonTextWriter) { }
    }
}
`,
  handles: {},
  cells: [
    t9("Filter", "SetFilterDots", "t9", "R.SetFilter(Amount, '..');", {
      vars: ['R: Record "T9 Row";'],
    }),
    t9("Filter", "SetFilterAt", "t9", "R.SetFilter(Amount, '@');", {
      vars: ['R: Record "T9 Row";'],
    }),
    t9("Evaluate", "Gt100", "t9", "if Evaluate(D, '>100') then;", { vars: ["D: Decimal;"] }),
    t9("Evaluate", "Gt1000", "t9", "if Evaluate(D, '>1000') then;", { vars: ["D: Decimal;"] }),
    t9("Evaluate", "Lt1000", "t9", "if Evaluate(D, '<1000') then;", { vars: ["D: Decimal;"] }),
    t9("RecordRef", "Duplicate", "closed", "R2 := RR.Duplicate();", {
      vars: ["RR: RecordRef;", "R2: RecordRef;"],
    }),
    t9(
      "Report",
      "RunRequestPage",
      "t9",
      "T := Report.RunRequestPage(Report::\"T9 Report\", '<a/>');",
      {
        vars: ["T: Text;"],
        // a write before the call leaves a transaction open, and then the run stops before the refusal (the census kit writes first)
        setup: ["Commit();"],
      },
    ),
    t9(
      "Report",
      "SaveAs",
      "t9",
      "Report.SaveAs(Report::\"T9 Print Report\", '<a/>', ReportFormat::Xml, OutS);",
      {
        vars: ["OutS: OutStream;", 'R: Record "T9 Row";'],
        setup: ["R.Blob.CreateOutStream(OutS);"],
      },
    ),
    t9("ZipArchive", "Ctor", "t9", "ZA := ZA.ZipArchive(MS);", {
      vars: ["MS: DotNet T9MemoryStream;", "ZA: DotNet T9ZipArchive;"],
      setup: ["MS := MS.MemoryStream();"],
    }),
    t9("JsonTextWriter", "WriteEndObject", "t9", "JW.WriteEndObject();", {
      vars: JSON_VARS,
      setup: JSON_SETUP,
    }),
    t9("JsonTextWriter", "WriteStartObject", "t9", "JW.WriteStartObject();", {
      vars: JSON_VARS,
      setup: [
        ...JSON_SETUP,
        "JW.WriteStartObject();",
        "JW.WritePropertyName('a');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('b');",
        "JW.WriteValue('v');",
      ],
    }),
    t9("JsonTextWriter", "WritePropertyName", "t9", "JW.WritePropertyName('b');", {
      vars: JSON_VARS,
      setup: [
        ...JSON_SETUP,
        "JW.WriteStartObject();",
        "JW.WritePropertyName('a');",
        "JW.WriteStartArray();",
      ],
    }),
    t9("Conversion", "FieldValue", "t9", "RR.Field(3).Value := false;", {
      vars: ["RR: RecordRef;"],
      setup: ['RR.Open(Database::"T9 Row");'],
    }),
    t9("RecordRef", "ClearMarks", "untouched", "RR.ClearMarks();", { vars: ["RR: RecordRef;"] }),
    t9("FieldRef", "SetFilter", "untouched", "FR.SetFilter('%1', 5);", { vars: ["FR: FieldRef;"] }),
  ],
};

/**
 * PR-83: record filters. Invented header and line tables; every cell reloads a fixed data set (`Seed.Load`: DeleteAll, then the
 * inserts), does one operation, and reports its answer as `V:[...]` (the ordered primary keys joined with ',', counts and
 * numbers through Format(x, 0, 9), filter text as returned). Cell i is codeunit BASE_ID + 1 + i; the support codeunit is 51000.
 */
const RF_SUPPORT = `enum 51000 "RF Color"
{
    Extensible = false;

    value(0; Red) { Caption = 'Red'; }
    value(1; Green) { Caption = 'Green'; }
    value(2; Blue) { Caption = 'Blue'; }
}

table 51000 "RF Header"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Name; Text[50]) { }
        field(3; Kind; Option) { OptionMembers = Alpha,Beta,Gamma; }
        field(4; Color; Enum "RF Color") { }
        field(5; "Doc Date"; Date) { }
        field(6; Qty; Integer) { }
        field(7; Amount; Decimal) { }
        field(8; Active; Boolean) { }
        field(9; Region; Code[10]) { }
        field(10; "Date Filter"; Date) { FieldClass = FlowFilter; }
        field(20; "Line Total"; Decimal)
        {
            FieldClass = FlowField;
            Editable = false;
            CalcFormula = sum("RF Line".Amount where("Header Code" = field("Code"), "Line Date" = field("Date Filter")));
        }
        field(21; "Line Count"; Integer)
        {
            FieldClass = FlowField;
            Editable = false;
            CalcFormula = count("RF Line" where("Header Code" = field("Code"), "Line Date" = field("Date Filter")));
        }
        field(22; "Has Lines"; Boolean)
        {
            FieldClass = FlowField;
            Editable = false;
            CalcFormula = exist("RF Line" where("Header Code" = field("Code"), "Line Date" = field("Date Filter")));
        }
        field(23; "Max Qty"; Integer)
        {
            FieldClass = FlowField;
            Editable = false;
            CalcFormula = max("RF Line".Qty where("Header Code" = field("Code"), "Line Date" = field("Date Filter")));
        }
        field(24; "Min Qty"; Integer)
        {
            FieldClass = FlowField;
            Editable = false;
            CalcFormula = min("RF Line".Qty where("Header Code" = field("Code"), "Line Date" = field("Date Filter")));
        }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
        key(ByRegion; Region) { SumIndexFields = Amount, Qty; }
        key(ByKindQty; Kind, Qty) { }
    }
}

table 51001 "RF Line"
{
    fields
    {
        field(1; "Header Code"; Code[20]) { }
        field(2; "Line No."; Integer) { }
        field(3; Amount; Decimal) { }
        field(4; Qty; Integer) { }
        field(5; "Line Date"; Date) { }
    }
    keys
    {
        key(PK; "Header Code", "Line No.") { Clustered = true; SumIndexFields = Amount, Qty; }
    }
}

codeunit 51000 "RF Seed"
{
    procedure Load()
    var
        Hd: Record "RF Header";
        Ln: Record "RF Line";
    begin
        Hd.DeleteAll();
        Ln.DeleteAll();
        AddHeader('A001', 'Alpha', 0, "RF Color"::Red, DMY2Date(10, 1, 2024), 5, 10.5, true, 'N');
        AddHeader('A002', 'alpha two', 1, "RF Color"::Green, DMY2Date(15, 2, 2024), 5, 20, true, 'S');
        AddHeader('B001', 'Bravo', 2, "RF Color"::Blue, DMY2Date(15, 3, 2024), 12, -3.25, false, 'N');
        AddHeader('B002', 'Émile', 0, "RF Color"::Red, DMY2Date(15, 3, 2024), 12, 0, true, 'S');
        AddHeader('C001', 'Ærø', 1, "RF Color"::Green, DMY2Date(31, 12, 2024), 0, 100, false, 'E');
        AddHeader('C002', 'Zebra', 2, "RF Color"::Blue, 0D, 7, 7, true, '');
        AddHeader('D001', 'a*b?', 0, "RF Color"::Red, DMY2Date(1, 1, 2025), 7, 1000.123, true, 'N');
        AddHeader('D002', '', 1, "RF Color"::Green, DMY2Date(30, 6, 2025), -1, 0.5, false, 'S');
        AddLine('A001', 1, 10, 2, DMY2Date(5, 1, 2024));
        AddLine('A001', 2, 20, 4, DMY2Date(5, 2, 2024));
        AddLine('A001', 3, 5.5, 1, DMY2Date(5, 3, 2024));
        AddLine('A002', 1, 7.25, 3, DMY2Date(20, 2, 2024));
        AddLine('B001', 1, 100, 10, DMY2Date(1, 3, 2024));
        AddLine('B001', 2, -40, 5, DMY2Date(1, 4, 2024));
    end;

    local procedure AddHeader(C: Code[20]; N: Text[50]; K: Integer; Col: Enum "RF Color"; D: Date; Q: Integer; A: Decimal; Act: Boolean; Reg: Code[10])
    var
        Hd: Record "RF Header";
    begin
        Hd.Init();
        Hd.Code := C;
        Hd.Name := N;
        Hd.Kind := K;
        Hd.Color := Col;
        Hd."Doc Date" := D;
        Hd.Qty := Q;
        Hd.Amount := A;
        Hd.Active := Act;
        Hd.Region := Reg;
        Hd.Insert();
    end;

    local procedure AddLine(HC: Code[20]; No: Integer; A: Decimal; Q: Integer; D: Date)
    var
        Ln: Record "RF Line";
    begin
        Ln.Init();
        Ln."Header Code" := HC;
        Ln."Line No." := No;
        Ln.Amount := A;
        Ln.Qty := Q;
        Ln."Line Date" := D;
        Ln.Insert();
    end;

    procedure Keys(var R: Record "RF Header"): Text
    var
        Result: Text;
    begin
        if R.FindSet() then
            repeat
                if Result <> '' then
                    Result += ',';
                Result += R.Code;
            until R.Next() = 0;
        exit(Result);
    end;

    procedure KeysBack(var R: Record "RF Header"): Text
    var
        Result: Text;
    begin
        if R.FindLast() then
            repeat
                if Result <> '' then
                    Result += ',';
                Result += R.Code;
            until R.Next(-1) = 0;
        exit(Result);
    end;

    procedure Rows(): Text
    var
        R: Record "RF Header";
        Result: Text;
    begin
        if R.FindSet() then
            repeat
                Result += R.Code + ':' + Format(R.Qty, 0, 9) + ':' + R.Name + ':' + Format(R.Active, 0, 9) + ':' + Format(R.Color, 0, 9) + ';';
            until R.Next() = 0;
        exit(Result);
    end;

    procedure LRows(): Text
    var
        R: Record "RF Line";
        Result: Text;
    begin
        if R.FindSet() then
            repeat
                Result += R."Header Code" + '/' + Format(R."Line No.", 0, 9) + ';';
            until R.Next() = 0;
        exit(Result);
    end;

    procedure FindText(var R: Record "RF Header"; Mode: Text): Text
    begin
        if R.Find(Mode) then
            exit(R.Code);
        exit('none');
    end;

    procedure FirstText(var R: Record "RF Header"): Text
    begin
        if R.FindFirst() then
            exit(R.Code);
        exit('none');
    end;

    procedure LastText(var R: Record "RF Header"): Text
    begin
        if R.FindLast() then
            exit(R.Code);
        exit('none');
    end;

    procedure NextText(var R: Record "RF Header"; Start: Code[20]; Step: Integer): Text
    var
        Moved: Integer;
    begin
        if not R.Get(Start) then
            exit('no start');
        Moved := R.Next(Step);
        exit(Format(Moved, 0, 9) + '/' + R.Code);
    end;
}
`;
const RF_VARS = ['H: Record "RF Header";', 'Seed: Codeunit "RF Seed";'];
const rf = (
  type: string,
  method: string,
  state: string,
  setup: string[],
  answer: string,
  o: { vars?: string[]; depends?: Cell["depends"] } = {},
): Cell => ({
  type,
  method,
  state,
  vars: [...RF_VARS, ...(o.vars ?? [])],
  setup: ["Seed.Load();", ...setup],
  call: `Error('V:[%1]', ${answer});`,
  ...withDepends(o.depends),
});
const al = (s: string) => `'${s.replace(/'/g, "''")}'`;
const n9 = (e: string) => `Format(${e}, 0, 9)`;
const KEYS = "Seed.Keys(H)";
const dt = (d: number, m: number, y: number) => `DMY2Date(${d}, ${m}, ${y})`;
const RF_FIELD = {
  Code: "H.Code",
  Text: "H.Name",
  Option: "H.Kind",
  Enum: "H.Color",
  Date: 'H."Doc Date"',
  Integer: "H.Qty",
  Decimal: "H.Amount",
  Boolean: "H.Active",
} as const;

/** SetRange: [field type, state, the SetRange arguments after the field]. */
const RF_RANGES: readonly (readonly [keyof typeof RF_FIELD, string, string])[] = [
  ["Code", "single", al("B001")],
  ["Code", "range", `${al("A002")}, ${al("B002")}`],
  ["Code", "upper empty", `${al("B001")}, ''`],
  ["Code", "lower above upper", `${al("B002")}, ${al("B001")}`],
  ["Code", "lowercase value", al("b001")],
  ["Code", "absent value", al("Z999")],
  ["Text", "single", al("Alpha")],
  ["Text", "other case", al("alpha")],
  ["Text", "no accent", al("Emile")],
  ["Text", "accent", al("Émile")],
  ["Text", "range", `${al("A")}, ${al("B")}`],
  ["Text", "empty", "''"],
  ["Text", "wildcard text", al("a*b?")],
  ["Option", "single", "H.Kind::Beta"],
  ["Option", "range", "H.Kind::Alpha, H.Kind::Beta"],
  ["Enum", "single", '"RF Color"::Green'],
  ["Enum", "range", '"RF Color"::Red, "RF Color"::Green'],
  ["Date", "single", dt(15, 3, 2024)],
  ["Date", "range", `${dt(1, 2, 2024)}, ${dt(31, 3, 2024)}`],
  ["Date", "upper 0D", `${dt(1, 1, 2025)}, 0D`],
  ["Date", "0D single", "0D"],
  ["Date", "lower above upper", `${dt(31, 3, 2024)}, ${dt(1, 2, 2024)}`],
  ["Integer", "single", "5"],
  ["Integer", "range", "0, 7"],
  ["Integer", "negative", "-1"],
  ["Integer", "lower above upper", "7, 0"],
  ["Integer", "zero", "0"],
  ["Decimal", "zero", "0"],
  ["Decimal", "fraction", "10.5"],
  ["Decimal", "range", "0, 20"],
  ["Decimal", "negative range", "-3.25, 0.5"],
  ["Decimal", "five decimals", "1000.123"],
  ["Boolean", "true", "true"],
  ["Boolean", "false", "false"],
];

/** SetFilter: [field type, filter text, extra %1.. arguments, depends on locale]. */
const RF_FILTERS: readonly (readonly [
  keyof typeof RF_FIELD,
  string,
  (string | undefined)?,
  boolean?,
])[] = [
  ["Code", "A001|B001"],
  ["Code", "A001..B001"],
  ["Code", "A*"],
  ["Code", "*001"],
  ["Code", "A00?"],
  ["Code", "<>A001"],
  ["Code", "<B"],
  ["Code", ">=C"],
  ["Code", "<>A001&<>A002"],
  ["Code", "A001|B*"],
  ["Code", "a001"],
  ["Code", "@a*"],
  ["Code", "%1", al("B001")],
  ["Text", "Alpha"],
  ["Text", "@alpha"],
  ["Text", "alpha*"],
  ["Text", "@alpha*"],
  ["Text", "@*a"],
  ["Text", "a*b?"],
  ["Text", "a'*'b'?'"],
  ["Text", "É*"],
  ["Text", "@é*"],
  ["Text", "@emile"],
  ["Text", "''"],
  ["Text", "<>''"],
  ["Integer", "5|12"],
  ["Integer", "5..12"],
  ["Integer", "5.."],
  ["Integer", "<5"],
  ["Integer", ">5"],
  ["Integer", "<>5&<>12"],
  ["Integer", ">5&<12"],
  ["Integer", "5.5"],
  ["Integer", "abc"],
  ["Integer", ">%1", "5"],
  ["Integer", "%1..%2", "5, 12"],
  ["Decimal", "10.5", undefined, true],
  ["Decimal", ">10"],
  ["Decimal", "10.5..100", undefined, true],
  ["Decimal", "0"],
  ["Decimal", "<0"],
  ["Decimal", "<>0"],
  ["Decimal", "%1", "10.5", true],
  ["Date", "150324", undefined, true],
  ["Date", "150324..", undefined, true],
  ["Date", "..150324", undefined, true],
  ["Date", "150324|100124", undefined, true],
  ["Date", "2024-03-15", undefined, true],
  ["Date", "%1", dt(15, 3, 2024), true],
  ["Date", "%1..%2", `${dt(1, 2, 2024)}, ${dt(31, 3, 2024)}`, true],
  ["Date", "<>%1", "0D", true],
  ["Option", "Beta"],
  ["Option", "Alpha|Gamma"],
  ["Option", "Alpha..Beta"],
  ["Option", "<>Alpha"],
  ["Option", "1"],
  ["Option", "Delta"],
  ["Option", "%1", "H.Kind::Beta"],
  ["Enum", "Green"],
  ["Enum", "Red|Blue"],
  ["Enum", "<>Red"],
  ["Enum", "Purple"],
  ["Enum", "%1", '"RF Color"::Blue'],
  ["Boolean", "Yes"],
  ["Boolean", "No"],
  ["Boolean", "true"],
  ["Boolean", "<>Yes"],
];

/** The CalcFields cells: five FlowFields, each on a header with lines, one without, under a FlowFilter. */
const RF_FLOWS: readonly (readonly [string, (e: string) => string])[] = [
  ["Line Total", (e) => n9(e)],
  ["Line Count", (e) => n9(e)],
  ["Has Lines", (e) => n9(e)],
  ["Max Qty", (e) => n9(e)],
  ["Min Qty", (e) => n9(e)],
];
const RF_SCENES: readonly (readonly [string, string[]])[] = [
  ["A001 no filter", ["H.Get('A001');"]],
  ["C001 no lines", ["H.Get('C001');"]],
  [
    "A001 February",
    [`H.SetRange(H."Date Filter", ${dt(1, 2, 2024)}, ${dt(29, 2, 2024)});`, "H.Get('A001');"],
  ],
  ["B001 from April", [`H.SetRange(H."Date Filter", ${dt(1, 4, 2024)}, 0D);`, "H.Get('B001');"]],
];

// the record is the field's own prefix (`H.Qty` or `H2.Qty`)
const sr = (f: string, a: string) => `${f.split(".")[0]}.SetRange(${f}, ${a});`;
const RF_DANISH = (method: string, state: string, setup: string[], answer: string): Cell => ({
  type: "Danish",
  method,
  state,
  call: "GlobalLanguage(1030);",
  // the reader sets the language itself too, so a build that does not carry it from the first test is still measured in Danish
  reader: {
    vars: RF_VARS,
    setup: ["GlobalLanguage(1030);", "Seed.Load();", ...setup],
    call: `Error('V:[%1|%2]', ${n9("GlobalLanguage()")}, ${answer});`,
  },
  depends: "locale",
});

const RF_ORDER_CELLS: Cell[] = [
  ["default key", [], KEYS],
  ["default key descending", ["H.Ascending(false);"], KEYS],
  ["Region key", ["H.SetCurrentKey(H.Region);"], KEYS],
  ["Region key descending", ["H.SetCurrentKey(H.Region);", "H.Ascending(false);"], KEYS],
  ["Kind,Qty key", ["H.SetCurrentKey(H.Kind, H.Qty);"], KEYS],
  ["Kind,Qty key descending", ["H.SetCurrentKey(H.Kind, H.Qty);", "H.Ascending(false);"], KEYS],
  ["non-key Name", ["H.SetCurrentKey(H.Name);"], KEYS],
  ["non-key Doc Date", ['H.SetCurrentKey(H."Doc Date");'], KEYS],
  ["non-key Amount", ["H.SetCurrentKey(H.Amount);"], KEYS],
  ["Region key backwards", ["H.SetCurrentKey(H.Region);"], "Seed.KeysBack(H)"],
  ["Region key filtered", ["H.SetCurrentKey(H.Region);", sr("H.Qty", "5, 12")], KEYS],
  ["FindFirst default", [], "Seed.FirstText(H)"],
  ["FindLast default", [], "Seed.LastText(H)"],
  ["FindFirst Region key", ["H.SetCurrentKey(H.Region);"], "Seed.FirstText(H)"],
  ["FindLast Region key", ["H.SetCurrentKey(H.Region);"], "Seed.LastText(H)"],
  [
    "FindLast Region desc",
    ["H.SetCurrentKey(H.Region);", "H.Ascending(false);"],
    "Seed.LastText(H)",
  ],
  ["Find - Region key", ["H.SetCurrentKey(H.Region);"], "Seed.FindText(H, '-')"],
  ["Find + Region key", ["H.SetCurrentKey(H.Region);"], "Seed.FindText(H, '+')"],
  [
    "Find + Region desc",
    ["H.SetCurrentKey(H.Region);", "H.Ascending(false);"],
    "Seed.FindText(H, '+')",
  ],
  ["Find - filtered", [sr("H.Kind", "H.Kind::Beta")], "Seed.FindText(H, '-')"],
  ...["B001", "B000"].flatMap((c) =>
    ["=", ">", "<"].map((m): [string, string[], string] => [
      `Find ${m} ${c}`,
      [`H.Code := ${al(c)};`],
      `Seed.FindText(H, ${al(m)})`,
    ]),
  ),
  ["Find >= B000", [`H.Code := ${al("B000")};`], "Seed.FindText(H, '>=')"],
  ["Find <= B000", [`H.Code := ${al("B000")};`], "Seed.FindText(H, '<=')"],
  ...(
    [
      ["Next 1 from A001", "A001", 1],
      ["Next 2 from A001", "A001", 2],
      ["Next -1 from B001", "B001", -1],
      ["Next -1 from first", "A001", -1],
      ["Next 99 from B001", "B001", 99],
      ["Next -2 from D002", "D002", -2],
    ] as const
  ).map((x): [string, string[], string] => [x[0], [], `Seed.NextText(H, ${al(x[1])}, ${x[2]})`]),
  ["Next -1 Region key", ["H.SetCurrentKey(H.Region);"], "Seed.NextText(H, 'B001', -1)"],
  ["Get ignores filter", [sr("H.Kind", "H.Kind::Gamma")], "Format(H.Get('A001'), 0, 9)"],
].map(([state, setup, answer]) =>
  rf("Order", "order", state as string, setup as string[], answer as string),
);

const RF_FILTERGROUP_CELLS: Cell[] = [
  rf(
    "FilterGroup",
    "group 2",
    "then group 0 keys",
    ["H.FilterGroup(2);", sr("H.Kind", "H.Kind::Beta"), "H.FilterGroup(0);"],
    KEYS,
  ),
  rf(
    "FilterGroup",
    "group 2",
    "and group 0 combine",
    ["H.FilterGroup(2);", sr("H.Kind", "H.Kind::Beta"), "H.FilterGroup(0);", sr("H.Qty", "12")],
    KEYS,
  ),
  rf(
    "FilterGroup",
    "group 2",
    "same field both groups",
    ["H.FilterGroup(2);", sr("H.Qty", "5"), "H.FilterGroup(0);", sr("H.Qty", "12")],
    KEYS,
  ),
  rf(
    "FilterGroup",
    "GetFilters",
    "group 0 hides group 2",
    [
      "H.FilterGroup(2);",
      sr("H.Region", "'N'"),
      "H.FilterGroup(0);",
      sr("H.Kind", "H.Kind::Alpha"),
    ],
    "H.GetFilters()",
  ),
  rf(
    "FilterGroup",
    "GetFilters",
    "inside group 2",
    [
      "H.FilterGroup(2);",
      sr("H.Region", "'N'"),
      "H.FilterGroup(0);",
      sr("H.Kind", "H.Kind::Alpha"),
      "H.FilterGroup(2);",
    ],
    "H.GetFilters()",
  ),
  rf(
    "FilterGroup",
    "GetFilter",
    "group 0 of group 2 field",
    ["H.FilterGroup(2);", sr("H.Region", "'N'"), "H.FilterGroup(0);"],
    "H.GetFilter(H.Region)",
  ),
  rf(
    "FilterGroup",
    "GetFilter",
    "group 2",
    ["H.FilterGroup(2);", sr("H.Region", "'N'")],
    "H.GetFilter(H.Region)",
  ),
  rf("FilterGroup", "return value", "previous group", [], n9("H.FilterGroup(2)")),
  rf(
    "FilterGroup",
    "return value",
    "current group after set",
    ["H.FilterGroup(2);"],
    n9("H.FilterGroup()"),
  ),
  rf("FilterGroup", "return value", "group 10", ["H.FilterGroup(10);"], n9("H.FilterGroup()")),
  rf(
    "FilterGroup",
    "Reset",
    "clears all groups",
    [
      "H.FilterGroup(2);",
      sr("H.Kind", "H.Kind::Beta"),
      "H.FilterGroup(0);",
      sr("H.Qty", "12"),
      "H.Reset();",
    ],
    KEYS,
  ),
  rf(
    "FilterGroup",
    "Reset",
    "group back to 0",
    ["H.FilterGroup(2);", "H.Reset();"],
    n9("H.FilterGroup()"),
  ),
  rf("FilterGroup", "Reset", "clears the key", ["H.SetCurrentKey(H.Region);", "H.Reset();"], KEYS),
  rf("FilterGroup", "Reset", "clears descending", ["H.Ascending(false);", "H.Reset();"], KEYS),
  rf(
    "FilterGroup",
    "CopyFilters",
    "group 0",
    [sr("H2.Kind", "H2.Kind::Gamma"), "H.CopyFilters(H2);"],
    KEYS,
    { vars: ['H2: Record "RF Header";'] },
  ),
  rf(
    "FilterGroup",
    "CopyFilters",
    "group 2 source",
    [
      "H2.FilterGroup(2);",
      sr("H2.Kind", "H2.Kind::Gamma"),
      "H2.FilterGroup(0);",
      "H.CopyFilters(H2);",
    ],
    KEYS,
    { vars: ['H2: Record "RF Header";'] },
  ),
  rf(
    "FilterGroup",
    "CopyFilters",
    "replaces own",
    [sr("H.Region", "'N'"), sr("H2.Kind", "H2.Kind::Gamma"), "H.CopyFilters(H2);"],
    KEYS,
    { vars: ['H2: Record "RF Header";'] },
  ),
  rf(
    "FilterGroup",
    "CopyFilter",
    "one field",
    [sr("H2.Qty", "5, 12"), "H2.CopyFilter(H2.Qty, H.Qty);"],
    KEYS,
    { vars: ['H2: Record "RF Header";'] },
  ),
  rf(
    "FilterGroup",
    "SetRecFilter",
    "GetFilters",
    ["H.Get('B001');", "H.SetRecFilter();"],
    "H.GetFilters()",
  ),
  rf("FilterGroup", "SetRecFilter", "keys", ["H.Get('B001');", "H.SetRecFilter();"], KEYS),
];

const RF_GETFILTERS: [string, string[], boolean][] = [
  ["no filter", [], false],
  ["Code range", [sr("H.Code", "'A001', 'B001'")], false],
  ["Code SetFilter wildcard", ["H.SetFilter(H.Code, 'A*|?002');"], false],
  ["Text accent", [sr("H.Name", al("Émile"))], false],
  ["Option name", [sr("H.Kind", "H.Kind::Beta")], false],
  ["Option range", [sr("H.Kind", "H.Kind::Alpha, H.Kind::Beta")], false],
  ["Enum", [sr("H.Color", '"RF Color"::Green')], false],
  ["Boolean", [sr("H.Active", "true")], false],
  ["Integer range", [sr("H.Qty", "5, 12")], false],
  ["Integer open", [sr("H.Qty", "5, 0")], false],
  ["Decimal", [sr("H.Amount", "10.5, 1000.123")], true],
  ["Date single", [sr('H."Doc Date"', dt(15, 3, 2024))], true],
  ["Date range", [sr('H."Doc Date"', `${dt(1, 2, 2024)}, ${dt(31, 3, 2024)}`)], true],
  ["two fields", [sr("H.Qty", "5"), sr("H.Code", "'A001', 'B001'")], false],
  ["SetFilter placeholder", ["H.SetFilter(H.Qty, '%1|%2', 5, 12);"], false],
];

const RF_CELLS: Cell[] = [
  ...RF_RANGES.map(([t, state, a]) => rf("SetRange", t, state, [sr(RF_FIELD[t], a)], KEYS)),
  rf("SetRange", "Code", "set then cleared", [sr("H.Code", "'B001'"), "H.SetRange(H.Code);"], KEYS),
  rf(
    "SetRange",
    "Code",
    "second call replaces first",
    [sr("H.Code", "'B001'"), sr("H.Code", "'A001'")],
    KEYS,
  ),
  rf("SetRange", "Code", "empty Region", [sr("H.Region", "''")], KEYS),
  rf(
    "SetRange",
    "Code",
    "two fields",
    [sr("H.Region", "'N'"), sr("H.Kind", "H.Kind::Alpha")],
    KEYS,
  ),
  ...RF_FILTERS.map(([t, text, args, loc]) =>
    rf(
      "SetFilter",
      t,
      args !== undefined ? `${text} with args` : text,
      [`H.SetFilter(${RF_FIELD[t]}, ${al(text)}${args !== undefined ? `, ${args}` : ""});`],
      KEYS,
      loc === true ? { depends: "locale" } : {},
    ),
  ),
  ...RF_ORDER_CELLS,
  ...RF_FILTERGROUP_CELLS,
  ...RF_GETFILTERS.map(([state, setup, loc]) =>
    rf(
      "GetFilters",
      "GetFilters",
      state,
      setup,
      "H.GetFilters()",
      loc ? { depends: "locale" } : {},
    ),
  ),
  rf("Count", "Count", "no filter", [], n9("H.Count()")),
  rf("Count", "Count", "Kind filter", [sr("H.Kind", "H.Kind::Alpha")], n9("H.Count()")),
  rf("Count", "Count", "no match", [sr("H.Code", "'Z999'")], n9("H.Count()")),
  rf(
    "Count",
    "Count",
    "after Reset",
    [sr("H.Kind", "H.Kind::Alpha"), "H.Reset();"],
    n9("H.Count()"),
  ),
  rf("Count", "Count", "FlowField filter", ['H.SetRange(H."Line Count", 2);'], n9("H.Count()")),
  rf("Count", "IsEmpty", "no filter", [], n9("H.IsEmpty()")),
  rf("Count", "IsEmpty", "matching filter", [sr("H.Kind", "H.Kind::Alpha")], n9("H.IsEmpty()")),
  rf("Count", "IsEmpty", "no match", [sr("H.Code", "'Z999'")], n9("H.IsEmpty()")),
  rf("Count", "IsEmpty", "after DeleteAll", ["H.DeleteAll();"], n9("H.IsEmpty()")),
  rf("Count", "IsEmpty", "filter on empty text", [sr("H.Name", "''")], n9("H.IsEmpty()")),
  ...RF_FLOWS.flatMap(([f, show]) =>
    RF_SCENES.slice(0, f === "Line Total" || f === "Line Count" ? 4 : 3).map(([scene, setup]) =>
      rf("CalcFields", f, scene, [...setup, `H.CalcFields(H."${f}");`], show(`H."${f}"`)),
    ),
  ),
  rf("FlowField", "Get without CalcFields", "A001", ["H.Get('A001');"], n9('H."Line Count"')),
  rf(
    "FlowField",
    "all at once",
    "A001",
    ["H.Get('A001');", 'H.CalcFields(H."Line Total", H."Line Count", H."Max Qty");'],
    `${n9('H."Line Total"')} + '|' + ${n9('H."Line Count"')} + '|' + ${n9('H."Max Qty"')}`,
  ),
  rf("FlowField", "filter on FlowField", "Line Count 2", ['H.SetRange(H."Line Count", 2);'], KEYS),
  rf("FlowField", "filter on FlowField", "Line Count 0", ['H.SetRange(H."Line Count", 0);'], KEYS),
  rf(
    "FlowField",
    "filter on FlowField",
    "Line Total > 0",
    ["H.SetFilter(H.\"Line Total\", '>0');"],
    KEYS,
  ),
  rf(
    "FlowField",
    "filter on FlowField",
    "Has Lines true",
    ['H.SetRange(H."Has Lines", true);'],
    KEYS,
  ),
  rf("FlowField", "filter on FlowField", "Max Qty 10", ['H.SetRange(H."Max Qty", 10);'], KEYS),
  rf(
    "FlowField",
    "filter on FlowField",
    "Line Total with Feb",
    [
      `H.SetRange(H."Date Filter", ${dt(1, 2, 2024)}, ${dt(29, 2, 2024)});`,
      "H.SetFilter(H.\"Line Total\", '>0');",
    ],
    KEYS,
  ),
  rf(
    "FlowField",
    "SetAutoCalcFields",
    "then Get",
    ['H.SetAutoCalcFields(H."Line Count");', "H.Get('A001');"],
    n9('H."Line Count"'),
  ),
  rf(
    "FlowField",
    "FlowFilter",
    "GetFilter",
    [`H.SetRange(H."Date Filter", ${dt(1, 2, 2024)}, ${dt(29, 2, 2024)});`],
    'H.GetFilter(H."Date Filter")',
    { depends: "locale" },
  ),
  rf("CalcSums", "Amount", "no filter", ["H.CalcSums(H.Amount);"], n9("H.Amount")),
  rf(
    "CalcSums",
    "Amount",
    "Region key",
    ["H.SetCurrentKey(H.Region);", "H.CalcSums(H.Amount);"],
    n9("H.Amount"),
  ),
  rf(
    "CalcSums",
    "Amount",
    "Kind filter",
    [sr("H.Kind", "H.Kind::Beta"), "H.CalcSums(H.Amount);"],
    n9("H.Amount"),
  ),
  rf(
    "CalcSums",
    "Amount",
    "Region filter on key",
    ["H.SetCurrentKey(H.Region);", sr("H.Region", "'N'"), "H.CalcSums(H.Amount);"],
    n9("H.Amount"),
  ),
  rf(
    "CalcSums",
    "Amount",
    "no match",
    [sr("H.Code", "'Z999'"), "H.CalcSums(H.Amount);"],
    n9("H.Amount"),
  ),
  rf(
    "CalcSums",
    "Amount and Qty",
    "Region key",
    ["H.SetCurrentKey(H.Region);", "H.CalcSums(H.Amount, H.Qty);"],
    `${n9("H.Amount")} + '|' + ${n9("H.Qty")}`,
  ),
  rf(
    "CalcSums",
    "Qty",
    "range",
    ["H.SetCurrentKey(H.Region);", sr("H.Qty", "5, 12"), "H.CalcSums(H.Qty);"],
    n9("H.Qty"),
  ),
  rf("CalcSums", "Line Amount", "no filter", ["L.CalcSums(L.Amount);"], n9("L.Amount"), {
    vars: ['L: Record "RF Line";'],
  }),
  rf(
    "CalcSums",
    "Line Amount",
    "header filter",
    ["L.SetRange(L.\"Header Code\", 'A001');", "L.CalcSums(L.Amount, L.Qty);"],
    `${n9("L.Amount")} + '|' + ${n9("L.Qty")}`,
    { vars: ['L: Record "RF Line";'] },
  ),
  rf(
    "CalcSums",
    "Line Amount",
    "negative amounts",
    ["L.SetFilter(L.Amount, '<0');", "L.CalcSums(L.Amount);"],
    n9("L.Amount"),
    { vars: ['L: Record "RF Line";'] },
  ),
  rf(
    "ModifyAll",
    "Qty",
    "Kind Alpha",
    [sr("H.Kind", "H.Kind::Alpha"), "H.ModifyAll(H.Qty, 99);"],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Active",
    "Region S",
    [sr("H.Region", "'S'"), "H.ModifyAll(H.Active, false);"],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Name",
    "case-insensitive filter",
    ["H.SetFilter(H.Name, '@a*');", "H.ModifyAll(H.Name, 'X');"],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Qty",
    "no match",
    [sr("H.Code", "'Z999'"), "H.ModifyAll(H.Qty, 99);"],
    "Seed.Rows()",
  ),
  rf("ModifyAll", "Qty", "no filter", ["H.ModifyAll(H.Qty, 1);"], "Seed.Rows()"),
  rf(
    "ModifyAll",
    "Qty",
    "no trigger",
    [sr("H.Qty", "5"), "H.ModifyAll(H.Qty, 6, false);"],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Color",
    "Red to Blue",
    [sr("H.Color", '"RF Color"::Red'), 'H.ModifyAll(H.Color, "RF Color"::Blue);'],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Qty",
    "group 2 filter",
    [
      "H.FilterGroup(2);",
      sr("H.Kind", "H.Kind::Gamma"),
      "H.FilterGroup(0);",
      "H.ModifyAll(H.Qty, 50);",
    ],
    "Seed.Rows()",
  ),
  rf(
    "ModifyAll",
    "Qty",
    "MarkedOnly",
    ["H.Get('A001');", "H.Mark(true);", "H.MarkedOnly(true);", "H.ModifyAll(H.Qty, 77);"],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "Kind Alpha",
    [sr("H.Kind", "H.Kind::Alpha"), "H.DeleteAll();"],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "no match",
    [sr("H.Code", "'Z999'"), "H.DeleteAll();"],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "empty Region",
    [sr("H.Region", "''"), "H.DeleteAll();"],
    "Seed.Rows()",
  ),
  rf("DeleteAll", "DeleteAll", "no filter", ["H.DeleteAll();"], "Seed.Rows()"),
  rf(
    "DeleteAll",
    "DeleteAll",
    "Qty range",
    [sr("H.Qty", "5, 12"), "H.DeleteAll(true);"],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "MarkedOnly",
    [
      "H.Get('A001');",
      "H.Mark(true);",
      "H.Get('D002');",
      "H.Mark(true);",
      "H.MarkedOnly(true);",
      "H.DeleteAll();",
    ],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "group 2 filter",
    ["H.FilterGroup(2);", sr("H.Region", "'N'"), "H.FilterGroup(0);", "H.DeleteAll();"],
    "Seed.Rows()",
  ),
  rf(
    "DeleteAll",
    "DeleteAll",
    "lines of A001",
    ["L.SetRange(L.\"Header Code\", 'A001');", "L.DeleteAll();"],
    "Seed.LRows()",
    { vars: ['L: Record "RF Line";'] },
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "two rows",
    ["H.Get('A001');", "H.Mark(true);", "H.Get('C001');", "H.Mark(true);", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "set back to false",
    ["H.Get('A001');", "H.Mark(true);", "H.MarkedOnly(true);", "H.MarkedOnly(false);"],
    KEYS,
  ),
  rf("Mark", "Marked", "after Mark true", ["H.Get('A001');", "H.Mark(true);"], n9("H.Mark()")),
  rf("Mark", "Marked", "unmarked row", ["H.Get('A001');"], n9("H.Mark()")),
  rf(
    "Mark",
    "Mark false",
    "unmarks",
    ["H.Get('A001');", "H.Mark(true);", "H.Mark(false);", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "with a Kind filter",
    [
      "H.Get('A001');",
      "H.Mark(true);",
      "H.Get('C001');",
      "H.Mark(true);",
      sr("H.Kind", "H.Kind::Alpha"),
      "H.MarkedOnly(true);",
    ],
    KEYS,
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "mark outside the filter",
    [sr("H.Kind", "H.Kind::Alpha"), "H.Get('C001');", "H.Mark(true);", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "ClearMarks",
    "then MarkedOnly",
    ["H.Get('A001');", "H.Mark(true);", "H.ClearMarks();", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "Reset",
    "keeps marks",
    ["H.Get('A001');", "H.Mark(true);", "H.Reset();", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "Mark in loop",
    "Qty above 6",
    ["if H.FindSet() then repeat H.Mark(H.Qty > 6); until H.Next() = 0;", "H.MarkedOnly(true);"],
    KEYS,
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "Region key order",
    [
      "H.Get('A002');",
      "H.Mark(true);",
      "H.Get('A001');",
      "H.Mark(true);",
      "H.SetCurrentKey(H.Region);",
      "H.MarkedOnly(true);",
    ],
    KEYS,
  ),
  rf(
    "Mark",
    "MarkedOnly",
    "Count",
    ["H.Get('A001');", "H.Mark(true);", "H.MarkedOnly(true);"],
    n9("H.Count()"),
  ),
  RF_DANISH("GetFilters", "Decimal range", [sr("H.Amount", "10.5, 1000.123")], "H.GetFilters()"),
  RF_DANISH(
    "GetFilters",
    "Date range",
    [sr('H."Doc Date"', `${dt(1, 2, 2024)}, ${dt(31, 3, 2024)}`)],
    "H.GetFilters()",
  ),
  RF_DANISH("GetFilters", "Boolean true", [sr("H.Active", "true")], "H.GetFilters()"),
  RF_DANISH("GetFilters", "Option name", [sr("H.Kind", "H.Kind::Beta")], "H.GetFilters()"),
  RF_DANISH(
    "GetFilters",
    "SetFilter Decimal placeholder",
    ["H.SetFilter(H.Amount, '%1', 10.5);"],
    "H.GetFilters()",
  ),
  RF_DANISH(
    "GetFilters",
    "SetFilter Date placeholders",
    [`H.SetFilter(H."Doc Date", '%1..%2', ${dt(1, 2, 2024)}, ${dt(31, 3, 2024)});`],
    "H.GetFilters()",
  ),
  ...["10,5", "10.5", "1000,123"].map((t) =>
    RF_DANISH("SetFilter", `Decimal ${t}`, [`H.SetFilter(H.Amount, ${al(t)});`], KEYS),
  ),
  ...["15.03.2024", "15-03-2024..", "150324", "2024-03-15"].map((t) =>
    RF_DANISH("SetFilter", `Date ${t}`, [`H.SetFilter(H."Doc Date", ${al(t)});`], KEYS),
  ),
  ...["Ja", "Nej", "Yes"].map((t) =>
    RF_DANISH("SetFilter", `Boolean ${t}`, [`H.SetFilter(H.Active, ${al(t)});`], KEYS),
  ),
  RF_DANISH("SetFilter", "Text @æ*", ["H.SetFilter(H.Name, '@æ*');"], KEYS),
  RF_DANISH("Format", "Decimal field", ["H.Get('D001');"], "Format(H.Amount)"),
];

export const RECORD_FILTERS: Family = {
  name: "record-filters",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues",
  known: [],
  support: RF_SUPPORT,
  handles: {},
  cells: RF_CELLS,
};

export const FAMILIES: Readonly<Record<string, Family>> = {
  [UNTOUCHED_HANDLE.name]: UNTOUCHED_HANDLE,
  [DOTNET_NO_OBJECT.name]: DOTNET_NO_OBJECT,
  [PLATFORM_TABLE_READ.name]: PLATFORM_TABLE_READ,
  [PERMISSION_DENIAL.name]: PERMISSION_DENIAL,
  [NO_CLIENT.name]: NO_CLIENT,
  // PR-26: appended (bcCheckApp's id is the place in this list)
  [GET_URL.name]: GET_URL,
  // PR-30: appended; its BC-check number is 8 (bcCheckApp skips 7), as 7 is PR-27's hand-written number-sequence app
  [TABLE_CONNECTION.name]: TABLE_CONNECTION,
  // PR-32: appended (BC-check number 9)
  [DOTNET_EXCEPTION.name]: DOTNET_EXCEPTION,
  // PR-33: appended (BC-check number 10): family 9's OpenSSL RSA form
  [DOTNET_EXCEPTION_RSA.name]: DOTNET_EXCEPTION_RSA,
  // PR-33: appended (BC-check number 11): family 10, #8038
  [PUBAPP_FLOWFIELD.name]: PUBAPP_FLOWFIELD,
  // PR-52: appended (BC-check number 12): Format, Evaluate and the text functions, for a per-cell BC differential
  [FORMAT_EVALUATE.name]: FORMAT_EVALUATE,
  // PR-74: appended (BC-check number 13): t9's refusal texts, for a keep census
  [T9_REFUSALS.name]: T9_REFUSALS,
  // PR-83: appended (BC-check number 14): record filters, keys, FlowFields, marks, for a per-cell BC differential
  [RECORD_FILTERS.name]: RECORD_FILTERS,
};

/** The first codeunit id; cell i is `BASE + 1 + i`. */
export const BASE_ID = 51000;

/** A cell's test codeunit name (AL caps object names at 30). */
export function cellName(c: Cell, i: number): string {
  return `C${i} ${c.type} ${c.method} ${c.state === "untouched" ? "" : c.state}`
    .trim()
    .slice(0, 30);
}

/**
 * PR-17: platform tables BC 28's compiler rejects in an app (AL0433: removed; AL0161: internal to the System app), measured
 * with alc against the bc2 server's own System symbols. al-runner compiles them, so family 3 reads them, but no app on BC
 * can: a BC-check app leaves their cells out.
 */
export const BC_UNAVAILABLE_TABLES: ReadonlySet<string> = new Set([
  "Agent Access Control Data",
  "Agent Data",
  "Agent Task Data",
  "Agent Task File Data",
  "Agent Task Log Entry Data",
  "Agent Task Memory Entry Data",
  "Agent Task Message Data",
  "Agent Task Msg Attach Data",
  "Agent Task Timeline Step Data",
  "Agent Task User Int. Data",
  "Agent Troubleshoot Info Data",
  "Debugger Breakpoint",
  "Debugger Call Stack",
  "Debugger Variable",
  "Debugger Watch",
  "NAV App",
  "NAV App Dependencies",
  "NAV App Object Metadata",
  "NAV App Publish Reference",
  "NAV App Published App",
  "NAV App Resource",
  "NAV App Tenant App",
  "Profile",
  "Profile Metadata",
  "Profile Page Metadata",
  "User Metadata",
]);

/** PR-17: a family's cells that a BC app can hold (cells on a table BC 28 rejects are left out). */
export function bcCheckFamily(f: Family): Family {
  const gone = new Set([...BC_UNAVAILABLE_TABLES].map(tableType));
  return { ...f, cells: f.cells.filter((c) => !gone.has(c.type)) };
}

/**
 * PR-17: the id and name of a family's BC-check app (the same cells, run on BC to measure what al-runner's answer is only
 * inferred against). Each family gets its own app id, so publishing one never reads as an upgrade of another; they share the
 * object range, so a BC server holds one at a time. The id is the family's place in FAMILIES: append a family, never insert
 * one (the test pins the ids handed to lethal-bugs).
 */
export function bcCheckApp(f: Family): { id: string; name: string } {
  const place = Object.keys(FAMILIES).indexOf(f.name) + 1;
  if (place === 0) throw new Error(`refusal-family: ${f.name} is not a listed family`);
  // PR-30: 7 is PR-27's hand-written number-sequence app, which has no FAMILIES entry, so places from 7 on take the next number
  const n = place >= 7 ? place + 1 : place;
  return {
    id: `51000000-0000-4000-8000-0000000510${String(n).padStart(2, "0")}`,
    name: `LethAL BC Check ${f.name}`,
  };
}

/** The app's files: app.json and one .al file with the support objects and one test codeunit per cell. */
export function emitApp(
  f: Family,
  app: { id: string; name: string } = {
    id: "51000000-0000-4000-8000-000000051000",
    name: `Refusal Family ${f.name}`,
  },
): Record<string, string> {
  const units = f.cells.map((c, i) => {
    const vars = [f.handles[c.type], ...(c.vars ?? [])].filter((v) => v !== undefined);
    const body = [...(c.setup ?? []), c.call].map((s) => `        ${s}`).join("\n");
    // PR-17: a cell that shows UI binds its handlers; each handler is a whole procedure, named by its `procedure` line
    const handlers = c.handlers ?? [];
    const names = handlers
      .map((h) => /procedure (\w+)/.exec(h)?.[1])
      .filter((n) => n !== undefined);
    const proc = (name: string, vs: readonly string[], b: string) =>
      `${names.length > 0 ? `    [HandlerFunctions('${names.join(",")}')]\n` : ""}    [Test]
    procedure ${name}()
${vs.length > 0 ? `    var\n${vs.map((v) => `        ${v}`).join("\n")}\n` : ""}    begin
${b}
    end;
`;
    const t = c.reader;
    // PR-63: a two-test cell lists SetLanguage, then ReadLanguage (declaration order is the run order)
    const tests =
      t === undefined
        ? proc("Cell", vars, body)
        : `${proc(SET_TEST, vars, body)}\n${proc(
            READ_TEST,
            t.vars ?? [],
            [...(t.setup ?? []), t.call].map((s) => `        ${s}`).join("\n"),
          )}`;
    return `codeunit ${BASE_ID + 1 + i} "${cellName(c, i)}"
{
    Subtype = Test;

${tests}${handlers.map((h) => `\n${h}`).join("")}}
`;
  });
  return {
    "app.json": `${JSON.stringify(
      {
        id: app.id,
        name: app.name,
        publisher: "LethAL Repro",
        version: "1.0.0.0",
        platform: "28.0.0.0",
        runtime: "17.0",
        ...(f.target !== undefined ? { target: f.target } : {}),
        idRanges: [{ from: BASE_ID, to: BASE_ID + 1 + f.cells.length }],
        features: ["NoImplicitWith"],
        ...(f.dependencies !== undefined ? { dependencies: f.dependencies } : {}),
      },
      null,
      2,
    )}\n`,
    "src/Cells.al": `// Generated by scripts/refusal-family.ts (PR-01), family ${f.name}: invented, no corpus source text.\n${f.support}\n${units.join("\n")}`,
  };
}

export type Outcome = "pass" | "fail" | "refused" | "timeout" | "missing";

export interface CellResult {
  readonly cell: Cell;
  readonly outcome: Outcome;
  readonly message?: string;
}

/** The refusal text of a row: what follows v3's marker (wherever it stands), without a trailing ` (not pinned)`. */
export function refusalText(message: string): string {
  const at = message.indexOf("NotRun: out-of-scope: ");
  return (at >= 0 ? message.slice(at + "NotRun: out-of-scope: ".length) : message)
    .replace(/ \(not pinned\)$/, "")
    .trim();
}

/** Each cell's outcome from the run's rows (`Codeunit<id>.Cell`). A cell with no row is `missing`, never a pass. */
export function classify(
  f: Family,
  rows: ReadonlyArray<{ name: string; status: string; message?: string; notRun?: boolean }>,
): CellResult[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  return f.cells.map((cell, i) => {
    const id = BASE_ID + 1 + i;
    const r = byName.get(`Codeunit${id}.${cell.reader !== undefined ? READ_TEST : "Cell"}`);
    if (r === undefined) return { cell, outcome: "missing" };
    // PR-63: the reader's answer means nothing if the setter did not pass; say so rather than score the reader
    if (cell.reader !== undefined) {
      const s = byName.get(`Codeunit${id}.${SET_TEST}`);
      if (s === undefined) return { cell, outcome: "missing" };
      if (s.status !== "pass" || s.notRun === true)
        return { cell, outcome: "fail", message: `${SET_TEST} did not pass: ${s.message ?? ""}` };
    }
    // A stopped test is neither a refusal nor a score.
    if (r.notRun === true && V3_TIMEOUT_MESSAGE.test(r.message ?? ""))
      return {
        cell,
        outcome: "timeout",
        ...(r.message !== undefined ? { message: r.message } : {}),
      };
    // Review: v3's refusal marker ANYWHERE in the message is a refusal, with or without `notRun` (R675).
    if (r.notRun === true || isV3RefusalText(r.message))
      return { cell, outcome: "refused", message: refusalText(r.message ?? "") };
    if (r.status === "pass") return { cell, outcome: "pass" };
    return { cell, outcome: "fail", ...(r.message !== undefined ? { message: r.message } : {}) };
  });
}

/**
 * A refusal's class: its text up to the first `: ` (the reason's explanation is dropped), with a leading `Type.Method` made
 * `Type.*`, since al-runner names the method in each text ("RecordRef.FindSet on a RecordRef that is not open" and
 * "RecordRef.FieldCount on a RecordRef that is not open" are one class).
 */
export function classOf(text: string): string {
  // PR-26: a GetUrl text names the client type and the argument count (and, for Default or Windows, the object type); the
  // reason after it is the class
  const getUrl = /^GetUrl\([^)]*\)(?:: | of object type \w+ with \d+ arguments )(.*)$/.exec(text);
  if (getUrl) return `GetUrl(*): ${getUrl[1]?.replace(/ \(not pinned\)$/, "")}`;
  // PR-02: a DotNet member's text names the member twice and the cause after it; the cause is the class.
  const dotnet = /^DotNet [\w.]+: '[\w.]+' (.*)$/.exec(text);
  if (dotnet) return `DotNet *: ${dotnet[1]}`;
  // PR-32: a .NET exception's text names the member, the exception and its message (some without the "; the text AL would see
  // is not pinned" tail); one class, #7924's
  if (/^DotNet (?:new )?[\w.+]+ raised the \.NET exception /.test(text))
    return "DotNet * raised the .NET exception *";
  // PR-13: a platform table's text names the table; the store's reason is the class.
  const platform = /^(?:store error )?platform table '[^']+' \(\d+\) (.*)$/.exec(text);
  if (platform) return `platform table *: ${platform[1]}`;
  // PR-13: the store words a read's refusal with `store error ` or without, and names the read (`IsEmpty on`,
  // `FindFirst on`): one class per cause.
  // PR-16: a permission denial names the object it denies; the permission and the reason are the class
  const denial = text.replace(/ on object type \d+ id \d+\)/, " on object type * id *)");
  if (denial !== text) return classOf(denial);
  // PR-16: `<table>: permission set '<set>': `<grant>` <reason>`: a set's rows read through a system table; the reason is
  // the class, whichever table and set
  const setRows = /^(?:store error )?[^:]+: permission set '[^']*': `[^`]*` (.*)$/.exec(text);
  if (setRows) return `*: permission set *: ${setRows[1]}`;
  const store = text
    .replace(/^store error /, "")
    .replace(/^(?:IsEmpty|FindFirst|FindSet|Count) on /, "* on ");
  if (store !== text) return classOf(store);
  const head = text.split(": ")[0] ?? text;
  return head.replace(/^([A-Za-z]+)\.[A-Za-z]+ on /, "$1.* on ").trim();
}

/** Refused cells grouped by their class; `known` marks a class the family's issue already names. */
export function refusalClasses(
  f: Family,
  results: readonly CellResult[],
): { text: string; known: boolean; cells: string[] }[] {
  const known = new Set(f.known.map(classOf));
  const groups = new Map<string, string[]>();
  for (const r of results) {
    if (r.outcome !== "refused") continue;
    const k = classOf(r.message ?? "");
    groups.set(k, [...(groups.get(k) ?? []), `${r.cell.type}.${r.cell.method} (${r.cell.state})`]);
  }
  return [...groups.entries()]
    .map(([text, cells]) => ({ text, known: known.has(text), cells }))
    .sort((a, b) => Number(a.known) - Number(b.known) || a.text.localeCompare(b.text));
}

/** PR-52: one BC answer per cell, as lethal-bugs returns it: `<codeunit id>\t<pass|fail>\t<message>` (PR-17's shape). */
export interface BcRow {
  readonly outcome: string;
  readonly message: string;
  /**
   * PR-63: how the id came: bare (`51001`), as the reader (`51539.B_ReadLanguage`) or as the setter only
   * (`51539.A_SetLanguage`). `joinCells` checks the form against the cell: a two-test cell needs `reader` plus `setter`.
   */
  readonly form?: "plain" | "reader" | "setter";
  readonly setter?: { readonly outcome: string; readonly message: string };
}

export function parseBcTsv(text: string): Map<number, BcRow> {
  const answers = new Map<number, BcRow>();
  const setters = new Map<number, { outcome: string; message: string }>();
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const [idText, outcome, ...rest] = line.split("\t");
    // PR-63: a two-test codeunit may come back as `<id>.SetLanguage` and `<id>.ReadLanguage`; the reader's row is the cell's
    // answer, the setter's row is dropped. A plain `<id>` is the cell's answer as before.
    const [id, test, extra] = (idText ?? "").split(".");
    const n = Number(id);
    if (
      !Number.isInteger(n) ||
      extra !== undefined ||
      (test !== undefined && test !== SET_TEST && test !== READ_TEST) ||
      (outcome !== "pass" && outcome !== "fail")
    )
      throw new Error(
        `refusal-family: bad BC row (want id[.${SET_TEST}|.${READ_TEST}], pass|fail, message): ${line.slice(0, 80)}`,
      );
    const key = `${n}.${test === SET_TEST ? SET_TEST : "answer"}`;
    if (seen.has(key)) throw new Error(`refusal-family: BC row ${idText} appears twice`);
    seen.add(key);
    const row = { outcome, message: rest.join("\t") };
    if (test === SET_TEST) setters.set(n, row);
    else answers.set(n, test === READ_TEST ? { ...row, form: "reader" } : row);
  }
  const rows = new Map<number, BcRow>();
  for (const [n, a] of answers) {
    const setter = setters.get(n);
    rows.set(n, setter !== undefined ? { ...a, setter } : a);
  }
  for (const [n, s] of setters) if (!rows.has(n)) rows.set(n, { ...s, form: "setter" });
  return rows;
}

export type JoinClass =
  | "equal"
  | "v3 refused"
  | "different value"
  | "different error text"
  | "one errors, one returns"
  | "transport-trimmed"
  | "v3 not run";

/** Both sides' messages go through this before they are compared: line breaks and tabs become one space. */
export const normalizeMessage = (m: string | undefined): string =>
  (m ?? "").replace(/\r\n|[\r\n\t]/g, " ");

/** A cell's value ends in `]`; a message that starts `V:` but does not end that way lost its tail on the way. */
const intactValue = (m: string) => /^V:\[[\s\S]*\]$/.test(m);

export interface JoinRow {
  readonly id: number;
  readonly cell: Cell;
  readonly cls: JoinClass;
  /** A differing cell that depends on locale or time zone: that difference may explain it. */
  readonly depends: Cell["depends"];
  readonly v3: string;
  readonly bc: string;
}

/** The raw answer, with every escape visible (JSON), never collapsed whitespace. */
const say = (outcome: string, message: string | undefined) =>
  outcome === "pass" ? "pass" : `${outcome}: ${JSON.stringify(message ?? "")}`;

/** The report's cells must be the family's cells, in order. */
export function checkReportCells(results: readonly CellResult[]): void {
  if (results.length !== FORMAT_EVALUATE.cells.length)
    throw new Error(
      `the report has ${results.length} cells, the family ${FORMAT_EVALUATE.cells.length}`,
    );
  for (const [i, r] of results.entries()) {
    const c = FORMAT_EVALUATE.cells[i];
    if (c?.type !== r.cell.type || c.method !== r.cell.method || c.state !== r.cell.state)
      throw new Error(`cell ${i} of the report is not the family's cell ${i}`);
  }
}

/**
 * Join v3's results (`--json`, cell i is codeunit BASE_ID+1+i) with BC's rows, per cell. A BC id outside the family's range
 * or a cell with no BC row is refused, never skipped.
 */
export function joinCells(
  results: readonly CellResult[],
  bc: ReadonlyMap<number, BcRow>,
): JoinRow[] {
  for (const id of bc.keys())
    if (id <= BASE_ID || id > BASE_ID + results.length)
      throw new Error(
        `refusal-family: BC id ${id} is outside the family's ${BASE_ID + 1}..${BASE_ID + results.length}`,
      );
  return results.map((r, i) => {
    const id = BASE_ID + 1 + i;
    const got = bc.get(id);
    if (got === undefined) throw new Error(`refusal-family: no BC row for cell ${id}`);
    // PR-63: the row's form must fit the cell. A two-test cell needs the reader's row AND the setter's; a one-test cell takes a bare id.
    const form = got.form ?? "plain";
    if (r.cell.reader !== undefined) {
      if (form === "plain")
        throw new Error(
          `refusal-family: cell ${id} has two tests: give ${id}.${READ_TEST}, not ${id}`,
        );
      if (form === "setter") throw new Error(`refusal-family: no ${READ_TEST} row for cell ${id}`);
      if (got.setter === undefined)
        throw new Error(`refusal-family: no ${SET_TEST} row for cell ${id}`);
    } else if (form !== "plain" || got.setter !== undefined)
      throw new Error(`refusal-family: cell ${id} has one test: give ${id}, not a test suffix`);
    // a setter that failed makes the reader's answer meaningless: the answer is the setter's failure
    const b =
      got.setter !== undefined && got.setter.outcome !== "pass"
        ? { outcome: "fail", message: `${SET_TEST} did not pass: ${got.setter.message}` }
        : got;
    const v3 = say(r.outcome, r.message);
    const row = (cls: JoinClass): JoinRow => ({
      id,
      cell: r.cell,
      cls,
      depends: cls !== "equal" ? r.cell.depends : undefined,
      v3,
      bc: say(b.outcome, b.message),
    });
    if (r.outcome === "refused") return row("v3 refused");
    if (r.outcome !== "pass" && r.outcome !== "fail") return row("v3 not run");
    const [rm, bm] = [normalizeMessage(r.message), normalizeMessage(b.message)];
    if (r.outcome === b.outcome && rm === bm) return row("equal");
    const starts = (o: string, m: string) => o === "fail" && m.startsWith("V:");
    if ((starts(r.outcome, rm) && !intactValue(rm)) || (starts(b.outcome, bm) && !intactValue(bm)))
      return row("transport-trimmed");
    const rv = starts(r.outcome, rm);
    const bv = starts(b.outcome, bm);
    if (rv && bv) return row("different value");
    if (rv !== bv) return row("one errors, one returns");
    return row("different error text");
  });
}

export function joinTsv(rows: readonly JoinRow[]): string {
  return `${rows
    .map((r) =>
      [
        r.id,
        `${r.cell.type} ${r.cell.method} ${r.cell.state}`.trim(),
        r.cls,
        r.depends !== undefined ? `${r.depends}?` : "",
        r.v3,
        r.bc,
      ].join("\t"),
    )
    .join("\n")}\n`;
}

export function joinCounts(rows: readonly JoinRow[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const r of rows) {
    const k = r.depends !== undefined ? `${r.cls} (${r.depends}?)` : r.cls;
    n[k] = (n[k] ?? 0) + 1;
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const joinAt = args.indexOf("--join");
  if (joinAt >= 0) {
    // PR-52: bun scripts/refusal-family.ts --join <v3 report.json> <bc.tsv> [--out <joined.tsv>]
    const [reportPath, bcPath] = [args[joinAt + 1], args[joinAt + 2]];
    if (reportPath === undefined || bcPath === undefined)
      throw new Error(
        "usage: refusal-family.ts --join <v3 report.json> <bc.tsv> [--out <joined.tsv>]",
      );
    const results = JSON.parse(await Bun.file(reportPath).text()) as CellResult[];
    checkReportCells(results);
    const rows = joinCells(results, parseBcTsv(await Bun.file(bcPath).text()));
    const out = opt("--out");
    if (out !== undefined) writeFileSync(out, joinTsv(rows));
    else process.stdout.write(joinTsv(rows));
    console.error(JSON.stringify(joinCounts(rows), null, 2));
    process.exit(0);
  }
  const f = FAMILIES[opt("--family") ?? ""];
  if (f === undefined)
    throw new Error(
      `usage: refusal-family.ts --family ${Object.keys(FAMILIES).join("|")} [--bin <al-runner>] [--out <dir>] [--json <file>] | --emit-bc-check <dir>`,
    );
  const check = opt("--emit-bc-check");
  if (check !== undefined) {
    // PR-17: only the app, under its own BC-check id and name, for a BC run; al-runner is not run
    for (const [file, text] of Object.entries(emitApp(bcCheckFamily(f), bcCheckApp(f)))) {
      mkdirSync(join(check, file, ".."), { recursive: true });
      writeFileSync(join(check, file), text);
    }
    process.exit(0);
  }
  const bin = opt("--bin") ?? "/work/tools/al-runner-v3/current/al-runner";
  const dir = opt("--out") ?? mkdtempSync(join(tmpdir(), "refusal-family-"));
  for (const [file, text] of Object.entries(emitApp(f))) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const p = Bun.spawnSync(
    [bin, "test", "--bc-version", "28", ...(f.args ?? []), "--output-json", dir],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ALRUNNER_SEED: "1" },
      timeout: 600_000,
    },
  );
  let j: {
    tests?: { name: string; status: string; message?: string; notRun?: boolean }[];
    compilationErrors?: unknown[];
  };
  try {
    j = JSON.parse(p.stdout.toString());
  } catch (err) {
    throw new Error(
      `al-runner gave no JSON (exit ${p.exitCode}${p.exitedDueToTimeout === true ? ", timed out after 600 s" : ""}): ${String(err)}; stderr: ${p.stderr.toString().slice(-500)}`,
    );
  }
  if ((j.compilationErrors ?? []).length > 0 || !Array.isArray(j.tests) || j.tests.length === 0)
    throw new Error(
      `the generated app did not run (exit ${p.exitCode}): ${JSON.stringify(j.compilationErrors ?? []).slice(0, 2000)}`,
    );
  const results = classify(f, j.tests);
  const n = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(
    `family ${f.name} on ${bin}: ${results.length} cells: pass ${n("pass")}, fail ${n("fail")}, refused ${n("refused")}, missing ${n("missing")} (app in ${dir})`,
  );
  for (const c of refusalClasses(f, results))
    console.log(
      `${c.known ? "known" : "NEW  "} ${c.cells.length} cell(s): ${c.text}\n        ${c.cells.join(", ")}`,
    );
  for (const r of results.filter((x) => x.outcome === "missing" || x.outcome === "timeout"))
    console.log(`${r.outcome.toUpperCase()}: ${r.cell.type}.${r.cell.method} (${r.cell.state})`);
  for (const r of results.filter((x) => x.outcome === "fail"))
    console.log(
      `fail: ${r.cell.type}.${r.cell.method} (${r.cell.state}): ${(r.message ?? "").slice(0, 160)}`,
    );
  const json = opt("--json");
  if (json !== undefined) writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  // A cell with no row means the run did not cover the family: not a result to read.
  if (n("missing") > 0) process.exitCode = 2;
}
