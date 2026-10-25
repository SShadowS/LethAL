/**
 * R761: serve-entries is the default v3 transport where it is proven; one-shot otherwise, with ONE
 * named warning. Explicit keys are honoured. The decision is made once, before the first v3 process.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { V3_NO_SERVE_ENTRIES as ITEST_NO_SERVE } from "../itest/alrunner-v3-legs";
import {
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3ServeDottedTestNameError,
  AlRunnerV3TransportFrozenError,
  V3_SERVE_PROVEN_NAME_SHAPES,
} from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { V3_NO_SERVE_ENTRIES } from "../src/al-runner-v3-pin";
import type { TestMethodRef } from "../src/backend";

const GOOD_VERSION = "alrunner 3.0.0-alpha.5 (abcdef012)";
const ref = (method: string, codeunitName = "Plain Tests"): TestMethodRef => ({
  codeunitId: 50100,
  codeunitName,
  method,
});
const PLAIN = [ref("A"), ref("B_2")];

const PLAIN_AL = `codeunit 50000 "Plain"\n{\n    procedure P()\n    begin\n    end;\n}\n`;
const MULTI_AL = `${PLAIN_AL}\ncodeunit 50001 "Second"\n{\n    procedure Q()\n    begin\n    end;\n}\n`;
const WRAPPED_AL = `#if CLEAN\n${PLAIN_AL}#endif\n`;

let roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

interface Rig {
  readonly b: AlRunnerV3Backend;
  readonly spawns: string[][];
  readonly warnings: { code: string; message: string }[];
}

async function rig(
  cfg: Partial<AlRunnerV3Config>,
  opts: { src?: string; tests?: readonly TestMethodRef[]; version?: string } = {},
): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "r761-"));
  roots.push(root);
  const src = join(root, "src");
  const testDir = join(root, "test");
  await mkdir(src);
  await mkdir(testDir);
  await writeFile(join(src, "Plain.Codeunit.al"), opts.src ?? PLAIN_AL);
  await writeFile(join(testDir, "T.Codeunit.al"), PLAIN_AL.replace("50000", "50099"));
  const spawns: string[][] = [];
  const warnings: { code: string; message: string }[] = [];
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/al-runner",
      instrumentedDir: join(root, "scratch"),
      testDir,
      packagesDir: join(root, "deps"),
      bcVersion: "28.0.46665.47126",
      selectorObjectId: 50001,
      alcPath: "/fake/alc",
      coverage: "none",
      sourceProjectDir: src,
      transport: "serve-entries",
      ...cfg,
    },
    async (argv) => {
      spawns.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  );
  b.setNotify((code, message) => warnings.push({ code, message }));
  // The pinned build, as `status()` would have recorded it (no process is started here).
  (b as unknown as { build: unknown }).build = {
    version: opts.version ?? GOOD_VERSION,
    binarySha256: "0",
  };
  b.useDiscoveredTests(opts.tests ?? PLAIN);
  return { b, spawns, warnings };
}

const DEFAULT = { transportSource: "default" } as const;
const FALLBACK = "al-runner-v3-serve-default-fallback";

describe("R761: the default transport", () => {
  test("default, no fallback reason: serve-entries, no warning", async () => {
    const r = await rig(DEFAULT);
    expect(r.b.inRunStopIsBudget).toBe(true); // one-shot-safe until decided
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.spawns).toEqual([]);
  });

  test("reason resume: one-shot plus the warning naming it", async () => {
    const r = await rig(DEFAULT);
    await r.b.decideTransport({ resume: true });
    expect(r.b.inRunStopIsBudget).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe(FALLBACK);
    expect(r.warnings[0]?.message).toContain("resume:");
    expect(r.warnings[0]?.message).not.toContain("multi-object-or-wrapped");
  });

  test("reason multi-object-or-wrapped: a multi-object file and a wrapped file each fall back", async () => {
    for (const src of [MULTI_AL, WRAPPED_AL]) {
      const r = await rig(DEFAULT, { src });
      await r.b.decideTransport({ resume: false });
      expect(r.b.inRunStopIsBudget).toBe(true);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]?.code).toBe(FALLBACK);
      expect(r.warnings[0]?.message).toContain("multi-object-or-wrapped: Plain.Codeunit.al");
    }
  });

  test("reason unproven-test-name-shape (method): a dotted or unseen-character method name falls back", async () => {
    // R763: "1st" and "has space" are proven since leg N1S; the dot and `ø` are not.
    for (const method of ["Dot.Step", "Ø Step", "Colon:Step"]) {
      const r = await rig(DEFAULT, { tests: [...PLAIN, ref(method)] });
      await r.b.decideTransport({ resume: false });
      expect(r.b.inRunStopIsBudget).toBe(true);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]?.message).toContain("unproven-test-name-shape");
    }
  });

  test("R763: a method name N1S proved under serve ('Slash/Step', '7Digit Step') no longer falls back", async () => {
    // red when the widening is missing: these method shapes fell back before R763
    for (const method of ["Slash/Step", "7Digit Step", "Blåbær Step"]) {
      const r = await rig(DEFAULT, { tests: [...PLAIN, ref(method)] });
      await r.b.decideTransport({ resume: false });
      expect([method, r.b.inRunStopIsBudget]).toEqual([method, false]);
      expect(r.warnings).toEqual([]);
    }
  });

  test("reason unproven-test-name-shape (codeunit): '/' falls back; a space and a dot do not", async () => {
    const bad = await rig(DEFAULT, { tests: [ref("A", "Tests/Slash")] });
    await bad.b.decideTransport({ resume: false });
    expect(bad.b.inRunStopIsBudget).toBe(true);
    expect(bad.warnings[0]?.message).toContain("unproven-test-name-shape");
    const ok = await rig(DEFAULT, { tests: [ref("A", "CDO Recipient Mgt. Tests")] });
    await ok.b.decideTransport({ resume: false });
    expect(ok.b.inRunStopIsBudget).toBe(false);
    expect(ok.warnings).toEqual([]);
  });

  test("the name shapes are the measured ones", () => {
    expect(V3_SERVE_PROVEN_NAME_SHAPES.method.test("Plain_1")).toBe(true);
    expect(V3_SERVE_PROVEN_NAME_SHAPES.codeunit.test("CDO Recipient Mgt. Tests")).toBe(true);
    expect(V3_SERVE_PROVEN_NAME_SHAPES.codeunit.test("A - B")).toBe(false);
  });

  // R763: leg N1S proved every non-dot method shape in fixtures/sandbox-names-tests under serve.
  test("R763: N1's measured method shapes are proven; the dot and unseen characters are not", () => {
    // red when the widening is missing: each of these is a name N1S ran under serve with 0 differences
    for (const name of [
      "Space Step",
      "Dash-Step",
      "Paren(Step)",
      "Slash/Step",
      "Amp&Step",
      "7Digit Step",
      "Blåbær Step",
      "Twin Pair",
      "Twin_PairLong",
    ]) {
      expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, true]);
    }
    // red when the widening is too loose: the dot is #5798, and characters N1S never ran stay unproven
    for (const name of ["Dot.Step", "Ø Step", "Å Step", "Quote'Step", "Colon:Step", "Plus+Step", "Tab\tStep", ""]) {
      expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, false]);
    }
    // red when only the character set is checked: N1S never ran these positions
    for (const name of [" Step", "Step ", "Two  Spaces", "-Step", "(Step)", "()", "   "]) {
      expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, false]);
    }
  });

  test("reason no-serve-build: alpha.2 falls back", async () => {
    const r = await rig(DEFAULT, { version: V3_NO_SERVE_ENTRIES[0] ?? "" });
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.message).toContain("no-serve-build");
  });

  test("every reason that holds is named in the ONE warning", async () => {
    const r = await rig(DEFAULT, {
      src: MULTI_AL,
      tests: [ref("Dot.Step")],
      version: V3_NO_SERVE_ENTRIES[0] ?? "",
    });
    await r.b.decideTransport({ resume: true });
    expect(r.warnings).toHaveLength(1);
    for (const name of [
      "resume:",
      "multi-object-or-wrapped",
      "unproven-test-name-shape",
      "no-serve-build",
    ]) {
      expect(r.warnings[0]?.message).toContain(name);
    }
  });

  test("the src copy of the no-serve builds equals the itest's", () => {
    expect(V3_NO_SERVE_ENTRIES).toEqual(ITEST_NO_SERVE);
  });
});

describe("R761: explicit keys", () => {
  test("explicit one-shot is honoured, even with a clean project", async () => {
    const r = await rig({ transport: "one-shot", transportSource: "explicit" });
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test("explicit serve with plain names: serve, even on a resume", async () => {
    const r = await rig({ transportSource: "explicit" });
    await r.b.decideTransport({ resume: true });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  test("explicit serve with a dotted test method name refuses by name, before any process", async () => {
    const r = await rig({ transportSource: "explicit" }, { tests: [...PLAIN, ref("Dot.Step")] });
    const err = await r.b.decideTransport({ resume: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3ServeDottedTestNameError);
    expect((err as Error).message).toContain("#5798");
    expect((err as Error).message).toContain("Plain Tests.Dot.Step");
    expect((err as Error).message).toContain('"one-shot"');
    expect(r.spawns).toEqual([]);
    expect(r.b.spawnCount).toBe(0);
  });

  test("explicit one-shot with a dotted name is not refused", async () => {
    const r = await rig(
      { transport: "one-shot", transportSource: "explicit" },
      { tests: [ref("Dot.Step")] },
    );
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(true);
  });

  test("an internal caller with no transportSource keeps today's behaviour (no decision, dotted allowed)", async () => {
    const r = await rig({}, { tests: [ref("Dot.Step")], src: MULTI_AL });
    await r.b.decideTransport({ resume: true });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.warnings).toEqual([]);
  });
});

describe("R761: the decision is frozen", () => {
  test("a second decision throws", async () => {
    const r = await rig(DEFAULT);
    await r.b.decideTransport({ resume: false });
    const err = await r.b.decideTransport({ resume: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3TransportFrozenError);
    expect(r.b.inRunStopIsBudget).toBe(false); // unchanged
  });

  test("a decision after a v3 process started throws", async () => {
    const r = await rig(DEFAULT);
    (r.b as unknown as { transportFrozen: boolean }).transportFrozen = true; // what the first spawn sets
    const err = await r.b.decideTransport({ resume: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3TransportFrozenError);
  });
});

describe("R761: the config", () => {
  const base = { packagesDir: "/p", bcVersion: "28.0.1.2" };
  test("no key: serve-entries, source default", () => {
    const c = validateAlRunnerV3Config(base);
    expect([c.transport, c.transportSource]).toEqual(["serve-entries", "default"]);
  });
  test("explicit keys: source explicit", () => {
    for (const t of ["one-shot", "serve-entries"] as const) {
      const c = validateAlRunnerV3Config({ ...base, transport: t });
      expect([c.transport, c.transportSource]).toEqual([t, "explicit"]);
    }
  });
});
