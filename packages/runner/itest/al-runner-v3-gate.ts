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

/**
 * The D legs' corpus, bound by content, not path (lane ruling 2026-10-21; R187): Continia Document
 * Output at 5f2a71d, a clean checkout, corpus fingerprint aa47c61c1fcbb7e3
 * (`scripts/corpus-fingerprint.ts` over the checkout root), as R594's oracle was measured.
 */
export const CDO_COMMIT = "5f2a71d";
export const CDO_FINGERPRINT = "aa47c61c1fcbb7e3";

/** `undefined` when the checkout is the pre-committed one; otherwise the named refusal. */
export function cdoCheckoutRefusal(c: {
  readonly head: string;
  readonly porcelain: string;
  readonly fingerprint: string;
}): string | undefined {
  const tag = "al-runner-v3-cdo-checkout-refused";
  const head = c.head.trim();
  if (!head.startsWith(CDO_COMMIT)) return `${tag}: HEAD ${head}, pre-committed ${CDO_COMMIT}`;
  if (c.porcelain.trim() !== "")
    return `${tag}: not clean (${c.porcelain.trim().split("\n").length} changed path(s))`;
  const fp = c.fingerprint.slice(0, 16);
  if (fp !== CDO_FINGERPRINT)
    return `${tag}: corpus fingerprint ${fp}, pre-committed ${CDO_FINGERPRINT}`;
  return undefined;
}

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
      known.has(k) &&
      os.length === 1 &&
      ns.length === 1 &&
      (b.get(k)?.length ?? 0) === 1 &&
      sameRow(ns[0], b.get(k)?.[0]);
    if (toward) {
      anyHeld = true;
      lines.push(
        `held: ${k}: ${os[0]?.verdict} -> ${ns[0]?.verdict} (the BC verdict, a known difference)`,
      );
    } else {
      anyFail = true;
      lines.push(
        `gate-fail: ${k}: ${os.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"} -> ${ns.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"}${known.has(k) ? " (a known row, but not to its BC verdict)" : ""}`,
      );
    }
  }
  return { outcome: anyFail ? "gate-fail" : anyHeld ? "held" : "pass", lines };
}

/**
 * M5: the BC-vs-own differences must be exactly `pinned`, by key AND by transition (BC verdict and
 * killing test -> own verdict and killing test). Returns the refusal, or `undefined`.
 */
export function knownDifferencesRefusal(
  bc: readonly NormalizedMutant[],
  own: readonly NormalizedMutant[],
  pinned: ReadonlyArray<readonly [string, string, string, string | null, string | null]>,
): string | undefined {
  const b = byKey(bc);
  const o = byKey(own);
  const measured = new Map<string, string>();
  for (const k of knownDifferenceKeys(bc, own)) {
    const bs = b.get(k) ?? [];
    const os = o.get(k) ?? [];
    measured.set(
      k,
      `${bs.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"} -> ${os.map((r) => `${r.verdict}/${r.killingTest}`).join(",") || "absent"}`,
    );
  }
  const want = new Map(pinned.map(([k, bv, ov, bk, ok]) => [k, `${bv}/${bk} -> ${ov}/${ok}`]));
  const bad: string[] = [];
  for (const [k, t] of measured)
    if (want.get(k) !== t) bad.push(`${k}: ${t}${want.has(k) ? ` (pinned ${want.get(k)})` : " (not pinned)"}`);
  for (const [k, t] of want) if (!measured.has(k)) bad.push(`${k}: pinned ${t}, not measured`);
  return bad.length === 0
    ? undefined
    : `the BC-vs-own differences are not the pinned ${want.size}: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`;
}

/**
 * RC-2 (I-2): leg C's verdict. A contract fact must read `matches` and a defect fact (`defects`)
 * `defect-present`. A defect fact reading `gone` (upstream fixed it) is `held`, for the orchestrator
 * to re-pre-commit, never a blacklisting. Any `diverged`, or another fact count, is `gate-fail`. An
 * `unmeasurable` fact is `infra-fail`. Precedence: gate-fail, infra-fail, held, pass.
 */
export function classifyLegC(
  facts: ReadonlyArray<{ readonly fact: string; readonly verdict: string }>,
  defects: readonly string[],
  count: number,
): { readonly outcome: "pass" | "held" | "gate-fail" | "infra-fail"; readonly lines: string[] } {
  const lines: string[] = [];
  let fail = facts.length !== count;
  if (fail) lines.push(`gate-fail: ${facts.length} facts, pre-committed ${count}`);
  let infra = false;
  let held = false;
  for (const f of facts) {
    const want = defects.includes(f.fact) ? "defect-present" : "matches";
    if (f.verdict === want) continue;
    if (f.verdict === "unmeasurable") {
      infra = true;
      lines.push(`infra-fail: ${f.fact}: unmeasurable`);
    } else if (want === "defect-present" && f.verdict === "gone") {
      held = true;
      lines.push(`held: ${f.fact}: defect-present -> gone (an upstream fix; re-pre-commit)`);
    } else {
      fail = true;
      lines.push(`gate-fail: ${f.fact}: ${f.verdict}, pre-committed ${want}`);
    }
  }
  return {
    outcome: fail ? "gate-fail" : infra ? "infra-fail" : held ? "held" : "pass",
    lines,
  };
}

/**
 * RC-2 (I-2): X (b), v3 alone on the broken target. As measured (#5602): exit 7, 1 pass, 1 not
 * run. v3 now refusing it (a non-zero exit with nothing passed) is #5602's fix, a move toward BC:
 * `held`. Anything else is `gate-fail`.
 */
export function classifyXb(r: {
  readonly exitCode: number;
  readonly passed: number;
  readonly notRun: number;
}): "pass" | "held" | "gate-fail" {
  if (r.exitCode === 7 && r.passed === 1 && r.notRun === 1) return "pass";
  if (r.exitCode !== 0 && r.passed === 0) return "held";
  return "gate-fail";
}

/** A pre-committed figure differs: `gate-fail`. Extends `Error` directly. */
export class V3LegFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V3LegFailure";
  }
}

/** M2: the environment, not the build (a checkout, a setup, a variable): `infra-fail`. */
export class V3LegEnvironment extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V3LegEnvironment";
  }
}

/** I-2: every difference is a move toward BC: `held`. */
export class V3LegHeld extends Error {
  readonly lines: readonly string[];
  constructor(lines: readonly string[]) {
    super(`held: ${lines.join("; ")}`);
    this.name = "V3LegHeld";
    this.lines = lines;
  }
}

/** M2: a leg's outcome from its error, by TYPE only. Anything untyped is `infra-fail`. */
export function legOutcomeOfError(err: unknown): V3LegOutcome {
  if (err instanceof V3LegHeld) return "held";
  if (err instanceof V3LegFailure) return "gate-fail";
  return "infra-fail";
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
