// R766 (b): a rig for the lane tests of AlRunnerV3Backend: the fakes of al-runner-v3-entries.test.ts
// (a scripted `serve` daemon that records each request with the tree and cwd it was started in, a
// fake one-shot v3, a fake alc), cut down to what the lane tests read. No coverage, no windows.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { ServerProcessHandle, ServerSpawnFn } from "../../src/al-runner-server";
import { AlRunnerV3Backend, type V3LaneView } from "../../src/al-runner-v3-backend";
import type { ArtifactIo } from "../../src/artifact";
import type { RunOpts, TestMethodRef } from "../../src/backend";
import type { SpawnFn } from "../../src/publisher";
import { buildFakeAppWithEntries } from "./fake-app";

export const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
export const SELECTOR_ID = 79199;
export const ECHO = 79198;
export const ARTIFACT = "0123456789abcdef0123456789abcdef";
export const CU = 79100;
export const OPTS: RunOpts = { coverage: "none", timeoutMs: 1000 };
export const TIMEOUT_1S = "Test exceeded 1s timeout.";
export const MUTANT_IDS = ["M0001", "M0002", "M0003", "M0004", "M0005", "M0006"];

export const ref = (method: string): TestMethodRef => ({
  codeunitId: CU,
  codeunitName: `Tests${CU}`,
  method,
});
export const A = ref("A");
export const B = ref("B");
export const SUITE = [A, B];

const TARGET_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
// The Sleep sits on line 5, so the §6 index is not empty and a pass under a mutant would open a window.
export const SLEEPER_AL = `codeunit 79000 "Logic"
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

export interface FakeRow {
  method: string;
  status: "pass" | "fail" | "error";
  message?: string;
  notRun?: boolean;
}
const stopMsOf = (message: string | undefined): number => {
  const m = /^Test exceeded (\d+)s timeout\./.exec(message ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
};
/** `daemon` is the daemon's index over the whole fake (every lane), `n` the request's index. */
export type RowsFn = (mutant: string, cu: number, daemon: number, n: number) => FakeRow[];
export const allPass: RowsFn = () => [
  { method: "A", status: "pass" },
  { method: "B", status: "pass" },
];
export const resourceFile = (active: string) =>
  join(active, "LethALResources", "active-mutant.txt");

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

export interface Req {
  readonly daemon: number;
  /** `sourcePaths[0]`: the tree this request names. */
  readonly active: string;
  readonly ids: string[];
  /** The mutant ids of the entries (echo entries leave out), in order. */
  readonly mutants: string[];
}

export interface ServeCtl {
  rows: RowsFn;
  /** The request (by index over every daemon) whose answer is an end of stream: a server error. */
  eofAt?: (n: number, req: Req) => boolean;
  /** The echo answer for a mutant; default vouches for it. */
  echo?: (m: string, daemon: number, n: number) => FakeRow;
}

function fakeServe(ctl: ServeCtl) {
  const daemons: string[][] = [];
  const requests: Req[] = [];
  const closes: number[] = [];
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
            closes.push(daemon);
            out.push("{}");
            out.end();
            return;
          }
          const sources = body.sourcePaths as string[];
          const entries = (body.entries as Record<string, unknown>[] | undefined) ?? [];
          const n = requests.length;
          const mutants = entries
            .filter((e) => !String(e.id).endsWith("|echo"))
            .map((e) => String((e.resources as Record<string, string>)["active-mutant.txt"]));
          const req: Req = {
            daemon,
            active: sources[0] ?? "",
            ids: entries.map((e) => String(e.id)),
            mutants,
          };
          requests.push(req);
          const cuOf = (t: unknown) => Number(/^Codeunit(\d+)\.$/.exec(String(t))?.[1]);
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
          const testLine = (cu: number, r: FakeRow, entry: string) => ({
            type: "test",
            name: `Codeunit${cu}.${r.method}`,
            status: r.status,
            durationMs: stopMsOf(r.message),
            ...(r.message !== undefined ? { message: r.message } : {}),
            ...(r.notRun === true ? { notRun: true } : {}),
            entry,
          });
          const selected = new Set(entries.map((e) => cuOf(e.test)));
          const per: Record<string, unknown>[] = [];
          for (const e of entries) {
            const m = String((e.resources as Record<string, string>)["active-mutant.txt"]);
            const cu = cuOf(e.test);
            const rs: FakeRow[] =
              cu === ECHO
                ? [
                    ctl.echo?.(m, daemon, n) ?? {
                      method: "Echo",
                      status: "fail",
                      message: `LETHAL-ECHO:${m}:true`,
                    },
                  ]
                : ctl.rows(m, cu, daemon, n);
            for (const r of rs) lines.push(testLine(cu, r, String(e.id)));
            per.push({ type: "entrySummary", entry: e.id, ...count(rs) });
          }
          lines.push(...per);
          const cached = [...selected].every((c) => compiled.has(c));
          if (!cached) compiled = selected;
          lines.push({ type: "summary", cached, exitCode: 0, ...sums });
          if (ctl.eofAt?.(n, req) === true) {
            out.end();
            return;
          }
          for (const l of lines) out.push(JSON.stringify(l));
        })();
      },
    };
    return handle;
  };
  return { spawn, daemons, requests, closes, cwds };
}

function fakeOneShot(rows: RowsFn) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const tests = rows("STATIC", cu, -1, -1).map((r) => ({
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

const rigRoots: string[] = [];
/** `afterEach`: removes every scratch root a rig made, whether or not its deploy succeeded. */
export async function cleanRigs(): Promise<void> {
  for (const r of rigRoots.splice(0)) await rm(r, { recursive: true, force: true });
}

export interface LanesRig {
  readonly root: string;
  readonly batch: string;
  readonly scratch: string;
  readonly b: AlRunnerV3Backend;
  /** The lane views (empty when the rig was built with `lanes: 0`). */
  readonly views: readonly V3LaneView[];
  readonly serve: ReturnType<typeof fakeServe>;
  readonly one: ReturnType<typeof fakeOneShot>;
  readonly notices: string[];
  /** `rm -rf` of the scratch root. */
  dispose(): Promise<void>;
}

/**
 * A backend with `lanes` lane views (0: none), deployed. `sleepRule`: the seam `sleepRuleRetired`
 * (default true, so the lanes are allowed). The baseline is NOT run: the caller does it on `views[0]`.
 */
export async function lanesRig(
  o: {
    lanes?: number;
    rows?: RowsFn;
    serve?: Partial<ServeCtl>;
    targetAl?: string;
    mutants?: readonly string[];
    afterLaneCopy?: (dir: string) => Promise<void>;
    /** R778: turn the kill-pair batch ON (default off: these tests measure today's per-kill pair). */
    pairBatch?: boolean;
  } = {},
): Promise<LanesRig> {
  await initParser();
  const root = await mkdtemp(join(tmpdir(), "lethal-v3lanes-"));
  rigRoots.push(root);
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
      mutants: (o.mutants ?? MUTANT_IDS).map((mutantId) => ({
        mutantId,
        objectType: "Codeunit",
        codeunitId: 79000,
      })),
    }),
  );
  await writeFile(join(batch, "MutationSelector.Codeunit.al"), "codeunit 79199 x { }");
  await writeFile(join(batch, "MutationRegister.Codeunit.al"), "codeunit 79198 r { }");
  await writeFile(join(batch, "Logic.Codeunit.al"), o.targetAl ?? TARGET_AL);
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
  const rows = o.rows ?? allPass;
  const serve = fakeServe({ rows, ...o.serve });
  const one = fakeOneShot(rows);
  const scratch = join(root, "scratch");
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
  );
  const notices: string[] = [];
  b.setNotify((code, message) => notices.push(`${code}: ${message}`));
  b.seams.sleepRuleRetired = true;
  // R778: these tests measure today's per-kill pair; the batch has its own tests.
  (b as unknown as { pairBatch: boolean }).pairBatch = o.pairBatch === true;
  if (o.afterLaneCopy !== undefined) b.seams.afterLaneCopy = o.afterLaneCopy;
  b.useBuildSymbols([]);
  b.useDiscoveredTests(SUITE);
  b.useSessionTests(SUITE);
  b.useMutantBudgetFloor(1000, 1000);
  const views = o.lanes === 0 ? [] : b.lanes(o.lanes ?? 3);
  await b.deploy(batch);
  return {
    root,
    batch,
    scratch,
    b,
    views,
    serve,
    one,
    notices,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The orchestrator's baseline step on lane 0's view: the bracket, a null activation, one run per ref. */
export async function laneBaseline(r: LanesRig): Promise<void> {
  const v0 = r.views[0];
  if (v0 === undefined) throw new Error("no lane 0");
  r.b.baselinePhase(true);
  try {
    await v0.activate(null);
    for (const t of SUITE) await v0.run(t, OPTS);
  } finally {
    r.b.baselinePhase(false);
  }
}
