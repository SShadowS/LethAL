import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationSpec,
  astSubtreeHash,
  findEnclosingProcedure,
} from "@lethal/engine";
import { compileSchemataForFile } from "./compile";
import { type TierResolver, dedupeSpecs } from "./dedup";
import type { DeclaredObject } from "./id-ranges";
import { assignMutantIds } from "./ids";
import {
  type SelectorConfig,
  emitMutationSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
} from "./selector";

export const CONTROL_SELECTOR_FILENAME = "MutationSelector.Codeunit.al";
export const CONTROL_REGISTER_FILENAME = "MutationRegister.Codeunit.al";
export const CONTROL_UPGRADE_FILENAME = "MutationUpgrade.Codeunit.al";

export interface InstrumentedFile {
  readonly path: string;
  readonly source: string;
  readonly root: ALSyntaxNode;
  readonly specs: readonly MutationSpec[];
}

export interface WriteInput {
  readonly targetDir: string;
  readonly files: readonly InstrumentedFile[];
  readonly selectorIds: SelectorConfig;
  readonly artifactId: string;
  /** The target project's own app.json `id` — baked into the delegating selector and the
   *  register-install codeunit so the LethAL Control extension keys state on the full
   *  (targetAppId, artifactId, mutantId) tuple (Layer 5C-A). */
  readonly targetAppId: string;
  /** Tier of each registered operator, keyed by `MutationSpec.operatorName` — used to resolve
   *  Tier-2 narrowings of a Tier-1 operator that would otherwise emit a byte-identical mutant at
   *  the same site under two names (see `dedupeSpecs`). `MutationSpec` itself carries no tier
   *  (that's a property of `MutationOperator`), so the caller supplies this map. */
  readonly operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom">;
}

export interface MutantManifestEntry {
  readonly mutantId: string;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startLine: number;
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astHash: string;
  /**
   * The AL object KEYWORD this mutant's object was declared with, lowercased: `table`,
   * `codeunit`, `page`, `report`, `query`, `xmlport`, `enum`.
   *
   * Required, and deliberately not optional: BC object ids are unique PER TYPE, so
   * `codeunitId` alone does not identify an object — `table 50100 "Foo"` alongside
   * `codeunit 50100 "Foo Mgt."` is ordinary. Coverage lookup keys on the (type, id) pair
   * (`packages/runner/src/selection.ts`), and a manifest that cannot supply the type is
   * refused there rather than silently defaulted: defaulting merges two different objects'
   * coverage and turns a live mutation site into a false survivor.
   */
  readonly objectType: string;
  /** The object's id. Named `codeunitId` for history; it is the id of whatever
   *  `objectType` names, not necessarily a codeunit. */
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly triggerName?: string;
  /**
   * The source text this mutant REPLACED, and what it replaced it with — the mutation itself,
   * stated rather than implied.
   *
   * Without these a consumer sees only `lethal.empty-block at line 6` and has to reverse-engineer
   * which span an operator chose before it can judge, report, or act on a survivor. `file` +
   * `startIndex`/`endIndex` technically locate it, but only if the consumer re-reads the source
   * at exactly the revision that was mutated — a survivor acted on days later, or by an agent
   * with only the report in hand, has no such guarantee.
   *
   * `mutatedText` is `""` for a deletion operator (`lethal.void-method-call`,
   * `lethal.remove-setrange`, ...), which is meaningful, not missing: the mutation IS the empty
   * string. Both are truncated at `MAX_MUTATION_TEXT` with a trailing marker — a whole procedure
   * body can be a single `lethal.empty-block` span, and a manifest is not a source archive.
   */
  readonly originalText: string;
  readonly mutatedText: string;
}

/**
 * Cap on `originalText`/`mutatedText`. Generous enough that an ordinary statement-level mutation
 * survives whole (the common case, and the one a consumer acts on), small enough that a
 * block-rooted mutation over a long procedure body cannot bloat the manifest.
 */
export const MAX_MUTATION_TEXT = 600;

/** Truncates to `MAX_MUTATION_TEXT`, marking the cut so a consumer never mistakes a clipped
 *  fragment for the complete mutation text. */
export function clipMutationText(text: string): string {
  return text.length <= MAX_MUTATION_TEXT
    ? text
    : `${text.slice(0, MAX_MUTATION_TEXT)}… [truncated ${text.length - MAX_MUTATION_TEXT} chars]`;
}

export interface MutantManifest {
  readonly selectorIds: SelectorConfig;
  readonly artifactId: string;
  readonly mutants: readonly MutantManifestEntry[];
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Global, so `matchAll` can find EVERY object header in the file, not just the first. */
// Extension kinds first: alternation is tried left to right, so a bare `page`/`table` would
// engage on `pageextension`/`tableextension` before failing its `\s+\d+`.
const OBJECT_HEADER =
  /^\s*(codeunit|tableextension|pageextension|table|page|report|query|xmlport|enum)\s+(\d+)\s+("([^"]+)"|(\w+))/gim;

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
 * String literals are tracked because AL text may legally contain `//` or `/*`
 * (`Error('use // here')`), and a stripper blind to them would blank the rest of the file and
 * report "no AL object header" on a valid one. `''` inside a single-quoted string is an escaped
 * quote, which this handles by simply re-entering the string state on the next quote.
 */
export function stripAlComments(source: string): string {
  const out = source.split("");
  let state: "code" | "line-comment" | "block-comment" | "string" | "identifier" = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "'") state = "string";
      else if (c === '"') state = "identifier";
      else if (c === "/" && next === "/") {
        state = "line-comment";
        out[i] = " ";
      } else if (c === "/" && next === "*") {
        state = "block-comment";
        out[i] = " ";
      }
      continue;
    }
    if (state === "string") {
      if (c === "'") state = "code";
      continue;
    }
    if (state === "identifier") {
      if (c === '"') state = "code";
      continue;
    }
    // Inside a comment: blank everything except newlines, so line numbers and the regex's
    // `^` anchors keep addressing the same lines they did in the original.
    if (state === "line-comment") {
      if (c === "\n") state = "code";
      else out[i] = " ";
      continue;
    }
    // block-comment
    if (c !== "\n") out[i] = " ";
    if (c === "*" && next === "/") {
      out[i + 1] = " ";
      i++;
      state = "code";
    }
  }
  return out.join("");
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
 *  position `injectSelectorVarIntoObject` can anchor against). */
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
function objectHeadersOf(source: string, filePath: string): readonly ObjectHeader[] {
  // Comment-free text, so a commented-out object neither appears in the result nor wins any
  // position race against a live one — see `stripAlComments`.
  // `matchAll` operates on an internal clone, so the shared `g` regex's `lastIndex` never carries
  // between calls (a plain `.exec` loop on OBJECT_HEADER would).
  const matches = [...stripAlComments(source).matchAll(OBJECT_HEADER)];
  if (matches.length === 0) throw new Error(`${filePath}: file has no AL object header`);
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
  throw new Error(
    `writeInstrumentedProject: cannot instrument ${filePath} — it mixes ${found.join("; ")} in one file. ${why}`,
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
    throw new Error(
      `${filePath}: mutation site at offset ${spec.before.startIndex} sits before this file's first AL object header — cannot attribute it to an object.`,
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

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function procedureNameOf(spec: MutationSpec): string {
  const proc = findEnclosingProcedure(spec.before);
  if (proc === null) return "";
  const nameNode = proc.childForFieldName("name");
  return nameNode === null ? "" : stripQuotes(nameNode.text);
}

/**
 * Name of the enclosing `trigger_declaration`, or `undefined` outside one.
 *
 * Trigger bodies have no enclosing `procedure`, so `procedureNameOf` returns
 * `""` for them. That empty string becomes the coverage key `<objectId>::`,
 * which matches no coverage entry and silently classifies every trigger mutant
 * as no-coverage — no error, no failing test, just a tier that appears to have
 * nothing to run.
 */
function triggerNameOf(spec: MutationSpec): string | undefined {
  let current: ALSyntaxNode | null = spec.before;
  while (current !== null) {
    if (current.kind === ALNodeKind.trigger) {
      const nameNode = current.childForFieldName("name");
      return nameNode === null ? undefined : stripQuotes(nameNode.text);
    }
    current = current.parent;
  }
  return undefined;
}

export async function writeInstrumentedProject(input: WriteInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });

  // Dedup runs BEFORE ids are assigned and BEFORE compilation: dropping a mutant only while
  // building the manifest would leave it compiled into the emitted dispatch chain holding an
  // assigned id — an unreported mutation that still exists in the artifact.
  const tierOf: TierResolver = (name) => input.operatorTiers.get(name);
  const specsByFile = new Map<string, readonly MutationSpec[]>();
  for (const f of input.files) specsByFile.set(f.path, dedupeSpecs(f.specs, tierOf));
  const idedByFile = assignMutantIds(specsByFile);

  const manifest: MutantManifestEntry[] = [];
  for (const f of input.files) {
    const ided = idedByFile.get(f.path) ?? [];
    const deduped = specsByFile.get(f.path) ?? [];
    // Read every object header BEFORE instrumenting: both remaining throws (no object header,
    // an injectable object mixed with a non-injectable one) mean this file can never be
    // attributed correctly, and failing before the write keeps a refused file from being left
    // behind, half-instrumented, in the artifact dir.
    const headers = objectHeadersOf(f.source, f.path);
    assertNoUnsupportedObjectMix(headers, f.path);
    const compiled = compileSchemataForFile(f.source, f.root, deduped, ided, f.path);
    await writeFile(join(input.targetDir, basename(f.path)), compiled, "utf8");
    for (const { mutantId, spec } of ided) {
      const triggerName = triggerNameOf(spec);
      // R6: attributed to ITS OWN enclosing object, not always the file's first header — a file
      // legally declaring more than one AL object (all codeunit/table, guarded above) now gets
      // correct per-mutant (objectType, objectId) coverage-lookup keys.
      const header = attributeHeader(headers, spec, f.path);
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        startLine: lineOfIndex(f.source, spec.before.startIndex),
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
        astHash: astSubtreeHash(spec.before),
        objectType: header.type,
        codeunitId: header.id,
        codeunitName: header.name,
        procedureName: procedureNameOf(spec),
        originalText: clipMutationText(spec.before.text),
        mutatedText: clipMutationText(spec.after.text),
        ...(triggerName !== undefined ? { triggerName } : {}),
      });
    }
  }

  // The delegating selector (Active -> LC Control State.IsActive) and the register-install
  // codeunit (registers targetAppId -> artifactId on install). The in-target Mutation Active
  // table, Mutation Control codeunit, and MutationControl web-service XML are NO LONGER emitted —
  // the LethAL Control extension owns all of that now (Layer 5C-A Task 4). The freed controlId
  // becomes the register-install codeunit's object id.
  //
  // Task 8: the selector is the single source of the (targetAppId, artifactId) identity tuple —
  // emitRegisterInstall/emitRegisterUpgrade now read it off `Mutation Selector` at runtime
  // instead of taking it as args, so registration can never diverge from what `Active` uses.
  await writeFile(
    join(input.targetDir, CONTROL_SELECTOR_FILENAME),
    emitMutationSelector({
      ...input.selectorIds,
      artifactId: input.artifactId,
      targetAppId: input.targetAppId,
    }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_REGISTER_FILENAME),
    emitRegisterInstall({ objectId: input.selectorIds.controlId }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_UPGRADE_FILENAME),
    emitRegisterUpgrade({ objectId: input.selectorIds.tableId }),
    "utf8",
  );

  const manifestJson: MutantManifest = {
    selectorIds: input.selectorIds,
    artifactId: input.artifactId,
    mutants: manifest,
  };
  await writeFile(
    join(input.targetDir, "mutant-manifest.json"),
    `${JSON.stringify(manifestJson, null, 2)}\n`,
    "utf8",
  );
}
