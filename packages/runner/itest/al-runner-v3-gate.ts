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
import { AlRunnerV3CoverageJoinError } from "../src/al-runner-v3-sleep";
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

/**
 * M14: the corpus fingerprint excludes `.dependencies`, where the slice's target lives, and
 * `Test/.alpackages` (the D legs' `<deps>`, gitignored) is bound by nothing else. Both are pinned
 * by sha256, measured 2026-10-21 on `/work/lethal-wt/cdo-r396` (the R594 measurement checkout).
 */
export const CDO_SLICE_FILE = "Cloud/.dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al";
export const CDO_SLICE_SHA256 = "b3f4de48fe5fa1cb022a07a41e04495062881f2aabf09aed742e55450be6fbd4";
export const CDO_ALPACKAGES: ReadonlyArray<readonly [string, string]> = [
  [
    "Continia Software_Continia Connector App_28.5.0.336834.app",
    "82487ec6ad0f2e5b105aecdd4b09060898e69f49a7cc6ada06d88664fd8b3966",
  ],
  [
    "Continia Software_Continia Core Internal Activation App_28.0.0.218906.app",
    "c57fb082a313d61c8e7b1b6811c9e220dd54af9916e7d9999ad5ea270f60d3b8",
  ],
  [
    "Continia Software_Continia Core_28.5.0.336883.app",
    "8b09259ac3d5d7fb407c4aa64e4df2311293879b6cffa37abea414eaebafa52d",
  ],
  [
    "Continia Software_Continia Delivery Network_28.5.0.336910.app",
    "922e59ea6d22746714a032fe548d9dd8520757f6f6d5c560f1c1b5622f34cf6f",
  ],
  [
    "Continia Software_Continia System Application_28.5.0.336834.app",
    "5eee39f7f79dd7242e632c9bb3a8872870105618ac997f95fc2990ea6a0af7d4",
  ],
  [
    "Microsoft_Any_28.4.53241.53758.app",
    "e08ef542779c8758a6c1780bc25cb804ae833d6967c77fc430b25d2729b2fe22",
  ],
  [
    "Microsoft_Application Test Library_28.4.53241.53758.app",
    "cd619b16b502051041123a62f5c70629b98012f609328f2f1ff217f97b89ca6c",
  ],
  [
    "Microsoft_Application_28.4.53241.53758.app",
    "6e80099c53b4395f0fe22c62dd03ae8acd0daea9c055160047efa43b43261470",
  ],
  [
    "Microsoft_Base Application_28.4.53241.53758.app",
    "6859ff17baadb5d013927bf8eca849b8f60ca2d29fc8e7e75c4236d8a02817fd",
  ],
  [
    "Microsoft_Business Foundation_28.4.53241.53758.app",
    "a5c6ad808ea9a7b5360e80605e459ffadd0d9c52b4b27c5e393abe1fc0ab9ad1",
  ],
  [
    "Microsoft_Library Assert_28.4.53241.53758.app",
    "a6fe0dc8a0bedcf187752f47e049a5e15ec10dac5e543bbec8d1e278f10f6f43",
  ],
  [
    "Microsoft_Permissions Mock_28.4.53241.53758.app",
    "40bc1261bb8edbdaa48818ce358634d3807199febb409c4d8a048c5f93e7585b",
  ],
  [
    "Microsoft_System Application Test Library_28.4.53241.53758.app",
    "34b73dfd9e534cc3e73e53ee44af7e7bc4a4b3b3faa012554606543f8c096bed",
  ],
  [
    "Microsoft_System Application_28.4.53241.53758.app",
    "a12a1cf3436d77938a5f6b15e8164a30a254bb268b762061be0da7e801ef3ec1",
  ],
  [
    "Microsoft_System_28.0.53667.0.app",
    "ffa9cff0c111f5f469a5cb3dbe8e8bd22952c2c94281372c566458f09d8fb99c",
  ],
  [
    "Microsoft_Test Runner_28.4.53241.53758.app",
    "0304659173ce0dcbc95792815a61a97a5dc1c31382f1059ef8daeb6ed2bcf29c",
  ],
  [
    "Microsoft_Tests-TestLibraries_28.4.53241.53758.app",
    "4a928583106125a80db7bf48ccd23df4665b2806412e054b28313c6a6a838d9b",
  ],
];

/**
 * `undefined` when the checkout is the pre-committed one; otherwise the named refusal. The
 * `alpackages` listing is compared as a whole set, so an empty or partial listing never matches.
 */
export function cdoCheckoutRefusal(c: {
  readonly head: string;
  readonly porcelain: string;
  readonly fingerprint: string;
  readonly sliceSha256: string;
  readonly alpackages: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
}): string | undefined {
  const tag = "al-runner-v3-cdo-checkout-refused";
  const head = c.head.trim();
  if (!head.startsWith(CDO_COMMIT)) return `${tag}: HEAD ${head}, pre-committed ${CDO_COMMIT}`;
  if (c.porcelain.trim() !== "")
    return `${tag}: not clean (${c.porcelain.trim().split("\n").length} changed path(s))`;
  const fp = c.fingerprint.slice(0, 16);
  if (fp !== CDO_FINGERPRINT)
    return `${tag}: corpus fingerprint ${fp}, pre-committed ${CDO_FINGERPRINT}`;
  if (c.sliceSha256 !== CDO_SLICE_SHA256)
    return `${tag}: the slice's mutated file ${CDO_SLICE_FILE} has sha256 ${c.sliceSha256}, pre-committed ${CDO_SLICE_SHA256}`;
  const got = [...c.alpackages].map((a) => `${a.name} ${a.sha256}`).sort();
  const want = CDO_ALPACKAGES.map(([n, s]) => `${n} ${s}`).sort();
  if (got.join("\n") !== want.join("\n")) {
    const missing = want.filter((w) => !got.includes(w)).length;
    const extra = got.filter((g) => !want.includes(g)).length;
    return `${tag}: Test/.alpackages is not the pinned ${want.length} apps (${got.length} found, ${missing} pinned missing or changed, ${extra} not pinned)`;
  }
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
    if (want.get(k) !== t)
      bad.push(`${k}: ${t}${want.has(k) ? ` (pinned ${want.get(k)})` : " (not pinned)"}`);
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
 * RC-2 (I-2), as narrowed by F3: X (b), v3 alone on the broken target. As measured (#5602): exit 7,
 * 1 pass, 1 not run. `held` (#5602's fix, a move toward BC) ONLY for the parsed compile-refusal
 * shape: a positive exit code, a document that parsed, nothing passed, and the compile diagnostic
 * (AL0118, or a non-empty `compilationErrors`) reported. A panic or other code without the
 * diagnostic, a signal (no exit code), or unparseable output is `gate-fail`.
 */
export function classifyXb(r: {
  readonly exitCode: number;
  readonly passed: number;
  readonly notRun: number;
  /** The `--output-json` document parsed. */
  readonly parsed: boolean;
  /** The output names the broken target's compile diagnostic (AL0118 / `compilationErrors`). */
  readonly compileError: boolean;
}): "pass" | "held" | "gate-fail" {
  if (r.exitCode === 7 && r.passed === 1 && r.notRun === 1) return "pass";
  if (r.exitCode > 0 && r.parsed && r.compileError && r.passed === 0) return "held";
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

/**
 * M2: a leg's outcome from its error, by TYPE only. Anything untyped is `infra-fail`. F4: inside
 * the update gate, `AlRunnerV3CoverageJoinError` is a real v3 behaviour change (the form of its
 * coverage paths moved), so it is `gate-fail`, kept under `failed/<tag>@<commit>`; in a user
 * session it stays a plain refusal.
 */
export function legOutcomeOfError(err: unknown): V3LegOutcome {
  if (err instanceof V3LegHeld) return "held";
  if (err instanceof V3LegFailure) return "gate-fail";
  if (err instanceof AlRunnerV3CoverageJoinError) return "gate-fail";
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
  /** F5: the gate worktree had tracked changes (a rewritten lockfile, an edited file). */
  readonly dirty: boolean;
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
