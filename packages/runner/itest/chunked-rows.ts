/**
 * R208 + R582: `itest:chunked`'s fold of a leg's `op_kind = 'many'` rows, kept out of
 * `chunked.itest.ts` (which runs its gate at import, R186) so it is unit-tested offline
 * (`tests/chunked-rows.test.ts`).
 *
 * Per mutant, in row order:
 * - a row with `mutant_code` NULL is a warm replay row (R206's confirm);
 * - a MUTATED row before the mutant's first replay row is a covering call's row;
 * - a mutated row AFTER it is the kill's re-run under the mutant (R577's rule, on for bcdev since
 *   R582). It is kept apart, in `reruns`, never counted as a covering call: otherwise the cap check
 *   and "some mutant took more than one call" could pass on re-runs alone. On this fixture the
 *   re-run is the only mutated call after the confirm (`unstable` and `warm-prefix-unstable` are
 *   refused by the gate), so the split is exact.
 */

export interface ChunkedRow {
  readonly mutant_row_id: number | null;
  readonly mutant_code: string | null;
  readonly method: string;
  readonly session_id: number | null;
}

export interface ChunkedFold {
  /** mutantCode -> the replay's method names, in recorded order (absent when none ran). */
  readonly replays: ReadonlyMap<string, readonly string[]>;
  /** mutantCode -> how many methods each covering call ran, in call order. */
  readonly callSizes: ReadonlyMap<string, readonly number[]>;
  /** mutantCode -> the warm re-run's method names, in recorded order (absent when none ran). */
  readonly reruns: ReadonlyMap<string, readonly string[]>;
}

export function foldChunkedRows(
  rows: readonly ChunkedRow[],
  codeOf: ReadonlyMap<number, string>,
): ChunkedFold {
  const replays = new Map<string, string[]>();
  const callSizes = new Map<string, number[]>();
  const reruns = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, method: string) => {
    const list = map.get(key) ?? [];
    list.push(method);
    map.set(key, list);
  };
  let lastSession: number | null = null;
  let lastCode: string | null = null;
  for (const r of rows) {
    const owner = r.mutant_row_id === null ? undefined : codeOf.get(r.mutant_row_id);
    if (owner === undefined) continue;
    if (r.mutant_code === null) {
      // A replay row: `mutantCode` null, still attributed to the mutant it confirms.
      push(replays, owner, r.method);
    } else if (replays.has(owner)) {
      push(reruns, owner, r.method);
    } else {
      // A covering row. One call is one session, so a change of session id starts a new call.
      const sizes = callSizes.get(owner) ?? [];
      if (r.session_id !== lastSession || owner !== lastCode || sizes.length === 0) {
        sizes.push(0);
      }
      sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + 1;
      callSizes.set(owner, sizes);
      lastSession = r.session_id;
      lastCode = owner;
    }
  }
  return { replays, callSizes, reruns };
}

/**
 * R582 (F2): each warm kill's re-run must replay EXACTLY its replay list (the chunk's prefix), the
 * same methods in the same order. Without it a re-run over `ordered`'s prefix would pass every
 * other check. `[]` when it holds.
 */
export function rerunMismatches(
  warm: readonly { readonly code: string; readonly replay: readonly string[] }[],
  fold: Pick<ChunkedFold, "reruns">,
): string[] {
  const out: string[] = [];
  for (const w of warm) {
    const got = fold.reruns.get(w.code) ?? [];
    if (got.length !== w.replay.length || got.some((m, i) => m !== w.replay[i])) {
      out.push(
        `chunked: ${w.code}'s re-run under the mutant ran ${JSON.stringify(got)}, expected exactly its replay list ${JSON.stringify(w.replay)} (R582: the re-run replays the CHUNK's prefix)`,
      );
    }
  }
  return out;
}
