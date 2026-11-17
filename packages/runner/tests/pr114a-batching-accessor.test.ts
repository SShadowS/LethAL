// PR-114a: the capability facts' consumers. PR-117: the accessor `baselineBatchingFor` is true only when the
// build's OWN gate record carries `batchFacts` with all eight capability facts `matches`, AND this session's
// probe reads all eight `matches`, AND the §6 Sleep rule is retired. There is no list of builds and no candidate
// rule. `classifyLegC` gate-fails a capability fact that does not read `matches`, except a `diverged` one whose
// alone reference passed (batching off, not a failure); the probe cache stores the new kind. Pure: the only pin
// changed is a synthetic copy, removed in `finally`.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_DEFECT_FACTS, classifyLegC } from "../itest/al-runner-v3-gate";
import {
  type V3ContractResult,
  type V3Fact,
  V3_CAPABILITY_FACTS,
  v3ContractRefusals,
} from "../src/al-runner-v3-contract";
import * as pinsModule from "../src/al-runner-v3-pins";
import {
  type V3BuildPin,
  V3_BUILD_PINS,
  adoptV3Pin,
  baselineBatchingFor,
  baselineBatchingOffReason,
  findV3Pin,
  resetAdoptedV3Pins,
} from "../src/al-runner-v3-pins";
import {
  type ProbeCacheKey,
  readProbeCache,
  uncacheableReason,
  writeProbeCache,
} from "../src/al-runner-v3-probe-cache";

const cap = (fact: string, verdict: V3Fact["verdict"] = "matches"): V3Fact => ({
  fact,
  kind: "capability",
  verdict,
  expected: "x",
  measured: "m",
});
const sleep = (verdict: string): V3Fact => ({
  fact: "sleep-is-noop",
  kind: "defect",
  verdict: verdict as "gone",
  expected: "x",
  measured: "m",
});
const allMatch = (): V3Fact[] => V3_CAPABILITY_FACTS.map((n) => cap(n));
const result = (...facts: V3Fact[]): V3ContractResult => ({ facts });

/** A gate record (`.gated` or a manifest row) as the accessor reads it. */
const COMMIT = "c0".repeat(20);
const rec = (batchFacts?: Record<string, string>) => ({
  lethalCommit: COMMIT,
  ...(batchFacts !== undefined ? { batchFacts } : {}),
});
const recAll = (over: Record<string, string> = {}) =>
  rec({ ...Object.fromEntries(V3_CAPABILITY_FACTS.map((n) => [n, "matches"])), ...over });

/** A pin that retires the Sleep rule (every current pin records it gone), copied. */
const base = (() => {
  const p = V3_BUILD_PINS.find((x) => x.legC["sleep-is-noop"]?.verdict === "gone");
  if (p === undefined) throw new Error("no pin records sleep-is-noop gone");
  return p;
})();
const SHA = "ab".repeat(32);
const VERSION = "al-runner 3.0.0-pr114a-test (0000000)";

/** Runs `fn` with a synthetic pin for (VERSION, SHA) in the table, then removes it. */
function withPin(extra: Partial<V3BuildPin>, fn: () => void): void {
  const table = V3_BUILD_PINS as V3BuildPin[];
  table.push({ ...base, id: "pr114a-test", version: VERSION, binarySha256: SHA, ...extra });
  try {
    fn();
  } finally {
    table.pop();
  }
}

describe("PR-117: baselineBatchingFor follows the build's own gate record", () => {
  const probe = () => result(...allMatch(), sleep("gone"));

  test("the hand list is gone", () => {
    expect("V3_BASELINE_BATCHING_BUILDS" in pinsModule).toBe(false);
  });

  test("on: a record of eight matches, the probe's eight matches, the Sleep rule retired", () => {
    withPin({}, () => {
      expect(baselineBatchingFor(probe(), VERSION, SHA, recAll())).toBe(true);
      expect(baselineBatchingOffReason(probe(), VERSION, SHA, recAll())).toBeUndefined();
    });
  });

  test("off: no record, or a record without batchFacts, names the build's gate commit", () => {
    withPin({}, () => {
      for (const g of [undefined, rec()]) {
        expect(baselineBatchingFor(probe(), VERSION, SHA, g)).toBe(false);
        expect(baselineBatchingOffReason(probe(), VERSION, SHA, g)).toMatch(
          /this build's gate record \(lethalCommit .*\) has no batchFacts/,
        );
      }
      expect(baselineBatchingOffReason(probe(), VERSION, SHA, rec())).toContain(COMMIT);
    });
  });

  test("off: a fact missing from the record, each of the eight, by name", () => {
    withPin({}, () => {
      for (const name of V3_CAPABILITY_FACTS) {
        const all = recAll().batchFacts as Record<string, string>;
        const { [name]: _gone, ...rest } = all;
        expect(baselineBatchingFor(probe(), VERSION, SHA, rec(rest)), name).toBe(false);
        expect(baselineBatchingOffReason(probe(), VERSION, SHA, rec(rest))).toBe(
          `${name} not recorded`,
        );
      }
    });
  });

  test("off: a fact diverged or unmeasurable in the record, each of the eight, by name", () => {
    withPin({}, () => {
      for (const name of V3_CAPABILITY_FACTS) {
        for (const v of ["diverged", "unmeasurable"]) {
          const g = recAll({ [name]: v });
          expect(baselineBatchingFor(probe(), VERSION, SHA, g), `${name} ${v}`).toBe(false);
          expect(baselineBatchingOffReason(probe(), VERSION, SHA, g)).toBe(
            `the gate read ${name} ${v}`,
          );
        }
      }
    });
  });

  test("L: an empty lethalCommit (a candidate's record) prints none in the off reason", () => {
    withPin({}, () => {
      expect(baselineBatchingOffReason(probe(), VERSION, SHA, { lethalCommit: "" })).toBe(
        "this build's gate record (lethalCommit none) has no batchFacts",
      );
    });
  });

  test("M-3: off when the probe alone reads eight matches and there is no record (no candidate rule)", () => {
    withPin({}, () => {
      expect(baselineBatchingFor(probe(), VERSION, SHA, undefined)).toBe(false);
      expect(baselineBatchingFor(probe(), VERSION, SHA, { lethalCommit: "" })).toBe(false);
    });
  });

  test("H1: a build adopted from ANY pin never batches without its own record", () => {
    try {
      for (const p of V3_BUILD_PINS) {
        adoptV3Pin(VERSION, SHA, p.id);
        expect(findV3Pin(VERSION, SHA)?.id).toBe(p.id);
        expect(baselineBatchingFor(probe(), VERSION, SHA, undefined), `adopted from ${p.id}`).toBe(
          false,
        );
      }
    } finally {
      resetAdoptedV3Pins();
    }
  });

  test("off when any one capability fact is not matches in THIS session's probe (each of the eight), or is missing", () => {
    withPin({}, () => {
      for (const name of V3_CAPABILITY_FACTS) {
        for (const v of ["diverged", "unmeasurable"] as const) {
          const facts = allMatch().map((f) => (f.fact === name ? cap(name, v) : f));
          const c = result(...facts, sleep("gone"));
          expect(baselineBatchingFor(c, VERSION, SHA, recAll()), `${name} ${v}`).toBe(false);
          expect(baselineBatchingOffReason(c, VERSION, SHA, recAll())).toContain(
            `${name} read ${v}`,
          );
        }
        const missing = result(...allMatch().filter((f) => f.fact !== name), sleep("gone"));
        expect(baselineBatchingFor(missing, VERSION, SHA, recAll()), `${name} missing`).toBe(false);
      }
      expect(baselineBatchingFor(undefined, VERSION, SHA, recAll())).toBe(false);
    });
  });

  test("off when the §6 Sleep rule is not retired (the probe reads sleep-is-noop another way, or not at all)", () => {
    withPin({}, () => {
      for (const c of [result(...allMatch(), sleep("defect-present")), result(...allMatch())]) {
        expect(baselineBatchingFor(c, VERSION, SHA, recAll())).toBe(false);
        expect(baselineBatchingOffReason(c, VERSION, SHA, recAll())).toMatch(
          /Sleep rule is not retired/,
        );
      }
    });
    // and a pin that does not record sleep-is-noop gone
    withPin({ legC: {} }, () => {
      expect(baselineBatchingFor(probe(), VERSION, SHA, recAll())).toBe(false);
    });
  });
});

describe("PR-114a: a capability fact in leg C and in a session", () => {
  const facts = (v: V3Fact["verdict"]) => [cap("batch-lane-hint-only", v)];
  const run = (v: V3Fact["verdict"]) => classifyLegC(facts(v), [], 1, []);

  test("classifyLegC: matches passes; diverged is gate-fail; unmeasurable is infra-fail", () => {
    expect(run("matches")).toEqual({ outcome: "pass", lines: [] });
    const d = run("diverged");
    expect(d.outcome).toBe("gate-fail");
    expect(d.lines.join("\n")).toMatch(
      /gate-fail: batch-lane-hint-only: diverged, pre-committed matches/,
    );
    expect(run("unmeasurable").outcome).toBe("infra-fail");
  });

  test("classifyLegC: each of the eight, diverged in an otherwise passing set, fails the gate", () => {
    for (const name of V3_CAPABILITY_FACTS) {
      const set = allMatch().map((f) => (f.fact === name ? cap(name, "diverged") : f));
      expect(classifyLegC(set, V3_DEFECT_FACTS, 8, []).outcome, name).toBe("gate-fail");
    }
    expect(classifyLegC(allMatch(), V3_DEFECT_FACTS, 8, []).outcome).toBe("pass");
  });

  test("a session never refuses on a capability fact, whatever it reads", () => {
    for (const v of ["matches", "diverged", "unmeasurable"] as const)
      expect(v3ContractRefusals(result(cap("batch-no-cross-row", v)))).toEqual([]);
  });
});

describe("PR-117 (M-2): a capability fact diverged only in its batch half passes", () => {
  const F = "batch-no-cross-row";
  const diverged = (reference?: "pass" | "fail" | "none"): V3Fact => ({
    ...cap(F, "diverged"),
    ...(reference !== undefined ? { reference } : {}),
  });
  const run = (f: V3Fact, caps: readonly string[] = V3_CAPABILITY_FACTS) =>
    classifyLegC([f], [], 1, [], undefined, caps);

  test("reference pass: passes with the off line, naming the fact", () => {
    const c = run(diverged("pass"));
    expect(c.outcome).toBe("pass");
    expect(c.lines.join("\n")).toMatch(
      /al-runner-v3-baseline-batching-off: batch-no-cross-row: diverged/,
    );
  });

  test("reference fail: gate-fail (the single request is wrong)", () => {
    expect(run(diverged("fail")).outcome).toBe("gate-fail");
  });

  test("reference none (it ran nothing): infra-fail", () => {
    expect(run(diverged("none")).outcome).toBe("infra-fail");
  });

  test("no reference by design (the lane and OnRun-duplicate facts): diverged gate-fails, as before PR-117", () => {
    expect(run(diverged()).outcome).toBe("gate-fail");
  });

  test("a fact outside the capability list that reads diverged still gate-fails, whatever its reference", () => {
    expect(run({ ...diverged("pass"), fact: "some-contract-fact" }).outcome).toBe("gate-fail");
    expect(run(diverged("pass"), []).outcome).toBe("gate-fail");
  });

  test("unmeasurable and unlike-bc behave as before", () => {
    expect(run({ ...cap(F, "unmeasurable"), reference: "pass" }).outcome).toBe("infra-fail");
    expect(run({ ...cap(F), verdict: "unlike-bc" as never, reference: "pass" }).outcome).toBe(
      "gate-fail",
    );
  });

  test("no hand pin's legC has a capability key (a pin mismatch would turn a passing diverged into held)", () => {
    for (const p of V3_BUILD_PINS)
      for (const n of V3_CAPABILITY_FACTS)
        expect(Object.hasOwn(p.legC, n), `${p.id} ${n}`).toBe(false);
  });
});

describe("PR-114a: the probe cache holds the capability kind", () => {
  const ARGS = ["0.0.0", SHA] as const;

  test("M2: a capability fact never makes the probe uncacheable, whatever it reads (fail-safe: batching needs matches)", () => {
    for (const v of ["matches", "diverged", "unmeasurable"] as const)
      expect(uncacheableReason(result(cap("batch-no-cross-row", v)), ...ARGS), v).toBeUndefined();
    // a contract fact that diverges still does
    expect(
      uncacheableReason(
        result(cap("batch-no-cross-row", "unmeasurable"), {
          fact: "version",
          kind: "contract",
          verdict: "diverged",
          expected: "x",
          measured: "m",
        }),
        ...ARGS,
      ),
    ).toBeDefined();
  });

  test("a result with capability facts round-trips through the cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-pr114a-"));
    try {
      const bin = join(dir, "al-runner");
      await writeFile(bin, "x");
      const key: ProbeCacheKey = {
        binarySha256: SHA,
        version: "v",
        probeCodeHash: "h",
        bcVersion: "28",
        environment: "saas",
        packages: "p",
        alc: "a",
        cacheDir: null,
        gateRecord: "g",
        tasksetPresent: false,
        libraryAssertApp: false,
      };
      const r = result(...allMatch());
      await writeProbeCache(bin, key, r);
      expect(await readProbeCache(bin, key)).toEqual(r);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
