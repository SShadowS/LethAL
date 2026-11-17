// PR-114a: the capability facts' consumers. The accessor `baselineBatchingFor` is true only for a build in
// `V3_BASELINE_BATCHING_BUILDS` (PR-115: not a pin flag, which gated and adopted builds would inherit) AND
// all eight capability facts `matches` AND the §6 Sleep rule retired; `classifyLegC` gate-fails a capability fact that does not read `matches`; the probe cache stores
// the new kind. Pure: the only pin changed is a synthetic copy, removed in `finally`.
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
import {
  type V3BuildPin,
  V3_BASELINE_BATCHING_BUILDS,
  V3_BUILD_PINS,
  adoptV3Pin,
  baselineBatchingFor,
  baselineBatchingOffReason,
  findV3Pin,
  gatedBuilds,
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

/** A pin that retires the Sleep rule (every current pin records it gone), copied. */
const base = (() => {
  const p = V3_BUILD_PINS.find((x) => x.legC["sleep-is-noop"]?.verdict === "gone");
  if (p === undefined) throw new Error("no pin records sleep-is-noop gone");
  return p;
})();
const SHA = "ab".repeat(32);
const VERSION = "al-runner 3.0.0-pr114a-test (0000000)";

/**
 * Runs `fn` with a synthetic pin for (VERSION, SHA) in the table, and (PR-115) in the batching list when
 * `listed`, then removes both.
 */
function withPin(listed: boolean, extra: Partial<V3BuildPin>, fn: () => void): void {
  const table = V3_BUILD_PINS as V3BuildPin[];
  const list = V3_BASELINE_BATCHING_BUILDS as { version: string; binarySha256: string }[];
  table.push({ ...base, id: "pr114a-test", version: VERSION, binarySha256: SHA, ...extra });
  if (listed) list.push({ version: VERSION, binarySha256: SHA });
  try {
    fn();
  } finally {
    table.pop();
    if (listed) list.pop();
  }
}

describe("PR-114a: baselineBatchingFor", () => {
  test("PR-115: exactly one build is listed (edge-4ebfe7913's gated row, by version and sha); the accessor is false on every other pin and gated row", () => {
    expect(V3_BASELINE_BATCHING_BUILDS).toHaveLength(1);
    const gated = gatedBuilds().find((g) => g.id === "edge-4ebfe7913");
    if (gated === undefined) throw new Error("no gated row for edge-4ebfe7913");
    expect(V3_BASELINE_BATCHING_BUILDS[0]).toEqual({
      version: gated.version,
      binarySha256: gated.binarySha256,
    });
    const probe = result(...allMatch(), sleep("gone"));
    expect(baselineBatchingFor(probe, gated.version, gated.binarySha256)).toBe(true);
    for (const p of V3_BUILD_PINS) {
      expect(baselineBatchingFor(probe, p.version, p.binarySha256), p.id).toBe(false);
    }
    for (const g of gatedBuilds()) {
      expect(baselineBatchingFor(probe, g.version, g.binarySha256), g.id).toBe(
        g.id === "edge-4ebfe7913",
      );
    }
    // Named builds: alpha.13, alpha.14 releases and edge-d72d3197d.
    for (const id of ["alpha.13-23e7631be", "alpha.14-ef00a6a8f", "edge-d72d3197d"]) {
      const e = gatedBuilds().find((g) => g.id === id) ?? V3_BUILD_PINS.find((p) => p.id === id);
      if (e === undefined) throw new Error(id);
      expect(baselineBatchingFor(probe, e.version, e.binarySha256), id).toBe(false);
    }
  });

  test("PR-115 (H1): a build adopted or gated from ANY pin never batches, so the flag cannot spread through readingsFrom", () => {
    const probe = result(...allMatch(), sleep("gone"));
    try {
      for (const p of V3_BUILD_PINS) {
        adoptV3Pin(VERSION, SHA, p.id);
        expect(findV3Pin(VERSION, SHA)?.id).toBe(p.id);
        expect(baselineBatchingFor(probe, VERSION, SHA), `adopted from ${p.id}`).toBe(false);
      }
    } finally {
      resetAdoptedV3Pins();
    }
  });

  test("false when the build is not listed, though every fact matches and the Sleep rule is retired", () => {
    withPin(false, {}, () => {
      const c = result(...allMatch(), sleep("gone"));
      expect(baselineBatchingFor(c, VERSION, SHA)).toBe(false);
      expect(baselineBatchingOffReason(c, VERSION, SHA)).toMatch(
        /not in V3_BASELINE_BATCHING_BUILDS/,
      );
    });
  });

  test("false when any one capability fact is not matches (each of the eight, each reading), or is missing", () => {
    withPin(true, {}, () => {
      for (const name of V3_CAPABILITY_FACTS) {
        for (const v of ["diverged", "unmeasurable"] as const) {
          const facts = allMatch().map((f) => (f.fact === name ? cap(name, v) : f));
          const c = result(...facts, sleep("gone"));
          expect(baselineBatchingFor(c, VERSION, SHA), `${name} ${v}`).toBe(false);
          expect(baselineBatchingOffReason(c, VERSION, SHA)).toContain(`${name} read ${v}`);
        }
        const missing = result(...allMatch().filter((f) => f.fact !== name), sleep("gone"));
        expect(baselineBatchingFor(missing, VERSION, SHA), `${name} missing`).toBe(false);
      }
      expect(baselineBatchingFor(undefined, VERSION, SHA)).toBe(false);
    });
  });

  test("false when the §6 Sleep rule is not retired (the probe reads sleep-is-noop another way, or not at all)", () => {
    withPin(true, {}, () => {
      for (const c of [result(...allMatch(), sleep("defect-present")), result(...allMatch())]) {
        expect(baselineBatchingFor(c, VERSION, SHA)).toBe(false);
        expect(baselineBatchingOffReason(c, VERSION, SHA)).toMatch(/Sleep rule is not retired/);
      }
    });
    // and a pin that does not record sleep-is-noop gone, though listed
    withPin(true, { legC: {} }, () => {
      expect(baselineBatchingFor(result(...allMatch(), sleep("gone")), VERSION, SHA)).toBe(false);
    });
  });

  test("true only when listed, all eight match, and the Sleep rule is retired; false for another sha", () => {
    withPin(true, {}, () => {
      const c = result(...allMatch(), sleep("gone"));
      expect(baselineBatchingFor(c, VERSION, SHA)).toBe(true);
      expect(baselineBatchingOffReason(c, VERSION, SHA)).toBeUndefined();
      expect(baselineBatchingFor(c, VERSION, "cd".repeat(32))).toBe(false);
      expect(baselineBatchingOffReason(c, VERSION, "cd".repeat(32))).toMatch(
        /not in V3_BASELINE_BATCHING_BUILDS/,
      );
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
