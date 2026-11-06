/**
 * R843: refuse a target that declares an object an installed dependent app already declares, before
 * the target is published (the control app, and a test app an env-tool hook publishes, may have gone
 * first). BC refuses such an upgrade ("The application object of type 'CodeUnit' with
 * the ID '79100' is defined in multiple apps"); when it cannot restore the old target it leaves the
 * target uninstalled and removes every installed dependent (R709). Pre-commitment:
 * docs/superpowers/specs/2026-11-06-r843-object-clash-precommitment.md.
 *
 * Two sets are compared by (kind, id):
 *   A. the target: every object declaration in the source snapshot, plus the three injected codeunits.
 *   B. each INSTALLED dependent (direct dependents only: BC's list has no transitive ones), read from
 *      the `SymbolReference.json` of the package the server holds. That is exactly what BC holds, so it
 *      has no `#if` question. When the tests app's package cannot be read, its source stands in, read
 *      under the tests build symbols; a refusal from that fallback says so.
 *
 * No existing scanner is reused: `scanDeclaredObjects`, `objectIdentityOf` and `AppMethodIndex` each
 * miss some of these kinds, and the first reads both `#if` arms.
 */
import {
  type ALSyntaxNode,
  evaluateArms,
  parseAL,
  startsInInactiveArm,
  wrapRoot,
} from "@lethal/engine";
import { readPackageEntry } from "./app-package";
import { RECOVERY_DOC } from "./app-version";
import { type PublishedPackageRead, isUnread } from "./backend";
import { WALK_MAX_APPS, WALK_MAX_MS } from "./dependents-warning";
import { type InstalledDependent, UnfilteredExtensionsQueryError } from "./harness";
import {
  type Container,
  type ExtensionEntry,
  type MemberPair,
  type MemberRule,
  type PackageMember,
  type SourceMember,
  bareAppId,
  bodyOf,
  compareMembers,
  compareMembersBySource,
  packageMoved,
  readExtensionEntry,
  readSourceMembers,
  resolveExtensionMembers,
  sourceMoved,
  splitQualified,
  unquoteName,
} from "./member-clash";
import { unwrapSymbolPackage } from "./published-test-app";

/** The 13 kinds BC and alc compare by (kind, id). Interfaces, profiles, controladdins and dotnet
 *  have no real id and are not compared. */
export const CLASH_KINDS = [
  "Table",
  "Codeunit",
  "Page",
  "Report",
  "Query",
  "XmlPort",
  "Enum",
  "EnumExtension",
  "PermissionSet",
  "PermissionSetExtension",
  "TableExtension",
  "PageExtension",
  "ReportExtension",
] as const;
export type ClashKind = (typeof CLASH_KINDS)[number];

/** The grammar's node stem for each kind: `<stem>_declaration` and `<stem>_keyword`. */
const STEM_OF: Readonly<Record<string, ClashKind>> = {
  table: "Table",
  codeunit: "Codeunit",
  page: "Page",
  report: "Report",
  query: "Query",
  xmlport: "XmlPort",
  enum: "Enum",
  enumextension: "EnumExtension",
  permissionset: "PermissionSet",
  permissionsetextension: "PermissionSetExtension",
  tableextension: "TableExtension",
  pageextension: "PageExtension",
  reportextension: "ReportExtension",
};

/** The `SymbolReference.json` array of each kind, named one by one (measured with alc 18.1 on a probe
 *  app holding one object of every kind, 2026-11-06; `Interfaces` carries a synthetic id and is not
 *  here). Each array also sits under `Namespaces[]`, to any depth. */
const SYMBOL_KEYS: ReadonlyArray<readonly [string, ClashKind]> = [
  ["Tables", "Table"],
  ["Codeunits", "Codeunit"],
  ["Pages", "Page"],
  ["Reports", "Report"],
  ["Queries", "Query"],
  ["XmlPorts", "XmlPort"],
  ["EnumTypes", "Enum"],
  ["EnumExtensionTypes", "EnumExtension"],
  ["PermissionSets", "PermissionSet"],
  ["PermissionSetExtensions", "PermissionSetExtension"],
  ["TableExtensions", "TableExtension"],
  ["PageExtensions", "PageExtension"],
  ["ReportExtensions", "ReportExtension"],
];

export interface DeclaredObject {
  readonly kind: ClashKind;
  readonly id: number;
  readonly name: string;
  /** The source file, or `SymbolReference.json`, or an injected role. */
  readonly where: string;
  /** R845: `ObsoleteState = Moved` / `MovedTo` / `MovedFrom` on the object. Set only when true. */
  readonly moved?: boolean;
}

export interface ObjectsRead {
  readonly objects: readonly DeclaredObject[];
  /** Files whose `#if` arms could not be decided: the objects inside a conditional are left out of
   *  `objects` (never a reason to refuse), and each file is named for a warning. */
  readonly undecided: readonly { readonly file: string; readonly reason: string }[];
  /** R845: the fields of tables and tableextensions, the values of enums and enumextensions. */
  readonly members: readonly SourceMember[];
  /** R845: members this read could not take (an id that is not a number, a header split by `#if`).
   *  Each is a warning; the members of that declaration are not compared. */
  readonly memberNotes: readonly string[];
}

const unquote = unquoteName;

const MEMBER_STEMS = new Set(["table", "tableextension", "enum", "enumextension"]);

/**
 * Every object declaration of the 13 kinds in `files`, by tree, each file's `#if` arms evaluated
 * under `symbols` (`evaluateArms`). A header split by `#if` (`preproc_split_declaration`) is counted
 * per live arm, not dropped. The caller must have called `initParser()`. R845: also the members of
 * tables and enums (`members`).
 */
export function declaredObjectsOfSource(
  files: readonly { readonly path: string; readonly text: string }[],
  symbols: readonly string[],
): ObjectsRead {
  const objects: DeclaredObject[] = [];
  const undecided: { file: string; reason: string }[] = [];
  const memberNotes: string[] = [];
  /** Tables and enums this source declares: `<Container>:<lower name>` to the namespace (lower). */
  const owners = new Map<string, string>();
  const pending: { read: Omit<SourceMember, "own">; qualifier: string | undefined }[] = [];
  for (const f of files) {
    const root = wrapRoot(parseAL(f.text));
    const arms = evaluateArms(root, f.text, symbols);
    if (arms.kind === "undecided") undecided.push({ file: f.path, reason: arms.reason });
    const live = (n: ALSyntaxNode): boolean =>
      arms.kind === "decided" && !startsInInactiveArm(arms.inactive, n.startIndex);
    const nsNode = root.children.find((k) => k.rawKind === "namespace_declaration");
    const fileNamespace = (nsNode?.childForFieldName("name")?.text ?? "")
      .replace(/\s+/g, "")
      .toLowerCase();
    const take = (
      kind: ClashKind,
      id: ALSyntaxNode | null,
      name: ALSyntaxNode | null,
      decl?: ALSyntaxNode,
    ): void => {
      if (id === null) return;
      const n = Number.parseInt(id.text, 10);
      if (Number.isNaN(n)) return;
      const moved = kind === "Table" && decl !== undefined && sourceMoved(bodyOf(decl));
      objects.push({
        kind,
        id: n,
        name: unquote(name?.text ?? ""),
        where: f.path,
        ...(moved ? { moved: true } : {}),
      });
    };
    const takeMembers = (c: ALSyntaxNode, stem: string, inside: boolean): void => {
      if (!MEMBER_STEMS.has(stem)) return;
      const nameNode = c.childForFieldName("object_name");
      if (nameNode === null) return;
      const own = stem === "table" || stem === "enum";
      let ownerName = unquote(nameNode.text);
      let qualifier: string | undefined;
      if (!own) {
        const base = c.childForFieldName("base_object");
        if (base === null) {
          memberNotes.push(`${f.path}: ${stem} "${ownerName}" has no readable base object`);
          return;
        }
        const ek = c.children.find((k) => k.rawKind === "extends_keyword");
        const pre = (ek === undefined ? "" : f.text.slice(ek.endIndex, base.startIndex))
          .replace(/\s+/g, "")
          .replace(/\.+$/, "");
        const split = splitQualified(base.text);
        ownerName = split.name;
        qualifier = [pre.replaceAll('"', ""), split.qualifier].filter((s) => s !== "").join(".");
      } else {
        const container = stem === "table" ? "Table" : "Enum";
        owners.set(`${container}:${ownerName.toLowerCase()}`, fileNamespace);
      }
      const got = readSourceMembers(
        c,
        stem as "table" | "tableextension" | "enum" | "enumextension",
        ownerName,
        f.path,
        live,
        inside,
      );
      memberNotes.push(...got.bad);
      // A parse error can swallow a field whole (`field(x; ...)` makes no field node). A qualified
      // `extends Ns.Name` also parses with an ERROR node, so a bare `hasError` would cry wolf: only
      // when the text shows more `field(` / `value(` lines than were read is a member lost.
      if (c.hasError) {
        const word = stem.startsWith("table") ? "field" : "value";
        const lines = c.text.match(new RegExp(`^\\s*${word}\\s*\\(`, "gim"))?.length ?? 0;
        if (lines > got.members.length) {
          memberNotes.push(
            `${f.path}: ${stem} ${nameNode.text} has a syntax error and shows ${lines} ${word} line(s) but ${got.members.length} were read`,
          );
        }
      }
      for (const m of got.members) pending.push({ read: m, qualifier });
    };
    // `inside`: under a preproc node. Undecided arms: those objects are not trusted either way.
    const visit = (parent: ALSyntaxNode, inside: boolean): void => {
      for (const c of parent.children) {
        const raw = c.rawKind;
        if (raw === "preproc_conditional_object") {
          visit(c, true);
        } else if (raw === "preproc_split_declaration") {
          if (arms.kind !== "decided") continue;
          let kind: ClashKind | undefined;
          let id: ALSyntaxNode | null = null;
          let name: ALSyntaxNode | null = null;
          const flush = (): void => {
            if (kind !== undefined && id !== null && live(id)) take(kind, id, name);
            kind = undefined;
            id = null;
            name = null;
          };
          for (const k of c.children) {
            if (k.rawKind.endsWith("_keyword") && STEM_OF[k.rawKind.slice(0, -8)] !== undefined) {
              flush();
              kind = STEM_OF[k.rawKind.slice(0, -8)];
              if (MEMBER_STEMS.has(k.rawKind.slice(0, -8))) {
                memberNotes.push(
                  `${f.path}: a ${k.rawKind.slice(0, -8)} header is split by #if; its fields or values are not compared`,
                );
              }
            } else if (k.fieldName === "object_id") id = k;
            else if (k.fieldName === "object_name") name = k;
          }
          flush();
        } else if (raw.endsWith("_declaration")) {
          const kind = STEM_OF[raw.slice(0, -12)];
          if (kind === undefined) continue;
          if (inside && !live(c)) continue;
          take(kind, c.childForFieldName("object_id"), c.childForFieldName("object_name"), c);
          takeMembers(c, raw.slice(0, -12), inside);
        }
      }
    };
    visit(root, false);
  }
  const members: SourceMember[] = pending.map(({ read, qualifier }) => {
    const ns = owners.get(`${read.container}:${read.ownerKey}`);
    // Own: the target declares the table or enum itself, or the extension names it plainly or
    // through the target's own namespace. A qualifier pointing elsewhere is another table.
    const own =
      qualifier === undefined ||
      (ns !== undefined && (qualifier === "" || qualifier.toLowerCase() === ns));
    return { ...read, own };
  });
  return { objects, undecided, members, memberNotes };
}

/** What a `SymbolReference.json` declares, with the app it says it belongs to. */
export interface SymbolReferenceRead {
  readonly objects: readonly DeclaredObject[];
  readonly appId: string;
  readonly version: string | undefined;
  /** R845: fields of table extensions and values of enum extensions, on the app that owns the table. */
  readonly members: readonly PackageMember[];
  /** R845: extensions with a bare `TargetObject` that is not a table or enum this app declares. */
  readonly unresolved: readonly string[];
}

/**
 * The objects of a parsed `SymbolReference.json`, through `Namespaces` to any depth. FAIL-CLOSED:
 * a document that is not an object with a string `AppId`, a kind's value that is present and not an
 * array, an entry that is not an object or whose `Id` is not a number, and a `Namespaces` that is not
 * an array of objects are all `unreadable`. A garbled package must never read as "declares nothing".
 */
export function declaredObjectsOfSymbolReference(
  json: unknown,
  where: string,
): SymbolReferenceRead | { readonly unreadable: string } {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isRecord(json)) return { unreadable: "its SymbolReference.json is not a JSON object" };
  if (typeof json.AppId !== "string" || json.AppId === "") {
    return { unreadable: "its SymbolReference.json carries no string AppId" };
  }
  const out: DeclaredObject[] = [];
  let bad: string | undefined;
  const extensions: ExtensionEntry[] = [];
  const ownNames: Record<Container, Set<string>> = { Table: new Set(), Enum: new Set() };
  const walk = (rec: Record<string, unknown>, scope: string): void => {
    for (const [key, kind] of SYMBOL_KEYS) {
      const arr = rec[key];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) {
        bad ??= `${scope}${key} is present and not an array`;
        continue;
      }
      for (const o of arr as unknown[]) {
        if (!isRecord(o) || typeof o.Id !== "number" || !Number.isFinite(o.Id)) {
          bad ??= `${scope}${key} holds an entry whose Id is not a number`;
          continue;
        }
        const moved = packageMoved(o);
        if (typeof moved === "object") bad ??= `${scope}${key}: ${moved.bad}`;
        out.push({
          kind,
          id: o.Id,
          name: typeof o.Name === "string" ? o.Name : "",
          where,
          ...(moved === true ? { moved: true } : {}),
        });
        if (kind === "Table" && typeof o.Name === "string")
          ownNames.Table.add(o.Name.toLowerCase());
        if (kind === "Enum" && typeof o.Name === "string") ownNames.Enum.add(o.Name.toLowerCase());
        if (kind === "TableExtension" || kind === "EnumExtension") {
          const ext = readExtensionEntry(o, kind === "TableExtension" ? "Table" : "Enum");
          if ("bad" in ext) bad ??= `${scope}${key}: ${ext.bad}`;
          else extensions.push(ext);
        }
      }
    }
    const ns = rec.Namespaces;
    if (ns === undefined) return;
    if (!Array.isArray(ns)) {
      bad ??= `${scope}Namespaces is present and not an array`;
      return;
    }
    for (const n of ns as unknown[]) {
      if (!isRecord(n)) bad ??= `${scope}Namespaces holds a non-object`;
      else walk(n, `${scope}Namespaces/`);
    }
  };
  walk(json, "");
  if (bad !== undefined) return { unreadable: `its SymbolReference.json is malformed: ${bad}` };
  const { members, unresolved } = resolveExtensionMembers(
    extensions,
    bareAppId(json.AppId),
    ownNames,
    where,
  );
  return {
    objects: out,
    appId: json.AppId,
    version: typeof json.Version === "string" ? json.Version : undefined,
    members,
    unresolved,
  };
}

/**
 * The objects of one `.app` package, or why it cannot be read. Never throws. A Ready-to-Run wrapper
 * is unwrapped first (`unwrapSymbolPackage`, R820). With `expect`, the package must also BE that
 * app: its `AppId` equals `expect.id` (case-insensitive) and its `Version` equals `expect.version`,
 * because the dev endpoint is asked for "whatever version the server has" and the answer is not
 * otherwise proven to be the installed one.
 */
export function declaredObjectsOfPackage(
  pkg: Uint8Array,
  expect?: { readonly id: string; readonly version: string },
):
  | {
      readonly objects: readonly DeclaredObject[];
      readonly members: readonly PackageMember[];
      readonly unresolved: readonly string[];
      /** The app the package says it is (32 hex, lower case). */
      readonly appId: string;
    }
  | { readonly unreadable: string } {
  let entry: Buffer | null;
  try {
    const inner = unwrapSymbolPackage(Buffer.from(pkg.buffer, pkg.byteOffset, pkg.byteLength));
    entry = readPackageEntry(inner, "SymbolReference.json");
  } catch (err) {
    return { unreadable: `the package is not a readable app (${String(err)})` };
  }
  if (entry === null) return { unreadable: "the package carries no SymbolReference.json" };
  let text = entry.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { unreadable: `its SymbolReference.json is not valid JSON (${String(err)})` };
  }
  const read = declaredObjectsOfSymbolReference(json, "SymbolReference.json");
  if ("unreadable" in read) return read;
  if (expect !== undefined) {
    if (read.appId.toLowerCase() !== expect.id.toLowerCase()) {
      return { unreadable: `the package is for app ${read.appId}, not the installed ${expect.id}` };
    }
    if (read.version !== expect.version) {
      return {
        unreadable: `the package is version ${read.version ?? "(none)"}, not the installed ${expect.version}`,
      };
    }
  }
  return {
    objects: read.objects,
    members: read.members,
    unresolved: read.unresolved,
    appId: bareAppId(read.appId),
  };
}

export interface ObjectClashFinding {
  readonly kind: ClashKind;
  readonly id: number;
  readonly target: DeclaredObject;
  readonly other: DeclaredObject;
  readonly app: InstalledDependent;
  /** `installed-package`: what BC holds. `source-fallback`: the tests app's source under `symbols`. */
  readonly read: "installed-package" | "source-fallback";
  readonly symbols?: readonly string[];
}

/**
 * R845: the apps the target's `app.json` depends on, by id and publisher. A missing `dependencies`
 * is none; one that is not an array, or an entry with no string `id` (or `appId`), is refused by name:
 * a half-read list would shrink the set of tables the check refuses on, not widen it.
 */
export function dependenciesOf(
  manifest: Readonly<Record<string, unknown>>,
): { readonly id: string }[] {
  const deps = manifest.dependencies;
  if (deps === undefined) return [];
  if (!Array.isArray(deps)) throw new Error("target app.json: dependencies is not an array");
  return (deps as unknown[]).map((d, i) => {
    const rec = d as Record<string, unknown> | null;
    const id = rec?.id ?? rec?.appId;
    if (typeof id !== "string" || id === "") {
      throw new Error(`target app.json: dependencies[${i}] has no string id`);
    }
    return { id };
  });
}

/** R845: one field or enum value the target and an installed app both give the same table or enum. */
export interface MemberClashFinding {
  readonly rule: MemberRule;
  readonly container: Container;
  /** The table or enum, by the name the target's side writes it. */
  readonly ownerName: string;
  readonly target: { readonly id: number; readonly name: string; readonly where: string };
  readonly other: { readonly id: number; readonly name: string };
  readonly app: InstalledDependent;
  readonly read: "installed-package" | "source-fallback";
}

/** The pure comparison: every (kind, id) the target and one other app both declare. */
export function findObjectClashes(
  target: readonly DeclaredObject[],
  other: readonly DeclaredObject[],
): { readonly target: DeclaredObject; readonly other: DeclaredObject }[] {
  const byKey = new Map<string, DeclaredObject>();
  for (const o of other) byKey.set(`${o.kind}:${o.id}`, o);
  const out: { target: DeclaredObject; other: DeclaredObject }[] = [];
  const seen = new Set<string>();
  for (const t of target) {
    const key = `${t.kind}:${t.id}`;
    const o = byKey.get(key);
    if (o !== undefined && !seen.has(key)) {
      seen.add(key);
      out.push({ target: t, other: o });
    }
  }
  return out;
}

/** The three codeunits LethAL injects into the instrumented target. */
export function injectedObjects(ids: {
  readonly selectorId: number;
  readonly controlId: number;
  readonly tableId: number;
}): DeclaredObject[] {
  return [
    {
      kind: "Codeunit",
      id: ids.selectorId,
      name: "LethAL selector",
      where: "injected (selectorId)",
    },
    { kind: "Codeunit", id: ids.controlId, name: "LethAL control", where: "injected (controlId)" },
    {
      kind: "Codeunit",
      id: ids.tableId,
      name: "Mutation Upgrade",
      where: "injected (tableId, a codeunit)",
    },
  ];
}

/** The refusal. Extends `Error` directly. The target was not published when it is thrown (the
 *  control app, and a test app an env-tool hook publishes, may have gone first). */
export class ObjectClashError extends Error {
  readonly code = "object-clash" as const;
  readonly findings: readonly ObjectClashFinding[];
  /** R845: field and enum value clashes. */
  readonly memberFindings: readonly MemberClashFinding[];

  constructor(
    findings: readonly ObjectClashFinding[],
    memberFindings: readonly MemberClashFinding[] = [],
  ) {
    const how = (read: "installed-package" | "source-fallback", symbols?: readonly string[]) =>
      read === "installed-package"
        ? "(read from the package the server holds)"
        : `(read from its SOURCE under symbols [${(symbols ?? []).join(", ")}], because its installed package could not be read)`;
    const lines = findings.map((f) => {
      return `${f.kind} ${f.id}: the target declares "${f.target.name}" (${f.target.where}); installed app ${f.app.name} ${f.app.version} by ${f.app.publisher} declares "${f.other.name}" ${how(f.read, f.symbols)}`;
    });
    const memberLines = memberFindings.map((f) => {
      const what =
        f.rule === "field-id"
          ? `field id ${f.target.id}`
          : f.rule === "field-name"
            ? `field name "${f.target.name}"`
            : f.rule === "enum-ordinal"
              ? `enum value ordinal ${f.target.id}`
              : `enum value name "${f.target.name}"`;
      const kind = f.container === "Table" ? "table" : "enum";
      return `${kind} "${f.ownerName}", ${what}: the target declares "${f.target.name}" (${f.target.id}, ${f.target.where}); installed app ${f.app.name} ${f.app.version} by ${f.app.publisher} declares "${f.other.name}" (${f.other.id}) on the same ${kind} ${how(f.read)}`;
    });
    const injected = findings.some((f) => f.target.where.startsWith("injected"));
    const fromSource = findings.some((f) => !f.target.where.startsWith("injected"));
    // An injected id is LethAL's own: republishing the installed app does not change it.
    const advice = [
      ...(fromSource
        ? ["Republish the named app built against this target, or remove it from the server."]
        : []),
      ...(injected
        ? [
            "For an injected codeunit (selectorId, controlId or tableId), set selectorIds in the config to ids no installed app declares; republishing does not change them.",
          ]
        : []),
      ...(memberFindings.length > 0
        ? [
            "For a field or enum value, change or remove it, in the target or in the named app. Rebuilding the named app alone does not help: it fails with AL0206.",
          ]
        : []),
      "Then run again.",
      `Nothing was removed from the server by this refusal; if an earlier run already stripped it, see ${RECOVERY_DOC}.`,
    ].join(" ");
    const kinds =
      findings.length > 0 && memberFindings.length > 0
        ? "an object and a field or enum value"
        : memberFindings.length > 0
          ? "a field or enum value of one table or enum"
          : "the same object";
    super(
      `refusing before the target is published (R843, R845): the target and an installed app declare ${kinds}. BC refuses an upgrade with two apps defining one object ("defined in multiple apps"), one field on a table ("can only appear once in the table") or one value on an enum ("Metadata delta application failed") and, when it cannot restore the old target, removes every installed app that depends on it (R709). ${[...lines, ...memberLines].join("; ")}. ${advice}`,
    );
    this.name = "ObjectClashError";
    this.findings = findings;
    this.memberFindings = memberFindings;
  }
}

export interface ObjectClashCheckArgs {
  /** The installed dependents of the target, or the error the read threw: then nothing is compared
   *  (the dependents warning already says the read failed). */
  readonly dependents: readonly InstalledDependent[] | { readonly error: unknown };
  readonly testsAppId: string | undefined;
  readonly targetFiles: readonly { readonly path: string; readonly text: string }[];
  readonly targetSymbols: readonly string[];
  readonly injected: {
    readonly selectorId: number;
    readonly controlId: number;
    readonly tableId: number;
  };
  readonly fetchPackage:
    | ((app: { publisher: string; name: string }) => Promise<PublishedPackageRead>)
    | undefined;
  /** The tests app's source, read only if its package cannot be. */
  readonly readTestSources: () => Promise<
    readonly { readonly path: string; readonly text: string }[]
  >;
  readonly testSymbols: readonly string[];
  /** R845: the target's own app id (`app.json` `id`). */
  readonly targetAppId: string;
  /** R845: the target's `app.json` `dependencies`. A table owned by one of these, or by a Microsoft
   *  app, is a table the target's tableextension may share with a dependent's. */
  readonly targetDependencies: readonly { readonly id: string }[];
  /** R845: dependents beyond the direct ones, breadth first (`readDependents`). */
  readonly transitive: readonly InstalledDependent[];
  /** R845: when the walk of the dependents began, and the clock, for the 120 s bound. */
  readonly startedMs: number;
  readonly now: () => number;
}

const nameList = (ds: readonly InstalledDependent[]): string =>
  ds
    .slice(0, 3)
    .map((d) => `${d.name} ${d.version}`)
    .join(", ") + (ds.length > 3 ? ", ..." : "");

/**
 * Throws `ObjectClashError` when the target shares a (kind, id) with an installed dependent, or a
 * field id or name, or an enum ordinal or value name, on one table or enum; returns warnings
 * (undecided arms, an unreadable package, anything BC may or may not refuse) otherwise. Reads only;
 * publishes nothing. Call after `initParser()`.
 */
export async function checkObjectClashes(args: ObjectClashCheckArgs): Promise<string[]> {
  const warnings: string[] = [];
  if (!Array.isArray(args.dependents)) return warnings;
  const dependents: readonly InstalledDependent[] = [
    ...(args.dependents as readonly InstalledDependent[]),
    ...args.transitive,
  ];
  if (dependents.length === 0) return warnings;
  const targetRead = declaredObjectsOfSource(args.targetFiles, args.targetSymbols);
  for (const u of targetRead.undecided) {
    warnings.push(
      `[lethal] R843: the #if arms of target file ${u.file} could not be decided (${u.reason}); objects and fields or values inside its conditionals are not compared.`,
    );
  }
  for (const n of targetRead.memberNotes) {
    warnings.push(
      `[lethal] R845: ${n}; the fields or values of that declaration were NOT compared.`,
    );
  }
  const target = [...targetRead.objects, ...injectedObjects(args.injected)];
  const targetApp = bareAppId(args.targetAppId);
  const trusted = new Set(args.targetDependencies.map((d) => bareAppId(d.id)));
  const findings: ObjectClashFinding[] = [];
  const memberFindings: MemberClashFinding[] = [];
  const direct = (args.dependents as readonly InstalledDependent[]).length;
  for (const [i, d] of dependents.entries()) {
    if (i >= WALK_MAX_APPS || args.now() - args.startedMs >= WALK_MAX_MS) {
      const rest = dependents.slice(i);
      warnings.push(
        `[lethal] R845: stopped after reading ${i} installed app(s) (the bound is ${WALK_MAX_APPS} apps and ${WALK_MAX_MS / 1000} s): ${rest.length} were NOT read, first ${nameList(rest)}. A clash with them was not checked.`,
      );
      break;
    }
    const via = i < direct ? "" : " (a transitive dependent)";
    let objects: readonly DeclaredObject[] | undefined;
    let members: readonly PackageMember[] = [];
    let read: ObjectClashFinding["read"] = "installed-package";
    let why = "its package could not be fetched";
    if (args.fetchPackage !== undefined) {
      try {
        const got = await args.fetchPackage({ publisher: d.publisher, name: d.name });
        if (got instanceof Uint8Array) {
          const pkg = declaredObjectsOfPackage(got, { id: d.id, version: d.version });
          if ("objects" in pkg) {
            objects = pkg.objects;
            members = pkg.members;
            for (const u of pkg.unresolved) {
              warnings.push(
                `[lethal] R845: in ${d.name} ${d.version} by ${d.publisher}${via}, ${u}, which is not a table or enum that app declares; its fields or values were not compared.`,
              );
            }
          } else why = pkg.unreadable;
        } else if (isUnread(got)) why = got.unread;
      } catch (err) {
        // R-496: a read not filtered by one app id is a refused request, not an unreadable package.
        if (err instanceof UnfilteredExtensionsQueryError) throw err;
        why = String(err);
      }
    }
    if (
      objects === undefined &&
      args.testsAppId !== undefined &&
      d.id.toLowerCase() === args.testsAppId
    ) {
      const src = declaredObjectsOfSource(await args.readTestSources(), args.testSymbols);
      for (const u of src.undecided) {
        warnings.push(
          `[lethal] R843: the #if arms of tests file ${u.file} could not be decided (${u.reason}); objects inside its conditionals are not compared.`,
        );
      }
      objects = src.objects;
      read = "source-fallback";
      for (const n of src.memberNotes) {
        warnings.push(
          `[lethal] R845: tests ${n}; the fields or values of that declaration were NOT compared.`,
        );
      }
      // R845: both sides are names only here, so a member clash from the fallback WARNS, never
      // refuses. A tests-app table of the target's name is the tests app's own and is left out.
      for (const c of compareMembersBySource(targetRead.members, src.members)) {
        warnings.push(
          `[lethal] R845: the tests source ${c.other.where} gives ${c.target.container === "Table" ? "table" : "enum"} "${c.target.ownerName}" ${ruleText(c.rule)} that the target also gives it (${c.target.where}); read from SOURCE, so this is a warning, not a refusal. If the installed ${d.name} extends the target's ${c.target.container === "Table" ? "table" : "enum"}, BC refuses the upgrade.`,
        );
      }
      // Clean or not, the comparison was against SOURCE: a stale resident app is not excluded.
      warnings.push(
        `[lethal] R843: the installed package of ${d.name} ${d.version} by ${d.publisher} was not read (${why}); its source under symbols [${args.testSymbols.join(", ")}] was compared instead, so an older build of it on the server that declares an object the target declares could not be seen by this check.`,
      );
    }
    if (objects === undefined) {
      warnings.push(
        `[lethal] R843: could not read the installed package of ${d.name} ${d.version} by ${d.publisher} (${why}); whether it declares an object the target declares was NOT checked.`,
      );
      continue;
    }
    for (const c of findObjectClashes(target, objects)) {
      // R845: a table that either side marks Moved is not refused on the pair alone (not measured on BC).
      if (c.target.kind === "Table" && (c.target.moved === true || c.other.moved === true)) {
        warnings.push(
          `[lethal] R845: Table ${c.target.id} is marked Moved on ${c.target.moved === true ? "the target" : `${d.name}${via}`}: the pair "${c.target.name}" / "${c.other.name}" was NOT refused (a Moved pair is not measured on BC).`,
        );
        continue;
      }
      findings.push({
        kind: c.target.kind,
        id: c.target.id,
        target: c.target,
        other: c.other,
        app: d,
        read,
        ...(read === "source-fallback" ? { symbols: args.testSymbols } : {}),
      });
    }
    const cmp = compareMembers(targetRead.members, members, {
      targetApp,
      otherApp: bareAppId(d.id),
      trusted,
    });
    for (const p of cmp.clashes) {
      memberFindings.push({
        rule: p.rule,
        container: p.target.container,
        ownerName: p.target.ownerName,
        target: { id: p.target.id, name: p.target.name, where: p.target.where },
        other: { id: p.other.id, name: p.other.name },
        app: d,
        read,
      });
    }
    for (const s of cmp.soft) {
      const kind = s.target.container === "Table" ? "table" : "enum";
      warnings.push(
        s.reason === "moved"
          ? `[lethal] R845: ${kind} "${s.target.ownerName}" ${ruleText(s.rule)} is shared with ${d.name}${via}, and one side is marked Moved: NOT refused (a Moved pair is not measured on BC).`
          : `[lethal] R845: ${kind} "${s.target.ownerName}" ${ruleText(s.rule)} is shared with ${d.name}${via} on a ${kind} of that name owned by an app the target does not depend on (${s.other.ownerApp}); it may be another app's ${kind}, so this is a warning, not a refusal.`,
      );
    }
  }
  if (findings.length > 0 || memberFindings.length > 0) {
    throw new ObjectClashError(findings, memberFindings);
  }
  return warnings;
}

function ruleText(rule: MemberRule): string {
  return rule === "field-id"
    ? "a field id"
    : rule === "field-name"
      ? "a field name"
      : rule === "enum-ordinal"
        ? "a value ordinal"
        : "a value name";
}
