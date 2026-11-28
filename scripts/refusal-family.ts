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
 *
 * PR-417, the culture rule: every BC differential so far ran on bc2 or bc4, which are BC on LINUX. A culture-dependent answer
 * (Format, FormatRegion, a report language, dates, decimals, digit grouping, sort order) is Linux ICU data, which Windows BC
 * (NLS) need not share. Each family records where it was measured (`bcMeasured`), and `--join` names its Linux culture cells.
 * Such a cell's difference is recorded as "measured on Linux BC <build>" and is filed upstream only after Windows BC gives the
 * same answer.
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
  /** PR-191: support codeunits after the last cell's id (cell ids end at BASE + cells.length); widens app.json's idRanges. */
  readonly extraIds?: number;
  /**
   * PR-191: extra census readers. Each is an AL Text `expr` (using the `vars` it declares) that keep-census folds into the
   * observation it compares, beside the kit's own state, so state the kit cannot see (a bound subscriber, a SingleInstance
   * global, XML runtime state) shows up as a difference. A family without it is measured exactly as before.
   */
  readonly readers?: readonly {
    readonly name: string;
    readonly vars: readonly string[];
    readonly expr: string;
  }[];
  /** PR-02: the app's `target` when the cells need one (DotNet needs `OnPrem`). */
  readonly target?: "OnPrem";
  /**
   * PR-83: `TestPermissions = Disabled` on every test codeunit, for a family whose cells write tables. On LethAL's web-service
   * path BC runs a test without it under a restrictive default (#8160), so a cell's own Insert is refused before it runs.
   */
  readonly testPermissions?: "Disabled";
  /** PR-17: al-runner arguments the family's run needs (`--no-client`), put before the app. */
  readonly args?: readonly string[];
  /** PR-16: apps the cells call (Microsoft's Permissions Mock), as app.json `dependencies`. */
  readonly dependencies?: readonly {
    readonly id: string;
    readonly name: string;
    readonly publisher: string;
    readonly version: string;
  }[];
  /**
   * PR-417: where the family's BC answers were measured. bc1-bc4 run BC on LINUX, whose culture data (ICU) is not Windows BC's
   * (NLS): see `linuxBcCultureCells`. Recorded for every family with culture cells (a test pins it); the earlier families
   * (PR-17 to PR-33, also measured on bc2) have none and carry no record.
   */
  readonly bcMeasured?: {
    readonly os: "linux" | "windows";
    readonly server: string;
    readonly build: string;
    readonly task: string;
  };
  /**
   * PR-417: "all" when EVERY cell's answer comes from culture data (a FormatRegion, a report language), not only the cells
   * marked `depends: "locale"` (those follow the session's language and region).
   */
  readonly cultureData?: "all";
}

/**
 * PR-417: the cells (0-based) whose BC answer is culture data measured on LINUX BC. Such an answer is recorded as "measured on
 * Linux BC <build>" and is never filed upstream as an al-runner bug unless Windows BC gives it too: #8861, #8862 and #8871 were
 * Linux ICU data, and Windows BC (NLS) matched al-runner.
 */
export function linuxBcCultureCells(f: Family): number[] {
  if (f.bcMeasured?.os !== "linux") return [];
  return f.cells.flatMap((c, i) => (f.cultureData === "all" || c.depends === "locale" ? [i] : []));
}

/** PR-417: the line `--join` prints for a family with Linux culture cells. */
export function linuxBcCultureNote(f: Family, n: number): string {
  const m = f.bcMeasured;
  return `PR-417: ${n} of ${f.cells.length} cells of ${f.name} are culture data measured on Linux BC (${m?.server}, ${m?.build}; ${m?.task}): record each difference there as "measured on Linux BC", and file none upstream unless Windows BC gives the same answer`;
}

/** PR-417: bc2's BC-check runs (PR-52, PR-63, PR-83, PR-86, PR-87), as their results name the server and build. */
const BC2_LINUX = { os: "linux", server: "bc2", build: "BC 28.4 W1, en-US session" } as const;
/** PR-417: bc4's BC-check runs (PR-373, PR-374, PR-375). */
const BC4_LINUX = {
  os: "linux",
  server: "bc4",
  build: "BC 29.0.54011.57673 W1, en-US session",
} as const;
/** PR-488: bc1's BC-check runs with culture cells (numbers-text; errors-temp ran on bc1 too but has none). */
const BC1_LINUX = {
  os: "linux",
  server: "bc1",
  build: "BC 28.4.53241.56590 W1, en-US session",
} as const;

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
  bcMeasured: { ...BC2_LINUX, task: "PR-52, PR-63" },
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
 * PR-93: the refusal texts DO windows t10 and t11 still closed on after PR-74, each driven by an invented cell (no corpus source
 * text; values such as 'GL00000000' and the JSON path are names only). Cell i is codeunit BASE_ID + 1 + i; the support objects
 * share id 51000 as in the other families.
 */
const T10_JSON_VARS = ["SW: DotNet T10StringWriter;", "JW: DotNet T10JsonTextWriter;"];
const T10_JSON_SETUP = ["SW := SW.StringWriter();", "JW := JW.JsonTextWriter(SW);"];
const T10_TO_RECIPIENTS = [
  ...T10_JSON_SETUP,
  "JW.WriteStartObject();",
  "JW.WritePropertyName('message');",
  "JW.WriteStartObject();",
  "JW.WritePropertyName('toRecipients');",
  "JW.WriteStartArray();",
];
const T10_ROW = ['R: Record "T10 Row";'];
export const T10_REFUSALS: Family = {
  name: "t10-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `table 51000 "T10 Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Decimal) { }
        field(3; Count; BigInteger) { }
        field(4; Blob; Blob) { }
        field(5; "Doc Date"; Date) { }
        field(6; Img; Media) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

page 51000 "T10 Page"
{
    PageType = List;
    SourceTable = "T10 Row";
    layout { area(Content) { repeater(Rows) { field(CodeCol; Rec."Code") { } } } }
}

report 51000 "T10 Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "T10 Row") { } }
    requestpage { layout { area(Content) { } } }
}

dotnet
{
    assembly(mscorlib)
    {
        type(System.IO.StringWriter; T10StringWriter) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.JsonTextWriter; T10JsonTextWriter) { }
    }
}
`,
  handles: {},
  cells: [
    t9("Date", "CalcDate", "t10", "D := CalcDate('<+2Y>', DMY2Date(1, 1, 9998));", {
      vars: ["D: Date;"],
    }),
    t9("JsonTextWriter", "WriteEndArray", "t10", "JW.WriteEndArray();", {
      vars: T10_JSON_VARS,
      setup: T10_JSON_SETUP,
    }),
    t9("JsonTextWriter", "WritePropertyName", "state Array", "JW.WritePropertyName('x');", {
      vars: T10_JSON_VARS,
      setup: [...T10_TO_RECIPIENTS, "JW.WriteValue('a');"],
    }),
    t9("JsonTextWriter", "WritePropertyName", "state ArrayStart", "JW.WritePropertyName('x');", {
      vars: T10_JSON_VARS,
      setup: T10_TO_RECIPIENTS,
    }),
    t9("Evaluate", "Lt300", "t10", "if Evaluate(D, '<300') then;", { vars: ["D: Decimal;"] }),
    t9("FieldRef", "EnumValueCount", "never assigned", "N := FR.EnumValueCount();", {
      vars: ["FR: FieldRef;", "N: Integer;"],
    }),
    // a call whose result is dropped (a statement) is the form al-runner refuses; as a value it fails with .NET's own text
    t9("FieldRef", "Value", "never assigned", "FR.Value := 1;", { vars: ["FR: FieldRef;"] }),
    t9("KeyRef", "FieldCount", "never assigned", "KR.FieldCount();", { vars: ["KR: KeyRef;"] }),
    t9("KeyRef", "FieldIndex", "never assigned", "KR.FieldIndex(1);", { vars: ["KR: KeyRef;"] }),
    t9("Page", "Run", "RecordRef", 'Page.Run(Page::"T10 Page", RR);', {
      vars: ["RR: RecordRef;"],
    }),
    t9("Page", "Run", "unassigned Variant", 'Page.Run(Page::"T10 Page", V);', {
      vars: ["V: Variant;"],
    }),
    t9("RecordRef", "FindFirst", "closed", "RR.FindFirst();", { vars: ["RR: RecordRef;"] }),
    t9("RecordRef", "GetFilters", "closed", "RR.GetFilters();", { vars: ["RR: RecordRef;"] }),
    t9("RecordRef", "GetTable", "Text", "RR.GetTable(V);", {
      vars: ["RR: RecordRef;", "V: Variant;"],
      setup: ["V := 'Not a record';"],
    }),
    t9("RecordRef", "KeyIndex", "closed", "RR.KeyIndex(1);", { vars: ["RR: RecordRef;"] }),
    t9("Report", "SaveAs", "id 0", "Report.SaveAs(0, '<a/>', ReportFormat::Xml, OutS);", {
      vars: ["OutS: OutStream;", ...T10_ROW],
      setup: ["R.Blob.CreateOutStream(OutS);"],
    }),
    t9("Filter", "SetFilterBigInt", "GL00000000", "R.SetFilter(Count, 'GL00000000');", {
      vars: T10_ROW,
    }),
    t9("Filter", "SetFilterBigInt", "GU00000001", "R.SetFilter(Count, 'GU00000001');", {
      vars: T10_ROW,
    }),
    t9("Filter", "SetFilterEmptyTerm", "t10", "R.SetFilter(Amount, '|');", { vars: T10_ROW }),
    t9("Filter", "SetFilterDate", "-1M", "R.SetFilter(\"Doc Date\", '-1M');", { vars: T10_ROW }),
    t9("Filter", "SetFilterDate", "-2026-09-01", "R.SetFilter(\"Doc Date\", '-2026-09-01');", {
      vars: T10_ROW,
    }),
    t9("Filter", "SetFilterAngle", "t10", "R.SetFilter(Code, '<-1M>..<CM>');", { vars: T10_ROW }),
    t9("Filter", "SetFilterNotEqual", "t10", "R.SetFilter(Amount, '<>');", { vars: T10_ROW }),
    t9("XmlDocument", "ReadFrom", "not an InStream", "B := XmlDocument.ReadFrom(OutS, XD);", {
      vars: ["OutS: OutStream;", "XD: XmlDocument;", "B: Boolean;"],
    }),
    t9(
      "Report",
      "RunRequestPage",
      "after Commit",
      "T := Report.RunRequestPage(Report::\"T10 Report\", '<a/>');",
      { vars: ["T: Text;"], setup: ["Commit();"] },
    ),
    t9(
      "Report",
      "RunRequestPage",
      "in write transaction",
      "T := Report.RunRequestPage(Report::\"T10 Report\", '<a/>');",
      { vars: ["T: Text;", ...T10_ROW], setup: ["R.Code := 'W1';", "R.Insert();"] },
    ),
    // a Media value is written out to an untouched OutStream: the text names the OutStream
    t9("Media", "ExportStream", "untouched OutStream", "R.Img.ExportStream(OutS);", {
      vars: ["OutS: OutStream;", "InS: InStream;", "IO: OutStream;", ...T10_ROW],
      setup: [
        "R.Blob.CreateOutStream(IO);",
        "IO.WriteText('x');",
        "R.Blob.CreateInStream(InS);",
        "R.Img.ImportStream(InS, 'x');",
      ],
    }),
    t9("Conversion", "FieldRefSetRange", "Code", "RR.Field(3).SetRange(C);", {
      vars: ["RR: RecordRef;", "C: Code[20];"],
      setup: ['RR.Open(Database::"T10 Row");', "C := 'GL00000000';"],
    }),
  ],
};

/**
 * PR-105: the refusal texts DO windows t12 and t13 still closed on after PR-93, each driven by an invented cell (no corpus source
 * text; the JSON path and the filter code are names only). Cell i is codeunit BASE_ID + 1 + i; the support objects share id
 * 51000 as in the other families. Not driven: the SaveAs-with-layout errors and the placeholder Pdf read (they need Base
 * Application's reports) and RunRequestPage (PR-74 review H1, PR-93). Not produced either: "a list without the new-row line
 * that lost its only row to an action" (class 7). Every cell tried (a list page opened by OpenView, a read-only page, a page
 * with InsertAllowed = false) either passed or gave the "a filtered list without the new-row line ..." text, a different one.
 */
const T12_JSON_VARS = ["SW: DotNet T12StringWriter;", "JW: DotNet T12JsonTextWriter;"];
const T12_JSON_SETUP = ["SW := SW.StringWriter();", "JW := JW.JsonTextWriter(SW);"];
const T12_ROW = ['R: Record "T12 Row";'];
const T12_LIST_VARS = ['R: Record "T12 Row";', 'TP: TestPage "T12 List";'];
export const T12_REFUSALS: Family = {
  name: "t12-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `table 51000 "T12 Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Decimal) { }
        field(3; Count; BigInteger) { }
        field(4; Blob; Blob) { }
        field(5; Num; Integer) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

page 51000 "T12 List"
{
    PageType = List;
    SourceTable = "T12 Row";
    layout { area(Content) { repeater(Rows) { field(CodeCol; Rec."Code") { } } } }
    actions
    {
        area(Processing)
        {
            action(TouchOther) { trigger OnAction() begin Rec.Get('B'); Rec.Amount := 7; end; }
        }
    }
}

report 51000 "T12 Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "T12 Row") { } }
    requestpage { layout { area(Content) { } } }
}

dotnet
{
    assembly(mscorlib)
    {
        type(System.IO.StringWriter; T12StringWriter) { }
        type(System.IO.MemoryStream; T12MemoryStream) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.JsonTextWriter; T12JsonTextWriter) { }
    }
}
`,
  handles: {},
  cells: [
    t9("FieldRef", "CalcField", "not a FlowField", "FR.CalcField();", {
      vars: ["RR: RecordRef;", "FR: FieldRef;"],
      setup: ['RR.Open(Database::"T12 Row");', "FR := RR.Field(2);"],
    }),
    t9("Filter", "SetFilterBigInt", "C10000", "R.SetFilter(Count, 'C10000');", { vars: T12_ROW }),
    // the texts are runs of NUL characters (code 0), built in AL: a literal cannot hold one
    ...[6, 5, 4].map((n) =>
      t9("Evaluate", "NulDecimal", `${n} NULs`, "if Evaluate(D, T) then;", {
        vars: ["D: Decimal;", "T: Text;", "Ch: Char;", "I: Integer;"],
        setup: ["Ch := 0;", `for I := 1 to ${n} do T += Format(Ch);`],
      }),
    ),
    t9("Conversion", "TextToBlob", "xml", "RR.Field(4).Value := T;", {
      vars: ["RR: RecordRef;", "T: Text;"],
      setup: [
        'RR.Open(Database::"T12 Row");',
        'T := \'<?xml version="1.0" encoding="utf-8"?><a/>\';',
      ],
    }),
    t9("Page", "Action", "another row in Rec", "TP.TouchOther.Invoke();", {
      vars: T12_LIST_VARS,
      setup: [
        "R.Code := 'A';",
        "R.Insert();",
        "R.Code := 'B';",
        "R.Insert();",
        "TP.OpenView();",
        "TP.GoToKey('A');",
      ],
    }),
    t9("Conversion", "TextToInteger", "=18", "RR.Field(5).SetRange(T);", {
      vars: ["RR: RecordRef;", "T: Text;"],
      setup: ['RR.Open(Database::"T12 Row");', "T := '=18';"],
    }),
    t9("Conversion", "TextToInteger", "1=18", "RR.Field(5).SetRange(T);", {
      vars: ["RR: RecordRef;", "T: Text;"],
      setup: ['RR.Open(Database::"T12 Row");', "T := '1=18';"],
    }),
    t9("CopyStream", "DotNetStream", "untouched handle", "CopyStream(MS, InS);", {
      vars: ["MS: DotNet T12MemoryStream;", "InS: InStream;"],
      setup: ["MS := MS.MemoryStream();"],
    }),
    t9("JsonTextWriter", "WriteStartObject", "state Object", "JW.WriteStartObject();", {
      vars: T12_JSON_VARS,
      setup: [
        ...T12_JSON_SETUP,
        "JW.WriteStartObject();",
        "JW.WritePropertyName('message');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('body');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('ccRecipients');",
        "JW.WriteStartArray();",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('emailAddress');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('address');",
        "JW.WriteValue('a');",
      ],
    }),
    t9(
      "Report",
      "SaveAs",
      "untouched handle",
      "Report.SaveAs(Report::\"T12 Report\", '<a/>', ReportFormat::Xml, OutS);",
      { vars: ["OutS: OutStream;"] },
    ),
  ],
};

/**
 * PR-133: two refusal texts DO's x2 window still closed its serve daemon on, each driven by an invented cell (no corpus source
 * text); the C* text has a second, nested cell. Cell i is codeunit BASE_ID + 1 + i (51001 to 51003); the support objects are
 * table 51000, codeunit 51000 and pages 51000 and 51001, all inside the family's id block (51000 to 51004).
 */
export const X2_REFUSALS: Family = {
  name: "x2-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `table 51000 "X2 Row"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Amount; BigInteger) { }
        field(3; Trig; Integer)
        {
            trigger OnValidate()
            var
                R: Record "X2 Row";
            begin
                R.SetFilter(Amount, 'C*');
                if R.FindFirst() then;
            end;
        }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 51000 "X2 Helper"
{
    [TryFunction]
    procedure ValidateTrig(var R: Record "X2 Row")
    begin
        R.Validate(Trig, 1);
    end;
}

page 51000 "X2 Wizard"
{
    PageType = Card;
    SourceTable = "X2 Row";
    UsageCategory = None;
    layout { area(Content) { field(IdCtl; Rec.Id) { ApplicationArea = All; } } }
    actions
    {
        area(Processing)
        {
            action(Go)
            {
                ApplicationArea = All;
                trigger OnAction()
                var
                    Helper: Codeunit "X2 Helper";
                    Row: Record "X2 Row";
                begin
                    Row.Id := 1;
                    if not Helper.ValidateTrig(Row) then;
                end;
            }
        }
    }
}

page 51001 "X2 Card"
{
    PageType = Card;
    SourceTable = "X2 Row";
    UsageCategory = None;
    layout { area(Content) { field(IdCtl; Rec.Id) { ApplicationArea = All; } } }
    actions
    {
        area(Processing)
        {
            action(OpenWizard)
            {
                ApplicationArea = All;
                trigger OnAction()
                begin
                    Page.RunModal(Page::"X2 Wizard");
                end;
            }
        }
    }
}
`,
  handles: {},
  cells: [
    t9(
      "Filter",
      "SetFilterBigIntWildcard",
      "C*",
      "R.SetFilter(Amount, 'C*'); if R.FindFirst() then;",
      {
        vars: ['R: Record "X2 Row";'],
      },
    ),
    t9("RecordRef", "GetTable", "Integer 123", "RR.GetTable(V);", {
      vars: ["RR: RecordRef;", "V: Variant;"],
      setup: ["V := 123;"],
    }),
    // PR-133 amendment 1: the C* text reached as DO reaches it: a card TestPage action runs a wizard with Page.RunModal,
    // a modal handler invokes the wizard's action, which calls a [TryFunction] that validates a field whose OnValidate
    // runs the SetFilter. The refusal must unwind through all of it.
    t9("Page", "NestedValidate", "C*", "TP.OpenWizard.Invoke();", {
      vars: ['R: Record "X2 Row";', 'TP: TestPage "X2 Card";'],
      setup: ["R.Id := 1;", "R.Insert();", "TP.OpenView();"],
      handlers: [
        '    [ModalPageHandler]\n    procedure WizHandler(var W: TestPage "X2 Wizard")\n    begin\n        W.Go.Invoke();\n    end;\n',
      ],
    }),
  ],
};

/**
 * PR-139: the NUL-run Evaluate text at the widths DO's x3 window closed on (3, 10, 12, 14, 30, 37, 40), each driven by an
 * invented cell: the plain shape, a bare array-element Evaluate, a TryFunction, a nested TestPage/modal/TryFunction/OnValidate
 * chain (as X2's NestedValidate) and an OnInsert trigger after writes to a SingleInstance Dictionary. Amendment 1 appends the
 * widths 7, 9, 11, 13, 16, 21, 25 and 27 (the other NUL widths in M28736's DO requests). Every cell must give
 * "Evaluate of `<N NULs>` into Decimal (form not pinned by the corpus)". Cell i is codeunit BASE_ID + 1 + i (51001 to 51019);
 * support codeunits 51000 and 51020, tables 51000 and 51001, pages 51000 and 51001 (the id block is 51000 to 51020).
 */
const X3_VARS = ["T: Text;", "Ch: Char;", "I: Integer;"];
const x3Nul = (n: number): string[] => ["Ch := 0;", `for I := 1 to ${n} do T += Format(Ch);`];
const X3_NUL_BODY = `        T := '';
        Ch := 0;
        for I := 1 to 10 do T += Format(Ch);`;
export const X3_REFUSALS: Family = {
  name: "x3-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `table 51000 "X3 Row"
{
    fields
    {
        field(1; Id; Integer) { }
        field(3; Trig; Integer)
        {
            trigger OnValidate()
            var
                T: Text;
                Ch: Char;
                I: Integer;
                V: Integer;
            begin
${X3_NUL_BODY}
                if not Evaluate(V, T) then;
            end;
        }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

table 51001 "X3 Ins"
{
    fields { field(1; Id; Integer) { } }
    keys { key(PK; Id) { Clustered = true; } }

    trigger OnInsert()
    var
        T: Text;
        Ch: Char;
        I: Integer;
        V: Integer;
    begin
${X3_NUL_BODY}
        if not Evaluate(V, T) then;
    end;
}

codeunit 51000 "X3 Helper"
{
    [TryFunction]
    procedure ValidateTrig(var R: Record "X3 Row")
    begin
        R.Validate(Trig, 1);
    end;

    [TryFunction]
    procedure EvalBare()
    var
        T: Text;
        Ch: Char;
        I: Integer;
        V: Integer;
    begin
${X3_NUL_BODY}
        Evaluate(V, T);
    end;
}

codeunit 51020 "X3 Cache"
{
    SingleInstance = true;

    var
        Seen: Dictionary of [Text, Integer];

    procedure Put(K: Text; V: Integer)
    begin
        Seen.Set(K, V);
    end;
}

page 51000 "X3 Wizard"
{
    PageType = Card;
    SourceTable = "X3 Row";
    UsageCategory = None;
    layout { area(Content) { field(IdCtl; Rec.Id) { ApplicationArea = All; } } }
    actions
    {
        area(Processing)
        {
            action(Go)
            {
                ApplicationArea = All;
                trigger OnAction()
                var
                    Helper: Codeunit "X3 Helper";
                    Row: Record "X3 Row";
                begin
                    Row.Id := 1;
                    if not Helper.ValidateTrig(Row) then;
                end;
            }
        }
    }
}

page 51001 "X3 Card"
{
    PageType = Card;
    SourceTable = "X3 Row";
    UsageCategory = None;
    layout { area(Content) { field(IdCtl; Rec.Id) { ApplicationArea = All; } } }
    actions
    {
        area(Processing)
        {
            action(OpenWizard)
            {
                ApplicationArea = All;
                trigger OnAction()
                begin
                    Page.RunModal(Page::"X3 Wizard");
                end;
            }
        }
    }
}
`,
  handles: {},
  cells: [
    ...[3, 10, 12, 14, 30, 37, 40].map((n) =>
      t9("Evaluate", "NulInteger", `${n} NULs`, "if not Evaluate(V, T) then;", {
        vars: ["V: Integer;", ...X3_VARS],
        setup: x3Nul(n),
      }),
    ),
    t9("Evaluate", "NulIntArray", "10 NULs", "Evaluate(A[1], T);", {
      vars: ["A: array[3] of Integer;", ...X3_VARS],
      setup: x3Nul(10),
    }),
    t9("Evaluate", "NulTryFunction", "10 NULs", "if not Helper.EvalBare() then;", {
      vars: ['Helper: Codeunit "X3 Helper";'],
    }),
    t9("Page", "NestedEvaluate", "10 NULs", "TP.OpenWizard.Invoke();", {
      vars: ['R: Record "X3 Row";', 'TP: TestPage "X3 Card";'],
      setup: ["R.Id := 1;", "R.Insert();", "TP.OpenView();"],
      handlers: [
        '    [ModalPageHandler]\n    procedure WizHandler(var W: TestPage "X3 Wizard")\n    begin\n        W.Go.Invoke();\n    end;\n',
      ],
    }),
    t9("Evaluate", "NulOnInsert", "10 NULs", "R.Insert(true);", {
      vars: ['R: Record "X3 Ins";', 'Cache: Codeunit "X3 Cache";'],
      setup: ["Cache.Put('a', 1);", "R.Id := 1;"],
    }),
    // amendment 1: the other NUL widths M28736's DO requests hold (7, 9, 11, 13, 16, 21, 25, 27), appended so C0-C10 keep
    // their codeunit ids
    ...[7, 9, 11, 13, 16, 21, 25, 27].map((n) =>
      t9("Evaluate", "NulInteger", `${n} NULs`, "if not Evaluate(V, T) then;", {
        vars: ["V: Integer;", ...X3_VARS],
        setup: x3Nul(n),
      }),
    ),
  ],
};

/**
 * PR-159: the two sibling texts DO's y1 window still closed on, each driven by an invented cell (no corpus source text):
 * `RecordRef.GetTable of Integer 12345` plainly and through a procedure that first checks `IsRecord` (the remove-not mutant
 * of DO's guard), and the JSON writer's WriteStartObject at path `message.body.toRecipients[0].emailAddress`. Cell i is
 * codeunit BASE_ID + 1 + i (51001 to 51003); the support codeunit is 51000 (the family's id block is 51000 to 51003).
 */
export const Y1_REFUSALS: Family = {
  name: "y1-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  target: "OnPrem",
  known: [],
  support: `codeunit 51000 "Y1 Helper"
{
    procedure GetLog(VariantRecord: Variant)
    var
        RecRef: RecordRef;
    begin
        if VariantRecord.IsRecord then
            exit;
        RecRef.GetTable(VariantRecord);
    end;
}

dotnet
{
    assembly(mscorlib)
    {
        type(System.IO.StringWriter; Y1StringWriter) { }
    }
    assembly(Newtonsoft.Json)
    {
        type(Newtonsoft.Json.JsonTextWriter; Y1JsonTextWriter) { }
    }
}
`,
  handles: {},
  cells: [
    t9("RecordRef", "GetTable", "Integer 12345", "RR.GetTable(V);", {
      vars: ["RR: RecordRef;", "V: Variant;"],
      setup: ["V := 12345;"],
    }),
    t9("RecordRef", "GetTableGuarded", "Integer 12345", "Helper.GetLog(V);", {
      vars: ['Helper: Codeunit "Y1 Helper";', "V: Variant;"],
      setup: ["V := 12345;"],
    }),
    t9("JsonTextWriter", "WriteStartObject", "state Object", "JW.WriteStartObject();", {
      vars: ["SW: DotNet Y1StringWriter;", "JW: DotNet Y1JsonTextWriter;"],
      setup: [
        "SW := SW.StringWriter();",
        "JW := JW.JsonTextWriter(SW);",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('message');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('body');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('toRecipients');",
        "JW.WriteStartArray();",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('emailAddress');",
        "JW.WriteStartObject();",
        "JW.WritePropertyName('address');",
        "JW.WriteValue('a');",
      ],
    }),
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
  bcMeasured: { ...BC2_LINUX, task: "PR-83" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues",
  known: [],
  support: RF_SUPPORT,
  handles: {},
  cells: RF_CELLS,
  // bc2 run 1 was void: RF Seed's Insert was refused under BC's restrictive test default (lethal-bugs, PR-83)
  testPermissions: "Disabled",
};

/**
 * PR-86: date formulas and date/time arithmetic. No tables: every cell works on invented dates and reports `V:[...]`, dates
 * through Format(x, 0, 9) (locale-free). Cells that print a local DateTime are marked `tz`; DateFormula text cells `locale`.
 * The WorkDate cells set WorkDate first, so none assumes a session default.
 */
const dfc = (
  type: string,
  method: string,
  state: string,
  vars: string[],
  setup: string[],
  answer: string,
  depends?: Cell["depends"],
): Cell => ({
  type,
  method,
  state,
  vars,
  setup,
  call: `Error('V:[%1]', ${answer});`,
  ...withDepends(depends),
});
const cdCell = (formula: string, label: string, base: string): Cell =>
  dfc("CalcDate", formula, label, [], [], n9(`CalcDate(${al(formula)}, ${base})`));
const D15 = dt(15, 3, 2024); // a Friday
const CD_FORMULAS = [
  "<1D>",
  "<-1D>",
  "<1W>",
  "<-1W>",
  "<1M>",
  "<-1M>",
  "<1Q>",
  "<-1Q>",
  "<1Y>",
  "<-1Y>",
  "<CD>",
  "<CW>",
  "<CM>",
  "<CQ>",
  "<CY>",
  "<-CM>",
  "<-CY>",
  "<CM+1D>",
  "<-CM-1M>",
  "<CM-1D>",
  "<CQ+1D>",
  "<-CQ-1D>",
  "<CY+1D>",
  "<1M+1D>",
  "<1M-1D>",
  "<-1M+1D>",
  "<1Y+1M+1D>",
  "<-1Y-1M-1D>",
  "<12M>",
  "<100D>",
  "<0D>",
  "<WD1>",
  "<WD2>",
  "<WD4>",
  "<WD5>",
  "<WD7>",
  "<+1W-WD1>",
  "<-1W+WD1>",
  "<CW-WD7>",
  "<1M-WD1>",
  "<-WD1>",
  "1M",
  "<1m>",
  "<cm>",
];
const CD_EDGES: readonly (readonly [string, string, readonly string[]])[] = [
  ["31 Jan 2024", dt(31, 1, 2024), ["<1M>", "<-1M>", "<CM>", "<1Y>", "<1M-1D>", "<2M>"]],
  [
    "29 Feb 2024",
    dt(29, 2, 2024),
    ["<1Y>", "<-1Y>", "<1M>", "<CM>", "<CY>", "<4Y>", "<-4Y>", "<1D>"],
  ],
  ["30 Mar 2024", dt(30, 3, 2024), ["<-1M>", "<1M>", "<-1M-1M>"]],
  ["31 Mar 2024", dt(31, 3, 2024), ["<-1M>", "<1M>"]],
  ["31 May 2024", dt(31, 5, 2024), ["<1M>", "<-3M>"]],
  ["31 Dec 2024", dt(31, 12, 2024), ["<1D>", "<CM+1D>", "<1Y>", "<CW>"]],
  ["1 Jan 2024", dt(1, 1, 2024), ["<-1D>", "<-1M>", "<-CM-1D>", "<CW>"]],
  ["28 Feb 2100", dt(28, 2, 2100), ["<1D>", "<1Y>", "<CM>"]],
  ["28 Feb 2000", dt(28, 2, 2000), ["<1D>", "<1Y>", "<CM>"]],
  ["29 Feb 2000", dt(29, 2, 2000), ["<1Y>", "<-1Y>", "<100Y>"]],
  ["31 Dec 9999", dt(31, 12, 9999), ["<1D>", "<-1D>", "<CY>"]],
  [
    "closing date of 2023",
    "ClosingDate(DMY2Date(31, 12, 2023))",
    ["<1D>", "<-1D>", "<CM>", "<CY>", "<0D>"],
  ],
  ["closing date of 2024-02-29", "ClosingDate(DMY2Date(29, 2, 2024))", ["<CM>", "<1D>"]],
  ["0D", "0D", ["<0D>"]],
];
const DF_EVAL_TEXTS = [
  "1M",
  "<1M>",
  "1D",
  "-1D",
  "CM",
  "<CM>",
  "1W",
  "CM+1D",
  "-CM-1M",
  "WD1",
  "1Y",
  "1Q",
  "0D",
  "",
  "abc",
  "1X",
  "<1M",
  "1M>",
  "1 M",
  "1d",
  "cm",
  "<-1Y+2M>",
  "100D",
  "++1D",
  "D",
];
const DF_FORMATS = ["1M", "-1D", "CM+1D", "WD1", "1Y+1M+1D", ""];
const DF_VARS = ["DF: DateFormula;", "Ok: Boolean;"];
const dfEval = (text: string, n: boolean): Cell =>
  dfc(
    "DateFormula",
    n ? "Evaluate 9" : "Evaluate",
    text === "" ? "empty" : text,
    DF_VARS,
    ["Evaluate(DF, '<1Y>');"],
    `${n9(`Evaluate(DF, ${al(text)}${n ? ", 9" : ""})`)} + '|' + Format(DF, 0, 9)`,
    n ? undefined : "locale",
  );
const DWY_DATES: readonly (readonly [string, string])[] = [
  ["31 Dec 2024", dt(31, 12, 2024)],
  ["1 Jan 2021", dt(1, 1, 2021)],
  ["29 Dec 2025", dt(29, 12, 2025)],
  ["1 Jan 2024", dt(1, 1, 2024)],
  ["0D", "0D"],
];
const DOUBLE_DT = "CreateDateTime(DMY2Date(14, 3, 2024), 230000T)";
const dtCell = (method: string, state: string, setup: string[], answer: string, tz = false): Cell =>
  dfc(
    "DateTime",
    method,
    state,
    ["A: DateTime;", "B: DateTime;", "Dur: Duration;", "T: Time;", "D: Date;"],
    setup,
    answer,
    tz ? "tz" : undefined,
  );
const tmCell = (method: string, state: string, setup: string[], answer: string): Cell =>
  dfc(
    "Time",
    method,
    state,
    ["T: Time;", "U: Time;", "Dur: Duration;", "I: Integer;"],
    setup,
    answer,
  );
const wdCell = (
  method: string,
  state: string,
  setup: string[],
  answer: string,
  depends?: Cell["depends"],
): Cell =>
  dfc(
    "WorkDate",
    method,
    state,
    ["DF: DateFormula;"],
    [`WorkDate(${D15});`, ...setup],
    answer,
    depends,
  );
const clCell = (method: string, state: string, setup: string[], answer: string): Cell =>
  dfc("ClosingDate", method, state, ["D: Date;", "E: Date;"], setup, answer);
/** Two-test language cell: the setter sets the language; the reader sets it too (so a build that does not carry it still measures it). */
const dfLang = (
  code: number,
  method: string,
  state: string,
  vars: string[],
  setup: string[],
  answer: string,
): Cell => ({
  type: `Lang${code}`,
  method,
  state,
  call: `GlobalLanguage(${code});`,
  reader: {
    vars,
    setup: [`GlobalLanguage(${code});`, ...setup],
    call: `Error('V:[%1|%2]', ${n9("GlobalLanguage()")}, ${answer});`,
  },
  depends: "locale",
});
const LANG_FORMULAS: Readonly<Record<number, readonly string[]>> = {
  1030: ["1D", "1U", "1W", "1M", "1K", "1Q", "1Å", "1Y", "NU", "CW", "AM"],
  1031: ["1T", "1D", "1W", "1M", "1J", "1Y", "1Q", "AJ", "CW"],
};
const langCells = (code: number): Cell[] => [
  ...(LANG_FORMULAS[code] ?? []).map((t) =>
    dfLang(
      code,
      "Evaluate",
      t,
      DF_VARS,
      ["Evaluate(DF, '<1Y>');", `Ok := Evaluate(DF, ${al(t)});`],
      `${n9("Ok")} + '|' + Format(DF, 0, 9) + '|' + Format(DF)`,
    ),
  ),
  ...["1M", "-1D", "CM+1D", "1Y+1M+1D", "-CW", "WD1"].map((t) =>
    dfLang(code, "Format", t, ["DF: DateFormula;"], [`Evaluate(DF, ${al(t)}, 9);`], "Format(DF)"),
  ),
  ...(code === 1030 ? ["<1U>", "<1K>", "<1Å>", "<1D>"] : ["<1T>", "<1J>", "<1W>", "<1D>"]).map(
    (t) => dfLang(code, "CalcDate text", t, [], [], n9(`CalcDate(${al(t)}, ${D15})`)),
  ),
];

const DATES_CELLS: Cell[] = [
  ...CD_FORMULAS.map((f) => cdCell(f, "15 Mar 2024", D15)),
  ...CD_EDGES.flatMap(([label, base, fs]) => fs.map((f) => cdCell(f, label, base))),
  dfc(
    "CalcDate",
    "DateFormula variable",
    "1M+1D",
    ["DF: DateFormula;"],
    ["Evaluate(DF, '1M+1D');"],
    n9(`CalcDate(DF, ${D15})`),
    "locale",
  ),
  dfc(
    "CalcDate",
    "DateFormula variable",
    "empty",
    ["DF: DateFormula;"],
    [],
    n9(`CalcDate(DF, ${D15})`),
  ),
  dfc("CalcDate", "invalid formula", "<1X>", [], [], n9(`CalcDate('<1X>', ${D15})`)),
  dfc("CalcDate", "invalid formula", "empty text", [], [], n9(`CalcDate('', ${D15})`)),
  dfc("CalcDate", "invalid formula", "<>", [], [], n9(`CalcDate('<>', ${D15})`)),
  ...DF_EVAL_TEXTS.map((t) => dfEval(t, false)),
  ...["1M", "<1M>", "CM", "abc", ""].map((t) => dfEval(t, true)),
  ...DF_FORMATS.flatMap((t) => [
    dfc(
      "DateFormula",
      "Format",
      t === "" ? "empty" : t,
      DF_VARS,
      [`Ok := Evaluate(DF, ${al(t)});`],
      "Format(DF)",
      "locale",
    ),
    dfc(
      "DateFormula",
      "Format 0,9",
      t === "" ? "empty" : t,
      DF_VARS,
      [`Ok := Evaluate(DF, ${al(t)});`],
      "Format(DF, 0, 9)",
      "locale", // the setup's Evaluate reads letters in the session language
    ),
  ]),
  dfc(
    "DateFormula",
    "Format len4",
    "1Y+1M+1D",
    DF_VARS,
    ["Ok := Evaluate(DF, '1Y+1M+1D');"],
    "Format(DF, 4)",
    "locale",
  ),
  dfc(
    "DateFormula",
    "Format len20",
    "1M",
    DF_VARS,
    ["Ok := Evaluate(DF, '1M');"],
    "Format(DF, 20)",
    "locale",
  ),
  ...(
    [
      ["first of the year", 1, 1, 2024],
      ["last of the year", 31, 12, 2024],
      ["leap day", 29, 2, 2024],
      ["non-leap 29 Feb", 29, 2, 2023],
      ["day 0", 0, 1, 2024],
      ["day 32", 32, 1, 2024],
      ["31 April", 31, 4, 2024],
      ["month 13", 1, 13, 2024],
      ["month 0", 1, 0, 2024],
      ["year 1753", 1, 1, 1753],
      ["year 1752", 31, 12, 1752],
      ["year 9999", 31, 12, 9999],
      ["year 10000", 1, 1, 10000],
      ["year 0", 1, 1, 0],
      ["2100 not leap", 29, 2, 2100],
      ["2000 leap", 29, 2, 2000],
      ["negative day", -1, 1, 2024],
    ] as const
  ).map(([s, d, m, y]) => dfc("DMY2Date", "DMY2Date", s, [], [], n9(`DMY2Date(${d}, ${m}, ${y})`))),
  ...DWY_DATES.flatMap(([label, d]) =>
    [1, 2, 3].map((p) => dfc("Date2DMY", `part ${p}`, label, [], [], n9(`Date2DMY(${d}, ${p})`))),
  ),
  dfc("Date2DMY", "part 4", "15 Mar 2024", [], [], n9(`Date2DMY(${D15}, 4)`)),
  dfc("Date2DMY", "part 0", "15 Mar 2024", [], [], n9(`Date2DMY(${D15}, 0)`)),
  ...DWY_DATES.flatMap(([label, d]) =>
    [1, 2, 3].map((p) => dfc("Date2DWY", `part ${p}`, label, [], [], n9(`Date2DWY(${d}, ${p})`))),
  ),
  dfc("Date2DWY", "part 4", "15 Mar 2024", [], [], n9(`Date2DWY(${D15}, 4)`)),
  ...(
    [
      ["Monday week 1 of 2025", 1, 1, 2025],
      ["week 53 of 2020", 1, 53, 2020],
      ["week 53 of 2021 (has 52)", 1, 53, 2021],
      ["week 53 of 2026", 3, 53, 2026],
      ["Sunday week 52 of 2024", 7, 52, 2024],
      ["week 0", 1, 0, 2024],
      ["day 8", 8, 1, 2024],
      ["day 0", 0, 1, 2024],
      ["week 54", 1, 54, 2024],
      ["Friday week 1 of 2021", 5, 1, 2021],
      ["week 1 of 1753", 1, 1, 1753],
      ["week 52 of 2025", 1, 52, 2025],
      ["Monday week 1 of 2026", 1, 1, 2026],
      ["Monday week 1 of 2024", 1, 1, 2024],
    ] as const
  ).map(([s, a, b, c]) => dfc("DWY2Date", "DWY2Date", s, [], [], n9(`DWY2Date(${a}, ${b}, ${c})`))),
  dfc(
    "Date",
    "difference",
    "two days",
    ["D: Date;", "E: Date;"],
    [`D := ${dt(17, 3, 2024)};`, `E := ${D15};`],
    n9("D - E"),
  ),
  dfc(
    "Date",
    "difference",
    "negative",
    ["D: Date;", "E: Date;"],
    [`D := ${D15};`, `E := ${dt(17, 3, 2024)};`],
    n9("D - E"),
  ),
  dfc(
    "Date",
    "difference",
    "across a leap day",
    ["D: Date;", "E: Date;"],
    [`D := ${dt(1, 3, 2024)};`, `E := ${dt(28, 2, 2024)};`],
    n9("D - E"),
  ),
  dtCell(
    "Duration",
    "across midnight",
    [`A := ${DOUBLE_DT};`, "B := CreateDateTime(DMY2Date(15, 3, 2024), 010000T);", "Dur := B - A;"],
    n9("Dur"),
  ),
  dtCell(
    "Duration",
    "same day",
    [
      `A := CreateDateTime(${D15}, 080000T);`,
      `B := CreateDateTime(${D15}, 163000T);`,
      "Dur := B - A;",
    ],
    n9("Dur"),
  ),
  dtCell(
    "Duration",
    "negative",
    [
      `A := CreateDateTime(${D15}, 163000T);`,
      `B := CreateDateTime(${D15}, 080000T);`,
      "Dur := B - A;",
    ],
    n9("Dur"),
  ),
  dtCell("Duration", "zero", [`A := CreateDateTime(${D15}, 080000T);`, "Dur := A - A;"], n9("Dur")),
  dtCell(
    "Duration",
    "over a leap day",
    [
      `A := CreateDateTime(${dt(28, 2, 2024)}, 120000T);`,
      `B := CreateDateTime(${dt(1, 3, 2024)}, 120000T);`,
      "Dur := B - A;",
    ],
    n9("Dur"),
  ),
  dtCell(
    "Duration",
    "with milliseconds",
    [
      `A := CreateDateTime(${D15}, 120000.000T);`,
      `B := CreateDateTime(${D15}, 120000.250T);`,
      "Dur := B - A;",
    ],
    n9("Dur"),
  ),
  dtCell(
    "Duration",
    "one day in ms",
    [
      `A := CreateDateTime(${D15}, 120000T);`,
      `B := CreateDateTime(${dt(16, 3, 2024)}, 120000T);`,
      "Dur := B - A;",
    ],
    n9("Dur"),
  ),
  dtCell("Duration", "compare", ["Dur := 3600000;"], n9("Dur = 3600000")),
  dtCell("Duration", "compare less", ["Dur := 3600000;"], n9("Dur < 7200000")),
  dtCell("DT2Date", "evening", [`A := ${DOUBLE_DT};`], n9("DT2Date(A)")),
  dtCell("DT2Time", "evening", [`A := ${DOUBLE_DT};`], n9("DT2Time(A)")),
  dtCell("DT2Date", "midnight time", [`A := CreateDateTime(${D15}, 000000T);`], n9("DT2Date(A)")),
  dtCell("DT2Time", "midnight time", [`A := CreateDateTime(${D15}, 000000T);`], n9("DT2Time(A)")),
  dtCell("DT2Date", "0DT", ["A := 0DT;"], n9("DT2Date(A)")),
  dtCell("DT2Time", "0DT", ["A := 0DT;"], n9("DT2Time(A)")),
  dtCell("CreateDateTime", "0D and 0T", ["A := CreateDateTime(0D, 0T);"], n9("A = 0DT")),
  dtCell("CreateDateTime", "date and 0T", [`A := CreateDateTime(${D15}, 0T);`], n9("DT2Time(A)")),
  dtCell("CreateDateTime", "0D and a time", ["A := CreateDateTime(0D, 120000T);"], n9("A = 0DT")),
  dtCell(
    "CreateDateTime",
    "date and 235959.999",
    [`A := CreateDateTime(${D15}, 235959.999T);`],
    n9("DT2Time(A)"),
  ),
  dtCell("CreateDateTime", "Format 9 evening", [`A := ${DOUBLE_DT};`], n9("A"), true),
  dtCell(
    "CreateDateTime",
    "Format 9 midnight",
    [`A := CreateDateTime(${D15}, 0T);`],
    n9("A"),
    true,
  ),
  dtCell("CreateDateTime", "Format 9 0DT", ["A := 0DT;"], n9("A")),
  dtCell(
    "DateTime plus",
    "one hour",
    [`A := ${DOUBLE_DT};`, "A := A + 3600000;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime plus",
    "two hours across midnight",
    [`A := ${DOUBLE_DT};`, "A := A + 7200000;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime plus",
    "one day",
    [`A := ${DOUBLE_DT};`, "A := A + 86400000;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime plus",
    "minus one ms",
    [`A := CreateDateTime(${D15}, 0T);`, "A := A - 1;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime plus",
    "0DT plus one hour",
    ["A := 0DT;", "A := A + 3600000;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime plus",
    "Duration variable",
    [`A := ${DOUBLE_DT};`, "Dur := 5400000;", "A := A + Dur;"],
    `${n9("DT2Date(A)")} + '|' + ${n9("DT2Time(A)")}`,
  ),
  dtCell(
    "DateTime compare",
    "earlier is less",
    [`A := ${DOUBLE_DT};`, `B := CreateDateTime(${D15}, 0T);`],
    n9("A < B"),
  ),
  dtCell("DateTime compare", "equal", [`A := ${DOUBLE_DT};`, `B := ${DOUBLE_DT};`], n9("A = B")),
  dtCell("DateTime compare", "0DT is least", [`A := ${DOUBLE_DT};`, "B := 0DT;"], n9("B < A")),
  tmCell("Time plus", "noon plus one hour", ["T := 120000T;", "T := T + 3600000;"], n9("T")),
  tmCell("Time plus", "23:59:59 plus 1000 ms", ["T := 235959T;", "T := T + 1000;"], n9("T")),
  tmCell("Time plus", "23:59:59 plus 2000 ms", ["T := 235959T;", "T := T + 2000;"], n9("T")),
  tmCell("Time plus", "23:59:59.999 plus 1 ms", ["T := 235959.999T;", "T := T + 1;"], n9("T")),
  tmCell("Time plus", "midnight minus 1 ms", ["T := 000000T;", "T := T - 1;"], n9("T")),
  tmCell("Time plus", "noon minus 13 hours", ["T := 120000T;", "T := T - 46800000;"], n9("T")),
  tmCell("Time plus", "noon plus 25 hours", ["T := 120000T;", "T := T + 90000000;"], n9("T")),
  tmCell("Time plus", "0T plus one hour", ["T := 0T;", "T := T + 3600000;"], n9("T")),
  tmCell(
    "Time plus",
    "noon plus Duration",
    ["T := 120000T;", "Dur := 1800000;", "T := T + Dur;"],
    n9("T"),
  ),
  tmCell(
    "Time minus",
    "Time minus Time",
    ["T := 150000T;", "U := 120000T;", "Dur := T - U;"],
    n9("Dur"),
  ),
  tmCell(
    "Time minus",
    "earlier minus later",
    ["T := 120000T;", "U := 150000T;", "Dur := T - U;"],
    n9("Dur"),
  ),
  tmCell("Time compare", "less", ["T := 120000T;", "U := 150000T;"], n9("T < U")),
  tmCell("Time compare", "equal", ["T := 120000T;", "U := 120000T;"], n9("T = U")),
  tmCell("Time compare", "0T is least", ["T := 0T;", "U := 000001T;"], n9("T < U")),
  tmCell("Time", "milliseconds kept", ["T := 120000.123T;"], n9("T")),
  tmCell("Time", "Format 9 of 0T", ["T := 0T;"], n9("T")),
  clCell("ClosingDate", "Format 9", ["D := ClosingDate(DMY2Date(31, 12, 2023));"], n9("D")),
  clCell(
    "ClosingDate",
    "NormalDate Format 9",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("NormalDate(D)"),
  ),
  clCell(
    "ClosingDate",
    "NormalDate of normal date",
    ["D := DMY2Date(31, 12, 2023);"],
    n9("NormalDate(D)"),
  ),
  clCell("ClosingDate", "NormalDate of 0D", ["D := 0D;"], n9("NormalDate(D)")),
  clCell("ClosingDate", "ClosingDate of 0D", ["D := ClosingDate(0D);"], n9("D")),
  clCell(
    "ClosingDate",
    "of a mid-year date",
    ["D := ClosingDate(DMY2Date(15, 3, 2024));"],
    n9("NormalDate(D)"),
  ),
  clCell(
    "ClosingDate",
    "twice",
    ["D := ClosingDate(ClosingDate(DMY2Date(31, 12, 2023)));"],
    n9("NormalDate(D)"),
  ),
  clCell(
    "ClosingDate",
    "equals its normal date",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(31, 12, 2023);"],
    n9("D = E"),
  ),
  clCell(
    "ClosingDate",
    "greater than its normal date",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(31, 12, 2023);"],
    n9("D > E"),
  ),
  clCell(
    "ClosingDate",
    "less than its normal date",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(31, 12, 2023);"],
    n9("D < E"),
  ),
  clCell(
    "ClosingDate",
    "less than next day",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(1, 1, 2024);"],
    n9("D < E"),
  ),
  clCell(
    "ClosingDate",
    "greater than day before",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(30, 12, 2023);"],
    n9("D > E"),
  ),
  clCell(
    "ClosingDate",
    "two closing dates",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := ClosingDate(DMY2Date(31, 12, 2024));"],
    n9("D < E"),
  ),
  clCell(
    "ClosingDate",
    "equal closing dates",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("D = E"),
  ),
  clCell(
    "ClosingDate",
    "closing date of next year vs 31 Dec",
    ["D := ClosingDate(DMY2Date(31, 12, 2024));", "E := DMY2Date(31, 12, 2024);"],
    n9("D > E"),
  ),
  clCell(
    "ClosingDate",
    "against 0D",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := 0D;"],
    n9("D > E"),
  ),
  clCell(
    "ClosingDate",
    "Date2DMY day",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("Date2DMY(D, 1)"),
  ),
  clCell(
    "ClosingDate",
    "Date2DMY year",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("Date2DMY(D, 3)"),
  ),
  clCell(
    "ClosingDate",
    "Date2DWY week",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("Date2DWY(D, 2)"),
  ),
  clCell(
    "ClosingDate",
    "CalcDate plus a day",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("CalcDate('<1D>', D)"),
  ),
  clCell(
    "ClosingDate",
    "CalcDate current year",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("CalcDate('<CY>', D)"),
  ),
  clCell(
    "ClosingDate",
    "difference",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));", "E := DMY2Date(31, 12, 2023);"],
    n9("D - E"),
  ),
  clCell(
    "ClosingDate",
    "equals its own normal date again",
    ["D := ClosingDate(DMY2Date(31, 12, 2023));"],
    n9("D = NormalDate(D)"),
  ),
  wdCell("WorkDate", "read back", [], n9("WorkDate()")),
  wdCell("WorkDate", "set twice", [`WorkDate(${dt(1, 1, 2025)});`], n9("WorkDate()")),
  wdCell("WorkDate", "set to 0D", ["WorkDate(0D);"], n9("WorkDate() = 0D")),
  wdCell("CalcDate", "0D base plus a day", [], n9("CalcDate('<1D>', 0D)")),
  wdCell("CalcDate", "0D base current month", [], n9("CalcDate('<CM>', 0D)")),
  wdCell("CalcDate", "0D base Monday", [], n9("CalcDate('<-WD1>', 0D)")),
  wdCell("CalcDate", "WorkDate base plus a month", [], n9("CalcDate('<1M>', WorkDate())")),
  wdCell("CalcDate", "WorkDate base current year", [], n9("CalcDate('<CY>', WorkDate())")),
  wdCell(
    "CalcDate",
    "after a second WorkDate",
    [`WorkDate(${dt(31, 1, 2024)});`],
    n9("CalcDate('<1M>', WorkDate())"),
  ),
  wdCell(
    "CalcDate",
    "0D base after a second WorkDate",
    [`WorkDate(${dt(31, 1, 2024)});`],
    n9("CalcDate('<1M>', 0D)"),
  ),
  wdCell(
    "CalcDate",
    "DateFormula variable on 0D",
    ["Evaluate(DF, '1W');"],
    n9("CalcDate(DF, 0D)"),
    "locale",
  ),
  wdCell("Date2DMY", "of WorkDate", [], n9("Date2DMY(WorkDate(), 1)")),
  wdCell("Date2DWY", "week of WorkDate", [], n9("Date2DWY(WorkDate(), 2)")),
  wdCell(
    "WorkDate",
    "ClosingDate as WorkDate",
    ["WorkDate(ClosingDate(DMY2Date(31, 12, 2023)));"],
    n9("NormalDate(WorkDate())"),
  ),
  wdCell("WorkDate", "year 1753", [`WorkDate(${dt(1, 1, 1753)});`], n9("WorkDate()")),
  ...[1030, 1031].flatMap(langCells),
];

export const DATES_FORMULAS: Family = {
  name: "dates-formulas",
  bcMeasured: { ...BC2_LINUX, task: "PR-86" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues",
  known: [],
  support: "",
  handles: {},
  cells: DATES_CELLS,
  // as record-filters: BC's restrictive default would refuse a table write; this family writes none, but the option is the family's from the start
  testPermissions: "Disabled",
};

/**
 * PR-87: JSON objects, arrays, tokens and values; TextBuilder; text functions and text comparison on Danish letters.
 * No tables. Every cell reports `V:[...]`; an error the call raises IS the answer. A cell whose text holds a non-ASCII
 * letter, every TextCompare cell, and AsDate/AsTime/AsDecimal of JSON text are marked `locale` (case mapping, text
 * order and text conversion follow the session language and region). Two pairs of cells have the same AL (Keys count /
 * Keys count DOC; less a vs B / ordered a before B): they were measured so, and cell ids are positions, so they stay. `FORMAT_EVALUATE` already has the
 * ASCII text-function cells and `äöüßé` case mapping, so these use other inputs. AsDateTime cells are `tz`.
 */
const NON_ASCII = /[^ -~]/;
const jx = (
  type: string,
  method: string,
  state: string,
  vars: string[],
  setup: string[],
  answer: string,
  depends?: Cell["depends"],
): Cell => {
  const c = dfc(type, method, state, vars, setup, answer, depends);
  // every text compare is culture-ordered on BC ('a' < 'B' is true), ASCII or not
  return depends === undefined &&
    (type === "TextCompare" || NON_ASCII.test([...vars, ...setup, answer].join(" ")))
    ? { ...c, depends: "locale" }
    : c;
};
const JO_VARS = ["O: JsonObject;", "P: JsonObject;", "T: JsonToken;", "Ok: Boolean;", "S: Text;"];
const JO_DOC =
  '{"a":1,"b":"x","c":null,"d":{"e":[10,20,{"f":"deep"}],"g h":7},"a b":5,"arr":[[1,2],[3]]}';
const joc = (
  method: string,
  state: string,
  json: string,
  stmts: string[],
  answer: string,
  type = "JsonObject",
): Cell => jx(type, method, state, JO_VARS, [`Ok := O.ReadFrom(${al(json)});`, ...stmts], answer);
const JO_WT = "O.WriteTo(S);";
/** Gets the token at `path` of O and writes it. */
const tokenOf = (path: string) => `Ok := O.SelectToken(${al(path)}, T); if Ok then T.WriteTo(S);`;
const OK_S = `${n9("Ok")} + '|' + S`;
const keyLabel = (k: string) => `key ${k === "" ? "empty" : k.replace(/ /g, "_")}`;
const JO_ADDS: readonly (readonly [string, string])[] = [
  ["new text", "O.Add('k', 'v');"],
  ["new integer", "O.Add('k', 5);"],
  ["new decimal 1.50", "O.Add('k', 1.50);"],
  ["new boolean", "O.Add('k', true);"],
  ["new date", `O.Add('k', ${dt(15, 3, 2024)});`],
  ["text with quote", `O.Add('k', 'x"y');`],
  ["empty key", "O.Add('', 1);"],
  ["key aeoeaa", "O.Add('æøå', 1);"],
  ["existing key", "O.Add('a', 2);"],
  ["existing key other case", "O.Add('A', 2);"],
  ["same key twice", "O.Add('k', 1); O.Add('k', 2);"],
  ["object value", `P.ReadFrom('{"x":1}'); O.Add('k', P);`],
];
const JO_PATHS: readonly (readonly [string, string])[] = [
  ["plain key", "a"],
  ["dollar dot key", "$.a"],
  ["nested", "d.e"],
  ["array index 0", "d.e[0]"],
  ["array then key", "d.e[2].f"],
  ["index past end", "d.e[3]"],
  ["negative index", "d.e[-1]"],
  ["quoted key in brackets", "['a']"],
  ["quoted key with space", "['a b']"],
  ["dollar quoted key", "$['a b']"],
  ["nested quoted key", "d['g h']"],
  ["double quoted key", 'd["g h"]'],
  ["array of arrays", "arr[1][0]"],
  ["missing key", "x"],
  ["into a value", "a.b"],
  ["null value", "c"],
  ["dollar only", "$"],
  ["empty path", ""],
  ["wildcard", "d.e[*]"],
  ["recursive", "$..f"],
  ["key case differs", "A"],
];
const JV_VARS = ["O: JsonObject;", "T: JsonToken;", "Ok: Boolean;"];
const JV_CONV = [
  "AsInteger",
  "AsDecimal",
  "AsBigInteger",
  "AsBoolean",
  "AsText",
  "AsCode",
  "AsDate",
  "AsTime",
  "AsDateTime",
];
const JV_ALL = ["1.50", "1e3", '"12"', '"abc"', "null"];
const JV_SOME: readonly (readonly [string, readonly string[]])[] = [
  ["true", ["AsBoolean", "AsInteger", "AsText"]],
  ['"2024-03-15"', ["AsDate", "AsDateTime", "AsText"]],
  ['"10:20:30"', ["AsTime", "AsDate", "AsText"]],
  ["-0", ["AsInteger", "AsDecimal", "AsText"]],
  ["12345678901234567890", ["AsInteger", "AsBigInteger", "AsDecimal", "AsText"]],
  ['"2024-03-15T10:20:30Z"', ["AsDateTime", "AsDate", "AsText"]],
  ['"true"', ["AsBoolean", "AsText"]],
  ['""', ["AsInteger", "AsText", "AsBoolean", "AsDate"]],
  ['"æøå"', ["AsText", "AsCode", "AsInteger"]],
  ['{"a":1}', ["AsText"]],
  ["[1]", ["AsText"]],
];
const jvSetup = (lit: string) => [
  `Ok := O.ReadFrom(${al(`{"v":${lit}}`)});`,
  "Ok := O.Get('v', T);",
];
const jvCell = (lit: string, conv: string): Cell =>
  jx(
    "JsonValue",
    conv,
    lit.replace(/"/g, "'"),
    JV_VARS,
    jvSetup(lit),
    n9(`T.AsValue().${conv}()`),
    conv === "AsDateTime"
      ? "tz"
      : conv === "AsDate" || conv === "AsTime" || (conv === "AsDecimal" && lit.startsWith('"'))
        ? "locale" // text read as a date, time or decimal follows the region
        : undefined,
  );
const JT_OBJECT: readonly (readonly [string, string])[] = [
  ["spaces around", '{ "a" : 1 }'],
  ["unicode escape", '{"a":"\\u00e6\\u00f8"}'],
  ["literal aeoeaa", '{"a":"æøå"}'],
  ["escaped quote", '{"a":"x\\"y"}'],
  ["escaped backslash", '{"a":"x\\\\y"}'],
  ["escaped newline", '{"a":"x\\ny"}'],
  ["number 1e3", '{"a":1e3}'],
  ["number minus zero", '{"a":-0}'],
  ["number 1.50", '{"a":1.50}'],
  ["number very large", '{"a":123456789012345678901234567890}'],
  ["number many digits", '{"a":0.1234567890123456789}'],
  ["number overflow", '{"a":1e400}'],
  ["number leading zero", '{"a":007}'],
  ["number NaN", '{"a":NaN}'],
  ["duplicate keys", '{"a":1,"a":2}'],
  ["empty object", "{}"],
  ["null value", '{"a":null}'],
  ["empty text", ""],
  ["missing close", '{"a":1'],
  ["unquoted key", "{a:1}"],
  ["trailing comma", '{"a":1,}'],
  ["top-level array", "[1,2]"],
  ["top-level text", '"s"'],
  ["trailing garbage", "{} x"],
];
const JT_ARRAY: readonly (readonly [string, string])[] = [
  ["array plain", "[1,2]"],
  ["array trailing comma", "[1,]"],
  ["array of objects", '[{"a":1},{"b":2}]'],
  ["array from object text", '{"a":1}'],
  ["array empty text", ""],
  ["array nested", "[[1],[2,[3]]]"],
];
const JT_TOKEN: readonly (readonly [string, string])[] = [
  ["token number", "1.50"],
  ["token text", '"s"'],
  ["token true", "true"],
  ["token null", "null"],
  ["token object", '{"a":1}'],
  ["token array", "[1]"],
  ["token empty", ""],
  ["token bare word", "abc"],
  ["token escaped text", '"x\\u00e6y"'],
];
const JA_VARS = ["A: JsonArray;", "B: JsonArray;", "T: JsonToken;", "Ok: Boolean;", "S: Text;"];
const jac = (
  method: string,
  state: string,
  stmts: string[],
  answer: string,
  json = '[10,20,30,"x"]',
): Cell =>
  jx("JsonArray", method, state, JA_VARS, [`Ok := A.ReadFrom(${al(json)});`, ...stmts], answer);
const JA_WT = "A.WriteTo(S);";
const JA_GET = "if Ok then T.WriteTo(S);";
const flags = `${n9("T.IsValue()")} + ${n9("T.IsObject()")} + ${n9("T.IsArray()")}`;

const TB_VARS = ["TB: TextBuilder;", "CR: Char;", "LF: Char;", "S: Text;"];
const TB_INIT = "CR := 13; LF := 10;";
/** Shows CR and LF as `\r` and `\n`, so the answer is one line. */
const vis = (e: string) => `${e}.Replace(Format(CR), '\\r').Replace(Format(LF), '\\n')`;
const tbc = (method: string, state: string, stmts: string[], answer: string): Cell =>
  jx("TextBuilder", method, state, TB_VARS, [TB_INIT, ...stmts], answer);
const TB_TEXT = vis("TB.ToText()");
const tbBase = "TB.Append('abcdef');";

/** A text-function cell: the name is the type and the label is the method. */
const tfc = (
  type: string,
  label: string,
  expr: string,
  vars: string[] = [],
  setup: string[] = [],
  text = true,
): Cell => jx(type, label, "", vars, setup, text ? expr : n9(expr));
const sIs = (v: string) => [`S := ${al(v)};`];
const DK = "æøåÆØÅ";

const TC_PAIRS: readonly (readonly [string, string, string])[] = [
  ["a vs A", "a", "A"],
  ["ae letter vs capital", "æ", "Æ"],
  ["e vs e acute", "e", "é"],
  ["A ring vs AA", "Å", "AA"],
  ["a ring vs aa", "å", "aa"],
  ["a vs B", "a", "B"],
  ["z vs ae letter", "z", "æ"],
  ["o slash vs a ring", "ø", "å"],
  ["a vs a space", "a", "a "],
];
const TC_OPS: readonly (readonly [string, string])[] = [
  ["equals", "="],
  ["less", "<"],
  ["greater", ">"],
];
const tcCell = (method: string, state: string, a: string, b: string, e: string): Cell =>
  jx(
    "TextCompare",
    method,
    state,
    ["X: Text;", "Y: Text;"],
    [`X := ${al(a)};`, `Y := ${al(b)};`],
    n9(e),
  );

const JSON_TEXT_CELLS: Cell[] = [
  // JsonObject
  ...JO_ADDS.map(([s, st]) => joc("Add", s, "{}", [st, JO_WT], "S")),
  joc("Replace", "existing key", '{"a":1}', ["O.Replace('a', 'new');", JO_WT], "S"),
  joc("Replace", "missing key", '{"a":1}', ["O.Replace('zz', 1);", JO_WT], "S"),
  joc("Replace", "to object", '{"a":1}', ["P.ReadFrom('{}'); O.Replace('a', P);", JO_WT], "S"),
  joc("Replace", "to boolean", '{"a":1}', ["O.Replace('a', false);", JO_WT], "S"),
  joc("Replace", "key case differs", '{"a":1}', ["O.Replace('A', 2);", JO_WT], "S"),
  ...(
    [
      ["existing", "a"],
      ["missing", "zz"],
      ["case differs", "A"],
      ["key with space", "a b"],
      ["null valued", "c"],
    ] as const
  ).map(([s, k]) =>
    joc("Remove", s, '{"a":1,"c":null,"a b":2}', [`Ok := O.Remove(${al(k)});`, JO_WT], OK_S),
  ),
  joc("Remove", "twice", '{"a":1}', ["O.Remove('a'); Ok := O.Remove('a');", JO_WT], OK_S),
  ...["a", "c", "d", "a b", "zz", "A"].map((k) =>
    joc(
      "Get",
      keyLabel(k),
      JO_DOC,
      [`Ok := O.Get(${al(k)}, T); if Ok then begin T.WriteTo(S); S := S + '|' + ${flags}; end;`],
      OK_S,
    ),
  ),
  ...["a", "a b", "A", "zz", "", "æ"].map((k) =>
    joc("Contains", keyLabel(k), JO_DOC, [], n9(`O.Contains(${al(k)})`)),
  ),
  joc("Keys", "count", JO_DOC, [], n9("O.Keys().Count()")),
  joc("Keys", "first", JO_DOC, [], "O.Keys().Get(1)"),
  joc("Keys", "last", JO_DOC, [], "O.Keys().Get(6)"),
  joc("Keys", "past end", JO_DOC, [], "O.Keys().Get(7)"),
  joc("Keys", "insertion order", "{}", ["O.Add('z', 1); O.Add('a', 2);"], "O.Keys().Get(1)"),
  joc("Keys", "duplicate keys", '{"a":1,"a":2}', [], n9("O.Keys().Count()")),
  joc("Keys", "empty object", "{}", [], n9("O.Keys().Count()")),
  // JsonObject has no Count: the key count is Keys().Count()
  joc("Keys count", "DOC", JO_DOC, [], n9("O.Keys().Count()")),
  joc("Keys count", "after add", "{}", ["O.Add('k', 1);"], n9("O.Keys().Count()")),
  joc("Keys count", "after remove", '{"a":1}', ["O.Remove('a');"], n9("O.Keys().Count()")),
  joc("Keys count", "after replace", '{"a":1}', ["O.Replace('a', 2);"], n9("O.Keys().Count()")),
  joc(
    "Clone",
    "add object then change it",
    "{}",
    [`P.ReadFrom('{"x":1}'); O.Add('q', P); P.Add('y', 2);`, JO_WT],
    "S",
  ),
  joc(
    "Clone",
    "add clone then change original",
    "{}",
    [`P.ReadFrom('{"x":1}'); O.Add('q', P.Clone()); P.Add('y', 2);`, JO_WT],
    "S",
  ),
  joc("Clone", "assign then change", '{"a":1}', ["P := O; P.Add('b', 2);", JO_WT], "S"),
  joc(
    "Clone",
    "clone then change",
    '{"a":1}',
    ["P := O.Clone().AsObject(); P.Add('b', 2);", JO_WT],
    "S",
  ),
  joc(
    "Clone",
    "AsToken then change",
    '{"a":1}',
    ["T := O.AsToken(); T.AsObject().Add('b', 2);", JO_WT],
    "S",
  ),
  joc(
    "Clone",
    "get nested then change",
    '{"d":{"x":1}}',
    ["O.Get('d', T); T.AsObject().Add('y', 2);", JO_WT],
    "S",
  ),
  // SelectToken on an object
  ...JO_PATHS.map(([s, p]) => joc("SelectToken", s, JO_DOC, [tokenOf(p)], OK_S)),
  ...(
    [
      ["path of nested array item", "d.e[2].f"],
      ["path of quoted key", "['a b']"],
      ["path of array of arrays", "arr[1][0]"],
    ] as const
  ).map(([s, p]) =>
    joc(
      "SelectToken Path",
      s,
      JO_DOC,
      [`Ok := O.SelectToken(${al(p)}, T); if Ok then S := T.Path();`],
      OK_S,
    ),
  ),
  // JsonToken
  ...(
    [
      ["number", "a"],
      ["text", "b"],
      ["null", "c"],
      ["object", "d"],
      ["array", "d.e"],
      ["object in array", "d.e[2]"],
    ] as const
  ).map(([s, p]) =>
    joc(
      "kind flags",
      s,
      JO_DOC,
      [`Ok := O.SelectToken(${al(p)}, T); if Ok then S := ${flags};`],
      OK_S,
      "JsonToken",
    ),
  ),
  ...(
    [
      ["AsObject on array", "d.e", "T.AsObject().WriteTo(S);"],
      ["AsArray on object", "d", "T.AsArray().WriteTo(S);"],
      ["AsValue on object", "d", "S := T.AsValue().AsText();"],
      ["AsObject on number", "a", "T.AsObject().WriteTo(S);"],
      ["AsValue on array", "d.e", "S := T.AsValue().AsText();"],
      ["AsArray on null", "c", "T.AsArray().WriteTo(S);"],
    ] as const
  ).map(([s, p, st]) =>
    joc("mismatch", s, JO_DOC, [`Ok := O.SelectToken(${al(p)}, T); ${st}`], OK_S, "JsonToken"),
  ),
  joc(
    "Clone",
    "clone token then change",
    '{"d":{"x":1}}',
    ["O.Get('d', T); T.Clone().AsObject().Add('y', 2); O.WriteTo(S);"],
    "S",
    "JsonToken",
  ),
  joc("Path", "root", '{"a":1}', ["T := O.AsToken(); S := T.Path();"], "S", "JsonToken"),
  // JsonValue conversions
  ...JV_ALL.flatMap((lit) => JV_CONV.map((conv) => jvCell(lit, conv))),
  ...JV_SOME.flatMap(([lit, convs]) => convs.map((conv) => jvCell(lit, conv))),
  ...JV_ALL.slice(2, 7).map((lit) =>
    jx(
      "JsonValue",
      "IsNull",
      lit.replace(/"/g, "'"),
      JV_VARS,
      jvSetup(lit),
      n9("T.AsValue().IsNull()"),
    ),
  ),
  ...(
    [
      ["SetValueToNull then IsNull", "V.SetValueToNull();", n9("V.IsNull()")],
      ["SetValueToNull then AsText", "V.SetValueToNull();", "V.AsText()"],
      ["SetValue text then AsInteger", "V.SetValue('12');", n9("V.AsInteger()")],
      ["SetValue integer then AsText", "V.SetValue(12);", "V.AsText()"],
      ["SetValue decimal then AsText", "V.SetValue(1.50);", "V.AsText()"],
      ["SetValue boolean then AsInteger", "V.SetValue(true);", n9("V.AsInteger()")],
      ["SetValue text then AsBoolean", "V.SetValue('true');", n9("V.AsBoolean()")],
      ["SetValue date then AsText", `V.SetValue(${dt(15, 3, 2024)});`, n9("V.AsText()")],
      ["fresh value IsNull", "", n9("V.IsNull()")],
      ["fresh value IsUndefined", "", n9("V.IsUndefined()")],
      ["fresh value AsText", "", "V.AsText()"],
    ] as const
  ).map(([s, st, a]) => jx("JsonValue", "SetValue", s, ["V: JsonValue;"], [st], a)),
  // ReadFrom / WriteTo
  ...JT_OBJECT.map(([s, t]) =>
    joc("ReadFrom object", s, t, [`if Ok then ${JO_WT}`], OK_S, "JsonText"),
  ),
  ...JT_ARRAY.map(([s, t]) =>
    jx(
      "JsonText",
      "ReadFrom array",
      s,
      JA_VARS,
      [`Ok := A.ReadFrom(${al(t)});`, `if Ok then ${JA_WT}`],
      OK_S,
    ),
  ),
  ...JT_TOKEN.map(([s, t]) =>
    jx(
      "JsonText",
      "ReadFrom token",
      s,
      JA_VARS,
      [`Ok := T.ReadFrom(${al(t)});`, "if Ok then T.WriteTo(S);"],
      OK_S,
    ),
  ),
  // JsonArray
  ...(
    [
      ["text", "A.Add('v');"],
      ["integer", "A.Add(5);"],
      ["decimal 1.50", "A.Add(1.50);"],
      ["boolean", "A.Add(false);"],
      ["array value", "B.ReadFrom('[1]'); A.Add(B);"],
      ["same array into itself", "A.Add(A);"],
    ] as const
  ).map(([s, st]) => jac("Add", s, [st, JA_WT], "S")),
  ...[0, 1, 4, 5, -1].map((i) => jac("Insert", `index ${i}`, [`A.Insert(${i}, 99);`, JA_WT], "S")),
  ...[0, 3, 4, -1].map((i) => jac("Set", `index ${i}`, [`A.Set(${i}, 99);`, JA_WT], "S")),
  ...[0, 3, 4, -1].map((i) => jac("RemoveAt", `index ${i}`, [`A.RemoveAt(${i});`, JA_WT], "S")),
  ...(
    [
      ["integer 20", "20"],
      ["text x", "'x'"],
      ["missing 99", "99"],
      ["text 20", "'20'"],
      ["decimal 20.0", "20.0"],
      ["first", "10"],
    ] as const
  ).map(([s, v]) => jac("IndexOf", s, [], n9(`A.IndexOf(${v})`))),
  ...[0, 1, 3, 4, -1].map((i) =>
    jac("Get", `index ${i}`, [`Ok := A.Get(${i}, T); ${JA_GET}`], OK_S),
  ),
  jac("Count", "four items", [], n9("A.Count()")),
  jac("Count", "empty", [], n9("A.Count()"), "[]"),
  jac("Clone", "clone then change", ["B := A.Clone().AsArray(); B.Add(1);", JA_WT], "S"),
  jac("Clone", "assign then change", ["B := A; B.Add(1);", JA_WT], "S"),
  jac("Clone", "add array then change it", ["B.ReadFrom('[1]'); A.Add(B); B.Add(2);", JA_WT], "S"),
  jac("Clone", "AsToken then change", ["T := A.AsToken(); T.AsArray().Add(5);", JA_WT], "S"),
  jac(
    "SelectToken",
    "index",
    [`Ok := A.SelectToken('[1].a', T); ${JA_GET}`],
    OK_S,
    '[{"a":1},{"a":2}]',
  ),
  jac(
    "SelectToken",
    "dollar index",
    [`Ok := A.SelectToken('$[0]', T); ${JA_GET}`],
    OK_S,
    "[[1,2],[3]]",
  ),
  jac("SelectToken", "index past end", [`Ok := A.SelectToken('[5]', T); ${JA_GET}`], OK_S, "[1]"),
  jac("SelectToken", "key on array", [`Ok := A.SelectToken('a', T); ${JA_GET}`], OK_S, "[1]"),
  // TextBuilder
  tbc("Append", "once", [tbBase], TB_TEXT),
  tbc("Append", "twice", [tbBase, "TB.Append('gh');"], TB_TEXT),
  tbc("Append", "empty", [tbBase, "TB.Append('');"], TB_TEXT),
  tbc("Append", "letters", ["TB.Append('æøå');"], TB_TEXT),
  tbc(
    "Append",
    "line break char",
    ["TB.Append('a'); TB.Append(Format(CR)); TB.Append(Format(LF)); TB.Append('b');"],
    TB_TEXT,
  ),
  tbc("AppendLine", "empty", ["TB.AppendLine();"], TB_TEXT),
  tbc("AppendLine", "text", ["TB.AppendLine('x');"], TB_TEXT),
  tbc("AppendLine", "twice", ["TB.AppendLine('x'); TB.AppendLine('y');"], TB_TEXT),
  tbc(
    "AppendLine",
    "after Append",
    ["TB.Append('a'); TB.AppendLine('b'); TB.Append('c');"],
    TB_TEXT,
  ),
  tbc("AppendLine", "length", ["TB.AppendLine('x');"], n9("TB.Length()")),
  ...[0, 1, 3, 6, 7, -1].map((i) =>
    tbc("Insert", `index ${i}`, [tbBase, `TB.Insert(${i}, 'XY');`], TB_TEXT),
  ),
  tbc("Insert", "empty text", [tbBase, "TB.Insert(2, '');"], TB_TEXT),
  tbc("Replace", "one letter", [tbBase, "TB.Replace('b', 'X');"], TB_TEXT),
  tbc("Replace", "not found", [tbBase, "TB.Replace('z', 'X');"], TB_TEXT),
  tbc("Replace", "to empty", [tbBase, "TB.Replace('b', '');"], TB_TEXT),
  tbc("Replace", "empty old", [tbBase, "TB.Replace('', 'X');"], TB_TEXT),
  tbc("Replace", "all matches", ["TB.Append('abab'); TB.Replace('a', 'XX');"], TB_TEXT),
  tbc("Replace", "case differs", [tbBase, "TB.Replace('B', 'X');"], TB_TEXT),
  ...(
    [
      [0, 1],
      [1, 2],
      [2, 0],
      [5, 1],
      [6, 1],
      [-1, 1],
      [0, 9],
      [3, -1],
    ] as const
  ).map(([s, n]) =>
    tbc("Remove", `start ${s} length ${n}`, [tbBase, `TB.Remove(${s}, ${n});`], TB_TEXT),
  ),
  tbc("Length", "empty", [], n9("TB.Length()")),
  tbc("Length", "after append", [tbBase], n9("TB.Length()")),
  tbc("Length", "letters", ["TB.Append('æøå');"], n9("TB.Length()")),
  tbc("Length", "after clear", [tbBase, "TB.Clear();"], n9("TB.Length()")),
  tbc("Capacity", "empty", [], n9("TB.Capacity()")),
  tbc("Capacity", "after append", [tbBase], n9("TB.Capacity()")),
  tbc("EnsureCapacity", "100", [], n9("TB.EnsureCapacity(100)")),
  tbc("EnsureCapacity", "0", [], n9("TB.EnsureCapacity(0)")),
  tbc("EnsureCapacity", "negative", [], n9("TB.EnsureCapacity(-1)")),
  tbc("EnsureCapacity", "then Capacity", ["TB.EnsureCapacity(100);"], n9("TB.Capacity()")),
  tbc("MaxCapacity", "default", [], n9("TB.MaxCapacity()")),
  ...(
    [
      [0, 2],
      [1, 2],
      [3, 0],
      [2, 9],
      [-1, 1],
      [9, 1],
      [0, 6],
      [6, 0],
      [5, 1],
    ] as const
  ).map(([s, n]) => tbc("ToText", `start ${s} count ${n}`, [tbBase], vis(`TB.ToText(${s}, ${n})`))),
  tbc("ToText", "empty", [], vis("TB.ToText()")),
  // text functions on Danish letters
  tfc("UpperCase", "Danish lower", `UpperCase(${al(DK.slice(0, 3))})`),
  tfc("UpperCase", "mixed", "UpperCase('Blåbærgrød')"),
  tfc("UpperCase", "e acute", "UpperCase('é')"),
  tfc("UpperCase", "y diaeresis", "UpperCase('ÿ')"),
  tfc("LowerCase", "Danish upper", `LowerCase(${al(DK.slice(3))})`),
  tfc("LowerCase", "A ring first", "LowerCase('Ålborg')"),
  tfc("LowerCase", "E acute", "LowerCase('É')"),
  tfc("ToUpper", "Danish lower", "S.ToUpper()", ["S: Text;"], sIs(DK.slice(0, 3))),
  tfc("ToLower", "Danish upper", "S.ToLower()", ["S: Text;"], sIs(DK.slice(3))),
  tfc("StrPos", "A ring found", "StrPos('Blåbær', 'å')", [], [], false),
  tfc("StrPos", "ae found", "StrPos('Blåbær', 'æ')", [], [], false),
  tfc("StrPos", "case differs", "StrPos('æøå', 'Å')", [], [], false),
  tfc("StrPos", "aa vs a ring", "StrPos('Århus', 'aa')", [], [], false),
  tfc("StrPos", "ae vs ae letter", "StrPos('æ', 'ae')", [], [], false),
  tfc("IncStr", "a ring nine", "IncStr('å9')"),
  tfc("IncStr", "ae 99", "IncStr('æ99')"),
  tfc("IncStr", "letter only", "IncStr('ø')"),
  tfc("IncStr", "digit then letter", "IncStr('1å')"),
  tfc("PadStr", "pad", "PadStr('æøå', 6)"),
  tfc("PadStr", "pad with letter", "PadStr('æøå', 6, 'ø')"),
  tfc("PadStr", "cut", "PadStr('æøå', 2)"),
  tfc("PadStr", "two letter filler", "PadStr('æøå', 6, 'åæ')"),
  tfc("ConvertStr", "to ASCII", "ConvertStr('bærgrød', 'æø', 'ae')"),
  tfc("ConvertStr", "capitals", "ConvertStr('ÆØÅ', 'ÆØÅ', 'AOA')"),
  tfc("ConvertStr", "to letter", "ConvertStr('aeoeaa', 'a', 'å')"),
  tfc("ConvertStr", "case differs", "ConvertStr('æ', 'Æ', 'x')"),
  ...["<", ">", "="].map((w) => tfc("DelChr", `where ${w} ae`, `DelChr('ææxææ', '${w}', 'æ')`)),
  tfc("DelChr", "several letters", "DelChr('åæøåæø', '=', 'æå')"),
  tfc("DelChr", "case differs", "DelChr('Ææ', '=', 'æ')"),
  tfc("SelectStr", "second", "SelectStr(2, 'æ,ø,å')"),
  tfc("SelectStr", "third", "SelectStr(3, 'æ,ø,å')"),
  tfc("SelectStr", "long first", "SelectStr(1, 'æøå,ab')"),
  tfc("SelectStr", "no comma", "SelectStr(2, 'æ;ø')"),
  tfc("CopyStr", "middle", "CopyStr('æøåÆØÅ', 2, 3)"),
  tfc("CopyStr", "to end", "CopyStr('æøåÆØÅ', 5)"),
  tfc("CopyStr", "last", "CopyStr('æøåÆØÅ', 6, 1)"),
  tfc("CopyStr", "past end", "CopyStr('æøåÆØÅ', 7)"),
  tfc("StrLen", "Danish", "StrLen('æøå')", [], [], false),
  tfc("StrLen", "Japanese", "StrLen('日本語')", [], [], false),
  tfc("StrLen", "emoji", "StrLen('😀')", [], [], false),
  tfc("StrLen", "e plus combining accent", "StrLen('é')", [], [], false),
  tfc("StrLen", "e acute", "StrLen('é')", [], [], false),
  tfc("Text[5]", "StrLen fits", "StrLen(C)", ["C: Text[5];"], ["C := 'æøåÆØ';"], false),
  tfc("Text[5]", "MaxStrLen", "MaxStrLen(C)", ["C: Text[5];"], ["C := 'æø';"], false),
  tfc("Text[5]", "too long", "StrLen(C)", ["C: Text[5];"], ["C := 'æøåÆØÅ';"], false),
  tfc("Code[5]", "StrLen fits", "StrLen(C)", ["C: Code[5];"], ["C := 'æøå';"], false),
  tfc("Code[5]", "assigned value", "C", ["C: Code[5];"], ["C := 'æøå';"]),
  tfc("Code[5]", "MaxStrLen", "MaxStrLen(C)", ["C: Code[5];"], ["C := 'æ';"], false),
  tfc("Code[5]", "too long", "C", ["C: Code[5];"], ["C := 'æøåÆØÅ';"]),
  tfc("Code[5]", "lower e acute", "C", ["C: Code[5];"], ["C := 'é';"]),
  tfc("Contains", "letter found", "S.Contains('å')", ["S: Text;"], sIs("Blåbærgrød"), false),
  tfc("Contains", "capital differs", "S.Contains('Å')", ["S: Text;"], sIs("Blåbærgrød"), false),
  tfc("StartsWith", "capital", "S.StartsWith('Æ')", ["S: Text;"], sIs("æøå"), false),
  tfc("StartsWith", "same case", "S.StartsWith('æ')", ["S: Text;"], sIs("æøå"), false),
  tfc("EndsWith", "capital", "S.EndsWith('Å')", ["S: Text;"], sIs("æøå"), false),
  tfc("EndsWith", "same case", "S.EndsWith('å')", ["S: Text;"], sIs("æøå"), false),
  tfc("IndexOf", "o slash", "S.IndexOf('ø')", ["S: Text;"], sIs("Blåbærgrød"), false),
  tfc("IndexOf", "capital", "S.IndexOf('Ø')", ["S: Text;"], sIs("Blåbærgrød"), false),
  tfc("LastIndexOf", "o slash", "S.LastIndexOf('ø')", ["S: Text;"], sIs("grødgrød"), false),
  tfc("LastIndexOf", "not found", "S.LastIndexOf('x')", ["S: Text;"], sIs("grødgrød"), false),
  tfc("Split", "on a ring count", "S.Split('å').Count()", ["S: Text;"], sIs("åaåbå"), false),
  tfc("Split", "on ae first", "S.Split('æ').Get(1)", ["S: Text;"], sIs("xæyæz")),
  tfc("Trim", "no-break space", "S.Trim()", ["S: Text;"], sIs(" æ ")),
  tfc("PadLeft", "letter filler", "S.PadLeft(5, 'å')", ["S: Text;"], sIs("æ")),
  tfc("Replace", "ae letter", "S.Replace('æ', 'ae')", ["S: Text;"], sIs("bærgrød")),
  tfc("Replace", "capital differs", "S.Replace('Æ', 'ae')", ["S: Text;"], sIs("bærgrød")),
  tfc("Substring", "middle", "S.Substring(2, 3)", ["S: Text;"], sIs(DK)),
  // text comparison
  ...TC_PAIRS.flatMap(([s, a, b]) => TC_OPS.map(([m, op]) => tcCell(m, s, a, b, `X ${op} Y`))),
  ...(
    [
      ["Code vs Text same letters", "abc", "abc"],
      ["Code vs Text upper", "abc", "ABC"],
      ["Code ae letter vs capital", "æ", "Æ"],
      ["Code a ring vs aa", "å", "AA"],
    ] as const
  ).map(([s, a, b]) =>
    jx(
      "TextCompare",
      "Code equals Text",
      s,
      ["Cd: Code[10];", "Tx: Text;"],
      [`Cd := ${al(a)};`, `Tx := ${al(b)};`],
      n9("Cd = Tx"),
    ),
  ),
  ...(
    [
      ["Code less Text", "<"],
      ["Code greater Text", ">"],
    ] as const
  ).map(([m, op]) =>
    jx(
      "TextCompare",
      m,
      "ae letter vs z",
      ["Cd: Code[10];", "Tx: Text;"],
      ["Cd := 'æ';", "Tx := 'z';"],
      n9(`Cd ${op} Tx`),
    ),
  ),
  ...(
    [
      ["ae letter", "æ", "Æ"],
      ["e acute", "é", "É"],
      ["a ring vs aa", "å", "AA"],
    ] as const
  ).map(([s, a, b]) => tcCell("lowercased equal", s, a, b, "X.ToLower() = Y.ToLower()")),
  tcCell("ordered", "a before B", "a", "B", "X < Y"),
];

export const JSON_TEXT: Family = {
  name: "json-text",
  bcMeasured: { ...BC2_LINUX, task: "PR-87" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues",
  known: [],
  support: "",
  handles: {},
  cells: JSON_TEXT_CELLS,
  // as dates-formulas: no table write, but the option is the family's from the start
  testPermissions: "Disabled",
};

/**
 * PR-191: the XML refusal texts DO's y2 window closed on, each driven by an invented cell (no corpus source text). A
 * non-SingleInstance wrapper codeunit (51000) holds a global XmlNode; the cells call it through 2 to 4 procedures. The deep
 * cells (depth 6, two codeunits) bind a manual subscriber and set a SingleInstance codeunit first. Cell i is codeunit
 * BASE_ID + 1 + i (51001 to 51021); the support codeunits are 51000 and 51022 to 51025 (`extraIds`).
 * Amendment 1 MED-3: `WriteTo(OutStream)` on an unassigned XmlNode fails with an engine error (no refusal), so it has no cell.
 */
const Y2_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const y2 = (method: string, call: string, vars: string[] = [], setup: string[] = []): Cell =>
  t9("XmlCell", method, "y2", call, {
    vars: ['W: Codeunit "Y2 Xml Node";', ...vars],
    setup,
  });
const y2Name = (method: string, name: string): Cell => y2(method, `W.CreateNamed(${name});`);
const Y2_DEEP_VARS = [
  'Chain: Codeunit "Y2 Chain";',
  'Sub: Codeunit "Y2 Subscriber";',
  'Single: Codeunit "Y2 Single";',
];
// the SingleInstance global and the binding, then a real blob row written through an OutStream, then a Commit (DO's deep tests)
const Y2_DEEP_SETUP = [
  "Single.SetValue('x');",
  "BindSubscription(Sub);",
  "W.WriteBlob();",
  "Commit();",
];
export const Y2_XML: Family = {
  name: "y2-xml",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  known: [],
  extraIds: 4,
  support: `codeunit 51000 "Y2 Xml Node"
{
    var
        Node: XmlNode;

    procedure Init()
    var
        Root: XmlElement;
    begin
        Root := XmlElement.Create('root');
        Root.Add(XmlElement.Create('child'));
        Node := Root.AsXmlNode();
    end;

    procedure SetNode(var N: XmlNode)
    begin
        Node := N;
    end;

    procedure UnassignedAfterChildren()
    begin
        UnassignedAfterChildrenInner();
    end;

    local procedure UnassignedAfterChildrenInner()
    var
        Root: XmlElement;
        Children: XmlNodeList;
        Unset: XmlNode;
        B: Boolean;
    begin
        Root := Node.AsXmlElement();
        Children := Root.GetChildNodes();
        B := Unset.IsXmlText();
    end;

    procedure CopyUnassignedInto(Target: Codeunit "Y2 Xml Node")
    var
        Unset: XmlNode;
    begin
        Target.SetNode(Unset);
        Target.UseNode();
    end;

    procedure UseNode()
    var
        B: Boolean;
    begin
        B := Node.IsXmlText();
    end;

    // M36794/5's shape: the target is passed by var and the setter is never called, so its global stays unset
    procedure SkipSetter(var Target: Codeunit "Y2 Xml Node")
    begin
        // nothing touches Target or any XML value: the first refusing statement is the caller's Target.UseNode()
    end;

    procedure SetOnlyInto(Target: Codeunit "Y2 Xml Node")
    var
        Unset: XmlNode;
    begin
        Target.SetNode(Unset);
    end;

    procedure Deep6Noop()
    begin
    end;

    // the deep setup's state, read inside the same test (the DeepSetupOnly control)
    procedure AssertDeepState(Single: Codeunit "Y2 Single")
    var
        Row: Record "Y2 Blob Row";
        Hits: Integer;
    begin
        Hits := Single.TakeHits();
        if Hits <> 1 then
            Error('subscriber ran %1 times, expected 1', Hits);
        if Single.GetValue() <> 'x' then
            Error('Y2 Single value is [%1], expected [x]', Single.GetValue());
        if not Row.Get('B1') then
            Error('blob row B1 is missing');
        Row.CalcFields(Blob);
        if not Row.Blob.HasValue() then
            Error('blob row B1 has an empty blob');
    end;

    procedure MultiContentWithUnassigned()
    begin
        MultiContentInner();
    end;

    local procedure MultiContentInner()
    var
        Root: XmlElement;
        Unset: XmlNode;
    begin
        Root := XmlElement.Create('root');
        Root.Add(XmlText.Create('first'), Unset);
    end;

    procedure WriteBlob()
    var
        Row: Record "Y2 Blob Row";
        OutS: OutStream;
    begin
        Row.Init();
        Row."Code" := 'B1';
        Row.Blob.CreateOutStream(OutS);
        OutS.WriteText('payload');
        Row.Insert();
    end;

    procedure SetAttributeOnUnassigned()
    begin
        SetAttributeInner();
    end;

    local procedure SetAttributeInner()
    var
        E: XmlElement;
    begin
        E.SetAttribute('a', '', 'b');
    end;

    procedure HasAttributesOnUnassigned()
    begin
        HasAttributesInner();
    end;

    local procedure HasAttributesInner()
    var
        E: XmlElement;
        B: Boolean;
    begin
        B := E.HasAttributes();
    end;

    procedure AddUnassignedToDocument()
    begin
        AddUnassignedInner();
    end;

    local procedure AddUnassignedInner()
    var
        Doc: XmlDocument;
        Unset: XmlNode;
    begin
        Doc := XmlDocument.Create();
        Doc.Add(Unset);
    end;

    procedure GetFromUnassignedCollection()
    begin
        GetFromCollectionInner();
    end;

    local procedure GetFromCollectionInner()
    var
        Coll: XmlAttributeCollection;
        Attr: XmlAttribute;
        B: Boolean;
    begin
        B := Coll.Get('a', Attr);
    end;

    procedure CreateNamed(Name: Text)
    begin
        CreateNamedInner(Name);
    end;

    local procedure CreateNamedInner(Name: Text)
    var
        E: XmlElement;
    begin
        E := XmlElement.Create(Name);
    end;

    procedure AlphabetName(Len: Integer): Text
    var
        Alphabet: Text;
        R: Text;
        i: Integer;
    begin
        Alphabet := '${Y2_ALPHABET}';
        for i := 0 to Len - 1 do
            R += CopyStr(Alphabet, (i mod StrLen(Alphabet)) + 1, 1);
        exit(R);
    end;

    procedure Deep6AddUnassigned()
    begin
        AddUnassignedInner();
    end;

    procedure Deep6CreateNamed(Name: Text)
    begin
        CreateNamedInner(Name);
    end;
}

codeunit 51022 "Y2 Chain"
{
    procedure RaiseProbe()
    begin
        OnY2Step();
    end;

    procedure ContentDeep(W: Codeunit "Y2 Xml Node")
    begin
        ContentStep2(W);
    end;

    local procedure ContentStep2(W: Codeunit "Y2 Xml Node")
    begin
        OnY2Step();
        ContentStep3(W);
    end;

    local procedure ContentStep3(W: Codeunit "Y2 Xml Node")
    begin
        ContentStep4(W);
    end;

    local procedure ContentStep4(W: Codeunit "Y2 Xml Node")
    begin
        W.Deep6AddUnassigned();
    end;

    procedure NoopDeep(W: Codeunit "Y2 Xml Node")
    begin
        NoopStep2(W);
    end;

    local procedure NoopStep2(W: Codeunit "Y2 Xml Node")
    begin
        OnY2Step();
        NoopStep3(W);
    end;

    local procedure NoopStep3(W: Codeunit "Y2 Xml Node")
    begin
        NoopStep4(W);
    end;

    local procedure NoopStep4(W: Codeunit "Y2 Xml Node")
    begin
        W.Deep6Noop();
    end;

    procedure NameDeep(W: Codeunit "Y2 Xml Node"; Name: Text)
    begin
        NameStep2(W, Name);
    end;

    local procedure NameStep2(W: Codeunit "Y2 Xml Node"; Name: Text)
    begin
        OnY2Step();
        NameStep3(W, Name);
    end;

    local procedure NameStep3(W: Codeunit "Y2 Xml Node"; Name: Text)
    begin
        NameStep4(W, Name);
    end;

    local procedure NameStep4(W: Codeunit "Y2 Xml Node"; Name: Text)
    begin
        W.Deep6CreateNamed(Name);
    end;

    [IntegrationEvent(false, false)]
    local procedure OnY2Step()
    begin
    end;
}

codeunit 51023 "Y2 Subscriber"
{
    EventSubscriberInstance = Manual;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Y2 Chain", 'OnY2Step', '', false, false)]
    local procedure HandleStep()
    var
        Single: Codeunit "Y2 Single";
    begin
        Single.AddHit();
    end;
}

codeunit 51024 "Y2 Single"
{
    SingleInstance = true;

    var
        Value: Text;
        Hits: Integer;
        Left: Codeunit "Y2 Subscriber";

    procedure SetValue(V: Text)
    begin
        Value := V;
    end;

    procedure GetValue(): Text
    begin
        exit(Value);
    end;

    procedure AddHit()
    begin
        Hits += 1;
    end;

    procedure TakeHits(): Integer
    var
        R: Integer;
    begin
        R := Hits;
        Hits := 0;
        exit(R);
    end;

    // a binding that outlives the test that made it (the sensitivity smoke)
    procedure BindAndLeave()
    begin
        BindSubscription(Left);
    end;
}

table 51000 "Y2 Blob Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Blob; Blob) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

// the census readers (Family.readers): each answer is folded into the observation the census compares
codeunit 51025 "Y2 Probe"
{
    procedure EventRan(): Text
    var
        Chain: Codeunit "Y2 Chain";
        Single: Codeunit "Y2 Single";
        Dummy: Integer;
    begin
        Dummy := Single.TakeHits();
        Chain.RaiseProbe();
        exit(Format(Single.TakeHits()));
    end;

    procedure SingleValue(): Text
    var
        Single: Codeunit "Y2 Single";
    begin
        exit(Single.GetValue());
    end;

    procedure XmlText(): Text
    var
        Doc: XmlDocument;
        Root: XmlElement;
        Nodes: XmlNodeList;
        T: Text;
    begin
        if not XmlDocument.ReadFrom('<r a="1"><c>x</c><c>y</c></r>', Doc) then
            exit('readfail');
        if not Doc.GetRoot(Root) then
            exit('noroot');
        Root.SetAttribute('b', '2');
        if not Root.SelectNodes('c', Nodes) then
            exit('noselect');
        Doc.WriteTo(T);
        exit(T + ' n=' + Format(Nodes.Count()));
    end;
}
`,
  readers: [
    { name: "y2event", vars: ['Y2P1: Codeunit "Y2 Probe";'], expr: "Y2P1.EventRan()" },
    { name: "y2single", vars: ['Y2P2: Codeunit "Y2 Probe";'], expr: "Y2P2.SingleValue()" },
    { name: "y2xml", vars: ['Y2P3: Codeunit "Y2 Probe";'], expr: "Y2P3.XmlText()" },
  ],
  handles: {},
  cells: [
    y2("UnassignedNodeAfterChildren", "W.UnassignedAfterChildren();", [], ["W.Init();"]),
    y2(
      "UnassignedNodeByVar",
      "W2.UseNode();",
      ['W2: Codeunit "Y2 Xml Node";'],
      ["W.Init();", "W.SkipSetter(W2);"],
    ),
    y2(
      "UnassignedNodeByValue",
      "W.CopyUnassignedInto(W2);",
      ['W2: Codeunit "Y2 Xml Node";'],
      ["W.Init();", "W2.Init();"],
    ),
    y2("UnassignedElementSetAttr", "W.SetAttributeOnUnassigned();"),
    y2("UnassignedElementHasAttrs", "W.HasAttributesOnUnassigned();"),
    y2("NodeAsContent", "W.AddUnassignedToDocument();"),
    y2("AttrCollectionGet", "W.GetFromUnassignedCollection();"),
    y2Name("Name1Plus", "'+'"),
    y2Name("NameDigitStart", "'1abc'"),
    y2Name("NameImageJpeg", "'image/jpeg'"),
    y2Name("NamePdf", "'application/pdf'"),
    y2Name("Name16Eq", "W.AlphabetName(15) + '='"),
    y2Name("Name76", "W.AlphabetName(75) + '='"),
    y2Name("Name1336", "W.AlphabetName(1336)"),
    y2Name("Name2000", "W.AlphabetName(2000)"),
    y2("NodeAsSecondContent", "W.MultiContentWithUnassigned();"),
    y2("DeepNodeAsContent", "Chain.ContentDeep(W);", Y2_DEEP_VARS, Y2_DEEP_SETUP),
    y2("DeepName76", "Chain.NameDeep(W, W.AlphabetName(75) + '=');", Y2_DEEP_VARS, Y2_DEEP_SETUP),
    // controls (passing; the census ignores them): where each XmlNode cell refuses
    y2("CtlByVarSetterOnly", "W.SkipSetter(W2);", ['W2: Codeunit "Y2 Xml Node";'], ["W.Init();"]),
    y2(
      "CtlByValueSetOnly",
      "W.SetOnlyInto(W2);",
      ['W2: Codeunit "Y2 Xml Node";'],
      ["W.Init();", "W2.Init();"],
    ),
    y2("CtlDeepSetupOnly", "W.AssertDeepState(Single);", Y2_DEEP_VARS, [
      ...Y2_DEEP_SETUP,
      "Single.TakeHits();",
      "Chain.NoopDeep(W);",
    ]),
  ],
};

/**
 * PR-195: the collation refusal DO's y2 window closed on (`ordering of the character U+516C (no collation weight)`), driven by
 * an invented cell (no corpus source text). `InRange` is written in the shape the mutant has: `Ch >= 'A'` turned into
 * `Ch >= ''`, so a Char compare becomes a Text compare. Depth 3: test -> Derive -> Clean -> InRange. Cell i is codeunit
 * BASE_ID + 1 + i (51001 to 51007); the support codeunits are 51000 and 51008 to 51009 (`extraIds`).
 */
const y2c = (method: string, code: string, setup: string[] = [], vars: string[] = []): Cell =>
  t9("Collation", method, "y2c", "W.SetOverride(7); Result := W.Derive(T);", {
    vars: ['W: Codeunit "Y2C Derive";', "Ch: Char;", "T: Text;", "Result: Text;", ...vars],
    setup: [`Ch := ${code};`, "T := Format(Ch) + 'AB';", ...setup],
  });
const Y2C_ROW = ['Row: Record "Y2C Row";'];
const Y2C_ROW_SETUP = ["Row.Init();", "Row.Code := 'R1';", "Row.Insert();"];
const Y2C_SINGLE = ['Single: Codeunit "Y2C Single";'];
const Y2C_SINGLE_SETUP = ["Single.SetValue('x');"];
export const Y2_COLLATION: Family = {
  name: "y2-collation",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8203",
  known: [],
  extraIds: 2,
  testPermissions: "Disabled",
  support: `codeunit 51000 "Y2C Derive"
{
    SingleInstance = true;

    var
        Override: Integer;

    procedure SetOverride(N: Integer)
    begin
        Override := N;
    end;

    procedure GetOverride(): Integer
    begin
        exit(Override);
    end;

    procedure Derive(Name: Text): Text
    begin
        exit(Clean(Name));
    end;

    local procedure Clean(Value: Text): Text
    var
        Result: TextBuilder;
        Ch: Char;
        i: Integer;
    begin
        Value := UpperCase(Value);
        for i := 1 to StrLen(Value) do begin
            Ch := Value[i];
            if InRange(Ch) then
                Result.Append(Format(Ch))
            else
                Result.Append('-');
        end;
        exit(Result.ToText());
    end;

    local procedure InRange(Ch: Char): Boolean
    begin
        exit(((Ch >= '') and (Ch <= 'Z')) or ((Ch >= '0') and (Ch <= '9')));
    end;
}

codeunit 51008 "Y2C Single"
{
    SingleInstance = true;

    var
        Value: Text;

    procedure SetValue(V: Text)
    begin
        Value := V;
    end;

    procedure GetValue(): Text
    begin
        exit(Value);
    end;
}

codeunit 51009 "Y2C Probe"
{
    procedure SingleValue(): Text
    var
        Single: Codeunit "Y2C Single";
    begin
        exit(Single.GetValue());
    end;

    // PR-195 build review MED-2: the rows the "after an insert" cells write, so a row that outlived a refusal shows.
    procedure RowCount(): Text
    var
        Row: Record "Y2C Row";
    begin
        exit(Format(Row.Count()));
    end;

    procedure OverrideValue(): Text
    var
        D: Codeunit "Y2C Derive";
    begin
        exit(Format(D.GetOverride()));
    end;

    // text al-runner already orders: reported, so a change in it shows in the census
    procedure OrderText(): Text
    var
        Row: Record "Y2C Order Row" temporary;
        Acute: Text;
        Tilde: Text;
        R: Text;
    begin
        Acute := 'é';
        Tilde := '~';
        R := Format(Acute > 'Z') + Format(Acute < 'a') + Format(Acute > 'z') + Format(Acute < 'z');
        R += '|' + Format(Tilde > 'a') + Format(Tilde < 'a') + Format(Tilde > 'Z') + Format(Tilde < 'Z');
        Row.Code := 'Z';
        Row.Insert();
        Row.Code := 'É';
        Row.Insert();
        R += '|';
        if Row.FindSet() then
            repeat
                R += Row.Code + ',';
            until Row.Next() = 0;
        exit(R);
    end;
}

table 51000 "Y2C Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

table 51001 "Y2C Order Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}
`,
  readers: [
    { name: "y2single", vars: ['Y2P1: Codeunit "Y2C Probe";'], expr: "Y2P1.SingleValue()" },
    { name: "y2cover", vars: ['Y2P2: Codeunit "Y2C Probe";'], expr: "Y2P2.OverrideValue()" },
    { name: "y2order", vars: ['Y2P3: Codeunit "Y2C Probe";'], expr: "Y2P3.OrderText()" },
    { name: "y2rows", vars: ['Y2P4: Codeunit "Y2C Probe";'], expr: "Y2P4.RowCount()" },
  ],
  handles: {},
  cells: [
    y2c("CjkPlain", "20844"),
    y2c("CyrillicPlain", "1050"),
    y2c("CjkAfterInsert", "20844", Y2C_ROW_SETUP, Y2C_ROW),
    y2c("CyrillicAfterInsert", "1050", Y2C_ROW_SETUP, Y2C_ROW),
    y2c("CjkAfterSingle", "20844", Y2C_SINGLE_SETUP, Y2C_SINGLE),
    y2c("CyrillicAfterSingle", "1050", Y2C_SINGLE_SETUP, Y2C_SINGLE),
    // control (passing; the census ignores it): ASCII only, so no collation weight is needed. The expected text follows the
    // AL above: UpperCase, then every character kept. The mutated shape compares as Text, and ' ' >= '' and ' ' <= 'Z' hold,
    // so the space is kept too (measured on al-runner). It errors only on a mismatch.
    t9(
      "Collation",
      "CtlAscii",
      "y2c",
      "Result := W.Derive('ABC 12'); if Result <> 'ABC 12' then Error('Derive gave [%1], expected [ABC 12]', Result);",
      { vars: ['W: Codeunit "Y2C Derive";', "Result: Text;"] },
    ),
  ],
};

/**
 * PR-373: #8094's family, the largest open coherent one after families 1-22 under R1036's count over c3 and c3off
 * (main-bf3a3e863; 20 standing sightings of "Format of a value (standard format N) while CurrReport.FormatRegion is <x> is not
 * pinned"). A document report sets `CurrReport.Language` and `CurrReport.FormatRegion`, then formats a value. Here an invented
 * report (51000) does that in its data item's OnAfterGetRecord and hands the text to a SingleInstance holder (codeunit 51000).
 * The cell runs the report with `SaveAs` (Xml, the dataset only: no layout) and reports the text with `Error('V:[...]')`, so
 * every cell is expected to FAIL with its answer. Cell i is codeunit BASE_ID + 1 + i; the support objects all have id 51000.
 */
const FR_REGIONS: readonly (readonly [string, number])[] = [
  ["en-GB", 2057],
  ["de-DE", 1031],
  ["fr-FR", 1036],
  ["da-DK", 1030],
  ["en-US", 1033],
];
const FR_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** The report's `Kind` values (its `Compute` case) with the cell's method name. */
const FR_KINDS: readonly (readonly [number, string])[] = [
  [0, "Date std0"],
  [10, "Decimal neg"],
  [11, "Decimal big"],
  [20, "Enum caption"],
  [30, "DateTime"],
  [31, "Time"],
  [40, "Date picture"],
];
const frCell = (
  state: string,
  lang: number,
  region: string,
  kind: number,
  method: string,
  month = 1,
): Cell => ({
  type: "Region",
  method,
  state,
  vars: [
    'Rep: Report "FR Report";',
    'Buf: Record "FR Buf";',
    "OS: OutStream;",
    'Holder: Codeunit "FR Holder";',
  ],
  setup: [
    "Buf.Data.CreateOutStream(OS);",
    `Rep.SetCase(${lang}, '${region}', ${region === "" ? "false" : "true"}, ${kind}, DMY2Date(17, ${month}, 2026));`,
    "Rep.SaveAs('', ReportFormat::Xml, OS);",
  ],
  // ponytail: the SingleInstance holder is not cleared before the report runs, so a report that never fires OnAfterGetRecord
  // would report the previous cell's text. Not seen on bc4 or main-bf3a3e863 (every answer matches its own month and kind).
  // Add `Holder.Put('');` first when the cells are next re-measured on both sides (it changes the BC-check app).
  call: "Error('V:[%1]', Holder.Get());",
  // without the report language, month names and captions follow the session's language
  ...(lang === 0 ? { depends: "locale" as const } : {}),
});
const frSet = (state: string, lang: number, region: string): Cell[] => [
  ...FR_MONTHS.map((m, i) => frCell(state, lang, region, 4, `Date f4 ${m}`, i + 1)),
  ...FR_KINDS.map(([k, m]) => frCell(state, lang, region, k, m)),
];
export const FORMAT_REGION: Family = {
  name: "format-region",
  // PR-417: every cell reads region or language data; #8861 and #8862 (da-DK, fr-FR) came from these cells and were Linux ICU
  // data, which Windows BC (NLS) does not share
  bcMeasured: { ...BC4_LINUX, task: "PR-373" },
  cultureData: "all",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8094",
  // the two texts #8094 itself quotes; a class is matched whole, so every other region's text stays NEW
  known: [
    "Format of a value (standard format 4) while CurrReport.FormatRegion is 'en-GB' is not pinned (docs/probes-needed.md)",
    "Format of a value (standard format 0) while CurrReport.FormatRegion is 'de-DE' is not pinned (docs/probes-needed.md)",
  ],
  testPermissions: "Disabled",
  support: `enum 51000 "FR Kind"
{
    value(0; First) { Caption = 'First Value'; }
    value(1; Second) { Caption = 'Second Value'; }
}

table 51000 "FR Buf"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 51000 "FR Holder"
{
    SingleInstance = true;

    var
        Value: Text;

    procedure Put(V: Text)
    begin
        Value := V;
    end;

    procedure Get(): Text
    begin
        exit(Value);
    end;
}

report 51000 "FR Report"
{
    UsageCategory = None;

    dataset
    {
        dataitem(Row; Integer)
        {
            DataItemTableView = where(Number = const(1));

            column(Answer; Answer) { }

            trigger OnAfterGetRecord()
            var
                Holder: Codeunit "FR Holder";
            begin
                if Lang <> 0 then
                    CurrReport.Language := Lang;
                if SetRegion then
                    CurrReport.FormatRegion := Region;
                Answer := Compute();
                Holder.Put(Answer);
            end;
        }
    }

    var
        Lang: Integer;
        Region: Text[80];
        SetRegion: Boolean;
        Kind: Integer;
        D: Date;
        Answer: Text;

    procedure SetCase(NewLang: Integer; NewRegion: Text[80]; NewSetRegion: Boolean; NewKind: Integer; NewDate: Date)
    begin
        Lang := NewLang;
        Region := NewRegion;
        SetRegion := NewSetRegion;
        Kind := NewKind;
        D := NewDate;
    end;

    local procedure Compute(): Text
    var
        E: Enum "FR Kind";
    begin
        case Kind of
            0:
                exit(Format(D));
            4:
                exit(Format(D, 0, 4));
            10:
                exit(Format(-1234.5));
            11:
                exit(Format(1234567.891));
            20:
                begin
                    E := E::Second;
                    exit(Format(E));
                end;
            30:
                exit(Format(CreateDateTime(D, 133015T)));
            31:
                exit(Format(133015T));
            40:
                exit(Format(D, 0, '<Day,2>. <Month Text> <Year4>'));
        end;
        Error('FR Report: no kind %1', Kind);
    end;
}
`,
  handles: {},
  cells: [
    ...FR_REGIONS.flatMap(([r, lang]) => [
      ...frSet(`${r} lang`, lang, r),
      ...frSet(`${r} only`, 0, r),
    ]),
    // control: no language and no region set, so the session's own formats
    ...frSet("none", 0, ""),
  ],
};

/**
 * PR-374: #8219's family, the largest open coherent one after families 1-23 under R1036's count over c3 and c3off
 * (main-bf3a3e863): "conversion of Boolean false to BigInteger" (6) and "conversion of Code <x> to BigInteger" (2), met where
 * RecordRef code hands a FieldRef a value of another type. Each cell opens table 51000 through a RecordRef, takes one field,
 * gives it one typed value through one FieldRef method, and reports what the field then holds: the filter after SetRange or
 * SetFilter, the formatted value after `Value :=` or Validate. No row is written. Cell i is codeunit BASE_ID + 1 + i.
 */
const FC_FIELDS: readonly (readonly [string, number])[] = [
  ["BigInteger", 2],
  ["Integer", 3],
  ["Decimal", 4],
  ["Code", 5],
  ["Text", 6],
  ["Date", 7],
  ["Boolean", 8],
  ["Option", 9],
  ["Guid", 10],
];
/** The value's name, its AL declaration and the statement that sets it. */
const FC_VALUES: readonly (readonly [string, string, string])[] = [
  ["Boolean false", "Boolean", "V := false;"],
  ["Code ABC", "Code[20]", "V := 'ABC';"],
  ["Code 123", "Code[20]", "V := '123';"],
  ["Text XY", "Text[30]", "V := 'XY';"],
  ["Integer 5", "Integer", "V := 5;"],
  ["BigInteger 5", "BigInteger", "V := 5L;"],
  ["Decimal 1.5", "Decimal", "V := 1.5;"],
  ["Date", "Date", "V := DMY2Date(17, 1, 2026);"],
];
/** The method, the statement under test and the read-back that becomes the answer. */
const FC_METHODS: readonly (readonly [string, string, string])[] = [
  ["SetRange", "FR.SetRange(V);", "FR.GetFilter()"],
  ["SetFilter", "FR.SetFilter('%1', V);", "FR.GetFilter()"],
  ["Value", "FR.Value := V;", "Format(FR.Value, 0, 9)"],
  ["Validate", "FR.Validate(V);", "Format(FR.Value, 0, 9)"],
];
export const FIELDREF_CONVERT: Family = {
  name: "fieldref-convert",
  bcMeasured: { ...BC4_LINUX, task: "PR-374" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8219",
  known: ["conversion of Boolean false to BigInteger"],
  testPermissions: "Disabled",
  support: `table 51000 "FC Row"
{
    fields
    {
        field(1; "Key"; Integer) { }
        field(2; BigInt; BigInteger) { }
        field(3; Int; Integer) { }
        field(4; Dec; Decimal) { }
        field(5; Cod; Code[20]) { }
        field(6; Txt; Text[50]) { }
        field(7; Dat; Date) { }
        field(8; Bool; Boolean) { }
        field(9; Opt; Option) { OptionMembers = A,B,C; }
        field(10; Gid; Guid) { }
    }
    keys { key(PK; "Key") { Clustered = true; } }
}
`,
  handles: {},
  cells: FC_FIELDS.flatMap(([field, no]) =>
    FC_VALUES.flatMap(([value, decl, set]) =>
      FC_METHODS.map(([method, call, read]) => ({
        type: `FC ${field}`,
        method,
        state: value,
        vars: ["RecRef: RecordRef;", "FR: FieldRef;", `V: ${decl};`],
        setup: ["RecRef.Open(51000);", `FR := RecRef.Field(${no});`, set],
        call: `${call} Error('V:[%1]', ${read});`,
      })),
    ),
  ),
};

/**
 * PR-374: the refusal PR-373 found (19 cells): "CurrReport.FormatRegion := '<x>' in a report not started by Run (its formats and
 * dataset in that region are not built)", and its sibling "after CurrReport.Language := N in a report not started by Run".
 * al-runner pins a few (language, region) pairs in a report run by SaveAs and refuses the rest. Here each cell is one pair: an
 * invented report sets `CurrReport.Language`, then `CurrReport.FormatRegion`, in OnAfterGetRecord, and formats a long date, an
 * amount, a short date and a time in one text. The holder is cleared before each run (PR-373's review), so a run that never
 * fires the trigger answers `[]`, never the previous cell's text. Cell i is codeunit BASE_ID + 1 + i; support objects at 51000.
 */
const LR_LANGUAGES = [1030, 1031, 1033, 1034, 1036, 1040, 1043, 1044, 1053, 2057, 3084];
const LR_REGIONS = [
  "da-DK",
  "de-DE",
  "en-US",
  "es-ES",
  "fr-FR",
  "it-IT",
  "nl-NL",
  "nb-NO",
  "sv-SE",
  "en-GB",
  "fr-CA",
  "de-CH",
];
const lrCell = (lang: number, region: string): Cell => ({
  type: "Pair",
  method: region,
  state: lang === 0 ? "no language" : `lang ${lang}`,
  vars: [
    'Rep: Report "LR Report";',
    'Buf: Record "LR Buf";',
    "OS: OutStream;",
    'Holder: Codeunit "LR Holder";',
  ],
  setup: [
    "Holder.Put('');",
    "Buf.Data.CreateOutStream(OS);",
    `Rep.SetCase(${lang}, '${region}');`,
    "Rep.SaveAs('', ReportFormat::Xml, OS);",
  ],
  call: "Error('V:[%1]', Holder.Get());",
  // without the report language, month names follow the session's language
  ...(lang === 0 ? { depends: "locale" as const } : {}),
});
export const LANGUAGE_REGION: Family = {
  name: "language-region",
  // PR-417: every cell reads a (language, region) pair's data; #8871 (sv-SE) came from these cells and was Linux ICU data
  bcMeasured: { ...BC4_LINUX, task: "PR-374" },
  cultureData: "all",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8094",
  known: [],
  testPermissions: "Disabled",
  support: `table 51000 "LR Buf"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 51000 "LR Holder"
{
    SingleInstance = true;

    var
        Value: Text;

    procedure Put(V: Text)
    begin
        Value := V;
    end;

    procedure Get(): Text
    begin
        exit(Value);
    end;
}

report 51000 "LR Report"
{
    UsageCategory = None;

    dataset
    {
        dataitem(Row; Integer)
        {
            DataItemTableView = where(Number = const(1));

            column(Answer; Answer) { }

            trigger OnAfterGetRecord()
            var
                Holder: Codeunit "LR Holder";
                D: Date;
            begin
                if Lang <> 0 then
                    CurrReport.Language := Lang;
                CurrReport.FormatRegion := Region;
                D := DMY2Date(17, 1, 2026);
                Answer := Format(D, 0, 4) + '|' + Format(1234567.891) + '|' + Format(D) + '|' + Format(133015T);
                Holder.Put(Answer);
            end;
        }
    }

    var
        Lang: Integer;
        Region: Text[80];
        Answer: Text;

    procedure SetCase(NewLang: Integer; NewRegion: Text[80])
    begin
        Lang := NewLang;
        Region := NewRegion;
    end;
}
`,
  handles: {},
  cells: [
    ...LR_LANGUAGES.flatMap((lang) => LR_REGIONS.map((r) => lrCell(lang, r))),
    // the region alone (the shape that ran in PR-373's fr-FR cells)
    ...LR_REGIONS.map((r) => lrCell(0, r)),
  ],
};

/**
 * PR-375: the largest open coherent cause after families 1-25 under R1036's count over c3 and c3off (main-bf3a3e863): "DotNet
 * System.IO.Compression.ZipArchive.Dispose: a .NET write over the bytes an AL OutStream held before the call (what the Blob then
 * holds is not pinned)" (6 sightings, all at baseline). It is met where an app keeps a zip in a Blob and adds a file to it through
 * the System Application's "Data Compression" codeunit: it opens the archive from the Blob's InStream, clears the Blob, and saves
 * the archive back into the same Blob through an OutStream. Each cell runs one such sequence on an invented table's Blob fields
 * (A = 2, B = 3, C = 4; the record is never inserted) and reports what the target Blob then holds, through codeunit 51000's
 * Describe: `empty`, `notzip:<text>`, or `zip|<entry>:<length>:<first 12 characters>|...`. Compressed bytes are never compared.
 * Cell i is codeunit BASE_ID + 1 + i; the support objects are at 51000.
 */
const ZC_PAYLOADS: readonly (readonly [string, string])[] = [
  ["hello", "'hello'"],
  ["empty", "''"],
  ["long", "PadStr('', 2000, 'x')"],
];
/** The scenario's name, its statements (`<payload>` is the entry text) and the field its result is read from. */
const ZC_SCENARIOS: readonly (readonly [string, readonly string[], number])[] = [
  [
    "new to other blob",
    [
      "P.PutText(R, 2, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.CreateZipArchive();",
      "DC.AddEntry(IS, 'a.txt');",
      "R.B.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    3,
  ],
  [
    "new to source via copy",
    [
      "P.PutText(R, 2, <payload>);",
      "Copy.A := R.A;",
      "Copy.A.CreateInStream(IS);",
      "Clear(R.A);",
      "R.A.CreateOutStream(OS);",
      "DC.CreateZipArchive();",
      "DC.AddEntry(IS, 'a.txt');",
      "DC.SaveZipArchive(OS);",
    ],
    2,
  ],
  [
    "new to source same blob",
    [
      "P.PutText(R, 2, <payload>);",
      "R.A.CreateInStream(IS);",
      "Clear(R.A);",
      "R.A.CreateOutStream(OS);",
      "DC.CreateZipArchive();",
      "DC.AddEntry(IS, 'a.txt');",
      "DC.SaveZipArchive(OS);",
    ],
    2,
  ],
  [
    "update to other blob",
    [
      "P.MakeZip(R, 2, 'a.txt', 'first');",
      "P.PutText(R, 4, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, true);",
      "R.C.CreateInStream(IS2);",
      "DC.AddEntry(IS2, 'c.txt');",
      "R.B.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    3,
  ],
  [
    "update to source cleared",
    [
      "P.MakeZip(R, 2, 'a.txt', 'first');",
      "P.PutText(R, 4, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, true);",
      "R.C.CreateInStream(IS2);",
      "DC.AddEntry(IS2, 'c.txt');",
      "Clear(R.A);",
      "R.A.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    2,
  ],
  [
    "update to source not cleared",
    [
      "P.MakeZip(R, 2, 'a.txt', 'first');",
      "P.PutText(R, 4, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, true);",
      "R.C.CreateInStream(IS2);",
      "DC.AddEntry(IS2, 'c.txt');",
      "R.A.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    2,
  ],
  [
    "read only then add",
    [
      "P.MakeZip(R, 2, 'a.txt', 'first');",
      "P.PutText(R, 4, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, false);",
      "R.C.CreateInStream(IS2);",
      "DC.AddEntry(IS2, 'c.txt');",
      "R.B.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    3,
  ],
  [
    "remove and add to source",
    [
      "P.MakeZip(R, 2, 'a.txt', 'first');",
      "P.PutText(R, 4, <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, true);",
      "DC.RemoveEntry('a.txt');",
      "R.C.CreateInStream(IS2);",
      "DC.AddEntry(IS2, 'c.txt');",
      "Clear(R.A);",
      "R.A.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    2,
  ],
  [
    "extract entry",
    [
      "P.MakeZip(R, 2, 'a.txt', <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, false);",
      "R.B.CreateOutStream(OS);",
      "Len := DC.ExtractEntry('a.txt', OS);",
      "DC.CloseZipArchive();",
    ],
    3,
  ],
  [
    "close then save",
    [
      "P.MakeZip(R, 2, 'a.txt', <payload>);",
      "R.A.CreateInStream(IS);",
      "DC.OpenZipArchive(IS, true);",
      "DC.CloseZipArchive();",
      "R.B.CreateOutStream(OS);",
      "DC.SaveZipArchive(OS);",
    ],
    3,
  ],
  // IsZip itself (target 0: the answer is Format(DC.IsZip(IS)) of the InStream the statements leave)
  ["IsZip of a zip", ["P.MakeZip(R, 2, 'a.txt', <payload>);", "R.A.CreateInStream(IS);"], 0],
  ["IsZip of the text", ["P.PutText(R, 2, <payload>);", "R.A.CreateInStream(IS);"], 0],
];
export const ZIP_BLOB: Family = {
  name: "zip-blob",
  bcMeasured: { ...BC4_LINUX, task: "PR-375" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7924",
  known: [],
  testPermissions: "Disabled",
  // Data Compression wraps .NET's ZipArchive: al-runner needs its .NET helper (and the exact BC build, which every family now
  // runs on: REFUSAL_FAMILY_BC_VERSION, PR-377), as LethAL's own serve runs pass them.
  // ponytail: box paths (the pinned build's sidecar, the cached service tier); take them from the run's config when a second box needs this.
  args: [
    "--dotnet-sidecar",
    "/work/tools/al-runner-v3/current/dotnet-sidecar/AlDotNetSidecar.dll",
    "--dotnet-assembly-dir",
    "/coord/cache/bc28-service-windows",
  ],
  dependencies: [
    {
      id: "63ca2fa4-4f03-4f2b-a480-172fef340d3f",
      name: "System Application",
      publisher: "Microsoft",
      version: "28.0.0.0",
    },
  ],
  support: `table 51000 "ZC Buf"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; A; Blob) { }
        field(3; B; Blob) { }
        field(4; C; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

codeunit 51000 "ZC Probe"
{
    procedure PutText(var R: Record "ZC Buf"; Which: Integer; T: Text)
    var
        OS: OutStream;
    begin
        ClearField(R, Which);
        OpenOut(R, Which, OS);
        OS.WriteText(T);
    end;

    // a zip with one entry, built from its own record so the target Blob holds nothing else
    procedure MakeZip(var R: Record "ZC Buf"; Which: Integer; EntryName: Text; Content: Text)
    var
        Src: Record "ZC Buf";
        DC: Codeunit "Data Compression";
        IS: InStream;
        OS: OutStream;
    begin
        PutText(Src, 4, Content);
        Src.C.CreateInStream(IS);
        DC.CreateZipArchive();
        DC.AddEntry(IS, EntryName);
        ClearField(R, Which);
        OpenOut(R, Which, OS);
        DC.SaveZipArchive(OS);
        DC.CloseZipArchive();
    end;

    procedure Describe(var R: Record "ZC Buf"; Which: Integer): Text
    var
        Tmp: Record "ZC Buf";
        DC: Codeunit "Data Compression";
        IS: InStream;
        EntryIS: InStream;
        OS: OutStream;
        Names: List of [Text];
        EntryName: Text;
        T: Text;
        Res: Text;
        B1: Byte;
        B2: Byte;
    begin
        if not HasData(R, Which) then
            exit('empty');
        // a zip starts with 'PK' (80, 75); read as bytes, so the probe does not lean on IsZip (it has cells of its own)
        OpenIn(R, Which, IS);
        IS.Read(B1);
        IS.Read(B2);
        if not ((B1 = 80) and (B2 = 75)) then begin
            OpenIn(R, Which, IS);
            exit('notzip:' + ReadAll(IS));
        end;
        OpenIn(R, Which, IS);
        DC.OpenZipArchive(IS, false);
        DC.GetEntryList(Names);
        Res := 'zip';
        foreach EntryName in Names do begin
            Clear(Tmp.B);
            Tmp.B.CreateOutStream(OS);
            DC.ExtractEntry(EntryName, OS);
            Tmp.B.CreateInStream(EntryIS);
            T := ReadAll(EntryIS);
            Res += '|' + EntryName + ':' + Format(StrLen(T)) + ':' + CopyStr(T, 1, 12);
        end;
        DC.CloseZipArchive();
        exit(Res);
    end;

    local procedure ReadAll(var IS: InStream): Text
    var
        Line: Text;
        Res: Text;
    begin
        while not IS.EOS() do begin
            IS.ReadText(Line);
            Res += Line;
        end;
        exit(Res);
    end;

    local procedure HasData(var R: Record "ZC Buf"; Which: Integer): Boolean
    begin
        case Which of
            2:
                exit(R.A.HasValue());
            3:
                exit(R.B.HasValue());
            4:
                exit(R.C.HasValue());
        end;
        Error('ZC Probe: no field %1', Which);
    end;

    local procedure ClearField(var R: Record "ZC Buf"; Which: Integer)
    begin
        case Which of
            2:
                Clear(R.A);
            3:
                Clear(R.B);
            4:
                Clear(R.C);
            else
                Error('ZC Probe: no field %1', Which);
        end;
    end;

    local procedure OpenIn(var R: Record "ZC Buf"; Which: Integer; var IS: InStream)
    begin
        case Which of
            2:
                R.A.CreateInStream(IS);
            3:
                R.B.CreateInStream(IS);
            4:
                R.C.CreateInStream(IS);
            else
                Error('ZC Probe: no field %1', Which);
        end;
    end;

    local procedure OpenOut(var R: Record "ZC Buf"; Which: Integer; var OS: OutStream)
    begin
        case Which of
            2:
                R.A.CreateOutStream(OS);
            3:
                R.B.CreateOutStream(OS);
            4:
                R.C.CreateOutStream(OS);
            else
                Error('ZC Probe: no field %1', Which);
        end;
    end;
}
`,
  handles: {},
  cells: ZC_SCENARIOS.flatMap(([scenario, statements, target]) =>
    ZC_PAYLOADS.map(([payload, expr]) => ({
      type: "Zip",
      method: scenario,
      state: payload,
      vars: [
        'R: Record "ZC Buf";',
        'Copy: Record "ZC Buf";',
        'DC: Codeunit "Data Compression";',
        'P: Codeunit "ZC Probe";',
        "IS: InStream;",
        "IS2: InStream;",
        "OS: OutStream;",
        "Len: Integer;",
      ],
      setup: statements.map((s) => s.replace("<payload>", expr)),
      call:
        target === 0
          ? "Error('V:[%1]', Format(DC.IsZip(IS)));"
          : `Error('V:[%1]', P.Describe(R, ${target}));`,
    })),
  ),
};

/**
 * PR-431 (R1214): the refusal texts edge e5176a9fd closes its serve daemon on, driven by invented cells: SetRange or SetFilter
 * of a Code or Text value into a BigInteger or Integer field (assumption setrange-other-type-convert), and #8801's restamped
 * rows (a SystemRowVersion read, or a find on it, of a row inserted before a row version sent ahead of it). The values are
 * invented ones of DO's shapes. Cell i is codeunit BASE_ID + 1 + i; the support tables are 51000 and 51001. Measured on edge
 * e5176a9fd: the Text cells refuse only through the key (a plain Field(n) fails with an Evaluate error), and inserting A then B
 * and reading A back passes unless B is read (sent) in between.
 */
const ER_ROWS = ['A: Record "ER Row A";', 'B: Record "ER Row B";', "V: BigInteger;"];
const ER_INSERT_TWO = [
  "A.Code := 'A';",
  "A.Insert();",
  "B.Code := 'B';",
  "B.Insert();",
  "B.Get('B');",
  "V := B.SystemRowVersion;",
  "A.Get('A', 0);",
];
export const EDGE_REFUSALS: Family = {
  name: "edge-refusals",
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8801",
  known: [],
  testPermissions: "Disabled",
  support: `table 51000 "ER Row A"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Line; Integer) { }
        field(3; Big; BigInteger) { }
    }
    keys { key(PK; "Code", Line) { Clustered = true; } }
}

table 51001 "ER Row B"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}
`,
  handles: {},
  cells: [
    t9("Conversion", "SetRangeCodeToBigInt", "ABCDE1", "RR.Field(3).SetRange(C);", {
      vars: ["RR: RecordRef;", "C: Code[20];"],
      setup: ['RR.Open(Database::"ER Row A");', "C := 'ABCDE1';"],
    }),
    t9("Conversion", "SetFilterCodeToBigInt", "ABCDE1", "RR.Field(3).SetFilter('%1', C);", {
      vars: ["RR: RecordRef;", "C: Code[20];"],
      setup: ['RR.Open(Database::"ER Row A");', "C := 'ABCDE1';"],
    }),
    // the Text cells reach the Integer field through the key (a plain Field(n) only fails with an Evaluate error on edge)
    ...[
      ["SetRangeTextToInt", "QWERTYUIOPASDFGHJKLZ", "FR.SetRange(T);"],
      ["SetRangeTextToInt", "empty", "FR.SetRange(T);"],
      ["SetFilterTextToInt", "QWERTYUIOPASDFGHJKLZ", "FR.SetFilter('%1', T);"],
    ].map(([method = "", state = "", call = ""]) =>
      t9("Conversion", method, state, call, {
        vars: ["RR: RecordRef;", "FR: FieldRef;", "T: Text;"],
        setup: [
          'RR.Open(Database::"ER Row A");',
          "FR := RR.KeyIndex(1).FieldIndex(2);",
          `T := '${state === "empty" ? "" : state}';`,
        ],
      }),
    ),
    t9("RowVersion", "RestampedRead", "er", "V := A.SystemRowVersion;", {
      vars: ER_ROWS,
      setup: ER_INSERT_TWO,
    }),
    t9("RowVersion", "RestampedFind", "er", "if A.FindFirst() then;", {
      vars: ER_ROWS,
      setup: [...ER_INSERT_TWO, "A.SetCurrentKey(SystemRowVersion);"],
    }),
  ],
};

/**
 * PR-487: error handling, transactions and temporary records, for a per-cell BC differential (a family no earlier one covered).
 * Each cell makes its calls, then reports through `Error('V:[...]')`, or fails with the runtime's own error (the answer).
 * Cells that write a real table use their OWN key range (`etKey`), never DeleteAll: a DeleteAll is a write, and a write
 * before `Codeunit.Run`'s return value is used changes what BC does. So counts hold whether or not BC rolls back between
 * tests. Booleans are read through Format(x, 0, 9). Two cells Commit (asserterror after Commit, Codeunit.Run after Commit),
 * as Y2_XML's cells did on bc2. Their committed rows stay, so on BC those two cells answer only on a fresh install: run the
 * app again only after uninstalling it WITH its data (they would answer "already exists"). Cell i is codeunit BASE_ID + 1 + i;
 * tables 51000-51002; the support codeunits follow the last cell (`extraIds`: the helper, the failing Run target, the passing
 * Run target). What the cells do NOT reach (both runtimes stop earlier) is listed in R1236.
 */
let etNext = 0;
/** A fresh key range of 10 for one cell. */
const etKey = (): number => {
  etNext += 1;
  return 1000 + etNext * 10;
};
const ET_VARS = [
  'H: Codeunit "ET Helper";',
  'Row: Record "ET Row";',
  'Row2: Record "ET Row";',
  "R: Boolean;",
];
const et = (
  type: string,
  method: string,
  setup: string[],
  call: string,
  vars: string[] = [],
): Cell => ({
  type: `ET ${type}`,
  method,
  state: "et",
  vars: [...ET_VARS, ...vars],
  setup,
  call,
});
/** Row2 filtered to a cell's key range, for counting. */
const etRange = (k: number): string => `Row2.SetRange("Key", ${k}, ${k + 9});`;
const TMP_VARS = ['Tmp: Record "ET Row" temporary;', 'Tmp2: Record "ET Row" temporary;'];
const tmpAdd = (rec: string, key: number): string =>
  `${rec}.Init(); ${rec}."Key" := ${key}; ${rec}.Insert();`;
const ET_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  const add = (c: Cell): void => {
    cells.push(c);
  };
  // --- TryFunction ---
  add(
    et(
      "Try",
      "ReturnError",
      ["ClearLastError();", "R := H.TryError();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  add(
    et(
      "Try",
      "ReturnOk",
      ["ClearLastError();", "R := H.TryOk();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  add(et("Try", "UnusedError", [], "H.TryError(); Error('V:[reached]');"));
  add(et("Try", "UnusedOk", [], "H.TryOk(); Error('V:[reached]');"));
  {
    const k = etKey();
    add(
      et(
        "Try",
        "InsertThenError",
        [`R := H.TryInsertThenError(${k});`, etRange(k)],
        "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Try",
        "InsertOk",
        [`R := H.TryInsertOk(${k});`, etRange(k)],
        "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  add(et("Try", "LastErrorCode", ["R := H.TryError();"], "Error('V:[%1]', GetLastErrorCode());"));
  add(
    et(
      "Try",
      "CallStack",
      ["R := H.TryError();"],
      "Error('V:[%1]', Format(StrLen(GetLastErrorCallStack()) > 0, 0, 9));",
    ),
  );
  add(
    et(
      "Try",
      "ClearLastError",
      ["R := H.TryError();", "ClearLastError();"],
      "Error('V:[%1|%2]', GetLastErrorText(), GetLastErrorCode());",
    ),
  );
  add(
    et(
      "Try",
      "ErrorInfo",
      ["R := H.TryErrorInfo();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  add(
    et("Try", "Substituted", ["R := H.TryLabelError();"], "Error('V:[%1]', GetLastErrorText());"),
  );
  add(
    et(
      "Try",
      "OkAfterError",
      ["R := H.TryError();", "R := H.TryOk();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  add(
    et(
      "Try",
      "TempThenError",
      ["R := H.TryInsertTempThenError(Tmp);"],
      "Error('V:[%1|%2]', Format(R, 0, 9), Tmp.Count());",
      TMP_VARS,
    ),
  );
  // --- Codeunit.Run ---
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailReturn",
        [
          "ClearLastError();",
          "Row.Init();",
          `Row."Key" := ${k};`,
          'R := Codeunit.Run(Codeunit::"ET Run Fail", Row);',
          etRange(k),
        ],
        "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "OkReturn",
        [
          "Row.Init();",
          `Row."Key" := ${k};`,
          'R := Codeunit.Run(Codeunit::"ET Run Ok", Row);',
          etRange(k),
        ],
        "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailUnused",
        ["Row.Init();", `Row."Key" := ${k};`],
        "Codeunit.Run(Codeunit::\"ET Run Fail\", Row); Error('V:[reached]');",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "OkAfterWrite",
        [
          `H.InsertRow(${k});`,
          "Row.Init();",
          `Row."Key" := ${k + 1};`,
          'R := Codeunit.Run(Codeunit::"ET Run Ok", Row);',
          etRange(k),
        ],
        "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailAfterWrite",
        [
          `H.InsertRow(${k});`,
          "Row.Init();",
          `Row."Key" := ${k + 1};`,
          'R := Codeunit.Run(Codeunit::"ET Run Fail", Row);',
          etRange(k),
        ],
        "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "OkAfterWriteUnused",
        [
          `H.InsertRow(${k});`,
          "Row.Init();",
          `Row."Key" := ${k + 1};`,
          'Codeunit.Run(Codeunit::"ET Run Ok", Row);',
          etRange(k),
        ],
        "Error('V:[%1]', Row2.Count());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailLastErrorCode",
        ["Row.Init();", `Row."Key" := ${k};`, 'R := Codeunit.Run(Codeunit::"ET Run Fail", Row);'],
        "Error('V:[%1]', GetLastErrorCode());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailCallStack",
        ["Row.Init();", `Row."Key" := ${k};`, 'R := Codeunit.Run(Codeunit::"ET Run Fail", Row);'],
        "Error('V:[%1]', Format(StrLen(GetLastErrorCallStack()) > 0, 0, 9));",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Run",
        "FailAfterCommit",
        [
          `H.InsertRow(${k});`,
          "Commit();",
          "Row.Init();",
          `Row."Key" := ${k + 1};`,
          'R := Codeunit.Run(Codeunit::"ET Run Fail", Row);',
          etRange(k),
        ],
        "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  // --- asserterror ---
  add(et("Assert", "NoError", [], "asserterror Row.SetRange(\"Key\", 1); Error('V:[reached]');"));
  add(
    et(
      "Assert",
      "Text",
      ["asserterror Error('ET asserted');"],
      "Error('V:[%1]', GetLastErrorText());",
    ),
  );
  add(
    et(
      "Assert",
      "Code",
      ["asserterror Error('ET asserted');"],
      "Error('V:[%1]', GetLastErrorCode());",
    ),
  );
  {
    const k = etKey();
    add(
      et(
        "Assert",
        "RollbackInside",
        [`asserterror H.InsertThenError(${k});`, etRange(k)],
        "Error('V:[%1|%2]', Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Assert",
        "RollbackBefore",
        [`H.InsertRow(${k});`, "asserterror Error('ET asserted');", etRange(k)],
        "Error('V:[%1]', Row2.Count());",
      ),
    );
  }
  {
    const k = etKey();
    add(
      et(
        "Assert",
        "AfterCommit",
        [`H.InsertRow(${k});`, "Commit();", `asserterror H.InsertThenError(${k + 1});`, etRange(k)],
        "Error('V:[%1|%2]', Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  add(
    et(
      "Assert",
      "ErrorInfo",
      ["asserterror H.RaiseInfo();"],
      "Error('V:[%1]', GetLastErrorText());",
    ),
  );
  add(
    et(
      "Assert",
      "TempNotRolledBack",
      ["asserterror H.InsertTempThenError(Tmp);"],
      "Error('V:[%1]', Tmp.Count());",
      TMP_VARS,
    ),
  );
  // --- ErrorInfo values ---
  const EI = ["EI: ErrorInfo;"];
  add(
    et(
      "Info",
      "Defaults",
      [],
      "Error('V:[%1|%2|%3|%4]', Format(EI.Collectible, 0, 9), Format(EI.ErrorType), Format(EI.Verbosity), EI.Message);",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "Create",
      ["EI := ErrorInfo.Create('ET m');"],
      "Error('V:[%1|%2]', EI.Message, Format(EI.Collectible, 0, 9));",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "CreateCollectible",
      ["EI := ErrorInfo.Create('ET m', true);"],
      "Error('V:[%1|%2]', EI.Message, Format(EI.Collectible, 0, 9));",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "Title",
      ["EI.Title('ET title');", "EI.Message('ET body');", "asserterror Error(EI);"],
      "Error('V:[%1|%2]', GetLastErrorText(), EI.Title);",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "Detailed",
      ["EI.Message('ET body');", "EI.DetailedMessage('ET detail');", "asserterror Error(EI);"],
      "Error('V:[%1|%2]', GetLastErrorText(), EI.DetailedMessage);",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "Dimensions",
      ["Dims.Add('ET k', 'ET v');", "EI.CustomDimensions(Dims);"],
      "Error('V:[%1|%2]', EI.CustomDimensions.Count(), EI.CustomDimensions.Get('ET k'));",
      [...EI, "Dims: Dictionary of [Text, Text];"],
    ),
  );
  add(
    et(
      "Info",
      "ClientType",
      ["EI.Message('ET client');", "EI.ErrorType(ErrorType::Client);", "asserterror Error(EI);"],
      "Error('V:[%1]', GetLastErrorText());",
      EI,
    ),
  );
  add(
    et(
      "Info",
      "Percent",
      ["asserterror Error(ErrorInfo.Create('ET 100% done'));"],
      "Error('V:[%1]', GetLastErrorText());",
    ),
  );
  // --- collectible errors ---
  add(
    et(
      "Collect",
      "AndClear",
      [],
      "Error('V:[%1|%2]', H.CollectAndClear(), Format(HasCollectedErrors(), 0, 9));",
    ),
  );
  add(et("Collect", "AndKeep", [], "H.CollectAndKeep(); Error('V:[reached]');"));
  add(et("Collect", "ThenPlain", [], "H.CollectThenPlain(); Error('V:[reached]');"));
  add(et("Collect", "KeepGoing", [], "Error('V:[%1]', H.CollectKeepGoing());"));
  add(
    et(
      "Collect",
      "Outside",
      ["asserterror H.RaiseCollectibleOutside();"],
      "Error('V:[%1|%2]', GetLastErrorText(), Format(HasCollectedErrors(), 0, 9));",
    ),
  );
  add(
    et(
      "Collect",
      "NoneYet",
      [],
      "Error('V:[%1|%2]', Format(HasCollectedErrors(), 0, 9), GetCollectedErrors().Count());",
    ),
  );
  add(
    et(
      "Collect",
      "KeepInTry",
      ["R := H.TryCollectKeep();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  // --- triggers of a temporary record ---
  const TRIG = ['T: Record "ET Trig" temporary;'];
  add(
    et(
      "Trig",
      "TempInsertTrue",
      ["T.Init();", 'T."Key" := 1;', "T.Val := 'BAD';", "T.Insert(true);"],
      "Error('V:[%1]', T.Count());",
      TRIG,
    ),
  );
  add(
    et(
      "Trig",
      "TempInsertFalse",
      ["T.Init();", 'T."Key" := 1;', "T.Val := 'BAD';", "T.Insert(false);"],
      "Error('V:[%1]', T.Count());",
      TRIG,
    ),
  );
  add(
    et(
      "Trig",
      "TempModifyTrue",
      ["T.Init();", 'T."Key" := 1;', "T.Insert(false);", "T.Val := 'BAD';", "T.Modify(true);"],
      "Error('V:[%1]', T.Val);",
      TRIG,
    ),
  );
  add(
    et(
      "Trig",
      "TempDeleteTrue",
      ["T.Init();", 'T."Key" := 1;', "T.Val := 'BAD';", "T.Insert(false);", "T.Delete(true);"],
      "Error('V:[%1]', T.Count());",
      TRIG,
    ),
  );
  {
    const k = etKey();
    add(
      et(
        "Trig",
        "RealInsertTrue",
        ["RT.Init();", `RT."Key" := ${k};`, "RT.Val := 'BAD';", "RT.Insert(true);"],
        "Error('V:[reached]');",
        ['RT: Record "ET Trig";'],
      ),
    );
  }
  // --- temporary records ---
  add(
    et(
      "Temp",
      "IsTemporary",
      [],
      "Error('V:[%1|%2]', Format(Tmp.IsTemporary, 0, 9), Format(Row.IsTemporary, 0, 9));",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "CopyShared",
      [tmpAdd("Tmp2", 1), "Tmp.Copy(Tmp2, true);", tmpAdd("Tmp2", 2)],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp2.Count());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "CopyNotShared",
      [tmpAdd("Tmp2", 1), "Tmp.Copy(Tmp2);", tmpAdd("Tmp2", 2)],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp2.Count());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "CopySharedInsertOther",
      ["Tmp.Copy(Tmp2, true);", tmpAdd("Tmp", 1)],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp2.Count());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "CopySharedDeleteAll",
      [tmpAdd("Tmp2", 1), tmpAdd("Tmp2", 2), "Tmp.Copy(Tmp2, true);", "Tmp.DeleteAll();"],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp2.Count());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "ResetClearsFilter",
      [
        tmpAdd("Tmp", 1),
        tmpAdd("Tmp", 2),
        tmpAdd("Tmp", 3),
        'Tmp.SetRange("Key", 2);',
        "Tmp.Reset();",
      ],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp.GetFilters());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "FilteredDeleteAll",
      [
        tmpAdd("Tmp", 1),
        tmpAdd("Tmp", 2),
        tmpAdd("Tmp", 3),
        'Tmp.SetRange("Key", 2, 3);',
        "Tmp.DeleteAll();",
        "Tmp.Reset();",
      ],
      "Error('V:[%1]', Tmp.Count());",
      TMP_VARS,
    ),
  );
  add(et("Temp", "ByVar", ["H.AddByVar(Tmp, 1);"], "Error('V:[%1]', Tmp.Count());", TMP_VARS));
  add(et("Temp", "ByValue", ["H.AddByValue(Tmp, 1);"], "Error('V:[%1]', Tmp.Count());", TMP_VARS));
  {
    const k = etKey();
    add(
      et(
        "Temp",
        "ByValueToRealParam",
        [`H.AddByValueReal(Tmp, ${k});`, etRange(k)],
        "Error('V:[%1|%2]', Tmp.Count(), Row2.Count());",
        TMP_VARS,
      ),
    );
  }
  add(
    et(
      "Temp",
      "AutoIncTemp",
      [
        "TA.Val := 'a';",
        "TA.Insert();",
        "I1 := TA.Id;",
        "TA.Val := 'b';",
        "TA.Id := 0;",
        "TA.Insert();",
      ],
      "Error('V:[%1|%2]', I1, TA.Id);",
      ['TA: Record "ET Auto" temporary;', "I1: Integer;"],
    ),
  );
  add(
    et(
      "Temp",
      "AutoIncReal",
      [
        "RA.Val := 'a';",
        "RA.Insert();",
        "I1 := RA.Id;",
        "RA.Val := 'b';",
        "RA.Id := 0;",
        "RA.Insert();",
      ],
      "Error('V:[%1]', RA.Id - I1);",
      ['RA: Record "ET Auto";', "I1: Integer;"],
    ),
  );
  add(
    et(
      "Temp",
      "DuplicateKey",
      [tmpAdd("Tmp", 1), tmpAdd("Tmp", 1)],
      "Error('V:[reached]');",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "ClearShared",
      [tmpAdd("Tmp2", 1), "Tmp.Copy(Tmp2, true);", "Clear(Tmp);"],
      "Error('V:[%1|%2]', Tmp.Count(), Tmp2.Count());",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "ClearSingle",
      [tmpAdd("Tmp", 1), "Clear(Tmp);"],
      "Error('V:[%1|%2]', Tmp.Count(), Format(Tmp.IsTemporary, 0, 9));",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "RealShareTemp",
      [tmpAdd("Tmp", 1), "Row.Copy(Tmp, true);"],
      "Error('V:[%1|%2]', Row.Count(), Format(Row.IsTemporary, 0, 9));",
      TMP_VARS,
    ),
  );
  add(
    et(
      "Temp",
      "ModifyAll",
      [
        tmpAdd("Tmp", 1),
        tmpAdd("Tmp", 2),
        "Tmp.ModifyAll(Val, 'ET x');",
        "Tmp.SetRange(Val, 'ET x');",
      ],
      "Error('V:[%1]', Tmp.Count());",
      TMP_VARS,
    ),
  );
  return cells;
})();
/** The helper and the two Codeunit.Run targets follow the last cell. */
const ET_HELPER = 51000 + 1 + ET_CELLS.length;
export const ERRORS_TEMP: Family = {
  name: "errors-temp",
  issue: "",
  known: [],
  testPermissions: "Disabled",
  extraIds: 3,
  support: `table 51000 "ET Row"
{
    fields
    {
        field(1; "Key"; Integer) { }
        field(2; Val; Text[30]) { }
    }
    keys { key(PK; "Key") { Clustered = true; } }
}

table 51001 "ET Auto"
{
    fields
    {
        field(1; Id; Integer) { AutoIncrement = true; }
        field(2; Val; Text[30]) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

table 51002 "ET Trig"
{
    fields
    {
        field(1; "Key"; Integer) { }
        field(2; Val; Text[30]) { }
    }
    keys { key(PK; "Key") { Clustered = true; } }

    trigger OnInsert()
    begin
        if Val = 'BAD' then
            Error('ET insert refused');
    end;

    trigger OnModify()
    begin
        if Val = 'BAD' then
            Error('ET modify refused');
    end;

    trigger OnDelete()
    begin
        if Val = 'BAD' then
            Error('ET delete refused');
    end;
}

codeunit ${ET_HELPER} "ET Helper"
{
    [TryFunction]
    procedure TryError()
    begin
        Error('ET try failed');
    end;

    [TryFunction]
    procedure TryOk()
    begin
    end;

    [TryFunction]
    procedure TryInsertThenError(K: Integer)
    begin
        InsertRow(K);
        Error('ET try failed after insert');
    end;

    [TryFunction]
    procedure TryInsertOk(K: Integer)
    begin
        InsertRow(K);
    end;

    [TryFunction]
    procedure TryErrorInfo()
    begin
        RaiseInfo();
    end;

    [TryFunction]
    procedure TryLabelError()
    begin
        Error('ET value %1', 7);
    end;

    [TryFunction]
    procedure TryInsertTempThenError(var T: Record "ET Row" temporary)
    begin
        InsertTempThenError(T);
    end;

    [TryFunction]
    procedure TryCollectKeep()
    begin
        CollectAndKeep();
    end;

    procedure InsertRow(K: Integer)
    var
        Row: Record "ET Row";
    begin
        Row.Init();
        Row."Key" := K;
        Row.Insert();
    end;

    procedure InsertThenError(K: Integer)
    begin
        InsertRow(K);
        Error('ET after insert');
    end;

    procedure InsertTempThenError(var T: Record "ET Row" temporary)
    begin
        T.Init();
        T."Key" := 1;
        T.Insert();
        Error('ET after temp insert');
    end;

    procedure RaiseInfo()
    var
        EI: ErrorInfo;
    begin
        EI.Message('ET info message');
        EI.DetailedMessage('ET info detail');
        Error(EI);
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectAndClear(): Text
    var
        EI: ErrorInfo;
        Errs: List of [ErrorInfo];
        T: Text;
    begin
        EI.Collectible(true);
        EI.Message('ET c1');
        Error(EI);
        EI.Message('ET c2');
        Error(EI);
        Errs := GetCollectedErrors();
        T := StrSubstNo('%1|%2|%3|%4', Format(HasCollectedErrors(), 0, 9), Errs.Count(), Errs.Get(1).Message, Errs.Get(2).Message);
        ClearCollectedErrors();
        exit(T + '|' + Format(HasCollectedErrors(), 0, 9));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectAndKeep()
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('ET k1');
        Error(EI);
        EI.Message('ET k2');
        Error(EI);
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectThenPlain()
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('ET p1');
        Error(EI);
        Error('ET plain stops');
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectKeepGoing(): Text
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('ET g1');
        Error(EI);
        exit('ET reached the end');
    end;

    procedure RaiseCollectibleOutside()
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('ET outside');
        Error(EI);
    end;

    procedure AddByVar(var T: Record "ET Row" temporary; K: Integer)
    begin
        T.Init();
        T."Key" := K;
        T.Insert();
    end;

    procedure AddByValue(T: Record "ET Row" temporary; K: Integer)
    begin
        T.Init();
        T."Key" := K;
        T.Insert();
    end;

    procedure AddByValueReal(T: Record "ET Row"; K: Integer)
    begin
        T.Init();
        T."Key" := K;
        T.Insert();
    end;
}

codeunit ${ET_HELPER + 1} "ET Run Fail"
{
    TableNo = "ET Row";

    trigger OnRun()
    begin
        Rec.Insert();
        Error('ET run failed');
    end;
}

codeunit ${ET_HELPER + 2} "ET Run Ok"
{
    TableNo = "ET Row";

    trigger OnRun()
    begin
        Rec.Insert();
    end;
}
`,
  handles: {},
  cells: ET_CELLS,
};

/**
 * PR-488: numbers and text builtins, for a per-cell BC differential: Round, Decimal precision, Power, div/mod, divide by
 * zero, overflow, Duration arithmetic, IncStr, the text functions at 0 / negative / past-the-end positions, SelectStr,
 * ConvertStr, DelChr, text-length overflow, Code trimming, StrSubstNo forms, case mapping beyond Danish (json-text holds the
 * Danish cells), and R1236's cheap follow-ups. Each cell reports one value through `Error('V:[%1]', ...)` or fails with the
 * runtime's own error. Every number is read through Format(x, 0, 9) (R1210: no culture formats); the case cells are
 * `depends: "locale"`. Operands are variables, so the compiler folds nothing. Cell i is codeunit BASE_ID + 1 + i; the
 * support codeunits follow the last cell (`extraIds`: the helper, a Codeunit.Run target that does nothing).
 */
const NT_VARS = [
  'H: Codeunit "NT Helper";',
  "A: Integer;",
  "B: Integer;",
  "I: Integer;",
  "BI: BigInteger;",
  "D: Decimal;",
  "Dur: Duration;",
  "T: Text;",
  "R: Boolean;",
];
const nt = (
  type: string,
  method: string,
  expr: string,
  setup: string[] = [],
  extra: { vars?: string[]; locale?: true } = {},
): Cell => ({
  type: `NT ${type}`,
  method,
  state: "nt",
  vars: [...NT_VARS, ...(extra.vars ?? [])],
  setup,
  call: `Error('V:[%1]', ${expr});`,
  ...(extra.locale === true ? { depends: "locale" as const } : {}),
});
/** A Decimal expression read with format 9. */
const f9 = (e: string): string => `Format(${e}, 0, 9)`;
const NT_CELLS: readonly Cell[] = [
  // --- Round ---
  ...(
    [
      ["half up 1.005", "1.005", "0.01", ""],
      ["half 2.5", "2.5", "1", ""],
      ["half -2.5", "-2.5", "1", ""],
      ["down 2.5", "2.5", "1", "<"],
      ["up 2.1", "2.1", "1", ">"],
      ["up -2.1", "-2.1", "1", ">"],
      ["to 0.05", "1.234", "0.05", ""],
      ["near -1.25", "-1.25", "0.1", "="],
      ["to 100", "12345", "100", ""],
      ["tiny", "0.000000000000000001", "0.00001", ""],
      ["precision 0", "1.5", "0", ""],
      ["direction x", "2.5", "1", "x"],
    ] as const
  ).map(([m, v, p, dir]) =>
    nt("Round", m, f9(dir === "" ? `Round(D, ${p})` : `Round(D, ${p}, '${dir}')`), [`D := ${v};`]),
  ),
  // --- Decimal and Power ---
  nt("Decimal", "third times 3", f9("D / 3 * 3"), ["D := 1;"]),
  nt("Decimal", "third", f9("D / 3"), ["D := 1;"]),
  nt("Decimal", "0.1 + 0.2", f9("D + 0.2"), ["D := 0.1;"]),
  nt("Decimal", "divide by zero", f9("1 / D"), ["D := 0;"]),
  nt("Decimal", "max times 10", f9("D * 10"), ["D := 79228162514264337593543950335.0;"]),
  nt("Power", "sqrt 2", f9("Power(D, 0.5)"), ["D := 2;"]),
  nt("Power", "0 ^ 0", f9("Power(D, 0)"), ["D := 0;"]),
  nt("Power", "negative cube root", f9("Power(D, 1 / 3)"), ["D := -8;"]),
  nt("Power", "10 ^ 30", f9("Power(D, 30)"), ["D := 10;"]),
  nt("Power", "2 ^ -1", f9("Power(D, -1)"), ["D := 2;"]),
  nt("Abs", "negative half", f9("Abs(D)"), ["D := -0.5;"]),
  nt("Abs", "Integer min", f9("Abs(A)"), ["A := -2147483647 - 1;"]),
  // --- Integer arithmetic ---
  nt("Int", "-7 div 2", f9("A div B"), ["A := -7;", "B := 2;"]),
  nt("Int", "7 mod -2", f9("A mod B"), ["A := 7;", "B := -2;"]),
  nt("Int", "-7 mod 2", f9("A mod B"), ["A := -7;", "B := 2;"]),
  nt("Int", "7 / 2", f9("A / B"), ["A := 7;", "B := 2;"]),
  nt("Int", "div by zero", f9("A div B"), ["A := 7;", "B := 0;"]),
  nt("Int", "mod by zero", f9("A mod B"), ["A := 7;", "B := 0;"]),
  nt("Int", "slash by zero", f9("A / B"), ["A := 7;", "B := 0;"]),
  nt("Int", "max plus 1", f9("I"), ["I := 2147483647;", "I := I + 1;"]),
  nt("Int", "square overflow", f9("I"), ["I := 100000;", "I := I * I;"]),
  nt("Int", "BigInteger max plus 1", f9("BI"), ["BI := 9223372036854775807L;", "BI := BI + 1;"]),
  nt("Int", "Decimal div", f9("D div 2"), ["D := 7.5;"]),
  // --- Duration ---
  nt("Duration", "1d1h1m1s1ms", f9("Dur"), ["Dur := 90061001;"]),
  nt("Duration", "negative", f9("Dur"), ["Dur := -1500;"]),
  nt("Duration", "times 1.5", f9("Dur * 1.5"), ["Dur := 1001;"]),
  nt("Duration", "over 3", f9("Dur / 3"), ["Dur := 1000;"]),
  nt("Duration", "zero", f9("Dur"), ["Dur := 0;"]),
  // --- IncStr ---
  ...(
    [
      ["empty", "''"],
      ["no digit", "'ABC'"],
      ["all nines", "'99'"],
      ["leading zeros", "'A0099'"],
      ["digit inside", "'A9B'"],
      ["minus sign", "'A-9'"],
      ["spaces", "'A 9 '"],
    ] as const
  ).map(([m, v]) => nt("IncStr", m, "'[' + IncStr(T) + ']'", [`T := ${v};`])),
  nt("IncStr", "by 5", "'[' + IncStr(T, 5) + ']'", ["T := 'A1';"]),
  nt("IncStr", "by -5", "'[' + IncStr(T, -5) + ']'", ["T := 'A10';"]),
  nt("IncStr", "by -5 below zero", "'[' + IncStr(T, -5) + ']'", ["T := 'A3';"]),
  // --- text edges (ASCII) ---
  ...(
    [
      ["CopyStr", "from 0", "CopyStr(T, A)", "0"],
      ["CopyStr", "from -1", "CopyStr(T, A)", "-1"],
      ["CopyStr", "length 0", "CopyStr(T, 1, A)", "0"],
      ["CopyStr", "length -1", "CopyStr(T, 1, A)", "-1"],
      ["CopyStr", "from past end", "CopyStr(T, A, 2)", "10"],
      ["CopyStr", "length past end", "CopyStr(T, 2, A)", "100"],
      ["PadStr", "to 0", "PadStr(T, A)", "0"],
      ["PadStr", "to -1", "PadStr(T, A)", "-1"],
      ["PadStr", "empty filler", "PadStr(T, A, '')", "9"],
      ["DelStr", "2 for 2", "DelStr(T, 2, A)", "2"],
      ["DelStr", "at 0", "DelStr(T, A, 1)", "0"],
      ["DelStr", "length past end", "DelStr(T, 5, A)", "100"],
      ["DelStr", "from past end", "DelStr(T, A)", "7"],
      ["DelStr", "length 0", "DelStr(T, 1, A)", "0"],
      ["DelStr", "to the end", "DelStr(T, A)", "2"],
      ["DelStr", "from -1", "DelStr(T, A)", "-1"],
      ["InsStr", "at 1", "InsStr(T, 'X', A)", "1"],
      ["InsStr", "at the end", "InsStr(T, 'X', A)", "7"],
      ["InsStr", "past the end", "InsStr(T, 'X', A)", "10"],
      ["InsStr", "at 0", "InsStr(T, 'X', A)", "0"],
      ["InsStr", "at -1", "InsStr(T, 'X', A)", "-1"],
    ] as const
  ).map(([fn, m, e, a]) => nt(fn, m, `'[' + ${e} + ']'`, ["T := 'abcdef';", `A := ${a};`])),
  nt("CopyStr", "empty text", "'[' + CopyStr(T, 1, 1) + ']'", ["T := '';"]),
  nt("PadStr", "empty text", "'[' + PadStr(T, 3, '*') + ']'", ["T := '';"]),
  nt("InsStr", "into empty", "'[' + InsStr(T, 'X', 1) + ']'", ["T := '';"]),
  ...(
    [
      ["0 of 2", "0", "'a,b'"],
      ["3 of 2", "3", "'a,b'"],
      ["1 of empty", "1", "''"],
      ["empty middle", "2", "'a,,b'"],
      ["after trailing comma", "3", "'a,b,'"],
      ["-1", "-1", "'a,b'"],
    ] as const
  ).map(([m, n, v]) =>
    nt("SelectStr", m, `'[' + SelectStr(A, T) + ']'`, [`A := ${n};`, `T := ${v};`]),
  ),
  nt("ConvertStr", "unequal lengths", "'[' + ConvertStr(T, 'ab', 'b') + ']'", ["T := 'abc';"]),
  nt("ConvertStr", "empty sets", "'[' + ConvertStr(T, '', '') + ']'", ["T := 'abc';"]),
  nt("ConvertStr", "repeated from", "'[' + ConvertStr(T, 'aa', 'xy') + ']'", ["T := 'aaa';"]),
  nt("DelChr", "default", "'[' + DelChr(T) + ']'", ["T := '  a b  ';"]),
  nt("DelChr", "both ends", "'[' + DelChr(T, '<>', 'x') + ']'", ["T := 'xxaxx';"]),
  nt("DelChr", "empty set", "'[' + DelChr(T, '=', '') + ']'", ["T := 'abc';"]),
  nt("DelChr", "leading all", "'[' + DelChr(T, '<', 'a') + ']'", ["T := 'aaa';"]),
  nt("DelChr", "two chars", "'[' + DelChr(T, '=', 'ba') + ']'", ["T := 'abcab';"]),
  nt("DelChr", "where x", "'[' + DelChr(T, 'x', 'a') + ']'", ["T := 'abc';"]),
  nt("DelChr", "where <=>", "'[' + DelChr(T, '<=>', 'a') + ']'", ["T := 'abaca';"]),
  nt("Length", "Text[5] overflow", "T5", ["T := 'abcdefg';", "T5 := T;"], {
    vars: ["T5: Text[5];"],
  }),
  nt("Length", "Code[5] overflow", "C5", ["T := 'abcdefg';", "C5 := T;"], {
    vars: ["C5: Code[5];"],
  }),
  nt("Length", "Code trims", "'[' + C10 + ']'", ["T := '  ab  ';", "C10 := T;"], {
    vars: ["C10: Code[10];"],
  }),
  nt(
    "Length",
    "CopyStr into Text[5]",
    "T5",
    ["T := 'abcdefg';", "T5 := CopyStr(T, 1, MaxStrLen(T5));"],
    { vars: ["T5: Text[5];"] },
  ),
  nt("Length", "MaxStrLen Text", f9("MaxStrLen(T)"), []),
  nt("Length", "surrogate StrLen", f9("StrLen(T)"), ["T := '😀a';"]),
  nt("Length", "surrogate CopyStr 2", f9("StrLen(CopyStr(T, 2))"), ["T := '😀a';"]),
  // --- StrSubstNo (Text arguments only) ---
  ...(
    [
      ["missing arg", "'%1 %2', 'a'"],
      ["extra arg", "'%1', 'a', 'b'"],
      ["only %3", "'%3', 'a'"],
      ["%%1", "'%%1', 'a'"],
      ["percent alone", "'100% done', 'a'"],
      ["#1### cut", "'#1###', 'abcdefg'"],
      ["#1##### pad", "'#1#####|', 'ab'"],
      ["%10", "'%10', 'a'"],
      ["%1%1", "'%1%1', 'a'"],
      ["arg holds %1", "'[%1]', 'x%1y'"],
      ["%1 empty", "'<%1>', ''"],
    ] as const
  ).map(([m, args]) => nt("StrSubstNo", m, `'[' + StrSubstNo(${args}) + ']'`)),
  // --- case mapping beyond Danish (culture data: R1210) ---
  ...(
    [
      ["UpperCase", "sharp s", "ß"],
      ["LowerCase", "dotted capital I", "İ"],
      ["UpperCase", "dotless i", "ı"],
      ["UpperCase", "dz digraph", "ǆ"],
      ["UpperCase", "fi ligature", "ﬁ"],
      ["LowerCase", "final sigma", "ΣΑΣ"],
      ["UpperCase", "n apostrophe", "ŉ"],
    ] as const
  ).map(([fn, m, v]) =>
    nt("Case", `${fn} ${m}`, `'[' + ${fn}(T) + ']' + ${f9(`StrLen(${fn}(T))`)}`, [`T := '${v}';`], {
      locale: true,
    }),
  ),
  // --- R1236's cheap follow-ups ---
  nt("Follow", "nested asserterror text", "GetLastErrorText()", ["asserterror H.AssertNothing();"]),
  nt(
    "Follow",
    "ErrorInfo enums format 9",
    `${f9("EI.ErrorType")} + '|' + ${f9("EI.Verbosity")}`,
    [],
    { vars: ["EI: ErrorInfo;"] },
  ),
  nt("Follow", "one collected counted", "H.CollectOneCount()"),
  nt("Follow", "Run ok clears last error", `${f9("R")} + '|' + GetLastErrorText()`, [
    "asserterror Error('NT before');",
    'R := Codeunit.Run(Codeunit::"NT Run Ok");',
  ]),
  nt("Follow", "HasCollectedErrors in Run", "H.HasCollectedInRun()"),
];
const NT_HELPER = 51000 + 1 + NT_CELLS.length;
export const NUMBERS_TEXT: Family = {
  name: "numbers-text",
  // PR-417: the 7 case-mapping cells are culture data; measured on bc1 (Linux BC)
  bcMeasured: { ...BC1_LINUX, task: "PR-488" },
  issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/9267",
  known: [],
  testPermissions: "Disabled",
  extraIds: 2,
  support: `codeunit ${NT_HELPER} "NT Helper"
{
    procedure AssertNothing()
    var
        X: Integer;
    begin
        asserterror X := 1;
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectOneCount(): Text
    var
        EI: ErrorInfo;
        N: Text;
    begin
        EI.Collectible(true);
        EI.Message('NT one');
        Error(EI);
        N := Format(GetCollectedErrors().Count(), 0, 9);
        ClearCollectedErrors();
        exit(N);
    end;

    procedure HasCollectedInRun(): Text
    var
        Probe: Codeunit "NT Run Ok";
    begin
        Probe.Run();
        exit(Format(Probe.Seen(), 0, 9) + '|' + Format(Probe.Count(), 0, 9));
    end;
}

codeunit ${NT_HELPER + 1} "NT Run Ok"
{
    var
        SeenHas: Boolean;
        SeenCount: Integer;

    trigger OnRun()
    begin
        SeenHas := HasCollectedErrors();
        SeenCount := GetCollectedErrors().Count();
    end;

    procedure Seen(): Boolean
    begin
        exit(SeenHas);
    end;

    procedure Count(): Integer
    begin
        exit(SeenCount);
    end;
}
`,
  handles: {},
  cells: NT_CELLS,
};

/**
 * PR-489: I/O, for a per-cell BC differential: WriteText/ReadText, Write/Read, each TextEncoding and its byte-order mark,
 * EOS, Blob fields with and without CalcFields, CopyStream, the System Application's Temp Blob and Base64 Convert, and
 * XMLport Export/Import over a stream. Uncreated streams are R1010's (left out). Each cell reports one text through
 * `Error('V:[%1]', ...)` or fails with the runtime's own error; numbers through Format(x, 0, 9). Cells that write a real
 * table use their own key (`ioKey`), never DeleteAll. A Windows or MSDos encoding of a non-ASCII letter follows the OS code
 * page, so those cells are `depends: "locale"` (Linux BC, R1210). Cell i is codeunit BASE_ID + 1 + i; tables 51000-51001,
 * XMLports 51000-51001; the helper codeunit follows the last cell (`extraIds`).
 */
let ioNext = 0;
/** A fresh key for one cell (a Blob row id, and the stem of its item codes). */
const ioKey = (): number => {
  ioNext += 1;
  return 1000 + ioNext * 10;
};
const IO_VARS = [
  'H: Codeunit "IO Helper";',
  'TB: Record "IO Blob" temporary;',
  'TB2: Record "IO Blob" temporary;',
  "OutS: OutStream;",
  "OutS2: OutStream;",
  "InS: InStream;",
  "InS2: InStream;",
  "T: Text;",
  "T2: Text;",
  "N: Integer;",
  "R: Boolean;",
];
const io = (
  type: string,
  method: string,
  setup: string[],
  expr: string,
  extra: { vars?: string[]; locale?: true } = {},
): Cell => ({
  type: `IO ${type}`,
  method,
  state: "io",
  vars: [...IO_VARS, ...(extra.vars ?? [])],
  setup,
  call: `Error('V:[%1]', ${expr});`,
  ...(extra.locale === true ? { depends: "locale" as const } : {}),
});
// numbers through `n9` (Format(x, 0, 9)), declared with record-filters above
/** Write lines into TB, then open TB for reading. */
const ioWrite = (lines: string[], enc?: string): string[] => [
  enc === undefined
    ? "TB.Data.CreateOutStream(OutS);"
    : `TB.Data.CreateOutStream(OutS, TextEncoding::${enc});`,
  ...lines,
  enc === undefined
    ? "TB.Data.CreateInStream(InS);"
    : `TB.Data.CreateInStream(InS, TextEncoding::${enc});`,
];
const IO_ENCODINGS = ["UTF8", "UTF16", "Windows", "MSDos"] as const;
const IO_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  const add = (c: Cell): void => {
    cells.push(c);
  };
  // --- WriteText / ReadText / Write / Read ---
  add(
    io(
      "Text",
      "three lines",
      ioWrite(["OutS.WriteText('ab');", "OutS.WriteText();", "OutS.WriteText('cd');"]),
      "H.ReadAll(InS)",
    ),
  );
  add(
    io("Text", "WriteText length 3", ioWrite(["OutS.WriteText('abcdef', 3);"]), "H.ReadAll(InS)"),
  );
  add(
    io(
      "Text",
      "ReadText length 2",
      [...ioWrite(["OutS.WriteText('abcdef');"]), "N := InS.ReadText(T, 2);"],
      `T + '|' + ${n9("N")}`,
    ),
  );
  add(
    io(
      "Text",
      "ReadText returns",
      [...ioWrite(["OutS.WriteText('abc');"]), "N := InS.ReadText(T);"],
      `T + '|' + ${n9("N")}`,
    ),
  );
  add(
    io(
      "Text",
      "ReadText at EOS",
      [
        ...ioWrite(["OutS.WriteText('a');"]),
        "InS.ReadText(T);",
        "T2 := 'x';",
        "N := InS.ReadText(T2);",
      ],
      `'[' + T2 + ']' + ${n9("N")}`,
    ),
  );
  add(
    io(
      "Text",
      "Write then ReadAll",
      ioWrite(["OutS.Write('ab');"]),
      `H.ReadAll(InS) + ${n9("TB.Data.Length")}`,
    ),
  );
  add(
    io(
      "Text",
      "Write twice Read",
      [...ioWrite(["OutS.Write('ab');", "OutS.Write('cd');"]), "InS.Read(T);", "InS.Read(T2);"],
      "T + '|' + T2",
    ),
  );
  add(
    io(
      "Text",
      "Integer binary",
      [...ioWrite(["N := 258;", "OutS.Write(N);"]), "N := 0;", "InS.Read(N);"],
      `${n9("N")} + '|' + ${n9("TB.Data.Length")}`,
    ),
  );
  add(io("Text", "WriteText length", ioWrite(["OutS.WriteText('abc');"]), n9("TB.Data.Length")));
  add(
    io(
      "Text",
      "empty WriteText",
      ioWrite(["OutS.WriteText('');"]),
      `${n9("TB.Data.Length")} + '|' + ${n9("TB.Data.HasValue")}`,
    ),
  );
  add(
    io(
      "Text",
      "WriteText newline only",
      ioWrite(["OutS.WriteText();"]),
      `${n9("TB.Data.Length")} + '|' + H.ReadAll(InS)`,
    ),
  );
  add(
    io(
      "Text",
      "bytes of two lines",
      ioWrite(["OutS.WriteText('a');", "OutS.WriteText();", "OutS.WriteText('b');"]),
      "H.Bytes(InS, 8)",
    ),
  );
  // --- EOS ---
  add(io("EOS", "new Blob", ["TB.Data.CreateInStream(InS);"], n9("InS.EOS")));
  add(
    io(
      "EOS",
      "after last line",
      [...ioWrite(["OutS.WriteText('a');"]), "InS.ReadText(T);"],
      n9("InS.EOS"),
    ),
  );
  add(
    io(
      "EOS",
      "between lines",
      [
        ...ioWrite(["OutS.WriteText('a');", "OutS.WriteText();", "OutS.WriteText('b');"]),
        "InS.ReadText(T);",
      ],
      n9("InS.EOS"),
    ),
  );
  add(io("EOS", "before reading", ioWrite(["OutS.WriteText('a');"]), n9("InS.EOS")));
  // --- encodings: length, first bytes, read back ---
  for (const enc of IO_ENCODINGS) {
    for (const [name, v] of [
      ["a", "a"],
      ["ae letter", "æ"],
    ] as const) {
      const codePage = (enc === "Windows" || enc === "MSDos") && name !== "a";
      add(
        io(
          "Enc",
          `${enc} ${name}`,
          [
            ...ioWrite([`OutS.WriteText('${v}');`], enc),
            `TB.Data.CreateInStream(InS2, TextEncoding::${enc});`,
          ],
          `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 6) + '|' + H.ReadAll(InS2)`,
          codePage ? { locale: true } : {},
        ),
      );
    }
  }
  add(
    io(
      "Enc",
      "UTF16 read as UTF8",
      [
        ...ioWrite(["OutS.WriteText('a');"], "UTF16"),
        "TB.Data.CreateInStream(InS2, TextEncoding::UTF8);",
      ],
      "H.Bytes(InS2, 6) + '|' + H.ReadAll(InS2)",
    ),
  );
  add(
    io(
      "Enc",
      "UTF8 ae read as UTF16",
      [
        ...ioWrite(["OutS.WriteText('æ');"], "UTF8"),
        "TB.Data.CreateInStream(InS2, TextEncoding::UTF16);",
      ],
      n9("StrLen(H.ReadAll(InS2))"),
    ),
  );
  add(
    io(
      "Enc",
      "UTF8 ae read as Windows",
      [
        ...ioWrite(["OutS.WriteText('æ');"], "UTF8"),
        "TB.Data.CreateInStream(InS2, TextEncoding::Windows);",
      ],
      "H.ReadAll(InS2)",
      { locale: true },
    ),
  );
  add(
    io(
      "Enc",
      "UTF8 ae read without encoding",
      [...ioWrite(["OutS.WriteText('æ');"], "UTF8"), "TB.Data.CreateInStream(InS2);"],
      "H.ReadAll(InS2)",
      // no encoding: the default one decodes the non-ASCII bytes by the OS code page
      { locale: true },
    ),
  );
  add(
    io(
      "Enc",
      "default ae bytes",
      ioWrite(["OutS.WriteText('æ');"]),
      `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 6)`,
      { locale: true },
    ),
  );
  // --- Blob fields on a real table ---
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "HasValue without CalcFields",
        [`H.InsertBlob(${k}, 'abc');`, `B.Get(${k});`],
        `${n9("B.Data.HasValue")} + '|' + ${n9("B.Data.Length")}`,
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "after CalcFields",
        [
          `H.InsertBlob(${k}, 'abc');`,
          `B.Get(${k});`,
          "B.CalcFields(Data);",
          "B.Data.CreateInStream(InS);",
        ],
        `${n9("B.Data.Length")} + '|' + H.ReadAll(InS)`,
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "Clear then Modify",
        [
          `H.InsertBlob(${k}, 'abc');`,
          `B.Get(${k});`,
          "Clear(B.Data);",
          "B.Modify();",
          `B.Get(${k});`,
          "B.CalcFields(Data);",
        ],
        n9("B.Data.HasValue"),
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "rewrite and Modify",
        [
          `H.InsertBlob(${k}, 'a');`,
          `B.Get(${k});`,
          "B.Data.CreateOutStream(OutS);",
          "OutS.WriteText('bb');",
          "B.Modify();",
          "Clear(B);",
          `B.Get(${k});`,
          "B.CalcFields(Data);",
          "B.Data.CreateInStream(InS);",
        ],
        "H.ReadAll(InS)",
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "never written",
        ["B.Init();", `B.Id := ${k};`, "B.Insert();", `B.Get(${k});`, "B.CalcFields(Data);"],
        `${n9("B.Data.HasValue")} + '|' + ${n9("B.Data.Length")}`,
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "empty text written",
        [`H.InsertBlob(${k}, '');`, `B.Get(${k});`, "B.CalcFields(Data);"],
        `${n9("B.Data.HasValue")} + '|' + ${n9("B.Data.Length")}`,
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Field",
        "read without CalcFields",
        [`H.InsertBlob(${k}, 'abc');`, `B.Get(${k});`, "B.Data.CreateInStream(InS);"],
        "'[' + H.ReadAll(InS) + ']'",
        { vars: ['B: Record "IO Blob";'] },
      ),
    );
  }
  // --- CopyStream ---
  add(
    io(
      "Copy",
      "whole",
      [
        ...ioWrite(["OutS.WriteText('ab');", "OutS.WriteText();", "OutS.WriteText('cd');"]),
        "TB2.Data.CreateOutStream(OutS2);",
        "CopyStream(OutS2, InS);",
        "TB2.Data.CreateInStream(InS2);",
      ],
      "H.ReadAll(InS2)",
    ),
  );
  add(
    io(
      "Copy",
      "2 bytes",
      [
        ...ioWrite(["OutS.WriteText('abcdef');"]),
        "TB2.Data.CreateOutStream(OutS2);",
        "CopyStream(OutS2, InS, 2);",
        "TB2.Data.CreateInStream(InS2);",
      ],
      `H.ReadAll(InS2) + '|' + H.ReadAll(InS)`,
    ),
  );
  add(
    io(
      "Copy",
      "from empty",
      [
        "TB.Data.CreateInStream(InS);",
        "TB2.Data.CreateOutStream(OutS2);",
        "R := CopyStream(OutS2, InS);",
      ],
      `${n9("R")} + '|' + ${n9("TB2.Data.Length")}`,
    ),
  );
  add(
    io(
      "Copy",
      "returns",
      [
        ...ioWrite(["OutS.WriteText('ab');"]),
        "TB2.Data.CreateOutStream(OutS2);",
        "R := CopyStream(OutS2, InS);",
      ],
      `${n9("R")} + '|' + ${n9("TB2.Data.Length")}`,
    ),
  );
  add(
    io(
      "Copy",
      "after partial read",
      [
        ...ioWrite(["OutS.WriteText('ab');", "OutS.WriteText();", "OutS.WriteText('cd');"]),
        "InS.ReadText(T);",
        "TB2.Data.CreateOutStream(OutS2);",
        "CopyStream(OutS2, InS);",
        "TB2.Data.CreateInStream(InS2);",
      ],
      "H.ReadAll(InS2)",
    ),
  );
  add(
    io(
      "Copy",
      "Temp Blob to Temp Blob",
      [
        "Blob1.CreateOutStream(OutS);",
        "OutS.WriteText('ab');",
        "Blob1.CreateInStream(InS);",
        "Blob2.CreateOutStream(OutS2);",
        "CopyStream(OutS2, InS);",
        "Blob2.CreateInStream(InS2);",
      ],
      `H.ReadAll(InS2) + ${n9("Blob2.Length()")}`,
      { vars: ['Blob1: Codeunit "Temp Blob";', 'Blob2: Codeunit "Temp Blob";'] },
    ),
  );
  // --- Temp Blob ---
  const TEMP_BLOB = { vars: ['Blob1: Codeunit "Temp Blob";'] };
  add(
    io(
      "TempBlob",
      "round trip",
      ["Blob1.CreateOutStream(OutS);", "OutS.WriteText('ab');", "Blob1.CreateInStream(InS);"],
      `H.ReadAll(InS) + ${n9("Blob1.Length()")} + '|' + ${n9("Blob1.HasValue()")}`,
      TEMP_BLOB,
    ),
  );
  add(
    io(
      "TempBlob",
      "empty",
      [],
      `${n9("Blob1.Length()")} + '|' + ${n9("Blob1.HasValue()")}`,
      TEMP_BLOB,
    ),
  );
  add(
    io(
      "TempBlob",
      "UTF16 a",
      ["Blob1.CreateOutStream(OutS, TextEncoding::UTF16);", "OutS.WriteText('a');"],
      n9("Blob1.Length()"),
      TEMP_BLOB,
    ),
  );
  add(
    io(
      "TempBlob",
      "read twice",
      [
        "Blob1.CreateOutStream(OutS);",
        "OutS.WriteText('ab');",
        "Blob1.CreateInStream(InS);",
        "T := H.ReadAll(InS);",
        "Blob1.CreateInStream(InS2);",
      ],
      "T + H.ReadAll(InS2)",
      TEMP_BLOB,
    ),
  );
  // --- Base64 Convert ---
  const B64 = { vars: ['B64: Codeunit "Base64 Convert";'] };
  add(io("Base64", "To abc", [], "B64.ToBase64('abc')", B64));
  add(io("Base64", "From YWJj", [], "B64.FromBase64('YWJj')", B64));
  add(io("Base64", "To ae", [], "B64.ToBase64('æ')", B64));
  add(io("Base64", "To ae UTF8", [], "B64.ToBase64('æ', TextEncoding::UTF8)", B64));
  add(io("Base64", "From w6Y= UTF8", [], "B64.FromBase64('w6Y=', TextEncoding::UTF8)", B64));
  add(io("Base64", "From invalid", [], "B64.FromBase64('not base64!')", B64));
  add(io("Base64", "To empty", [], "'[' + B64.ToBase64('') + ']'", B64));
  add(io("Base64", "From empty", [], "'[' + B64.FromBase64('') + ']'", B64));
  add(io("Base64", "To stream", ioWrite(["OutS.WriteText('abc');"]), "B64.ToBase64(InS)", B64));
  add(
    io(
      "Base64",
      "From to stream",
      [
        "TB.Data.CreateOutStream(OutS);",
        "B64.FromBase64('YWJj', OutS);",
        "TB.Data.CreateInStream(InS);",
      ],
      "H.ReadAll(InS)",
      B64,
    ),
  );
  add(
    io("Base64", "To ae Windows", [], "B64.ToBase64('æ', TextEncoding::Windows)", {
      ...B64,
      locale: true,
    }),
  );
  add(io("Base64", "From padding missing", [], "B64.FromBase64('YWI')", B64));
  // --- XMLport over a stream ---
  const XP = (port: string) => ({ vars: [`Xp: XmlPort "${port}";`, 'Item: Record "IO Item";'] });
  {
    const k = ioKey();
    add(
      io(
        "Xmlport",
        "Export Xml",
        [
          `H.InsertItems('X${k}');`,
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
          "Xp.SetTableView(Item);",
          "TB.Data.CreateOutStream(OutS);",
          "Xp.SetDestination(OutS);",
          "Xp.Export();",
          "TB.Data.CreateInStream(InS);",
        ],
        "H.ReadAll(InS)",
        // the UTF-16 export read through the default encoding: its byte-order mark and NULs decode by the OS code page
        { ...XP("IO Items Xml"), locale: true },
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Xmlport",
        "Export Csv",
        [
          `H.InsertItems('X${k}');`,
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
          "Xp.SetTableView(Item);",
          "TB.Data.CreateOutStream(OutS);",
          "Xp.SetDestination(OutS);",
          "Xp.Export();",
          "TB.Data.CreateInStream(InS);",
        ],
        "H.ReadAll(InS)",
        XP("IO Items Csv"),
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Xmlport",
        "Import Xml",
        [
          ...ioWrite([
            `OutS.WriteText('<Items><Item><Code>X${k}1</Code><Name>N1</Name></Item><Item><Code>X${k}2</Code><Name>N2</Name></Item></Items>');`,
          ]),
          "Xp.SetSource(InS);",
          "Xp.Import();",
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
        ],
        `${n9("Item.Count()")} + '|' + H.ItemNames('X${k}')`,
        XP("IO Items Xml"),
      ),
    );
  }
  {
    const k = ioKey();
    add(
      io(
        "Xmlport",
        "Import Csv",
        [
          ...ioWrite([
            `OutS.WriteText('X${k}1,N1');`,
            "OutS.WriteText();",
            `OutS.WriteText('X${k}2,N2');`,
          ]),
          "Xp.SetSource(InS);",
          "Xp.Import();",
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
        ],
        `${n9("Item.Count()")} + '|' + H.ItemNames('X${k}')`,
        XP("IO Items Csv"),
      ),
    );
  }
  add(
    io(
      "Xmlport",
      "Import malformed Xml",
      [...ioWrite(["OutS.WriteText('<Items><Item>');"]), "Xp.SetSource(InS);", "Xp.Import();"],
      "'reached'",
      XP("IO Items Xml"),
    ),
  );
  add(
    io(
      "Xmlport",
      "Import empty stream",
      ["TB.Data.CreateInStream(InS);", "Xp.SetSource(InS);", "Xp.Import();"],
      "'reached'",
      XP("IO Items Xml"),
    ),
  );
  {
    const k = ioKey();
    add(
      io(
        "Xmlport",
        "Import Xml with declaration",
        [
          ...ioWrite([
            `OutS.WriteText('<?xml version="1.0" encoding="UTF-8"?><Items><Item><Code>X${k}1</Code><Name>N1</Name></Item></Items>');`,
          ]),
          "Xp.SetSource(InS);",
          "Xp.Import();",
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
        ],
        n9("Item.Count()"),
        XP("IO Items Xml"),
      ),
    );
  }
  return cells;
})();
const IO_HELPER = 51000 + 1 + IO_CELLS.length;
export const IO_STREAMS: Family = {
  name: "io-streams",
  // PR-417: the 6 code-page cells are culture data; measured on bc1 (Linux BC)
  bcMeasured: { ...BC1_LINUX, task: "PR-489" },
  issue: "",
  known: [],
  testPermissions: "Disabled",
  extraIds: 1,
  dependencies: [
    {
      id: "63ca2fa4-4f03-4f2b-a480-172fef340d3f",
      name: "System Application",
      publisher: "Microsoft",
      version: "28.0.0.0",
    },
  ],
  support: `table 51000 "IO Blob"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

table 51001 "IO Item"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Name; Text[30]) { }
    }
    keys { key(PK; Code) { Clustered = true; } }
}

xmlport 51000 "IO Items Xml"
{
    Format = Xml;
    Direction = Both;
    schema
    {
        textelement(Items)
        {
            tableelement(Item; "IO Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51001 "IO Items Csv"
{
    Format = VariableText;
    Direction = Both;
    schema
    {
        textelement(Root)
        {
            tableelement(Item; "IO Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

codeunit ${IO_HELPER} "IO Helper"
{
    /// Every line to the end, each followed by '|'.
    procedure ReadAll(var InS: InStream): Text
    var
        Line: Text;
        Result: Text;
    begin
        while not InS.EOS do begin
            InS.ReadText(Line);
            Result += Line + '|';
        end;
        exit(Result);
    end;

    /// The first N bytes as numbers, space separated.
    procedure Bytes(var InS: InStream; N: Integer): Text
    var
        B: Byte;
        V: Integer;
        I: Integer;
        Result: Text;
    begin
        while (I < N) and not InS.EOS do begin
            InS.Read(B);
            V := B;
            Result += Format(V, 0, 9) + ' ';
            I += 1;
        end;
        exit(Result);
    end;

    procedure InsertBlob(K: Integer; V: Text)
    var
        B: Record "IO Blob";
        OutS: OutStream;
    begin
        B.Init();
        B.Id := K;
        B.Data.CreateOutStream(OutS);
        OutS.WriteText(V);
        B.Insert();
    end;

    procedure InsertItems(Stem: Text)
    var
        Item: Record "IO Item";
    begin
        Item.Init();
        Item.Code := CopyStr(Stem + '1', 1, 20);
        Item.Name := 'N1';
        Item.Insert();
        Item.Init();
        Item.Code := CopyStr(Stem + '2', 1, 20);
        Item.Name := 'N2';
        Item.Insert();
    end;

    procedure ItemNames(Stem: Text): Text
    var
        Item: Record "IO Item";
        Result: Text;
    begin
        Item.SetFilter(Code, '%1', Stem + '*');
        if Item.FindSet() then
            repeat
                Result += Item.Code + '=' + Item.Name + ';';
            until Item.Next() = 0;
        exit(Result);
    end;
}
`,
  handles: {},
  cells: IO_CELLS,
};

/**
 * PR-500: errors-temp-2, R1236's follow-up items 2-11 as a second per-cell BC differential. Same rules as errors-temp: a cell
 * that writes a real table counts its own key range (`e2Key`) and never DeleteAll; booleans and numbers go through
 * Format(x, 0, 9); each cell reports through `Error('V:[...]')` or fails with the runtime's own error. The two kinds of cell
 * that stopped early on both runtimes in errors-temp are re-shaped: a write inside a try with the return value UNUSED, and
 * Codeunit.Run after a Commit (not after an uncommitted write). Cells that Commit (Run.AfterCommit*, Run.CommitInTarget*,
 * Assert.CommitInside) leave rows behind: on BC run the app again only after uninstalling it WITH its data. Cell i is
 * codeunit BASE_ID + 1 + i; tables 51000-51002; the helper and ten Run targets follow the last cell (`extraIds`).
 */
let e2Next = 0;
/** A fresh key range of 10 for one cell. */
const e2Key = (): number => {
  e2Next += 1;
  return 1000 + e2Next * 10;
};
const E2_VARS = [
  'H: Codeunit "E2 Helper";',
  'Row: Record "E2 Row";',
  'Row2: Record "E2 Row";',
  "R: Boolean;",
];
const e2 = (
  type: string,
  method: string,
  setup: string[],
  call: string,
  vars: string[] = [],
): Cell => ({
  type: `E2 ${type}`,
  method,
  state: "e2",
  vars: [...E2_VARS, ...vars],
  setup,
  call,
});
const e2Range = (k: number): string => `Row2.SetRange("Key", ${k}, ${k + 9});`;
const E2_TMP = ['Tmp: Record "E2 Row" temporary;', 'Tmp2: Record "E2 Row" temporary;'];
const E2_EI = ["EI: ErrorInfo;"];
const E2_TRIG = ['T: Record "E2 Trig" temporary;'];
/** A new row of `Row` with its key, not inserted. */
const e2Row = (k: number): string[] => ["Row.Init();", `Row."Key" := ${k};`];
const E2_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  const add = (c: Cell): void => {
    cells.push(c);
  };
  // --- item 2: collectible errors read through a Codeunit.Run boundary ---
  add(
    e2(
      "Collect",
      "HasInRun",
      [...e2Row(1), 'R := Codeunit.Run(Codeunit::"E2 Run Probe", Row);'],
      "Error('V:[%1|%2]', Format(R, 0, 9), Row.Val);",
    ),
  );
  add(e2("Collect", "KeepGoingCount", [], "Error('V:[%1]', H.CollectKeepGoingCount());"));
  add(
    e2(
      "Collect",
      "CountInRun",
      [...e2Row(1), 'R := Codeunit.Run(Codeunit::"E2 Run Collect", Row);'],
      "Error('V:[%1|%2]', Format(R, 0, 9), Row.Val);",
    ),
  );
  // --- item 3: TryFunction, re-shaped (return value unused), Commit, Run ---
  {
    const k = e2Key();
    add(
      e2(
        "Try",
        "WriteUnused",
        [`H.TryInsertOk(${k});`, e2Range(k)],
        "Error('V:[%1]', Row2.Count());",
      ),
    );
  }
  {
    const k = e2Key();
    add(
      e2(
        "Try",
        "WriteUnusedThenError",
        [`asserterror H.TryInsertThenError(${k});`, e2Range(k)],
        "Error('V:[%1|%2]', Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  add(
    e2(
      "Try",
      "CommitInside",
      ["R := H.TryCommit();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  add(
    e2(
      "Try",
      "CallsRun",
      [...e2Row(1), "R := H.TryRunProbe(Row);"],
      "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row.Val, GetLastErrorText());",
    ),
  );
  add(
    e2(
      "Try",
      "CallsRunErr",
      ["R := H.TryRunErr();"],
      "Error('V:[%1|%2]', Format(R, 0, 9), GetLastErrorText());",
    ),
  );
  // --- item 4: Codeunit.Run ---
  add(
    e2(
      "Run",
      "ProbeSeesLastError",
      [
        "asserterror Error('E2 before');",
        ...e2Row(1),
        'R := Codeunit.Run(Codeunit::"E2 Run Last", Row);',
      ],
      "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row.Val, GetLastErrorText());",
    ),
  );
  add(
    e2(
      "Run",
      "Nested",
      [...e2Row(1), 'R := Codeunit.Run(Codeunit::"E2 Run Nest", Row);'],
      "Error('V:[%1|%2]', Format(R, 0, 9), Row.Val);",
    ),
  );
  add(
    e2(
      "Run",
      "NestedFail",
      [...e2Row(1), 'R := Codeunit.Run(Codeunit::"E2 Run NestFail", Row);'],
      "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row.Val, GetLastErrorText());",
    ),
  );
  for (const [method, target, fails] of [
    ["AfterCommitOk", "E2 Run Ok", false],
    ["AfterCommitFail", "E2 Run Fail", true],
  ] as const) {
    const k = e2Key();
    add(
      e2(
        "Run",
        method,
        [
          `H.InsertRow(${k});`,
          "Commit();",
          ...e2Row(k + 1),
          `R := Codeunit.Run(Codeunit::"${target}", Row);`,
          e2Range(k),
        ],
        fails
          ? "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row2.Count(), GetLastErrorText());"
          : "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  for (const [method, target, fails] of [
    ["CommitInTarget", "E2 Run Commit", true],
    ["CommitInTargetOk", "E2 Run CommitOk", false],
  ] as const) {
    const k = e2Key();
    add(
      e2(
        "Run",
        method,
        [...e2Row(k), `R := Codeunit.Run(Codeunit::"${target}", Row);`, e2Range(k)],
        fails
          ? "Error('V:[%1|%2|%3]', Format(R, 0, 9), Row2.Count(), GetLastErrorText());"
          : "Error('V:[%1|%2]', Format(R, 0, 9), Row2.Count());",
      ),
    );
  }
  // --- item 5: ErrorInfo ---
  add(
    e2(
      "Info",
      "TypeInternal",
      [
        "EI.Message('E2 internal');",
        "EI.ErrorType(ErrorType::Internal);",
        "asserterror Error(EI);",
      ],
      "Error('V:[%1|%2]', GetLastErrorText(), Format(EI.ErrorType, 0, 9));",
      E2_EI,
    ),
  );
  add(
    e2(
      "Info",
      "RecordId",
      [...e2Row(5), "EI.RecordId(Row.RecordId);"],
      "Error('V:[%1|%2]', Format(EI.RecordId.TableNo, 0, 9), Format(EI.RecordId = Row.RecordId, 0, 9));",
      E2_EI,
    ),
  );
  add(
    e2(
      "Info",
      "TableId",
      ["EI.TableId(51000);"],
      "Error('V:[%1]', Format(EI.TableId, 0, 9));",
      E2_EI,
    ),
  );
  add(
    e2("Info", "FieldNo", ["EI.FieldNo(2);"], "Error('V:[%1]', Format(EI.FieldNo, 0, 9));", E2_EI),
  );
  add(
    e2(
      "Info",
      "RefDefaults",
      [],
      "Error('V:[%1|%2|%3]', Format(EI.TableId, 0, 9), Format(EI.FieldNo, 0, 9), Format(EI.RecordId.TableNo, 0, 9));",
      E2_EI,
    ),
  );
  add(e2("Info", "CollectedTitleDetail", [], "Error('V:[%1]', H.CollectedTitleDetail());"));
  add(e2("Info", "CollectedRefs", [], "Error('V:[%1]', H.CollectedRefs());"));
  add(
    e2(
      "Info",
      // `.AsInteger()` does not compile on these two types (AL0132), so the values are read through format 9
      "EnumSetFormat9",
      ["EI.ErrorType(ErrorType::Internal);", "EI.Verbosity(Verbosity::Warning);"],
      "Error('V:[%1|%2]', Format(EI.ErrorType, 0, 9), Format(EI.Verbosity, 0, 9));",
      E2_EI,
    ),
  );
  // --- item 6: collect scopes ---
  add(e2("Collect", "Nested", [], "Error('V:[%1]', H.CollectNested());"));
  add(e2("Collect", "GetClear", [], "Error('V:[%1]', H.CollectGetClear());"));
  add(e2("Collect", "TryInScope", [], "Error('V:[%1]', H.CollectTryInScope());"));
  // --- item 7: a Commit inside the asserterror body ---
  {
    const k = e2Key();
    add(
      e2(
        "Assert",
        "CommitInside",
        [`asserterror H.InsertCommitThenError(${k});`, e2Range(k)],
        "Error('V:[%1|%2]', Row2.Count(), GetLastErrorText());",
      ),
    );
  }
  // --- item 8: triggers of a temporary record ---
  const bad = (n: number): string[] => [
    "T.Init();",
    `T."Key" := ${n};`,
    "T.Val := 'BAD';",
    "T.Insert(false);",
  ];
  add(
    e2(
      "Trig",
      "InsertTrueRow",
      ["T.Init();", 'T."Key" := 1;', "T.Val := 'BAD';", "asserterror T.Insert(true);"],
      "Error('V:[%1|%2]', T.Count(), GetLastErrorText());",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "ModifyFalseBad",
      [...bad(1), "T.Val := 'BAD';", "T.Modify(false);"],
      "Error('V:[%1|%2]', T.Count(), T.Val);",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "DeleteFalseBad",
      [...bad(1), "T.Delete(false);"],
      "Error('V:[%1]', T.Count());",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "DeleteAllTrueBad",
      [...bad(1), ...bad(2), "asserterror T.DeleteAll(true);"],
      "Error('V:[%1|%2]', T.Count(), GetLastErrorText());",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "DeleteAllFalseBad",
      [...bad(1), ...bad(2), "T.DeleteAll(false);"],
      "Error('V:[%1]', T.Count());",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "ValidateBad",
      ["T.Init();", 'T."Key" := 1;', "asserterror T.Validate(Val, 'NOPE');"],
      "Error('V:[%1|%2]', GetLastErrorText(), T.Val);",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "RenameOk",
      ["T.Init();", 'T."Key" := 1;', "T.Val := 'ok';", "T.Insert(false);", "T.Rename(2);"],
      "Error('V:[%1|%2]', T.Count(), T.\"Key\");",
      E2_TRIG,
    ),
  );
  add(
    e2(
      "Trig",
      "RenameBad",
      [...bad(1), "asserterror T.Rename(2);"],
      "Error('V:[%1|%2]', GetLastErrorText(), T.\"Key\");",
      E2_TRIG,
    ),
  );
  // --- item 9: Copy shared, filters on each side ---
  const three = [tmpAdd("Tmp2", 1), tmpAdd("Tmp2", 2), tmpAdd("Tmp2", 3)];
  const filters =
    'Error(\'V:[%1|%2|%3|%4]\', Tmp.Count(), Tmp2.Count(), Tmp.GetFilter("Key"), Tmp2.GetFilter("Key"));';
  add(
    e2(
      "Temp",
      "CopySharedSetRange",
      [...three, "Tmp.Copy(Tmp2, true);", 'Tmp.SetRange("Key", 2);'],
      filters,
      E2_TMP,
    ),
  );
  add(
    e2(
      "Temp",
      "CopySharedSetRangeSource",
      [...three, "Tmp.Copy(Tmp2, true);", 'Tmp2.SetRange("Key", 3);'],
      filters,
      E2_TMP,
    ),
  );
  add(
    e2(
      "Temp",
      "CopySharedResetCopy",
      [...three, 'Tmp2.SetRange("Key", 2);', "Tmp.Copy(Tmp2, true);", "Tmp.Reset();"],
      filters,
      E2_TMP,
    ),
  );
  add(
    e2(
      "Temp",
      "CopySharedResetSource",
      [...three, 'Tmp2.SetRange("Key", 2);', "Tmp.Copy(Tmp2, true);", "Tmp2.Reset();"],
      filters,
      E2_TMP,
    ),
  );
  // --- item 10: var vs value ---
  {
    const k = e2Key();
    add(
      e2(
        "Temp",
        "RealToTempParam",
        [`H.AddByValueTemp(Row, ${k});`, e2Range(k)],
        "Error('V:[%1]', Row2.Count());",
      ),
    );
  }
  add(
    e2(
      "Temp",
      "TempReturn",
      ["Tmp := H.MakeTemp(7);"],
      "Error('V:[%1|%2]', Tmp.Count(), Format(Tmp.IsTemporary, 0, 9));",
      E2_TMP,
    ),
  );
  add(
    e2(
      "Temp",
      "TempReturnToReal",
      ["Row := H.MakeTemp(7);"],
      "Error('V:[%1|%2]', Row.\"Key\", Format(Row.IsTemporary, 0, 9));",
    ),
  );
  // --- item 11: AutoIncrement ---
  add(
    e2(
      "Auto",
      "TempExplicit",
      ["TA.Id := 5;", "TA.Val := 'a';", "TA.Insert();"],
      "Error('V:[%1|%2]', TA.Id, TA.Count());",
      ['TA: Record "E2 Auto" temporary;'],
    ),
  );
  add(
    e2(
      "Auto",
      "TempExplicitThenZero",
      [
        "TA.Id := 5;",
        "TA.Val := 'a';",
        "TA.Insert();",
        "TA.Id := 0;",
        "TA.Val := 'b';",
        "TA.Insert();",
      ],
      "Error('V:[%1|%2]', TA.Id, TA.Count());",
      ['TA: Record "E2 Auto" temporary;'],
    ),
  );
  add(
    e2(
      "Auto",
      "RealAfterRollback",
      [
        "RA.Val := 'a';",
        "RA.Insert();",
        "I1 := RA.Id;",
        "asserterror H.InsertAutoThenError();",
        "RA2.Val := 'c';",
        "RA2.Insert();",
      ],
      "Error('V:[%1]', Format(RA2.Id - I1, 0, 9));",
      ['RA: Record "E2 Auto";', 'RA2: Record "E2 Auto";', "I1: Integer;"],
    ),
  );
  return cells;
})();
const E2_HELPER = 51000 + 1 + E2_CELLS.length;
export const ERRORS_TEMP_2: Family = {
  name: "errors-temp-2",
  issue: "",
  known: [],
  testPermissions: "Disabled",
  extraIds: 11,
  support: `table 51000 "E2 Row"
{
    fields
    {
        field(1; "Key"; Integer) { }
        field(2; Val; Text[30]) { }
    }
    keys { key(PK; "Key") { Clustered = true; } }
}

table 51001 "E2 Auto"
{
    fields
    {
        field(1; Id; Integer) { AutoIncrement = true; }
        field(2; Val; Text[30]) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

table 51002 "E2 Trig"
{
    fields
    {
        field(1; "Key"; Integer) { }
        field(2; Val; Text[30])
        {
            trigger OnValidate()
            begin
                if Val = 'NOPE' then
                    Error('E2 validate refused');
            end;
        }
    }
    keys { key(PK; "Key") { Clustered = true; } }

    trigger OnInsert()
    begin
        if Val = 'BAD' then
            Error('E2 insert refused');
    end;

    trigger OnModify()
    begin
        if Val = 'BAD' then
            Error('E2 modify refused');
    end;

    trigger OnDelete()
    begin
        if Val = 'BAD' then
            Error('E2 delete refused');
    end;

    trigger OnRename()
    begin
        if Val = 'BAD' then
            Error('E2 rename refused');
    end;
}

codeunit ${E2_HELPER} "E2 Helper"
{
    [TryFunction]
    procedure TryInsertOk(K: Integer)
    begin
        InsertRow(K);
    end;

    [TryFunction]
    procedure TryInsertThenError(K: Integer)
    begin
        InsertRow(K);
        Error('E2 try failed after insert');
    end;

    [TryFunction]
    procedure TryCommit()
    begin
        Commit();
    end;

    [TryFunction]
    procedure TryRunProbe(var Row: Record "E2 Row")
    begin
        Codeunit.Run(Codeunit::"E2 Run Probe", Row);
    end;

    [TryFunction]
    procedure TryRunErr()
    begin
        Codeunit.Run(Codeunit::"E2 Run Err");
    end;

    [TryFunction]
    procedure TryRaiseCollectible()
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('E2 try collectible');
        Error(EI);
    end;

    procedure InsertRow(K: Integer)
    var
        Row: Record "E2 Row";
    begin
        Row.Init();
        Row."Key" := K;
        Row.Insert();
    end;

    procedure InsertCommitThenError(K: Integer)
    begin
        InsertRow(K);
        Commit();
        Error('E2 after commit');
    end;

    procedure InsertAutoThenError()
    var
        RA: Record "E2 Auto";
    begin
        RA.Val := 'x';
        RA.Insert();
        Error('E2 auto rolled back');
    end;

    procedure AddByValueTemp(T: Record "E2 Row" temporary; K: Integer)
    begin
        T.Init();
        T."Key" := K;
        T.Insert();
    end;

    procedure MakeTemp(K: Integer) Result: Record "E2 Row" temporary
    begin
        Result.Init();
        Result."Key" := K;
        Result.Insert();
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectKeepGoingCount(): Text
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('E2 g1');
        Error(EI);
        exit(StrSubstNo('%1|%2', Format(GetCollectedErrors().Count(), 0, 9), 'reached'));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectNested(): Text
    var
        EI: ErrorInfo;
        Inner: Text;
    begin
        EI.Collectible(true);
        EI.Message('E2 outer');
        Error(EI);
        Inner := CollectInner();
        exit(StrSubstNo('%1|%2', Inner, Format(GetCollectedErrors().Count(), 0, 9)));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectInner(): Text
    var
        EI: ErrorInfo;
    begin
        EI.Collectible(true);
        EI.Message('E2 inner');
        Error(EI);
        exit(Format(GetCollectedErrors().Count(), 0, 9));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectGetClear(): Text
    var
        EI: ErrorInfo;
        Errs: List of [ErrorInfo];
    begin
        EI.Collectible(true);
        EI.Message('E2 a');
        Error(EI);
        EI.Message('E2 b');
        Error(EI);
        Errs := GetCollectedErrors(true);
        exit(StrSubstNo('%1|%2|%3', Format(Errs.Count(), 0, 9), Format(HasCollectedErrors(), 0, 9), Format(GetCollectedErrors().Count(), 0, 9)));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectTryInScope(): Text
    var
        R: Boolean;
    begin
        R := TryRaiseCollectible();
        exit(StrSubstNo('%1|%2|%3', Format(R, 0, 9), Format(GetCollectedErrors().Count(), 0, 9), GetLastErrorText()));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectedTitleDetail(): Text
    var
        EI: ErrorInfo;
        E: ErrorInfo;
        Errs: List of [ErrorInfo];
    begin
        EI.Collectible(true);
        EI.Title('E2 title');
        EI.Message('E2 body');
        EI.DetailedMessage('E2 detail');
        Error(EI);
        Errs := GetCollectedErrors();
        E := Errs.Get(1);
        exit(StrSubstNo('%1|%2|%3|%4', Format(Errs.Count(), 0, 9), E.Message, E.Title, E.DetailedMessage));
    end;

    [ErrorBehavior(ErrorBehavior::Collect)]
    procedure CollectedRefs(): Text
    var
        EI: ErrorInfo;
        E: ErrorInfo;
        Row: Record "E2 Row";
        Errs: List of [ErrorInfo];
    begin
        Row."Key" := 5;
        EI.Collectible(true);
        EI.Message('E2 refs');
        EI.TableId(51000);
        EI.FieldNo(2);
        EI.RecordId(Row.RecordId);
        Error(EI);
        Errs := GetCollectedErrors();
        E := Errs.Get(1);
        exit(StrSubstNo('%1|%2|%3', Format(E.TableId, 0, 9), Format(E.FieldNo, 0, 9), Format(E.RecordId.TableNo, 0, 9)));
    end;
}

codeunit ${E2_HELPER + 1} "E2 Run Probe"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Val := CopyStr(StrSubstNo('%1|%2', Format(HasCollectedErrors(), 0, 9), Format(GetCollectedErrors().Count(), 0, 9)), 1, 30);
    end;
}

codeunit ${E2_HELPER + 2} "E2 Run Last"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Val := CopyStr(GetLastErrorText(), 1, 30);
    end;
}

codeunit ${E2_HELPER + 3} "E2 Run Collect"
{
    TableNo = "E2 Row";

    trigger OnRun()
    var
        H: Codeunit "E2 Helper";
    begin
        Rec.Val := CopyStr(H.CollectKeepGoingCount(), 1, 30);
    end;
}

codeunit ${E2_HELPER + 4} "E2 Run Err"
{
    trigger OnRun()
    begin
        Error('E2 run err');
    end;
}

codeunit ${E2_HELPER + 5} "E2 Run Nest"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        if Codeunit.Run(Codeunit::"E2 Run Probe", Rec) then
            Rec.Val := CopyStr('N:' + Rec.Val, 1, 30);
    end;
}

codeunit ${E2_HELPER + 6} "E2 Run NestFail"
{
    TableNo = "E2 Row";

    trigger OnRun()
    var
        Ok: Boolean;
    begin
        Ok := Codeunit.Run(Codeunit::"E2 Run Err");
        Rec.Val := CopyStr(Format(Ok, 0, 9) + '|' + GetLastErrorText(), 1, 30);
    end;
}

codeunit ${E2_HELPER + 7} "E2 Run Commit"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Insert();
        Commit();
        Error('E2 after commit');
    end;
}

codeunit ${E2_HELPER + 8} "E2 Run CommitOk"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Insert();
        Commit();
    end;
}

codeunit ${E2_HELPER + 9} "E2 Run Ok"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Insert();
    end;
}

codeunit ${E2_HELPER + 10} "E2 Run Fail"
{
    TableNo = "E2 Row";

    trigger OnRun()
    begin
        Rec.Insert();
        Error('E2 run failed');
    end;
}
`,
  handles: {},
  cells: E2_CELLS,
};

/**
 * PR-500: io-streams-2, R1238's follow-up cells and cheap gaps as a second per-cell BC differential. Same rules as
 * io-streams: cells that write a real table use their own key (`i2Key`), never DeleteAll; numbers go through Format(x, 0, 9);
 * a code-page decode of a non-ASCII letter is `depends: "locale"` (Linux BC, R1210). Cell i is codeunit BASE_ID + 1 + i;
 * tables 51000-51001, XMLports 51000-51005; the helper codeunit follows the last cell (`extraIds`).
 */
let i2Next = 0;
/** A fresh key for one cell (a Blob row id, and the stem of its item codes). */
const i2Key = (): number => {
  i2Next += 1;
  return 1000 + i2Next * 10;
};
const I2_VARS = [
  'H: Codeunit "I2 Helper";',
  'TB: Record "I2 Blob" temporary;',
  "OutS: OutStream;",
  "InS: InStream;",
  "InS2: InStream;",
  "T: Text;",
  "T2: Text;",
  "N: Integer;",
  "N2: Integer;",
  "N3: Integer;",
];
const i2 = (
  type: string,
  method: string,
  setup: string[],
  expr: string,
  extra: { vars?: string[]; locale?: true } = {},
): Cell => ({
  type: `I2 ${type}`,
  method,
  state: "i2",
  vars: [...I2_VARS, ...(extra.vars ?? [])],
  setup,
  call: `Error('V:[%1]', ${expr});`,
  ...(extra.locale === true ? { depends: "locale" as const } : {}),
});
const I2_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  const add = (c: Cell): void => {
    cells.push(c);
  };
  // --- byte dumps: Write of text, and the binary form of each simple type, then Read back ---
  add(
    i2(
      "Bytes",
      "Write ab",
      ioWrite(["OutS.Write('ab');"]),
      `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 8)`,
    ),
  );
  for (const [method, vars, write, read, back] of [
    ["Integer", [], ["N := 258;", "OutS.Write(N);"], "InS2.Read(N2);", n9("N2")],
    [
      "Char",
      ["Ch: Char;", "Ch2: Char;"],
      ["Ch := 65;", "OutS.Write(Ch);"],
      "InS2.Read(Ch2); N2 := Ch2;",
      n9("N2"),
    ],
    [
      "Boolean",
      ["R2: Boolean;"],
      ["R2 := true;", "OutS.Write(R2);"],
      "R2 := false; InS2.Read(R2);",
      n9("R2"),
    ],
    ["Decimal", ["D: Decimal;"], ["D := 1.5;", "OutS.Write(D);"], "D := 0; InS2.Read(D);", n9("D")],
    [
      "Date",
      ["Dt: Date;"],
      ["Dt := 20260102D;", "OutS.Write(Dt);"],
      "Dt := 0D; InS2.Read(Dt);",
      n9("Dt"),
    ],
  ] as const) {
    add(
      i2(
        "Bytes",
        method,
        [...ioWrite([...write]), "TB.Data.CreateInStream(InS2);", read],
        `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 24) + '|' + ${back}`,
        { vars: [...vars] },
      ),
    );
  }
  // --- ReadText's count ---
  add(
    i2(
      "ReadText",
      "UTF8 ae count",
      [...ioWrite(["OutS.WriteText('æ');"], "UTF8"), "N := InS.ReadText(T);"],
      `${n9("N")} + '|' + ${n9("StrLen(T)")}`,
    ),
  );
  add(
    i2(
      "ReadText",
      "over CRLF count",
      [
        ...ioWrite(["OutS.WriteText('ab');", "OutS.WriteText();", "OutS.WriteText('cde');"]),
        "N := InS.ReadText(T);",
        "N2 := InS.ReadText(T2);",
      ],
      `${n9("N")} + '|' + ${n9("N2")} + '|' + T + '|' + T2`,
    ),
  );
  for (const [method, code] of [
    ["LF only", 10],
    ["CR only", 13],
  ] as const) {
    add(
      i2(
        "ReadText",
        method,
        [
          "T2 := 'ab cd';",
          `T2[3] := ${code};`,
          ...ioWrite(["OutS.WriteText(T2);"]),
          "N := InS.ReadText(T);",
        ],
        `${n9("TB.Data.Length")} + '|' + T + '|' + ${n9("N")} + '|' + H.ReadAll(InS)`,
      ),
    );
  }
  // --- a byte-order mark at the start of a stream being read ---
  add(
    i2(
      "ReadText",
      "UTF8 BOM",
      [
        "TB.Data.CreateOutStream(OutS);",
        "H.WriteByte(OutS, 239);",
        "H.WriteByte(OutS, 187);",
        "H.WriteByte(OutS, 191);",
        "OutS.WriteText('ab');",
        "TB.Data.CreateInStream(InS, TextEncoding::UTF8);",
        "N := InS.ReadText(T);",
        "if StrLen(T) > 0 then N2 := T[1];",
      ],
      `${n9("StrLen(T)")} + '|' + ${n9("N")} + '|' + ${n9("N2")}`,
    ),
  );
  add(
    i2(
      "ReadText",
      "UTF16 BOM",
      [
        "TB.Data.CreateOutStream(OutS);",
        "H.WriteByte(OutS, 255);",
        "H.WriteByte(OutS, 254);",
        "H.WriteByte(OutS, 97);",
        "H.WriteByte(OutS, 0);",
        "H.WriteByte(OutS, 98);",
        "H.WriteByte(OutS, 0);",
        "TB.Data.CreateInStream(InS, TextEncoding::UTF16);",
        "N := InS.ReadText(T);",
        "if StrLen(T) > 0 then N2 := T[1];",
      ],
      `${n9("StrLen(T)")} + '|' + ${n9("N")} + '|' + ${n9("N2")}`,
    ),
  );
  // --- encodings read from a FRESH stream, as numbers ---
  add(
    i2(
      "Enc",
      "UTF16 read as UTF8 fresh",
      [
        ...ioWrite(["OutS.WriteText('a');"], "UTF16"),
        "TB.Data.CreateInStream(InS2, TextEncoding::UTF8);",
        "T := H.ReadAll(InS2);",
        "if StrLen(T) > 0 then N2 := T[1];",
      ],
      `${n9("StrLen(T)")} + '|' + ${n9("N2")}`,
    ),
  );
  add(
    i2(
      "Enc",
      "UTF8 ae read as UTF16 code point",
      [
        ...ioWrite(["OutS.WriteText('æ');"], "UTF8"),
        "TB.Data.CreateInStream(InS2, TextEncoding::UTF16);",
        "T := H.ReadAll(InS2);",
        "if StrLen(T) > 0 then N2 := T[1];",
      ],
      `${n9("StrLen(T)")} + '|' + ${n9("N2")}`,
    ),
  );
  add(
    i2(
      "Enc",
      "UTF8 ae read as MSDos",
      [
        ...ioWrite(["OutS.WriteText('æ');"], "UTF8"),
        "TB.Data.CreateInStream(InS2, TextEncoding::MSDos);",
        "T := H.ReadAll(InS2);",
        "if StrLen(T) > 0 then N2 := T[1];",
        "if StrLen(T) > 1 then N3 := T[2];",
      ],
      `${n9("StrLen(T)")} + '|' + ${n9("N2")} + '|' + ${n9("N3")}`,
      { locale: true },
    ),
  );
  // --- InStream Length, Position, ResetPosition ---
  const ABC = ioWrite(["OutS.WriteText('ab');", "OutS.WriteText();", "OutS.WriteText('cd');"]);
  add(i2("InStream", "Length", ABC, n9("InS.Length()")));
  add(i2("InStream", "Position at start", ABC, n9("InS.Position()")));
  add(
    i2(
      "InStream",
      "Position after ReadText",
      [...ABC, "InS.ReadText(T);"],
      `${n9("InS.Position()")} + '|' + ${n9("InS.Length()")}`,
    ),
  );
  add(
    i2(
      "InStream",
      "ResetPosition",
      [...ABC, "InS.ReadText(T);", "InS.ResetPosition();"],
      `${n9("InS.Position()")} + '|' + H.ReadAll(InS)`,
    ),
  );
  add(
    i2(
      "InStream",
      "ResetPosition after EOS",
      [...ABC, "T := H.ReadAll(InS);", "InS.ResetPosition();"],
      `${n9("InS.EOS")} + '|' + ${n9("InS.Position()")}`,
    ),
  );
  // --- XMLport ---
  const XP = (port: string, extraVars: string[] = []) => ({
    vars: [`Xp: XmlPort "${port}";`, 'Item: Record "I2 Item";', ...extraVars],
  });
  /** Insert two items, then export them through `Xp` into TB and open TB for reading. */
  const exportSetup = (k: number): string[] => [
    `H.InsertItems('X${k}');`,
    `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
    "Xp.SetTableView(Item);",
    "TB.Data.CreateOutStream(OutS);",
    "Xp.SetDestination(OutS);",
    "Xp.Export();",
    "TB.Data.CreateInStream(InS);",
  ];
  const exportItem = (k: number, name: string): string[] => [
    `H.InsertItem('X${k}1', '${name}');`,
    `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
    "Xp.SetTableView(Item);",
    "TB.Data.CreateOutStream(OutS);",
    "Xp.SetDestination(OutS);",
    "Xp.Export();",
    "TB.Data.CreateInStream(InS);",
  ];
  const emptyExport = (k: number): string[] => [
    `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
    "Xp.SetTableView(Item);",
    "TB.Data.CreateOutStream(OutS);",
    "Xp.SetDestination(OutS);",
    "Xp.Export();",
    "TB.Data.CreateInStream(InS);",
  ];
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "Xml export first bytes",
        exportSetup(k),
        `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 12)`,
        XP("I2 Items Xml"),
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "Xml export read as UTF16",
        [...exportSetup(k), "TB.Data.CreateInStream(InS2, TextEncoding::UTF16);"],
        "H.ReadAll(InS2)",
        XP("I2 Items Xml"),
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "Xml Encoding UTF8",
        [...exportSetup(k), "TB.Data.CreateInStream(InS2, TextEncoding::UTF8);"],
        `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 12) + '|' + H.ReadAll(InS2)`,
        XP("I2 Items Xml8"),
      ),
    );
  }
  for (const [method, port, locale] of [
    ["Csv UTF8 export", "I2 Csv U8", false],
    ["Csv UTF16 export", "I2 Csv U16", false],
    ["Csv Windows export", "I2 Csv Win", true],
  ] as const) {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        method,
        exportItem(k, "æ"),
        `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 40)`,
        { ...XP(port), ...(locale ? { locale: true as const } : {}) },
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "Xml 0 rows",
        [...emptyExport(k), "TB.Data.CreateInStream(InS2, TextEncoding::UTF16);"],
        `${n9("TB.Data.Length")} + '|' + H.ReadAll(InS2)`,
        XP("I2 Items Xml"),
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "Csv 0 rows",
        emptyExport(k),
        `${n9("TB.Data.Length")} + '|' + H.Bytes(InS, 8)`,
        XP("I2 Items Csv"),
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        "reimport UTF16 export",
        [
          ...exportSetup(k),
          `H.DeleteItem('X${k}1');`,
          `H.DeleteItem('X${k}2');`,
          "TB.Data.CreateInStream(InS2);",
          "Xp2.SetSource(InS2);",
          "Xp2.Import();",
        ],
        `${n9("Item.Count()")} + '|' + H.ItemNames('X${k}')`,
        XP("I2 Items Xml", ['Xp2: XmlPort "I2 Items Xml";']),
      ),
    );
  }
  for (const [method, name] of [
    ["Csv export comma", "a,b"],
    ["Csv export quote", 'c"d'],
  ] as const) {
    const k = i2Key();
    add(i2("Xmlport", method, exportItem(k, name), "H.ReadAll(InS)", XP("I2 Items Csv")));
  }
  for (const [method, text] of [
    ["Csv import comma", '"a,b"'],
    ["Csv import quote", '"c""d"'],
  ] as const) {
    const k = i2Key();
    add(
      i2(
        "Xmlport",
        method,
        [
          ...ioWrite([`OutS.WriteText('X${k}1,${text}');`]),
          "Xp.SetSource(InS);",
          "Xp.Import();",
          `Item.SetRange(Code, 'X${k}1', 'X${k}9');`,
        ],
        `${n9("Item.Count()")} + '|' + H.ItemNames('X${k}')`,
        XP("I2 Items Csv"),
      ),
    );
  }
  // --- Temp Blob: FromRecord and ToRecordRef ---
  const BLOB = { vars: ['B: Record "I2 Blob";', 'Blob1: Codeunit "Temp Blob";'] };
  for (const [method, calc] of [
    ["FromRecord", true],
    ["FromRecord no CalcFields", false],
  ] as const) {
    const k = i2Key();
    add(
      i2(
        "TempBlob",
        method,
        [
          `H.InsertBlob(${k}, 'abc');`,
          `B.Get(${k});`,
          ...(calc ? ["B.CalcFields(Data);"] : []),
          "Blob1.FromRecord(B, B.FieldNo(Data));",
          "Blob1.CreateInStream(InS);",
        ],
        `H.ReadAll(InS) + ${n9("Blob1.Length()")}`,
        BLOB,
      ),
    );
  }
  {
    const k = i2Key();
    add(
      i2(
        "TempBlob",
        "ToRecordRef",
        [
          "B.Init();",
          `B.Id := ${k};`,
          "B.Insert();",
          "Blob1.CreateOutStream(OutS);",
          "OutS.WriteText('xy');",
          "RR.GetTable(B);",
          "Blob1.ToRecordRef(RR, B.FieldNo(Data));",
          "RR.Modify();",
          "Clear(B);",
          `B.Get(${k});`,
          "B.CalcFields(Data);",
          "B.Data.CreateInStream(InS);",
        ],
        `H.ReadAll(InS) + ${n9("B.Data.Length")}`,
        { vars: [...BLOB.vars, "RR: RecordRef;"] },
      ),
    );
  }
  return cells;
})();
const I2_HELPER = 51000 + 1 + I2_CELLS.length;
export const IO_STREAMS_2: Family = {
  name: "io-streams-2",
  // PR-500: the 2 code-page cells are culture data; to be measured on a Linux BC (R1210)
  bcMeasured: { ...BC1_LINUX, task: "PR-500" },
  issue: "",
  known: [],
  testPermissions: "Disabled",
  extraIds: 1,
  dependencies: [
    {
      id: "63ca2fa4-4f03-4f2b-a480-172fef340d3f",
      name: "System Application",
      publisher: "Microsoft",
      version: "28.0.0.0",
    },
  ],
  support: `table 51000 "I2 Blob"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

table 51001 "I2 Item"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Name; Text[30]) { }
    }
    keys { key(PK; Code) { Clustered = true; } }
}

xmlport 51000 "I2 Items Xml"
{
    Format = Xml;
    Direction = Both;
    schema
    {
        textelement(Items)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51001 "I2 Items Csv"
{
    Format = VariableText;
    Direction = Both;
    schema
    {
        textelement(Root)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51002 "I2 Items Xml8"
{
    Format = Xml;
    Direction = Both;
    Encoding = UTF8;
    schema
    {
        textelement(Items)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51003 "I2 Csv U8"
{
    Format = VariableText;
    Direction = Both;
    TextEncoding = UTF8;
    schema
    {
        textelement(Root)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51004 "I2 Csv U16"
{
    Format = VariableText;
    Direction = Both;
    TextEncoding = UTF16;
    schema
    {
        textelement(Root)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

xmlport 51005 "I2 Csv Win"
{
    Format = VariableText;
    Direction = Both;
    TextEncoding = WINDOWS;
    schema
    {
        textelement(Root)
        {
            tableelement(Item; "I2 Item")
            {
                fieldelement(Code; Item.Code) { }
                fieldelement(Name; Item.Name) { }
            }
        }
    }
}

codeunit ${I2_HELPER} "I2 Helper"
{
    /// Every line to the end, each followed by '|'.
    procedure ReadAll(var InS: InStream): Text
    var
        Line: Text;
        Result: Text;
    begin
        while not InS.EOS do begin
            InS.ReadText(Line);
            Result += Line + '|';
        end;
        exit(Result);
    end;

    /// The first N bytes as numbers, space separated.
    procedure Bytes(var InS: InStream; N: Integer): Text
    var
        B: Byte;
        V: Integer;
        I: Integer;
        Result: Text;
    begin
        while (I < N) and not InS.EOS do begin
            InS.Read(B);
            V := B;
            Result += Format(V, 0, 9) + ' ';
            I += 1;
        end;
        exit(Result);
    end;

    procedure WriteByte(var OutS: OutStream; V: Integer)
    var
        B: Byte;
    begin
        B := V;
        OutS.Write(B);
    end;

    procedure InsertBlob(K: Integer; V: Text)
    var
        B: Record "I2 Blob";
        OutS: OutStream;
    begin
        B.Init();
        B.Id := K;
        B.Data.CreateOutStream(OutS);
        OutS.WriteText(V);
        B.Insert();
    end;

    procedure InsertItem(C: Text; Name: Text)
    var
        Item: Record "I2 Item";
    begin
        Item.Init();
        Item.Code := CopyStr(C, 1, 20);
        Item.Name := CopyStr(Name, 1, 30);
        Item.Insert();
    end;

    procedure InsertItems(Stem: Text)
    begin
        InsertItem(Stem + '1', 'N1');
        InsertItem(Stem + '2', 'N2');
    end;

    procedure DeleteItem(C: Text)
    var
        Item: Record "I2 Item";
    begin
        if Item.Get(CopyStr(C, 1, 20)) then
            Item.Delete();
    end;

    procedure ItemNames(Stem: Text): Text
    var
        Item: Record "I2 Item";
        Result: Text;
    begin
        Item.SetFilter(Code, '%1', Stem + '*');
        if Item.FindSet() then
            repeat
                Result += Item.Code + '=' + Item.Name + ';';
            until Item.Next() = 0;
        exit(Result);
    end;
}
`,
  handles: {},
  cells: I2_CELLS,
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
  // PR-86: appended (BC-check number 15): date formulas, date and time arithmetic, for a per-cell BC differential
  [DATES_FORMULAS.name]: DATES_FORMULAS,
  // PR-87: appended (BC-check number 16): JSON, TextBuilder, Danish-letter text functions and comparison, for a per-cell BC differential
  [JSON_TEXT.name]: JSON_TEXT,
  // PR-93: appended (BC-check number 17): the refusal texts t10 and t11 still closed on, for a keep census
  [T10_REFUSALS.name]: T10_REFUSALS,
  // PR-105: appended (BC-check number 18): the refusal texts t12 and t13 still closed on, for a keep census
  [T12_REFUSALS.name]: T12_REFUSALS,
  // PR-133: appended (BC-check number 19): the two refusal texts DO's x2 window closed on, for a keep census
  [X2_REFUSALS.name]: X2_REFUSALS,
  // PR-139: appended (BC-check number 20): the NUL-run Evaluate widths DO's x3 window closed on, for a keep census
  [X3_REFUSALS.name]: X3_REFUSALS,
  // PR-159: appended (BC-check number 21): the two sibling texts DO's y1 window closed on, for a keep census
  [Y1_REFUSALS.name]: Y1_REFUSALS,
  // PR-191: appended (BC-check number 22): the XML refusal texts DO's y2 window closed on, for a keep census
  [Y2_XML.name]: Y2_XML,
  // PR-195: appended (BC-check number 23): the collation refusal DO's y2 window closed on, for a keep census
  [Y2_COLLATION.name]: Y2_COLLATION,
  // PR-373: appended (BC-check number 24): #8094, Format under CurrReport.FormatRegion, for a per-cell BC differential
  [FORMAT_REGION.name]: FORMAT_REGION,
  // PR-374: appended (BC-check number 25): #8219, a FieldRef given a value of another type, for a per-cell BC differential
  [FIELDREF_CONVERT.name]: FIELDREF_CONVERT,
  // PR-374: appended (BC-check number 26): (language, region) pairs in a report not started by Run, for a per-cell BC differential
  [LANGUAGE_REGION.name]: LANGUAGE_REGION,
  // PR-375: appended (BC-check number 27): a zip kept in a Blob, through the System Application's Data Compression
  [ZIP_BLOB.name]: ZIP_BLOB,
  // PR-431: appended (BC-check number 28): edge's setrange-other-type-convert and restamped-row texts, for leg C's keep cases
  [EDGE_REFUSALS.name]: EDGE_REFUSALS,
  // PR-487: appended (BC-check number 29): errors, transactions and temporary records, for a per-cell BC differential
  [ERRORS_TEMP.name]: ERRORS_TEMP,
  // PR-488: appended (BC-check number 30): numbers and text builtins, for a per-cell BC differential
  [NUMBERS_TEXT.name]: NUMBERS_TEXT,
  // PR-489: appended (BC-check number 31): streams, encodings, Blob fields, Temp Blob, Base64 and XMLport over a stream
  [IO_STREAMS.name]: IO_STREAMS,
  // PR-500: appended (BC-check number 32): R1236's follow-up items 2-11, for a per-cell BC differential
  [ERRORS_TEMP_2.name]: ERRORS_TEMP_2,
  // PR-500: appended (BC-check number 33): R1238's follow-up cells and cheap gaps, for a per-cell BC differential
  [IO_STREAMS_2.name]: IO_STREAMS_2,
};

/** The first codeunit id; cell i is `BASE + 1 + i`. */
export const BASE_ID = 51000;

/**
 * PR-377: the one BC build every family runs on, four numbers: the build LethAL's DO configs and serve runs name (R1194). A bare
 * major version (`28`) resolves to a build whose service-tier runtime al-runner then fetches from the artifact feed (PR-375).
 */
export const REFUSAL_FAMILY_BC_VERSION = "28.4.53241.56646";

/** PR-377: al-runner's arguments for one family's run of the app in `dir`. */
export function runArgs(f: Family, dir: string): string[] {
  return [
    "test",
    "--bc-version",
    REFUSAL_FAMILY_BC_VERSION,
    ...(f.args ?? []),
    "--output-json",
    dir,
  ];
}

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
  /**
   * PR-363: emit only these cell indices (into `f.cells`). Each keeps its own codeunit id (cell i is BASE_ID + 1 + i, no
   * renumbering), the support objects keep theirs, and `idRanges` stays the family's whole range (it covers what is emitted).
   * Absent: every cell, byte-identical to before.
   */
  only?: readonly number[],
): Record<string, string> {
  const keep = only === undefined ? undefined : new Set(only);
  const units = f.cells
    .flatMap((c, i) => (keep === undefined || keep.has(i) ? [[c, i] as const] : []))
    .map(([c, i]) => {
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
    Subtype = Test;${f.testPermissions !== undefined ? `\n    TestPermissions = ${f.testPermissions};` : ""}

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
        idRanges: [{ from: BASE_ID, to: BASE_ID + 1 + f.cells.length + (f.extraIds ?? 0) }],
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

/** The report's cells must be the family's cells, in order (PR-83: any family; format-evaluate by default, as PR-52 used it). */
export function checkReportCells(
  results: readonly CellResult[],
  family: Family = FORMAT_EVALUATE,
): void {
  if (results.length !== family.cells.length)
    throw new Error(
      `the report has ${results.length} cells, the family ${family.name} ${family.cells.length}`,
    );
  for (const [i, r] of results.entries()) {
    const c = family.cells[i];
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
    // PR-52: bun scripts/refusal-family.ts --join <v3 report.json> <bc.tsv> [--family <name>] [--out <joined.tsv>]
    const [reportPath, bcPath] = [args[joinAt + 1], args[joinAt + 2]];
    if (reportPath === undefined || bcPath === undefined)
      throw new Error(
        "usage: refusal-family.ts --join <v3 report.json> <bc.tsv> [--family <name>] [--out <joined.tsv>]",
      );
    const named = opt("--family");
    const family = named === undefined ? FORMAT_EVALUATE : FAMILIES[named];
    if (family === undefined)
      throw new Error(`refusal-family: --family ${named} is not a listed family`);
    const results = JSON.parse(await Bun.file(reportPath).text()) as CellResult[];
    checkReportCells(results, family);
    const rows = joinCells(results, parseBcTsv(await Bun.file(bcPath).text()));
    const out = opt("--out");
    if (out !== undefined) writeFileSync(out, joinTsv(rows));
    else process.stdout.write(joinTsv(rows));
    console.error(JSON.stringify(joinCounts(rows), null, 2));
    const culture = linuxBcCultureCells(family);
    if (culture.length > 0) console.error(linuxBcCultureNote(family, culture.length));
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
  const p = Bun.spawnSync([bin, ...runArgs(f, dir)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALRUNNER_SEED: "1" },
    timeout: 600_000,
  });
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
