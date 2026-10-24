import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { V3_AGENTFLOW_LEGS } from "../../packages/runner/itest/alrunner-v3-legs.ts";
import {
  CHUNKED_SUBLEGS,
  HANG_SUBLEGS,
  HARDEN_SUBLEGS,
} from "../../packages/runner/itest/gate-sublegs.ts";
import {
  EXPECTED_SUBLEGS,
  FULL_SET,
  GateSelectionError,
  LEG_CONTAINER,
  LEG_ORDER,
  type Leg,
  selectLegs,
  widenWithDelta,
} from "./gate-table.ts";
import { expectedSublegsFor } from "./tick.ts";

// R654 S2 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md §S2a): the v3
// gate is a leg of its own. S3 removed the .NET al-runner leg it was selected beside.
describe("R654 S2: the alrunner-v3 leg", () => {
  test("a change to al-runner-v3-backend.ts selects alrunner-v3", () => {
    expect(selectLegs(["packages/runner/src/al-runner-v3-backend.ts"]).legs).toContain(
      "alrunner-v3",
    );
  });

  test("a change to the v3 gate's own itest files selects alrunner-v3", () => {
    for (const p of [
      "packages/runner/itest/al-runner-v3.itest.ts",
      "packages/runner/itest/al-runner-v3-gate.ts",
      "packages/runner/itest/alrunner-v3-legs.ts",
    ]) {
      expect([p, selectLegs([p]).legs.includes("alrunner-v3")]).toEqual([p, true]);
    }
  });

  test("R654 S3: every selection that held the retired alrunner leg holds alrunner-v3, and no leg is alrunner", () => {
    expect((LEG_ORDER as readonly string[]).includes("alrunner")).toBe(false);
    for (const p of [
      "packages/engine/src/x.ts",
      "packages/schemata/src/x.ts",
      "packages/runner/src/store.ts",
      "fixtures/sandbox-app/src/x.al",
      "extensions/lethal-control/src/x.al",
      "packages/somewhere-new/x.ts",
    ]) {
      const legs = selectLegs([p]).legs as readonly string[];
      expect([p, legs.includes("alrunner"), legs.includes("alrunner-v3")]).toEqual([
        p,
        false,
        true,
      ]);
    }
  });

  test("docs still select no live leg", () => {
    expect(selectLegs(["docs/gates/alrunner-v3.md"]).legs).toEqual([]);
  });

  test("its receipt is checked against the exact default leg list, on agent-app, right after chunked", () => {
    expect(EXPECTED_SUBLEGS["alrunner-v3" as Leg]).toEqual(V3_AGENTFLOW_LEGS);
    expect(LEG_CONTAINER["alrunner-v3" as Leg]).toBe("agent-app");
    expect(LEG_ORDER.indexOf("alrunner-v3" as Leg)).toBe(LEG_ORDER.indexOf("chunked") + 1);
  });
});

// R271: harden, verify, testapp and agreement. Each leg: its own paths select it (and a path of
// another leg's does not), so a rule that is dropped or widened to everything goes red.
describe("R271: harden, verify, testapp and agreement legs", () => {
  const OWN: Readonly<Record<string, readonly string[]>> = {
    harden: [
      "fixtures/sandbox-harden/src/Harden.Codeunit.al",
      "fixtures/sandbox-harden-tests/Harden.Test.al",
      "fixtures/sandbox-harden-answers/Answers.Test.al",
      "packages/runner/itest/harden.itest.ts",
      "packages/runner/itest/harden-expected.ts",
      "packages/runner/src/equivalence-marks.ts",
    ],
    verify: [
      "packages/runner/src/verify.ts",
      "packages/runner/src/test-digest.ts",
      "packages/runner/src/testpage-scan.ts",
      "packages/runner/src/gaps.ts",
      "packages/runner/src/closed-world.ts",
      "packages/runner/src/assertion-screen.ts",
      "packages/runner/src/digest-inputs.ts",
      "packages/runner/src/equivalence-marks.ts",
      "packages/runner/itest/verify.itest.ts",
      "fixtures/sandbox-app/src/Sandbox.Codeunit.al",
      "fixtures/sandbox-tests/Sandbox.Test.al",
    ],
    testapp: [
      "packages/runner/src/test-app-publish.ts",
      "packages/runner/src/stale-test-app.ts",
      "packages/runner/itest/test-app-publish.itest.ts",
      "fixtures/sandbox-app/src/Sandbox.Codeunit.al",
      "fixtures/sandbox-tests/Sandbox.Test.al",
    ],
    agreement: [
      "packages/runner/itest/verify-agreement.itest.ts",
      "packages/runner/itest/verify-agreement.ts",
      "packages/runner/src/verify.ts",
      "fixtures/sandbox-harden/src/Harden.Codeunit.al",
    ],
  };

  for (const [leg, paths] of Object.entries(OWN)) {
    test(`a change under ${leg}'s own paths selects ${leg}`, () => {
      for (const p of paths) {
        const s = selectLegs([p]);
        // Matched by a rule, not rescued by default-deny (which would select every leg).
        expect([p, s.unmatched]).toEqual([p, []]);
        expect([p, (s.legs as readonly string[]).includes(leg)]).toEqual([p, true]);
      }
    });
  }

  test("an unrelated change selects none of the four", () => {
    for (const p of [
      "fixtures/sandbox-hang/src/Hang.Codeunit.al",
      "fixtures/sandbox-data/src/DataMain.Table.al",
      "packages/runner/src/store.ts",
      "packages/runner/src/publisher.ts",
    ]) {
      const legs = selectLegs([p]).legs as readonly string[];
      for (const l of ["harden", "verify", "testapp", "agreement"]) {
        expect([p, l, legs.includes(l)]).toEqual([p, l, false]);
      }
    }
  });

  test("a hardening change does not select verify or testapp, and a test-app change does not select harden", () => {
    const h = selectLegs(["fixtures/sandbox-harden/src/Harden.Codeunit.al"]).legs;
    expect(h).not.toContain("verify");
    expect(h).not.toContain("testapp");
    const t = selectLegs(["packages/runner/src/test-app-publish.ts"]).legs;
    expect(t).not.toContain("harden");
  });

  // Build review B1: harden, chunked and hang emit several sublegs; a missing or wrong entry makes
  // the tick refuse their passing receipt ("A partial run is not a pass").
  test("EXPECTED_SUBLEGS holds each multi-subleg itest's list, and the one-subleg legs have none", () => {
    expect(EXPECTED_SUBLEGS.harden).toEqual(["base-suite", "answer-key"]);
    expect(EXPECTED_SUBLEGS.chunked).toEqual(["unbounded", "chunked-2"]);
    expect(EXPECTED_SUBLEGS.hang).toEqual([
      "stop-hung-sessions-on",
      "stop-hung-sessions-single",
      "stop-baseline",
      "stop-hung-sessions-off",
    ]);
    for (const l of ["verify", "testapp", "agreement"] as const) {
      expect([l, EXPECTED_SUBLEGS[l]]).toEqual([l, undefined]);
    }
    expect(expectedSublegsFor("harden")).toEqual(HARDEN_SUBLEGS);
  });

  test("each itest emits its shared subleg constant, and the one-subleg itests emit one name", () => {
    const src = (f: string) =>
      readFileSync(new URL(`../../packages/runner/itest/${f}`, import.meta.url), "utf8");
    const emitted = (f: string, leg: string) =>
      new RegExp(`emitPassed\\("${leg}",\\s*\\{\\s*sublegs: \\[([^\\]]*)\\]`).exec(src(f))?.[1];
    expect(emitted("harden.itest.ts", "harden")).toBe("...HARDEN_SUBLEGS");
    expect(emitted("chunked.itest.ts", "chunked")).toBe("...CHUNKED_SUBLEGS");
    expect(emitted("hang.itest.ts", "hang")).toBe("...HANG_SUBLEGS");
    expect(CHUNKED_SUBLEGS).toEqual(EXPECTED_SUBLEGS.chunked as readonly string[]);
    expect(HANG_SUBLEGS).toEqual(EXPECTED_SUBLEGS.hang as readonly string[]);
    for (const [f, leg] of [
      ["verify.itest.ts", "verify"],
      ["test-app-publish.itest.ts", "testapp"],
      ["verify-agreement.itest.ts", "agreement"],
    ] as const) {
      expect([leg, emitted(f, leg)]).toEqual([leg, `"${leg}"`]);
    }
  });

  test("all four are in FULL_SET (default-deny) and the unmatched path selects them", () => {
    const s = selectLegs(["packages/somewhere-new/src/thing.ts"]).legs;
    for (const l of ["harden", "verify", "testapp", "agreement"] as const) {
      expect(FULL_SET).toContain(l);
      expect(s).toContain(l);
    }
  });

  test("containers: harden and agreement on the harden lease, verify and testapp on agent-app", () => {
    expect(LEG_CONTAINER.harden).toBe("agent-harden");
    expect(LEG_CONTAINER.agreement).toBe("agent-harden");
    expect(LEG_CONTAINER.verify).toBe("agent-app");
    expect(LEG_CONTAINER.testapp).toBe("agent-app");
  });

  test("order: the test-app swappers run after the read-only legs and before hang", () => {
    const at = (l: Leg) => LEG_ORDER.indexOf(l);
    expect(at("coverage-differential")).toBeLessThan(at("harden"));
    expect(at("harden")).toBeLessThan(at("verify"));
    expect(at("verify")).toBeLessThan(at("testapp"));
    expect(at("testapp")).toBeLessThan(at("agreement"));
    expect(at("agreement")).toBeLessThan(at("hang"));
  });
});

describe("default-deny", () => {
  test("a path matching no rule selects the FULL SET, never nothing", () => {
    // The property that makes this table safe to be wrong.
    const s = selectLegs(["packages/somewhere-new/src/thing.ts"]);
    expect(s.legs).toEqual(FULL_SET.filter((l) => LEG_ORDER.includes(l)));
    expect(s.unmatched).toEqual(["packages/somewhere-new/src/thing.ts"]);
  });

  test("builtin-tier2 is matched, because the first draft of this table forgot it", () => {
    // The concrete miss: Tier-2 operators are exercised only by tables and chunked, and with no
    // rule and no default-deny they would have run zero live legs.
    const s = selectLegs(["packages/builtin-tier2/src/remove-test-field.ts"]);
    expect(s.unmatched).toEqual([]);
    expect(s.legs).toContain("tables");
    expect(s.legs).toContain("chunked");
  });

  test("an empty change set throws rather than answering 'no legs'", () => {
    expect(() => selectLegs([])).toThrow(GateSelectionError);
  });
});

describe("rows union, they never override", () => {
  test("publisher.ts gets the general runner legs AND stale-publish", () => {
    const s = selectLegs(["packages/runner/src/publisher.ts"]);
    // The general row's legs survive the specific row.
    expect(s.legs).toContain("bcdev");
    expect(s.legs).toContain("lease");
    expect(s.legs).toContain("tables");
    expect(s.legs).toContain("chunked");
    expect(s.legs).toContain("alrunner-v3");
    // And the specific row adds the one gate that races two publishes.
    expect(s.legs).toContain("stale-publish");
  });

  test("run-mutant-transport.ts adds hang to the general runner legs", () => {
    // The under-selection a first-match rule would cause: hang is the only gate with a
    // non-terminating mutant, and the only one asserting a client abort is not promoted to
    // timeout-killed.
    const s = selectLegs(["packages/runner/src/run-mutant-transport.ts"]);
    expect(s.legs).toContain("hang");
    expect(s.legs).toContain("bcdev");
  });

  test("coverage code adds the differential to the general runner legs", () => {
    const s = selectLegs(["packages/runner/src/coverage-split.ts"]);
    expect(s.legs).toContain("coverage-differential");
    expect(s.legs).toContain("tables");
  });

  test("two paths union their selections", () => {
    const s = selectLegs([
      "fixtures/sandbox-data/src/DataMain.Table.al",
      "fixtures/sandbox-app/src/Sandbox.Codeunit.al",
    ]);
    expect(s.legs).toContain("tables");
    expect(s.legs).toContain("chunked");
    expect(s.legs).toContain("bcdev");
    expect(s.legs).toContain("alrunner-v3");
  });
});

describe("what selects nothing, and what parks", () => {
  test("docs select no live legs", () => {
    expect(selectLegs(["docs/roadmap/R223.md"]).legs).toEqual([]);
    expect(selectLegs(["README.md"]).legs).toEqual([]);
  });

  test("a doc alongside code still runs the code's legs", () => {
    const s = selectLegs(["docs/roadmap/R223.md", "packages/engine/src/ast.ts"]);
    expect(s.legs).toContain("bcdev");
  });

  test("scripts select no live legs, but the executor's own directory is not 'scripts'", () => {
    expect(selectLegs(["scripts/census-operator-sites.ts"]).legs).toEqual([]);
    // agentflow is excluded from that row, so it falls through to default-deny rather than
    // being treated as an ordinary script. It is a protected path anyway, but the table must not
    // be the thing that says a change to the executor needs no gates.
    const s = selectLegs(["scripts/agentflow/gate-table.ts"]);
    expect(s.unmatched).toEqual(["scripts/agentflow/gate-table.ts"]);
    expect(s.legs.length).toBeGreaterThan(0);
  });

  test("env-tool paths park with a reason and select no legs", () => {
    const s = selectLegs(["packages/runner/src/env-tool.ts"]);
    expect(s.park).toHaveLength(1);
    expect(s.park[0]).toContain("manual-only");
    // It still matches the general runner row, so it is not silently ungated: it is parked.
    expect(s.legs).toContain("bcdev");
  });

  test("the control app selects the full set", () => {
    const s = selectLegs(["extensions/lethal-control/src/Control.Codeunit.al"]);
    for (const l of FULL_SET) expect(s.legs).toContain(l);
  });
});

describe("fixture rows", () => {
  test("each fixture and its test suite select the same legs", () => {
    expect(selectLegs(["fixtures/sandbox-tests/Sandbox.Test.al"]).legs).toEqual(
      selectLegs(["fixtures/sandbox-app/src/Sandbox.Codeunit.al"]).legs,
    );
    expect(selectLegs(["fixtures/sandbox-data-tests/Data.Test.al"]).legs).toEqual(
      selectLegs(["fixtures/sandbox-data/src/DataMain.Table.al"]).legs,
    );
    expect(selectLegs(["fixtures/sandbox-hang-tests/Hang.Test.al"]).legs).toEqual(
      selectLegs(["fixtures/sandbox-hang/src/Hang.Codeunit.al"]).legs,
    );
  });

  test("the probes fixture selects bcdev and lease", () => {
    const s = selectLegs(["fixtures/sandbox-probes/Probe.Codeunit.al"]);
    expect(s.legs).toEqual(["bcdev", "lease"]);
  });
});

describe("ordering and containers", () => {
  test("hang is last in the ORDER ITSELF, not merely last in one selection", () => {
    // Asserting `legs[legs.length - 1] === "hang"` on a selection is a test that passes for the
    // wrong reason: the control-app selection happens not to include coverage-differential, so
    // hang trails it whether or not the order is right. Red-checked by swapping the last two
    // entries of LEG_ORDER, which that weaker assertion did not catch and this one does.
    //
    // The property is real: hang's OFF leg strands an operation marker by design and its cleanup
    // is best-effort, so anything scheduled after it can be red for hang's residue.
    expect(LEG_ORDER[LEG_ORDER.length - 1]).toBe("hang");
  });

  test("a selection containing both hang and the differential runs hang second", () => {
    const s = selectLegs([
      "packages/runner/src/run-mutant-transport.ts",
      "packages/runner/src/coverage-split.ts",
    ]);
    expect(s.legs).toContain("hang");
    expect(s.legs).toContain("coverage-differential");
    expect(s.legs.indexOf("coverage-differential")).toBeLessThan(s.legs.indexOf("hang"));
  });

  test("returned legs are in destructive-residue order", () => {
    const s = selectLegs(["extensions/lethal-control/src/Control.Codeunit.al"]);
    expect(s.legs.indexOf("bcdev")).toBeLessThan(s.legs.indexOf("lease"));
  });

  test("bcdev precedes lease wherever both are selected", () => {
    const s = selectLegs(["packages/runner/src/store.ts"]);
    expect(s.legs.indexOf("bcdev")).toBeLessThan(s.legs.indexOf("lease"));
  });

  test("every leg is ordered and assigned a container", () => {
    // A leg added to LEGS without a place in the order or a container would otherwise run last by
    // accident, or against whichever container happened to be leased.
    for (const l of LEG_ORDER) expect(LEG_CONTAINER[l]).toBeDefined();
    const ordered = new Set<Leg>(LEG_ORDER);
    for (const l of Object.keys(LEG_CONTAINER) as Leg[]) expect(ordered.has(l)).toBe(true);
  });

  test("the two fixtures never share a container", () => {
    // At most one instrumented target per container, so the codeunit and table fixtures are pinned
    // apart. bcdev and tables sharing a container would trip the attestation mismatch.
    expect(LEG_CONTAINER.bcdev).not.toBe(LEG_CONTAINER.tables);
    expect(LEG_CONTAINER.chunked).toBe(LEG_CONTAINER.tables);
    expect(LEG_CONTAINER.hang).toBe(LEG_CONTAINER.bcdev);
  });
});

describe("the structural delta may only widen", () => {
  test("delta legs are added and existing ones kept", () => {
    const base = selectLegs(["docs/roadmap/R223.md"]);
    expect(base.legs).toEqual([]);
    const widened = widenWithDelta(base, ["tables"]);
    expect(widened.legs).toEqual(["tables"]);
  });

  test("widening preserves order", () => {
    const base = selectLegs(["fixtures/sandbox-data/src/DataMain.Table.al"]);
    const widened = widenWithDelta(base, ["bcdev"]);
    expect(widened.legs).toEqual(["bcdev", "tables", "chunked"]);
  });

  test("widening with an already-selected leg is a no-op, not a duplicate", () => {
    const base = selectLegs(["fixtures/sandbox-data/src/DataMain.Table.al"]);
    expect(widenWithDelta(base, ["tables"]).legs).toEqual(base.legs);
  });

  test("park and unmatched survive widening", () => {
    const base = selectLegs(["packages/runner/src/env-tool.ts"]);
    const widened = widenWithDelta(base, ["hang"]);
    expect(widened.park).toEqual(base.park);
  });
});

describe("path normalisation", () => {
  test("Windows separators are handled, since this repo runs on Windows", () => {
    const s = selectLegs(["packages\\builtin-tier2\\src\\thing.ts"]);
    expect(s.unmatched).toEqual([]);
    expect(s.legs).toContain("tables");
  });
});
