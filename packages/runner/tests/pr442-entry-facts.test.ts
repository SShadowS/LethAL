// PR-442: the 14 `entry-no-cross-*` leg-C facts. Pure: the judge from six answers, and classifyLegC's branch.
import { describe, expect, test } from "bun:test";
import {
  V3_DEFECT_FACTS,
  V3_LEG_C_FACTS,
  V3_WARN_FACTS,
  classifyLegC,
} from "../itest/al-runner-v3-gate";
import {
  ENTRY_CARRY_PREFIX,
  ENTRY_DEAD_PREFIX,
  ENTRY_MODES,
  STOP_EARLIER_KILLER_FACT,
  type EntryMode,
  type EntryRow,
  type EntryRun,
  V3_CAPABILITY_FACTS,
  V3_CARRY_FACT,
  V3_ENTRY_FACTS,
  judgeEntryFacts,
} from "../src/al-runner-v3-contract";

type Kv = Record<string, string>;
const CU = "Codeunit50460";
const SENT: Record<string, string> = { e0: "MUT-Z", e1: "MUT-A", e2: "MUT-B" };

/** probe-v2-current's readings: a clean reader, and the control after the writer in the same entry. */
const clean = (res: string): Kv => ({
  lasterr: "[]",
  selector: res,
  fresh: res,
  appSI: "0",
  testSI: "0",
  global: "0",
  lib: "0",
  workdate: "2026-11-25",
  language: "1033",
  temp: "0",
  static: "0",
  manual: "0",
  rows: "0",
  iso: "No",
  seq: "No",
});
const control = (res: string, mode: EntryMode): Kv => ({
  ...clean(res),
  appSI: "7",
  testSI: "8",
  global: "9",
  lib: "5",
  workdate: "2031-01-01",
  language: "1030",
  temp: "1",
  static: "2",
  manual: "1",
  iso: "Nej",
  seq: mode === "C-method" ? "Ja" : "Nej",
});
const text = (kv: Kv): string =>
  `MEASURED ${["lasterr", "selector", "fresh", "appSI", "testSI", "global", "lib", "workdate", "language", "temp", "static", "manual", "rows", "iso", "seq"].map((k) => `${k}=${kv[k]}`).join(" ")}`;

const SHAPE: Record<EntryMode, readonly (readonly [string, string])[]> = {
  "T-flag": [
    ["e1", "A_Reader1"],
    ["e1", "B_Writer"],
    ["e1", "C_Reader2"],
    ["e2", "A_Reader1"],
  ],
  "T-plain": [
    ["e1", "A_Reader1"],
    ["e1", "B_Writer"],
    ["e1", "C_Reader2"],
    ["e2", "A_Reader1"],
  ],
  "C-method": [
    ["e0", "A_Reader1"],
    ["e0", "B_Writer"],
    ["e0", "C_Reader2"],
    ["e1", "B_Writer"],
    ["e2", "A_Reader1"],
  ],
};

/** `patch` may change a reader's values per run: role `def` (the first row), `e2` (the last row) or `ctrl` (the first entry's C_Reader2). */
type Patch = (run: { replay: boolean; mode: EntryMode }, role: "def" | "e2" | "ctrl", kv: Kv) => Kv;
function rowsFor(mode: EntryMode, patch?: Patch, replay = false): EntryRow[] {
  return SHAPE[mode].map(([entry, m], i, all) => {
    const name = `${CU}.${m}`;
    if (m === "B_Writer") return { entry, name, status: "pass", message: undefined };
    const res = SENT[entry] ?? "";
    const isCtrl = m === "C_Reader2";
    const isE2 = i === all.length - 1;
    let kv = isCtrl ? control(res, mode) : clean(res);
    if (i === 0 && patch) kv = patch({ replay, mode }, "def", kv);
    if (isCtrl && patch) kv = patch({ replay, mode }, "ctrl", kv);
    if (isE2 && patch) kv = patch({ replay, mode }, "e2", kv);
    return { entry, name, status: "fail", message: text(kv) };
  });
}
const runsOf = (patch?: Patch, edit?: (run: EntryRun) => EntryRun | undefined): EntryRun[] =>
  [false, true].flatMap((replay) =>
    ENTRY_MODES.flatMap((mode) => {
      const run: EntryRun = { replay, mode, answer: { rows: rowsFor(mode, patch, replay) } };
      const out = edit ? edit(run) : run;
      return out === undefined ? [] : [out];
    }),
  );
const verdicts = (runs: readonly EntryRun[]) =>
  Object.fromEntries(judgeEntryFacts(runs).map((f) => [f.fact, f]));

describe("PR-442: judgeEntryFacts", () => {
  test("current's exact readings: all 14 facts match", () => {
    const fs = judgeEntryFacts(runsOf());
    expect(fs.map((f) => f.fact)).toEqual([...V3_ENTRY_FACTS]);
    for (const f of fs) expect(f.verdict, f.fact).toBe("matches");
    expect(V3_ENTRY_FACTS.length).toBe(14);
  });

  test("a carried channel in e2 reads diverged (carry) for that fact only", () => {
    const v = verdicts(
      runsOf((run, role, kv) =>
        role === "e2" && run.replay && run.mode === "T-plain" ? { ...kv, appSI: "7" } : kv,
      ),
    );
    expect(v["entry-no-cross-singleinstance"]?.verdict).toBe("diverged");
    expect(v["entry-no-cross-singleinstance"]?.measured.startsWith(ENTRY_CARRY_PREFIX)).toBe(true);
    for (const n of V3_ENTRY_FACTS.filter((x) => x !== "entry-no-cross-singleinstance"))
      expect(v[n]?.verdict, n).toBe("matches");
  });

  test("a stuck selector (e2 reads MUT-A) reads diverged (carry) for selector-cache", () => {
    const v = verdicts(
      runsOf((run, role, kv) =>
        role === "e2" && run.mode === "C-method" ? { ...kv, selector: "MUT-A" } : kv,
      ),
    );
    expect(v["entry-no-cross-selector-cache"]?.verdict).toBe("diverged");
    expect(v["entry-no-cross-selector-cache"]?.measured.startsWith(ENTRY_CARRY_PREFIX)).toBe(true);
    expect(v["entry-no-cross-singleinstance"]?.verdict).toBe("matches");
  });

  test("a fresh read that differs from the sent resource also reads carry", () => {
    const v = verdicts(
      runsOf((_run, role, kv) => (role === "e2" ? { ...kv, fresh: "MUT-A" } : kv)),
    );
    expect(v["entry-no-cross-selector-cache"]?.measured.startsWith(ENTRY_CARRY_PREFIX)).toBe(true);
  });

  test("a dead positive control reads diverged (dead probe) for that live fact only", () => {
    const v = verdicts(
      runsOf((run, role, kv) =>
        role === "ctrl" && !run.replay && run.mode === "T-flag" ? { ...kv, appSI: "0" } : kv,
      ),
    );
    expect(v["entry-no-cross-singleinstance"]?.verdict).toBe("diverged");
    expect(v["entry-no-cross-singleinstance"]?.measured.startsWith(ENTRY_DEAD_PREFIX)).toBe(true);
    for (const n of V3_ENTRY_FACTS.filter((x) => x !== "entry-no-cross-singleinstance"))
      expect(v[n]?.verdict, n).toBe("matches");
  });

  test("a rollback channel needs no live control: numbersequence matches with a control that reads the default", () => {
    const v = verdicts(
      runsOf((_run, role, kv) => (role === "ctrl" ? { ...kv, seq: "No", rows: "0" } : kv)),
    );
    expect(v["entry-no-cross-numbersequence"]?.verdict).toBe("matches");
    expect(v["entry-no-cross-rows"]?.verdict).toBe("matches");
  });

  test("a dirty state before the probe (the first reader reads appSI=7) is a dead probe, not a match", () => {
    const v = verdicts(
      runsOf((run, role, kv) =>
        role === "def" && run.replay && run.mode === "C-method" ? { ...kv, appSI: "7" } : kv,
      ),
    );
    expect(v["entry-no-cross-singleinstance"]?.verdict).toBe("diverged");
    expect(v["entry-no-cross-singleinstance"]?.measured.startsWith(ENTRY_DEAD_PREFIX)).toBe(true);
    expect(v["entry-no-cross-test-singleinstance"]?.verdict).toBe("matches");
  });

  test("workdate: another date in e2 (past midnight) matches; the written 2031-01-01 is a carry", () => {
    const other = verdicts(
      runsOf((_run, role, kv) => (role === "e2" ? { ...kv, workdate: "2026-11-26" } : kv)),
    );
    expect(other["entry-no-cross-workdate"]?.verdict).toBe("matches");
    const carried = verdicts(
      runsOf((_run, role, kv) => (role === "e2" ? { ...kv, workdate: "2031-01-01" } : kv)),
    );
    expect(carried["entry-no-cross-workdate"]?.verdict).toBe("diverged");
    expect(carried["entry-no-cross-workdate"]?.measured.startsWith(ENTRY_CARRY_PREFIX)).toBe(true);
  });

  test("a reader message without selector= or fresh= is a dead probe for selector-cache, never a carry", () => {
    for (const drop of ["selector", "fresh"]) {
      const runs = runsOf(undefined, (run) =>
        run.replay && run.mode === "T-flag" && "rows" in run.answer
          ? {
              ...run,
              answer: {
                rows: run.answer.rows.map((r, i, all) =>
                  i === all.length - 1
                    ? { ...r, message: (r.message ?? "").replace(new RegExp(`${drop}=\\S+ `), "") }
                    : r,
                ),
              },
            }
          : run,
      );
      const f = verdicts(runs)["entry-no-cross-selector-cache"];
      expect(f?.verdict, drop).toBe("diverged");
      expect(f?.measured.startsWith(ENTRY_DEAD_PREFIX), drop).toBe(true);
    }
  });

  test("a rollback channel that crosses reads carry (lasterror)", () => {
    const v = verdicts(
      runsOf((_run, role, kv) => (role === "e2" ? { ...kv, lasterr: "[P442-WRITER-ERROR]" } : kv)),
    );
    expect(v["entry-no-cross-lasterror"]?.measured.startsWith(ENTRY_CARRY_PREFIX)).toBe(true);
  });

  const rowEdits: [string, (rows: readonly EntryRow[]) => EntryRow[]][] = [
    ["a missing row", (r) => r.slice(0, -1)],
    ["an extra row", (r) => [...r, ...r.slice(-1)]],
    [
      "a reordered row",
      (r) => [r[1], r[0], ...r.slice(2)].filter((x): x is EntryRow => x !== undefined),
    ],
    ["a wrong entry", (r) => r.map((x, i) => (i === r.length - 1 ? { ...x, entry: "e9" } : x))],
  ];
  for (const [what, edit] of rowEdits)
    test(`${what} in one run: every fact reads diverged (dead probe)`, () => {
      const runs = runsOf(undefined, (run) =>
        run.replay && run.mode === "T-flag" && "rows" in run.answer
          ? { ...run, answer: { rows: edit(run.answer.rows) } }
          : run,
      );
      for (const f of judgeEntryFacts(runs)) {
        expect(f.verdict, f.fact).toBe("diverged");
        expect(f.measured.startsWith(ENTRY_DEAD_PREFIX), f.fact).toBe(true);
      }
    });

  test("a missing run, or a run with no answer, reads unmeasurable for every fact", () => {
    for (const runs of [
      runsOf(undefined, (run) => (run.replay && run.mode === "C-method" ? undefined : run)),
      runsOf(undefined, (run) =>
        !run.replay && run.mode === "T-plain" ? { ...run, answer: { failed: "deadline" } } : run,
      ),
    ])
      for (const f of judgeEntryFacts(runs)) expect(f.verdict, f.fact).toBe("unmeasurable");
  });
});

describe("PR-442: classifyLegC", () => {
  const base = (): { fact: string; verdict: string; measured?: string }[] => [
    ...V3_DEFECT_FACTS.map((fact) => ({ fact, verdict: "defect-present", measured: "x" })),
    ...Array.from({ length: 18 }, (_, i) => ({
      fact: `contract-${i}`,
      verdict: "matches",
      measured: "ok",
    })),
    ...V3_WARN_FACTS.map((fact) => ({ fact, verdict: "matches", measured: "ok" })),
    ...[
      ...V3_CAPABILITY_FACTS,
      V3_CARRY_FACT,
      "stop-groups",
      STOP_EARLIER_KILLER_FACT, // PR-452
      ...V3_ENTRY_FACTS,
    ].map((fact) => ({
      fact,
      verdict: "matches",
      measured: "ok",
    })),
  ];
  const withEntry = (fact: string, verdict: string, measured: string) =>
    base().map((f) => (f.fact === fact ? { ...f, verdict, measured } : f));
  const run = (facts: ReturnType<typeof base>) =>
    classifyLegC(facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS, V3_WARN_FACTS);

  test("the count is 53 (PR-452: + stop-groups-earlier-killer) and an all-matches reading passes with no line", () => {
    expect(V3_LEG_C_FACTS).toBe(53);
    expect(base().length).toBe(53);
    expect(run(base())).toEqual({ outcome: "pass", lines: [] });
  });
  test("a diverged carry never gate-fails and prints al-runner-v3-entry-carry", () => {
    const r = run(
      withEntry("entry-no-cross-workdate", "diverged", `${ENTRY_CARRY_PREFIX} replay=0 T-flag`),
    );
    expect(r.outcome).toBe("pass");
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]?.startsWith("al-runner-v3-entry-carry: entry-no-cross-workdate")).toBe(true);
  });
  test("a diverged dead probe never gate-fails and prints al-runner-v3-entry-probe-dead", () => {
    const r = run(
      withEntry(
        "entry-no-cross-temp-table",
        "diverged",
        `${ENTRY_DEAD_PREFIX} the control reads the default 0`,
      ),
    );
    expect(r.outcome).toBe("pass");
    expect(r.lines[0]?.startsWith("al-runner-v3-entry-probe-dead: entry-no-cross-temp-table")).toBe(
      true,
    );
  });
  test("unmeasurable stays an infra-fail", () => {
    expect(run(withEntry("entry-no-cross-rows", "unmeasurable", "no answer")).outcome).toBe(
      "infra-fail",
    );
  });
});
