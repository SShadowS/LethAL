// R586: AlRunnerV3Backend against a fake v3 and a fake alc. Plan
// docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md, §3-§6, tests T5, T12, T21, T22,
// T24, T28-T32 and the decoder rows of §5. Every guard has a test per direction.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { initParser } from "@lethal/engine";
import { emitStaticSelector } from "@lethal/schemata";
import {
  AL_RUNNER_V3_VERSION,
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3ResourceSelectorRefusedError,
  AlRunnerV3RowMissingError,
  AlRunnerV3SelectionError,
  AlRunnerV3UnprovenBatchError,
  V3_REFUSED_NEARBY_TAG,
  V3_STATE_NOTE_TAG,
  WINDOW_BOUND_CAVEAT,
  decodeV3Rows,
  stopSecondsOf,
  v3CallArgv,
  v3CallDeadlineMs,
  v3RowVerdict,
} from "../src/al-runner-v3-backend";
import { MESSAGE_PREFIX_REASON, type V3ContractResult } from "../src/al-runner-v3-contract";
import { sha256OfFile } from "../src/al-runner-v3-pin";
import { AlRunnerV3CoverageJoinError } from "../src/al-runner-v3-sleep";
import { AlcCompileError, type ArtifactIo, ArtifactPrepareError } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import type { SpawnFn } from "../src/publisher";
import { TestAppError } from "../src/test-app-publish";
import { ProjectSymlinkRefusedError } from "../src/walk";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const SELECTOR_ID = 79199;
const ARTIFACT = "0123456789abcdef0123456789abcdef";
const CU = 79100;

const TARGET_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const TEST_AL = `codeunit ${CU} "Tests"
{
    Subtype = Test;

    [Test]
    procedure A()
    begin
    end;

    [Test]
    procedure B()
    begin
    end;
}
`;

function fakeApp(id: string): Buffer {
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${id}" Name="X" Publisher="LethAL" Version="1.0.0.0" /></Package>`,
  });
}

const ref = (method: string, codeunitId = CU): TestMethodRef => ({
  codeunitId,
  codeunitName: "Tests",
  method,
});

let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

beforeAll(async () => {
  await initParser();
});

interface Layout {
  readonly root: string;
  readonly batch: string;
  readonly testDir: string;
  readonly deps: string;
  readonly scratch: string;
}

async function layout(targetAl = TARGET_AL, testAl = TEST_AL): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "lethal-v3-"));
  roots.push(root);
  const batch = join(root, "batch");
  const testDir = join(root, "tests");
  const deps = join(root, "deps");
  for (const d of [batch, testDir, deps]) await mkdir(d, { recursive: true });
  await writeFile(
    join(batch, "app.json"),
    JSON.stringify({ id: TARGET_ID, name: "T", version: "1.0.0.0" }),
  );
  await writeFile(
    join(batch, "mutant-manifest.json"),
    JSON.stringify({
      artifactId: ARTIFACT,
      mutants: [
        { mutantId: "M0001", objectType: "Codeunit", codeunitId: 79000 },
        { mutantId: "M0002", objectType: "Codeunit", codeunitId: 79000 },
      ],
    }),
  );
  // The batch arrives with the CONTROL selector; deploy replaces it with the static one.
  await writeFile(
    join(batch, "MutationSelector.Codeunit.al"),
    "codeunit 79199 x { /* dynamic */ }",
  );
  await writeFile(join(batch, "Logic.Codeunit.al"), targetAl);
  await writeFile(
    join(testDir, "app.json"),
    JSON.stringify({ id: "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7", name: "Tests" }),
  );
  await writeFile(join(testDir, "Tests.Codeunit.al"), testAl);
  await writeFile(
    join(deps, "Microsoft_System.app"),
    fakeApp("8874ed3a-0643-4247-9ced-7a7002f7135d"),
  );
  await writeFile(join(deps, "Stale_Target.app"), fakeApp(TARGET_ID));
  return { root, batch, testDir, deps, scratch: join(root, "scratch") };
}

/** A fake alc: records each call, writes a dummy .app, or fails when `fail(project)` says so. */
function fakeAlc(fail: (project: string) => boolean = () => false) {
  const calls: { project: string; cache: string; staged: string[] }[] = [];
  const io: ArtifactIo = {
    spawn: async (argv) => {
      // ArtifactCompiler passes forward slashes on every OS; `normalize` gives them back in the
      // platform's form, so the expectations (built with `join`) compare like with like on Windows.
      const project = normalize(
        (argv.find((a) => a.startsWith("/project:")) ?? "").slice("/project:".length),
      );
      const cache = normalize(
        (argv.find((a) => a.startsWith("/packagecachepath:")) ?? "").slice(18),
      );
      const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
      const { readdir } = await import("node:fs/promises");
      calls.push({ project, cache, staged: (await readdir(cache)).sort() });
      if (fail(project)) return { exitCode: 1, stdout: "error AL0118: NoSuchVar", stderr: "" };
      await writeFile(out, `app of ${project}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readArtifact: async (p) => new Uint8Array(await readFile(p)),
    writeArtifact: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
  };
  return { io, calls };
}

interface FakeRow {
  method: string;
  status: "pass" | "fail" | "error";
  message?: string;
  notRun?: boolean;
}

/**
 * A fake v3: answers `test --codeunit <id>` with `rows(activeId, argv)` and writes `coverage` (or
 * none) to `--coverage-json`. `exit` overrides the exit code.
 */
function fakeV3(
  rows: (activeId: string, argv: readonly string[]) => FakeRow[],
  opts: {
    coverage?: (activeId: string, active: string, testDir: string) => unknown;
    exit?: number;
    stdout?: string;
  } = {},
) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    if (argv[1] === "--version")
      return { exitCode: 0, stdout: "alrunner 3.0.0-alpha.2 (91253f2d6)\n", stderr: "" };
    calls.push([...argv]);
    const active = argv.at(-2) ?? "";
    const testDir = argv.at(-1) ?? "";
    const sel = await readFile(join(active, "MutationSelector.Codeunit.al"), "utf8");
    const activeId = /MutantId = '([^']+)'/.exec(sel)?.[1] ?? "";
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const covPath = argv[argv.indexOf("--coverage-json") + 1] ?? "";
    const cov = opts.coverage?.(activeId, active, testDir);
    if (cov !== undefined) await writeFile(covPath, JSON.stringify(cov));
    const tests = rows(activeId, argv).map((r) => ({
      codeunit: cu,
      codeunitName: "Tests",
      durationMs: 0,
      method: r.method,
      name: `Codeunit${cu}.${r.method}`,
      status: r.status,
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.notRun === true ? { notRun: true } : {}),
    }));
    return {
      exitCode: opts.exit ?? 0,
      stdout: opts.stdout ?? JSON.stringify({ tests, exitCode: 0 }),
      stderr: "",
    };
  };
  return { spawn, calls };
}

/** Per-test coverage where every test hits one statement of its own test file. */
const plainCoverage = (_id: string, _active: string, testDir: string) => ({
  coverage: [
    {
      file: join(testDir, "Tests.Codeunit.al"),
      statements: [
        { line: 7, hits: 1 },
        { line: 12, hits: 1 },
      ],
    },
  ],
  perTestCoverage: ["A", "B"].map((m, i) => ({
    test: `Codeunit${CU}.${m}`,
    coverage: [
      {
        file: join(testDir, "Tests.Codeunit.al"),
        statements: [{ line: i === 0 ? 7 : 12, hits: 1 }],
      },
    ],
  })),
});

function backendOf(
  l: Layout,
  spawn: SpawnFn,
  alcIo: ArtifactIo,
  extra: Partial<AlRunnerV3Config> = {},
) {
  return new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/alrunner",
      instrumentedDir: l.scratch,
      testDir: l.testDir,
      packagesDir: l.deps,
      bcVersion: "28.0.46665.47126",
      selectorObjectId: SELECTOR_ID,
      alcPath: "/fake/alc",
      coverage: "none",
      ...extra,
    },
    spawn,
    alcIo,
  );
}

const allPass = () => [
  { method: "A", status: "pass" as const },
  { method: "B", status: "pass" as const },
];

describe("§3 the compile proof", () => {
  test("deploy compiles the batch, then the test app against the batch app plus <deps> WITHOUT the stale target; v3 not started", async () => {
    const l = await layout();
    const alc = fakeAlc();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, alc.io);
    await b.deploy(l.batch);
    expect(alc.calls.map((c) => c.project)).toEqual([join(l.scratch, "active"), l.testDir]);
    expect(alc.calls[0]?.cache).toBe(l.deps);
    // The stale copy of the target is not in the test app's package cache; the batch app is.
    expect(alc.calls[1]?.staged).toEqual(["Microsoft_System.app", "lethal-v3-batch.app"]);
    expect(v3.calls).toHaveLength(0);
    // The batch v3 reads has the STATIC baseline selector, no control files.
    const sel = await readFile(join(l.scratch, "active", "MutationSelector.Codeunit.al"), "utf8");
    expect(sel).toBe(
      emitStaticSelector({
        objectId: SELECTOR_ID,
        activeId: "",
        artifactId: ARTIFACT,
        targetAppId: "",
      }),
    );
  });

  test("R631: a linked helper folder in the test dir refuses the compile proof by name; v3 not started", async () => {
    const l = await layout();
    await mkdir(join(l.root, "helpers"), { recursive: true });
    await writeFile(join(l.root, "helpers", "H.Codeunit.al"), "codeunit 79150 H { }");
    await symlink(join(l.root, "helpers"), join(l.testDir, "helpers"), "junction");
    const v3 = fakeV3(allPass);
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    const err = await b.deploy(l.batch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((err as Error).message).toContain(join(l.testDir, "helpers"));
    expect(v3.calls).toHaveLength(0);
  });

  test("leg X (a): a batch alc rejects throws AlcCompileError and v3 is spawned 0 times", async () => {
    const l = await layout();
    const alc = fakeAlc((p) => p.endsWith("active"));
    const v3 = fakeV3(allPass);
    const b = backendOf(l, v3.spawn, alc.io);
    await expect(b.deploy(l.batch)).rejects.toBeInstanceOf(AlcCompileError);
    await expect(b.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3UnprovenBatchError,
    );
    expect(v3.calls).toHaveLength(0);
  });

  test("a test app that does not compile against the batch stops the session, and is NOT an AlcCompileError (bisection must not read it as the batch's)", async () => {
    const l = await layout();
    const alc = fakeAlc((p) => p === l.testDir);
    const b = backendOf(l, fakeV3(allPass).spawn, alc.io);
    const err = await b.deploy(l.batch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestAppError);
    expect(err).not.toBeInstanceOf(AlcCompileError);
    expect(String(err)).toMatch(/test app does not compile against this batch/);
  });

  test("compileCheck runs alc alone on a copy, never v3, and never touches the deployed batch", async () => {
    const l = await layout();
    const alc = fakeAlc();
    const v3 = fakeV3(allPass);
    const b = backendOf(l, v3.spawn, alc.io);
    await b.compileCheck(l.batch);
    expect(alc.calls.map((c) => c.project)).toEqual([join(l.scratch, "compile-check")]);
    expect(v3.calls).toHaveLength(0);
    const failing = backendOf(l, v3.spawn, fakeAlc(() => true).io);
    await expect(failing.compileCheck(l.batch)).rejects.toBeInstanceOf(AlcCompileError);
  });
});

describe("M8: status() refuses a package folder with no System Application", () => {
  const versionOnly: SpawnFn = async () => ({
    exitCode: 0,
    stdout: "alrunner 3.0.0-alpha.2 (91253f2d6)\n",
    stderr: "",
  });
  test("none found: refused by name before the pin or the probe", async () => {
    const l = await layout();
    const s = await backendOf(l, versionOnly, fakeAlc().io).status();
    expect(s.ok).toBe(false);
    expect(s.details).toMatch(/al-runner-v3-system-application-not-found/);
  });
  test("other direction: with the System Application at bcVersion, status() goes on to the pin", async () => {
    const l = await layout();
    const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
    await writeFile(
      join(l.deps, "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package ${NS}><App Id="1" Name="System Application" Publisher="Microsoft" Version="28.0.46665.47126" /></Package>`,
      }),
    );
    const bin = join(l.root, "al-runner");
    await writeFile(bin, "binary");
    const s = await backendOf(l, versionOnly, fakeAlc().io, { alRunnerPath: bin }).status();
    expect(s.ok).toBe(false);
    expect(s.details).not.toMatch(/system-application-not-found/);
    expect(s.details).toMatch(/al-runner-v3-ungated-build/);
  });
});

describe("R639 r9 §2: status() passes candidate into the unlike-bc refusals and warnings", () => {
  const VERSION = "al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)";
  const versionOnly: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
  const UNLIKE: V3ContractResult = {
    facts: [
      {
        fact: "refusal-row-shape",
        kind: "defect",
        verdict: "unlike-bc",
        expected: "x",
        measured: "edge text",
      },
    ],
  };
  async function statusOf(candidate: boolean, contract: V3ContractResult = UNLIKE) {
    const l = await layout();
    const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
    await writeFile(
      join(l.deps, "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package ${NS}><App Id="1" Name="System Application" Publisher="Microsoft" Version="28.0.46665.47126" /></Package>`,
      }),
    );
    const bin = join(l.root, "al-runner");
    await writeFile(bin, "binary");
    if (!candidate) {
      await writeFile(
        join(l.root, ".gated"),
        JSON.stringify({
          version: VERSION,
          binarySha256: await sha256OfFile(bin),
          lethalCommit: "a".repeat(40),
        }),
      );
    }
    const b = backendOf(l, versionOnly, fakeAlc().io, {
      alRunnerPath: bin,
      ...(candidate ? { candidate: true } : {}),
    });
    // The probe itself is tested in al-runner-v3-contract.test.ts; seed its result, test the wiring.
    (b as unknown as { contract: V3ContractResult }).contract = contract;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await b.status();
      return { s, warned: warn.mock.calls.map((c) => String(c[0])).join("\n") };
    } finally {
      warn.mockRestore();
    }
  }
  test("a candidate backend warns al-runner-v3-defect-unlike-bc and runs", async () => {
    const { s, warned } = await statusOf(true);
    expect(s.ok).toBe(true);
    expect(warned).toMatch(/al-runner-v3-defect-unlike-bc: refusal-row-shape/);
  });
  test("a non-candidate backend refuses, naming refusal-row-shape", async () => {
    const { s, warned } = await statusOf(false);
    expect(s.ok).toBe(false);
    expect(s.details).toMatch(/UNLIKE-BC — refusal-row-shape/);
    expect(warned).not.toMatch(/unlike-bc/);
  });
  test("R667: a prefixed failure message refuses the session before any mutant is scored, naming K1(a)", async () => {
    const prefixed: V3ContractResult = {
      facts: [
        {
          fact: "message-has-no-type-prefix",
          kind: "contract",
          verdict: "diverged",
          expected: "x",
          measured: 'prefix "SomeException: "; Fails "SomeException: NotRun: out-of-scope: x"',
        },
      ],
    };
    for (const candidate of [false, true]) {
      const { s } = await statusOf(candidate, prefixed);
      expect(s.ok).toBe(false);
      expect(s.details).toContain(`why: ${MESSAGE_PREFIX_REASON}`);
    }
  });
});

describe("T3, T4, T23", () => {
  test("T3: two static selectors differ only in the id literal", () => {
    const a = emitStaticSelector({
      objectId: 7,
      activeId: "M0001",
      artifactId: ARTIFACT,
      targetAppId: "",
    });
    const b = emitStaticSelector({
      objectId: 7,
      activeId: "M0042",
      artifactId: ARTIFACT,
      targetAppId: "",
    });
    expect(a.replace("M0001", "X")).toBe(b.replace("M0042", "X"));
    expect(a).not.toBe(b);
  });

  test("T4: alc that cannot be started is ArtifactPrepareError (the session stops), never AlcCompileError", async () => {
    const l = await layout();
    const io: ArtifactIo = {
      ...fakeAlc().io,
      spawn: async () => {
        throw new Error("ENOENT alc");
      },
    };
    const err = await backendOf(l, fakeV3(allPass).spawn, io)
      .deploy(l.batch)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactPrepareError);
    expect(err).not.toBeInstanceOf(AlcCompileError);
  });

  test("T23: the test app is compiled on EVERY deploy (two deploys, two test-app compiles, two target compiles)", async () => {
    const l = await layout();
    const alc = fakeAlc();
    const b = backendOf(l, fakeV3(allPass).spawn, alc.io);
    await b.deploy(l.batch);
    await b.deploy(l.batch);
    expect(alc.calls.filter((c) => c.project === l.testDir)).toHaveLength(2);
    expect(alc.calls).toHaveLength(4);
  });
});

describe("T22: the proof is bound to the bytes v3 reads (c1-c5)", () => {
  async function deployed() {
    const l = await layout();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0002");
    return { l, v3, b };
  }
  const active = (l: Layout) => join(l.scratch, "active");
  const run = (b: AlRunnerV3Backend) => b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });

  test("an unchanged folder runs (the other direction)", async () => {
    const { b, v3 } = await deployed();
    expect((await run(b)).outcome).toBe("pass");
    expect(v3.calls).toHaveLength(1);
  });

  const cases: [string, (l: Layout) => Promise<void>][] = [
    [
      "c1: a byte appended to a target .al in active/",
      (l) => appendFile(join(active(l), "Logic.Codeunit.al"), " "),
    ],
    [
      "c2: a byte appended to a test .al",
      (l) => appendFile(join(l.testDir, "Tests.Codeunit.al"), " "),
    ],
    [
      "c3: the selector rewritten to an id not in the manifest",
      (l) =>
        writeFile(
          join(active(l), "MutationSelector.Codeunit.al"),
          emitStaticSelector({
            objectId: SELECTOR_ID,
            activeId: "M9999",
            artifactId: ARTIFACT,
            targetAppId: "",
          }),
        ),
    ],
    [
      "c4: the selector rewritten to ANOTHER manifest id than the last activated",
      (l) =>
        writeFile(
          join(active(l), "MutationSelector.Codeunit.al"),
          emitStaticSelector({
            objectId: SELECTOR_ID,
            activeId: "M0001",
            artifactId: ARTIFACT,
            targetAppId: "",
          }),
        ),
    ],
    ["c5: a byte changed in active/app.json", (l) => appendFile(join(active(l), "app.json"), " ")],
    ["c5: one file added to <deps>", (l) => writeFile(join(l.deps, "Extra.app"), "x")],
    [
      "c5: a <deps> file's bytes changed (size moves)",
      (l) => appendFile(join(l.deps, "Microsoft_System.app"), "x"),
    ],
    ["the test app's app.json changed", (l) => appendFile(join(l.testDir, "app.json"), " ")],
    [
      // R631 review L1: drift, never ProjectSymlinkRefusedError (asserted by the class below).
      "R631: a test-dir junction holding an .al appears mid-run",
      async (l) => {
        await mkdir(join(l.root, "helpers"), { recursive: true });
        await writeFile(join(l.root, "helpers", "H.Codeunit.al"), "codeunit 79150 H { }");
        await symlink(join(l.root, "helpers"), join(l.testDir, "helpers"), "junction");
      },
    ],
  ];
  for (const [name, tamper] of cases) {
    test(`${name} -> AlRunnerV3UnprovenBatchError, 0 spawns`, async () => {
      const { l, b, v3 } = await deployed();
      await tamper(l);
      await expect(run(b)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
      expect(v3.calls).toHaveLength(0);
    });
  }

  // R655: active/ is LethAL's own copy and holds no link (measured), so one is drift by name.
  const linkHelpers = async (l: Layout, into: string): Promise<string> => {
    await mkdir(join(l.root, "helpers"), { recursive: true });
    await writeFile(join(l.root, "helpers", "H.Codeunit.al"), "codeunit 79150 H { }");
    const link = join(into, "helpers");
    await symlink(join(l.root, "helpers"), link, "junction");
    return link;
  };

  test("R655: a junction holding an .al added under active/ after deploy is refused at the next send, by path", async () => {
    const { l, b, v3 } = await deployed();
    const link = await linkHelpers(l, active(l));
    const err = await run(b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect((err as Error).message).toContain(link);
    expect(v3.calls).toHaveLength(0);
  });

  test("R655: a link in the batch (cp carries it into active/) is refused at deploy, by path; v3 not started", async () => {
    const l = await layout();
    await linkHelpers(l, l.batch);
    const v3 = fakeV3(allPass);
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    const err = await b.deploy(l.batch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect((err as Error).message).toContain(join(active(l), "helpers"));
    await expect(run(b)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(v3.calls).toHaveLength(0);
  });

  test("activate refuses an id the manifest does not hold", async () => {
    const { b } = await deployed();
    await expect(b.activate("M9999")).rejects.toThrow(/not a mutant of the deployed batch/);
  });

  test("R652 T7: one check per SPAWN: a run served from memory does not check; the next spawn is refused", async () => {
    const { l, b, v3 } = await deployed();
    expect((await run(b)).outcome).toBe("pass");
    expect((await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("pass");
    expect(v3.calls).toHaveLength(1);
    expect(b.entriesStats().boundChecks).toBe(1);
    await appendFile(join(active(l), "Logic.Codeunit.al"), " ");
    // Served from the spawn's rows, which came from the checked bytes.
    expect((await run(b)).outcome).toBe("pass");
    await b.activate("M0002");
    await expect(run(b)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(v3.calls).toHaveLength(1);
  });
});

describe("§4 selection, the cache and T5 / T21 / T28 / T29", () => {
  test("T5: one --codeunit per call, --coverage-json always, no name selection, --no-download with the pinned build", () => {
    const argv = v3CallArgv({
      alRunnerPath: "/b",
      codeunitId: 7,
      stopSeconds: 3,
      packagesDir: "/d",
      bcVersion: "28.0.1.2",
      symbols: ["S1"],
      coverageJson: "/c.json",
      activeDir: "/a",
      testDir: "/t",
    });
    expect(argv.filter((a) => a === "--codeunit")).toHaveLength(1);
    expect(argv).toContain("--coverage-json");
    for (const forbidden of [
      "--test",
      "--test-exact",
      "--filter",
      "--exclude-test",
      "--allow-not-run",
      "--explain",
    ]) {
      expect(argv).not.toContain(forbidden);
    }
    expect(argv.slice(0, 7)).toEqual([
      "/b",
      "test",
      "--output-json",
      "--isolation",
      "test",
      "--test-timeout-secs",
      "3",
    ]);
    expect(argv).toContain("--no-download");
    expect(argv.slice(-2)).toEqual(["/a", "/t"]);
  });

  test("two tests of one codeunit under one activation are ONE call; a mutant call carries --coverage-json", async () => {
    const l = await layout();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 });
    expect(v3.calls).toHaveLength(1);
    expect(v3.calls[0]).toContain("--coverage-json");
  });

  test("T21 (C2): activate(M); run; activate(M); run spawns TWICE (a reproduction is a real re-run)", async () => {
    const l = await layout();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    await b.activate("M0001");
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(v3.calls).toHaveLength(2);
  });

  test("T28: N is the LARGEST planned budget of the call's refs, not the asking ref's own", async () => {
    const l = await layout();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    b.useCoveringBudgets("M0001", [
      { ref: ref("A"), budgetMs: 1500 },
      { ref: ref("B"), budgetMs: 7200 },
    ]);
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1500 });
    const argv = v3.calls[0] ?? [];
    expect(argv[argv.indexOf("--test-timeout-secs") + 1]).toBe("8");
  });

  test("T28 (other direction): the plan of ANOTHER mutant is ignored; a ref of another codeunit does not raise N", async () => {
    const l = await layout();
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    b.useCoveringBudgets("M0002", [{ ref: ref("B"), budgetMs: 9000 }]);
    await b.activate("M0001");
    b.useCoveringBudgets("M0001", [
      { ref: ref("A"), budgetMs: 2000 },
      { ref: ref("Z", 1), budgetMs: 60000 },
    ]);
    await b.run(ref("A"), { coverage: "none", timeoutMs: 2000 });
    const argv = v3.calls[0] ?? [];
    expect(argv[argv.indexOf("--test-timeout-secs") + 1]).toBe("2");
  });

  test("T28: a timeout row must report the stop the call was sent", async () => {
    const timeoutRow = (n: number) => () => [
      {
        method: "A",
        status: "error" as const,
        notRun: true,
        message: `Test exceeded ${n}s timeout.`,
      },
      { method: "B", status: "pass" as const },
    ];
    const l = await layout();
    const good = backendOf(
      l,
      fakeV3(timeoutRow(2), { coverage: plainCoverage }).spawn,
      fakeAlc().io,
    );
    await good.deploy(l.batch);
    await good.activate("M0001");
    const v = await good.run(ref("A"), { coverage: "none", timeoutMs: 2000 });
    expect(v.outcome).toBe("timeout");
    expect(v.reportedStopMs).toBe(2000);
    const bad = backendOf(
      l,
      fakeV3(timeoutRow(20), { coverage: plainCoverage }).spawn,
      fakeAlc().io,
    );
    await bad.deploy(l.batch);
    await bad.activate("M0001");
    const w = await bad.run(ref("A"), { coverage: "none", timeoutMs: 2000 });
    expect(w.outcome).toBe("error");
    expect(w.runnerRow).toBe("runner-test-error");
  });

  test("T29: a malformed second row caches nothing (the next run spawns again) and is never a verdict; a valid document is cached", async () => {
    const l = await layout();
    let calls = 0;
    const spawn: SpawnFn = async (argv) => {
      calls += 1;
      const tests = [
        { codeunit: CU, method: "A", name: `Codeunit${CU}.A`, status: "pass" },
        { codeunit: CU, method: "B", name: `Codeunit${CU}.B`, status: "maybe" },
      ];
      await writeFile(
        argv[argv.indexOf("--coverage-json") + 1] ?? "",
        JSON.stringify(plainCoverage("", "", l.testDir)),
      );
      return { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "" };
    };
    const b = backendOf(l, spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    const v = await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("pre-dispatch-rejected");
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(calls).toBe(2);
  });

  test("a session-suite test with no row: the baseline stops; under a mutant it is an error, never a verdict", async () => {
    const l = await layout();
    const onlyA = () => [{ method: "A", status: "pass" as const }];
    const b = backendOf(l, fakeV3(onlyA, { coverage: plainCoverage }).spawn, fakeAlc().io);
    b.useSessionTests([ref("A"), ref("B")]);
    await b.deploy(l.batch);
    await b.activate(null);
    await expect(b.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3RowMissingError,
    );
    await b.activate("M0001");
    const v = await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(v.outcome).toBe("error");
    expect(v.runnerRow).toBe("runner-test-error");
  });

  test("exit 6 stops the session; exit 2 is a transport failure; exit 7 reads its rows", async () => {
    const l = await layout();
    const six = backendOf(l, fakeV3(allPass, { exit: 6, stdout: "" }).spawn, fakeAlc().io);
    await six.deploy(l.batch);
    await expect(six.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3SelectionError,
    );
    const two = backendOf(l, fakeV3(allPass, { exit: 2 }).spawn, fakeAlc().io);
    await two.deploy(l.batch);
    const v = await two.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect([v.outcome, v.operation]).toEqual(["error", "pre-dispatch-rejected"]);
    const seven = backendOf(l, fakeV3(allPass, { exit: 7 }).spawn, fakeAlc().io);
    await seven.deploy(l.batch);
    expect((await seven.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("pass");
  });

  test("T10: exit 0 with no document is a transport failure, never 'all passed'", async () => {
    const l = await layout();
    const b = backendOf(l, fakeV3(allPass, { stdout: "" }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    const v = await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect([v.outcome, v.operation]).toEqual(["error", "pre-dispatch-rejected"]);
  });

  test("T6: rows match on codeunit + method, whole and case-folded: Twin Pair is not Twin_PairLong, 'a' finds 'A'", async () => {
    const l = await layout();
    const rows = () => [
      { method: "Twin_PairLong", status: "fail" as const, message: "x" },
      { method: "Twin Pair", status: "pass" as const },
      { method: "A", status: "pass" as const },
    ];
    // Every row has its own per-test entry, so §6 lets each pass through.
    const cov = (_id: string, _a: string, testDir: string) => ({
      coverage: [],
      perTestCoverage: ["Twin_PairLong", "Twin Pair", "A"].map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      })),
    });
    const b = backendOf(l, fakeV3(rows, { coverage: cov }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    expect((await b.run(ref("Twin Pair"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe(
      "pass",
    );
    expect((await b.run(ref("a"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("pass");
  });

  test("T26: a test's baseline coverage is its own per-test entry, never a sibling's", async () => {
    const l = await layout();
    const v3 = fakeV3(allPass, {
      coverage: (_id, active, testDir) => ({
        coverage: [],
        perTestCoverage: [
          {
            test: `Codeunit${CU}.A`,
            coverage: [
              {
                file: join(active, "Logic.Codeunit.al"),
                statements: [{ line: 5, hits: 1, scope: "Twice" }],
              },
            ],
          },
          {
            test: `Codeunit${CU}.B`,
            coverage: [
              { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 12, hits: 1 }] },
            ],
          },
        ],
      }),
    });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    const a = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    const bb = await b.run(ref("B"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(a.coverage?.entries.map((e) => e.procedure)).toEqual(["Twice"]);
    expect(bb.coverage?.entries).toEqual([]);
  });

  test("the outer bound is 10 x N x tests + 90 s", () => {
    expect(v3CallDeadlineMs(3, 4)).toBe(10 * 3000 * 4 + 90_000);
    expect(v3CallDeadlineMs(1, 0)).toBe(10_000 + 90_000);
    expect(stopSecondsOf(1)).toBe(1);
    expect(stopSecondsOf(2001)).toBe(3);
  });

  test("selectorMode resource is refused by name before any call", async () => {
    const l = await layout();
    expect(() =>
      backendOf(l, fakeV3(allPass).spawn, fakeAlc().io, { selectorMode: "resource" }),
    ).toThrow(AlRunnerV3ResourceSelectorRefusedError);
  });
});

describe("R639 F1 (R10): the v3 version pattern", () => {
  test("F1-accept: alpha.2, alpha.3 and an edge build with SemVer build metadata are v3 builds", () => {
    for (const v of [
      "alrunner 3.0.0-alpha.2 (91253f2d6)",
      "al-runner 3.0.0-alpha.3 (c893e3633)",
      "al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)",
    ])
      expect(AL_RUNNER_V3_VERSION.test(v)).toBe(true);
  });
  test("F1-empty: empty build metadata is refused", () => {
    expect(AL_RUNNER_V3_VERSION.test("al-runner 3.0.0-alpha.4+ (57f1e4f98)")).toBe(false);
  });
  test("F1-space (M7): build metadata with a space is refused", () => {
    expect(AL_RUNNER_V3_VERSION.test("al-runner 3.0.0-alpha.4+edge 2026 (57f1e4f98)")).toBe(false);
  });
  test("F1-hex: a commit that is not hex is refused", () => {
    expect(AL_RUNNER_V3_VERSION.test("al-runner 3.0.0+edge (zz)")).toBe(false);
  });
  test("F1-v2: a v2 line is refused", () => {
    expect(AL_RUNNER_V3_VERSION.test("AlRunner 2.12.0 (c39ad5de)")).toBe(false);
  });
});

describe("§5 the row decoder", () => {
  const r = ref("A");
  const row = (o: Partial<Parameters<typeof v3RowVerdict>[1]>) => ({
    codeunit: CU,
    method: "A",
    name: `Codeunit${CU}.A`,
    status: "pass" as const,
    notRun: false,
    ...o,
  });
  test("notRun with pass or fail is a contract error, never a verdict", () => {
    for (const status of ["pass", "fail"] as const) {
      const v = v3RowVerdict(r, row({ status, notRun: true }), 3, 10, undefined);
      expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
    }
  });
  test("notRun + the timeout sentence is a timeout at that stop; notRun + anything else is a refusal (the field wins over the prefix)", () => {
    const t = v3RowVerdict(
      r,
      row({ status: "error", notRun: true, message: "Test exceeded 3s timeout." }),
      3,
      10,
      undefined,
    );
    expect([t.outcome, t.reportedStopMs]).toEqual(["timeout", 3000]);
    const ref1 = v3RowVerdict(
      r,
      row({ status: "error", notRun: true, message: "anything at all" }),
      3,
      10,
      undefined,
    );
    expect([ref1.outcome, ref1.runnerRow]).toEqual(["error", "runner-refused"]);
  });
  test("without notRun: fail is a kill, pass a pass, error an unclassified non-verdict", () => {
    expect(
      v3RowVerdict(r, row({ status: "fail", message: "boom" }), 3, 10, undefined).outcome,
    ).toBe("fail");
    expect(v3RowVerdict(r, row({}), 3, 10, undefined).outcome).toBe("pass");
    const e = v3RowVerdict(r, row({ status: "error", message: "?" }), 3, 10, undefined);
    expect([e.outcome, e.runnerRow]).toEqual(["error", "runner-test-error"]);
  });
  const PREFIXED = "NotRun: out-of-scope: x";
  test("K1-a: a fail whose message starts with the refusal prefix (notRun false) is error/runner-test-error, never a kill", () => {
    const v = v3RowVerdict(r, row({ status: "fail", message: PREFIXED }), 3, 10, undefined);
    expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
    expect(v.failureMessage).toContain("a refusal written as a fail; never scored");
  });
  test("K1-b: the same with status pass is error, never a pass", () => {
    const v = v3RowVerdict(r, row({ status: "pass", message: PREFIXED }), 3, 10, undefined);
    expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
  });
  test("K1-c (the control): a plain fail with another message still scores fail", () => {
    expect(
      v3RowVerdict(r, row({ status: "fail", message: "boom" }), 3, 10, undefined).outcome,
    ).toBe("fail");
  });
  test("K1-d: the prefix NOT at the start still scores fail (the match is anchored)", () => {
    expect(
      v3RowVerdict(r, row({ status: "fail", message: `x ${PREFIXED}` }), 3, 10, undefined).outcome,
    ).toBe("fail");
  });
  // R672 (plan 2026-10-23-r672-v3-refusal-prefix.md §2): K1(a) reads the refusal after at most ONE
  // `V3_TYPE_PREFIX` word (dots allowed).
  for (const p of [
    "SomeException: ",
    "Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: ",
    "Error: ",
  ]) {
    for (const status of ["fail", "pass"] as const) {
      test(`R672 K1: ${status} "${p}${PREFIXED}" is error/runner-test-error, never scored`, () => {
        const v = v3RowVerdict(r, row({ status, message: `${p}${PREFIXED}` }), 3, 10, undefined);
        expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
        expect(v.failureMessage).toContain(`a refusal written as a ${status}; never scored`);
      });
    }
  }
  test("R672 K1: an unprefixed refusal's verdict is byte-identical (the whole object)", () => {
    for (const status of ["fail", "pass"] as const) {
      expect(v3RowVerdict(r, row({ status, message: PREFIXED }), 3, 10, undefined)).toEqual({
        ref: r,
        outcome: "error",
        durationMs: 10,
        failureMessage: `NotRun: out-of-scope: x [al-runner v3: a refusal written as a ${status}; never scored (R639)]`,
        operation: "completed-accepted",
        runnerRow: "runner-test-error",
      });
    }
  });
  test("R672 K1: an Assert text that quotes the refusal is still a kill", () => {
    const v = v3RowVerdict(
      r,
      row({ status: "fail", message: `Assert.AreEqual failed. Expected: ${PREFIXED}` }),
      3,
      10,
      undefined,
    );
    expect(v.outcome).toBe("fail");
  });
  test("R672 residual (closed by leg C's message-has-no-type-prefix, which refuses such a build): A: B: + refusal still scores fail", () => {
    // Two prefix words: K1(a) reads one. The leg-C fact matches `A: B: boom`, so such a build is
    // refused before any mutant (al-runner-rows.test.ts, the chain asymmetry).
    expect(
      v3RowVerdict(r, row({ status: "fail", message: `A: B: ${PREFIXED}` }), 3, 10, undefined)
        .outcome,
    ).toBe("fail");
  });
  test("R672 residual (open, R675): Runtime error: + refusal still scores fail", () => {
    // A prefix with a space: neither K1(a) nor leg C sees it (R675).
    expect(
      v3RowVerdict(
        r,
        row({ status: "fail", message: `Runtime error: ${PREFIXED}` }),
        3,
        10,
        undefined,
      ).outcome,
    ).toBe("fail");
  });
  test("decodeV3Rows refuses another codeunit's row and a name that is not Codeunit<id>.<method>", () => {
    const doc = (t: object) => JSON.stringify({ tests: [t] });
    expect(
      decodeV3Rows(doc({ codeunit: 1, method: "A", name: "Codeunit1.A", status: "pass" }), 2),
    ).toHaveProperty("why");
    expect(
      decodeV3Rows(doc({ codeunit: 2, method: "A", name: "Codeunit2.B", status: "pass" }), 2),
    ).toHaveProperty("why");
    expect(
      decodeV3Rows(
        doc({ codeunit: 2, method: "Space Step", name: "Codeunit2.Space Step", status: "pass" }),
        2,
      ),
    ).toHaveProperty("rows");
  });
});

describe("T24 (I1) and I3: the notes", () => {
  test("a kill gets [v3-codeunit-state-possible] iff a COVERING test of its codeunit ran before it in v3's row order", async () => {
    const l = await layout();
    const rowsAB = () => [
      { method: "A", status: "pass" as const },
      { method: "B", status: "fail" as const, message: "x" },
    ];
    const b = backendOf(l, fakeV3(rowsAB, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    b.useCoveringBudgets("M0001", [
      { ref: ref("A"), budgetMs: 1000 },
      { ref: ref("B"), budgetMs: 1000 },
    ]);
    const v = await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 });
    expect(v.backendNote?.startsWith(V3_STATE_NOTE_TAG)).toBe(true);
    // Direction 2: A ran first but does NOT cover this mutant: no note.
    await b.activate("M0002");
    b.useCoveringBudgets("M0002", [{ ref: ref("B"), budgetMs: 1000 }]);
    expect(
      (await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).backendNote,
    ).toBeUndefined();
  });

  test("R637 (S2): the note names a not-run covering sibling as timed out or refused, never just not run", async () => {
    const l = await layout();
    const rows = () => [
      { method: "A", status: "error" as const, notRun: true, message: "Test exceeded 3s timeout." },
      { method: "C", status: "error" as const, notRun: true, message: "NotRun: out-of-scope: x" },
      { method: "B", status: "fail" as const, message: "x" },
    ];
    const b = backendOf(l, fakeV3(rows, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    b.useCoveringBudgets("M0001", [
      { ref: ref("A"), budgetMs: 1000 },
      { ref: ref("B"), budgetMs: 1000 },
      { ref: ref("C"), budgetMs: 1000 },
    ]);
    const note = (await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).backendNote;
    expect(note).toContain("A (timed out)");
    expect(note).toContain("C (refused)");
    expect(note).not.toContain("not run");
  });

  test("a first-row kill gets no note", async () => {
    const l = await layout();
    const rowsBA = () => [
      { method: "B", status: "fail" as const, message: "x" },
      { method: "A", status: "pass" as const },
    ];
    const b = backendOf(l, fakeV3(rowsBA, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0001");
    b.useCoveringBudgets("M0001", [
      { ref: ref("A"), budgetMs: 1000 },
      { ref: ref("B"), budgetMs: 1000 },
    ]);
    expect(
      (await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).backendNote,
    ).toBeUndefined();
  });

  test("I3: a survivor whose covering codeunit had a baseline refusal is noted; one whose codeunit had none is not", async () => {
    const l = await layout();
    const rows = () => [
      { method: "A", status: "pass" as const },
      {
        method: "B",
        status: "error" as const,
        notRun: true,
        message: "NotRun: out-of-scope: Commit",
      },
    ];
    const b = backendOf(l, fakeV3(rows, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate(null);
    expect((await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).runnerRow).toBe(
      "runner-refused",
    );
    expect(b.survivorNote([ref("A")])?.startsWith(V3_REFUSED_NEARBY_TAG)).toBe(true);
    expect(b.survivorNote([ref("Q", 1)])).toBeUndefined();
  });
});

describe("§6 the Sleep rule through the backend (T12, T31, T32)", () => {
  // The target sleeps on line 5; deploy keeps line numbers (no guards in this fake batch).
  const SLEEPER = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;
  const sleepCoverage =
    (opts: { hit?: boolean; listLine?: boolean; perTest?: boolean; unowned?: boolean } = {}) =>
    (_id: string, active: string, testDir: string) => {
      const target = join(active, "Logic.Codeunit.al");
      const line = { line: 5, hits: opts.hit === true || opts.unowned === true ? 1 : 0 };
      const own = (m: string) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
          ...(opts.hit === true && m === "A"
            ? [{ file: target, statements: [{ line: 5, hits: 1 }] }]
            : []),
        ],
      });
      return {
        coverage: [
          // v3 always lists the called test codeunit's own file (the RC1-R9 log shows it).
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
          {
            file: target,
            statements:
              opts.listLine === false ? [{ line: 6, hits: 0 }] : [line, { line: 6, hits: 0 }],
          },
        ],
        perTestCoverage: opts.perTest === false ? [own("B")] : [own("A"), own("B")],
      };
    };
  async function sleeper(cov: ReturnType<typeof sleepCoverage>, rows: () => FakeRow[] = allPass) {
    const l = await layout(SLEEPER);
    const v3 = fakeV3(rows, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    return { l, b, v3 };
  }
  const runA = (b: AlRunnerV3Backend) => b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });

  test("T31: the index is built from active/ (target 1 line) and the test dir (0)", async () => {
    const { b } = await sleeper(sleepCoverage());
    expect(b.sleepIndexSize()).toEqual({ target: 1, test: 0 });
  });

  test("T12 case 3: a covering pass that hits the indexed Sleep reads error/runner-refused with the note", async () => {
    const { b } = await sleeper(sleepCoverage({ hit: true }));
    await b.activate("M0001");
    const v = await runA(b);
    expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-refused"]);
    expect(v.failureMessage?.startsWith("[v3-sleep-noop] covered Sleep at")).toBe(true);
  });

  test("R652 T11: a one-shot Sleep note (no window, its own checked spawn) does NOT carry the window caveat", async () => {
    const { b } = await sleeper(sleepCoverage({ hit: true }));
    await b.activate("M0001");
    expect((await runA(b)).failureMessage).not.toContain(WINDOW_BOUND_CAVEAT);
  });

  test("T12 other direction: the Sleep line listed at 0 hits leaves the pass scored", async () => {
    const { b } = await sleeper(sleepCoverage());
    await b.activate("M0001");
    expect((await runA(b)).outcome).toBe("pass");
  });

  test("T12: a baseline call is never touched (a hit at baseline stays a pass)", async () => {
    const { b } = await sleeper(sleepCoverage({ hit: true }));
    await b.activate(null);
    expect((await runA(b)).outcome).toBe("pass");
  });

  test("T12: a kill with a Sleep hit stays a kill", async () => {
    const failA = () => [
      { method: "A", status: "fail" as const, message: "x" },
      { method: "B", status: "pass" as const },
    ];
    const { b } = await sleeper(sleepCoverage({ hit: true }), failA);
    await b.activate("M0001");
    expect((await runA(b)).outcome).toBe("fail");
  });

  test("T32 case 1: no coverage document under a mutant reads error, not 'no hit'", async () => {
    const { b } = await sleeper(sleepCoverage());
    b.coverageTamper = async (p) => {
      await rm(p, { force: true });
    };
    await b.activate("M0001");
    const v = await runA(b);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toMatch(/coverage unavailable/);
  });

  test("T32 case 1: a covering test with no per-test entry reads error", async () => {
    const { b } = await sleeper(sleepCoverage({ perTest: false }));
    await b.activate("M0001");
    expect((await runA(b)).failureMessage).toMatch(/no per-test entry/);
  });

  test("T32 case 2: an indexed line absent from a listed file's coverage errors this and every later pass of the batch", async () => {
    const { b } = await sleeper(sleepCoverage({ listLine: false }));
    await b.activate("M0001");
    expect((await runA(b)).failureMessage).toMatch(/not in v3's coverage/);
    await b.activate("M0002");
    expect((await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("error");
  });

  test("I-1: coverage paths under another prefix than the index's real roots stop the session by name", async () => {
    const moved = (id: string, active: string, testDir: string) => {
      const d = sleepCoverage({ hit: true })(id, active, testDir);
      const away = <F extends { file: string }>(f: F): F => ({ ...f, file: `/elsewhere${f.file}` });
      return {
        coverage: d.coverage.map(away),
        perTestCoverage: d.perTestCoverage.map((e) => ({ ...e, coverage: e.coverage.map(away) })),
      };
    };
    const { b } = await sleeper(moved);
    await b.activate("M0001");
    const err = await runA(b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3CoverageJoinError);
    expect(String(err)).toMatch(/al-runner-v3-coverage-join-refused/);
  });

  test("F2 now admits: a covering call listing only the test file (no target file reached) is scored, not refused", async () => {
    const onlyTests = (_id: string, _active: string, testDir: string) => ({
      coverage: [{ file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] }],
      perTestCoverage: ["A", "B"].map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      })),
    });
    const { b } = await sleeper(onlyTests);
    expect(b.sleepIndexSize()).toEqual({ target: 1, test: 0 });
    await b.activate("M0001");
    expect((await runA(b)).outcome).toBe("pass");
  });

  test("F2 still refuses: the target file listed under another prefix stops the session", async () => {
    const moved = (id: string, active: string, testDir: string) => {
      const d = sleepCoverage({ hit: true })(id, active, testDir);
      const away = <F extends { file: string }>(f: F): F =>
        f.file.startsWith(testDir) ? f : { ...f, file: `/elsewhere${f.file}` };
      return {
        coverage: d.coverage.map(away),
        perTestCoverage: d.perTestCoverage.map((e) => ({ ...e, coverage: e.coverage.map(away) })),
      };
    };
    const { b } = await sleeper(moved);
    await b.activate("M0001");
    await expect(runA(b)).rejects.toBeInstanceOf(AlRunnerV3CoverageJoinError);
  });

  test("I-1: through a symlinked test dir, the argv and the index use its real path", async () => {
    const l = await layout(SLEEPER);
    const link = `${l.testDir}-link`;
    await symlink(l.testDir, link);
    try {
      const v3 = fakeV3(allPass, { coverage: sleepCoverage() });
      const b = backendOf(l, v3.spawn, fakeAlc().io, { testDir: link });
      await b.deploy(l.batch);
      await b.activate("M0001");
      await runA(b);
      const argv = v3.calls[0] ?? [];
      const real = await realpath(l.testDir);
      expect(argv.at(-1)).toBe(real);
      expect(argv.at(-2)).toBe(await realpath(argv.at(-2) ?? ""));
    } finally {
      await rm(link, { force: true });
    }
  });

  test("F1: a BASELINE run whose hit sits under the real active/ but maps to no batch line stops the session", async () => {
    // The run the orchestrator makes (baseline, unmutated): never via activate(mutant), which an
    // uncovered mutant never reaches.
    const l = await layout(SLEEPER);
    const cov = (_id: string, active: string, testDir: string) => ({
      coverage: [
        { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        { file: join(active, "Renamed", "LOGIC.al"), statements: [{ line: 5, hits: 1 }] },
      ],
      perTestCoverage: ["A", "B"].map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(active, "Renamed", "LOGIC.al"), statements: [{ line: 5, hits: 1 }] },
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      })),
    });
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    await expect(
      b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(AlRunnerV3CoverageJoinError);
  });

  test("F1, other direction: a baseline test that reaches only test-app code (no hit under active/) runs", async () => {
    const l = await layout(SLEEPER);
    const cov = (_id: string, _active: string, testDir: string) => ({
      coverage: [{ file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] }],
      perTestCoverage: ["A", "B"].map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      })),
    });
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    const v = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(v.outcome).toBe("pass");
    expect(v.coverage?.entries.length ?? -1).toBe(0);
  });

  test("F1, other direction: a baseline hit that maps to a batch line runs, with coverage", async () => {
    const l = await layout(SLEEPER);
    const cov = (_id: string, active: string, testDir: string) => ({
      coverage: [
        { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        { file: join(active, "Logic.Codeunit.al"), statements: [{ line: 5, hits: 1 }] },
      ],
      perTestCoverage: ["A", "B"].map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          { file: join(active, "Logic.Codeunit.al"), statements: [{ line: 6, hits: 1 }] },
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      })),
    });
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    const v = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(v.coverage?.entries.length ?? 0).toBeGreaterThan(0);
    await b.activate("M0001");
  });

  test("T32 case 4: a top-level hit no per-test entry owns errors every covering pass of the call", async () => {
    const { b } = await sleeper(sleepCoverage({ unowned: true }));
    await b.activate("M0001");
    expect((await runA(b)).failureMessage).toMatch(/unattributed Sleep hit/);
  });

  test("item 6: coverage none (refused for a multi-object file) still requests --coverage-json and still applies §6 on raw lines", async () => {
    // Two objects in one file, the Sleep in the SECOND: the shape whose coverage the v3 backend
    // refuses (multi-object), so the session runs coverage "none". The Sleep rule must not care.
    const MULTI = `codeunit 79001 "First"
{
    procedure One(): Integer
    begin
        exit(1);
    end;
}

codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;
    const l = await layout(MULTI);
    const cov = (_id: string, active: string, testDir: string) => {
      const target = join(active, "Logic.Codeunit.al");
      return {
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
          {
            file: target,
            statements: [
              { line: 13, hits: 1 },
              { line: 14, hits: 1 },
            ],
          },
        ],
        perTestCoverage: ["A", "B"].map((m) => ({
          test: `Codeunit${CU}.${m}`,
          coverage: [
            { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
            ...(m === "A" ? [{ file: target, statements: [{ line: 13, hits: 1 }] }] : []),
          ],
        })),
      };
    };
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "none" });
    await b.deploy(l.batch);
    expect(b.sleepIndexSize()).toEqual({ target: 1, test: 0 });
    await b.activate("M0001");
    const v = await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(v3.calls[0]).toContain("--coverage-json");
    expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-refused"]);
    expect(v.failureMessage?.startsWith("[v3-sleep-noop] covered Sleep at")).toBe(true);
  });

  test("T31: a second deploy rebuilds the index (a batch without the Sleep indexes 0)", async () => {
    const { b, l } = await sleeper(sleepCoverage());
    await writeFile(join(l.batch, "Logic.Codeunit.al"), TARGET_AL);
    await b.deploy(l.batch);
    expect(b.sleepIndexSize()).toEqual({ target: 0, test: 0 });
  });
});
