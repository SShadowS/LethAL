import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type ArmEvaluation,
  initParser,
  isProcedureLike,
  objectDeclarationsOf,
  parseAL,
  procedureLikeArmNames,
  procedureLikeNameNode,
  renamedMemberCoverageNames,
  startsInInactiveArm,
  wrapRoot,
} from "@lethal/engine";
import { FLAT_NAMES_FILENAME, displayPathsOf } from "@lethal/schemata";
import type { BuildBackend } from "./preprocessor-symbols";

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
  /**
   * R318: set only on a split member whose `#if` arms RENAME it (spanned under its first coverage
   * name): every arm's own name, lower-cased. The server re-key accepts only a producer scope
   * that is one of these.
   */
  readonly arms?: readonly string[];
}

interface ObjectLines {
  /** Procedures only — triggers are deliberately absent. See `lookup`'s rule 4. */
  readonly procedures: readonly ProcedureSpan[];
  /**
   * R175: trigger spans, indexed for CLASSIFICATION ONLY and never for naming.
   *
   * `lookup` still returns `undefined` for a trigger line, for the reason rule 4 gives: naming one
   * would land in `byMember` under a key no mutant queries, so it would be harmless and invisible.
   * What was missing is the ability to tell the two kinds of `undefined` apart:
   *
   *   - the line is inside a TRIGGER, which this map deliberately declines to name. Expected.
   *   - the line is inside NOTHING this map knows about. That is a naming GAP, and it means the
   *     map could not place a line the server says executed.
   *
   * Until R175 those were one answer, and the difference is the whole of `isNamingGap`: an
   * unnameable observation of the first kind says nothing, while one of the second kind is direct
   * evidence that attribution failed in this object.
   */
  readonly triggers: readonly ProcedureSpan[];
  /** R318: the renamed members' spans only, so an object with none answers `renamedMemberAt` at once. */
  readonly renamed: readonly ProcedureSpan[];
  /**
   * R318 (review r2, ruling A): lines inside MORE THAN ONE declaration span. Spans are inclusive
   * and one physical line can close one member and hold the next (`end; procedure Other() begin
   * ... end;`). Counted over EVERY declaration of the object: named procedures, renamed split
   * members with or without a coverage name, `#if`-wrapped and var-swallowed procedures, and
   * triggers. Such a line names nobody: neither `lookup` nor the re-key may pick a side.
   */
  readonly shared: ReadonlySet<number>;
}

/**
 * R318 (pre-flight P8): how many `renamedMemberAt` calls got past the no-renamed-member exit, so a
 * test can pin that an ordinary object costs one map read per statement and no span search.
 */
export const renamedMemberAttempts = { count: 0 };

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
   * The FIRST object's base was the weak half of that rule for a long time: every row measured above
   * is a second or third object, where "previous end + 1" and "own keyword line" differ, and for a
   * first object under a file header they differ by the header's length while every measurement
   * agreed. DISCRIMINATED 2026-08-27 on a gated fixture: `DataShiftOps.Codeunit.al` carries a
   * 31-line comment header, so its `codeunit` keyword is at FILE line 32, and all twelve of its
   * mutants at file lines 37..47 come back `coverageAttribution: "exact"`. Under "own keyword line"
   * the map would be looking up lines 6..16 and would name nothing. So the header IS part of the
   * first object's numbering, and base 1 is right.
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
  /**
   * R298: set when this object's coverage is REFUSED, and then it is the reason, a sentence naming
   * the object and its file. Set on every object declared inside a `#if ... #endif` object wrapper,
   * and on every object declared AFTER the first such wrapper in the same file: a bare object's
   * base is "previous object's end + 1", and whether a wrapper's inactive arm counts as that
   * previous object is exactly what R300 has to measure. A guessed base names the wrong procedure
   * with full confidence (R29), so the map refuses rather than guesses.
   */
  readonly refused?: string;
}

/** R298: the fixed refusal sentence, shared by the fenced line map and the al-runner index. */
export function refusedCoverageReason(objectType: string, objectId: number, file: string): string {
  return `coverage refused for ${objectType}:${objectId} (${file}): it is declared inside, or after, a #if ... #endif object wrapper, and how the compiled arm's lines are numbered is not yet measured (R300). Its mutants read no-coverage.`;
}

/** R298: the sentence for a bare object refused only because its FILE holds an object wrapper. */
export function refusedWholeFileReason(objectType: string, objectId: number, file: string): string {
  return `coverage refused for ${objectType}:${objectId} (${file}): its file also holds a #if ... #endif object wrapper, and al-runner refuses such a file whole (R298, R300). Its mutants read no-coverage.`;
}

/** R-300b: the sentence for an object in a `#if`-wrapped file al-runner does not admit. */
export function refusedUnmeasuredShapeReason(
  objectType: string,
  objectId: number,
  file: string,
): string {
  return `coverage refused for ${objectType}:${objectId} (${file}): its file holds a #if object wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.`;
}

/** R-300b (C1): the sentence for an object key two files declare. */
export function duplicateObjectReason(key: string, fileA: string, fileB: string): string {
  return `coverage refused for ${key}: it is declared in ${fileA} and ${fileB}; coverage cannot tell them apart (R300). Its mutants read no-coverage.`;
}

/**
 * R-307 section 4: the sentence for a DECLARED object the source yields no declaration for (R305's
 * split header is the measured shape). Only an object with no mutant keeps this refusal: one with
 * mutants is refused by `assertManifestObjectsDeclared`'s Direction A throw before any baseline.
 */
export function unmappedCoverageReason(key: string): string {
  return `coverage refused for ${key}: the compiled artifact declares it, but LethAL found no object declaration it can read in the source (an object header split by #if is one such shape, R305). It carries no mutant, so no verdict reads its coverage.`;
}

/**
 * R-307 section 4: every `type:id` key (lower-cased, as `keyOf`) the manifest's mutants are
 * attributed to. An entry without a usable object throws: it could be checked against nothing.
 */
export function manifestObjectKeys(
  mutants: readonly { readonly objectType?: unknown; readonly codeunitId?: unknown }[],
): Set<string> {
  const out = new Set<string>();
  for (const m of mutants) {
    if (typeof m.objectType !== "string" || typeof m.codeunitId !== "number") {
      throw new Error("line-map: a manifest entry has no objectType/codeunitId");
    }
    out.add(keyOf(m.objectType, m.codeunitId));
  }
  return out;
}

/**
 * R-307 section 4: `assertManifestObjectsDeclared`'s refusal. Typed so the publish fence can tell
 * it is a CONFIRMED terminal failure: it is raised before anything is published (bcdev indexes
 * before publish; al-runner publishes nothing), so the fence tombstones the attempt rather than
 * latching the tier for recycle. Extends `Error` directly, like every typed error here.
 */
export class ManifestDeclarationError extends Error {
  override readonly name = "ManifestDeclarationError";
}

/**
 * R-307 section 4: the batch manifest's objects against the declarations coverage resolves
 * through, checked once per deploy, before any baseline.
 *
 * - Direction A (`mapped` given): a declared key with mutants but no line-map entry throws. The
 *   map refuses such a key by name instead of throwing at the first coverage row, so this is
 *   the only place an unmappable object WITH mutants is caught.
 * - Direction B: a key `declared` lacks throws, unless `exempt` (the run's named coverage
 *   refusals) names it. An empty `declared` therefore fails every key; it never passes them.
 */
export function assertManifestObjectsDeclared(
  manifestKeys: Iterable<string>,
  declared: ReadonlySet<string>,
  mapped: ReadonlySet<string> | undefined,
  exempt: ReadonlySet<string>,
): void {
  for (const key of manifestKeys) {
    if (declared.has(key)) {
      if (mapped !== undefined && !mapped.has(key)) {
        const why =
          "every declared object's source is written by LethAL and must be mappable. " +
          "This is a LethAL bug, not a problem with the project under test.";
        throw new ManifestDeclarationError(
          `line-map: the compiled artifact declares ${key} but no line map was built for it — ${why}`,
        );
      }
    } else if (!exempt.has(key)) {
      throw new ManifestDeclarationError(
        `a mutant is attributed to ${key}, which the compiled app does not declare. It is not named in the run's coverage refusals, so its mutants would read no-coverage with no reason given.`,
      );
    }
  }
}

export class LineMap {
  private readonly byObject = new Map<string, ObjectLines>();
  /** R298: declared objects whose coverage is refused, key -> reason. Read before `byObject`. */
  private readonly refused = new Map<string, string>();
  /** R-307: the subset of `refused` that is declared with no entry at all (`unmappedCoverageReason`). */
  private readonly unmapped = new Set<string>();
  /**
   * R-307: every object the SOURCE refuses by R298's per-object rule, declared or not: the
   * exemption for Direction B. It is `coverageRefusedObjects` without al-runner's whole-file
   * widening, which only adds bare objects outside every wrapper; those are compiled, so declared,
   * so B never consults the exemption for them.
   */
  private readonly refusedInSource = new Set<string>();

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
    renamedNames: RenamedMemberNames = NO_RENAMED_NAMES,
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
      if (e.refused !== undefined) this.refusedInSource.add(key);
      if (!declared.has(key)) continue;
      // R298: no spans at all for a refused object, so nothing can name one of its lines, and
      // `lookup`/`isNamingGap` answer from `refused` before they look for spans.
      if (e.refused !== undefined) {
        this.refused.set(key, e.refused);
        continue;
      }
      this.byObject.set(key, spansOf(e.root, e.baseLine, renamedNames.get(key) ?? []));
    }
    // R-307 section 4: a declared object with no entry (R305's split header) is refused by name,
    // never thrown at its first coverage row. One WITH mutants is `assertManifestObjectsDeclared`'s
    // Direction A, checked before any baseline.
    for (const key of declared) {
      if (this.byObject.has(key) || this.refused.has(key)) continue;
      this.unmapped.add(key);
      this.refused.set(key, unmappedCoverageReason(key));
    }
  }

  /** R-307: the declared keys with a line-map entry, spans or an R298 refusal: Direction A's `mapped`. */
  mappedKeys(): ReadonlySet<string> {
    return new Set([
      ...this.byObject.keys(),
      ...[...this.refused.keys()].filter((k) => !this.unmapped.has(k)),
    ]);
  }

  /** R-307: Direction B's exemption on the fenced path (see `refusedInSource`). */
  sourceRefusedKeys(): ReadonlySet<string> {
    return this.refusedInSource;
  }

  /**
   * R298: is this object's coverage REFUSED? A caller that gets `true` must drop the row entirely:
   * not a named entry and not an object-level one either, since an object-level entry feeds
   * `byObjectUnnamed` and selection's local-procedure fallback, which is attribution by the back
   * door.
   */
  isRefused(objectType: string, objectId: number): boolean {
    return this.refused.has(keyOf(objectType, objectId));
  }

  /** R298: the refusal sentence for a refused object, `undefined` for any other. */
  refusalReason(objectType: string, objectId: number): string | undefined {
    return this.refused.get(keyOf(objectType, objectId));
  }

  /**
   * R298: every refused DECLARED object, `type:id` (lower-cased) -> reason. Read at index time so
   * a wrapped object is named even when no coverage row ever arrives for it.
   */
  refusedByKey(): ReadonlyMap<string, string> {
    return this.refused;
  }

  /** Whether the compiled artifact declares this object at all. */
  declares(objectType: string, objectId: number): boolean {
    return this.declared.has(keyOf(objectType, objectId));
  }

  /**
   * How many `(objectType, objectId)` pairs the artifact declares.
   *
   * Exposed for diagnostics, and ZERO is itself a diagnosis rather than a detail: it means the
   * symbol reference yielded nothing, so no coverage row could ever match and the run will report
   * every mutant `no-coverage` while erroring about nothing. That is exactly how issue #9 presented
   * before a namespaced app was found to declare an empty root.
   */
  get declaredCount(): number {
    return this.declared.size;
  }

  /** A few declared keys, so a diagnostic can show what it compared against and stay readable. */
  declaredSample(limit: number): readonly string[] {
    return [...this.declared].slice(0, limit);
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
   * Never throws. A declared object this map has no entry for is refused (R-307 section 4): one
   * with mutants fails `assertManifestObjectsDeclared` before any baseline, so no verdict can read
   * its coverage, and one without mutants cannot affect a verdict.
   */
  /**
   * R175: did this line fall inside NOTHING this map knows about, procedure or trigger?
   *
   * `true` is evidence that naming FAILED for this object rather than that the line belongs to a
   * member we decline to name. It is the signal `coverageFilter` needs to tell "your tests do not
   * reach this code" from "LethAL could not place what your tests did".
   *
   * Deliberately conservative in the safe direction. A var section, a blank line between
   * procedures and an object-level `lineNo` 0 row are all "no known span" without being naming
   * failures, so this returns `false` for line 0 (BC's object-level row, measured) and callers
   * treat the answer as evidence about the OBJECT rather than about any one line: one gap row in
   * an object is enough to say attribution is unreliable there, and a handful of var-section rows
   * cannot be told from a real gap, so the object is flagged either way. Over-flagging costs a
   * report line; under-flagging is the R175 defect itself.
   */
  isNamingGap(objectType: string, objectId: number, lineNo: number): boolean {
    if (this.isRefused(objectType, objectId)) return false;
    const entry = this.byObject.get(keyOf(objectType, objectId));
    if (entry === undefined) return false;
    if (lineNo <= 0) return false;
    const inSpan = (spans: readonly ProcedureSpan[]) =>
      spans.some((p) => lineNo >= p.firstLine && lineNo <= p.lastLine);
    return !inSpan(entry.procedures) && !inSpan(entry.triggers);
  }

  lookup(objectType: string, objectId: number, lineNo: number): string | undefined {
    const key = keyOf(objectType, objectId);
    if (this.refused.has(key)) return undefined; // R298: refused, never unmapped
    const entry = this.byObject.get(key);
    // Not ours (platform, base app, test app). A declared object with no entry is in `refused`
    // (the constructor's unmapped rule), so it returned above.
    if (entry === undefined) return undefined;
    // Line 0 is BC's object-level row. Deliberately checked before the span scan so it can never
    // fall inside a procedure whose range happens to start at 0 through some future bug.
    if (lineNo <= 0) return undefined;
    // R318 (review r2): a line inside two spans belongs to neither as far as a LINE can tell.
    if (entry.shared.has(lineNo)) return undefined;
    for (const p of entry.procedures) {
      if (lineNo >= p.firstLine && lineNo <= p.lastLine) return p.name;
    }
    return undefined;
  }

  /**
   * R318: the coverage name of the RENAMED split member whose span alone holds `lineNo`, when
   * `scope` (the producer's own name for the statement, al-runner `--server`'s `st.scope`) is one
   * of that member's arm names. Else `undefined`, and the caller keeps `scope`.
   *
   * Why re-key at all: the producer names the COMPILED arm, which the collision rule may have
   * dropped (`r3` build `[]`: `Choose`) and which in another build can be another declaration's
   * name (`r4`: `Beta`). Keying by POSITION to the span's name is what makes the server legs agree
   * with the line-based ones in every build.
   *
   * Why the two refusals: a line two declarations share can hold the other one's statement
   * (`r10`: `OtherOnly` reports line 12 with scope `Other`), and a scope the member does not
   * declare is, by the producer's own account, some other member's statement.
   *
   * Cost: one map read and an empty-list exit for every object without a renamed member, which is
   * every object in every measured corpus.
   */
  renamedMemberAt(
    objectType: string,
    objectId: number,
    lineNo: number,
    scope: string | undefined,
  ): string | undefined {
    const entry = this.byObject.get(keyOf(objectType, objectId));
    if (entry === undefined || entry.renamed.length === 0) return undefined;
    renamedMemberAttempts.count++;
    if (scope === undefined || lineNo <= 0 || entry.shared.has(lineNo)) return undefined;
    const own = scope.toLowerCase();
    for (const p of entry.renamed) {
      if (lineNo >= p.firstLine && lineNo <= p.lastLine) {
        return p.arms?.includes(own) === true ? p.name : undefined;
      }
    }
    return undefined;
  }

  /**
   * R383: is `lineNo` inside a RENAMED split member's span? There R318's rule
   * (`renamedMemberAt`) decides alone, both halves: an own arm name is re-keyed, any other scope is
   * kept as some other member's statement. No counter: an object with none exits at once.
   */
  inRenamedSpan(objectType: string, objectId: number, lineNo: number): boolean {
    const entry = this.byObject.get(keyOf(objectType, objectId));
    if (entry === undefined || entry.renamed.length === 0) return false;
    return entry.renamed.some((p) => lineNo >= p.firstLine && lineNo <= p.lastLine);
  }
}

/**
 * Procedure spans for one object, in OBJECT-relative coordinates.
 *
 * Built from the PARSE, never a regex: a regex fooled by the word `procedure` inside a comment
 * or a string literal mis-draws a range and produces a wrong member key, which is the
 * wrong-verdict failure this module exists to avoid. (The pre-R63 `findLocalProcedureNames`
 * was regex-based; it is gone, and the over-credit it produced is exactly what this module
 * must not reintroduce.)
 */
function spansOf(
  objectRoot: ALSyntaxNode,
  baseLine: number,
  fromManifest: readonly (readonly string[])[],
): ObjectLines {
  const procedures: ProcedureSpan[] = [];
  const triggers: ProcedureSpan[] = [];
  /** R318 ruling A: renamed split members with no coverage name. Never named, but counted for `shared`. */
  const unnamed: ProcedureSpan[] = [];
  const span = (n: ALSyntaxNode, name: string): ProcedureSpan => ({
    name,
    firstLine: n.startPosition.row + 1 - baseLine + 1,
    lastLine: n.endPosition.row + 1 - baseLine + 1,
  });
  const walk = (n: ALSyntaxNode): void => {
    // R175: trigger spans are collected for CLASSIFICATION only — see `ObjectLines.triggers`.
    // They never reach `procedures`, so `lookup` cannot name one and rule 4 is unchanged.
    if (n.kind === ALNodeKind.trigger) {
      const nameNode = n.childForFieldName("name");
      triggers.push(span(n, nameNode === null ? "" : stripQuotes(nameNode.text)));
      return;
    }
    // R301, R316: a split-header procedure, either shape, is one procedure (one shared body). Its
    // span starts at the `#if` line, which holds no code, so no covered line can land there.
    // R318: an arm that renames the procedure is spanned under its first coverage name, one no
    // other declaration of the object uses (`renamedMemberCoverageNames`), which the manifest
    // lists first in `coverageArmNames`. A line belongs to the member whichever arm was compiled,
    // so this holds in every build. No such name: no named span, as before R318.
    if (isProcedureLike(n)) {
      const nameNode = procedureLikeNameNode(n);
      const name =
        nameNode === null ? renamedSpanName(n, fromManifest) : stripQuotes(nameNode.text);
      if (name !== null && name !== "") {
        // Measured: BC's rows span a procedure CONTIGUOUSLY from its declaration line through its
        // closing `end;`, so the node's own line extent is exactly the right range.
        const arms =
          nameNode === null ? procedureLikeArmNames(n).map((a) => a.toLowerCase()) : undefined;
        procedures.push({ ...span(n, name), ...(arms !== undefined ? { arms } : {}) });
      } else if (n.children.length > 0) {
        // Ruling A. A bare `procedure` keyword token is also procedure-like (no children, not a
        // declaration): it spans nothing.
        unnamed.push(span(n, ""));
      }
      return; // do not descend: a nested construct belongs to this procedure, not its own span
    }
    for (const c of n.children) walk(c);
  };
  walk(objectRoot);
  return {
    procedures,
    triggers,
    renamed: procedures.filter((p) => p.arms !== undefined),
    shared: linesInTwoSpans([...procedures, ...unnamed, ...triggers]),
  };
}

/**
 * R318 (review I1): the name a RENAMED split member is spanned under.
 *
 * The manifest's `coverageArmNames[0]` first. The manifest was computed on the ORIGINAL source,
 * and the line map parses the EMITTED source, which can re-parse with an ERROR node the original
 * did not have (grammar issue #30: a nested `#if` in a conditional var section, measured). An
 * ERROR anywhere in the object makes `renamedMemberCoverageNames` refuse, and without this the
 * member would be unnamed on the line legs while a PLAIN member in the same object stays named
 * (measured) and the server leg covers it by `st.scope`. The manifest entry is matched to this
 * node by its own arm names. That is unambiguous: a coverage name is, by construction, a name no
 * other declaration of the object carries in any arm, and instrumentation adds statements, never
 * declarations. More than one match: no name, the safe direction.
 *
 * No manifest entry (a member with no mutant, or a caller with no manifest): the same computation
 * on the tree this map parsed, as before. So an object whose ORIGINAL tree has an ERROR (no
 * manifest names) but whose emitted tree parses cleanly still gets a span, under a name no mutant
 * looks up. Harmless: nothing reads that key, and the shared-line count is unchanged.
 */
function renamedSpanName(
  member: ALSyntaxNode,
  fromManifest: readonly (readonly string[])[],
): string | null {
  const own = new Set(procedureLikeArmNames(member).map((a) => a.toLowerCase()));
  const hits = fromManifest.filter((names) => own.has((names[0] ?? "").toLowerCase()));
  if (hits.length > 1) return null;
  return hits[0]?.[0] ?? renamedMemberCoverageNames(member)[0] ?? null;
}

/**
 * R318 (review I1): per object (`type:id`, lower-cased, as `keyOf`), the distinct
 * `coverageArmNames` lists of the manifest's renamed members.
 */
export type RenamedMemberNames = ReadonlyMap<string, readonly (readonly string[])[]>;

const NO_RENAMED_NAMES: RenamedMemberNames = new Map();

/**
 * `RenamedMemberNames` from a manifest's mutants (`MutantManifestEntry`: the object is its
 * `objectType` keyword and `codeunitId`). An entry that carries names but no usable object throws:
 * keying it under a made-up object would drop the name without a word.
 */
export function renamedMemberNamesOf(
  mutants: readonly {
    readonly objectType?: unknown;
    readonly codeunitId?: unknown;
    readonly coverageArmNames?: readonly string[];
  }[],
): RenamedMemberNames {
  const out = new Map<string, (readonly string[])[]>();
  const seen = new Set<string>();
  for (const m of mutants) {
    const names = m.coverageArmNames;
    if (names === undefined || names.length === 0) continue;
    if (typeof m.objectType !== "string" || typeof m.codeunitId !== "number") {
      throw new Error(
        `line-map: a manifest entry carries coverageArmNames ${JSON.stringify(names)} but no objectType/codeunitId`,
      );
    }
    const key = keyOf(m.objectType, m.codeunitId);
    // JSON, not a "|" join: a quoted AL name may contain "|" (it compiles), so a join makes
    // ["Pick|Choose", "Third"] and ["Pick", "Choose|Third"] one key and drops a member's list.
    const id = JSON.stringify([key, ...names.map((n) => n.toLowerCase())]);
    if (seen.has(id)) continue;
    seen.add(id);
    const list = out.get(key) ?? [];
    list.push(names);
    out.set(key, list);
  }
  return out;
}

/**
 * R318 (review I1): `RenamedMemberNames` from the `mutant-manifest.json` that
 * `writeInstrumentedProject` writes beside the instrumented sources. A directory with no manifest
 * (a hand-built fixture) has none. A manifest that cannot be read or parsed THROWS: an unreadable
 * one silently dropping renamed members' names is the say-less-on-one-leg bug this exists to fix.
 */
export async function readRenamedMemberNames(dir: string): Promise<RenamedMemberNames> {
  const mutants = await readManifestMutants(dir);
  return mutants === undefined ? NO_RENAMED_NAMES : renamedMemberNamesOf(mutants);
}

/** `<dir>/mutant-manifest.json`'s `mutants`, `undefined` when there is no manifest; else throws. */
async function readManifestMutants(dir: string): Promise<Record<string, unknown>[] | undefined> {
  const path = join(dir, "mutant-manifest.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `line-map: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `line-map: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const mutants =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { mutants?: unknown }).mutants
      : undefined;
  if (!Array.isArray(mutants)) throw new Error(`line-map: ${path} has no "mutants" array`);
  return mutants as Record<string, unknown>[];
}

/**
 * R318: every line inside at least two of `spans`. Declarations are siblings and never nest, so
 * two overlap only where one ends on the line the next begins; the running furthest end keeps it
 * right even if they did. Usually no line at all: the empty set is shared.
 */
function linesInTwoSpans(spans: readonly ProcedureSpan[]): ReadonlySet<number> {
  const shared = new Set<number>();
  let reach = 0;
  for (const s of [...spans].sort((a, b) => a.firstLine - b.firstLine)) {
    for (let l = s.firstLine; l <= Math.min(reach, s.lastLine); l++) shared.add(l);
    reach = Math.max(reach, s.lastLine);
  }
  return shared.size === 0 ? NO_LINES : shared;
}

const NO_LINES: ReadonlySet<number> = new Set();

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

/** What a `#if` object wrapper may hold without holding an OBJECT: file-level lines, no code. */
const NOT_AN_OBJECT: ReadonlySet<string> = new Set([
  "namespace_declaration",
  "using_statement",
  "comment",
  "multiline_comment",
]);

/**
 * R298: does this `preproc_conditional_object` hold an object? Decided by EXCLUSION (anything but
 * namespace/using lines and comments), never by `objectIdentityOf`, which is null for an enum,
 * an interface or a permission set: those are objects that shift a following object's base too,
 * so the unsafe direction is to call them nothing.
 */
export function wrapperHoldsObject(wrapper: ALSyntaxNode): boolean {
  // R383 r3: `containerNodesOf`, so a split-header object in the wrapper counts (it did not).
  return containerNodesOf(wrapper).some((d) => !NOT_AN_OBJECT.has(d.rawKind));
}

/**
 * R383 r3: preprocessor nodes that are directive LINES and hold no declaration. Every other
 * `preproc_*` node an object container holds is declaration-bearing and counts as an object
 * (fail-closed). In tree-sitter-al 4.4.1 that is `preproc_split_declaration` (`grammar.js` 420,
 * 426: `#if`-alternated object headers over ONE shared body, an `_object` choice), and any kind a
 * later grammar adds there.
 */
const DIRECTIVE_ONLY_KINDS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
  "preproc_region",
  "preproc_endregion",
  "preproc_define",
  "preproc_undef",
  "preproc_pragma_only",
]);

/**
 * R383 r3: like `objectDeclarationsOf` (the `#if` wrappers flattened), but a declaration-bearing
 * preprocessor node is KEPT. `objectDeclarationsOf` drops every `preproc_*` child, so a
 * `preproc_split_declaration` vanished from the object count.
 */
function containerNodesOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (const c of root.namedChildren) {
    if (c.rawKind === "preproc_conditional_object") out.push(...containerNodesOf(c));
    else if (!DIRECTIVE_ONLY_KINDS.has(c.rawKind)) out.push(c);
  }
  return out;
}

/**
 * R383: is this top-level node an OBJECT for the partition and the multi-object count? Every
 * declaration kind is (enum, interface, permission set, extension, profile, dotnet, ...), and so is
 * an `ERROR` or any kind not listed here: fail-closed, since a node holding lines shifts a later
 * object's base. Not objects: namespace, using and comment lines, `preproc_*` markers, and a
 * `#pragma` line, which is a compiler directive like a comment. Measured (r2 census): `pragma` is
 * the ONLY non-declaration kind at top level across fixtures, DC, System Application, Business
 * Foundation, BaseApp and CDO, and no file there has a top-level `ERROR`. Before R383 a pragma never
 * moved a base either; counting it would refuse every BaseApp file that opens with one.
 *
 * R383 r3: a declaration-bearing preprocessor node (`preproc_split_declaration`, anything outside
 * `DIRECTIVE_ONLY_KINDS`) IS an object: it holds a whole object's lines. A `#if` wrapper
 * (`preproc_conditional_object`) is not one itself; its arms are counted (`containerNodesOf`).
 */
export function isTopLevelObject(node: ALSyntaxNode): boolean {
  return (
    !NOT_AN_OBJECT.has(node.rawKind) &&
    node.rawKind !== "pragma" &&
    node.rawKind !== "preproc_conditional_object" &&
    !DIRECTIVE_ONLY_KINDS.has(node.rawKind)
  );
}

/**
 * R383 r2 ruling: object kinds that carry no code, so one AFTER a file's first object shifts no
 * covered line. An explicit allow-list by AL semantics, NOT by the grammar: tree-sitter-al 4.4.1
 * gives every one of these the shared `declaration_body` (`grammar.js` 475 `permissionset_declaration:
 * _object_with_id(...)`, 487 `enum_declaration`, 529 `entitlement_declaration`; `interface_body` at
 * 559 is `repeat1(choice($._body_element, $.interface_procedure))`), and `node-types.json` lists
 * `procedure` and `trigger_declaration` among `declaration_body`'s and `interface_body`'s children.
 * So the grammar shows NO kind code-free, `enumextension` included, and none is added beyond the
 * ruling's list; `holdsCode` backs the list up by refusing an allow-listed node that parsed with code.
 */
const CODE_FREE_KINDS: ReadonlySet<string> = new Set([
  "permissionset_declaration",
  "permissionsetextension_declaration",
  "enum_declaration",
  "interface_declaration",
  "entitlement_declaration",
]);

/** Node kinds that hold executable code (or a procedure split across `#if` arms). */
const CODE_KINDS: ReadonlySet<string> = new Set([
  "procedure",
  "trigger_declaration",
  "code_block",
  "preproc_split_procedure",
  "preproc_split_procedure_preamble",
]);

function holdsCode(node: ALSyntaxNode): boolean {
  return node.namedChildren.some((c) => CODE_KINDS.has(c.rawKind) || holdsCode(c));
}

/**
 * R383: the objects a file declares, of ANY kind, in source order, each as the list of its
 * declaration nodes. A plain top-level declaration is one object of one node. The arms of one
 * `#if` wrapper (R298) that declare the same object are ONE object of several nodes, merged by kind
 * plus `object_id`, or the header line for a kind with no id (an interface). R383 r3: merged only
 * WITHIN one top-level wrapper, the one place alternative arms of one object can be. Two separate
 * declarations whose keys collide (two multiline `interface` headers both key `interface`) stay two
 * objects, and every node is kept, so the code check sees each one. An `ERROR` node is always its
 * own object, and so is a declaration-bearing preprocessor node (`isTopLevelObject`).
 */
function fileObjects(root: ALSyntaxNode): ALSyntaxNode[][] {
  const out: ALSyntaxNode[][] = [];
  for (const top of root.namedChildren) {
    if (top.rawKind !== "preproc_conditional_object") {
      if (isTopLevelObject(top)) out.push([top]);
      continue;
    }
    const arms = new Map<string, ALSyntaxNode[]>();
    for (const node of containerNodesOf(top)) {
      if (!isTopLevelObject(node)) continue;
      const tag =
        node.rawKind === "ERROR" || node.rawKind.startsWith("preproc_")
          ? `@${node.startPosition.row}:${node.startPosition.column}`
          : (node.childForFieldName("object_id")?.text ?? node.text.split("\n")[0]?.trim() ?? "");
      const key = `${node.rawKind}:${tag.toLowerCase()}`;
      const merged = arms.get(key);
      if (merged === undefined) {
        const object = [node];
        arms.set(key, object);
        out.push(object);
      } else merged.push(node);
    }
  }
  return out;
}

/**
 * R383 r2 ruling, the ONE predicate the al-runner coverage guard, the CLI fallback and the index
 * skip share: is this file refused as multi-object? al-runner reports every object after a file's
 * first in the wrong frame, so a file is refused UNLESS every object after the first is code-free
 * (`CODE_FREE_KINDS`, with no code node inside, checked on EVERY node of a merged object). The first
 * object may be any kind. Anything else after it refuses, an `ERROR` or an unknown kind included
 * (fail-closed).
 *
 * R383 r3: a `preproc_split_declaration` is never in `CODE_FREE_KINDS`, so one after the first
 * object refuses the file whatever its headers say: it carries code unless proven otherwise, and
 * nothing here proves it. As the FIRST object it is simply the first object (base 1), like any
 * kind. Its own lines resolve nowhere: `objectIdentityOf` gives it no identity, so it has no index
 * entry. That loses nothing measured today: R305's skip (`generateMutationSet`) generates no mutant
 * in a file whose only code-carrying object is split, and a file where a plain object follows it is
 * refused here.
 */
export function refusedAsMultiObject(root: ALSyntaxNode): boolean {
  return fileObjects(root)
    .slice(1)
    .some((object) => object.some((n) => !CODE_FREE_KINDS.has(n.rawKind) || holdsCode(n)));
}

/**
 * Builds the per-object entries for one parsed FILE.
 *
 * `baseLine` is computed as "one past the previous object's last line", with the first object
 * based at line 1 — see `LineMapEntry.baseLine` for the measurements that rule comes from and the
 * case that has not yet discriminated it.
 *
 * R298: an object inside a `preproc_conditional_object` (a `#if`-wrapped object, one declaration
 * per arm) gets an entry marked `refused`, and so does every object after the first such wrapper
 * in the file (see `LineMapEntry.refused`). A wrapper holding no object (only `using` lines, say)
 * refuses nothing and moves no base, exactly as before: it is not an object.
 */
export function fileLineMapEntries(
  fileRoot: ALSyntaxNode,
  objectIdentity: (node: ALSyntaxNode) => { objectType: string; objectId: number } | null,
  file = "<source>",
): LineMapEntry[] {
  const entries: LineMapEntry[] = [];
  let previousEndLine = 0; // so the first object bases at 1
  let afterWrapper = false;
  const push = (node: ALSyntaxNode, refuse: boolean): boolean => {
    const identity = objectIdentity(node);
    if (identity === null) return false;
    entries.push({
      objectType: identity.objectType,
      objectId: identity.objectId,
      root: node,
      baseLine: previousEndLine + 1,
      ...(refuse
        ? { refused: refusedCoverageReason(identity.objectType, identity.objectId, file) }
        : {}),
    });
    return true;
  };
  for (const node of fileRoot.namedChildren) {
    if (node.rawKind === "preproc_conditional_object") {
      for (const decl of objectDeclarationsOf(node)) push(decl, true);
      if (!wrapperHoldsObject(node)) continue;
      afterWrapper = true;
      previousEndLine = node.endPosition.row + 1;
      continue;
    }
    push(node, afterWrapper);
    // R383: EVERY top-level object moves the base, indexed or not. An enum, an interface or a
    // permission set has no coverage identity but still holds lines, so a codeunit after one is
    // numbered from one past its end. Namespace, using and comment lines are not objects: a leading
    // comment belongs to the object after it, as measured (`LineMapEntry.baseLine`). So does a
    // `#pragma` line, as before R383 (`isTopLevelObject`).
    if (!isTopLevelObject(node)) continue;
    previousEndLine = node.endPosition.row + 1;
  }
  return entries;
}

/**
 * R383: a FILE-relative line of the INSTRUMENTED text to the object whose declaration holds it and
 * the OBJECT-relative line the line map is keyed on.
 *
 * Infrastructure only for now. al-runner v2.12.0-main.c39ad5de reports a multi-object file's
 * first object in this frame but every later object in a mixed source/instrumented frame
 * (`al-runner-coverage.ts` header), so the index does not admit such files and this function sees
 * files whose only object with code is the first (`refusedAsMultiObject`), so its base is 1.
 *
 * Selects by the declaration node's own FILE span and converts with the same `baseLine` `spansOf`
 * used, so the two cannot disagree. `undefined` for a line in no indexed object (a blank or comment
 * line between objects, an enum's lines) and for a refused object's lines: no coverage entry at all,
 * never a guess. Keyed by `(objectType, objectId)`, never by a procedure name or a bare id.
 */
export function resolveFileLine(
  entries: readonly LineMapEntry[],
  fileLine: number,
): { objectType: string; objectId: number; objectLine: number } | undefined {
  for (const e of entries) {
    if (fileLine < e.root.startPosition.row + 1 || fileLine > e.root.endPosition.row + 1) continue;
    if (e.refused !== undefined) return undefined;
    return {
      objectType: e.objectType,
      objectId: e.objectId,
      objectLine: fileLine - e.baseLine + 1,
    };
  }
  return undefined;
}

/**
 * R298: does this file hold, at its root, a `#if ... #endif` object wrapper with an object (of ANY
 * kind) in it? al-runner's index refuses such a file WHOLE, and selection refuses every object in
 * it (`coverageRefusedObjects`), so the two cannot disagree.
 */
export function fileHoldsWrappedObject(root: ALSyntaxNode): boolean {
  return root.namedChildren.some(
    (c) => c.rawKind === "preproc_conditional_object" && wrapperHoldsObject(c),
  );
}

/**
 * R-300b: does al-runner score this `#if`-wrapped file? True only for the shapes measured on both
 * al-runner legs (H1: the original file's line numbers, `alrunner-results.md`) and pinned live by
 * `fixtures/sandbox-wrapped`: exactly ONE top-level wrapper holding an object, with no `#else` or
 * `#elif` at its top level, no nested object wrapper, exactly one object inside it (one with a
 * coverage identity), and no object of any kind before or after it. Namespace, using and comment
 * lines may sit before the `#if` or inside it, and a statement-level `#if` inside the object is
 * allowed. Such a file has one object, so `refusedAsMultiObject` is false for it by construction.
 * The index, the CLI guard and selection all read this one predicate (R387's precedent).
 */
export function alRunnerAdmitsWrappedFile(root: ALSyntaxNode): boolean {
  if (root.namedChildren.some(isTopLevelObject)) return false;
  const wrappers = root.namedChildren.filter(
    (c) => c.rawKind === "preproc_conditional_object" && wrapperHoldsObject(c),
  );
  const [wrapper] = wrappers;
  if (wrappers.length !== 1 || wrapper === undefined) return false;
  const nested = wrapper.namedChildren.some(
    (c) =>
      c.rawKind === "preproc_else" ||
      c.rawKind === "preproc_elif" ||
      c.rawKind === "preproc_conditional_object",
  );
  if (nested) return false;
  const objects = containerNodesOf(wrapper).filter(isTopLevelObject);
  const [only] = objects;
  return objects.length === 1 && only !== undefined && objectIdentityOf(only) !== null;
}

/**
 * R-300b (C1): the entries of a file whose declarations this build compiles. One starting in an
 * inactive arm is dropped; an `undecided` file gives none (it has no mutant either).
 */
export function activeEntries(
  entries: readonly LineMapEntry[],
  arms: ArmEvaluation,
): LineMapEntry[] {
  if (arms.kind === "undecided") return [];
  return entries.filter((e) => !startsInInactiveArm(arms.inactive, e.root.startIndex));
}

/**
 * R-300b (C1): every object key declared in more than one file -> `duplicateObjectReason`, naming
 * the first two files. The ONE function the al-runner index and selection share. A key repeated
 * inside one file (two arms of one wrapper) is not a duplicate.
 */
export function duplicateObjectRefusals(
  files: readonly { readonly path: string; readonly keys: Iterable<string> }[],
): Map<string, string> {
  const firstFile = new Map<string, string>();
  const out = new Map<string, string>();
  for (const f of files) {
    for (const key of new Set(f.keys)) {
      const seen = firstFile.get(key);
      if (seen === undefined) firstFile.set(key, f.path);
      else if (!out.has(key)) out.set(key, duplicateObjectReason(key, seen, f.path));
    }
  }
  return out;
}

/**
 * R-300b (C1): the keys of a file's compiled declarations, as `duplicateObjectRefusals` reads
 * them. Only a file holding an object wrapper can have a declaration in an inactive arm, so arms
 * are applied only there; a plain file's keys never depend on them (an `undecided` plain file
 * keeps its keys, as the index keeps its entries).
 */
export function activeObjectKeys(root: ALSyntaxNode, arms: ArmEvaluation): string[] {
  const entries = fileLineMapEntries(root, objectIdentityOf);
  return (fileHoldsWrappedObject(root) ? activeEntries(entries, arms) : entries).map((e) =>
    keyOf(e.objectType, e.objectId),
  );
}

/** R-300b: the sentence for an admitted wrapped file whose arms `evaluateArms` cannot decide. */
export function undecidedArmsReason(
  objectType: string,
  objectId: number,
  file: string,
  reason: string,
): string {
  return `coverage refused for ${objectType}:${objectId} (${file}): its #if arms could not be evaluated as alc does (${reason}), so which declaration is compiled is unknown (R300). Its mutants read no-coverage.`;
}

/**
 * R298: the refused objects of the project's parsed files, `type:id` (lower-cased, the same key
 * `selection.ts`'s `objectKeyOf` builds) -> the refusal sentence.
 *
 * R-300b: per coverage path. `backendKind` is REQUIRED, so no caller can forget which path it asks
 * for. Under `"bcdev"` the result is exactly the pre-R-300b one. Under `"al-runner"` a file
 * `alRunnerAdmitsWrappedFile` admits adds no refusal, and every other wrapped file's objects are
 * refused with `refusedUnmeasuredShapeReason`. Duplicate keys (C1) are refused by the caller from
 * `duplicateObjectRefusals`, which needs the build's arms.
 *
 * The UNION of two rules, so selection refuses at least what any coverage path refuses: the line
 * map's per-object rule (`fileLineMapEntries`: inside a wrapper, or after the first wrapper that
 * holds an object), and al-runner's whole-file rule (`fileHoldsWrappedObject`: every object of a
 * file holding such a wrapper, including a bare object BEFORE it). The second is wider only for a
 * bare object before the wrapper. It matters when the wrapped object has no coverage identity (an
 * enum, an interface): coverage stays on for the file's other objects (a code-free enum after the
 * table does not make the file multi-object, `refusedAsMultiObject`), al-runner drops the whole
 * file's hits, and without the
 * union the bare table's trigger mutants would reach the all-green fallback. Over-refusing is the
 * safe direction.
 */
export function coverageRefusedObjects(
  files: readonly { readonly path: string; readonly root: ALSyntaxNode }[],
  backendKind: BuildBackend["kind"],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    for (const [key, reason] of refusedObjectsOfFile(
      f.root,
      normalizeSlashes(f.path),
      backendKind,
    )) {
      out.set(key, reason);
    }
  }
  return out;
}

/**
 * R298: one file's refused objects, by the union rule `coverageRefusedObjects` documents. A bare
 * object BEFORE the wrapper gets its own sentence (`refusedWholeFileReason`), since "inside, or
 * after" would be false for it. R-300b: under `"al-runner"` an admitted file refuses nothing and
 * every other wrapped file's objects get `refusedUnmeasuredShapeReason`. al-runner's index prints
 * exactly these sentences.
 */
export function refusedObjectsOfFile(
  root: ALSyntaxNode,
  file: string,
  backendKind: BuildBackend["kind"],
): Map<string, string> {
  const out = new Map<string, string>();
  const wholeFile = fileHoldsWrappedObject(root);
  const alRunner = backendKind === "al-runner";
  if (alRunner && alRunnerAdmitsWrappedFile(root)) return out;
  for (const e of fileLineMapEntries(root, objectIdentityOf, file)) {
    const reason =
      alRunner && wholeFile
        ? refusedUnmeasuredShapeReason(e.objectType, e.objectId, file)
        : (e.refused ??
          (wholeFile ? refusedWholeFileReason(e.objectType, e.objectId, file) : undefined));
    if (reason !== undefined) out.set(keyOf(e.objectType, e.objectId), reason);
  }
  return out;
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
  [ALNodeKind.reportextension]: "ReportExtension",
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
  return lineMapFromSources(
    await readAlSources(projectDir),
    declared,
    await readRenamedMemberNames(projectDir),
  );
}

/** One `.al` file of a project: its path relative to the project dir, and its text. */
export interface AlSource {
  readonly path: string;
  readonly text: string;
}

/** Every `.al` under `projectDir`, recursively, sorted by relative path: what `buildLineMap` parses. */
export async function readAlSources(projectDir: string): Promise<AlSource[]> {
  const files = (await readdir(projectDir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  // R219: a batch file given a disambiguated flat name is named by its project path, since the
  // path is only ever quoted (refusals), never read again.
  const display = await batchDisplayPaths(projectDir);
  const out: AlSource[] = [];
  for (const path of files) {
    out.push({ path: display(path), text: await readFile(join(projectDir, path), "utf8") });
  }
  return out;
}

/**
 * R219: how to quote a file of batch directory `dir` to a user: its project path when the batch
 * wrote it under a disambiguated flat name (`FLAT_NAMES_FILENAME`), else unchanged. A directory
 * without the record (every batch with unique basenames, any non-batch directory) changes nothing.
 */
export async function batchDisplayPaths(dir: string): Promise<(path: string) => string> {
  let sidecar: string | undefined;
  try {
    sidecar = await readFile(join(dir, FLAT_NAMES_FILENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return displayPathsOf(sidecar);
}

/** `buildLineMap` over sources already read (C02-04b: the preflight's in-memory copy). */
export async function lineMapFromSources(
  sources: readonly AlSource[],
  declared: ReadonlySet<string>,
  renamedNames: RenamedMemberNames = NO_RENAMED_NAMES,
): Promise<LineMap> {
  await initParser();
  const entries: LineMapEntry[] = [];
  for (const { path, text } of sources) {
    entries.push(
      ...fileLineMapEntries(wrapRoot(parseAL(text)), objectIdentityOf, normalizeSlashes(path)),
    );
  }
  return new LineMap(entries, declared, renamedNames);
}

/**
 * R298, for the HUB path, which builds no line map: `coverageRefusedObjects` over these sources,
 * keyed as `LineMap.refusedByKey` keys them, declared or not. The hub names the declared ones and
 * exempts all of them from R-307's Direction B.
 */
export async function coverageRefusedFromSources(
  sources: readonly AlSource[],
): Promise<ReadonlyMap<string, string>> {
  await initParser();
  return coverageRefusedObjects(
    sources.map((s) => ({ path: s.path, root: wrapRoot(parseAL(s.text)) })),
    "bcdev",
  );
}

/**
 * R-307: the object keys of `<dir>/mutant-manifest.json`'s mutants. STRICT: a missing manifest
 * throws too, unlike `readRenamedMemberNames`, because the caller checks these keys and an empty
 * set would pass that check with nothing checked.
 */
export async function readManifestObjectKeys(dir: string): Promise<Set<string>> {
  const mutants = await readManifestMutants(dir);
  if (mutants === undefined) {
    // Fix round 1: an absent manifest would check nothing, and empty-vs-anything "matches".
    throw new ManifestDeclarationError(
      `line-map: ${join(dir, "mutant-manifest.json")} does not exist, so the batch's mutant objects cannot be checked against its declarations`,
    );
  }
  return manifestObjectKeys(mutants);
}

/** Forward slashes, so a path quoted to a user reads the same on every platform. */
function normalizeSlashes(path: string): string {
  return path.split("\\").join("/");
}
