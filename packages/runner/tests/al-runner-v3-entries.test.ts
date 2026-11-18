// R635: the serve + entries transport of the al-runner v3 backend, against a scripted fake
// `serve` daemon and a fake one-shot v3. Plan
// docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md (r3) §9, tests 1-13 and 16-21; the
// orchestrator's seams (tests 14, 15) are in orchestrator.test.ts. Call counters, no wall clock.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  AlRunnerV3BaselineUniformlyRefusedError,
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
  MEMORY_WATCH_OVER_TICKS,
  SPECULATE_BASELINE_ENV,
  UniformRefusalWatch,
  type V3KeptDrift,
  type V3RequestSized,
  V3_AUTO_METHOD_ONE_SHOT,
  V3_ROUTINE_CLOSES,
  V3_UNIFORM_REFUSAL_CODEUNITS,
  WINDOW_BOUND_CAVEAT,
  pickV3Timings,
  unkeptRowReason,
  v3CallDeadlineMs,
  v3DaemonClosesText,
  warmupCause,
} from "../src/al-runner-v3-backend";
import { BATCH_FORBIDDEN_FIELDS } from "../src/al-runner-v3-baseline-batch";
import type { PeakProbe } from "../src/al-runner-v3-baseline-check";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import {
  AlRunnerV3EntriesEncodeError,
  AlRunnerV3EntriesRefusedError,
  ENTRIES_CHUNK_CAP,
  ENTRIES_UNMEASURED_CAP,
  type EntryGroup,
  SELECTOR_ECHO_FILENAME,
  type SentEntry,
  batchRefusalReason,
  chunkGroups,
  decodeEntriesAnswer,
  effectiveExclusion,
  emitSelectorEcho,
  encodeGroups,
  groupsThatFit,
  missingKeptTests,
  selectedOnlyDecision,
  assertEntriesWellFormed as wellFormed,
} from "../src/al-runner-v3-entries";
import { AlRunnerV3SeedError } from "../src/al-runner-v3-seed";
import { AlcCompileError, type ArtifactIo, ArtifactPrepareError } from "../src/artifact";
import type {
  RunOpts,
  TestMethodRef,
  TestVerdict,
  V3BaselineOneShotTimed,
  V3RequestTimed,
} from "../src/backend";
import { buildBackend } from "../src/cli";
import { baselineSourceTag } from "../src/orchestrator";
import { splitBackend } from "../src/parallel-queue";
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

/** PR-115: test codeunits `layout` writes with a `trigger OnRun`; a test sets and clears it. */
const ONRUN_CUS = new Set<number>();
/** PR-123: test codeunits `layout` writes with `Subtype = Normal`, so the source scan does not see them as tests. */
const UNSCANNED_CUS = new Set<number>();

async function layout(
  targetAl: string,
  suite: readonly TestMethodRef[],
  appExtra: Record<string, unknown> = {},
): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "lethal-v3e-"));
  roots.push(root);
  const batch = join(root, "batch");
  const testDir = join(root, "tests");
  const deps = join(root, "deps");
  for (const d of [batch, testDir, deps]) await mkdir(d, { recursive: true });
  await writeFile(
    join(batch, "app.json"),
    JSON.stringify({ id: TARGET_ID, name: "T", version: "1.0.0.0", runtime: "17.0", ...appExtra }),
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
    const text = UNSCANNED_CUS.has(cu)
      ? testAl(cu, methods).replace("Subtype = Test;", "Subtype = Normal;")
      : testAl(cu, methods);
    // PR-115: a test codeunit named in ONRUN_CUS gets a `trigger OnRun` (the scan sends it alone).
    await writeFile(
      join(testDir, `Tests${cu}.Codeunit.al`),
      ONRUN_CUS.has(cu)
        ? text.replace(
            "Subtype = Test;",
            "Subtype = Test;\n    trigger OnRun()\n    begin\n    end;\n",
          )
        : text,
    );
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
  echo?: (mutant: string) => string,
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
    // R937: the selector's echo codeunit, run one-shot, reports the mutant it read from the file
    const source: FakeRow[] =
      cu === ECHO
        ? [
            {
              method: "Echo",
              status: "fail",
              message: (echo ?? ((x) => `LETHAL-ECHO:${x}:true`))(m),
            },
          ]
        : rows(m, cu, -1, -1);
    const asked = source.filter((r) => only === null || r.method === only[2]);
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
  /** R987: real milliseconds a request waits, after `stderr`, before it answers. */
  delayMs?: (req: Req, n: number) => number;
  /** PR-88: daemons whose server has no pid any more (as after a cut answer, R895). The test adds to it. */
  pidGone?: Set<number>;
  /** PR-115: a plain request with no `test` is a batch; it answers these codeunits less the `excludeTests` ones (default: every `Tests<cu>.Codeunit.al` in the test dir). */
  batchCus?: readonly number[];
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
      // R952: what the recycle bound's RSS seam is asked about (never a real /proc read)
      // (PR-88: undefined once the test marks the daemon gone; the cast keeps exactOptionalPropertyTypes quiet.)
      get pid(): number {
        return (script.pidGone?.has(daemon) === true ? undefined : 90_000 + daemon) as number;
      },
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
          // R987: a request that takes this long (real time) before it answers.
          const delay = script.delayMs?.(req, n) ?? 0;
          if (delay > 0) await Bun.sleep(delay);
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
          } else if (body.test === undefined) {
            // PR-115: a batch (no `test`): every codeunit's rows, less what `excludeTests` hides (a substring of the full name).
            const out = ((body.excludeTests as string[] | undefined) ?? []).map((x) =>
              x.toLowerCase(),
            );
            selected = new Set();
            const cov = { coverage: [] as unknown[], perTestCoverage: [] as unknown[] };
            const present = (await readdir(testDir))
              .map((f) => /^Tests(\d+)\.Codeunit\.al$/.exec(f)?.[1])
              .filter((x): x is string => x !== undefined)
              .map(Number);
            for (const cu of script.batchCus ?? present) {
              const rs = rowsOf(onDisk, cu).filter(
                (r) => !out.some((x) => `Codeunit${cu}.${r.method}`.toLowerCase().includes(x)),
              );
              if (rs.length === 0) continue;
              selected.add(cu);
              for (const r of rs) lines.push(testLine(cu, r));
              count(rs);
              if (body.coverage === true) {
                const doc = (script.coverage?.(onDisk, cu, active, testDir) ?? {
                  coverage: [],
                  perTestCoverage: [],
                }) as { coverage: unknown[]; perTestCoverage: unknown[] };
                cov.coverage.push(...doc.coverage);
                cov.perTestCoverage.push(...doc.perTestCoverage);
              }
            }
            if (body.coverage === true) extra = cov;
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
  /** PR-98: the lane views (empty unless `lanes` was asked). */
  readonly views: ReturnType<AlRunnerV3Backend["lanes"]>;
}

interface RigOpts {
  /** PR-98: build this many lane views before the deploy. */
  lanes?: number;
  /** PR-21: extra fields for the batch's app.json (e.g. a publisher). */
  appExtra?: Record<string, unknown>;
  serve?: ServeScript;
  oneShotRows?: RowsFn;
  oneShotCoverage?: CoverageFn;
  oneShotAnswer?: { readonly exitCode: number; readonly stderr: string };
  /** R937: the message of the echo row a one-shot echo process reports for the mutant it read. */
  oneShotEcho?: (mutant: string) => string;
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

/** PR-88: what the fake peak probe does (it never reads `/proc`). */
interface FakeProbeOpts {
  /** The reset write fails. */
  resetOk?: boolean;
  /** Added to `VmRSS` for the `VmHWM` read right after the reset (a reset that did not take). */
  hwmAtReset?: number;
  /** Added to `VmRSS` for the `VmHWM` read after the answer (a spike the sampler missed; may be negative). */
  spike?: number;
  /** The process is gone when the answer's read comes. */
  exited?: boolean;
}

/** PR-88: the first read after a reset is the verification, the next one is after the answer. */
function fakeProbe(
  o: FakeProbeOpts,
  rss: () => number,
  log?: string[],
  pids?: number[],
): PeakProbe {
  let reads = 0;
  return {
    reset(pid) {
      pids?.push(pid);
      log?.push("reset");
      reads = 0;
      return o.resetOk ?? true;
    },
    read(pid) {
      pids?.push(pid);
      log?.push("read");
      reads += 1;
      if (reads === 1) return { hwm: rss() + (o.hwmAtReset ?? 0), rss: rss() };
      if (o.exited === true) return undefined;
      return { hwm: rss() + (o.spike ?? 0), rss: rss() };
    },
  };
}

/** R952, R987: a backend built outside `rig` reads no daemon's RSS (the fakes' pids are made up). */
function noProcReads(b: AlRunnerV3Backend): void {
  Object.assign(b.seams, { rssReader: () => undefined, requestRssReader: () => undefined });
}

async function rig(opts: RigOpts = {}): Promise<Rig> {
  const suite = opts.suite ?? SUITE1;
  const l = await layout(opts.targetAl ?? TARGET_AL, suite, opts.appExtra);
  const serve = fakeServe(opts.serve);
  const one = fakeOneShot(
    opts.oneShotRows ?? opts.serve?.rows ?? allPass,
    opts.oneShotCoverage,
    opts.oneShotAnswer,
    opts.oneShotEcho,
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
  // R987: so is the per-request reading; with none, requests stay at the 16-entry probe.
  Object.assign(
    b.seams,
    { rssReader: () => undefined, requestRssReader: () => undefined },
    opts.seams ?? {},
  );
  if (opts.notify !== undefined) b.setNotify(opts.notify);
  if (opts.stopHandle !== undefined) b.useStopHandle(opts.stopHandle);
  const views = opts.lanes === undefined ? [] : b.lanes(opts.lanes);
  await b.deploy(l.batch);
  return { l, b, serve, one, views };
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
    noProcReads(b);
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
    const sunk: {
      lane?: number;
      reason: string;
      family?: string;
      text?: string;
      test?: string;
      phase?: string;
    }[] = [];
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
    // R1009: the whole first line too, which the family cuts
    expect(sunk).toEqual([
      {
        lane: 0,
        reason: "refusal",
        family: "WithEvents subscriber …",
        text: WITH_EVENTS,
        test: `Codeunit${CU}.A`,
        // PR-100: the request that held the refused row was a prefetch
        phase: "prefetch",
      },
    ]);
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

  // R1009 (coord PR-09): DO's stale-buffer close was known only by its cut family ("... after a lock other
  // tha"), so it could not be measured. The close carries the whole first line and the test.
  test("R1009: a refusal's whole first line rides along (text), where the family is cut", () => {
    const stale =
      "NotRun: out-of-scope: a stale Issued Reminder Header buffer from its own write, after a lock other than LockTable or a ReadIsolation read in the open transaction (not pinned)";
    const why = unkeptRowReason([
      {
        name: "Codeunit1.A",
        status: "error",
        notRun: true,
        message: `${stale}\nsecond line`,
      },
    ]);
    expect(why?.family).toBe(
      "a stale Issued Reminder Header buffer from its own write, after a lock other tha",
    );
    expect(why?.text).toBe(stale);
    expect(why?.test).toBe("Codeunit1.A");
    // a timeout carries none
    expect(
      unkeptRowReason([
        { name: "Codeunit1.A", status: "error", notRun: false, message: TIMEOUT_1S },
      ])?.text,
    ).toBeUndefined();
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

    test("R987: a request the memory bound made small is judged in its 256-entry chunk", async () => {
      // 20 mutants, 40 entries: nothing measured, so 16 groups (32 entries) go first and the last 4
      // (8 entries) alone. Those 4 are refused; the first request ran, and both lie in one 256-entry
      // chunk, so it is no batch stop (it would be if the chunk were the request).
      const twenty = plans(
        Array.from({ length: 20 }, (_, i) => `M${String(i + 1).padStart(4, "0")}`),
      );
      const last4 = twenty.slice(16).map((p) => p.mutantId);
      const r = await rig({ serve: refuseOnly(last4), oneShotRows: allPass });
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(twenty, { batchPlans: twenty }); // no AlRunnerV3EntriesRefusedError
      // Split as said (the refused tail is then re-sent once, on a fresh daemon).
      expect(r.b.entriesStats().prefetchRequests).toBeGreaterThanOrEqual(2);
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
    // PR-99 (§10.6, build review #4): the session's warm-ups, summed over the lanes (the only lane here).
    (r.b as unknown as { lane: { stats: { warmups: number } } }).lane.stats.warmups =
      earlierWarmups;
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

  // R998 (review 1): the coverage request leaves out what the entry left out, or the two disagree on the
  // left-out test's row and the pass is never scored.
  test("R998: a left-out test is left out of the coverage request too, so the pass is scored", async () => {
    const bRefused: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B"
          ? {
              ...x,
              status: "error" as const,
              notRun: true,
              message: "NotRun: out-of-scope: InStream method on an unassigned Variant",
            }
          : x,
      );
    const { r, n0 } = await windowOf({ serve: { rows: bRefused }, oneShotRows: bRefused });
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
    const cov = since(r, n0).find((q) => q.body.coverage === true);
    expect(cov?.body.excludeTests).toEqual([`Codeunit${CU}.B`]);
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
      "DBM",
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

describe("R987: entries per serve request follow the daemon growth measured per codeunit", () => {
  const GiB = 2 ** 30;
  const g = (mutantId: string, ...codeunits: number[]): EntryGroup => ({ mutantId, codeunits });

  test("groupsThatFit: 16 unmeasured codeunit entries, 4 GiB of measured cost, 256 entries, never 0", () => {
    const none = () => undefined;
    expect(ENTRIES_UNMEASURED_CAP).toBe(16);
    // Unmeasured: 8 groups of two codeunits fill the 16; the 9th waits.
    expect(
      groupsThatFit(
        Array.from({ length: 12 }, (_, i) => g(`M${i}`, 1, 2)),
        none,
      ),
    ).toBe(8);
    // Measured at 1 GiB an entry: 4 codeunit entries fit 4 GiB (the echo costs nothing).
    expect(
      groupsThatFit(
        Array.from({ length: 9 }, (_, i) => g(`M${i}`, 1)),
        () => GiB,
      ),
    ).toBe(4);
    // Measured at no cost: only the 256 entries bound it (128 groups of two entries).
    expect(
      groupsThatFit(
        Array.from({ length: 300 }, (_, i) => g(`M${i}`, 1)),
        () => 0,
      ),
    ).toBe(128);
    // A first group over every bound still goes alone.
    expect(groupsThatFit([g("M0", 1, 2, 3), g("M1", 1)], () => 8 * GiB)).toBe(1);
    expect(groupsThatFit([], none)).toBe(0);
  });

  /**
   * The fake daemon's RSS is the floor plus, per entry, its codeunit's cost (`perCu`, echo free).
   * `shrink`: it rises when the request arrives and falls back to the floor before the answer, the
   * request lasting 450 ms, so only the 200 ms sampler sees the peak. Otherwise it is set when the
   * request answers and never falls (a daemon that does not shrink back). Every request's size is
   * recorded; a daemon's first request is its warm-up, neither counted nor grown.
   */
  const prefetchOf = async (
    perCu: ReadonlyMap<number, number>,
    planned: { mutantId: string; refs: readonly TestMethodRef[] }[],
    /** `stack`: each request grows the daemon on top of what earlier ones left (it keeps it all). */
    o: {
      rows?: RowsFn;
      shrink?: boolean;
      stack?: boolean;
      /** PR-88: a fake peak probe over the fake daemon (default: none, the sampler alone). */
      probe?: FakeProbeOpts;
      /** PR-88: collects the `serve-request-sized` events. */
      sized?: V3RequestSized[];
      /** PR-88: collects the notices' messages. */
      messages?: string[];
      /** PR-88: collects the order of the probe calls and the fake daemon's answers. */
      log?: string[];
      /** PR-88: the pids the fake probe was called with. */
      pids?: number[];
      /** PR-88: the daemon has no pid once it answered its first counted request (as after a cut, R895). */
      exits?: boolean;
    } = {},
  ) => {
    const gone = new Set<number>();
    const floor = 0.5 * GiB;
    const mem = { level: floor };
    const sizes: number[] = [];
    const notes: string[] = [];
    const warm = new Set<number>();
    const grown = (q: Req) => {
      const entries = (q.body.entries ?? []) as { test?: unknown }[];
      let b = floor;
      for (const e of entries) {
        const cu = Number(/^Codeunit(\d+)\./.exec(String(e.test))?.[1]);
        b += perCu.get(cu) ?? 0;
      }
      return b;
    };
    const counted = (q: Req) => {
      if (warm.has(q.daemon)) return true;
      warm.add(q.daemon);
      return false;
    };
    const r = await rig({
      suite: SUITE2,
      ...(o.rows !== undefined ? { oneShotRows: o.rows, pairBatch: true } : {}),
      serve: {
        pidGone: gone,
        ...(o.rows !== undefined ? { rows: o.rows } : {}),
        ...(o.shrink === true
          ? {
              stderr: (q) => {
                if (counted(q)) {
                  sizes.push(q.ids.length);
                  mem.level = grown(q);
                }
                return undefined;
              },
              delayMs: (q) => (warm.has(q.daemon) && q.ids.length > 1 ? 450 : 0),
              answer: () => {
                mem.level = floor;
                return undefined;
              },
            }
          : {
              answer: (q) => {
                o.log?.push("answer");
                if (counted(q)) {
                  if (o.exits === true) gone.add(q.daemon);
                  sizes.push(q.ids.length);
                  mem.level =
                    o.stack === true ? mem.level + grown(q) - floor : Math.max(mem.level, grown(q));
                }
                return undefined;
              },
            }),
      },
      seams: {
        requestRssReader: () => mem.level,
        ...(o.probe !== undefined
          ? { peakProbe: fakeProbe(o.probe, () => mem.level, o.log, o.pids) }
          : {}),
      },
      notify: (code, message) => {
        notes.push(code);
        o.messages?.push(message);
      },
    });
    if (o.sized !== undefined) {
      const into = o.sized;
      r.b.setRequestSizedSink((e) => into.push(e));
    }
    await baseline(r.b, SUITE2);
    sizes.length = 0; // the prefetch's requests only
    await r.b.prefetchMutants(planned);
    return { sizes, notes, s: r.b.entriesStats() };
  };
  const mids = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `M${String(from + i).padStart(4, "0")}`);
  const onCu = (ids: string[]) => ids.map((mutantId) => ({ mutantId, refs: SUITE1 }));
  const onCu2 = (ids: string[]) => ids.map((mutantId) => ({ mutantId, refs: [ref("C", CU2)] }));

  test("a high reading caps every later request at what fits 4 GiB, and says so once", async () => {
    // 60 groups of two entries (echo + one test entry). 16 unmeasured, which grow the daemon 8 GiB:
    // 0.5 GiB a test entry (the echoes are not counted), so 8 groups a request. The later requests read
    // no growth (the daemon does not shrink back); the highest cost seen still holds.
    const high = await prefetchOf(new Map([[CU, 0.5 * GiB]]), onCu(mids(1, 60)));
    expect(high.sizes).toEqual([32, 16, 16, 16, 16, 16, 8]);
    expect(high.notes.filter((c) => c === "al-runner-v3-entries-cap-lowered")).toEqual([
      "al-runner-v3-entries-cap-lowered",
    ]);
  });

  test("a low reading lets the requests grow to 256 entries", async () => {
    const low = await prefetchOf(new Map([[CU, 2 ** 20]]), onCu(mids(1, 60)));
    expect(low.sizes).toEqual([32, 88]);
    expect(low.notes).not.toContain("al-runner-v3-entries-cap-lowered");
  });

  test("a request that grew the daemon by nothing, near its floor, is a reading of no cost", async () => {
    // The gate fixtures: a request often grows the daemon by 0 bytes. Near the floor that is cheap,
    // not unknown: the next request is not held to 16 unmeasured test entries.
    const none = await prefetchOf(new Map([[CU, 0]]), onCu(mids(1, 60)));
    expect(none.sizes).toEqual([32, 88]);
  });

  test("a request that reuses memory an earlier one left is no reading: a heavy codeunit after another stays unmeasured", async () => {
    // 16 groups on CU (0.5 GiB a test entry) leave the daemon at 8.5 GiB. CU2 is as heavy, but its first
    // request reuses that memory, so its peak is 8.5 GiB again: read as growth from its start it would
    // cost 0, and the rest of CU2 would go in one request. It is no reading: CU2 stays unmeasured, 16 at a time.
    const reused = await prefetchOf(
      new Map([
        [CU, 0.5 * GiB],
        [CU2, 0.5 * GiB],
      ]),
      [...onCu(mids(1, 16)), ...onCu2(mids(17, 48))],
    );
    expect(reused.sizes).toEqual([32, 32, 32, 32]);
  });

  test("growth is read from the daemon's floor, not from a request's higher start", async () => {
    // A daemon that keeps what each request grew it by. 16 groups on CU at 0.125 GiB a test entry:
    // +2 GiB, to 2.5 GiB. Then 16 groups on CU2 at 0.25: +4 GiB on top, to 6.5 GiB. From its 2.5 GiB
    // start CU2 would read 0.25 GiB a test entry (4 / 16) and the next request take 16 groups; from the
    // 0.5 GiB floor it reads 0.375 (6 / 16), so 10 groups (3.75 GiB), 20 entries.
    const mem = await prefetchOf(
      new Map([
        [CU, 0.125 * GiB],
        [CU2, 0.25 * GiB],
      ]),
      [...onCu(mids(1, 16)), ...onCu2(mids(17, 60))],
      { stack: true },
    );
    expect(mem.sizes.slice(0, 3)).toEqual([32, 32, 20]);
  });

  test("a codeunit no request has measured goes 16 at a time, even after cheap ones", async () => {
    // 30 cheap groups on CU, then 30 on CU2, which no request has run (and which is heavy).
    const late = await prefetchOf(
      new Map([
        [CU, 2 ** 20],
        [CU2, 0.25 * GiB],
      ]),
      [...onCu(mids(1, 30)), ...onCu2(mids(31, 30))],
    );
    // 16 CU groups (unmeasured), then the 14 cheap ones left and 16 of CU2, then CU2 by its cost.
    expect(late.sizes[0]).toBe(32);
    expect(late.sizes[1]).toBe(60);
    expect(late.sizes.reduce((a, b) => a + b, 0)).toBe(120);
  });

  test("the sampler sees a peak the daemon gives back before the request ends", async () => {
    const shrinking = await prefetchOf(new Map([[CU, 0.5 * GiB]]), onCu(mids(1, 60)), {
      shrink: true,
    });
    expect(shrinking.sizes).toEqual([32, 16, 16, 16, 16, 16, 8]);
  });

  test("the kill-pair batches follow the measured cost: 4 pairs a request", async () => {
    const killsAll: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((r) =>
        r.method === "A" ? { ...r, status: "fail" as const, message: "boom" } : r,
      );
    const high = await prefetchOf(new Map([[CU, 0.5 * GiB]]), onCu(mids(1, 60)), {
      rows: killsAll,
    });
    expect(high.s.pairBatchStored).toBe(60);
    // A pair is its two test entries (NONE and M) at 0.5 GiB: 4 fit 4 GiB, so 15 requests (1 at 256).
    expect(high.s.pairBatchRequests).toBe(15);
  });

  describe("PR-88: the true peak of a request", () => {
    const heavy = new Map([[CU, 0.5 * GiB]]);
    const run = (
      probe: FakeProbeOpts | undefined,
      extra: { cu2?: boolean; exits?: boolean } = {},
    ) => {
      const sized: V3RequestSized[] = [];
      const messages: string[] = [];
      const log: string[] = [];
      const pids: number[] = [];
      const planned =
        extra.cu2 === true
          ? [...onCu(mids(1, 16)), ...onCu2(mids(17, 16)), ...onCu(mids(33, 30))]
          : onCu(mids(1, 60));
      const perCu = extra.cu2 === true ? new Map([...heavy, [CU2, 0.5 * GiB]]) : heavy;
      return prefetchOf(perCu, planned, {
        ...(probe !== undefined ? { probe } : {}),
        sized,
        messages,
        log,
        pids,
        ...(extra.exits === true ? { exits: true } : {}),
      }).then((r) => ({ ...r, sized, messages, log, pids }));
    };
    const MiB = 2 ** 20;

    test("the high-water mark is reset right before each send, and read after the answer", async () => {
      const r = await run({});
      // The warm-up answers first, unprobed. Then per request: reset, the verification read, the
      // daemon's answer, the read after it.
      expect(r.log.join(" ")).toMatch(/^answer( reset read answer read)+$/);
      expect(r.log.filter((x) => x === "answer").length).toBeGreaterThan(1);
    });

    test("a verified reset: the peak is max(VmHWM, sampled peak), from the hwm", async () => {
      const r = await run({ spike: GiB });
      const first = r.sized[0];
      expect(first).toBeDefined();
      expect(first?.peakSource).toBe("hwm");
      // The sampler saw 8.5 GiB; the daemon's own high-water mark was a GiB higher.
      expect(first?.sampledPeak).toBe(8.5 * GiB);
      expect(first?.hwm).toBe(9.5 * GiB);
      expect(first?.g).toBe(9 * GiB);
      // Charged at 9 GiB over 16 test entries, not 8: fewer entries fit 4 GiB than at the sampled cost.
      expect(first?.calls).toEqual([{ call: CU, entries: 16, cost: (9 * GiB) / 16 }]);
      expect(r.sizes[1]).toBe(14);
      expect(r.notes).not.toContain("al-runner-v3-peak-unverified");
    });

    test("a sampled peak above the high-water mark still stands (the sampler is a floor)", async () => {
      const r = await run({ spike: -GiB });
      const first = r.sized[0];
      expect(first?.peakSource).toBe("sampled");
      expect(first?.g).toBe(8 * GiB);
      expect(first?.hwm).toBe(7.5 * GiB);
      expect(r.sizes[1]).toBe(16);
    });

    test("an unreset VmHWM far from VmRSS falls back to the sampled peak, and says so once", async () => {
      const r = await run({ hwmAtReset: GiB, spike: 4 * GiB });
      expect(r.sized[0]?.peakSource).toBe("sampled");
      expect(r.sized[0]?.hwm).toBeUndefined();
      expect(r.sized[0]?.g).toBe(8 * GiB);
      expect(r.sizes[1]).toBe(16);
      expect(r.notes.filter((c) => c === "al-runner-v3-peak-unverified")).toEqual([
        "al-runner-v3-peak-unverified",
      ]);
    });

    test("a failed reset write falls back the same way", async () => {
      const r = await run({ resetOk: false, spike: 4 * GiB });
      expect(r.sized[0]?.peakSource).toBe("sampled");
      expect(r.sizes[1]).toBe(16);
      expect(r.notes.filter((c) => c === "al-runner-v3-peak-unverified").length).toBe(1);
    });

    test("a process that is gone when the answer's read comes keeps the sampled reading", async () => {
      const r = await run({ exited: true });
      // Never a dropped reading (a cut answer, R895): the sampler's 8.5 GiB peak raises the cost as before.
      const first = r.sized[0];
      expect(first?.peakSource).toBe("sampled");
      expect(first?.hwm).toBeUndefined();
      expect(first?.g).toBe(8 * GiB);
      expect(r.sizes[1]).toBe(16);
      expect(r.notes).toContain("al-runner-v3-entries-cap-lowered");
    });

    test("a daemon whose server exited before the read is not read (a reused pid), the sampled reading stands", async () => {
      const r = await run({ spike: 4 * GiB }, { exits: true });
      const first = r.sized[0];
      expect(first?.peakSource).toBe("sampled");
      expect(first?.hwm).toBeUndefined();
      expect(first?.g).toBe(8 * GiB);
      // Reset and verification read only: no read after the answer (nor any probe call on the pid-less daemon).
      expect(r.log.slice(0, 4)).toEqual(["answer", "reset", "read", "answer"]);
      expect(r.log.slice(4).every((x) => x === "answer")).toBe(true);
    });

    test("the probe is called with the fake daemon's pid", async () => {
      const r = await run({});
      expect(r.pids.length).toBeGreaterThan(0);
      expect([...new Set(r.pids)]).toEqual([90_000]);
    });

    test("the reset check is exact at 64 MiB: 64 MiB is verified, 64 MiB and one byte is not", async () => {
      const at = await run({ hwmAtReset: 64 * MiB, spike: GiB });
      expect(at.sized[0]?.peakSource).toBe("hwm");
      expect(at.notes).not.toContain("al-runner-v3-peak-unverified");
      const over = await run({ hwmAtReset: 64 * MiB + 1, spike: GiB });
      expect(over.sized[0]?.peakSource).toBe("sampled");
      expect(over.notes).toContain("al-runner-v3-peak-unverified");
    });

    test("one cap line per call, once per call, in the spec's wording", async () => {
      const r = await run({}, { cu2: true });
      const lines = r.messages.filter((m) => m.includes("hold about"));
      expect(lines.length).toBe(2);
      expect(lines.filter((m) => m.includes(`codeunit ${CU} `)).length).toBe(1);
      expect(lines.filter((m) => m.includes(`codeunit ${CU2} `)).length).toBe(1);
      for (const l of lines)
        expect(l).toMatch(
          /requests carrying codeunit \d+ hold about \d+ test entries \(its highest measured cost: \d+ MiB per entry, from a hwm peak\)/,
        );
    });

    test("the event's G is read from the daemon's floor, not from a request's higher start", async () => {
      const sized: V3RequestSized[] = [];
      await prefetchOf(
        new Map([
          [CU, 0.125 * GiB],
          [CU2, 0.25 * GiB],
        ]),
        [...onCu(mids(1, 16)), ...onCu2(mids(17, 30))],
        { stack: true, sized },
      );
      // The second request starts at 2.5 GiB (what the first left), its floor is still 0.5 GiB.
      const second = sized.find((e) => e.start > e.floor);
      expect(second).toBeDefined();
      expect(second?.g).toBe((second?.sampledPeak ?? 0) - 0.5 * GiB);
      expect(second?.peakSource).toBe("sampled");
    });

    test("the event carries the request's figures", async () => {
      const r = await run({ spike: GiB });
      const e = r.sized[0];
      expect(e).toEqual({
        lane: 0,
        kind: "prefetch", // PR-103
        daemonRequest: 2, // the whole-union warm-up was the daemon's first
        daemonProved: 0,
        daemonProveGrowth: 0,
        fresh: true,
        calls: [{ call: CU, entries: 16, cost: (9 * GiB) / 16 }],
        floor: 0.5 * GiB,
        start: 0.5 * GiB,
        sampledPeak: 8.5 * GiB,
        hwm: 9.5 * GiB,
        g: 9 * GiB,
        peakSource: "hwm",
      });
    });
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
    // PR-102: a case with a 4th element `true` sends its pair uncut. A malformed answer (a missing row of a
    // test the cut keeps) makes a flagged request re-send unflagged (PR-94), which today's confirm does not do.
    const cases: Array<[string, ServeScript, number, boolean?]> = [
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
      ["NONE 0 rows", { rows: noneAtPair(() => []) }, 1, true],
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
      [
        "a suite test missing",
        { rows: noneAtPair((rs) => rs.filter((x) => x.method !== "B")) },
        1,
        true,
      ],
    ];
    for (const [name, serve, saved, uncut] of cases) {
      test(`${name}: equal verdicts, ${saved} request(s) saved`, async () => {
        const today = await killed(serve);
        const t0 = today.serve.requests.length;
        const want = await confirmAndReproduce(today, false);
        const paired = await killed(serve);
        if (uncut === true) (paired.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU);
        const p0 = paired.serve.requests.length;
        const got = await confirmAndReproduce(paired, true);
        expect(got).toEqual(want);
        expect(today.serve.requests.length - t0 - (paired.serve.requests.length - p0)).toBe(saved);
      });
    }

    // PR-102 (L3): "NONE 0 rows" on the CUT path. NONE gives no rows on the daemon's later requests too.
    // The flagged pair lacks the kept A, so PR-94 discards it, puts the codeunit in neverFlag and re-sends
    // it unflagged and uncut; that answer is empty too, so the confirm throws as today's does.
    test("PR-102: NONE 0 rows on the cut path: a scan-gap re-send, neverFlag, and today's verdicts", async () => {
      const serve: ServeScript = {
        rows: (m, cu, d, n) => (m === "NONE" && d === 0 && n >= 2 ? [] : killsM1(m, cu, d, n)),
      };
      const today = await killed(serve);
      const want = await confirmAndReproduce(today, false);
      const r = await killed(serve);
      const n0 = r.serve.requests.length;
      const got = await confirmAndReproduce(r, true);
      const sent = r.serve.requests.slice(n0, n0 + 2).map((q) => q.body.runSelectedOnly);
      expect(sent).toEqual([true, undefined]);
      expect(
        (r.serve.requests[n0 + 1]?.body.entries as Record<string, unknown>[]).every(
          (e) => e.excludeTests === undefined,
        ),
      ).toBe(true);
      expect([...(r.b as unknown as { neverFlag: Set<number> }).neverFlag]).toEqual([CU]);
      expect(got).toEqual(want);
    });
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
      // PR-102: an uncut pair, so the timeout row B is inside the entry (a cut pair leaves B out)
      (r.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU);
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
      (r.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU); // PR-102: uncut pair
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

    // PR-102 (M1): the same fake, but the pair is CUT after the killer A. B (the timeout row) is left out,
    // so the cut never happens: no fallback, no daemon close, and the same verdicts as the uncut run.
    for (const a of ["fail", "pass"] as const) {
      test(`PR-102: P5c on the cut path (confirm ${a}): B is left out, nothing is cut or closed, verdicts equal the uncut run's`, async () => {
        const verdicts = async (r: Rig) => {
          await r.b.sendKillPair("M0001", A);
          await r.b.activate(null);
          const confirm = await settle(r.b.run(A, OPTS));
          await r.b.activate("M0001");
          const repro = await settle(r.b.run(A, OPTS));
          return { confirm, repro };
        };
        const uncut = await killed(cutAtNoneCodeunit(a));
        (uncut.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU);
        const want = await verdicts(uncut);
        const r = await killed(cutAtNoneCodeunit(a));
        const n0 = r.serve.requests.length;
        const s0 = r.b.entriesStats();
        const daemons0 = r.serve.daemons.length;
        const got = await verdicts(r);
        const q = r.serve.requests[n0];
        expect(q?.body.runSelectedOnly).toBe(true);
        const none = (q?.body.entries as Record<string, unknown>[]).find(
          (e) => e.id === `NONE|${CU}`,
        );
        expect(none?.excludeTests).toEqual([`Codeunit${CU}.B`]);
        const s1 = r.b.entriesStats();
        expect(s1.pairFallbacks1 - s0.pairFallbacks1).toBe(0);
        expect(s1.pairFallbacks2 - s0.pairFallbacks2).toBe(0);
        expect(s1.pairRequests - s0.pairRequests).toBe(1);
        expect(r.serve.daemons.length).toBe(daemons0); // no close, no restart
        expect(got).toEqual(want);
      });
    }

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
      "stop-signal", // R1014: the session ends, no warm-up follows
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
  // A named refusal R612 still closes on (R945 left it off the keep list: never measured). Until R968
  // this was `FindSet on the Company table`, which is now kept (`company-findset`).
  const COMPANY = "NotRun: out-of-scope: InStream method on an unassigned Variant";
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
  /**
   * R1004: the warm-up leaves out a test whose baseline row is a refusal the daemon cannot keep, so
   * R786 now applies to a refused test the warm-up has to keep: one whose name starts another test's
   * name (v3 matches `excludeTests` by prefix, so leaving out `B` would also drop the green `BB`).
   */
  const SUITE_BB = [ref("A"), ref("B"), ref("BB")];
  const bbRows =
    (message: string): RowsFn =>
    (m, cu, d, n) =>
      (cu === CU
        ? ["A", "B", "BB"].map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message }
          : x,
      );
  const prefetchBB = (r: Rig) =>
    r.b.prefetchMutants(plans(["M0001"], SUITE_BB)).catch((e: unknown) => e);

  test("default + a named refusal at the warm-up: the typed fallback signal, the daemon closed, no mutant entry sent", async () => {
    const r = asDefault(await rig({ suite: SUITE_BB, serve: { rows: bbRows(COMPANY) } }));
    await baseline(r.b, SUITE_BB);
    const err = await prefetchBB(r);
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(String(err)).toContain(`Codeunit${CU}.B`);
    expect(String(err)).toContain(COMPANY);
    expect(r.serve.requests.map((q) => q.ids[0])).toEqual(["NONE|echo"]);
    expect(r.serve.daemons).toHaveLength(1);
    expect(r.serve.closes).toEqual([{ daemon: 0, afterRequests: 1 }]);
  });

  test("explicit serve-entries + the same row: refuses warmup-dirty as before", async () => {
    const r = asDefault(
      await rig({ suite: SUITE_BB, serve: { rows: bbRows(COMPANY) } }),
      "explicit",
    );
    await baseline(r.b, SUITE_BB);
    const err = await prefetchBB(r);
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
    const r = asDefault(await rig({ suite: SUITE_BB, serve: { rows: bbRows(COMPANY) } }));
    await baseline(r.b, SUITE_BB);
    // The pair needs an activated mutant outside the baseline and no prefetch (so the daemon starts here).
    await r.b.activate("M0001");
    const seen: string[] = [];
    r.b.setNotify((c) => seen.push(c));
    const err = await r.b.sendKillPair("M0001", ref("A")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect(seen).toEqual([]);
  });
});

// R1004 (coord R-992): a test the baseline refused by name (both transports refuse it, and it decides
// no verdict) is left out of the warm-up request, so it neither dirties the warm-up daemon nor sends
// the default transport back to one-shot (R786). DO: R982's ZipArchive tests.
describe("R1004: the warm-up leaves out the tests the baseline refused by name", () => {
  const REFUSAL = "NotRun: out-of-scope: InStream method on an unassigned Variant";
  const bRefused: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((x) =>
      m === "NONE" && x.method === "B"
        ? { ...x, status: "error" as const, notRun: true, message: REFUSAL }
        : x,
    );
  const asSource = (r: Rig, source: "default" | "explicit") => {
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = source;
    return r;
  };
  const warmupEntry = (r: Rig) => {
    const q = r.serve.requests[0];
    const entries = (q?.body.entries as Record<string, unknown>[] | undefined) ?? [];
    return entries.find((e) => String(e.test) === `Codeunit${CU}.`);
  };

  for (const source of ["default", "explicit"] as const) {
    test(`${source}: a baseline-refused test is excluded, the warm-up is clean, and the prefetch goes on on serve`, async () => {
      const r = asSource(await rig({ serve: { rows: bRefused } }), source);
      await baseline(r.b, SUITE1);
      const out = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
      expect(out).not.toBeInstanceOf(Error);
      expect(warmupEntry(r)?.excludeTests).toEqual([`Codeunit${CU}.B`]);
      // The warm-up daemon was reused for the mutant entries: no close after the warm-up.
      expect(r.serve.daemons).toHaveLength(1);
      expect(r.serve.requests.length).toBeGreaterThan(1);
      expect(r.serve.closes).toEqual([]);
    });
  }

  // R998 (coord R-998): the mutant entries leave the same tests out (DO t1: 35 daemon closes, 3,625 s
  // of warm-ups, R-984). Red without the R998 change: every mutant request meets B's refusal and
  // closes its daemon, and with the exclusion but without suiteMissing's allowance, A reads row-missing.
  test("R998: the mutant entries leave it out too: no daemon closes on it, and the covering test's verdict reads as ever", async () => {
    const bAlways: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      );
    const r = asSource(await rig({ serve: { rows: bAlways } }), "default");
    await baseline(r.b, SUITE1);
    const covering = [ref("A")]; // B is refused at baseline, so it covers no mutant
    await r.b.prefetchMutants(plans(["M0001", "M0002"], covering));
    const mutantEntries = r.serve.requests
      .slice(1)
      .flatMap((q) => (q.body.entries as Record<string, unknown>[] | undefined) ?? [])
      .filter((e) => String(e.test) === `Codeunit${CU}.`);
    expect(mutantEntries.length).toBeGreaterThan(0);
    expect(mutantEntries.map((e) => e.excludeTests)).toEqual(
      mutantEntries.map(() => [`Codeunit${CU}.B`]),
    );
    expect(r.serve.closes).toEqual([]);
    expect(r.serve.daemons).toHaveLength(1);
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(v.outcome).toBe("pass");
  });

  // R998 (review 2-3): a refused test with a test after it stays in the mutant entries, so the test
  // after it starts from the baseline's state; the warm-up (which only compares) still leaves it out.
  test("R998: a refused test in the middle of its codeunit stays in the mutant entries (only a trailing run is left out)", async () => {
    const SUITE_ABC = [ref("A"), ref("B"), ref("C")];
    const bMid: RowsFn = (m, cu, d, n) =>
      (cu === CU
        ? ["A", "B", "C"].map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) =>
        x.method === "B" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      );
    const r = asSource(await rig({ suite: SUITE_ABC, serve: { rows: bMid } }), "default");
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("C")])).catch(() => {});
    expect(warmupEntry(r)?.excludeTests).toEqual([`Codeunit${CU}.B`]);
    const mutantEntries = r.serve.requests
      .slice(1)
      .flatMap((q) => (q.body.entries as Record<string, unknown>[] | undefined) ?? [])
      .filter((e) => String(e.test) === `Codeunit${CU}.`);
    expect(mutantEntries.length).toBeGreaterThan(0);
    expect(mutantEntries.every((e) => e.excludeTests === undefined)).toBe(true);
  });

  // PR-24 (L2): a restarted daemon's lazy warm-up leaves out what the whole-union warm-up does
  // (`leftOutNames`), not what a mutant entry does (`mutantLeftOutNames`): with B refused in the middle,
  // the two differ, and the warm-up must not run B (it would dirty the daemon it proves).
  test("PR-24: a restarted daemon's lazy warm-up leaves out the warm-up's tests, not the mutant entries'", async () => {
    const SUITE_ABC = [ref("A"), ref("B"), ref("C")];
    const bMid: RowsFn = (m, cu, d, n) =>
      (cu === CU
        ? ["A", "B", "C"].map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) =>
        x.method === "B" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      );
    const r = asSource(
      await rig({ suite: SUITE_ABC, serve: { rows: bMid }, extra: { daemonMaxRequests: 1 } }),
      "default",
    );
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("C")])).catch(() => {});
    await r.b.prefetchMutants(plans(["M0002"], [ref("A"), ref("C")])).catch(() => {});
    const lazy = r.serve.requests.filter(
      (q) => q.daemon >= 1 && q.ids.every((i) => i.startsWith("NONE|")),
    );
    expect(lazy.length).toBeGreaterThan(0);
    for (const q of lazy) {
      const entries = (q.body.entries as Record<string, unknown>[] | undefined) ?? [];
      const cuEntry = entries.find((e) => String(e.test) === `Codeunit${CU}.`);
      expect(cuEntry?.excludeTests).toEqual([`Codeunit${CU}.B`]);
    }
  });

  test("a refusal the daemon keeps (R945: Company FindSet) is not left out: the warm-up still runs it", async () => {
    const KEPT =
      "NotRun: out-of-scope: FindSet on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)";
    const keptB: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message: KEPT }
          : x,
      );
    const r = asSource(await rig({ serve: { rows: keptB } }), "default");
    await baseline(r.b, SUITE1);
    const out = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(out).not.toBeInstanceOf(Error);
    expect(warmupEntry(r)).toBeDefined();
    expect(warmupEntry(r)?.excludeTests).toBeUndefined();
  });

  test("a refused test whose name starts another test's name stays in (v3 excludes by prefix)", async () => {
    const SUITE_BB = [ref("A"), ref("B"), ref("BB")];
    const bb: RowsFn = (m, cu, d, n) =>
      (cu === CU
        ? ["A", "B", "BB"].map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message: REFUSAL }
          : x,
      );
    const r = asSource(await rig({ suite: SUITE_BB, serve: { rows: bb } }), "explicit");
    await baseline(r.b, SUITE_BB);
    const err = await r.b.prefetchMutants(plans(["M0001"], SUITE_BB)).catch((e: unknown) => e);
    expect(warmupEntry(r)?.excludeTests).toBeUndefined();
    expect(String(err)).toContain("al-runner-v3-entries-warmup-dirty");
  });

  test("a clean baseline sends no excludeTests at the warm-up", async () => {
    const r = asSource(await rig({}), "default");
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001"]));
    expect(warmupEntry(r)).toBeDefined();
    expect(warmupEntry(r)?.excludeTests).toBeUndefined();
  });

  test("a left-out test whose row comes back anyway is a disagreement, never a silent pass", async () => {
    // A daemon that ignores excludeTests: B's refused row returns, and the baseline (without B) disagrees.
    const r = asSource(await rig({ serve: { rows: bRefused } }), "default");
    await baseline(r.b, SUITE1);
    const realSend = (r.b as unknown as { send: (...a: unknown[]) => unknown }).send.bind(r.b);
    (r.b as unknown as { send: (...a: unknown[]) => unknown }).send = (...a: unknown[]) =>
      realSend(...a.slice(0, 6));
    const err = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-disagrees");
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
    /** PR-102: true sends the pairs uncut (the codeunit is never flagged), as before the cut existed. */
    uncut = false,
  ) => {
    let reqs: readonly Req[] = [];
    /** Request `n` is a batch: its first entry is a NONE pair group. */
    const isBatch = (n: number) => (reqs[n]?.ids[0] ?? "").startsWith("NONE#");
    const r = await rig({ serve: mk(isBatch), oneShotRows: allPass, suite, pairBatch: true });
    if (uncut) (r.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU);
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
      (
        r.b as unknown as { lane: { prefetch: { prefetched: Map<string, unknown> } } }
      ).lane.prefetch.prefetched = new Map();
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
      const store = (
        r.b as unknown as { lane: { prefetch: { pairStore: Map<string, { seq: number }> } } }
      ).lane.prefetch.pairStore;
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
      // PR-102: uncut pairs (a cut pair serves only a killer at or before the one it was cut after)
      const { r } = await batchRig(() => ({ rows: killsAll }), ["M0001"], [], SUITE1, true);
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
      const store = (r.b as unknown as { lane: { prefetch: { pairStore: Map<string, unknown> } } })
        .lane.prefetch.pairStore;
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
        const store = (
          r.b as unknown as { lane: { prefetch: { pairStore: Map<string, unknown> } } }
        ).lane.prefetch.pairStore;
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
        // PR-102: uncut pairs, so the unkept B row is inside the entry (a cut pair would leave B out)
        const { r, before } = await batchRig(mk, ["M0001", "M0002", "M0003"], [], SUITE1, true);
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

    // PR-102 (M1): case 0's fake on the cut path. B (the unkept row, after the killer A) is left out of
    // every pair entry, so the batch is not cut: one request, all three pairs stored and served, and the
    // same confirm and reproduction verdicts as the uncut run (where the cut kill takes today's pair).
    test("PR-102: case 0 on the cut path: B is left out, no cut, no re-send, verdicts equal the uncut run's", async () => {
      // case 0's cut (an unkept B after A in NONE_2's entry), but NONE_2's A passes, so a stored pair and
      // today's pair agree on the confirm
      const mk = (isBatch: (n: number) => boolean): ServeScript => ({
        rows: (m, cu, d, n, seen) =>
          d === 0 && isBatch(n) && m === "NONE" && seen === 1
            ? [{ method: "A", status: "pass" }, unkept()]
            : killsAll(m, cu, d, n),
      });
      const mutants = ["M0001", "M0002", "M0003"];
      const run = async (uncut: boolean) => {
        const { r } = await batchRig(mk, mutants, [], SUITE1, uncut);
        const got: unknown[] = [];
        for (const m of mutants) {
          await kill(r, m);
          got.push(await confirmAndRepro(r, m));
        }
        return { r, got };
      };
      const want = (await run(true)).got;
      const { r, got } = await run(false);
      const batch = r.serve.requests.filter((q) => (q.ids[0] ?? "").startsWith("NONE#"));
      expect(batch).toHaveLength(1);
      expect(batch[0]?.body.runSelectedOnly).toBe(true);
      const cuts = ((batch[0]?.body.entries as Record<string, unknown>[]) ?? [])
        .filter((e) => String(e.test) === `Codeunit${CU}.`)
        .map((e) => e.excludeTests);
      expect(cuts).toEqual(Array(6).fill([`Codeunit${CU}.B`]));
      expect(batchStats(r)).toEqual({ requests: 1, stored: 3, served: 3, refused: 0 });
      const s = r.b.entriesStats();
      expect([s.pairFallbacks1, s.pairFallbacks2]).toEqual([0, 0]);
      expect(r.serve.daemons).toHaveLength(1); // no close
      expect(got).toEqual(want);
    });

    // PR-102: a re-sent batch is flagged again, so its pairs keep their cut through the killer.
    test("PR-102: the cut batch and its re-send are both flagged and both carry the cut", async () => {
      // NONE_2's entry ends in a timeout at the killer A, a row R612 does not keep: the batch is cut there
      const { r } = await batchRig(
        (isBatch) => ({
          rows: (m, cu, d, n, seen) =>
            d === 0 && isBatch(n) && m === "NONE" && seen === 1
              ? [{ method: "A", status: "error", notRun: true, message: TIMEOUT_1S }]
              : killsAll(m, cu, d, n),
        }),
        ["M0001", "M0002", "M0003"],
      );
      const batches = r.serve.requests.filter((q) => (q.ids[0] ?? "").startsWith("NONE#"));
      expect(batches).toHaveLength(2);
      for (const q of batches) {
        expect(q.body.runSelectedOnly).toBe(true);
        const cuts = ((q.body.entries as Record<string, unknown>[]) ?? [])
          .filter((e) => String(e.test) === `Codeunit${CU}.`)
          .map((e) => e.excludeTests);
        expect(cuts.length).toBeGreaterThan(0);
        for (const c of cuts) expect(c).toEqual([`Codeunit${CU}.B`]);
      }
    });
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
      (r.b as unknown as { neverFlag: Set<number> }).neverFlag.add(CU); // PR-102: uncut pairs
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
    noProcReads(b);
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
      noProcReads(b);
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
    noProcReads(b);
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
      const so = () =>
        (r.b as unknown as { entriesStats(): Record<string, number> }).entriesStats(); // PR-99: summed lanes
      const soBefore = [
        so().selectedOnlyRequests,
        so().selectedOnlyTestsSkipped,
        so().selectedOnlyRefusedGapped,
      ];
      const v = await r.b.run(B, OPTS);
      expect(v.outcome).toBe("pass");
      // PR-94: the alone request keeps its own flag (below) and is neither counted nor refused as a
      // selected-only request
      expect([
        so().selectedOnlyRequests,
        so().selectedOnlyTestsSkipped,
        so().selectedOnlyRefusedGapped,
      ]).toEqual(soBefore);
      const sent = r.serve.requests.slice(n0);
      // PR-24 (L2): the cut killed its daemon; the restarted one proves CU on itself (a NONE warm-up of
      // exactly that codeunit) before the alone request runs one of its tests there.
      expect(sent).toHaveLength(2);
      expect(sent[0]?.daemon).toBe(sent[1]?.daemon);
      expect(sent[0]?.body.runSelectedOnly).not.toBe(true);
      const warm = sent[0]?.body.entries as { test: string; resources: object }[];
      expect(warm.map((e) => e.test)).toEqual([`Codeunit${ECHO}.`, `Codeunit${CU}.`]);
      expect(warm.map((e) => (e.resources as Record<string, string>)["active-mutant.txt"])).toEqual(
        ["NONE", "NONE"],
      );
      const body = sent[1]?.body ?? {};
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

    describe("PR-41: after a mutant's timeout cut, its later runs are alone calls (R577, trace L/A2)", () => {
      type Sent = Awaited<ReturnType<typeof readyRig>>["serve"]["requests"][number];
      /** The entry tests of a request, minus the echo, with the mutant its resources name. */
      const shape = (q: Sent) => ({
        alone: q.body.runSelectedOnly === true,
        tests: (q.body.entries as { test: string }[])
          .map((e) => e.test)
          .filter((t) => t !== `Codeunit${ECHO}.`),
        mutants: [
          ...new Set(
            (q.body.entries as { resources: Record<string, string> }[]).map(
              (e) => e.resources["active-mutant.txt"],
            ),
          ),
        ],
      });
      const sentFor = (r: Awaited<ReturnType<typeof readyRig>>, n0: number, m: string) =>
        r.serve.requests
          .slice(n0)
          .map(shape)
          .filter((s) => s.mutants.includes(m) && s.tests.length > 0);

      test("1: the cut was at ANOTHER test (A hangs): the killer B's run and its reproduction are alone requests, no whole-codeunit resend", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        expect(r.b.entriesStats().timeoutCuts).toBe(1);
        const n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        expect((await r.b.run(B, OPTS)).outcome).toBe("pass"); // R895: no row after the cut
        await r.b.activate("M0001"); // R577: the prefetched rows were consumed; this runs live
        expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: true, tests: [`Codeunit${CU}.B`], mutants: ["M0001"] },
          { alone: true, tests: [`Codeunit${CU}.B`], mutants: ["M0001"] },
        ]);
      });

      test("1b: the cut was AT the killing test: the reproduction is a live whole-codeunit request, not alone", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
        const n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: false, tests: [`Codeunit${CU}.`], mutants: ["M0001"] },
        ]);
      });

      test("2: a mutant killed by a plain failure (no timeout cut) reproduces as a live whole-codeunit call, as today", async () => {
        const r = await readyRig({
          serve: { rows: killsM1 },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
        const n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: false, tests: [`Codeunit${CU}.`], mutants: ["M0001"] },
        ]);
      });

      test("3: NONE after the mutant's timeout cut is a live whole-codeunit call, never alone", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        expect(r.b.entriesStats().timeoutCuts).toBe(1);
        await r.b.activate("M0001");
        expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
        const n0 = r.serve.requests.length;
        await r.b.activate(null);
        expect((await r.b.run(B, OPTS)).outcome).toBe("pass");
        // (the restarted daemon's NONE warm-up has the same shape; every NONE request is whole-codeunit)
        const none = sentFor(r, n0, "NONE");
        expect(none.length).toBeGreaterThan(0);
        for (const s of none)
          expect(s).toEqual({ alone: false, tests: [`Codeunit${CU}.`], mutants: ["NONE"] });
      });

      test("4: the set does not leak into the next batch or a redeploy", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        // The cut happened (A hangs), and the set is live: B's next run goes alone.
        expect(r.b.entriesStats().timeoutCuts).toBe(1);
        await r.b.activate("M0001");
        await r.b.run(B, OPTS);
        let n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        await r.b.run(B, OPTS);
        expect(sentFor(r, n0, "M0001").map((s) => s.alone)).toEqual([true]);
        // Next window: M0001 is not prefetched, so its run is live; the set was cleared.
        await r.b.prefetchMutants(plans(["M0002"], SUITE2));
        n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        await r.b.run(B, OPTS);
        // (the live whole-codeunit request, cut at A; then R895's alone run of B)
        expect(sentFor(r, n0, "M0001").map((s) => s.alone)).toEqual([false, true]);
        // Redeploy: cut again, then deploy; the same.
        const cuts = r.b.entriesStats().timeoutCuts;
        await r.b.prefetchMutants(plans(["M0001"], SUITE2));
        expect(r.b.entriesStats().timeoutCuts).toBe(cuts + 1);
        await r.b.deploy(r.l.batch);
        await baseline(r.b, SUITE2);
        n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        await r.b.run(B, OPTS);
        expect(sentFor(r, n0, "M0001").map((s) => s.alone)).toEqual([false, true]);
      });

      // PR-51 (F1): RunOpts.alone runs exactly one test alone, whatever the routing state says.
      const ALONE = { ...OPTS, alone: true as const };

      test("5 (F1): alone at the CUT test itself is an alone request, not the live whole-codeunit call 1b shows", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
        const n0 = r.serve.requests.length;
        await r.b.activate("M0001");
        const v = await r.b.run(A, ALONE);
        expect(v.selection).toBe("alone");
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: true, tests: [`Codeunit${CU}.A`], mutants: ["M0001"] },
        ]);
      });

      test("6 (F1): alone with no cut anywhere is still an alone request (test 2 shows the live whole-codeunit default)", async () => {
        const r = await readyRig({
          serve: { rows: killsM1 },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        const n0 = r.serve.requests.length;
        const v = await r.b.run(A, ALONE);
        expect(v.selection).toBe("alone");
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: true, tests: [`Codeunit${CU}.A`], mutants: ["M0001"] },
        ]);
      });

      test("7 (F1): alone under NONE (the confirm) is an alone request for NONE", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        await r.b.run(B, OPTS);
        const n0 = r.serve.requests.length;
        await r.b.activate(null);
        const v = await r.b.run(B, ALONE);
        expect(v.selection).toBe("alone");
        expect(sentFor(r, n0, "NONE")).toEqual([
          { alone: true, tests: [`Codeunit${CU}.B`], mutants: ["NONE"] },
        ]);
      });

      test("8 (F1): an alone answer is never cached as the codeunit's call, and a plain run carries no selection", async () => {
        const r = await readyRig({
          serve: { rows: killsM1 },
          suite: SUITE2,
          // M0001 is not prefetched, so its plain run is a live request unless the alone answer
          // was cached as the codeunit's call.
          mutants: ["M0002"],
          seams: retired,
        });
        await r.b.activate("M0001");
        const n0 = r.serve.requests.length;
        expect((await r.b.run(A, ALONE)).selection).toBe("alone");
        const plain = await r.b.run(A, OPTS);
        expect(plain.selection).toBeUndefined();
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: true, tests: [`Codeunit${CU}.A`], mutants: ["M0001"] },
          { alone: false, tests: [`Codeunit${CU}.`], mutants: ["M0001"] },
        ]);
      });

      test("10 (Addendum 1): cutState/restoreCutState put the cut set back, so a replayed timeout's reproduction is live, not alone", async () => {
        // A and B both hang under M0001. A is held, B (alone, after A's cut) is noted: its cut now
        // sits in the same codeunit. The reproduction of A runs after `restoreCutState` of the state
        // met at A: live, as in the old walk. Without the restore, B's cut routes it alone.
        const hangsAB: RowsFn = (m, cu, d, n) =>
          m === "M0001" && cu === CU
            ? [
                { method: "A", status: "error", notRun: true, message: TIMEOUT_1S },
                { method: "B", status: "error", notRun: true, message: TIMEOUT_1S },
              ]
            : allPass(m, cu, d, n);
        const r = await readyRig({
          serve: { rows: hangsAB },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        expect((await r.b.run(A, OPTS)).outcome).toBe("timeout");
        const atA = r.b.cutState("M0001");
        expect((await r.b.run(B, OPTS)).outcome).toBe("timeout");
        // the alone run of B really recorded a second cut, so the restore below has something to undo
        expect((r.b.cutState("M0001") as Set<string>).size).toBe((atA as Set<string>).size + 1);
        r.b.restoreCutState("M0001", atA);
        await r.b.activate("M0001");
        const n0 = r.serve.requests.length;
        await r.b.run(A, OPTS);
        expect(sentFor(r, n0, "M0001")).toEqual([
          { alone: false, tests: [`Codeunit${CU}.`], mutants: ["M0001"] },
        ]);
      });

      test("9 (F1): a verdict R895's own routing answered alone is marked, so the orchestrator can confirm it alone", async () => {
        const r = await readyRig({
          serve: { rows: hangsA },
          suite: SUITE2,
          mutants: ["M0001"],
          seams: retired,
        });
        await r.b.activate("M0001");
        expect((await r.b.run(B, OPTS)).selection).toBe("alone");
      });
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

  /**
   * R988: the baseline keeps each call's coverage without its unhit statements (v3 lists every
   * statement of the called codeunit's reach, nearly all unhit: DO, 67 MB a request), and the verdicts
   * do not move. `daemonBaseline`: through the daemon fill, or one-shot (`callCodeunit`).
   */
  const r988KeptCoverage = async (daemonBaseline: boolean) => {
    type Doc = {
      coverage: { file: string; statements: { line: number; hits: number }[] }[];
      perTestCoverage: { test: string; coverage: Doc["coverage"] }[];
    };
    const padded: CoverageFn = (m, cu, active, testDir) => {
      const d = plainCoverage(m, cu, active, testDir) as Doc;
      const pad = (fs: Doc["coverage"]) =>
        fs.map((f) => ({
          file: f.file,
          statements: [
            ...f.statements,
            ...Array.from({ length: 50 }, (_, i) => ({ line: 100 + i, hits: 0 })),
          ],
        }));
      return {
        coverage: pad(d.coverage),
        perTestCoverage: d.perTestCoverage.map((e) => ({
          test: e.test,
          coverage: pad(e.coverage),
        })),
      };
    };
    const plain = await dbRig({ extra: { coverage: "al-runner", daemonBaseline } });
    const vPlain = await baseline(plain.b, SUITE3);
    const r = await dbRig({
      serve: { coverage: padded },
      oneShotCoverage: padded,
      extra: { coverage: "al-runner", daemonBaseline },
    });
    // Every document a baseline verdict's coverage is read from, as the fill handed it on.
    type Read = { kind: string } & Partial<Doc>;
    const handed: Read[] = [];
    const proto = AlRunnerV3Backend.prototype as unknown as {
      coverageOf: (lane: unknown, row: string, doc: Read) => unknown;
    };
    const original = proto.coverageOf;
    const spy = spyOn(proto, "coverageOf").mockImplementation(function (
      this: unknown,
      lane: unknown,
      row: string,
      doc: Read,
    ) {
      handed.push(doc);
      return original.call(this, lane, row, doc);
    });
    let v: Awaited<ReturnType<typeof baseline>>;
    try {
      v = await baseline(r.b, SUITE3);
    } finally {
      spy.mockRestore();
    }
    // Outcome and coverage per verdict (durations and call ids differ run to run).
    const seen = (xs: typeof v) => xs.map((x) => ({ outcome: x.outcome, coverage: x.coverage }));
    expect(seen(v)).toEqual(seen(vPlain));
    expect(vPlain.some((x) => x.coverage !== undefined)).toBe(true);
    const docs = handed.filter((d) => d.kind === "doc");
    expect(docs.length).toBe(SUITE3.length);
    for (const d of docs) {
      const all = [
        ...(d.coverage ?? []),
        ...(d.perTestCoverage ?? []).flatMap((e) => e.coverage),
      ].flatMap((f) => f.statements);
      expect(all.length).toBeGreaterThan(0);
      expect(all.filter((s) => s.hits <= 0)).toEqual([]);
    }
  };

  test("R988: the daemon fill keeps each answer's coverage without its unhit statements; verdicts do not move", () =>
    r988KeptCoverage(true));

  test("R988: a one-shot baseline call keeps its coverage without its unhit statements; verdicts do not move", () =>
    r988KeptCoverage(false));

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

// R1014 (coord PR-07): R-998's DO window ran 40 min past its budget and a SIGTERM, re-sending requests
// whose hanging mutants each waited out the 1,762 s test stop.
describe("R1014: the mutant phase honours a spent budget and a stop signal between and inside requests", () => {
  const handle = (o: { spent: () => boolean; signalled: () => boolean }) => ({
    ...o,
    stopForMemory: () => {},
  });

  test("a spent budget sends no prefetch chunk (nor a warm-up for it); an unspent one does", async () => {
    for (const spent of [true, false]) {
      const r = await rig({ stopHandle: handle({ spent: () => false, signalled: () => false }) });
      await baseline(r.b, SUITE1);
      (r.b as unknown as { stopHandle: unknown }).stopHandle = handle({
        spent: () => spent,
        signalled: () => false,
      });
      await r.b.prefetchMutants(plans(["M0001", "M0002"]));
      // red without the check: the chunk starts a daemon and sends its warm-up and its request
      expect([spent, r.serve.requests.length > 0]).toEqual([spent, !spent]);
    }
  });

  test("a budget spent after the prefetch sends no kill-pair batch; an unspent one does", async () => {
    const killsA: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "M0001" && x.method === "A" ? { ...x, status: "fail" as const } : x,
      );
    for (const spendIt of [true, false]) {
      const box: { r?: Rig } = {};
      const prefetched = () =>
        box.r?.serve.requests.some((q) => q.ids.some((id) => id.startsWith("M0001|"))) === true;
      const r = await rig({
        stopHandle: handle({ spent: () => spendIt && prefetched(), signalled: () => false }),
        serve: { rows: killsA },
        oneShotRows: killsA,
        pairBatch: true,
      });
      box.r = r;
      await baseline(r.b, SUITE1);
      await r.b.prefetchMutants(plans(["M0001"]));
      const pairSent = r.serve.requests.some((q) => q.ids.some((id) => id.includes("#m")));
      // red without the check: the pair batch goes out after the budget is spent
      expect([spendIt, prefetched(), pairSent]).toEqual([spendIt, true, !spendIt]);
    }
  });

  test("a stop signal ends a request that is still running (a hang) by closing its daemon; without one it runs to its answer", async () => {
    for (const signal of [true, false]) {
      let sig = false;
      const notices: string[] = [];
      const r = await rig({
        stopHandle: handle({ spent: () => sig, signalled: () => sig }),
        notify: (c) => notices.push(c),
        // every request with a mutant's entries hangs for 1.5 s (a test that waits out its stop)
        serve: { delayMs: (q) => (q.ids.some((id) => id.startsWith("M0001")) ? 1500 : 0) },
      });
      await baseline(r.b, SUITE1);
      const started = Date.now();
      if (signal)
        setTimeout(() => {
          sig = true;
        }, 300);
      await r.b.prefetchMutants(plans(["M0001"])).catch(() => {});
      const ms = Date.now() - started;
      const closes = r.b.daemonCloses().byReason;
      if (signal) {
        // red without the watch: the request waits out its whole delay
        expect(ms).toBeLessThan(1000);
        expect(closes.get("stop-signal")).toBe(1);
        // review 6: no "its mutants run as live requests" warning after a stop
        expect(notices).not.toContain("al-runner-v3-entries-prefetch-dropped");
      } else {
        expect(ms).toBeGreaterThanOrEqual(1400);
        expect(closes.get("stop-signal")).toBeUndefined();
      }
    }
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

  const refusedA =
    (message: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "A" && d >= 0 ? { ...x, status: "error" as const, notRun: true, message } : x,
      );
  const askedOf = (r: Awaited<ReturnType<typeof methodRig>>) =>
    r.one.calls.map((c) => c[c.indexOf("--test-exact") + 1]?.split(".").at(-1)).sort();

  test("R1007: a refusal the daemon may keep (V3_SERVE_SAFE_REFUSALS) is kept from the daemon, not re-run", async () => {
    // A fresh process refuses A alike (the rig's one-shot rows), so the kept answer is the one one-shot would give.
    const r = await methodRig({ serve: { rows: refusedA(COMMIT) }, oneShotRows: refusedA(COMMIT) });
    const v = await baseline(r.b, SUITE2);
    expect(v[1]?.outcome).toBe("pass"); // B stood from the daemon (and its sample agreed)
    expect(v[0]?.outcome).not.toBe("pass"); // A: the daemon's refusal stands
    // Only the samples B and C ran one-shot.
    expect(askedOf(r)).toEqual(["B", "C"]);
  });

  test("R1007 (build review): a cascade refusal is never kept in the per-test fill: one test per request cannot honestly give it", async () => {
    const CASCADE =
      "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (a refusal of an earlier test)";
    const r = await methodRig({ serve: { rows: refusedA(CASCADE) } });
    await baseline(r.b, SUITE2);
    // A re-ran alone one-shot, as before R1007, besides the samples B and C.
    expect(askedOf(r)).toEqual(["A", "B", "C"]);
  });

  test("R1007: a refused SAMPLE is compared like any row: the same refusal (first line) keeps the daemon baseline, another answer drops it by name", async () => {
    // Not in V3_SERVE_SAFE_REFUSALS: before R1007 a sample like this was skipped as daemon-odd-row.
    const REFUSED = "NotRun: out-of-scope: a refusal no serve rule names";
    const refusedB =
      (daemonOnly: boolean, tail: string): RowsFn =>
      (m, cu, d, n) =>
        allPass(m, cu, d, n).map((x) =>
          x.method === "B" && (!daemonOnly || d >= 0)
            ? { ...x, status: "error" as const, notRun: true, message: `${REFUSED}${tail}` }
            : x,
        );
    // Same refusal in the fresh process; only text after the first line differs (it can, by path).
    const same = await methodRig({
      serve: { rows: refusedB(true, "\ndaemon path") },
      oneShotRows: refusedB(false, "\none-shot path"),
    });
    const v = await baseline(same.b, SUITE2);
    expect(same.b.daemonBaselineReport().dropped).toBeUndefined();
    expect(same.b.daemonBaselineReport().sampledSkipped).toEqual([]);
    expect(v[1]?.outcome).not.toBe("pass"); // B: the refusal both agreed on
    expect(askedOf(same)).toEqual(["B", "C"]);
    // The fresh process passes B: the daemon's refusal differs, and the daemon baseline drops by name.
    const other = await methodRig({ serve: { rows: refusedB(true, "") } });
    await baseline(other.b, SUITE2);
    expect(other.b.daemonBaselineReport().dropped).toContain("differs from a fresh process's");
    expect(other.b.daemonBaselineReport().droppedDetail.join(" ")).toContain(
      "b: differs in status, notRun",
    );
  });

  test("an answer that is not exactly that test's row, run, falls back to the test alone one-shot", async () => {
    // A refusal outside V3_SERVE_SAFE_REFUSALS is not kept (R1007 keeps only the safe ones).
    const r = await methodRig({
      serve: { rows: refusedA("NotRun: out-of-scope: a refusal no serve rule names") },
    });
    const v = await baseline(r.b, SUITE2);
    expect(v[1]?.outcome).toBe("pass"); // B stood from the daemon (and its sample agreed)
    // A alone one-shot (the daemon's answer was a refusal it may not keep), plus the sample's B and C.
    expect(askedOf(r)).toEqual(["A", "B", "C"]);
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
      seams: { concurrentSamples: false }, // PR-119: this test counts the guard's reads
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
        concurrentSamples: false, // PR-119: this test counts the guard's reads
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

  // R970: the per-test fill's processes can grow after their start was admitted; the watch reads
  // the container while they run. The fake raises memory inside the second process and fires the
  // watch there, so the reading comes from a process in flight, never at a start.
  // `overTicks`: how many watch readings in a row the second process's spike lasts.
  const growingFill = async (overTicks: number) => {
    const methods = ["A", "B", "C", "D"];
    const suite = methods.map((m) => ref(m));
    let used = GIB;
    let calls = 0;
    const clock: { tick: (() => void) | undefined; stopped: number } = {
      tick: undefined,
      stopped: 0,
    };
    const r = await guarded(() => used, {
      suite,
      polls: 1,
      extra: { isolateTests: true, isolatedBaselineProcesses: 1 },
      oneShotRows: () => {
        calls += 1;
        if (calls === 2) {
          // A spike only while this process runs: the gate at the next start reads GIB again, so
          // only the watch can see it.
          used = 30 * GIB;
          for (let t = 0; t < overTicks; t++) clock.tick?.();
          used = GIB;
          clock.tick?.(); // and one reading back under it
        }
        return methods.map((method) => ({ method, status: "pass" as const }));
      },
      seams: {
        memoryWatchClock: (t) => {
          clock.tick = t;
          return () => {
            clock.stopped += 1;
            clock.tick = undefined;
          };
        },
      },
    });
    r.b.baselinePhase(true);
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS); // takes the fill
    r.b.baselinePhase(false);
    return { r, clock };
  };

  test("R970: memory that stays over the bound while a fill process runs stops the session once; no further process starts", async () => {
    const { r, clock } = await growingFill(MEMORY_WATCH_OVER_TICKS);
    expect(r.stops).toEqual([
      { usedBytes: 30 * GIB, boundBytes: 28 * GIB, source: "/sys/fs/cgroup/memory.max" },
    ]);
    expect(r.one.calls).toHaveLength(2);
    const line = r.seen.find(([c]) => c === "al-runner-v3-memory-bound")?.[1] ?? "";
    expect(line).toContain("while the per-test baseline's processes run");
    expect(clock.stopped).toBe(1); // the watch ends with the fill
  });

  test("R970: a spike shorter than the watch's readings in a row is no stop: every test's process runs", async () => {
    expect(MEMORY_WATCH_OVER_TICKS).toBe(3);
    const { r, clock } = await growingFill(MEMORY_WATCH_OVER_TICKS - 1);
    expect(r.stops).toHaveLength(0);
    expect(r.one.calls).toHaveLength(4);
    expect(clock.stopped).toBe(1);
  });

  test("R970: a gate already waiting when the watch stops the session answers no, even once memory clears; one stop", async () => {
    const methods = ["A", "B", "C"];
    const suite = methods.map((m) => ref(m));
    let used = GIB;
    let calls = 0;
    const clock: { tick: (() => void) | undefined } = { tick: undefined };
    const r = await guarded(() => used, {
      suite,
      polls: 5,
      extra: { isolateTests: true, isolatedBaselineProcesses: 1 },
      oneShotRows: () => {
        calls += 1;
        if (calls === 1) used = 30 * GIB; // the next start's gate finds the bound passed and waits
        return methods.map((method) => ({ method, status: "pass" as const }));
      },
      seams: {
        memoryWatchClock: (t) => {
          clock.tick = t;
          return () => {
            clock.tick = undefined;
          };
        },
        memorySleep: async () => {
          // While the gate waits, the watch's readings stay over and stop the session; then memory clears.
          for (let t = 0; t < MEMORY_WATCH_OVER_TICKS; t++) clock.tick?.();
          used = GIB;
        },
      },
    });
    r.b.baselinePhase(true);
    await r.b.activate(null);
    await r.b.run(ref("A"), OPTS);
    r.b.baselinePhase(false);
    expect(r.one.calls).toHaveLength(1);
    expect(r.stops).toHaveLength(1);
  });

  test("R970: with no stop handle the watch's stop is thrown by name, once, after the fill", async () => {
    const methods = ["A", "B", "C"];
    const suite = methods.map((m) => ref(m));
    let used = GIB;
    let calls = 0;
    const clock: { tick: (() => void) | undefined } = { tick: undefined };
    const r = await rig({
      suite,
      extra: { memoryHeadroomGb: 4, isolateTests: true, isolatedBaselineProcesses: 1 },
      oneShotRows: () => {
        calls += 1;
        if (calls === 1) {
          used = 30 * GIB;
          for (let t = 0; t < MEMORY_WATCH_OVER_TICKS; t++) clock.tick?.();
          used = GIB;
        }
        return methods.map((method) => ({ method, status: "pass" as const }));
      },
      seams: {
        memoryReader: () => ({
          usedBytes: used,
          maxBytes: 32 * GIB,
          source: "/sys/fs/cgroup/memory.max",
        }),
        memorySleep: async () => {},
        memoryWaitPolls: 1,
        memoryWatchClock: (t) => {
          clock.tick = t;
          return () => {
            clock.tick = undefined;
          };
        },
      },
    });
    r.b.baselinePhase(true);
    await r.b.activate(null);
    await expect(r.b.run(ref("A"), OPTS)).rejects.toThrow(/al-runner-v3-memory-bound/);
    expect(r.one.calls).toHaveLength(1);
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

describe("PR-24 (L2): a restarted daemon warms each codeunit on its first use there", () => {
  const P1 = [ref("A"), ref("B")]; // codeunit CU
  const P2 = [ref("C", CU2)]; // codeunit CU2
  const STEPS: readonly [string, readonly TestMethodRef[]][] = [
    ["M0001", P1],
    ["M0002", P2],
    ["M0003", P1],
  ];
  /** Each mutant prefetched on its own, then run; the union holds CU, then CU and CU2. */
  const session = async (opts: RigOpts, steps = STEPS) => {
    const r = await rig({ serve: { rows: killsM1 }, oneShotRows: killsM1, suite: SUITE2, ...opts });
    await baseline(r.b, SUITE2);
    const verdicts: string[] = [];
    for (const [m, refs] of steps) {
      await r.b.prefetchMutants([{ mutantId: m, refs }]);
      await r.b.activate(m);
      for (const t of refs) verdicts.push(`${m} ${t.method} ${outcome(await r.b.run(t, OPTS))}`);
    }
    return { r, verdicts };
  };
  const entriesOf = (r: Rig, d: number) =>
    r.serve.requests.filter((q) => q.daemon === d && !q.ids.some((i) => i.startsWith("plain:")));
  const codeunitsOf = (ids: readonly string[]) =>
    [...new Set(ids.filter((i) => !i.endsWith("|echo")).map((i) => i.split("|")[1]))].sort();

  test("daemonMaxRequests 1 does not loop; verdicts equal the control; each restarted daemon first proves exactly the codeunits of its next request", async () => {
    const control = await session({});
    const s = await session({ extra: { daemonMaxRequests: 1 } });
    expect(s.verdicts).toEqual(control.verdicts);
    expect(s.verdicts).toContain("M0001 A fail,"); // a kill is in the comparison
    const daemons = s.r.serve.daemons.length;
    expect(daemons).toBeGreaterThan(2); // a restart per request: the lazy path is what runs here
    // The first mutant daemon warms the whole union it starts with, as before.
    expect(entriesOf(s.r, 0)[0]?.ids).toEqual(["NONE|echo", `NONE|${CU}`]);
    for (let d = 1; d < daemons; d++) {
      const [warm, next] = entriesOf(s.r, d);
      if (next === undefined) continue; // a daemon its session ended on
      expect(warm?.ids[0]).toBe("NONE|echo");
      expect(warm?.ids.every((i) => i.startsWith("NONE|"))).toBe(true);
      expect(codeunitsOf(warm?.ids ?? [])).toEqual(codeunitsOf(next.ids));
    }
    // CU2 is in the union from M0002 on, but no daemon that runs only CU warms it.
    for (let d = 1; d < daemons; d++) {
      const [warm, ...rest] = entriesOf(s.r, d);
      if (!rest.flatMap((q) => q.ids).some((i) => i.endsWith(`|${CU2}`)))
        expect(warm?.ids ?? []).not.toContain(`NONE|${CU2}`);
    }
  });

  test("a restarted daemon whose codeunit differs from the baseline under NONE is refused before that codeunit's first entry", async () => {
    // Every daemon after the first answers NONE on CU with a failing A: the baseline (one-shot) has it passing.
    const drift: RowsFn = (m, cu, d, n) =>
      m === "NONE" && cu === CU && d >= 1
        ? [
            { method: "A", status: "fail", message: "drift" },
            { method: "B", status: "pass" },
          ]
        : killsM1(m, cu, d, n);
    const r = await rig({
      serve: { rows: drift },
      oneShotRows: killsM1,
      suite: SUITE2,
      extra: { daemonMaxRequests: 1 },
    });
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants([{ mutantId: "M0001", refs: P1 }]); // daemon 0: whole-union warm-up, clean
    await r.b.prefetchMutants([{ mutantId: "M0002", refs: P2 }]); // a restart proves CU2 only: clean
    await expect(r.b.prefetchMutants([{ mutantId: "M0003", refs: P1 }])).rejects.toThrow(
      /al-runner-v3-entries-warmup-disagrees/,
    );
    // The refused daemon got its warm-up and nothing of M0003.
    expect(r.serve.requests.flatMap((q) => q.ids)).not.toContain(`M0003|${CU}`);
  });

  // Review B1: a live request on a spent budget must still get its real verdict, as with master's
  // whole-union restart warm-up (no spent check there); a "deadline" from the warm-up would become a
  // deadline-exceeded verdict (`liveFailure`). Only prefetch and pair batches skip once spent, before request().
  test("a live call on a restarted daemon with the budget spent still warms up and returns its real verdict", async () => {
    const liveAfterRestart = async (spentNow: boolean) => {
      let spent = false;
      const r = await rig({
        serve: { rows: killsM1 },
        oneShotRows: killsM1,
        suite: SUITE2,
        extra: { daemonMaxRequests: 1 },
        stopHandle: { spent: () => spent, signalled: () => false, stopForMemory: () => {} },
      });
      await baseline(r.b, SUITE2);
      // Another mutant is prefetched (daemon 0, then recycled), so M0001's call below is live.
      await r.b.prefetchMutants([{ mutantId: "M0003", refs: P1 }]);
      spent = spentNow;
      const n0 = r.serve.requests.length;
      // A live call (not prefetched) on a restarted daemon.
      await r.b.activate("M0001");
      const v = await r.b.run(ref("A"), OPTS);
      return { ids: r.serve.requests.slice(n0).flatMap((q) => q.ids), v: outcome(v) };
    };
    const control = await liveAfterRestart(false);
    expect(control.ids).toContain(`NONE|${CU}`); // the restarted daemon proves CU first
    expect(control.v).toEqual(["fail", ""]); // M0001 kills A: a real verdict, not a timeout
    const spentRun = await liveAfterRestart(true);
    expect(spentRun.ids).toContain(`NONE|${CU}`);
    expect(spentRun.v).toEqual(control.v);
  });

  test("a kill pair on a restarted daemon is preceded there by the warm-up of its codeunit", async () => {
    const r = await rig({
      serve: { rows: killsM1 },
      oneShotRows: killsM1,
      suite: SUITE2,
      extra: { daemonMaxRequests: 1 },
    });
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants([{ mutantId: "M0002", refs: P2 }]); // daemon 0: the union is CU2 only
    await r.b.activate("M0001");
    const n0 = r.serve.requests.length;
    await r.b.sendKillPair("M0001", ref("A"));
    const after = r.serve.requests
      .slice(n0)
      .filter((q) => !q.ids.some((i) => i.startsWith("plain:")));
    const pair = after.findIndex((q) => q.ids.some((i) => i.startsWith("M0001|")));
    expect(pair).toBeGreaterThan(0);
    const warm = after[pair - 1];
    expect(warm?.daemon).toBe(after[pair]?.daemon);
    expect(warm?.ids).toEqual(["NONE|echo", `NONE|${CU}`]);
  });

  // Review: rule 4. A daemon-filled baseline (R948) or L5's re-check runs on the baseline's own daemon,
  // which never passes ensureDaemon; the first MUTANT daemon must still warm the whole union.
  test("after a daemon-filled baseline the first mutant daemon still warms the whole union", async () => {
    const r = await dbRig({ serve: { rows: killsM1 }, oneShotRows: killsM1 });
    await baseline(r.b, SUITE3);
    // The batch plans put CU, CU2 and CU3 in the union; the window's request needs CU only.
    await r.b.prefetchMutants([{ mutantId: "M0001", refs: P1 }], {
      batchPlans: [
        { mutantId: "M0001", refs: P1 },
        { mutantId: "M0002", refs: [ref("C", CU2), ref("D", CU3)] },
      ],
    });
    const firstMutantDaemon = r.serve.requests.find(
      (q) => !q.ids.some((i) => i.startsWith("plain:")),
    );
    expect(firstMutantDaemon?.ids).toEqual([
      "NONE|echo",
      `NONE|${CU}`,
      `NONE|${CU2}`,
      `NONE|${CU3}`,
    ]);
  });

  test("a lazy warm-up does not count toward R952's request bound: a restarted daemon still serves daemonMaxRequests requests", async () => {
    const s = await session({ extra: { daemonMaxRequests: 2 } });
    const daemons = s.r.serve.daemons.length;
    expect(daemons).toBeGreaterThan(1);
    // Every restarted daemon but the last: its warm-up, then exactly 2 requests before the recycle.
    for (let d = 1; d < daemons - 1; d++) {
      const [warm, ...rest] = entriesOf(s.r, d);
      expect(warm?.ids.every((i) => i.startsWith("NONE|"))).toBe(true);
      expect(rest.filter((q) => !q.ids.every((i) => i.startsWith("NONE|")))).toHaveLength(2);
    }
  });
});

describe("PR-103: the serve-request-sized event says what the request's daemon did first", () => {
  const P1 = [ref("A"), ref("B")]; // codeunit CU
  const P2 = [ref("C", CU2)]; // codeunit CU2
  const MiB = 2 ** 20;
  const GiB = 2 ** 30;
  const GROW = 7 * MiB;
  /**
   * Each mutant prefetched on its own, then run. A lazy proof (a NONE-only request on a daemon after the
   * first) grows the fake daemon by `GROW`.
   */
  const session = async (extra: Partial<AlRunnerV3Config>) => {
    const mem = { level: GiB };
    const r = await rig({
      serve: {
        rows: killsM1,
        answer: (q) => {
          if (q.daemon >= 1 && q.ids.every((i) => i.startsWith("NONE|"))) mem.level += GROW;
          return undefined;
        },
      },
      oneShotRows: killsM1,
      suite: SUITE2,
      extra,
      seams: { requestRssReader: () => mem.level },
    });
    const sized: V3RequestSized[] = [];
    r.b.setRequestSizedSink((e) => sized.push(e));
    await baseline(r.b, SUITE2);
    for (const [m, refs] of [
      ["M0001", P1],
      ["M0002", P2],
      ["M0003", P1],
    ] as const) {
      await r.b.prefetchMutants([{ mutantId: m, refs }]);
      await r.b.activate(m);
      for (const t of refs) await r.b.run(t, OPTS);
    }
    return { sized, r };
  };

  test("a request after a lazy proof carries proved and proveGrowth", async () => {
    const { sized } = await session({ daemonMaxRequests: 1 });
    const proofs = sized.filter((e) => e.proved !== undefined);
    expect(proofs.length).toBeGreaterThan(0);
    for (const e of proofs) {
      expect(e.proved).toBeGreaterThan(0);
      expect(e.proveGrowth).toBe(GROW);
    }
  });

  test("a request without a lazy proof carries neither", async () => {
    const { sized } = await session({});
    expect(sized.length).toBeGreaterThan(1);
    for (const e of sized) {
      expect("proved" in e).toBe(false);
      expect("proveGrowth" in e).toBe(false);
    }
  });

  test("proveGrowth is left out when the RSS before the proofs cannot be read", async () => {
    // Unreadable until the first lazy proof is answered: the "before" read fails, the "after" read works.
    let blind = true;
    const r = await rig({
      serve: {
        rows: killsM1,
        answer: (q) => {
          if (q.daemon >= 1 && q.ids.every((i) => i.startsWith("NONE|"))) blind = false;
          return undefined;
        },
      },
      oneShotRows: killsM1,
      suite: SUITE2,
      extra: { daemonMaxRequests: 1 },
      seams: { requestRssReader: () => (blind ? undefined : GiB) },
    });
    const sized: V3RequestSized[] = [];
    r.b.setRequestSizedSink((e) => sized.push(e));
    await baseline(r.b, SUITE2);
    for (const [m, refs] of [
      ["M0001", P1],
      ["M0002", P2],
    ] as const)
      await r.b.prefetchMutants([{ mutantId: m, refs }]);
    const first = sized.find((e) => e.proved !== undefined);
    expect(first).toBeDefined();
    expect(first?.proveGrowth).toBeUndefined();
  });

  test("fresh is on a new daemon's first request only", async () => {
    const { sized } = await session({});
    expect(sized[0]?.fresh).toBe(true);
    expect(sized.slice(1).some((e) => "fresh" in e)).toBe(false);
    const recycled = await session({ daemonMaxRequests: 1 });
    expect(recycled.sized.every((e) => e.fresh === true)).toBe(true);
  });

  describe("running totals per daemon (addendum 1)", () => {
    // daemonMaxRequests 3: daemon 0 (union-warmed) serves a and b, then daemon 1 is restarted for
    // c (fresh, proves CU), d (proves CU2, +600 MiB: a reading-less request, the daemon is 600 MiB over its
    // floor and did not grow) and e (grows 1 MiB: the next emitted event).
    const run = async () => {
      const mem = { level: GiB };
      let entriesAnswers = 0;
      const r = await rig({
        serve: {
          rows: killsM1,
          answer: (q) => {
            if (q.daemon < 1) return undefined;
            if (q.ids.every((i) => i.startsWith("NONE|"))) {
              mem.level += q.ids.includes(`NONE|${CU2}`) ? 600 * MiB : GROW;
            } else {
              entriesAnswers += 1;
              if (entriesAnswers !== 2) mem.level += MiB; // d's own entries do not grow it
            }
            return undefined;
          },
        },
        oneShotRows: killsM1,
        suite: SUITE2,
        extra: { daemonMaxRequests: 3 },
        seams: { requestRssReader: () => mem.level },
      });
      const sized: V3RequestSized[] = [];
      r.b.setRequestSizedSink((e) => sized.push(e));
      await baseline(r.b, SUITE2);
      for (const [m, t] of [
        ["M0001", ref("A")],
        ["M0001", ref("B")],
        ["M0003", ref("A")], // c
        ["M0002", ref("C", CU2)], // d
        ["M0003", ref("C", CU2)], // e
      ] as const) {
        await r.b.activate(m);
        await r.b.run(t, OPTS);
      }
      return sized;
    };

    test("a reused daemon's request that took no reading still has its proof in the next event's totals", async () => {
      const sized = await run();
      const last = sized[sized.length - 1];
      expect(last?.daemonRequest).toBe(3);
      expect(last?.proved).toBeUndefined(); // the last request proved nothing itself
      expect(last?.daemonProved).toBe(1); // d's proof, though d gave no event
      expect(last?.daemonProveGrowth).toBe(600 * MiB);
      expect(sized.filter((e) => e.proved !== undefined && e.fresh !== true)).toHaveLength(0);
    });

    test("the totals leave out the fresh request's proofs", async () => {
      const sized = await run();
      const fresh = sized.filter((e) => e.fresh === true && e.proved !== undefined);
      expect(fresh.length).toBeGreaterThan(0);
      for (const e of fresh) {
        expect(e.daemonProved).toBe(0);
        expect(e.daemonProveGrowth).toBe(0);
      }
      // c proved CU on the fresh daemon (+GROW): not in the last event's totals (they are d's alone).
      expect(sized[sized.length - 1]?.daemonProveGrowth).not.toBe(600 * MiB + GROW);
    });
  });

  test("proved counts the codeunits sent, not those marked missing (R1004: an isolated call whose test is left out)", async () => {
    const REFUSAL = "NotRun: out-of-scope: InStream method on an unassigned Variant";
    const bRefused: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "NONE" && x.method === "B"
          ? { ...x, status: "error" as const, notRun: true, message: REFUSAL }
          : x,
      );
    const r = await rig({
      serve: { rows: bRefused },
      oneShotRows: bRefused,
      suite: SUITE2,
      extra: { isolateTests: true, daemonMaxRequests: 1 },
      seams: { requestRssReader: () => GiB },
    });
    const sized: V3RequestSized[] = [];
    r.b.setRequestSizedSink((e) => sized.push(e));
    await baseline(r.b, SUITE2);
    for (const m of ["M0001", "M0002", "M0003"])
      await r.b.prefetchMutants([{ mutantId: m, refs: [ref("A"), ref("B")] }]);
    const proofs = sized.filter((e) => e.proved !== undefined);
    expect(proofs.length).toBeGreaterThan(0);
    // A is proved; B (left out at baseline, isolated) is marked proven but not sent.
    for (const e of proofs) expect(e.proved).toBe(1);
  });

  test("daemonRequest counts as R952 does: a lazy proof is not a request", async () => {
    const { sized } = await session({ daemonMaxRequests: 1 });
    const proofs = sized.filter((e) => e.proved !== undefined);
    expect(proofs.length).toBeGreaterThan(0);
    expect(proofs.every((e) => e.daemonRequest === 1)).toBe(true);
    const plain = (await session({})).sized;
    const counts = plain.map((e) => e.daemonRequest);
    expect(counts.every((n, i) => i === 0 || n === (counts[i - 1] ?? 0) + 1)).toBe(true);
  });

  test("lane and kind are right on a prefetch and on a live request", async () => {
    const r = await rig({
      serve: { rows: killsM1 },
      oneShotRows: killsM1,
      suite: SUITE2,
      seams: { requestRssReader: () => GiB },
    });
    const sized: V3RequestSized[] = [];
    r.b.setRequestSizedSink((e) => sized.push(e));
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants([{ mutantId: "M0003", refs: P1 }]);
    expect(sized.length).toBeGreaterThan(0);
    expect(sized.every((e) => e.lane === 0 && e.kind === "prefetch")).toBe(true);
    // M0001 was not prefetched: its call runs live.
    const n = sized.length;
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    const live = sized.slice(n);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((e) => e.kind === "live" && e.lane === 0)).toBe(true);
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
    // PR-119: a concurrent sample's forward pick is taken after the loop's position at the settle,
    // so this in-place-flow pin runs with the samples in place (the concurrent pick: pr119 tests).
    const r = await six({ seams: { concurrentSamples: false } });
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
    // R1007: and names the skipped samples with their reasons, not only the itests' report.
    expect(dropNotice(seen)[0]?.[1]).toMatch(/; skipped samples: \S.* \(\S+\)/);
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
      seams: { concurrentSamples: false }, // PR-119: the spent() read count below is the in-place flow's
      // spent() is read twice per request (PR-119: again after the pre-check) and once after the skipped
      // sample's run: the 6th read is the loop top before the replacement (CUS[2]), where the fill stops.
      stopHandle: { spent: () => ++n >= 6, signalled: () => false, stopForMemory: () => {} },
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

// ---------------------------------------------------------------------------------------------
// R937 (coord R-957): a test codeunit holding a method name serve is not proven for runs one-shot
// INSIDE the serve session; every serve phase leaves it out. `pickTransport` picks the set
// (r761-serve-default.test.ts); here the set is given and the routing is read off the fakes.
// ---------------------------------------------------------------------------------------------
describe("R937: a one-shot codeunit inside a serve session", () => {
  const markOneShot = (b: AlRunnerV3Backend, ...cus: number[]) => {
    (b as unknown as { oneShotCodeunits: ReadonlySet<number> }).oneShotCodeunits = new Set(cus);
  };
  /** Every test fails under M0001, so each codeunit's kill shows. */
  const killsAllM1: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((r) =>
      m === "M0001" ? { ...r, status: "fail" as const, message: "boom" } : r,
    );
  const entryIds = (r: Rig) => r.serve.requests.flatMap((q) => q.ids);
  const C = ref("C", CU2);

  test("the prefetch, the warm-up and the kill pair leave it out; its live call is one-shot under the mutant file, NONE restored after", async () => {
    const r = await rig({ suite: SUITE2, serve: { rows: killsAllM1 }, pairBatch: true });
    markOneShot(r.b, CU2);
    await baseline(r.b, SUITE2);
    const baselineCalls = r.one.calls.length;
    await r.b.prefetchMutants(plans(["M0001"], SUITE2));
    // serve saw CU and the echo only; the warm-up union never held CU2
    expect(entryIds(r).some((id) => id.includes(String(CU2)))).toBe(false);
    expect(entryIds(r).some((id) => id === `M0001|${CU}`)).toBe(true);
    expect(r.one.calls.length).toBe(baselineCalls);
    await r.b.activate("M0001");
    // CU2 is not prefetched: its call is one-shot, and v3 read M0001 from the resource file
    const one = r.one.calls.length;
    const sent = r.serve.requests.length;
    expect((await r.b.run(C, OPTS)).outcome).toBe("fail");
    expect(r.one.calls.length).toBe(one + 2); // the echo process, then the call
    expect(r.one.calls.at(-2)?.join(" ")).toContain(`--codeunit ${ECHO}`);
    expect(r.one.calls.at(-1)?.join(" ")).toContain(`--codeunit ${CU2}`);
    expect(r.serve.requests.length).toBe(sent);
    expect(await readFile(resourceFile(join(r.l.scratch, "active")), "utf8")).toBe("NONE");
    // CU's kill is the prefetched one: no new process, no new request
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("fail");
    expect(r.one.calls.length).toBe(one + 2);
    // the kill pair of the one-shot codeunit sends nothing; the confirm runs one-shot, unmutated
    await r.b.sendKillPair("M0001", C);
    expect(r.serve.requests.length).toBe(sent);
    await r.b.activate(null);
    expect((await r.b.run(C, OPTS)).outcome).toBe("pass");
    expect(r.one.calls.length).toBe(one + 3); // unmutated: no echo
    expect(r.serve.requests.length).toBe(sent);
  });

  test("a mutant call whose echo does not name the mutant is refused by name, never scored, and its call is not made", async () => {
    for (const said of ["NONE", "M0002"]) {
      const r = await rig({
        suite: SUITE2,
        serve: { rows: killsAllM1 },
        oneShotEcho: () => `LETHAL-ECHO:${said}:true`,
      });
      markOneShot(r.b, CU2);
      await baseline(r.b, SUITE2);
      await r.b.prefetchMutants(plans(["M0001"], SUITE2));
      await r.b.activate("M0001");
      const before = r.one.calls.length;
      const v = await r.b.run(C, OPTS);
      expect([said, v.outcome]).toEqual([said, "error"]);
      expect(v.failureMessage).toContain("entries-echo-mismatch");
      expect(r.one.calls.length).toBe(before + 1); // the echo only
      expect(await readFile(resourceFile(join(r.l.scratch, "active")), "utf8")).toBe("NONE");
    }
  });

  test("R937 review: one echo per mutant serves every one-shot codeunit under it, a mismatch included, and the stats count it", async () => {
    for (const said of ["M0001", "NONE"]) {
      const r = await rig({
        suite: SUITE3,
        serve: { rows: killsAllM1 },
        oneShotEcho: () => `LETHAL-ECHO:${said}:true`,
      });
      markOneShot(r.b, CU2, CU3);
      await baseline(r.b, SUITE3);
      await r.b.prefetchMutants(plans(["M0001"], SUITE3));
      await r.b.activate("M0001");
      const before = r.one.calls.length;
      const c = await r.b.run(C, OPTS);
      const d = await r.b.run(ref("D", CU3), OPTS);
      const ok = said === "M0001";
      // the echo once, then each codeunit's own call when the echo named the mutant
      expect([said, r.one.calls.length - before]).toEqual([said, ok ? 3 : 1]);
      expect([said, c.outcome, d.outcome]).toEqual([
        said,
        ok ? "fail" : "error",
        ok ? "fail" : "error",
      ]);
      const s = r.b.entriesStats();
      expect([said, s.echoRequests, s.echoMismatches]).toEqual([said, 1, ok ? 0 : 1]);
    }
  });

  test("the daemon baseline never asks serve for it; it runs one-shot like a one-shot session's", async () => {
    const r = await dbRig();
    markOneShot(r.b, CU2);
    const v = await baseline(r.b, SUITE3);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(r.serve.requests.map((q) => q.ids[0])).not.toContain(`plain:Codeunit${CU2}.`);
    expect(r.serve.requests.map((q) => q.ids[0])).toContain(`plain:Codeunit${CU}.`);
    expect(oneShotCodeunits(r)).toContain(String(CU2));
  });

  test("under isolation auto, a one-shot codeunit moved to `method` (per-test call ids) is still left out of the prefetch", async () => {
    const r = await rig({
      suite: SUITE2,
      serve: { rows: killsAllM1 },
      extra: { isolation: "auto" },
    });
    markOneShot(r.b, CU2);
    await baseline(r.b, SUITE2);
    r.b.chooseIsolation(CU2, "method");
    await r.b.prefetchMutants(plans(["M0001"], SUITE2));
    expect(entryIds(r).filter((id) => id.startsWith("M0001|"))).toEqual([
      "M0001|echo",
      `M0001|${CU}`,
    ]);
  });

  test("with nothing marked, the same codeunit goes to serve (the routing is the mark's doing)", async () => {
    const r = await rig({ suite: SUITE2, serve: { rows: killsAllM1 } });
    await baseline(r.b, SUITE2);
    await r.b.prefetchMutants(plans(["M0001"], SUITE2));
    expect(entryIds(r).some((id) => id === `M0001|${CU2}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// R1001 (coord R-991): a baseline whose first codeunits are all refused, every row with one text,
// stops by name instead of running the rest (DC: 0 of 1,839, 4,656 s, 117 daemons). Call counters.
// ---------------------------------------------------------------------------------------------
const UNIFORM =
  'NotRun: out-of-scope: Company Triggers OnCompanyOpen(Completed) subscriber codeunit "X".InitCompany before the first test: Y row not found';
const R1001_CUS = Array.from({ length: 12 }, (_, i) => 79300 + i);
for (const cu of R1001_CUS) SUITE_METHODS[cu] = ["T1", "T2"];
const R1001_SUITE = R1001_CUS.flatMap((cu) => [ref("T1", cu), ref("T2", cu)]);
const refusedAll: RowsFn = (_m, cu) =>
  (SUITE_METHODS[cu] ?? []).map((method) => ({
    method,
    status: "error" as const,
    notRun: true,
    message: UNIFORM,
  }));
const wrow = (cu: number, o: Partial<V3RowLike> = {}): V3RowLike => ({
  codeunit: cu,
  method: "T1",
  name: `Codeunit${cu}.T1`,
  status: "error",
  notRun: true,
  message: UNIFORM,
  ...o,
});
type V3RowLike = {
  codeunit: number;
  method: string;
  name: string;
  status: "pass" | "fail" | "error";
  notRun: boolean;
  message?: string;
};

describe("R1001: the uniform-refusal watch", () => {
  test("returns the text once N codeunits are refused with one text, not before", () => {
    const w = new UniformRefusalWatch(3);
    expect(w.observe(1, [wrow(1), wrow(1, { method: "T2" })])).toBeUndefined();
    expect(w.observe(2, [wrow(2)])).toBeUndefined();
    expect(w.observe(3, [wrow(3)])).toBe(UNIFORM);
    expect(V3_UNIFORM_REFUSAL_CODEUNITS).toBe(10);
  });
  test("one passing or failing row, a timeout, or a second text disarms it for good", () => {
    const pass: V3RowLike = {
      codeunit: 2,
      method: "T1",
      name: "Codeunit2.T1",
      status: "pass",
      notRun: false,
    };
    for (const odd of [
      pass,
      wrow(2, { status: "fail", notRun: false, message: "boom" }),
      // a plain fail whose text equals the refusals': only the refusal check stops it, not the text check
      wrow(2, { status: "fail", notRun: false }),
      wrow(2, { status: "pass", notRun: false }),
      wrow(2, { message: "Test exceeded 5s timeout." }),
      wrow(2, { message: `${UNIFORM} but another` }),
    ]) {
      const w = new UniformRefusalWatch(3);
      w.observe(1, [wrow(1)]);
      expect(w.observe(2, [odd])).toBeUndefined();
      expect(w.observe(3, [wrow(3)])).toBeUndefined();
      expect(w.observe(4, [wrow(4)])).toBeUndefined();
    }
  });
  test("a codeunit is counted once; an empty answer counts nothing", () => {
    const w = new UniformRefusalWatch(2);
    expect(w.observe(1, [wrow(1)])).toBeUndefined();
    expect(w.observe(1, [wrow(1)])).toBeUndefined();
    expect(w.observe(2, [])).toBeUndefined();
    expect(w.observe(2, [wrow(2)])).toBe(UNIFORM);
  });
});

describe("R1001: a uniformly refused baseline stops by name", () => {
  test("one-shot: the 10th codeunit's answer stops the baseline with the text; no 11th codeunit runs", async () => {
    const r = await rig({ suite: R1001_SUITE, oneShotRows: refusedAll });
    const err = await baseline(r.b, R1001_SUITE).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlRunnerV3BaselineUniformlyRefusedError);
    expect(String((err as Error).message)).toContain(UNIFORM);
    expect(String((err as Error).message)).toContain("the first 10 test codeunits");
    expect(new Set(r.one.calls.map((c) => c[c.indexOf("--codeunit") + 1]))).toEqual(
      new Set(R1001_CUS.slice(0, 10).map(String)),
    );
  });
  test("one-shot: a codeunit refused with another text, or one passing test, and every codeunit runs", async () => {
    for (const odd of [
      (cu: number) => (cu === 79304 ? `${UNIFORM} (other)` : UNIFORM),
      (cu: number) => (cu === 79301 ? "pass" : UNIFORM),
    ]) {
      const rows: RowsFn = (_m, cu) =>
        (SUITE_METHODS[cu] ?? []).map((method) =>
          odd(cu) === "pass"
            ? { method, status: "pass" as const }
            : { method, status: "error" as const, notRun: true, message: odd(cu) },
        );
      const r = await rig({ suite: R1001_SUITE, oneShotRows: rows });
      const v = await baseline(r.b, R1001_SUITE);
      expect(v).toHaveLength(R1001_SUITE.length);
      expect(new Set(r.one.calls.map((c) => c[c.indexOf("--codeunit") + 1])).size).toBe(12);
    }
  });
  test("daemon baseline: the fill stops by name once a sample compared clean, before the 11th request", async () => {
    const r = await dbRig({
      suite: R1001_SUITE,
      serve: { rows: refusedAll, coverage: plainCoverage },
      oneShotRows: refusedAll,
    });
    const err = await baseline(r.b, R1001_SUITE).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlRunnerV3BaselineUniformlyRefusedError);
    expect(r.serve.requests.length).toBe(10);
  });
  test("daemon baseline: when the sample shows the daemon disagrees with a fresh process, no stop: the daemon baseline drops and every codeunit runs one-shot", async () => {
    const r = await dbRig({
      suite: R1001_SUITE,
      serve: { rows: refusedAll, coverage: plainCoverage },
      oneShotRows: (_m, cu) =>
        (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const })),
    });
    const v = await baseline(r.b, R1001_SUITE);
    expect(v).toHaveLength(R1001_SUITE.length);
    expect(r.b.daemonBaselineReport().dropped).toBeDefined();
  });
  test("daemon baseline: with every sample skipped (none compared) the fill never stops, and after the drop the fresh green answers decide", async () => {
    const r = await dbRig({
      suite: R1001_SUITE,
      serve: { rows: refusedAll, coverage: plainCoverage },
      oneShotRows: (_m, cu) =>
        (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const })),
    });
    // every one-shot call while the fill holds (its samples) gives no answer, so each sample is skipped
    const holder = r.b as unknown as { spawnCodeunit: (...a: unknown[]) => Promise<unknown> };
    const real = holder.spawnCodeunit.bind(r.b);
    holder.spawnCodeunit = async (...a) =>
      r.b.daemonBaselineReport().dropped === undefined
        ? { spawnError: "boom", wallMs: 0 }
        : real(...a);
    // red without the `compared >= 1` guard (the fill stops on unchecked answers), and red with a
    // watch shared with the one-shot path (the dropped fill's refusals stop the fresh green run)
    const v = await baseline(r.b, R1001_SUITE);
    expect(v.map((x) => x.outcome)).toEqual(R1001_SUITE.map(() => "pass"));
    expect(r.b.daemonBaselineReport().dropped).toBeDefined();
  });
  test("per-test keys (--isolate-tests) are not codeunits: a uniformly refused codeunit's tests never stop the run", async () => {
    const cus = R1001_CUS.slice(0, 2);
    for (const cu of cus) SUITE_METHODS[cu] = Array.from({ length: 6 }, (_, i) => `T${i + 1}`);
    try {
      const suite = cus.flatMap((cu) => (SUITE_METHODS[cu] ?? []).map((m) => ref(m, cu)));
      const r = await rig({ suite, oneShotRows: refusedAll, extra: { isolateTests: true } });
      const v = await baseline(r.b, suite); // red without the per-test skip: the 10th test would stop it
      expect(v).toHaveLength(12);
    } finally {
      for (const cu of cus) SUITE_METHODS[cu] = ["T1", "T2"];
    }
  });
});

// PR-20 (L4): a mutant's entry stops after the mutant's last covering test of the codeunit
// (docs/superpowers/specs/2026-11-15-pr20-l4-entry-cut.md). A verdict reads only covering tests, and
// a later test cannot change an earlier one, so the tests after it are left out (`excludeTests`).
describe("PR-20 (L4): a mutant entry stops after its last covering test", () => {
  const rowsIn =
    (methods: readonly string[], over: (m: string, x: FakeRow) => FakeRow = (_m, x) => x): RowsFn =>
    (m, cu, d, n) =>
      (cu === CU
        ? methods.map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) => over(m, x));
  const ABC = ["A", "B", "C"];
  const SUITE_ABC = ABC.map((m) => ref(m));
  const entriesOf = (r: Rig, m: string) =>
    r.serve.requests
      .flatMap((q) => (q.body.entries as Record<string, unknown>[] | undefined) ?? [])
      .filter((e) => String(e.test) === `Codeunit${CU}.` && String(e.id).startsWith(`${m}|`));
  const stats = (r: Rig) => r.b.entriesStats(); // PR-99: the lanes' counters, summed

  test("the entry leaves out the tests after the last covering one; the NONE warm-up runs the whole codeunit", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    // red without L4: the mutant's entry has no excludeTests and B and C run
    expect(entriesOf(r, "M0001").map((e) => e.excludeTests)).toEqual([
      [`Codeunit${CU}.B`, `Codeunit${CU}.C`],
    ]);
    expect(entriesOf(r, "NONE").every((e) => e.excludeTests === undefined)).toBe(true);
    // review 1: the stats line gives the share left out: 2 of the entry's 3 tests
    expect(stats(r)).toMatchObject({
      l4MutantEntries: 1,
      l4WholeTests: 3,
      l4Entries: 1,
      l4Excluded: 2,
    });
    await r.b.activate("M0001");
    // suiteMissing: B and C have no row, and that is not `missing`
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
  });

  test("a kill by the LAST covering test stays a kill (it runs); only the test after it is left out", async () => {
    const bFails = rowsIn(ABC, (m, x) =>
      m === "M0001" && x.method === "B" ? { ...x, status: "fail" as const, message: "boom" } : x,
    );
    const r = await rig({ suite: SUITE_ABC, serve: { rows: bFails } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B")]));
    expect(entriesOf(r, "M0001").map((e) => e.excludeTests)).toEqual([[`Codeunit${CU}.C`]]);
    await r.b.activate("M0001");
    // red with a cut one test too early: B has no row and reads as missing, not as the kill
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
  });

  test("#8059: a tail test whose name starts a test that must run stays in", async () => {
    const order = ["AB", "A", "C"]; // v3 matches excludeTests by prefix: leaving out `A` drops `AB`
    const suite = order.map((m) => ref(m));
    const saved = SUITE_METHODS[CU];
    SUITE_METHODS[CU] = order;
    try {
      const r = await rig({ suite, serve: { rows: rowsIn(order) } });
      await baseline(r.b, suite);
      await r.b.prefetchMutants(plans(["M0001"], [ref("AB")]));
      // red without the guard: `Codeunit<cu>.A` is left out too, and AB (the covering test) with it
      expect(entriesOf(r, "M0001").map((e) => e.excludeTests)).toEqual([[`Codeunit${CU}.C`]]);
      await r.b.activate("M0001");
      expect((await r.b.run(ref("AB"), OPTS)).outcome).toBe("pass");
    } finally {
      SUITE_METHODS[CU] = saved ?? ["A", "B"];
    }
  });

  test("suiteMissing the other way: a covering test without a row is still missing", async () => {
    const noA: RowsFn = (m, cu, d, n) =>
      rowsIn(ABC)(m, cu, d, n).filter((x) => !(m === "M0001" && x.method === "A"));
    const r = await rig({ suite: SUITE_ABC, serve: { rows: noA } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B")]));
    await r.b.activate("M0001");
    expect((await r.b.run(ref("A"), OPTS)).outcome).not.toBe("pass");
  });

  test("rows out of the baseline order: the cut entry is not used (missing), never read", async () => {
    const swapped: RowsFn = (m, cu, d, n) => {
      const rs = rowsIn(ABC)(m, cu, d, n);
      return m === "M0001" && cu === CU ? [...rs].reverse() : rs;
    };
    const r = await rig({ suite: SUITE_ABC, serve: { rows: swapped } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("B")]));
    await r.b.activate("M0001");
    // red without the order check: B's row is read and the mutant passes
    expect((await r.b.run(ref("B"), OPTS)).outcome).not.toBe("pass");
    expect(stats(r).l4OrderBroken).toBeGreaterThan(0);
  });

  test("a ref the cut left out (not in the plan) runs live without that cut, never read as missing", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.activate("M0001");
    // red without the widening: B has no row in the prefetched call and reads as missing
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    expect(stats(r).l4Widened).toBe(1);
    // the live entry now runs B and still leaves out C
    expect(entriesOf(r, "M0001").at(-1)?.excludeTests).toEqual([`Codeunit${CU}.C`]);
    // review 1: the live repeat of the (mutant, codeunit) entry is not counted again
    expect(stats(r)).toMatchObject({ l4MutantEntries: 1, l4WholeTests: 3, l4Excluded: 2 });
  });
});

// PR-94: a prefetch or live request whose entries are all whole or a prefix cut sends `runSelectedOnly`, so the
// excluded tail does not run (docs/superpowers/specs/2026-11-16-pr94-selected-only-prefix-cuts.md).
describe("PR-94: runSelectedOnly on prefix-cut requests", () => {
  const entry = (codeunit: number, excludeTests?: string[], over: Partial<SentEntry> = {}) =>
    ({
      id: `M|${codeunit}`,
      mutantId: "M",
      key: "M",
      codeunit,
      echo: false,
      resources: {},
      test: `Codeunit${codeunit}.`,
      ...(excludeTests !== undefined ? { excludeTests } : {}),
      ...over,
    }) satisfies SentEntry;
  const echo = entry(9, undefined, { echo: true });
  const tests = (baseline: string[], discovered: string[] = baseline) => ({ baseline, discovered });
  const ABCD = ["a", "b", "c", "d"];
  const decide = (
    sent: SentEntry[],
    of: ReturnType<typeof tests> | Record<number, ReturnType<typeof tests>> = tests(ABCD),
    never: ReadonlySet<number> = new Set(),
  ) => selectedOnlyDecision(sent, (cu) => ("baseline" in of ? of : (of[cu] ?? tests([]))), never);

  test("effectiveExclusion: v3's lower-cased contains, per position (a prefix name takes the longer test)", () => {
    expect(effectiveExclusion(1, ["a", "b"], ["Codeunit1.B"])).toEqual([false, true]);
    // L1: a pattern without a dot matches the method name only, never the `codeunit<id>.` text
    expect(effectiveExclusion(1, ["a", "codeunit1x"], ["codeunit1"])).toEqual([false, true]);
    expect(effectiveExclusion(1, ["a", "b"], ["unit1."])).toEqual([true, true]);
    expect(effectiveExclusion(1, ["ab", "a", "c"], ["Codeunit1.A"])).toEqual([true, true, false]);
    expect(effectiveExclusion(1, ["a"], ["Codeunit2.A"])).toEqual([false]);
    expect(effectiveExclusion(1, ["a", "a"], undefined)).toEqual([false, false]);
  });

  test("a suffix cut gives the flag, with the number of tests it skips", () => {
    expect(decide([echo, entry(1, ["Codeunit1.C", "Codeunit1.D"])])).toEqual({
      flag: true,
      refused: false,
      skipped: 2,
    });
  });

  test("only uncut and echo entries: no flag, and nothing was refused", () => {
    expect(decide([echo, entry(1), entry(1, [])])).toEqual({
      flag: false,
      refused: false,
      skipped: 0,
    });
    // an exclusion that matches no baseline test leaves nothing out
    expect(decide([echo, entry(1, ["Codeunit1.Z"])]).flag).toBe(false);
  });

  test("an uncut entry beside a cut one does not stop the flag", () => {
    expect(decide([echo, entry(1), entry(1, ["Codeunit1.D"])]).flag).toBe(true);
  });

  test("a gap (#8059: the excluded name is a prefix of a test before it) gives no flag, and is counted refused", () => {
    expect(decide([echo, entry(1, ["Codeunit1.B"])], tests(["bx", "x", "b"]))).toEqual({
      flag: false,
      refused: true,
      skipped: 0,
    });
  });

  test("a gapped entry beside a clean cut one refuses the whole request", () => {
    const of = { 1: tests(ABCD), 2: tests(["bx", "x", "b"]) };
    expect(decide([echo, entry(1, ["Codeunit1.D"]), entry(2, ["Codeunit2.B"])], of)).toMatchObject({
      flag: false,
      refused: true,
    });
  });

  test("a codeunit in the never-flag set gives no flag and is not counted refused (H1)", () => {
    expect(decide([echo, entry(1, ["Codeunit1.D"])], tests(ABCD), new Set([1]))).toEqual({
      flag: false,
      refused: false,
      skipped: 0,
    });
    // another codeunit in the set does not matter
    expect(decide([echo, entry(1, ["Codeunit1.D"])], tests(ABCD), new Set([2])).flag).toBe(true);
  });

  test("missingKeptTests: every kept test needs exactly its rows; excluded ones need none", () => {
    const order = ["a", "b", "c", "d"];
    const ex = ["Codeunit1.D"];
    expect(missingKeptTests(1, order, ex, ["A", "B", "C"])).toEqual([]);
    expect(missingKeptTests(1, order, ex, ["A", "C"])).toEqual(["b"]);
    expect(missingKeptTests(1, order, ex, ["A", "B", "C", "C"])).toEqual(["c"]);
    expect(missingKeptTests(1, order, ex, ["A", "B"])).toEqual(["c"]);
    expect(missingKeptTests(1, order, undefined, ["A", "B", "C"])).toEqual(["d"]);
  });

  test("a duplicated name cannot hide a gap", () => {
    // `a` is excluded at both of its places, so `b` sits between two excluded tests
    expect(decide([echo, entry(1, ["Codeunit1.A"])], tests(["a", "b", "a"])).flag).toBe(false);
  });

  test("a codeunit whose discovered set differs from its baseline gives no flag, for a cut or an uncut entry", () => {
    const of = { 1: tests(ABCD), 2: tests(["a", "b"], ["a", "b", "extra"]) };
    expect(decide([echo, entry(1, ["Codeunit1.D"]), entry(2)], of).flag).toBe(false);
    // L2: a mismatch is not a gap, so it is not counted as refused
    expect(decide([echo, entry(2, ["Codeunit2.B"])], of)).toMatchObject({
      flag: false,
      refused: false,
    });
    expect(decide([echo, entry(1, ["Codeunit1.D"])], tests(ABCD, ["a", "b", "c"])).flag).toBe(
      false,
    );
  });

  test("an alone or isolated entry (a call id) keeps its own flag: neither flagged nor refused here", () => {
    expect(
      decide([echo, entry(1, ["Codeunit1.D"]), entry(1, ["Codeunit1.B"], { call: -4 })]),
    ).toEqual({ flag: false, refused: false, skipped: 0 });
  });

  const REFUSAL = "NotRun: out-of-scope: InStream method on an unassigned Variant";
  const asSource = (r: Rig, source: "default" | "explicit") => {
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = source;
    return r;
  };
  const ABC = ["A", "B", "C"];
  const SUITE_ABC = ABC.map((m) => ref(m));
  const rowsIn =
    (methods: readonly string[], over: (m: string, x: FakeRow) => FakeRow = (_m, x) => x): RowsFn =>
    (m, cu, d, n) =>
      (cu === CU
        ? methods.map((method) => ({ method, status: "pass" as const }))
        : allPass(m, cu, d, n)
      ).map((x) => over(m, x));
  const mutantReq = (r: Rig, m: string) =>
    r.serve.requests.filter((q) =>
      ((q.body.entries as Record<string, unknown>[] | undefined) ?? []).some((e) =>
        String(e.id).startsWith(`${m}|`),
      ),
    );
  // PR-99: the counters are per lane; the session totals are `entriesStats()`, summed over the lanes.
  const sstats = (r: Rig) =>
    (
      r.b as unknown as {
        entriesStats(): {
          selectedOnlyRequests: number;
          selectedOnlyTestsSkipped: number;
          selectedOnlyRefusedGapped: number;
        };
      }
    ).entriesStats();

  test("a suffix-cut prefetch carries runSelectedOnly; the warm-up does not; the daemon is the same one (no extra spawn)", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    // red without the flag: the tail would run hidden
    expect(mutantReq(r, "M0001").map((q) => q.body.runSelectedOnly)).toEqual([true]);
    for (const q of r.serve.requests.filter((q) => !mutantReq(r, "M0001").includes(q)))
      expect(q.body.runSelectedOnly).toBeUndefined();
    expect(r.serve.daemons).toHaveLength(1);
    expect(new Set(r.serve.requests.map((q) => q.daemon)).size).toBe(1);
    expect(sstats(r)).toMatchObject({
      selectedOnlyRequests: 1,
      selectedOnlyTestsSkipped: 2,
      selectedOnlyRefusedGapped: 0,
    });
  });

  test("a request of only uncut entries is not flagged (the covering test is the last one)", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("C")]));
    expect(mutantReq(r, "M0001").map((q) => q.body.runSelectedOnly)).toEqual([undefined]);
    expect(sstats(r).selectedOnlyRequests).toBe(0);
    expect(sstats(r).selectedOnlyRefusedGapped).toBe(0);
  });

  test("a live request that widens a cut entry is flagged too", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.activate("M0001");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
    const last = mutantReq(r, "M0001").at(-1);
    expect(last?.body.runSelectedOnly).toBe(true);
    expect((last?.body.entries as Record<string, unknown>[]).at(-1)?.excludeTests).toEqual([
      `Codeunit${CU}.C`,
    ]);
    expect(sstats(r).selectedOnlyRequests).toBe(2);
  });

  test("the baseline and warm-up requests are never flagged, even when they leave a suffix out (R998)", async () => {
    const bAlways: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      );
    const r = asSource(await rig({ serve: { rows: bAlways } }), "default");
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001", "M0002"], [ref("A")]));
    const first = r.serve.requests[0];
    // the warm-up leaves B out (a suffix) and still carries no flag; red when `send` flags warm-ups
    expect(
      (first?.body.entries as Record<string, unknown>[]).some((e) => e.excludeTests !== undefined),
    ).toBe(true);
    expect(first?.body.runSelectedOnly).toBeUndefined();
    // the mutant requests are R998-only suffix cuts and are flagged
    expect(r.serve.requests.slice(1).every((q) => q.body.runSelectedOnly === true)).toBe(true);
  });

  test("suiteMissing's order check runs on an R998-only flagged entry", async () => {
    // C is refused at the baseline and ends the codeunit: R998 alone leaves it out, so the cut adds nothing
    const cRefused: RowsFn = (m, cu, d, n) => {
      const rs = rowsIn(ABC, (_m, x) =>
        x.method === "C" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      )(m, cu, d, n);
      return m === "M0001" && cu === CU ? [...rs].reverse() : rs;
    };
    const r = asSource(await rig({ suite: SUITE_ABC, serve: { rows: cRefused } }), "default");
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B")]));
    const q = mutantReq(r, "M0001")[0];
    expect((q?.body.entries as Record<string, unknown>[]).at(-1)?.excludeTests).toEqual([
      `Codeunit${CU}.C`,
    ]);
    expect(q?.body.runSelectedOnly).toBe(true);
    await r.b.activate("M0001");
    // red without the order check on flagged entries: A's row is read and the mutant passes
    expect((await r.b.run(ref("A"), OPTS)).outcome).not.toBe("pass");
    expect(
      (r.b as unknown as { entriesStats(): { l4OrderBroken: number } }).entriesStats()
        .l4OrderBroken,
    ).toBeGreaterThan(0);
  });

  test("a gapped entry (#8059) is sent as today: no flag, counted as refused, the tail runs hidden", async () => {
    // The backend's own lists never make a gap (R998 and L4 both guard #8059), so the list is forced:
    // v3 reads `Codeunit<cu>.B` as a prefix of BX, which sits BEFORE the kept X.
    const order = ["BX", "X", "B"];
    const suite = order.map((m) => ref(m));
    const saved = SUITE_METHODS[CU];
    SUITE_METHODS[CU] = order;
    try {
      const r = await rig({ suite, serve: { rows: rowsIn(order) } });
      await baseline(r.b, suite);
      (r.b as unknown as { mutantExcludes: () => string[] }).mutantExcludes = () => [
        `Codeunit${CU}.B`,
      ];
      await r.b.prefetchMutants(plans(["M0001"], [ref("X")]));
      const q = mutantReq(r, "M0001")[0];
      expect((q?.body.entries as Record<string, unknown>[]).at(-1)?.excludeTests).toEqual([
        `Codeunit${CU}.B`,
      ]);
      // red without the gap check: the flag is set and BX is skipped though it must run
      expect(q?.body.runSelectedOnly).toBeUndefined();
      expect(sstats(r)).toMatchObject({ selectedOnlyRequests: 0, selectedOnlyRefusedGapped: 1 });
    } finally {
      SUITE_METHODS[CU] = saved ?? ["A", "B"];
    }
  });

  test("the drift re-run counts the new stats once", async () => {
    const KEPT = "NotRun: out-of-scope: conversion of Blob to Integer";
    const rows: RowsFn = (m, cu, d) =>
      cu === CU
        ? ABC.map((method) => {
            const x: FakeRow = { method, status: "pass" };
            if (m === "M0001" && method === "A")
              return { ...x, status: "error" as const, notRun: true, message: KEPT };
            if (m === "M0002" && d === 0 && method === "A")
              return { ...x, status: "fail" as const, message: "boom" };
            return x;
          })
        : allPass(m, cu, d, 0);
    const r = await rig({ suite: SUITE_ABC, serve: { rows }, oneShotRows: rows });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("B")]));
    expect(
      (r.b as unknown as { entriesStats(): { keptDrifts: number } }).entriesStats().keptDrifts,
    ).toBe(1);
    // M0001 skipped B and C; M0002 skipped C once. Red without the restore: 2 requests for M0002 -> 3 and 4
    expect(sstats(r)).toMatchObject({ selectedOnlyRequests: 2, selectedOnlyTestsSkipped: 3 });
  });

  // H1: al-runner's test scan is shallow, so under the flag a test LethAL knows may not run. The fake drops
  // B's row from every flagged answer, as v3 would for `[Test][HandlerFunctions('H')]` on one line.
  const ABCD_NAMES = ["A", "B", "C", "D"];
  const withABCD = async (run: () => Promise<void>) => {
    const saved = SUITE_METHODS[CU];
    SUITE_METHODS[CU] = ABCD_NAMES;
    try {
      await run();
    } finally {
      SUITE_METHODS[CU] = saved ?? ["A", "B"];
    }
  };
  const dropBUnderFlag = (
    req: { body: Record<string, unknown> },
    lines: Record<string, unknown>[],
  ) => {
    if (req.body.runSelectedOnly !== true) return undefined;
    const dropped = lines.filter((l) => l.type === "test" && String(l.name).endsWith(".B"));
    const per = (id: unknown) => dropped.filter((l) => l.entry === id).length;
    return {
      lines: lines
        .filter((l) => !dropped.includes(l))
        .map((l) => {
          const n =
            l.type === "entrySummary" ? per(l.entry) : l.type === "summary" ? dropped.length : 0;
          return n === 0 ? l : { ...l, passed: Number(l.passed) - n, total: Number(l.total) - n };
        }),
    };
  };
  const neverFlagOf = (r: Rig) => (r.b as unknown as { neverFlag: Set<number> }).neverFlag;

  test("H1: a kept row dropped under the flag: the answer is discarded, re-sent unflagged, the codeunit is never flagged again", async () => {
    await withABCD(async () => {
      const suite = ABCD_NAMES.map((m) => ref(m));
      const r = await rig({
        suite,
        serve: { rows: rowsIn(ABCD_NAMES), answer: (req, _n, lines) => dropBUnderFlag(req, lines) },
      });
      const warned: string[] = [];
      r.b.setNotify((code) => warned.push(code));
      await baseline(r.b, suite);
      await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B"), ref("C")]));
      // red without the re-send: B has no row and the mutant's verdict reads missing
      expect(mutantReq(r, "M0001").map((q) => q.body.runSelectedOnly)).toEqual([true, undefined]);
      expect(warned.filter((c) => c === "al-runner-v3-selected-only-scan-gap")).toHaveLength(1);
      expect([...neverFlagOf(r)]).toEqual([CU]);
      // the discarded send is not counted
      expect(sstats(r)).toMatchObject({ selectedOnlyRequests: 0, selectedOnlyTestsSkipped: 0 });
      await r.b.activate("M0001");
      expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
      // red without the never-flag set: the next mutant's request is flagged again
      await r.b.prefetchMutants(plans(["M0002"], [ref("A"), ref("B"), ref("C")]));
      expect(mutantReq(r, "M0002").map((q) => q.body.runSelectedOnly)).toEqual([undefined]);
      expect(warned.filter((c) => c === "al-runner-v3-selected-only-scan-gap")).toHaveLength(1);
    });
  });

  test("H1: a flagged answer that drops nothing stands: no re-send, no warning, no never-flag", async () => {
    await withABCD(async () => {
      const suite = ABCD_NAMES.map((m) => ref(m));
      const r = await rig({ suite, serve: { rows: rowsIn(ABCD_NAMES) } });
      const warned: string[] = [];
      r.b.setNotify((code) => warned.push(code));
      await baseline(r.b, suite);
      await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B"), ref("C")]));
      expect(mutantReq(r, "M0001").map((q) => q.body.runSelectedOnly)).toEqual([true]);
      expect(warned).toEqual([]);
      expect(neverFlagOf(r).size).toBe(0);
      expect(sstats(r).selectedOnlyRequests).toBe(1);
    });
  });

  test("L4: an unflagged R998-only entry keeps the order check OFF (it is a hidden tail, not a prefix cut)", async () => {
    const cRefused: RowsFn = (m, cu, d, n) => {
      const rs = rowsIn(ABC, (_m, x) =>
        x.method === "C" ? { ...x, status: "error" as const, notRun: true, message: REFUSAL } : x,
      )(m, cu, d, n);
      return m === "M0001" && cu === CU ? [...rs].reverse() : rs;
    };
    const r = asSource(await rig({ suite: SUITE_ABC, serve: { rows: cRefused } }), "default");
    await baseline(r.b, SUITE_ABC);
    neverFlagOf(r).add(CU); // so the request goes out unflagged
    await r.b.prefetchMutants(plans(["M0001"], [ref("A"), ref("B")]));
    expect(mutantReq(r, "M0001")[0]?.body.runSelectedOnly).toBeUndefined();
    await r.b.activate("M0001");
    // red if the order check is forced on: the reversed rows are refused as out of order
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
  });

  test("L4: a kill pair request (NONE and the mutant) is flagged when the mutant's entry is cut", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.activate("M0001");
    const n0 = r.serve.requests.length;
    await r.b.sendKillPair("M0001", ref("A"));
    const pair = r.serve.requests.slice(n0);
    expect(pair.length).toBeGreaterThan(0);
    expect(pair.some((q) => q.ids.some((i) => i.startsWith("NONE")))).toBe(true);
    expect(pair.every((q) => q.body.runSelectedOnly === true)).toBe(true);
  });

  // PR-102 (R1097): a kill pair runs only the prefix through the killing test, and the cut goes out only
  // in a request sent with runSelectedOnly (docs/superpowers/specs/2026-11-17-pr102-kill-pair-prefix.md).
  describe("PR-102: a kill pair is cut after its killer", () => {
    const cuEntries = (q: { body: Record<string, unknown> }) =>
      ((q.body.entries as Record<string, unknown>[] | undefined) ?? []).filter(
        (e) => String(e.test) === `Codeunit${CU}.`,
      );
    const cutOf = (e: Record<string, unknown> | undefined) => e?.excludeTests;
    const lower = (xs: string[]) => xs.map((x) => `Codeunit${CU}.${x}`);
    /** A rig past the prefetch of M0001 (covering `covering`) with M0001 active, ready to send a pair. */
    const pairRig = async (
      covering: readonly string[] = ["A", "C"],
      o: Partial<RigOpts> = {},
    ): Promise<Rig> => {
      const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) }, ...o });
      await baseline(r.b, SUITE_ABC);
      await r.b.prefetchMutants(
        plans(
          ["M0001"],
          covering.map((m) => ref(m)),
        ),
      );
      await r.b.activate("M0001");
      return r;
    };
    // PR-99: the lanes' counters, summed
    const stats = (r: Rig) => r.b.entriesStats() as unknown as Record<string, number>;

    test("both entries carry the cut through the killer, and the pair request is flagged", async () => {
      // covering A and C: before PR-102 the M entry was uncut and the NONE entry never cut
      const r = await pairRig();
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", ref("A"));
      const q = r.serve.requests.slice(n0);
      expect(q).toHaveLength(1);
      expect(q[0]?.body.runSelectedOnly).toBe(true);
      expect(cuEntries(q[0] ?? { body: {} }).map(cutOf)).toEqual([
        lower(["B", "C"]),
        lower(["B", "C"]),
      ]);
    });

    test("no cut when the killer is not in the baseline order", async () => {
      const r = await pairRig();
      const n0 = r.serve.requests.length;
      await r.b.sendKillPair("M0001", ref("Z"));
      const q = r.serve.requests[n0];
      expect(cuEntries(q ?? { body: {} }).map(cutOf)).toEqual([undefined, undefined]);
      expect(q?.body.runSelectedOnly).toBeUndefined();
    });

    test("#8059: a tail test whose name starts the killer or a kept test stays in", async () => {
      const order = ["AB", "A", "C"];
      const saved = SUITE_METHODS[CU];
      SUITE_METHODS[CU] = order;
      try {
        const suite = order.map((m) => ref(m));
        const r = await rig({ suite, serve: { rows: rowsIn(order) } });
        await baseline(r.b, suite);
        await r.b.prefetchMutants(plans(["M0001"], [ref("AB")]));
        await r.b.activate("M0001");
        const n0 = r.serve.requests.length;
        await r.b.sendKillPair("M0001", ref("AB"));
        // red without the keep rule: `A` is left out too, and v3 drops AB with it (prefix match)
        expect(cuEntries(r.serve.requests[n0] ?? { body: {} }).map(cutOf)).toEqual([
          lower(["C"]),
          lower(["C"]),
        ]);
      } finally {
        SUITE_METHODS[CU] = saved ?? ["A", "B"];
      }
    });

    test("under NONE, after the confirm, a test after the killer runs live and never reads the pair's rows", async () => {
      const r = await pairRig();
      await r.b.sendKillPair("M0001", ref("A"));
      await r.b.activate(null);
      expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
      const n0 = r.serve.requests.length;
      // red without the NONE branch: the cut pair has no B row and the run is a rowMissing throw
      expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
      expect(r.serve.requests).toHaveLength(n0 + 1);
      expect(cuEntries(r.serve.requests[n0] ?? { body: {} }).map(cutOf)).toEqual([undefined]);
      // the NONE widen is not an L4 widen
      expect(stats(r).l4Widened).toBe(0);
    });

    test("still holds: under the mutant, a covering test after the killer is widened live (L4)", async () => {
      const r = await pairRig();
      await r.b.sendKillPair("M0001", ref("A"));
      await r.b.activate(null);
      await r.b.run(ref("A"), OPTS);
      await r.b.activate("M0001");
      expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
      const n0 = r.serve.requests.length;
      expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
      expect(stats(r).l4Widened).toBe(1);
      expect(r.serve.requests).toHaveLength(n0 + 1);
    });

    test("a pair's cut does not move the l4* stats", async () => {
      const r = await pairRig();
      await r.b.activate("M0002"); // never prefetched: a counted cut would add its entry
      const keys = ["l4MutantEntries", "l4WholeTests", "l4Entries", "l4Excluded", "l4Widened"];
      const before = keys.map((k) => stats(r)[k]);
      await r.b.sendKillPair("M0002", ref("A"));
      expect(keys.map((k) => stats(r)[k])).toEqual(before);
    });

    describe("H1: the cut goes out only with the flag", () => {
      const sentCuts = (r: Rig, n0: number) =>
        r.serve.requests.slice(n0).map((q) => ({
          flag: q.body.runSelectedOnly,
          cuts: cuEntries(q).map(cutOf),
        }));

      test("a neverFlag codeunit's pair is sent uncut", async () => {
        const r = await pairRig();
        neverFlagOf(r).add(CU);
        const n0 = r.serve.requests.length;
        await r.b.sendKillPair("M0001", ref("A"));
        expect(sentCuts(r, n0)).toEqual([{ flag: undefined, cuts: [undefined, undefined] }]);
      });

      test("a #8059 gap in the pair's cut: sent uncut", async () => {
        const order = ["BX", "X", "B"];
        const saved = SUITE_METHODS[CU];
        SUITE_METHODS[CU] = order;
        try {
          const suite = order.map((m) => ref(m));
          const r = await rig({ suite, serve: { rows: rowsIn(order) } });
          await baseline(r.b, suite);
          await r.b.prefetchMutants(plans(["M0001"], [ref("X")]));
          await r.b.activate("M0001");
          (r.b as unknown as { cutAfterKiller: () => string[] }).cutAfterKiller = () =>
            lower(["B"]);
          const n0 = r.serve.requests.length;
          await r.b.sendKillPair("M0001", ref("X"));
          expect(sentCuts(r, n0)).toEqual([{ flag: undefined, cuts: [undefined, undefined] }]);
        } finally {
          SUITE_METHODS[CU] = saved ?? ["A", "B"];
        }
      });

      test("the scan-gap re-send of a pair carries no cut", async () => {
        await withABCD(async () => {
          const suite = ABCD_NAMES.map((m) => ref(m));
          const r = await rig({
            suite,
            serve: {
              rows: rowsIn(ABCD_NAMES),
              answer: (req, _n, lines) => dropBUnderFlag(req, lines),
            },
          });
          await baseline(r.b, suite);
          await r.b.prefetchMutants(plans(["M0001"], [ref("D")]));
          await r.b.activate("M0001");
          const n0 = r.serve.requests.length;
          await r.b.sendKillPair("M0001", ref("C"));
          // the re-send is unflagged because the codeunit is now in neverFlag; `sendInFlight` then drops
          // the cut. Red when it keeps it: the second request would hide a tail v3 still runs.
          expect(sentCuts(r, n0)).toEqual([
            { flag: true, cuts: [lower(["D"]), lower(["D"])] },
            { flag: undefined, cuts: [undefined, undefined] },
          ]);
        });
      });

      test("the drift re-send of a pair carries no cut", async () => {
        const KEPT = "NotRun: out-of-scope: conversion of Blob to Integer";
        let armed = false;
        const rows: RowsFn = (m, cu, d) =>
          cu === CU
            ? ABC.map((method) => {
                const x: FakeRow = { method, status: "pass" };
                if (m === "M0001" && method === "A")
                  return { ...x, status: "error" as const, notRun: true, message: KEPT };
                if (armed && d === 0 && m === "NONE" && method === "A")
                  return { ...x, status: "fail" as const, message: "boom" };
                return x;
              })
            : allPass(m, cu, d, 0);
        const r = await rig({ suite: SUITE_ABC, serve: { rows }, oneShotRows: rows });
        await baseline(r.b, SUITE_ABC);
        await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
        armed = true;
        await r.b.activate("M0002");
        const n0 = r.serve.requests.length;
        await r.b.sendKillPair("M0002", ref("B"));
        expect(r.b.entriesStats().keptDrifts).toBe(1);
        // The drift re-send is not a neverFlag case: the decision would flag it again. It carries no cut
        // because `requestOne` strips it (red when that strip is removed).
        // the fresh daemon's warm-up sits between the two pair requests
        const sent = sentCuts(r, n0);
        expect(sent).toHaveLength(3);
        expect(sent[0]).toEqual({ flag: true, cuts: [lower(["C"]), lower(["C"])] });
        expect(sent[2]).toEqual({ flag: undefined, cuts: [undefined, undefined] });
      });
    });

    describe("a stored batched pair (R778, L1)", () => {
      const batched = async (): Promise<Rig> => {
        const r = await rig({
          suite: SUITE_ABC,
          serve: {
            rows: (m, cu, d, n) =>
              rowsIn(ABC)(m, cu, d, n).map((x) =>
                m !== "NONE" && x.method === "B"
                  ? { ...x, status: "fail" as const, message: "boom" }
                  : x,
              ),
          },
          oneShotRows: rowsIn(ABC),
          pairBatch: true,
        });
        await baseline(r.b, SUITE_ABC);
        await r.b.prefetchMutants(plans(["M0001"], SUITE_ABC));
        await r.b.activate("M0001");
        expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
        return r;
      };
      // PR-99: the stored pairs are the lane's; at N = 1 the owner's own lane
      const storeOf = (r: Rig) =>
        (
          r.b as unknown as {
            lane: { prefetch: { pairStore: Map<string, { through?: string | undefined }> } };
          }
        ).lane.prefetch.pairStore;
      const counts = (r: Rig) => r.b.entriesStats();

      // The kill ledger (R197) can pick any failing covering test as the killer, so the batch cuts after
      // the LAST failing one: here A and B both fail and the actual kill is B.
      test("A and B both fail in the prefetch and the kill is B: the pair is cut after B and served", async () => {
        const r = await rig({
          suite: SUITE_ABC,
          serve: {
            rows: (m, cu, d, n) =>
              rowsIn(ABC)(m, cu, d, n).map((x) =>
                m !== "NONE" && (x.method === "A" || x.method === "B")
                  ? { ...x, status: "fail" as const, message: "boom" }
                  : x,
              ),
          },
          oneShotRows: rowsIn(ABC),
          pairBatch: true,
        });
        await baseline(r.b, SUITE_ABC);
        await r.b.prefetchMutants(plans(["M0001"], SUITE_ABC));
        await r.b.activate("M0001");
        expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
        expect([...storeOf(r).values()].map((v) => v.through)).toEqual(["B"]);
        const last = r.serve.requests.at(-1);
        expect(last?.body.runSelectedOnly).toBe(true);
        expect(cuEntries(last ?? { body: {} }).map(cutOf)).toEqual([lower(["C"]), lower(["C"])]);
        const before = counts(r);
        await r.b.sendKillPair("M0001", ref("B"));
        const after = counts(r);
        expect(after.pairBatchServed - before.pairBatchServed).toBe(1);
        expect(after.pairBatchRefused).toBe(0);
      });

      test("the batch's pair is cut through the killer and served to that killer", async () => {
        const r = await batched();
        expect([...storeOf(r).values()].map((v) => v.through)).toEqual(["B"]);
        const last = r.serve.requests.at(-1);
        expect(last?.body.runSelectedOnly).toBe(true);
        expect(cuEntries(last ?? { body: {} }).map(cutOf)).toEqual([lower(["C"]), lower(["C"])]);
        await r.b.sendKillPair("M0001", ref("B"));
        expect(counts(r)).toMatchObject({ pairBatchServed: 1, pairBatchRefused: 0 });
      });

      test("a killer after `through` is refused and the pair is sent fresh", async () => {
        const r = await batched();
        const n0 = r.serve.requests.length;
        await r.b.sendKillPair("M0001", ref("C"));
        expect(counts(r)).toMatchObject({ pairBatchServed: 0, pairBatchRefused: 1 });
        expect(r.serve.requests).toHaveLength(n0 + 1);
      });

      test("a ref or a through that is not in the baseline order is refused", async () => {
        const r = await batched();
        await r.b.sendKillPair("M0001", ref("Z"));
        expect(counts(r)).toMatchObject({ pairBatchServed: 0, pairBatchRefused: 1 });
        const r2 = await batched();
        for (const [k, v] of storeOf(r2)) storeOf(r2).set(k, { ...v, through: "Zed" });
        await r2.b.sendKillPair("M0001", ref("B"));
        expect(counts(r2)).toMatchObject({ pairBatchServed: 0, pairBatchRefused: 1 });
      });

      test("an uncut stored pair is served as today", async () => {
        const r = await batched();
        for (const [k, v] of storeOf(r)) storeOf(r).set(k, { ...v, through: undefined });
        await r.b.sendKillPair("M0001", ref("C"));
        expect(counts(r)).toMatchObject({ pairBatchServed: 1, pairBatchRefused: 0 });
      });
    });
  });

  test("the stats line names the three counters", async () => {
    const r = await rig({ suite: SUITE_ABC, serve: { rows: rowsIn(ABC) } });
    await baseline(r.b, SUITE_ABC);
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await r.b.close();
      expect(
        warn.mock.calls.some((a) =>
          String(a[0]).includes(
            "selected-only requests (PR-94) 1, tests skipped 2, refused for a gap 0",
          ),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("PR-21 (L5): re-check of a reused serve baseline", () => {
  const PUB = "Acme Pub";
  const NAME = "T"; // the rig's app name
  const msg = (v: string, tail = "boom") => `${tail} in ${NAME} by ${PUB} version ${v}`;
  const rowsWith =
    (text: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        x.method === "B" ? { ...x, status: "fail" as const, message: text } : x,
      );
  // R1123 (PR-146): coverage on, so the re-check's coverage guard compares real maps (under "none" it compares none)
  const named = (opts: RigOpts) =>
    rig({
      ...opts,
      appExtra: { publisher: PUB },
      extra: { coverage: "al-runner", ...opts.extra },
      oneShotCoverage: plainCoverage,
    });
  const rowsOf = (r: Rig) =>
    (r.b as unknown as { baselineRows: Map<number, unknown[]> }).baselineRows;
  /** Each first session's stored coverage, as the orchestrator builds it from the baseline verdicts. */
  const storedOf = new Map<Rig, ReadonlyMap<string, string>>();
  /** A second session, in the baseline bracket the orchestrator holds, re-checks `first`'s state. */
  const recheck = async (
    first: Rig,
    rows: RowsFn,
    patch: (s: Record<string, unknown>) => unknown = (s) => s,
    coverage: ReadonlyMap<string, string> = storedOf.get(first) ?? new Map(),
  ) => {
    const state = await first.b.baselineState();
    const r2 = await named({ serve: { rows, coverage: plainCoverage } });
    r2.b.baselinePhase(true);
    const why = await r2.b.recheckReusedBaseline(
      patch(JSON.parse(JSON.stringify(state)) as Record<string, unknown>),
      coverage,
      1000,
    );
    return { why, r2 };
  };
  const firstOf = async (rows: RowsFn) => {
    const r = await named({ serve: { rows, coverage: plainCoverage } });
    const verdicts = await baseline(r.b, SUITE1);
    storedOf.set(
      r,
      new Map(
        verdicts.map((v) => [
          `codeunit${v.ref.codeunitId}.${v.ref.method}`.toLowerCase(),
          JSON.stringify(v.coverage ?? null),
        ]),
      ),
    );
    return r;
  };

  test("1: the state round-trips: an equal second session reuses it and holds the same rows", async () => {
    const r1 = await firstOf(allPass);
    expect(await r1.b.baselineState()).toBeDefined();
    const { why, r2 } = await recheck(r1, allPass);
    expect(why).toBeUndefined();
    expect(rowsOf(r2).size).toBeGreaterThan(0);
    // review 1: this session's own rows are imported, so compare what the re-check compares
    const shape = (r: Rig) =>
      [...rowsOf(r).entries()].map(([k, rs]) => [
        k,
        (rs as Record<string, unknown>[]).map((x) => [x.method, x.status, x.notRun, x.message]),
      ]);
    expect(shape(r2)).toEqual(shape(r1));
  });

  test("PR-98: after lanes(2) the re-check runs on lane 0 and imports the rows; lane 1 holding a daemon throws by name", async () => {
    const r1 = await firstOf(allPass);
    const state = await r1.b.baselineState();
    const r2 = await named({ serve: { rows: allPass, coverage: plainCoverage }, lanes: 2 });
    r2.b.baselinePhase(true);
    const why = await r2.b.recheckReusedBaseline(
      JSON.parse(JSON.stringify(state)),
      storedOf.get(r1) ?? new Map(),
      1000,
    );
    expect(why).toBeUndefined();
    expect(rowsOf(r2).size).toBeGreaterThan(0);
    // a lane beyond lane 0 holding a daemon makes the call a misuse, by name
    r2.b.baselinePhase(false);
    const v1 = r2.views[1];
    if (v1 === undefined) throw new Error("no lane 1");
    await v1.activate("M0001");
    await v1.run(SUITE1[0] as TestMethodRef, OPTS);
    r2.b.baselinePhase(true);
    await expect(
      r2.b.recheckReusedBaseline(
        JSON.parse(JSON.stringify(state)),
        storedOf.get(r1) ?? new Map(),
        1000,
      ),
    ).rejects.toThrow(
      /al-runner-v3-lane-misuse: recheckReusedBaseline\(\) was called while lane 1 holds a daemon/,
    );
  });

  // PR-98 (PR-89 fix 1): a --workers 2 run's backend is `splitBackend(owner, lane0)`. Tested at the
  // backend level (no orchestrator fake exists for a lane-capable owner); the orchestrator's
  // "resume-baseline-reused" event is r619-one-lend's, with a stub backend.
  test("PR-98: through splitBackend, a fresh two-lane run stores backend state and a two-lane resume re-checks it", async () => {
    const first = await named({ serve: { rows: allPass, coverage: plainCoverage }, lanes: 2 });
    const v0 = first.views[0];
    if (v0 === undefined) throw new Error("no lane 0");
    const verdicts: TestVerdict[] = [];
    first.b.baselinePhase(true);
    try {
      await v0.activate(null);
      for (const t of SUITE1) verdicts.push(await v0.run(t, OPTS));
    } finally {
      first.b.baselinePhase(false);
    }
    const state = await splitBackend(first.b, v0).baselineState?.();
    expect(state).toBeDefined();
    const stored = new Map(
      verdicts.map((v) => [
        `codeunit${v.ref.codeunitId}.${v.ref.method}`.toLowerCase(),
        JSON.stringify(v.coverage ?? null),
      ]),
    );
    const resumed = await named({ serve: { rows: allPass, coverage: plainCoverage }, lanes: 2 });
    const w0 = resumed.views[0];
    if (w0 === undefined) throw new Error("no lane 0");
    const split = splitBackend(resumed.b, w0);
    expect(split.resumeRunsBaseline).toBe(resumed.b.resumeRunsBaseline);
    resumed.b.baselinePhase(true);
    const why = await split.recheckReusedBaseline?.(
      JSON.parse(JSON.stringify(state)),
      stored,
      1000,
    );
    expect(why).toBeUndefined();
    expect(rowsOf(resumed).size).toBeGreaterThan(0);
  });

  test("2: a row that differs refuses by name and imports nothing", async () => {
    const r1 = await firstOf(allPass);
    const { why, r2 } = await recheck(r1, rowsWith("boom"));
    expect(why).toContain("the re-check");
    expect(why).toContain(String(CU));
    expect(rowsOf(r2).size).toBe(0);
  });

  test("3: only the target app's minted version is masked", async () => {
    const r1 = await firstOf(rowsWith(msg("1.0.0.1")));
    expect((await recheck(r1, rowsWith(msg("1.0.0.2")))).why).toBeUndefined();
    expect((await recheck(r1, rowsWith(msg("1.0.0.1", "bang")))).why).toContain("the re-check");
    const other = (v: string) => `boom in Other App by X version ${v}`;
    const r3 = await firstOf(rowsWith(other("1.2.3.4")));
    expect((await recheck(r3, rowsWith(other("1.2.3.5")))).why).toContain("the re-check");
  });

  test("4: no usable state, or another seed, refuses by name", async () => {
    const r1 = await firstOf(allPass);
    const none = await recheck(r1, allPass, () => undefined);
    expect(none.why).toStartWith("no backend state");
    const bad = await recheck(r1, allPass, (s) => ({ ...s, rows: "x" }));
    expect(bad.why).toStartWith("no backend state");
    const seed = await recheck(r1, allPass, (s) => ({ ...s, seed: 12345 }));
    expect(seed.why).toStartWith("the seed");
    expect(rowsOf(seed.r2).size).toBe(0);
  });

  test("5: another sidecar hash refuses by name", async () => {
    const r1 = await firstOf(allPass);
    const { why } = await recheck(r1, allPass, (s) => ({ ...s, sidecarSha256: "abc" }));
    expect(why).toStartWith("the .NET sidecar");
  });

  test("6: a stored coverage map that differs refuses by name", async () => {
    const r1 = await firstOf(allPass);
    const { why } = await recheck(
      r1,
      allPass,
      (s) => s,
      new Map([[`codeunit${CU}.a`, JSON.stringify({ not: "it" })]]),
    );
    expect(why).toContain("coverage differs");
  });

  test("7 (review 2): an equal stored coverage map passes; a sampled codeunit with nothing to compare refuses", async () => {
    const r1 = await firstOf(allPass);
    expect((await recheck(r1, allPass)).why).toBeUndefined(); // the first session's own maps
    // the stored keys renamed: nothing matches, so the check must not pass empty vs empty
    const renamed = new Map(
      [...(storedOf.get(r1) ?? new Map<string, string>())].map(([k, v]) => [`x${k}`, v]),
    );
    const { why } = await recheck(r1, allPass, (s) => s, renamed);
    expect(why).toContain("no stored coverage to compare");
  });

  test("R1123: under coverage none no map is compared, and the re-check says so by name instead of passing null vs null", async () => {
    const state = await (await firstOf(allPass)).b.baselineState();
    const r2 = await named({
      serve: { rows: allPass, coverage: plainCoverage },
      extra: { coverage: "none" },
    });
    r2.b.baselinePhase(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // nothing stored to compare: under coverage on this refuses (test 7); under none the rows decide
      const why = await r2.b.recheckReusedBaseline(
        JSON.parse(JSON.stringify(state)),
        new Map(),
        1000,
      );
      expect(why).toBeUndefined();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("re-check: coverage not compared")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("R1123: a failing test's null vs null is not a comparison: with the passing test's map missing, it refuses", async () => {
    const rows = rowsWith("boom"); // B fails, A passes
    const r1 = await firstOf(rows);
    // keep only B's stored entry ("null"): A's map is missing, so nothing real is compared
    const onlyB = new Map(
      [...(storedOf.get(r1) ?? new Map<string, string>())].filter(([k]) => k.endsWith(".b")),
    );
    expect([...onlyB.values()]).toEqual(["null"]);
    const { why } = await recheck(r1, rows, (s) => s, onlyB);
    expect(why).toContain("no stored coverage to compare");
  });

  test("8 (review 1): the rows imported are this session's re-check rows, not the stored ones", async () => {
    const r1 = await firstOf(allPass);
    // the stored rows carry a tail the re-check does not compare (a refusal's first line only):
    // a notRun row whose second line differs
    const { why, r2 } = await recheck(r1, allPass, (s) => {
      const rows = s.rows as [number, Record<string, unknown>[]][];
      return {
        ...s,
        rows: rows.map(([k, rs]) => [k, rs.map((r) => ({ ...r, stored: true }))]),
      };
    });
    expect(why).toBeUndefined();
    for (const rs of rowsOf(r2).values())
      for (const r of rs as Record<string, unknown>[]) expect(r.stored).toBeUndefined();
  });
});

// PR-56: after a request whose rows hold a KEPT refusal (V3_SERVE_SAFE_REFUSALS), the NEXT request on the same
// daemon is checked against the baseline: a NONE row, or a row of a test before the first one covering the
// mutant, must equal it. On a difference the daemon closes, the request runs again on a fresh daemon, and
// those rows stand. The fake's `d` is the daemon number: daemon 0 drifts, daemon 1 (the fresh one) does not.
describe("PR-56: drift after a kept refusal", () => {
  const KEPT = "NotRun: out-of-scope: conversion of Blob to Integer";
  const ABC = ["A", "B", "C"];
  const SUITE_ABC = ABC.map((m) => ref(m));
  type Over = (m: string, x: FakeRow, d: number, n: number) => FakeRow;
  const refused = (x: FakeRow): FakeRow => ({
    ...x,
    status: "error",
    notRun: true,
    message: KEPT,
  });
  const failed = (x: FakeRow): FakeRow => ({ ...x, status: "fail", message: "boom" });
  const driftRig = async (over: Over) => {
    const rows: RowsFn = (m, cu, d, n) =>
      cu === CU
        ? ABC.map((method) => over(m, { method, status: "pass" }, d, n))
        : allPass(m, cu, d, n);
    const r = await rig({ suite: SUITE_ABC, serve: { rows }, oneShotRows: rows });
    const events: V3KeptDrift[] = [];
    const warned: string[] = [];
    r.b.setKeptDriftSink((e) => events.push(e));
    r.b.setNotify((code) => warned.push(code));
    await baseline(r.b, SUITE_ABC);
    return { r, events, warned };
  };
  const keptsIn = (m: string, x: FakeRow) => (m === "M0001" && x.method === "A" ? refused(x) : x);
  const driftStats = (r: Rig) => r.b.entriesStats(); // PR-99: the lanes' counters, summed
  const CODE = "al-runner-v3-serve-drift-after-kept-refusal";

  test("a row before the first covering test differs: the daemon closes, the request re-runs fresh and the fresh rows stand", async () => {
    const { r, events, warned } = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0002" && d === 0 && x.method !== "C" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    expect(r.serve.daemons.length).toBe(1);
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    // red without the guard: one daemon, and the drifted rows are used
    expect(r.serve.daemons.length).toBe(2);
    expect(events).toEqual([
      {
        lane: 0,
        refusal: KEPT,
        test: `Codeunit${CU}.A`,
        baselineRow: "a=pass",
        row: "a=fail",
      },
    ]);
    expect(warned.filter((c) => c === CODE)).toEqual([CODE]);
    expect(driftStats(r).keptDrifts).toBe(1);
    expect(r.b.daemonCloses().byReason.get("kept-refusal-drift")).toBe(1);
    await r.b.activate("M0002");
    // B differed on daemon 0 too: the drifted rows would be a kill, the fresh daemon's are a pass
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("pass");
  });

  test("the covering test's own row differs: that is a kill, not drift", async () => {
    const { r, events } = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0002" && d === 0 && x.method === "B" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(events).toEqual([]);
    expect(r.serve.daemons.length).toBe(1);
    await r.b.activate("M0002");
    expect((await r.b.run(ref("B"), OPTS)).outcome).toBe("fail");
  });

  test("a later non-covering test differs: state flows forward, so that is not drift", async () => {
    const { r, events } = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0002" && d === 0 && x.method === "B" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    // covering A and C: B lies after the first covering test and is not covering
    await r.b.prefetchMutants(plans(["M0002"], [ref("A"), ref("C")]));
    expect(events).toEqual([]);
    expect(r.serve.daemons.length).toBe(1);
  });

  test("a NONE row differs (a kill pair): same close, fresh re-run, the fresh NONE rows stand", async () => {
    const { r, events } = await driftRig((m, x, d, n) =>
      m === "M0002" && x.method === "A"
        ? refused(keptsIn(m, x))
        : keptsIn(m, m === "NONE" && d === 0 && n >= 3 && x.method === "A" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("A")]));
    expect(events).toEqual([]);
    await r.b.activate("M0002");
    await r.b.sendKillPair("M0002", ref("A"));
    expect(events.map((e) => [e.test, e.baselineRow, e.row])).toEqual([
      [`Codeunit${CU}.A`, "a=pass", "a=fail"],
    ]);
    expect(r.serve.daemons.length).toBe(2);
    await r.b.activate(null);
    // red if the drifted NONE rows were used: A would read fail
    expect((await r.b.run(ref("A"), OPTS)).outcome).toBe("pass");
  });

  test("only the request right after a kept refusal is checked", async () => {
    const { r, events } = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0003" && d === 0 && x.method === "A" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")])); // kept refusal
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")])); // checked, clean, no refusal
    await r.b.prefetchMutants(plans(["M0003"], [ref("B"), ref("C")])); // would drift, not checked
    expect(events).toEqual([]);
    expect(r.serve.daemons.length).toBe(1);
  });

  test("a test the baseline refused is not compared", async () => {
    // A is a kept refusal in the baseline and everywhere else, except under M0002 on daemon 0 (a pass)
    const { r, events } = await driftRig((m, x, d) =>
      x.method === "A" && !(m === "M0002" && d === 0) ? refused(x) : x,
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("B")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(events).toEqual([]);
  });

  test("R1115: in a mutant entry, a test red at baseline that now passes is not drift (its reach is unknown)", async () => {
    // A fails at baseline and everywhere, except under M0002 on daemon 0, where the mutant makes it pass
    const { r, events } = await driftRig((m, x, d) => {
      if (x.method === "A") return m === "M0002" && d === 0 ? x : failed(x);
      return m === "M0001" && x.method === "C" ? refused(x) : x;
    });
    await r.b.prefetchMutants(plans(["M0001"], [ref("C")])); // kept refusal
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")])); // A is before B, the first covering test
    // red without the R1115 skip: one drift event and a second daemon
    expect(events).toEqual([]);
    expect(r.serve.daemons.length).toBe(1);
  });

  test("R1115: a NONE entry still compares a test red at baseline", async () => {
    // A fails at baseline; on daemon 0 from the 3rd request on, a NONE run of A passes (carried state)
    const { r, events } = await driftRig((m, x, d, n) => {
      if (x.method === "A") return m === "NONE" && d === 0 && n >= 2 ? x : failed(x);
      return m === "M0002" && x.method === "B" ? refused(x) : x;
    });
    await r.b.prefetchMutants(plans(["M0002"], [ref("B")])); // kept refusal
    await r.b.activate("M0002");
    await r.b.sendKillPair("M0002", ref("B"));
    // red if the skip ignored the entry kind: no event
    expect(events.map((e) => [e.test, e.baselineRow, e.row])).toEqual([
      [`Codeunit${CU}.A`, "a=fail", "a=pass"],
    ]);
  });

  test("R1115: in a mutant entry, a test green at baseline that now fails is still drift", async () => {
    const { r, events } = await driftRig((m, x, d) => {
      if (x.method === "A") return m === "M0002" && d === 0 ? failed(x) : x;
      return m === "M0001" && x.method === "C" ? refused(x) : x;
    });
    await r.b.prefetchMutants(plans(["M0001"], [ref("C")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(events.map((e) => [e.test, e.baselineRow, e.row])).toEqual([
      [`Codeunit${CU}.A`, "a=pass", "a=fail"],
    ]);
  });

  test("review M1: a NONE confirm run alone after a kept refusal is not compared", async () => {
    const { r, events } = await driftRig((m, x, d, n) =>
      keptsIn(m, m === "NONE" && d === 0 && n >= 2 && x.method === "A" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.activate(null);
    // red without the skip: the alone row of A differs from the codeunit run's baseline row, as it may
    const v = await r.b.run(ref("A"), { ...OPTS, alone: true });
    expect(v.outcome).toBe("fail");
    expect(events).toEqual([]);
    expect(r.serve.daemons.length).toBe(1);
  });

  test("review L1: a drift re-run counts the request once (requests, entries, the bound invariant)", async () => {
    const { r } = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0002" && d === 0 && x.method === "A" ? failed(x) : x),
    );
    await r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(r.serve.daemons.length).toBe(2);
    const s = r.b.entriesStats();
    expect(s.prefetchRequests).toBe(2); // red if the drifted send also counts: 3
    // the drifted request is the third the fake saw (warm-up, M0001, M0002); the rest were counted
    const idsOf = r.serve.requests.map((q) => q.ids.length);
    expect(s.entriesSent).toBe(idsOf.reduce((a, b) => a + b, 0) - (idsOf[2] ?? 0));
    expect(s.boundChecks).toBe(
      s.warmups + s.prefetchRequests + s.liveRequests + s.coverageRequests,
    );
  });

  test("review L2: a timeout row is not drift, and a request cut at a timeout is not re-run", async () => {
    const timeout = (x: FakeRow): FakeRow => ({
      ...x,
      status: "error",
      notRun: true,
      message: TIMEOUT_1S,
    });
    // default seams: the timeout row is read to the end, before the first covering test
    const t = await driftRig((m, x, d) =>
      keptsIn(m, m === "M0002" && d === 0 && x.method === "A" ? timeout(x) : x),
    );
    await t.r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await t.r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(t.events).toEqual([]);
    expect(driftStats(t.r).keptDrifts).toBe(0);
    // a build that retires the Sleep rule cuts at the timeout row (B): A differs before it, yet no re-run
    const c = await driftRig((m, x, d) =>
      keptsIn(
        m,
        m === "M0002" && d === 0
          ? x.method === "A"
            ? failed(x)
            : x.method === "B"
              ? timeout(x)
              : x
          : x,
      ),
    );
    Object.assign(c.r.b.seams, { sleepRuleRetired: true });
    await c.r.b.prefetchMutants(plans(["M0001"], [ref("A")]));
    await c.r.b.prefetchMutants(plans(["M0002"], [ref("B"), ref("C")]));
    expect(c.r.b.entriesStats().timeoutCuts).toBe(1);
    expect(c.events).toEqual([]);
    expect(driftStats(c.r).keptDrifts).toBe(0);
  });
});

// PR-100: where a run's time went. Spec docs/superpowers/specs/2026-11-17-pr100-timing-visibility.md §1, §2.
describe("PR-100: serve-request-timed, and the phase a daemon closed in", () => {
  const REFUSED = "NotRun: out-of-scope: WithEvents subscriber 'Probe Sub' (not pinned)";
  const refusedFor =
    (who: string): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === who && x.method === "A"
          ? { ...x, status: "error" as const, notRun: true, message: REFUSED }
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
  const watchedRig = async (opts: RigOpts) => {
    const r = await rig({ oneShotRows: allPass, ...opts });
    const timed: V3RequestTimed[] = [];
    const closed: { reason: string; phase: string }[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    r.b.setDaemonCloseSink((c) => closed.push({ reason: c.reason, phase: c.phase }));
    await baseline(r.b, SUITE1);
    return { r, timed, closed };
  };
  const warmupCauses = (t: readonly V3RequestTimed[]) =>
    t.filter((e) => e.kind === "warmup").map((e) => e.cause);

  test("closeLane stamps the kind in flight: a refusal after a prefetch says prefetch", async () => {
    const { r, closed } = await watchedRig({ serve: { rows: refusedFor("M0002") } });
    await r.b.prefetchMutants(plans(["M0001", "M0002", "M0003"]));
    expect(closed).toEqual([{ reason: "refusal", phase: "prefetch" }]);
  });

  test("closeLane stamps idle between requests: a recycle is not in a request", async () => {
    const { r, closed } = await watchedRig({
      serve: { rows: killsM1 },
      extra: { daemonMaxRequests: 2 },
    });
    for (const m of ["M0001", "M0002", "M0003"]) await r.b.prefetchMutants(plans([m]));
    const recycles = closed.filter((c) => c.reason === "recycle");
    expect(recycles.length).toBeGreaterThan(0);
    expect(recycles.every((c) => c.phase === "idle")).toBe(true);
  });

  test("one serve-request-timed per send, each with LethAL's wall clock and its counts", async () => {
    const { r, timed } = await watchedRig({ serve: { rows: allPass } });
    await r.b.prefetchMutants(plans(["M0001", "M0002"]));
    expect(timed.length).toBe(r.serve.requests.length);
    expect(timed.map((e) => e.kind)).toEqual(["warmup", "prefetch"]);
    for (const e of timed) {
      expect(e.lane).toBe(0);
      expect(e.wallMs).toBeGreaterThanOrEqual(0);
      expect(e.entries).toBeGreaterThan(0);
      expect(e.tests).toBeGreaterThan(0);
    }
    expect(timed.some((e) => e.failed === true || e.cut === true)).toBe(false);
  });

  test("PR-113: each baseline plain request is timed as kind baseline, and nothing else is", async () => {
    const r = await dbRig();
    const timed: V3RequestTimed[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    await baseline(r.b, SUITE3);
    expect(r.serve.requests).toHaveLength(3);
    expect(timed.map((e) => e.kind)).toEqual(["baseline", "baseline", "baseline"]);
    for (const e of timed) {
      expect(e.lane).toBe(0);
      expect(e.entries).toBe(1);
      expect(e.tests).toBeGreaterThan(0);
      expect(e.wallMs).toBeGreaterThanOrEqual(0);
      expect(e.cause).toBeUndefined();
    }
  });

  test("PR-113: a baseline event carries al-runner's timings", async () => {
    const r = await dbRig({
      serve: {
        answer: (_q, _n, ls) => ({
          lines: ls.map((x) =>
            x.type === "summary" ? { ...x, timings: { setupMs: 7, engineMs: 8 } } : x,
          ),
        }),
      },
    });
    const timed: V3RequestTimed[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    await baseline(r.b, SUITE3);
    expect(timed.length).toBeGreaterThan(0);
    for (const e of timed) expect(e.timings).toEqual({ setupMs: 7, engineMs: 8 });
  });

  test("PR-113: a failed baseline request is timed with failed, and has no timings", async () => {
    const r = await dbRig({
      serve: {
        answer: (q) =>
          q.ids[0]?.startsWith("plain:") === true && q.daemon === 0
            ? { lines: [], eof: true }
            : undefined,
      },
    });
    const timed: V3RequestTimed[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    await baseline(r.b, SUITE3).catch(() => undefined);
    const bad = timed.filter((e) => e.failed === true);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.kind).toBe("baseline");
    expect(bad[0]?.timings).toBeUndefined();
  });

  test("PR-113: the mutant phase's coverage and echo windows (plain requests outside the baseline) keep no event", async () => {
    const r = await rig({
      targetAl: SLEEPER_AL,
      serve: { rows: killsM1, coverage: sleepCoverage() },
    });
    const timed: V3RequestTimed[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0001", "M0002"]));
    await r.b.activate("M0001");
    await r.b.run(ref("A"), OPTS);
    await r.b.activate("M0002");
    await r.b.run(ref("A"), OPTS);
    await r.b.run(ref("B"), OPTS);
    const s = r.b.entriesStats();
    // the windows really ran as plain requests ...
    expect(s.coverageRequests + s.echoRequests).toBeGreaterThan(0);
    // ... and are the only serve requests without an event
    expect(timed.some((e) => e.kind === "baseline")).toBe(false);
    expect(timed).toHaveLength(r.serve.requests.length - s.coverageRequests - s.echoRequests);
  });

  test("PR-113: a one-shot that never started (spawnError) is not timed", async () => {
    const r = await dbRig();
    const holder = r.b as unknown as { spawnCodeunit: (...a: unknown[]) => Promise<unknown> };
    let spawns = 0;
    holder.spawnCodeunit = async () => {
      spawns += 1;
      return { spawnError: "no process", wallMs: 5 };
    };
    const shots: V3BaselineOneShotTimed[] = [];
    r.b.setBaselineOneShotSink((e) => shots.push(e));
    await baseline(r.b, SUITE3).catch(() => undefined);
    expect(spawns).toBeGreaterThan(0);
    expect(shots).toEqual([]);
  });

  test("PR-113: a cross-check one-shot is timed with reason cross-check", async () => {
    const r = await dbRig();
    const shots: V3BaselineOneShotTimed[] = [];
    r.b.setBaselineOneShotSink((e) => shots.push(e));
    await baseline(r.b, SUITE3);
    // the sample: the 2nd and the last codeunit, one process each (see R948 A)
    expect(shots.map((e) => [e.codeunit, e.reason])).toEqual([
      [CU2, "cross-check"],
      [CU3, "cross-check"],
    ]);
    for (const e of shots) expect(e.wallMs).toBeGreaterThanOrEqual(0);
  });

  test("PR-113: after a dropped daemon baseline the ordinary one-shot calls are timed as other, each process once", async () => {
    const other: CoverageFn = (m, cu, a, t) => {
      const d = plainCoverage(m, cu, a, t) as {
        perTestCoverage: { coverage: { statements: { line: number; hits: number }[] }[] }[];
      };
      const first = d.perTestCoverage[0]?.coverage[0];
      if (first !== undefined) first.statements = [{ line: 99, hits: 1 }];
      return d;
    };
    const r = await dbRig({ suite: SUITE2, oneShotCoverage: other });
    const shots: V3BaselineOneShotTimed[] = [];
    r.b.setBaselineOneShotSink((e) => shots.push(e));
    await baseline(r.b, SUITE2);
    expect(r.b.daemonBaselineReport().dropped).toBeDefined(); // the cross-check dropped the daemon baseline
    expect(shots.filter((e) => e.reason === "cross-check").map((e) => e.codeunit)).toEqual([CU2]);
    expect(
      shots
        .filter((e) => e.reason === "other")
        .map((e) => e.codeunit)
        .sort(),
    ).toEqual([CU, CU2]);
    // one event per process, none twice
    expect(shots).toHaveLength(r.one.calls.length);
  });

  test("PR-113: R790's too-slow re-run is timed with reason too-slow", async () => {
    const slowCu: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        cu === CU ? { ...x, message: "Test exceeded 3s timeout." } : x,
      );
    const r = await dbRig({ serve: { rows: slowCu } });
    const shots: V3BaselineOneShotTimed[] = [];
    r.b.setBaselineOneShotSink((e) => shots.push(e));
    await baseline(r.b, SUITE3);
    expect(shots.filter((e) => e.reason === "too-slow").map((e) => e.codeunit)).toEqual([CU]);
    expect(shots.filter((e) => e.reason === "cross-check").map((e) => e.codeunit)).toEqual([
      CU2,
      CU3,
    ]);
  });

  test("a thrown send is timed with failed, and has no timings", async () => {
    const { r, timed, closed } = await watchedRig({
      serve: {
        rows: allPass,
        answer: (q) => (q.ids[0] === "M0001|echo" ? { lines: [], eof: true } : undefined),
      },
    });
    await r.b.prefetchMutants(plans(["M0001"])).catch(() => undefined);
    const bad = timed.filter((e) => e.failed === true);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.kind).toBe("prefetch");
    expect(bad[0]?.timings).toBeUndefined();
    // the close that ends a thrown request is stamped with that request's kind
    expect(closed).toContainEqual({ reason: "request-failed", phase: "prefetch" });
  });

  test("an answer cut at a timeout row is timed with cut, and has no timings", async () => {
    const { r, timed } = await watchedRig({
      seams: { sleepRuleRetired: true }, // the only build a request is cut on
      serve: {
        rows: timedOutFor("M0002"),
        answer: (_q, _n, ls) => ({
          lines: ls.map((x) => (x.type === "summary" ? { ...x, timings: { setupMs: 5 } } : x)),
        }),
      },
    });
    await r.b.prefetchMutants(plans(["M0001", "M0002", "M0003"]));
    const cuts = timed.filter((e) => e.cut === true);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.timings).toBeUndefined();
    expect(timed.filter((e) => e.cut !== true).every((e) => e.timings !== undefined)).toBe(true);
  });

  test("timings copies only the known fields, of the right type", async () => {
    const { r, timed } = await watchedRig({
      serve: {
        rows: allPass,
        answer: (_q, _n, ls) => ({
          lines: ls.map((x) =>
            x.type === "summary"
              ? {
                  ...x,
                  timings: {
                    setupMs: 11,
                    compileMs: "12",
                    engineMs: 13,
                    baselineSource: "snapshot",
                    engineKept: true,
                    resetMs: 14,
                    surprise: 99,
                  },
                }
              : x,
          ),
        }),
      },
    });
    await r.b.prefetchMutants(plans(["M0001"]));
    const p = timed.find((e) => e.kind === "prefetch");
    expect(p?.timings).toEqual({
      setupMs: 11,
      engineMs: 13,
      resetMs: 14,
      baselineSource: "snapshot",
      engineKept: true,
    });
    // the same rule as a plain function
    expect(pickV3Timings({ engineKept: false, testsMs: Number.NaN, x: 1 })).toBeUndefined();
    expect(pickV3Timings("nope")).toBeUndefined();
    expect(pickV3Timings({ testsMs: 0 })).toEqual({ testsMs: 0 });
  });

  test("the warm-up cause: first, after-deploy, recycle, after-<reason>", async () => {
    // first, and after a refusal closed the daemon
    const a = await watchedRig({ serve: { rows: refusedFor("M0002") } });
    await a.r.b.prefetchMutants(plans(["M0001", "M0002", "M0003"]));
    expect(warmupCauses(a.timed)[0]).toBe("first");
    expect(warmupCauses(a.timed)).toContain("after-refusal");
    // after a redeploy
    const b = await watchedRig({ serve: { rows: allPass } });
    await b.r.b.prefetchMutants(plans(["M0001"]));
    await b.r.b.deploy(b.r.l.batch);
    await baseline(b.r.b, SUITE1);
    await b.r.b.prefetchMutants(plans(["M0001"]));
    expect(warmupCauses(b.timed)).toEqual(["first", "after-deploy"]);
    // after R952's bound
    const c = await watchedRig({ serve: { rows: allPass }, extra: { daemonMaxRequests: 2 } });
    for (const m of ["M0001", "M0002", "M0003"]) await c.r.b.prefetchMutants(plans([m]));
    expect(warmupCauses(c.timed)[0]).toBe("first");
    expect(warmupCauses(c.timed)).toContain("recycle");
    // only warm-ups carry a cause
    expect(c.timed.filter((e) => e.kind !== "warmup").every((e) => e.cause === undefined)).toBe(
      true,
    );
  });

  test("a restarted daemon: its first warm-up carries the restart's cause, every later lazy one is lazy-prove", async () => {
    const P1 = [ref("A"), ref("B")]; // codeunit CU
    const P2 = [ref("C", CU2)]; // codeunit CU2
    const { r, timed } = await watchedRig({
      serve: { rows: timedOutFor("M0002") },
      suite: SUITE2,
      seams: { sleepRuleRetired: true }, // the only build a request is cut on
    });
    await baseline(r.b, SUITE2);
    // M0002's A times out: the request is cut there, daemon 0 closes (timeout), M0003 is re-sent on a
    // fresh daemon, which first proves CU (cause: the timeout).
    await r.b.prefetchMutants([
      { mutantId: "M0001", refs: P1 },
      { mutantId: "M0002", refs: P1 },
      { mutantId: "M0003", refs: P1 },
    ]);
    // the same daemon then meets CU2 for the first time: a second, lazy warm-up
    await r.b.prefetchMutants([{ mutantId: "M0004", refs: P2 }]);
    expect(warmupCauses(timed)).toEqual(["first", "after-timeout", "lazy-prove"]);
  });

  test("a baseline daemon's close never sets a mutant warm-up's cause: after a baseline timeout the first mutant warm-up says first", async () => {
    // The baseline daemon (daemon 0) times out on codeunit CU's first request and is closed; the mutant
    // phase's own daemon then starts for the first time.
    const timedOutAtBaseline: RowsFn = (m, cu, d, n) =>
      d === 0 && cu === CU
        ? [
            { method: "A", status: "error" as const, notRun: true, message: TIMEOUT_1S },
            { method: "B", status: "pass" as const },
          ]
        : allPass(m, cu, d, n);
    const r = await dbRig({ serve: { rows: timedOutAtBaseline } });
    const timed: V3RequestTimed[] = [];
    const closed: { reason: string; phase: string }[] = [];
    r.b.setRequestTimedSink((e) => timed.push(e));
    r.b.setDaemonCloseSink((c) => closed.push({ reason: c.reason, phase: c.phase }));
    await baseline(r.b, SUITE3);
    // a close during a plain() request says baseline
    expect(closed).toContainEqual({ reason: "timeout", phase: "baseline" });
    await r.b.prefetchMutants(plans(["M0001"], SUITE3)).catch(() => undefined);
    expect(warmupCauses(timed)[0]).toBe("first");
  });

  test("a close inside a plain() request (a failed baseline request) says baseline", async () => {
    const r = await dbRig({
      serve: {
        answer: (q) =>
          q.ids[0]?.startsWith("plain:") === true && q.daemon === 0
            ? { lines: [], eof: true }
            : undefined,
      },
    });
    const closed: { reason: string; phase: string }[] = [];
    r.b.setDaemonCloseSink((c) => closed.push({ reason: c.reason, phase: c.phase }));
    await baseline(r.b, SUITE3).catch(() => undefined);
    expect(closed).toContainEqual({ reason: "request-failed", phase: "baseline" });
  });

  test("a redeploy sets after-deploy on a lane that held no daemon when it came", async () => {
    // daemon 0 closes for a refusal and the lane holds none; the redeploy still counts for its next start
    const { r, timed } = await watchedRig({ serve: { rows: refusedFor("M0001") } });
    await r.b.prefetchMutants(plans(["M0001"]));
    await r.b.deploy(r.l.batch);
    await baseline(r.b, SUITE1);
    await r.b.prefetchMutants(plans(["M0002"]));
    expect(warmupCauses(timed).at(-1)).toBe("after-deploy");
  });

  test("warmupCause maps a close reason to the cause", () => {
    expect(warmupCause(undefined)).toBe("first");
    expect(warmupCause("deploy")).toBe("after-deploy");
    expect(warmupCause("recycle")).toBe("recycle");
    expect(warmupCause("timeout")).toBe("after-timeout");
    expect(warmupCause("refusal")).toBe("after-refusal");
  });
});

// ---------------------------------------------------------------------------------------------
// PR-115 (R1106 part b): the baseline's test codeunits in batches. The batch size is a seam (2 or 3), the
// decision a seam (`baselineBatching`); the pin and probe side is pr114a-batching-accessor.test.ts.
// ---------------------------------------------------------------------------------------------
const CU4 = 79103;
SUITE_METHODS[CU4] = ["E"];
const SUITE4 = [...SUITE3, ref("E", CU4)];

describe("PR-115: batching the daemon baseline", () => {
  const bRig = (o: RigOpts = {}, size = 2): Promise<Rig> =>
    dbRig({
      ...o,
      seams: { baselineBatching: true, baselineBatchSize: size, ...(o.seams ?? {}) },
    });
  const isBatch = (q: Req) => q.body.test === undefined;
  // A batch answer that names an EXTRA row (no suite test) twice: only decode step 3 catches it, since the
  // per-codeunit row check ignores extra rows (the first row of the answer is copied under another name).
  const dupFirstRow = (q: Req, _n: number, lines: Record<string, unknown>[]) => {
    const first = lines[0];
    if (!isBatch(q) || first === undefined) return undefined;
    const extra = { ...first, name: `Codeunit${CU}.Extra` };
    return { lines: [extra, extra, ...lines] };
  };

  test("the batch body is requestBase's plus excludeTests and coverage, with none of the forbidden fields; the lone codeunit is today's request", async () => {
    const r = await bRig({ extra: { daemonBaseline: true, noClient: true } });
    const v = await baseline(r.b, SUITE3);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(r.serve.requests).toHaveLength(2);
    const [batch, single] = r.serve.requests;
    if (batch === undefined || single === undefined) throw new Error("two requests");
    expect(isBatch(batch)).toBe(true);
    expect(single.body.test).toBe(`Codeunit${CU3}.`);
    const { excludeTests, ...batchRest } = batch.body;
    const { test: _t, ...singleRest } = single.body;
    // every OTHER Subtype=Test codeunit of both trees: CU3, and the control echo codeunit deployed into active/
    expect(excludeTests).toEqual([`Codeunit${CU3}.`, `Codeunit${ECHO}.`]);
    expect(batchRest).toEqual(singleRest); // sourcePaths, testIsolation, noClient, coverage, perTestCoverage
    expect(batch.body.noClient).toBe(true);
    for (const f of BATCH_FORBIDDEN_FIELDS) expect(batch.body).not.toHaveProperty(f);
    expect(r.b.daemonBaselineReport()).toMatchObject({ requests: 2, dropped: undefined });
  });

  test("a one-codeunit suite sends its codeunit alone: a batch of 1 is today's request (the empty-complement rule itself is pinned in pr115-baseline-batch.test.ts)", async () => {
    const r = await bRig({ suite: SUITE1 });
    await baseline(r.b, SUITE1);
    expect(r.serve.requests.map((q) => q.body.test)).toEqual([`Codeunit${CU}.`]);
    expect(r.serve.requests.every((q) => q.body.excludeTests === undefined)).toBe(true);
  });

  test("a test codeunit with trigger OnRun goes alone, and the other batch is shorter", async () => {
    ONRUN_CUS.add(CU2);
    try {
      const r = await bRig();
      await baseline(r.b, SUITE3);
      expect(r.serve.requests.map((q) => q.body.test)).toEqual([
        `Codeunit${CU}.`,
        `Codeunit${CU2}.`,
        `Codeunit${CU3}.`,
      ]);
    } finally {
      ONRUN_CUS.delete(CU2);
    }
  });

  test("the accessor false (no seam, no pin) means no batching", async () => {
    const r = await dbRig({ seams: { baselineBatchSize: 2 } });
    expect(r.b.isBaselineBatching()).toBe(false);
    await baseline(r.b, SUITE3);
    expect(r.serve.requests.every((q) => q.body.test !== undefined)).toBe(true);
    expect(r.serve.requests).toHaveLength(3);
  });

  test("batching needs coverage: a fill without it sends every codeunit alone", async () => {
    const r = await bRig();
    const priv = r.b as unknown as {
      lane: unknown;
      fillDaemonBaseline(l: unknown, s: number, c: boolean): Promise<void>;
    };
    await priv.fillDaemonBaseline(priv.lane, 1, false);
    expect(r.serve.requests).toHaveLength(3);
    for (const q of r.serve.requests) {
      expect(q.body.test).toBeDefined();
      expect(q.body).not.toHaveProperty("coverage");
    }
  });

  test("a batch request that fails keeps nothing: each codeunit is re-sent alone", async () => {
    const r = await bRig({
      serve: { answer: (q) => (isBatch(q) ? { lines: [], eof: true } : undefined) },
    });
    const v = await baseline(r.b, SUITE3);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(r.serve.requests.map((q) => q.body.test)).toEqual([
      undefined,
      `Codeunit${CU}.`,
      `Codeunit${CU2}.`,
      `Codeunit${CU3}.`,
    ]);
  });

  test("a duplicate test name discards the batch WITHOUT throwing, closes the daemon, re-sends alone, and turns batching off for the session", async () => {
    const r = await bRig({ suite: SUITE4, serve: { answer: dupFirstRow } });
    const v = await baseline(r.b, SUITE4);
    expect(v.map((x) => x.outcome)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    // one discarded batch, then four singles: the second group [CU3, CU4] is never batched (the first discard turned it off)
    expect(r.serve.requests.map((q) => q.body.test)).toEqual([
      undefined,
      `Codeunit${CU}.`,
      `Codeunit${CU2}.`,
      `Codeunit${CU3}.`,
      `Codeunit${CU4}.`,
    ]);
    expect(r.serve.requests.map((q) => q.daemon)).toEqual([0, 1, 1, 1, 1]); // closed after the discard
  });

  test("R1001's watch sees only decoded rows: a discarded batch's duplicate rows never reach it", async () => {
    const seen: { id: number; names: string[] }[] = [];
    const spy = spyOn(UniformRefusalWatch.prototype, "observe").mockImplementation(function (
      this: unknown,
      id: number,
      rows: readonly { name: string }[],
    ) {
      seen.push({ id, names: rows.map((x) => x.name) });
      return undefined;
    });
    try {
      const r = await bRig({ serve: { answer: dupFirstRow } });
      await baseline(r.b, SUITE3);
    } finally {
      spy.mockRestore();
    }
    // The fill's own watch saw each codeunit once, after the discard (later entries are the per-call watch's).
    expect(seen.slice(0, 3).map((s) => s.id)).toEqual([CU, CU2, CU3]);
    for (const s of seen) expect(new Set(s.names).size).toBe(s.names.length);
  });

  test("verdicts and coverage equal the unbatched baseline's", async () => {
    const run = async (batched: boolean) => {
      const r = await dbRig({
        suite: SUITE4,
        extra: { coverage: "al-runner", daemonBaseline: true },
        ...(batched ? { seams: { baselineBatching: true, baselineBatchSize: 3 } } : {}),
      });
      const v = await baseline(r.b, SUITE4);
      return { r, seen: v.map((x) => ({ outcome: x.outcome, coverage: x.coverage })) };
    };
    const plain = await run(false);
    const batched = await run(true);
    expect(batched.r.serve.requests.some((q) => q.body.test === undefined)).toBe(true);
    expect(batched.seen).toEqual(plain.seen);
    expect(plain.seen.some((x) => x.coverage !== undefined)).toBe(true);
  });

  test("R948: a batched sample is compared by rows and per-test sets, not by its top level (the union of its tests)", async () => {
    const r = await bRig();
    await baseline(r.b, SUITE3);
    // CU2 (a sample) sits in the batch; its one-shot top level has lines 7 and 12, the union of its one test only 7.
    expect(r.b.daemonBaselineReport()).toMatchObject({ dropped: undefined, compared: 2 });
  });

  test("R790 is per codeunit: a slow codeunit in a batch does not make its neighbour re-run", async () => {
    const slow =
      (which: number): RowsFn =>
      (m, cu, d, n) =>
        allPass(m, cu, d, n).map((x) =>
          cu === which ? { ...x, message: "Test exceeded 3s timeout." } : x,
        );
    // CU is not a sample: slow, so skipped as too slow. CU2 slow instead: CU stays served.
    const a = await bRig({ serve: { rows: slow(CU) } });
    await baseline(a.b, SUITE3);
    expect(a.b.daemonBaselineReport().skippedTooSlow).toEqual([`Codeunit${CU}`]);
    const b = await bRig({ serve: { rows: slow(CU2) } });
    await baseline(b.b, SUITE3);
    expect(b.b.daemonBaselineReport().skippedTooSlow).toEqual([]);
    expect(b.b.daemonBaselineReport().served).toBe(1); // CU, from the batch
  });

  test("the deadline is v3CallDeadlineMs over the batch's total tests", async () => {
    const spy = spyOn(AlRunnerServer.prototype, "runEntries");
    try {
      const r = await bRig();
      await baseline(r.b, SUITE3);
      const s = Number(/--test-timeout (\d+)/.exec(r.serve.daemons[0]?.join(" ") ?? "")?.[1]);
      const deadlines = spy.mock.calls.map((c) => c[1]);
      expect(deadlines[0]).toBe(v3CallDeadlineMs(s, 3)); // A, B, C
      expect(deadlines[1]).toBe(v3CallDeadlineMs(s, 1)); // D
    } finally {
      spy.mockRestore();
    }
  });

  test("one callId covers a batch: its codeunits' verdicts share it, the wall time is charged once", async () => {
    // rows with no own time of their own are the ones that carry a call id (R963)
    const noOwnTime: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) => ({ ...x, noDuration: true }));
    const r = await bRig({ suite: SUITE4, serve: { rows: noOwnTime } }, 3);
    const v = await baseline(r.b, SUITE4);
    // groups [CU, CU2, CU3] and [CU4]; CU and CU3 are served from the batch, CU2 and CU4 are samples (one-shot).
    const ids = (cu: number) =>
      v.filter((_, i) => SUITE4[i]?.codeunitId === cu).map((x) => x.callId);
    const shared = new Set([...ids(CU), ...ids(CU3)]);
    expect(shared.size).toBe(1);
    expect([...shared][0]).toBeDefined();
    expect(shared.has(ids(CU2)[0])).toBe(false);
  });

  test("a stop signal after the batch request drops the whole batch", async () => {
    const held: { rig?: Rig } = {};
    const asked = () => held.rig?.serve.requests.length ?? 0;
    const r = await bRig({
      stopHandle: { spent: () => false, signalled: () => asked() >= 1, stopForMemory: () => {} },
    });
    held.rig = r;
    await baseline(r.b, SUITE3);
    expect(r.serve.requests).toHaveLength(1);
    expect(r.b.daemonBaselineReport().served).toBe(0);
    expect(oneShotCodeunits(r)).toHaveLength(3); // nothing kept: all three run live
  });

  test("R951: a skipped sample inside a batch is replaced by a later codeunit of the same batch", async () => {
    const r = await bRig({ suite: SUITE4 }, 3);
    const holder = r.b as unknown as { spawnCodeunit: (...a: unknown[]) => Promise<unknown> };
    const real = holder.spawnCodeunit.bind(r.b);
    let first = true;
    holder.spawnCodeunit = async (...a) => {
      if (!first) return real(...a);
      first = false;
      return { timedOut: true, wallMs: 1 }; // CU2's cross-check run gives no answer
    };
    await baseline(r.b, SUITE4).catch(() => {});
    expect(r.b.daemonBaselineReport().replacements).toEqual({
      [`Codeunit${CU2}`]: `Codeunit${CU3}`,
    });
    // one batch [CU, CU2, CU3] and CU4 alone: the replacement CU3 was served from the batch's answer, not re-asked
    expect(r.serve.requests).toHaveLength(2);
    expect(r.serve.requests[0] !== undefined && isBatchReq(r.serve.requests[0])).toBe(true);
  });
});
const isBatchReq = (q: Req) => q.body.test === undefined;

// ---------------------------------------------------------------------------------------------
// PR-123: the L5 re-check of a reused baseline, in batches (spec 2026-11-17-pr123-batched-recheck.md), as
// PR-126 changed it (spec 2026-11-17-pr126-recheck-coverage-samples-only.md): the samples go singly WITH
// coverage, the rest batch WITHOUT. Seven codeunits (SUITE7), batch size 2: the samples are the 2nd, the
// middle and the last (CU2, CU4, CU7); the non-samples CU, CU3, CU5, CU6 make the batches [CU, CU3] and
// [CU5, CU6]. Call counters and request logs on the fakes, never the clock.
// ---------------------------------------------------------------------------------------------
const CU5 = 79104;
const CU6 = 79105;
const CU7 = 79106;
SUITE_METHODS[CU5] = ["F"];
SUITE_METHODS[CU6] = ["G"];
SUITE_METHODS[CU7] = ["H"];
const SUITE7 = [...SUITE4, ref("F", CU5), ref("G", CU6), ref("H", CU7)];
interface BatchReq {
  batchRequest(
    ...a: unknown[]
  ): Promise<Map<number, { withCoverage: boolean; coverage: { kind: string } }> | undefined>;
}
describe("PR-123: the batched re-check of a reused baseline", () => {
  const isBatch = (q: Req) => q.body.test === undefined;
  // R1123 (PR-146): coverage on, so a sample's coverage is a real map (under "none" the re-check compares none)
  const named = (opts: RigOpts) =>
    rig({
      suite: SUITE7,
      oneShotCoverage: plainCoverage,
      ...opts,
      appExtra: { publisher: "Acme Pub" },
      extra: { coverage: "al-runner", ...opts.extra },
    });
  const rowsOf = (r: Rig) =>
    (r.b as unknown as { baselineRows: Map<number, unknown[]> }).baselineRows;
  const priv = (r: Rig) =>
    r.b as unknown as {
      baselineStats: { batches: number; batchDiscards: number };
      baselineBatchingSpent: string | undefined;
      memoryGate(a: boolean): Promise<boolean>;
      checkBound(l: unknown): Promise<void>;
    };
  const batchesOf = (r: Rig) => r.serve.requests.filter(isBatch);
  const singlesOf = (r: Rig) => r.serve.requests.filter((q) => !isBatch(q));
  /** Rows equal to allPass, except the listed (codeunit, method) tests fail. */
  const failing =
    (...bad: [number, string][]): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        bad.some(([c, meth]) => c === cu && meth === x.method)
          ? { ...x, status: "fail" as const, message: "boom" }
          : x,
      );
  /** The first session: one unbatched baseline, its stored state and stored coverage. */
  const stored = async (extra?: Partial<AlRunnerV3Config>, cov: CoverageFn = plainCoverage) => {
    const r = await named({
      serve: { rows: allPass, coverage: cov },
      ...(extra !== undefined ? { extra, oneShotCoverage: cov } : {}),
    });
    const verdicts = await baseline(r.b, SUITE7);
    return {
      state: await r.b.baselineState(),
      coverage: new Map(
        verdicts.map((v) => [
          `codeunit${v.ref.codeunitId}.${v.ref.method}`.toLowerCase(),
          JSON.stringify(v.coverage ?? null),
        ]),
      ) as ReadonlyMap<string, string>,
    };
  };
  interface Resume {
    rows?: RowsFn;
    coverage?: CoverageFn;
    batched?: boolean;
    answer?: ServeScript["answer"];
    stopHandle?: RigOpts["stopHandle"];
    patch?: (s: Record<string, unknown>) => unknown;
    before?: (r: Rig) => Promise<void> | void;
    extra?: Partial<AlRunnerV3Config>;
  }
  const resume = async (f: Awaited<ReturnType<typeof stored>>, o: Resume = {}) => {
    const r2 = await named({
      serve: {
        rows: o.rows ?? allPass,
        coverage: o.coverage ?? plainCoverage,
        ...(o.answer !== undefined ? { answer: o.answer } : {}),
      },
      ...(o.batched === false
        ? {}
        : { seams: { baselineBatching: true, baselineBatchSize: 2 } as const }),
      ...(o.stopHandle !== undefined ? { stopHandle: o.stopHandle } : {}),
      ...(o.extra !== undefined ? { extra: o.extra } : {}),
    });
    await o.before?.(r2);
    r2.b.baselinePhase(true);
    const state = JSON.parse(JSON.stringify(f.state)) as Record<string, unknown>;
    const why = await r2.b.recheckReusedBaseline(o.patch?.(state) ?? state, f.coverage, 1000);
    return { why, r2 };
  };
  /** The stored coverage of sample CU2's test C is another map (as the L5 test 6 does it). */
  const otherCoverage = (f: Awaited<ReturnType<typeof stored>>) =>
    new Map([...f.coverage, [`codeunit${CU2}.c`, JSON.stringify({ not: "it" })]]);
  const lineOf = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes("re-check batching (PR-123)"));

  test("the same answers, the same outcome, batched and unbatched: all equal reuses, and the batched arm sent batches only", async () => {
    const f = await stored();
    const plain = await resume(f, { batched: false });
    const batched = await resume(f);
    expect(plain.why).toBeUndefined();
    expect(batched.why).toBeUndefined();
    expect(batchesOf(plain.r2)).toHaveLength(0);
    expect(singlesOf(plain.r2)).toHaveLength(7);
    // red without the batched fetch: seven singles
    expect(batchesOf(batched.r2)).toHaveLength(2);
    expect(singlesOf(batched.r2)).toHaveLength(3); // the samples
    expect(rowsOf(batched.r2).size).toBe(7);
  });

  test("PR-126: the samples go singly WITH coverage and are in every batch's excludeTests; a non-sample batch's body has neither coverage field", async () => {
    const f = await stored();
    const { why, r2 } = await resume(f);
    expect(why).toBeUndefined();
    const batches = batchesOf(r2);
    expect(batches.length).toBeGreaterThan(0);
    // each sample once, alone, asking for coverage; never inside a batch
    const singles = singlesOf(r2);
    expect(singles.map((q) => q.body.test).sort()).toEqual(
      [CU2, CU4, CU7].map((c) => `Codeunit${c}.`).sort(),
    );
    for (const q of singles) expect(q.body.coverage).toBe(true);
    for (const q of batches) {
      for (const c of [CU2, CU4, CU7]) expect(q.body.excludeTests).toContain(`Codeunit${c}.`);
      expect(q.body).not.toHaveProperty("coverage");
      expect(q.body).not.toHaveProperty("perTestCoverage");
    }
  });

  test("PR-126: a non-sample batch's answers carry withCoverage: false and unavailable coverage", async () => {
    const f = await stored();
    const seen: { withCoverage: boolean; kind: string }[] = [];
    const real = (AlRunnerV3Backend.prototype as unknown as BatchReq).batchRequest;
    const spy = spyOn(AlRunnerV3Backend.prototype as unknown as BatchReq, "batchRequest");
    spy.mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const out = await real.apply(this, a);
      for (const v of out?.values() ?? [])
        seen.push({ withCoverage: v.withCoverage, kind: v.coverage.kind });
      return out;
    });
    try {
      const { why } = await resume(f);
      expect(why).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(4); // CU, CU3, CU5, CU6
    for (const s of seen) expect(s).toEqual({ withCoverage: false, kind: "unavailable" });
  });

  test("PR-126: the fill's batch body still asks for coverage (both fields true)", async () => {
    const r = await dbRig({
      suite: SUITE4,
      seams: { baselineBatching: true, baselineBatchSize: 2 },
    });
    await baseline(r.b, SUITE4);
    const batches = r.serve.requests.filter(isBatch);
    expect(batches.length).toBeGreaterThan(0);
    for (const q of batches) {
      expect(q.body.coverage).toBe(true);
      expect(q.body.perTestCoverage).toBe(true);
    }
  });

  test("PR-126 (L3): the fill's step 5 still holds: a ghost per-test entry in a FILL batch discards it", async () => {
    const r = await dbRig({
      suite: SUITE3,
      seams: { baselineBatching: true, baselineBatchSize: 2 },
      serve: {
        answer: (q, _n, lines) =>
          isBatch(q)
            ? {
                lines: lines.map((l) =>
                  l.type === "summary"
                    ? {
                        ...l,
                        perTestCoverage: [
                          ...((l.perTestCoverage as unknown[] | undefined) ?? []),
                          { test: `Codeunit${CU}.Ghost`, coverage: [] },
                        ],
                      }
                    : l,
                ),
              }
            : undefined,
      },
    });
    await baseline(r.b, SUITE3);
    const p = r.b as unknown as {
      baselineStats: { batchDiscards: number };
      baselineBatchingSpent: string | undefined;
    };
    expect(p.baselineStats.batchDiscards).toBe(1);
    expect(p.baselineBatchingSpent).toContain("no row of the batch");
  });

  test("the same answers, the same outcome: one stored row differs (a codeunit no sample covers), not reused either way, nothing imported", async () => {
    const f = await stored();
    const rows = failing([CU, "B"]);
    const plain = await resume(f, { batched: false, rows });
    const batched = await resume(f, { rows });
    expect(plain.why).toContain(`codeunit ${CU}:`);
    expect(batched.why).toBe(plain.why); // red without the row compare on a batched answer
    expect(batchesOf(batched.r2).length).toBeGreaterThan(0);
    expect(rowsOf(batched.r2).size).toBe(0);
  });

  test("the same answers, the same outcome: a sample's coverage differs, not reused either way", async () => {
    const f = await stored();
    const stored2 = { ...f, coverage: otherCoverage(f) };
    const plain = await resume(stored2, { batched: false });
    const batched = await resume(stored2);
    expect(plain.why).toContain("coverage differs");
    expect(batched.why).toBe(plain.why); // red without the sample's coverage compare on a batched answer
    expect(batchesOf(batched.r2).length).toBeGreaterThan(0);
  });

  test("batching on: ONE memory hold and ONE bound check per batch; batching off: one per codeunit", async () => {
    const f = await stored();
    const count = async (batched: boolean) => {
      const gate: unknown[] = [];
      const bound: unknown[] = [];
      const { why } = await resume(f, {
        batched,
        before: (r) => {
          const p = priv(r);
          const g = p.memoryGate.bind(p);
          const c = p.checkBound.bind(p);
          p.memoryGate = (a) => {
            gate.push(a);
            return g(a);
          };
          p.checkBound = (l) => {
            bound.push(l);
            return c(l);
          };
        },
      });
      expect(why).toBeUndefined();
      return { gate: gate.length, bound: bound.length };
    };
    // two batches and the three samples singly; unbatched: seven
    expect(await count(true)).toEqual({ gate: 5, bound: 5 });
    expect(await count(false)).toEqual({ gate: 7, bound: 7 });
  });

  test("a discarded batch whose rows MATCH the stored ones: its rows are not used, the re-sends are singles (coverage for samples only), batching is latched off with the re-check's reason", async () => {
    const f = await stored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // request 0 is the first batch [CU, CU3]: its rows EQUAL the stored ones, but an extra row named twice
      // discards it (decode step 3; a ghost coverage entry no longer discards a no-coverage batch, PR-126).
      // Every later request answers a DIFFERENT row for CU (B fails), so using the discarded answer would wrongly reuse.
      const { why, r2 } = await resume(f, {
        rows: (m, cu, d, n) => (n === 0 ? allPass(m, cu, d, n) : failing([CU, "B"])(m, cu, d, n)),
        answer: (q, _n, lines) => {
          const first = lines[0];
          if (!isBatch(q) || first === undefined) return undefined;
          const extra = { ...first, name: `Codeunit${CU}.Extra` };
          return { lines: [extra, extra, ...lines] };
        },
      });
      expect(why).toContain(`codeunit ${CU}:`); // the single's row decided
      expect(rowsOf(r2).size).toBe(0);
      // the discarded batch, then CU alone (and no coverage: CU is no sample); the second batch is never sent (the latch)
      expect(r2.serve.requests.map((q) => q.body.test)).toEqual([undefined, `Codeunit${CU}.`]);
      expect(singlesOf(r2).map((q) => q.body.coverage === true)).toEqual([false]);
      expect(priv(r2).baselineBatchingSpent).toStartWith("the re-check: ");
      expect(priv(r2).baselineBatchingSpent).toContain(`test Codeunit${CU}.Extra appears twice`); // step 3
      expect(priv(r2).baselineStats.batchDiscards).toBe(1);
      expect(lineOf(warn)).toContain("1 discarded or failed (the re-check: ");
    } finally {
      warn.mockRestore();
    }
  });

  describe("with a real coverage index (coverage: al-runner)", () => {
    const real = { coverage: "al-runner" } as const;
    /** Every test hits the target's line 5, except the ones `skip` names: those hit nothing in the target. */
    const hitsTarget =
      (skip: (cu: number, method: string) => boolean): CoverageFn =>
      (_m, cu, active, t) => {
        const own = (method: string) => ({
          test: `Codeunit${cu}.${method}`,
          coverage: [
            { file: join(t, `Tests${cu}.Codeunit.al`), statements: [{ line: 7, hits: 1 }] },
            ...(skip(cu, method)
              ? []
              : [
                  {
                    file: join(active, "Logic.Codeunit.al"),
                    statements: [{ line: 5, hits: 1 }],
                  },
                ]),
          ],
        });
        const tests = (SUITE_METHODS[cu] ?? []).map(own);
        return {
          coverage: tests.flatMap((e) => e.coverage),
          perTestCoverage: tests,
        };
      };
    const same = hitsTarget(() => false);
    /** CU2's test C no longer hits the target; the rows and every other test's coverage are the same. */
    const otherLine = hitsTarget((cu, method) => cu === CU2 && method === "C");

    test("a sample's single-request per-test coverage equal to the stored map: reused, and the stored maps are real", async () => {
      const f = await stored(real, same);
      expect(f.coverage.get(`codeunit${CU2}.c`)).not.toBe("null"); // a real index, not null against null
      const { why, r2 } = await resume(f, { extra: real, coverage: same });
      expect(why).toBeUndefined();
      expect(batchesOf(r2)).toHaveLength(2);
      expect(singlesOf(r2)).toHaveLength(3); // the samples, with coverage
    });

    test("a sample's single-request per-test coverage that differs from the stored map (rows equal) is not reused, naming the method (PR-126 L4)", async () => {
      const f = await stored(real, same);
      const { why, r2 } = await resume(f, { extra: real, coverage: otherLine });
      expect(why).toContain(`codeunit ${CU2}: C's coverage differs`);
      expect(batchesOf(r2).length).toBeGreaterThan(0);
      expect(singlesOf(r2)).toHaveLength(1); // CU2, the first sample in stored order; the check stopped there
      expect(rowsOf(r2).size).toBe(0);
    });
  });

  test("a failed batch request: latched, a discard counted, singles sent", async () => {
    const f = await stored();
    const { why, r2 } = await resume(f, {
      answer: (q) => (isBatch(q) ? { lines: [], eof: true } : undefined),
    });
    expect(why).toBeUndefined();
    expect(r2.serve.requests.map((q) => q.body.test)).toEqual([
      undefined,
      ...[CU, CU2, CU3, CU4, CU5, CU6, CU7].map((c) => `Codeunit${c}.`),
    ]);
    // coverage only for the samples CU2, CU4, CU7
    expect(singlesOf(r2).map((q) => q.body.coverage === true)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(priv(r2).baselineBatchingSpent).toStartWith("the re-check: a batch request failed");
    expect(priv(r2).baselineStats.batchDiscards).toBe(1);
  });

  test("a stop signal after a batch returns the signal reason, and no answer of that batch is compared", async () => {
    const f = await stored();
    const held: { rig?: Rig } = {};
    const { why, r2 } = await resume(f, {
      // the batch's rows differ: a compare would name the codeunit instead of the signal
      rows: failing([CU, "B"]),
      stopHandle: {
        spent: () => false,
        signalled: () => (held.rig?.serve.requests.length ?? 0) >= 1,
        stopForMemory: () => {},
      },
      before: (r) => {
        held.rig = r;
      },
    });
    expect(why).toBe("a stop signal (during the re-check)");
    expect(r2.serve.requests).toHaveLength(1);
    expect(rowsOf(r2).size).toBe(0);
  });

  test("the budget is checked before each batch", async () => {
    const f = await stored();
    const held: { rig?: Rig } = {};
    const { why, r2 } = await resume(f, {
      stopHandle: {
        spent: () => (held.rig?.serve.requests.length ?? 0) >= 1,
        signalled: () => false,
        stopForMemory: () => {},
      },
      before: (r) => {
        held.rig = r;
      },
    });
    expect(why).toContain("the time budget");
    expect(r2.serve.requests).toHaveLength(1); // the second batch was never sent
  });

  test("a codeunit with trigger OnRun goes singly, the rest still batch", async () => {
    ONRUN_CUS.add(CU3);
    try {
      const f = await stored();
      const { why, r2 } = await resume(f);
      expect(why).toBeUndefined();
      // the batch [CU5, CU6] first (CU and CU3 are alone), then the singles in stored order
      expect(r2.serve.requests.map((q) => q.body.test)).toEqual([
        undefined,
        ...[CU, CU2, CU3, CU4, CU7].map((c) => `Codeunit${c}.`),
      ]);
    } finally {
      ONRUN_CUS.delete(CU3);
    }
  });

  test("a suite codeunit with no stored rows (and no source file) is in the batch's excludeTests", async () => {
    UNSCANNED_CUS.add(CU3);
    try {
      const f = await stored();
      const { why, r2 } = await resume(f, {
        patch: (s) => ({ ...s, rows: (s.rows as [number, unknown][]).filter(([k]) => k !== CU3) }),
      });
      expect(why).toBeUndefined();
      const batch = batchesOf(r2)[0];
      if (batch === undefined) throw new Error("a batch was sent");
      // CU3 is only in the suite (the scan does not find it): the suite ids exclude it
      expect(batch.body.excludeTests).toContain(`Codeunit${CU3}.`);
      // the samples (now CU2, CU5, CU7) are excluded too; the batch is [CU, CU4]
      expect(batch.body.excludeTests).toContain(`Codeunit${CU5}.`);
      expect(batch.body.excludeTests).not.toContain(`Codeunit${CU4}.`);
    } finally {
      UNSCANNED_CUS.delete(CU3);
    }
  });

  test("batches are planned over ascending ids, and the checks run in stored order", async () => {
    const f = await stored();
    const { why, r2 } = await resume(f, {
      // stored order CU7 .. CU; samples CU6, CU4, CU. Two failing BATCHED codeunits: CU5 is stored before CU2,
      // so the reason names CU5 (ascending or batch order would name CU2)
      patch: (s) => ({ ...s, rows: [...(s.rows as unknown[])].reverse() }),
      rows: failing([CU5, "F"], [CU2, "C"]),
    });
    expect(why).toContain(`codeunit ${CU5}:`);
    const first = batchesOf(r2)[0]?.body.excludeTests as string[] | undefined;
    // ascending plan over the non-samples CU2, CU3, CU5, CU7: the first batch is [CU2, CU3]
    expect(first).toContain(`Codeunit${CU4}.`);
    expect(first).toContain(`Codeunit${CU5}.`);
    expect(first).not.toContain(`Codeunit${CU2}.`);
    expect(first).not.toContain(`Codeunit${CU3}.`);
  });

  test("the stats line, both ways", async () => {
    const f = await stored();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await resume(f);
      expect(lineOf(warn)).toContain("2 batch(es) kept, 0 discarded or failed");
      warn.mockClear();
      await resume(f, { batched: false });
      expect(lineOf(warn)).toContain("re-check batching (PR-123): off (");
    } finally {
      warn.mockRestore();
    }
  });

  test("after a batched reuse, a warm-up NONE row that differs from an imported row throws by name", async () => {
    const f = await stored();
    const { why, r2 } = await resume(f, {
      // requests 0 and 1 are the two batches, 2-4 the samples; the warm-up is request 5 and disagrees on CU2
      rows: (m, cu, d, n) =>
        n >= 5 && cu === CU2 ? [{ method: "C", status: "fail" as const }] : allPass(m, cu, d, n),
    });
    expect(why).toBeUndefined();
    r2.b.baselinePhase(false);
    const err = await r2.b.prefetchMutants(plans(["M0001"], SUITE7)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(String(err)).toContain("al-runner-v3-entries-warmup-disagrees");
  });
});

// ---------------------------------------------------------------------------------------------
// PR-119 (R1107): the daemon fill's cross-check samples run beside the daemon. Event logs and call
// counters on the fakes, never the clock: a "hold" waits for an event, with a cap only so a
// sequential flow (where the event can never come first) cannot hang.
// ---------------------------------------------------------------------------------------------
describe("PR-119: cross-check samples beside the daemon", () => {
  // Six codeunits: the plan samples index 1 and the last (index 5).
  const CUS = [79120, 79121, 79122, 79123, 79124, 79125];
  for (const c of CUS) SUITE_METHODS[c] = ["T"];
  const SUITE = CUS.map((c) => ref("T", c));
  const at = (i: number) => CUS[i] ?? 0;
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 150 && !pred(); i += 1) await Bun.sleep(1);
  };
  interface Hooks {
    /** Runs at the start of a codeunit's FIRST one-shot process. */
    hold?: (id: number, log: string[]) => Promise<void>;
    /** Gives that first process this result instead of running it. */
    stub?: Record<number, unknown>;
    /** That first process throws. */
    boom?: number[];
  }
  const GIBS = 2 ** 30;
  const memSample = (usedBytes: number) => ({
    usedBytes,
    maxBytes: 32 * GIBS,
    source: "/sys/fs/cgroup/memory.max",
  });
  /** One test's rig with an event log: `req:<cu>` at a daemon request, `start:`/`end:<cu>` around a one-shot. */
  async function setup(o: RigOpts & { hooks?: Hooks } = {}) {
    const log: string[] = [];
    const { hooks, ...rest } = o;
    const r = await dbRig({
      suite: SUITE,
      ...rest,
      serve: {
        coverage: plainCoverage,
        stderr: (req) => {
          log.push(`req:${/Codeunit(\d+)/.exec(req.ids[0] ?? "")?.[1]}`);
          return undefined;
        },
        ...(rest.serve ?? {}),
      },
    });
    const holder = r.b as unknown as {
      spawnCodeunit: (...a: { id: number }[]) => Promise<unknown>;
    };
    const real = holder.spawnCodeunit.bind(r.b);
    const seen = new Map<number, number>();
    holder.spawnCodeunit = async (...a) => {
      const id = a[0]?.id ?? 0;
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      log.push(`start:${id}`);
      if (n === 1) await hooks?.hold?.(id, log);
      if (n === 1 && hooks?.boom?.includes(id)) throw new Error("sample boom");
      const made = n === 1 ? hooks?.stub?.[id] : undefined;
      const out = made ?? (await real(...a));
      log.push(`end:${id}`);
      return out;
    };
    const idx = (e: string) => log.indexOf(e);
    return { r, log, idx, rep: () => r.b.daemonBaselineReport() };
  }
  const timedOut = { timedOut: true, wallMs: 1 };
  /** The one-shot of codeunit index 1 differs from the daemon's. */
  const differsAt1: RowsFn = (_m, cu) =>
    cu === at(1)
      ? [{ method: "T", status: "fail" as const, message: "differs" }]
      : (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const }));
  /** Holds a first one-shot until the daemon request for index `i` has arrived. */
  const holdUntilReq = (sample: number, i: number) => (id: number, log: string[]) =>
    id === sample ? until(() => log.includes(`req:${at(i)}`)) : Promise.resolve();
  /** Holds a first one-shot until another one-shot starts (it never does while the loop settles it first). */
  const holdUntilOtherStart = (sample: number) => (id: number, log: string[]) =>
    id === sample
      ? until(() => log.some((e) => e.startsWith("start:") && e !== `start:${sample}`))
      : Promise.resolve();

  test("a sample in flight overlaps the next daemon request; the stats and the console line say so", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = await setup({ hooks: { hold: holdUntilReq(at(1), 2) } });
      await baseline(t.r.b, SUITE);
      // the request for index 2 arrived while index 1's one-shot was still running
      expect(t.idx(`req:${at(2)}`)).toBeGreaterThan(-1);
      expect(t.idx(`req:${at(2)}`)).toBeLessThan(t.idx(`end:${at(1)}`));
      expect(t.rep()).toMatchObject({
        dropped: undefined,
        samplesOverlapped: 1,
        samplesSequential: 1,
      });
      expect(t.rep().sampleMemoryAtStart).toBeUndefined(); // no guard here
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("baseline samples (PR-119): 1 overlapped, 1 sequential"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("the seam off, or LETHAL_V3_SEQUENTIAL_SAMPLES=1: today's call order, each sample finished before the next request", async () => {
    const sequential = (t: Awaited<ReturnType<typeof setup>>) => {
      expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`req:${at(2)}`));
      expect(t.rep()).toMatchObject({ samplesOverlapped: 0, samplesSequential: 2 });
    };
    const off = await setup({
      seams: { concurrentSamples: false },
      hooks: { hold: holdUntilReq(at(1), 2) },
    });
    await baseline(off.r.b, SUITE);
    sequential(off);
    const before = process.env.LETHAL_V3_SEQUENTIAL_SAMPLES;
    process.env.LETHAL_V3_SEQUENTIAL_SAMPLES = "1";
    try {
      const env = await setup({ hooks: { hold: holdUntilReq(at(1), 2) } });
      await baseline(env.r.b, SUITE);
      sequential(env);
      process.env.LETHAL_V3_SEQUENTIAL_SAMPLES = "yes";
      await expect(setup()).rejects.toThrow(/al-runner-v3-sequential-samples-refused/);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "LETHAL_V3_SEQUENTIAL_SAMPLES");
      else process.env.LETHAL_V3_SEQUENTIAL_SAMPLES = before;
    }
  });

  test("a sample that settles with no daemon request started beside it counts as sequential (one batch holds every codeunit)", async () => {
    const t = await setup({ seams: { baselineBatching: true, baselineBatchSize: 6 } });
    await baseline(t.r.b, SUITE);
    expect(t.r.serve.requests.filter((q) => q.body.test === undefined)).toHaveLength(1);
    expect(t.rep()).toMatchObject({ dropped: undefined, compared: 2 });
    // index 1 ran in flight, but every later answer was cached: no request overlapped it
    expect(t.rep()).toMatchObject({ samplesOverlapped: 0, samplesSequential: 2 });
  });

  test("the result is applied only at the settle: a differing sample does not stop the requests the loop makes before it settles", async () => {
    const t = await setup({ oneShotRows: differsAt1 });
    await baseline(t.r.b, SUITE).catch(() => {});
    expect(t.rep().dropped).toContain("differs from a fresh process's");
    expect(t.r.serve.requests).toHaveLength(6); // sequentially: 2, the drop came first
  });

  test("a dropped result wins over a later uniform stop (R1001): the drop is the reading, not a throw", async () => {
    const t = await setup({
      suite: R1001_SUITE,
      serve: { rows: refusedAll },
      oneShotRows: (_m, cu) =>
        (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const })),
    });
    const v = await baseline(t.r.b, R1001_SUITE);
    expect(v).toHaveLength(R1001_SUITE.length);
    expect(t.rep().dropped).toContain("differs from a fresh process's");
    expect(t.r.serve.requests.length).toBeGreaterThanOrEqual(10); // the loop ran on to the 10th refusal
  });

  test("a dropped result wins over the two-unusable drop", async () => {
    const t = await setup({
      oneShotRows: differsAt1,
      serve: { answer: (_q, n) => (n === 2 || n === 3 ? { lines: [], eof: true } : undefined) },
    });
    await baseline(t.r.b, SUITE).catch(() => {});
    expect(t.rep().dropped).toContain("differs from a fresh process's");
    expect(t.rep().dropped).not.toContain("two serve requests");
  });

  test("a dropped result is applied at the loop's end after a stop, not lost", async () => {
    const held: { r?: Rig } = {};
    const t = await setup({
      oneShotRows: differsAt1,
      stopHandle: {
        spent: () => (held.r?.serve.requests.length ?? 0) >= 3,
        signalled: () => false,
        stopForMemory: () => {},
      },
    });
    held.r = t.r;
    await baseline(t.r.b, SUITE).catch(() => {});
    expect(t.rep().dropped).toContain("differs from a fresh process's");
  });

  test("the sample's throw beats a loop throw in finally, and the loop's is named in a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = await setup({ hooks: { boom: [at(1)] } });
      const h = t.r.b as unknown as { baselineRequest: (...a: unknown[]) => Promise<unknown> };
      const realReq = h.baselineRequest.bind(t.r.b);
      let calls = 0;
      h.baselineRequest = async (...a) => {
        if (++calls === 3) throw new Error("loop boom");
        return realReq(...a);
      };
      await expect(baseline(t.r.b, SUITE)).rejects.toThrow("sample boom");
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("al-runner-v3-baseline-sample-error-order"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("finally applies nothing but a throw: a dropped sample in flight when the loop throws gives the loop's error, no drop, no notice", async () => {
    const seen: [string, string][] = [];
    const t = await setup({ oneShotRows: differsAt1, notify: (c, m) => seen.push([c, m]) });
    const h = t.r.b as unknown as { baselineRequest: (...a: unknown[]) => Promise<unknown> };
    const realReq = h.baselineRequest.bind(t.r.b);
    let calls = 0;
    h.baselineRequest = async (...a) => {
      if (++calls === 3) throw new Error("loop boom");
      return realReq(...a);
    };
    await expect(baseline(t.r.b, SUITE)).rejects.toThrow("loop boom");
    expect(dropNotice(seen)).toHaveLength(0);
    expect(t.rep().dropped).toBeUndefined();
  });

  test("a skipped forward pick is taken after the loop's position at the settle, and the too-slow one-shot settles the sample first", async () => {
    const slow: RowsFn = (_m, cu) =>
      cu === at(3)
        ? [{ method: "T", status: "fail" as const, message: "Test exceeded 9s timeout." }]
        : (SUITE_METHODS[cu] ?? []).map((method) => ({ method, status: "pass" as const }));
    const t = await setup({
      serve: { rows: slow },
      oneShotRows: slow,
      hooks: {
        stub: { [at(1)]: timedOut },
        // held until the too-slow one-shot of index 3 starts: it never can before the sample is settled
        hold: (id, log) =>
          id === at(1) ? until(() => log.includes(`start:${at(3)}`)) : Promise.resolve(),
      },
    });
    await baseline(t.r.b, SUITE);
    expect(t.idx(`end:${at(1)}`)).toBeGreaterThan(-1);
    expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`start:${at(3)}`));
    // settled while the loop was at index 3: the first unsampled codeunit after it is index 4 (not 2)
    expect(t.rep().replacements).toEqual({ [`Codeunit${at(1)}`]: `Codeunit${at(4)}` });
  });

  test("a backward pick runs after the in-flight sample settled, never beside it", async () => {
    const t = await setup({
      hooks: { stub: { [at(1)]: timedOut }, hold: holdUntilOtherStart(at(1)) },
    });
    await baseline(t.r.b, SUITE);
    expect(t.idx(`end:${at(1)}`)).toBeGreaterThan(-1);
    expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`start:${at(4)}`)); // the backward pick (the last has no later codeunit)
    expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`start:${at(5)}`)); // and the last sample
    expect(t.rep().replacements).toEqual({ [`Codeunit${at(1)}`]: `Codeunit${at(4)}` });
  });

  test("the got-undefined sample branch settles the sample before its replacement runs", async () => {
    const t = await setup({
      hooks: { hold: holdUntilOtherStart(at(1)) },
      serve: { answer: (_q, n) => (n === 5 ? { lines: [], eof: true } : undefined) },
    });
    await baseline(t.r.b, SUITE);
    expect(t.idx(`end:${at(1)}`)).toBeGreaterThan(-1);
    expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`start:${at(4)}`));
    expect(t.rep().replacements).toEqual({ [`Codeunit${at(5)}`]: `Codeunit${at(4)}` });
  });

  test("a skipped result settled at a stop starts no replacement one-shot (R955)", async () => {
    const held: { r?: Rig } = {};
    const t = await setup({
      hooks: { stub: { [at(1)]: timedOut } },
      stopHandle: {
        spent: () => false,
        // the request for index 5 is the last that arrives: the stop signal ends it
        signalled: () => (held.r?.serve.requests.length ?? 0) >= 6,
        stopForMemory: () => {},
      },
    });
    held.r = t.r;
    // Only the fill (the first baseline call): later live calls would start index 4 for their own sake.
    t.r.b.baselinePhase(true);
    await t.r.b.activate(null);
    await t.r.b.run(SUITE[0] ?? ref("T"), OPTS).catch(() => {});
    t.r.b.baselinePhase(false);
    expect(t.rep().sampledSkipped).toEqual([`Codeunit${at(1)} (timed-out)`]);
    expect(t.log.includes(`start:${at(4)}`)).toBe(false); // the backward pick did not run
  });

  describe("memory (the guard on, a fixed reader)", () => {
    const guarded = (
      used: (held: { r?: Rig }) => number | undefined,
      o: {
        rss?: number;
        hooks?: Hooks;
        sampleRss?: () => number;
        stopHandle?: RigOpts["stopHandle"];
      } = {},
    ) => {
      const held: { r?: Rig } = {};
      return setup({
        extra: { memoryHeadroomGb: 4 },
        seams: {
          memoryReader: () => {
            const u = used(held);
            return u === undefined ? undefined : memSample(u);
          },
          memorySleep: async () => {},
          anonReader: () => o.rss ?? GIBS,
          ...(o.sampleRss !== undefined ? { sampleRss: o.sampleRss } : {}),
        },
        ...(o.stopHandle !== undefined ? { stopHandle: o.stopHandle } : {}),
        ...(o.hooks !== undefined ? { hooks: o.hooks } : {}),
      }).then((t) => {
        held.r = t.r;
        return t;
      });
    };

    test("room: a sample overlaps and the fill's start reading is recorded; no room (23 of 28 GiB): it runs in place", async () => {
      const yes = await guarded(() => 20 * GIBS);
      await baseline(yes.r.b, SUITE);
      expect(yes.rep().samplesOverlapped).toBeGreaterThanOrEqual(1);
      expect(yes.rep().sampleMemoryAtStart).toBe(20 * GIBS);
      const no = await guarded(() => 23 * GIBS);
      await baseline(no.r.b, SUITE);
      expect(no.rep()).toMatchObject({
        samplesOverlapped: 0,
        samplesSequential: 2,
        dropped: undefined,
      });
    });

    test("an unreadable memory reading, or an unreadable daemon RSS, means sequential", async () => {
      const reading = await guarded((h) =>
        (h.r?.serve.requests.length ?? 0) >= 2 ? undefined : 20 * GIBS,
      );
      await baseline(reading.r.b, SUITE);
      expect(reading.rep().samplesOverlapped).toBe(0);
      const rss = await guarded(() => 20 * GIBS, { rss: 0 });
      await baseline(rss.r.b, SUITE);
      expect(rss.rep().samplesOverlapped).toBe(0);
    });

    test("S is the larger of the estimate and the daemon's RSS: a 9 GiB daemon refuses a sample 3 GiB would admit", async () => {
      const big = await guarded(() => 17 * GIBS, { rss: 9 * GIBS });
      await baseline(big.r.b, SUITE);
      expect(big.rep().samplesOverlapped).toBe(0);
      const small = await guarded(() => 17 * GIBS, { rss: GIBS });
      await baseline(small.r.b, SUITE);
      expect(small.rep().samplesOverlapped).toBeGreaterThanOrEqual(1);
    });

    test("a daemon request whose read says no settles the sample before its gate", async () => {
      // 20 GiB with nothing held, 26 GiB while the sample holds its reservation: admitted, then no room.
      const t = await guarded((h) =>
        ((h.r?.b as unknown as { memoryHeld: number } | undefined)?.memoryHeld ?? 0) > 0
          ? 26 * GIBS
          : 20 * GIBS,
      );
      await baseline(t.r.b, SUITE);
      // admitted (started in flight), but settled before the request started: sequential in effect
      expect(t.idx(`start:${at(1)}`)).toBeGreaterThan(-1);
      expect(t.idx(`end:${at(1)}`)).toBeLessThan(t.idx(`req:${at(2)}`));
      expect(t.rep()).toMatchObject({ samplesOverlapped: 0, samplesSequential: 2 });
    });

    const heldOf = (h: { r?: Rig }) =>
      (h.r?.b as unknown as { memoryHeld: number } | undefined)?.memoryHeld ?? 0;

    test("a settle at the pre-check whose replacement one-shot spends the stop handle: no daemon request follows (R955)", async () => {
      const seen: { log?: string[] } = {};
      // The sample (index 1) stays in flight, held, until the request for index 5 would arrive. That request's
      // pre-check says no (26 GiB while the sample holds), so the sample settles: skipped, and its backward
      // replacement (index 4, nothing is left after index 5's position) runs one-shot and spends the stop handle.
      const t = await guarded(
        (h) => (heldOf(h) > 0 && (h.r?.serve.requests.length ?? 0) >= 5 ? 26 * GIBS : 20 * GIBS),
        {
          hooks: { stub: { [at(1)]: timedOut }, hold: holdUntilReq(at(1), 5) },
          stopHandle: {
            spent: () => seen.log?.includes(`end:${at(4)}`) === true,
            signalled: () => false,
            stopForMemory: () => {},
          },
        },
      );
      seen.log = t.log;
      // Only the fill (the first baseline call): later live calls would send requests of their own.
      t.r.b.baselinePhase(true);
      await t.r.b.activate(null);
      await t.r.b.run(SUITE[0] ?? ref("T"), OPTS).catch(() => {});
      t.r.b.baselinePhase(false);
      expect(t.log).toContain(`end:${at(4)}`); // the replacement ran, inside the settle
      expect(t.r.serve.requests).toHaveLength(5); // and the request for index 5 never went out
    });

    test("the pre-check reads with the in-flight sample's reservation already held (its gate was queued first)", async () => {
      const reads: { req: number; held: boolean }[] = [];
      const t = await guarded(
        (h) => {
          reads.push({ req: h.r?.serve.requests.length ?? 0, held: heldOf(h) > 0 });
          return 20 * GIBS;
        },
        { hooks: { hold: holdUntilReq(at(1), 3) } },
      );
      await baseline(t.r.b, SUITE);
      // after request 1 is answered (2 requests in): admission, the sample's own gate, the pre-check, the gate of request 2
      expect(reads.filter((x) => x.req === 2).map((x) => x.held)).toEqual([
        false,
        false,
        true,
        true,
      ]);
    });

    test("the sampleRss seam replaces the per-pid read in admission: 0 means the sample runs in place", async () => {
      const t = await guarded(() => 20 * GIBS, { sampleRss: () => 0 });
      await baseline(t.r.b, SUITE);
      expect(t.rep()).toMatchObject({ samplesOverlapped: 0, samplesSequential: 2 });
    });
  });
});
