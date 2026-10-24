// R719: a session mutes a defect-gone / defect-refused warning only when the running build's pin
// (exact version line AND binarySha256) names that exact fact with that exact outcome.
import { describe, expect, test } from "bun:test";
import {
  BC_HTTP_HUB_TEXT,
  type V3ContractResult,
  type V3Fact,
  v3DefectWarnings,
} from "../src/al-runner-v3-contract";
import { V3_BUILD_PINS, pinnedDefectCoverage } from "../src/al-runner-v3-pins";

const VERSION = "al-runner 3.0.0-alpha.5 (07342060e)";
const SHA = "fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2";
const OTHER_SHA = `${SHA.slice(0, -1)}${SHA.endsWith("0") ? "1" : "0"}`;

const ROW = (cu: number, m: string) =>
  `{"codeunit":${cu},"method":"${m}","name":"Codeunit${cu}.${m}"`;
// The alpha.5 readings the pin matches (the same texts as r586c-pins.test.ts).
const MEASURED: Record<string, string> = {
  "none-selected-exit": "exit 6, stdout 0 rows",
  "quoted-name-unselectable": "exit 0",
  "refusal-cascade": `[${ROW(50654, "LaterFails")},"status":"fail","durationMs":0,"message":"later","notRun":false}] exit 1`,
  "sleep-is-noop": `N=3: 46 ms [${ROW(50660, "ShortSleep")},"status":"pass","durationMs":0,"notRun":false},${ROW(50660, "LongSleepA")},"status":"error","durationMs":0,"message":"Test exceed; no flag: 38 ms`,
  "upstream-compile-errors": "exit 3 null",
  "refusal-row-shape": `[${ROW(50653, "HttpGet")},"status":"fail","durationMs":0,"message":"${BC_HTTP_HUB_TEXT}","notRun":false}] exit 1`,
  "duplicate-key-insert-raises": `[${ROW(50655, "DuplicateNamedKey")},"status":"error","durationMs":0,"message":"NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is not pinned","notRun":true}] exit 7`,
};
const fact = (name: string, verdict: V3Fact["verdict"], measured?: string): V3Fact => ({
  fact: name,
  kind: "defect",
  verdict,
  expected: "x",
  measured: measured ?? MEASURED[name] ?? "m",
});
const GONE = [
  "none-selected-exit",
  "quoted-name-unselectable",
  "refusal-cascade",
  "sleep-is-noop",
  "upstream-compile-errors",
  "refusal-row-shape",
];
const PINNED: V3ContractResult = {
  facts: [...GONE.map((n) => fact(n, "gone")), fact("duplicate-key-insert-raises", "refused")],
};
const warnings = (r: V3ContractResult, version: string, sha: string): string[] => {
  const cov = pinnedDefectCoverage(r, version, sha);
  return [...(cov === undefined ? [] : [cov.line]), ...v3DefectWarnings(r, { muted: cov?.muted })];
};
const warns = (lines: string[]) => lines.filter((l) => /al-runner-v3-defect-/.test(l));

describe("R719: pin-covered defect warnings", () => {
  test("the pin table is the one the gate uses (alpha.5 is pinned)", () => {
    expect(V3_BUILD_PINS.some((p) => p.version === VERSION && p.binarySha256 === SHA)).toBe(true);
  });
  test("a pinned fact with the pinned outcome is silent, and one pin line is printed", () => {
    const lines = warnings(PINNED, VERSION, SHA);
    expect(warns(lines)).toEqual([]);
    expect(lines).toEqual([
      "[lethal] al-runner-v3 pin alpha.5-07342060e covers 7 facts (#5700, #5788, R586c)",
    ]);
  });
  test("an unpinned fact still warns, the pinned ones stay silent", () => {
    const r = { facts: [...PINNED.facts, fact("brand-new-defect", "gone")] };
    const w = warns(warnings(r, VERSION, SHA));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/defect-gone: brand-new-defect/);
  });
  test("the same facts on a different sha all warn, and no pin line", () => {
    const lines = warnings(PINNED, VERSION, OTHER_SHA);
    expect(warns(lines)).toHaveLength(7);
    expect(lines.some((l) => /pin alpha/.test(l))).toBe(false);
  });
  test("the same fact with another outcome warns", () => {
    const r: V3ContractResult = {
      facts: [fact("none-selected-exit", "refused"), fact("duplicate-key-insert-raises", "gone")],
    };
    const w = warns(warnings(r, VERSION, SHA));
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/defect-gone: duplicate-key-insert-raises/);
    expect(w[1]).toMatch(/defect-refused: none-selected-exit/);
  });
  test("a pinned fact with the pinned outcome but a measured text the pin does not match warns", () => {
    const r = {
      facts: [fact("none-selected-exit", "gone", "m"), fact("refusal-row-shape", "gone")],
    };
    const w = warns(warnings(r, VERSION, SHA));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/defect-gone: none-selected-exit/);
  });
  test("sleep-is-noop: the pin's extra check (no-flag wall under 1000 ms) also gates the mute", () => {
    const slow = MEASURED["sleep-is-noop"]?.replace("no flag: 38 ms", "no flag: 5000 ms");
    const r = { facts: [fact("sleep-is-noop", "gone", slow)] };
    expect(warns(warnings(r, VERSION, SHA))).toHaveLength(1);
  });
  test("no pin: all seven warn", () => {
    expect(warns(warnings(PINNED, "al-runner 3.0.0-alpha.4 (x)", SHA))).toHaveLength(7);
  });
  test("a fact the pin names whose outcome is defect-present is not muted (never printed anyway)", () => {
    const r = { facts: [fact("none-selected-exit", "defect-present")] };
    expect(pinnedDefectCoverage(r, VERSION, SHA)).toBeUndefined();
  });
});
