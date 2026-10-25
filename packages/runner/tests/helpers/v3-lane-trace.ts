// R766 step (a): one scripted serve-entries session through AlRunnerV3Backend, recorded as a trace
// (every request body in order, every daemon close, the stats, every verdict). The expected value is
// committed in `v3-lane-trace.expected.json`; the refactor to a `Lane` must reproduce it exactly.
// Fakes follow al-runner-v3-entries.test.ts (a scripted `serve` daemon, a fake one-shot v3, a fake alc).
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { ServerProcessHandle, ServerSpawnFn } from "../../src/al-runner-server";
import { AlRunnerV3Backend } from "../../src/al-runner-v3-backend";
import type { ArtifactIo } from "../../src/artifact";
import type { RunOpts, TestMethodRef, TestVerdict } from "../../src/backend";
import type { SpawnFn } from "../../src/publisher";
import { buildFakeAppWithEntries } from "./fake-app";

const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const SELECTOR_ID = 79199;
const ECHO = 79198;
const ARTIFACT = "0123456789abcdef0123456789abcdef";
const CU = 79100;
const OPTS: RunOpts = { coverage: "none", timeoutMs: 1000 };
const MUTANTS = ["M0001", "M0002", "M0003", "M0004", "M0005", "M0006", "M0007", "M0008"];
const TIMEOUT_1S = "Test exceeded 1s timeout.";
// The Sleep sits on line 5 (the §6 index), so a pass under a mutant opens a coverage window.
const SLEEPER_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;
const testAl = `codeunit ${CU} "Tests${CU}"
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
const ref = (method: string): TestMethodRef => ({
  codeunitId: CU,
  codeunitName: `Tests${CU}`,
  method,
});
const A = ref("A");
const B = ref("B");
const SUITE = [A, B];

interface FakeRow {
  method: string;
  status: "pass" | "fail" | "error";
  message?: string;
  notRun?: boolean;
}
const stopMsOf = (message: string | undefined): number => {
  const m = /^Test exceeded (\d+)s timeout\./.exec(message ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
};
const resourceFile = (active: string) => join(active, "LethALResources", "active-mutant.txt");

/** The script's switches, flipped by the session as it goes. */
interface Ctl {
  armPair1: boolean;
  armPair2: boolean;
  blind: boolean;
  liveCut: boolean;
  disagreeFrom: number;
}

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

const pass = (): FakeRow[] => ["A", "B"].map((method) => ({ method, status: "pass" as const }));
const timesOutA = (rs: FakeRow[]): FakeRow[] =>
  rs.map((x) =>
    x.method === "A" ? { ...x, status: "error" as const, notRun: true, message: TIMEOUT_1S } : x,
  );
const failing = (rs: FakeRow[], method: string, message: string): FakeRow[] =>
  rs.map((x) => (x.method === method ? { ...x, status: "fail" as const, message } : x));

/** What the session's mutants do. `d` is the daemon index; NONE disagrees on later daemons. */
function rowsFor(ctl: Ctl, m: string, d: number): FakeRow[] {
  const base = pass();
  if (m === "M0001") return failing(base, "B", "boom1");
  if (m === "M0002") return failing(base, "A", "boom2");
  if (m === "M0003" && d === 0) return timesOutA(base);
  if (m === "M0005") return failing(base, "A", "boom5");
  if (m === "M0008" && ctl.liveCut) return timesOutA(base);
  if (m === "NONE" && d >= ctl.disagreeFrom) return failing(base, "B", "disagrees");
  return base;
}

/** §6 coverage of the sleeper: line 5 listed, never hit; `blind` drops the line (batchBlind). */
function coverageFor(ctl: Ctl, cu: number, active: string, testDir: string): unknown {
  const target = join(active, "Logic.Codeunit.al");
  const own = (m: string) => ({
    test: `Codeunit${cu}.${m}`,
    coverage: [
      { file: join(testDir, `Tests${cu}.Codeunit.al`), statements: [{ line: 7, hits: 1 }] },
    ],
  });
  return {
    coverage: [
      { file: join(testDir, `Tests${cu}.Codeunit.al`), statements: [{ line: 7, hits: 1 }] },
      {
        file: target,
        statements: ctl.blind
          ? [{ line: 6, hits: 0 }]
          : [
              { line: 5, hits: 0 },
              { line: 6, hits: 0 },
            ],
      },
    ],
    perTestCoverage: ["A", "B"].map(own),
  };
}

interface Req {
  readonly daemon: number;
  readonly body: Record<string, unknown>;
  readonly onDisk: string;
}

function fakeServe(ctl: Ctl) {
  const daemons: string[][] = [];
  const requests: Req[] = [];
  const closes: { daemon: number; afterRequests: number }[] = [];
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
          requests.push({ daemon, body, onDisk });
          const cuOf = (t: unknown) => Number(/^Codeunit(\d+)\.$/.exec(String(t))?.[1]);
          const rowsOf = (m: string, cu: number): FakeRow[] => {
            if (cu !== ECHO) return rowsFor(ctl, m, daemon);
            if (ctl.armPair1 && m === "M0002") {
              ctl.armPair1 = false;
              return [{ method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }];
            }
            if (ctl.armPair2 && m === "NONE") {
              ctl.armPair2 = false;
              return [{ method: "Echo", status: "error", notRun: true, message: TIMEOUT_1S }];
            }
            return [{ method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` }];
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
              const doc = coverageFor(ctl, cu, active, testDir) as Record<string, unknown>;
              extra = { coverage: doc.coverage, perTestCoverage: doc.perTestCoverage };
            }
          }
          const cached = [...selected].every((c) => compiled.has(c));
          if (!cached) compiled = selected;
          lines.push({ type: "summary", cached, exitCode: 0, ...sums, ...extra });
          for (const l of lines) out.push(JSON.stringify(l));
        })();
      },
    };
    return handle;
  };
  return { spawn, daemons, requests, closes, cwds };
}

function fakeOneShot(ctl: Ctl) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    const active = argv.at(-2) ?? "";
    const testDir = argv.at(-1) ?? "";
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const cov = coverageFor(ctl, cu, active, testDir);
    await writeFile(argv[argv.indexOf("--coverage-json") + 1] ?? "", JSON.stringify(cov));
    const tests = pass().map((r) => ({
      codeunit: cu,
      method: r.method,
      name: `Codeunit${cu}.${r.method}`,
      status: r.status,
    }));
    return { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "" };
  };
  return { spawn, calls };
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

export interface V3LaneTrace {
  readonly steps: readonly unknown[];
  readonly requests: readonly string[];
  readonly closes: readonly { daemon: number; afterRequests: number }[];
  readonly daemonArgv: readonly string[];
  readonly daemonCwds: readonly (string | null)[];
  readonly oneShotCalls: readonly string[];
  readonly spawnCount: number;
  readonly stats: unknown;
  readonly notices: readonly string[];
}

/** Runs the session and returns its trace, with the scratch root's paths replaced by `<ROOT>`. */
export async function runV3LaneTrace(): Promise<V3LaneTrace> {
  await initParser();
  const root = await mkdtemp(join(tmpdir(), "lethal-v3lane-"));
  try {
    const real = await realpath(root);
    const norm = (s: string): string => s.split(real).join("<ROOT>").split(root).join("<ROOT>");
    const batch = join(root, "batch");
    const testDir = join(root, "tests");
    const deps = join(root, "deps");
    const scratch = join(root, "scratch");
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
        mutants: MUTANTS.map((mutantId) => ({
          mutantId,
          objectType: "Codeunit",
          codeunitId: 79000,
        })),
      }),
    );
    await writeFile(join(batch, "MutationSelector.Codeunit.al"), "codeunit 79199 x { }");
    await writeFile(join(batch, "MutationRegister.Codeunit.al"), "codeunit 79198 r { }");
    await writeFile(join(batch, "Logic.Codeunit.al"), SLEEPER_AL);
    await writeFile(
      join(testDir, "app.json"),
      JSON.stringify({ id: "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7", name: "Tests" }),
    );
    await writeFile(join(testDir, `Tests${CU}.Codeunit.al`), testAl);
    const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
    await writeFile(
      join(deps, "Microsoft_System.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="8874ed3a-0643-4247-9ced-7a7002f7135d" Name="X" Publisher="LethAL" Version="1.0.0.0" /></Package>`,
      }),
    );

    const ctl: Ctl = {
      armPair1: false,
      armPair2: false,
      blind: false,
      liveCut: false,
      disagreeFrom: Number.MAX_SAFE_INTEGER,
    };
    const serve = fakeServe(ctl);
    const one = fakeOneShot(ctl);
    let t = 0;
    const b = new AlRunnerV3Backend(
      {
        alRunnerPath: "/fake/al-runner",
        instrumentedDir: scratch,
        testDir,
        packagesDir: deps,
        bcVersion: "28.0.46665.47126",
        selectorObjectId: SELECTOR_ID,
        alcPath: "/fake/alc",
        coverage: "none",
        transport: "serve-entries",
      },
      one.spawn,
      fakeAlc(),
      serve.spawn,
      () => ++t,
    );
    const notices: string[] = [];
    b.setNotify((code, message) => notices.push(`${code}: ${norm(message)}`));
    b.useBuildSymbols([]);
    b.useDiscoveredTests(SUITE);
    b.useSessionTests(SUITE);
    b.useMutantBudgetFloor(1000, 1000);
    await b.deploy(batch);

    const steps: unknown[] = [];
    const settle = async (label: string, p: Promise<TestVerdict>): Promise<void> => {
      try {
        const v = await p;
        steps.push(
          JSON.parse(
            norm(
              JSON.stringify({
                label,
                outcome: v.outcome,
                runnerRow: v.runnerRow ?? null,
                operation: v.operation ?? null,
                failureMessage: v.failureMessage ?? null,
                backendNote: v.backendNote ?? null,
                reportedStopMs: v.reportedStopMs ?? null,
                refusedAfterStop: v.refusedAfterStop ?? null,
              }),
            ),
          ),
        );
      } catch (e) {
        steps.push({
          label,
          threw: norm(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
        });
      }
    };
    const run = (label: string, r: TestMethodRef) => settle(label, b.run(r, OPTS));
    const mark = (label: string) => steps.push({ label });

    // Baseline (one-shot bracket), then one prefetch of six mutants. M0003 times out on daemon 0:
    // R612 closes it and M0004-M0006 are re-sent on daemon 1.
    b.baselinePhase(true);
    try {
      await b.activate(null);
      for (const r of SUITE) await run(`baseline ${r.method}`, r);
    } finally {
      b.baselinePhase(false);
    }
    mark("prefetch M0001-M0006");
    await b.prefetchMutants(MUTANTS.slice(0, 6).map((mutantId) => ({ mutantId, refs: SUITE })));

    // M0001: a pass opens a coverage window; B fails after A (the state note); a clean kill pair.
    b.useCoveringBudgets("M0001", [
      { ref: A, budgetMs: 1000 },
      { ref: B, budgetMs: 1000 },
    ]);
    await b.activate("M0001");
    await run("M0001 A", A);
    await run("M0001 B", B);
    await b.sendKillPair("M0001", B);
    await b.activate(null);
    await run("M0001 confirm B", B);
    await b.activate("M0001");
    await run("M0001 reproduce B", B);

    // M0002: the pair's M echo is cut (fallback 1); the reproduction runs live.
    await b.activate("M0002");
    await run("M0002 A", A);
    ctl.armPair1 = true;
    await b.sendKillPair("M0002", A);
    await b.activate(null);
    await run("M0002 confirm A", A);
    await b.activate("M0002");
    await run("M0002 reproduce A", A);

    // M0003 (prefetched timeout), M0004 (re-sent on daemon 1; a pass, so a window).
    await b.activate("M0003");
    await run("M0003 A", A);
    await b.activate("M0004");
    await run("M0004 A", A);

    // M0005: the pair's NONE echo is cut (fallback 2); the confirm restarts a daemon.
    await b.activate("M0005");
    await run("M0005 A", A);
    ctl.armPair2 = true;
    await b.sendKillPair("M0005", A);
    await b.activate(null);
    await run("M0005 confirm A", A);
    await b.activate("M0005");
    await run("M0005 reproduce A", A);

    // batchBlind: the window of M0006 sees no Sleep line; M0007 (live) carries the latched note.
    ctl.blind = true;
    await b.activate("M0006");
    await run("M0006 A", A);
    await b.activate("M0007");
    await run("M0007 A", A);

    // entriesRefused: M0008's live request is cut (daemon closed); the restart's warm-up disagrees.
    ctl.liveCut = true;
    ctl.disagreeFrom = serve.daemons.length;
    await b.activate("M0008");
    await run("M0008 A", A);
    await b.activate(null);
    await run("latched confirm A", A);
    await b.activate("M0007");
    await run("latched M0007 B", B);
    await b.close();

    const reqLine = (q: Req): string => {
      const entries = (
        q.body.entries as { id: string; resources: unknown; test: string }[] | undefined
      )?.map((e) => `${e.id} ${JSON.stringify(e.resources)} ${e.test}`);
      const rest = { ...q.body, ...(entries !== undefined ? { entries } : {}) };
      return norm(JSON.stringify({ daemon: q.daemon, onDisk: q.onDisk, body: rest }));
    };
    return {
      steps,
      requests: serve.requests.map(reqLine),
      closes: serve.closes,
      daemonArgv: serve.daemons.map((a) => norm(a.join(" "))),
      daemonCwds: serve.cwds.map((c) => (c === undefined ? null : norm(c))),
      oneShotCalls: one.calls.map((a) => norm(a.join(" "))),
      spawnCount: b.spawnCount,
      stats: b.entriesStats(),
      notices,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
