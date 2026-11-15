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
}

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
          setup: ["NavApp.GetCurrentModuleInfo(Me);", ...(type === "Item" ? PUBAPP_ITEM : filters)],
          call: `PermissionsMock.Set('${set}');\n        ${read}`,
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
    return `codeunit ${BASE_ID + 1 + i} "${cellName(c, i)}"
{
    Subtype = Test;

${names.length > 0 ? `    [HandlerFunctions('${names.join(",")}')]\n` : ""}    [Test]
    procedure Cell()
${vars.length > 0 ? `    var\n${vars.map((v) => `        ${v}`).join("\n")}\n` : ""}    begin
${body}
    end;
${handlers.map((h) => `\n${h}`).join("")}}
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
    const r = byName.get(`Codeunit${BASE_ID + 1 + i}.Cell`);
    if (r === undefined) return { cell, outcome: "missing" };
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
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
