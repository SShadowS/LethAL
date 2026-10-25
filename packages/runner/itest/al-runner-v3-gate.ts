/**
 * R586 §11-§12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`): the pure
 * halves of `itest:alrunner-v3`, kept out of the gate script (which runs at import) so they are
 * unit-tested offline (`packages/runner/tests/r586-gate.test.ts`).
 *
 * Leg T's `held` (r4 I-3): with no live BC oracle for the tables fixture, "a move toward BC" is read
 * from the known differences alone: the rows where v3's own baseline differs from BC's
 * `tables.baseline.json` (pre-committed as the 52 of `precommitment-tables-52.txt`: 41 Commit #5607,
 * 7 duplicate key #5603, 4 TestPage). A leg-T difference is `held` only when its row is one of those
 * AND it now equals the BC row (verdict and killing test). r9 §7 (R639) adds one narrow case: a
 * known row whose verdict disagreed with BC's, now `error` through a named refusal
 * (`runner-refused`, no killing test). Anything else is `gate-fail`.
 */
import { writeFile } from "node:fs/promises";
import { AlRunnerCoverageFrameError } from "../src/al-runner-coverage";
import type { V3EntriesStats } from "../src/al-runner-v3-backend";
import { applyTPin, pinnedFactMatches } from "../src/al-runner-v3-pins";
import type { V3BuildPin, XbPin } from "../src/al-runner-v3-pins";
import { AlRunnerV3CoverageJoinError } from "../src/al-runner-v3-sleep";
import { GateWarningsMismatchError } from "./gate-warnings";
import { bareHashRows, compareMutants } from "./mutant-equality";
import type { MutantComparison, NormalizedMutant } from "./mutant-equality";

/** R654 S2: `"skipped (candidate build)"` is K's value on a candidate (`V3_K_CANDIDATE_SKIP` in
 *  `alrunner-v3-legs.ts`); K is outside `V3_GATE_LEGS`, so `gateOutcome` never reads it. */
export type V3LegOutcome =
  | "pass"
  | "held"
  | "gate-fail"
  | "infra-fail"
  | "skipped"
  | "skipped (candidate build)";
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

/** The exact leg set a `pass` must hold (r3 F6 d). R654 S2 adds L1, Y-A and Y-B (a candidate is
 *  judged on layout and symbol sets too); K is outside it by ruling (`alrunner-v3-legs.ts`).
 *  R602 (orchestrator ruling 2026-10-24) adds MO and WR: they are the only measurement of v3's
 *  per-object frame, so a pin that breaks it must not move `current`.
 *  R722 adds N1E (N1 under serve-entries): a build that fixes #5798 reads `held`; alpha.2, which has
 *  no serve-entries path, reads `pass` (not applicable, `V3_NO_SERVE_ENTRIES`). */
export const V3_GATE_LEGS = [
  "C",
  "S1",
  "S1E",
  "S3",
  "N1",
  "N1E",
  "X",
  "L1",
  "Y-A",
  "Y-B",
  "MO",
  "WR",
  "D1",
  "D1c",
  "T",
] as const;

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

/** r10 (b): one row of leg T that differs from v3's own baseline. `own`/`now` absent: no row. */
export interface LegTRow {
  readonly key: string;
  readonly kind: "held-bc" | "held-refusal" | "gate-fail";
  /** One of the pinned 52 (a known BC-vs-own difference): picks the gate-fail reason text. */
  readonly known: boolean;
  readonly own: NormalizedMutant | undefined;
  readonly now: NormalizedMutant | undefined;
}

/**
 * Leg T against its own baseline: `pass` (no difference), `held` (every difference is a known row
 * moving to its BC row), else `gate-fail`. A twin group, a missing or an extra row is `gate-fail`.
 */
export function classifyLegT(
  own: readonly NormalizedMutant[],
  now: readonly NormalizedMutant[],
  bc: readonly NormalizedMutant[],
): { readonly outcome: "pass" | "held" | "gate-fail"; readonly rows: readonly LegTRow[] } {
  const known = knownDifferenceKeys(bc, own);
  const o = byKey(own);
  const n = byKey(now);
  const b = byKey(bc);
  const rows: LegTRow[] = [];
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
    // r9 §7 (R639): a known row whose VERDICT disagreed with BC's, now a named refusal (v3 notRun,
    // or LethAL §6, which cannot fire on leg T: its Sleep index is pre-committed at 0 + 0).
    const bk = b.get(k);
    const refusal =
      known.has(k) &&
      os.length === 1 &&
      ns.length === 1 &&
      bk?.length === 1 &&
      os[0]?.verdict !== bk[0]?.verdict &&
      ns[0]?.verdict === "error" &&
      ns[0].errorClass === "runner-refused" &&
      ns[0].killingTest === null;
    const kind = toward ? "held-bc" : refusal ? "held-refusal" : "gate-fail";
    if (kind === "gate-fail") anyFail = true;
    else anyHeld = true;
    // M3: keys carry the R193 ordinal, so a side holds at most one row per key; a repeated key
    // (not expected) still reads gate-fail above and shows its first row.
    rows.push({ key: k, kind, known: known.has(k), own: os[0], now: ns[0] });
  }
  return { outcome: anyFail ? "gate-fail" : anyHeld ? "held" : "pass", rows };
}

const LEG_T_REASON = {
  "held-bc": "the BC verdict, a known difference",
  "held-refusal": "a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit",
  "gate-fail": "a known row, but not to its BC verdict",
} as const;

const rowSide = (m: NormalizedMutant | undefined): string =>
  m === undefined ? "absent" : `${m.verdict}/${m.errorClass ?? "-"}/${m.killingTest ?? "-"}`;

/** r10 (b): `T: <held|gate-fail>: <mutantCode> <key>: <old> -> <new> (<reason>)`. */
export function formatLegTRow(row: LegTRow, mutantCode: string | undefined): string {
  const reason = row.kind !== "gate-fail" || row.known ? ` (${LEG_T_REASON[row.kind]})` : "";
  return `T: ${row.kind === "gate-fail" ? "gate-fail" : "held"}: ${mutantCode ?? "-"} ${row.key}: ${rowSide(row.own)} -> ${rowSide(row.now)}${reason}`;
}

/** The key `compareMutants` names in a difference (`mutant <key>: …` or `mutant <key> [occurrence …`). */
function differenceKey(d: string, keys: ReadonlySet<string>): string | undefined {
  for (const k of keys)
    if (d.startsWith(`mutant ${k}: `) || d.startsWith(`mutant ${k} [occurrence `)) return k;
  return undefined;
}

/**
 * r10 (a): leg T's judgement, pure. Step 0 (always): every classification row and every compare
 * difference that is not a row become `lines`, one receipt line each. Then, first failure wins:
 * 1. Sleep index 0 + 0; 2. `unsupportedTests` 3; 3. the pinned 52 (`knownRefusal`); 4. the
 * classification: `gate-fail`; `held` only past R556's bare-hash refusal (R650) and when the compare's differing keys EQUAL the held keys
 * (no count check, I2); `pass` only with 0 compare differences, then 290 / 57 / 59 over 406. The
 * caller's `assertGateBaseline` compare follows a `pass`.
 */
type LegTJudgement = {
  readonly outcome: "pass" | "held" | "gate-fail";
  readonly lines: readonly string[];
  readonly failure?: string;
  /** R586c: true only when the pin made this a pass (the caller skips the alpha.2 baseline compare). */
  readonly pinned?: true;
  /** Rows and compare agreed; only the figures (counts, total) differ: a real difference. */
  readonly countMismatch?: true;
};

/** R586c: what leg T needs of a build pin: its rows and counts, the BC rows and the identity scheme. */
export interface LegTPinInput {
  readonly id: string;
  readonly legT: V3BuildPin["legT"];
  readonly bc: readonly NormalizedMutant[];
  readonly sameScheme: boolean;
}

const WORSENESS = { pass: 0, held: 1, "gate-fail": 2 } as const;

/**
 * R586c (B1): leg T's judgement, pinned. The pinned run (own rows with the pinned keys overridden,
 * the pin's counts) must be a `pass`; then the result is a pinned pass. Anything else returns the
 * WORSE of today's judgement and `held`, plus one `T: pin-mismatch:` line, so alpha.2's old value
 * (all seven `survived`) is never a pass on a pinned build.
 */
function judgeLegTPinned(i: LegTInput, pin: LegTPinInput): LegTJudgement {
  const today = judgeLegTCore(i, { killed: 290, survived: 57, noCoverage: 59, total: 406 });
  const mismatch = (reason: string): LegTJudgement => ({
    outcome: WORSENESS[today.outcome] >= WORSENESS.held ? today.outcome : "held",
    lines: [...today.lines, `T: pin-mismatch: ${reason}`],
    ...(today.failure !== undefined ? { failure: today.failure } : {}),
  });
  const ownPinned = applyTPin(i.own, pin.legT);
  if (ownPinned === undefined)
    return mismatch(
      "a pinned key is absent, repeated, or not survived/-/- in the committed baseline",
    );
  const run = judgeLegTCore(
    {
      ...i,
      own: ownPinned,
      classification: classifyLegT(ownPinned, i.now, pin.bc),
      compare: compareMutants(ownPinned, i.now, { sameScheme: pin.sameScheme }),
    },
    { ...pin.legT.counts, total: pin.legT.total },
  );
  // The rows are exactly the pinned ones but the figures are not: a real difference, not a pin miss.
  if (run.countMismatch === true)
    return {
      outcome: "gate-fail",
      lines: [...today.lines, ...run.lines],
      failure: run.failure ?? "T: counts",
    };
  if (run.outcome !== "pass")
    return mismatch(run.failure ?? `the pinned compare is ${run.outcome}: ${run.lines[0] ?? "-"}`);
  const bare = bareHashRows(ownPinned, i.now);
  if (bare.length > 0)
    return mismatch(
      `${bare.length} mutant(s) of this run have no mutated-text hash (R556), first ${bare[0]?.key}`,
    );
  return {
    outcome: "pass",
    lines: [`T: pinned ${pin.legT.rows.length} rows (pin ${pin.id}, #5788)`],
    pinned: true,
  };
}

/** `judgeLegTCore` (r10 (a), above) with an optional build pin (R586c); no pin: exactly as before. */
export function judgeLegT(i: LegTInput & { readonly pin?: LegTPinInput }): LegTJudgement {
  const { pin, ...rest } = i;
  if (pin === undefined) return judgeLegTCore(rest);
  return judgeLegTPinned(rest, pin);
}

interface LegTInput {
  readonly classification: ReturnType<typeof classifyLegT>;
  readonly compare: MutantComparison;
  /** The own baseline's rows and this run's, for R556's bare-hash refusal on `held` (R650). */
  readonly own: readonly NormalizedMutant[];
  readonly now: readonly NormalizedMutant[];
  readonly counts: {
    readonly killed: number;
    readonly survived: number;
    readonly noCoverage: number;
  };
  readonly total: number;
  readonly unsupportedTests: number;
  readonly sleepIndex: { readonly target: number; readonly test: number } | undefined;
  readonly knownRefusal: string | undefined;
  /** Key -> the session report's mutant code. */
  readonly codes: ReadonlyMap<string, string>;
}

function judgeLegTCore(
  i: LegTInput,
  want: {
    readonly killed: number;
    readonly survived: number;
    readonly noCoverage: number;
    readonly total: number;
  } = { killed: 290, survived: 57, noCoverage: 59, total: 406 },
): LegTJudgement {
  const { rows } = i.classification;
  const lines = rows.map((r) => formatLegTRow(r, i.codes.get(r.key)));
  const rowKeys = new Set(rows.map((r) => r.key));
  const allKeys = new Set([...rowKeys, ...i.codes.keys()]);
  const diffKeys = new Set<string>();
  for (const d of i.compare.differences) {
    const k = differenceKey(d, allKeys);
    diffKeys.add(k ?? d);
    if (k === undefined || !rowKeys.has(k))
      lines.push(
        `T: gate-fail: ${(k !== undefined ? i.codes.get(k) : undefined) ?? "-"} ${k ?? "-"}: ${d}`,
      );
  }
  const fail = (failure: string) => ({ outcome: "gate-fail" as const, lines, failure });
  const s = i.sleepIndex;
  if (s?.target !== 0 || s.test !== 0)
    return fail(`T: Sleep index ${JSON.stringify(s)}, pre-committed 0 + 0`);
  if (i.unsupportedTests !== 3)
    return fail(`T: ${i.unsupportedTests} refused tests, pre-committed 3`);
  if (i.knownRefusal !== undefined) return fail(`T: v3's own baseline: ${i.knownRefusal}`);
  const c = i.classification.outcome;
  if (c === "gate-fail")
    return fail(
      `T: ${rows.filter((r) => r.kind === "gate-fail").length} gate-fail row(s): ${lines.join("; ")}`,
    );
  if (c === "held") {
    // R650: R556's bare-hash refusal, which a `pass` meets in `assertGateBaseline`.
    const bare = bareHashRows(i.own, i.now);
    if (bare.length > 0)
      return fail(
        `T: the own baseline records a mutated-text hash per mutant, but ${bare.length} mutant(s) of this run have no mutated-text hash (no mutatedText, or a redacted one), first ${bare[0]?.key}. Refusing (R556): the text check would switch itself off.`,
      );
    const extra = [...diffKeys].filter((k) => !rowKeys.has(k));
    const missing = [...rowKeys].filter((k) => !diffKeys.has(k));
    if (extra.length > 0 || missing.length > 0)
      return fail(
        `T: held rows and compare differences are not the same keys (compare only: ${extra.join(", ") || "none"}; held only: ${missing.join(", ") || "none"})`,
      );
    return { outcome: "held", lines };
  }
  if (i.compare.differences.length > 0)
    return fail(
      `T: ${i.compare.differences.length} compare difference(s) on a pass: ${lines.join("; ")}`,
    );
  const { killed, survived, noCoverage } = i.counts;
  if (
    killed !== want.killed ||
    survived !== want.survived ||
    noCoverage !== want.noCoverage ||
    i.total !== want.total
  )
    return {
      ...fail(
        `T: ${killed} / ${survived} / ${noCoverage} over ${i.total}, pre-committed ${want.killed} / ${want.survived} / ${want.noCoverage} over ${want.total}`,
      ),
      countMismatch: true,
    };
  return { outcome: "pass", lines };
}

/**
 * R651: one leg's wall-clock split, TIMING ONLY. `phases` sums the orchestrator's `phase-left`
 * events; the mutant loop is its wall (unlike `timings.mutantsMs`, a sum over mutants) and holds
 * the backend's serve-entries timers in brackets; `other` is the loop less those (windows hold
 * coverage and echo, so those two are not subtracted again). A phase that never ran prints `-`.
 */
export function v3SplitLine(phases: Readonly<Record<string, number>>, s: V3EntriesStats): string {
  const p = (k: string) => phases[k] ?? "-";
  const loop = phases.mutants;
  const named = s.warmupMs + s.prefetchMs + s.liveMs + s.windowMs + s.boundMs;
  const other = loop === undefined ? "-" : loop - named;
  return `split ms: deploy ${p("deploy")}, baseline ${p("baseline")}, mutant loop ${p("mutants")} (warm-up ${s.warmupMs}, prefetch ${s.prefetchMs}, live ${s.liveMs}, windows ${s.windowMs} of which coverage ${s.coverageMs} and echo ${s.echoMs}, bound ${s.boundMs} over ${s.boundChecks} checks, other ${other})`;
}

/** r10 (c): SleeperDoubles's `baseline-batch-finished` verdict, or `undefined` when absent. */
export interface XdBaselineVerdict {
  readonly outcome: string;
  readonly failureMessage?: string;
}

export const xdBaselineLine = (v: XdBaselineVerdict | undefined): string =>
  `X (d): SleeperDoubles baseline-batch-finished: ${v === undefined ? "absent" : `${v.outcome}${v.failureMessage !== undefined ? `: ${v.failureMessage}` : ""}`}`;

/** r10 (c): a failed X (d) check's message, with the not-green reason keyed on SleeperDoubles alone. */
export function xdFailure(what: string, v: XdBaselineVerdict | undefined): string {
  if (v === undefined || v.outcome === "pass") return what;
  return `${what}; X (d): SleeperDoubles is not green at baseline (${v.outcome}: ${v.failureMessage ?? "-"}): the Sleep rule was not exercised; gate-fail`;
}

/**
 * r10 M5: X (b)'s held lines go to the receipt (`push`) BEFORE the rest of leg X runs, so a later
 * gate-fail cannot hide them. A held X (b) then makes the leg held; its lines are already pushed.
 */
export async function xbHeldFirst(
  xHeld: readonly string[],
  push: (line: string) => void,
  rest: () => Promise<void>,
): Promise<void> {
  for (const l of xHeld) push(`X: ${l}`);
  await rest();
  if (xHeld.length > 0) throw new V3LegHeld([]);
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
 * Leg C's defect facts: each must read `defect-present` (r6; `none-selected-exit` since r7, R632;
 * `refusal-row-shape` since r9, R639). Every other fact of the 28 is a contract fact and must read
 * `matches`, except the warn facts.
 */
export const V3_DEFECT_FACTS = [
  "upstream-compile-errors",
  "duplicate-key-insert-raises",
  "sleep-is-noop",
  "refusal-cascade",
  "codeunit-runs-whole",
  "quoted-name-unselectable",
  "commit-under-test-isolation",
  "none-selected-exit",
  // r9 (R639): #5608, as r7 did for #5613.
  "refusal-row-shape",
] as const;

/**
 * Leg C's pre-committed fact count: 9 defect, 18 contract, 1 warn (r13, R590: the contract fact
 * `dependency-skip-line`; r12 (R667, `message-has-no-type-prefix`) had 27, r9 had 26).
 */
export const V3_LEG_C_FACTS = 28;

/** F4 (R639): leg C's per-fact log line, with `measured` whole. */
export const legCFactLine = (f: {
  readonly fact: string;
  readonly verdict: string;
  readonly measured: string;
}): string => `  C: ${f.fact} = ${f.verdict} | ${f.measured}`;

/**
 * R612 (plan r3 §2): leg C's warn facts, a third kind. Anything but `matches` prints
 * `al-runner-v3-serve-keep-reason-moved` in the log and receipt lines and changes no outcome.
 */
export const V3_WARN_FACTS: readonly string[] = ["serve-keep-reasons"];

/**
 * RC-2 (I-2): leg C's verdict. A contract fact must read `matches` and a defect fact (`defects`)
 * `defect-present`. A defect fact reading `gone` (upstream fixed it) is `held`, for the orchestrator
 * to re-pre-commit, never a blacklisting. Any `diverged`, or another fact count, is `gate-fail`. An
 * `unmeasurable` fact is `infra-fail`. r9 (R639): `refused` is `held` on a defect fact and
 * `gate-fail` on any other; `unlike-bc` is always `gate-fail`. Precedence: gate-fail, infra-fail,
 * held, pass.
 */
export function classifyLegC(
  facts: ReadonlyArray<{
    readonly fact: string;
    readonly verdict: string;
    readonly measured?: string;
  }>,
  defects: readonly string[],
  count: number,
  warns: readonly string[] = V3_WARN_FACTS,
  pin?: V3BuildPin["legC"],
): { readonly outcome: "pass" | "held" | "gate-fail" | "infra-fail"; readonly lines: string[] } {
  const lines: string[] = [];
  let fail = facts.length !== count;
  if (fail) lines.push(`gate-fail: ${facts.length} facts, pre-committed ${count}`);
  let infra = false;
  let held = false;
  for (const f of facts) {
    const want = defects.includes(f.fact) ? "defect-present" : "matches";
    // R586c: a pinned fact that reads exactly as pinned is accepted. B1: one that does not is
    // judged by today's rules and then forced to at least `held` (the old reading means the build
    // moved back, which today's rules would pass).
    const p = pin !== undefined && Object.hasOwn(pin, f.fact) ? pin[f.fact] : undefined;
    if (pin !== undefined && p !== undefined) {
      if (pinnedFactMatches(pin, f)) {
        lines.push(`pinned: ${f.fact} = ${f.verdict} (${p.issue ?? "as BC"})`);
        continue;
      }
      lines.push(`pin-mismatch: ${f.fact}: pinned ${p.verdict}, read ${f.verdict}`);
      held = true;
    }
    if (f.verdict === want) continue;
    // R633 I1: what v3 returned, so the receipt itself carries the evidence.
    const m = f.measured !== undefined ? ` (measured ${f.measured.slice(0, 300)})` : "";
    if (f.verdict === "unlike-bc") {
      // r9 §2: never admitted, whatever the fact's kind.
      fail = true;
      lines.push(
        `gate-fail: ${f.fact}: unlike-bc (v3 fails as BC does, with another text; #5700)${m}`,
      );
    } else if (f.verdict === "refused") {
      // r9 §6: held for a defect fact; on a contract or a warn fact, gate-fail (M-g).
      if (want === "defect-present") {
        held = true;
        lines.push(
          `held: ${f.fact}: defect-present -> refused (v3 declines; not BC's reading; re-pre-commit)${m}`,
        );
      } else {
        fail = true;
        lines.push(`gate-fail: ${f.fact}: refused, pre-committed ${want}${m}`);
      }
    } else if (warns.includes(f.fact)) {
      // R612 (plan r3 §2): costs only speed (the rule then closes), so it never blocks.
      lines.push(`al-runner-v3-serve-keep-reason-moved: ${f.fact}: ${f.verdict}${m}`);
    } else if (f.verdict === "unmeasurable") {
      infra = true;
      lines.push(`infra-fail: ${f.fact}: unmeasurable${m}`);
    } else if (want === "defect-present" && f.verdict === "gone") {
      held = true;
      lines.push(`held: ${f.fact}: defect-present -> gone (an upstream fix; re-pre-commit)${m}`);
    } else {
      fail = true;
      lines.push(`gate-fail: ${f.fact}: ${f.verdict}, pre-committed ${want}${m}`);
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
export function classifyXb(
  r: {
    readonly exitCode: number;
    readonly passed: number;
    readonly notRun: number;
    /** The `--output-json` document parsed. */
    readonly parsed: boolean;
    /** The output names the broken target's compile diagnostic (AL0118 / `compilationErrors`). */
    readonly compileError: boolean;
    /** R586c: read only with a pin. `passed` and `notRun` above default to 0 when absent. */
    readonly passedPresent?: boolean;
    readonly notRunPresent?: boolean;
    readonly failed?: number;
    /** The document's `tests[]` length; absent when it has none. */
    readonly rowCount?: number;
    readonly compilationErrorsCount?: number;
  },
  pin?: XbPin,
): "pass" | "held" | "gate-fail" {
  const today = ((): "pass" | "held" | "gate-fail" => {
    if (r.exitCode === 7 && r.passed === 1 && r.notRun === 1) return "pass";
    if (r.exitCode > 0 && r.parsed && r.compileError && r.passed === 0) return "held";
    return "gate-fail";
  })();
  if (pin === undefined) return today;
  // R586c (M1): the pinned shape is a pass; B1: every other shape, alpha.2's 7/1/1 included, is at
  // best `held`.
  const pinned =
    r.exitCode === pin.exitCode &&
    r.parsed &&
    r.passedPresent === true &&
    r.notRunPresent === true &&
    r.passed === pin.passed &&
    r.notRun === pin.notRun &&
    (r.failed === undefined || r.failed === 0) &&
    r.rowCount === 0 &&
    (r.compilationErrorsCount ?? 0) > 0;
  if (pinned) return "pass";
  return today === "pass" ? "held" : today;
}

/**
 * R586c (M5): a record request on a pinned or candidate build is refused by name, for every leg
 * that records. A baseline is recorded from the build `current` is gated on, never from a build
 * the pin or the candidate flag stands in for. `requested` is the selected legs' baseline paths
 * whose record variable is set.
 */
export function recordRefusal(
  pinned: boolean,
  candidate: boolean,
  requested: readonly string[],
): string | undefined {
  if ((!pinned && !candidate) || requested.length === 0) return undefined;
  return `al-runner-v3-itest-record-refused: a record run refuses a ${pinned ? "pinned" : "candidate"} build (${requested.join(", ")}): record from the build current is gated on`;
}

/**
 * M6 (RC-5): X (e) and (f) fail closed only when the session holds the SAME five mutants (r5), none
 * of them survived, and the (d) control M0002 (which survives there) reads `error`. An empty or
 * short mutant list is a failure, never a vacuous pass. Returns the reason, or `undefined`.
 */
export function failsClosedRefusal(
  mutants: ReadonlyArray<{ readonly mutantCode: string; readonly verdict: string }>,
): string | undefined {
  if (mutants.length !== 5) return `${mutants.length} mutants, r5 5`;
  const survivors = mutants.filter((m) => m.verdict === "survived").map((m) => m.mutantCode);
  if (survivors.length > 0) return `a survivor (${survivors.join(",")})`;
  if (mutants.find((m) => m.mutantCode === "M0002")?.verdict !== "error")
    return "the control M0002 does not read error";
  return undefined;
}

/**
 * R635: the transport flags of `itest:alrunner-v3`, `LETHAL_ITEST_V3_TRANSPORT` (`one-shot` or
 * `serve-entries`) and `LETHAL_ITEST_V3_SECOND_ECHO` (`0` or `1`, serve-entries only). Unset (or
 * `one-shot` alone) gives `{}`, so the gate's backend config is byte-for-byte what it was. Any other
 * value refuses by name.
 */
export function v3ItestTransport(env: Readonly<Record<string, string | undefined>>): {
  readonly transport?: "serve-entries";
  readonly secondEcho?: boolean;
} {
  const t = env.LETHAL_ITEST_V3_TRANSPORT;
  const e = env.LETHAL_ITEST_V3_SECOND_ECHO;
  if (t !== undefined && t !== "one-shot" && t !== "serve-entries") {
    throw new Error(
      `al-runner-v3-itest-transport-refused: LETHAL_ITEST_V3_TRANSPORT=${JSON.stringify(t)}; allowed: one-shot, serve-entries (R635)`,
    );
  }
  if (e !== undefined && e !== "0" && e !== "1") {
    throw new Error(
      `al-runner-v3-itest-transport-refused: LETHAL_ITEST_V3_SECOND_ECHO=${JSON.stringify(e)}; allowed: 0, 1 (R635)`,
    );
  }
  if (e !== undefined && t !== "serve-entries") {
    throw new Error(
      "al-runner-v3-itest-transport-refused: LETHAL_ITEST_V3_SECOND_ECHO is set without LETHAL_ITEST_V3_TRANSPORT=serve-entries (R635)",
    );
  }
  return t === "serve-entries"
    ? { transport: "serve-entries", ...(e !== undefined ? { secondEcho: e === "1" } : {}) }
    : {};
}

/**
 * G5: the gate worktree is dirty when `git status --porcelain --untracked-files=all` shows any
 * tracked change, or an UNTRACKED file under `fixtures/` or `packages/` (it would compile into a
 * leg). Other untracked files are the gate's own outputs.
 */
export function dirtyFromStatus(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter((l) => l.trim() !== "")
    .some((l) => {
      if (!l.startsWith("??")) return true;
      const path = l.slice(3).trim().replace(/^"/, "");
      return path.startsWith("fixtures/") || path.startsWith("packages/");
    });
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

/**
 * I-2, as worded by r9 §8: every difference is a move toward BC or a named refusal; read the
 * receipt's lines: `held`.
 */
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
 * session it stays a plain refusal. R602: inside legs MO and WR, `AlRunnerCoverageFrameError` is
 * `gate-fail` too: those legs are the measurement of v3's per-object frame, so the error IS the
 * regression. In every other leg it stays `infra-fail`.
 */
export function legOutcomeOfError(err: unknown, leg?: string): V3LegOutcome {
  if (err instanceof V3LegHeld) return "held";
  if (err instanceof V3LegFailure) return "gate-fail";
  // R736: codes that differ from the recorded set judge the build; a set nobody recorded is LethAL's
  // own gap, never a verdict on the binary (the update script keeps a gate-fail for good).
  if (err instanceof GateWarningsMismatchError) return "gate-fail";
  if (err instanceof AlRunnerV3CoverageJoinError) return "gate-fail";
  if (err instanceof AlRunnerCoverageFrameError && (leg === "MO" || leg === "WR")) {
    return "gate-fail";
  }
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

/**
 * R736: the outcome the receipt carries. An observe run is never a pass: it writes `gate-fail`,
 * which the update script cannot match to the legs' `gateOutcome`, so it reads the receipt as an
 * infra-fail and never moves the pin. The itest also refuses observe mode outright when a receipt
 * is demanded (`observeWithReceiptRefusal`).
 */
export function v3ReceiptOutcome(
  legs: Readonly<Record<string, V3LegOutcome>>,
  observe: boolean,
): V3GateOutcome {
  return observe ? "gate-fail" : gateOutcome(legs);
}

/** R736: the update gate (a receipt path set) must never run in observe mode. */
export function observeWithReceiptRefusal(
  observe: boolean,
  receiptPath: string | undefined,
): string | undefined {
  return observe && receiptPath !== undefined
    ? "LETHAL_ITEST_OBSERVE_WARNINGS=1 with LETHAL_V3_GATE_RECEIPT set: the update gate trusts its receipt and an observe run is never a pass, so the two cannot be combined. Observe by running the gate by hand."
    : undefined;
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
  /** R612 M-2: leg C's reading of each warn fact (`V3_WARN_FACTS`); the update script copies it
   *  into `.gated` on a pass. */
  readonly warnFacts?: Readonly<Record<string, string>>;
  /** F8: the BC build of each leg's oracle server, beside v3's `--bc-version`. */
  readonly oracleBcBuild: Readonly<Record<string, string>>;
  readonly writtenAt: string;
}

export async function writeV3Receipt(path: string, r: V3GateReceipt): Promise<void> {
  await writeFile(path, `${JSON.stringify(r, null, 2)}\n`, "utf8");
}
