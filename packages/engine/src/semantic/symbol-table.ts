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
}

const OBJECT_KIND_BY_NODE: Record<string, ObjectSymbol["kind"]> = {
  [ALNodeKind.codeunit]: "codeunit",
  [ALNodeKind.table]: "table",
  [ALNodeKind.page]: "page",
  [ALNodeKind.report]: "report",
};

export function buildSymbolTable(files: readonly SourceFile[]): SymbolTable {
  const objects: ObjectSymbol[] = [];
  const procedures = new Map<string, ProcedureSymbol[]>();
  const globals = new Map<string, VarSymbol[]>();

  for (const file of files) {
    for (const objectNode of file.root.children) {
      const header = parseObjectHeader(objectNode);
      if (header === null) continue;
      objects.push({ ...header, node: objectNode });

      // Object members (var_section, procedure) sit inside v3's
      // declaration_body container rather than being direct namedChildren.
      const members = declarationMembers(objectNode);

      // Globals: a var_section that's a direct member of the object.
      const objectVarSection = members.find((c) => c.kind === ALNodeKind.var_section);
      if (objectVarSection !== undefined) {
        globals.set(header.name, collectVarDeclarations(objectVarSection));
      }

      // Procedures: direct members of kind `procedure`. Avoid a recursive
      // search so we don't misattribute nested future constructs.
      const procs: ProcedureSymbol[] = [];
      for (const child of members) {
        if (child.kind !== ALNodeKind.procedure) continue;
        const proc = parseProcedure(child, header.name);
        if (proc !== null) procs.push(proc);
      }
      procedures.set(header.name, procs);
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
  };
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
