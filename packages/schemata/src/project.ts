import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationSpec,
  astSubtreeHash,
  gapBlockOf,
  isProcedureLike,
  memberSpanText,
  procedureLikeNameNode,
  renamedMemberCoverageNames,
} from "@lethal/engine";
import { type TierResolver, dedupeSpecs } from "./dedup";
import type { ReachGrain } from "./dispatch-plan";
import { type FlatNames, flatNamesFor } from "./flat-names";
import { type IdedSpec, assignMutantIds, compareCodeUnits } from "./ids";
import { emitOneFile } from "./project-emit";
import { type PlannedMutant, attributeHeader, objectHeadersOf, planOneFile } from "./project-plan";
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
  /**
   * R219: the flat name of each written file, built over the WHOLE project's `.al` list so a
   * duplicate basename is named as every other writer and reader names it (`flatNamesFor`).
   * Absent: built over `files` alone, which is only right when no unwritten project file shares a
   * basename with one of them (tests and scripts writing a hand-built set). A real run passes it.
   */
  readonly flatNames?: FlatNames;
}

/** C02-09: a gap's id. Reads the file (separators normalised), the block's position and its source
 *  text (owner, Q1), so any edit to the block, or a move, gives a new id. R276: the position is the
 *  block's LINE span and the text has its line endings normalised, so a CRLF and an LF checkout of
 *  one commit give one id (byte offsets and raw text differed between them). */
export function gapIdOf(
  file: string,
  startLine: number,
  endLine: number,
  blockText: string,
): string {
  const lf = blockText.replaceAll("\r\n", "\n");
  const text = `${file.replaceAll("\\", "/")}\n${startLine}\n${endLine}\n${lf}`;
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
 * R442: the COARSE identity tuple, `astHash|operatorName|major`: `identityTupleOf` without the
 * object name and the scope. A site a run numbered no ordinal for (a header-rule refusal, a site
 * a line filter dropped) records this, and every mutant sharing it carries no verdict across that
 * run (fail closed, R307 I3).
 *
 * Why it covers every ordinal twin even though names and scopes may hold `|`: the exact tuple is
 * `hash|name|scope|op|major` and a key adds `|ordinal` only above 0. The hash is hex, operator
 * names come from the built-in registry (no `|`, never all digits) and the major is an integer.
 * So two equal tuple or key strings share the first field and, read from the right, the operator
 * and major (an ordinal tail cannot pose as a major: the field before it would then be an
 * all-digit operator name). R307's loose tuple kept the scope, and so missed object `"A|B"` with
 * procedure `C` against object `A` with procedure `"B|C"`.
 */
export function coarseIdentityTupleOf(
  m: Pick<MutantManifestEntry, "astHash" | "operatorName" | "operatorVersion">,
): string {
  const major = Number(m.operatorVersion.split(".")[0] ?? "0");
  return `${m.astHash}|${m.operatorName}|${major}`;
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
 * another file can change ordinal. 8: R405, a member-level #if now hides a procedure or trigger
 * by arm for the symbol table, the table-trigger readers and the receiver filter, so a call that
 * was refused (or read against an inactive arm) is admitted, and a newly admitted mutant with the
 * same tuple as an existing one earlier in a member takes ordinal 0 and moves that one's key. 9:
 * R307 (R374), identity ordinals are numbered once over the whole run instead of per batch, so
 * keys move only where batching split twins (two twins in two batches both held ordinal 0
 * before). 10: R196 and R239, the built-in value operators refuse a site that writes a loop
 * condition's variable, and `flip-boolean-literal` refuses a literal that reaches a loop's exit, so
 * a later same-tuple twin of a refused mutant takes its ordinal and its old key. 11: R295 and
 * R294, every name of `A, B: T` is declared and a member-expression receiver resolves again (and
 * a name inside a `with` body types as nothing), so sites are added and removed and same-tuple
 * ordinals move. 12 was reserved for R254 and is unused. 13: R455, a field-designator argument of a record
 * builtin is never swapped, an unqualified call in a record scope types as nothing, and a
 * case-only pair is not swapped, so swaps and additive flips are removed and a later same-tuple
 * twin takes the removed one's ordinal. 14: R454, the built-in value operators also refuse a
 * literal in a loop condition's `#if` tail (`shift-integer`), a literal inside a comparison in a
 * loop's exit test (`flip-boolean-literal`) and a write to `R.Field` that an enclosing loop's
 * condition reads, so a later same-tuple twin of a refused mutant takes its ordinal and its old
 * key. 15 was reserved for R-254 and is unused. 16: R-364, inside an object wrapped whole in `#if`
 * (not indexed) the same refusal matches an unresolved target by name, so hang-capable writes
 * there are removed and a later same-tuple twin takes the removed one's ordinal. 17: R254, a
 * reportextension is instrumented; its mutants take ordinals, so a same-named twin elsewhere can
 * move. 18: R-458, the same refusal also matches by name through every `with` subject and implicit
 * record (`Rec`, report dataitems, reportextension `modify`) a target's name can bind to, so those
 * hang-capable writes are removed and a later same-tuple twin takes the removed one's ordinal. 19:
 * R468, every direct object-level var section is the object's globals (only the first was), so a
 * later section's record receivers move call deletions from `void-method-call` to Tier 2, `true`
 * RunTrigger flips cede to `swap-modify-flag`, new hang refusals remove writes, and swaps choose a
 * different typed pair under an unchanged key. 20 was held for R-464 and is unused. 21: R459, a
 * two-argument `Insert`'s Booleans are flipped (no longer ceded to `swap-modify-flag`, which never
 * claimed them), so a later same-tuple `true` twin in the procedure moves ordinal (BC.History: 9
 * keys). 22: R-464, one implicit-record resolver: a qualified `Rec` in a page or a TableNo `OnRun`,
 * a report dataitem and a `with` subject now resolve, so Tier 2 claims sites there (and the `true`
 * RunTrigger flips they held cede to `swap-modify-flag`), `validate-to-assign`'s bare form writes
 * the record the call binds to or is refused, and a later same-tuple twin of a removed mutant takes
 * its ordinal. 23 was held for R-446 and is unused. 24: R475, twins are numbered in code-unit file
 * order (was the host's default collation), so a cross-file twin pair whose paths order
 * differently under the two can swap ordinals (fixtures, CDO and BaseApp measured: 0 keys move).
 * 25: R446, in a loop whose condition reads no name and calls nothing (`while true`), a write a
 * body-exit guard reads is hang-refused, so a later same-tuple twin of a refused mutant takes its
 * ordinal (BC.History: 16 keys). 26: R477, `validate-to-assign` emits the bare `F := V` where
 * R-464 refused a bare `Validate(F, V)` and nothing at the call declares F, so a new mutant earlier
 * in a procedure with the same tuple as an existing one takes ordinal 0 and moves that one's key
 * (corpora: 47 sites added, 0 keys moved; the move is pinned on a constructed table). 27: R480, a
 * body-exit guard's write is hang-refused under any `while`/`repeat` condition that names no
 * cursor method, a write feeding a guard of a `while true` loop is too, and so is a write to an
 * enclosing `for`'s control variable, so a later same-tuple twin of a refused mutant takes its
 * ordinal (prototype: 52 keys, DC 12, BC.History 40). 28: R484, an open `Integer` report data item
 * is a loop, so a write its exit guards or its own range bounds read is hang-refused and a later
 * same-tuple twin of a refused mutant takes its ordinal (BC.History: 216 keys; fixtures, CDO, DC
 * and DO: none). 29: R-300b, no key tuple moves and the emitted AL is byte-identical, but on
 * al-runner a `#if`-wrapped object alone in its file is now scored, so a key whose verdict was a
 * refusal's `no-coverage` can now be scored (R318's scheme-4 reason). The bump is global: history,
 * `--resume` and marks recorded under 28 are not carried, bcdev's included. 30: R487, every site
 * the four hang-capable operators mutate in an open `Integer` report data item's code (its
 * triggers, its child items, a reportextension dataset block anchored on it, and the same-object
 * procedures that code reaches) is hang-refused, so a later same-tuple twin of a refused mutant
 * takes its ordinal (BC.History: 5,010 sites refused, 203 keys; fixtures, CDO, DC and DO: none).
 * 32: R509, the type table reads a `Record "X" temporary` as table X, so `swap-additive` gains
 * mutants on a temporary record's fields, and a new mutant earlier in a procedure with an existing
 * one's tuple takes its ordinal (keys moved: CDO 1, DO 2, BC.History 3; fixtures and DC: none). 31
 * was held for R-501 and is unused: R509 landed first, so R-501 takes the next number above it.
 * 33: R501, the same scope is hang-refused for EVERY operator at dispatch (`openItemHangRefuses`,
 * no exemption), and so is a site that deletes or alters a bounded item's only `SetRange` bound,
 * so a later same-tuple twin of a refused mutant takes its ordinal (BC.History: 13,435 mutants
 * refused, 378 keys; fixtures, CDO, DC and DO: none).
 * 34: R343, an object wrapped whole in `#if` is indexed when the build compiles its arm, so typed
 * operators gain its sites and Tier 1 cedes the ones Tier 2 claims, and a new or ceded mutant
 * earlier in a procedure moves a same-tuple twin's ordinal (BC.History: 4 keys; fixtures, CDO, DC
 * and DO: none).
 * 35: R500, the dispatch check also refuses `Date` items, one-hop callees of open-item code in other
 * objects (codeunits, records, interface implementers, event subscribers), outside filter calls on
 * an open item, and two stated limits (a preset exit name's writes, a self-inserting item's own
 * filter), so a later same-tuple twin of a refused mutant takes its ordinal (measured against master
 * 15c3a620, BC.History: 23,944 deployed mutants removed, 165 keys; CDO and DO 2 removed, 0 keys;
 * fixtures and DC: none).
 * 36: R497, the BC paths score #if-wrapped objects of the measured shapes; no key moves, but a key whose verdict was a refusal's no-coverage on bcdev can now be scored, so history, --resume and marks recorded under 35 are not carried (the R-300b precedent, scheme 29).
 * 37: R340, a trigger's header names (parameters, plain var locals, the named return) are typed, so typed operators gain sites in triggers and swap-call-arguments can choose a different pair under an unchanged identity key (measured: DC +59, DO +5, CDO +5 sites, 0 keys moved, but a pair change is invisible to keys); history, --resume and marks recorded under 36 are not carried.
 * 38: R555, a call to a procedure that writes a preset exit name (in the report, its extension's base, or through a typed `Report X` receiver in any object) is hang-refused like the write itself; a refused site renumbers its same-tuple twins (measured on BaseApp at 48d5534f: 483 deployed mutants removed, 0 tuples moved, five ordinals moved; every other corpus: none).
 * 39 R-531: 47 ordinals renumber (43 BaseApp, 4 System Application); no tuple moves. A loop whose cursor condition (`Find*`, `IsEmpty`, `Count`, never `Next`) ends only because its body consumes the record set is hang-refused (the consumers, their guards and feeds, a one-hop same-object callee's consumers, the pre-loop filters the ending depends on, and every operator in the condition but swap-find-direction), so a refused site renumbers its same-tuple twins.
 */
export const IDENTITY_SCHEME = 39;

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
      compareCodeUnits(a.file, b.file) ||
      a.startIndex - b.startIndex ||
      compareCodeUnits(a.mutantId, b.mutantId),
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
 * then operator name, the order `assignMutantIds` gives the same specs. Strings compare by code
 * unit (R475), the order discovery and the generation hash use, never by the host's collation:
 * otherwise a resume on another host could swap two twins' ordinals under an equal hash. The sort
 * is stable, so two entries equal on all three keep their input order, as `assignMutantIds` keeps
 * them.
 * Reserved entries (R-307) take a number like any other. Two entries on one key are refused.
 */
export function numberIdentityOrdinals(entries: readonly IdentityEntry[]): Map<string, number> {
  const order = [...entries].sort(
    (a, b) =>
      compareCodeUnits(a.file, b.file) ||
      a.startIndex - b.startIndex ||
      compareCodeUnits(a.operatorName, b.operatorName),
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
  return numberIdentityOrdinals(runIdentityEntries(files, operatorTiers, reserved));
}

/** R391: the entries `runIdentityOrdinals` numbers, so a run can also record which tuples are
 *  twins within one file from exactly the set its ordinals were numbered over. */
export function runIdentityEntries(
  files: readonly InstrumentedFile[],
  operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom">,
  reserved: readonly IdentityEntry[] = [],
): IdentityEntry[] {
  const tierOf: TierResolver = (name) => operatorTiers.get(name);
  return [
    ...files.flatMap((f) => identityEntriesOf(f.path, f.source, dedupeSpecs(f.specs, tierOf))),
    ...reserved,
  ];
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
   * R474: SHA-256 of the enclosing member's RAW source (`memberSpanText`: from its first
   * attribute, attribute-only `#if` wrappers included, to its end); `""` at object level. NOT part
   * of the identity key: rule 2 of `carryRecord` also requires it equal, so a verdict carries across
   * an edit only into an unchanged member. Absent on a manifest written before R474, which carries
   * nothing under rule 2 and is never given an invented hash.
   */
  readonly memberHash?: string;
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

// R-307 O6: the header rules (H1-H3) and `stripAlComments` moved to project-plan.ts (PLAN).
export {
  type ObjectHeader,
  attributeHeader,
  scanDeclaredObjects,
  stripAlComments,
} from "./project-plan";

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
 * R307, R-307 O6: the writer's per-file steps, as a composition: PLAN (`planOneFile`, every
 * per-file refusal and every decision; `generateMutationSet`'s trial runs this alone) then EMIT
 * (`emitOneFile`, the instrumented text). `mutants` is the plan's, unchanged: one entry per ided
 * spec, in `ided` order, carrying its header and grain.
 */
export function instrumentOneFile(
  f: Pick<InstrumentedFile, "path" | "source" | "root">,
  deduped: readonly MutationSpec[],
  ided: readonly IdedSpec[],
): { readonly compiled: string; readonly mutants: readonly PlannedMutant[] } {
  const plan = planOneFile(f, deduped, ided);
  return { compiled: emitOneFile(plan), mutants: plan.mutants };
}

export async function writeInstrumentedProject(input: WriteInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });
  const flatNames = input.flatNames ?? flatNamesFor(input.files.map((f) => f.path));

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
    const { compiled, mutants } = instrumentOneFile(f, deduped, ided);
    // R-307 O6: `mutants` is walked in step with `ided`, by position, so a missing or reordered
    // entry is a caller-contract violation, refused before anything of this file is written.
    if (mutants.length !== ided.length) {
      const unmatched =
        mutants.length < ided.length
          ? ided[mutants.length]?.mutantId
          : mutants[ided.length]?.mutantId;
      throw new Error(
        `writeInstrumentedProject: ${f.path}: the plan holds ${mutants.length} mutant(s) for ${ided.length} ided spec(s); first unmatched: ${unmatched}`,
      );
    }
    await writeFile(join(input.targetDir, flatNames.flatOf(f.path)), compiled, "utf8");
    // RUST-03 S4.2a: per file, not per mutant: the line index, and each gap block's id and lines.
    const starts = lineStartsOf(f.source);
    const gapOf = new Map<
      string,
      { gapId: string; blockStartLine: number; blockEndLine: number }
    >();
    const armNamesCache = new Map<number, string[]>();
    // R474: one hash per member (keyed by its start), not per mutant.
    const memberHashes = new Map<number, string>();
    const memberHashOf = (member: ALSyntaxNode | null): string => {
      if (member === null) return "";
      let hash = memberHashes.get(member.startIndex);
      if (hash === undefined) {
        hash = createHash("sha256").update(memberSpanText(f.source, member)).digest("hex");
        memberHashes.set(member.startIndex, hash);
      }
      return hash;
    };
    let at = 0;
    for (const { mutantId, spec } of ided) {
      const planned = mutants[at];
      if (planned === undefined || planned.mutantId !== mutantId) {
        throw new Error(
          `writeInstrumentedProject: ${f.path}: mutant ${at} of the plan is ${planned?.mutantId ?? "missing"}, where ided holds ${mutantId}`,
        );
      }
      at++;
      // R6: attributed to ITS OWN enclosing object, not always the file's first header — a file
      // legally declaring more than one AL object (all codeunit/table, guarded above) now gets
      // correct per-mutant (objectType, objectId) coverage-lookup keys.
      const { header, grain: reachGrain } = planned;
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
          lineOfIndex(starts, block.startIndex),
          lineOfIndex(starts, block.endIndex),
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
        memberHash: memberHashOf(member),
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
