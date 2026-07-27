/**
 * Project-local symbol table (Layer 1).
 *
 * Resolves identifiers in parsed AL source to their definitions: objects
 * (codeunit / table / page / report), procedures, globals, parameters,
 * and procedure-local vars. Base-app / system-app symbols are **out of
 * scope** at Layer 1; callers treat unresolved names as external.
 *
 * Grammar-field adjustments (SShadowS/tree-sitter-al v3.0.1):
 *   - Object header id is exposed as the field `object_id` (not `id`).
 *   - Object header name is exposed as `object_name` (not `name`), and the
 *     name node is either `identifier` or `quoted_identifier`; quotes are
 *     stripped when present.
 *   - `procedure` exposes `name` and `return_type` as fields, but its
 *     parameter list is a positional namedChild of kind `parameter_list`
 *     (no field name in the grammar), so we locate it by kind.
 *   - `parameter` and `variable_declaration` both expose `name` and `type`
 *     as fields, matching the plan.
 *   - v3 wraps an object declaration's members (`var_section`, `procedure`)
 *     in a `declaration_body` container, and a `var_section`'s declarations
 *     in a `var_body` container. See `declarationMembers` / `varDeclarations`
 *     in `ast/tree-walks.ts`, which skip these containers.
 */
import { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import { findAll } from "../ast/syntax-node";
import { declarationMembers, varDeclarations } from "../ast/tree-walks";

export interface SourceFile {
  readonly path: string;
  readonly root: ALSyntaxNode;
}

export interface ObjectSymbol {
  readonly kind: "codeunit" | "table" | "page" | "report";
  readonly id: number;
  readonly name: string;
  readonly node: ALSyntaxNode;
}

/**
 * A `tableextension` declaration, indexed SEPARATELY from `objects`.
 *
 * Not an `ObjectSymbol`: an extension declares no object of its own, it adds members to one the
 * header only NAMES. Folding it into `objects` would silently change what `buildCallerIndex` and
 * `buildTypeTable` (both of which walk `objects`) consider a declaring object, which is a much
 * wider change than the one this exists for. A parallel list changes nothing that already works.
 *
 * WHY IT EXISTS: in AL, a `tableextension`'s public procedures are callable on a variable of the
 * EXTENDED table's type. `Rec.SetRange(A, B)` where a project `tableextension` declares
 * `procedure SetRange(A; B)` is that procedure, not the builtin — so a consumer asking "does the
 * project declare a procedure of this name on this table?" must see extensions or it answers
 * wrongly in the dangerous direction. `claimsRecordMethod` in `@lethal/builtin-tier2` is that
 * consumer.
 *
 * No `id` field: nothing needs it, and an extension whose `object_id` failed to parse would then
 * have to be either dropped (losing a refusal) or given a fabricated id. `name` and `baseObject`
 * are the two the matching actually depends on, and an entry is indexed only when both are real.
 */
export interface ExtensionSymbol {
  readonly kind: "tableextension";
  /** The extension object's own name, quotes stripped. */
  readonly name: string;
  /** The `extends` target verbatim, quotes stripped — always a NAME in AL, never an id. */
  readonly baseObject: string;
  readonly node: ALSyntaxNode;
}

export interface VarSymbol {
  readonly name: string;
  readonly typeText: string;
  readonly node: ALSyntaxNode;
}

export interface ProcedureSymbol {
  readonly name: string;
  readonly owner: string;
  readonly parameters: readonly VarSymbol[];
  readonly locals: readonly VarSymbol[];
  readonly returnType: string | null;
  readonly node: ALSyntaxNode;
}

export interface SymbolTable {
  resolveObject(q: {
    kind: ObjectSymbol["kind"];
    idOrName: string;
  }): ObjectSymbol | null;
  resolveProcedure(ownerName: string, procName: string): ProcedureSymbol | null;
  globalsOf(ownerName: string): readonly VarSymbol[];
  localsOf(ownerName: string, procName: string): readonly VarSymbol[];
  readonly objects: readonly ObjectSymbol[];
  /** Every `tableextension` in the project — see `ExtensionSymbol`. Empty, never absent. */
  readonly tableExtensions: readonly ExtensionSymbol[];
}

const OBJECT_KIND_BY_NODE: Record<string, ObjectSymbol["kind"]> = {
  [ALNodeKind.codeunit]: "codeunit",
  [ALNodeKind.table]: "table",
  [ALNodeKind.page]: "page",
  [ALNodeKind.report]: "report",
};

/**
 * The grammar's node kind for `tableextension 50000 "X" extends "Y"`, and its `extends` field.
 *
 * Local consts rather than `ALNodeKind` members, matching how `receiver.ts` handles
 * `quoted_identifier`: `ALNodeKind` enumerates the kinds the mutation pipeline TARGETS, and
 * widening it also widens `isALNodeKind`, which every `ALSyntaxNode.kind` consumer reads.
 * Measured against the vendored tree-sitter-al v3.0.1 grammar: the header exposes `object_id`,
 * `object_name` and `base_object` as fields, and members sit in the same `declaration_body`
 * container an ordinary object uses.
 */
const TABLEEXTENSION_DECLARATION = "tableextension_declaration";
const BASE_OBJECT_FIELD = "base_object";

/**
 * The `procedures`/`globals` key under which a `tableextension`'s own members are indexed for
 * VARIABLE SCOPE lookup (R30).
 *
 * Namespaced on purpose. The bare extension name must keep resolving to nothing, because
 * `resolveProcedure("My Ext", "SetRange")` would otherwise answer for a receiver no AL expression
 * can name — the documented reason extensions were skipped in the first place. This lets a caller
 * that legitimately needs the extension's SCOPE ask for it without weakening that contract.
 */
export function extensionScopeKey(extensionName: string): string {
  return `tableextension:${extensionName}`;
}

export function buildSymbolTable(files: readonly SourceFile[]): SymbolTable {
  const objects: ObjectSymbol[] = [];
  const procedures = new Map<string, ProcedureSymbol[]>();
  const globals = new Map<string, VarSymbol[]>();

  const tableExtensions: ExtensionSymbol[] = [];

  /**
   * Index one declaration's members (globals, procedures with their locals and parameters) under
   * `ownerName`. Shared by ordinary objects and by `tableextension`s — see the extension branch
   * below for why an extension owns its members for SCOPE purposes while owning no call target.
   */
  const indexMembers = (objectNode: ALSyntaxNode, ownerName: string): void => {
    // Object members (var_section, procedure) sit inside v3's
    // declaration_body container rather than being direct namedChildren.
    const members = declarationMembers(objectNode);

    // Globals: a var_section that's a direct member of the object.
    const objectVarSection = members.find((c) => c.kind === ALNodeKind.var_section);
    if (objectVarSection !== undefined) {
      globals.set(ownerName, collectVarDeclarations(objectVarSection));
    }

    // Procedures: direct members of kind `procedure`. Avoid a recursive
    // search so we don't misattribute nested future constructs.
    const procs: ProcedureSymbol[] = [];
    for (const child of members) {
      if (child.kind !== ALNodeKind.procedure) continue;
      const proc = parseProcedure(child, ownerName);
      if (proc !== null) procs.push(proc);
    }
    procedures.set(ownerName, procs);
  };

  for (const file of files) {
    for (const objectNode of file.root.children) {
      const extension = parseTableExtensionHeader(objectNode);
      if (extension !== null) {
        tableExtensions.push({ ...extension, node: objectNode });
        // NOT pushed to `objects`: an extension's procedures belong to the EXTENDED table, not to
        // an object of its own, and registering it as an object would invent a call target no AL
        // expression can name. `resolveObject` and `types.ts` (which iterates `objects`) therefore
        // never see it, and procedure SHADOWING keeps going through `tableExtensions` /
        // `extensionDeclaresProcedure`, keyed on the extended table.
        //
        // Its MEMBERS are indexed for VARIABLE SCOPE — R30 — but under a NAMESPACED key, never
        // under the bare extension name. Scope and callability are different questions: a local,
        // parameter or global declared inside an extension is visible only there, so for scope the
        // extension genuinely is the owner; but `resolveProcedure("My Ext", ...)` must keep
        // answering `null`, because that receiver is one no AL call can name. Keying scope
        // separately keeps both true, and the test asserting the second is deliberately unchanged.
        //
        // Skipping this entirely made `lookupVar` find nothing for a site written in an extension,
        // so every call on a declared record variable there was refused as unresolvable. Measured
        // on Continia Document Output: that is the shape its extension code overwhelmingly uses.
        indexMembers(objectNode, extensionScopeKey(extension.name));
        continue;
      }
      const header = parseObjectHeader(objectNode);
      if (header === null) continue;
      objects.push({ ...header, node: objectNode });
      indexMembers(objectNode, header.name);
    }
  }

  const resolveProcedure = (ownerName: string, procName: string): ProcedureSymbol | null => {
    const list = procedures.get(ownerName);
    if (list === undefined) return null;
    return list.find((p) => p.name === procName) ?? null;
  };

  return {
    resolveObject({ kind, idOrName }) {
      const id = Number.parseInt(idOrName, 10);
      for (const o of objects) {
        if (o.kind !== kind) continue;
        if (!Number.isNaN(id) && o.id === id) return o;
        if (o.name === idOrName) return o;
      }
      return null;
    },
    resolveProcedure,
    globalsOf(ownerName) {
      return globals.get(ownerName) ?? [];
    },
    localsOf(ownerName, procName) {
      return resolveProcedure(ownerName, procName)?.locals ?? [];
    },
    objects,
    tableExtensions,
  };
}

/**
 * `tableextension <id> "<name>" extends "<base>"` -> its name and its extends target.
 *
 * `null` for any other node kind, and for an extension missing either name — both are what the
 * matching in `@lethal/builtin-tier2`'s `claimsRecordMethod` keys on, and half an entry could
 * only ever produce a wrong match.
 */
function parseTableExtensionHeader(
  node: ALSyntaxNode,
): { kind: "tableextension"; name: string; baseObject: string } | null {
  if (node.rawKind !== TABLEEXTENSION_DECLARATION) return null;
  const nameNode = node.childForFieldName("object_name");
  const baseNode = node.childForFieldName(BASE_OBJECT_FIELD);
  if (nameNode === null || baseNode === null) return null;
  const name = stripQuotes(nameNode.text);
  const baseObject = stripQuotes(baseNode.text);
  if (name === "" || baseObject === "") return null;
  return { kind: "tableextension", name, baseObject };
}

function parseObjectHeader(
  node: ALSyntaxNode,
): { kind: ObjectSymbol["kind"]; id: number; name: string } | null {
  const kind = OBJECT_KIND_BY_NODE[node.kind];
  if (kind === undefined) return null;

  const idNode = node.childForFieldName("object_id");
  const nameNode = node.childForFieldName("object_name");
  if (idNode === null || nameNode === null) return null;

  const id = Number.parseInt(idNode.text, 10);
  if (Number.isNaN(id)) return null;
  const name = stripQuotes(nameNode.text);
  return { kind, id, name };
}

function parseProcedure(node: ALSyntaxNode, owner: string): ProcedureSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return null;

  // parameter_list has no field name in the grammar; find by kind.
  const paramsNode = node.namedChildren.find((c) => c.kind === ALNodeKind.parameter_list);
  const parameters = paramsNode === undefined ? [] : collectParameters(paramsNode);

  // Procedure-local vars: a var_section that is a direct namedChild of the
  // procedure node (not nested inside the code_block).
  const varSection = node.namedChildren.find((c) => c.kind === ALNodeKind.var_section);
  const locals = varSection === undefined ? [] : collectVarDeclarations(varSection);

  const returnTypeNode = node.childForFieldName("return_type");
  const returnType = returnTypeNode === null ? null : returnTypeNode.text;

  return {
    name: stripQuotes(nameNode.text),
    owner,
    parameters,
    locals,
    returnType,
    node,
  };
}

function collectParameters(paramsNode: ALSyntaxNode): VarSymbol[] {
  const out: VarSymbol[] = [];
  for (const p of findAll(paramsNode, ALNodeKind.parameter)) {
    const name = p.childForFieldName("name")?.text ?? "";
    const type = p.childForFieldName("type")?.text ?? "";
    if (name !== "") {
      out.push({ name: stripQuotes(name), typeText: type, node: p });
    }
  }
  return out;
}

function collectVarDeclarations(varSection: ALSyntaxNode): VarSymbol[] {
  const out: VarSymbol[] = [];
  for (const decl of varDeclarations(varSection)) {
    if (decl.kind !== ALNodeKind.variable_declaration) continue;
    const name = decl.childForFieldName("name")?.text ?? "";
    const type = decl.childForFieldName("type")?.text ?? "";
    if (name !== "") {
      out.push({ name: stripQuotes(name), typeText: type, node: decl });
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}
