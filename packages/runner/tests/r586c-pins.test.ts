// R586c: per-build pins in the al-runner v3 gate (design `/coord/handoff/R-586c/design.md`,
// pre-commitment r18). Pure: no IO except reading the itest's own source text for wiring checks.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  V3_DEFECT_FACTS,
  V3_LEG_C_FACTS,
  V3_WARN_FACTS,
  classifyLegC,
  classifyLegT,
  classifyXb,
  judgeLegT,
  recordRefusal,
} from "../itest/al-runner-v3-gate";
import { V3_BUILD_PINS, applyTPin, findV3Pin, pinPattern } from "../itest/al-runner-v3-pins";
import { TABLES_KNOWN_DIFFERENCES } from "../itest/al-runner-v3-tables-known";
import { type NormalizedMutant, compareMutants } from "../itest/mutant-equality";
import { BC_HTTP_HUB_TEXT } from "../src/al-runner-v3-contract";

const VERSION = "al-runner 3.0.0-alpha.5 (07342060e)";
const SHA = "fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2";
const flip = (s: string): string => `${s.slice(0, -1)}${s.endsWith("0") ? "1" : "0"}`;
const pin = findV3Pin(VERSION, SHA);
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const SEVEN = [
  "none-selected-exit",
  "quoted-name-unselectable",
  "refusal-cascade",
  "sleep-is-noop",
  "upstream-compile-errors",
  "refusal-row-shape",
  "duplicate-key-insert-raises",
];

// The alpha.5 readings, byte for byte from the 6eddda0b gate.log and R705's legC-alpha5.log.
const ALPHA5: Record<string, { verdict: string; measured: string }> = {
  "none-selected-exit": { verdict: "gone", measured: "exit 6, stdout 0 rows" },
  "quoted-name-unselectable": { verdict: "gone", measured: "exit 0" },
  "refusal-cascade": {
    verdict: "gone",
    measured:
      '[{"codeunit":50654,"method":"LaterFails","name":"Codeunit50654.LaterFails","status":"fail","durationMs":0,"message":"later","notRun":false}] exit 1',
  },
  "sleep-is-noop": {
    verdict: "gone",
    measured:
      'N=3: 46 ms [{"codeunit":50660,"method":"ShortSleep","name":"Codeunit50660.ShortSleep","status":"pass","durationMs":0,"notRun":false},{"codeunit":50660,"method":"LongSleepA","name":"Codeunit50660.LongSleepA","status":"error","durationMs":0,"message":"Test exceed; no flag: 38 ms',
  },
  "upstream-compile-errors": { verdict: "gone", measured: "exit 3 null" },
  "refusal-row-shape": {
    verdict: "gone",
    measured: `[{"codeunit":50653,"method":"HttpGet","name":"Codeunit50653.HttpGet","status":"fail","durationMs":0,"message":"${BC_HTTP_HUB_TEXT}","notRun":false}] exit 1`,
  },
  "duplicate-key-insert-raises": {
    verdict: "refused",
    measured:
      '[{"codeunit":50655,"method":"DuplicateNamedKey","name":"Codeunit50655.DuplicateNamedKey","status":"error","durationMs":0,"message":"NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is not pinned","notRun":true}] exit 7',
  },
};

describe("R586c pins: the key", () => {
  test("P-key-1: the exact version and sha find the alpha.5 pin", () => {
    expect(pin?.id).toBe("alpha.5-07342060e");
  });
  test("P-key-2: another sha, another version, or alpha.2 finds nothing", () => {
    expect(findV3Pin(VERSION, flip(SHA))).toBeUndefined();
    expect(findV3Pin(`${VERSION} `, SHA)).toBeUndefined();
    expect(findV3Pin("al-runner 3.0.0-alpha.5 (07342060f)", SHA)).toBeUndefined();
    expect(findV3Pin("alrunner 3.0.0-alpha.2 (91253f2d6)", SHA)).toBeUndefined();
    expect(findV3Pin("alrunner 3.0.0-alpha.2 (91253f2d6)", "0".repeat(64))).toBeUndefined();
  });
  test("P-lookup: names on Object.prototype are never a pinned fact or a pin", () => {
    const legC = need(pin).legC;
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = classifyLegC([{ fact: k, verdict: "gone", measured: "x" }], [], 1, [], legC);
      expect(r.lines.join("\n")).not.toMatch(/pin-mismatch|pinned:/);
      expect(r.outcome).toBe("gate-fail");
      expect(findV3Pin(k, k)).toBeUndefined();
    }
  });
});

describe("R586c pins: the table", () => {
  test("P-meta-1: exactly the seven facts, all defect facts; a differing one names its issue", () => {
    const legC = need(pin).legC;
    expect(Object.keys(legC).sort()).toEqual([...SEVEN].sort());
    for (const [k, p] of Object.entries(legC)) {
      expect((V3_DEFECT_FACTS as readonly string[]).includes(k)).toBe(true);
      if (p.bc === "differs") expect(p.issue).toMatch(/^https:\/\/github\.com\/.+\/issues\/\d+$/);
    }
    expect(legC["duplicate-key-insert-raises"]?.verdict).toBe("refused");
    expect(legC["duplicate-key-insert-raises"]?.issue).toMatch(/issues\/5788$/);
    for (const k of SEVEN.filter((s) => s !== "duplicate-key-insert-raises"))
      expect(legC[k]?.verdict).toBe("gone");
  });
  test("P-meta-2: the seven T keys are the known killed -> survived rows, distinct", () => {
    const rows = need(pin).legT.rows;
    expect(rows.length).toBe(7);
    expect(new Set(rows.map((r) => r.key)).size).toBe(7);
    for (const r of rows) {
      const d = TABLES_KNOWN_DIFFERENCES.find((x) => x[0] === r.key);
      expect(d?.[1]).toBe("killed");
      expect(d?.[2]).toBe("survived");
      expect(r.verdict).toBe("error");
      expect(r.errorClass).toBe("runner-refused");
      expect(r.killingTest).toBeNull();
      expect(r.issue).toMatch(/issues\/5788$/);
    }
    expect(need(pin).legT.counts).toEqual({ killed: 290, survived: 50, noCoverage: 59 });
    expect(need(pin).legT.total).toBe(406);
  });
  test("P-meta-3: patterns are anchored, flagless, escape every dot; only sleep has a cut and an extra", () => {
    for (const [k, p] of Object.entries(need(pin).legC)) {
      expect(p.measured.flags).toBe("");
      expect(p.measured.source.startsWith("^")).toBe(true);
      expect(p.measured.source.endsWith("$")).toBe(true);
      expect(/(?<!\\)\./.test(p.measured.source)).toBe(false);
      expect(p.measured.source.includes('[^"]*')).toBe(k === "sleep-is-noop");
      expect(p.extra !== undefined).toBe(k === "sleep-is-noop");
    }
  });
  test("P-meta-3: pinPattern matches only the literal template, numbers free", () => {
    const t = "a.b (c) [d] | e? {n} ms";
    const re = pinPattern(t);
    expect(re.test("a.b (c) [d] | e? 12 ms")).toBe(true);
    expect(re.test("aXb (c) [d] | e? 12 ms")).toBe(false);
    expect(re.test("a.b (c) [d] | e? ms")).toBe(false);
    expect(re.test("xa.b (c) [d] | e? 12 ms")).toBe(false);
    expect(pinPattern("p {cut} q").test("p zz q")).toBe(false);
    expect(pinPattern("p {cut} q", { cut: true }).test("p zz q")).toBe(true);
  });
  test("P-meta-4: sha is 64 lowercase hex; ids and pairs are unique", () => {
    for (const p of V3_BUILD_PINS) expect(p.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(V3_BUILD_PINS.map((p) => p.id)).size).toBe(V3_BUILD_PINS.length);
    expect(new Set(V3_BUILD_PINS.map((p) => `${p.version}|${p.binarySha256}`)).size).toBe(
      V3_BUILD_PINS.length,
    );
  });
  test("P-bind: each pattern matches alpha.5's logged text, not alpha.2's reading or a one-character change", () => {
    const legC = need(pin).legC;
    for (const k of SEVEN) {
      const p = need(legC[k]);
      expect(p.measured.test(need(ALPHA5[k]).measured)).toBe(true);
      expect(p.measured.test(`${need(ALPHA5[k]).measured}!`)).toBe(false);
    }
    const casc = need(legC["refusal-cascade"]).measured;
    expect(
      casc.test(
        need(ALPHA5["refusal-cascade"]).measured.replace('"notRun":false', '"notRun":true'),
      ),
    ).toBe(false);
    const sl = need(ALPHA5["sleep-is-noop"]).measured;
    expect(
      need(legC["sleep-is-noop"]).measured.test(sl.replace('"status":"error"', '"status":"pass"')),
    ).toBe(false);
    // M2: a one-character change at a `.` of the hub text must not match (an unescaped `.` would).
    const hub = need(ALPHA5["refusal-row-shape"]).measured;
    const variant = hub.replace("requirements.", "requirements,");
    expect(variant).not.toBe(hub);
    expect(need(legC["refusal-row-shape"]).measured.test(variant)).toBe(false);
  });
  test("P-bind: sleep's extra wants the no-flag wall under 1000 ms", () => {
    const extra = need(need(pin).legC["sleep-is-noop"]?.extra);
    expect(extra(need(ALPHA5["sleep-is-noop"]).measured)).toBe(true);
    expect(extra("N=3: 46 ms [x]; no flag: 1000 ms")).toBe(false);
    expect(extra("N=3: 46 ms [x]; no flag: 999 ms")).toBe(true);
    expect(extra("no wall here")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Leg C
// ---------------------------------------------------------------------------------------------

/** The 28 facts as alpha.5 read them: 9 defect, 18 contract, 1 warn. */
function alpha5Facts(): { fact: string; verdict: string; measured?: string }[] {
  const facts: { fact: string; verdict: string; measured?: string }[] = [];
  for (const d of V3_DEFECT_FACTS) {
    const a = ALPHA5[d];
    facts.push(
      a !== undefined ? { fact: d, ...a } : { fact: d, verdict: "defect-present", measured: "x" },
    );
  }
  for (let i = 1; i <= 18; i++)
    facts.push({ fact: `contract-${i}`, verdict: "matches", measured: "ok" });
  facts.push({ fact: "serve-keep-reasons", verdict: "matches", measured: "ok" });
  return facts;
}
const withFact = (
  facts: ReturnType<typeof alpha5Facts>,
  fact: string,
  o: { verdict?: string; measured?: string },
) => facts.map((f) => (f.fact === fact ? { ...f, ...o } : f));
const runC = (facts: ReturnType<typeof alpha5Facts>, withPin = true) =>
  classifyLegC(
    facts,
    V3_DEFECT_FACTS,
    V3_LEG_C_FACTS,
    V3_WARN_FACTS,
    withPin ? need(pin).legC : undefined,
  );

describe("R586c leg C: the pin", () => {
  test("the 28 facts: 9 defect, 18 contract, 1 warn", () => {
    expect(alpha5Facts().length).toBe(V3_LEG_C_FACTS);
  });
  test("C-pin-1: alpha.5's readings with the pin pass, with seven pinned lines and no held line", () => {
    const r = runC(alpha5Facts());
    expect(r.outcome).toBe("pass");
    expect(r.lines.filter((l) => l.startsWith("pinned: ")).length).toBe(7);
    expect(r.lines.some((l) => l.startsWith("held:") || l.includes("pin-mismatch"))).toBe(false);
    expect(r.lines.find((l) => l.includes("duplicate-key-insert-raises"))).toMatch(/issues\/5788/);
  });
  test("C-pin-2: the same readings with no pin are held: six gone and one refused", () => {
    const r = runC(alpha5Facts(), false);
    expect(r.outcome).toBe("held");
    expect(r.lines.filter((l) => l.includes("-> gone")).length).toBe(6);
    expect(r.lines.filter((l) => l.includes("-> refused")).length).toBe(1);
    expect(r.lines.some((l) => l.startsWith("pinned:"))).toBe(false);
  });
  test("C-pin-3: per fact, a one-character change or alpha.2's reading is exactly held; diverged is gate-fail", () => {
    for (const k of SEVEN) {
      const base = alpha5Facts();
      const one = runC(withFact(base, k, { measured: `${need(ALPHA5[k]).measured}!` }));
      expect(one.outcome, `${k} one character`).toBe("held");
      expect(one.lines.filter((l) => l.startsWith("pinned: ")).length, `${k} others`).toBe(6);
      expect(one.lines.some((l) => l.startsWith(`pin-mismatch: ${k}:`))).toBe(true);
      const old = runC(withFact(base, k, { verdict: "defect-present" }));
      expect(old.outcome, `${k} defect-present`).toBe("held");
      expect(old.lines.filter((l) => l.startsWith("pinned: ")).length).toBe(6);
      const div = runC(withFact(base, k, { verdict: "diverged" }));
      expect(div.outcome, `${k} diverged`).toBe("gate-fail");
    }
  });
  test("C-pin-3b: sleep's no-flag wall of 1000 ms or more is held", () => {
    const slow = need(ALPHA5["sleep-is-noop"]).measured.replace(
      "no flag: 38 ms",
      "no flag: 1500 ms",
    );
    expect(runC(withFact(alpha5Facts(), "sleep-is-noop", { measured: slow })).outcome).toBe("held");
  });
  test("C-pin-4: refusal-row-shape with the web-service text (unlike-bc) is gate-fail", () => {
    const r = runC(
      withFact(alpha5Facts(), "refusal-row-shape", {
        verdict: "unlike-bc",
        measured: "[{... web-service text ...}] exit 1",
      }),
    );
    expect(r.outcome).toBe("gate-fail");
  });
  test("C-pin-5: duplicate-key read as gone (BC's fail text) is held, and not a pin pass", () => {
    const r = runC(
      // The pinned refusal text but read as `gone`: only the verdict compare can refuse it.
      withFact(alpha5Facts(), "duplicate-key-insert-raises", { verdict: "gone" }),
    );
    expect(r.outcome).toBe("held");
    expect(r.lines.some((l) => l.startsWith("pinned: duplicate-key"))).toBe(false);
  });
  test("C-pin-6: an unpinned defect fact moving beside a full pin is held, not pass", () => {
    const r = runC(withFact(alpha5Facts(), "codeunit-runs-whole", { verdict: "gone" }));
    expect(r.outcome).toBe("held");
  });
  test("a wrong fact count is still gate-fail first", () => {
    expect(runC(alpha5Facts().slice(1)).outcome).toBe("gate-fail");
  });
});

// ---------------------------------------------------------------------------------------------
// X (b)
// ---------------------------------------------------------------------------------------------

describe("R586c X (b): the pinned shape", () => {
  const m1 = {
    exitCode: 3,
    passed: 0,
    notRun: 0,
    parsed: true,
    compileError: true,
    passedPresent: true,
    notRunPresent: true,
    failed: 0,
    rowCount: 0,
    compilationErrorsCount: 2,
  };
  test("X-pin-1: the M1 shape is a pass with the pin, held without", () => {
    expect(classifyXb(m1, need(pin).xb)).toBe("pass");
    expect(classifyXb(m1)).toBe("held");
  });
  test("X-pin-2: alpha.2's 7/1/1 is held with the pin (never pass)", () => {
    expect(
      classifyXb(
        { exitCode: 7, passed: 1, notRun: 1, parsed: true, compileError: false },
        need(pin).xb,
      ),
    ).toBe("held");
  });
  test("X-pin-2: each other shape is not a pass", () => {
    const x = need(pin).xb;
    expect(classifyXb({ ...m1, exitCode: 2 }, x)).toBe("held");
    expect(classifyXb({ ...m1, exitCode: 7, passed: 1, notRun: 1 }, x)).toBe("held");
    expect(classifyXb({ ...m1, parsed: false }, x)).toBe("gate-fail");
    expect(classifyXb({ ...m1, compilationErrorsCount: 0 }, x)).toBe("held");
    const { compilationErrorsCount: _ce, ...noCe } = m1;
    expect(classifyXb(noCe, x)).toBe("held");
    expect(classifyXb({ ...m1, passedPresent: false }, x)).toBe("held");
    expect(classifyXb({ ...m1, notRunPresent: false }, x)).toBe("held");
    expect(classifyXb({ ...m1, failed: 1 }, x)).toBe("held");
    expect(classifyXb({ ...m1, rowCount: 1 }, x)).toBe("held");
    const { rowCount: _rc, ...noRows } = m1;
    expect(classifyXb(noRows, x)).toBe("held");
    expect(classifyXb({ ...m1, notRun: 1 }, x)).toBe("held");
    expect(classifyXb({ ...m1, passed: 1 }, x)).toBe("gate-fail");
    expect(classifyXb({ ...m1, exitCode: 101, compileError: false }, x)).toBe("gate-fail");
  });
  test("with failed absent the pinned shape still passes", () => {
    const { failed: _f, ...noFailed } = m1;
    expect(classifyXb(noFailed, need(pin).xb)).toBe("pass");
  });
});

// ---------------------------------------------------------------------------------------------
// Leg T
// ---------------------------------------------------------------------------------------------

describe("R586c leg T: the seven rows", () => {
  const keys = need(pin).legT.rows.map((r) => r.key);
  const hash = (k: string) => `h-${k.slice(0, 8)}-${k.length}`;
  const base = (key: string, verdict: string, killingTest: string | null): NormalizedMutant => ({
    key,
    verdict,
    killingTest,
    coverageFiltered: verdict === "no-coverage",
    errorClass: null,
    mutatedTextSha256: hash(key),
  });
  const ownRows: NormalizedMutant[] = [
    ...keys.map((k) => base(k, "survived", null)),
    base("K2", "killed", "T2"),
    base("K3", "survived", null),
  ];
  const bcRows: NormalizedMutant[] = [
    ...keys.map((k) => base(k, "killed", "DoubleInsertWithoutKeyTriggerRaises")),
    base("K2", "killed", "T2"),
    base("K3", "survived", null),
  ];
  const refused = (r: NormalizedMutant): NormalizedMutant => ({
    ...r,
    verdict: "error",
    errorClass: "runner-refused",
    killingTest: null,
  });
  const movedNow = ownRows.map((r) => (keys.includes(r.key) ? refused(r) : r));
  const codes = new Map(ownRows.map((r, i) => [r.key, `M${i}`]));
  const judge = (
    now: readonly NormalizedMutant[],
    o: { pinned?: boolean; counts?: [number, number, number]; extra?: object } = {},
  ) => {
    const [killed, survived, noCoverage] = o.counts ?? [290, 50, 59];
    return judgeLegT({
      classification: classifyLegT(ownRows, now, bcRows),
      compare: compareMutants(ownRows, now, { sameScheme: true }),
      own: ownRows,
      now,
      counts: { killed, survived, noCoverage },
      total: 406,
      unsupportedTests: 3,
      sleepIndex: { target: 0, test: 0 },
      knownRefusal: undefined,
      codes,
      ...(o.pinned === false
        ? {}
        : { pin: { id: need(pin).id, legT: need(pin).legT, bc: bcRows, sameScheme: true } }),
      ...o.extra,
    });
  };
  test("T-pin-1: baseline plus the seven overrides, 290/50/59: pass, pinned", () => {
    const j = judge(movedNow);
    expect(j.outcome).toBe("pass");
    expect(j.pinned).toBe(true);
    expect(j.lines).toEqual(["T: pinned 7 rows (pin alpha.5-07342060e, #5788)"]);
  });
  test("T-pin-2: the same input with no pin is held (today)", () => {
    const j = judge(movedNow, { pinned: false });
    expect(j.outcome).toBe("held");
    expect(j.pinned).toBeUndefined();
  });
  test("T-pin-0 (B1): all seven still survived, 290/57/59, with the pin: exactly held (no pin: pass)", () => {
    expect(judge(ownRows, { pinned: false, counts: [290, 57, 59] }).outcome).toBe("pass");
    const j = judge(ownRows, { counts: [290, 57, 59] });
    expect(j.outcome).toBe("held");
    expect(j.pinned).toBeUndefined();
    expect(j.lines.some((l) => l.startsWith("T: pin-mismatch: "))).toBe(true);
  });
  test("T-pin-3: six of seven moved is not a pass; the value is the worse of today and held", () => {
    const now = ownRows.map((r) => (keys.slice(1).includes(r.key) ? refused(r) : r));
    const j = judge(now);
    const today = judge(now, { pinned: false });
    expect(j.pinned).toBeUndefined();
    expect(j.outcome).toBe(today.outcome === "gate-fail" ? "gate-fail" : "held");
    expect(j.outcome).not.toBe("pass");
  });
  test("T-pin-3: seven moved plus an eighth known row moved is not a pass", () => {
    const now = movedNow.map((r) => (r.key === "K3" ? refused(r) : r));
    expect(judge(now).outcome).not.toBe("pass");
    expect(judge(now).pinned).toBeUndefined();
  });
  test("T-pin-3: one row with another errorClass is gate-fail", () => {
    const now = movedNow.map((r, i) => (i === 0 ? { ...r, errorClass: "runner-test-error" } : r));
    expect(judge(now).outcome).toBe("gate-fail");
  });
  test("T-pin-3: one refused row WITH a killing test is not a pass", () => {
    const now = movedNow.map((r, i) => (i === 0 ? { ...r, killingTest: "SomeTest" } : r));
    expect(judge(now).outcome).not.toBe("pass");
  });
  test("T-pin-3: counts 290/57/59 with the seven moved is gate-fail", () => {
    expect(judge(movedNow, { counts: [290, 57, 59] }).outcome).toBe("gate-fail");
  });
  test("T-pin-3: Sleep index 1 + 0 and unsupportedTests 2 are gate-fail", () => {
    expect(judge(movedNow, { extra: { sleepIndex: { target: 1, test: 0 } } }).outcome).toBe(
      "gate-fail",
    );
    expect(judge(movedNow, { extra: { unsupportedTests: 2 } }).outcome).toBe("gate-fail");
  });
  test("T-pin-3: the real alpha.2 known-refusal check still applies", () => {
    expect(judge(movedNow, { extra: { knownRefusal: "x" } }).outcome).toBe("gate-fail");
  });
  test("T-pin-4: a pinned key whose baseline row is not survived: applyTPin is undefined, one mismatch line", () => {
    const changed = ownRows.map((r, i) => (i === 0 ? base(r.key, "killed", "X") : r));
    expect(applyTPin(changed, need(pin).legT)).toBeUndefined();
    expect(applyTPin(ownRows.slice(1), need(pin).legT)).toBeUndefined();
    expect(applyTPin([...ownRows, ownRows[0] as NormalizedMutant], need(pin).legT)).toBeUndefined();
    const own2 = changed;
    const j = judgeLegT({
      classification: classifyLegT(own2, movedNow, bcRows),
      compare: compareMutants(own2, movedNow, { sameScheme: true }),
      own: own2,
      now: movedNow,
      counts: { killed: 290, survived: 50, noCoverage: 59 },
      total: 406,
      unsupportedTests: 3,
      sleepIndex: { target: 0, test: 0 },
      knownRefusal: undefined,
      codes,
      pin: { id: need(pin).id, legT: need(pin).legT, bc: bcRows, sameScheme: true },
    });
    expect(j.pinned).toBeUndefined();
    expect(j.outcome).not.toBe("pass");
    expect(j.lines.filter((l) => l.startsWith("T: pin-mismatch: ")).length).toBe(1);
  });
  test("T-pin-5 (R556): a now row without a mutated-text hash is not a pass", () => {
    const now = movedNow.map((r, i) => {
      if (i !== 0) return r;
      const { mutatedTextSha256: _drop, ...rest } = r;
      return rest;
    });
    const j = judge(now);
    expect(j.outcome).not.toBe("pass");
    expect(j.pinned).toBeUndefined();
  });
  test("T-pin-6: a changed mutated-text hash on a pinned row is not a pass", () => {
    const now = movedNow.map((r, i) => (i === 0 ? { ...r, mutatedTextSha256: "other" } : r));
    const j = judge(now);
    expect(j.outcome).not.toBe("pass");
    expect(j.pinned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Itest wiring and the record refusal (M5)
// ---------------------------------------------------------------------------------------------

const ITEST = readFileSync(join(import.meta.dir, "..", "itest", "al-runner-v3.itest.ts"), "utf8");

describe("R586c itest wiring", () => {
  test("W-1: one findV3Pin call, the three pin arguments, and the guarded baseline compare", () => {
    expect(ITEST.match(/findV3Pin\(/g)?.length).toBe(1);
    expect(ITEST).toContain("findV3Pin(version, sha)");
    expect(ITEST).toContain("activePin?.legC");
    expect(ITEST).toContain("activePin?.xb");
    expect(ITEST).toContain("activePin?.legT");
    expect(ITEST).toMatch(
      /if \(!t\.pinned\) \{\s*try \{\s*await assertGateBaseline\(t\.r, TABLES_BASELINE_PATH/,
    );
    const call = ITEST.indexOf("recordRefusal(");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(ITEST.indexOf("for (const leg of LEGS)"));
  });
  test("S3: the candidate seam is passed only inside legK, and only on a candidate", () => {
    expect(ITEST.match(/alRunnerCandidate/g)?.length).toBe(1);
    const k = ITEST.indexOf("async function legK(");
    const next = ITEST.indexOf("\nasync function ", k + 10);
    const at = ITEST.indexOf("alRunnerCandidate");
    expect(at).toBeGreaterThan(k);
    expect(at).toBeLessThan(next);
    expect(ITEST).toMatch(/alRunnerCandidate: true/);
    expect(ITEST).toContain("CANDIDATE ?");
  });
});

describe("R586c M5: a record request on a pinned or candidate build is refused", () => {
  test("a pinned build refuses a request for any leg's baseline", () => {
    expect(recordRefusal(true, false, ["al-runner-v3.layout.baseline.json"])).toMatch(/refuses/);
  });
  test("a candidate build refuses it too", () => {
    expect(recordRefusal(false, true, ["al-runner-v3.tables.baseline.json"])).toMatch(/refuses/);
  });
  test("an unpinned gated build and an empty request are not refused", () => {
    expect(recordRefusal(false, false, ["anything"])).toBeUndefined();
    expect(recordRefusal(true, false, [])).toBeUndefined();
    expect(recordRefusal(true, true, [])).toBeUndefined();
  });
});
