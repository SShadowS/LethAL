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
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { emitStaticSelector } from "@lethal/schemata";
import {
  AL_RUNNER_V3_VERSION,
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3DependencySkippedError,
  AlRunnerV3ResourceSelectorRefusedError,
  AlRunnerV3ReusedBaselineUnclassifiedError,
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
import * as pinsNs from "../src/al-runner-v3-pins";
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
  /** R586c (B2): default 0, or the stop in ms for a "Test exceeded Ns timeout." row (a CPU stop); null omits it. */
  durationMs?: number | null;
}
const stopMsOf = (message: string | undefined): number => {
  const m = /^Test exceeded (\d+)s timeout\./.exec(message ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
};

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
    /** R590: v3's stderr, per call (the mutant id the selector read). */
    stderr?: (activeId: string) => string;
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
    const covAt = argv.indexOf("--coverage-json");
    const cov = opts.coverage?.(activeId, active, testDir);
    // R762 A: a call without the flag has nowhere to write it.
    if (cov !== undefined && covAt >= 0)
      await writeFile(argv[covAt + 1] ?? "", JSON.stringify(cov));
    const tests = rows(activeId, argv).map((r) => ({
      codeunit: cu,
      codeunitName: "Tests",
      ...(r.durationMs === null ? {} : { durationMs: r.durationMs ?? stopMsOf(r.message) }),
      method: r.method,
      name: `Codeunit${cu}.${r.method}`,
      status: r.status,
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.notRun === true ? { notRun: true } : {}),
    }));
    return {
      exitCode: opts.exit ?? 0,
      stdout: opts.stdout ?? JSON.stringify({ tests, exitCode: 0 }),
      stderr: opts.stderr?.(activeId) ?? "",
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

  test("R734: an alc rejection of the batch stops deploy() at the target compile: the test app is never compiled and nothing is deployed", async () => {
    const l = await layout();
    const alc = fakeAlc((p) => p.endsWith("active"));
    const b = backendOf(l, fakeV3(allPass).spawn, alc.io);
    await expect(b.deploy(l.batch)).rejects.toBeInstanceOf(AlcCompileError);
    // exactly one alc run (the target), never the test app's
    expect(alc.calls.map((c) => c.project)).toEqual([join(l.scratch, "active")]);
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
      return {
        s,
        warned: warn.mock.calls.map((c) => String(c[0])).join("\n"),
        sha: await sha256OfFile(bin),
      };
    } finally {
      warn.mockRestore();
    }
  }
  test("a candidate backend warns al-runner-v3-defect-unlike-bc and runs", async () => {
    const { s, warned } = await statusOf(true);
    expect(s.ok).toBe(true);
    expect(warned).toMatch(/al-runner-v3-defect-unlike-bc: refusal-row-shape/);
  });
  test("R719: status() passes the pin's muted set to the warnings and prints the pin line", async () => {
    const gone = (fact: string): V3ContractResult["facts"][number] => ({
      fact,
      kind: "defect",
      verdict: "gone",
      expected: "x",
      measured: "m",
    });
    const contract: V3ContractResult = {
      facts: [gone("refusal-row-shape"), gone("none-selected-exit")],
    };
    const spy = spyOn(pinsNs, "pinnedDefectCoverage").mockReturnValue({
      muted: new Set(["refusal-row-shape=gone"]),
      line: "PINLINE",
    });
    try {
      const { s, warned, sha } = await statusOf(false, contract);
      expect(s.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([contract, VERSION, sha]);
      expect(warned).toContain("PINLINE");
      expect(warned).toMatch(/defect-gone: none-selected-exit/);
      expect(warned).not.toMatch(/defect-gone: refusal-row-shape/);
    } finally {
      spy.mockRestore();
    }
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
      // R767: every send re-hashes every .al byte, so a stat check can never be fooled.
      "R767: a target .al rewritten at the same size with its mtime restored",
      async (l) => {
        const p = join(active(l), "Logic.Codeunit.al");
        const s = await stat(p);
        const text = await readFile(p, "utf8");
        const i = text.search(/[A-Za-z]/);
        const c = text[i] === "X" ? "Y" : "X";
        await writeFile(p, text.slice(0, i) + c + text.slice(i + 1));
        expect((await stat(p)).size).toBe(s.size);
        await utimes(p, s.atime, s.mtime);
      },
    ],
    [
      "R767: an .al file added to active/",
      (l) => writeFile(join(active(l), "Extra.Codeunit.al"), "codeunit 79151 Extra { }"),
    ],
    ["R767: a target .al removed from active/", (l) => rm(join(active(l), "Logic.Codeunit.al"))],
    [
      "R767: a test .al added to the test dir",
      (l) => writeFile(join(l.testDir, "Extra.Codeunit.al"), "codeunit 79152 Extra { }"),
    ],
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

describe("R608: the proof binds the non-.al files, the test dir's .alpackages and <deps> subfolders", () => {
  const active = (l: Layout) => join(l.scratch, "active");
  const run = (b: AlRunnerV3Backend) => b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
  async function deployed(before: (l: Layout) => Promise<void> = async () => {}) {
    const l = await layout();
    await before(l);
    const v3 = fakeV3(allPass, { coverage: plainCoverage });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate("M0002");
    return { l, v3, b };
  }
  const withRes = async (l: Layout) => {
    await writeFile(join(l.testDir, "res.txt"), "one");
    await mkdir(join(l.testDir, ".alpackages"), { recursive: true });
    await writeFile(join(l.testDir, ".alpackages", "Sym.app"), "sym");
  };
  const cases: [string, (l: Layout) => Promise<void>][] = [
    ["a non-.al file added to active/", (l) => writeFile(join(active(l), "extra.json"), "{}")],
    [
      "a non-.al file of active/ changed (the manifest)",
      (l) => appendFile(join(active(l), "mutant-manifest.json"), " ", "utf8"),
    ],
    ["a non-.al file added to the test dir", (l) => writeFile(join(l.testDir, "extra.xlf"), "x")],
    [
      "a non-.al file of the test dir changed",
      (l) => writeFile(join(l.testDir, "res.txt"), "twelve"),
    ],
    [
      "a file added to <testDir>/.alpackages",
      (l) => writeFile(join(l.testDir, ".alpackages", "New.app"), "n"),
    ],
    [
      "a file of <testDir>/.alpackages changed",
      (l) => writeFile(join(l.testDir, ".alpackages", "Sym.app"), "changed symbols"),
    ],
  ];
  for (const [name, tamper] of cases) {
    test(`${name} -> AlRunnerV3UnprovenBatchError naming the folder, 0 spawns`, async () => {
      const { l, b, v3 } = await deployed(withRes);
      await tamper(l);
      const err = await run(b).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
      expect((err as Error).message).toContain("a non-.al file in");
      expect(v3.calls).toHaveLength(0);
    });
  }

  test("the other direction: nothing touched, and a new .vscode file (not read by v3), still runs", async () => {
    const { l, b, v3 } = await deployed(withRes);
    await mkdir(join(l.testDir, ".vscode"), { recursive: true });
    await writeFile(join(l.testDir, ".vscode", "settings.json"), "{}");
    expect((await run(b)).outcome).toBe("pass");
    expect(v3.calls).toHaveLength(1);
  });

  test("a same-size rewrite with a moved mtime is caught by the re-hash", async () => {
    const { l, b, v3 } = await deployed(withRes);
    const p = join(l.testDir, "res.txt");
    await writeFile(p, "two");
    const later = new Date(Date.now() + 60_000);
    await utimes(p, later, later);
    const err = await run(b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect((err as Error).message).toContain("res.txt");
    expect(v3.calls).toHaveLength(0);
  });

  test("a moved mtime alone (same bytes) does not refuse", async () => {
    const { l, b, v3 } = await deployed(withRes);
    const p = join(l.testDir, ".alpackages", "Sym.app");
    const later = new Date(Date.now() + 60_000);
    await utimes(p, later, later);
    expect((await run(b)).outcome).toBe("pass");
    expect(v3.calls).toHaveLength(1);
  });

  test("a <deps> subfolder is refused at deploy, by name; v3 not started", async () => {
    const l = await layout();
    await mkdir(join(l.deps, "sub"), { recursive: true });
    const v3 = fakeV3(allPass);
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    const err = await b.deploy(l.batch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect((err as Error).message).toContain(join(l.deps, "sub"));
    expect(v3.calls).toHaveLength(0);
  });

  test("a <deps> subfolder created after deploy is refused at the next send", async () => {
    const { l, b, v3 } = await deployed();
    await mkdir(join(l.deps, "late"), { recursive: true });
    const err = await run(b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect((err as Error).message).toContain(join(l.deps, "late"));
    expect(v3.calls).toHaveLength(0);
  });

  test("LethAL's own writes do not refuse: the cov/ output beside active/, and an activate() between sends", async () => {
    const { b, v3 } = await deployed();
    expect((await run(b)).outcome).toBe("pass");
    await b.activate("M0001");
    expect((await run(b)).outcome).toBe("pass");
    expect(v3.calls).toHaveLength(2);
  });
});

describe("R645: v3 runs in the session's scratch dir, so its coverage.cobertura.xml never lands in the caller's", () => {
  test("the one-shot call's cwd is the scratch dir, not process.cwd(); a relative cache dir is made absolute", async () => {
    const l = await layout();
    const inner = fakeV3(allPass, { coverage: plainCoverage });
    const seen: { argv: readonly string[]; cwd: string | undefined; cache: string | undefined }[] =
      [];
    const spawn: SpawnFn = (argv, opts) => {
      if (argv[1] !== "--version")
        seen.push({ argv, cwd: opts?.cwd, cache: opts?.env?.ALRUNNER_CACHE });
      return inner.spawn(argv, opts);
    };
    // Every configured path relative to the caller's cwd: all must reach v3 absolute. The cwd is
    // moved into the layout's root so the relative names hold no `..` (Windows `rm` refuses those).
    const before = process.cwd();
    process.chdir(l.root);
    try {
      const here = process.cwd();
      const b = backendOf(l, spawn, fakeAlc().io, {
        cacheDir: "rel-cache",
        instrumentedDir: "scratch",
        testDir: "tests",
        packagesDir: "deps",
        alRunnerPath: join("fake", "alrunner"),
      });
      await b.deploy(l.batch);
      await b.activate("M0002");
      await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
      expect(seen).toHaveLength(1);
      expect(isAbsolute(seen[0]?.argv[0] ?? "")).toBe(true);
      expect(seen[0]?.cwd).toBe(join(here, "scratch"));
      expect(seen[0]?.cwd).not.toBe(here);
      expect(seen[0]?.cache).toBe(join(here, "rel-cache"));
    } finally {
      process.chdir(before);
    }
    // Every path argument is absolute, or the new cwd would break it.
    const argv = seen[0]?.argv ?? [];
    const argAfter = (flag: string) => argv[argv.indexOf(flag) + 1] ?? "";
    for (const p of [argAfter("--package-cache"), argAfter("--coverage-json"), ...argv.slice(-2)])
      expect(isAbsolute(p)).toBe(true);
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

  // R590 (R-537): the line R-537's probe read from alpha.2 when the dependency's package was absent.
  const SKIP_LINE =
    "dependency skipped: dependency `R537 Dep` by LethAL R537 (9b3e6c1a-2f47-4d8e-a5b0-537a00000001) version 1.0.0.0 or higher was not found; searched: pkgsM, app/.alpackages, tests/.alpackages; put its .app with AL source (or its source archive) in the project's .alpackages or pass --deps DIR";
  const MISSING_OBJECT =
    "You tried to invoke the CodeUnit object with the ID 50960 from the object R537 ById Tests. An object with that ID does not exist in the current application compiled with emit version 28014.";
  const byIdFails = () => [
    { method: "A", status: "pass" as const },
    { method: "B", status: "fail" as const, message: MISSING_OBJECT },
  ];
  const skipStderr = (line: string) => () => `${line}\nalrunner 3.0.0-alpha.2 (91253f2d6)\n`;

  test("R590: a skipped dependency stops the session before its missing-object fail can score a kill", async () => {
    const l = await layout();
    const v3 = fakeV3(byIdFails, { exit: 1, stderr: skipStderr(SKIP_LINE) });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    const err = await b
      .run(ref("B"), { coverage: "none", timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3DependencySkippedError);
    expect(String(err)).toContain("R537 Dep");
    expect(String(err)).toContain("AL source");
  });

  test("R590: the check runs on a mutant call too, with exit 0 and every row passing, and before exit 6", async () => {
    const l = await layout();
    const mutantOnly = (id: string) => (id === "M0001" ? `${SKIP_LINE}\n` : "");
    const v3 = fakeV3(allPass, { coverage: plainCoverage, stderr: mutantOnly });
    const b = backendOf(l, v3.spawn, fakeAlc().io);
    await b.deploy(l.batch);
    expect((await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("pass");
    await b.activate("M0001");
    await expect(b.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3DependencySkippedError,
    );
    const six = backendOf(
      l,
      fakeV3(allPass, { exit: 6, stdout: "", stderr: skipStderr(SKIP_LINE) }).spawn,
      fakeAlc().io,
    );
    await six.deploy(l.batch);
    await expect(six.run(ref("A"), { coverage: "none", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AlRunnerV3DependencySkippedError,
    );
  });

  test("R590: v3's hidden-notes line refuses too (a skipped line may be among the hidden)", async () => {
    const l = await layout();
    const hidden = "... 14 more dependency notes (--verbose lists them)";
    const b = backendOf(l, fakeV3(allPass, { stderr: skipStderr(hidden) }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    const err = await b
      .run(ref("A"), { coverage: "none", timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3DependencySkippedError);
    expect(String(err)).toContain("--verbose");
  });

  test("R590 near misses: the words mid-line, and System's optional-root note, score the row as before", async () => {
    const l = await layout();
    for (const line of [
      "warning: dependency skipped: X",
      "dependency note: optional dependency `System` by Microsoft (8874ed3a-0643-4247-9ced-7a7002f7135d) skipped",
      "... more dependency notes",
      // No count: v3 always writes one; `\d*` would accept this line, `\d+` does not.
      "...  more dependency notes",
    ]) {
      const b = backendOf(
        l,
        fakeV3(byIdFails, { exit: 1, stderr: skipStderr(line) }).spawn,
        fakeAlc().io,
      );
      await b.deploy(l.batch);
      expect((await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).outcome).toBe("fail");
    }
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
    expect(v.failureMessage).toContain("a fail that holds v3's refusal marker; never scored");
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
  test("R675 K1-d (inverts R672's): the marker NOT at the start is error, never a kill", () => {
    const v = v3RowVerdict(r, row({ status: "fail", message: `x ${PREFIXED}` }), 3, 10, undefined);
    expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
  });
  // R675 (plan 2026-10-23-r675-v3-refusal-marker-anywhere.md §3): K1(a) reads the marker after ANY
  // text: the R672 one-word prefixes, the spaced and `::` shapes, a chain, and an Assert quoting it
  // (the last one a lost kill, the safe direction; R675's known limit).
  for (const p of [
    "SomeException: ",
    "Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: ",
    "Error: ",
    "Runtime error: ",
    "al_runtime::Error: ",
    "A: B: ",
    "Assert.AreEqual failed. Expected: ",
  ]) {
    for (const status of ["fail", "pass"] as const) {
      test(`R675 K1: ${status} "${p}${PREFIXED}" is error/runner-test-error, never scored`, () => {
        const v = v3RowVerdict(r, row({ status, message: `${p}${PREFIXED}` }), 3, 10, undefined);
        expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-test-error"]);
        expect(v.failureMessage).toContain(
          `a ${status} that holds v3's refusal marker; never scored (R639, R675)`,
        );
        expect(v.failureMessage).not.toContain("a refusal written as");
      });
    }
  }
  test("R672 K1: an unprefixed refusal's verdict (the whole object; R675's marker wording)", () => {
    for (const status of ["fail", "pass"] as const) {
      expect(v3RowVerdict(r, row({ status, message: PREFIXED }), 3, 10, undefined)).toEqual({
        ref: r,
        outcome: "error",
        durationMs: 10,
        failureMessage: `NotRun: out-of-scope: x [al-runner v3: a ${status} that holds v3's refusal marker; never scored (R639, R675)]`,
        operation: "completed-accepted",
        runnerRow: "runner-test-error",
      });
    }
  });
  test("R675: today's refusal (marker at 0, with notRun) is byte-identical (the whole object)", () => {
    expect(
      v3RowVerdict(
        r,
        row({ status: "error", notRun: true, message: `${PREFIXED} an outbound HTTP request` }),
        3,
        10,
        undefined,
      ),
    ).toEqual({
      ref: r,
      outcome: "error",
      durationMs: 10,
      failureMessage:
        "NotRun: out-of-scope: x an outbound HTTP request [al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]",
      operation: "completed-accepted",
      runnerRow: "runner-refused",
    });
  });
  test("R675 kill direction: rows without the marker give master's exact object", () => {
    for (const message of [
      "boom 5",
      "Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). R667 values differ.",
      "out-of-scope: x",
    ]) {
      expect(v3RowVerdict(r, row({ status: "fail", message }), 3, 10, undefined)).toEqual({
        ref: r,
        outcome: "fail",
        durationMs: 10,
        failureMessage: message,
      });
    }
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

describe("R-435 (B1): the artifact cache's apps folder", () => {
  test("dependencyArtifactAppsDir is <cacheDir>/artifacts/<bcVersion>/apps, and absent without a cacheDir", async () => {
    const l = await layout();
    const spawn = fakeV3(() => [], { coverage: plainCoverage }).spawn;
    const withCache = backendOf(l, spawn, fakeAlc().io, { cacheDir: "rel-cache" });
    expect(withCache.dependencyArtifactAppsDir()).toBe(
      join(resolve("rel-cache"), "artifacts", "28.0.46665.47126", "apps"),
    );
    expect(backendOf(l, spawn, fakeAlc().io).dependencyArtifactAppsDir()).toBeUndefined();
  });
});

describe("R586c (B2): a timeout under a mutant whose wall time is under its stop ran on v3's virtual clock", () => {
  const stopRow = (method: string, n: number, durationMs: number | null) => ({
    method,
    status: "error" as const,
    notRun: true,
    message: `Test exceeded ${n}s timeout.`,
    durationMs,
  });
  async function verdictOf(rows: FakeRow[], ask: string, n: number, mutant = true) {
    const l = await layout();
    const b = backendOf(l, fakeV3(() => rows, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    if (mutant) {
      await b.activate("M0001");
      b.useCoveringBudgets(
        "M0001",
        rows.map((r) => ({ ref: ref(r.method), budgetMs: n * 1000 })),
      );
    } else await b.activate(null);
    return b.run(ref(ask), { coverage: "none", timeoutMs: n * 1000 });
  }
  const outcomeAt = async (durationMs: number | null, n = 3) => {
    const v = await verdictOf([stopRow("A", n, durationMs)], "A", n);
    return [v.outcome, v.runnerRow] as const;
  };

  test("V-1: a stop whose wall time reached the stop (3006, 3009) is still a scored timeout", async () => {
    expect(await outcomeAt(3006)).toEqual(["timeout", undefined]);
    expect(await outcomeAt(3009)).toEqual(["timeout", undefined]);
  });
  test("V-2: durationMs 0 or 46 under a stop of 3 s is a runner-refused error naming the virtual clock", async () => {
    for (const d of [0, 46]) {
      const v = await verdictOf([stopRow("A", 3, d)], "A", 3);
      expect([v.outcome, v.runnerRow]).toEqual(["error", "runner-refused"]);
      expect(v.failureMessage).toContain("virtual clock");
      expect(v.failureMessage).toContain("Test exceeded 3s timeout.");
    }
  });
  test("V-3: the boundary: 2999 is refused, 3000 is scored", async () => {
    expect(await outcomeAt(2999)).toEqual(["error", "runner-refused"]);
    expect(await outcomeAt(3000)).toEqual(["timeout", undefined]);
  });
  test("V-4: no durationMs: scored as before", async () => {
    expect(await outcomeAt(null)).toEqual(["timeout", undefined]);
  });
  test("V-5: timeout-is-cpu rows (limit 2: 2007 and 16038) stay timeouts", async () => {
    expect(await outcomeAt(2007, 2)).toEqual(["timeout", undefined]);
    expect(await outcomeAt(16038, 2)).toEqual(["timeout", undefined]);
  });
  test("V-6: the baseline call keeps reading a virtual stop as a timeout", async () => {
    const v = await verdictOf([stopRow("A", 3, 0)], "A", 3, false);
    expect(v.outcome).toBe("timeout");
    expect(v.runnerRow).toBeUndefined();
  });
  test("V-6b: after a guarded mutant row, R639 and R-435 treat the sequence as pinned here", async () => {
    const refusedB = {
      method: "B",
      status: "error" as const,
      notRun: true,
      message: "NotRun: out-of-scope: Commit",
    };
    const rows = [stopRow("A", 3, 0), refusedB, stopRow("D", 3, 3000)];
    const a = await verdictOf(rows, "A", 3);
    expect([a.runnerRow, a.refusedAfterStop]).toEqual(["runner-refused", undefined]);
    const b = await verdictOf(rows, "B", 3);
    expect([b.runnerRow, b.refusedAfterStop]).toEqual(["runner-refused", "A"]);
    const d = await verdictOf(rows, "D", 3);
    expect([d.outcome, d.runnerRow]).toEqual(["error", "runner-test-error"]);
  });
});

describe("R-435: a timeout after an earlier refusal or stop in the same call is not trusted", () => {
  const STOP = "Test exceeded 1s timeout.";
  const refused = (method: string) => ({
    method,
    status: "error" as const,
    notRun: true,
    message: "NotRun: out-of-scope: Commit",
  });
  const timedOut = (method: string) => ({
    method,
    status: "error" as const,
    notRun: true,
    message: STOP,
  });
  /** Rows in v3's run order; `mutant` false = the baseline call. Returns the verdict of `ask`. */
  async function verdictOf(rows: FakeRow[], ask: string, mutant = true) {
    const l = await layout();
    const b = backendOf(l, fakeV3(() => rows, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    if (mutant) {
      await b.activate("M0001");
      b.useCoveringBudgets(
        "M0001",
        rows.map((r) => ({ ref: ref(r.method), budgetMs: 1000 })),
      );
    } else await b.activate(null);
    return b.run(ref(ask), { coverage: "none", timeoutMs: 1000 });
  }

  test("[E refused, D timeout] -> error, never a timeout and never runner-refused", async () => {
    const v = await verdictOf([refused("A"), timedOut("B")], "B");
    expect(v.outcome).toBe("error");
    expect(v.runnerRow).toBe("runner-test-error");
    expect(v.failureMessage).toContain("A");
    expect(v.failureMessage).toContain("R-435");
  });

  test("[A timeout, D timeout] -> error for D, while A itself stays a timeout", async () => {
    const rows = [timedOut("A"), timedOut("B")];
    const d = await verdictOf(rows, "B");
    expect(d.outcome).toBe("error");
    expect(d.runnerRow).toBe("runner-test-error");
    expect((await verdictOf(rows, "A")).outcome).toBe("timeout");
  });

  test("the twin: [P pass, D timeout] stays a timeout", async () => {
    const v = await verdictOf([{ method: "A", status: "pass" }, timedOut("B")], "B");
    expect(v.outcome).toBe("timeout");
    expect(v.runnerRow).toBeUndefined();
  });

  test("a K1(a) refusal marker in an earlier plain row also guards the timeout", async () => {
    const marker = {
      method: "A",
      status: "pass" as const,
      message: "NotRun: out-of-scope: Commit",
    };
    const v = await verdictOf([marker, timedOut("B")], "B");
    expect(v.outcome).toBe("error");
    expect(v.runnerRow).toBe("runner-test-error");
  });

  test("the baseline call is unchanged: [E refused, D timeout] still reads D as a timeout", async () => {
    const v = await verdictOf([refused("A"), timedOut("B")], "B", false);
    expect(v.outcome).toBe("timeout");
  });

  // R639: a refusal that follows a call's FIRST not-run row, when that row is a timeout, is
  // flagged so the covering loop may go on to the next test (the order cannot hide the timeout).
  describe("R639: refusedAfterStop", () => {
    const failMarker = {
      method: "B",
      status: "fail" as const,
      message: "NotRun: out-of-scope: Commit",
    };
    test("B1: [A timeout, B refusal] flags B with the timed-out test's name", async () => {
      const v = await verdictOf([timedOut("A"), refused("B")], "B");
      expect(v.runnerRow).toBe("runner-refused");
      expect(v.refusedAfterStop).toBe("A");
    });
    test("B1b: the whole sequence [A timeout, B refusal, D timeout]: B is flagged, then D is guarded (error, never timeout)", async () => {
      const rows = [timedOut("A"), refused("B"), timedOut("D")];
      expect((await verdictOf(rows, "B")).refusedAfterStop).toBe("A");
      const d = await verdictOf(rows, "D");
      expect(d.outcome).toBe("error");
      expect(d.runnerRow).toBe("runner-test-error");
    });
    test("B2a: a refusal with no timeout is not flagged", async () => {
      const v = await verdictOf([{ method: "A", status: "pass" }, refused("B")], "B");
      expect(v.runnerRow).toBe("runner-refused");
      expect(v.refusedAfterStop).toBeUndefined();
    });
    test("B2b: a timeout AFTER the refused row does not flag it", async () => {
      const v = await verdictOf([refused("B"), timedOut("A")], "B");
      expect(v.runnerRow).toBe("runner-refused");
      expect(v.refusedAfterStop).toBeUndefined();
    });
    test("B2c: an earlier non-timeout refusal first: not flagged", async () => {
      const v = await verdictOf([refused("E"), timedOut("A"), refused("B")], "B");
      expect(v.refusedAfterStop).toBeUndefined();
    });
    test("B2d: a plain fail holding the marker (runner-test-error) is not flagged", async () => {
      const v = await verdictOf([timedOut("A"), failMarker], "B");
      expect(v.runnerRow).toBe("runner-test-error");
      expect(v.refusedAfterStop).toBeUndefined();
    });
    test("B2e: no mutant active: not flagged", async () => {
      const v = await verdictOf([timedOut("A"), refused("B")], "B", false);
      expect(v.runnerRow).toBe("runner-refused");
      expect(v.refusedAfterStop).toBeUndefined();
    });
    test("B2f: the timeout row itself is not flagged", async () => {
      const v = await verdictOf([timedOut("A"), refused("B")], "A");
      expect(v.outcome).toBe("timeout");
      expect(v.refusedAfterStop).toBeUndefined();
    });
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

  test("R677: a batch-0 baseline refusal still notes a survivor in a later batch whose baseline ran nothing (a reused --resume snapshot)", async () => {
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
    await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 });
    // Batch 1: a reused snapshot runs no baseline call, so it records no refusal of its own.
    await b.deploy(l.batch);
    await b.activate(null);
    expect(b.survivorNote([ref("A")])?.startsWith(V3_REFUSED_NEARBY_TAG)).toBe(true);
  });

  // R678: the stored verdict of each notRun row shape, made by the same decoder a baseline uses.
  const notRunVerdict = (method: string, status: "pass" | "fail" | "error", message: string) =>
    v3RowVerdict(
      ref(method),
      { codeunit: CU, name: `Codeunit${CU}.${method}`, method, status, message, notRun: true },
      1,
      5,
      undefined,
    );

  test("R678: a fully reused --resume snapshot's v3 refusal still notes a survivor (no baseline call in this session)", async () => {
    const l = await layout();
    const b = backendOf(l, fakeV3(() => []).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    b.noteReusedBaseline([
      { ref: ref("B"), verdict: notRunVerdict("B", "error", "NotRun: out-of-scope: Commit") },
    ]);
    expect(b.survivorNote([ref("A")])).toStartWith(`${V3_REFUSED_NEARBY_TAG} Tests.B:`);
    expect(b.survivorNote([ref("Q", 1)])).toBeUndefined();
  });

  test("R678: a reused snapshot with no v3 refusal notes nothing (a timeout, a contract error, a .NET-shaped refusal, a pass)", async () => {
    const l = await layout();
    const b = backendOf(l, fakeV3(() => []).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    const dotnetShaped = v3RowVerdict(
      ref("D"),
      {
        codeunit: CU,
        name: `Codeunit${CU}.D`,
        method: "D",
        status: "fail",
        message: "Commit: out-of-scope: x",
        notRun: false,
      },
      1,
      5,
      undefined,
    );
    expect(dotnetShaped.runnerRow).toBe("runner-refused");
    b.noteReusedBaseline([
      { ref: ref("T"), verdict: notRunVerdict("T", "error", "Test exceeded 1s timeout.") },
      { ref: ref("C"), verdict: notRunVerdict("C", "fail", "NotRun: out-of-scope: Commit") },
      { ref: ref("D"), verdict: dotnetShaped },
      { ref: ref("A"), verdict: { ref: ref("A"), outcome: "pass", durationMs: 1 } },
    ]);
    expect(b.survivorNote([ref("A")])).toBeUndefined();
  });

  test("R678: a reused verdict with v3's notRun refusal text but no runner-refused row throws by name, never records nothing", async () => {
    const l = await layout();
    const b = backendOf(l, fakeV3(() => []).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    const refused = notRunVerdict("B", "error", "NotRun: out-of-scope: Commit");
    // Today's shapes, refusal and not, do not throw.
    expect(() =>
      b.noteReusedBaseline([
        { ref: ref("B"), verdict: refused },
        { ref: ref("T"), verdict: notRunVerdict("T", "error", "Test exceeded 1s timeout.") },
        { ref: ref("C"), verdict: notRunVerdict("C", "fail", "NotRun: out-of-scope: Commit") },
        { ref: ref("A"), verdict: { ref: ref("A"), outcome: "pass", durationMs: 1 } },
      ]),
    ).not.toThrow();
    const { runnerRow: _dropped, ...malformed } = refused;
    expect(() => b.noteReusedBaseline([{ ref: ref("M"), verdict: malformed }])).toThrow(
      AlRunnerV3ReusedBaselineUnclassifiedError,
    );
    expect(() =>
      b.noteReusedBaseline([
        { ref: ref("M"), verdict: { ...refused, runnerRow: "runner-test-error" } },
      ]),
    ).toThrow(AlRunnerV3ReusedBaselineUnclassifiedError);
  });

  test("R678: a fresh baseline's notRun row with a non-error status (a contract error, not a refusal) notes nothing, as a reused one would", async () => {
    const l = await layout();
    const rows = () => [
      { method: "A", status: "pass" as const },
      {
        method: "B",
        status: "fail" as const,
        notRun: true,
        message: "NotRun: out-of-scope: Commit",
      },
    ];
    const b = backendOf(l, fakeV3(rows, { coverage: plainCoverage }).spawn, fakeAlc().io);
    await b.deploy(l.batch);
    await b.activate(null);
    expect((await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 })).runnerRow).toBe(
      "runner-test-error",
    );
    expect(b.survivorNote([ref("A")])).toBeUndefined();
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

// R666 (R349 on v3): v3 labels a target file's coverage by the deployed flat path, in the EMITTED
// line numbers of that batch's text (measured on alpha.2, /coord/handoff/R-666/measure.md §2).
// So batch 1's lines must be read through batch 1's index. Two guards keep the index fresh:
// `resetLayoutState()` clears it, and `deploy()` assigns the new one unconditionally. Either alone
// is enough, so deleting only one of them leaves this test green BY DESIGN; it goes red only when
// both go (the stale index), or when batch 1 gets no index at all.
describe("R666: batch 1's coverage is read through batch 1's layout (one-shot)", () => {
  // Batch 0: Grow on lines 3-6, Twice on lines 8-15; the object ends on line 16.
  const BATCH0_AL = `codeunit 79000 "Logic"
{
    procedure Grow(X: Integer): Integer
    begin
        exit(X + 1);
    end;

    procedure Twice(X: Integer): Integer
    // padding: Twice spans lines 8 to 15 here
    //
    //
    //
    begin
        exit(X * 2);
    end;
}
`;
  // Batch 1: Grow lengthened to lines 3-14, so Twice's exit (line 18) is past batch 0's object.
  const BATCH1_AL = `codeunit 79000 "Logic"
{
    procedure Grow(X: Integer): Integer
    begin
        X := X + 1;
        X := X + 1;
        X := X + 1;
        X := X + 1;
        X := X + 1;
        X := X + 1;
        X := X + 1;
        X := X + 1;
        exit(X);
    end;

    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
  test("batch 1's Grow line inside batch 0's Twice span is Grow, and its Twice line past batch 0's end is Twice", async () => {
    const l = await layout(BATCH0_AL);
    // A calls Grow, B calls Twice; each hit is at the emitted line of the batch deployed now.
    let lines = { A: 5, B: 14 };
    const cov = (_id: string, active: string) => ({
      coverage: [],
      perTestCoverage: (["A", "B"] as const).map((m) => ({
        test: `Codeunit${CU}.${m}`,
        coverage: [
          {
            file: join(active, "Logic.Codeunit.al"),
            statements: [{ line: lines[m], hits: 1, scope: m === "A" ? "Grow" : "Twice" }],
          },
        ],
      })),
    });
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    const procs = async () => {
      await b.activate(null);
      const out: (string | undefined)[][] = [];
      for (const m of ["A", "B"]) {
        const v = await b.run(ref(m), { coverage: "al-runner", timeoutMs: 1000 });
        out.push((v.coverage?.entries ?? [{ procedure: "<no coverage>" }]).map((e) => e.procedure));
      }
      return out;
    };
    await b.deploy(l.batch);
    expect(await procs()).toEqual([["Grow"], ["Twice"]]);
    // The next batch: the same file, instrumented differently.
    await writeFile(join(l.batch, "Logic.Codeunit.al"), BATCH1_AL);
    lines = { A: 10, B: 18 };
    await b.deploy(l.batch);
    expect(await procs()).toEqual([["Grow"], ["Twice"]]);
  });
});

describe("R602 A1/A2: a multi-object batch deploys with coverage on, and its second object is covered", () => {
  // `Logic` (79000) is the file's SECOND object: header on line 9, `exit(X * 2)` on line 13.
  const MULTI = `codeunit 79001 "First"
{
    procedure One(): Integer
    begin
        exit(1);
    end;
}

${TARGET_AL}`;
  const cov = (_id: string, active: string) => ({
    coverage: [],
    perTestCoverage: [
      {
        test: `Codeunit${CU}.A`,
        coverage: [
          {
            file: join(active, "Logic.Codeunit.al"),
            statements: [{ line: 13, hits: 1, scope: "Twice" }],
          },
        ],
      },
      { test: `Codeunit${CU}.B`, coverage: [] },
    ],
  });

  test("A2: deploy does not throw on a multi-object file (the old frame throw is gone)", async () => {
    const l = await layout(MULTI);
    const b = backendOf(l, fakeV3(allPass, { coverage: cov }).spawn, fakeAlc().io, {
      coverage: "al-runner",
    });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
  });

  test("A1: test A's coverage is the SECOND object's procedure, at its own object line", async () => {
    // File line 13 is object line 6: the second object's base is 8 (R383's frame, the line before
    // its header), the same frame the line map and BC use.
    const l = await layout(MULTI);
    const b = backendOf(l, fakeV3(allPass, { coverage: cov }).spawn, fakeAlc().io, {
      coverage: "al-runner",
    });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    const a = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(a.coverage?.entries).toEqual([
      { objectType: "Codeunit", objectId: 79000, procedure: "Twice", line: 6 },
    ]);
    expect(
      (await b.run(ref("B"), { coverage: "al-runner", timeoutMs: 1000 })).coverage?.entries,
    ).toEqual([]);
  });
});

describe("R609: a test v3 refused MID-RUN keeps the coverage it reached before the refusal", () => {
  const LOGIC = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;
  // A has a per-test entry that hits Logic line 6; B has an entry that hits only its own test file.
  const cov = (_id: string, active: string, testDir: string) => ({
    coverage: [],
    perTestCoverage: [
      {
        test: `Codeunit${CU}.A`,
        coverage: [
          { file: join(active, "Logic.Codeunit.al"), statements: [{ line: 6, hits: 1 }] },
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 7, hits: 1 }] },
        ],
      },
      {
        test: `Codeunit${CU}.B`,
        coverage: [
          { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 12, hits: 1 }] },
        ],
      },
    ],
  });
  const REFUSAL = "NotRun: out-of-scope: an outbound HTTP request";
  const runA = async (rowA: FakeRow, coverageFn: typeof cov = cov) => {
    const l = await layout(LOGIC);
    const v3 = fakeV3(() => [rowA, { method: "B", status: "pass" as const }], {
      coverage: coverageFn,
    });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    return b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
  };

  test("a refused notRun row with a per-test entry carries that coverage", async () => {
    const v = await runA({ method: "A", status: "error", notRun: true, message: REFUSAL });
    expect(v.runnerRow).toBe("runner-refused");
    expect(v.coverage?.entries.length ?? 0).toBeGreaterThan(0);
  });

  test("a row refused BEFORE it starts (no per-test entry) does not throw and has no coverage", async () => {
    const none = (_id: string, _a: string, testDir: string) => ({
      coverage: [],
      perTestCoverage: [
        {
          test: `Codeunit${CU}.B`,
          coverage: [
            { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 12, hits: 1 }] },
          ],
        },
      ],
    });
    const v = await runA({ method: "A", status: "error", notRun: true, message: REFUSAL }, none);
    expect(v.runnerRow).toBe("runner-refused");
    expect(v.coverage).toBeUndefined();
  });

  test("R762 A: a coverage-none call on the unmutated selector (a kill confirm) omits --coverage-json and joins no coverage", async () => {
    const noEntry = (_id: string, _a: string, testDir: string) => ({
      coverage: [],
      perTestCoverage: [
        {
          test: `Codeunit${CU}.B`,
          coverage: [
            { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 12, hits: 1 }] },
          ],
        },
      ],
    });
    const l = await layout(LOGIC);
    const v3 = fakeV3(allPass, { coverage: noEntry });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    // Master reads the missing entry as unavailable and throws; honoured "none" never looks.
    const v = await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    expect(v.outcome).toBe("pass");
    expect(v.coverage).toBeUndefined();
    expect(v3.calls).toHaveLength(1);
    expect(v3.calls[0]).not.toContain("--coverage-json");
  });

  test("R762 A: a coverage-none confirm, then a coverage-wanting call on the same codeunit, re-calls with --coverage-json and joins coverage", async () => {
    const l = await layout(LOGIC);
    const v3 = fakeV3(allPass, { coverage: cov });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
    const v = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(v3.calls).toHaveLength(2);
    expect(v3.calls[0]).not.toContain("--coverage-json");
    expect(v3.calls[1]).toContain("--coverage-json");
    expect(v.coverage?.entries.length ?? 0).toBeGreaterThan(0);
  });

  test("R762 A: the baseline call (coverage al-runner) still passes --coverage-json and still throws on unavailable coverage", async () => {
    const l = await layout(LOGIC);
    const v3 = fakeV3(allPass, { coverage: () => undefined });
    const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
    b.useBuildSymbols([]);
    await b.deploy(l.batch);
    await b.activate(null);
    await expect(b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 })).rejects.toThrow(
      /R586 §6/,
    );
    expect(v3.calls[0]).toContain("--coverage-json");
  });

  test("a PASSING row with no per-test entry still refuses (R586 §6)", async () => {
    const none = (_id: string, _a: string, testDir: string) => ({
      coverage: [],
      perTestCoverage: [
        {
          test: `Codeunit${CU}.B`,
          coverage: [
            { file: join(testDir, "Tests.Codeunit.al"), statements: [{ line: 12, hits: 1 }] },
          ],
        },
      ],
    });
    await expect(runA({ method: "A", status: "pass" }, none)).rejects.toThrow(/R586 §6/);
  });

  test("a timeout notRun row stays without coverage", async () => {
    const v = await runA({
      method: "A",
      status: "error",
      notRun: true,
      message: "Test exceeded 1s timeout.",
    });
    expect(v.outcome).toBe("timeout");
    expect(v.coverage).toBeUndefined();
  });

  test("a refusal-marker row (a fail, not notRun) stays without coverage", async () => {
    const v = await runA({ method: "A", status: "fail", message: REFUSAL });
    expect(v.runnerRow).toBe("runner-test-error");
    expect(v.coverage).toBeUndefined();
  });
});

// R739: a session's notifier gets the backend's notices; the console gets none. Each test goes red
// if its site reverts to `console.warn`.
describe("R739: v3 notices reach setNotify, never the console", () => {
  const notices = (b: ReturnType<typeof backendOf>) => {
    const seen: Array<[string, string]> = [];
    b.setNotify((c, m) => seen.push([c, m]));
    return seen;
  };

  test("exit 8 is an al-runner-v3-dotnet-helper-missing notice, once per session, again in the next", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l = await layout();
      const b = backendOf(l, fakeV3(allPass, { exit: 8 }).spawn, fakeAlc().io, {
        coverage: "none",
      });
      const first = notices(b);
      await b.deploy(l.batch);
      await b.activate(null);
      await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
      await b.run(ref("B"), { coverage: "none", timeoutMs: 1000 });
      expect(first.map(([c]) => c)).toEqual(["al-runner-v3-dotnet-helper-missing"]);
      // A second session on the same backend sees its own notice (setNotify resets the flag).
      b.setNotify(undefined);
      const second = notices(b);
      await b.deploy(l.batch); // the next session's deploy clears the cached answers
      await b.activate(null);
      await b.run(ref("A"), { coverage: "none", timeoutMs: 1000 });
      expect(second.map(([c]) => c)).toEqual(["al-runner-v3-dotnet-helper-missing"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a disagreeing scope under coverage is an al-runner-v3-scope-disagreement notice", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l = await layout();
      const v3 = fakeV3(allPass, {
        coverage: (_id, active) => ({
          coverage: [],
          perTestCoverage: [
            {
              test: `Codeunit${CU}.A`,
              coverage: [
                {
                  file: join(active, "Logic.Codeunit.al"),
                  statements: [{ line: 5, hits: 1, scope: "NotTwice" }],
                },
              ],
            },
          ],
        }),
      });
      const b = backendOf(l, v3.spawn, fakeAlc().io, { coverage: "al-runner" });
      b.useBuildSymbols([]);
      const seen = notices(b);
      await b.deploy(l.batch);
      await b.activate(null);
      const a = await b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
      expect(a.coverage?.entries.map((e) => e.procedure)).toEqual(["Twice"]);
      expect(seen.map(([c]) => c)).toEqual(["al-runner-v3-scope-disagreement"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("the coverage index's refusals are coverage-refused-object notices, through the backend's notifier", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l = await layout();
      await writeFile(
        join(l.batch, "Wrapped.Codeunit.al"),
        '#if SOMESYM\ncodeunit 79050 "W"\n{\n}\n#else\ncodeunit 79050 "W"\n{\n}\n#endif\n',
      );
      const b = backendOf(l, fakeV3(allPass).spawn, fakeAlc().io, { coverage: "al-runner" });
      b.useBuildSymbols([]);
      const seen = notices(b);
      await b.deploy(l.batch);
      expect(seen.map(([c]) => c)).toEqual(["coverage-refused-object"]);
      expect(seen[0]?.[1]).toContain("coverage refused for Codeunit:79050");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
