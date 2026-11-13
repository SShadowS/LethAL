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
  AlRunnerV3IsolateTestsRefusedError,
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
/** R937: the test codeunit ids the backend runs one-shot inside its serve session. */
const oneShotOf = (b: AlRunnerV3Backend): number[] => [
  ...(b as unknown as { oneShotCodeunits: ReadonlySet<number> }).oneShotCodeunits,
];

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
  opts: {
    src?: string;
    tests?: readonly TestMethodRef[];
    version?: string;
    sha?: string;
  } = {},
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
      environmentChoice: { value: "saas", source: "config" },
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
    binarySha256: opts.sha ?? "0",
  };
  b.useDiscoveredTests(opts.tests ?? PLAIN);
  return { b, spawns, warnings };
}

// R782: edge a157b2d34, the one pin that records #5798 fixed.
const FIXED_VERSION = "al-runner 3.0.0-alpha.5+edge.20261025 (a157b2d34)";
const FIXED_SHA = "d9429e53a6938dbafb58108f61ce5408f65389bd9604ff94b4788ef26c8d17fb";
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
  });

  test("R896 (build review 2): an auto resume keeps serve-entries; a forced-test resume still falls back", async () => {
    const auto = await rig({ ...DEFAULT, isolation: "auto" });
    await auto.b.decideTransport({ resume: true });
    expect(auto.b.inRunStopIsBudget).toBe(false);
    expect(auto.warnings).toEqual([]);
    const forced = await rig({ ...DEFAULT, isolation: "test" });
    await forced.b.decideTransport({ resume: true });
    expect(forced.b.inRunStopIsBudget).toBe(true);
    expect(forced.warnings.map((w) => w.code)).toEqual([FALLBACK]);
    expect(forced.warnings[0]?.message).toContain("resume:");
  });

  test("R918: a multi-object file and a wrapped file no longer fall back (legs MOE and WRE)", async () => {
    for (const src of [MULTI_AL, WRAPPED_AL]) {
      const r = await rig(DEFAULT, { src });
      await r.b.decideTransport({ resume: false });
      expect(r.b.inRunStopIsBudget).toBe(false);
      expect(r.warnings).toEqual([]);
    }
  });

  test("reason unproven-test-name-shape (method): with another reason, or an isolation mode, the whole session falls back", async () => {
    // R763: "1st" and "has space" are proven since leg N1S; the dot and `ø` are not.
    for (const method of ["Dot.Step", "AØ Step", "Pct%Step"]) {
      const r = await rig(DEFAULT, { tests: [...PLAIN, ref(method)] });
      await r.b.decideTransport({ resume: true });
      expect(r.b.inRunStopIsBudget).toBe(true);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]?.message).toContain("unproven-test-name-shape");
      expect(oneShotOf(r.b)).toEqual([]);
    }
    // R937: an isolation mode (one entry per test) keeps the whole-session reason
    const a = await rig({ ...DEFAULT, isolation: "auto" }, { tests: [...PLAIN, ref("Pct%Step")] });
    await a.b.decideTransport({ resume: false });
    // "auto" is the default isolation: it takes the per-codeunit path, never the whole fallback
    expect(a.b.inRunStopIsBudget).toBe(false);
    expect(oneShotOf(a.b)).toEqual([50100]);
    const m = await rig(
      { ...DEFAULT, isolation: "method" },
      { tests: [...PLAIN, ref("Pct%Step")] },
    );
    await expect(m.b.decideTransport({ resume: false })).rejects.toThrow(
      "unproven-test-name-shape",
    );
  });

  test("R937: on the default transport only the codeunit holding an unproven method runs one-shot; serve stays on, the warning names it", async () => {
    const odd = { ...ref("Pct%Step", "Odd Tests"), codeunitId: 50101 };
    const r = await rig(DEFAULT, { tests: [...PLAIN, odd] });
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(false); // serve-entries
    expect(oneShotOf(r.b)).toEqual([50101]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe(FALLBACK);
    const message = r.warnings[0]?.message ?? "";
    expect(message).toContain('codeunit 50101 "Odd Tests"');
    expect(message).toContain('method "Pct%Step" ("%")');
    expect(message).not.toContain("50100");
    expect(message).not.toContain("runs one-shot, not the serve-entries default");
    // an explicit transport keeps today's behaviour: no check, nothing one-shot, no warning
    const e = await rig({ transportSource: "explicit" }, { tests: [...PLAIN, odd] });
    await e.b.decideTransport({ resume: false });
    expect(oneShotOf(e.b)).toEqual([]);
    expect(e.warnings).toEqual([]);
  });

  test("R782: on a #5798-fixed build a dotted method no longer falls back; an unproven shape still does", async () => {
    const fixed = { version: FIXED_VERSION, sha: FIXED_SHA };
    const r = await rig(DEFAULT, { tests: [...PLAIN, ref("Dot.Step")], ...fixed });
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.warnings).toEqual([]);
    // the dot is read like an inner character only: edge dots and other unseen characters still fall back
    for (const method of [
      ".Step",
      "Step.",
      "A..B",
      "Ø.Step",
      "Pct%Step",
      "A.B.C",
      "A .B",
      "A. B",
      "Ab.(C)",
    ]) {
      // R937: still unproven, so its codeunit (and only it) runs one-shot, named in the warning
      const o = await rig(DEFAULT, { tests: [...PLAIN, ref(method)], ...fixed });
      await o.b.decideTransport({ resume: false });
      expect([method, oneShotOf(o.b)]).toEqual([method, [50100]]);
      expect(o.warnings[0]?.message).toContain("not proven for");
    }
    // R937: proven since coord R-957; with a dot beside it still reads through the row fields
    const colon = await rig(DEFAULT, { tests: [...PLAIN, ref("Colon:Step")], ...fixed });
    await colon.b.decideTransport({ resume: false });
    expect(oneShotOf(colon.b)).toEqual([]);
    expect(colon.warnings).toEqual([]);
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

  // R922 item 3 (R-929): a codeunit's name never reaches serve (rows and requests go by id), so no
  // codeunit name falls back; measured per mutant equal on an invented app with these names.
  test("R922 (3): no codeunit name falls back, whatever its characters", async () => {
    for (const codeunit of [
      "Tests Ø Codeunit",
      "Names A:B Tests",
      "Names A'B Tests",
      "-Lead Names Tests",
      "(Lead) Names Tests",
      "/Lead Names Tests",
    ]) {
      const r = await rig(DEFAULT, { tests: [ref("Check", codeunit)] });
      await r.b.decideTransport({ resume: false });
      expect([codeunit, r.b.inRunStopIsBudget]).toEqual([codeunit, false]);
      expect(r.warnings).toEqual([]);
    }
  });

  test("R922: an unproven METHOD is named as the method, with its character, not the codeunit", async () => {
    const r = await rig(DEFAULT, { tests: [...PLAIN, ref("Pct%Step")] });
    await r.b.decideTransport({ resume: true }); // the whole-session text; R937's per-codeunit text names the codeunit
    const message = r.warnings[0]?.message ?? "";
    expect(message).toContain('method "Pct%Step" ("%")');
    expect(message).not.toContain("codeunit");
  });

  // R922: each codeunit-name shape the invented app ran under serve and one-shot, 48 of 48 equal.
  test("R922: the codeunit shapes measured under serve no longer fall back", async () => {
    for (const codeunit of [
      "Names A/B Tests",
      "Names A-B Tests",
      "Names (A) Tests",
      "Names A&B Tests",
      "Names Blåbær Tests",
      "7Digit Names Tests",
      "ERM WHT G/L Account",
      "SAF-T Tests",
      "Subc. Non-Inv Item Valid. Test",
    ]) {
      const r = await rig(DEFAULT, { tests: [ref("CheckIt", codeunit)] });
      await r.b.decideTransport({ resume: false });
      expect([codeunit, r.b.inRunStopIsBudget]).toEqual([codeunit, false]);
      expect(r.warnings).toEqual([]);
    }
  });

  test("the name shapes are the measured ones: methods only", () => {
    expect(V3_SERVE_PROVEN_NAME_SHAPES.method.test("Plain_1")).toBe(true);
    expect(Object.keys(V3_SERVE_PROVEN_NAME_SHAPES)).toEqual(["method"]);
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
    for (const name of ["Dot.Step", "AØ Step", "Tab\tStep", ""]) {
      expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, false]);
    }
    // red when only the character set is checked: N1S never ran these positions
    for (const name of [" Step", "Step ", "Two  Spaces", "(Step)", "()", "   "]) {
      expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, false]);
    }
  });

  // R937 (coord R-957): the 15 shapes of /coord/handoff/R-957/shapes/result.md, 97 mutants equal.
  test("R937: exactly the 15 names of /coord/handoff/R-957/shapes/make.ts are proven; the unmeasured variants are not", async () => {
    // red when the pattern is narrower than the measurement. The names, as in make.ts's SHAPES list.
    const MEASURED = [
      "PlainCheck",
      "Dot.Check",
      "-Check",
      "+Check",
      "_Check",
      "7Check",
      "A:Check",
      "A'Check",
      "ØCheck",
      "ÆCheck",
      "ÅCheck",
      "A Check",
      "A#Check",
      "A&Check",
      "A(Check",
    ];
    expect(MEASURED).toHaveLength(15);
    for (const name of MEASURED) {
      // the dot is not in the pattern: a #5798-fixed build reads it through the row fields
      const fixed = name === "Dot.Check";
      const r = await rig(DEFAULT, {
        tests: [...PLAIN, ref(name)],
        ...(fixed ? { version: FIXED_VERSION, sha: FIXED_SHA } : {}),
      });
      await r.b.decideTransport({ resume: false });
      expect([name, oneShotOf(r.b), r.warnings]).toEqual([name, [], []]);
      if (!fixed)
        expect([name, V3_SERVE_PROVEN_NAME_SHAPES.method.test(name)]).toEqual([name, true]);
    }
    // red when the pattern is wider than the measurement: none of these ran
    for (const name of [
      "AØCheck",
      "AÆCheck",
      "AÅCheck",
      "A+Check",
      "A:",
      "A:",
      "Check#",
      "Check'",
      "A::Check",
      "+ Check",
      "- Check",
      "-",
      "+",
      "_",
      "AøCheck",
      'A"Check',
      "A\\Check",
      "A*Check",
      "A%Check",
      "A,Check",
      " Check",
      "Check ",
      ")Check",
      "A.Check",
      ".Check",
    ]) {
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
    for (const name of ["resume:", "unproven-test-name-shape", "no-serve-build"]) {
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

  test("R782: explicit serve with a dotted name is NOT refused on a build whose pin records #5798 fixed", async () => {
    const r = await rig(
      { transportSource: "explicit" },
      { tests: [...PLAIN, ref("Dot.Step")], version: FIXED_VERSION, sha: FIXED_SHA },
    );
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.b.isServeRowFields()).toBe(true);
  });

  test("R782: the same sha under another version line, and the dcdf9e821 pin, still refuse", async () => {
    for (const [version, sha] of [
      ["al-runner 3.0.0-alpha.5+edge.20261025 (other)", FIXED_SHA],
      [
        "al-runner 3.0.0-alpha.5+edge.20261024 (dcdf9e821)",
        "0e3139359b37a7dd9c51377b64c0ae1acdcb208545f79075e4194571bbe03890",
      ],
    ] as const) {
      const r = await rig(
        { transportSource: "explicit" },
        { tests: [ref("Dot.Step")], version, sha },
      );
      const err = await r.b.decideTransport({ resume: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlRunnerV3ServeDottedTestNameError);
      expect(r.b.isServeRowFields()).toBe(false);
    }
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

describe("R857: --isolate-tests needs serve-entries", () => {
  const ON = { ...DEFAULT, isolateTests: true } as const;
  const ISOLATE_NOTE = "al-runner-v3-isolate-tests";

  test("each way to one-shot is refused by name, with its reason", async () => {
    const cases: readonly [Rig, string][] = [
      [await rig(ON, { version: V3_NO_SERVE_ENTRIES[0] ?? "" }), "no-serve-build"],
      [await rig({ ...ON, serveFallbackWarmup: "Codeunit1.X: refused" }), "the warm-up:"],
      [
        await rig({ transportSource: "explicit", transport: "one-shot", isolateTests: true }),
        "one-shot",
      ],
    ];
    for (const [r, why] of cases) {
      const err = await r.b.decideTransport({ resume: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlRunnerV3IsolateTestsRefusedError);
      expect((err as Error).message).toContain(why);
      expect(r.warnings.map((w) => w.code)).not.toContain(ISOLATE_NOTE);
    }
  });

  test("a resume stays on serve-entries; the same resume without the flag falls back", async () => {
    const on = await rig(ON);
    await on.b.decideTransport({ resume: true });
    expect(on.b.inRunStopIsBudget).toBe(false);
    expect(on.warnings.map((w) => w.code)).toEqual([ISOLATE_NOTE]);
    const off = await rig(DEFAULT);
    await off.b.decideTransport({ resume: true });
    expect(off.b.inRunStopIsBudget).toBe(true);
  });

  test("a run with the flag says so once; a run without it says nothing", async () => {
    const on = await rig(ON);
    await on.b.decideTransport({ resume: false });
    expect(on.warnings.map((w) => w.code)).toEqual([ISOLATE_NOTE]);
    const off = await rig(DEFAULT);
    await off.b.decideTransport({ resume: false });
    expect(off.warnings).toEqual([]);
  });
});

describe("R786: the one-shot re-run after a serve warm-up fallback", () => {
  const WHY =
    "Codeunit50100.B (codeunit 50100): NotRun: out-of-scope: FindSet on the Company table";

  test("one-shot, ONE named warning that names the row and its reason, no process started", async () => {
    const r = await rig({ ...DEFAULT, serveFallbackWarmup: WHY });
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(true); // one-shot
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe("al-runner-v3-serve-default-fallback-warmup");
    expect(r.warnings[0]?.message).toContain(WHY);
    expect(r.spawns).toEqual([]);
    // Nothing of a serve attempt: this backend never sent an entry, started a daemon or prefetched.
    const s = r.b.entriesStats();
    expect([s.daemons, s.warmups, s.entriesSent, s.prefetchRequests, s.liveRequests]).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  test("without the fact, the default still picks serve-entries and says nothing", async () => {
    const r = await rig(DEFAULT);
    await r.b.decideTransport({ resume: false });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  test("--workers > 1 after a fallback is refused by name (parallel needs serve-entries)", async () => {
    const r = await rig({ ...DEFAULT, serveFallbackWarmup: WHY });
    await r.b.decideTransport({ resume: false });
    expect(r.b.parallelRefusal()).toStartWith("al-runner-v3-workers-refused:");
    expect(r.b.parallelRefusal()).toContain("needs the serve-entries transport");
  });

  test("an explicit transport ignores the fact (the fallback is for the default only)", async () => {
    const r = await rig({
      transport: "serve-entries",
      transportSource: "explicit",
      serveFallbackWarmup: WHY,
    });
    await r.b.decideTransport({ resume: false });
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
