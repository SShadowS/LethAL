// R635: the serve + entries transport of the al-runner v3 backend, against a scripted fake
// `serve` daemon and a fake one-shot v3. Plan
// docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md (r3) §9, tests 1-13 and 16-21; the
// orchestrator's seams (tests 14, 15) are in orchestrator.test.ts. Call counters, no wall clock.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { emitResourceSelector, emitStaticSelector } from "@lethal/schemata";
import {
  V3_GATE_SERVE_LEGS,
  v3ItestLegTransport,
  v3ItestTransport,
  v3SplitLine,
} from "../itest/al-runner-v3-gate";
import { judgeDaemonBaseline } from "../itest/alrunner-v3-legs";
import {
  AlRunnerServer,
  AlRunnerServerRequestError,
  LineReader,
  type ServerProcessHandle,
  type ServerSpawnFn,
} from "../src/al-runner-server";
import {
  AL_RUNNER_V3_VERSION,
  AlRunnerV3AutoMethodOneShotRefusedError,
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3DependencyMissingError,
  AlRunnerV3DependencySkippedError,
  AlRunnerV3IsolateTestsWithAutoRefusedError,
  AlRunnerV3NoTestRanError,
  AlRunnerV3RowMissingError,
  AlRunnerV3ServeFallbackWarmupError,
  AlRunnerV3ServeStopUnsetError,
  AlRunnerV3TransportFrozenError,
  AlRunnerV3UnprovenBatchError,
  ISOLATED_BASELINE_PROCESSES,
  SPECULATE_BASELINE_ENV,
  V3_AUTO_METHOD_ONE_SHOT,
  V3_ROUTINE_CLOSES,
  WINDOW_BOUND_CAVEAT,
  unkeptRowReason,
  v3CallDeadlineMs,
  v3DaemonClosesText,
} from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import {
  AlRunnerV3EntriesEncodeError,
  AlRunnerV3EntriesRefusedError,
  SELECTOR_ECHO_FILENAME,
  batchRefusalReason,
  chunkGroups,
  decodeEntriesAnswer,
  emitSelectorEcho,
  encodeGroups,
  assertEntriesWellFormed as wellFormed,
} from "../src/al-runner-v3-entries";
import { AlRunnerV3SeedError } from "../src/al-runner-v3-seed";
import { AlcCompileError, type ArtifactIo, ArtifactPrepareError } from "../src/artifact";
import type { RunOpts, TestMethodRef, TestVerdict } from "../src/backend";
import { buildBackend } from "../src/cli";
import { baselineSourceTag } from "../src/orchestrator";
import type { SpawnFn } from "../src/publisher";
import { installResourceSelector } from "../src/resource-selector";
import { backendBuildRefusal } from "../src/store";
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
  /** R907: al-runner's `flagged` (a pass resting on an unprobed assumption). */
  flagged?: boolean;
  /** R963: the row has NO `durationMs` of its own (al-runner may omit it). */
  noDuration?: boolean;
}
/** R586c (B2): a real CPU stop takes at least its stop; the fake's stop rows say so. */
const stopMsOf = (message: string | undefined): number => {
  const m = /^Test exceeded (\d+)s timeout\./.exec(message ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
};
/** `n` is the request's index over the whole fake (every daemon); -1 for a one-shot call. */
type RowsFn = (
  mutant: string,
  cu: number,
  daemon: number,
  n: number,
  /** R778: how many codeunit entries (not echoes) of this override the request had before this one. */
  seen?: number,
) => FakeRow[];
type CoverageFn = (
  mutant: string,
  cu: number,
  active: string,
  testDir: string,
  /** R857: the one test of a `--test-exact` process. */
  method?: string,
) => unknown;

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
function fakeOneShot(
  rows: RowsFn,
  coverage?: CoverageFn,
  answer?: { readonly exitCode: number; readonly stderr: string },
) {
  const calls: string[][] = [];
  // R866: how many processes ran at one time, by call counters, never by the clock.
  let running = 0;
  let peak = 0;
  let joined = 0;
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    running += 1;
    joined += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((r) => setImmediate(r));
    // R866: a one-test process stays until no neighbour has joined for 5 ms (at most 100 ms), so the
    // peak is how many the backend lets run, whatever that number, and not a matter of luck.
    for (let i = 0, quiet = 0; argv.includes("--test-exact") && quiet < 5 && i < 100; i += 1) {
      const before = joined;
      await new Promise<void>((r) => setTimeout(r, 1));
      quiet = joined === before ? quiet + 1 : 0;
    }
    running -= 1;
    const active = argv.at(-2) ?? "";
    const testDir = argv.at(-1) ?? "";
    // R857: `--test-exact Codeunit<id>.<method>` runs that one test.
    const exact = argv.indexOf("--test-exact");
    const only = exact < 0 ? null : /^Codeunit(\d+)\.(.+)$/.exec(argv[exact + 1] ?? "");
    const cu = Number(only?.[1] ?? argv[argv.indexOf("--codeunit") + 1]);
    const m = await readFile(resourceFile(active), "utf8").catch(() => "STATIC");
    const cov = coverage?.(m, cu, active, testDir, only?.[2]);
    if (cov !== undefined) {
      await writeFile(argv[argv.indexOf("--coverage-json") + 1] ?? "", JSON.stringify(cov));
    }
    const asked = rows(m, cu, -1, -1).filter((r) => only === null || r.method === only[2]);
    const tests = asked.map((r) => ({
      codeunit: cu,
      method: r.method,
      name: `Codeunit${cu}.${r.method}`,
      status: r.status,
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.notRun === true ? { notRun: true } : {}),
    }));
    return { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "", ...answer };
  };
  const clearPeak = () => {
    peak = 0;
  };
  return { spawn, calls, peak: () => peak, running: () => running, clearPeak };
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
  /** R895: the daemon number of every `kill()` (a close's fallback kill too). */
  const kills: number[] = [];
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
      pid: 90_000 + daemon, // R952: what the recycle bound's RSS seam is asked about (never a real /proc read)
      kill: () => {
        kills.push(daemon);
        out.end();
      },
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
          const cuOf = (t: unknown) => Number(/^Codeunit(\d+)\./.exec(String(t))?.[1]);
          // R857: as measured on edge 6bb821b98: `test` selects by text, so `Codeunit1.Alpha` also
          // picks `AlphaTwo`; `excludeTests` takes names out. `Codeunit1.` picks every test.
          const picked = (cu: number, test: unknown, ex: unknown, rs: FakeRow[]) =>
            rs.filter((r) => {
              const name = `Codeunit${cu}.${r.method}`.toLowerCase();
              const out = ((ex as string[] | undefined) ?? []).map((x) => x.toLowerCase());
              return (
                cu === ECHO ||
                (name.startsWith(String(test).toLowerCase()) && !out.some((x) => name.includes(x)))
              );
            });
          const seenBy = new Map<string, number>();
          const rowsOf = (m: string, cu: number): FakeRow[] => {
            if (cu !== ECHO) {
              const seen = seenBy.get(m) ?? 0;
              seenBy.set(m, seen + 1);
              return rows(m, cu, daemon, n, seen);
            }
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
            ...(r.noDuration === true ? {} : { durationMs: stopMsOf(r.message) }),
            ...(r.message !== undefined ? { message: r.message } : {}),
            ...(r.notRun === true ? { notRun: true } : {}),
            ...(r.flagged !== undefined ? { flagged: r.flagged } : {}),
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
              const rs = picked(cu, e.test, e.excludeTests, rowsOf(m, cu));
              for (const r of rs) lines.push(testLine(cu, r, String(e.id)));
              per.push({ type: "entrySummary", entry: e.id, ...count(rs) });
            }
            lines.push(...per);
          } else {
            const cu = cuOf(body.test);
            selected = new Set([cu]);
            const rs = picked(cu, body.test, body.excludeTests, rowsOf(onDisk, cu));
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
  return { spawn, daemons, requests, firsts, closes, cwds, kills };
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
  oneShotAnswer?: { readonly exitCode: number; readonly stderr: string };
  extra?: Partial<AlRunnerV3Config>;
  targetAl?: string;
  suite?: readonly TestMethodRef[];
  floor?: readonly [number, number] | false;
  /** R651: the phase timers' clock. */
  now?: () => number;
  /** R778: the kill-pair batch after the prefetch; off unless a test asks, so R653's tests see today's pair. */
  pairBatch?: boolean;
  /** R790: backend test seams, set before the deploy. */
  seams?: AlRunnerV3Backend["seams"];
  /** R948: the backend's notices, collected before the deploy. */
  notify?: (code: string, message: string) => void;
  /** R948: the session's stop state, given before the deploy. */
  stopHandle?: Parameters<AlRunnerV3Backend["useStopHandle"]>[0];
}

async function rig(opts: RigOpts = {}): Promise<Rig> {
  const suite = opts.suite ?? SUITE1;
  const l = await layout(opts.targetAl ?? TARGET_AL, suite);
  const serve = fakeServe(opts.serve);
  const one = fakeOneShot(
    opts.oneShotRows ?? opts.serve?.rows ?? allPass,
    opts.oneShotCoverage,
    opts.oneShotAnswer,
  );
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: "/fake/al-runner",
      environmentChoice: { value: "saas", source: "config" },
      instrumentedDir: l.scratch,
      testDir: l.testDir,
      packagesDir: l.deps,
      bcVersion: "28.0.46665.47126",
      selectorObjectId: SELECTOR_ID,
      alcPath: "/fake/alc",
      coverage: "none",
      transport: "serve-entries",
      downloadDemoData: false, // R885: the argv pins below are the offline path; tests override via extra
      ...opts.extra,
    },
    one.spawn,
    fakeAlc(),
    serve.spawn,
    opts.now,
  );
  (b as unknown as { pairBatch: boolean }).pairBatch = opts.pairBatch === true;
  b.useBuildSymbols([]);
  b.useDiscoveredTests(suite);
  b.useSessionTests(suite);
  if (opts.floor !== false) b.useMutantBudgetFloor(...(opts.floor ?? [1000, 1000]));
  // R952: the recycle bound's RSS read is unreadable unless a test says otherwise (tests never read /proc).
  Object.assign(b.seams, { rssReader: () => undefined }, opts.seams ?? {});
  if (opts.notify !== undefined) b.setNotify(opts.notify);
  if (opts.stopHandle !== undefined) b.useStopHandle(opts.stopHandle);
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
        environmentChoice: { value: "saas", source: "config" },
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

  test("1: the config's default transport is serve-entries (R761, source default) and secondEcho defaults on", () => {
    const c = validateAlRunnerV3Config({ packagesDir: "/p", bcVersion: "28.0.1.2" });
    expect(c.transport).toBe("serve-entries");
    expect(c.transportSource).toBe("default");
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

  test("R808 (g): a NONE live call after the prefetch that returns no row at all (an OnRun that raised, #5859) stops the session", async () => {
    const r = await rig({
      serve: { rows: (m, cu, d, n) => (n === 0 ? allPass(m, cu, d, n) : []) },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans([]));
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toBeInstanceOf(AlRunnerV3RowMissingError);
  });

  test("R815: a serve session's baseline call is one-shot, so a failing OnRun stops by the same name", async () => {
    const r = await rig({
      oneShotAnswer: { exitCode: 6, stderr: "Result: NOTHING SELECTED (exit 6)\n" },
    });
    await expect(baseline(r.b, SUITE1)).rejects.toBeInstanceOf(AlRunnerV3NoTestRanError);
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
    InherentPermissions = X;

    var
        Loaded: Boolean;
        ActiveId: Text;

    procedure Active(MutantId: Text): Boolean
    begin
        if GetExecutionContext() <> ExecutionContext::Normal then
            exit(false);
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

describe("R885: demo data, on the serve path", () => {
  const OFF =
    "note: test data is off: the demo data of build 28.4.1.2 is not cached and --no-download is set. Microsoft's tests expect a CRONUS company.";
  const DOWNLOAD =
    "test data: downloading the w1 demo data of build 28.4.1.2 (about 0.5 GB, once) ...";
  const run = async (extra: Partial<AlRunnerV3Config>, line: string | undefined, runs = 2) => {
    const seen: Array<[string, string]> = [];
    let armed = false;
    const r = await readyRig({
      serve: { rows: killsM1, stderr: () => (armed ? line : undefined) },
      mutants: ["M0001", "M0002"],
      extra,
    });
    r.b.setNotify((c, m) => seen.push([c, m]));
    armed = true;
    for (let i = 0; i < runs; i++) {
      await r.b.activate("M0001");
      await r.b.run(ref("A"), OPTS);
    }
    return { seen, r };
  };

  test("the daemon argv has --no-download only when downloadDemoData is false", async () => {
    const off = await readyRig({ mutants: ["M0001"], extra: { downloadDemoData: false } });
    expect(off.serve.daemons[0] ?? []).toContain("--no-download");
    const on = await readyRig({ mutants: ["M0001"], extra: { downloadDemoData: true } });
    expect(on.serve.daemons[0] ?? []).not.toContain("--no-download");
  });

  test("R956: the daemon argv carries --license <path> only when the license is set", async () => {
    const on = (
      await readyRig({
        mutants: ["M0001"],
        extra: { license: { path: "/l/x.bclicense", sha256: "a".repeat(64) } },
      })
    ).serve.daemons[0];
    expect(on?.[(on?.indexOf("--license") ?? -2) + 1]).toBe("/l/x.bclicense");
    expect((await readyRig({ mutants: ["M0001"] })).serve.daemons[0] ?? []).not.toContain(
      "--license",
    );
  });

  test("R938: the daemon argv carries --environment <value> (the stated one)", async () => {
    const on = (
      await readyRig({
        mutants: ["M0001"],
        extra: { environmentChoice: { value: "onprem", source: "launch.json" } },
      })
    ).serve.daemons[0];
    expect(on?.[(on?.indexOf("--environment") ?? -2) + 1]).toBe("onprem");
    const dflt = (await readyRig({ mutants: ["M0001"] })).serve.daemons[0];
    expect(dflt?.[(dflt?.indexOf("--environment") ?? -2) + 1]).toBe("saas");
  });

  test("R886: the daemon argv carries --dotnet-sidecar <dll> only when dotnetSidecar names a file", async () => {
    const dll = join(await mkdtemp(join(tmpdir(), "r886-")), "AlDotNetSidecar.dll");
    await writeFile(dll, "x");
    const on = (await readyRig({ mutants: ["M0001"], extra: { dotnetSidecar: dll } })).serve
      .daemons[0];
    expect(on?.[(on?.indexOf("--dotnet-sidecar") ?? -2) + 1]).toBe(dll);
    for (const extra of [{}, { dotnetSidecar: false as const }]) {
      const off = await readyRig({ mutants: ["M0001"], extra });
      expect(off.serve.daemons[0] ?? []).not.toContain("--dotnet-sidecar");
    }
  });

  test("R941/R943: the daemon argv carries each probing path as a --dotnet-assembly-dir, only with a sidecar", async () => {
    const dll = join(await mkdtemp(join(tmpdir(), "r943-")), "AlDotNetSidecar.dll");
    await writeFile(dll, "x");
    const dirs = (argv: readonly string[]) =>
      argv.flatMap((a, i) => (a === "--dotnet-assembly-dir" ? [argv[i + 1]] : []));
    const paths = { assemblyProbingPaths: ["/abs/one", "rel/two"] };
    const on = (await readyRig({ mutants: ["M0001"], extra: { dotnetSidecar: dll, ...paths } }))
      .serve.daemons[0];
    // resolve() on both: on Windows an absolute "/abs/one" gains the drive letter.
    expect(dirs(on ?? [])).toEqual([resolve("/abs/one"), resolve("rel/two")]);
    const offRig = await readyRig({
      mutants: ["M0001"],
      extra: { dotnetSidecar: false as const, ...paths },
    });
    // Review: a daemon must have started, or an empty argv would pass this for the wrong reason.
    expect(offRig.serve.daemons.length).toBeGreaterThanOrEqual(1);
    expect(dirs(offRig.serve.daemons[0] ?? [])).toEqual([]);
  });

  test("the test-data-off note on the daemon's stderr warns once, naming the cacheDir key", async () => {
    const { seen, r } = await run({ cacheDir: "/c" }, `${OFF}\n${OFF}`);
    const codes = seen.map(([c]) => c);
    expect(codes.filter((c) => c === "al-runner-v3-test-data-off")).toHaveLength(1);
    expect(seen.find(([c]) => c === "al-runner-v3-test-data-off")?.[1]).toContain(
      "alRunnerV3.cacheDir",
    );
    expect(r.b.baselineNote?.()).toContain("28.4.1.2");
  });

  test("no note, no warning, no baseline line", async () => {
    const { seen, r } = await run({}, undefined);
    expect(seen.filter(([c]) => c.startsWith("al-runner-v3-test-data"))).toEqual([]);
    expect(r.b.baselineNote?.()).toBeUndefined();
  });

  test("a download in progress is announced once, with the opt-out key", async () => {
    const { seen } = await run({ cacheDir: "/c", downloadDemoData: true }, DOWNLOAD);
    const d = seen.filter(([c]) => c === "al-runner-v3-demo-data-download");
    expect(d).toHaveLength(1);
    expect(d[0]?.[1]).toContain("downloading BC 28.4.1.2 demo data (~549 MB, once) into /c");
    expect(d[0]?.[1]).toContain("alRunnerV3.downloadDemoData=false");
  });

  test("no download line, no download notice", async () => {
    const { seen } = await run({ downloadDemoData: true }, undefined);
    expect(seen.filter(([c]) => c === "al-runner-v3-demo-data-download")).toEqual([]);
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

  // R860 (upstream #7139): the refusal line serve wrote for a build that stops on a missing app.
  // Two apps, each line over 300 characters like the real ones (a long `searched:` list), so the
  // second sits past the 400th character that `runEntries` used to cut at.
  const SEARCHED = `; searched: ${"/long/package/folder/".repeat(10)}, proj/app/.alpackages; put its .app with AL source (or its source archive) in the project's .alpackages or pass --dep DIR`;
  const STOP = `2 dependency app(s) were not found and --no-download is set, so the run would use a different install than a run with the apps:\n  dependency \`D\` by X (00000000-0000-0000-0000-000000000001) version 1.0.0.0 or higher was not found${SEARCHED}\n  dependency \`Second\` by Y (00000000-0000-0000-0000-000000000002) version 2.0.0.0 or higher was not found${SEARCHED}`;

  test("R860: serve's error line for a missing dependency stops the session by name, on a live request and at the warm-up", async () => {
    let stop = false;
    const r = await readyRig({
      serve: {
        rows: killsM1,
        answer: () => (stop ? { lines: [{ error: STOP }] } : undefined),
      },
      mutants: ["M0002"],
    });
    stop = true;
    await r.b.activate("M0001");
    const err = await r.b.run(ref("A"), OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3DependencyMissingError);
    expect(String(err)).toContain('"D" by X');
    expect(String(err)).toContain('"Second" by Y');
    expect(String(err)).toContain("packagesDir");
    // The daemon was started without the allow flag.
    expect(r.serve.daemons.flat().some((a) => a.includes("allow-missing-dependencies"))).toBe(
      false,
    );
    expect(r.serve.daemons.length).toBeGreaterThan(0);
    const w = await rig({ serve: { rows: killsM1, answer: () => ({ lines: [{ error: STOP }] }) } });
    await baseline(w.b, SUITE1);
    await expect(w.b.prefetchMutants(plans(["M0001"]))).rejects.toBeInstanceOf(
      AlRunnerV3DependencyMissingError,
    );
    // Any other error line keeps its old handling.
    const o = await rig({
      serve: { rows: killsM1, answer: () => ({ lines: [{ error: "boom" }] }) },
    });
    await baseline(o.b, SUITE1);
    await o.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => {
      expect(e).not.toBeInstanceOf(AlRunnerV3DependencyMissingError);
    });
  });

  test("R860: serve's missing-dependency line on a kill pair stops the session (never the pair-skipped warning)", async () => {
    let stop = false;
    const r = await readyRig({
      serve: {
        rows: killsM1,
        answer: () => (stop ? { lines: [{ error: STOP }] } : undefined),
      },
      mutants: ["M0001"],
    });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    stop = true;
    await expect(r.b.sendKillPair("M0001", ref("A"))).rejects.toBeInstanceOf(
      AlRunnerV3DependencyMissingError,
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

describe("R963: a serve-entries request is one call: its rows with no own time share one callId", () => {
  const noOwn: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((r) => ({ ...r, noDuration: true }));
  test("every verdict of one request (two mutants, two tests each) carries the SAME callId; another request gets a different one", async () => {
    const r = await rig({ serve: { rows: noOwn } });
    const base = await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001", "M0002"], SUITE1));
    const n0 = r.serve.requests.length;
    const got: TestVerdict[] = [];
    for (const m of ["M0001", "M0002"]) {
      await r.b.activate(m);
      for (const t of SUITE1) got.push(await r.b.run(t, OPTS));
    }
    expect(r.serve.requests.length).toBe(n0); // all four came from the one prefetch request
    expect(got.map((v) => v.measuredDurationMs)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const ids = new Set(got.map((v) => v.callId));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(typeof id).toBe("string");
    const baseIds = new Set(base.map((v) => v.callId));
    expect(baseIds.size).toBe(1);
    expect(baseIds.has(id)).toBe(false);
  });
});

// R939: every daemon close is counted by its reason; the unexpected ones warn, naming a refusal's family.
describe("R939: why each serve daemon closed", () => {
  const WITH_EVENTS = "NotRun: out-of-scope: WithEvents subscriber 'Probe Sub' (not pinned)";
  const refusedFor =
    (who: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === who && x.method === "A"
          ? { ...x, status: "error" as const, notRun: true, message: WITH_EVENTS }
          : x,
      );
  const timedOutFor =
    (who: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === who && x.method === "A"
          ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
          : x,
      );
  const watched = async (rows: RowsFn) => {
    const r = await rig({ serve: { rows }, oneShotRows: allPass });
    const seen: [string, string][] = [];
    const sunk: { reason: string; family?: string }[] = [];
    r.b.setNotify((c, m) => seen.push([c, m]));
    r.b.setDaemonCloseSink((c) => sunk.push({ ...c }));
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001", "M0002", "M0003"], SUITE1));
    return { r, seen, sunk };
  };

  test("a refusal outside the keep list: one close, reason refusal, its family in the count and the sink, no notice", async () => {
    const { r, seen, sunk } = await watched(refusedFor("M0002"));
    const c = r.b.daemonCloses();
    expect([...c.byReason]).toEqual([["refusal", 1]]);
    expect([...c.refusalFamilies]).toEqual([["WithEvents subscriber …", 1]]);
    expect(sunk).toEqual([{ reason: "refusal", family: "WithEvents subscriber …" }]);
    // Not a warning: gates pin their warning sets (R939).
    expect(seen.filter(([code]) => code.includes("daemon"))).toEqual([]);
  });

  test("a timeout row: reason timeout, no family", async () => {
    const { r } = await watched(timedOutFor("M0002"));
    const c = r.b.daemonCloses();
    expect([...c.byReason]).toEqual([["timeout", 1]]);
    expect(c.refusalFamilies.size).toBe(0);
  });

  test("every row kept: no close until the session ends, which is counted but never sent to the sink", async () => {
    const { r, sunk } = await watched(allPass);
    expect(r.b.daemonCloses().byReason.size).toBe(0);
    await r.b.close();
    expect([...r.b.daemonCloses().byReason]).toEqual([["session-end", 1]]);
    expect(sunk).toEqual([]);
  });

  test("the close line names each reason and the refusal families, most first", () => {
    expect(
      v3DaemonClosesText({
        byReason: new Map([
          ["timeout", 1],
          ["refusal", 3],
        ]),
        refusalFamilies: new Map([
          ["DateTime before N", 1],
          ["WithEvents subscriber …", 2],
        ]),
      }),
    ).toBe("daemons closed: refusal 3 (WithEvents subscriber … 2, DateTime before N 1), timeout 1");
    expect(v3DaemonClosesText({ byReason: new Map(), refusalFamilies: new Map() })).toBe(
      "daemons closed: none",
    );
  });

  test("unkeptRowReason: kept rows give none; a pass with v3's marker is unkept-row", () => {
    expect(unkeptRowReason([{ name: "Codeunit1.A", status: "pass", notRun: false }])).toBe(
      undefined,
    );
    expect(
      unkeptRowReason([
        { name: "Codeunit1.A", status: "pass", notRun: false, message: WITH_EVENTS },
      ])?.reason,
    ).toBe("unkept-row");
  });

  test("a refusal's family masks backticked and quoted spans BEFORE cutting, so no code survives; numbers in words stay", () => {
    const family = (message: string) =>
      unkeptRowReason([{ name: "Codeunit1.A", status: "error", notRun: true, message }])?.family;
    // A backticked call holds the cut characters: masked first, nothing of it is left.
    expect(
      family(
        "NotRun: out-of-scope: call `Chart.UpdateChart(CurrPage.Forecast)`: what it does is not pinned",
      ),
    ).toBe("call …");
    expect(family("NotRun: out-of-scope: a DateTime before 1753 (not pinned)")).toBe(
      "a DateTime before N",
    );
    expect(family("NotRun: out-of-scope: field 'CO2e Emission' of table CO2e Ledger")).toBe(
      "field … of table CO2e Ledger",
    );
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
    // R895: the warm-up never opts in to the cut: its timeout row is read to the end, so the daemon
    // is closed by a shutdown (a cut kills it without one), and no cut is counted.
    expect(r.serve.closes.filter((c) => c.daemon === 0)).toHaveLength(1);
    expect(r.b.entriesStats().timeoutCuts).toBe(0);
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

  describe("R912: windows decide a batch refusal as one whole-batch prefetch does", () => {
    const four = plans(["M0001", "M0002", "M0003", "M0004"]);
    /** Every entry of these mutants is refused with one unlisted reason; the warm-up is not. */
    const refuseOnly = (ids: readonly string[]) => ({
      rows: ((m, cu, d, n) =>
        ids.includes(m)
          ? allPass(m, cu, d, n).map((x) => ({
              ...x,
              status: "error" as const,
              notRun: true,
              message: UNLISTED,
            }))
          : allPass(m, cu, d, n)) as RowsFn,
      echo: ((m, d, n) =>
        ids.includes(m)
          ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
          : goodEcho(m, d, n)) as Echo,
    });
    const run = async (windows: readonly (typeof four)[], refused: readonly string[]) => {
      const r = await rig({ serve: refuseOnly(refused), oneShotRows: allPass });
      await baseline(r.b, SUITE1);
      let err: unknown;
      for (const [i, w] of windows.entries()) {
        err = await r.b.prefetchMutants(w, i === 0 ? { batchPlans: four } : undefined).then(
          () => undefined,
          (e: unknown) => e,
        );
        if (err !== undefined) break;
      }
      return err;
    };

    test("a refused batch stops the session with one group per window and with many, as with one window", async () => {
      const all = four.map((p) => p.mutantId);
      const whole = await run([four], all);
      const many = await run([four.slice(0, 2), four.slice(2)], all);
      const lone = await run(
        four.map((p) => [p]),
        all,
      );
      for (const err of [whole, many, lone]) {
        expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
        expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
      }
    });

    test("a lone group outside any batch is still that mutant's error, never a batch stop", async () => {
      const r = await rig({ serve: refuseOnly(["M0001"]), oneShotRows: allPass });
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]));
    });

    test("a later window refused after an earlier window ran is no batch stop, as in one chunk", async () => {
      const later = ["M0003", "M0004"];
      expect(await run([four], later)).toBeUndefined();
      expect(await run([four.slice(0, 2), four.slice(2)], later)).toBeUndefined();
      expect(
        await run(
          four.map((p) => [p]),
          later,
        ),
      ).toBeUndefined();
    });
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

  const warmupRefusal = async (source: "default" | "explicit", earlierWarmups = 0) => {
    const r = await rig({
      serve: { rows: refuseFrom(0), echo: refusedEcho(0) },
      oneShotRows: allPass,
    });
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = source;
    await baseline(r.b, SUITE1);
    // R960 review a: a session that already warmed a daemon up (another mode, a restart).
    (r.b as unknown as { stats: { warmups: number } }).stats.warmups = earlierWarmups;
    return r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
  };

  test("R960: default + the whole warm-up refused: the typed fallback signal, naming the reason", async () => {
    const err = await warmupRefusal("default");
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(String(err)).toContain("entries-batch-refused");
    expect(String(err)).toContain(UNLISTED);
    // R960 review b: a whole-request refusal, not a row R612 refuses; no R635 plan suffix.
    expect((err as AlRunnerV3ServeFallbackWarmupError).wholeRequest).toBe(true);
    expect(String(err)).toContain("met a refusal of the whole warm-up request");
    expect(String(err)).not.toContain("which R612 refuses by name");
    expect(String(err)).not.toContain("(R635 plan §3, §6)");
  });

  test("R960 review a: a LATER warm-up's whole-request refusal still fails by name (no session re-run)", async () => {
    const err = await warmupRefusal("default", 1);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(err).not.toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
  });

  test("R960: explicit + the whole warm-up refused: still fails by name", async () => {
    const err = await warmupRefusal("explicit");
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
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
    expect(argv.join(" ")).toContain(
      "--bc-version 28.0.46665.47126 --environment saas --no-download",
    );
  });

  test("R954: useMutantStop makes S ceil(ms/1000) even when the baseline timeout is larger, and a daemon started under the old stop is replaced", async () => {
    const r = await readyRig({ floor: [1000, 120_000], mutants: ["M0001"] });
    expect(r.b.inRunStopMs).toBe(120_000); // before: max(floor, baseline timeout)
    expect(r.serve.daemons).toHaveLength(1);
    expect((r.serve.daemons[0] ?? []).join(" ")).toContain("--test-timeout 120");
    r.b.useMutantStop(60_500);
    expect(r.b.inRunStopMs).toBe(61_000);
    await r.b.prefetchMutants(plans(["M0002"]));
    expect(r.serve.daemons).toHaveLength(2);
    expect((r.serve.daemons[1] ?? []).join(" ")).toContain("--test-timeout 61");
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

  test("R912: a first window warms up the whole batch's codeunits when given batchPlans, and only its own without", async () => {
    const window1 = [{ mutantId: "M0001", refs: [ref("A")] }];
    const batch = [...window1, { mutantId: "M0002", refs: [ref("C", CU2)] }];
    const whole = await rig({ suite: SUITE2 });
    await baseline(whole.b, SUITE2);
    await whole.b.prefetchMutants(window1, { batchPlans: batch });
    expect(whole.serve.firsts()[0]?.ids).toEqual(["NONE|echo", `NONE|${CU}`, `NONE|${CU2}`]);
    const alone = await rig({ suite: SUITE2 });
    await baseline(alone.b, SUITE2);
    await alone.b.prefetchMutants(window1);
    expect(alone.serve.firsts()[0]?.ids).toEqual(["NONE|echo", `NONE|${CU}`]);
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
  const build = async (extra: Record<string, unknown>, alFiles: Record<string, string> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-v3e-cli-"));
    roots.push(dir);
    for (const [name, text] of Object.entries(alFiles)) await writeFile(join(dir, name), text);
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
          environment: "saas", // R938
          packagesDir: deps,
          bcVersion: "28.0.46665.47126",
          alcPath: "/fake/alc",
          coverage: "none",
          ...extra,
        },
      },
      dir,
      undefined,
      { alcRunnable: () => true },
      { selectorId: SELECTOR_ID, controlId: ECHO, tableId: 79197 },
    );
  };
  test("no transport builds a backend that is one-shot until the session decides (R761); transport serve-entries builds serve-entries", async () => {
    if (!LINUX) {
      await expect(build({})).rejects.toThrow(/al-runner-v3-(windows|platform)-unsupported/);
      return;
    }
    expect((await build({})).inRunStopIsBudget).toBe(true);
    expect((await build({ transport: "serve-entries" })).inRunStopIsBudget).toBe(false);
  });

  // R907: the capability the report reads. Off Linux the refusal above is already asserted.
  test.skipIf(!LINUX)(
    "coverage turned off for a wrapper shape names the file in the capabilities",
    async () => {
      const unit = `codeunit 50604 "R907 Arms"\n{\n    procedure Hit()\n    begin\n    end;\n}\n`;
      const twoArm = `#if SYM\n${unit}#else\n${unit}#endif\n`;
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const off = await build({ coverage: "al-runner" }, { "Odd.Codeunit.al": twoArm });
        expect(off.capabilities().coverage).toBe("none");
        expect(off.capabilities().coverageOffFiles).toEqual(["Odd.Codeunit.al"]);
        const on = await build({ coverage: "al-runner" }, { "Plain.Codeunit.al": unit });
        expect(on.capabilities().coverage).toBe("al-runner");
        expect("coverageOffFiles" in on.capabilities()).toBe(false);
        const configured = await build({ coverage: "none" }, { "Odd.Codeunit.al": twoArm });
        expect("coverageOffFiles" in configured.capabilities()).toBe(false);
      } finally {
        warn.mockRestore();
      }
    },
  );
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

  test("R912: only a prefetch request's deadline is clamped to the time left; the warm-up and a live request never are", async () => {
    const real = AlRunnerServer.prototype.runEntries;
    const deadlines: number[] = [];
    const spy = spyOn(AlRunnerServer.prototype, "runEntries").mockImplementation(function (
      this: AlRunnerServer,
      ...a: Parameters<typeof real>
    ) {
      deadlines.push(a[1] as number);
      return real.apply(this, a);
    });
    try {
      const r = await rig();
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]), { remainingMs: () => 5000 });
      await r.b.prefetchMutants(plans(["M0002"])); // no budget: today's deadline
      await r.b.activate("M0003"); // never prefetched: its run is a live request
      await r.b.run(ref("A"), OPTS);
    } finally {
      spy.mockRestore();
    }
    const [warmup, clamped, plain, live] = deadlines;
    expect(deadlines).toHaveLength(4);
    expect(clamped).toBe(5000);
    expect(warmup).toBeGreaterThan(5000);
    expect(plain).toBeGreaterThan(5000);
    expect(live).toBeGreaterThan(5000);
  });

  test("R912: wholeCodeunit is true on entries for a codeunit that is not per-test, false per test and one-shot", async () => {
    const entries = await rig();
    expect(entries.b.wholeCodeunit(CU)).toBe(true);
    const perTest = await rig({ extra: { isolateTests: true } });
    expect(perTest.b.wholeCodeunit(CU)).toBe(false);
    const oneShot = await rig({ extra: { transport: "one-shot" } });
    expect(oneShot.b.wholeCodeunit(CU)).toBe(false);
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
  test("R788: unflagged, exactly D1, D1c and T run serve-entries; a flag names every leg's transport", () => {
    const serve = { transport: "serve-entries" } as const;
    for (const leg of ["D1", "D1c", "T"]) expect(v3ItestLegTransport(leg, {})).toEqual(serve);
    for (const leg of [
      "C",
      "S1",
      "S1E",
      "DB",
      "DBI",
      "S3",
      "N1",
      "N1E",
      "N1S",
      "O1",
      "ISO",
      "X",
      "L1",
      "Y-A",
      "Y-B",
      "MO",
      "WR",
      "K",
    ])
      expect(v3ItestLegTransport(leg, {})).toEqual({});
    expect(V3_GATE_SERVE_LEGS).toEqual(["D1", "D1c", "T"]);
    expect(v3ItestLegTransport("D1", { LETHAL_ITEST_V3_TRANSPORT: "one-shot" })).toEqual({});
    expect(
      v3ItestLegTransport("S1", {
        LETHAL_ITEST_V3_TRANSPORT: "serve-entries",
        LETHAL_ITEST_V3_SECOND_ECHO: "0",
      }),
    ).toEqual({ transport: "serve-entries", secondEcho: false });
    expect(() => v3ItestLegTransport("D1", { LETHAL_ITEST_V3_SECOND_ECHO: "0" })).toThrow(
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

  test("R785: the lane rule's warm-up is lane 0's LATEST daemon start, not the session total", async () => {
    const { r, clock } = await clockedRig();
    await scenario(r, clock);
    expect([r.b.laneWarmupMs(), r.b.laneDaemonStarts()]).toEqual([1, 1]);
    await r.b.deploy(r.l.batch); // closes the daemon: the next batch warms a new one
    await scenario(r, clock);
    expect(r.b.entriesStats().warmupMs).toBe(2); // the session total grew ...
    expect([r.b.laneWarmupMs(), r.b.laneDaemonStarts()]).toEqual([1, 2]); // ... the rule's figure did not
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
    // R766 (b): assertBound takes the lane it checks.
    const b = r.b as unknown as { assertBound: (lane: unknown) => Promise<void> };
    const orig = b.assertBound.bind(r.b);
    // Each check takes 7 on the fake clock; the requests' amounts are unchanged.
    spyOn(b, "assertBound").mockImplementation(async (lane: unknown) => {
      clock.t += 7;
      await orig(lane);
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

// R807: a seed refusal is not a skipped pair, and the observed seed is read on every serve path.
describe("R807: the kill pair rethrows a seed refusal; observedRunSeed reads each serve path", () => {
  const seeded = (when: (q: Req) => boolean): ServeScript => ({
    answer: (q, _n, lines) =>
      when(q)
        ? {
            lines: lines.map((x) =>
              x.type === "summary" ? { ...x, seed: 1, seedSource: "env" } : x,
            ),
          }
        : undefined,
  });
  const isPlain = (q: Req) => q.ids[0]?.startsWith("plain:") === true;

  test("N1: a seed refusal in the kill pair is rethrown, not filed as al-runner-v3-pair-skipped", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, mutants: ["M0001"] });
    const seen: Array<[string, string]> = [];
    r.b.setNotify((c, m) => seen.push([c, m]));
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    (r.b as unknown as { request: () => Promise<never> }).request = async () => {
      throw new AlRunnerV3SeedError("seed 2");
    };
    await expect(r.b.sendKillPair("M0001", ref("A"))).rejects.toBeInstanceOf(AlRunnerV3SeedError);
    expect(seen).toEqual([]);
  });

  test("S2: a warm-up (send) answer reporting seed 1 is observed; none reported leaves it absent", async () => {
    const none = await readyRig({ mutants: ["M0001"] });
    expect(none.serve.requests.length).toBeGreaterThan(0);
    expect(none.b.observedRunSeed()).toBeUndefined();
    const r = await readyRig({ serve: seeded((q) => !isPlain(q)), mutants: ["M0001"] });
    expect(r.serve.requests.length).toBeGreaterThan(0);
    expect(r.b.observedRunSeed()).toBe(1);
  });

  test("S2: a plain request (the coverage window) reporting seed 1 is observed", async () => {
    const r = await readyRig({
      targetAl: SLEEPER_AL,
      mutants: ["M0001"],
      serve: { coverage: sleepCoverage(), ...seeded(isPlain) },
    });
    expect(r.b.observedRunSeed()).toBeUndefined(); // the entries sends reported none
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.b.observedRunSeed()).toBe(1);
  });
});

describe("R927: an explicit serve-entries run probes for a batch refusal before the baseline", () => {
  // E-Document Core's reason (R-915): serve refuses EVERY entry with it, whatever the codeunit.
  const INSTALL =
    "NotRun: out-of-scope: the install code read a resource file, and an entry with resource files of its own would need an install baseline of its own (al-runner issue 5635)";
  const allRefused: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((x) => ({
      ...x,
      status: "error" as const,
      notRun: true,
      message: INSTALL,
    }));
  // The echo entry is refused with the same reason, as every entry of E-Document Core's request was.
  const echoRefused: Echo = () => ({
    method: "Echo",
    status: "error",
    notRun: true,
    message: INSTALL,
  });

  test("explicit + every entry refused: deploy itself fails by name, with the probe's text", async () => {
    const err = await rig({
      serve: { rows: allRefused, echo: echoRefused },
      oneShotRows: allPass,
      extra: { transportSource: "explicit" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
    expect(String(err)).toContain("found before the baseline by the probe of codeunit");
    expect(String(err)).toContain(INSTALL);
  });

  test("explicit + a clean answer: one probe request, its daemon closed, the session goes on", async () => {
    const r = await rig({ extra: { transportSource: "explicit" } });
    expect(r.serve.requests).toHaveLength(1);
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.closes).toEqual([{ daemon: 0, afterRequests: 1 }]);
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(r.serve.daemons).toHaveLength(2); // the warm-up's own daemon, as before
    // R939: the probe's close is counted on the close line, and is routine: never an early close.
    expect([...r.b.daemonCloses().byReason]).toEqual([["probe", 1]]);
    expect([...V3_ROUTINE_CLOSES].sort()).toEqual([
      "baseline-end", // R948: the baseline's own daemon
      "deploy",
      "mutant-stop",
      "probe",
      "session-end",
    ]);
  });

  test("the default transport and an internal caller (no source) never probe", async () => {
    for (const extra of [{ transportSource: "default" as const }, {}]) {
      const r = await rig({
        serve: { rows: allRefused, echo: echoRefused },
        oneShotRows: allPass,
        extra,
      });
      expect(r.serve.requests, JSON.stringify(extra)).toHaveLength(0);
    }
  });

  test("review r1: the probe runs once per session, not at every deploy", async () => {
    const r = await rig({ extra: { transportSource: "explicit" } });
    await r.b.deploy(r.l.batch);
    expect(r.serve.requests).toHaveLength(1);
  });

  test("review r1: a probe answer that is no batch refusal is not the probe's to judge: deploy goes on", async () => {
    // The probe's request gets a broken answer (stdout ends): a request error, which the warm-up judges later.
    const r = await rig({
      serve: { answer: (_req, n) => (n === 0 ? { lines: [], eof: true } : undefined) },
      extra: { transportSource: "explicit" },
    });
    expect(r.serve.requests).toHaveLength(1);
    expect(r.serve.closes.length + r.serve.kills.length).toBeGreaterThan(0);
  });
});

describe("R786: the serve-entries DEFAULT falls back on a warm-up row R612 refuses by name", () => {
  const COMPANY =
    "NotRun: out-of-scope: FindSet on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)";
  const PLAIN_REFUSAL = "NotRun: out-of-scope: runtime panic (bug): x";
  const underNone =
    (message: string, status: "error" | "fail" = "error"): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status, ...(status === "error" ? { notRun: true } : {}), message }
          : x,
      );
  /** As the CLI builds a default backend: the source is "default" (the rig's entries are already on). */
  const asDefault = (r: Rig, source: "default" | "explicit" = "default") => {
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = source;
    return r;
  };
  const prefetch = (r: Rig) => r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);

  test("default + a named refusal at the warm-up: the typed fallback signal, the daemon closed, no mutant entry sent", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(COMPANY) } }));
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(String(err)).toContain(`Codeunit${CU}.B`);
    expect(String(err)).toContain(COMPANY);
    expect(r.serve.requests.map((q) => q.ids[0])).toEqual(["NONE|echo"]);
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.closes).toEqual([{ daemon: 0, afterRequests: 1 }]);
  });

  test("explicit serve-entries + the same row: refuses warmup-dirty as before", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(COMPANY) } }), "explicit");
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
    // R927: and names the way out, since the default would have re-run one-shot.
    expect(String(err)).toContain("the default would re-run this session one-shot instead");
  });

  test("R927: explicit + a timeout row (no fallback would apply either): no way-out text", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(TIMEOUT_1S) } }), "explicit");
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
    expect(String(err)).not.toContain("the default would re-run");
  });

  test("default + a named refusal FIRST and a timeout row after it (same entry): still refuses, naming the timeout", async () => {
    const mixed: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m !== "NONE"
          ? x
          : x.method === "A"
            ? { ...x, status: "error" as const, notRun: true, message: COMPANY }
            : x.method === "B"
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
      );
    const r = asDefault(await rig({ serve: { rows: mixed } }));
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain(`Codeunit${CU}.B`);
    expect(String(err)).toContain(TIMEOUT_1S);
  });

  test("default + a named refusal in one codeunit and a timeout in another: still refuses", async () => {
    const mixed: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m !== "NONE"
          ? x
          : cu === CU && x.method === "A"
            ? { ...x, status: "error" as const, notRun: true, message: COMPANY }
            : cu === CU2
              ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S }
              : x,
      );
    const r = asDefault(await rig({ suite: SUITE2, serve: { rows: mixed } }));
    await baseline(r.b, SUITE2);
    const err = await r.b.prefetchMutants(plans(["M0001"], SUITE2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain(TIMEOUT_1S);
  });

  test("default + a timeout row (dirty, but not a refusal by name): still refuses", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(TIMEOUT_1S) } }));
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
  });

  test("default + a plain fail that holds v3's refusal marker (R672): still refuses", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(PLAIN_REFUSAL, "fail") } }));
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
  });

  test("default + warm-up rows that disagree with the baseline rows: still refuses (never a fallback)", async () => {
    // The baseline (one-shot) rows are clean; the daemon's NONE row for B is the named refusal.
    const r = asDefault(await rig({ serve: { rows: underNone(COMPANY) }, oneShotRows: allPass }));
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-disagrees");
  });

  test("default + a wrong echo at the warm-up: still refuses (never a fallback)", async () => {
    const r = asDefault(
      await rig({
        serve: { rows: underNone(COMPANY), echo: () => ({ method: "Echo", status: "pass" }) },
      }),
    );
    await baseline(r.b, SUITE1);
    const err = await prefetch(r);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
  });

  test("a fallback while a kill pair starts the daemon is not swallowed as pair-skipped", async () => {
    const r = asDefault(await rig({ serve: { rows: underNone(COMPANY) } }));
    await baseline(r.b, SUITE1);
    // The pair needs an activated mutant outside the baseline and no prefetch (so the daemon starts here).
    await r.b.activate("M0001");
    const seen: string[] = [];
    r.b.setNotify((c) => seen.push(c));
    const err = await r.b.sendKillPair("M0001", ref("A")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(seen).toEqual([]);
  });
});

describe("R761: a real first spawn freezes the transport decision", () => {
  const decided = (r: Rig) => {
    // A default-source backend, as the CLI builds it; the build is as `status()` would record it.
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = "default";
    (r.b as unknown as { build: unknown }).build = {
      version: "alrunner 3.0.0-alpha.5 (abcdef012)",
      binarySha256: "0",
    };
    return r.b.decideTransport({ resume: false }).catch((e: unknown) => e);
  };

  test("a one-shot call (callCodeunit) freezes it", async () => {
    const r = await rig({ extra: { transport: "one-shot" } });
    expect(r.one.calls).toHaveLength(0);
    await baseline(r.b, SUITE1);
    expect(r.one.calls.length).toBeGreaterThan(0);
    expect(await decided(r)).toBeInstanceOf(AlRunnerV3TransportFrozenError);
  });

  test("a daemon start (startDaemon) freezes it", async () => {
    // R790: no speculative baseline, whose one-shot calls in deploy() would freeze it first.
    const r = await rig({ seams: { noSpeculativeBaseline: true } });
    // The one-shot baseline spawn would freeze it; a daemon start alone must too.
    const priv = r.b as unknown as {
      startDaemon(lane: unknown, mode: unknown): Promise<unknown>;
      lane: unknown;
    };
    await priv.startDaemon(priv.lane, { testIsolation: "test", runSelectedOnly: false });
    expect(r.one.calls).toHaveLength(0);
    expect(r.serve.daemons.length).toBeGreaterThan(0);
    expect(await decided(r)).toBeInstanceOf(AlRunnerV3TransportFrozenError);
  });
});

// R778: after the prefetch, the NONE confirm and the mutant reproduction of every kill travel in a
// few chunked requests (each kill's NONE group directly before its M group), and the orchestrator's
// sendKillPair uses a stored pair only when the kill came from the prefetch and the pair ran after it.
describe("R778: kill pairs batched after the prefetch", () => {
  const A = ref("A");
  /** A fails under every mutant; NONE passes everything. */
  const killsAll: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((r) =>
      m !== "NONE" && r.method === "A" ? { ...r, status: "fail" as const, message: "boom" } : r,
    );
  const failA = (rs: FakeRow[], message: string): FakeRow[] =>
    rs.map((x) => (x.method === "A" ? { ...x, status: "fail" as const, message } : x));
  const unkept = (): FakeRow => ({
    method: "B",
    status: "error",
    notRun: true,
    message: TIMEOUT_1S,
  });
  /** Deployed, baseline, prefetch (and the batch). `before` is the counters just before the prefetch. */
  const batchRig = async (
    mk: (isBatch: (n: number) => boolean) => ServeScript,
    mutants: readonly string[],
    notices: string[] = [],
    suite: readonly TestMethodRef[] = SUITE1,
  ) => {
    let reqs: readonly Req[] = [];
    /** Request `n` is a batch: its first entry is a NONE pair group. */
    const isBatch = (n: number) => (reqs[n]?.ids[0] ?? "").startsWith("NONE#");
    const r = await rig({ serve: mk(isBatch), oneShotRows: allPass, suite, pairBatch: true });
    reqs = r.serve.requests;
    r.b.setNotify((c) => notices.push(c));
    await baseline(r.b, suite);
    const before = r.b.entriesStats();
    await r.b.prefetchMutants(plans(mutants, suite));
    return { r, before };
  };
  const kill = async (r: Rig, m: string) => {
    await r.b.activate(m);
    expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
  };
  /** The orchestrator's order after a kill: the pair, the confirm, the reproduction. */
  const confirmAndRepro = async (r: Rig, m: string) => {
    await r.b.sendKillPair(m, A);
    await r.b.activate(null);
    const confirm = await r.b.run(A, OPTS);
    await r.b.activate(m);
    const repro = await r.b.run(A, OPTS);
    return { confirm: confirm.outcome, repro: repro.outcome, reproMessage: repro.failureMessage };
  };
  const batchStats = (r: Rig) => {
    const s = r.b.entriesStats();
    return {
      requests: s.pairBatchRequests,
      stored: s.pairBatchStored,
      served: s.pairBatchServed,
      refused: s.pairBatchRefused,
    };
  };

  test("R912: a kill pair formed in window 2 gives the one-window result, with no extra request", async () => {
    const scenario = async (windowed: boolean) => {
      const r = await rig({ serve: { rows: killsAll }, oneShotRows: allPass, pairBatch: true });
      await baseline(r.b, SUITE1);
      const all = plans(["M0001", "M0002"]);
      if (windowed) {
        await r.b.prefetchMutants(all.slice(0, 1), { batchPlans: all });
        await r.b.prefetchMutants(all.slice(1));
      } else {
        await r.b.prefetchMutants(all, { batchPlans: all });
      }
      await kill(r, "M0002");
      const n0 = r.serve.requests.length;
      const got = await confirmAndRepro(r, "M0002");
      return { got, extraRequests: r.serve.requests.length - n0, stats: batchStats(r) };
    };
    const one = await scenario(false);
    const two = await scenario(true);
    expect(one.extraRequests).toBe(0);
    expect(one.got).toMatchObject({ confirm: "pass", repro: "fail" });
    expect(two.got).toEqual(one.got);
    expect(two.extraRequests).toBe(one.extraRequests);
    expect(two.stats.served).toBe(1);
  });

  describe("1: two NONE groups for one codeunit keep their own answers", () => {
    for (const flaky of [0, 1]) {
      test(`the ${flaky === 0 ? "first" : "second"} kill's NONE fails, the other passes: each confirms with ITS OWN NONE row`, async () => {
        const { r } = await batchRig(
          (isBatch) => ({
            rows: (m, cu, d, n, seen) =>
              m === "NONE" && isBatch(n) && seen === flaky
                ? failA(allPass(m, cu, d, n), "flaky")
                : killsAll(m, cu, d, n),
          }),
          ["M0001", "M0002"],
        );
        const batch = r.serve.requests.at(-1)?.ids;
        expect(batch).toEqual([
          "NONE#M0001|echo",
          `NONE#M0001|${CU}`,
          "M0001#m|echo",
          `M0001#m|${CU}`,
          "NONE#M0002|echo",
          `NONE#M0002|${CU}`,
          "M0002#m|echo",
          `M0002#m|${CU}`,
        ]);
        const n0 = r.serve.requests.length;
        const got: string[] = [];
        for (const m of ["M0001", "M0002"]) {
          await kill(r, m);
          got.push((await confirmAndRepro(r, m)).confirm);
        }
        expect(got).toEqual(flaky === 0 ? ["fail", "pass"] : ["pass", "fail"]);
        expect(r.serve.requests.length).toBe(n0);
        expect(batchStats(r)).toEqual({ requests: 1, stored: 2, served: 2, refused: 0 });
      });
    }
  });

  describe("2: a pair is used only for a kill that came from the prefetch, and only if it ran after it", () => {
    test("a kill served by liveCall (the prefetched rows dropped) sends today's pair; the stored one is refused", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      (r.b as unknown as { prefetched: Map<string, unknown> }).prefetched = new Map();
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(r.serve.requests.at(-1)?.ids).toEqual([
        "NONE|echo",
        `NONE|${CU}`,
        "M0001|echo",
        `M0001|${CU}`,
      ]);
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 1 });
    });

    test("a kill from the prefetch but a pair that did not run after it: today's pair", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      const store = (r.b as unknown as { pairStore: Map<string, { seq: number }> }).pairStore;
      for (const [k, v] of store) store.set(k, { ...v, seq: 0 });
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 1 });
    });

    test("a kill in another codeunit than the stored pair's: today's pair, with the actual codeunit", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"], [], SUITE2);
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", ref("C", CU2));
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(r.serve.requests.at(-1)?.ids).toEqual([
        "NONE|echo",
        `NONE|${CU2}`,
        "M0001|echo",
        `M0001|${CU2}`,
      ]);
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 1 });
    });

    test("a hit sets the pair's ref to the actual killer: its confirm and its reproduction are served", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      // The prefetch predicted A; the kill was by B (the same codeunit).
      await r.b.sendKillPair("M0001", ref("B"));
      await r.b.activate(null);
      expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
      await r.b.activate("M0001");
      expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
      expect(r.serve.requests.length).toBe(n0);
      expect(r.b.entriesStats().pairRequests).toBe(1);
    });

    test("the reproduction before the confirm is live, and so is the confirm", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      await kill(r, "M0001");
      await r.b.sendKillPair("M0001", A);
      expect(batchStats(r)).toMatchObject({ served: 1 });
      const n0 = r.serve.requests.length;
      // Wrong order: M first. The pair is not consumed by it; both runs are live.
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
      await r.b.activate(null);
      expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
      expect(r.serve.requests.length).toBe(n0 + 2);
      expect(r.b.entriesStats().pairRequests).toBe(0);
    });
  });

  describe("3: the encoder keeps groups apart by key", () => {
    const e = (id: string, m: string, t: unknown = `Codeunit${CU}.`) => ({
      id,
      resources: { "active-mutant.txt": m },
      test: t,
    });
    const echoOf = (id: string, m: string) => e(`${id}|echo`, m, `Codeunit${ECHO}.`);
    const ok = (xs: readonly object[]) => wellFormed(xs, `Codeunit${ECHO}.`);
    const pair = [
      { mutantId: "NONE", key: "NONE#a", codeunits: [CU] },
      { mutantId: "a", key: "a#m", codeunits: [CU] },
    ];

    test("ids carry the key, the override stays exactly the override", () => {
      const sent = encodeGroups(pair, ECHO);
      expect(sent.map((x) => x.id)).toEqual([
        "NONE#a|echo",
        `NONE#a|${CU}`,
        "a#m|echo",
        `a#m|${CU}`,
      ]);
      expect(sent.map((x) => x.resources["active-mutant.txt"])).toEqual(["NONE", "NONE", "a", "a"]);
      expect(sent.map((x) => x.mutantId)).toEqual(["NONE", "NONE", "a", "a"]);
    });
    test("a duplicate key is refused", () => {
      expect(() => encodeGroups([...pair, ...pair], ECHO)).toThrow(AlRunnerV3EntriesEncodeError);
    });
    test("two groups of one key apart (reordered) are refused", () => {
      expect(() =>
        ok([
          echoOf("NONE#a", "NONE"),
          e("NONE#a|1", "NONE"),
          echoOf("a#m", "a"),
          e("NONE#a|2", "NONE"),
        ]),
      ).toThrow(/two groups/);
    });
    test("a swapped id (the key of one override, the override of another) is refused", () => {
      expect(() => ok([echoOf("NONE#a", "NONE"), e("a#m|1", "NONE")])).toThrow(/override/);
      expect(() => ok([echoOf("a#m", "a"), e("NONE#a|1", "a")])).toThrow(/override/);
    });
    test("NONE's override is exact: not a longer text, not two overrides in one group", () => {
      expect(() => ok([echoOf("NONE#a", "NONEX")])).toThrow(/override/);
      expect(() => ok([echoOf("NONE#a", "NONE"), e("NONE#a|1", "NONE#a")])).toThrow(/override/);
    });
  });

  describe("4: a stored pair is single-use and bound to its deploy", () => {
    test("redeploy with the same mutant id: nothing is served", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      const store = (r.b as unknown as { pairStore: Map<string, unknown> }).pairStore;
      expect(store.size).toBe(1);
      await r.b.deploy(r.l.batch);
      // The deploy alone empties it (the baseline bracket and a prefetch would too).
      expect(store.size).toBe(0);
      await baseline(r.b, SUITE1);
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(batchStats(r)).toMatchObject({ served: 0 });
    });
    test("a pair stored under another artifact id is not served", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      // The batch now in force has another artifact id (a store the deploy did not clear).
      // (The bound check would refuse the send of another artifact; it is not what this test is about.)
      const priv = r.b as unknown as { proof: { artifactId: string }; checkBound: () => unknown };
      priv.proof = { ...priv.proof, artifactId: "ffffffffffffffffffffffffffffffff" };
      priv.checkBound = async () => {};
      await kill(r, "M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(batchStats(r)).toMatchObject({ served: 0 });
    });
    test("a second lookup serves nothing", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
      await kill(r, "M0001");
      await confirmAndRepro(r, "M0001");
      expect(batchStats(r)).toMatchObject({ served: 1 });
      await r.b.activate("M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(batchStats(r)).toMatchObject({ served: 1 });
    });
    test("a lookup that does not match still deletes the entry", async () => {
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"], [], SUITE2);
      await kill(r, "M0001");
      await r.b.sendKillPair("M0001", ref("C", CU2));
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 1 });
      await r.b.activate("M0001");
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", A);
      expect(r.serve.requests.length).toBe(n0 + 1);
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 1 });
    });
    test("a new prefetch, the baseline bracket and status() each clear the store", async () => {
      for (const clear of [
        (r: Rig) => r.b.prefetchMutants([]),
        async (r: Rig) => {
          r.b.baselinePhase(true);
          r.b.baselinePhase(false);
        },
        async (r: Rig) => {
          await r.b.status().catch(() => undefined);
        },
      ]) {
        const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"]);
        const store = (r.b as unknown as { pairStore: Map<string, unknown> }).pairStore;
        expect(store.size).toBe(1);
        await clear(r);
        expect(store.size).toBe(0);
      }
    });
  });

  describe("5: a cut inside the batch", () => {
    const cases: Array<[string, (isBatch: (n: number) => boolean) => ServeScript]> = [
      [
        "at NONE_2's codeunit entry",
        (isBatch) => ({
          rows: (m, cu, d, n, seen) =>
            d === 0 && isBatch(n) && m === "NONE" && seen === 1
              ? [...failA(allPass(m, cu, d, n), "flaky-cut").slice(0, 1), unkept()]
              : killsAll(m, cu, d, n),
        }),
      ],
      [
        "at M_2's echo",
        (isBatch) => ({
          rows: (m, cu, d, n) =>
            d === 0 && isBatch(n) && m === "M0002"
              ? failA(allPass(m, cu, d, n), "from-cut-batch")
              : killsAll(m, cu, d, n),
          echo: (m, d, n) =>
            d === 0 && isBatch(n) && m === "M0002"
              ? { method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }
              : goodEcho(m, d, n),
        }),
      ],
      [
        "at M_2's codeunit entry (both its entries stand, M's last row is the cut)",
        (isBatch) => ({
          rows: (m, cu, d, n) =>
            d === 0 && isBatch(n) && m === "M0002"
              ? [...failA(allPass(m, cu, d, n), "boom").slice(0, 1), unkept()]
              : killsAll(m, cu, d, n),
        }),
      ],
    ];
    for (const [i, [name, mk]] of cases.entries()) {
      // Cases 0 and 1 leave kill 2 without both entries: it takes today's pair. Case 2 keeps it.
      const own = i < 2 ? 1 : 0;
      test(`${name}: earlier kills stand, the cut kill ${own === 1 ? "takes today's pair" : "stands as it is"}, later kills are re-sent`, async () => {
        const { r, before } = await batchRig(mk, ["M0001", "M0002", "M0003"]);
        // The first request (daemon 0) was cut; the kills after the cut were re-sent on a fresh daemon.
        expect(batchStats(r)).toEqual({ requests: 2, stored: 3 - own, served: 0, refused: 0 });
        const got: Record<string, unknown> = {};
        const sPre = r.b.entriesStats();
        for (const m of ["M0001", "M0002", "M0003"]) {
          await kill(r, m);
          got[m] = await confirmAndRepro(r, m);
        }
        for (const m of ["M0001", "M0002", "M0003"]) {
          expect(got[m]).toEqual({ confirm: "pass", repro: "fail", reproMessage: "boom" });
        }
        expect(batchStats(r)).toEqual({
          requests: 2,
          stored: 3 - own,
          served: 3 - own,
          refused: 0,
        });
        const s = r.b.entriesStats();
        const d = (k: keyof typeof s) => s[k] - before[k];
        // A kill that took today's path sent one pair of its own (its confirm passed).
        expect(s.liveRequests - sPre.liveRequests).toBe(own);
        expect([s.pairRequests, s.pairFallbacks1, s.pairFallbacks2]).toEqual([3, 0, 0]);
        // liveRequests = the batch requests + (2 - pairRequests) for each kill that took today's path.
        expect(d("liveRequests")).toBe(d("pairBatchRequests") + own);
        expect(d("boundChecks")).toBe(
          d("warmups") + d("prefetchRequests") + d("liveRequests") + d("coverageRequests"),
        );
      });
    }
  });

  describe("S1: only a request error is absorbed (as the prefetch does); every other error stops the session", () => {
    test("(a) an .al changed before chunk 2: the unproven error propagates, no notice, pairs are not served", async () => {
      const notices: string[] = [];
      const holder: { dir?: string } = {};
      let tampered = false;
      const mutants = Array.from({ length: 65 }, (_, i) => `M${String(i + 1).padStart(4, "0")}`);
      let reqs: readonly Req[] = [];
      const r = await rig({
        serve: {
          rows: (m, cu, d, n) => {
            // The first batch request answers; then the tree changes before the second chunk.
            if (!tampered && (reqs[n]?.ids[0] ?? "").startsWith("NONE#") && holder.dir) {
              tampered = true;
              appendFileSync(join(holder.dir, "Logic.Codeunit.al"), " ");
            }
            return killsAll(m, cu, d, n);
          },
        },
        oneShotRows: allPass,
        suite: SUITE1,
        pairBatch: true,
      });
      reqs = r.serve.requests;
      holder.dir = join(r.l.scratch, "active");
      r.b.setNotify((c) => notices.push(c));
      await baseline(r.b, SUITE1);
      const err = await r.b.prefetchMutants(plans(mutants)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
      expect(notices).not.toContain("al-runner-v3-pair-batch-skipped");
      expect(r.b.entriesStats().pairBatchRequests).toBe(1);
    });

    test("(b) a fresh daemon's warm-up disagrees while re-sending after a cut: the refusal propagates, no notice", async () => {
      const notices: string[] = [];
      let reqs: readonly Req[] = [];
      const isBatch = (n: number) => (reqs[n]?.ids[0] ?? "").startsWith("NONE#");
      const r = await rig({
        serve: {
          rows: (m, cu, d, n, seen) =>
            d === 0 && isBatch(n) && m === "NONE" && seen === 1
              ? [...failA(allPass(m, cu, d, n), "flaky-cut").slice(0, 1), unkept()]
              : d >= 1 && !isBatch(n) && m === "NONE"
                ? failA(allPass(m, cu, d, n), "disagrees")
                : killsAll(m, cu, d, n),
        },
        oneShotRows: allPass,
        suite: SUITE1,
        pairBatch: true,
      });
      reqs = r.serve.requests;
      r.b.setNotify((c) => notices.push(c));
      await baseline(r.b, SUITE1);
      const err = await r.b
        .prefetchMutants(plans(["M0001", "M0002", "M0003"]))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
      expect(String(err)).toContain("al-runner-v3-entries-warmup-disagrees");
      expect(notices).not.toContain("al-runner-v3-pair-batch-skipped");
    });
  });

  test("7: only a FAIL row is a kill candidate: survivors and timeouts send no batch", async () => {
    const { r } = await batchRig(
      () => ({
        rows: (m, cu, d, n) =>
          m === "M0002"
            ? allPass(m, cu, d, n).map((x) => (x.method === "A" ? { ...x, status: "pass" } : x))
            : allPass(m, cu, d, n),
      }),
      ["M0001", "M0002"],
    );
    expect(batchStats(r)).toEqual({ requests: 0, stored: 0, served: 0, refused: 0 });
  });

  describe("6: a chunk that throws stores nothing; every kill takes today's path", () => {
    test("no pair stored, a named notice, kind live (no batch refusal), each kill has its own pair", async () => {
      const notices: string[] = [];
      const { r } = await batchRig(
        (isBatch) => ({
          rows: killsAll,
          answer: (_req, n) => (isBatch(n) ? { lines: [], eof: true } : undefined),
        }),
        ["M0001", "M0002"],
        notices,
      );
      expect(batchStats(r)).toEqual({ requests: 1, stored: 0, served: 0, refused: 0 });
      expect(notices).toEqual(["al-runner-v3-pair-batch-skipped"]);
      const n0 = r.serve.requests.length;
      for (const m of ["M0001", "M0002"]) {
        await kill(r, m);
        expect(await confirmAndRepro(r, m)).toEqual({
          confirm: "pass",
          repro: "fail",
          reproMessage: "boom",
        });
      }
      // Per kill: its pair; the first kill's pair also restarts the closed daemon (a warm-up).
      expect(r.serve.requests.length).toBe(n0 + 3);
      expect(batchStats(r)).toMatchObject({ served: 0, refused: 0 });
      expect(r.b.entriesStats().pairRequests).toBe(2);
    });
  });
});

// R790 (A1, the owner's Design A): deploy() runs the baseline's one-shot calls while alc proves the
// batch, keeps their answers private, still waits for alc, and serves them once only when every byte
// they read is a byte the proof records. Call counters on the fakes, no wall clock.
describe("R790: the speculative baseline", () => {
  /** alc that rejects (or cannot start) the BATCH compile only; the test-app compile passes. */
  const batchAlc = (how: "reject" | "spawn"): ArtifactIo => {
    const ok = fakeAlc();
    return {
      ...ok,
      spawn: async (argv, o) => {
        const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
        if (!out.includes("v3-batch")) return ok.spawn(argv, o);
        if (how === "spawn") throw new Error("alc could not be started");
        const project = (argv.find((a) => a.startsWith("/project:")) ?? "").slice(9);
        return {
          exitCode: 1,
          stdout: `${project}/src/Logic.al(1,1): error AL0118: boom`,
          stderr: "",
        };
      },
    };
  };
  /** alc that passes, after `write(project, isBatch)` ran inside the compile's project dir. */
  const writingAlc = (write: (project: string, isBatch: boolean) => Promise<void>): ArtifactIo => {
    const ok = fakeAlc();
    return {
      ...ok,
      spawn: async (argv, o) => {
        const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
        await write(
          (argv.find((a) => a.startsWith("/project:")) ?? "").slice(9),
          out.includes("v3-batch"),
        );
        return ok.spawn(argv, o);
      },
    };
  };
  async function deployWith(
    alc: ArtifactIo | undefined,
    speculate: boolean | undefined,
    o: {
      rows?: RowsFn;
      floor?: readonly [number, number];
      seams?: (l: Layout) => AlRunnerV3Backend["seams"];
      /** Option 4: a cache dir shared by deploys. */
      cacheDir?: string;
    } = {},
  ) {
    const l = await layout(TARGET_AL, SUITE1);
    const one = fakeOneShot(o.rows ?? allPass);
    const serve = fakeServe();
    const b = new AlRunnerV3Backend(
      {
        alRunnerPath: "/fake/al-runner",
        environmentChoice: { value: "saas", source: "config" },
        instrumentedDir: l.scratch,
        testDir: l.testDir,
        packagesDir: l.deps,
        bcVersion: "28.0.46665.47126",
        selectorObjectId: SELECTOR_ID,
        alcPath: "/fake/alc",
        coverage: "none",
        transport: "serve-entries",
        // R798: opt-in. undefined leaves the option unset, so the env decides.
        ...(speculate !== undefined ? { speculateBaseline: speculate } : {}),
        ...(o.cacheDir !== undefined ? { cacheDir: o.cacheDir } : {}),
      },
      one.spawn,
      alc ?? fakeAlc(),
      serve.spawn,
    );
    b.useBuildSymbols([]);
    b.useDiscoveredTests(SUITE1);
    b.useSessionTests(SUITE1);
    b.useMutantBudgetFloor(...(o.floor ?? [1000, 1000]));
    Object.assign(b.seams, o.seams?.(l) ?? {});
    const err = await b.deploy(l.batch).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { l, b, one, err };
  }
  const speculative = (b: AlRunnerV3Backend) =>
    (b as unknown as { speculative: unknown }).speculative;
  // Both separator forms: on Windows the message holds forward slashes, the root backslashes.
  const fwd = (s: string) => s.replaceAll("\\", "/");
  const shape = (e: unknown, root: string) =>
    e instanceof Error
      ? [e.constructor.name, fwd(e.message).split(fwd(root)).join("<root>")]
      : [String(e)];
  /** A write alc made, with an mtime clearly after the staging (coarse clocks would hide it). */
  const alcWrite = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    const later = new Date(Date.now() + 60_000);
    await utimes(path, later, later);
  };

  test("alc passes: the baseline is served from the calls deploy() made, equal to the sequential baseline", async () => {
    const spec = await deployWith(undefined, true);
    const seq = await deployWith(undefined, false);
    expect([spec.err, seq.err]).toEqual([undefined, undefined]);
    // The speculative calls ran inside deploy(): one per suite codeunit; the sequential deploy made none.
    expect(spec.one.calls).toHaveLength(1);
    expect(seq.one.calls).toHaveLength(0);
    const a = await baseline(spec.b, SUITE1);
    const s = await baseline(seq.b, SUITE1);
    // Served, not re-run: no new one-shot call in the baseline; the sequential one made its call there.
    expect(spec.one.calls).toHaveLength(1);
    expect(seq.one.calls).toHaveLength(1);
    // R963: `callId` is a fresh identity per call, so it differs between two runs by design.
    const plain = (vs: TestVerdict[]) =>
      vs.map((v) => ({ ...v, durationMs: 0, callId: undefined }));
    expect(plain(a)).toEqual(plain(s));
  });

  /** Runs `fn` with LETHAL_V3_SPECULATE_BASELINE set to `v` (unset when undefined), then restores it. */
  async function withEnv<T>(v: string | undefined, fn: () => Promise<T>): Promise<T> {
    const was = process.env[SPECULATE_BASELINE_ENV];
    if (v === undefined) delete process.env[SPECULATE_BASELINE_ENV];
    else process.env[SPECULATE_BASELINE_ENV] = v;
    try {
      return await fn();
    } finally {
      if (was === undefined) delete process.env[SPECULATE_BASELINE_ENV];
      else process.env[SPECULATE_BASELINE_ENV] = was;
    }
  }

  test("R798 default: option and env unset (or empty) make no speculative call in deploy()", async () => {
    for (const v of [undefined, ""]) {
      const r = await withEnv(v, () => deployWith(undefined, undefined));
      expect(r.err).toBeUndefined();
      expect(r.one.calls).toHaveLength(0);
      expect(speculative(r.b)).toBeUndefined();
    }
  });

  test("R798 opt-in by env: LETHAL_V3_SPECULATE_BASELINE=1 speculates", async () => {
    const r = await withEnv("1", () => deployWith(undefined, undefined));
    expect(r.err).toBeUndefined();
    expect(r.one.calls).toHaveLength(1);
  });

  test("R798: the option beats the env in both directions", async () => {
    const off = await withEnv("1", () => deployWith(undefined, false));
    expect(off.one.calls).toHaveLength(0);
    const on = await withEnv(undefined, () => deployWith(undefined, true));
    expect(on.one.calls).toHaveLength(1);
  });

  test("R798: the env is read at construction, not at deploy(): setting it after construction does not speculate", async () => {
    const r = await withEnv(undefined, () =>
      deployWith(undefined, undefined, {
        // Runs after construction, before deploy().
        seams: () => {
          process.env[SPECULATE_BASELINE_ENV] = "1";
          return {};
        },
      }),
    );
    expect(r.err).toBeUndefined();
    expect(r.one.calls).toHaveLength(0);
  });

  test("R798: any other env value throws by name at construction", async () => {
    for (const v of ["0", "true", "yes"]) {
      await expect(withEnv(v, () => deployWith(undefined, undefined))).rejects.toThrow(
        "al-runner-v3-speculate-baseline-refused",
      );
    }
  });

  test("served once: a second baseline runs live", async () => {
    const r = await deployWith(undefined, true);
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(1);
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  test("alc rejects: deploy() throws today's AlcCompileError, with the batch's own path, and nothing is kept", async () => {
    const spec = await deployWith(batchAlc("reject"), true);
    const seq = await deployWith(batchAlc("reject"), false);
    expect(spec.err).toBeInstanceOf(AlcCompileError);
    expect(shape(spec.err, spec.l.root)).toEqual(shape(seq.err, seq.l.root));
    expect((spec.err as Error).message).not.toContain("alc-src");
    expect(speculative(spec.b)).toBeUndefined();
    // Nothing can reach a baseline or a store: there is no deployed batch.
    await expect(spec.b.activate(null)).rejects.toThrow("before a successful deploy");
  });

  test("alc cannot start: ArtifactPrepareError aborts as today, and nothing is kept", async () => {
    const spec = await deployWith(batchAlc("spawn"), true);
    const seq = await deployWith(batchAlc("spawn"), false);
    expect(spec.err).toBeInstanceOf(ArtifactPrepareError);
    expect(spec.err).not.toBeInstanceOf(AlcCompileError);
    expect(shape(spec.err, spec.l.root)).toEqual(shape(seq.err, seq.l.root));
    expect(speculative(spec.b)).toBeUndefined();
  });

  test("R958: a spent stop starts no speculative call; unspent, the call runs", async () => {
    for (const spent of [true, false]) {
      const l = await layout(TARGET_AL, SUITE1);
      const one = fakeOneShot(allPass);
      const b = new AlRunnerV3Backend(
        {
          alRunnerPath: "/fake/al-runner",
          environmentChoice: { value: "saas", source: "config" },
          instrumentedDir: l.scratch,
          testDir: l.testDir,
          packagesDir: l.deps,
          bcVersion: "28.0.46665.47126",
          selectorObjectId: SELECTOR_ID,
          alcPath: "/fake/alc",
          coverage: "none",
          transport: "serve-entries",
          speculateBaseline: true,
        },
        one.spawn,
        fakeAlc(),
        fakeServe().spawn,
      );
      b.useBuildSymbols([]);
      b.useDiscoveredTests(SUITE1);
      b.useSessionTests(SUITE1);
      b.useMutantBudgetFloor(1000, 1000);
      b.useStopHandle({ spent: () => spent, signalled: () => false, stopForMemory: () => {} });
      await b.deploy(l.batch);
      expect(one.calls).toHaveLength(spent ? 0 : 1);
    }
  });

  test("a byte that changes while the calls run: never served, the baseline runs live", async () => {
    const l = await layout(TARGET_AL, SUITE1);
    const one = fakeOneShot(allPass);
    const b = new AlRunnerV3Backend(
      {
        alRunnerPath: "/fake/al-runner",
        environmentChoice: { value: "saas", source: "config" },
        instrumentedDir: l.scratch,
        testDir: l.testDir,
        packagesDir: l.deps,
        bcVersion: "28.0.46665.47126",
        selectorObjectId: SELECTOR_ID,
        alcPath: "/fake/alc",
        coverage: "none",
        transport: "serve-entries",
        speculateBaseline: true, // R798: opt-in
      },
      one.spawn,
      fakeAlc(),
      fakeServe().spawn,
    );
    b.useBuildSymbols([]);
    b.useDiscoveredTests(SUITE1);
    b.useSessionTests(SUITE1);
    b.useMutantBudgetFloor(1000, 1000);
    // The test dir changes after the speculative calls read it (and before the proof reads it).
    b.seams.afterSpeculation = async () => {
      await writeFile(join(l.testDir, "Late.Codeunit.al"), 'codeunit 79999 "Late" { }');
    };
    await b.deploy(l.batch);
    expect(one.calls).toHaveLength(1);
    expect(speculative(b)).toBeUndefined();
    await baseline(b, SUITE1);
    expect(one.calls).toHaveLength(2);
  });

  // Review 1: a NON-.al file the proof records (the test-app compile's Translations/*.g.xlf), written
  // after the calls joined: before and after agree, only the proof differs. Red if the key drops the
  // other files (a Map serialises as "{}").
  test("an .xlf the test-app compile writes into the test dir: never served", async () => {
    const r = await deployWith(
      writingAlc(async (project, isBatch) => {
        if (isBatch) return;
        await mkdir(join(project, "Translations"), { recursive: true });
        await writeFile(join(project, "Translations", "Tests.g.xlf"), "<xliff/>");
      }),
      true,
    );
    expect(r.err).toBeUndefined();
    expect(speculative(r.b)).toBeUndefined();
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  // The "after" check alone: a change while the calls ran, undone before the proof read.
  test("a byte that changes during the calls and changes back before the proof: never served", async () => {
    const late = (l: Layout) => join(l.testDir, "Late.Codeunit.al");
    let at = "";
    const r = await deployWith(
      writingAlc(async (_p, isBatch) => {
        if (!isBatch && at !== "") await rm(at, { force: true });
      }),
      true,
      {
        seams: (l) => ({
          afterSpeculation: async () => {
            at = late(l);
            await writeFile(at, 'codeunit 79999 "Late" { }');
          },
        }),
      },
    );
    expect(r.err).toBeUndefined();
    expect(speculative(r.b)).toBeUndefined();
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  // Review 2: a call that ran out of time beside alc may not be what a live call answers.
  test("a speculative call with a timeout row is not kept: that baseline call runs live", async () => {
    const timesOutA: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "A" ? { ...x, status: "error" as const, message: TIMEOUT_1S } : x,
      );
    const r = await deployWith(undefined, true, { rows: timesOutA });
    expect(r.one.calls).toHaveLength(1);
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  // Review r2 #1: a served duration must not be able to move a mutant budget (max(2 x d, floor)).
  test("a call whose duration the floor would not cover is not kept: that baseline call runs live", async () => {
    // A 0 ms floor: twice any wall time (the fake's can be 0 ms) reaches it, so the duration would
    // decide the budget.
    const r = await deployWith(undefined, true, { floor: [0, 1000] });
    expect(r.one.calls).toHaveLength(1);
    expect(speculative(r.b)).not.toBeUndefined(); // bound, but the call itself was not kept
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  test("a baseline call at another stop than the speculative one: not served", async () => {
    // The floor's baseline timeout (5 s) is not the baseline's run budget (OPTS: 1 s).
    const r = await deployWith(undefined, true, { floor: [1000, 5000] });
    expect(r.one.calls).toHaveLength(1);
    await baseline(r.b, SUITE1);
    expect(r.one.calls).toHaveLength(2);
  });

  // Review 4: what alc writes into its project still reaches the batch v3 reads, as before R790.
  test("a file alc writes into the copy it compiles is copied into the batch", async () => {
    const r = await deployWith(
      writingAlc(async (project, isBatch) => {
        if (!isBatch) return;
        await alcWrite(join(project, "Translations", "T.g.xlf"), "<xliff/>");
      }),
      true,
    );
    expect(r.err).toBeUndefined();
    const active = (r.b as unknown as { lane: { activeDir(): string } }).lane.activeDir();
    expect(await readFile(join(active, "Translations", "T.g.xlf"), "utf8")).toBe("<xliff/>");
    // The calls read the batch without it, so they are not served.
    expect(speculative(r.b)).toBeUndefined();
  });

  // Option 4 (ruling): alc's writes are cached by the batch's .al hash and app.json, and placed into
  // the next identical batch before the calls; alc's real output is the judge.
  describe("option 4: alc's writes from an identical batch, placed before the calls", () => {
    const xlfAlc = (content: () => string | undefined) =>
      writingAlc(async (project, isBatch) => {
        const c = content();
        if (!isBatch || c === undefined) return;
        await alcWrite(join(project, "Translations", "T.g.xlf"), c);
      });
    const activeOf = (b: AlRunnerV3Backend) =>
      (b as unknown as { lane: { activeDir(): string } }).lane.activeDir();
    const cacheDir = async () => {
      const d = await mkdtemp(join(tmpdir(), "lethal-r790-cache-"));
      roots.push(d);
      return d;
    };

    test("a cached .xlf equal to alc's output: the warm run is served", async () => {
      const cache = await cacheDir();
      const cold = await deployWith(
        xlfAlc(() => "<xliff a/>"),
        true,
        { cacheDir: cache },
      );
      expect(speculative(cold.b)).toBeUndefined(); // cold: nothing cached yet
      const warm = await deployWith(
        xlfAlc(() => "<xliff a/>"),
        true,
        { cacheDir: cache },
      );
      expect(warm.err).toBeUndefined();
      expect(speculative(warm.b)).not.toBeUndefined();
      await baseline(warm.b, SUITE1);
      expect(warm.one.calls).toHaveLength(1); // served: no live call in the baseline
      expect(await readFile(join(activeOf(warm.b), "Translations", "T.g.xlf"), "utf8")).toBe(
        "<xliff a/>",
      );
    });

    test("a cached .xlf that differs from alc's output: not served, and the batch holds alc's bytes", async () => {
      const cache = await cacheDir();
      await deployWith(
        xlfAlc(() => "<xliff a/>"),
        true,
        { cacheDir: cache },
      );
      const warm = await deployWith(
        xlfAlc(() => "<xliff b/>"),
        true,
        { cacheDir: cache },
      );
      expect(speculative(warm.b)).toBeUndefined();
      expect(await readFile(join(activeOf(warm.b), "Translations", "T.g.xlf"), "utf8")).toBe(
        "<xliff b/>",
      );
      await baseline(warm.b, SUITE1);
      expect(warm.one.calls).toHaveLength(2);
    });

    test("a cached file alc does not write this time: removed from the batch, not served", async () => {
      const cache = await cacheDir();
      await deployWith(
        xlfAlc(() => "<xliff a/>"),
        true,
        { cacheDir: cache },
      );
      const warm = await deployWith(
        xlfAlc(() => undefined),
        true,
        { cacheDir: cache },
      );
      expect(speculative(warm.b)).toBeUndefined();
      expect(existsSync(join(activeOf(warm.b), "Translations", "T.g.xlf"))).toBe(false);
    });
  });
});

describe("R907: --no-client", () => {
  test("R907: serve never passes --skip-after-timeout, even when the help listed it", async () => {
    const r = await readyRig({ serve: { rows: killsM1 } });
    (r.b as unknown as { skipAfterTimeoutLearned: boolean }).skipAfterTimeoutLearned = true;
    expect(r.b.skipAfterTimeout).toBe(false);
  });

  test("R919: on serve with the flag learned, the build tag still says supported", async () => {
    const r = await readyRig({ serve: { rows: killsM1 } });
    expect(r.b.skipAfterTimeoutSupported).toBe(false);
    (r.b as unknown as { skipAfterTimeoutLearned: boolean }).skipAfterTimeoutLearned = true;
    expect(r.b.skipAfterTimeout).toBe(false);
    expect(r.b.skipAfterTimeoutSupported).toBe(true);
  });

  test("on: every runTests request carries noClient: true", async () => {
    const r = await readyRig({ serve: { rows: killsM1 }, extra: { noClient: true } });
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    expect(r.serve.requests.length).toBeGreaterThan(0);
    for (const q of r.serve.requests) expect(q.body.noClient).toBe(true);
    expect(r.b.noClient).toBe(true);
  });

  test("off: no request carries the key, so today's requests are unchanged", async () => {
    const r = await readyRig({ serve: { rows: killsM1 } });
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    expect(r.serve.requests.length).toBeGreaterThan(0);
    for (const q of r.serve.requests) expect(q.body).not.toHaveProperty("noClient");
  });

  test("a serve row's flagged: true reaches a pass verdict; an unflagged pass has no flagged key", async () => {
    const flaggedA: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((row) => (row.method === "A" ? { ...row, flagged: true } : row));
    const r = await readyRig({ serve: { rows: flaggedA }, extra: { noClient: true } });
    await r.b.activate("M0002");
    const a = await r.b.run(ref("A"), OPTS);
    const b = await r.b.run(ref("B"), OPTS);
    expect(a.outcome).toBe("pass");
    expect(a.flagged).toBe(true);
    expect(b.outcome).toBe("pass");
    expect(b).not.toHaveProperty("flagged");
  });

  // R-911: under --no-client al-runner refuses a surface it cannot answer with a not-run row; that
  // must stay a refusal and never score as a kill.
  test("on: a refused not-run row is error runner-refused, never a fail", async () => {
    const REFUSED =
      "NotRun: out-of-scope: a page runs in a session without a client (--no-client): not pinned";
    const refusedA: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((row) =>
        m === "M0001" && row.method === "A"
          ? { ...row, status: "error" as const, notRun: true, message: REFUSED }
          : row,
      );
    const r = await readyRig({ serve: { rows: refusedA }, extra: { noClient: true } });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(v.outcome).toBe("error");
    expect(v.runnerRow).toBe("runner-refused");
  });
});

describe("R857: --isolate-tests", () => {
  const ISOLATE = { extra: { isolateTests: true } };
  type Sent = { id: string; test: string; excludeTests?: string[] };
  const entriesOf = (r: Rig): Sent[] =>
    r.serve.requests.flatMap((q) => (q.body.entries as Sent[] | undefined) ?? []);
  const argvHas = (r: Rig, flag: string) => r.one.calls.filter((c) => c.includes(flag)).length;

  test("off, a run is what it always was: no field, no flag, whole codeunits", async () => {
    const r = await readyRig({ serve: { rows: killsM1 } });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.length).toBeGreaterThan(0);
    for (const q of r.serve.requests) {
      expect(q.body).not.toHaveProperty("runSelectedOnly");
      expect(Object.keys(q.body).sort()).toEqual([
        "command",
        "entries",
        "sourcePaths",
        "testIsolation",
      ]);
    }
    for (const e of entriesOf(r)) {
      expect(e.test).toMatch(/^Codeunit\d+\.$/);
      expect(Object.keys(e).sort()).toEqual(["id", "resources", "test"]);
    }
    expect(entriesOf(r).map((e) => e.id)).toContain(`M0001|${CU}`);
    expect(argvHas(r, "--run-selected-only")).toBe(0);
    expect(argvHas(r, "--test-exact")).toBe(0);
    expect(argvHas(r, "--codeunit")).toBe(r.one.calls.length);
    expect(r.b.isolatesTests).toBe(false);
  });

  test("on: the baseline is one process per test, and every later entry one test", async () => {
    const r = await readyRig({ ...ISOLATE, serve: { rows: killsM1 } });
    // Sorted: since R866 the processes run side by side, so they may start in any order.
    expect(r.one.calls.map((c) => c[c.indexOf("--test-exact") + 1]).sort()).toEqual([
      `Codeunit${CU}.A`,
      `Codeunit${CU}.B`,
    ]);
    expect(argvHas(r, "--run-selected-only")).toBe(2);
    expect(argvHas(r, "--codeunit")).toBe(0);
    for (const q of r.serve.requests) expect(q.body.runSelectedOnly).toBe(true);
    // In source order, in the warm-up as in every group.
    expect((r.serve.requests[0]?.body.entries as Sent[]).map((e) => e.test)).toEqual([
      `Codeunit${ECHO}.`,
      `Codeunit${CU}.A`,
      `Codeunit${CU}.B`,
    ]);
    const tests = new Set(entriesOf(r).map((e) => e.test));
    expect([...tests].sort()).toEqual([`Codeunit${CU}.A`, `Codeunit${CU}.B`, `Codeunit${ECHO}.`]);
    expect(r.b.isolatesTests).toBe(true);
  });

  test("on: each verdict is read from its own test's entry", async () => {
    const r = await readyRig({ ...ISOLATE, serve: { rows: killsM1 } });
    const before = r.serve.requests.length;
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    await r.b.activate("M0002");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    expect(r.serve.requests.length).toBe(before); // all of it came from the prefetch
  });

  test("on: a confirm and a reproduction are that test alone, as one kill pair", async () => {
    const r = await readyRig({ ...ISOLATE, serve: { rows: killsM1 } });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    const before = r.serve.requests.length;
    await r.b.sendKillPair("M0001", ref("A"));
    const pair = (r.serve.requests[before]?.body.entries as Sent[]).map((e) => e.test);
    expect(pair).toEqual([
      `Codeunit${ECHO}.`,
      `Codeunit${CU}.A`,
      `Codeunit${ECHO}.`,
      `Codeunit${CU}.A`,
    ]);
    await r.b.activate(null);
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.length).toBe(before + 1);
  });

  test("on: a test whose name starts another's excludes it, so each entry runs one test", async () => {
    const suite = [ref("Alpha"), ref("AlphaTwo")];
    const rows: RowsFn = () => suite.map((t) => ({ method: t.method, status: "pass" as const }));
    const r = await readyRig({ ...ISOLATE, suite, serve: { rows } });
    const of = (m: string) => entriesOf(r).find((e) => e.test === `Codeunit${CU}.${m}`);
    expect(of("Alpha")?.excludeTests).toEqual([`Codeunit${CU}.AlphaTwo`]);
    expect(of("AlphaTwo")).not.toHaveProperty("excludeTests");
    await r.b.activate("M0001");
    expect((await r.b.run(suite[0] ?? ref("?"), OPTS)).outcome).toBe("pass");
    expect((await r.b.run(suite[1] ?? ref("?"), OPTS)).outcome).toBe("pass");
  });

  test("on: a second row in an entry is no verdict: the test did not run alone", async () => {
    const rows: RowsFn = (m, cu, d, n) => [
      ...allPass(m, cu, d, n),
      ...(m === "M0001" ? [{ method: "AHidden", status: "pass" as const }] : []),
    ];
    const r = await readyRig({ ...ISOLATE, serve: { rows } });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("has 2 rows, so that test did not run alone");
    // The other way: an entry with its one row is read as usual.
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
  });

  test("on: a cut at one test re-sends only the tests after it, on a fresh daemon", async () => {
    const stop = { method: "A", status: "error" as const, notRun: true, message: TIMEOUT_1S };
    const rows: RowsFn = (m, cu, d, n) =>
      m === "M0001" && d === 0
        ? allPass(m, cu, d, n).map((x) => (x.method === "A" ? stop : x))
        : allPass(m, cu, d, n);
    const r = await readyRig({ ...ISOLATE, serve: { rows }, mutants: ["M0001"] });
    expect(r.serve.daemons).toHaveLength(2);
    const onSecond = r.serve.requests.filter((q) => q.daemon === 1).flatMap((q) => q.ids);
    const after = onSecond.filter((id) => id.startsWith("M0001|") && !id.endsWith("|echo"));
    expect(after).toHaveLength(1);
    const sent = entriesOf(r).filter((e) => e.id === after[0]);
    expect(sent.map((e) => e.test)).toContain(`Codeunit${CU}.B`);
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("timeout");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
  });

  test("on: the warm-up compares test by test with the lone baseline", async () => {
    const serveRows: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) => (x.method === "B" ? { ...x, status: "fail" as const } : x));
    await expect(
      readyRig({ ...ISOLATE, serve: { rows: serveRows }, oneShotRows: allPass }),
    ).rejects.toThrow(
      // Exactly B's own rows on both sides, and A's entry agrees: a wrong key reads an empty side.
      `al-runner-v3-entries-warmup-disagrees: the daemon's NONE rows are not this batch's one-shot baseline (codeunit ${CU}: serve [b=fail], one-shot [b=pass])`,
    );
  });

  test("on: a refusal at baseline still names the real codeunit in a survivor's note", async () => {
    const refused: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "A" ? { ...x, status: "error" as const, notRun: true, message: COMMIT } : x,
      );
    const r = await rig({ ...ISOLATE, oneShotRows: refused });
    await baseline(r.b, SUITE1);
    expect(r.b.survivorNote([ref("B")])).toContain(`Tests${CU}.A`);
  });

  test("on: every failing test has a stored pair, so a kill by any of them sends nothing", async () => {
    const fails: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "M0001" ? { ...x, status: "fail" as const, message: "boom" } : x,
      );
    const r = await readyRig({ ...ISOLATE, pairBatch: true, serve: { rows: fails } });
    const before = r.serve.requests.length;
    await r.b.activate("M0001");
    // The second failing test, as the kill ledger can put it first.
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
    await r.b.sendKillPair("M0001", ref("B"));
    await r.b.activate(null);
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    await r.b.activate("M0001");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.length).toBe(before);
  });

  test("on: a refusal names the real codeunit and test, never a call id", async () => {
    const noRow: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).filter((x) => !(m === "M0001" && x.method === "B"));
    const r = await readyRig({ ...ISOLATE, serve: { rows: noRow } });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("B"), OPTS);
    expect(v.failureMessage).toContain(`codeunit ${CU}'s entry has 0 row(s)`);
    const cold = await rig(ISOLATE); // a prefetch with no baseline behind it
    await expect(cold.b.prefetchMutants(plans(["M0001"]))).rejects.toThrow(
      `codeunit(s) Codeunit${CU}.A, Codeunit${CU}.B of the warm-up union`,
    );
  });

  test("on: a live request runs one test too", async () => {
    const r = await rig({ ...ISOLATE, serve: { rows: killsM1 } });
    await baseline(r.b, SUITE1);
    await r.b.activate("M0001"); // no prefetch, so the run below goes live
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    const tests = entriesOf(r).map((e) => e.test);
    expect(tests).toContain(`Codeunit${CU}.B`);
    expect(tests).not.toContain(`Codeunit${CU}.`);
  });

  test("on: a coverage window asks for that one test, and the longer names stay out", async () => {
    const suite = [ref("A"), ref("AB")];
    const rows: RowsFn = () => suite.map((t) => ({ method: t.method, status: "pass" as const }));
    const r = await readyRig({
      ...ISOLATE,
      suite,
      targetAl: SLEEPER_AL,
      mutants: ["M0001"],
      serve: { rows, coverage: sleepCoverage() },
    });
    const n0 = r.serve.requests.length;
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    const window = r.serve.requests.slice(n0).find((q) => q.body.coverage === true);
    expect(window?.ids).toEqual([`plain:Codeunit${CU}.A`]);
    expect(window?.body.excludeTests).toEqual([`Codeunit${CU}.AB`]);
    expect(window?.body.runSelectedOnly).toBe(true);
  });

  describe("R866: the baseline's processes, four at a time", () => {
    const methods = ["A", "B", "C", "D", "E", "F"];
    const suite = methods.map((m) => ref(m));
    const rows: RowsFn = () => methods.map((method) => ({ method, status: "pass" as const }));
    const opts = { ...ISOLATE, suite, oneShotRows: rows };
    const exactOf = (r: Rig) => r.one.calls.map((c) => c[c.indexOf("--test-exact") + 1]);

    test("every test once, at most four at a time, each verdict its own", async () => {
      const r = await rig(opts);
      const verdicts = await baseline(r.b, suite);
      expect(r.one.peak()).toBe(ISOLATED_BASELINE_PROCESSES);
      expect(ISOLATED_BASELINE_PROCESSES).toBe(4);
      expect(exactOf(r).sort()).toEqual(methods.map((m) => `Codeunit${CU}.${m}`));
      expect(verdicts.map((v) => [v.ref.method, v.outcome])).toEqual(
        methods.map((m) => [m, "pass"]),
      );
    });

    test("--workers sets how many at a time: one, or more than four", async () => {
      for (const n of [1, 6]) {
        const extra = { isolateTests: true, isolatedBaselineProcesses: n };
        const r = await rig({ extra, suite, oneShotRows: rows });
        await baseline(r.b, suite);
        expect(r.one.peak()).toBe(n);
        expect(r.one.calls).toHaveLength(methods.length);
      }
    });

    // R958: a stop (budget, signal or memory all read as spent()) starts no further process.
    const fill = async (stopAfter: number, processes: number) => {
      const box: { r?: Rig } = {};
      const r = await rig({
        ...opts,
        extra: { isolateTests: true, isolatedBaselineProcesses: processes },
        stopHandle: {
          spent: () => (box.r?.one.calls.length ?? 0) >= stopAfter,
          signalled: () => false,
          stopForMemory: () => {},
        },
      });
      box.r = r;
      r.b.baselinePhase(true);
      await r.b.activate(null);
      await r.b.run(ref("A"), OPTS); // takes the fill
      r.b.baselinePhase(false);
      return r;
    };

    test("R958: stopped after two, one worker starts no third process", async () => {
      const r = await fill(2, 1);
      expect(r.one.calls).toHaveLength(2);
    });

    test("R958: stopped after four, four workers start no fifth process", async () => {
      const r = await fill(4, 4);
      expect(r.one.calls).toHaveLength(4);
    });

    test("R958: never stopped, every test runs", async () => {
      const r = await fill(Number.POSITIVE_INFINITY, 4);
      expect(r.one.calls).toHaveLength(methods.length);
    });

    test("off, the baseline stays one process at a time", async () => {
      const r = await rig({ suite, oneShotRows: rows });
      await baseline(r.b, suite);
      expect(r.one.peak()).toBe(1);
    });

    test("a test that stopped beside the others runs again alone, and that answer stands", async () => {
      // One test, as the fake builds every row for each process: `first` must be A's own.
      let first = true;
      const stopOnce: RowsFn = () => {
        const stopped = first;
        first = false;
        return stopped
          ? [{ method: "A", status: "error", notRun: true, message: TIMEOUT_1S }]
          : [{ method: "A", status: "pass" }];
      };
      const r = await rig({ ...ISOLATE, suite: [ref("A")], oneShotRows: stopOnce });
      const verdicts = await baseline(r.b, [ref("A")]);
      expect(r.one.calls).toHaveLength(2);
      expect(verdicts.map((v) => v.outcome)).toEqual(["pass"]);
    });

    test("a duration that could move a budget is not kept: every test runs again alone", async () => {
      const r = await rig({ ...ISOLATE, floor: [0, 1000] });
      await baseline(r.b, SUITE1);
      expect(r.one.calls).toHaveLength(4);
    });

    test("a new deploy fills again, four at a time", async () => {
      const r = await rig(opts);
      await baseline(r.b, suite);
      r.one.clearPeak();
      await r.b.deploy(r.l.batch);
      await baseline(r.b, suite);
      expect(r.one.peak()).toBe(ISOLATED_BASELINE_PROCESSES);
      expect(r.one.calls).toHaveLength(12);
    });

    test("an answer no call took does not cross a deploy", async () => {
      let batch2 = false;
      // In the second batch B's row is one the fill never keeps, so only a stale answer reads pass.
      const byBatch: RowsFn = (m, cu, d, n) =>
        allPass(m, cu, d, n).map((x) =>
          x.method === "B" && batch2
            ? { ...x, status: "error" as const, notRun: true, message: COMMIT }
            : x,
        );
      const r = await rig({ ...ISOLATE, oneShotRows: byBatch });
      await baseline(r.b, [ref("A")]); // the fill also holds B's answer, which nothing takes
      batch2 = true;
      await r.b.deploy(r.l.batch);
      const [b] = await baseline(r.b, [ref("B")]);
      expect(b?.outcome).not.toBe("pass");
    });

    test("an answer is served once: a second call for that test runs its own process", async () => {
      const r = await rig(ISOLATE);
      r.b.baselinePhase(true);
      await r.b.activate(null);
      await r.b.run(ref("A"), OPTS);
      await r.b.activate(null); // drops the rows, so the next run asks for a call again
      await r.b.run(ref("A"), OPTS);
      r.b.baselinePhase(false);
      expect(exactOf(r).filter((t) => t === `Codeunit${CU}.A`)).toHaveLength(2);
    });

    test("an answer made at another stop is not served", async () => {
      const r = await rig(ISOLATE);
      r.b.baselinePhase(true);
      await r.b.activate(null);
      await r.b.run(ref("A"), OPTS);
      await r.b.run(ref("B"), { ...OPTS, timeoutMs: 5000 });
      r.b.baselinePhase(false);
      expect(exactOf(r).filter((t) => t === `Codeunit${CU}.B`)).toHaveLength(2);
    });

    test("each test keeps its own coverage", async () => {
      const own: CoverageFn = (_m, cu, _a, _t, method) => ({
        coverage: [],
        perTestCoverage: [{ test: `Codeunit${cu}.${method}`, coverage: [] }],
      });
      const r = await rig({ ...opts, oneShotCoverage: own });
      await baseline(r.b, suite);
      const seen = [
        ...(
          r.b as unknown as { lane: { rowsByCodeunit: Map<number, unknown> } }
        ).lane.rowsByCodeunit.values(),
      ] as { rows: { name: string }[]; coverage: { perTestCoverage?: { test: string }[] } }[];
      expect(seen).toHaveLength(methods.length);
      for (const c of seen) {
        expect(c.rows.map((x) => x.name)).toEqual(
          (c.coverage.perTestCoverage ?? []).map((e) => e.test),
        );
      }
    });

    test("a row that did not run is not trusted beside the others: alone, the test runs", async () => {
      let first = true;
      const raced: RowsFn = () => {
        const refused = first;
        first = false;
        return refused
          ? [{ method: "A", status: "error", notRun: true, message: COMMIT }]
          : [{ method: "A", status: "pass" }];
      };
      const r = await rig({ ...ISOLATE, suite: [ref("A")], oneShotRows: raced });
      const verdicts = await baseline(r.b, [ref("A")]);
      expect(r.one.calls).toHaveLength(2);
      expect(verdicts.map((v) => v.outcome)).toEqual(["pass"]);
      expect(r.b.survivorNote([ref("A")])).toBeUndefined();
    });

    test("exit 8 is not kept: each test runs alone", async () => {
      const r = await rig({ ...ISOLATE, oneShotAnswer: { exitCode: 8, stderr: "" } });
      await baseline(r.b, SUITE1);
      expect(r.one.calls).toHaveLength(4);
    });

    test("an answer with no row, or another test's, is not kept", async () => {
      const r = await rig(ISOLATE);
      const stub = r.b as unknown as {
        aloneAnswer: (m: unknown, r: TestMethodRef, f: number) => boolean;
      };
      const answer = (tests: unknown[]) => ({
        res: { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "" },
        wallMs: 1,
        timedOut: false,
        deadlineMs: 1,
      });
      const row = (method: string) => ({
        codeunit: CU,
        method,
        name: `Codeunit${CU}.${method}`,
        status: "pass",
      });
      expect(stub.aloneAnswer(answer([]), ref("A"), 1000)).toBe(false);
      expect(stub.aloneAnswer(answer([row("B")]), ref("A"), 1000)).toBe(false);
      expect(stub.aloneAnswer(answer([row("A"), row("B")]), ref("A"), 1000)).toBe(false);
      expect(stub.aloneAnswer(answer([row("A")]), ref("A"), 1000)).toBe(true);
    });

    test("a failure stops the queue, and no process outlives the call", async () => {
      // One worker fails and three stay well: only an emptied queue stops those three.
      const names = Array.from({ length: 12 }, (_, i) => `T${i}`);
      const many = names.map((m) => ref(m));
      const rowsOfMany: RowsFn = () => names.map((method) => ({ method, status: "pass" as const }));
      const r = await rig({ ...ISOLATE, suite: many, oneShotRows: rowsOfMany });
      const b = r.b as unknown as { aloneAnswer: () => boolean };
      let failed = false;
      b.aloneAnswer = () => {
        if (failed) return true;
        failed = true;
        throw new Error("boom");
      };
      await expect(baseline(r.b, many)).rejects.toThrow("boom");
      expect(r.one.running()).toBe(0);
      expect(r.one.calls.length).toBeLessThan(names.length);
    });

    test("no process starts on bytes the proof does not cover", async () => {
      const r = await rig(ISOLATE);
      await appendFile(join(r.l.scratch, "active", "Logic.Codeunit.al"), "// drift\n");
      await expect(baseline(r.b, SUITE1)).rejects.toThrow(AlRunnerV3UnprovenBatchError);
      expect(r.one.calls).toHaveLength(0);
    });

    test("the bytes are checked again when an answer is served", async () => {
      const r = await rig(ISOLATE);
      r.b.baselinePhase(true);
      await r.b.activate(null);
      await r.b.run(ref("A"), OPTS); // fills, and serves A
      await appendFile(join(r.l.scratch, "active", "Logic.Codeunit.al"), "// drift\n");
      await expect(r.b.run(ref("B"), OPTS)).rejects.toThrow(AlRunnerV3UnprovenBatchError);
      r.b.baselinePhase(false);
    });
  });

  test("on: the speculative baseline stays off, as its calls run whole codeunits", async () => {
    const r = await rig({ extra: { isolateTests: true, speculateBaseline: true } });
    await baseline(r.b, SUITE1);
    expect(argvHas(r, "--codeunit")).toBe(0);
    expect(r.one.calls).toHaveLength(2);
  });
});

// R895: a request is cut at the first streamed timeout row; the daemon is killed.
describe("R895: stop a request at its first timeout row", () => {
  /** A scripted daemon: every request answers `lines`; counts kills and shutdowns. */
  function scripted(lines: readonly unknown[]) {
    const out = new Chan();
    const err = new Chan();
    const seen = { kills: 0, shutdowns: 0 };
    out.push(JSON.stringify({ ready: true }));
    const spawn: ServerSpawnFn = () => ({
      stdout: out,
      stderr: err,
      kill: () => {
        seen.kills += 1;
        out.end();
      },
      write: (line) => {
        if ((JSON.parse(line) as { command?: string }).command === "shutdown") {
          seen.shutdowns += 1;
          out.push("{}");
          return;
        }
        for (const l of lines) out.push(JSON.stringify(l));
      },
    });
    return { spawn, seen };
  }
  const test_ = (entry: string, method: string, extra: Record<string, unknown> = {}) => ({
    type: "test",
    entry,
    name: `Codeunit${CU}.${method}`,
    status: "pass",
    ...extra,
  });
  const stop = { status: "error", notRun: true, message: TIMEOUT_1S };
  const tail = [
    { type: "entrySummary", entry: "e1" },
    { type: "summary", exitCode: 0 },
  ];
  async function ask(lines: readonly unknown[], stopAtTimeout?: boolean) {
    const s = scripted(lines);
    const server = new AlRunnerServer("/fake", s.spawn, [], "serve");
    server.enforceRunSeed = false;
    await server.start(5000);
    const answer = await server.runEntries({ entries: [] }, 5000, stopAtTimeout);
    return { answer, seen: s.seen, server };
  }

  test("opt-in: a timeout row ends the read; partial answer with the marker; the daemon is killed once, never shut down", async () => {
    const { answer, seen, server } = await ask(
      [test_("e1", "A"), test_("e1", "B", stop), test_("e1", "C", stop), ...tail],
      true,
    );
    expect(answer.tests.map((t) => t.name)).toEqual([`Codeunit${CU}.A`, `Codeunit${CU}.B`]);
    expect(answer.entrySummaries).toEqual([]);
    expect(answer.cut).toEqual({ entry: "e1", test: `Codeunit${CU}.B` });
    expect(seen).toEqual({ kills: 1, shutdowns: 0 });
    await server.close(); // already gone: nothing more is sent or killed
    expect(seen).toEqual({ kills: 1, shutdowns: 0 });
  });

  test("opt-in: a plain fail row, a fail or error that quotes the timeout text without notRun, and a non-timeout notRun refusal are never cut", async () => {
    const { answer, seen } = await ask(
      [
        test_("e1", "A", { status: "fail", message: "boom" }),
        test_("e1", "B", { status: "fail", message: TIMEOUT_1S }),
        test_("e1", "C", { status: "error", notRun: true, message: COMMIT }),
        // The exact timeout text on an error row that v3 did NOT mark notRun: not a stop.
        test_("e1", "D", { status: "error", message: TIMEOUT_1S }),
        ...tail,
      ],
      true,
    );
    expect(answer.tests).toHaveLength(4);
    expect(answer.cut).toBeUndefined();
    expect(answer.entrySummaries).toHaveLength(1);
    expect(seen.kills).toBe(0);
  });

  test("without the opt-in (the warm-up): a timeout row is read to the end, like any row", async () => {
    const { answer, seen } = await ask([test_("e1", "A", stop), test_("e1", "B"), ...tail]);
    expect(answer.tests).toHaveLength(2);
    expect(answer.cut).toBeUndefined();
    expect(answer.summary.type).toBe("summary");
    expect(seen.kills).toBe(0);
  });

  describe("decode", () => {
    const sent = () =>
      encodeGroups(
        [
          { mutantId: "M0001", codeunits: [CU] },
          { mutantId: "M0002", codeunits: [CU] },
        ],
        ECHO,
      );
    const echoRow = (m: string) => ({
      type: "test",
      entry: `${m}|echo`,
      name: `Codeunit${ECHO}.Echo`,
      status: "fail",
      message: `LETHAL-ECHO:${m}:true`,
    });
    const cutAnswer = (tests: Record<string, unknown>[], entry = `M0001|${CU}`) => ({
      tests,
      entrySummaries: [],
      summary: {},
      cut: { entry, test: `Codeunit${CU}.A` },
    });
    const timeoutRow = { ...test_(`M0001|${CU}`, "A", stop) };

    test("a partial answer with the marker decodes: the cut entry keeps its rows, later entries have none", () => {
      const d = decodeEntriesAnswer(sent(), cutAnswer([echoRow("M0001"), timeoutRow]));
      if ("why" in d) throw new Error(d.why);
      expect(d.cut).toEqual({ entry: `M0001|${CU}`, test: `Codeunit${CU}.A` });
      expect(d.rows.get(`M0001|${CU}`)?.map((r) => r.method)).toEqual(["A"]);
      expect(d.rows.get(`M0002|${CU}`)).toEqual([]);
    });

    test("a row for an entry AFTER the cut entry is refused", () => {
      const d = decodeEntriesAnswer(
        sent(),
        cutAnswer([echoRow("M0001"), test_(`M0002|${CU}`, "A"), timeoutRow]),
      );
      expect("why" in d && d.why).toContain("has a row after the cut");
    });

    test("no marker: a short answer without summaries is refused as today", () => {
      const d = decodeEntriesAnswer(sent(), {
        tests: [echoRow("M0001"), timeoutRow],
        entrySummaries: [],
        summary: {},
      });
      expect("why" in d && d.why).toContain("entrySummary ids");
    });

    test("a marker that is not the last test line, or names an unsent entry, is refused", () => {
      const notLast = decodeEntriesAnswer(
        sent(),
        cutAnswer([echoRow("M0001"), timeoutRow, test_(`M0001|${CU}`, "B")]),
      );
      expect("why" in notLast && notLast.why).toContain("not the answer's last test line");
      const unsent = decodeEntriesAnswer(sent(), cutAnswer([timeoutRow], "nope"));
      expect("why" in unsent && unsent.why).toContain("was not sent");
    });
  });

  describe("backend", () => {
    /** M0001's codeunit CU: A hangs (the timeout row), B would be a cascade row. */
    const hangsA: RowsFn = (m, cu, d, n) =>
      m === "M0001" && cu === CU
        ? [
            { method: "A", status: "error", notRun: true, message: TIMEOUT_1S },
            { method: "B", status: "pass" },
          ]
        : allPass(m, cu, d, n);
    const A = ref("A");
    const B = ref("B");
    const C = ref("C", CU2);
    /** A build that retires the §6 Sleep rule: the only kind a request is cut on. */
    const retired = { sleepRuleRetired: true };

    test("where the §6 Sleep rule applies, a timeout row is read to the end: nothing is cut", async () => {
      const r = await readyRig({
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001", "M0002"],
        seams: { sleepRuleRetired: false },
      });
      expect(r.b.entriesStats().timeoutCuts).toBe(0);
      expect(r.serve.closes.filter((c) => c.daemon === 0)).toHaveLength(1);
    });

    test("a timeout row mid-stream: T's row is kept, the later entries are re-sent on a fresh daemon, the old daemon is killed once", async () => {
      const r = await readyRig({
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001", "M0002"],
        seams: retired,
      });
      expect(r.b.entriesStats().timeoutCuts).toBe(1);
      // Daemon 0 held the cut request; daemon 1 got the re-send (its warm-up, then the rest).
      expect(r.serve.daemons).toHaveLength(2);
      expect(r.serve.kills).toEqual([0]);
      expect(r.serve.closes.filter((c) => c.daemon === 0)).toEqual([]);
      const resent = r.serve.requests.filter((q) => q.daemon === 1).at(-1);
      expect(resent?.ids).toEqual([
        "M0001|echo",
        `M0001|${CU2}`,
        "M0002|echo",
        `M0002|${CU}`,
        `M0002|${CU2}`,
      ]);
      await r.b.activate("M0001");
      const a = await r.b.run(A, OPTS);
      expect(a.outcome).toBe("timeout");
      expect((await r.b.run(C, OPTS)).outcome).toBe("pass");
    });

    test("a ref the cut call has no row for runs ALONE: exact selection, runSelectedOnly, the same mutant", async () => {
      const r = await readyRig({
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001"],
        seams: retired,
      });
      await r.b.activate("M0001");
      const n0 = r.serve.requests.length;
      const v = await r.b.run(B, OPTS);
      expect(v.outcome).toBe("pass");
      const sent = r.serve.requests.slice(n0);
      expect(sent).toHaveLength(1);
      const body = sent[0]?.body ?? {};
      expect(body.runSelectedOnly).toBe(true);
      const entries = body.entries as { id: string; test: string; resources: object }[];
      expect(entries.map((e) => e.test)).toEqual([`Codeunit${ECHO}.`, `Codeunit${CU}.B`]);
      expect(
        entries.map((e) => (e.resources as Record<string, string>)["active-mutant.txt"]),
      ).toEqual(["M0001", "M0001"]);
      // Only that request carries runSelectedOnly.
      expect(r.serve.requests.filter((q) => q.body.runSelectedOnly === true)).toHaveLength(1);
    });

    test("R907: noClient on: the alone (runSelectedOnly) request carries noClient: true too", async () => {
      const r = await readyRig({
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001"],
        seams: retired,
        extra: { noClient: true },
      });
      await r.b.activate("M0001");
      const n0 = r.serve.requests.length;
      expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
      const alone = r.serve.requests.slice(n0).filter((q) => q.body.runSelectedOnly === true);
      expect(alone).toHaveLength(1);
      for (const q of r.serve.requests) expect(q.body.noClient).toBe(true);
    });

    test("a timeout in that alone fetch is a timeout verdict", async () => {
      const rows: RowsFn = (m, cu, d, n) =>
        m === "M0001" && cu === CU
          ? [
              { method: "A", status: "error", notRun: true, message: TIMEOUT_1S },
              { method: "B", status: "error", notRun: true, message: TIMEOUT_1S },
            ]
          : allPass(m, cu, d, n);
      const r = await readyRig({
        serve: { rows },
        suite: SUITE2,
        mutants: ["M0001"],
        seams: retired,
      });
      await r.b.activate("M0001");
      const v = await r.b.run(B, OPTS);
      expect(v.outcome).toBe("timeout");
      expect(r.b.entriesStats().timeoutCuts).toBe(2);
    });

    test("a cut with rows only after the cut entry in the answer is a protocol error: the prefetch is dropped", async () => {
      const r = await rig({
        suite: SUITE2,
        seams: retired,
        serve: {
          rows: hangsA,
          // Move the timeout line to the end, so M0002's rows come before the cut.
          answer: (_q, n, lines) =>
            n === 1
              ? {
                  lines: [
                    ...lines.filter((x) => x.type === "test" && x.notRun !== true),
                    ...lines.filter((x) => x.type === "test" && x.notRun === true),
                  ],
                }
              : undefined,
        },
      });
      await baseline(r.b, SUITE2);
      await r.b.prefetchMutants(plans(["M0001", "M0002"], SUITE2));
      expect(r.b.entriesStats().prefetchDropped).toBe(1);
    });

    test("a kill pair whose M entry is cut keeps T's timeout, not an error", async () => {
      const rows: RowsFn = (m, cu, d, n) =>
        m === "M0001" && cu === CU && d === 0 && n === 2
          ? [
              { method: "A", status: "error", notRun: true, message: TIMEOUT_1S },
              { method: "B", status: "pass" },
            ]
          : killsM1(m, cu, d, n);
      const r = await readyRig({
        serve: { rows },
        oneShotRows: allPass,
        mutants: ["M0001"],
        seams: retired,
      });
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      expect((await r.b.run(A, OPTS)).outcome).toBe("pass");
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
      const s = r.b.entriesStats();
      expect([s.timeoutCuts, s.pairFallbacks1]).toEqual([1, 0]);
    });

    test("isolation method: a cut entry is one test and holds its own row, so nothing is fetched alone", async () => {
      const r = await readyRig({
        extra: { isolation: "method" },
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001"],
        seams: retired,
      });
      expect(r.b.entriesStats().timeoutCuts).toBeGreaterThan(0);
      await r.b.activate("M0001");
      const n = r.serve.requests.length;
      expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
      expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
      expect((await r.b.run(C, OPTS)).outcome).toBe("pass");
      // B and C were re-sent after the cut and stood in the prefetch: no alone fetch, no new request.
      expect(r.serve.requests).toHaveLength(n);
    });

    test("R907: noClient on, isolation method: every request on the method daemon carries noClient: true", async () => {
      const r = await readyRig({
        extra: { isolation: "method", noClient: true },
        serve: { rows: hangsA },
        suite: SUITE2,
        mutants: ["M0001"],
        seams: retired,
      });
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
      expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
      expect(r.serve.requests.length).toBeGreaterThan(0);
      for (const q of r.serve.requests) expect(q.body.noClient).toBe(true);
    });

    test("isolation auto, one codeunit switched to method: a cut in the other codeunit fetches alone on that codeunit's own daemon", async () => {
      const r = await rig({
        extra: { isolation: "auto" },
        serve: { rows: hangsA },
        suite: SUITE2,
        seams: retired,
      });
      await baseline(r.b, SUITE2);
      r.b.baselinePhase(true);
      try {
        r.b.chooseIsolation(CU2, "method");
      } finally {
        r.b.baselinePhase(false);
      }
      await baseline(r.b, SUITE2);
      await r.b.prefetchMutants(plans(["M0001"], SUITE2));
      expect(r.b.entriesStats().timeoutCuts).toBe(1);
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
      const n = r.serve.requests.length;
      expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
      // The cut killed the test-mode daemon, so a fresh one starts: its warm-up (test mode, its own
      // union, no runSelectedOnly), then the alone request on that same daemon.
      const [warm, alone] = r.serve.requests.slice(n);
      expect(r.serve.requests.slice(n)).toHaveLength(2);
      expect(warm?.ids[0]).toBe("NONE|echo");
      expect(warm?.body.testIsolation).toBe("test");
      expect(warm?.body.runSelectedOnly).toBeUndefined();
      expect(alone?.daemon).toBe(warm?.daemon ?? -1);
      expect(alone?.body.testIsolation).toBe("test");
      expect(alone?.body.runSelectedOnly).toBe(true);
      expect((alone?.body.entries as { test: string }[]).map((e) => e.test)).toEqual([
        `Codeunit${ECHO}.`,
        `Codeunit${CU}.B`,
      ]);
      // CU2 (method) is unaffected.
      expect((await r.b.run(C, OPTS)).outcome).toBe("pass");
    });
  });
});

describe("R890: alRunnerV3.isolation", () => {
  const isolationOf = (c: readonly string[]) => c[c.indexOf("--isolation") + 1];

  test("default: one-shot passes --isolation test and serve sends testIsolation test", async () => {
    const r = await readyRig({ serve: { rows: killsM1 } });
    expect(r.one.calls.length).toBeGreaterThan(0);
    for (const c of r.one.calls) expect(isolationOf(c)).toBe("test");
    expect(r.serve.requests.length).toBeGreaterThan(0);
    for (const q of r.serve.requests) expect(q.body.testIsolation).toBe("test");
    expect(r.b.isolatesTests).toBe(false);
    expect(r.b.methodIsolation).toBe(false);
  });

  test("method: every test alone under codeunit isolation, one-shot and serve", async () => {
    const r = await readyRig({ extra: { isolation: "method" }, serve: { rows: killsM1 } });
    expect(r.one.calls.length).toBe(2);
    for (const c of r.one.calls) {
      expect(isolationOf(c)).toBe("codeunit");
      expect(c).toContain("--run-selected-only");
      expect(c).toContain("--test-exact");
    }
    expect(r.serve.requests.length).toBeGreaterThan(0);
    for (const q of r.serve.requests) {
      expect(q.body.testIsolation).toBe("codeunit");
      expect(q.body.runSelectedOnly).toBe(true);
    }
    expect(r.b.isolatesTests).toBe(true);
    expect(r.b.methodIsolation).toBe(true);
  });

  test("--isolate-tests alone keeps isolation test", async () => {
    const r = await readyRig({ extra: { isolateTests: true }, serve: { rows: killsM1 } });
    for (const c of r.one.calls) expect(isolationOf(c)).toBe("test");
    for (const q of r.serve.requests) expect(q.body.testIsolation).toBe("test");
    expect(r.b.methodIsolation).toBe(false);
  });
});

describe("R896: isolation auto, per codeunit", () => {
  const isolationOf = (c: readonly string[]) => c[c.indexOf("--isolation") + 1];
  const AUTO = { isolation: "auto" as const };
  /** Inside the bracket, as the orchestrator does it. */
  const choose = (b: AlRunnerV3Backend, cu: number, mode: "test" | "method") => {
    b.baselinePhase(true);
    try {
      b.chooseIsolation(cu, mode);
    } finally {
      b.baselinePhase(false);
    }
  };

  test("--isolate-tests with auto is refused by name; auto alone is not a forced mode", async () => {
    await expect(rig({ extra: { ...AUTO, isolateTests: true } })).rejects.toThrow(
      AlRunnerV3IsolateTestsWithAutoRefusedError,
    );
    const r = await rig({ extra: AUTO });
    expect([r.b.isolationAuto, r.b.isolatesTests, r.b.methodIsolation]).toEqual([
      true,
      false,
      false,
    ]);
    const forced = await rig({ extra: { isolation: "test" } });
    expect(() => forced.b.chooseIsolation(CU, "method")).toThrow(/not "auto"/);
  });

  test("one-shot: after a switch the codeunit's calls (baseline and mutant) run per test under codeunit isolation; the other codeunit's are unchanged", async () => {
    const r = await rig({ extra: { ...AUTO, transport: "one-shot" }, suite: SUITE2 });
    await baseline(r.b, SUITE2);
    for (const c of r.one.calls) {
      expect(isolationOf(c)).toBe("test");
      expect(c).not.toContain("--test-exact");
    }
    const before = r.one.calls.length;
    choose(r.b, CU, "method");
    expect(r.b.isolationOf(CU)).toBe("method");
    expect(r.b.isolationOf(CU2)).toBe("test");
    await baseline(r.b, SUITE2);
    // The mutant phase: `callCodeunit`'s own spawn, per test.
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    await r.b.run(ref("C", CU2), OPTS);
    const after = r.one.calls.slice(before);
    const mine = after.filter((c) => c.includes("--test-exact"));
    expect(mine.map((c) => c[c.indexOf("--test-exact") + 1]).sort()).toEqual([
      `Codeunit${CU}.A`,
      `Codeunit${CU}.A`,
      `Codeunit${CU}.B`,
    ]);
    for (const c of mine) {
      expect(isolationOf(c)).toBe("codeunit");
      expect(c).toContain("--run-selected-only");
    }
    const other = after.filter((c) => !c.includes("--test-exact"));
    expect(other.map((c) => c[c.indexOf("--codeunit") + 1])).toEqual([String(CU2), String(CU2)]);
    for (const c of other) expect(isolationOf(c)).toBe("test");
  });

  test("serve: a mixed batch is one request per mode, each on its own daemon with its own warm-up", async () => {
    const r = await rig({ extra: AUTO, suite: SUITE2 });
    await baseline(r.b, SUITE2);
    choose(r.b, CU, "method");
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants(plans(["M0002"], SUITE2));
    expect(r.serve.daemons).toHaveLength(2);
    const cuOf = (q: Req) =>
      new Set(
        ((q.body.entries as { test: string }[] | undefined) ?? [])
          .map((e) => Number(/^Codeunit(\d+)\./.exec(e.test)?.[1]))
          .filter((c) => c !== ECHO),
      );
    for (const q of r.serve.requests) {
      const method = q.body.testIsolation === "codeunit";
      expect(q.body.runSelectedOnly).toBe(method ? true : undefined);
      expect([...cuOf(q)]).toEqual([method ? CU : CU2]);
      expect(q.daemon).toBe(
        r.serve.requests.find((x) => x.body.testIsolation === q.body.testIsolation)?.daemon ?? -1,
      );
    }
    // Per daemon: its warm-up, then the prefetch of its mode.
    expect(r.serve.requests.filter((q) => q.body.testIsolation === "codeunit")).toHaveLength(2);
    expect(r.serve.requests.filter((q) => q.body.testIsolation === "test")).toHaveLength(2);
    await r.b.activate("M0002");
    const n = r.serve.requests.length;
    for (const t of SUITE2) expect((await r.b.run(t, OPTS)).outcome).toBe("pass");
    expect(r.serve.requests).toHaveLength(n); // served from the merged prefetch
  });

  test("speculation never runs a method codeunit whole, and its baseline never takes one", async () => {
    const r = await rig({ extra: { ...AUTO, speculateBaseline: true }, suite: SUITE2 });
    await baseline(r.b, SUITE2);
    choose(r.b, CU, "method");
    const before = r.one.calls.length;
    await r.b.deploy(r.l.batch); // a later batch: deploy speculates again
    const spec = r.one.calls.slice(before);
    expect(spec.map((c) => c[c.indexOf("--codeunit") + 1])).toEqual([String(CU2)]);
    for (const c of spec) expect(isolationOf(c)).toBe("test");
    const mid = r.one.calls.length;
    await baseline(r.b, SUITE2);
    const live = r.one.calls.slice(mid);
    expect(live.filter((c) => !c.includes("--test-exact"))).toEqual([]); // CU2 came from speculation
    expect(live.filter((c) => c.includes("--test-exact"))).toHaveLength(2);
  });

  test("review 4: a choice clears the codeunit's refusal notes; the chosen rows note them again", async () => {
    let methodPass = false;
    const refusesB: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B" && !methodPass
          ? { ...x, status: "error" as const, notRun: true, message: COMMIT }
          : x,
      );
    const r = await rig({ extra: AUTO, serve: { rows: refusesB } });
    const testRows = await baseline(r.b, SUITE1);
    expect(r.b.survivorNote([ref("A")])).toContain(`Tests${CU}.B`);
    choose(r.b, CU, "method");
    expect(r.b.survivorNote([ref("A")])).toBeUndefined();
    methodPass = true;
    await baseline(r.b, SUITE1);
    expect(r.b.survivorNote([ref("A")])).toBeUndefined();
    // Reverted to test: the test set comes back (build review 1); re-noting the rows adds nothing.
    choose(r.b, CU, "test");
    const back = r.b.survivorNote([ref("A")]);
    expect(back).toContain(`Tests${CU}.B`);
    r.b.noteReusedBaseline(SUITE1.map((t, i) => ({ ref: t, verdict: testRows[i] as TestVerdict })));
    expect(r.b.survivorNote([ref("A")])).toBe(back);
  });

  test("build review 4: a mixed prefetch of 2 groups, one per mode, with a uniform refusal is batch-refused, as an unsplit one", async () => {
    // Every mutant entry and echo refused with one unlisted reason; the warm-ups (NONE) are clean.
    const rows: RowsFn = (m, cu, d, n) =>
      m.startsWith("M")
        ? (SUITE_METHODS[cu] ?? []).map((method) => ({
            method,
            status: "error" as const,
            notRun: true,
            message: UNLISTED,
          }))
        : allPass(m, cu, d, n);
    const echo: Echo = (m, d, n) =>
      m.startsWith("M")
        ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
        : goodEcho(m, d, n);
    const r = await rig({
      extra: AUTO,
      suite: SUITE2,
      serve: { rows, echo },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE2);
    choose(r.b, CU, "method");
    await baseline(r.b, SUITE2);
    const err = await r.b
      .prefetchMutants([
        { mutantId: "M0001", refs: SUITE1 }, // CU, on method
        { mutantId: "M0002", refs: [ref("C", CU2)] }, // CU2, on test
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-batch-refused");
    expect(String(err)).toContain(UNLISTED);
  });

  test("build review 1: a tie reverted to test keeps the refusals of tests outside the verdict rows", async () => {
    let methodPass = false;
    // A fails in both modes (a tie); B, outside the session's suite, is refused by the whole call.
    const rows: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "A"
          ? { ...x, status: "fail" as const, message: "red" }
          : x.method === "B" && !methodPass
            ? { ...x, status: "error" as const, notRun: true, message: COMMIT }
            : x,
      );
    const only = [ref("A")];
    const make = async (isolation: "auto" | "test") => {
      const r = await rig({ extra: { isolation }, serve: { rows }, suite: SUITE1 });
      r.b.useSessionTests(only);
      methodPass = false;
      return r;
    };
    const forced = await make("test");
    await baseline(forced.b, only);
    const want = forced.b.survivorNote(only);
    expect(want).toContain(`Tests${CU}.B`);
    const r = await make("auto");
    const testRows = await baseline(r.b, only);
    choose(r.b, CU, "method");
    methodPass = true;
    const methodRows = await baseline(r.b, only);
    expect(methodRows.map((v) => v.outcome)).toEqual(testRows.map((v) => v.outcome)); // a tie
    choose(r.b, CU, "test");
    r.b.noteReusedBaseline(only.map((t, i) => ({ ref: t, verdict: testRows[i] as TestVerdict })));
    expect(r.b.survivorNote(only)).toBe(want);
  });

  test("the bracket: a method pass inside it carries coverage; the same calls outside carry none", async () => {
    const r = await rig({
      extra: { ...AUTO, coverage: "al-runner" },
      oneShotCoverage: plainCoverage,
      suite: SUITE1,
    });
    await baseline(r.b, SUITE1);
    choose(r.b, CU, "method");
    const inside = await baseline(r.b, SUITE1);
    expect(inside.map((v) => v.coverage === undefined)).toEqual([false, false]);
    await r.b.activate(null);
    const outside = await r.b.run(ref("A"), { coverage: "al-runner", timeoutMs: 1000 });
    expect(outside.coverage).toBeUndefined();
  });

  test("one-shot under auto: the switch allows method by default, and refuses by name when set to refuse", async () => {
    const allow = await rig({ extra: { ...AUTO, transport: "one-shot" } });
    expect(V3_AUTO_METHOD_ONE_SHOT).toBe("allow");
    choose(allow.b, CU, "method");
    const refuse = await rig({
      extra: { ...AUTO, transport: "one-shot", autoMethodOneShot: "refuse" },
    });
    expect(() => choose(refuse.b, CU, "method")).toThrow(AlRunnerV3AutoMethodOneShotRefusedError);
    choose(refuse.b, CU, "test");
    const serve = await rig({ extra: { ...AUTO, autoMethodOneShot: "refuse" } });
    choose(serve.b, CU, "method");
    expect(serve.b.isolationOf(CU)).toBe("method");
  });
});

// ---------------------------------------------------------------------------------------------
// R948: the baseline through ONE serve daemon, per-test requests for `method` codeunits, the
// cross-check against fresh processes, and the memory guard. Call counters, never the clock.
// ---------------------------------------------------------------------------------------------
const CU3 = 79102;
SUITE_METHODS[CU3] = ["D"];
const SUITE3 = [ref("A"), ref("B"), ref("C", CU2), ref("D", CU3)];
const GIB = 2 ** 30;

/** A rig with the daemon baseline on, a baseline stop (2 s) that differs from the mutant phase's (5 s), and coverage on both transports. */
function dbRig(o: RigOpts = {}): Promise<Rig> {
  return rig({
    suite: SUITE3,
    floor: [5000, 2000],
    oneShotCoverage: plainCoverage,
    ...o,
    serve: { coverage: plainCoverage, ...(o.serve ?? {}) },
    extra: { daemonBaseline: true, ...(o.extra ?? {}) },
  });
}
const oneShotCodeunits = (r: Rig) => r.one.calls.map((c) => c[c.indexOf("--codeunit") + 1] ?? "?");
const dropNotice = (seen: readonly [string, string][]) =>
  seen.filter(([c]) => c === "al-runner-v3-baseline-daemon-dropped");

describe("R948 A: the baseline through one daemon", () => {
  test("one daemon answers every codeunit at the baseline's stop; the first and the last are cross-checked one-shot; the middle one is served from the daemon; the daemon is closed before the mutant phase's own", async () => {
    const r = await dbRig();
    const v = await baseline(r.b, SUITE3);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(r.serve.requests.map((q) => q.ids[0])).toEqual([
      `plain:Codeunit${CU}.`,
      `plain:Codeunit${CU2}.`,
      `plain:Codeunit${CU3}.`,
    ]);
    expect(new Set(r.serve.requests.map((q) => q.daemon))).toEqual(new Set([0]));
    expect(r.serve.daemons[0]?.join(" ")).toContain("--test-timeout 1");
    for (const q of r.serve.requests) expect(q.body.coverage).toBe(true);
    // (the baseline call's own timeout, OPTS' 1000 ms, not the mutant phase's 5 s)
    // The sample: the 2nd (CU2) and the last (CU3), one process each; never index 0, so CU came from
    // the daemon alone.
    expect(oneShotCodeunits(r)).toEqual([String(CU2), String(CU3)]);
    expect(r.b.daemonBaselineReport()).toMatchObject({
      dropped: undefined,
      codeunits: 3,
      requests: 3,
      sampledCodeunits: [CU2, CU3],
      compared: 2,
      served: 1, // CU only: the two sampled ones were answered by their fresh process
    });
    expect(r.serve.closes).toHaveLength(1);
    expect(r.b.daemonCloses().byReason.get("baseline-end")).toBeGreaterThanOrEqual(1);
    await r.b.prefetchMutants(plans(["M0001"], SUITE3));
    expect(r.serve.daemons[1]?.join(" ")).toContain("--test-timeout 5");
  });

  const leakCu2: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((x) =>
      cu === CU2 && d >= 0 && n > 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
    );

  test("a daemon answer that differs from a fresh process's drops the daemon baseline for the whole session: one-shot for all, one named notice", async () => {
    const seen: [string, string][] = [];
    const r = await dbRig({
      suite: SUITE2,
      serve: { rows: leakCu2 },
      notify: (c, m) => seen.push([c, m]),
    });
    const v = await baseline(r.b, SUITE2);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass"]); // the fresh process's answer stands
    expect(dropNotice(seen)).toHaveLength(1);
    expect(dropNotice(seen)[0]?.[1]).toContain(`codeunit ${CU2}`);
    // The sample run (CU2), then every codeunit one-shot: no verdict rests on the daemon.
    expect(oneShotCodeunits(r)).toEqual([String(CU2), String(CU), String(CU2)]);
    expect(r.b.daemonBaselineReport().served).toBe(0); // nothing a daemon said was taken
    const asked = r.serve.requests.length;
    await baseline(r.b, SUITE2); // a second baseline of the session asks the daemon nothing
    expect(r.serve.requests).toHaveLength(asked);
  });

  test("R949: a daemon-answered pass has flagged UNKNOWN; a one-shot-answered one does not; one notice, no count (the report is the record), cites the issue", async () => {
    const seen: [string, string][] = [];
    const r = await dbRig({ notify: (c, m) => seen.push([c, m]) });
    const v = await baseline(r.b, SUITE3);
    // Only CU came from the daemon alone (see the test above); CU2 and CU3 were answered by a fresh process.
    expect(v.map((x) => x.flaggedUnknown === true)).toEqual([true, true, false, false]);
    const n = seen.filter(([c]) => c === "al-runner-v3-serve-flagged-unknown");
    expect(n).toHaveLength(1);
    expect(n[0]?.[1]).toContain("issues/7954");
    expect(n[0]?.[1]).toContain(
      "every passing test the daemon answered has an UNKNOWN flagged state",
    );
    expect(n[0]?.[1]).not.toMatch(/up to \d/); // R949 review: a count here undercounted later batches
    expect(r.b.daemonBaselineReport().dropped).toBeUndefined();
  });

  test("R949: no daemon answer used, no notice and no unknown", async () => {
    const seen: [string, string][] = [];
    const r = await rig({
      suite: SUITE3,
      floor: [5000, 2000],
      oneShotCoverage: plainCoverage,
      notify: (c, m) => seen.push([c, m]),
    });
    const v = await baseline(r.b, SUITE3);
    expect(v.some((x) => x.flaggedUnknown === true)).toBe(false);
    expect(seen.some(([c]) => c === "al-runner-v3-serve-flagged-unknown")).toBe(false);
  });

  test("agreement keeps it: the same suite without the leak raises no notice and runs no live process", async () => {
    const seen: [string, string][] = [];
    const r = await dbRig({ suite: SUITE2, notify: (c, m) => seen.push([c, m]) });
    await baseline(r.b, SUITE2);
    expect(dropNotice(seen)).toHaveLength(0);
    expect(oneShotCodeunits(r)).toEqual([String(CU2)]); // the sample (the 2nd) only
  });

  test("order: a leak only the reversed order shows is caught there, and not in the forward order", async () => {
    const leakCu: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CU && d >= 0 && n > 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
      );
    const forward: [string, string][] = [];
    const f = await dbRig({
      suite: SUITE2,
      serve: { rows: leakCu },
      notify: (c, m) => forward.push([c, m]),
    });
    await baseline(f.b, SUITE2);
    expect(dropNotice(forward)).toHaveLength(0);
    const reversed: [string, string][] = [];
    const g = await dbRig({
      suite: SUITE2,
      serve: { rows: leakCu },
      notify: (c, m) => reversed.push([c, m]),
      seams: { reverseBaselineOrder: true },
    });
    await baseline(g.b, SUITE2);
    expect(dropNotice(reversed)).toHaveLength(1);
    expect(g.serve.requests[0]?.ids[0]).toBe(`plain:Codeunit${CU2}.`); // CU2 went first
  });

  test("the fail text is compared (the rows' class alone would not see it)", async () => {
    const seen: [string, string][] = [];
    const text: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "C"
          ? { ...x, status: "fail" as const, message: d >= 0 ? "boom daemon" : "boom" }
          : x,
      );
    const r = await dbRig({
      suite: SUITE2,
      serve: { rows: text },
      notify: (c, m) => seen.push([c, m]),
    });
    await baseline(r.b, SUITE2);
    expect(dropNotice(seen)).toHaveLength(1);
    expect(dropNotice(seen)[0]?.[1]).toContain("differs in failText");
    // The structured field names the test and the field, uncut.
    const rep = r.b.daemonBaselineReport();
    expect(rep.dropped).toContain(`codeunit ${CU2}`);
    expect(rep.droppedDetail).toHaveLength(1);
    expect(rep.droppedDetail[0]).toContain("c: differs in failText");
  });

  test("the per-test coverage set is compared exactly", async () => {
    const seen: [string, string][] = [];
    const other: CoverageFn = (m, cu, a, t) => {
      const d = plainCoverage(m, cu, a, t) as {
        perTestCoverage: { coverage: { statements: { line: number; hits: number }[] }[] }[];
      };
      const first = d.perTestCoverage[0]?.coverage[0];
      if (first !== undefined) first.statements = [{ line: 99, hits: 1 }];
      return d;
    };
    const r = await dbRig({
      suite: SUITE2,
      oneShotCoverage: other,
      notify: (c, m) => seen.push([c, m]),
    });
    await baseline(r.b, SUITE2);
    expect(dropNotice(seen)).toHaveLength(1);
    expect(dropNotice(seen)[0]?.[1]).toContain("coverage differs (daemon only 1");
    // Only the coverage differs: no row field is named, and the keys are file:line only.
    const detail = r.b.daemonBaselineReport().droppedDetail.join(" ");
    expect(detail).toContain("coverage differs");
    expect(detail).toContain(":99");
    expect(detail).not.toContain("differs in");
  });

  test("durations: a codeunit whose daemon duration could move a budget (2 x d >= floor) runs one-shot and its answer stands", async () => {
    const slowCu: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CU ? { ...x, message: "Test exceeded 3s timeout." } : x,
      );
    const r = await dbRig({ serve: { rows: slowCu } });
    await baseline(r.b, SUITE3);
    // The two samples, and CU (3000 ms x 2 >= the 5000 ms floor): three processes.
    expect(oneShotCodeunits(r).sort()).toEqual([String(CU), String(CU2), String(CU3)].sort());
    // The skip is counted and named, so a gate can tell it from a silent drop.
    const rep = r.b.daemonBaselineReport();
    expect(rep.skippedTooSlow).toEqual([`Codeunit${CU}`]);
    expect([rep.skippedError, rep.skippedOther, rep.sampledSkipped]).toEqual([[], [], []]);
    expect(rep.served + rep.skippedTooSlow.length).toBe(
      rep.codeunits - rep.sampledCodeunits.length,
    );
  });

  test("a dirty daemon: the row stands, the daemon is closed, the next codeunit starts a fresh one, nothing is re-run", async () => {
    const hangsC: RowsFn = (m, cu, d, n) =>
      cu === CU2
        ? [{ method: "C", status: "error", notRun: true, message: "Test exceeded 2s timeout." }]
        : allPass(m, cu, d, n);
    const r = await dbRig({ serve: { rows: hangsC } });
    const v = await baseline(r.b, SUITE3);
    expect(v[2]?.outcome).not.toBe("pass"); // C's timeout row is kept as the baseline's row
    expect(r.serve.requests.map((q) => q.ids[0])).toEqual([
      `plain:Codeunit${CU}.`,
      `plain:Codeunit${CU2}.`,
      `plain:Codeunit${CU3}.`,
    ]);
    expect(r.serve.requests.map((q) => q.daemon)).toEqual([0, 0, 1]); // restarted after C
    expect(r.b.daemonCloses().byReason.get("timeout")).toBe(1);
  });

  test("R955: a spent budget starts no further request; a signal drops the call it ended", async () => {
    let rr: Rig | undefined;
    const asked = () => rr?.serve.requests.length ?? 0;
    const spentAfterTwo = await dbRig({
      stopHandle: { spent: () => asked() >= 2, signalled: () => false, stopForMemory: () => {} },
    });
    rr = spentAfterTwo;
    await baseline(spentAfterTwo.b, SUITE3);
    expect(spentAfterTwo.serve.requests).toHaveLength(2); // CU3 never asked
    // CU from the daemon, CU2 (sample) one-shot; CU3 runs live: two processes.
    expect(oneShotCodeunits(spentAfterTwo)).toHaveLength(2);

    const signalled = await dbRig({
      stopHandle: {
        spent: () => asked() >= 1,
        signalled: () => asked() >= 1,
        stopForMemory: () => {},
      },
    });
    rr = signalled;
    await baseline(signalled.b, SUITE3);
    expect(signalled.serve.requests).toHaveLength(1);
    // The first request's call is dropped, nothing is kept: all three codeunits run live.
    expect(oneShotCodeunits(signalled)).toHaveLength(3);
  });
});

describe("R948 B: `method` codeunits as per-test requests", () => {
  const methodRig = (o: RigOpts = {}) =>
    dbRig({ suite: SUITE2, extra: { isolation: "method" }, ...o });

  test("every test is one request to ONE codeunit-isolation daemon; no process is started", async () => {
    const r = await methodRig();
    const v = await baseline(r.b, SUITE2);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass"]);
    // Only the cross-check's sample (the 2nd test and the last, B and C) runs as a process.
    expect(r.one.calls.map((c) => c[c.indexOf("--test-exact") + 1]?.split(".").at(-1))).toEqual([
      "B",
      "C",
    ]);
    expect(r.serve.requests).toHaveLength(3);
    for (const q of r.serve.requests) {
      expect(q.body.testIsolation).toBe("codeunit");
      expect(q.body.runSelectedOnly).toBe(true);
      expect(q.body.coverage).toBe(true);
      expect(q.daemon).toBe(0);
    }
    expect(r.serve.daemons[0]?.join(" ")).toContain("--test-timeout 1");
    expect(r.serve.closes).toHaveLength(1); // closed when the baseline ended, before any mutant daemon
  });

  test("an answer that is not exactly that test's row, run, falls back to the test alone one-shot", async () => {
    const refusedA: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "A" && d >= 0
          ? { ...x, status: "error" as const, notRun: true, message: COMMIT }
          : x,
      );
    const r = await methodRig({ serve: { rows: refusedA } });
    const v = await baseline(r.b, SUITE2);
    expect(v[1]?.outcome).toBe("pass"); // B stood from the daemon (and its sample agreed)
    // A alone one-shot (the daemon's answer was a refusal), plus the sample's B and C.
    const asked = r.one.calls.map((c) => c[c.indexOf("--test-exact") + 1]?.split(".").at(-1));
    expect(asked.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("R948 C: the memory guard", () => {
  const sampleOf = (usedBytes: number, source = "/sys/fs/cgroup/memory.max") => ({
    usedBytes,
    maxBytes: 32 * GIB,
    source,
  });
  const guarded = (
    used: () => number,
    o: RigOpts & { polls?: number } = {},
  ): Promise<
    Rig & {
      sleeps: number[];
      stops: { usedBytes: number; boundBytes: number; source: string }[];
      seen: [string, string][];
    }
  > => {
    const sleeps: number[] = [];
    const stops: { usedBytes: number; boundBytes: number; source: string }[] = [];
    const seen: [string, string][] = [];
    return rig({
      ...o,
      extra: { memoryHeadroomGb: 4, ...(o.extra ?? {}) },
      notify: (c, m) => seen.push([c, m]),
      stopHandle: {
        spent: () => false,
        signalled: () => false,
        stopForMemory: (i) => stops.push(i),
      },
      seams: {
        memoryReader: () => sampleOf(used()),
        memorySleep: async (ms) => {
          sleeps.push(ms);
        },
        memoryWaitPolls: o.polls ?? 2,
        ...(o.seams ?? {}),
      },
    }).then((r) => ({ ...r, sleeps, stops, seen }));
  };

  test("the first line names the bound and its source", async () => {
    const r = await guarded(() => GIB);
    const line = r.seen.find(([c]) => c === "al-runner-v3-memory-guard")?.[1] ?? "";
    expect(line).toContain("28.0 GiB");
    expect(line).toContain("/sys/fs/cgroup/memory.max");
    expect(line).toContain("32.0 GiB");
    expect(line).toContain("4 GiB headroom");
  });

  test("no readable cgroup: the guard says it is off, by name, and the run goes on", async () => {
    const seen: [string, string][] = [];
    const r = await rig({
      extra: { memoryHeadroomGb: 4 },
      notify: (c, m) => seen.push([c, m]),
      seams: { memoryReader: () => undefined },
    });
    const off = seen.find(([c]) => c === "al-runner-v3-memory-guard-off")?.[1] ?? "";
    expect(off).toContain("no cgroup");
    expect((await baseline(r.b, SUITE1)).map((v) => v.outcome)).toEqual(["pass", "pass"]);
  });

  test("over the bound for good: no call starts, the baseline call is dropped (a failure row, nothing stored), and the session is stopped once through the handle", async () => {
    const r = await guarded(() => 30 * GIB);
    const a = await baselineOne(r.b, ref("A"));
    expect(a.outcome).toBe("error");
    expect(a.failureMessage).toContain("al-runner-v3-memory-bound");
    expect(r.one.calls).toHaveLength(0);
    expect(r.stops).toEqual([
      { usedBytes: 30 * GIB, boundBytes: 28 * GIB, source: "/sys/fs/cgroup/memory.max" },
    ]);
    expect(r.sleeps).toHaveLength(2); // it waited through its two polls first
    const b = await baselineOne(r.b, ref("B")); // later calls are refused at once
    expect(b.outcome).toBe("error");
    expect([r.sleeps.length, r.stops.length, r.one.calls.length]).toEqual([2, 1, 0]);
  });

  test("a bound that clears while it waits is no stop: the call runs", async () => {
    let reads = 0;
    const r = await guarded(() => (++reads === 1 ? GIB : reads <= 3 ? 30 * GIB : GIB), {
      polls: 5,
    });
    const a = await baselineOne(r.b, ref("A"));
    expect(a.outcome).toBe("pass");
    expect(r.sleeps).toHaveLength(2);
    expect(r.stops).toHaveLength(0);
    expect(r.one.calls).toHaveLength(1);
  });

  test("with no stop handle the guard throws by name", async () => {
    const r = await rig({
      extra: { memoryHeadroomGb: 4 },
      seams: {
        memoryReader: (() => {
          let n = 0;
          return () => sampleOf(++n === 1 ? GIB : 30 * GIB);
        })(),
        memorySleep: async () => {},
        memoryWaitPolls: 1,
      },
    });
    await expect(baselineOne(r.b, ref("A"))).rejects.toThrow(/al-runner-v3-memory-bound/);
  });

  test("a daemon baseline stops asking at the bound: what was answered stands, the rest is dropped, one stop", async () => {
    let reads = 0;
    const r = await guarded(() => (++reads <= 3 ? GIB : 30 * GIB), {
      suite: SUITE2,
      floor: [5000, 2000],
      oneShotCoverage: plainCoverage,
      serve: { coverage: plainCoverage },
      extra: { daemonBaseline: true },
      polls: 1,
    });
    const v: TestVerdict[] = [];
    r.b.baselinePhase(true);
    await r.b.activate(null);
    for (const t of SUITE2) v.push(await r.b.run(t, OPTS));
    r.b.baselinePhase(false);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "error"]); // C was never started
    expect(v[2]?.failureMessage).toContain("memory-bound");
    expect(r.serve.requests).toHaveLength(2); // CU, then CU2, whose cross-check was blocked
    expect(oneShotCodeunits(r)).toEqual([]); // no process started over the bound
    expect(r.stops).toHaveLength(1);
  });

  test("a group start asks the guard: under the bound it may start; over it for good it waits, stops the session once, and is told no, now and after", async () => {
    let used = GIB;
    const r = await guarded(() => used, { polls: 1 });
    await baseline(r.b, SUITE1);
    expect(await r.b.mayStartGroup()).toBe(true);
    used = 30 * GIB;
    expect(await r.b.mayStartGroup()).toBe(false);
    expect(r.stops).toHaveLength(1);
    expect(r.sleeps).toHaveLength(1);
    expect(await r.b.mayStartGroup()).toBe(false); // at once, nothing more is waited or reported
    expect([r.stops.length, r.sleeps.length]).toEqual([1, 1]);
  });

  test("activate itself neither waits nor stops: the question is asked before it, so a refused group is never activated", async () => {
    let used = GIB;
    const r = await guarded(() => used, { polls: 1 });
    await baseline(r.b, SUITE1);
    used = 30 * GIB;
    await r.b.activate("M0001");
    expect([r.stops.length, r.sleeps.length]).toEqual([0, 0]);
  });

  test("callers take turns and each one that holds counts an estimated cost: two at 26 of 28 GiB do not both pass", async () => {
    const r = await guarded(() => 26 * GIB, { polls: 1, seams: { memoryEstimateBytes: 3 * GIB } });
    const gate = (h: boolean) =>
      (r.b as unknown as { memoryGate(h: boolean): Promise<boolean> }).memoryGate(h);
    const release = () => (r.b as unknown as { memoryRelease(): void }).memoryRelease();
    const [a, b] = await Promise.all([gate(true), gate(true)]);
    expect([a, b]).toEqual([true, false]); // the second sees the first's 3 GiB on top of 26
    expect(r.stops).toHaveLength(1);
    // (the first still holds; the session is stopped, so every later gate says no)
    expect(await gate(true)).toBe(false);
    release();
  });

  test("a released reservation is not counted again", async () => {
    const r = await guarded(() => 26 * GIB, { polls: 1, seams: { memoryEstimateBytes: 3 * GIB } });
    const gate = (h: boolean) =>
      (r.b as unknown as { memoryGate(h: boolean): Promise<boolean> }).memoryGate(h);
    const release = () => (r.b as unknown as { memoryRelease(): void }).memoryRelease();
    expect(await gate(true)).toBe(true);
    release();
    expect(await gate(true)).toBe(true);
    expect(r.stops).toHaveLength(0);
  });

  test("before it waits the guard closes the baseline's daemon (it holds 2-3 GB)", async () => {
    let reads = 0;
    let closesAtFirstSleep = -1;
    const held: { rig?: Rig } = {};
    const r = await guarded(() => (++reads <= 2 ? GIB : 30 * GIB), {
      suite: SUITE2,
      floor: [5000, 2000],
      oneShotCoverage: plainCoverage,
      serve: { coverage: plainCoverage },
      extra: { daemonBaseline: true },
      polls: 1,
      seams: {
        memorySleep: async () => {
          if (closesAtFirstSleep < 0) closesAtFirstSleep = held.rig?.serve.closes.length ?? -2;
        },
      },
    });
    held.rig = r;
    await baselineOne(r.b, ref("A"));
    // CU's request ran on daemon 0; the gate for CU2 found the bound passed and closed it first.
    expect(closesAtFirstSleep).toBeGreaterThanOrEqual(1);
  });
});

describe("R948 ordering and the per-test cross-check", () => {
  test("a per-test call that comes FIRST (batch 2 under auto) still waits for the whole-codeunit fill and its cross-check, which can drop the daemon baseline before anything is served", async () => {
    const seen: [string, string][] = [];
    const leakCu2: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CU2 && d >= 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
      );
    // CU is the `method` codeunit; CU2 a whole-codeunit one whose daemon answer leaks (sampled: the 2nd).
    const r = await dbRig({
      suite: SUITE2,
      extra: { isolation: "auto" },
      serve: { rows: leakCu2 },
      notify: (c, m) => seen.push([c, m]),
    });
    (r.b as unknown as { chooseIsolation(cu: number, m: "method"): void }).chooseIsolation(
      CU,
      "method",
    );
    // Only CU's per-test call is made first; no daemon answer for it may be served before the check.
    const v = await baselineOne(r.b, ref("A"));
    expect(dropNotice(seen)).toHaveLength(1);
    expect(v.outcome).toBe("pass"); // from a one-shot process, not from a served daemon answer
    expect(r.one.calls.some((c) => c.includes("--test-exact"))).toBe(true);
  });

  test("under --isolate-tests (every codeunit per-test) the per-test requests have their own cross-check: a difference drops the daemon baseline", async () => {
    const seen: [string, string][] = [];
    const leak: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        d >= 0 && n > 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
      );
    const r = await dbRig({
      suite: SUITE2,
      extra: { isolateTests: true },
      serve: { rows: leak },
      notify: (c, m) => seen.push([c, m]),
    });
    const v = await baseline(r.b, SUITE2);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass"]); // the fresh processes' answers
    expect(dropNotice(seen)).toHaveLength(1);
    expect(r.b.daemonBaselineReport().sampledPerTest).toEqual([1, 2]);
  });

  test("--isolate-tests: per-test requests agree with fresh processes: the daemon baseline stays, in test isolation with runSelectedOnly", async () => {
    const seen: [string, string][] = [];
    const r = await dbRig({
      suite: SUITE2,
      extra: { isolateTests: true },
      notify: (c, m) => seen.push([c, m]),
    });
    await baseline(r.b, SUITE2);
    expect(dropNotice(seen)).toHaveLength(0);
    for (const q of r.serve.requests) {
      expect(q.body.testIsolation).toBe("test");
      expect(q.body.runSelectedOnly).toBe(true);
    }
    expect(r.b.daemonBaselineReport()).toMatchObject({
      perTestRequests: 3,
      compared: 2,
      served: 1,
    });
  });

  test("a baseline snapshot's lending key names its source: a daemon baseline is tagged, a one-shot one is not", async () => {
    const on = await dbRig({ suite: SUITE2 });
    const off = await rig({ suite: SUITE2 });
    expect(baselineSourceTag(on.b)).toBe(" baseline-daemon");
    expect(baselineSourceTag(off.b)).toBe("");
    const run = (runnerBuild: string) => ({ id: 1, backend: "al-runner-v3", runnerBuild });
    const lend = (tagRun: string, tagSession: string) =>
      backendBuildRefusal(run(`v3 sha${tagRun}`), {
        backend: "al-runner-v3",
        runnerBuild: `v3 sha${tagSession}`,
      });
    expect(lend(" baseline-daemon", "")).toContain("only to the same build"); // daemon snapshot, one-shot session
    expect(lend("", " baseline-daemon")).toContain("only to the same build"); // and the other way
    expect(lend(" baseline-daemon", " baseline-daemon")).toBeUndefined();
    expect(lend("", "")).toBeUndefined();
  });
});

describe("R948: a throw after the memory hold gives the hold back", () => {
  const held = (b: AlRunnerV3Backend) => (b as unknown as { memoryHeld: number }).memoryHeld;
  const guard = {
    memoryHeadroomGb: 4,
    seams: {
      memoryReader: () => ({
        usedBytes: GIB,
        maxBytes: 32 * GIB,
        source: "/sys/fs/cgroup/memory.max",
      }),
    },
  };

  test("the bound check inside a fill (a tampered batch) throws; nothing stays held", async () => {
    const r = await dbRig({
      suite: SUITE2,
      seams: guard.seams,
      extra: { memoryHeadroomGb: guard.memoryHeadroomGb },
    });
    await writeFile(join(r.l.scratch, "active", "Logic.Codeunit.al"), "codeunit 79000 Other { }");
    await expect(baselineOne(r.b, ref("A"))).rejects.toThrow();
    expect(held(r.b)).toBe(0);
  });

  test("the one-shot cross-check failing before its spawn (its coverage file cannot be removed) releases its hold", async () => {
    const r = await dbRig({
      suite: SUITE2,
      seams: guard.seams,
      extra: { memoryHeadroomGb: guard.memoryHeadroomGb },
    });
    // The first call takes call-1; the fill's own process takes call-2, whose path is a folder
    // with a file in it, so removing it throws after the hold was taken.
    const blocked = join(r.l.scratch, "cov", "call-2.json");
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, "x"), "x");
    await expect(baselineOne(r.b, ref("A"))).rejects.toThrow();
    expect(held(r.b)).toBe(0);
  });

  test("the process worker: a throw before its spawn releases its hold", async () => {
    const r = await rig({
      suite: SUITE2,
      seams: guard.seams,
      extra: { isolateTests: true, memoryHeadroomGb: guard.memoryHeadroomGb },
    });
    // The first call takes call-1; the fill's own process takes call-2, whose path is a folder
    // with a file in it, so removing it throws after the hold was taken.
    const blocked = join(r.l.scratch, "cov", "call-2.json");
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, "x"), "x");
    await expect(baselineOne(r.b, ref("A"))).rejects.toThrow();
    expect(held(r.b)).toBe(0);
  });
});

describe("R952 (R948): a serve daemon past its size or request bound is recycled", () => {
  const GIB = 2 ** 30;
  /** Each mutant prefetched on its own (one ensureDaemon each), then run: every verdict, and the rig. */
  const session = async (opts: RigOpts) => {
    const r = await rig({ serve: { rows: killsM1 }, oneShotRows: killsM1, ...opts });
    await baseline(r.b, SUITE1);
    const verdicts: string[] = [];
    for (const m of ["M0001", "M0002", "M0003"]) {
      await r.b.prefetchMutants(plans([m]));
      await r.b.activate(m);
      for (const t of SUITE1) verdicts.push(`${m} ${t.method} ${outcome(await r.b.run(t, OPTS))}`);
    }
    return { r, verdicts, closes: [...r.b.daemonCloses().byReason] };
  };

  test("no bound reached: no recycle (the control)", async () => {
    const c = await session({});
    expect(c.closes.filter(([why]) => why === "recycle")).toEqual([]);
  });

  test("daemonMaxRequests: a daemon past it is replaced, and every verdict equals the control's", async () => {
    const control = await session({});
    const s = await session({ extra: { daemonMaxRequests: 2 } });
    const recycles = s.closes.find(([why]) => why === "recycle")?.[1] ?? 0;
    expect(recycles).toBeGreaterThan(0);
    expect(s.r.serve.daemons.length).toBe(control.r.serve.daemons.length + recycles);
    expect(s.verdicts).toEqual(control.verdicts);
    expect(s.verdicts).toContain("M0001 A fail,"); // a kill is in the comparison, not only passes
  });

  test("daemonMaxRssGb: only the daemon over the size is replaced; the default is 6 GiB", async () => {
    const control = await session({});
    // The first daemon the bound asks about GROWS: 1 GiB at its first check (warm-up and one request),
    // 7 GiB after that. Every other daemon stays at 1 GiB.
    let first: number | undefined;
    let checks = 0;
    const reader = (pid: number) => {
      first ??= pid;
      if (pid !== first) return GIB;
      checks++;
      return checks === 1 ? GIB : 7 * GIB;
    };
    const notices: string[] = [];
    const s = await session({
      seams: { rssReader: reader },
      notify: (code) => notices.push(code),
    });
    expect(s.closes.find(([why]) => why === "recycle")?.[1]).toBe(1);
    expect(s.verdicts).toEqual(control.verdicts);
    expect(notices).not.toContain("al-runner-v3-daemon-recycle-off");
    // at 5 GiB the default bound (6) is not reached; at 0 the bound is off whatever the size
    const under = await session({ seams: { rssReader: () => 5 * GIB } });
    expect(under.closes.filter(([why]) => why === "recycle")).toEqual([]);
    const off = await session({
      extra: { daemonMaxRssGb: 0 },
      seams: { rssReader: () => 100 * GIB },
    });
    expect(off.closes.filter(([why]) => why === "recycle")).toEqual([]);
  });

  // Review r1: a project whose fresh daemon is already over the size would otherwise pay a warm-up
  // per request. The bound turns itself off for the session, said once; nothing is recycled.
  test("a daemon already over the size after its warm-up: the size bound goes off, said once", async () => {
    const control = await session({});
    const notices: string[] = [];
    const s = await session({
      seams: { rssReader: () => 7 * GIB },
      notify: (code) => notices.push(code),
    });
    expect(s.closes.filter(([why]) => why === "recycle")).toEqual([]);
    expect(notices.filter((c) => c === "al-runner-v3-daemon-recycle-off")).toHaveLength(1);
    expect(s.verdicts).toEqual(control.verdicts);
    // the request bound is not affected by it
    const r = await session({
      seams: { rssReader: () => 7 * GIB },
      extra: { daemonMaxRequests: 2 },
    });
    expect(r.closes.find(([why]) => why === "recycle")?.[1] ?? 0).toBeGreaterThan(0);
  });

  test("a recycle is not routine: it costs a warm-up, so it reaches the close sink", () => {
    expect(V3_ROUTINE_CLOSES.has("recycle")).toBe(false);
  });
});

/** One baseline call inside its bracket (the orchestrator's `baselinePhase` and null activation). */
async function baselineOne(b: AlRunnerV3Backend, t: TestMethodRef): Promise<TestVerdict> {
  b.baselinePhase(true);
  try {
    await b.activate(null);
    return await b.run(t, OPTS);
  } finally {
    await b.baselinePhase(false);
  }
}

describe("R951 R1: a one-shot baseline run with no answer says why", () => {
  const crossChecked = async (o: RigOpts, patch?: (b: AlRunnerV3Backend) => void) => {
    const seen: [string, string][] = [];
    const r = await dbRig({ suite: SUITE2, notify: (c, m) => seen.push([c, m]), ...o });
    patch?.(r.b);
    // The later one-shot calls may refuse by name too (a missing row throws); only the drop is read.
    await baseline(r.b, SUITE2).catch(() => {});
    return { notice: dropNotice(seen)[0]?.[1] ?? "", rep: r.b.daemonBaselineReport() };
  };
  const stubSpawn = (b: AlRunnerV3Backend, made: unknown) => {
    // Only the first call (the cross-check) is stubbed; the session's later calls run as usual.
    const holder = b as unknown as { spawnCodeunit: (...a: unknown[]) => Promise<unknown> };
    const real = holder.spawnCodeunit.bind(b);
    let first = true;
    holder.spawnCodeunit = async (...a) => {
      if (!first) return real(...a);
      first = false;
      return made;
    };
  };

  test("memory-gate: the one-shot run is refused at the bound", async () => {
    const r = await rig({
      extra: { memoryHeadroomGb: 4 },
      seams: {
        memoryReader: () => ({
          usedBytes: 30 * GIB,
          maxBytes: 32 * GIB,
          source: "/sys/fs/cgroup/memory.max",
        }),
        memorySleep: async () => {},
        memoryWaitPolls: 1,
      },
      stopHandle: { spent: () => false, signalled: () => false, stopForMemory: () => {} },
    });
    const priv = r.b as unknown as {
      makeLane(k: number): unknown;
      oneShotBaselineAnswer(l: unknown, id: number, s: number, c: boolean): Promise<unknown>;
    };
    expect(await priv.oneShotBaselineAnswer(priv.makeLane(0), CU, 1, false)).toEqual({
      noAnswer: "memory-gate",
    });
  });

  test("spawn-error and timed-out", async () => {
    for (const [made, reason] of [
      [{ spawnError: "boom", wallMs: 0 }, "spawn-error"],
      [{ timedOut: true, wallMs: 1 }, "timed-out"],
    ] as const) {
      const { notice, rep } = await crossChecked({}, (b) => stubSpawn(b, made));
      // R2: no process answered, so the sample is SKIPPED by name; the only sample leaves none clean.
      expect(notice).toContain("too few clean cross-check samples: 0 of 1");
      expect(rep.sampledSkipped).toEqual([`Codeunit${CU2} (${reason})`]);
      expect(rep.droppedDetail).toEqual(["too-few-clean-samples:0/1"]);
    }
  });

  test("exit-<n> outside 0/1/7/8 drops, naming it", async () => {
    const { notice, rep } = await crossChecked({ oneShotAnswer: { exitCode: 6, stderr: "" } });
    expect(notice).toContain("(exit-6)");
    expect(rep.droppedDetail).toEqual(["exit-6"]);
    expect(rep.sampledSkipped).toEqual([]);
  });

  test("R2: exit 7 and 8 are answers, compared: equal keeps the daemon baseline", async () => {
    for (const exitCode of [7, 8]) {
      const { notice, rep } = await crossChecked({ oneShotAnswer: { exitCode, stderr: "" } });
      expect(notice).toBe("");
      expect(rep).toMatchObject({ dropped: undefined, compared: 1, sampledSkipped: [] });
    }
  });

  test("R2: exit 7 with a notRun row the daemon did not have is a real difference: drop", async () => {
    const notRunC: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "C" && d < 0 ? { ...x, status: "error" as const, notRun: true } : x,
      );
    const { notice, rep } = await crossChecked({
      oneShotAnswer: { exitCode: 7, stderr: "" },
      serve: { rows: allPass },
      oneShotRows: notRunC,
    });
    expect(notice).toContain("differs in");
    expect(rep.droppedDetail.join(" ")).toContain("notRun");
    expect(rep.compared).toBe(1);
  });

  test("rows-undecodable", async () => {
    const bad = { exitCode: 0, stderr: "", stdout: "not json" };
    const { notice, rep } = await crossChecked({
      oneShotAnswer: bad as unknown as { exitCode: number; stderr: string },
    });
    expect(notice).toContain("(rows-undecodable)");
    expect(rep.droppedDetail).toEqual(["rows-undecodable"]);
  });

  test("row-missing:<test name>", async () => {
    const noB: RowsFn = (m, cu, d, n) => allPass(m, cu, d, n).filter((x) => x.method !== "C");
    const { notice, rep } = await crossChecked({ serve: { rows: allPass }, oneShotRows: noB });
    // R2: a missing row is compared, and is a real difference.
    expect(notice).toContain("differs from a fresh process's");
    expect(rep.droppedDetail).toEqual(["c: a row only the daemon answer has"]);
  });
});

// R951 R2-R6: skip reasons, replacement, kept one-shot answers, the session-long set.
describe("R951 R2-R6: replacement samples, kept one-shot answers", () => {
  // Six whole codeunits; the plan samples the 2nd (index 1) and the last (index 5).
  const CUS = [79110, 79111, 79112, 79113, 79114, 79115];
  for (const c of CUS) SUITE_METHODS[c] = ["T"];
  const SUITE6 = CUS.map((c) => ref("T", c));
  const six = (o: RigOpts = {}) => dbRig({ suite: SUITE6, ...o });
  /** Make one-shot runs of the listed codeunits give `made` instead of a process. */
  const stubCus = (b: AlRunnerV3Backend, made: Record<number, unknown>, seen: number[] = []) => {
    const holder = b as unknown as {
      spawnCodeunit: (...a: { id: number }[]) => Promise<unknown>;
    };
    const real = holder.spawnCodeunit.bind(b);
    holder.spawnCodeunit = async (...a) => {
      const id = a[0]?.id ?? 0;
      seen.push(id);
      // Only the first spawn of a codeunit (the cross-check) is stubbed; its live call runs as usual.
      const stub = seen.filter((x) => x === id).length === 1 ? made[id] : undefined;
      return stub ?? real(...a);
    };
    return seen;
  };
  const rep = (r: Rig) => r.b.daemonBaselineReport();

  test("no skip: nothing replaced, sums unchanged", async () => {
    const r = await six();
    await baseline(r.b, SUITE6);
    expect(rep(r)).toMatchObject({
      replaced: 0,
      compared: 2,
      served: 4,
      sampledSkipped: [],
      dropped: undefined,
    });
  });

  test("a skipped middle sample (wall timeout) is replaced FORWARD; the report names reason and replacement", async () => {
    const r = await six();
    stubCus(r.b, { [CUS[1] ?? 0]: { timedOut: true, wallMs: 1 } });
    await baseline(r.b, SUITE6);
    expect(rep(r)).toMatchObject({
      dropped: undefined,
      compared: 2,
      replaced: 1,
      sampledSkipped: [`Codeunit${CUS[1]} (timed-out)`],
      replacements: { [`Codeunit${CUS[1]}`]: `Codeunit${CUS[2]}` },
      served: 3, // 6 - 2 samples - 1 replacement
    });
  });

  test("a skipped LAST sample is replaced BACKWARD (the last unsampled codeunit)", async () => {
    const r = await six();
    stubCus(r.b, { [CUS[5] ?? 0]: { spawnError: "boom", wallMs: 0 } });
    await baseline(r.b, SUITE6);
    expect(rep(r)).toMatchObject({
      dropped: undefined,
      compared: 2,
      replaced: 1,
      sampledSkipped: [`Codeunit${CUS[5]} (spawn-error)`],
      replacements: { [`Codeunit${CUS[5]}`]: `Codeunit${CUS[4]}` },
      served: 3,
    });
  });

  test("too few clean samples drops by name; a drop with all samples skipped keeps nothing from the daemon", async () => {
    const seen: [string, string][] = [];
    const r = await six({ notify: (c, m) => seen.push([c, m]) });
    const bad = { timedOut: true, wallMs: 1 };
    // Every codeunit's one-shot run times out: samples and their replacements all skip.
    stubCus(r.b, Object.fromEntries(CUS.slice(1).map((c) => [c, bad])));
    await baseline(r.b, SUITE6);
    expect(dropNotice(seen)[0]?.[1]).toContain("too few clean cross-check samples: 0 of 2");
    expect(rep(r).served).toBe(0);
  });

  test("R3: after a drop the one-shot answers already obtained are served with no second call; nothing a daemon answered is", async () => {
    const seen: [string, string][] = [];
    // The last sample differs between daemon and process: the drop comes after sample 1 was compared.
    const leakLast: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CUS[5] && d >= 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
      );
    const r = await six({
      notify: (c, m) => seen.push([c, m]),
      serve: { rows: leakLast },
      oneShotRows: allPass,
    });
    await baseline(r.b, SUITE6);
    expect(dropNotice(seen)).toHaveLength(1);
    // CUS[1] was compared one-shot before the drop: its baseline call is served from the kept store
    // (one process in all); CUS[5] ran twice (the cross-check, then its own live call); the others once.
    const spawns = (id: number) => oneShotCodeunits(r).filter((x) => x === String(id)).length;
    expect(spawns(CUS[1] ?? 0)).toBe(1);
    expect(spawns(CUS[5] ?? 0)).toBe(2);
    expect(spawns(CUS[0] ?? 0)).toBe(1);
    expect(rep(r).served).toBe(0);
  });

  test("R3: a deploy clears the kept one-shot answers", async () => {
    const r = await six();
    const kept = (b: AlRunnerV3Backend) => b as unknown as { oneShotKept: Map<number, unknown> };
    kept(r.b).oneShotKept.set(1, {});
    (r.b as unknown as { resetLayoutState(): void }).resetLayoutState();
    expect(kept(r.b).oneShotKept.size).toBe(0);
  });

  test("R6: a codeunit whose sample was skipped is never served from the daemon, and the set survives a deploy", async () => {
    const r = await six();
    stubCus(r.b, { [CUS[1] ?? 0]: { timedOut: true, wallMs: 1 } });
    await baseline(r.b, SUITE6);
    const unclean = (b: AlRunnerV3Backend) =>
      (b as unknown as { uncleanCalls: Set<number> }).uncleanCalls;
    expect([...unclean(r.b)]).toEqual([CUS[1] ?? 0]);
    await r.b.deploy(r.l.batch);
    expect([...unclean(r.b)]).toEqual([CUS[1] ?? 0]);
    // A second fill (the next batch) asks the daemon for every codeunit but that one.
    const before = r.serve.requests.length;
    await baseline(r.b, SUITE6);
    const asked = r.serve.requests.slice(before).map((q) => q.ids[0]);
    expect(asked).not.toContain(`plain:Codeunit${CUS[1]}.`);
    expect(asked).toContain(`plain:Codeunit${CUS[0]}.`);
  });

  test("R5: the per-test fill (--isolate-tests) skips and replaces the same way", async () => {
    const r = await six({ extra: { isolateTests: true } });
    stubCus(r.b, { [CUS[1] ?? 0]: { timedOut: true, wallMs: 1 } });
    await baseline(r.b, SUITE6);
    expect(rep(r)).toMatchObject({
      dropped: undefined,
      compared: 2,
      replaced: 1,
      sampledSkipped: [`Tests${CUS[1]}.T (timed-out)`],
      replacements: { [`Tests${CUS[1]}.T`]: `Tests${CUS[2]}.T` },
      served: 3,
    });
  });

  test("R6: a spent budget starts no replacement", async () => {
    let spawned: number[] = [];
    const r = await six({
      stopHandle: {
        // spent once the first (skipped) sample's one-shot run is over
        spent: () => spawned.length >= 1,
        signalled: () => false,
        stopForMemory: () => {},
      },
    });
    spawned = stubCus(r.b, { [CUS[1] ?? 0]: { timedOut: true, wallMs: 1 } });
    await baseline(r.b, SUITE6);
    expect(rep(r)).toMatchObject({ replaced: 0, dropped: undefined });
  });

  test("review 1: a per-test fill that drops after the whole-codeunit fill served nothing a daemon answered", async () => {
    const A1 = 79210;
    const B1 = 79211;
    const C1 = 79212;
    const D1 = 79213;
    SUITE_METHODS[A1] = ["T"];
    SUITE_METHODS[B1] = ["T"];
    SUITE_METHODS[C1] = ["T"];
    SUITE_METHODS[D1] = ["T", "U"];
    const suite = [ref("T", D1), ref("U", D1), ref("T", A1), ref("T", B1), ref("T", C1)];
    // The per-test sample (D1.U) differs between daemon and process: the drop comes AFTER the
    // whole-codeunit fill has put A1's daemon answer (and two kept shots) into the store.
    const leakU: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === D1 && x.method === "U" && d >= 0
          ? { ...x, status: "fail" as const, message: "leaked" }
          : x,
      );
    const seen: [string, string][] = [];
    const r = await dbRig({
      suite,
      notify: (c, m) => seen.push([c, m]),
      serve: { rows: leakU },
      oneShotRows: allPass,
      extra: { isolation: "auto" },
    });
    r.b.baselinePhase(true);
    try {
      r.b.chooseIsolation(D1, "method");
    } finally {
      r.b.baselinePhase(false);
    }
    await baseline(r.b, suite);
    expect(dropNotice(seen)).toHaveLength(1);
    expect(rep(r).served).toBe(0);
    // A1 was never a sample: its only process is its own live call (a daemon answer in the kept
    // store would have been served with no process). B1 and C1 were samples: one process each, kept.
    const spawns = (id: number) => oneShotCodeunits(r).filter((x) => x === String(id)).length;
    expect(spawns(A1)).toBe(1);
    expect(spawns(B1)).toBe(1);
    expect(spawns(C1)).toBe(1);
  });

  test("review 2: a one-shot sample answer with a duplicated row is not served (the live path's row check)", async () => {
    const dupC: RowsFn = (m, cu, d, n) => {
      const rows = allPass(m, cu, d, n);
      const c = rows.find((x) => x.method === "C");
      return c === undefined ? rows : [...rows, c];
    };
    const seen: [string, string][] = [];
    const r = await dbRig({
      suite: SUITE2,
      notify: (c, m) => seen.push([c, m]),
      serve: { rows: allPass },
      oneShotRows: dupC,
    });
    await baseline(r.b, SUITE2).catch(() => {}); // the live one-shot call refuses the duplicate too
    expect(dropNotice(seen)).toHaveLength(1);
    expect(rep(r).droppedDetail).toEqual(["one-shot-row-count"]);
  });

  test("review 2: serving an exit-8 one-shot answer (daemonBaseline) raises the .NET-helper notice", async () => {
    const seen: [string, string][] = [];
    const r = await dbRig({
      suite: SUITE2,
      notify: (c, m) => seen.push([c, m]),
      oneShotAnswer: { exitCode: 8, stderr: "" },
    });
    await baseline(r.b, SUITE2);
    expect(rep(r)).toMatchObject({ dropped: undefined, compared: 1 });
    // CU2's sample (exit 8) was served, not re-run: its one process is the cross-check.
    expect(oneShotCodeunits(r).filter((x) => x === String(CU2))).toHaveLength(1);
    expect(seen.filter(([c]) => c === "al-runner-v3-dotnet-helper-missing")).toHaveLength(1);
  });

  test("review 2: serving an exit-8 one-shot answer from the kept store raises the notice too", async () => {
    const seen: [string, string][] = [];
    const leakLast: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CUS[5] && d >= 0 ? { ...x, status: "fail" as const, message: "leaked" } : x,
      );
    const r = await six({
      notify: (c, m) => seen.push([c, m]),
      serve: { rows: leakLast },
      oneShotRows: allPass,
    });
    // CUS[1]'s cross-check process exits 8; every other process exits 0.
    const holder = r.b as unknown as {
      spawnCodeunit: (...a: { id: number }[]) => Promise<{ res: { exitCode: number } }>;
    };
    const real = holder.spawnCodeunit.bind(r.b);
    let first = true;
    holder.spawnCodeunit = async (...a) => {
      const made = await real(...a);
      if (a[0]?.id !== CUS[1] || !first) return made;
      first = false;
      return { ...made, res: { ...made.res, exitCode: 8 } };
    };
    await baseline(r.b, SUITE6);
    expect(dropNotice(seen)).toHaveLength(1);
    const spawns = oneShotCodeunits(r).filter((x) => x === String(CUS[1])).length;
    expect(spawns).toBe(1); // served from the kept store, not re-run
    expect(seen.filter(([c]) => c === "al-runner-v3-dotnet-helper-missing")).toHaveLength(1);
  });

  test("review 3: a forward replacement the loop never reaches is not counted", async () => {
    let n = 0;
    const r = await six({
      // spent() is read at each loop top and once after the skipped sample's run: the 4th read is
      // the loop top before the replacement (CUS[2]), where the fill stops.
      stopHandle: { spent: () => ++n >= 4, signalled: () => false, stopForMemory: () => {} },
    });
    stubCus(r.b, { [CUS[1] ?? 0]: { timedOut: true, wallMs: 1 } });
    await baseline(r.b, SUITE6);
    const d = rep(r);
    expect(d.sampledSkipped).toEqual([`Codeunit${CUS[1]} (timed-out)`]);
    expect(d).toMatchObject({ replaced: 0, replacements: {} });
    // The first sum holds for what was reached: 1 sample, skipped by name, nothing replaced.
    expect(judgeDaemonBaseline("DB", d, 0, 1).fail ?? "").not.toContain("in all plus");
  });
});
