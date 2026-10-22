// R635: the serve + entries transport of the al-runner v3 backend, against a scripted fake
// `serve` daemon and a fake one-shot v3. Plan
// docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md (r3) §9, tests 1-13 and 16-21; the
// orchestrator's seams (tests 14, 15) are in orchestrator.test.ts. Call counters, no wall clock.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { emitResourceSelector, emitStaticSelector } from "@lethal/schemata";
import { installResourceSelector } from "../src/al-runner-backend";
import {
  AlRunnerServer,
  AlRunnerServerRequestError,
  type ServerProcessHandle,
  type ServerSpawnFn,
} from "../src/al-runner-server";
import {
  AL_RUNNER_V3_VERSION,
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3RowMissingError,
  AlRunnerV3ServeStopUnsetError,
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
  const spawn: ServerSpawnFn = (argv) => {
    const daemon = daemons.length;
    daemons.push([...argv]);
    const out = new Chan();
    let compiled = new Set<number>();
    out.push(JSON.stringify({ ready: true }));
    const handle: ServerProcessHandle = {
      stdout: out,
      stderr: new Chan(),
      kill: () => out.end(),
      write: (line) => {
        void (async () => {
          const body = JSON.parse(line) as Record<string, unknown>;
          if (body.command === "shutdown") {
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
            durationMs: 0,
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
  return { spawn, daemons, requests, firsts };
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
    expect(outcome(await r.b.run(ref("A"), OPTS))).toEqual(["error", "pre-dispatch-rejected"]);
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
    expect(argv.slice(0, 2)).toEqual(["/fake/al-runner", "serve"]);
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

  test("§6 then runs on the window's coverage: a covered Sleep is error [v3-sleep-noop]", async () => {
    const { r } = await windowOf({ serve: { coverage: sleepCoverage(true) } });
    await r.b.activate("M0001");
    const v = await r.b.run(ref("A"), OPTS);
    expect(outcome(v)).toEqual(["error", "runner-refused"]);
    expect(v.failureMessage).toContain("[v3-sleep-noop] covered Sleep");
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
