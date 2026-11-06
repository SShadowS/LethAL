/**
 * R843: refuse a target that declares an object an installed dependent app already declares, before
 * anything is published. BC refuses such an upgrade ("The application object of type 'CodeUnit' with
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
import { type PublishedPackageRead, isUnread } from "./backend";
import type { InstalledDependent } from "./harness";

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
}

export interface ObjectsRead {
  readonly objects: readonly DeclaredObject[];
  /** Files whose `#if` arms could not be decided: the objects inside a conditional are left out of
   *  `objects` (never a reason to refuse), and each file is named for a warning. */
  readonly undecided: readonly { readonly file: string; readonly reason: string }[];
}

const unquote = (s: string): string =>
  s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

/**
 * Every object declaration of the 13 kinds in `files`, by tree, each file's `#if` arms evaluated
 * under `symbols` (`evaluateArms`). A header split by `#if` (`preproc_split_declaration`) is counted
 * per live arm, not dropped. The caller must have called `initParser()`.
 */
export function declaredObjectsOfSource(
  files: readonly { readonly path: string; readonly text: string }[],
  symbols: readonly string[],
): ObjectsRead {
  const objects: DeclaredObject[] = [];
  const undecided: { file: string; reason: string }[] = [];
  for (const f of files) {
    const root = wrapRoot(parseAL(f.text));
    const arms = evaluateArms(root, f.text, symbols);
    if (arms.kind === "undecided") undecided.push({ file: f.path, reason: arms.reason });
    const live = (n: ALSyntaxNode): boolean =>
      arms.kind === "decided" && !startsInInactiveArm(arms.inactive, n.startIndex);
    const take = (kind: ClashKind, id: ALSyntaxNode | null, name: ALSyntaxNode | null): void => {
      if (id === null) return;
      const n = Number.parseInt(id.text, 10);
      if (Number.isNaN(n)) return;
      objects.push({ kind, id: n, name: unquote(name?.text ?? ""), where: f.path });
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
            } else if (k.fieldName === "object_id") id = k;
            else if (k.fieldName === "object_name") name = k;
          }
          flush();
        } else if (raw.endsWith("_declaration")) {
          const kind = STEM_OF[raw.slice(0, -12)];
          if (kind === undefined) continue;
          if (inside && !live(c)) continue;
          take(kind, c.childForFieldName("object_id"), c.childForFieldName("object_name"));
        }
      }
    };
    visit(root, false);
  }
  return { objects, undecided };
}

/** The objects of a parsed `SymbolReference.json`, through `Namespaces` to any depth. */
export function declaredObjectsOfSymbolReference(json: unknown, where: string): DeclaredObject[] {
  const out: DeclaredObject[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    for (const [key, kind] of SYMBOL_KEYS) {
      const arr = rec[key];
      if (!Array.isArray(arr)) continue;
      for (const o of arr as Array<Record<string, unknown>>) {
        if (typeof o?.Id === "number") {
          out.push({ kind, id: o.Id, name: typeof o.Name === "string" ? o.Name : "", where });
        }
      }
    }
    if (Array.isArray(rec.Namespaces)) for (const n of rec.Namespaces) walk(n);
  };
  walk(json);
  return out;
}

/** The objects of one `.app` package, or why it cannot be read. Never throws. */
export function declaredObjectsOfPackage(
  pkg: Uint8Array,
): { readonly objects: readonly DeclaredObject[] } | { readonly unreadable: string } {
  let entry: Buffer | null;
  try {
    entry = readPackageEntry(
      Buffer.from(pkg.buffer, pkg.byteOffset, pkg.byteLength),
      "SymbolReference.json",
    );
  } catch (err) {
    return { unreadable: `the package is not a readable zip (${String(err)})` };
  }
  if (entry === null) return { unreadable: "the package carries no SymbolReference.json" };
  let text = entry.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { objects: declaredObjectsOfSymbolReference(JSON.parse(text), "SymbolReference.json") };
  } catch (err) {
    return { unreadable: `its SymbolReference.json is not valid JSON (${String(err)})` };
  }
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

/** The refusal. Extends `Error` directly. Nothing was published when it is thrown. */
export class ObjectClashError extends Error {
  readonly code = "object-clash" as const;
  readonly findings: readonly ObjectClashFinding[];

  constructor(findings: readonly ObjectClashFinding[]) {
    const lines = findings.map((f) => {
      const how =
        f.read === "installed-package"
          ? "(read from the package the server holds)"
          : `(read from its SOURCE under symbols [${(f.symbols ?? []).join(", ")}], because its installed package could not be read)`;
      return `${f.kind} ${f.id}: the target declares "${f.target.name}" (${f.target.where}); installed app ${f.app.name} ${f.app.version} by ${f.app.publisher} declares "${f.other.name}" ${how}`;
    });
    super(
      `refusing before anything is published (R843): the target and an installed app declare the same object. BC refuses an upgrade with two apps defining one object ("defined in multiple apps") and, when it cannot restore the old target, removes every installed app that depends on it (R709). ${lines.join("; ")}. Republish the named app built against this target, or remove it from the server, then run again.`,
    );
    this.name = "ObjectClashError";
    this.findings = findings;
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
}

/**
 * Throws `ObjectClashError` when the target shares a (kind, id) with an installed dependent; returns
 * warnings (undecided arms, an unreadable package) otherwise. Reads only; publishes nothing.
 * Call after `initParser()`.
 */
export async function checkObjectClashes(args: ObjectClashCheckArgs): Promise<string[]> {
  const warnings: string[] = [];
  if (!Array.isArray(args.dependents)) return warnings;
  const dependents = args.dependents as readonly InstalledDependent[];
  if (dependents.length === 0) return warnings;
  const targetRead = declaredObjectsOfSource(args.targetFiles, args.targetSymbols);
  for (const u of targetRead.undecided) {
    warnings.push(
      `[lethal] R843: the #if arms of target file ${u.file} could not be decided (${u.reason}); objects inside its conditionals are not compared.`,
    );
  }
  const target = [...targetRead.objects, ...injectedObjects(args.injected)];
  const findings: ObjectClashFinding[] = [];
  for (const d of dependents) {
    let objects: readonly DeclaredObject[] | undefined;
    let read: ObjectClashFinding["read"] = "installed-package";
    let why = "its package could not be fetched";
    if (args.fetchPackage !== undefined) {
      try {
        const got = await args.fetchPackage({ publisher: d.publisher, name: d.name });
        if (got instanceof Uint8Array) {
          const pkg = declaredObjectsOfPackage(got);
          if ("objects" in pkg) objects = pkg.objects;
          else why = pkg.unreadable;
        } else if (isUnread(got)) why = got.unread;
      } catch (err) {
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
    }
    if (objects === undefined) {
      warnings.push(
        `[lethal] R843: could not read the installed package of ${d.name} ${d.version} by ${d.publisher} (${why}); whether it declares an object the target declares was NOT checked.`,
      );
      continue;
    }
    for (const c of findObjectClashes(target, objects)) {
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
  }
  if (findings.length > 0) throw new ObjectClashError(findings);
  return warnings;
}
