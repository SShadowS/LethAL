import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sameBuildSymbols, validateSymbolList } from "./preprocessor-symbols";
import { twinSiteOf } from "./selection";

/**
 * R172 proposal 3 — let a reader record that a particular survivor is an EQUIVALENT MUTANT, and
 * keep that knowledge across runs.
 *
 * A survivor is meant to be a lead: something the tests do not notice. An equivalent mutant is a
 * survivor that is not a lead at all, because the mutated program behaves identically to the
 * original on every input. Nothing can kill it, and a reader who chases it wastes exactly the time
 * the tool exists to save. Deciding equivalence automatically is undecidable in general, and
 * [[R172]] refused the two cheap approximations after measuring them, so the remaining honest move
 * is to let a HUMAN rule on one mutant and then never make anyone rule on it again.
 *
 * **This never changes a verdict or the score.** A marked mutant stays `survived` and stays in
 * `mutationScore`. The mark is a note attached to a verdict, the way `platformArtifactKills` is a
 * note attached to a kill — because a reader's ruling is not something LethAL can verify, and a
 * score that silently improved when someone edited a JSON file would be the worst of both worlds.
 * What a mark buys is that the survivor list can say "someone already looked at this, and here is
 * what they concluded".
 *
 * ## The three outcomes, and why the third one is the point
 *
 * Matching marks against a run produces three groups, not one:
 *
 * - **matched** — the mark names a mutant in this run, and that mutant survived. The ordinary case.
 * - **stale** — the mark names nothing in this run. The identity key includes [[R166]]'s
 *   `astSubtreeHash`, so editing the mutated code changes the hash and the mark stops matching.
 *   That is the safe direction, but it must be reported: a ruling that silently evaporated is a
 *   ruling nobody knows they lost. A mark is also stale when it was made under another identity
 *   scheme ([[R325]]). An earlier version of this comment said a mark "can never drift onto a
 *   different mutant". It could: an engine change that renumbers ordinals (R193) hands an old key
 *   to a different mutant with the source unchanged. The scheme check is what closes that.
 * - **refused** (R443) — the mark cannot show that its key still names the mutant it was written
 *   for. A key holds no file, and twins are told apart by a run-wide ordinal, so an edit anywhere,
 *   `--only`, `--lines` or a repaired header can hand the key to another twin. A mark carries its
 *   proof (`numberingDigest`, `file`, `fileSingleton`, printed by `lethal explain`) and is matched
 *   only under rule 1 or rule 2 (`applyEquivalenceMarks`); anything else stays a survivor.
 * - **contradicted** — the mark names a mutant that this run KILLED. Someone stated that no test
 *   could distinguish this mutant, and a test just did. **That is a decidable check on a human
 *   claim, and it is the only part of this feature that can prove anything.** It is reported
 *   loudly, and the kill stands: the verdict is the measurement and the mark is the opinion.
 */

/** One reader's ruling about one mutant, as it appears in the marks file. */
export interface EquivalenceMark {
  /**
   * [[R166]]'s serialized identity: `astHash|codeunitName|procedureName|operatorName|operatorMajor`,
   * plus `|<identityOrdinal>` for a twin after the first (R193, R230).
   * Built with `serializeKey(identityKeyOf(entry))` so a mark and a run agree by construction; a
   * second spelling of the same key is how the two would drift apart.
   */
  readonly key: string;
  /**
   * WHY this mutant cannot be killed. Required, and required to be non-empty.
   *
   * A mark without a reason is an unexplained subtraction from the one list a reader is supposed to
   * act on, and six months later nobody can tell a considered ruling from a mis-click. The parser
   * refuses one rather than defaulting it.
   */
  readonly reason: string;
  readonly markedBy?: string;
  readonly markedOn?: string;
  /**
   * R325: the identity scheme (`IDENTITY_SCHEME`, `@lethal/schemata`) the key was made under. Read
   * from the marks file's top-level `identityScheme`; a file without one was written before the
   * field existed and reads as 1. A mark whose scheme is not the one its mutants were keyed under
   * is reported stale and never matched or contradicted.
   */
  readonly identityScheme: number;
  /**
   * R214: the effective preprocessor symbols (config plus app.json) the key was made under. After
   * R214 a key names a site within one build, so a mark applies only to a build with exactly this
   * set. ABSENT means `[]`: the mark applies only to a build with no symbols.
   */
  readonly preprocessorSymbols?: readonly string[];
  /**
   * R443: the marked mutant's file (`/` separators), as `lethal explain` printed it. Rule 2 matches
   * on (tuple, file).
   */
  readonly file?: string;
  /**
   * R443: the marked run's `numberingDigest` (`numberingDigestOf`, selection.ts). Rule 1 matches by
   * key only when this run's digest is equal, since equal digests mean equal ordinals.
   */
  readonly numberingDigest?: string;
  /**
   * R443: true when the marked run proved the mutant's (file, tuple) a singleton: outside the run's
   * twin sites, and neither its coarse tuple nor its file hidden from numbering (`carryHidden`).
   */
  readonly fileSingleton?: boolean;
}

/** The minimum a caller must know about a mutant to match marks against it. Deliberately
 *  structural: this module must not import the report, because the report imports this. */
export interface MarkableMutant {
  /** R231: ids restart per batch, so `mutantCode` names a mutant only with its batch. */
  readonly batchIndex: number;
  readonly mutantCode: string;
  /** `serializeKey(identityKeyOf(...))` for this mutant. */
  readonly identity: string;
  /** R443: the mutant's file and `identityTupleOf` tuple, for rule 2. */
  readonly file: string;
  readonly tuple: string;
  readonly verdict: string;
}

/**
 * R443: this run's numbering facts, recorded at generation: the digest of its numbering output and
 * its twin sites (`twinSitesOf`). Absent: every mark is refused (fail closed).
 */
export interface RunNumberingFacts {
  readonly numberingDigest: string;
  readonly twinSites: ReadonlySet<string>;
}

/**
 * R443: why a mark was refused.
 * - `no-proof`: the mark has none of `numberingDigest`, `file`, `fileSingleton` (written before R443).
 * - `no-run-facts`: this run recorded no numbering facts to check a proof against.
 * - `renumbered`: the numbering changed since the mark was made, and the mark does not prove its
 *   mutant a singleton in its file.
 * - `twin-in-file`: the mark proved a singleton, but this run has a twin of it in that file.
 */
export const MARK_REFUSAL_REASONS = [
  "no-proof",
  "no-run-facts",
  "renumbered",
  "twin-in-file",
] as const;
export type MarkRefusalReason = (typeof MARK_REFUSAL_REASONS)[number];

export interface RefusedMark {
  readonly key: string;
  readonly reason: MarkRefusalReason;
  /** The mark's file, when it named one, so a reader can find the mutant to re-mark. */
  readonly file?: string;
}

export interface MatchedMark {
  /** R443: the matched row's CURRENT key, which differs from the mark's under rule 2. */
  readonly key: string;
  readonly reason: string;
  readonly batchIndex: number;
  readonly mutantCode: string;
}

export interface ContradictedMark {
  readonly key: string;
  readonly reason: string;
  readonly batchIndex: number;
  readonly mutantCode: string;
  /** The verdict that contradicts the mark — a kill, or anything else that is not a survival. */
  readonly verdict: string;
}

export interface EquivalenceMarkReport {
  readonly matched: readonly MatchedMark[];
  readonly stale: readonly EquivalenceMark[];
  readonly contradicted: readonly ContradictedMark[];
  /** R443: marks that could not prove they name the mutant they were written for. */
  readonly refused: readonly RefusedMark[];
}

/** Verdicts that are consistent with a mutant nothing can kill. `known-survivor` counts: it is a
 *  survival carried from a prior run, not a fresh contradiction of the mark. */
export const SURVIVING_VERDICTS: ReadonlySet<string> = new Set(["survived", "known-survivor"]);

export class EquivalenceMarksError extends Error {}

/**
 * R443: the `reason` `lethal explain` prints in a ready-to-paste mark. The parser refuses it
 * unchanged, so pasting a mark without writing its reason fails loudly.
 */
export const MARK_REASON_PLACEHOLDER = "TODO: write why no test can kill this mutant";

/**
 * Parse a marks file. Throws `EquivalenceMarksError` on anything malformed rather than skipping the
 * bad entry — a marks file that silently loaded 4 of its 5 rulings would be worse than one that
 * failed, because the missing one looks exactly like a survivor nobody has examined yet.
 */
export function parseEquivalenceMarks(text: string, sourceName: string): EquivalenceMark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new EquivalenceMarksError(
      `${sourceName}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EquivalenceMarksError(
      `${sourceName}: expected an object with a "marks" array, got ${Array.isArray(raw) ? "an array" : typeof raw}`,
    );
  }
  const marksRaw = (raw as { marks?: unknown }).marks;
  if (!Array.isArray(marksRaw)) {
    throw new EquivalenceMarksError(`${sourceName}: missing required "marks" array`);
  }
  const schemeRaw = (raw as { identityScheme?: unknown }).identityScheme;
  if (schemeRaw !== undefined && !(Number.isInteger(schemeRaw) && (schemeRaw as number) >= 1)) {
    throw new EquivalenceMarksError(
      `${sourceName}: "identityScheme" must be a positive integer when present, got ${JSON.stringify(schemeRaw)}`,
    );
  }
  const identityScheme = schemeRaw === undefined ? 1 : (schemeRaw as number);
  const seen = new Set<string>();
  return marksRaw.map((entry, i) => {
    const at = `${sourceName}: marks[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new EquivalenceMarksError(`${at}: expected an object`);
    }
    const e = entry as Record<string, unknown>;
    const key = e.key;
    const reason = e.reason;
    if (typeof key !== "string" || key.trim() === "") {
      throw new EquivalenceMarksError(
        `${at}: "key" is required and must be a non-empty string. It is the R166 identity: astHash|codeunitName|procedureName|operatorName|operatorMajor`,
      );
    }
    const keyShapeError = identityKeyShapeError(key);
    if (keyShapeError !== undefined) {
      throw new EquivalenceMarksError(`${at}: "key" ${keyShapeError}. Got: ${key}`);
    }
    if (
      typeof reason !== "string" ||
      reason.trim() === "" ||
      reason.trim() === MARK_REASON_PLACEHOLDER
    ) {
      throw new EquivalenceMarksError(
        `${at}: "reason" is required and must be non-empty, and not \`lethal explain\`'s placeholder. A mark without a stated reason is an unexplained subtraction from the survivor list, and nobody can review it later.`,
      );
    }
    const markedBy = e.markedBy;
    const markedOn = e.markedOn;
    let symbols: readonly string[] | undefined;
    if (e.preprocessorSymbols !== undefined) {
      try {
        symbols = [...new Set(validateSymbolList(e.preprocessorSymbols, at))].sort();
      } catch (err) {
        throw new EquivalenceMarksError(err instanceof Error ? err.message : String(err));
      }
    }
    // R443: the proof fields, each optional and type-checked. A `fileSingleton: true` without a
    // `file` could never apply rule 2, so it is refused here rather than silently never matching.
    const file = e.file;
    if (file !== undefined && (typeof file !== "string" || file.trim() === "")) {
      throw new EquivalenceMarksError(`${at}: "file" must be a non-empty string when present`);
    }
    const numberingDigest = e.numberingDigest;
    if (
      numberingDigest !== undefined &&
      (typeof numberingDigest !== "string" || !/^[0-9a-f]{64}$/.test(numberingDigest))
    ) {
      throw new EquivalenceMarksError(
        `${at}: "numberingDigest" must be 64 lowercase hex characters (a sha256, as \`lethal explain\` prints it) when present. Got: ${JSON.stringify(numberingDigest)}`,
      );
    }
    const fileSingleton = e.fileSingleton;
    if (fileSingleton !== undefined && typeof fileSingleton !== "boolean") {
      throw new EquivalenceMarksError(`${at}: "fileSingleton" must be true or false when present`);
    }
    if (fileSingleton === true && file === undefined) {
      throw new EquivalenceMarksError(
        `${at}: "fileSingleton" is true but the mark names no "file", so it cannot be matched on its file. Copy the whole mark \`lethal explain\` prints.`,
      );
    }
    const normalFile = typeof file === "string" ? file.replaceAll("\\", "/") : undefined;
    // R214: one key can name different mutants in different builds, so a duplicate is the same key
    // under the same canonical symbol set (absent reads as []). R443: and the same file and digest,
    // since one key names different mutants under different numberings.
    const setLabel = (symbols ?? []).join(", ");
    const identity = JSON.stringify([
      key,
      symbols ?? [],
      normalFile ?? null,
      numberingDigest ?? null,
    ]);
    if (seen.has(identity)) {
      throw new EquivalenceMarksError(
        `${at}: duplicate key under preprocessor symbols [${setLabel}], file ${normalFile ?? "(none)"} and numbering digest ${numberingDigest ?? "(none)"}, already marked earlier in this file (key ${key}). Two rulings about one mutant cannot both be applied, and picking one silently is the guess this project refuses.`,
      );
    }
    seen.add(identity);
    return {
      key,
      reason: reason.trim(),
      identityScheme,
      ...(symbols !== undefined ? { preprocessorSymbols: symbols } : {}),
      ...(normalFile !== undefined ? { file: normalFile } : {}),
      ...(typeof numberingDigest === "string" ? { numberingDigest } : {}),
      ...(typeof fileSingleton === "boolean" ? { fileSingleton } : {}),
      ...(typeof markedBy === "string" && markedBy.trim() !== "" ? { markedBy } : {}),
      ...(typeof markedOn === "string" && markedOn.trim() !== "" ? { markedOn } : {}),
    };
  });
}

/**
 * R230: why `key` is not a shape `serializeKey` (selection.ts) can write, or `undefined` when it
 * is one. It writes the five-field tuple, plus `|<ordinal>` for a twin after the first (R193),
 * where the ordinal is a positive integer rendered by a template string: `1`, `2`, ... never `0`,
 * never a leading zero or sign. Accepting only that keeps a malformed key failing loudly.
 */
function identityKeyShapeError(key: string): string | undefined {
  const fields = key.split("|");
  if (fields.length === 5) return undefined;
  const expected =
    "expected 5 (astHash|codeunitName|procedureName|operatorName|operatorMajor), or 6 for a twin after the first, whose sixth field is its identityOrdinal (a positive integer)";
  if (fields.length !== 6) return `has ${fields.length} field(s), ${expected}`;
  const ordinal = fields[5] ?? "";
  if (!/^[1-9][0-9]*$/.test(ordinal)) {
    return `has a sixth field "${ordinal}" that is not a positive integer: ${expected}`;
  }
  return undefined;
}

/**
 * R325: the marks made under an identity scheme other than `identityScheme`, the one the mutants
 * they are matched against were keyed under. Every consumer of marks reads this one rule.
 */
export function marksUnderOtherScheme(
  marks: readonly EquivalenceMark[],
  identityScheme: number,
): EquivalenceMark[] {
  return marks.filter((m) => m.identityScheme !== identityScheme);
}

/** R325: the warning for `marksUnderOtherScheme`'s result, or `undefined` when it is empty. */
export function marksSchemeWarning(
  stale: readonly EquivalenceMark[],
  identityScheme: number,
): string | undefined {
  if (stale.length === 0) return undefined;
  const schemes = [...new Set(stale.map((m) => m.identityScheme))].sort((a, b) => a - b);
  return `[lethal] ${stale.length} equivalence mark(s) were made under identity scheme ${schemes.join(", ")}, and this run's mutants are keyed under identity scheme ${identityScheme}. A key can name a different mutant across schemes (an engine change can renumber ordinals), so each is reported stale and none is matched or contradicted. Re-check each mark against this run's report, then set "identityScheme": ${identityScheme} in ${EQUIVALENCE_MARKS_FILENAME} (R325).`;
}

/** R214: the marks made under a symbol set other than `buildSymbols`, the effective set of the
 *  build their mutants come from. An absent set is `[]`. */
export function marksUnderOtherSymbols(
  marks: readonly EquivalenceMark[],
  buildSymbols: readonly string[],
): EquivalenceMark[] {
  return marks.filter((m) => !sameBuildSymbols(m.preprocessorSymbols ?? [], buildSymbols));
}

/** R214: the warning for `marksUnderOtherSymbols`'s result, or `undefined` when it is empty. */
export function marksSymbolsWarning(
  stale: readonly EquivalenceMark[],
  buildSymbols: readonly string[],
): string | undefined {
  if (stale.length === 0) return undefined;
  const symbols = buildSymbols.length > 0 ? buildSymbols.join(", ") : "none";
  return `[lethal] ${stale.length} equivalence mark(s) were made under other preprocessor symbols than this build's (${symbols}). An identity key names a site within one build, so each is reported stale and none is matched or contradicted. Re-check each mark against this run's report, then set its "preprocessorSymbols" in ${EQUIVALENCE_MARKS_FILENAME} (R214).`;
}

/**
 * R443: the identity tuple a mark key names: the key without its twin ordinal. A key is the
 * five-field tuple, plus `|<ordinal>` for a twin after the first (`identityKeyShapeError`).
 */
export function markTupleOf(key: string): string {
  const fields = key.split("|");
  return fields.length === 6 ? fields.slice(0, 5).join("|") : key;
}

/**
 * Match a set of marks against this run's mutants. Pure; the caller decides what to print.
 *
 * R443: R-391's carry rule (`carryRecord`, selection.ts) applied to marks. A key holds no file and
 * twins are told apart by a run-wide ordinal, so a key alone cannot show which mutant it names.
 * - Rule 1: the mark's `numberingDigest` equals this run's. Equal digests mean the same numbered
 *   sites with the same ordinals, so the key names the same mutant: look it up by key.
 * - Rule 2: otherwise, the mark says `fileSingleton` and its (tuple, file) is not a twin site in
 *   this run: look it up by (tuple, file). No renumbering can move it onto another mutant.
 * - Otherwise the mark is REFUSED: the mutant stays a survivor, the safe direction for a reader.
 * A mark with no proof fields, and every mark when this run's facts are absent, is refused.
 */
export function applyEquivalenceMarks(
  marks: readonly EquivalenceMark[],
  mutants: readonly MarkableMutant[],
  /** R325: the identity scheme `mutants` were keyed under. A mark made under another is stale. */
  identityScheme: number,
  /** R214: the effective build symbols `mutants` come from. A mark made under another set is
   *  stale; an absent mark set is `[]`. */
  buildSymbols: readonly string[],
  /** R443: this run's numbering facts. Absent: every mark is refused (`no-run-facts`). */
  facts: RunNumberingFacts | undefined,
): EquivalenceMarkReport {
  const byIdentity = new Map<string, MarkableMutant>();
  const bySite = new Map<string, MarkableMutant>();
  for (const m of mutants) {
    byIdentity.set(m.identity, m);
    bySite.set(twinSiteOf(m.file, m.tuple), m);
  }

  const matched: MatchedMark[] = [];
  const stale: EquivalenceMark[] = [];
  const contradicted: ContradictedMark[] = [];
  const refused: RefusedMark[] = [];
  const refuse = (mark: EquivalenceMark, reason: MarkRefusalReason): void => {
    refused.push({
      key: mark.key,
      reason,
      ...(mark.file !== undefined ? { file: mark.file } : {}),
    });
  };

  for (const mark of marks) {
    if (
      mark.identityScheme !== identityScheme ||
      !sameBuildSymbols(mark.preprocessorSymbols ?? [], buildSymbols)
    ) {
      stale.push(mark);
      continue;
    }
    if (
      mark.numberingDigest === undefined &&
      mark.file === undefined &&
      mark.fileSingleton === undefined
    ) {
      refuse(mark, "no-proof");
      continue;
    }
    if (facts === undefined) {
      refuse(mark, "no-run-facts");
      continue;
    }
    let hit: MarkableMutant | undefined;
    if (mark.numberingDigest === facts.numberingDigest) {
      hit = byIdentity.get(mark.key);
    } else if (mark.fileSingleton === true && mark.file !== undefined) {
      const site = twinSiteOf(mark.file, markTupleOf(mark.key));
      if (facts.twinSites.has(site)) {
        refuse(mark, "twin-in-file");
        continue;
      }
      hit = bySite.get(site);
    } else {
      refuse(mark, "renumbered");
      continue;
    }
    if (hit === undefined) {
      stale.push(mark);
      continue;
    }
    if (SURVIVING_VERDICTS.has(hit.verdict)) {
      matched.push({
        key: hit.identity,
        reason: mark.reason,
        batchIndex: hit.batchIndex,
        mutantCode: hit.mutantCode,
      });
      continue;
    }
    contradicted.push({
      key: hit.identity,
      reason: mark.reason,
      batchIndex: hit.batchIndex,
      mutantCode: hit.mutantCode,
      verdict: hit.verdict,
    });
  }
  return { matched, stale, contradicted, refused };
}

/** The console lines for a marks result. Empty when there is nothing to say. */
export function equivalenceMarkWarnings(report: EquivalenceMarkReport): string[] {
  const lines: string[] = [];
  if (report.contradicted.length > 0) {
    lines.push(
      `EQUIVALENCE MARK CONTRADICTED: ${report.contradicted.length} mutant(s) marked as equivalent were NOT survivors in this run. A reader stated no test could distinguish them and this run says otherwise, the verdict stands and the mark is wrong. Remove or revise each:`,
    );
    for (const c of report.contradicted) {
      // R231's `<batchIndex>/<mutantCode>` (report.ts `mutantRef`; this module must not import it).
      lines.push(`  ${c.batchIndex}/${c.mutantCode} is ${c.verdict} — marked "${c.reason}"`);
    }
  }
  if (report.refused.length > 0) {
    lines.push(
      `EQUIVALENCE MARKS REFUSED: ${report.refused.length} mark(s) cannot show that their key still names the mutant they were written for, so each mutant stays a plain survivor (R443). A key holds no file, and an edit, --only, --lines or a repaired header can hand it to another twin. Re-mark each from a fresh report: \`lethal explain <report.json>\` prints every survivor's mark, with its proof fields, ready to paste:`,
    );
    for (const r of report.refused) lines.push(`  ${refusedMarkLine(r)}`);
  }
  if (report.stale.length > 0) {
    lines.push(
      `EQUIVALENCE MARKS STALE: ${report.stale.length} mark(s) matched no mutant in this run. Editing the marked code changes its identity, so its mark names nothing any more. The ruling is lost unless someone re-makes it:`,
    );
    for (const s of report.stale) lines.push(`  ${s.key}`);
  }
  if (report.matched.length > 0) {
    lines.push(
      `EQUIVALENCE MARKS: ${report.matched.length} survivor(s) carry a reader's ruling that they cannot be killed. They are STILL counted as survivors and still in the mutation score: a mark records a human's reasoning, it does not change a measurement.`,
    );
  }
  return lines;
}

/** R443: why each refusal reason refused, in words. */
const MARK_REFUSAL_WHY: Readonly<Record<MarkRefusalReason, string>> = {
  "no-proof": "no proof fields (written before R443)",
  "no-run-facts": "this run recorded no numbering facts to check it against",
  renumbered: "the numbering changed since it was made, and it does not prove a singleton",
  "twin-in-file": "this run has a twin of it in that file",
};

/** R443: one refused mark, as the run warnings and the report banner print it. */
export function refusedMarkLine(r: RefusedMark): string {
  return `${r.key}${r.file !== undefined ? ` (${r.file})` : ""}: ${r.reason}, ${MARK_REFUSAL_WHY[r.reason]}`;
}

/**
 * R172 proposal 3: load the reader's equivalence rulings for this project, if any.
 *
 * Discovery is a fixed filename beside the project rather than a CLI flag: a mark is a durable
 * property of the CODEBASE (this mutant, in this procedure, cannot be killed, and here is why), not
 * a choice a particular invocation makes. A flag would let one run apply the rulings and the next
 * one silently not, and two runs of the same project would then disagree about which survivors a
 * human had already examined.
 *
 * Absent file means absent feature, silently: that is the overwhelmingly common case and warning
 * about it every run would train people to ignore the line. A file that EXISTS and is malformed
 * throws, because a partially-loaded set of rulings is indistinguishable from survivors nobody has
 * looked at yet.
 */
export const EQUIVALENCE_MARKS_FILENAME = "lethal.equivalent.json";

export async function loadEquivalenceMarks(
  projectDir: string,
  readFileFn: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<readonly EquivalenceMark[] | undefined> {
  const path = join(projectDir, EQUIVALENCE_MARKS_FILENAME);
  let text: string;
  try {
    text = await readFileFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new Error(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}. Remove the file to run without equivalence marks; an unreadable one is not treated as an absent one.`,
    );
  }
  return parseEquivalenceMarks(text, path);
}
