/**
 * R845: the members of tables and enums, for the pre-publish clash check. BC refuses an upgrade when
 * two apps give one table the same field id or field name, or one enum the same value ordinal or
 * value name, and when it cannot restore the old target it removes the target and its dependents
 * (R709). Pre-commitment: docs/superpowers/specs/2026-11-06-r845-field-enum-transitive-precommitment.md.
 *
 * The standing rule of that design: a comparison REFUSES only if a BC measurement backs it. Field
 * names that differ only in case, page controls, actions and object names are accepted by BC and are
 * never compared here. Names compare EXACTLY (a trailing space is not measured).
 *
 * Two sides:
 *  - the target, read from its source by tree (`readSourceMembers`);
 *  - an installed app, read from the `SymbolReference.json` of its package (`readPackageMembers`).
 * A source side does not say which app owns a table an extension extends, so it matches on the NAME
 * and refuses only when the package side's owner app is one the target depends on or a Microsoft app.
 */
import type { ALSyntaxNode } from "@lethal/engine";

export type Container = "Table" | "Enum";
export type MemberRule = "field-id" | "field-name" | "enum-ordinal" | "enum-value-name";

/** The Microsoft apps the AL toolchain names in `app.json` (Base Application, System Application,
 *  Business Foundation, Application, System), 32 hex, no dashes, lower case. Any app in the
 *  target's own `dependencies` counts too (`trusted`), whatever its publisher. */
const MICROSOFT_APP_IDS: ReadonlySet<string> = new Set([
  "437dbf0e84ff417a965ded2bb9650972",
  "63ca2fa44f034f2ba480172fef340d3f",
  "f3552374a1f24356848e196002525837",
  "c133504230024257bf8a75c898ccb1b8",
  "8874ed3a064342479ced7a7002f7135d",
]);

/** An app id as the package's `TargetObject` writes it: no dashes, lower case. */
export const bareAppId = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** A member the TARGET declares, read from source. */
export interface SourceMember {
  readonly container: Container;
  /** The table or enum it belongs to, unquoted, last segment only. */
  readonly ownerName: string;
  /** `ownerName` lower-cased: AL names do not care about case. */
  readonly ownerKey: string;
  /** True when the target declares that table or enum itself (or the extension extends one it declares). */
  readonly own: boolean;
  /** A field id, or an enum value ordinal. */
  readonly id: number;
  readonly name: string;
  /** `ObsoleteState = Moved`, `MovedTo` or `MovedFrom` on the member. */
  readonly moved: boolean;
  readonly where: string;
}

/** A member an INSTALLED app declares, read from its package. */
export interface PackageMember {
  readonly container: Container;
  /** The app that owns the table or enum: 32 hex, lower case. */
  readonly ownerApp: string;
  readonly ownerName: string;
  readonly ownerKey: string;
  readonly id: number;
  readonly name: string;
  readonly moved: boolean;
  readonly where: string;
}

/** Strips the quotes of an AL identifier; `""` inside it is one `"`. */
export function unquoteName(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1).replaceAll('""', '"')
    : s;
}

/** `Foo.Two."Other Name"` into its qualifier (`Foo.Two`) and last segment, unquoted. */
export function splitQualified(text: string): { qualifier: string; name: string } {
  const cuts: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "." && !quoted) cuts.push(i);
  }
  const last = cuts.at(-1);
  if (last === undefined) return { qualifier: "", name: unquoteName(text.trim()) };
  return {
    qualifier: text.slice(0, last).replace(/\s+/g, "").replaceAll('"', ""),
    name: unquoteName(text.slice(last + 1).trim()),
  };
}

const isProperty = (n: ALSyntaxNode): boolean => n.rawKind === "property";

/** True when a declaration body's `property` children say Moved. */
export function sourceMoved(body: ALSyntaxNode | null | undefined): boolean {
  if (body === null || body === undefined) return false;
  for (const p of body.children.filter(isProperty)) {
    const name = p.childForFieldName("name")?.text.toLowerCase();
    const value = p.childForFieldName("value")?.text.toLowerCase();
    if (name === "movedto" || name === "movedfrom") return true;
    if (name === "obsoletestate" && value === "moved") return true;
  }
  return false;
}

/** The `declaration_body` child of a declaration, if it has one. */
export const bodyOf = (n: ALSyntaxNode): ALSyntaxNode | undefined =>
  n.children.find((c) => c.rawKind === "declaration_body");

export interface MemberRead {
  readonly members: Omit<SourceMember, "own">[];
  /** Members that could not be read (an id that is not a number). Never left out silently. */
  readonly bad: string[];
}

/**
 * The fields (table, tableextension) or values (enum, enumextension) of one declaration, found at any
 * depth. `live` decides a member under a `#if`: only members under a preproc node are asked.
 */
export function readSourceMembers(
  decl: ALSyntaxNode,
  stem: "table" | "tableextension" | "enum" | "enumextension",
  ownerName: string,
  file: string,
  live: (n: ALSyntaxNode) => boolean,
): MemberRead {
  const container: Container = stem.startsWith("table") ? "Table" : "Enum";
  const memberKind = container === "Table" ? "field_declaration" : "enum_value_declaration";
  const idField = container === "Table" ? "id" : "value_id";
  const nameField = container === "Table" ? "name" : "value_name";
  const members: Omit<SourceMember, "own">[] = [];
  const bad: string[] = [];
  const walk = (n: ALSyntaxNode, underPreproc: boolean): void => {
    for (const k of n.children) {
      if (k.rawKind === memberKind) {
        if (underPreproc && !live(k)) continue;
        const idNode = k.childForFieldName(idField);
        const nameNode = k.childForFieldName(nameField);
        const id = idNode === null ? Number.NaN : Number(idNode.text);
        if (!Number.isInteger(id) || nameNode === null) {
          bad.push(
            `${file}: a ${container === "Table" ? "field" : "value"} of ${ownerName} has no readable id or name`,
          );
          continue;
        }
        members.push({
          container,
          ownerName,
          ownerKey: ownerName.toLowerCase(),
          id,
          name: unquoteName(nameNode.text),
          moved: sourceMoved(bodyOf(k)),
          where: file,
        });
      } else {
        walk(k, underPreproc || k.rawKind.startsWith("preproc"));
      }
    }
  };
  walk(decl, false);
  return { members, bad };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `Properties[]` of a symbol entry says Moved. Present and not an array of objects is a bad entry. */
export function packageMoved(entry: Record<string, unknown>): boolean | { readonly bad: string } {
  const props = entry.Properties;
  if (props === undefined) return false;
  if (!Array.isArray(props)) return { bad: "Properties is present and not an array" };
  let moved = false;
  for (const p of props as unknown[]) {
    if (!isRecord(p)) return { bad: "Properties holds a non-object" };
    const name = typeof p.Name === "string" ? p.Name.toLowerCase() : "";
    const value = typeof p.Value === "string" ? p.Value.toLowerCase() : "";
    if (name === "movedto" || name === "movedfrom") moved = true;
    if (name === "obsoletestate" && value === "moved") moved = true;
  }
  return moved;
}

/** The two forms of `TargetObject`: `#<appid, 32 hex>#Name`, or a bare `Name` (the declaring app's own). */
export function parseTargetObject(
  t: unknown,
): { readonly app: string | undefined; readonly name: string } | { readonly bad: string } {
  if (typeof t !== "string" || t === "") return { bad: "an extension has no string TargetObject" };
  if (!t.startsWith("#")) return { app: undefined, name: t };
  const m = /^#([0-9a-fA-F]{32})#(.+)$/s.exec(t);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    return { bad: `TargetObject ${JSON.stringify(t)} is not #<app id>#Name` };
  }
  return { app: m[1].toLowerCase(), name: m[2] };
}

export interface ExtensionEntry {
  readonly container: Container;
  /** `app` undefined: a bare name, the declaring app's own table or enum. */
  readonly app: string | undefined;
  readonly name: string;
  readonly extensionName: string;
  readonly members: readonly {
    readonly id: number;
    readonly name: string;
    readonly moved: boolean;
  }[];
}

/**
 * One `TableExtensions[]` or `EnumExtensionTypes[]` entry. FAIL-CLOSED: a missing or odd
 * `TargetObject`, a `Fields` or `Values` that is present and not an array, and an entry whose `Id`,
 * `Ordinal` or `Name` has the wrong type are all a `bad` reason, never "declares nothing". A missing
 * `Ordinal` means 0 (BC's symbol file omits it for 0).
 */
export function readExtensionEntry(
  entry: Record<string, unknown>,
  container: Container,
): ExtensionEntry | { readonly bad: string } {
  const target = parseTargetObject(entry.TargetObject);
  if ("bad" in target) return target;
  const arrKey = container === "Table" ? "Fields" : "Values";
  const arr = entry[arrKey];
  if (arr !== undefined && !Array.isArray(arr)) {
    return { bad: `an extension's ${arrKey} is present and not an array` };
  }
  const members: { id: number; name: string; moved: boolean }[] = [];
  for (const m of (arr ?? []) as unknown[]) {
    if (!isRecord(m)) return { bad: `an extension's ${arrKey} holds a non-object` };
    const idKey = container === "Table" ? "Id" : "Ordinal";
    const raw = m[idKey];
    const id = raw === undefined && container === "Enum" ? 0 : raw;
    if (typeof id !== "number" || !Number.isInteger(id)) {
      return { bad: `an extension's ${arrKey} holds an entry whose ${idKey} is not an integer` };
    }
    if (typeof m.Name !== "string") {
      return { bad: `an extension's ${arrKey} holds an entry whose Name is not a string` };
    }
    const moved = packageMoved(m);
    if (typeof moved === "object") return moved;
    members.push({ id, name: m.Name, moved });
  }
  return {
    container,
    app: target.app,
    name: target.name,
    extensionName: typeof entry.Name === "string" ? entry.Name : "",
    members,
  };
}

/**
 * Puts a package's extension entries on their owner app. A bare name belongs to the declaring app,
 * and must be a table or enum that app declares (`ownNames`, lower-cased); otherwise it is returned in
 * `unresolved` by name and not compared.
 */
export function resolveExtensionMembers(
  entries: readonly ExtensionEntry[],
  declaringApp: string,
  ownNames: Readonly<Record<Container, ReadonlySet<string>>>,
  where: string,
): { readonly members: PackageMember[]; readonly unresolved: string[] } {
  const members: PackageMember[] = [];
  const unresolved: string[] = [];
  for (const e of entries) {
    let ownerApp = e.app;
    if (ownerApp === undefined) {
      if (!ownNames[e.container].has(e.name.toLowerCase())) {
        unresolved.push(`${e.extensionName || "(unnamed)"} extends "${e.name}"`);
        continue;
      }
      ownerApp = declaringApp;
    }
    for (const m of e.members) {
      members.push({
        container: e.container,
        ownerApp,
        ownerName: e.name,
        ownerKey: e.name.toLowerCase(),
        id: m.id,
        name: m.name,
        moved: m.moved,
        where,
      });
    }
  }
  return { members, unresolved };
}

export interface MemberPair {
  readonly rule: MemberRule;
  readonly target: SourceMember;
  readonly other: PackageMember;
}

/** Why a matching pair is a warning, not a refusal. */
export type SoftReason = "moved" | "owner-unknown";

export interface MemberCompare {
  readonly clashes: readonly MemberPair[];
  readonly soft: readonly (MemberPair & { readonly reason: SoftReason })[];
}

/** The rule two members of the same table or enum break, or undefined. Id first, then the name EXACTLY. */
export function ruleOf(
  t: { container: Container; id: number; name: string },
  o: { id: number; name: string },
): MemberRule | undefined {
  if (t.id === o.id) return t.container === "Table" ? "field-id" : "enum-ordinal";
  if (t.name === o.name) return t.container === "Table" ? "field-name" : "enum-value-name";
  return undefined;
}

/**
 * The pure comparison. A pair is on the SAME table or enum when:
 *  - the target member is `own` and the package member's owner is the target app, same name; or
 *  - it is not own and the package member's owner is another app, same name. That owner is trusted
 *    (refuse) when it is in `trusted` (the target's dependencies) or is a Microsoft app; otherwise
 *    the same-named table may be another app's, and it warns.
 * A pair with either side Moved warns. The same id, name or ordinal on a different table never pairs.
 */
export function compareMembers(
  target: readonly SourceMember[],
  other: readonly PackageMember[],
  ctx: {
    readonly targetApp: string;
    /** The installed app the `other` members come from (32 hex, lower case). */
    readonly otherApp: string;
    readonly trusted: ReadonlySet<string>;
  },
): MemberCompare {
  const byOwner = new Map<string, PackageMember[]>();
  for (const o of other) {
    const key = `${o.container}:${o.ownerKey}`;
    const list = byOwner.get(key);
    if (list === undefined) byOwner.set(key, [o]);
    else list.push(o);
  }
  const clashes: MemberPair[] = [];
  const soft: (MemberPair & { reason: SoftReason })[] = [];
  const seen = new Set<string>();
  for (const t of target) {
    for (const o of byOwner.get(`${t.container}:${t.ownerKey}`) ?? []) {
      const ownerIsTarget = o.ownerApp === ctx.targetApp;
      if (t.own !== ownerIsTarget) continue;
      if (o.ownerApp === ctx.otherApp) continue;
      // A table the dependent declares itself (a bare TargetObject) is not one the target can
      // extend: the dependent depends on the target, not the other way round.
      const rule = ruleOf(t, o);
      if (rule === undefined) continue;
      const key = `${rule}|${t.container}|${o.ownerApp}|${t.ownerKey}|${t.id}|${t.name}|${o.id}|${o.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pair = { rule, target: t, other: o };
      if (t.moved || o.moved) soft.push({ ...pair, reason: "moved" });
      else if (t.own || ctx.trusted.has(o.ownerApp) || MICROSOFT_APP_IDS.has(o.ownerApp)) {
        clashes.push(pair);
      } else soft.push({ ...pair, reason: "owner-unknown" });
    }
  }
  return { clashes, soft };
}

/**
 * The fallback comparison, for a tests app whose package could not be read: both sides are names
 * only, so every pair WARNS. A tests-app member on a table or enum the tests app declares itself
 * (`own`) is that app's own and is left out.
 */
export function compareMembersBySource(
  target: readonly SourceMember[],
  tests: readonly SourceMember[],
): readonly {
  readonly rule: MemberRule;
  readonly target: SourceMember;
  readonly other: SourceMember;
}[] {
  const out: { rule: MemberRule; target: SourceMember; other: SourceMember }[] = [];
  for (const m of tests) {
    if (m.own) continue;
    for (const t of target) {
      if (t.container !== m.container || t.ownerKey !== m.ownerKey) continue;
      const rule = ruleOf(t, m);
      if (rule !== undefined) out.push({ rule, target: t, other: m });
    }
  }
  return out;
}
