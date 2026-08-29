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
 *   That is the SAFE direction (a mark can never drift onto a different mutant), but it must be
 *   reported: a ruling that silently evaporated is a ruling nobody knows they lost.
 * - **contradicted** — the mark names a mutant that this run KILLED. Someone stated that no test
 *   could distinguish this mutant, and a test just did. **That is a decidable check on a human
 *   claim, and it is the only part of this feature that can prove anything.** It is reported
 *   loudly, and the kill stands: the verdict is the measurement and the mark is the opinion.
 */

/** One reader's ruling about one mutant, as it appears in the marks file. */
export interface EquivalenceMark {
  /**
   * [[R166]]'s serialized identity — `astHash|codeunitName|procedureName|operatorName|operatorMajor`.
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
}

/** The minimum a caller must know about a mutant to match marks against it. Deliberately
 *  structural: this module must not import the report, because the report imports this. */
export interface MarkableMutant {
  readonly mutantCode: string;
  /** `serializeKey(identityKeyOf(...))` for this mutant. */
  readonly identity: string;
  readonly verdict: string;
}

export interface MatchedMark {
  readonly key: string;
  readonly reason: string;
  readonly mutantCode: string;
}

export interface ContradictedMark {
  readonly key: string;
  readonly reason: string;
  readonly mutantCode: string;
  /** The verdict that contradicts the mark — a kill, or anything else that is not a survival. */
  readonly verdict: string;
}

export interface EquivalenceMarkReport {
  readonly matched: readonly MatchedMark[];
  readonly stale: readonly EquivalenceMark[];
  readonly contradicted: readonly ContradictedMark[];
}

/** Verdicts that are consistent with a mutant nothing can kill. `known-survivor` counts: it is a
 *  survival carried from a prior run, not a fresh contradiction of the mark. */
const SURVIVING_VERDICTS: ReadonlySet<string> = new Set(["survived", "known-survivor"]);

export class EquivalenceMarksError extends Error {}

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
    if (key.split("|").length !== 5) {
      throw new EquivalenceMarksError(
        `${at}: "key" has ${key.split("|").length} field(s), expected 5 ` +
          `(astHash|codeunitName|procedureName|operatorName|operatorMajor). Got: ${key}`,
      );
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new EquivalenceMarksError(
        `${at}: "reason" is required and must be non-empty. A mark without a stated reason is an unexplained subtraction from the survivor list, and nobody can review it later.`,
      );
    }
    if (seen.has(key)) {
      throw new EquivalenceMarksError(
        `${at}: duplicate key, already marked earlier in this file. Two rulings about one mutant cannot both be applied, and picking one silently is the guess this project refuses.`,
      );
    }
    seen.add(key);
    const markedBy = e.markedBy;
    const markedOn = e.markedOn;
    return {
      key,
      reason: reason.trim(),
      ...(typeof markedBy === "string" && markedBy.trim() !== "" ? { markedBy } : {}),
      ...(typeof markedOn === "string" && markedOn.trim() !== "" ? { markedOn } : {}),
    };
  });
}

/** Match a set of marks against this run's mutants. Pure; the caller decides what to print. */
export function applyEquivalenceMarks(
  marks: readonly EquivalenceMark[],
  mutants: readonly MarkableMutant[],
): EquivalenceMarkReport {
  const byIdentity = new Map<string, MarkableMutant>();
  for (const m of mutants) byIdentity.set(m.identity, m);

  const matched: MatchedMark[] = [];
  const stale: EquivalenceMark[] = [];
  const contradicted: ContradictedMark[] = [];

  for (const mark of marks) {
    const hit = byIdentity.get(mark.key);
    if (hit === undefined) {
      stale.push(mark);
      continue;
    }
    if (SURVIVING_VERDICTS.has(hit.verdict)) {
      matched.push({ key: mark.key, reason: mark.reason, mutantCode: hit.mutantCode });
      continue;
    }
    contradicted.push({
      key: mark.key,
      reason: mark.reason,
      mutantCode: hit.mutantCode,
      verdict: hit.verdict,
    });
  }
  return { matched, stale, contradicted };
}

/** The console lines for a marks result. Empty when there is nothing to say. */
export function equivalenceMarkWarnings(report: EquivalenceMarkReport): string[] {
  const lines: string[] = [];
  if (report.contradicted.length > 0) {
    lines.push(
      `EQUIVALENCE MARK CONTRADICTED: ${report.contradicted.length} mutant(s) marked as equivalent were NOT survivors in this run. A reader stated no test could distinguish them and this run says otherwise, the verdict stands and the mark is wrong. Remove or revise each:`,
    );
    for (const c of report.contradicted) {
      lines.push(`  ${c.mutantCode} is ${c.verdict} — marked "${c.reason}"`);
    }
  }
  if (report.stale.length > 0) {
    lines.push(
      `EQUIVALENCE MARKS STALE: ${report.stale.length} mark(s) matched no mutant in this run. The identity includes the mutated subtree's hash, so editing that code retires its mark, which is the safe direction, but the ruling is now lost unless someone re-makes it:`,
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
