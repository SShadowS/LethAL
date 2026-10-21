/**
 * R586 §11-§12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`): the pure
 * halves of `itest:alrunner-v3`, kept out of the gate script (which runs at import) so they are
 * unit-tested offline (`packages/runner/tests/r586-gate.test.ts`).
 *
 * Leg T's `held` (r4 I-3): with no live BC oracle for the tables fixture, "a move toward BC" is read
 * from the known differences alone: the rows where v3's own baseline differs from BC's
 * `tables.baseline.json` (pre-committed as the 52 of `precommitment-tables-52.txt`: 41 Commit #5607,
 * 7 duplicate key #5603, 4 TestPage). A leg-T difference is `held` only when its row is one of those
 * AND it now equals the BC row (verdict and killing test). Anything else is `gate-fail`.
 */
import { writeFile } from "node:fs/promises";
import type { NormalizedMutant } from "./mutant-equality";

export type V3LegOutcome = "pass" | "held" | "gate-fail" | "infra-fail" | "skipped";
export type V3GateOutcome = "pass" | "held" | "gate-fail" | "infra-fail";

/** The exact leg set a `pass` must hold (r3 F6 d). */
export const V3_GATE_LEGS = ["C", "S1", "S3", "N1", "X", "D1", "D1c", "T"] as const;

/** Rows by key; a key repeated (R193 twins) is not classified here, so it is refused upstream. */
function byKey(rows: readonly NormalizedMutant[]): Map<string, NormalizedMutant[]> {
  const m = new Map<string, NormalizedMutant[]>();
  for (const r of rows) m.set(r.key, [...(m.get(r.key) ?? []), r]);
  return m;
}

const sameRow = (a: NormalizedMutant | undefined, b: NormalizedMutant | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.verdict === b.verdict &&
  a.killingTest === b.killingTest &&
  a.coverageFiltered === b.coverageFiltered &&
  a.errorClass === b.errorClass;

/** The keys where v3's own baseline differs from BC's (the known differences, pre-committed at 52). */
export function knownDifferenceKeys(
  bc: readonly NormalizedMutant[],
  own: readonly NormalizedMutant[],
): Set<string> {
  const b = byKey(bc);
  const o = byKey(own);
  const keys = new Set<string>();
  for (const k of new Set([...b.keys(), ...o.keys()])) {
    const bs = b.get(k) ?? [];
    const os = o.get(k) ?? [];
    if (bs.length !== 1 || os.length !== 1 || !sameRow(bs[0], os[0])) keys.add(k);
  }
  return keys;
}

/**
 * Leg T against its own baseline: `pass` (no difference), `held` (every difference is a known row
 * moving to its BC row), else `gate-fail`. A twin group, a missing or an extra row is `gate-fail`.
 */
export function classifyLegT(
  own: readonly NormalizedMutant[],
  now: readonly NormalizedMutant[],
  bc: readonly NormalizedMutant[],
): { readonly outcome: "pass" | "held" | "gate-fail"; readonly lines: readonly string[] } {
  const known = knownDifferenceKeys(bc, own);
  const o = byKey(own);
  const n = byKey(now);
  const b = byKey(bc);
  const lines: string[] = [];
  let anyFail = false;
  let anyHeld = false;
  for (const k of new Set([...o.keys(), ...n.keys()])) {
    const os = o.get(k) ?? [];
    const ns = n.get(k) ?? [];
    if (os.length === 1 && ns.length === 1 && sameRow(os[0], ns[0])) continue;
    const toward =
      known.has(k) && os.length === 1 && ns.length === 1 && (b.get(k)?.length ?? 0) === 1 && sameRow(ns[0], b.get(k)?.[0]);
    if (toward) {
      anyHeld = true;
      lines.push(`held: ${k}: ${os[0]?.verdict} -> ${ns[0]?.verdict} (the BC verdict, a known difference)`);
    } else {
      anyFail = true;
      lines.push(
        `gate-fail: ${k}: ${os.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"} -> ${ns.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"}${known.has(k) ? " (a known row, but not to its BC verdict)" : ""}`,
      );
    }
  }
  return { outcome: anyFail ? "gate-fail" : anyHeld ? "held" : "pass", lines };
}

/** The run's outcome: `pass` only when EVERY leg of `V3_GATE_LEGS` passed. */
export function gateOutcome(legs: Readonly<Record<string, V3LegOutcome>>): V3GateOutcome {
  const vals = V3_GATE_LEGS.map((l) => legs[l] ?? "skipped");
  if (vals.includes("gate-fail")) return "gate-fail";
  if (vals.includes("infra-fail") || vals.includes("skipped")) return "infra-fail";
  if (vals.includes("held")) return "held";
  return "pass";
}

/** What the update script reads (r3 F6 a): matched by nonce AND the candidate binary's sha256. */
export interface V3GateReceipt {
  readonly nonce: string;
  readonly binarySha256: string;
  readonly version: string;
  readonly lethalCommit: string;
  readonly outcome: V3GateOutcome;
  readonly legs: Readonly<Record<string, V3LegOutcome>>;
  readonly lines: readonly string[];
  /** F8: the BC build of each leg's oracle server, beside v3's `--bc-version`. */
  readonly oracleBcBuild: Readonly<Record<string, string>>;
  readonly writtenAt: string;
}

export async function writeV3Receipt(path: string, r: V3GateReceipt): Promise<void> {
  await writeFile(path, `${JSON.stringify(r, null, 2)}\n`, "utf8");
}
