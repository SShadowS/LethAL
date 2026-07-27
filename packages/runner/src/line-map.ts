import { ALNodeKind, type ALSyntaxNode } from "@lethal/engine";

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
   * | file | object | keyword at file line | measured base |
   * |---|---|---|---|
   * | single-object | 79320 | 1 | 1 |
   * | two-object | 79322 | 29 | **28** |
   *
   * Both fit one rule — objects PARTITION the file, each beginning one line after the previous one
   * ends, with the first beginning at line 1 — and the "keyword line" hypothesis fits neither
   * jointly. The leading blank line before `codeunit 79322` therefore belongs to that object.
   *
   * NOT yet discriminated: a gap of TWO or more blank lines between objects, where "previous end
   * + 1" and "keyword − 1" diverge. This code implements "previous end + 1"; `buildLineMap`
   * computes it that way rather than from the node's own start position for exactly that reason.
   * Validate it on the first real session before trusting member-level attribution from a
   * multi-object file.
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
      this.byObject.set(keyOf(e.objectType, e.objectId), {
        procedures: procedureSpans(e.root, e.baseLine),
      });
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
        throw new Error(
          `line-map: the compiled artifact declares ${key} but no line map was built for it — ` +
            "every declared object's source is written by LethAL and must be mappable. This is a " +
            "LethAL bug, not a problem with the project under test.",
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
