import type { MutantVerdict } from "./store";

/** One recorded mutant row, reduced to what grouping by gap needs (C02-09). */
export interface GapRow {
  readonly mutantCode: string;
  readonly verdict: MutantVerdict;
  readonly gapId: string;
  readonly batchIndex: number;
  readonly line: number;
}

export interface GapTally {
  readonly gapId: string;
  readonly batchIndex: number;
  /** mutantCodes of the `survived` rows, ordered by line then mutantCode. */
  readonly members: readonly string[];
  /** mutantCodes of the `no-coverage` rows, same order. Never gap members (owner, Q2). */
  readonly noCoverageMembers: readonly string[];
  readonly survived: number;
  readonly killed: number;
  readonly noCoverage: number;
  readonly other: number;
  /** Every recorded row survived. The caller withholds it on a narrowed run. */
  readonly unobservedBlock: boolean;
}

/** A gap id whose rows sit in two batches. Batches split per file, so this is a broken input. */
export class GapGroupingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GapGroupingError";
  }
}

interface Acc {
  batchIndex: number;
  members: GapRow[];
  noCoverageMembers: GapRow[];
  survived: number;
  killed: number;
  noCoverage: number;
  other: number;
}

const byLineThenCode = (a: GapRow, b: GapRow): number =>
  a.line - b.line || (a.mutantCode < b.mutantCode ? -1 : a.mutantCode > b.mutantCode ? 1 : 0);

/** Every gap id among `rows`, with or without survivors. Throws GapGroupingError when one gap id
 *  spans two batches. The one grouping rule `explain` and `verify` share. */
export function tallyGaps(rows: readonly GapRow[]): ReadonlyMap<string, GapTally> {
  const accs = new Map<string, Acc>();
  for (const r of rows) {
    let acc = accs.get(r.gapId);
    if (acc === undefined) {
      acc = {
        batchIndex: r.batchIndex,
        members: [],
        noCoverageMembers: [],
        survived: 0,
        killed: 0,
        noCoverage: 0,
        other: 0,
      };
      accs.set(r.gapId, acc);
    } else if (acc.batchIndex !== r.batchIndex) {
      throw new GapGroupingError(
        `gap ${r.gapId} spans two batches (${acc.batchIndex} and ${r.batchIndex}); batches split per file, so one block cannot`,
      );
    }
    switch (r.verdict) {
      case "survived":
        acc.survived++;
        acc.members.push(r);
        break;
      case "killed":
      case "timeout-killed":
        acc.killed++;
        break;
      case "no-coverage":
        acc.noCoverage++;
        acc.noCoverageMembers.push(r);
        break;
      case "error":
      case "known-survivor":
        acc.other++;
        break;
      default: {
        const unknown: never = r.verdict;
        throw new GapGroupingError(
          `mutant ${r.mutantCode} has an unknown verdict ${String(unknown)}`,
        );
      }
    }
  }
  const out = new Map<string, GapTally>();
  for (const [gapId, a] of accs) {
    out.set(gapId, {
      gapId,
      batchIndex: a.batchIndex,
      members: a.members.sort(byLineThenCode).map((r) => r.mutantCode),
      noCoverageMembers: a.noCoverageMembers.sort(byLineThenCode).map((r) => r.mutantCode),
      survived: a.survived,
      killed: a.killed,
      noCoverage: a.noCoverage,
      other: a.other,
      unobservedBlock: a.killed === 0 && a.noCoverage === 0 && a.other === 0,
    });
  }
  return out;
}
