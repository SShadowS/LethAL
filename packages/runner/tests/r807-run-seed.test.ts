// R807: one run seed (ALRUNNER_SEED=1) for every al-runner process LethAL starts, its read-back guard,
// O1's seed judge and the alpha.12 pin. Pre-commitment:
// docs/superpowers/specs/2026-11-05-r807-alpha12-run-seed-precommitment.md (master 94b3337d).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { type O1SeedRequest, judgeO1Seed, o1CdoApps } from "../itest/alrunner-v3-legs";
import { AlRunnerServer, defaultServerSpawn } from "../src/al-runner-server";
import { AlRunnerV3Backend, decodeV3Rows } from "../src/al-runner-v3-backend";
import { findV3Pin } from "../src/al-runner-v3-pins";
import { probeV3PredefinedSymbols } from "../src/al-runner-v3-probe";
import {
  AlRunnerV3SeedError,
  V3_RUN_SEED,
  checkRunSeed,
  mergeChildEnv,
  v3ChildEnv,
  v3UnpinnedEnv,
} from "../src/al-runner-v3-seed";
import type { ArtifactIo } from "../src/artifact";
import { type SpawnFn, defaultSpawn } from "../src/publisher";
import { fakeAlRunnerServer } from "./helpers/fake-al-runner-server";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { legacyBuildReport } from "./helpers/legacy-report";

const AMBIENT = "7";
const withAmbientSeed = async <T>(f: () => Promise<T>): Promise<T> => {
  const saved = process.env.ALRUNNER_SEED;
  process.env.ALRUNNER_SEED = AMBIENT;
  try {
    return await f();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "ALRUNNER_SEED");
    else process.env.ALRUNNER_SEED = saved;
  }
};
const echoSeed = [
  process.execPath,
  "-e",
  "process.stdout.write(process.env.ALRUNNER_SEED ?? 'none')",
];

describe("(a) every spawn path sets the variable, and an ambient value does not win", () => {
  test("the constant is 1", () => {
    expect(V3_RUN_SEED).toBe(1);
    expect(v3ChildEnv({ ALRUNNER_CACHE: "/c" })).toEqual({
      ALRUNNER_CACHE: "/c",
      ALRUNNER_SEED: "1",
    });
  });

  test("a real child of defaultSpawn (one-shot) reads 1 beside an ambient 7", async () => {
    await withAmbientSeed(async () => {
      expect((await defaultSpawn(echoSeed, { env: v3ChildEnv() })).stdout).toBe("1");
      // other direction: with no env option the child inherits the ambient value, so the env option is what pins
      expect((await defaultSpawn(echoSeed)).stdout).toBe(AMBIENT);
    });
  });

  test("a real child of defaultServerSpawn (serve) reads 1 beside an ambient 7", async () => {
    await withAmbientSeed(async () => {
      const read = async (env?: Record<string, string | undefined>): Promise<string> => {
        const h = defaultServerSpawn(echoSeed, env !== undefined ? { env } : undefined);
        let out = "";
        for await (const c of h.stdout) out += new TextDecoder().decode(c);
        await h.wait?.();
        return out;
      };
      expect(await read(v3ChildEnv())).toBe("1");
      // O1's sensitivity daemon: the variable is REMOVED, even an ambient one
      expect(await read(v3UnpinnedEnv())).toBe("none");
    });
  });

  test("v3UnpinnedEnv removes upstream's fallback name too, even when it is ambient", async () => {
    const saved = process.env.AL_RUNNER_SEED;
    process.env.AL_RUNNER_SEED = AMBIENT;
    try {
      expect(mergeChildEnv(v3UnpinnedEnv()).AL_RUNNER_SEED).toBeUndefined();
      expect("AL_RUNNER_SEED" in mergeChildEnv(v3UnpinnedEnv())).toBe(false);
      // other direction: the plain merge keeps it, so the removal is what does the work
      expect(mergeChildEnv({}).AL_RUNNER_SEED).toBe(AMBIENT);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "AL_RUNNER_SEED");
      else process.env.AL_RUNNER_SEED = saved;
    }
  });

  test("mergeChildEnv: undefined removes, a value overrides, the rest is kept", () => {
    const m = mergeChildEnv({ ALRUNNER_SEED: undefined, LETHAL_R807_X: "x" });
    expect("ALRUNNER_SEED" in m).toBe(false);
    expect(m.LETHAL_R807_X).toBe("x");
    // A key taken from the environment: Windows spells PATH `Path`, and only process.env ignores case.
    const kept = Object.keys(process.env).find((k) => k !== "ALRUNNER_SEED") ?? "";
    expect(kept).not.toBe("");
    expect(m[kept]).toBe(process.env[kept]);
  });

  test("the contract-free probe (predefined symbols) starts v3 with the seed", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const spawn: SpawnFn = async (_argv, opts) => {
      seen.push(opts?.env);
      return { exitCode: 2, stdout: "", stderr: "" };
    };
    await probeV3PredefinedSymbols({
      alRunnerPath: "/fake/al-runner",
      packagesDir: "/fake/pkgs",
      bcVersion: "28.0.0.0",
      spawn,
    }).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(e?.ALRUNNER_SEED).toBe("1");
  });
});

// ---- the backend: --version, one-shot calls and the kill pair -----------------------------------
const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const CU = 79100;
let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});
beforeAll(async () => {
  await initParser();
});

const fakeApp = (id: string): Buffer =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="X" Publisher="LethAL" Version="1.0.0.0" /></Package>`,
  });

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "lethal-r807-"));
  roots.push(root);
  const [batch, testDir, deps] = ["batch", "tests", "deps"].map((d) => join(root, d)) as [
    string,
    string,
    string,
  ];
  for (const d of [batch, testDir, deps]) await mkdir(d, { recursive: true });
  await writeFile(
    join(batch, "app.json"),
    JSON.stringify({ id: TARGET_ID, name: "T", version: "1.0.0.0" }),
  );
  await writeFile(
    join(batch, "mutant-manifest.json"),
    JSON.stringify({
      artifactId: "0123456789abcdef0123456789abcdef",
      mutants: [{ mutantId: "M0001", objectType: "Codeunit", codeunitId: 79000 }],
    }),
  );
  await writeFile(join(batch, "MutationSelector.Codeunit.al"), "codeunit 79199 x { }");
  await writeFile(
    join(batch, "Logic.Codeunit.al"),
    'codeunit 79000 "Logic"\n{\n    procedure Twice(X: Integer): Integer\n    begin\n        exit(X * 2);\n    end;\n}\n',
  );
  await writeFile(
    join(testDir, "app.json"),
    JSON.stringify({ id: "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7", name: "Tests" }),
  );
  await writeFile(
    join(testDir, "Tests.Codeunit.al"),
    `codeunit ${CU} "Tests"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n`,
  );
  await writeFile(
    join(deps, "Microsoft_System.app"),
    fakeApp("8874ed3a-0643-4247-9ced-7a7002f7135d"),
  );
  return { root, batch, testDir, deps, scratch: join(root, "scratch") };
}

const alcIo: ArtifactIo = {
  spawn: async (argv) => {
    const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
    await writeFile(out, "app");
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  readArtifact: async (p) => new Uint8Array(await readFile(p)),
  writeArtifact: async (from, to) => {
    await rename(from, to);
  },
};

/** A fake v3: records each call's env; the test `A` passes with no mutant and fails under M0001. */
function fakeV3(extraEnvelope: Record<string, unknown> = {}) {
  const calls: { argv: string[]; env: Record<string, string> | undefined }[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv: [...argv], env: opts?.env });
    if (argv[1] === "--version")
      return { exitCode: 0, stdout: "alrunner 3.0.0-alpha.2 (91253f2d6)\n", stderr: "" };
    const active = argv.at(-2) ?? "";
    const sel = await readFile(join(active, "MutationSelector.Codeunit.al"), "utf8");
    const mutant = /MutantId = '([^']+)'/.exec(sel)?.[1] ?? "";
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const tests = [
      {
        codeunit: cu,
        codeunitName: "Tests",
        durationMs: 0,
        method: "A",
        name: `Codeunit${cu}.A`,
        status: mutant === "" ? "pass" : "fail",
        ...(mutant === "" ? {} : { message: "Assert.AreEqual failed" }),
      },
    ];
    return {
      exitCode: mutant === "" ? 0 : 1,
      stdout: JSON.stringify({ tests, exitCode: 0, ...extraEnvelope }),
      stderr: "",
    };
  };
  return { spawn, calls };
}

async function backend(spawn: SpawnFn) {
  const l = await layout();
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/alrunner",
      instrumentedDir: l.scratch,
      testDir: l.testDir,
      packagesDir: l.deps,
      bcVersion: "28.0.46665.47126",
      selectorObjectId: 79199,
      alcPath: "/fake/alc",
      coverage: "none",
    },
    spawn,
    alcIo,
  );
  await b.deploy(l.batch);
  return b;
}
const refA = { codeunitId: CU, codeunitName: "Tests", method: "A" };

describe("(a) the backend's own spawns", () => {
  test("--version and every one-shot call carry ALRUNNER_SEED=1", async () => {
    const v3 = fakeV3();
    const b = await backend(v3.spawn);
    await b.status().catch(() => {});
    await b.run(refA, { coverage: "none", timeoutMs: 1000 });
    expect(v3.calls.length).toBeGreaterThanOrEqual(2);
    expect(v3.calls.some((c) => c.argv[1] === "--version")).toBe(true);
    expect(v3.calls.some((c) => c.argv.includes("--codeunit"))).toBe(true);
    for (const c of v3.calls) expect(c.env?.ALRUNNER_SEED).toBe("1");
  });
});

describe("(f) a kill pair under one seed", () => {
  test("NONE passes, M fails, both under seed 1: the difference is scored as a kill, as before", async () => {
    const v3 = fakeV3({ seed: 1, seedSource: "env" });
    const b = await backend(v3.spawn);
    await b.activate(null);
    const none = await b.run(refA, { coverage: "none", timeoutMs: 1000 });
    await b.activate("M0001");
    const m = await b.run(refA, { coverage: "none", timeoutMs: 1000 });
    expect(none.outcome).toBe("pass");
    expect(m.outcome).toBe("fail");
    const tests = v3.calls.filter((c) => c.argv.includes("--codeunit"));
    expect(tests).toHaveLength(2);
    for (const c of tests) expect(c.env?.ALRUNNER_SEED).toBe("1");
    expect(b.observedRunSeed()).toBe(1);
  });

  test("a build reporting no seed leaves the observed seed absent", async () => {
    const v3 = fakeV3();
    const b = await backend(v3.spawn);
    await b.activate(null);
    await b.run(refA, { coverage: "none", timeoutMs: 1000 });
    expect(b.observedRunSeed()).toBeUndefined();
  });

  test("a one-shot answer reading another seed refuses the session by name", async () => {
    const b = await backend(fakeV3({ seed: 2, seedSource: "env" }).spawn);
    await b.activate(null);
    await expect(b.run(refA, { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3SeedError,
    );
  });
});

describe("(c) the read-back guard", () => {
  const doc = (x: Record<string, unknown>) => JSON.stringify({ tests: [], exitCode: 0, ...x });
  test("one-shot: seed 1 / env passes", () => {
    expect(decodeV3Rows(doc({ seed: 1, seedSource: "env" }), 1)).toEqual({ rows: [], seed: 1 });
  });
  test("one-shot: seed 2 is refused", () => {
    expect(() => decodeV3Rows(doc({ seed: 2, seedSource: "env" }), 1)).toThrow(AlRunnerV3SeedError);
  });
  test("one-shot: seedSource fresh is refused", () => {
    expect(() => decodeV3Rows(doc({ seed: 1, seedSource: "fresh" }), 1)).toThrow(
      AlRunnerV3SeedError,
    );
  });
  test("one-shot: seed 1 with source option is refused", () => {
    expect(() => decodeV3Rows(doc({ seed: 1, seedSource: "option" }), 1)).toThrow(
      AlRunnerV3SeedError,
    );
  });
  test("one-shot: no seed is accepted", () => {
    expect(decodeV3Rows(doc({}), 1)).toEqual({ rows: [] });
  });
  test("checkRunSeed returns the seed, or undefined", () => {
    expect(checkRunSeed({ seed: 1, seedSource: "env" }, "t")).toBe(1);
    expect(checkRunSeed({}, "t")).toBeUndefined();
  });

  // Both request paths: `runTests` (the older reader) and `runEntries` (what production uses).
  for (const via of ["runTests", "runEntries"] as const) {
    const serve = async (summary: Record<string, unknown>, enforce = true) => {
      const fake = fakeAlRunnerServer([{ name: "Codeunit1.A", status: "pass" }], { summary });
      const s = new AlRunnerServer("x", fake.spawn, [], "serve");
      s.enforceRunSeed = enforce;
      await s.start(5000, []);
      try {
        if (via === "runTests") await s.runTests({ sourcePaths: [] }, 5000);
        else await s.runEntries({ command: "runTests", test: "Codeunit1." }, 5000);
        return s.lastRunSeed;
      } finally {
        await s.close();
      }
    };
    test(`serve ${via}: seed 1 / env passes and is remembered`, async () => {
      expect(await serve({ seed: 1, seedSource: "env" })).toEqual({ seed: 1, seedSource: "env" });
    });
    test(`serve ${via}: seed 2 is refused`, async () => {
      await expect(serve({ seed: 2, seedSource: "env" })).rejects.toBeInstanceOf(
        AlRunnerV3SeedError,
      );
    });
    test(`serve ${via}: fresh is refused`, async () => {
      await expect(serve({ seed: 1, seedSource: "fresh" })).rejects.toBeInstanceOf(
        AlRunnerV3SeedError,
      );
    });
    test(`serve ${via}: no seed is accepted`, async () => {
      expect(await serve({})).toBeUndefined();
    });
    test(`serve ${via}: the sensitivity daemon (enforce off) reads a fresh seed without refusing`, async () => {
      expect(await serve({ seed: 91, seedSource: "fresh" }, false)).toEqual({
        seed: 91,
        seedSource: "fresh",
      });
    });
  }
});

describe("(g) the run seed reaches the report", () => {
  const BUILD = { version: "al-runner 3.0.0-alpha.12 (d4bc8d3a5)", binarySha256: "ab".repeat(32) };
  const CAPS = {
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
    kind: "al-runner-v3",
    authoritative: false,
  } as const;
  const mutant = {
    mutantId: "M0001",
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: "hash",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "Original();",
    mutatedText: "",
  } as const;
  const report = (
    runnerBuild: { version: string; binarySha256: string; runSeed?: number },
    carried = false,
  ) =>
    legacyBuildReport({
      caps: CAPS,
      baselineGreen: true,
      batches: 1,
      outcomes: [
        { mutant, verdict: "killed", batchIndex: 0, ...(carried ? { carried: true } : {}) },
      ],
      unsupportedTests: [],
      notInstrumented: { totalFiles: 1, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [{ codeunitName: "Tests" }],
      runnerBuild,
    });
  test("a measured context carries runSeed when the build reported one", () => {
    const c = report({ ...BUILD, runSeed: 1 }).validity.executionContexts;
    expect(c).toHaveLength(1);
    expect(c[0]?.runSeed).toBe(1);
    expect(c[0]?.binarySha256).toBe(BUILD.binarySha256);
  });
  test("it is absent when none was reported, and absent on a carried context", () => {
    const none = report(BUILD).validity.executionContexts;
    expect(none[0] !== undefined && "runSeed" in none[0]).toBe(false);
    const carried = report({ ...BUILD, runSeed: 1 }, true).validity.executionContexts;
    expect(carried.every((x) => !("runSeed" in x))).toBe(true);
  });
});

describe("(d) O1's seed judge", () => {
  const same = "SEEDVALUES=5|g|s";
  const q = (message: string | undefined, seed?: unknown, src?: unknown): O1SeedRequest => ({
    message,
    ...(seed !== undefined ? { seed } : {}),
    ...(src !== undefined ? { seedSource: src } : {}),
  });
  // a seed-reporting build: pinned identical and read back 1/env; unpinned differ
  const good = {
    pinned: [q(same, 1, "env"), q(same, 1, "env")],
    sensitive: [q("SEEDVALUES=1|a|b", 11, "fresh"), q("SEEDVALUES=2|c|d", 12, "fresh")],
  };
  test("a seed-reporting build that holds the pin passes", () => {
    expect(judgeO1Seed(good).outcome).toBe("pass");
  });
  test("pinned values that differ are a gate-fail", () => {
    const r = judgeO1Seed({
      ...good,
      pinned: [q(same, 1, "env"), q("SEEDVALUES=6|g|s", 1, "env")],
    });
    expect(r.outcome).toBe("gate-fail");
    expect(r.lines.join()).toContain("pin does not hold");
  });
  test("sensitivity values identical on a seed-reporting build is a gate-fail (a hollow check)", () => {
    const r = judgeO1Seed({ ...good, sensitive: [q(same, 11, "fresh"), q(same, 12, "fresh")] });
    expect(r.outcome).toBe("gate-fail");
    expect(r.lines.join()).toContain("cannot see a difference");
  });
  test("a build that reports no seed and reads identical values passes", () => {
    expect(
      judgeO1Seed({
        pinned: [q(same), q(same)],
        sensitive: [q(same), q(same)],
      }).outcome,
    ).toBe("pass");
  });
  test("a build that reports no seed but reads different values without the variable is a gate-fail", () => {
    expect(
      judgeO1Seed({ pinned: [q(same), q(same)], sensitive: [q(same), q("SEEDVALUES=9|x|y")] })
        .outcome,
    ).toBe("gate-fail");
  });
  test("a build that reports no seed but reads other values pinned than unpinned is a gate-fail (one seed per process)", () => {
    const r = judgeO1Seed({
      pinned: [q(same), q(same)],
      sensitive: [q("SEEDVALUES=9|x|y"), q("SEEDVALUES=9|x|y")],
    });
    expect(r.outcome).toBe("gate-fail");
    expect(r.lines.join()).toContain("with and without the variable");
  });
  test("read-back wrong (seed 2, or source fresh) is a gate-fail", () => {
    expect(judgeO1Seed({ ...good, pinned: [q(same, 2, "env"), q(same, 2, "env")] }).outcome).toBe(
      "gate-fail",
    );
    expect(
      judgeO1Seed({ ...good, pinned: [q(same, 1, "fresh"), q(same, 1, "fresh")] }).outcome,
    ).toBe("gate-fail");
  });
  test("a missing message is a gate-fail, never an empty-vs-empty pass", () => {
    expect(
      judgeO1Seed({ pinned: [q(undefined), q(undefined)], sensitive: [q(undefined), q(undefined)] })
        .outcome,
    ).toBe("gate-fail");
  });
  test("answers that report a seed in only some requests are a gate-fail", () => {
    expect(
      judgeO1Seed({ ...good, sensitive: [q("SEEDVALUES=1|a|b"), q("SEEDVALUES=2|c|d")] }).outcome,
    ).toBe("gate-fail");
  });
});

describe("(e) the alpha.12 pin and O1's app count", () => {
  const A12 = findV3Pin(
    "al-runner 3.0.0-alpha.12 (d4bc8d3a5)",
    "c406b57f178066ebbca3a66d7f6436730b2a1956292a7ccb6120479a93ec12cf",
  );
  const A7 = findV3Pin(
    "al-runner 3.0.0-alpha.7 (2c63a382e)",
    "af19368ded0c3f809877f6042bba1c40175c70fe418733178cbfb96ac7fcbb2d",
  );
  test("alpha.12 is pinned, on the shared readings, with 18 CDO apps", () => {
    expect(A12?.id).toBe("alpha.12-d4bc8d3a5");
    expect(A12?.legT).toBe(A7?.legT);
    expect(A12?.legC).toBe(A7?.legC);
    expect(A12?.o1?.cdoWorkDate).toBe("2026-08-01");
    expect(o1CdoApps(A12)).toBe(18);
  });
  test("other pins, and no pin, keep the default 17", () => {
    expect(o1CdoApps(A7)).toBe(17);
    expect(o1CdoApps(undefined)).toBe(17);
    expect(findV3Pin("al-runner 3.0.0-alpha.12 (d4bc8d3a5)", "0".repeat(64))).toBeUndefined();
  });
});

const startsBinary = (t: string): boolean =>
  /alRunnerPath|AL_RUNNER_V3_DEFAULT_PATH/.test(t) &&
  /(Bun\.spawn|defaultSpawn|defaultServerSpawn|spawnSync|execFile)\)?\(/.test(t);

describe("(b) a spawn of the binary cannot bypass the helper", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const read = (f: string) => readFile(join(SRC, f), "utf8");
  /** Every match of `re` must have `needle` within `reach` characters after it. */
  const eachFollowedBy = (text: string, re: RegExp, needle: string, reach: number) => {
    const hits = [...text.matchAll(re)];
    const bad = hits.filter((m) => !text.slice(m.index, (m.index ?? 0) + reach).includes(needle));
    return { count: hits.length, bad: bad.map((m) => text.slice(m.index, (m.index ?? 0) + 80)) };
  };
  test("the backend: --version, one-shot and serve spawns all take cacheEnv() (which wraps v3ChildEnv)", async () => {
    const t = await read("al-runner-v3-backend.ts");
    const r = eachFollowedBy(t, /this\.(?:serverSpawn|spawn)\(/g, "this.cacheEnv()", 250);
    expect(r.count).toBe(3);
    expect(r.bad).toEqual([]);
    expect(t).toContain("env: v3ChildEnv(");
  });
  test("the probe, the contract probe and doctor wrap their spawns in v3ChildEnv", async () => {
    const probe = eachFollowedBy(
      await read("al-runner-v3-probe.ts"),
      /a\.spawn \?\? defaultSpawn\)\(/g,
      "v3ChildEnv(",
      1500,
    );
    expect(probe.count).toBe(1);
    expect(probe.bad).toEqual([]);
    const c = await read("al-runner-v3-contract.ts");
    expect(eachFollowedBy(c, /spawnIn\(argv/g, "v3ChildEnv()", 150)).toEqual({ count: 1, bad: [] });
    expect(
      eachFollowedBy(c, /env\.serveSpawn \?\? defaultServerSpawn\)\(/g, "v3ChildEnv(", 150),
    ).toEqual({ count: 1, bad: [] });
    expect(
      eachFollowedBy(await read("cli.ts"), /spawn\(\[c\.path, "--version"\]/g, "v3ChildEnv()", 100),
    ).toEqual({ count: 1, bad: [] });
  });
  test("a NEW src file that starts al-runner must import the seed helper", async () => {
    const files = (await readdir(SRC)).filter((f) => f.endsWith(".ts"));
    // files that start the binary (or take its path to a spawn) by their own code; each is covered above or is the helper
    const KNOWN = new Set([
      "al-runner-v3-backend.ts",
      "al-runner-v3-probe.ts",
      "al-runner-v3-contract.ts",
      "al-runner-server.ts",
      "cli.ts",
      "al-runner-v3-seed.ts",
      "publisher.ts",
    ]);
    const offenders: string[] = [];
    for (const f of files) {
      if (KNOWN.has(f)) continue;
      const t = await read(f);
      if (startsBinary(t) && !t.includes("al-runner-v3-seed")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
  test("the scan sees the house idiom (a.spawn ?? defaultSpawn)(...) as well as a plain call", () => {
    expect(startsBinary("const p = alRunnerPath; await (a.spawn ?? defaultSpawn)([p]);")).toBe(
      true,
    );
    expect(startsBinary("const p = alRunnerPath; await defaultSpawn([p]);")).toBe(true);
    expect(startsBinary("const p = alRunnerPath; // no spawn here")).toBe(false);
  });
});
