// R635: the serve + entries transport of the al-runner v3 backend, against a scripted fake
// `serve` daemon and a fake one-shot v3. Plan
// docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md (r3) §9, tests 1-13 and 16-21; the
// orchestrator's seams (tests 14, 15) are in orchestrator.test.ts. Call counters, no wall clock.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { emitResourceSelector, emitStaticSelector } from "@lethal/schemata";
import { v3ItestTransport, v3SplitLine } from "../itest/al-runner-v3-gate";
import {
  AlRunnerServer,
  AlRunnerServerRequestError,
  LineReader,
  type ServerProcessHandle,
  type ServerSpawnFn,
} from "../src/al-runner-server";
import {
  AL_RUNNER_V3_VERSION,
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3DependencySkippedError,
  AlRunnerV3RowMissingError,
  AlRunnerV3ServeStopUnsetError,
  AlRunnerV3UnprovenBatchError,
  WINDOW_BOUND_CAVEAT,
  v3CallDeadlineMs,
} from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import {
  AlRunnerV3EntriesEncodeError,
  AlRunnerV3EntriesRefusedError,
  SELECTOR_ECHO_FILENAME,
  batchRefusalReason,
  chunkGroups,
  emitSelectorEcho,
  encodeGroups,
  assertEntriesWellFormed as wellFormed,
} from "../src/al-runner-v3-entries";
import type { ArtifactIo } from "../src/artifact";
import type { RunOpts, TestMethodRef, TestVerdict } from "../src/backend";
import { buildBackend } from "../src/cli";
import type { SpawnFn } from "../src/publisher";
import { installResourceSelector } from "../src/resource-selector";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const SELECTOR_ID = 79199;
const ECHO = 79198;
const ARTIFACT = "0123456789abcdef0123456789abcdef";
const CU = 79100;
const CU2 = 79101;
const OPTS: RunOpts = { coverage: "none", timeoutMs: 1000 };
const MUTANTS = ["M0001", "M0002", "M0003", "M00010"];
const UNLISTED = "NotRun: out-of-scope: the install baseline read resource active-mutant.txt";
const COMMIT =
  "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function: what the runner keeps is not pinned";
const TIMEOUT_1S = "Test exceeded 1s timeout.";

const TARGET_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
// The Sleep sits on line 5 (the §6 index), as in al-runner-v3-backend.test.ts.
const SLEEPER_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;
const testAl = (cu: number, methods: readonly string[]) => `codeunit ${cu} "Tests${cu}"
{
    Subtype = Test;
${methods.map((m) => `\n    [Test]\n    procedure ${m}()\n    begin\n    end;\n`).join("")}}
`;

const ref = (method: string, codeunitId = CU): TestMethodRef => ({
  codeunitId,
  codeunitName: `Tests${codeunitId}`,
  method,
});
const SUITE1 = [ref("A"), ref("B")];
const SUITE2 = [ref("A"), ref("B"), ref("C", CU2)];

function fakeApp(id: string): Buffer {
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${id}" Name="X" Publisher="LethAL" Version="1.0.0.0" /></Package>`,
  });
}

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

async function layout(targetAl: string, suite: readonly TestMethodRef[]): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "lethal-v3e-"));
  roots.push(root);
  const batch = join(root, "batch");
  const testDir = join(root, "tests");
  const deps = join(root, "deps");
  for (const d of [batch, testDir, deps]) await mkdir(d, { recursive: true });
  await writeFile(
    join(batch, "app.json"),
    JSON.stringify({ id: TARGET_ID, name: "T", version: "1.0.0.0", runtime: "17.0" }),
  );
  await writeFile(
    join(batch, "mutant-manifest.json"),
    JSON.stringify({
      selectorIds: { selectorId: SELECTOR_ID, controlId: ECHO, tableId: 79197 },
      artifactId: ARTIFACT,
      mutants: MUTANTS.map((mutantId) => ({ mutantId, objectType: "Codeunit", codeunitId: 79000 })),
    }),
  );
  await writeFile(join(batch, "MutationSelector.Codeunit.al"), "codeunit 79199 x { }");
  await writeFile(join(batch, "MutationRegister.Codeunit.al"), "codeunit 79198 r { }");
  await writeFile(join(batch, "Logic.Codeunit.al"), targetAl);
  await writeFile(
    join(testDir, "app.json"),
    JSON.stringify({ id: "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7", name: "Tests" }),
  );
  const byCu = new Map<number, string[]>();
  for (const r of suite) byCu.set(r.codeunitId, [...(byCu.get(r.codeunitId) ?? []), r.method]);
  for (const [cu, methods] of byCu) {
    await writeFile(join(testDir, `Tests${cu}.Codeunit.al`), testAl(cu, methods));
  }
  await writeFile(
    join(deps, "Microsoft_System.app"),
    fakeApp("8874ed3a-0643-4247-9ced-7a7002f7135d"),
  );
  return { root, batch, testDir, deps, scratch: join(root, "scratch") };
}

function fakeAlc(): ArtifactIo {
  return {
    spawn: async (argv) => {
      const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
      await writeFile(out, "app");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readArtifact: async (p) => new Uint8Array(await readFile(p)),
    writeArtifact: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
  };
}

interface FakeRow {
  method: string;
  status: "pass" | "fail" | "error";
  message?: string;
  notRun?: boolean;
}
/** R586c (B2): a real CPU stop takes at least its stop; the fake's stop rows say so. */
const stopMsOf = (message: string | undefined): number => {
  const m = /^Test exceeded (\d+)s timeout\./.exec(message ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
};
/** `n` is the request's index over the whole fake (every daemon); -1 for a one-shot call. */
type RowsFn = (mutant: string, cu: number, daemon: number, n: number) => FakeRow[];
type CoverageFn = (mutant: string, cu: number, active: string, testDir: string) => unknown;

const SUITE_METHODS: Record<number, string[]> = { [CU]: ["A", "B"], [CU2]: ["C"] };
const allPass: RowsFn = (_m, cu) =>
  (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const }));
const killsM1: RowsFn = (m, cu, d, n) =>
  allPass(m, cu, d, n).map((r) =>
    m === "M0001" && r.method === "A" ? { ...r, status: "fail" as const, message: "boom" } : r,
  );

const resourceFile = (active: string) => join(active, "LethALResources", "active-mutant.txt");

/** Per-test coverage where every test hits one statement of its own test file. */
const plainCoverage: CoverageFn = (_m, cu, _active, testDir) => ({
  coverage: [
    {
      file: join(testDir, `Tests${cu}.Codeunit.al`),
      statements: [
        { line: 7, hits: 1 },
        { line: 12, hits: 1 },
      ],
    },
  ],
  perTestCoverage: (SUITE_METHODS[cu] ?? []).map((m, i) => ({
    test: `Codeunit${cu}.${m}`,
    coverage: [
      {
        file: join(testDir, `Tests${cu}.Codeunit.al`),
        statements: [{ line: i === 0 ? 7 : 12, hits: 1 }],
      },
    ],
  })),
});

/** §6 coverage of the SLEEPER target: line 5 listed, hit by A only when `hit`. */
const sleepCoverage =
  (hit = false): CoverageFn =>
  (_m, cu, active, testDir) => {
    const target = join(active, "Logic.Codeunit.al");
    const own = (m: string) => ({
      test: `Codeunit${cu}.${m}`,
      coverage: [
        { file: join(testDir, `Tests${cu}.Codeunit.al`), statements: [{ line: 7, hits: 1 }] },
        ...(hit && m === "A" ? [{ file: target, statements: [{ line: 5, hits: 1 }] }] : []),
      ],
    });
    return {
      coverage: [
        { file: join(testDir, `Tests${cu}.Codeunit.al`), statements: [{ line: 7, hits: 1 }] },
        {
          file: target,
          statements: [
            { line: 5, hits: hit ? 1 : 0 },
            { line: 6, hits: 0 },
          ],
        },
      ],
      perTestCoverage: (SUITE_METHODS[cu] ?? []).map(own),
    };
  };

/** The one-shot v3 (`test --codeunit`): reads the active id from the resource file on disk. */
function fakeOneShot(rows: RowsFn, coverage?: CoverageFn) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    const active = argv.at(-2) ?? "";
    const testDir = argv.at(-1) ?? "";
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const m = await readFile(resourceFile(active), "utf8").catch(() => "STATIC");
    const cov = coverage?.(m, cu, active, testDir);
    if (cov !== undefined) {
      await writeFile(argv[argv.indexOf("--coverage-json") + 1] ?? "", JSON.stringify(cov));
    }
    const tests = rows(m, cu, -1, -1).map((r) => ({
      codeunit: cu,
      method: r.method,
      name: `Codeunit${cu}.${r.method}`,
      status: r.status,
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.notRun === true ? { notRun: true } : {}),
    }));
    return { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "" };
  };
  return { spawn, calls };
}

/** A byte channel a test pushes lines into: the fake daemon's stdout. */
class Chan implements AsyncIterable<Uint8Array> {
  private readonly q: Uint8Array[] = [];
  private readonly waiting: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;
  push(line: string): void {
    if (this.closed) return;
    const v = new TextEncoder().encode(`${line}\n`);
    const w = this.waiting.shift();
    if (w !== undefined) w({ value: v, done: false });
    else this.q.push(v);
  }
  end(): void {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const v = this.q.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiting.push(r));
      },
      return: async () => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

interface Req {
  readonly daemon: number;
  readonly body: Record<string, unknown>;
  /** The resource file's text on disk when the request arrived. */
  readonly onDisk: string;
  /** Entry ids, or `plain:<test>` for a plain request. */
  readonly ids: string[];
}
type Echo = (mutant: string, daemon: number, n: number) => FakeRow | FakeRow[] | "none";
interface ServeScript {
  rows?: RowsFn;
  echo?: Echo;
  /** Replaces a request's answer lines; `eof` ends stdout after them. */
  answer?: (
    req: Req,
    n: number,
    lines: Record<string, unknown>[],
  ) => { lines: unknown[]; eof?: boolean } | undefined;
  coverage?: CoverageFn;
  /** R590: a line the daemon writes to stderr as the request arrives. */
  stderr?: (req: Req, n: number) => string | undefined;
}
const goodEcho: Echo = (m) => ({
  method: "Echo",
  status: "fail",
  message: `LETHAL-ECHO:${m}:true`,
});

/** A scripted `al-runner serve`: entries per measure.md §1, plain requests, `cached` by compile set. */
function fakeServe(script: ServeScript = {}) {
  const rows = script.rows ?? allPass;
  const echo = script.echo ?? goodEcho;
  const daemons: string[][] = [];
  const requests: Req[] = [];
  /** R672: each shutdown, with how many requests (over every daemon) came before it. */
  const closes: { daemon: number; afterRequests: number }[] = [];
  /** R645: the working directory each daemon was started in. */
  const cwds: (string | undefined)[] = [];
  const spawn: ServerSpawnFn = (argv, opts) => {
    const daemon = daemons.length;
    daemons.push([...argv]);
    cwds.push(opts?.cwd);
    const out = new Chan();
    const err = new Chan();
    let compiled = new Set<number>();
    out.push(JSON.stringify({ ready: true }));
    const handle: ServerProcessHandle = {
      stdout: out,
      stderr: err,
      kill: () => out.end(),
      write: (line) => {
        void (async () => {
          const body = JSON.parse(line) as Record<string, unknown>;
          if (body.command === "shutdown") {
            closes.push({ daemon, afterRequests: requests.length });
            out.push("{}");
            out.end();
            return;
          }
          const sources = body.sourcePaths as string[];
          const active = sources[0] ?? "";
          const testDir = sources[1] ?? "";
          const onDisk = await readFile(resourceFile(active), "utf8").catch(() => "?");
          const entries = (body.entries as Record<string, unknown>[] | undefined) ?? [];
          const n = requests.length;
          const req: Req = {
            daemon,
            body,
            onDisk,
            ids:
              entries.length > 0
                ? entries.map((e) => String(e.id))
                : [`plain:${String(body.test)}`],
          };
          requests.push(req);
          const errLine = script.stderr?.(req, n);
          if (errLine !== undefined) err.push(errLine);
          const cuOf = (t: unknown) => Number(/^Codeunit(\d+)\.$/.exec(String(t))?.[1]);
          const rowsOf = (m: string, cu: number): FakeRow[] => {
            if (cu !== ECHO) return rows(m, cu, daemon, n);
            const e = echo(m, daemon, n);
            return e === "none" ? [] : Array.isArray(e) ? e : [e];
          };
          const lines: Record<string, unknown>[] = [];
          const sums = { passed: 0, failed: 0, errors: 0, notRun: 0, total: 0 };
          const count = (rs: FakeRow[]) => {
            const c = {
              passed: rs.filter((r) => r.status === "pass" && r.notRun !== true).length,
              failed: rs.filter((r) => r.status === "fail" && r.notRun !== true).length,
              errors: rs.filter((r) => r.status === "error").length,
              notRun: rs.filter((r) => r.notRun === true).length,
              total: rs.length,
            };
            for (const k of Object.keys(sums) as (keyof typeof sums)[]) sums[k] += c[k];
            return c;
          };
          const testLine = (cu: number, r: FakeRow, entry?: string) => ({
            type: "test",
            name: `Codeunit${cu}.${r.method}`,
            status: r.status,
            durationMs: stopMsOf(r.message),
            ...(r.message !== undefined ? { message: r.message } : {}),
            ...(r.notRun === true ? { notRun: true } : {}),
            ...(entry !== undefined ? { entry } : {}),
          });
          let selected: Set<number>;
          let extra: Record<string, unknown> = {};
          if (entries.length > 0) {
            selected = new Set(entries.map((e) => cuOf(e.test)));
            const per: Record<string, unknown>[] = [];
            for (const e of entries) {
              const m = String((e.resources as Record<string, string>)["active-mutant.txt"]);
              const cu = cuOf(e.test);
              const rs = rowsOf(m, cu);
              for (const r of rs) lines.push(testLine(cu, r, String(e.id)));
              per.push({ type: "entrySummary", entry: e.id, ...count(rs) });
            }
            lines.push(...per);
          } else {
            const cu = cuOf(body.test);
            selected = new Set([cu]);
            const rs = rowsOf(onDisk, cu);
            for (const r of rs) lines.push(testLine(cu, r));
            count(rs);
            if (body.coverage === true) {
              const doc = (script.coverage?.(onDisk, cu, active, testDir) ?? {
                coverage: [],
                perTestCoverage: [],
              }) as Record<string, unknown>;
              extra = { coverage: doc.coverage, perTestCoverage: doc.perTestCoverage };
            }
          }
          const cached = [...selected].every((c) => compiled.has(c));
          if (!cached) compiled = selected;
          lines.push({ type: "summary", cached, exitCode: 0, ...sums, ...extra });
          const over = script.answer?.(req, n, lines);
          for (const l of over?.lines ?? lines) out.push(JSON.stringify(l));
          if (over?.eof === true) out.end();
        })();
      },
    };
    return handle;
  };
  /** The first request each daemon got. */
  const firsts = () => daemons.map((_, d) => requests.find((r) => r.daemon === d));
  return { spawn, daemons, requests, firsts, closes, cwds };
}

interface Rig {
  readonly l: Layout;
  readonly b: AlRunnerV3Backend;
  readonly serve: ReturnType<typeof fakeServe>;
  readonly one: ReturnType<typeof fakeOneShot>;
}

interface RigOpts {
  serve?: ServeScript;
  oneShotRows?: RowsFn;
  oneShotCoverage?: CoverageFn;
  extra?: Partial<AlRunnerV3Config>;
  targetAl?: string;
  suite?: readonly TestMethodRef[];
  floor?: readonly [number, number] | false;
  /** R651: the phase timers' clock. */
  now?: () => number;
}

async function rig(opts: RigOpts = {}): Promise<Rig> {
  const suite = opts.suite ?? SUITE1;
  const l = await layout(opts.targetAl ?? TARGET_AL, suite);
  const serve = fakeServe(opts.serve);
  const one = fakeOneShot(opts.oneShotRows ?? opts.serve?.rows ?? allPass, opts.oneShotCoverage);
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/al-runner",
      instrumentedDir: l.scratch,
      testDir: l.testDir,
      packagesDir: l.deps,
      bcVersion: "28.0.46665.47126",
      selectorObjectId: SELECTOR_ID,
      alcPath: "/fake/alc",
      coverage: "none",
      transport: "serve-entries",
      ...opts.extra,
    },
    one.spawn,
    fakeAlc(),
    serve.spawn,
    opts.now,
  );
  b.useBuildSymbols([]);
  b.useDiscoveredTests(suite);
  b.useSessionTests(suite);
  if (opts.floor !== false) b.useMutantBudgetFloor(...(opts.floor ?? [1000, 1000]));
  await b.deploy(l.batch);
  return { l, b, serve, one };
}

/** The orchestrator's baseline step: the bracket, a null activation, one run per ref. */
async function baseline(b: AlRunnerV3Backend, refs: readonly TestMethodRef[]) {
  b.baselinePhase(true);
  try {
    await b.activate(null);
    const out: TestVerdict[] = [];
    for (const r of refs) out.push(await b.run(r, OPTS));
    return out;
  } finally {
    b.baselinePhase(false);
  }
}

const plans = (ids: readonly string[], refs: readonly TestMethodRef[] = SUITE1) =>
  ids.map((mutantId) => ({ mutantId, refs }));

/** Deployed, baseline run, and the given mutants prefetched. */
async function readyRig(opts: RigOpts & { mutants?: readonly string[] } = {}): Promise<Rig> {
  const r = await rig(opts);
  await baseline(r.b, opts.suite ?? SUITE1);
  await r.b.prefetchMutants(plans(opts.mutants ?? ["M0001", "M0002"], opts.suite ?? SUITE1));
  return r;
}

const outcome = (v: TestVerdict) => [v.outcome, v.runnerRow ?? v.operation ?? ""];
const plainEcho = `plain:Codeunit${ECHO}.`;
const plainCu = `plain:Codeunit${CU}.`;

describe("1, 2, 3: the option, its default, the version line", () => {
  test("1: no transport -> one-shot exactly as before: static selector, no echo, no resource folder; prefetch and the bracket do nothing", async () => {
    const l = await layout(TARGET_AL, SUITE1);
    const serve = fakeServe();
    const one = fakeOneShot(allPass);
    const b = new AlRunnerV3Backend(
      {
        alRunnerPath: "/fake/al-runner",
        instrumentedDir: l.scratch,
        testDir: l.testDir,
        packagesDir: l.deps,
        bcVersion: "28.0.46665.47126",
        selectorObjectId: SELECTOR_ID,
        alcPath: "/fake/alc",
      },
      one.spawn,
      fakeAlc(),
      serve.spawn,
    );
    b.useSessionTests(SUITE1);
    b.useMutantBudgetFloor(1000, 1000);
    await b.deploy(l.batch);
    const active = join(l.scratch, "active");
    expect(await readFile(join(active, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      emitStaticSelector({
        objectId: SELECTOR_ID,
        activeId: "",
        artifactId: ARTIFACT,
        targetAppId: "",
      }),
    );
    const absent = (p: string) => readFile(p, "utf8").catch(() => "absent");
    expect(await absent(join(active, SELECTOR_ECHO_FILENAME))).toBe("absent");
    expect(await absent(resourceFile(active))).toBe("absent");
    expect(JSON.parse(await readFile(join(active, "app.json"), "utf8"))).toEqual({
      id: TARGET_ID,
      name: "T",
      version: "1.0.0.0",
      runtime: "17.0",
    });
    expect(b.inRunStopIsBudget).toBe(true);
    expect(b.inRunStopMs).toBeUndefined();
    await baseline(b, SUITE1);
    await b.prefetchMutants(plans(["M0001"]));
    await b.activate("M0001");
    await b.run(ref("A"), OPTS);
    await b.activate(null);
    await b.run(ref("A"), OPTS);
    expect(serve.daemons).toHaveLength(0);
    expect(one.calls).toHaveLength(3);
    expect(one.calls[1]?.slice(1, 3)).toEqual(["test", "--output-json"]);
  });

  test("1: the config's default transport is one-shot and secondEcho defaults on", () => {
    const c = validateAlRunnerV3Config({ packagesDir: "/p", bcVersion: "28.0.1.2" });
    expect(c.transport).toBe("one-shot");
    expect(c.secondEcho).toBe(true);
  });

  test("2: both transports accepted; another value, a non-boolean secondEcho and selectorMode are refused by name", () => {
    const base = { packagesDir: "/p", bcVersion: "28.0.1.2" };
    expect(validateAlRunnerV3Config({ ...base, transport: "one-shot" }).transport).toBe("one-shot");
    expect(validateAlRunnerV3Config({ ...base, transport: "serve-entries" }).transport).toBe(
      "serve-entries",
    );
    expect(validateAlRunnerV3Config({ ...base, secondEcho: false }).secondEcho).toBe(false);
    expect(() => validateAlRunnerV3Config({ ...base, transport: "serve" })).toThrow(
      /alRunnerV3\.transport/,
    );
    expect(() => validateAlRunnerV3Config({ ...base, secondEcho: "no" })).toThrow(
      /alRunnerV3\.secondEcho/,
    );
    expect(() => validateAlRunnerV3Config({ ...base, selectorMode: "resource" })).toThrow(
      /al-runner-v3-resource-selector-refused/,
    );
  });

  test("3: the version line accepts the edge build part", () => {
    expect(AL_RUNNER_V3_VERSION.test("al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)")).toBe(
      true,
    );
    expect(AL_RUNNER_V3_VERSION.test("alrunner 3.0.0-alpha.2 (91253f2d6)")).toBe(true);
  });

  test("3: the version line still refuses a v2 line and a line without the sha", () => {
    expect(AL_RUNNER_V3_VERSION.test("al-runner 2.12.0-main.c39ad5de (c39ad5de)")).toBe(false);
    expect(AL_RUNNER_V3_VERSION.test("al-runner 3.0.0-alpha.4+edge.20261022")).toBe(false);
  });
});

describe("4: the encoder throws on a caller-contract violation", () => {
  const e = (id: string, m: string, t: unknown = `Codeunit${CU}.`, extra = {}) => ({
    id,
    resources: { "active-mutant.txt": m },
    test: t,
    ...extra,
  });
  const echoOf = (m: string) => e(`${m}|echo`, m, `Codeunit${ECHO}.`);
  const assertEntriesWellFormed = (xs: readonly object[]) => wellFormed(xs, `Codeunit${ECHO}.`);

  test("a well-formed request passes, echo first", () => {
    expect(() => assertEntriesWellFormed([echoOf("M1"), e("M1|79100", "M1")])).not.toThrow();
    expect(encodeGroups([{ mutantId: "M1", codeunits: [CU] }], ECHO).map((x) => x.id)).toEqual([
      "M1|echo",
      `M1|${CU}`,
    ]);
  });
  test("a test array", () => {
    expect(() =>
      assertEntriesWellFormed([echoOf("M1"), e("M1|79100", "M1", [`Codeunit${CU}.`])]),
    ).toThrow(AlRunnerV3EntriesEncodeError);
  });
  test("an excludeTests that is not a list", () => {
    expect(() =>
      assertEntriesWellFormed([
        echoOf("M1"),
        e("M1|79100", "M1", `Codeunit${CU}.`, { excludeTests: "A" }),
      ]),
    ).toThrow(/excludeTests/);
  });
  test("a duplicate id", () => {
    expect(() =>
      assertEntriesWellFormed([echoOf("M1"), e("M1|79100", "M1"), e("M1|79100", "M1")]),
    ).toThrow(/duplicate/);
  });
  test("an id prefix that is not its override text", () => {
    expect(() => assertEntriesWellFormed([echoOf("M1"), e("M1|79100", "M2")])).toThrow(/override/);
  });
  test("a mutant without its echo", () => {
    expect(() => assertEntriesWellFormed([e("M1|79100", "M1")])).toThrow(
      /does not start with its echo/,
    );
  });
  test("a mutant with two echoes", () => {
    expect(() =>
      assertEntriesWellFormed([
        echoOf("M1"),
        { ...echoOf("M1"), id: "M1|echo2" },
        e("M1|79100", "M1"),
      ]),
    ).toThrow(/more than one echo/);
  });
  test("a mutant whose entries sit in two groups of one request", () => {
    // M1 comes back AFTER M2's group, starting with an echo of its own: only the group rule sees it.
    expect(() =>
      assertEntriesWellFormed([
        echoOf("M1"),
        e("M1|79100", "M1"),
        echoOf("M2"),
        { ...echoOf("M1"), id: "M1|echo2" },
        e("M1|79101", "M1"),
      ]),
    ).toThrow(/two groups/);
  });
  test("a group is never split across chunks: 257 entries go alone, other groups are cut between", () => {
    const big = { mutantId: "MBIG", codeunits: Array.from({ length: 256 }, (_, i) => 1000 + i) };
    const small = { mutantId: "M1", codeunits: [CU] };
    const chunks = chunkGroups([small, big, { mutantId: "M2", codeunits: [CU] }]);
    expect(chunks.map((c) => c.map((g) => g.mutantId))).toEqual([["M1"], ["MBIG"], ["M2"]]);
    for (const c of chunks) expect(() => encodeGroups(c, ECHO)).not.toThrow();
  });
  test("a re-sent tail without an echo", () => {
    const sent = encodeGroups([{ mutantId: "M1", codeunits: [CU, CU2] }], ECHO);
    expect(() => assertEntriesWellFormed(sent.slice(2))).toThrow(/does not start with its echo/);
  });
});

describe("5: the decoder never trusts the answer's grouping: every miss is error, nothing cached", () => {
  type Mutate = (lines: Record<string, unknown>[]) => { lines: unknown[]; eof?: boolean };
  const isLive = (req: Req) => req.ids[0] === "M0001|echo" && req.ids.length === 2;
  const tests = (ls: Record<string, unknown>[]) => ls.filter((x) => x.type === "test");
  const rest = (ls: Record<string, unknown>[]) => ls.filter((x) => x.type !== "test");
  const bump = (x: Record<string, unknown>, k: string, by: number) => ({
    ...x,
    [k]: Number(x[k]) + by,
  });
  const cases: Array<[string, Mutate]> = [
    ["an {error} line", () => ({ lines: [{ error: "`entries`: bad field" }] })],
    ["EOF before the summary", (ls) => ({ lines: ls.slice(0, -1), eof: true })],
    [
      "entrySummary ids out of the sent order",
      (ls) => ({
        lines: [...tests(ls), ...ls.filter((x) => x.type === "entrySummary").reverse(), ls.at(-1)],
      }),
    ],
    [
      "an extra row for an id never sent",
      (ls) => ({ lines: [...tests(ls), { ...tests(ls)[1], entry: "X|1" }, ...rest(ls)] }),
    ],
    [
      "a row of another codeunit inside an entry",
      (ls) => ({
        lines: ls.map((x) =>
          x.type === "test" && x.name === `Codeunit${CU}.A`
            ? { ...x, name: `Codeunit${CU2}.A` }
            : x,
        ),
      }),
    ],
    [
      "a duplicate (entry, name) row, counts adjusted",
      (ls) => {
        const dup = tests(ls).find((x) => x.entry === `M0001|${CU}`);
        return {
          lines: [
            ...tests(ls),
            dup,
            ...rest(ls).map((x) =>
              x.type === "summary" || x.entry === `M0001|${CU}`
                ? bump(bump(x, "passed", 1), "total", 1)
                : x,
            ),
          ],
        };
      },
    ],
    [
      "an entrySummary count higher than its rows",
      (ls) => ({
        lines: ls.map((x) =>
          x.type === "entrySummary" && x.entry === `M0001|${CU}` ? bump(x, "passed", 1) : x,
        ),
      }),
    ],
    [
      "an entrySummary count lower than its rows",
      (ls) => ({
        lines: ls.map((x) =>
          x.type === "entrySummary" && x.entry === `M0001|${CU}` ? bump(x, "total", -1) : x,
        ),
      }),
    ],
    [
      "a summary that is not the sum of the entries",
      (ls) => ({ lines: ls.map((x) => (x.type === "summary" ? bump(x, "total", 1) : x)) }),
    ],
  ];
  for (const [name, mutate] of cases) {
    test(`${name}: a transport error, never pass/fail/timeout, and nothing cached`, async () => {
      const r = await rig({
        serve: { answer: (req, _n, lines) => (isLive(req) ? mutate(lines) : undefined) },
      });
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans([]));
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      expect(outcome(v)).toEqual(["error", "pre-dispatch-rejected"]);
      const before = r.serve.requests.filter(isLive).length;
      await r.b.run(ref("A"), OPTS);
      expect(r.serve.requests.filter(isLive).length).toBe(before + 1);
    });
  }

  test("an entry that selected nothing (total 0) is rowMissing: an error under a mutant, never a survive", async () => {
    const r = await readyRig({
      serve: { rows: (m, cu, d, n) => (m === "M0001" ? [] : allPass(m, cu, d, n)) },
      oneShotRows: allPass,
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-test-error"]);
    expect(v.failureMessage).toContain("0 row(s)");
  });

  test("an entry without a suite test's row is rowMissing; outside a mutant it stops the session", async () => {
    // Request 0 is the warm-up (all rows); request 1, the confirm, lacks B.
    const r = await rig({
      serve: {
        rows: (m, cu, d, n) => allPass(m, cu, d, n).filter((x) => n === 0 || x.method !== "B"),
      },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans([]));
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3RowMissingError);
  });

  test("notRun with pass, and a timeout naming another stop than S, are error", async () => {
    const r = await readyRig({
      serve: {
        rows: (m, cu, d, n) =>
          m === "M0001"
            ? [
                { method: "A", status: "pass", notRun: true },
                {
                  method: "B",
                  status: "error",
                  notRun: true,
                  message: "Test exceeded 7s timeout.",
                },
              ]
            : allPass(m, cu, d, n),
      },
      oneShotRows: allPass,
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("error");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("error");
  });

  test("F4 (16): an {error} line ends runEntries at once with AlRunnerServerRequestError (deadline 1 h)", async () => {
    let written = 0;
    const out = new Chan();
    out.push(JSON.stringify({ ready: true }));
    const server = new AlRunnerServer(
      "/fake",
      () => ({
        stdout: out,
        stderr: new Chan(),
        kill: () => out.end(),
        write: (line) => {
          if ((JSON.parse(line) as { command?: string }).command === "shutdown") return out.end();
          written += 1;
          out.push(JSON.stringify({ error: "`entries` needs at least one entry" }));
        },
      }),
      [],
      "serve",
    );
    await server.start(10_000, [], 1);
    const err = await server.runEntries({ command: "runTests" }, 3_600_000).catch((e) => e);
    expect(err).toBeInstanceOf(AlRunnerServerRequestError);
    expect((err as AlRunnerServerRequestError).kind).toBe("error");
    expect(written).toBe(1);
    await server.close();
  });
});

describe("6: the echo is matched exactly", () => {
  const withEcho =
    (bad: Echo): Echo =>
    (m, d, n) =>
      m === "M0001" ? bad(m, d, n) : goodEcho(m, d, n);
  test("LETHAL-ECHO:M0001:true stands: the pass is scored", async () => {
    const r = await readyRig({ mutants: ["M0001"] });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
  });
  const wrong: Array<[string, Echo]> = [
    [
      "another id sharing the prefix (M00010)",
      () => ({ method: "Echo", status: "fail", message: "LETHAL-ECHO:M00010:true" }),
    ],
    [
      "the selector disagreed (:false)",
      (m) => ({ method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:false` }),
    ],
    ["missing", () => "none"],
    [
      "two rows, the first one exact",
      (m) => [
        { method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` },
        { method: "Echo2", status: "fail", message: "x" },
      ],
    ],
    ["pass", (m) => ({ method: "Echo", status: "pass", message: `LETHAL-ECHO:${m}:true` })],
    [
      // A refusal R612 keeps, so the echo stands and is read (an unkept one is test 10's case).
      "notRun (a kept refusal)",
      () => ({ method: "Echo", status: "error", notRun: true, message: COMMIT }),
    ],
  ];
  for (const [name, bad] of wrong) {
    test(`${name} -> every row of the group is error entries-echo-mismatch`, async () => {
      const r = await readyRig({ serve: { echo: withEcho(bad) }, mutants: ["M0001"] });
      await r.b.activate("M0001");
      for (const m of ["A", "B"]) {
        const v = await r.b.run(ref(m), OPTS);
        expect(outcome(v)).toEqual(["error", "runner-test-error"]);
        expect(v.failureMessage).toContain("entries-echo-mismatch");
      }
    });
  }
});

describe("7: selector parity: v2's staged resource selector bytes, and the echo", () => {
  test("the shared installer writes the R222 resource selector, its folder and NONE, byte for byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-v3e-sel-"));
    roots.push(dir);
    await writeFile(join(dir, "app.json"), JSON.stringify({ id: "x", runtime: "17.0" }));
    await installResourceSelector(dir, 50000, ARTIFACT);
    expect(await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      `codeunit 50000 "Mutation Selector"
{
    SingleInstance = true;

    var
        Loaded: Boolean;
        ActiveId: Text;

    procedure Active(MutantId: Text): Boolean
    begin
        if not Loaded then begin
            ActiveId := NavApp.GetResourceAsText('active-mutant.txt', TextEncoding::UTF8);
            Loaded := true;
        end;
        exit(MutantId = ActiveId);
    end;

    procedure Reached(MutantId: Text)
    begin
        // ponytail: al-runner has no channel back to LethAL, so reach is not measured there (GH-24).
    end;

    procedure ArtifactId(): Text
    begin
        exit('${ARTIFACT}');
    end;

    procedure TargetAppId(): Text
    begin
        exit('');
    end;
}
`,
    );
    expect(await readFile(resourceFile(dir), "utf8")).toBe("NONE");
    expect(JSON.parse(await readFile(join(dir, "app.json"), "utf8")).resourceFolders).toEqual([
      "LethALResources",
    ]);
  });

  test("serve-entries stages that resource selector, the echo at controlId, and drops the register file", async () => {
    const r = await rig();
    const active = join(r.l.scratch, "active");
    expect(await readFile(join(active, "MutationSelector.Codeunit.al"), "utf8")).toBe(
      emitResourceSelector({ objectId: SELECTOR_ID, artifactId: ARTIFACT, targetAppId: "" }),
    );
    expect(await readFile(join(active, SELECTOR_ECHO_FILENAME), "utf8")).toBe(
      emitSelectorEcho(ECHO),
    );
    expect(emitSelectorEcho(ECHO)).toContain(`codeunit ${ECHO} `);
    expect(emitSelectorEcho(ECHO)).toContain("Error('LETHAL-ECHO:%1:%2', t, r);");
    expect(
      await readFile(join(active, "MutationRegister.Codeunit.al"), "utf8").catch(() => "gone"),
    ).toBe("gone");
  });

  test("assertBound refuses a resource file that is not NONE between requests", async () => {
    const r = await readyRig({ mutants: [] });
    await writeFile(resourceFile(join(r.l.scratch, "active")), "M0001");
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toThrow(/active-mutant\.txt/);
  });
});

describe("8, 14 (backend half): the baseline flag, never lastActivated, decides what a null activation is", () => {
  test("8: inside the bracket a null activation is the one-shot call; outside it a live NONE group with its echo", async () => {
    const r = await rig();
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(1);
    expect(r.serve.requests).toHaveLength(0);
    await r.b.prefetchMutants(plans([]));
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.one.calls).toHaveLength(1);
    const live = r.serve.requests.at(-1);
    expect(live?.ids).toEqual(["NONE|echo", `NONE|${CU}`]);
    expect((live?.body.entries as Record<string, unknown>[]).map((e) => e.resources)).toEqual([
      { "active-mutant.txt": "NONE" },
      { "active-mutant.txt": "NONE" },
    ]);
  });

  test("8: a mutant activated inside the bracket throws", async () => {
    const r = await rig();
    r.b.baselinePhase(true);
    await expect(r.b.activate("M0001")).rejects.toThrow(/baseline/);
  });

  test("14: coverage on, the confirm's null activation reads no coverage (no 'unavailable' throw) and adds no baseline refusal", async () => {
    const r = await rig({
      extra: { coverage: "al-runner" },
      oneShotCoverage: plainCoverage,
      oneShotRows: allPass,
      serve: {
        // Request 0 is the warm-up (= the baseline); the confirm (request 1) refuses B (Commit).
        rows: (m, cu, d, n) =>
          allPass(m, cu, d, n).map((x) =>
            n > 0 && x.method === "B"
              ? { ...x, status: "error" as const, notRun: true, message: COMMIT }
              : x,
          ),
      },
    });
    const base = await baseline(r.b, SUITE1);
    expect(base.map((v) => v.outcome)).toEqual(["pass", "pass"]);
    expect(base[0]?.coverage).toBeDefined();
    await r.b.prefetchMutants(plans([]));
    await r.b.activate(null);
    const a = await r.b.run(ref("A"), OPTS);
    expect(a.outcome).toBe("pass");
    expect(a.coverage).toBeUndefined();
    expect((await r.b.run(ref("B"), OPTS)).runnerRow).toBe("runner-refused");
    expect(r.b.survivorNote(SUITE1)).toBeUndefined();
  });
});

describe("8 (other direction): a refusal inside the bracket IS a baseline refusal", () => {
  test("a test v3 refused at the one-shot baseline gives a survivor its [v3-refused-test-nearby] note", async () => {
    const refusesB: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B" ? { ...x, status: "error" as const, notRun: true, message: COMMIT } : x,
      );
    const r = await rig({ serve: { rows: refusesB } });
    await baseline(r.b, SUITE1);
    expect(r.b.survivorNote([ref("A")])).toContain("[v3-refused-test-nearby]");
  });
});

describe("R590: the daemon's stderr is read after every request", () => {
  const SKIP =
    "dependency skipped: dependency `D` by X (00000000-0000-0000-0000-000000000001) version 1.0.0.0 or higher was not found";

  test("a skipped dependency on a live request stops the session (the one-shot baseline was clean)", async () => {
    let skip = false;
    // The daemon is warm (M0002 prefetched), so M0001's run is a live request, not the warm-up.
    const r = await readyRig({
      serve: { rows: killsM1, stderr: () => (skip ? SKIP : undefined) },
      mutants: ["M0002"],
    });
    skip = true;
    await r.b.activate("M0001");
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3DependencySkippedError);
    expect(r.b.entriesStats().liveRequests).toBe(1);
  });

  test("a skipped dependency on a kill pair stops the session (never the pair-skipped warning)", async () => {
    let skip = false;
    const r = await readyRig({
      serve: { rows: killsM1, stderr: () => (skip ? SKIP : undefined) },
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    skip = true;
    await expect(r.b.sendKillPair("M0001", ref("A"))).rejects.toBeInstanceOf(
      AlRunnerV3DependencySkippedError,
    );
  });

  test("a skipped dependency at the warm-up stops it there", async () => {
    const r = await rig({ serve: { rows: killsM1, stderr: () => SKIP } });
    await baseline(r.b, SUITE1);
    await expect(r.b.prefetchMutants(plans(["M0001"]))).rejects.toBeInstanceOf(
      AlRunnerV3DependencySkippedError,
    );
  });
});

describe("9: a prefetched answer is consumed once", () => {
  test("the first activation uses the prefetched rows; the re-activation (R577) sends one live request", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, mutants: ["M0001"] });
    const n0 = r.serve.requests.length;
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(n0);
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.slice(n0).map((q) => q.ids)).toEqual([
      ["NONE|echo", `NONE|${CU}`],
      ["M0001|echo", `M0001|${CU}`],
    ]);
  });
});

describe("10: R612's keep rule per entry, in entry order", () => {
  const timesOut =
    (who: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === who && x.method === "A"
          ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
          : x,
      );

  test("an unkept entry mid-request: it and the entries before it stand; later groups are re-sent with echoes on a NEW daemon", async () => {
    const r = await readyRig({
      serve: { rows: timesOut("M0002") },
      oneShotRows: allPass,
      mutants: ["M0001", "M0002", "M0003"],
    });
    expect(r.serve.daemons).toHaveLength(2);
    expect(r.serve.firsts().map((q) => q?.ids[0])).toEqual(["NONE|echo", "NONE|echo"]);
    expect(r.serve.requests.filter((q) => q.daemon === 1).map((q) => q.ids)).toEqual([
      ["NONE|echo", `NONE|${CU}`],
      ["M0003|echo", `M0003|${CU}`],
    ]);
    const n0 = r.serve.requests.length;
    await r.b.activate("M0002");
    const v = await r.b.run(ref("A"), OPTS);
    expect([v.outcome, v.reportedStopMs]).toEqual(["timeout", 1000]);
    await r.b.activate("M0003");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(n0);
  });

  test("an unkept ECHO: its whole group is re-sent", async () => {
    const r = await readyRig({
      serve: {
        echo: (m, d, n) =>
          m === "M0002" && d === 0
            ? { method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }
            : goodEcho(m, d, n),
      },
      mutants: ["M0001", "M0002", "M0003"],
    });
    expect(r.serve.requests.filter((q) => q.daemon === 1).map((q) => q.ids)[1]).toEqual([
      "M0002|echo",
      `M0002|${CU}`,
      "M0003|echo",
      `M0003|${CU}`,
    ]);
  });

  test("R645: the daemon starts in the session's scratch dir, never the caller's working directory", async () => {
    const r = await readyRig({ mutants: ["M0001"] });
    expect(r.serve.cwds).toEqual([r.l.scratch]);
    expect(r.serve.cwds[0]).not.toBe(process.cwd());
  });

  test("all entries kept: one daemon", async () => {
    const r = await readyRig({ mutants: ["M0001", "M0002", "M0003"] });
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.b.entriesStats().daemons).toBe(1);
  });

  test("no loop: a group that hits an unkept row again is not re-sent a second time; it runs live", async () => {
    const r = await readyRig({
      serve: {
        echo: (m, d, n) =>
          m === "M0002"
            ? { method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }
            : goodEcho(m, d, n),
      },
      mutants: ["M0001", "M0002"],
    });
    expect(r.serve.daemons).toHaveLength(2);
    expect(r.serve.requests.filter((q) => q.ids[0] === "M0002|echo")).toHaveLength(1);
    expect(r.serve.requests.filter((q) => q.ids.includes("M0002|echo"))).toHaveLength(2);
    await r.b.activate("M0002");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-test-error"]);
    expect(v.failureMessage).toContain(TIMEOUT_1S);
    // R672: a timeout cut names no R672 rule.
    expect(v.failureMessage).not.toContain("R672");
  });
});

/**
 * R654 S1 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md): R612's T2-T6,
 * which ran the v3 serve rule through the .NET backend (`AlRunnerBackend` with
 * `serveDaemonRule: "v3"`), rewritten on purpose against v3's own serve-entries transport. M0001's
 * entry carries the extra row on test A; M0002's is clean. A kept reason leaves ONE daemon, and
 * M0002's verdict comes from it; anything else closes the daemon, so a second one starts.
 */
describe("R654 S1: R612 T2-T6 on v3's serve-entries", () => {
  const HTTP =
    "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)";
  const CASCADE =
    "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HttpGet: did not run (an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a ): it can change session state the analysis does not follow, so the state it would have left is not BC's; this failure is not trusted: after a refusal";
  const ONRUN =
    "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): Arithmetic operation resulted in an overflow.";
  const NO_CALLEE =
    "NotRun: out-of-scope: R612 Broken.DoesNotCompile: call `NoSuchProcedure(1)` has no callee the checker resolved";
  const PANIC_TEST =
    "NotRun: out-of-scope: runtime panic (bug): requested by ALRUNNER_DEBUG_PANIC_IN";
  const PANIC_CASCADE =
    "NotRun: out-of-scope: an earlier test of this codeunit panicked (a runtime bug), so the rest of it was not run";
  const DUP_KEY =
    "NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Data Key Probe is deferred: whether the test runner raises it at the end of the test is not pinned";

  type Extra = { status: string; message?: string; notRun?: boolean };
  const refusal = (message: string): Extra => ({ status: "error", notRun: true, message });
  const onM1A =
    (extra: Extra): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "M0001" && x.method === "A" ? ({ ...x, ...extra } as FakeRow) : x,
      );
  const ready = (serve: ServeScript) =>
    readyRig({ serve, oneShotRows: allPass, mutants: ["M0001", "M0002"] });
  /** M0001's and M0002's verdicts on A, from the prefetched rows. */
  async function verdicts(r: Rig): Promise<[TestVerdict, TestVerdict]> {
    await r.b.activate("M0001");
    const one = await r.b.run(ref("A"), OPTS);
    await r.b.activate("M0002");
    const two = await r.b.run(ref("A"), OPTS);
    return [one, two];
  }

  for (const [entry, m] of [
    ["http", HTTP],
    ["commit", COMMIT],
    ["cascade", CASCADE],
    ["onrun-failed", ONRUN],
  ] as const) {
    test(`T2: a ${entry} refusal keeps the daemon; M0002's verdict is that daemon's, and M0001 is no kill`, async () => {
      const r = await ready({ rows: onM1A(refusal(m)) });
      expect(r.serve.daemons).toHaveLength(1);
      const [one, two] = await verdicts(r);
      expect(one.outcome).toBe("error");
      expect(two.outcome).toBe("pass");
      expect(r.serve.daemons).toHaveLength(1);
    });
  }

  for (const m of ["Test exceeded 3s timeout.", PANIC_TEST, PANIC_CASCADE]) {
    test(`T3: ${m.slice(0, 40)} closes the daemon: a second one starts`, async () => {
      const r = await ready({ rows: onM1A(refusal(m)) });
      expect(r.serve.daemons).toHaveLength(2);
      const [one, two] = await verdicts(r);
      expect(one.outcome).not.toBe("fail");
      expect(two.outcome).toBe("pass");
    });
  }

  for (const extra of [
    refusal(DUP_KEY),
    refusal(`${HTTP} (extra)`),
    refusal(NO_CALLEE),
    { status: "error", message: COMMIT },
    { status: "fail", notRun: true, message: COMMIT },
  ] as Extra[]) {
    test(`T4: an unknown kind closes the daemon ${JSON.stringify(extra).slice(0, 60)}`, async () => {
      const r = await ready({ rows: onM1A(extra) });
      expect(r.serve.daemons).toHaveLength(2);
      const [one] = await verdicts(r);
      expect(one.outcome).not.toBe("fail");
    });
  }

  /**
   * On serve-entries the decoder (`serveRow`, `decodeEntriesAnswer`) refuses these answers before
   * the keep rule reads them: the daemon is closed (an `AlRunnerServerRequestError` "protocol") and
   * nothing of the answer is cached. Daemon 0 gets no request after the bad one, and M0001's
   * verdict never comes from it.
   */
  function closedOnBadAnswer(r: Rig, one: TestVerdict): void {
    const d0 = r.serve.requests.filter((q) => q.daemon === 0);
    expect(d0.at(-1)?.ids).toContain(`M0001|${CU}`);
    expect(r.serve.daemons.length).toBeGreaterThanOrEqual(2);
    expect(one.outcome).not.toBe("fail");
  }

  test("T4 (skipped): an unknown status is refused by the decoder, which closes the daemon", async () => {
    const r = await ready({ rows: onM1A({ status: "skipped" }) });
    const [one] = await verdicts(r);
    closedOnBadAnswer(r, one);
  });

  /** Rewrites M0001's A line in the first daemon's answers. */
  const onM1ALine =
    (
      edit: (line: Record<string, unknown>) => Record<string, unknown>[],
    ): NonNullable<ServeScript["answer"]> =>
    (req, _n, lines) =>
      req.ids.includes(`M0001|${CU}`) && req.daemon === 0
        ? {
            lines: lines.flatMap((l) =>
              l.type === "test" && l.entry === `M0001|${CU}` && l.name === `Codeunit${CU}.A`
                ? edit(l)
                : [l],
            ),
          }
        : undefined;

  test("T5: a non-boolean notRun is refused by the decoder, which closes the daemon; M0001 is no kill", async () => {
    const r = await ready({
      answer: onM1ALine((l) => [{ ...l, status: "error", notRun: null, message: COMMIT }]),
    });
    const [one, two] = await verdicts(r);
    closedOnBadAnswer(r, one);
    expect(two.outcome).toBe("pass");
  });

  test("T6: a test named twice in one entry is refused by the decoder, which closes the daemon; M0001 is no kill", async () => {
    const r = await ready({
      answer: onM1ALine((l) => [l, { ...l, status: "fail", message: "boom" }]),
    });
    const [one, two] = await verdicts(r);
    closedOnBadAnswer(r, one);
    expect(two.outcome).toBe("pass");
  });
});

/**
 * R672 (plan docs/superpowers/plans/2026-10-23-r672-v3-refusal-prefix.md §1c): a refusal written as
 * a plain `fail` (no notRun) says the runtime's state is not trusted, so the daemon that wrote it is
 * closed. The fake daemon is stateful: once it writes M0001's A as such a refusal, every later A on
 * THAT daemon fails ("tainted state"). Without the close, M0002's A would score that taint as a kill.
 */
describe("R672: a refusal written as a plain fail closes the daemon; the tainted next request never scores", () => {
  const PLAIN_REFUSAL = "NotRun: out-of-scope: runtime panic (bug): x";
  const PREFIXED_REFUSAL = `Error: ${PLAIN_REFUSAL}`;
  // R675: the marker after a spaced prefix (`Runtime error: `) closes the daemon too.
  const REFUSALS = [PLAIN_REFUSAL, PREFIXED_REFUSAL, `Runtime error: ${PLAIN_REFUSAL}`];
  const tainting = (refusal: string): RowsFn => {
    const tainted = new Set<number>();
    return (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) => {
        if (x.method !== "A" || d < 0) return x;
        if (m === "M0001") {
          tainted.add(d);
          return { ...x, status: "fail" as const, message: refusal };
        }
        return tainted.has(d) ? { ...x, status: "fail" as const, message: "tainted state" } : x;
      });
  };

  for (const refusal of REFUSALS) {
    test(`entries (prefetch), "${refusal.slice(0, 12)}...": daemon 0 closes right after the refusal; M0002 is re-sent on a fresh daemon and passes`, async () => {
      const r = await readyRig({
        serve: { rows: tainting(refusal) },
        oneShotRows: allPass,
        mutants: ["M0001", "M0002"],
      });
      await r.b.activate("M0001");
      expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "runner-test-error"]);
      await r.b.activate("M0002");
      const two = await r.b.run(ref("A"), OPTS);
      // Never the taint scored as a kill.
      expect([two.outcome, two.failureMessage]).toEqual(["pass", undefined]);
      const i = r.serve.requests.findIndex((q) => q.ids.includes(`M0001|${CU}`));
      expect(r.serve.requests[i]?.daemon).toBe(0);
      expect(r.serve.requests.filter((q) => q.daemon === 0)).toHaveLength(i + 1);
      expect(r.serve.closes).toEqual([{ daemon: 0, afterRequests: i + 1 }]);
      expect(r.serve.daemons).toHaveLength(2);
      expect(r.serve.requests.filter((q) => q.ids.includes(`M0002|${CU}`)).at(-1)?.daemon).toBe(1);
    });

    test(`live requests, "${refusal.slice(0, 12)}...": daemon 0 closes after the refusal; M0002 runs on a fresh daemon and passes`, async () => {
      const r = await rig({ serve: { rows: tainting(refusal) }, oneShotRows: allPass });
      await baseline(r.b, SUITE1);
      await r.b.activate("M0001");
      expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "runner-test-error"]);
      const n0 = r.serve.requests.length;
      await r.b.activate("M0002");
      const two = await r.b.run(ref("A"), OPTS);
      // Never the taint scored as a kill.
      expect([two.outcome, two.failureMessage]).toEqual(["pass", undefined]);
      // Daemon 0 closed right after the refusal's request, before M0002's.
      expect(r.serve.requests.filter((q) => q.daemon === 0)).toHaveLength(n0);
      expect(r.serve.closes).toEqual([{ daemon: 0, afterRequests: n0 }]);
      expect(r.serve.daemons).toHaveLength(2);
      expect(r.serve.requests.at(-1)).toMatchObject({
        daemon: 1,
        ids: ["M0002|echo", `M0002|${CU}`],
      });
    });
  }

  test("a §5 window request (plain) with a refusal written as a plain fail closes the daemon after the window; M0002 runs on a fresh one", async () => {
    // Requests: 0 warm-up, 1 prefetch, 2 echo, 3 the coverage request (A refused as a fail), 4 echo.
    const tainted = new Set<number>();
    const rows: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) => {
        if (x.method !== "A" || d < 0) return x;
        if (n === 3) {
          tainted.add(d);
          return { ...x, status: "fail" as const, message: PREFIXED_REFUSAL };
        }
        return tainted.has(d) ? { ...x, status: "fail" as const, message: "tainted state" } : x;
      });
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      serve: { rows, coverage: sleepCoverage() },
      oneShotRows: allPass,
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).not.toBe("fail");
    await r.b.activate("M0002");
    const two = await r.b.run(ref("A"), OPTS);
    expect([two.outcome, two.failureMessage]).toEqual(["pass", undefined]);
    expect(r.serve.closes[0]).toEqual({ daemon: 0, afterRequests: 5 });
    expect(r.serve.daemons).toHaveLength(2);
    expect(r.serve.requests.find((q) => q.ids.includes(`M0002|${CU}`))?.daemon).toBe(1);
  });

  test("the control: a normal plain fail keeps the daemon (one daemon, no close, M0001 a kill)", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, oneShotRows: allPass });
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.closes).toEqual([]);
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    const live = await rig({ serve: { rows: killsM1 }, oneShotRows: allPass });
    await baseline(live.b, SUITE1);
    await live.b.activate("M0001");
    expect((await live.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    await live.b.activate("M0002");
    expect((await live.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(live.serve.daemons).toHaveLength(1);
    expect(live.serve.closes).toEqual([]);
  });

  test("review nit: a warm-up refusal written as a plain fail is refused naming R672's rule, not R612's", async () => {
    const underNone: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "fail" as const, message: PLAIN_REFUSAL }
          : x,
      );
    const r = await rig({ serve: { rows: underNone } });
    await baseline(r.b, SUITE1);
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
    expect(String(err)).toContain(
      "a plain fail that holds v3's refusal marker (R675), which R672 does not keep",
    );
    expect(String(err)).not.toContain("R612");
  });

  test("review nit: an echo cut by a refusal written as a plain fail names R672's rule in the mutant's error", async () => {
    const r = await rig({
      serve: {
        echo: (m, d, n) =>
          m === "M0002"
            ? { method: "Echo", status: "fail", message: PLAIN_REFUSAL }
            : goodEcho(m, d, n),
      },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    await r.b.activate("M0002");
    const v = await r.b.run(ref("A"), OPTS);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain(
      "a plain fail that holds v3's refusal marker (R675), which R672 does not keep",
    );
  });
});

describe("M1 (build review r1): a warm-up row R612 does not keep refuses by name", () => {
  // B behaves the same under NONE in the one-shot baseline and in the warm-up, so they agree.
  const underNone =
    (message: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message }
          : x,
      );

  test("a dirty warm-up (B times out under NONE) refuses warmup-dirty, naming the test and the reason, before any mutant entry", async () => {
    const r = await rig({ serve: { rows: underNone(TIMEOUT_1S) } });
    await baseline(r.b, SUITE1);
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
    expect(String(err)).toContain(`Codeunit${CU}.B`);
    expect(String(err)).toContain(TIMEOUT_1S);
    // R672: a timeout is still closed by R612's rule, and says so.
    expect(String(err)).toContain("is one R612 does not keep");
    expect(r.serve.requests.map((q) => q.ids[0])).toEqual(["NONE|echo"]);
  });

  test("a clean warm-up whose only notRun rows are kept refusals proceeds on one daemon", async () => {
    const r = await readyRig({ serve: { rows: underNone(COMMIT) }, mutants: ["M0001"] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.requests.map((q) => q.daemon)).toEqual([0, 0, 0]);
  });
});

describe("L2 (build review r1): a lone group never stops the batch", () => {
  test("one group whose echo and entry are notRun with an unlisted reason is that mutant's error, with the reason", async () => {
    const r = await rig({
      serve: {
        rows: (m, cu, d, n) =>
          allPass(m, cu, d, n).map((x) =>
            m === "M0001" ? { ...x, status: "error" as const, notRun: true, message: UNLISTED } : x,
          ),
        echo: (m, d, n) =>
          m === "M0001"
            ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
            : goodEcho(m, d, n),
      },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans([]));
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-test-error"]);
    expect(v.failureMessage).toContain(UNLISTED);
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
  });
});

describe("11, 20: a refusal of the whole request names its reason and re-sends nothing", () => {
  const refuseFrom =
    (from: number): RowsFn =>
    (m, cu, d, n) =>
      n >= from
        ? allPass(m, cu, d, n).map((x) => ({
            ...x,
            status: "error" as const,
            notRun: true,
            message: UNLISTED,
          }))
        : allPass(m, cu, d, n);
  const refusedEcho =
    (from: number): Echo =>
    (m, d, n) =>
      n >= from
        ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
        : goodEcho(m, d, n);

  test("11: every entry notRun with one unlisted reason -> al-runner-v3-entries-batch-refused, one daemon, no re-send", async () => {
    const r = await rig({
      serve: { rows: refuseFrom(1), echo: refusedEcho(1) },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    const err = await r.b.prefetchMutants(plans(["M0001", "M0002"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
    expect(String(err)).toContain(UNLISTED);
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.requests).toHaveLength(2);
  });

  test("20 (N3): the same refusal on the warm-up is batch-refused, not warmup-disagrees", async () => {
    const r = await rig({
      serve: { rows: refuseFrom(0), echo: refusedEcho(0) },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
    expect(String(err)).not.toContain("warmup-disagrees");
  });
});

describe("11: what counts as a refusal of the WHOLE request", () => {
  const row = (message: string, notRun = true) => ({
    codeunit: CU,
    method: "A",
    name: `Codeunit${CU}.A`,
    status: "error" as const,
    message,
    notRun,
  });
  const isSafe = (m: string) => m === COMMIT;
  const isTimeout = (m: string) => m === TIMEOUT_1S;
  const reason = (rows: Record<string, ReturnType<typeof row>[]>) =>
    batchRefusalReason(new Map(Object.entries(rows)), isSafe, isTimeout);
  test("one unlisted reason on every row of every entry is the reason", () => {
    expect(reason({ a: [row(UNLISTED)], b: [row(UNLISTED), row(UNLISTED)] })).toBe(UNLISTED);
  });
  test("a listed (kept) reason, a timeout, two reasons, a row that ran, or an empty entry is not", () => {
    expect(reason({ a: [row(COMMIT)], b: [row(COMMIT)] })).toBeUndefined();
    expect(reason({ a: [row(TIMEOUT_1S)], b: [row(TIMEOUT_1S)] })).toBeUndefined();
    expect(reason({ a: [row(UNLISTED)], b: [row(`${UNLISTED}x`)] })).toBeUndefined();
    expect(reason({ a: [row(UNLISTED)], b: [row(UNLISTED, false)] })).toBeUndefined();
    expect(reason({ a: [row(UNLISTED)], b: [] })).toBeUndefined();
  });
});

describe("12: the stop is the daemon's S", () => {
  test("serve-entries: inRunStopIsBudget false, inRunStopMs = S*1000; the daemon's argv carries S and the pinned flags", async () => {
    const r = await readyRig({ floor: [2500, 1000], mutants: ["M0001"] });
    expect(r.b.inRunStopIsBudget).toBe(false);
    expect(r.b.inRunStopMs).toBe(3000);
    const argv = r.serve.daemons[0] ?? [];
    expect(argv.slice(0, 2)).toEqual([resolve("/fake/al-runner"), "serve"]);
    expect(argv.join(" ")).toContain("--test-timeout 3");
    expect(argv.join(" ")).toContain(`--package-cache ${r.l.deps}`);
    expect(argv.join(" ")).toContain("--bc-version 28.0.46665.47126 --no-download");
  });

  test("a daemon start before useMutantBudgetFloor throws; no daemon is spawned", async () => {
    const r = await rig({ floor: false });
    await baseline(r.b, SUITE1);
    await expect(r.b.prefetchMutants(plans(["M0001"]))).rejects.toBeInstanceOf(
      AlRunnerV3ServeStopUnsetError,
    );
    expect(r.serve.daemons).toHaveLength(0);
  });
});

describe("13: §5, the coverage window for a pass under a mutant when the Sleep index is not empty", () => {
  const windowOf = async (opts: RigOpts = {}) => {
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      mutants: ["M0001"],
      ...opts,
      serve: { coverage: sleepCoverage(), ...opts.serve },
    });
    return { r, n0: r.serve.requests.length };
  };
  const since = (r: Rig, n0: number) => r.serve.requests.slice(n0);
  const onDisk = async (r: Rig) => readFile(resourceFile(join(r.l.scratch, "active")), "utf8");

  test("secondEcho on (default): echo, coverage request, echo, each with the mutant on disk; NONE afterwards; once per (mutant, codeunit)", async () => {
    const { r, n0 } = await windowOf();
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    expect(since(r, n0).map((q) => [q.ids[0], q.onDisk])).toEqual([
      [plainEcho, "M0001"],
      [plainCu, "M0001"],
      [plainEcho, "M0001"],
    ]);
    expect(since(r, n0)[1]?.body).toMatchObject({ coverage: true, perTestCoverage: true });
    expect(await onDisk(r)).toBe("NONE");
  });

  test("secondEcho off: the coverage request, then the echo", async () => {
    const { r, n0 } = await windowOf({ extra: { secondEcho: false } });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(since(r, n0).map((q) => q.ids[0])).toEqual([plainCu, plainEcho]);
  });

  test("the coverage request's rows disagree with the entry's -> error entries-coverage-disagreement", async () => {
    const plainFails: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        n > 1 && m === "M0001" && x.method === "B" ? { ...x, status: "fail" as const } : x,
      );
    const { r } = await windowOf({ serve: { rows: plainFails }, oneShotRows: allPass });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-test-error"]);
    expect(v.failureMessage).toContain("entries-coverage-disagreement");
  });

  const badEchoAt =
    (which: number): Echo =>
    (m, d, n) => {
      if (n <= 1) return goodEcho(m, d, n);
      seen += 1;
      return seen === which
        ? { method: "Echo", status: "fail", message: "LETHAL-ECHO:NONE:true" }
        : goodEcho(m, d, n);
    };
  let seen = 0;
  for (const [name, which] of [
    ["before", 1],
    ["after", 2],
  ] as const) {
    test(`a wrong echo ${name} the coverage request -> error entries-echo-mismatch`, async () => {
      seen = 0;
      const { r } = await windowOf({ serve: { echo: badEchoAt(which) } });
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      expect(outcome(v)).toEqual(["error", "runner-test-error"]);
      expect(v.failureMessage).toContain("entries-echo-mismatch");
      // The second echo (before the coverage request) is counted on its own.
      expect(r.b.entriesStats().secondEchoMismatches).toBe(which === 1 ? 1 : 0);
      expect(r.b.entriesStats().echoMismatches).toBe(1);
    });
  }

  test("a request that fails inside the window still leaves NONE on disk", async () => {
    const { r } = await windowOf({
      serve: {
        answer: (q) => (q.ids[0] === plainCu ? { lines: [{ error: "boom" }] } : undefined),
      },
    });
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(await onDisk(r)).toBe("NONE");
  });

  test("a coverage request that answers a row of another codeunit is a transport failure", async () => {
    const { r } = await windowOf({
      serve: {
        answer: (q, _n, ls) =>
          q.ids[0] === plainCu
            ? {
                lines: ls.map((x) =>
                  x.type === "test" ? { ...x, name: String(x.name).replace(`${CU}`, `${CU2}`) } : x,
                ),
              }
            : undefined,
      },
    });
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
  });

  test("§6 then runs on the window's coverage: a covered Sleep is error [v3-sleep-noop]", async () => {
    const { r } = await windowOf({ serve: { coverage: sleepCoverage(true) } });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-refused"]);
    expect(v.failureMessage).toContain("[v3-sleep-noop] covered Sleep");
  });

  test("R-762 B retired (pinned-gone build): a covered Sleep is a pass; no window, no coverage request, no second echo", async () => {
    const { r, n0 } = await windowOf({ serve: { coverage: sleepCoverage(true) } });
    (r.b as unknown as { sleepRuleRetired: boolean }).sleepRuleRetired = true;
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect([v.outcome, v.failureMessage]).toEqual(["pass", undefined]);
    expect(since(r, n0)).toEqual([]);
    expect(r.b.entriesStats().coverageRequests).toBe(0);
    expect(r.b.entriesStats().echoRequests).toBe(0);
    expect(await onDisk(r)).toBe("NONE");
  });

  test("an empty Sleep index opens no window", async () => {
    const r = await readyRig({ mutants: ["M0001"] });
    const n0 = r.serve.requests.length;
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(n0);
  });
});

describe("17, 18, 21: the warm-up", () => {
  const twoCu = [
    { mutantId: "M0001", refs: [ref("A")] },
    { mutantId: "M0002", refs: [ref("C", CU2)] },
  ];

  test("17: the first request on each daemon selects the union; cached:false is counted once per daemon", async () => {
    const r = await rig({ suite: SUITE2 });
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants(twoCu);
    expect(r.serve.firsts()[0]?.ids).toEqual(["NONE|echo", `NONE|${CU}`, `NONE|${CU2}`]);
    expect(
      (r.serve.firsts()[0]?.body.entries as Record<string, unknown>[]).map((e) => e.resources),
    ).toEqual(Array(3).fill({ "active-mutant.txt": "NONE" }));
    const s = r.b.entriesStats();
    expect([s.daemons, s.cachedFalse]).toEqual([1, 1]);
  });

  test("17: warm-up rows that differ from the one-shot baseline refuse al-runner-v3-entries-warmup-disagrees", async () => {
    const r = await rig({
      suite: SUITE2,
      oneShotRows: allPass,
      serve: {
        rows: (m, cu, d, n) =>
          cu === CU2 ? [{ method: "C", status: "fail" }] : allPass(m, cu, d, n),
      },
    });
    await baseline(r.b, SUITE2);
    const err = await r.b.prefetchMutants(twoCu).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-disagrees");
    expect(r.serve.requests).toHaveLength(1);
  });

  test("17: a warm-up echo that is not LETHAL-ECHO:NONE:true refuses warmup-disagrees", async () => {
    const r = await rig({
      serve: {
        echo: () => ({ method: "Echo", status: "fail", message: "LETHAL-ECHO:NONE:false" }),
      },
    });
    await baseline(r.b, SUITE1);
    expect(String(await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e))).toContain(
      "al-runner-v3-entries-warmup-disagrees",
    );
  });

  test("17: a warm-up echo that is notRun refuses warmup-disagrees, even with the exact text", async () => {
    const r = await rig({
      serve: {
        echo: () => ({
          method: "Echo",
          status: "error",
          notRun: true,
          message: "LETHAL-ECHO:NONE:true",
        }),
      },
    });
    await baseline(r.b, SUITE1);
    expect(String(await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e))).toContain(
      "al-runner-v3-entries-warmup-disagrees",
    );
  });

  test("18 (N1): a baseline that ran over [] (a reused snapshot) refuses no-baseline-rows, and no request is sent", async () => {
    const r = await rig();
    await baseline(r.b, []);
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-no-baseline-rows");
    expect(String(err)).toContain(String(CU));
    expect(r.serve.requests).toHaveLength(0);
    expect(r.serve.daemons).toHaveLength(0);
  });

  test("18 (N1): one of two union codeunits without baseline rows is refused, naming it", async () => {
    const r = await rig({ suite: SUITE2 });
    await baseline(r.b, SUITE1);
    const err = await r.b.prefetchMutants(twoCu).catch((e: unknown) => e);
    expect(String(err)).toContain("al-runner-v3-entries-no-baseline-rows");
    expect(String(err)).toContain(String(CU2));
    expect(r.serve.requests).toHaveLength(0);
  });

  test("21 (N4): cached:false of an answer the decoder rejects is still counted", async () => {
    const r = await rig({
      serve: {
        answer: (q, _n, ls) =>
          q.ids[0] === "M0001|echo"
            ? {
                lines: ls.map((x) =>
                  x.type === "summary" ? { ...x, cached: false, total: Number(x.total) + 9 } : x,
                ),
              }
            : undefined,
      },
    });
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans([]));
    expect(r.b.entriesStats().cachedFalse).toBe(0);
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(r.b.entriesStats().cachedFalse).toBe(2);
  });
});

describe("19 (N2): a restarted daemon whose warm-up disagrees mid-batch stops the session", () => {
  // Daemon 0 agrees with the baseline; any later daemon's NONE rows fail B.
  const laterDisagrees =
    (base: RowsFn): RowsFn =>
    (m, cu, d, n) =>
      d > 0 && m === "NONE"
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "B" ? { ...x, status: "fail" as const } : x,
          )
        : base(m, cu, d, n);

  test("after an R612 close: the causing request is a transportFailure, later runs too, and no third daemon starts", async () => {
    // The confirm on daemon 0 (NONE, after the prefetch) times out: R612 closes the daemon.
    const rows = laterDisagrees((m, cu, d, n) =>
      d === 0 && m === "NONE" && n > 0
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "A"
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
          )
        : killsM1(m, cu, d, n),
    );
    const r = await readyRig({ serve: { rows }, oneShotRows: killsM1, mutants: ["M0001"] });
    await r.b.activate("M0001");
    const kill = await r.b.run(ref("A"), OPTS);
    expect(kill.outcome).toBe("fail");
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("timeout");
    await r.b.activate("M0001");
    const repro = await r.b.run(ref("A"), OPTS);
    expect(outcome(repro)).toEqual(["error", "pre-dispatch-rejected"]);
    expect(repro.failureMessage).toContain("al-runner-v3-entries-warmup-disagrees");
    await r.b.activate(null);
    expect(outcome(await r.b.run(ref("B"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(r.serve.daemons).toHaveLength(2);
    expect(kill.outcome).toBe("fail");
  });

  test("a lazy restart for a live confirm: the confirm is a transportFailure", async () => {
    // The prefetch's LAST entry times out: R612 closes daemon 0 with nothing to re-send.
    const rows = laterDisagrees((m, cu, d, n) =>
      m === "M0001" && d === 0
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "B"
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
          )
        : allPass(m, cu, d, n),
    );
    const r = await readyRig({ serve: { rows }, oneShotRows: allPass, mutants: ["M0001"] });
    expect(r.serve.daemons).toHaveLength(1);
    await r.b.activate("M0001");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("timeout");
    await r.b.activate(null);
    expect(outcome(await r.b.run(ref("B"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(r.serve.daemons).toHaveLength(2);
  });

  test("after the latch, a prefetched pass that needs the §5 window starts no daemon either", async () => {
    // M0002's last entry times out, so daemon 0 closes; the confirm restarts and latches.
    const rows = laterDisagrees((m, cu, d, n) =>
      m === "M0002" && d === 0
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "B"
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
          )
        : allPass(m, cu, d, n),
    );
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      serve: { rows, coverage: sleepCoverage() },
      oneShotRows: allPass,
      mutants: ["M0001", "M0002"],
    });
    await r.b.activate(null);
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(r.serve.daemons).toHaveLength(2);
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    expect(r.serve.daemons).toHaveLength(2);
  });
});

describe("assertBound in serve-entries: the selector and the echo are the emitted bytes", () => {
  for (const [name, file] of [
    ["the selector", "MutationSelector.Codeunit.al"],
    ["the echo", SELECTOR_ECHO_FILENAME],
  ] as const) {
    test(`${name} edited after the proof refuses the run`, async () => {
      const r = await readyRig({ mutants: [] });
      const p = join(r.l.scratch, "active", file);
      await writeFile(p, `${await readFile(p, "utf8")}// edited\n`);
      await r.b.activate(null);
      await expect(r.b.run(ref("A"), OPTS)).rejects.toThrow(/refusing to start v3/);
    });
  }
});

describe("L1 (build review r1): a deadline is deadline-exceeded, never a kill; plain()'s R612 close", () => {
  const withDeadline = async (body: () => Promise<TestVerdict>) => {
    const spy = spyOn(AlRunnerServer.prototype, "runEntries").mockImplementation(async () => {
      throw new AlRunnerServerRequestError("deadline", "no summary line within 1 ms");
    });
    try {
      return await body();
    } finally {
      spy.mockRestore();
    }
  };

  test("a live request whose runEntries passes its deadline", async () => {
    const r = await readyRig({ mutants: ["M0001"] });
    await r.b.activate(null);
    const v = await withDeadline(() => r.b.run(ref("A"), OPTS));
    expect(v.outcome).toBe("deadline-exceeded");
  });

  test("a §5 window request that passes its deadline", async () => {
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      serve: { coverage: sleepCoverage() },
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    const v = await withDeadline(() => r.b.run(ref("A"), OPTS));
    expect(v.outcome).toBe("deadline-exceeded");
  });

  test("a window request with a row R612 does not keep closes the daemon after the window", async () => {
    // Requests: 0 warm-up, 1 prefetch, 2 echo, 3 the coverage request (B times out), 4 echo.
    const rows: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        n === 3 && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
          : x,
      );
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      serve: { rows, coverage: sleepCoverage() },
      oneShotRows: allPass,
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    expect(r.serve.daemons).toHaveLength(1);
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    expect(r.serve.daemons).toHaveLength(2);
  });
});

describe("the CLI threads the option through (wiring)", () => {
  // M9: v3 is refused off Linux, so the Windows CI job asserts that refusal instead.
  const LINUX = process.platform === "linux";
  const build = async (extra: Record<string, unknown>) => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-v3e-cli-"));
    roots.push(dir);
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({ id: TARGET_ID, idRanges: [{ from: 79000, to: 79199 }], runtime: "17.0" }),
    );
    const deps = join(dir, "deps");
    await mkdir(deps);
    await writeFile(
      join(deps, "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="28.0.46665.47126" /></Package>`,
      }),
    );
    return buildBackend(
      {
        mode: "run",
        projectDir: dir,
        testDir: dir,
        backendKind: "al-runner-v3",
        dbPath: "db",
        configPath: "cfg",
        skipKnownSurvivors: false,
        workers: 1,
        keepEnv: false,
        allowExpiringEnv: false,
      } as Parameters<typeof buildBackend>[0],
      {
        alRunnerV3: {
          packagesDir: deps,
          bcVersion: "28.0.46665.47126",
          alcPath: "/fake/alc",
          coverage: "none",
          ...extra,
        },
      },
      dir,
      undefined,
      {},
      { selectorId: SELECTOR_ID, controlId: ECHO, tableId: 79197 },
    );
  };
  test("no transport builds the one-shot backend; transport serve-entries builds serve-entries", async () => {
    if (!LINUX) {
      await expect(build({})).rejects.toThrow(/al-runner-v3-(windows|platform)-unsupported/);
      return;
    }
    expect((await build({})).inRunStopIsBudget).toBe(true);
    expect((await build({ transport: "serve-entries" })).inRunStopIsBudget).toBe(false);
  });
});

describe("timers above 2^31-1 ms (E3a's second daemon, /coord/handoff/R-635/live/run2)", () => {
  const LONG = 2_494_890_000; // v3CallDeadlineMs(180, 1386) before the clamp

  test("v3CallDeadlineMs is clamped to the largest timer setTimeout honours", () => {
    expect(v3CallDeadlineMs(180, 1386)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(v3CallDeadlineMs(1, 3)).toBe(120_000);
  });

  test("runEntries with a 2_494_890_000 ms deadline gets an answer that comes after 50 ms, not `deadline`", async () => {
    const out = new Chan();
    out.push(JSON.stringify({ ready: true }));
    const server = new AlRunnerServer(
      "/fake",
      () => ({
        stdout: out,
        stderr: new Chan(),
        kill: () => out.end(),
        write: (line) => {
          if ((JSON.parse(line) as { command?: string }).command === "shutdown") return out.end();
          setTimeout(() => out.push(JSON.stringify({ type: "summary", total: 0 })), 50);
        },
      }),
      [],
      "serve",
    );
    await server.start(10_000, [], 1);
    const ans = await server.runEntries({ command: "runTests" }, LONG);
    expect(ans.summary.total).toBe(0);
    await server.close();
  });

  test("a capped timer that fires before the real deadline waits again, and keeps the pending read", async () => {
    const ch = new Chan();
    setTimeout(() => ch.push("late line"), 50);
    // Cap 5 ms, deadline 10 s: the cap fires several times before the line arrives.
    expect(await new LineReader(ch).next(10_000, 5)).toEqual({ kind: "line", line: "late line" });
  });

  test("a stream chunk { value: undefined, done: false } is never read as the timer (no hot spin)", async () => {
    const chunks: IteratorResult<Uint8Array>[] = [
      { value: undefined as unknown as Uint8Array, done: false },
      { value: new TextEncoder().encode("after\n"), done: false },
    ];
    let reads = 0;
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          reads += 1;
          return chunks.shift() ?? { value: undefined, done: true };
        },
      }),
    };
    expect(await new LineReader(stream).next(300)).toEqual({ kind: "line", line: "after" });
    expect(reads).toBe(2);
  });

  test("every timer LineReader sets for a 2_494_890_000 ms deadline is at most 2^31-1 ms", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return real(fn, Math.min(ms ?? 0, 2 ** 31 - 1));
    }) as unknown as typeof setTimeout);
    try {
      const ch = new Chan();
      const got = new LineReader(ch).next(LONG);
      real(() => ch.push("line"), 20);
      expect(await got).toEqual({ kind: "line", line: "line" });
    } finally {
      spy.mockRestore();
    }
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every((d) => d <= 2 ** 31 - 1)).toBe(true);
  });

  test("a prefetch request that is dropped warns by name, never silently", async () => {
    const warned: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
    try {
      const r = await rig({
        serve: {
          answer: (q) => (q.ids[0] === "M0001|echo" ? { lines: [{ error: "boom" }] } : undefined),
        },
      });
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]));
      expect(warned.some((w) => w.includes("al-runner-v3-entries-prefetch-dropped"))).toBe(true);
      expect(r.b.entriesStats().prefetchDropped).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the gate's transport flags (itest:alrunner-v3 harness)", () => {
  const base = { alRunnerPath: "/x", coverage: "al-runner" };
  test("unset, or one-shot alone, adds nothing: the gate's config is unchanged", () => {
    expect(v3ItestTransport({})).toEqual({});
    expect({ ...base, ...v3ItestTransport({}) }).toEqual(base);
    expect(v3ItestTransport({ LETHAL_ITEST_V3_TRANSPORT: "one-shot" })).toEqual({});
  });
  test("serve-entries, with secondEcho 0 or 1 when given", () => {
    expect(v3ItestTransport({ LETHAL_ITEST_V3_TRANSPORT: "serve-entries" })).toEqual({
      transport: "serve-entries",
    });
    for (const [v, want] of [
      ["0", false],
      ["1", true],
    ] as const) {
      expect(
        v3ItestTransport({
          LETHAL_ITEST_V3_TRANSPORT: "serve-entries",
          LETHAL_ITEST_V3_SECOND_ECHO: v,
        }),
      ).toEqual({ transport: "serve-entries", secondEcho: want });
    }
  });
  test("an unknown value, or secondEcho without serve-entries, refuses by name", () => {
    expect(() => v3ItestTransport({ LETHAL_ITEST_V3_TRANSPORT: "serve" })).toThrow(
      /al-runner-v3-itest-transport-refused: LETHAL_ITEST_V3_TRANSPORT/,
    );
    expect(() =>
      v3ItestTransport({
        LETHAL_ITEST_V3_TRANSPORT: "serve-entries",
        LETHAL_ITEST_V3_SECOND_ECHO: "on",
      }),
    ).toThrow(/al-runner-v3-itest-transport-refused: LETHAL_ITEST_V3_SECOND_ECHO=/);
    expect(() => v3ItestTransport({ LETHAL_ITEST_V3_SECOND_ECHO: "0" })).toThrow(
      /SECOND_ECHO is set without/,
    );
  });
});

describe("R651: per-phase wall timers, timing only", () => {
  /**
   * A fake clock the fake server moves: each request adds its own amount, so a timer's total
   * names exactly the requests it saw. A daemon's first request (the warm-up) adds 1, a later
   * entries request `tick` (10 while prefetching, 100 for live), a plain echo 1000 and a plain
   * coverage request 10000.
   */
  const clockedRig = async (now?: () => number) => {
    const clock = { t: 0, tick: 0 };
    const warm = new Set<number>();
    const r = await rig({
      targetAl: SLEEPER_AL,
      now: now ?? (() => clock.t),
      serve: {
        rows: killsM1,
        coverage: sleepCoverage(),
        answer: (q) => {
          if (q.ids[0] === plainEcho) clock.t += 1000;
          else if (q.ids[0] === plainCu) clock.t += 10_000;
          else if (!warm.has(q.daemon)) {
            warm.add(q.daemon);
            clock.t += 1;
          } else clock.t += clock.tick;
          return undefined;
        },
      },
    });
    return { r, clock };
  };
  /** Prefetch M0001 and M0002, then a kill, a pass with its §5 window, and a live NONE run. */
  const scenario = async (r: Rig, clock: { tick: number }) => {
    await baseline(r.b, SUITE1);
    clock.tick = 10;
    await r.b.prefetchMutants(plans(["M0001", "M0002"]));
    clock.tick = 100;
    const out: TestVerdict[] = [];
    await r.b.activate("M0001");
    out.push(await r.b.run(ref("A"), OPTS));
    await r.b.activate("M0002");
    out.push(await r.b.run(ref("A"), OPTS), await r.b.run(ref("B"), OPTS));
    await r.b.activate(null);
    out.push(await r.b.run(ref("A"), OPTS));
    return out;
  };

  test("each timer holds only its own phase's requests", async () => {
    const { r, clock } = await clockedRig();
    await scenario(r, clock);
    const s = r.b.entriesStats();
    expect([
      s.warmups,
      s.prefetchRequests,
      s.liveRequests,
      s.coverageRequests,
      s.echoRequests,
    ]).toEqual([1, 1, 1, 1, 2]);
    expect({
      warmupMs: s.warmupMs,
      prefetchMs: s.prefetchMs,
      liveMs: s.liveMs,
      windowMs: s.windowMs,
      coverageMs: s.coverageMs,
      echoMs: s.echoMs,
      boundMs: s.boundMs,
      boundChecks: s.boundChecks,
    }).toEqual({
      warmupMs: 1,
      prefetchMs: 10,
      liveMs: 100,
      windowMs: 12_000,
      coverageMs: 10_000,
      echoMs: 2000,
      // No request runs inside a bound check; the baseline's two runs are not counted.
      boundMs: 0,
      boundChecks: 4,
    });
  });

  test("boundMs counts only the check: under a clock that moves 1 per read, 1 per check", async () => {
    let n = 0;
    const { r, clock } = await clockedRig(() => n++);
    await scenario(r, clock);
    const s = r.b.entriesStats();
    expect([s.boundChecks, s.boundMs]).toEqual([4, 4]);
  });

  test("R652 T8: a check nested inside a phase (the warm-up, a request) is not counted in that phase", async () => {
    const { r, clock } = await clockedRig();
    const b = r.b as unknown as { assertBound: () => Promise<void> };
    const orig = b.assertBound.bind(r.b);
    // Each check takes 7 on the fake clock; the requests' amounts are unchanged.
    spyOn(b, "assertBound").mockImplementation(async () => {
      clock.t += 7;
      await orig();
    });
    await scenario(r, clock);
    const s = r.b.entriesStats();
    expect({
      warmupMs: s.warmupMs,
      prefetchMs: s.prefetchMs,
      liveMs: s.liveMs,
      windowMs: s.windowMs,
      boundMs: s.boundMs,
      boundChecks: s.boundChecks,
    }).toEqual({
      warmupMs: 1,
      prefetchMs: 10,
      liveMs: 100,
      windowMs: 12_000,
      // 4 checks in the loop; the baseline's one-shot check is inside the bracket, not counted.
      boundMs: 28,
      boundChecks: 4,
    });
  });

  test("no verdict reads the timers: the same verdicts under a still clock and a wild one", async () => {
    const still = await clockedRig(() => 0);
    let n = 0;
    const wild = await clockedRig(() => 1e9 * n++);
    const strip = (vs: TestVerdict[]) => vs.map(({ durationMs: _d, ...v }) => v);
    const a = strip(await scenario(still.r, still.clock));
    const b = strip(await scenario(wild.r, wild.clock));
    expect(a.map((v) => v.outcome)).toEqual(["fail", "pass", "pass", "pass"]);
    expect(b).toEqual(a);
    expect(still.r.b.entriesStats().windowMs).toBe(0);
    expect(wild.r.b.entriesStats().coverageMs).toBeGreaterThan(1e8);
  });

  test("the itest's split line prints every phase, and `-` for one that never ran", async () => {
    const stats = {
      ...(await rig()).b.entriesStats(),
      warmupMs: 1,
      prefetchMs: 2,
      liveMs: 3,
      windowMs: 9,
      coverageMs: 4,
      echoMs: 5,
      boundMs: 20,
      boundChecks: 7,
    };
    // other = 100 - (1 + 2 + 3 + 9 + 20); coverage and echo sit inside windows.
    expect(v3SplitLine({ deploy: 7, baseline: 8, mutants: 100 }, stats)).toBe(
      "split ms: deploy 7, baseline 8, mutant loop 100 (warm-up 1, prefetch 2, live 3, windows 9 of which coverage 4 and echo 5, bound 20 over 7 checks, other 65)",
    );
    expect(v3SplitLine({ baseline: 8 }, stats)).toContain("deploy -, baseline 8, mutant loop - (");
    expect(v3SplitLine({ baseline: 8 }, stats)).toContain("other -)");
  });
});

describe("R652: the bound is checked before each SEND, not at each run()", () => {
  const activeOf = (r: Rig) => join(r.l.scratch, "active");
  const tampers: [string, (r: Rig) => Promise<void>][] = [
    ["a target .al byte", (r) => appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ")],
    ["a test .al byte", (r) => appendFile(join(r.l.testDir, `Tests${CU}.Codeunit.al`), " ")],
    ["a file added to <deps>", (r) => writeFile(join(r.l.deps, "Extra.app"), "x")],
  ];
  const identity = (r: Rig) => {
    const s = r.b.entriesStats();
    return [s.boundChecks, s.warmups + s.prefetchRequests + s.liveRequests + s.coverageRequests];
  };

  for (const [name, tamper] of tampers) {
    test(`T1: ${name} changed BETWEEN TWO REQUESTS is refused before the second is sent`, async () => {
      const r = await readyRig({ mutants: [] });
      await r.b.activate(null);
      expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
      const n0 = r.serve.requests.length;
      await tamper(r);
      await r.b.activate(null);
      await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
      expect(r.serve.requests.length).toBe(n0);
    });
  }

  test("T1 (other direction): an untouched tree sends the second request", async () => {
    const r = await readyRig({ mutants: [] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    const n0 = r.serve.requests.length;
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(n0 + 1);
  });

  test("T1 (R577 reproduction): a change after the confirm is refused before the reproduction is sent", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, mutants: ["M0001"] });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    const n0 = r.serve.requests.length;
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await r.b.activate("M0001");
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(r.serve.requests.length).toBe(n0);
  });

  test("T2: a run served from memory does not check (no send, no hash)", async () => {
    const r = await readyRig();
    const c0 = r.b.entriesStats().boundChecks;
    const n0 = r.serve.requests.length;
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    await r.b.run(ref("B"), OPTS);
    expect(r.b.entriesStats().boundChecks).toBe(c0);
    expect(r.serve.requests.length).toBe(n0);
  });

  test("T3a: the PREFETCH request is checked (on a warm daemon)", async () => {
    const r = await readyRig({ mutants: [] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS); // warms the daemon outside the bracket
    const n0 = r.serve.requests.length;
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await expect(r.b.prefetchMutants(plans(["M0001"]))).rejects.toBeInstanceOf(
      AlRunnerV3UnprovenBatchError,
    );
    expect(r.serve.requests.length).toBe(n0);
  });

  test("T3a (other direction): an untouched tree sends the prefetch", async () => {
    const r = await readyRig({ mutants: [] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    const n0 = r.serve.requests.length;
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(r.serve.requests.length).toBe(n0 + 1);
  });

  test("build review L3: a send the check refuses counts no entries; a sent one counts its entries", async () => {
    const r = await readyRig({ mutants: [] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    const e0 = r.b.entriesStats().entriesSent;
    await r.b.prefetchMutants(plans(["M0001"]));
    // One group: its echo entry and one codeunit entry.
    expect(r.b.entriesStats().entriesSent).toBe(e0 + 2);
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await expect(r.b.prefetchMutants(plans(["M0002"]))).rejects.toBeInstanceOf(
      AlRunnerV3UnprovenBatchError,
    );
    expect(r.b.entriesStats().entriesSent).toBe(e0 + 2);
  });

  test("T3b: the WARM-UP is checked: a change after the baseline sends nothing, and the daemon is closed", async () => {
    const r = await rig();
    await baseline(r.b, SUITE1);
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await expect(r.b.prefetchMutants(plans(["M0001"]))).rejects.toBeInstanceOf(
      AlRunnerV3UnprovenBatchError,
    );
    expect(r.serve.requests).toHaveLength(0);
    expect(r.serve.daemons).toHaveLength(1);
  });

  test("T3b (restart): after an R612 cut, the restarted daemon's warm-up is checked", async () => {
    const cutOnFirstLive: RowsFn = (m, cu, d, n) =>
      d === 0 && n === 1
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "A"
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
          )
        : allPass(m, cu, d, n);
    const r = await readyRig({ serve: { rows: cutOnFirstLive }, mutants: [] });
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS); // warm-up (n 0), live (n 1): cut, daemon 0 closed
    expect(r.serve.daemons).toHaveLength(1);
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(r.serve.daemons).toHaveLength(2);
    expect(r.serve.requests.filter((q) => q.daemon === 1)).toHaveLength(0);
  });

  test("T4: a change AFTER the prefetch send and before its rows are served: the rows stand (they came from the checked send); the next send is refused", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, mutants: ["M0001"] });
    const n0 = r.serve.requests.length;
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(r.serve.requests.length).toBe(n0);
  });

  const windowRig = (opts: RigOpts & { mutants?: readonly string[] } = {}) =>
    readyRig({
      targetAl: SLEEPER_AL,
      mutants: ["M0001"],
      ...opts,
      serve: { coverage: sleepCoverage(), ...opts.serve },
    });
  const onDisk = (r: Rig) => readFile(resourceFile(activeOf(r)), "utf8");

  test("R590: a skipped dependency logged on the coverage window's plain request stops the session", async () => {
    const r = await windowRig({
      serve: {
        stderr: (q) =>
          q.ids[0]?.startsWith("plain:") === true
            ? "dependency skipped: dependency `D` by X (00000000-0000-0000-0000-000000000001) was not found"
            : undefined,
      },
    });
    await r.b.activate("M0001");
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3DependencySkippedError);
    expect(r.b.entriesStats().coverageRequests).toBe(1);
  });

  test("T5(a): a change before the window is refused at the window, with zero plain requests", async () => {
    const r = await windowRig();
    const n0 = r.serve.requests.length;
    await appendFile(join(activeOf(r), "Logic.Codeunit.al"), " ");
    await r.b.activate("M0001");
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(r.serve.requests.length).toBe(n0);
    expect(await onDisk(r)).toBe("NONE");
  });

  test("T5(b): a resource file that is not NONE before the window is refused, with zero plain requests", async () => {
    const r = await windowRig();
    const n0 = r.serve.requests.length;
    await writeFile(resourceFile(activeOf(r)), "M0002", "utf8");
    await r.b.activate("M0001");
    await expect(r.b.run(ref("A"), OPTS)).rejects.toThrow(/not NONE, outside the coverage window/);
    expect(r.serve.requests.length).toBe(n0);
  });

  test("T5 (other direction) and T6: an untouched window sends its 3 plain requests under ONE check", async () => {
    const r = await windowRig();
    const n0 = r.serve.requests.length;
    const c0 = r.b.entriesStats().boundChecks;
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(n0 + 3);
    expect(r.b.entriesStats().boundChecks).toBe(c0 + 1);
    expect(await onDisk(r)).toBe("NONE");
  });

  test("T9: the identity boundChecks = warm-ups + prefetch + live + coverage holds when a daemon fails to start", async () => {
    const r = await readyRig({ mutants: [] });
    const spy = spyOn(AlRunnerServer.prototype, "start").mockImplementation(async () => {
      throw new AlRunnerServerRequestError("eof", "the daemon exited before it was ready");
    });
    try {
      await r.b.activate(null);
      expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("error");
    } finally {
      spy.mockRestore();
    }
    const [checks, sum] = identity(r);
    expect(checks).toBe(sum);
    expect(r.b.entriesStats().liveRequests).toBe(0);
  });

  test("T9: the identity holds when the window's first echo fails", async () => {
    const r = await windowRig({
      serve: {
        coverage: sleepCoverage(),
        answer: (q) => (q.ids[0] === plainEcho ? { lines: [{ error: "boom" }] } : undefined),
      },
    });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("error");
    const [checks, sum] = identity(r);
    expect(checks).toBe(sum);
    expect(r.b.entriesStats().coverageRequests).toBe(1);
  });

  test("T9: the identity holds on an ordinary loop (prefetch, memory reads, a window, a live run)", async () => {
    const r = await windowRig({ mutants: ["M0001", "M0002"] });
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    const [checks, sum] = identity(r);
    expect(checks).toBe(sum);
    expect(checks).toBe(4); // warm-up 1, prefetch 1, window 1, live 1
  });

  test("T10: a change inside a window's gap never yields killed: the window's FAIL rows are an error, and the next send is refused", async () => {
    let tampered = false;
    let active = "";
    const plainFails: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        tampered && m === "M0001"
          ? { ...x, status: "fail" as const, message: "killed by the change" }
          : x,
      );
    const r = await windowRig({
      serve: {
        rows: plainFails,
        coverage: sleepCoverage(),
        answer: (q) => {
          // Inside the gap: after the window's check and its first echo, before the coverage request.
          if (q.ids[0] === plainEcho && !tampered) {
            appendFileSync(join(active, "Logic.Codeunit.al"), " ");
            tampered = true;
          }
          return undefined;
        },
      },
      oneShotRows: allPass,
    });
    active = activeOf(r);
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(tampered).toBe(true);
    expect(v.outcome).toBe("error");
    expect(v.outcome).not.toBe("fail");
    expect(v.outcome).not.toBe("timeout");
    expect(v.failureMessage).toContain("entries-coverage-disagreement");
    const n0 = r.serve.requests.length;
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(r.serve.requests.length).toBe(n0);
  });

  describe("T11: every window-derived error names a bound-tree change as a possible cause", () => {
    test("the coverage disagreement", async () => {
      const plainFails: RowsFn = (m, cu, d, n) =>
        allPass(m, cu, d, n).map((x) =>
          n > 1 && m === "M0001" && x.method === "B" ? { ...x, status: "fail" as const } : x,
        );
      const r = await windowRig({ serve: { rows: plainFails }, oneShotRows: allPass });
      await r.b.activate("M0001");
      expect((await r.b.run(ref("A"), OPTS)).failureMessage).toContain(WINDOW_BOUND_CAVEAT);
    });

    test("an echo mismatch inside the window", async () => {
      const echo: Echo = (m, d, n) =>
        n > 1
          ? { method: "Echo", status: "fail", message: "LETHAL-ECHO:NONE:true" }
          : goodEcho(m, d, n);
      const r = await windowRig({ serve: { echo } });
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      expect(v.failureMessage).toContain("entries-echo-mismatch");
      expect(v.failureMessage).toContain(WINDOW_BOUND_CAVEAT);
    });

    test("a covered Sleep note on a windowed call", async () => {
      const r = await windowRig({ serve: { coverage: sleepCoverage(true) } });
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      expect(v.failureMessage).toContain("[v3-sleep-noop] covered Sleep");
      expect(v.failureMessage).toContain(WINDOW_BOUND_CAVEAT);
    });

    test("a batchBlind note latched in a window, and every later pass that carries it", async () => {
      const blind: CoverageFn = (m, cu, a, t) => {
        const doc = sleepCoverage()(m, cu, a, t) as { coverage: { statements: unknown[] }[] };
        // The indexed Sleep line 5 is missing from the target's statements: case 2.
        const target = doc.coverage[1];
        if (target !== undefined) target.statements = [{ line: 6, hits: 0 }];
        return doc;
      };
      const r = await windowRig({ mutants: ["M0001", "M0002"], serve: { coverage: blind } });
      await r.b.activate("M0001");
      const v1 = await r.b.run(ref("A"), OPTS);
      expect(v1.failureMessage).toContain("not in v3's coverage");
      expect(v1.failureMessage).toContain(WINDOW_BOUND_CAVEAT);
      await r.b.activate("M0002");
      const later = (await r.b.run(ref("A"), OPTS)).failureMessage ?? "";
      expect(later).toContain(WINDOW_BOUND_CAVEAT);
      // Build review L2: on a LATER mutant's verdict the note must not claim "this" window.
      expect(later).toContain("a bound-tree change since a window's bound check");
      expect(later).not.toContain("this window's");
    });

    test("a transport failure of the window's request", async () => {
      const r = await windowRig({
        serve: {
          coverage: sleepCoverage(),
          answer: (q) => (q.ids[0] === plainCu ? { lines: [{ error: "boom" }] } : undefined),
        },
      });
      await r.b.activate("M0001");
      expect((await r.b.run(ref("A"), OPTS)).failureMessage).toContain(WINDOW_BOUND_CAVEAT);
    });

    test("a failure BEFORE the window's check (its daemon fails to start) does NOT carry it", async () => {
      // The live entry's B row times out: R612 cuts the daemon, so the window must start one.
      const cutB: RowsFn = (m, cu, d, n) =>
        allPass(m, cu, d, n).map((x) =>
          m === "M0001" && n === 1 && x.method === "B"
            ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
            : x,
        );
      const r = await readyRig({
        targetAl: SLEEPER_AL,
        mutants: [],
        serve: { rows: cutB, coverage: sleepCoverage() },
      });
      const realStart = AlRunnerServer.prototype.start;
      let starts = 0;
      const spy = spyOn(AlRunnerServer.prototype, "start").mockImplementation(function (
        this: AlRunnerServer,
        ...args: Parameters<AlRunnerServer["start"]>
      ) {
        starts += 1;
        if (starts > 1) throw new AlRunnerServerRequestError("eof", "the daemon exited at start");
        return realStart.apply(this, args);
      });
      try {
        await r.b.activate("M0001");
        const v = await r.b.run(ref("A"), OPTS);
        expect(starts).toBe(2);
        expect(v.outcome).toBe("error");
        expect(v.failureMessage).toContain("the daemon exited at start");
        expect(v.failureMessage).not.toContain(WINDOW_BOUND_CAVEAT);
      } finally {
        spy.mockRestore();
      }
    });

    test("a coverage join refusal on a windowed call", async () => {
      const elsewhere: CoverageFn = () => ({
        coverage: [{ file: "/elsewhere/Other.Codeunit.al", statements: [{ line: 1, hits: 1 }] }],
        perTestCoverage: [],
      });
      const r = await windowRig({ serve: { coverage: elsewhere } });
      await r.b.activate("M0001");
      await expect(r.b.run(ref("A"), OPTS)).rejects.toThrow(WINDOW_BOUND_CAVEAT);
    });

    test("an ENTRY's echo mismatch (a checked send, no window) does NOT carry it", async () => {
      const echo: Echo = (m, d, n) =>
        m === "M0001" && n > 0
          ? { method: "Echo", status: "fail", message: "LETHAL-ECHO:NONE:true" }
          : goodEcho(m, d, n);
      const r = await readyRig({ serve: { echo }, mutants: ["M0001"] });
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      expect(v.failureMessage).toContain("entries-echo-mismatch");
      expect(v.failureMessage).not.toContain(WINDOW_BOUND_CAVEAT);
    });
  });
});

/**
 * R654 S2 (`/coord/handoff/R-654/s2-LR1-finding.md`): the one layout-scoped field a missing
 * `resetLayoutState()` would carry into the next batch on one-shot is `batchBlind`. Every other
 * field is rebuilt by `deploy()` or cleared by `activate()`, so no live leg sees the reset go
 * missing (L-R1 and L-R2 stayed green). This test is the guard: a §6 blind note latched in batch 0
 * must not refuse batch 1's covering pass.
 */
describe("R654 S2: a batch's latched blind note does not cross into the next batch (one-shot)", () => {
  test("batch 0 latches the note; after the next deploy, a clean covering pass is a pass", async () => {
    let blindOn = true;
    const coverage: CoverageFn = (m, cu, a, t) => {
      const doc = sleepCoverage()(m, cu, a, t) as { coverage: { statements: unknown[] }[] };
      // The indexed Sleep line 5 missing from the target's statements: §6 case 2, which latches.
      const target = doc.coverage[1];
      if (blindOn && target !== undefined) target.statements = [{ line: 6, hits: 0 }];
      return doc;
    };
    const r = await rig({
      targetAl: SLEEPER_AL,
      oneShotRows: allPass,
      oneShotCoverage: coverage,
      extra: { transport: "one-shot" },
    });
    await baseline(r.b, SUITE1);
    await r.b.activate("M0001");
    const latched = await r.b.run(ref("A"), OPTS);
    expect([latched.outcome, latched.failureMessage ?? ""]).toEqual([
      "error",
      expect.stringContaining("not in v3's coverage"),
    ]);
    // The next batch: a fresh deploy, and v3's coverage is complete again.
    blindOn = false;
    await r.b.deploy(r.l.batch);
    await baseline(r.b, SUITE1);
    await r.b.activate("M0001");
    const next = await r.b.run(ref("A"), OPTS);
    expect([next.outcome, next.failureMessage]).toEqual(["pass", undefined]);
  });
});

// R666: `baselineRows` and `union` are cleared only by `resetLayoutState()` (deploy() rebuilds
// neither), so these are the serve-entries state a missing reset would carry into the next batch.
describe("R666: serve-entries state does not cross a deploy", () => {
  const twoCu = [
    { mutantId: "M0001", refs: [ref("A")] },
    { mutantId: "M0002", refs: [ref("C", CU2)] },
  ];

  test("S1a: batch 0's baseline rows never answer for a batch that ran no baseline (a reused snapshot)", async () => {
    const r = await rig();
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(r.serve.daemons).toHaveLength(1);
    const n0 = r.serve.requests.length;
    await r.b.deploy(r.l.batch);
    await baseline(r.b, []);
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-no-baseline-rows");
    expect(String(err)).toContain(String(CU));
    expect(r.serve.requests).toHaveLength(n0);
    expect(r.serve.daemons).toHaveLength(1);
  });

  test("S1b: batch 1's warm-up is compared with batch 1's own baseline rows", async () => {
    // B fails in batch 1 only, on the one-shot baseline and on the daemon alike.
    let batch = 0;
    const rows: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        batch === 1 && x.method === "B" ? { ...x, status: "fail" as const, message: "b1" } : x,
      );
    const r = await rig({ oneShotRows: rows, serve: { rows } });
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001"]));
    batch = 1;
    await r.b.deploy(r.l.batch);
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(r.serve.daemons).toHaveLength(2);
  });

  test("S2: batch 1's warm-up selects batch 1's codeunits only", async () => {
    const r = await rig({ suite: SUITE2 });
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants(twoCu);
    expect(r.serve.firsts()[0]?.ids).toEqual(["NONE|echo", `NONE|${CU}`, `NONE|${CU2}`]);
    await r.b.deploy(r.l.batch);
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(r.serve.firsts()[1]?.ids).toEqual(["NONE|echo", `NONE|${CU}`]);
  });
});

// R653 (plans 2026-10-22-r653-paired-confirm-r2.md, -r3.md): a cold fail kill's confirm (NONE) and
// its R577 reproduction (M) in ONE entries request, confirm first. Requests on the fake: 0 the
// warm-up, 1 the prefetch, 2 the pair (or today's live confirm), 3 today's live reproduction.
describe("R653 pair", () => {
  const A = ref("A");
  const B = ref("B");
  /** Request 2 on the first daemon: the pair, or today's live confirm (P1 compares the two). */
  const pairReq = (d: number, n: number) => d === 0 && n === 2;
  /** Request `n` is a pair: [echo NONE, NONE's codeunit, echo M0001, M0001's codeunit]. */
  type IsPair = (n: number) => boolean;
  /** killsM1, except that a PAIR request marks every row of A with where it came from. */
  const marked = (isPair: IsPair): ServeScript => ({
    rows: (m, cu, d, n) =>
      isPair(n)
        ? allPass(m, cu, d, n).map((x) =>
            x.method === "A" ? { ...x, status: "fail" as const, message: `from-pair ${m}` } : x,
          )
        : killsM1(m, cu, d, n),
  });
  /** A pair request's echo for `who` is a row R612 does not keep: the request is cut there. */
  const cutEcho =
    (who: string) =>
    (isPair: IsPair): ServeScript => ({
      ...marked(isPair),
      echo: (m, d, n) =>
        m === who && isPair(n)
          ? { method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }
          : goodEcho(m, d, n),
    });
  /** Deployed, baseline, M0001 prefetched, and its kill read (A fails under M0001). */
  const killed = async (
    serve: ServeScript | ((isPair: IsPair, isWarmup: (n: number) => boolean) => ServeScript) = {
      rows: killsM1,
    },
  ) => {
    let reqs: readonly Req[] = [];
    const isPair: IsPair = (n) => {
      const ids = reqs[n]?.ids ?? [];
      return ids.length === 4 && ids[0] === "NONE|echo" && ids[2] === "M0001|echo";
    };
    /** Request `n` is its daemon's first: the warm-up. */
    const isWarmup = (n: number) => reqs.findIndex((q) => q.daemon === reqs[n]?.daemon) === n;
    const script = typeof serve === "function" ? serve(isPair, isWarmup) : serve;
    const r = await readyRig({ serve: script, oneShotRows: allPass, mutants: ["M0001"] });
    reqs = r.serve.requests;
    await r.b.activate("M0001");
    expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
    return r;
  };
  type Settled = Omit<TestVerdict, "durationMs"> | { readonly threw: string };
  const settle = (p: Promise<TestVerdict>): Promise<Settled> =>
    p.then(
      ({ durationMs: _d, ...v }) => v,
      (e: unknown) => ({ threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
    );
  /** The orchestrator's order after a kill: [the pair], activate(null), confirm, activate(M), reproduction. */
  const confirmAndReproduce = async (r: Rig, pair: boolean) => {
    if (pair) await r.b.sendKillPair("M0001", A);
    await r.b.activate(null);
    const confirm = await settle(r.b.run(A, OPTS));
    await r.b.activate("M0001");
    const repro = await settle(r.b.run(A, OPTS));
    return { confirm, repro };
  };
  const withRunEntriesThrowing = async <T>(err: () => Error, body: () => Promise<T>) => {
    const spy = spyOn(AlRunnerServer.prototype, "runEntries").mockImplementation(async () => {
      throw err();
    });
    try {
      return await body();
    } finally {
      spy.mockRestore();
    }
  };
  const msg = (s: Settled) => ("threw" in s ? s.threw : (s.failureMessage ?? ""));

  describe("P1: the pair's verdicts equal today's two live calls (durationMs aside)", () => {
    const noneAtPair =
      (f: (rows: FakeRow[]) => FakeRow[]): RowsFn =>
      (m, cu, d, n) =>
        m === "NONE" && pairReq(d, n) ? f(allPass(m, cu, d, n)) : killsM1(m, cu, d, n);
    const cases: Array<[string, ServeScript, number]> = [
      ["NONE pass, M fail", { rows: killsM1 }, 1],
      [
        "NONE fail, M fail",
        {
          rows: noneAtPair((rs) =>
            rs.map((x) => (x.method === "A" ? { ...x, status: "fail", message: "flaky" } : x)),
          ),
        },
        1,
      ],
      [
        "NONE pass, M pass",
        {
          rows: (m, cu, d, n) =>
            m === "M0001" && n >= 2 ? allPass(m, cu, d, n) : killsM1(m, cu, d, n),
        },
        1,
      ],
      [
        "NONE echo mismatch",
        {
          rows: killsM1,
          echo: (m, d, n) =>
            m === "NONE" && pairReq(d, n)
              ? { method: "Echo", status: "fail", message: "LETHAL-ECHO:M0001:true" }
              : goodEcho(m, d, n),
        },
        1,
      ],
      ["NONE 0 rows", { rows: noneAtPair(() => []) }, 1],
      [
        "2 rows for the method",
        { rows: noneAtPair((rs) => [...rs, { method: "A", status: "pass" }]) },
        0,
      ],
      [
        "only another codeunit's rows",
        {
          rows: killsM1,
          answer: (req, n, lines) =>
            pairReq(req.daemon, n)
              ? {
                  lines: lines.map((x) =>
                    x.type === "test" && x.entry === `NONE|${CU}`
                      ? { ...x, name: String(x.name).replace(`Codeunit${CU}.`, `Codeunit${CU2}.`) }
                      : x,
                  ),
                }
              : undefined,
        },
        0,
      ],
      ["a suite test missing", { rows: noneAtPair((rs) => rs.filter((x) => x.method !== "B")) }, 1],
    ];
    for (const [name, serve, saved] of cases) {
      test(`${name}: equal verdicts, ${saved} request(s) saved`, async () => {
        const today = await killed(serve);
        const t0 = today.serve.requests.length;
        const want = await confirmAndReproduce(today, false);
        const paired = await killed(serve);
        const p0 = paired.serve.requests.length;
        const got = await confirmAndReproduce(paired, true);
        expect(got).toEqual(want);
        expect(today.serve.requests.length - t0 - (paired.serve.requests.length - p0)).toBe(saved);
      });
    }
  });

  test("P2: one send, confirm FIRST (echo NONE, NONE's codeunit, echo M, M's codeunit); nothing else is sent", async () => {
    const r = await killed();
    const s0 = r.b.entriesStats();
    const n0 = r.serve.requests.length;
    await r.b.sendKillPair("M0001", A);
    expect(r.serve.requests.slice(n0).map((q) => q.ids)).toEqual([
      ["NONE|echo", `NONE|${CU}`, "M0001|echo", `M0001|${CU}`],
    ]);
    const s1 = r.b.entriesStats();
    expect([s1.liveRequests - s0.liveRequests, s1.boundChecks - s0.boundChecks]).toEqual([1, 1]);
    await r.b.activate(null);
    expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
    await r.b.activate("M0001");
    expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.length).toBe(n0 + 1);
    const s2 = r.b.entriesStats();
    expect([s2.pairRequests, s2.pairFallbacks1, s2.pairFallbacks2]).toEqual([1, 0, 0]);
    expect([s2.liveRequests - s0.liveRequests, s2.boundChecks - s0.boundChecks]).toEqual([1, 1]);
  });

  test("P3a (G1): one-shot sends no pair; the confirm is spawned as today", async () => {
    const r = await rig({ extra: { transport: "one-shot" } });
    await baseline(r.b, SUITE1);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    const c0 = r.one.calls.length;
    // Not even attempted: in one-shot a daemon start would fail before any spawn, so only the
    // entries request itself shows that G1 let the pair through.
    const request = spyOn(r.b as unknown as { request: () => Promise<unknown> }, "request");
    await r.b.sendKillPair("M0001", A);
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
    await r.b.activate(null);
    expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
    expect(r.one.calls.length).toBe(c0 + 1);
    expect(r.serve.daemons).toHaveLength(0);
  });

  test("P3b (G2, F3): a latched entriesRefused sends no pair; the confirm reads transportFailure, as liveCall gives", async () => {
    const r = await killed();
    (r.b as unknown as { entriesRefused?: string }).entriesRefused = "latched by the test";
    const n0 = r.serve.requests.length;
    await r.b.sendKillPair("M0001", A);
    expect(r.serve.requests.length).toBe(n0);
    await r.b.activate(null);
    const v = await r.b.run(A, OPTS);
    expect(outcome(v)).toEqual(["error", "pre-dispatch-rejected"]);
    expect(v.failureMessage).toContain("latched by the test");
  });

  test("P3c (G3): inside the baseline bracket no pair is sent", async () => {
    const r = await killed();
    const n0 = r.serve.requests.length;
    r.b.baselinePhase(true);
    try {
      await r.b.sendKillPair("M0001", A);
    } finally {
      r.b.baselinePhase(false);
    }
    expect(r.serve.requests.length).toBe(n0);
  });

  test("P3d (G4): a pair for a mutant other than the last activated one is not sent", async () => {
    const r = await killed();
    const n0 = r.serve.requests.length;
    await r.b.sendKillPair("M0002", A);
    expect(r.serve.requests.length).toBe(n0);
  });

  describe("P4: consumed only in order; anything else runs live", () => {
    test("activate(M0002) after the pair: the confirm is live", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      await r.b.activate("M0002");
      await r.b.activate(null);
      const n0 = r.serve.requests.length;
      expect(msg(await settle(r.b.run(A, OPTS)))).not.toContain("from-pair");
      expect(r.serve.requests.length).toBe(n0 + 1);
    });

    test("a second activate(null): the first confirm is served, the second is live, and so is the reproduction", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      const n0 = r.serve.requests.length;
      expect((await r.b.run(A, OPTS)).failureMessage).toBe("from-pair NONE");
      expect(r.serve.requests.length).toBe(n0);
      await r.b.activate(null);
      expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).failureMessage).toBe("boom");
      expect(r.serve.requests.length).toBe(n0 + 2);
    });

    test("activate(M) before activate(null): both runs are live", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      const n0 = r.serve.requests.length;
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).failureMessage).toBe("boom");
      await r.b.activate(null);
      expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
      expect(r.serve.requests.length).toBe(n0 + 2);
    });
  });

  test("P5a: the NONE entry did not stand (its echo cut): pairFallbacks2, confirm and reproduction both live", async () => {
    const r = await killed(cutEcho("NONE"));
    await r.b.sendKillPair("M0001", A);
    const n0 = r.serve.requests.length;
    const { confirm, repro } = await confirmAndReproduce(r, false);
    expect(msg(confirm)).toBe("");
    expect("threw" in confirm ? "threw" : confirm.outcome).toBe("pass");
    expect(msg(repro)).toBe("boom");
    // A new daemon: its warm-up, the live confirm, the live reproduction.
    expect(r.serve.requests.length).toBe(n0 + 3);
    const s = r.b.entriesStats();
    expect([s.pairRequests, s.pairFallbacks1, s.pairFallbacks2]).toEqual([1, 0, 1]);
  });

  test("P5b: the M entry did not stand (its echo cut): pairFallbacks1, the confirm served, the reproduction live; the pair's M rows never scored", async () => {
    const r = await killed(cutEcho("M0001"));
    await r.b.sendKillPair("M0001", A);
    const n0 = r.serve.requests.length;
    await r.b.activate(null);
    expect((await r.b.run(A, OPTS)).failureMessage).toBe("from-pair NONE");
    expect(r.serve.requests.length).toBe(n0);
    await r.b.activate("M0001");
    expect((await r.b.run(A, OPTS)).failureMessage).toBe("boom");
    expect(r.serve.requests.length).toBe(n0 + 2);
    const s = r.b.entriesStats();
    expect([s.pairRequests, s.pairFallbacks1, s.pairFallbacks2]).toEqual([1, 1, 0]);
  });

  describe("P5c, P5d: the pre-committed relation holds for every pair, fallback or not, confirm passed or not", () => {
    /**
     * The orchestrator's flow after a cold fail kill: the pair, activate(null), the confirm, and
     * activate(M) + the reproduction ONLY when the confirm passed (R577). Returns c (1 if it passed)
     * and every counter's change.
     */
    const flow = async (r: Rig) => {
      const s0 = r.b.entriesStats();
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      const c = (await r.b.run(A, OPTS)).outcome === "pass" ? 1 : 0;
      if (c === 1) {
        await r.b.activate("M0001");
        await r.b.run(A, OPTS);
      }
      const s1 = r.b.entriesStats();
      const d = (k: keyof typeof s0) => s1[k] - s0[k];
      const counters = {
        live: d("liveRequests"),
        bound: d("boundChecks"),
        warmups: d("warmups"),
        P: d("pairRequests"),
        F1: d("pairFallbacks1"),
        F1p: d("pairFallbacks1Passed"),
        F2: d("pairFallbacks2"),
        F2p: d("pairFallbacks2Passed"),
      };
      // Today's cost of one fail kill: the confirm, plus the reproduction when the confirm passed.
      const old = 1 + c;
      const want = old - counters.P + counters.F1p + counters.F2 + counters.F2p;
      expect(counters.live).toBe(want);
      // boundChecks = warm-ups + prefetch + live + coverage: a restart's warm-up is its own term.
      expect(counters.bound - counters.warmups).toBe(want);
      return { c, ...counters };
    };
    /** The pair's NONE entry for A: `a`; for B: a timeout R612 does not keep (the cut). */
    const cutAtNoneCodeunit =
      (a: FakeRow["status"]) =>
      (isPair: IsPair): ServeScript => ({
        rows: (m, cu, d, n) =>
          m === "NONE" && isPair(n)
            ? [
                { method: "A", status: a, ...(a === "fail" ? { message: "flaky" } : {}) },
                { method: "B", status: "error", notRun: true, message: TIMEOUT_1S },
              ]
            : killsM1(m, cu, d, n),
      });

    test("P5c: a cut at the NONE CODEUNIT entry (it stands: F1), the confirm fails: one request, nothing else", async () => {
      const r = await killed(cutAtNoneCodeunit("fail"));
      expect(await flow(r)).toEqual({
        c: 0,
        live: 1,
        bound: 1,
        warmups: 0,
        P: 0,
        F1: 1,
        F1p: 0,
        F2: 0,
        F2p: 0,
      });
    });

    test("P5c twin: the same cut, the confirm passes: the reproduction goes live on a new daemon", async () => {
      const r = await killed(cutAtNoneCodeunit("pass"));
      expect(await flow(r)).toEqual({
        c: 1,
        live: 2,
        bound: 3,
        warmups: 1,
        P: 1,
        F1: 1,
        F1p: 1,
        F2: 0,
        F2p: 0,
      });
    });

    test("P5d: the NONE echo cut (F2), the live confirm fails: two requests", async () => {
      const r = await killed((isPair, isWarmup) => ({
        ...cutEcho("NONE")(isPair),
        rows: (m, cu, d, n) =>
          m === "NONE" && n > 2 && !isWarmup(n)
            ? allPass(m, cu, d, n).map((x) =>
                x.method === "A" ? { ...x, status: "fail" as const, message: "flaky" } : x,
              )
            : killsM1(m, cu, d, n),
      }));
      expect(await flow(r)).toEqual({
        c: 0,
        live: 2,
        bound: 3,
        warmups: 1,
        P: 0,
        F1: 0,
        F1p: 0,
        F2: 1,
        F2p: 0,
      });
    });

    const others: Array<[string, Parameters<typeof killed>[0], number]> = [
      ["the pair stands, the confirm passes", { rows: killsM1 }, 1],
      [
        "the pair stands, the confirm fails",
        (isPair) => ({
          rows: (m, cu, d, n) =>
            m === "NONE" && isPair(n)
              ? allPass(m, cu, d, n).map((x) =>
                  x.method === "A" ? { ...x, status: "fail" as const, message: "flaky" } : x,
                )
              : killsM1(m, cu, d, n),
        }),
        0,
      ],
      [
        "the M echo cut (F1), the confirm passes",
        (isPair) => ({ ...cutEcho("M0001")(isPair), rows: killsM1 }),
        1,
      ],
      ["the M echo cut (F1), the confirm fails", cutEcho("M0001"), 0],
      ["the NONE echo cut (F2), the live confirm passes", cutEcho("NONE"), 1],
    ];
    for (const [name, serve, c] of others) {
      test(`the relation: ${name}`, async () => {
        expect((await flow(await killed(serve))).c).toBe(c);
      });
    }
  });

  describe("P6: a server error on the pair is the confirm's verdict, exactly as liveCall maps it", () => {
    const errors: Array<[string, () => Error, string[]]> = [
      [
        "a request error",
        () => new AlRunnerServerRequestError("protocol", "a bad answer"),
        ["error", "pre-dispatch-rejected"],
      ],
      [
        "the deadline",
        () => new AlRunnerServerRequestError("deadline", "no summary line within 1 ms"),
        ["deadline-exceeded", ""],
      ],
      [
        "a refusal (latches)",
        () => new AlRunnerV3EntriesRefusedError("al-runner-v3-test-refused", "refused by the test"),
        ["error", "pre-dispatch-rejected"],
      ],
    ];
    for (const [name, err, want] of errors) {
      test(name, async () => {
        const today = await killed();
        await today.b.activate(null);
        const live = await settle(withRunEntriesThrowing(err, () => today.b.run(A, OPTS)));
        const r = await killed();
        await withRunEntriesThrowing(err, () => r.b.sendKillPair("M0001", A));
        await r.b.activate(null);
        const v = await r.b.run(A, OPTS);
        expect(outcome(v)).toEqual(want);
        const { durationMs: _d, ...rest } = v;
        expect(rest).toEqual(live as typeof rest);
        if (name.includes("latches")) {
          const n0 = r.serve.requests.length;
          await r.b.activate("M0001");
          expect(outcome(await r.b.run(A, OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
          expect(r.serve.requests.length).toBe(n0);
        }
      });
    }
  });

  test("P7: any other throw (a bound change) sends nothing and stores nothing; the confirm's own send throws as today", async () => {
    const r = await killed();
    const n0 = r.serve.requests.length;
    await appendFile(join(r.l.scratch, "active", "Logic.Codeunit.al"), " ");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await r.b.sendKillPair("M0001", A);
      expect(warn.mock.calls.flat().join("\n")).toContain("AlRunnerV3UnprovenBatchError");
    } finally {
      warn.mockRestore();
    }
    expect(r.serve.requests.length).toBe(n0);
    await r.b.activate(null);
    await expect(r.b.run(A, OPTS)).rejects.toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    const s = r.b.entriesStats();
    expect([s.pairRequests, s.pairFallbacks1, s.pairFallbacks2]).toEqual([0, 0, 0]);
  });

  describe("P8: only the warm-up or a PREFETCH of 2+ groups speaks for the batch", () => {
    const refusedAt = (at: (d: number, n: number) => boolean): ServeScript => ({
      rows: (m, cu, d, n) =>
        at(d, n)
          ? allPass(m, cu, d, n).map((x) => ({
              ...x,
              status: "error" as const,
              notRun: true,
              message: UNLISTED,
            }))
          : killsM1(m, cu, d, n),
      echo: (m, d, n) =>
        at(d, n)
          ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
          : goodEcho(m, d, n),
    });

    test("a pair whose every row is refused with one unlisted reason does not latch: the confirm runs live", async () => {
      const r = await killed((isPair) => refusedAt((_d, n) => isPair(n)));
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      const v = await r.b.run(A, OPTS);
      expect(v.failureMessage ?? "").not.toContain("batch-refused");
      expect(v.outcome).toBe("pass");
      expect(r.b.entriesStats().pairFallbacks2).toBe(1);
    });

    test("a 1-group prefetch refused the same way does not latch either", async () => {
      const r = await rig({ serve: refusedAt((d, n) => d === 0 && n === 1), oneShotRows: allPass });
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]));
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).failureMessage ?? "").not.toContain("batch-refused");
    });
    // The other direction (a 2-group prefetch refusal still latches) is test 11 above.
  });

  describe("P9: a stored pair never outlives its kill: every public method that works drops it", () => {
    const drops: Array<[string, (r: Rig) => Promise<unknown> | unknown]> = [
      ["deploy", (r) => r.b.deploy(r.l.batch)],
      ["compileCheck", (r) => r.b.compileCheck(r.l.batch)],
      ["compilePlainCheck", (r) => r.b.compilePlainCheck(join(r.l.scratch, "active"))],
      ["baselinePhase", (r) => r.b.baselinePhase(false)],
      ["prefetchMutants", (r) => r.b.prefetchMutants([])],
      ["useCoveringBudgets", (r) => r.b.useCoveringBudgets("M0002", [])],
      ["useMutantBudgetFloor", (r) => r.b.useMutantBudgetFloor(1000, 1000)],
      ["useBuildSymbols", (r) => r.b.useBuildSymbols([])],
      ["useDiscoveredTests", (r) => r.b.useDiscoveredTests(SUITE1)],
      ["useSessionTests", (r) => r.b.useSessionTests(SUITE1)],
      ["status", (r) => r.b.status()],
      ["close (closeDaemon)", (r) => r.b.close()],
      ["sendKillPair that sends nothing", (r) => r.b.sendKillPair("M0002", A)],
    ];
    test("control: with no call in between, the confirm IS served from the pair", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      expect(msg(await settle(r.b.run(A, OPTS)))).toBe("from-pair NONE");
    });
    for (const [name, call] of drops) {
      test(`${name}, then a Decision 11 style activate(null): nothing is served from the pair`, async () => {
        const r = await killed(marked);
        await r.b.sendKillPair("M0001", A);
        await call(r);
        await r.b.activate(null);
        expect(msg(await settle(r.b.run(A, OPTS)))).not.toContain("from-pair");
      });
    }
  });

  test("P10: a stored confirm verdict is returned by one run only; a second run goes live", async () => {
    const r = await killed();
    await withRunEntriesThrowing(
      () => new AlRunnerServerRequestError("protocol", "a bad answer"),
      () => r.b.sendKillPair("M0001", A),
    );
    await r.b.activate(null);
    expect(outcome(await r.b.run(A, OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
    const n0 = r.serve.requests.length;
    expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBeGreaterThan(n0);
  });

  test("P11: the reproduction is served from the pair, with no extra live send", async () => {
    const r = await killed(marked);
    await r.b.sendKillPair("M0001", A);
    const n0 = r.serve.requests.length;
    await r.b.activate(null);
    expect((await r.b.run(A, OPTS)).failureMessage).toBe("from-pair NONE");
    await r.b.activate("M0001");
    expect((await r.b.run(A, OPTS)).failureMessage).toBe("from-pair M0001");
    expect(r.serve.requests.length).toBe(n0);
  });

  describe("P12: a run that is not the pair's own confirm drops the pair", () => {
    test("a run of a different ref after the confirm: the reproduction is live", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      expect((await r.b.run(A, OPTS)).failureMessage).toBe("from-pair NONE");
      await r.b.run(B, OPTS);
      const n0 = r.serve.requests.length;
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).failureMessage).toBe("boom");
      expect(r.serve.requests.length).toBe(n0 + 1);
    });

    test("a run of the pair's own ref BEFORE the consuming activate(null): the confirm is live", async () => {
      const r = await killed(marked);
      await r.b.sendKillPair("M0001", A);
      await r.b.run(A, OPTS);
      await r.b.activate(null);
      expect(msg(await settle(r.b.run(A, OPTS)))).not.toContain("from-pair");
    });
  });
});

// R739: the backend's notices go to the session's notifier, not to the console, once `setNotify`
// installed one. Each test goes red if its site reverts to `console.warn`.
describe("R739: v3 notices reach setNotify, never the console", () => {
  test("a dropped prefetch request is an al-runner-v3-entries-prefetch-dropped notice", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await rig({
        serve: {
          answer: (q) => (q.ids[0] === "M0001|echo" ? { lines: [{ error: "boom" }] } : undefined),
        },
      });
      const seen: Array<[string, string]> = [];
      r.b.setNotify((c, m) => seen.push([c, m]));
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]));
      expect(seen.map(([c]) => c)).toEqual(["al-runner-v3-entries-prefetch-dropped"]);
      expect(seen[0]?.[1]).toContain("al-runner-v3-entries-prefetch-dropped");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("an unexpected failure of the kill pair is an al-runner-v3-pair-skipped notice", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await readyRig({ serve: { rows: killsM1 }, mutants: ["M0001"] });
      const seen: Array<[string, string]> = [];
      r.b.setNotify((c, m) => seen.push([c, m]));
      await r.b.activate("M0001");
      expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
      (r.b as unknown as { request: () => Promise<never> }).request = async () => {
        throw new Error("pair boom");
      };
      await r.b.sendKillPair("M0001", ref("A"));
      expect(seen.map(([c]) => c)).toEqual(["al-runner-v3-pair-skipped"]);
      expect(seen[0]?.[1]).toContain("pair boom");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
