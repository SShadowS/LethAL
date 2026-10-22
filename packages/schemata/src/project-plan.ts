import { FileRefusedError, type MutationSpec, maskAlNonCode } from "@lethal/engine";
import { type CompilePlan, planFile } from "./compile-plan";
import type { ReachGrain } from "./dispatch-plan";
import type { DeclaredObject } from "./id-ranges";
import type { IdedSpec } from "./ids";
import type { InstrumentedFile } from "./project";

/**
 * R-307 O6. The PLAN half of `instrumentOneFile`: the per-file header rules (H1-H3, E5/E6) and
 * `planFile`, every decision and every throw for one file, returned as a frozen `FilePlan`. No
 * instrumented text is built; `emitOneFile` (project-emit.ts) builds it from the plan alone.
 * `generateMutationSet`'s per-file trial runs this and nothing else.
 */

/** One mutant's place in the manifest, decided by PLAN: its own object's header, and its grain. */
export interface PlannedMutant {
  readonly mutantId: string;
  readonly header: ObjectHeader;
  readonly grain: ReachGrain;
}

/** One file's frozen plan. `mutants` holds one entry per ided spec, in `ided` order. */
export interface FilePlan {
  readonly path: string;
  readonly headers: readonly ObjectHeader[];
  readonly compile: CompilePlan;
  readonly mutants: readonly PlannedMutant[];
}

/**
 * R307: the writer's per-file steps, in the writer's order, so the writer and
 * `generateMutationSet`'s per-file trial run ONE function and cannot drift. Every per-file refusal
 * (`FileRefusedError`) fires in here; nothing is written. `ided` must be the file's deduped specs
 * with ids in `assignMutantIds` order (the trial passes file-local ids, which order the same).
 */
export function planOneFile(
  f: Pick<InstrumentedFile, "path" | "source" | "root">,
  deduped: readonly MutationSpec[],
  ided: readonly IdedSpec[],
): FilePlan {
  // Read every object header BEFORE instrumenting: both remaining throws (no object header,
  // an injectable object mixed with a non-injectable one) mean this file can never be
  // attributed correctly, and failing before the write keeps a refused file from being left
  // behind, half-instrumented, in the artifact dir.
  const headers = objectHeadersOf(f.source, f.path);
  assertNoUnsupportedObjectMix(headers, f.path);
  const compile = planFile(f.source, f.root, deduped, ided, f.path);
  // The grain each member's chain placed (or omitted) its marker by, planned once in `planFile`.
  const grainOf = new Map<string, ReachGrain>();
  for (const m of compile.members) grainOf.set(m.mutantId, m.grain);
  const mutants: PlannedMutant[] = [];
  for (const { mutantId, spec } of ided) {
    // R6: attributed to ITS OWN enclosing object, not always the file's first header.
    const header = attributeHeader(headers, spec, f.path);
    const grain = grainOf.get(mutantId);
    if (grain === undefined) {
      throw new Error(`planOneFile: no reach grain for ${mutantId} in ${f.path}`);
    }
    mutants.push({ mutantId, header, grain });
  }
  return { path: f.path, headers, compile, mutants };
}

/** Global, so `matchAll` can find EVERY object header in the file, not just the first. */
// Extension kinds first: alternation is tried left to right, so a bare `page`/`table` would
// engage on `pageextension`/`tableextension`/`reportextension` before failing its `\s+\d+`.
const OBJECT_HEADER =
  /^\s*(codeunit|tableextension|pageextension|reportextension|table|page|report|query|xmlport|enum)\s+(\d+)\s+("([^"]+)"|(\w+))/gim;

/**
 * Blanks out AL comments, preserving length (so any index computed against the result still
 * addresses the same character of the original).
 *
 * `objectHeadersOf` counts headers with a regex, and the mixed-kind check it feeds
 * (`assertNoUnsupportedObjectMix`) turns a false positive into a refused file. A commented-out
 * object is exactly that false positive, and it is a shape real AL carries: an old
 * `codeunit 50100 "Old Impl"` left inside a block comment above the live
 * `codeunit 50101 "New Impl"`.
 *
 * The regex anchors at line start, so a `//`-commented header never matched — but a block-
 * commented one starts its own line and does. Worse, if the commented object came FIRST it won
 * the `matches[0]` race and mislabelled every mutant in the file, silently. Both go away by
 * scanning the comment-free text.
 *
 * String literals are tracked because AL text may legally contain `//` or a block-comment opener
 * (`Error('use // here')`), and a stripper blind to them would blank the rest of the file and
 * report "no AL object header" on a valid one. Their CONTENTS are deliberately left intact here —
 * see `maskAlNonCode`'s `blankStringContents` for why this consumer differs from test discovery.
 */
export function stripAlComments(source: string): string {
  // R80: one shared lexer, two policies. `blankStringContents: false` is this consumer's policy
  // and it is load-bearing — `objectHeadersOf` decides which object a mutant belongs to, so what
  // this function sees is mutant ATTRIBUTION. Measured over 717 real `.al` files, both policies
  // yield identical object-header sets, so the choice is documented rather than fragile.
  return maskAlNonCode(source, { blankStringContents: false });
}

/** One AL object header found in a file: kind (lowercased keyword), id, quote-stripped name,
 *  and the header's own start offset in the comment-stripped source (see `objectHeadersOf`).
 *  Exported for `attributeHeader`'s own direct unit tests (project.test.ts), the same pattern
 *  `stripAlComments` already uses — module-level export, not re-exported through `index.ts`. */
export interface ObjectHeader {
  readonly type: string;
  readonly id: number;
  readonly name: string;
  readonly startIndex: number;
}

/** AL object kinds that can carry the injected `var MutationSelector: Codeunit "Mutation
 *  Selector";` declaration — mirrors `canCarryMutationSelectorVar` (compile.ts) at object
 *  granularity: that predicate answers "does this FILE have at least one", this answers
 *  "is THIS object one". Kept in sync by hand (both are short, stable lists tied to the same
 *  AL grammar fact — only a codeunit or a table can hold a `var` before/around its members in a
 *  position `injectSelectorVarIntoObject` can anchor against).
 *  R254 kept this list on purpose: a reportextension is a carrier ALONE in its file, but beside
 *  another object it is refused `object-mix`, since al-runner's multi-object guard was measured
 *  for codeunits and tables only (pinned by `r254-reportext.test.ts`). */
const INJECTABLE_OBJECT_TYPES: ReadonlySet<string> = new Set(["codeunit", "table"]);

/**
 * Every AL object header this file declares, kind lowercased, in source order. `type` is the
 * matched AL keyword lowercased (`table`, `codeunit`, ...) — a BC object id is unique only
 * WITHIN a type, so every consumer that identifies an object (coverage lookup above all) needs
 * the pair, not the id alone.
 *
 * AL permits several objects in one file (rare, but legal); this is R6's per-object
 * attribution seam — `attributeHeader` uses the returned `startIndex`es to find which object a
 * given mutant actually sits inside, instead of the old behaviour of labelling every mutant in
 * the file with the FIRST header's `(type, id)` regardless of which object it was really in
 * (silently wrong coverage-lookup keys, the exact failure `MutantManifestEntry.objectType`'s
 * doc comment warns about). `assertNoUnsupportedObjectMix` is the remaining refusal: it still
 * throws for a file that mixes an injectable object with a non-injectable one, since dropping
 * only the non-injectable object's mutants (rather than the whole file) isn't implemented yet.
 */
export function objectHeadersOf(source: string, filePath: string): readonly ObjectHeader[] {
  // Comment-free text, so a commented-out object neither appears in the result nor wins any
  // position race against a live one — see `stripAlComments`.
  // `matchAll` operates on an internal clone, so the shared `g` regex's `lastIndex` never carries
  // between calls (a plain `.exec` loop on OBJECT_HEADER would).
  const matches = [...stripAlComments(source).matchAll(OBJECT_HEADER)];
  if (matches.length === 0)
    throw new FileRefusedError(`${filePath}: file has no AL object header`, {
      file: filePath,
      shape: "no-header",
      site: "project.no-header",
    });
  return matches.map((m) => {
    const type = m[1];
    if (type === undefined) {
      // Unreachable while OBJECT_HEADER keeps group 1 — asserted rather than defaulted, because a
      // wrong/absent object type silently merges two objects' coverage (see MutantManifestEntry).
      throw new Error(`${filePath}: AL object header matched without an object keyword`);
    }
    if (m.index === undefined) {
      // Unreachable: `matchAll` always sets `.index` on every match it yields. Asserted, not
      // defaulted — a wrong start offset would misattribute every mutant after it.
      throw new Error(`${filePath}: AL object header matched with no source offset`);
    }
    return {
      type: type.toLowerCase(),
      id: Number(m[2]),
      name: m[4] ?? m[5] ?? "",
      startIndex: m.index,
    };
  });
}

/**
 * Refuses a file only when it mixes an injectable object (codeunit/table) with a non-injectable
 * one (page/report/query/xmlport/enum/...). Two-or-more objects that are ALL injectable are
 * supported (R6): each mutant is attributed to its own enclosing object by `attributeHeader`,
 * and `injectMutationSelectorVar` (compile.ts) injects a declaration into every object that
 * actually received a guard, not just the first.
 *
 * The mixed-kind shape stays refused. `generateMutationSet` (@lethal/runner) drops a file's
 * specs only when the WHOLE file has zero injectable objects — a file holding one codeunit and
 * one page still reaches here with specs generated for both, and there is no per-object
 * DROPPING of just the page's specs (the same kind-filter `canCarryMutationSelectorVar` already
 * applies file-wide, applied at object granularity instead) — that is a real capability
 * extension, not yet built. Refusing the shape is the honest answer until it is.
 */
function assertNoUnsupportedObjectMix(headers: readonly ObjectHeader[], filePath: string): void {
  if (headers.length <= 1) return;
  const unsupported = headers.filter((h) => !INJECTABLE_OBJECT_TYPES.has(h.type));
  if (unsupported.length === 0) return; // every object is injectable — R6 per-object path.
  const found = headers.map((h) => `${h.type} ${h.id} ${h.name}`);
  const unsupportedKinds = [...new Set(unsupported.map((h) => h.type))].join(", ");
  const why = `LethAL attributes mutants per object only when every object in the file can carry the injected selector var (a codeunit or a table). This file also declares a ${unsupportedKinds}, and dropping only that object's mutants (rather than refusing the whole file) is not yet implemented. Split them into one file each.`;
  throw new FileRefusedError(
    `writeInstrumentedProject: cannot instrument ${filePath} — it mixes ${found.join("; ")} in one file. ${why}`,
    {
      file: filePath,
      shape: "object-mix",
      site: "project.object-mix",
      objects: headers.map(({ type, id, name }) => ({ type, id, name })),
    },
  );
}

/**
 * The object a mutant belongs to: the LAST header at or before the mutant's own start offset.
 * Headers partition the file left to right — an AL object's body cannot contain another
 * object's header — so this is exact, not a heuristic; it is the fix for the old "always the
 * first header" rule that mislabelled every mutant in a file's second-and-later object (R6).
 *
 * The boundary is deliberately `<=` (a header AT `spec.before.startIndex` still counts, so the
 * loop below breaks only on strictly-greater): a mutant whose `before` node starts at the exact
 * same offset as a header belongs to THAT object, not the previous one — the header's own text
 * is the first thing at that offset, so "at or after" is "inside this object", never "still
 * inside the previous one". Exported (module-level, not through `index.ts` — see `ObjectHeader`)
 * so this exact boundary is unit-testable without constructing a real multi-object AL fixture.
 */
export function attributeHeader(
  headers: readonly ObjectHeader[],
  spec: MutationSpec,
  filePath: string,
): ObjectHeader {
  let best: ObjectHeader | undefined;
  for (const header of headers) {
    if (header.startIndex > spec.before.startIndex) break;
    best = header;
  }
  if (best === undefined) {
    // Unreachable via the normal pipeline (spec generation walks nodes inside the parsed
    // objects), but a caller-constructed spec whose `before` sits before every header would
    // otherwise silently fall through to `undefined` — fail loudly instead.
    throw new FileRefusedError(
      `${filePath}: mutation site at offset ${spec.before.startIndex} sits before this file's first AL object header — cannot attribute it to an object.`,
      {
        file: filePath,
        shape: "site-before-header",
        site: "project.site-before-header",
        lines: [spec.before.startPosition.row + 1, spec.before.endPosition.row + 1],
      },
    );
  }
  return best;
}

/**
 * Every AL object header declared in `source` — unlike `objectHeaderOf` above (which enforces
 * exactly one object per file and throws otherwise, a rule that only applies to files THIS TOOL
 * instruments), this returns however many there are. Used for a structural id-collision scan
 * (`validateSelectorIds`, `id-ranges.ts`) across every `.al` file in a target project, including
 * ones with no mutation sites at all — those are never passed through `objectHeaderOf`, but their
 * object ids still occupy real AL id space the injected selector ids must not collide with.
 */
export function scanDeclaredObjects(source: string): DeclaredObject[] {
  const clean = stripAlComments(source);
  return [...clean.matchAll(OBJECT_HEADER)].map((m) => ({
    type: (m[1] ?? "").toLowerCase(),
    id: Number(m[2]),
    name: m[4] ?? m[5] ?? "",
  }));
}
