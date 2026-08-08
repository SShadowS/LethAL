import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Enumerate every leaf path a TYPE can produce, by reading the type declaration itself.
 *
 * R115 gap (1). `EXPLAIN_LEAF_PATHS` pins the leaves the projection is allowed to emit, and it was
 * built from OBSERVED output — the fixture plus the six committed reports. A field emitted under a
 * condition none of them reaches is therefore invisible in BOTH directions: it produces no unpinned
 * leaf (it never appears) and no dead pin entry (it was never listed). Measured with
 * `...(survivors.length > 200 ? { summary: "…" } : {})` at 43 pass / 0 fail, because the largest
 * committed report has 125 survivors. "Only summarize on a big run" is a natural thing to write.
 *
 * The type does not have that blind spot: `summary?: string` is in the declaration whether or not
 * any report provokes it. So the pin is compared against the TYPE here, and separately against the
 * observed output by the existing tests. A field that no report reaches now fails the SECOND of
 * those — it enters the pin via the type and then has no producer — which is the direction that
 * catches it.
 *
 * PARSE-ONLY, deliberately. `ts.createSourceFile` reads the declarations without building a
 * program or a type checker: no `tsconfig` resolution, no `node_modules` walk, milliseconds rather
 * than seconds, and no dependency on the per-package `dist` directories — which `bun test` runs are
 * required to delete before starting (CLAUDE.md's build order). The cost is that this resolves type names
 * LEXICALLY: a name declared in one of the given files is expanded, anything else is a leaf.
 *
 * That cost is the right one here and is checked rather than assumed. Every type this walker treats
 * as a leaf must genuinely be one — a union of string literals, a primitive, an indexed access into
 * a union — and `expectedLeafTypeNames` makes the caller state that list, so a struct-shaped type
 * arriving from another module cannot be silently flattened into one path.
 */
export interface TypeLeafPathOptions {
  /** Absolute paths of the `.ts` files whose declarations may be expanded. */
  readonly files: readonly string[];
  /** The root type to walk, e.g. `"ExplainOutput"`. */
  readonly root: string;
  /**
   * Every type NAME this walk is allowed to treat as a leaf, stated by the caller.
   *
   * Fails loudly on anything else. Without it, a type reference this walker cannot resolve — a
   * struct imported from a module the caller forgot to list, say — would silently become ONE leaf
   * path instead of the several it really contains, and the pin would go green over a hole. That
   * is the empty-vs-empty shape this project keeps producing, so it is refused rather than
   * defaulted.
   */
  readonly expectedLeafTypeNames: readonly string[];
}

/** Thrown when the walk cannot be completed. A caller-contract violation, never a soft default. */
export class TypeLeafPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeLeafPathError";
  }
}

type Members = ReadonlyMap<string, ts.TypeNode | undefined>;

/**
 * `ReportValidity["reliability"]` from its two halves, rather than via `node.getText()`.
 *
 * The interfaces here are rebuilt as synthetic `TypeLiteral`s so that interfaces and inline object
 * types take one path through `walk`, and a synthetic parent is exactly the thing that makes
 * `getText()` unreliable — it reads from the source file the node's parent chain leads to.
 * Reconstructing the text depends on nothing but the two child nodes.
 */
function indexedAccessText(node: ts.IndexedAccessTypeNode): string {
  const object =
    ts.isTypeReferenceNode(node.objectType) && ts.isIdentifier(node.objectType.typeName)
      ? node.objectType.typeName.text
      : "?";
  const index =
    ts.isLiteralTypeNode(node.indexType) && ts.isStringLiteral(node.indexType.literal)
      ? `"${node.indexType.literal.text}"`
      : "?";
  return `${object}[${index}]`;
}

function collectDeclarations(files: readonly string[]): Map<string, ts.TypeNode> {
  const out = new Map<string, ts.TypeNode>();
  for (const file of files) {
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    for (const stmt of src.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        // Rebuild the interface as a TypeLiteral so interfaces and inline object types take the
        // same path through `walk` below.
        out.set(
          stmt.name.text,
          ts.factory.createTypeLiteralNode(stmt.members as unknown as readonly ts.TypeElement[]),
        );
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        out.set(stmt.name.text, stmt.type);
      }
    }
  }
  return out;
}

function membersOf(node: ts.TypeLiteralNode): Members {
  const m = new Map<string, ts.TypeNode | undefined>();
  for (const member of node.members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = member.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    m.set(name.text, member.type);
  }
  return m;
}

/**
 * A type is STRUCTURAL if walking into it produces more than one path; everything else is a leaf.
 * Only three forms are structural: an object type, an array of one, and a name that resolves to
 * either.
 */
function isLeafShape(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return false;
  if (ts.isArrayTypeNode(node)) return false;
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return false;
  if (ts.isParenthesizedTypeNode(node)) return isLeafShape(node.type);
  return true;
}

export function typeLeafPaths(opts: TypeLeafPathOptions): readonly string[] {
  const declared = collectDeclarations(opts.files);
  const root = declared.get(opts.root);
  if (root === undefined) {
    throw new TypeLeafPathError(
      `typeLeafPaths: no interface or type alias named "${opts.root}" in ${opts.files.join(", ")}`,
    );
  }
  const allowedLeafNames = new Set(opts.expectedLeafTypeNames);
  const paths: string[] = [];
  const seen = new Set<string>();

  const walk = (node: ts.TypeNode, path: string): void => {
    // `readonly T[]` parses as a TypeOperator wrapping an ArrayType; `T[]` is the ArrayType alone.
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      walk(node.type, path);
      return;
    }
    if (ts.isParenthesizedTypeNode(node)) {
      walk(node.type, path);
      return;
    }
    if (ts.isArrayTypeNode(node)) {
      walk(node.elementType, `${path}[]`);
      return;
    }
    if (ts.isTypeLiteralNode(node)) {
      const members = membersOf(node);
      if (members.size === 0) {
        throw new TypeLeafPathError(
          `typeLeafPaths: the object type at ${path} has no readable property signatures`,
        );
      }
      for (const [name, type] of members) {
        if (type === undefined) {
          throw new TypeLeafPathError(`typeLeafPaths: property ${path}.${name} has no type node`);
        }
        walk(type, `${path}.${name}`);
      }
      return;
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      // `readonly string[]` also appears as `ReadonlyArray<string>` in some styles.
      if (name === "ReadonlyArray" || name === "Array") {
        const arg = node.typeArguments?.[0];
        if (arg === undefined) {
          throw new TypeLeafPathError(`typeLeafPaths: ${name} at ${path} has no type argument`);
        }
        walk(arg, `${path}[]`);
        return;
      }
      const target = declared.get(name);
      if (target !== undefined && !isLeafShape(target)) {
        // Recursion guard: a self-referential type would otherwise loop forever. Nothing in
        // `ExplainOutput` is recursive today, and a future one should fail loudly rather than hang.
        if (seen.has(`${name}@${path}`)) {
          throw new TypeLeafPathError(
            `typeLeafPaths: recursive type ${name} reached again at ${path}`,
          );
        }
        seen.add(`${name}@${path}`);
        walk(target, path);
        return;
      }
    }
    assertReallyALeaf(node, path);
    paths.push(path);
  };

  /**
   * Everything reaching here is about to become ONE path. Anything that is not obviously a single
   * value has to be named by the caller first — a struct that slipped through as a leaf would hide
   * every field inside it and the pin would go green over the hole.
   *
   * Primitives, literals, `null`/`undefined` and unions of those are single values by inspection.
   * A named reference or an indexed access is not, so it must appear in `expectedLeafTypeNames`
   * under the text used here.
   */
  function assertReallyALeaf(node: ts.TypeNode, path: string, via: Set<string> = new Set()): void {
    if (ts.isUnionTypeNode(node)) {
      // A union of leaves is a leaf; a union CONTAINING a struct is not, and each arm is checked.
      for (const arm of node.types) assertReallyALeaf(arm, path, via);
      return;
    }
    if (ts.isParenthesizedTypeNode(node)) {
      assertReallyALeaf(node.type, path, via);
      return;
    }
    // A name the caller has DECLARED to be one value is taken at its word — that declaration is
    // the readable statement, and checking it first means a caller can name a local alias
    // (`ToolCondition`) instead of the expression it happens to be defined by today.
    //
    // Otherwise an alias declared in one of the given files is followed through to whatever it
    // really is, so a struct hiding behind an alias still expands rather than collapsing to a leaf.
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (allowedLeafNames.has(node.typeName.text)) return;
      const target = declared.get(node.typeName.text);
      if (target !== undefined) {
        if (via.has(node.typeName.text)) {
          throw new TypeLeafPathError(
            `typeLeafPaths: alias cycle through ${node.typeName.text} at ${path}`,
          );
        }
        assertReallyALeaf(target, path, new Set([...via, node.typeName.text]));
        return;
      }
    }
    if (ts.isLiteralTypeNode(node)) return;
    if (
      node.kind === ts.SyntaxKind.StringKeyword ||
      node.kind === ts.SyntaxKind.NumberKeyword ||
      node.kind === ts.SyntaxKind.BooleanKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.UndefinedKeyword
    ) {
      return;
    }
    // `ReportValidity["reliability"]` — named by its written text, so listing it in
    // `expectedLeafTypeNames` is a statement about that exact member, not about the whole type.
    const name = ts.isIndexedAccessTypeNode(node)
      ? indexedAccessText(node)
      : ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
        ? node.typeName.text
        : undefined;
    if (name !== undefined && allowedLeafNames.has(name)) return;
    throw new TypeLeafPathError(
      `typeLeafPaths: ${path} has type "${name ?? ts.SyntaxKind[node.kind]}", which is neither expanded (not declared in the given files, or declared as a non-object) nor listed in expectedLeafTypeNames. Treating it as a single leaf would hide every field inside it — add the file that declares it, or list it in expectedLeafTypeNames if it really is one value.`,
    );
  }

  walk(root, "$");
  if (paths.length === 0) {
    throw new TypeLeafPathError(`typeLeafPaths: ${opts.root} produced no leaf paths`);
  }
  return paths;
}
