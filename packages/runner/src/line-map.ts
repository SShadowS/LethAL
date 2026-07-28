import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ALNodeKind, type ALSyntaxNode, initParser, parseAL, wrapRoot } from "@lethal/engine";

/**
 * R58: maps a BC `Code Coverage` row's `(objectType, objectId, lineNo)` to the procedure that owns
 * it, so coverage collected on the FENCED path can be keyed the way `coverageFilter` expects.
 *
 * The hub returns a `methodId` that `AppMethodIndex` names. The fence returns a LINE NUMBER, so
 * this reconstructs the mapping from the source LethAL itself emitted and compiled.
 *
 * **This is the step where a mistake becomes a wrong verdict rather than a missing mutant.** A line
 * attributed to the wrong procedure produces a confident, non-empty, WRONG covering set — precisely
 * the R29 failure that made 10 of 20 fixture survivors false. Every rule below is chosen to fail
 * toward "say less" rather than "guess".
 */

/** A procedure's line span in OBJECT-relative coordinates, inclusive at both ends. */
interface ProcedureSpan {
  readonly name: string;
  readonly firstLine: number;
  readonly lastLine: number;
}

interface ObjectLines {
  /** Procedures only — triggers are deliberately absent. See `lookup`'s rule 4. */
  readonly procedures: readonly ProcedureSpan[];
}

/** Key for the `(objectType, objectId)` pair. Never the bare id: a table and a codeunit may share
 *  one, which is the bug `6e89948` fixed for the hub's coverage map. */
function keyOf(objectType: string, objectId: number): string {
  return `${objectType.toLowerCase()}:${objectId}`;
}

export interface LineMapEntry {
  readonly objectType: string;
  readonly objectId: number;
  readonly root: ALSyntaxNode;
  /**
   * 1-based line of the FILE at which this object's own line numbering starts.
   *
   * MEASURED, and not what it looks like. BC numbers coverage lines OBJECT-relative, and the base
   * is NOT the `codeunit`/`table` keyword line:
   *
   * | file | object | keyword at file line | blank lines before | measured base |
   * |---|---|---|---|---|
   * | single-object | 79320 | 1 | — | 1 |
   * | two-object | 79322 | 29 | 1 | 28 |
   * | three-object | 79324 | 44 | **2** | **42** |
   *
   * The rule is: objects PARTITION the file — each begins one line after the previous one ends,
   * with the first beginning at line 1. Leading blank lines belong to the object that FOLLOWS them.
   *
   * The third row is the one that proves it. With a single blank line, "previous end + 1" and
   * "keyword − 1" coincide, so the first two measurements agreed with each other AND with a wrong
   * hypothesis. Two blank lines separate them: object 79324's `Third` spans FILE lines 46-49, and
   * BC reported object lines 5-8 — which is base 42 (previous end + 1), not 43 (keyword − 1) or 44
   * (keyword). Hence `fileLineMapEntries` tracks the previous object's end rather than reading the
   * node's own start position.
   *
   * An off-by-one here does not error. It shifts every range onto its neighbour, which on adjacent
   * procedures yields the wrong name with full confidence — the R29 shape.
   */
  readonly baseLine: number;
}

export class LineMap {
  private readonly byObject = new Map<string, ObjectLines>();

  /**
   * @param declared the `(objectType, objectId)` pairs the compiled ARTIFACT declares. A coverage
   *   row for anything else — Base App, System App, Test Runner, the test app, Continia Core,
   *   LethAL's own control codeunits — is skipped, not an error. `CoverageArray` serializes the
   *   whole `Code Coverage` table, so most rows are legitimately not ours; the hub path already
   *   skips them for the same reason (`AppMethodIndex.lookup`: "callers should skip it").
   */
  constructor(
    entries: readonly LineMapEntry[],
    private readonly declared: ReadonlySet<string>,
  ) {
    for (const e of entries) {
      const key = keyOf(e.objectType, e.objectId);
      // Undeclared objects are not merely unqueried — they are never INDEXED. `buildLineMap` parses
      // every `.al` in the batch dir, and `prepareBatchProject` deliberately copies Document
      // Output's 137 `.dependencies` sources (R39) whose objects are published by their own apps.
      // Indexing those would let a real coverage row resolve to a plausible-but-wrong member name
      // from text that is not what the server actually runs — R29 with extra steps. Filtering here
      // rather than at the call site makes that structurally impossible for every future caller.
      //
      // AFTER `fileLineMapEntries` computed the base lines, never before: objects PARTITION the
      // file, so an undeclared object still consumes the lines its declared neighbours are numbered
      // relative to.
      if (!declared.has(key)) continue;
      this.byObject.set(key, { procedures: procedureSpans(e.root, e.baseLine) });
    }
  }

  /** Whether the compiled artifact declares this object at all. */
  declares(objectType: string, objectId: number): boolean {
    return this.declared.has(keyOf(objectType, objectId));
  }

  /**
   * The procedure owning `lineNo`, or `undefined` for "this object, but no nameable member".
   *
   * `undefined` is a real answer, not a failure, and callers must emit an OBJECT-level
   * `CoverageEntry` for it rather than dropping the observation — dropping it is what made table
   * triggers false survivors (R29). It is returned for:
   *
   * - **line 0**, which BC emits as an object-level row (measured)
   * - **trigger bodies**, which are deliberately not indexed: emitting a trigger name would land in
   *   `byMember` under a key no mutant ever queries (`coverageFilter` builds `<type>:<id>::` for a
   *   trigger mutant, whose `procedureName` is `""`), so it would be harmless AND invisible to the
   *   differential gate — a silent divergence from the hub's `byObject`-only behaviour
   * - var sections, blank lines and anything else between procedures
   *
   * Throws only when the artifact DECLARES the object but this map has no entry for it. That is a
   * caller-contract violation — the artifact was compiled from source LethAL wrote — and the
   * project's rule is to fail loudly rather than return a plausible empty default.
   */
  lookup(objectType: string, objectId: number, lineNo: number): string | undefined {
    const key = keyOf(objectType, objectId);
    const entry = this.byObject.get(key);
    if (entry === undefined) {
      if (this.declared.has(key)) {
        const why =
          "every declared object's source is written by LethAL and must be mappable. " +
          "This is a LethAL bug, not a problem with the project under test.";
        throw new Error(
          `line-map: the compiled artifact declares ${key} but no line map was built for it — ${why}`,
        );
      }
      return undefined; // not ours: platform/base-app/test-app code incidentally covered
    }
    // Line 0 is BC's object-level row. Deliberately checked before the span scan so it can never
    // fall inside a procedure whose range happens to start at 0 through some future bug.
    if (lineNo <= 0) return undefined;
    for (const p of entry.procedures) {
      if (lineNo >= p.firstLine && lineNo <= p.lastLine) return p.name;
    }
    return undefined;
  }
}

/**
 * Procedure spans for one object, in OBJECT-relative coordinates.
 *
 * Built from the PARSE, never a regex. `findLocalProcedureNames` is regex-based and its own doc
 * justifies that as a safe over-approximation for a different purpose; here a regex fooled by the
 * word `procedure` inside a comment or a string literal mis-draws a range and produces a wrong
 * member key, which is the wrong-verdict failure this module exists to avoid.
 */
function procedureSpans(objectRoot: ALSyntaxNode, baseLine: number): ProcedureSpan[] {
  const spans: ProcedureSpan[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.procedure) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode === null ? null : stripQuotes(nameNode.text);
      if (name !== null && name !== "") {
        // Measured: BC's rows span a procedure CONTIGUOUSLY from its declaration line through its
        // closing `end;`, so the node's own line extent is exactly the right range.
        spans.push({
          name,
          firstLine: n.startPosition.row + 1 - baseLine + 1,
          lastLine: n.endPosition.row + 1 - baseLine + 1,
        });
      }
      return; // do not descend: a nested construct belongs to this procedure, not its own span
    }
    for (const c of n.children) walk(c);
  };
  walk(objectRoot);
  return spans;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

/**
 * Builds the per-object entries for one parsed FILE.
 *
 * `baseLine` is computed as "one past the previous object's last line", with the first object
 * based at line 1 — see `LineMapEntry.baseLine` for the measurements that rule comes from and the
 * case that has not yet discriminated it.
 */
export function fileLineMapEntries(
  fileRoot: ALSyntaxNode,
  objectIdentity: (node: ALSyntaxNode) => { objectType: string; objectId: number } | null,
): LineMapEntry[] {
  const entries: LineMapEntry[] = [];
  let previousEndLine = 0; // so the first object bases at 1
  for (const node of fileRoot.children) {
    const identity = objectIdentity(node);
    if (identity === null) continue;
    entries.push({
      objectType: identity.objectType,
      objectId: identity.objectId,
      root: node,
      baseLine: previousEndLine + 1,
    });
    previousEndLine = node.endPosition.row + 1;
  }
  return entries;
}

/**
 * The grammar's object-declaration node kinds, mapped to the type NAMES coverage rows key on.
 *
 * The values must match `objectTypeName`'s (app-package.ts) exactly — a coverage row arrives as a
 * BC integer, is named by that function, and is then looked up here; a spelling that disagrees
 * would key `"Xmlport:50011"` against `"XmlPort:50011"` and resolve nothing, which is
 * indistinguishable from "the test covered no member of this object".
 *
 * Probed against the vendored tree-sitter-al grammar rather than read off the kind list:
 * `ALNodeKind` names only six of the eight, but the grammar does produce `query_declaration` and
 * `xmlport_declaration`, each with the same `object_id` field. Enum/interface/permissionset
 * declarations are absent deliberately — `AppMethodIndex.declaredObjects()` does not report them
 * either, so they are never queried and never trip the declared-but-unmapped throw.
 */
const OBJECT_KIND_TO_TYPE_NAME: Readonly<Record<string, string>> = {
  [ALNodeKind.table]: "Table",
  [ALNodeKind.report]: "Report",
  [ALNodeKind.codeunit]: "Codeunit",
  xmlport_declaration: "XmlPort",
  [ALNodeKind.page]: "Page",
  query_declaration: "Query",
  [ALNodeKind.pageextension]: "PageExtension",
  [ALNodeKind.tableextension]: "TableExtension",
};

/** The `(objectType, objectId)` of an object declaration node, or null for anything else. */
export function objectIdentityOf(
  node: ALSyntaxNode,
): { objectType: string; objectId: number } | null {
  const objectType = OBJECT_KIND_TO_TYPE_NAME[node.kind];
  if (objectType === undefined) return null;
  const idNode = node.childForFieldName("object_id");
  if (idNode === null) return null;
  const objectId = Number.parseInt(idNode.text, 10);
  if (Number.isNaN(objectId)) return null;
  return { objectType, objectId };
}

/**
 * Builds the line map for one compiled artifact from the source it was compiled FROM.
 *
 * `projectDir` is the instrumented batch dir — the exact text `alc` read, so the lines BC reports
 * are lines of this source. (Unknown #6 in the spec: the published artifact IS the instrumented
 * source, so any line that resolves at all resolves in the right frame; the check is that the
 * resolved names are sane, not that the frame might be the original file's.)
 *
 * `declared` comes from the compiled package's own `SymbolReference.json`
 * (`AppMethodIndex.declaredObjects()`) and is the ONLY scope: every other object parsed here —
 * copied `.dependencies` sources, anything alc ignored — is dropped by the `LineMap` constructor.
 *
 * Parses every `.al` in the dir, exactly as `generateMutationSet` already does over the same source
 * tree, rather than pre-filtering by a regex: a regex that misses an object header would leave a
 * DECLARED object unmapped, which is rule 2's throw — a loud abort of a real run in exchange for
 * saving a parse.
 */
export async function buildLineMap(
  projectDir: string,
  declared: ReadonlySet<string>,
): Promise<LineMap> {
  await initParser();
  const files = (await readdir(projectDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  const entries: LineMapEntry[] = [];
  for (const rel of files) {
    const source = await readFile(join(projectDir, rel), "utf8");
    entries.push(...fileLineMapEntries(wrapRoot(parseAL(source)), objectIdentityOf));
  }
  return new LineMap(entries, declared);
}
