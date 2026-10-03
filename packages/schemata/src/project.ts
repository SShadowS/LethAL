import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  FileRefusedError,
  type MutationSpec,
  astSubtreeHash,
  gapBlockOf,
  isProcedureLike,
  maskAlNonCode,
  procedureLikeNameNode,
  renamedMemberCoverageNames,
} from "@lethal/engine";
import { compileSchemataForFile } from "./compile";
import { buildComponents } from "./components";
import { type TierResolver, dedupeSpecs } from "./dedup";
import { type ReachGrain, reachGrainOf } from "./dispatch";
import type { DeclaredObject } from "./id-ranges";
import { type IdedSpec, assignMutantIds } from "./ids";
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
  /** C02-09: a test seam for the gap id function; production passes nothing and gets `gapIdOf`. */
  readonly gapIdOf?: typeof gapIdOf;
  /**
   * R374: every mutant's identity ordinal, numbered ONCE over the whole run (`runIdentityOrdinals`,
   * or the runner's `identityOrdinalsOf` for a generated set), keyed by `identitySiteKey`. Required: a batch
   * that numbered its own rows would give twins in two batches the same key. A row with no entry
   * is refused, never defaulted to 0.
   */
  readonly identityOrdinals: ReadonlyMap<string, number>;
}

/** C02-09: a gap's id. Reads the file (separators normalised), the block's offsets and its raw
 *  source text (owner, Q1), so any edit to the block, or a move, gives a new id. */
export function gapIdOf(
  file: string,
  startIndex: number,
  endIndex: number,
  blockText: string,
): string {
  const text = `${file.replaceAll("\\", "/")}\n${startIndex}\n${endIndex}\n${blockText}`;
  return `G${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/**
 * R193: the five-part semantic identity every consumer keys on, as one string, WITHOUT the
 * ordinal. `identityKeyOf` (runner, selection.ts) builds the same tuple and adds the ordinal; this
 * lives here so `assignIdentityOrdinals` and that function cannot drift onto two tuples.
 */
export function identityTupleOf(
  m: Pick<
    MutantManifestEntry,
    | "astHash"
    | "codeunitName"
    | "procedureName"
    | "triggerName"
    | "operatorName"
    | "operatorVersion"
  >,
): string {
  const scope = m.procedureName || m.triggerName || "";
  const major = Number(m.operatorVersion.split(".")[0] ?? "0");
  return `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${major}`;
}

/**
 * R307: the LOOSE identity tuple: `identityTupleOf` without the object name. A file refused by the
 * header rule (`no-header`, `site-before-header`) has no object name to give, so the run records
 * these instead of reserving exact entries (fail closed, I3).
 */
export function looseIdentityTupleOf(
  m: Pick<
    MutantManifestEntry,
    "astHash" | "procedureName" | "triggerName" | "operatorName" | "operatorVersion"
  >,
): string {
  const scope = m.procedureName || m.triggerName || "";
  const major = Number(m.operatorVersion.split(".")[0] ?? "0");
  return `${m.astHash}|${scope}|${m.operatorName}|${major}`;
}

/**
 * R325: the version of the rules that turn AL source into identity keys.
 *
 * An identity key carries no version of its own. So when an engine or operator change moves an
 * existing mutant's key for UNCHANGED source (a new same-tuple mutant earlier in an object takes
 * ordinal 0 and pushes the old one to 1, R193), a key recorded before the change can name a
 * different mutant after it. Measured on System Application under R-302: a new site at one line
 * carries exactly the key an older site further down held before. Every consumer that carries a
 * verdict across sessions (the known-survivor history, resume, equivalence marks) therefore
 * refuses a key made under a different scheme.
 *
 * Bump it with any engine or operator change that can move an existing mutant's key for unchanged
 * AL source. `1` is every key made before this constant existed; anything recorded without a
 * scheme is read as `1`. 3: R323, a named return value became a declaration (measured moves in
 * the R-323 plan). 4: R318, a renamed split member's coverage is attributed by position and a
 * line two members share names nobody, which changes the verdict an unchanged key can carry
 * (history, `--resume`, `--resume-run`, equivalence marks). No key tuple moves; the bump is for
 * changed attribution of unchanged keys. 5: R214, a mutant in an #if arm the build compiles out is no
 * longer generated, a file whose directives cannot be evaluated as alc does is not mutated, and a
 * statement directly inside a statement-level #if became a statement position (measured moves in
 * the R-214 plan). 6: R418, `codeunitName` can move in a file holding a non-BMP character (an
 * emoji) anywhere before a later comment or blanked string, in code, a quoted name, a comment or a
 * string, in a file of one object or several: the mask no longer shifts, so an erased header is
 * found, a phantom commented-out header is gone, and a header's offset matches the source. 7:
 * R421, discovered paths are normalised to `/`, so on Windows a project with subfolders gets the
 * file order, mutant ids and batches Linux gets, and with per-batch ordinals an identity twin in
 * another file can change ordinal. 8: R307 (R374), identity ordinals are numbered once over the
 * whole run instead of per batch, so keys move only where batching split twins (two twins in two
 * batches both held ordinal 0 before).
 */
export const IDENTITY_SCHEME = 8;

/**
 * R193: number each mutant among its identity twins in SOURCE order (file, then start offset,
 * then mutant id as the last resort). Returns new entries; a mutant with no twin gets 0, so a
 * manifest with no collisions is unchanged apart from the field being present.
 */
export function assignIdentityOrdinals(
  entries: readonly MutantManifestEntry[],
): MutantManifestEntry[] {
  const ordinalOf = identityOrdinalsOf(entries);
  return entries.map((e) => ({ ...e, identityOrdinal: ordinalOf.get(e) ?? 0 }));
}

/** The numbering `assignIdentityOrdinals` applies, without copying the entries (RUST-03 S4.2a). */
function identityOrdinalsOf(
  entries: readonly MutantManifestEntry[],
): Map<MutantManifestEntry, number> {
  const order = [...entries].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startIndex - b.startIndex ||
      a.mutantId.localeCompare(b.mutantId),
  );
  const next = new Map<string, number>();
  const ordinalOf = new Map<MutantManifestEntry, number>();
  for (const e of order) {
    const tuple = identityTupleOf(e);
    const n = next.get(tuple) ?? 0;
    ordinalOf.set(e, n);
    next.set(tuple, n + 1);
  }
  return ordinalOf;
}

/** R374: the key a run-wide identity ordinal is stored under: (file, span, operator), the triple
 *  `narrowFilesToSubset` (runner) already matches a manifest row back to its spec by. */
export function identitySiteKey(
  file: string,
  startIndex: number,
  endIndex: number,
  operatorName: string,
): string {
  // R400: `join`, not a template literal: the same value, built flat. A template string held as a
  // Map key keeps its pieces alive (a rope), and the run-wide ordinal Map holds one per mutant.
  return [file, startIndex, endIndex, operatorName].join("\0");
}

/** R374: the identity fields the writer's row carries for `spec`, from ONE place, so a run-wide
 *  numbering and the manifest row cannot build two different tuples for one mutant. */
export function identityFieldsOf(
  spec: MutationSpec,
  headerName: string,
): Pick<
  MutantManifestEntry,
  "astHash" | "codeunitName" | "procedureName" | "triggerName" | "operatorName" | "operatorVersion"
> {
  const triggerName = triggerNameOf(spec);
  return {
    astHash: astSubtreeHash(spec.before),
    codeunitName: headerName,
    procedureName: procedureNameOf(spec),
    ...(triggerName !== undefined ? { triggerName } : {}),
    operatorName: spec.operatorName,
    operatorVersion: spec.operatorVersion,
  };
}

/** R374: one mutant (or one reserved refused-file site) in the run-wide numbering. */
export interface IdentityEntry {
  readonly file: string;
  readonly startIndex: number;
  /** With `file`, `startIndex` and `operatorName`, rebuilds the site's `identitySiteKey` at
   *  numbering time, so the entry does not hold a second copy of it (R400). */
  readonly endIndex: number;
  readonly operatorName: string;
  /** `identityTupleOf` of the site's `identityFieldsOf`. */
  readonly tuple: string;
}

/** R374: the identity entries of one file's DEDUPED specs, attributed by the writer's own header
 *  rule (`objectHeadersOf` + `attributeHeader`). Throws exactly where the writer would. */
export function identityEntriesOf(
  path: string,
  source: string,
  deduped: readonly MutationSpec[],
): IdentityEntry[] {
  const headers = objectHeadersOf(source, path);
  return deduped.map((spec) => {
    const header = attributeHeader(headers, spec, path);
    return {
      file: path,
      startIndex: spec.before.startIndex,
      endIndex: spec.before.endIndex,
      operatorName: spec.operatorName,
      tuple: identityTupleOf(identityFieldsOf(spec, header.name)),
    };
  });
}

/**
 * R374: number identity twins ONCE over every entry of the run, in source order: file, start,
 * then operator name, the order `assignMutantIds` gives the same specs (the sort is stable, so
 * two entries equal on all three keep their input order, as `assignMutantIds` keeps them).
 * Reserved entries (R-307) take a number like any other. Two entries on one key are refused.
 */
export function numberIdentityOrdinals(entries: readonly IdentityEntry[]): Map<string, number> {
  const order = [...entries].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startIndex - b.startIndex ||
      a.operatorName.localeCompare(b.operatorName),
  );
  const next = new Map<string, number>();
  const out = new Map<string, number>();
  for (const e of order) {
    const key = identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName);
    if (out.has(key)) {
      throw new Error(
        `numberIdentityOrdinals: two mutants share one site key ${JSON.stringify(key)}, so a run-wide identity ordinal cannot name one of them`,
      );
    }
    const n = next.get(e.tuple) ?? 0;
    out.set(key, n);
    next.set(e.tuple, n + 1);
  }
  return out;
}

/** R374: the run-wide ordinals of `files`, deduped as the writer dedupes them, plus `reserved`
 *  (R307: the entries of files refused whole, which take a number and get no row). A real run
 *  passes `generateMutationSet`'s files and reserved entries (`identityOrdinalsOf`, runner). */
export function runIdentityOrdinals(
  files: readonly InstrumentedFile[],
  operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom">,
  reserved: readonly IdentityEntry[] = [],
): Map<string, number> {
  const tierOf: TierResolver = (name) => operatorTiers.get(name);
  return numberIdentityOrdinals([
    ...files.flatMap((f) => identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf))),
    ...reserved,
  ]);
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
   * GH-24: where reach can be measured for this mutant, decided when the dispatch chain is emitted
   * (`reachGrainOf`). Only `statement` mutants carry a `MutationSelector.Reached` marker.
   * `writeInstrumentedProject` always writes it. Optional only for the same reason as
   * `identityOrdinal`: this type is embedded in the event stream, and a stream or manifest written
   * before GH-24 has no grain and must still validate. Absent means "not recorded", never a grain.
   */
  readonly reachGrain?: ReachGrain;
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
  /**
   * `local` when the enclosing procedure is declared `local`, `public` otherwise; ABSENT on
   * trigger mutants (no enclosing procedure — same shape as `triggerName`'s optionality).
   *
   * The hub coverage path cannot resolve a local procedure's coverage `methodId` to a name
   * (locals never appear in SymbolReference.json — verified 2026-07-18), so `byMember` can
   * never hit for a local-procedure mutant, while a member-level miss for a PUBLIC procedure
   * is positive evidence the procedure did not execute. `coverageFilter`'s unnamed-member
   * fallback (selection.ts) keys on this field to cover the first at object grain WITHOUT
   * widening the second into a vacuous `survived` — R63's measured failure on Document
   * Output, where 77 mutants in never-executed procedures were scored `survived`.
   */
  readonly procedureScope?: "local" | "public";
  /**
   * R318: the names coverage may attribute this mutant under, set ONLY when its member is a
   * split-header procedure whose `#if` arms RENAME it (`procedureName` is then `""`): each arm's
   * name once, minus any name another declaration of the same object uses
   * (`renamedMemberCoverageNames`, engine). One arm is compiled per build and coverage names that
   * build's member, so a row under one of these names is this member's row in whichever build ran.
   * The line map spans the member under the FIRST name. `procedureName` stays `""` on purpose, so
   * identity key tuples do not move. Absent everywhere else and on manifests written before R318, which
   * read as before: no member hit, so a public renamed member is `no-coverage`.
   */
  readonly coverageArmNames?: readonly string[];
  readonly triggerName?: string;
  /**
   * C02-01: the 1-based first and last line of the member enclosing this mutant: its `procedure`,
   * or its `trigger` when there is no procedure (the same member `procedureName || triggerName`
   * names, selection.ts `identityKeyOf`). Computed with the same `lineOfIndex` over the same
   * source as `startLine`, so the two can never disagree about numbering. Starts at the
   * `procedure`/`trigger` keyword line: attributes above it are NOT part of the node (measured).
   * Absent when neither encloses the site, and on manifests written before this field existed.
   * Line numbers only, never source text.
   */
  readonly procedureStartLine?: number;
  readonly procedureEndLine?: number;
  /**
   * C02-09: the id of this mutant's gap, `gapIdOf` over its gap block (`gapBlockOf`, the innermost
   * branch body holding the mutated node). Mutants that share a block share an id. Always written
   * by `writeInstrumentedProject`; optional only so manifests and streams written before C02-09
   * still validate. Absent means "not recorded", never "no gap".
   */
  readonly gapId?: string;
  /**
   * C02-09: the 1-based first and last line of the gap block, from the same `lineOfIndex` as
   * `startLine`. Optional for the same reason as `gapId`. Line numbers only, never source text.
   */
  readonly blockStartLine?: number;
  readonly blockEndLine?: number;
  /**
   * R193: this mutant's position, in SOURCE order, among the mutants of this artifact that share
   * its semantic identity tuple (`identityTupleOf`): 0 for the first or only one, 1 for the next
   * byte-identical shape in the same procedure under the same operator, and so on. Every `true`
   * literal in a procedure hashes the same, so without this every `flip-boolean-literal` there
   * shared one identity key: `--resume` re-executed all of them as a colliding key on every
   * resume (15 keys on one real run), and a stranded mutant's key excluded every twin it had (12
   * stranded from 3 events). Assigned by `assignIdentityOrdinals` over the whole manifest.
   *
   * SOURCE order, never report order: R166 rejected an ordinal on the ground that report order is
   * not stable, and it is not; source order is, for an unchanged file. Inserting a twin ABOVE
   * another shifts the ordinals below it, which is the same edit that moves their lines and is
   * the honest answer, an edited procedure re-measures. Absent on a manifest written before
   * R193, which readers treat as 0.
   */
  readonly identityOrdinal?: number;
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
  /**
   * R72 — carried verbatim from `MutationSpec.platformKillMechanism` (engine). A syntactic property
   * of the SITE saying that if this mutant dies, the platform rather than the suite is the likely
   * cause. Present only where an operator recognised one; absent is not a claim of the opposite.
   *
   * Typed as a bare `string` here rather than as the engine's union, deliberately: a manifest is
   * read back off disk from runs this build did not produce, and a value written by an older or
   * newer engine must survive the round trip rather than fail a parse. The report re-exposes it
   * unchanged for the same reason.
   */
  readonly platformKillMechanism?: string;
  /**
   * R196: carried verbatim from `MutationSpec.hangCapable` (engine). An enclosing loop's
   * condition reads the variable this site writes, so a timeout here is expected rather than
   * surprising. It does NOT claim the mutation prevents progress, and its absence does not mean
   * the site is safe. Widened to `string` for the same reason `platformKillMechanism` is: the
   * manifest is read by code that should not have to track the union's members.
   */
  readonly hangCapable?: string;
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

/** RUST-03 S4.2a: the offset of every line's first character, built once per file. */
export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of `index`: one plus the newlines before it (a binary search over `starts`). */
export function lineOfIndex(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
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
  if (matches.length === 0)
    throw new FileRefusedError(`${filePath}: file has no AL object header`, {
      file: filePath,
      shape: "no-header",
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

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * R301, R316: the narrowest procedure-like ancestor (a `procedure`, or either split-header shape),
 * or `null`. Project-local on purpose: the engine's `findEnclosingProcedure` also feeds semantic
 * resolution, which does not see inside a split procedure yet (R302), so it stays unchanged.
 */
function enclosingProcedureLike(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null && !isProcedureLike(current)) current = current.parent;
  return current;
}

/**
 * R318: see `MutantManifestEntry.coverageArmNames`. `[]` outside a renamed split member. `cache`
 * holds one answer per member (keyed by the member's start offset), `[]` answers included, for the
 * length of ONE file's write: `renamedMemberCoverageNames` walks the whole object, and a member can
 * carry dozens of mutants. `coverageArmNamesComputed` counts the computations, so a test can pin it.
 */
export const coverageArmNamesComputed = { count: 0 };
function coverageArmNamesOf(spec: MutationSpec, cache: Map<number, string[]>): string[] {
  const proc = enclosingProcedureLike(spec.before);
  if (proc === null) return [];
  const hit = cache.get(proc.startIndex);
  if (hit !== undefined) return hit;
  coverageArmNamesComputed.count++;
  const names = renamedMemberCoverageNames(proc);
  cache.set(proc.startIndex, names);
  return names;
}

function procedureNameOf(spec: MutationSpec): string {
  const proc = enclosingProcedureLike(spec.before);
  if (proc === null) return "";
  const nameNode = procedureLikeNameNode(proc);
  return nameNode === null ? "" : stripQuotes(nameNode.text);
}

// Leading modifiers of a procedure declaration, tolerating preceding attributes
// (`[ErrorBehavior(...)]` etc.): AL declares `local` FIRST (`local internal procedure`), so a
// `local` word ahead of the `procedure` keyword is the scope marker. Text-level, but anchored
// to the declaration's own start, so a `local` in a preceding comment line cannot match — the
// parse has already separated comments from the declaration node.
// RUST-03 S4.2a: sticky, run on the file's source at the declaration's start, so no procedure's
// whole text is taken per mutant. A match must end inside the declaration.
const LOCAL_SCOPE_PREFIX = /\s*(?:\[[^\]]*\]\s*)*local\b/y;

/** `local`/`public` for the enclosing procedure, or `undefined` outside one (a trigger body). */
function procedureScopeOf(spec: MutationSpec, source: string): "local" | "public" | undefined {
  const proc = enclosingProcedureLike(spec.before);
  if (proc === null) return undefined;
  // R301, R316: a split header's node text starts with `#if`, so its scope is read per arm.
  if (proc.kind !== ALNodeKind.procedure) return splitIsLocal(proc) ? "local" : "public";
  LOCAL_SCOPE_PREFIX.lastIndex = proc.startIndex;
  return LOCAL_SCOPE_PREFIX.test(source) && LOCAL_SCOPE_PREFIX.lastIndex <= proc.endIndex
    ? "local"
    : "public";
}

/** R301, R316: a split procedure, either shape, is `local` only when EVERY arm is: `local` widens
 *  coverage to object grain (selection.ts, R63), so a public arm read as local could manufacture a
 *  vacuous `survived`. Each arm is one `procedure_keyword`, with its `local` in a
 *  `procedure_modifier` before it. */
function splitIsLocal(proc: ALSyntaxNode): boolean {
  const arms = proc.children.filter((c) => c.rawKind === "procedure_keyword").length;
  const localArms = proc.children.filter(
    (c) =>
      c.rawKind === "procedure_modifier" && c.children.some((k) => k.rawKind === "local_keyword"),
  ).length;
  return arms > 0 && localArms === arms;
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

/** C02-01: the enclosing `procedure` node, else the nearest `trigger` ancestor, else `null`. */
function enclosingMemberOf(spec: MutationSpec): ALSyntaxNode | null {
  const proc = enclosingProcedureLike(spec.before);
  if (proc !== null) return proc;
  let current: ALSyntaxNode | null = spec.before;
  while (current !== null && current.kind !== ALNodeKind.trigger) current = current.parent;
  return current;
}

/** R374: `input` with its run-wide ordinals numbered over `input.files` alone. For a caller that
 *  writes ONE hand-built file set (tests, scripts); a real run passes `identityOrdinalsOf`'s. */
export function withRunIdentityOrdinals(input: Omit<WriteInput, "identityOrdinals">): WriteInput {
  return { ...input, identityOrdinals: runIdentityOrdinals(input.files, input.operatorTiers) };
}

/**
 * R307: the writer's per-file steps, in the writer's order, moved here verbatim so the writer and
 * `generateMutationSet`'s per-file trial run ONE function and cannot drift. Every per-file refusal
 * (`FileRefusedError`) fires in here; nothing is written. `ided` must be the file's deduped specs
 * with ids in `assignMutantIds` order (the trial passes file-local ids, which order the same).
 */
export function instrumentOneFile(
  f: Pick<InstrumentedFile, "path" | "source" | "root">,
  deduped: readonly MutationSpec[],
  ided: readonly IdedSpec[],
): {
  readonly compiled: string;
  readonly grainOf: ReadonlyMap<string, ReachGrain>;
  readonly headerOf: ReadonlyMap<string, ObjectHeader>;
} {
  // Read every object header BEFORE instrumenting: both remaining throws (no object header,
  // an injectable object mixed with a non-injectable one) mean this file can never be
  // attributed correctly, and failing before the write keeps a refused file from being left
  // behind, half-instrumented, in the artifact dir.
  const headers = objectHeadersOf(f.source, f.path);
  assertNoUnsupportedObjectMix(headers, f.path);
  const compiled = compileSchemataForFile(f.source, f.root, deduped, ided, f.path);
  // The same components `compileSchemataForFile` builds from the same `ided`, so the grain
  // recorded here is the one the emitted chain placed (or omitted) its marker by.
  const grainOf = new Map<string, ReachGrain>();
  for (const c of buildComponents(ided)) {
    for (const m of c.members) grainOf.set(m.mutantId, reachGrainOf(m, c.root));
  }
  // R6: attributed to ITS OWN enclosing object, not always the file's first header.
  const headerOf = new Map<string, ObjectHeader>();
  for (const { mutantId, spec } of ided)
    headerOf.set(mutantId, attributeHeader(headers, spec, f.path));
  return { compiled, grainOf, headerOf };
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

  // R374: rows are numbered from the run-wide `identityOrdinals`, never per batch.
  const rows: { -readonly [K in keyof MutantManifestEntry]: MutantManifestEntry[K] }[] = [];
  // C02-09: gap id -> "<file>\n<start>\n<end>" of the block it names. Offsets decide: two blocks
  // on one line are two blocks. A second, different block under one id is refused, never merged.
  const blockOfGap = new Map<string, string>();
  const idOf = input.gapIdOf ?? gapIdOf;
  for (const f of input.files) {
    const ided = idedByFile.get(f.path) ?? [];
    const deduped = specsByFile.get(f.path) ?? [];
    const { compiled, grainOf, headerOf } = instrumentOneFile(f, deduped, ided);
    await writeFile(join(input.targetDir, basename(f.path)), compiled, "utf8");
    // RUST-03 S4.2a: per file, not per mutant: the line index, and each gap block's id and lines.
    const starts = lineStartsOf(f.source);
    const gapOf = new Map<
      string,
      { gapId: string; blockStartLine: number; blockEndLine: number }
    >();
    const armNamesCache = new Map<number, string[]>();
    for (const { mutantId, spec } of ided) {
      // R6: attributed to ITS OWN enclosing object, not always the file's first header — a file
      // legally declaring more than one AL object (all codeunit/table, guarded above) now gets
      // correct per-mutant (objectType, objectId) coverage-lookup keys.
      const header = headerOf.get(mutantId);
      if (header === undefined) {
        throw new Error(`writeInstrumentedProject: no object header for ${mutantId} in ${f.path}`);
      }
      const id = identityFieldsOf(spec, header.name);
      const triggerName = id.triggerName;
      const siteKey = identitySiteKey(
        f.path,
        spec.before.startIndex,
        spec.before.endIndex,
        spec.operatorName,
      );
      const identityOrdinal = input.identityOrdinals.get(siteKey);
      if (identityOrdinal === undefined) {
        throw new Error(
          `writeInstrumentedProject: ${mutantId} (${f.path}, ${spec.before.startIndex}..${spec.before.endIndex}, ${spec.operatorName}) has no run-wide identity ordinal; the caller's identityOrdinals was built over a different spec set (R374)`,
        );
      }
      const procedureScope = procedureScopeOf(spec, f.source);
      const coverageArmNames = coverageArmNamesOf(spec, armNamesCache);
      const member = enclosingMemberOf(spec);
      const block = gapBlockOf(spec.before);
      const inFile = `${block.startIndex}\n${block.endIndex}`;
      let gap = gapOf.get(inFile);
      if (gap === undefined) {
        const gapId = idOf(
          f.path,
          block.startIndex,
          block.endIndex,
          f.source.slice(block.startIndex, block.endIndex),
        );
        const blockKey = `${f.path}\n${inFile}`;
        const firstBlock = blockOfGap.get(gapId);
        if (firstBlock === undefined) blockOfGap.set(gapId, blockKey);
        else if (firstBlock !== blockKey) {
          throw new Error(
            `writeInstrumentedProject: two blocks share gap id ${gapId}: ${JSON.stringify(firstBlock)} and ${JSON.stringify(blockKey)}`,
          );
        }
        gap = {
          gapId,
          blockStartLine: lineOfIndex(starts, block.startIndex),
          blockEndLine: lineOfIndex(starts, block.endIndex),
        };
        gapOf.set(inFile, gap);
      }
      const reachGrain = grainOf.get(mutantId);
      if (reachGrain === undefined) {
        throw new Error(`writeInstrumentedProject: no reach grain for ${mutantId} in ${f.path}`);
      }
      rows.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        startLine: lineOfIndex(starts, spec.before.startIndex),
        operatorName: id.operatorName,
        operatorVersion: id.operatorVersion,
        astHash: id.astHash,
        gapId: gap.gapId,
        blockStartLine: gap.blockStartLine,
        blockEndLine: gap.blockEndLine,
        reachGrain,
        objectType: header.type,
        codeunitId: header.id,
        codeunitName: id.codeunitName,
        procedureName: id.procedureName,
        originalText: clipMutationText(spec.before.text),
        mutatedText: clipMutationText(spec.after.text),
        ...(procedureScope !== undefined ? { procedureScope } : {}),
        ...(coverageArmNames.length > 0 ? { coverageArmNames } : {}),
        ...(member !== null
          ? {
              procedureStartLine: lineOfIndex(starts, member.startIndex),
              procedureEndLine: lineOfIndex(starts, member.endIndex),
            }
          : {}),
        ...(triggerName !== undefined ? { triggerName } : {}),
        ...(spec.platformKillMechanism !== undefined
          ? { platformKillMechanism: spec.platformKillMechanism }
          : {}),
        ...(spec.hangCapable !== undefined ? { hangCapable: spec.hangCapable } : {}),
        // Last, where `assignIdentityOrdinals`' spread puts it, so the manifest's key order holds.
        identityOrdinal,
      });
    }
  }

  const manifest: readonly MutantManifestEntry[] = rows;

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
  await writeManifestJson(join(input.targetDir, "mutant-manifest.json"), manifestJson);
}

/** R311: the manifest, written one row at a time. Serializes exactly the three named
 *  `MutantManifest` fields (`selectorIds`, `artifactId`, `mutants`) and nothing else, even an
 *  extra enumerable field the caller's object happens to carry, and rejects a sparse array or an
 *  `undefined` element in `mutants`, where `JSON.stringify` would write `null` instead. Within
 *  that contract, matches `${JSON.stringify(manifest, null, 2)}\n` byte for byte (RUST-03 S4a
 *  review M2 narrows this from "every input": see manifest-stream.test.ts for the edge values
 *  this was measured against). One string for a whole-BaseApp manifest exhausts memory; each
 *  row's own stringify is small. JSON strings contain no raw newline, so indenting every line
 *  after the first reproduces the nesting JSON.stringify would produce. `io` exists only so
 *  tests can inject a short-writing handle and a failing rename; product code never passes it. */
export interface ManifestIo {
  readonly open: typeof open;
  readonly rename: typeof rename;
}

// If MutantManifest gains a field, writeManifestJson must write it too: this fails typecheck first.
type _ManifestKeys = Exclude<keyof MutantManifest, "selectorIds" | "artifactId" | "mutants">;
const _manifestKeysCovered: [_ManifestKeys] extends [never] ? true : never = true;
void _manifestKeysCovered;

export async function writeManifestJson(
  path: string,
  manifest: MutantManifest,
  io: ManifestIo = { open, rename },
): Promise<void> {
  const nest = (v: unknown, pad: string): string =>
    JSON.stringify(v, null, 2).replaceAll("\n", `\n${pad}`);
  // RUST-03 S4a review I1: drop any manifest already sitting at the real name BEFORE writing the
  // .partial. A caller (writeInstrumentedProject) does not require an empty target directory, so
  // without this a failed rewrite left the OLD manifest under the real name looking complete and
  // valid to a later reader. Removing it up front means every failure path below now leaves NO
  // manifest at `path`, whether or not one was there before this call.
  await rm(path, { force: true });
  // Written to a .partial file and renamed only when whole, so a crash, a throw or a short write
  // never leaves a truncated mutant-manifest.json that a later reader could take for a whole one.
  const partial = `${path}.partial`;
  const fh = await io.open(partial, "w");
  // A write may accept fewer bytes than asked without throwing, so loop until all are written.
  const writeAll = async (text: string): Promise<void> => {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      if (bytesWritten <= 0)
        throw new Error(
          `writeManifestJson: no progress writing ${partial} at byte ${off} of ${buf.length}`,
        );
      off += bytesWritten;
    }
  };
  let written = false;
  let ok = false;
  try {
    try {
      await writeAll(
        `{\n  "selectorIds": ${nest(manifest.selectorIds, "  ")},\n  "artifactId": ${JSON.stringify(manifest.artifactId)},\n  "mutants": `,
      );
      if (manifest.mutants.length === 0) {
        await writeAll("[]");
      } else {
        await writeAll("[\n");
        let chunk = "";
        for (let i = 0; i < manifest.mutants.length; i++) {
          chunk += `${i === 0 ? "" : ",\n"}    ${nest(manifest.mutants[i], "    ")}`;
          if (chunk.length > 1 << 20) {
            await writeAll(chunk);
            chunk = "";
          }
        }
        await writeAll(`${chunk}\n  ]`);
      }
      await writeAll("\n}\n");
      written = true;
    } finally {
      // After a whole write, a failing close is the failure. After a failed write, the write's
      // own error wins and the close error is dropped.
      await fh.close().catch((e: unknown) => {
        if (written) throw e;
      });
    }
    ok = true;
  } finally {
    // Any failure above, close included, removes the .partial before the error propagates.
    if (!ok) await rm(partial, { force: true });
  }
  try {
    await io.rename(partial, path);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}
