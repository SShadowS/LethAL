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
 *   B. each INSTALLED dependent, direct and (R845) transitive, read from
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
import { parseSymbolReferenceJson, readPackageEntry } from "./app-package";
import { RECOVERY_DOC } from "./app-version";
import { type PublishedPackageRead, isUnread } from "./backend";
import { WALK_MAX_APPS, WALK_MAX_MS, testsFirst } from "./dependents-warning";
import { appInputsOfPackage } from "./digest-inputs";
import {
  type FieldItem,
  type FieldOwnerRow,
  type InstalledDependent,
  type ObjectItem,
  type ObjectOwnerRow,
  type OwnersRead,
  UnfilteredExtensionsQueryError,
} from "./harness";
import {
  type Container,
  type ExtensionEntry,
  MICROSOFT_APP_IDS,
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
import {
  READ_BUDGET_MS,
  controlObjects,
  newEnumValues,
  newObjects,
  newTableFields,
  readInBatches,
} from "./non-dependent-clash";
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
  const pending: {
    read: Omit<SourceMember, "own">;
    qualifier: string | undefined;
    numeric: boolean;
  }[] = [];
  for (const f of files) {
    const root = wrapRoot(parseAL(f.text));
    const arms = evaluateArms(root, f.text, symbols);
    if (arms.kind === "undecided") undecided.push({ file: f.path, reason: arms.reason });
    const live = (n: ALSyntaxNode): boolean =>
      arms.kind === "decided" && !startsInInactiveArm(arms.inactive, n.startIndex);
    const nsNode = root.children.find((k) => k.rawKind === "namespace_declaration");
    // The whole declaration's text: with a quoted segment the grammar keeps only the last segment
    // in the `name` field (the rest sits in an ERROR node).
    const fileNamespace = (nsNode?.text ?? "")
      .replace(/^\s*namespace\b/i, "")
      .replace(/;\s*$/, "")
      .replace(/\s+/g, "")
      .replaceAll('"', "")
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
    const takeMembers = (c: ALSyntaxNode, stem: string): void => {
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
        // tree-sitter-al 4.6.0 gives `extends A.B.C` as one `qualified_name` in `base_object`; the
        // clause is still read as text, from `extends` to the opening brace, comments dropped.
        const ek = c.children.find((k) => k.rawKind === "extends_keyword");
        const open = c.children.find((k) => k.rawKind === "{");
        if (ek === undefined || open === undefined) {
          memberNotes.push(`${f.path}: ${stem} "${ownerName}" has no readable extends clause`);
          return;
        }
        const clause = f.text
          .slice(ek.endIndex, open.startIndex)
          .replace(/"(?:[^"]|"")*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
            m.startsWith('"') ? m : " ",
          )
          .trim();
        const split = splitQualified(clause);
        ownerName = split.name;
        qualifier = split.qualifier;
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
      const numeric = !own && /^\d+$/.test(ownerName);
      for (const m of got.members) pending.push({ read: m, qualifier, numeric });
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
          takeMembers(c, raw.slice(0, -12));
        }
      }
    };
    visit(root, false);
  }
  const members: SourceMember[] = pending.map(({ read: first, qualifier, numeric }) => {
    // R861: `extends 18` names its base by id. A table or enum this source declares with that id
    // gives the name the dependents' members are compared on. An id this source does not declare
    // (a dependency's) stays the number, so it matches nothing: a LIMIT, not a safe path (a clash
    // on that base is not seen; the other side holds names, not ids, and guessing "any table"
    // would refuse on every shared field id).
    const base = numeric
      ? objects.find((o) => o.kind === first.container && o.id === Number(first.ownerName))
      : undefined;
    const read =
      base === undefined
        ? first
        : { ...first, ownerName: base.name, ownerKey: base.name.toLowerCase() };
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
  let json: unknown;
  try {
    json = parseSymbolReferenceJson(entry);
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
  /** R847: the app was named by a keyed read of what is new, not by the dependents list. Set only when true. */
  readonly notDependent?: true;
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
  /** R847: as on `ObjectClashFinding`. */
  readonly notDependent?: true;
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
      return `${f.kind} ${f.id}: the target declares "${f.target.name}" (${f.target.where}); installed app ${f.app.name} ${f.app.version} by ${f.app.publisher}${f.notDependent === true ? " (not known to be a dependent)" : ""} declares "${f.other.name}" ${how(f.read, f.symbols)}`;
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
      return `${kind} "${f.ownerName}", ${what}: the target declares "${f.target.name}" (${f.target.id}, ${f.target.where}); installed app ${f.app.name} ${f.app.version} by ${f.app.publisher}${f.notDependent === true ? " (not known to be a dependent)" : ""} declares "${f.other.name}" (${f.other.id}) on the same ${kind} ${how(f.read)}`;
    });
    const injected = findings.some((f) => f.target.where.startsWith("injected"));
    const fromSource = findings.some(
      (f) => !f.target.where.startsWith("injected") && f.notDependent !== true,
    );
    const unrelated = [...findings, ...memberFindings].some((f) => f.notDependent === true);
    // An injected id is LethAL's own: republishing the installed app does not change it.
    const advice = [
      ...(fromSource
        ? ["Republish the named app built against this target, or remove it from the server."]
        : []),
      // R847: the app was found by a keyed read, so it is not known to be a dependent (a truncated
      // walk cannot say "not a dependent"): rebuilding it against this target may not apply.
      ...(unrelated
        ? [
            "An app marked 'not known to be a dependent' was found by a keyed read of the server, not by the dependents list, so rebuilding it against this target may not apply: remove the clash in the target, or in that app.",
          ]
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
  /** R847: how to read the server about an installed app that is not a dependent. Absent: that step is
   *  skipped (a backend that is not bcdev). */
  readonly nonDependent?: NonDependentArgs;
}

/** R847: the keyed reads of the server. Each rejects with whatever the read threw. */
export interface NonDependentArgs {
  readonly targetPublisher: string;
  readonly targetName: string;
  readonly installedVersions: (appId: string) => Promise<readonly string[]>;
  readonly objectOwners: (
    items: readonly ObjectItem[],
    maxMs: number,
    timeoutMs: number,
  ) => Promise<OwnersRead<ObjectOwnerRow>>;
  readonly fieldOwners: (
    items: readonly FieldItem[],
    maxMs: number,
    timeoutMs: number,
  ) => Promise<OwnersRead<FieldOwnerRow>>;
  /** The package bytes of an app in the package cache, by app id (lower case, dashed), or why not. */
  readonly readDependencyApp: (
    appId: string,
  ) => Promise<readonly Uint8Array[] | { readonly unread: string }>;
  /** The one deadline for all the reads. Default `READ_BUDGET_MS`. */
  readonly budgetMs?: number;
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
  // R847: no early return before the keyed read of what is new in the target. A target with no
  // dependents, or whose dependents read failed, can still clash with an app that is not a dependent.
  const dependents: readonly InstalledDependent[] = Array.isArray(args.dependents)
    ? [
        ...testsFirst(args.dependents as readonly InstalledDependent[], args.testsAppId),
        ...args.transitive,
      ]
    : [];
  if (dependents.length === 0 && args.nonDependent === undefined) return warnings;
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
  const direct = Array.isArray(args.dependents) ? args.dependents.length : 0;
  /** Compared for real, by app id: a dependent whose read failed or fell past the bound is NOT here. */
  const compared = new Set<string>();
  /** Compares the target with one installed app. False when its objects could not be read. */
  const compareApp = async (
    d: InstalledDependent,
    via: string,
    notDependent: boolean,
  ): Promise<boolean> => {
    const flag = notDependent ? ({ notDependent: true } as const) : {};
    const [f0, m0, w0] = [findings.length, memberFindings.length, warnings.length];
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
    // A lead never refuses from SOURCE (the keyed read only says where to look): only the package decides.
    if (
      objects === undefined &&
      !notDependent &&
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
      return false;
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
        ...flag,
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
        ...flag,
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
    // A lead exists because a positive read named this app as an owner. If its package then gives
    // no finding and no warning, the read and the package disagree (a newer build on the server
    // than the symbols, or a member the comparison skips): say so, never a silent clean result.
    if (
      notDependent &&
      findings.length === f0 &&
      memberFindings.length === m0 &&
      warnings.length === w0
    ) {
      warnings.push(
        `[lethal] R847: the server named ${d.name} ${d.version} by ${d.publisher} as an owner of something the target adds, but its package shows no clash with the target; whether they clash was NOT decided (its build on the server may differ from the package read).`,
      );
    }
    return true;
  };
  /** The bound on apps read and time, shared by the dependents and the leads. */
  let readApps = 0;
  const bound = (): boolean =>
    readApps >= WALK_MAX_APPS || args.now() - args.startedMs >= WALK_MAX_MS;
  for (const [i, d] of dependents.entries()) {
    if (bound()) {
      const rest = dependents.slice(i);
      warnings.push(
        `[lethal] R845: stopped after reading ${i} installed app(s) (the bound is ${WALK_MAX_APPS} apps and ${WALK_MAX_MS / 1000} s): ${rest.length} were NOT read, first ${nameList(rest)}. A clash with them was not checked.`,
      );
      break;
    }
    readApps++;
    if (await compareApp(d, i < direct ? "" : " (a transitive dependent)", false)) {
      compared.add(bareAppId(d.id));
    }
  }
  // R847: read the target's new objects and fields against the server AFTER the dependents loop
  // (so the 120 s clock the loop shares is not eaten first, and `compared` is known). A target with
  // no dependents, or whose dependents read failed, still comes here. A lead is an app the keyed read
  // named that the loop did not compare. The read says only where to look: it refuses, if at all,
  // from the app's own package, by the comparisons above.
  const leads = await findNonDependentLeads(args, targetRead, target, warnings);
  const toRead = leads.filter((l) => !compared.has(bareAppId(l.id)));
  for (const [i, l] of toRead.entries()) {
    if (bound()) {
      const rest = toRead.slice(i);
      warnings.push(
        `[lethal] R847: stopped before reading ${rest.length} installed app(s) the keyed read named (the bound is ${WALK_MAX_APPS} apps and ${WALK_MAX_MS / 1000} s), first ${nameList(rest)}. A clash with them was not checked.`,
      );
      break;
    }
    readApps++;
    await compareApp(l, " (an installed app not known to be a dependent)", true);
  }
  if (findings.length > 0 || memberFindings.length > 0) {
    throw new ObjectClashError(findings, memberFindings);
  }
  return warnings;
}

/** An app id as the package cache indexes it: 8-4-4-4-12, lower case. */
const dashedId = (id: string): string => {
  const b = bareAppId(id);
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`;
};

/**
 * R847: the table id for each table NAME, offline. The source says `extends Customer`; the server's
 * `Field` table wants a number. The package cache holds the target's dependencies and the Microsoft
 * apps. Only a name found as exactly ONE id is returned; zero matches or two ids warn (Base
 * Application and Business Foundation share 8 table names) and the name is left out, so its fields
 * are not read. A package that cannot be read warns once; an app that is not in the cache is not an
 * error (a target need not depend on all five). The ids are followed through each non-Microsoft
 * package's manifest to the whole closure; if any app in it cannot be read, NO name resolves (it
 * could live in the app not read) and one warning says so. `names` are lower case.
 */
export async function resolveTableIds(
  names: readonly string[],
  appIds: readonly string[],
  read: NonDependentArgs["readDependencyApp"],
  warn: (m: string) => void,
): Promise<Map<string, number>> {
  const found = new Map<string, Set<number>>(names.map((n) => [n, new Set<number>()]));
  // The whole dependency closure: the ids given, then the dependencies each non-Microsoft package
  // names in its manifest. A name may live in an app only a dependency reaches, so one id found
  // among the apps read is not "the only id" unless every app in the closure was read. A Microsoft
  // app missing from the cache is fine (a target need not depend on all five).
  const isMicrosoft = (id: string): boolean => MICROSOFT_APP_IDS.has(bareAppId(id));
  const queue = [...new Set(appIds.map(dashedId))];
  const seen = new Set(queue);
  let incomplete: string | undefined;
  for (let appId = queue.shift(); appId !== undefined; appId = queue.shift()) {
    const got = await read(appId);
    if (!Array.isArray(got)) {
      if (!isMicrosoft(appId)) {
        incomplete ??= `${appId}, in the target's dependency closure, is not in the package cache (${(got as { unread: string }).unread})`;
      }
      continue;
    }
    for (const bytes of got as readonly Uint8Array[]) {
      const pkg = declaredObjectsOfPackage(bytes);
      if (!("objects" in pkg)) {
        warn(`the package of ${appId} in the package cache is unreadable (${pkg.unreadable}).`);
        incomplete ??= `the package of ${appId} is unreadable`;
        continue;
      }
      for (const o of pkg.objects) {
        if (o.kind === "Table") found.get(o.name.toLowerCase())?.add(o.id);
      }
      if (isMicrosoft(appId)) continue;
      try {
        const inner = unwrapSymbolPackage(
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        for (const d of appInputsOfPackage(inner).dependencies) {
          const next = dashedId(d.id);
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      } catch (err) {
        incomplete ??= `the dependencies of ${appId} could not be read (${String(err)})`;
      }
    }
  }
  if (incomplete !== undefined) {
    // A name could live in the app not read, so no name resolves; this only ever warns.
    warn(
      `${incomplete}, so table names cannot be told apart from tables of apps not read; the new fields were NOT checked against the server.`,
    );
    return new Map();
  }
  const out = new Map<string, number>();
  for (const [name, ids] of found) {
    const [only, ...more] = [...ids];
    if (only !== undefined && more.length === 0) out.set(name, only);
    else if (only === undefined) {
      warn(
        `no table "${name}" in the symbols of the target's dependencies or the Microsoft apps in the package cache; its new fields were NOT checked against the server.`,
      );
    } else {
      warn(
        `table "${name}" has ${ids.size} ids in those symbols (${[...ids].join(", ")}); its new fields were NOT checked against the server.`,
      );
    }
  }
  return out;
}

/**
 * R847: asks the server by key about what is NEW in the target, and returns the installed apps that
 * answered as owners of it and are not the target. A lead, never a refusal: the caller reads each
 * lead's own package and compares as it does for a dependent. Pushes warnings; rethrows only
 * `UnfilteredExtensionsQueryError`. When the target is not installed (a first publish), one keyed read
 * of the three injected codeunits only (R892); no call at all when nothing is new. Never reads the
 * whole list (R433); one deadline for all the reads, no retry.
 */
async function findNonDependentLeads(
  args: ObjectClashCheckArgs,
  targetRead: ObjectsRead,
  target: readonly DeclaredObject[],
  warnings: string[],
): Promise<InstalledDependent[]> {
  const nd = args.nonDependent;
  if (nd === undefined) return [];
  const warn = (m: string): void => {
    warnings.push(`[lethal] R847: ${m}`);
  };
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const unchecked = "an installed app that is not a dependent was NOT checked";
  const targetApp = bareAppId(args.targetAppId);

  // 1. Skip. A throw is never read as a first publish.
  let versions: readonly string[];
  try {
    versions = await nd.installedVersions(args.targetAppId);
  } catch (err) {
    if (err instanceof UnfilteredExtensionsQueryError) throw err;
    warn(`could not tell whether the target is installed (${why(err)}); ${unchecked}.`);
    return [];
  }
  if (versions.length === 0) {
    // A first publish cannot strip (R847), but the three injected codeunits are LethAL's own ids: an
    // installed app that is not a dependent may already declare one, and BC's publish refusal would
    // be the only signal (R892). Ask about those three ids alone; an owner is followed to its own
    // package, which decides, and an injected clash refuses with the selectorIds hint.
    const items: ObjectItem[] = injectedObjects(args.injected).map((o) => ({
      kind: o.kind,
      id: o.id,
    }));
    const first = { now: args.now, deadlineMs: args.now() + (nd.budgetMs ?? READ_BUDGET_MS) };
    let read: Awaited<ReturnType<typeof readInBatches<ObjectItem, ObjectOwnerRow>>>;
    try {
      read = await readInBatches(items, nd.objectOwners, first);
    } catch (err) {
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      warn(
        `the keyed read of the injected codeunits failed (${why(err)}); on this first publish an installed app that declares a selectorIds id was NOT checked.`,
      );
      return [];
    }
    if (read.error !== undefined || read.unread > 0) {
      warn(
        `the injected codeunits were not all read (${read.error !== undefined ? why(read.error) : `${read.unread} unread`}); on this first publish an installed app that declares a selectorIds id was NOT checked for them.`,
      );
    }
    const owners = new Map<string, InstalledDependent>();
    for (const r of read.rows) {
      if (r.outcome === "owner" && r.app !== undefined) {
        const key = bareAppId(r.app.id);
        if (key !== targetApp && !owners.has(key)) owners.set(key, r.app);
      } else if (r.outcome === "unresolved") {
        warn(
          `injected ${r.kind} ${r.id} is declared by an installed app the server could not name; it was NOT checked on this first publish.`,
        );
      }
    }
    return [...owners.values()];
  }

  // 2. Base set: the INSTALLED target's package, naming its installed version.
  let base: { objects: readonly DeclaredObject[]; members: readonly PackageMember[] } | undefined;
  const [installed, ...otherVersions] = versions;
  if (installed === undefined || otherVersions.length > 0) {
    warn(
      `the target has ${versions.length} installed versions (${versions.join(", ")}), so there is no one installed base: every object and field of the target is read against the server, under the budget.`,
    );
  } else {
    let reason = "its package could not be fetched";
    try {
      const got = await args.fetchPackage?.({
        publisher: nd.targetPublisher,
        name: nd.targetName,
      });
      if (got instanceof Uint8Array) {
        const pkg = declaredObjectsOfPackage(got, { id: args.targetAppId, version: installed });
        if ("objects" in pkg) base = { objects: pkg.objects, members: pkg.members };
        else reason = pkg.unreadable;
      } else if (isUnread(got)) reason = got.unread;
    } catch (err) {
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      reason = why(err);
    }
    if (base === undefined) {
      warn(
        `the installed target ${installed} could not be read (${reason}), so every object and field of the target is read against the server, under the budget.`,
      );
    }
  }

  // The one deadline starts HERE, after the base read: that read has its own, longer timeout and
  // must not starve the keyed reads.
  const clock = { now: args.now, deadlineMs: args.now() + (nd.budgetMs ?? READ_BUDGET_MS) };

  // 3. Items: what is new.
  const objects = newObjects(target, base?.objects);
  const fields = newTableFields(targetRead.members, base?.members);
  // The server has no table for enum values: say so, by the same new-only rule (R845 measured enum
  // clashes as strips).
  for (const e of newEnumValues(targetRead.members, base?.members)) {
    warn(
      `${e.count} new value(s) of enumextension(s) on enum "${e.enumName}" were NOT checked against the server (it has no table for enum values); ${unchecked} for them.`,
    );
  }
  if (objects.length === 0 && fields.length === 0) return [];

  const leads = new Map<string, InstalledDependent>();
  const lead = (app: InstalledDependent): void => {
    const key = bareAppId(app.id);
    if (key !== targetApp && !leads.has(key)) leads.set(key, app);
  };

  // 5/7. Objects, with one known-installed control for each kind asked.
  if (objects.length > 0) {
    const controls = base === undefined ? [] : controlObjects(objects, base.objects);
    const items: ObjectItem[] = [...controls, ...objects].map((o) => ({ kind: o.kind, id: o.id }));
    let read: Awaited<ReturnType<typeof readInBatches<ObjectItem, ObjectOwnerRow>>> | undefined;
    try {
      read = await readInBatches(items, nd.objectOwners, clock);
    } catch (err) {
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      warn(`the keyed read of ${items.length} object(s) failed (${why(err)}); ${unchecked}.`);
    }
    if (read?.error !== undefined) {
      // The rows of the calls before the failed one are kept and used below.
      warn(`a keyed read of objects failed (${why(read.error)}); ${unchecked} for the rest.`);
    }
    if (read !== undefined) {
      if (read.unread > 0) {
        warn(
          `${read.unread} of ${items.length} object(s) were NOT read (the budget is ${(nd.budgetMs ?? READ_BUDGET_MS) / 1000} s in all, or the server answered fewer); ${unchecked} for them.`,
        );
      }
      const seen = new Set<string>();
      const blindWhy = new Map<string, string>();
      for (const [i, c] of controls.entries()) {
        const r = read.rows[i];
        if (r === undefined) blindWhy.set(c.kind, "its control object was not read");
        else if (
          r.outcome === "owner" &&
          r.app !== undefined &&
          bareAppId(r.app.id) === targetApp
        ) {
          seen.add(c.kind);
        } else {
          blindWhy.set(
            c.kind,
            `its control object ${c.kind} ${c.id}, which the installed target declares, came back "${r.outcome}"${r.app !== undefined ? ` owned by ${r.app.name}` : ""}`,
          );
        }
      }
      for (const kind of new Set(objects.map((o) => o.kind))) {
        if (seen.has(kind)) continue;
        warn(
          `${kind}: the server's object table cannot be trusted for this kind (${blindWhy.get(kind) ?? (base === undefined ? "there is no installed target package to take a control object from" : "the installed target declares no object of this kind to use as a control")}), so a "none" for ${objects.filter((o) => o.kind === kind).length} new ${kind} object(s) is NOT clean. An owner answer is still followed to that app's own package, which decides.`,
        );
      }
      // A blind kind's `none` is uncounted (the warning above says so); an owner answer is still a
      // lead, since the package, not this row, decides.
      for (const [j, o] of objects.entries()) {
        const r = read.rows[controls.length + j];
        if (r === undefined || r.outcome === "none") continue;
        if (r.outcome === "unresolved" || r.app === undefined) {
          warn(`could not tell which installed app owns ${o.kind} ${o.id}; it was not checked.`);
        } else lead(r.app);
      }
    }
  }

  // 4/5. Fields on tables the target does not own.
  if (fields.length > 0) {
    const deps = [...args.targetDependencies.map((d) => d.id), ...MICROSOFT_APP_IDS];
    // A control for the field read: a field of an installed target tableextension on a table the
    // target does not own. It must come back owned by the TARGET, or `none` proves nothing.
    const controlMember = base?.members.find(
      (m) => m.container === "Table" && bareAppId(m.ownerApp) !== targetApp,
    );
    let ids: Map<string, number> | undefined;
    try {
      ids = await resolveTableIds(
        [
          ...new Set(
            [
              ...fields.map((f) => f.tableName),
              ...(controlMember ? [controlMember.ownerName] : []),
            ].map((n) => n.toLowerCase()),
          ),
        ],
        deps,
        nd.readDependencyApp,
        warn,
      );
    } catch (err) {
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      warn(`could not look up table ids (${why(err)}); new fields were NOT checked.`);
    }
    const asked: {
      item: FieldItem;
      field: (typeof fields)[number] | undefined;
      table: number;
      tableName: string;
    }[] = [];
    const controlTable =
      controlMember === undefined ? undefined : ids?.get(controlMember.ownerName.toLowerCase());
    const hasControl = controlMember !== undefined && controlTable !== undefined;
    if (hasControl) {
      // First, so the read order proves the control before the rest is trusted.
      asked.push({
        item: { table: controlTable, id: controlMember.id },
        field: undefined,
        table: controlTable,
        tableName: controlMember.ownerName,
      });
    }
    for (const f of fields) {
      const table = ids?.get(f.tableName.toLowerCase());
      if (table === undefined) continue;
      if (f.byId)
        asked.push({ item: { table, id: f.id }, field: f, table, tableName: f.tableName });
      if (f.byName) {
        asked.push({ item: { table, name: f.name }, field: f, table, tableName: f.tableName });
      }
    }
    if (asked.length > (hasControl ? 1 : 0)) {
      let read: Awaited<ReturnType<typeof readInBatches<FieldItem, FieldOwnerRow>>> | undefined;
      try {
        read = await readInBatches(
          asked.map((a) => a.item),
          nd.fieldOwners,
          clock,
        );
      } catch (err) {
        if (err instanceof UnfilteredExtensionsQueryError) throw err;
        warn(`the keyed read of ${asked.length} field(s) failed (${why(err)}); ${unchecked}.`);
      }
      if (read?.error !== undefined) {
        warn(`a keyed read of fields failed (${why(read.error)}); ${unchecked} for the rest.`);
      }
      if (read !== undefined) {
        if (read.unread > 0) {
          warn(
            `${read.unread} of ${asked.length} field(s) were NOT read (the budget is ${(nd.budgetMs ?? READ_BUDGET_MS) / 1000} s in all, or the server answered fewer); ${unchecked} for them.`,
          );
        }
        // The control: the Field table must name the installed target as the owner of a field the
        // target's own tableextension declares. Otherwise it may not hold extension fields, or name
        // the table's owner, and a `none` or a Base owner proves nothing.
        let fieldWhy: string | undefined;
        if (controlMember === undefined) {
          fieldWhy =
            "the installed target holds no field of an extension on another app's table to use as a control";
        } else if (controlTable === undefined) {
          fieldWhy = `the table id of the control field's table "${controlMember.ownerName}" is unknown`;
        } else {
          const c = read.rows[0];
          if (c === undefined) fieldWhy = "its control field was not read";
          else if (
            !(
              c.outcome === "owner" &&
              c.app !== undefined &&
              bareAppId(c.app.id) === targetApp &&
              c.tableName?.toLowerCase() === controlMember.ownerName.toLowerCase()
            )
          ) {
            fieldWhy = `its control field ${controlMember.id} of "${controlMember.ownerName}", which the installed target declares, came back "${c.outcome}"${c.app !== undefined ? ` owned by ${c.app.name}` : ""}`;
          }
        }
        if (fieldWhy !== undefined) {
          warn(
            `fields: the server's Field table cannot be trusted (${fieldWhy}), so a "none" for ${fields.length} new field(s) is NOT clean. An owner answer is still followed to that app's own package, which decides.`,
          );
        }
        for (const [j, a] of asked.entries()) {
          if (a.field === undefined) continue;
          const r = read.rows[j];
          if (r === undefined || r.outcome === "none") continue;
          const label = `field ${a.field.id} "${a.field.name}" of table "${a.field.tableName}"`;
          if (r.outcome === "unresolved" || r.app === undefined) {
            warn(`could not tell which installed app owns ${label}; it was not checked.`);
          } else if (r.tableName?.toLowerCase() !== a.field.tableName.toLowerCase()) {
            // A wrong table id must never refuse: the row is for another table.
            warn(
              `table ${a.table} is called "${r.tableName ?? "(none)"}" on the server, not "${a.field.tableName}": ${label} was not checked.`,
            );
          } else if (!("name" in a.item) || r.fieldName === a.item.name) {
            // BC accepts names that differ only in case (L5): only an exact name match is a lead.
            lead(r.app);
          }
        }
      }
    }
  }
  return [...leads.values()];
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
