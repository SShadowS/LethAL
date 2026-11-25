// PR-437 (R1217): the whole-codeunit daemon baseline spread over the lanes. Spec v4:
// docs/superpowers/specs/2026-11-25-pr437-r1217-baseline-spread.md, outcome 4 and v4's added list. A scripted fake
// `serve` daemon and a fake one-shot v3, as in al-runner-v3-entries.test.ts (trimmed copies; that file's tests are
// not imported, so they do not run twice). Event logs and call counters, never the clock: a "hold" waits for an
// event, with a cap only so a flow where the event can never come first cannot hang.
// Each test names the change that turns it red.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { judgeDaemonBaseline } from "../itest/alrunner-v3-legs";
import type { ServerProcessHandle, ServerSpawnFn } from "../src/al-runner-server";
import {
  AlRunnerV3Backend,
  AlRunnerV3BaselineFillGapError,
  AlRunnerV3BaselineLanesRefusedError,
  AlRunnerV3MemoryBoundError,
  AlRunnerV3UnprovenBatchError,
  BASELINE_LANES_ENV,
  BASELINE_ONESHOT_SLOT_BYTES,
  UniformRefusalWatch,
} from "../src/al-runner-v3-backend";
import { baselineSampleIds } from "../src/al-runner-v3-baseline-check";
import type { ArtifactIo } from "../src/artifact";
import type { RunOpts, TestMethodRef } from "../src/backend";
import type { SpawnFn } from "../src/publisher";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const SELECTOR_ID = 79199;
const ECHO = 79198;
const ARTIFACT = "0123456789abcdef0123456789abcdef";
const OPTS: RunOpts = { coverage: "none", timeoutMs: 1000 };
const GIB = 2 ** 30;
const TARGET_AL = `codeunit 79000 "Logic"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const SLOW = "Test exceeded 9s timeout."; // 9000 ms: 2 x 9000 >= the 5000 ms floor, so too slow

/** `n` test codeunits with one test `T` each, from 79300 on. */
const cus = (n: number) => Array.from({ length: n }, (_, i) => 79300 + i);
const refOf = (cu: number): TestMethodRef => ({
  codeunitId: cu,
  codeunitName: `Tests${cu}`,
  method: "T",
});

let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});
beforeAll(async () => {
  await initParser();
});

function fakeApp(id: string): Buffer {
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${id}" Name="X" Publisher="LethAL" Version="1.0.0.0" /></Package>`,
  });
}

async function layout(suite: readonly number[]) {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr437-"));
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
      mutants: [{ mutantId: "M0001", objectType: "Codeunit", codeunitId: 79000 }],
    }),
  );
  await writeFile(join(batch, "MutationSelector.Codeunit.al"), "codeunit 79199 x { }");
  await writeFile(join(batch, "MutationRegister.Codeunit.al"), "codeunit 79198 r { }");
  await writeFile(join(batch, "Logic.Codeunit.al"), TARGET_AL);
  await writeFile(
    join(testDir, "app.json"),
    JSON.stringify({ id: "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7", name: "Tests" }),
  );
  for (const cu of suite)
    await writeFile(
      join(testDir, `Tests${cu}.Codeunit.al`),
      `codeunit ${cu} "Tests${cu}"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T()\n    begin\n    end;\n}\n`,
    );
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

interface Row {
  status: "pass" | "fail";
  message?: string;
}
type Rows = (cu: number) => Row;
const pass: Rows = () => ({ status: "pass" });
/** Per-test coverage: the test hits one line of its own file; `unhit` adds statements nobody hit. */
const coverageOf = (cu: number, testDir: string, unhit = false) => {
  const file = join(testDir, `Tests${cu}.Codeunit.al`);
  const statements = [
    { line: 7, hits: 1 },
    ...(unhit ? Array.from({ length: 20 }, (_, i) => ({ line: 100 + i, hits: 0 })) : []),
  ];
  return {
    coverage: [{ file, statements }],
    perTestCoverage: [{ test: `Codeunit${cu}.T`, coverage: [{ file, statements }] }],
  };
};

/**
 * One rig's event log, shared by the fakes: `req:<cus>`, `ans:`/`eof:<cus>` (serve), `start:`/`end:<cu>` (one-shots),
 * `notify:<code>`, `count:sample` (the loop counted a sample: a settle or an in-place one), and the tests' own. A test
 * awaits an event or a count, which the fake resolves the moment it pushes it: order comes from these, never a clock.
 */
class Events {
  readonly list: string[] = [];
  private waits: { readonly met: () => boolean; readonly open: () => void }[] = [];
  push(e: string): void {
    this.list.push(e);
    const ready = this.waits.filter((w) => w.met());
    this.waits = this.waits.filter((w) => !ready.includes(w));
    for (const w of ready) w.open();
  }
  /** Resolves when `met` holds (at once if it holds now), checked at each push. */
  until(met: () => boolean): Promise<void> {
    if (met()) return Promise.resolve();
    return new Promise((open) => this.waits.push({ met, open }));
  }
  /** Resolves once `e` has been pushed. */
  when(e: string): Promise<void> {
    return this.until(() => this.list.includes(e));
  }
  /** Resolves once `n` events matching `pred` have been pushed (`whenCalls(n)` on a fake's counter). */
  whenCount(pred: (e: string) => boolean, n: number): Promise<void> {
    return this.until(() => this.list.filter(pred).length >= n);
  }
}

interface Req {
  readonly daemon: number;
  /** The lane whose daemon got it (from the daemon's cwd, `daemon-<k>`). */
  readonly lane: number;
  readonly body: Record<string, unknown>;
  /** The codeunits it answers (one for a plain request; the batch's for a batch). */
  readonly cus: number[];
  readonly batch: boolean;
}
interface ServeScript {
  rows?: Rows;
  /** A latch: the request's answer waits for this promise (the test decides when it opens). */
  holdUntil?: (q: Req, ev: Events) => Promise<void> | undefined;
  /** Answer nothing and end stdout (a request error: the daemon is closed). */
  eof?: (q: Req) => boolean;
  /** Coverage with unhit statements. */
  unhit?: boolean;
}

/** A scripted `al-runner serve` (trimmed from al-runner-v3-entries.test.ts). */
function fakeServe(script: ServeScript, ev: Events) {
  const rows = script.rows ?? pass;
  const cwds: (string | undefined)[] = [];
  const requests: Req[] = [];
  /** The order requests were ANSWERED in (codeunits). */
  const answered: number[] = [];
  const closes: number[] = [];
  const log = ev.list;
  /** The lane a daemon belongs to, from its cwd (`daemon-<k>`). */
  const laneOfDaemon = (d: number) => Number(/daemon-(\d+)$/.exec(cwds[d] ?? "")?.[1] ?? "0");
  const spawn: ServerSpawnFn = (_argv, opts) => {
    const daemon = cwds.length;
    cwds.push(opts?.cwd);
    const q: Uint8Array[] = [];
    const waiting: ((r: IteratorResult<Uint8Array>) => void)[] = [];
    let closed = false;
    const push = (line: string) => {
      if (closed) return;
      const v = new TextEncoder().encode(`${line}\n`);
      const w = waiting.shift();
      if (w !== undefined) w({ value: v, done: false });
      else q.push(v);
    };
    const end = () => {
      closed = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
    };
    const stdout: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const v = q.shift();
          if (v !== undefined) return Promise.resolve({ value: v, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => waiting.push(r));
        },
        return: async () => {
          end();
          return { value: undefined, done: true };
        },
      }),
    };
    const stderr: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => ({ value: undefined, done: true }),
      }),
    };
    push(JSON.stringify({ ready: true }));
    const handle: ServerProcessHandle = {
      stdout,
      stderr,
      get pid(): number {
        return 90_000 + daemon;
      },
      kill: () => end(),
      write: (line) => {
        void (async () => {
          const body = JSON.parse(line) as Record<string, unknown>;
          if (body.command === "shutdown") {
            closes.push(daemon);
            push("{}");
            end();
            return;
          }
          const testDir = (body.sourcePaths as string[])[1] ?? "";
          const batch = body.test === undefined;
          let picked: number[];
          if (batch) {
            const out = ((body.excludeTests as string[] | undefined) ?? []).map((x) =>
              x.toLowerCase(),
            );
            picked = (await readdir(testDir))
              .map((f) => /^Tests(\d+)\.Codeunit\.al$/.exec(f)?.[1])
              .filter((x): x is string => x !== undefined)
              .map(Number)
              .filter((cu) => !out.some((x) => `codeunit${cu}.t`.includes(x)))
              .sort((a, b) => a - b);
          } else picked = [Number(/^Codeunit(\d+)\./.exec(String(body.test))?.[1])];
          const req: Req = { daemon, lane: laneOfDaemon(daemon), body, cus: picked, batch };
          requests.push(req);
          ev.push(`req:${picked.join("+")}`);
          const held = script.holdUntil?.(req, ev);
          if (held !== undefined) await held;
          if (script.eof?.(req) === true) {
            ev.push(`eof:${picked.join("+")}`);
            end();
            return;
          }
          answered.push(...picked);
          ev.push(`ans:${picked.join("+")}`);
          const sums = { passed: 0, failed: 0, errors: 0, notRun: 0, total: 0 };
          const cov = { coverage: [] as unknown[], perTestCoverage: [] as unknown[] };
          for (const cu of picked) {
            const r = rows(cu);
            push(
              JSON.stringify({
                type: "test",
                name: `Codeunit${cu}.T`,
                status: r.status,
                durationMs: r.message === SLOW ? 9000 : 0,
                ...(r.message !== undefined ? { message: r.message } : {}),
              }),
            );
            sums.total += 1;
            if (r.status === "pass") sums.passed += 1;
            else sums.failed += 1;
            if (body.coverage === true) {
              const d = coverageOf(cu, testDir, script.unhit === true);
              cov.coverage.push(...d.coverage);
              cov.perTestCoverage.push(...d.perTestCoverage);
            }
          }
          push(
            JSON.stringify({
              type: "summary",
              cached: false,
              exitCode: 0,
              ...sums,
              ...(body.coverage === true ? cov : {}),
            }),
          );
        })();
      },
    };
    return handle;
  };
  return { spawn, cwds, requests, answered, closes, log, laneOfDaemon };
}

/** The one-shot v3: the same rows as the script, coverage written where asked. */
function fakeOneShot(rows: Rows, testDir: string) {
  const spawn: SpawnFn = async (argv) => {
    const cu = Number(argv[argv.indexOf("--codeunit") + 1]);
    const at = argv.indexOf("--coverage-json");
    if (at >= 0) {
      const d = coverageOf(cu, testDir);
      await writeFile(argv[at + 1] ?? "", JSON.stringify(d));
    }
    const r = rows(cu);
    const tests = [
      {
        codeunit: cu,
        method: "T",
        name: `Codeunit${cu}.T`,
        status: r.status,
        ...(r.message !== undefined ? { message: r.message } : {}),
      },
    ];
    return { exitCode: 0, stdout: JSON.stringify({ tests }), stderr: "" };
  };
  return spawn;
}

interface Hooks {
  /** A latch at the start of a codeunit's FIRST one-shot (after its `start:` event). */
  hold?: (cu: number, ev: Events) => Promise<void> | undefined;
  /** That first one-shot answers this instead of running. */
  stub?: Record<number, unknown>;
  /** That first one-shot throws. */
  boom?: number[];
}
interface Opts {
  n?: number;
  lanes?: number;
  serve?: ServeScript;
  /** The one-shot's rows (default: the daemon's). */
  oneShotRows?: Rows;
  seams?: AlRunnerV3Backend["seams"];
  /** The memory guard on (default) with a 32 GiB limit and this reading. */
  used?: () => number | undefined;
  guard?: false;
  hooks?: Hooks;
  stopHandle?: Parameters<AlRunnerV3Backend["useStopHandle"]>[0];
  notify?: (code: string, message: string) => void;
  coverage?: "al-runner";
  /** The join rule's own checks (default: the admission seam forces every join open). */
  realAdmission?: true;
}

const mem = (usedBytes: number) => ({
  usedBytes,
  maxBytes: 32 * GIB,
  source: "/sys/fs/cgroup/memory.max",
});

/** A deployed backend with the daemon baseline on (and, by default, two lanes, the guard on, admission open). */
async function rig(o: Opts = {}) {
  const ids = cus(o.n ?? 8);
  const l = await layout(ids);
  const ev = new Events();
  const serve = fakeServe(o.serve ?? {}, ev);
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
      coverage: o.coverage ?? "none",
      transport: "serve-entries",
      downloadDemoData: false,
      daemonBaseline: true,
      ...(o.guard === false ? {} : { memoryHeadroomGb: 4 }),
    },
    fakeOneShot(o.oneShotRows ?? o.serve?.rows ?? pass, l.testDir),
    fakeAlc(),
    serve.spawn,
  );
  const suite = ids.map(refOf);
  b.useBuildSymbols([]);
  b.useDiscoveredTests(suite);
  b.useSessionTests(suite);
  b.useMutantBudgetFloor(5000, 2000);
  Object.assign(
    b.seams,
    {
      rssReader: () => undefined,
      requestRssReader: () => undefined,
      memoryReader: () => {
        const u = (o.used ?? (() => GIB))();
        return u === undefined ? undefined : mem(u);
      },
      memorySleep: async () => {},
      anonReader: () => GIB,
      sampleRss: () => GIB,
      ...(o.realAdmission === true ? {} : { baselineLanesAdmit: true as const }),
    },
    o.seams ?? {},
  );
  b.setNotify((code, message) => {
    ev.push(`notify:${code}`);
    o.notify?.(code, message);
  });
  if (o.stopHandle !== undefined) b.useStopHandle(o.stopHandle);
  const views = (o.lanes ?? 2) > 1 ? b.lanes(o.lanes ?? 2) : [];
  await b.deploy(l.batch);
  // `count:sample` each time the loop counts a sample (a settle, or an in-place sample): a counter on the stats.
  const stats = (b as unknown as { baselineStats: Record<string, unknown> }).baselineStats;
  for (const k of ["samplesOverlapped", "samplesSequential"]) {
    let v = 0;
    Object.defineProperty(stats, k, {
      get: () => v,
      set: (n: number) => {
        const up = n > v;
        v = n;
        if (up) ev.push("count:sample");
      },
    });
  }
  // One-shot log: `start:<cu>`/`end:<cu>`, its cwd and tree; the hooks run on a codeunit's FIRST one-shot.
  const log = ev.list;
  const shots: { cu: number; cwd: string; active: string }[] = [];
  let running = 0;
  let peak = 0;
  const holder = b as unknown as {
    spawnCodeunit: (...a: { id: number; cwd: string; activeDir: string }[]) => Promise<unknown>;
  };
  const real = holder.spawnCodeunit.bind(b);
  const seen = new Map<number, number>();
  holder.spawnCodeunit = async (...a) => {
    const x = a[0];
    const id = x?.id ?? 0;
    const k = (seen.get(id) ?? 0) + 1;
    seen.set(id, k);
    shots.push({ cu: id, cwd: x?.cwd ?? "", active: x?.activeDir ?? "" });
    running += 1;
    peak = Math.max(peak, running);
    ev.push(`start:${id}`);
    try {
      if (k === 1) await o.hooks?.hold?.(id, ev);
      if (k === 1 && o.hooks?.boom?.includes(id)) throw new Error("sample boom");
      const made = k === 1 ? o.hooks?.stub?.[id] : undefined;
      return made ?? (await real(...a));
    } finally {
      running -= 1;
      ev.push(`end:${id}`);
    }
  };
  const priv = b as unknown as {
    lane: { index: number; realActive: string | undefined; scratchCwd(): string };
    laneList: { index: number; holdsDaemon(): boolean; inFlight: string | undefined }[];
    daemonBaseline: Map<number, { fromDaemon?: true }>;
    fillDaemonBaseline(l: unknown, s: number, c: boolean): Promise<void>;
    fillDaemonBaselineLaned(l: unknown, s: number, c: boolean): Promise<void>;
    checkBound(l: { index: number }): Promise<void>;
    baselineRequest(...a: unknown[]): Promise<unknown>;
    memoryGate(hold?: boolean): Promise<boolean>;
    baselineDaemonFor(l: unknown, m: unknown, s: number): Promise<unknown>;
    lanedFillActive: boolean;
    memoryStopped: boolean;
  };
  /** The fill alone, laned, as `takeDaemonBaseline` enters it (with coverage, stop 1 s). */
  const fill = () => priv.fillDaemonBaselineLaned(priv.lane, 1, true);
  /** The orchestrator's baseline step on lane 0's view: the bracket, a null activation, one run per test. */
  const baseline = async () => {
    const v = views[0];
    if (v === undefined) throw new Error("no lane views");
    b.baselinePhase(true);
    try {
      await v.activate(null);
      for (const r of suite) await v.run(r, OPTS);
    } finally {
      b.baselinePhase(false); // as al-runner-v3-entries.test.ts's `baseline`
    }
  };
  /** Lane -> the codeunits it answered, in ids order (from the serve log). */
  const answeredBy = () => {
    const by = new Map<number, number[]>();
    for (const q of serve.requests) {
      const k = serve.laneOfDaemon(q.daemon);
      by.set(k, [...(by.get(k) ?? []), ...q.cus]);
    }
    for (const v of by.values()) v.sort((a, b) => a - b);
    return by;
  };
  return {
    b,
    l,
    ids,
    serve,
    views,
    priv,
    fill,
    baseline,
    ev,
    log,
    shots,
    peak: () => peak,
    running: () => running,
    answeredBy,
    rep: () => b.daemonBaselineReport(),
    lanes: () => b.baselineLanesReport(),
    idx: (e: string) => log.indexOf(e),
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const timedOut = { timedOut: true, wallMs: 1 };
const shotCus = (r: Rig) => r.shots.map((s) => s.cu);

describe("PR-437 change 0: the one-worker path is today's", () => {
  const spies = () => {
    const proto = AlRunnerV3Backend.prototype as unknown as Record<string, () => Promise<void>>;
    return {
      one: spyOn(proto, "fillDaemonBaseline"),
      laned: spyOn(proto, "fillDaemonBaselineLaned"),
      restore() {
        this.one.mockRestore();
        this.laned.mockRestore();
      },
    };
  };

  // Red: change 0's knob condition removed (the laned fill entered with LETHAL_V3_BASELINE_LANES=1).
  test("the knob at 1 takes fillDaemonBaseline: every request on one daemon", async () => {
    const was = process.env[BASELINE_LANES_ENV];
    process.env[BASELINE_LANES_ENV] = "1";
    const s = spies();
    try {
      const r = await rig({ n: 4 });
      await r.baseline();
      expect(s.one).toHaveBeenCalled(); // once per baseline call; the first one fills
      expect(s.laned).toHaveBeenCalledTimes(0);
      expect(new Set(r.serve.requests.map((q) => q.daemon))).toEqual(new Set([0]));
      expect(r.lanes()).toBeUndefined();
    } finally {
      s.restore();
      if (was === undefined) Reflect.deleteProperty(process.env, BASELINE_LANES_ENV);
      else process.env[BASELINE_LANES_ENV] = was;
    }
  });

  // Red: change 0's lanes condition removed (a backend without lanes(n) enters the laned fill).
  test("no lanes takes fillDaemonBaseline", async () => {
    const s = spies();
    try {
      const r = await rig({ n: 4, lanes: 1 });
      const b = r.b;
      b.baselinePhase(true);
      await b.activate(null);
      for (const id of r.ids) await b.run(refOf(id), OPTS);
      await b.baselinePhase(false);
      expect(s.one).toHaveBeenCalled();
      expect(s.laned).toHaveBeenCalledTimes(0);
      expect(new Set(r.serve.requests.map((q) => q.daemon))).toEqual(new Set([0]));
    } finally {
      s.restore();
    }
  });

  // Red: change 0's guard condition removed (no guard, or a guard with no readable limit, enters the laned fill).
  test("no readable guard takes fillDaemonBaseline: no headroom, or a reading with no limit", async () => {
    const s = spies();
    try {
      const off = await rig({ n: 4, guard: false });
      await off.baseline();
      const noLimit = await rig({
        n: 4,
        seams: { memoryReader: () => ({ usedBytes: GIB, source: "/sys/fs/cgroup/memory.max" }) },
      });
      await noLimit.baseline();
      expect(s.laned).toHaveBeenCalledTimes(0);
      expect(s.one).toHaveBeenCalled();
      expect(off.lanes()).toBeUndefined();
      expect(noLimit.lanes()).toBeUndefined();
      // and with all three, the laned fill (once: later baseline calls find it filled)
      const on = await rig({ n: 4 });
      await on.baseline();
      expect(s.laned).toHaveBeenCalledTimes(1);
      expect(on.lanes()).toBeDefined();
    } finally {
      s.restore();
    }
  });

  // Red: the knob read as anything but exactly `1`/unset (a bad value accepted, or not read at construction).
  test("a bad LETHAL_V3_BASELINE_LANES is refused by name at construction", async () => {
    const was = process.env[BASELINE_LANES_ENV];
    process.env[BASELINE_LANES_ENV] = "2";
    try {
      await expect(rig({ n: 2 })).rejects.toThrow(AlRunnerV3BaselineLanesRefusedError);
      await expect(rig({ n: 2 })).rejects.toThrow(`${BASELINE_LANES_ENV} is "2"`);
    } finally {
      if (was === undefined) Reflect.deleteProperty(process.env, BASELINE_LANES_ENV);
      else process.env[BASELINE_LANES_ENV] = was;
    }
  });
});

describe("PR-437 change 1: one tree", () => {
  // Red: the worker sends its own lane's request base (`base` not passed), or checkBound(its lane), or a one-shot on lane k.
  test("lane k's request carries lane 0's sourcePaths and checkBound(lane 0); every one-shot's tree and cwd are lane 0's", async () => {
    const r = await rig({
      n: 6,
      seams: { holdBaselineLaneZero: true },
      serve: { rows: (cu) => (cu === 79303 ? { status: "fail", message: SLOW } : pass(cu)) },
    });
    const bound: number[] = [];
    const realBound = r.priv.checkBound.bind(r.b);
    r.priv.checkBound = async (l) => {
      bound.push(l.index);
      return realBound(l);
    };
    await r.fill();
    const lanesUsed = new Set(r.serve.requests.map((q) => r.serve.laneOfDaemon(q.daemon)));
    expect(lanesUsed).toEqual(new Set([0, 1])); // both lanes answered
    for (const q of r.serve.requests)
      expect((q.body.sourcePaths as string[])[0]).toBe(r.priv.lane.realActive ?? "?");
    expect(bound.length).toBeGreaterThanOrEqual(r.serve.requests.length);
    expect(new Set(bound)).toEqual(new Set([0]));
    expect(r.shots.length).toBeGreaterThanOrEqual(2);
    for (const s of r.shots) {
      expect(s.active).toBe(r.priv.lane.realActive ?? "?");
      expect(s.cwd).toBe(r.priv.lane.scratchCwd());
    }
    // The daemon is the lane's own: lane 1's daemon runs in daemon-1.
    expect(r.serve.cwds.some((c) => c?.endsWith("daemon-1"))).toBe(true);
    expect(r.rep().dropped).toBeUndefined();
  });

  // Red: the worker stores the raw answer (no keptAnswer), so a served document keeps unhit statements.
  test("stored outcomes hold no raw answer: what is served has no unhit statement", async () => {
    const r = await rig({ n: 5, serve: { unhit: true }, coverage: "al-runner" });
    await r.fill();
    const served = [...r.priv.daemonBaseline.values()] as unknown as {
      fromDaemon?: true;
      coverage: { kind: string; doc?: unknown };
    }[];
    const daemonOnes = served.filter((a) => a.fromDaemon === true);
    expect(daemonOnes.length).toBeGreaterThan(0);
    const text = JSON.stringify(daemonOnes.map((a) => a.coverage));
    expect(text).not.toContain('"hits":0');
    expect(text).toContain('"hits":1');
  });
});

describe("PR-437 change 3: lanes joining", () => {
  /** Real admission: R0 = 2 GiB (anon 2 GiB, estimate 1 GiB), LethAL at 4 GiB (no LethAL term). */
  const real = (o: { used: number; declared: string; anon?: number }) =>
    rig({
      n: 6,
      used: () => o.used,
      realAdmission: true,
      seams: {
        anonReader: () => o.anon ?? 2 * GIB,
        memoryEstimateBytes: GIB,
        lethalRss: () => 4 * GIB,
        classFilePath: () => "/fake/class",
        readTextFile: () => `other 1 ${o.declared}`,
      },
    });

  // Red: the cgroup check dropped from the join rule (lane 1 joins at 20 GiB used).
  test("the cgroup check refuses alone: 20 GiB used of 32 (T 11 GiB)", async () => {
    const r = await real({ used: 20 * GIB, declared: "25" });
    await r.fill();
    expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
    expect(r.lanes()?.notAdmitted[1]).toContain("cgroup");
    expect(r.rep().dropped).toBeUndefined(); // the fill still finishes when none joins
    expect(r.priv.daemonBaseline.size).toBeGreaterThan(0);
  });

  // Red: the declared-peak check dropped, or T without the two one-shot slots (need 8 GiB would fit 14).
  test("the declared check refuses alone, and T counts the two one-shot slots: 15 GiB needed, 14 declared", async () => {
    const r = await real({ used: GIB, declared: "14" });
    await r.fill();
    expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
    expect(r.lanes()?.notAdmitted[1]).toContain("declared peak");
    expect(r.lanes()?.notAdmitted[1]).toContain("15.0 GiB needed");
    expect(BASELINE_ONESHOT_SLOT_BYTES).toBe(3.5 * GIB);
  });

  // Red: `joined` not counting lane 0 (T = R0 + 2S: 13 GiB needed, so 14.9 would admit).
  test("the first join's T is 2·R0 + 2·S: 15 GiB declared joins, 14.9 does not", async () => {
    const yes = await real({ used: GIB, declared: "15" });
    await yes.fill();
    expect(Object.keys(yes.lanes()?.unitsByLane ?? {})).toEqual(["0", "1"]);
    const no = await real({ used: GIB, declared: "14.9" });
    await no.fill();
    expect(no.lanes()?.unitsByLane).toEqual({ 0: 6 });
  });

  // Red (M3): the receipt names only the first refused lane.
  test("every lane not admitted is named, with its rule", async () => {
    const r = await rig({
      n: 6,
      lanes: 3,
      used: () => 20 * GIB,
      realAdmission: true,
      seams: {
        anonReader: () => 2 * GIB,
        memoryEstimateBytes: GIB,
        lethalRss: () => 4 * GIB,
        classFilePath: () => "/fake/class",
        readTextFile: () => "other 1 25",
      },
    });
    await r.fill();
    expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
    expect(Object.keys(r.lanes()?.notAdmitted ?? {})).toEqual(["1", "2"]);
    for (const why of Object.values(r.lanes()?.notAdmitted ?? {})) expect(why).toContain("cgroup");
  });

  // Red: a 0 anon reading taken as a reading (R0 = est), so lane 1 joins for free.
  test("a 0 reading never admits", async () => {
    const r = await real({ used: GIB, declared: "64", anon: 0 });
    await r.fill();
    expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
    expect(r.lanes()?.notAdmitted[1]).toContain("unmeasured");
  });

  // Red: the `lane0Answered` condition dropped (lane 1 joins after lane 0's unusable first answer and takes unit 1).
  test("none joins before lane 0's first answer, and the fill still finishes", async () => {
    const r = await rig({
      n: 2,
      serve: { eof: (q) => q.cus.includes(79300) },
    });
    await r.fill();
    expect(r.lanes()?.unitsByLane).toEqual({ 0: 2 });
    expect(r.serve.cwds.every((c) => !c?.endsWith("daemon-1"))).toBe(true);
  });
});

describe("PR-437 change 3: the over-bound close", () => {
  // Red: the laned path closes every lane at the first poll (today's latch), so the busy lane 1 is closed mid-request.
  test("closes an idle lane at once and a busy one only on a later poll, once idle", async () => {
    let reads = 0;
    const r = await rig({
      n: 2,
      used: () => {
        reads += 1;
        return reads <= 3 ? 30 * GIB : GIB; // over the 28 GiB bound for three reads
      },
      seams: { memoryWaitPolls: 5 },
    });
    const [l0, l1] = r.priv.laneList;
    if (l0 === undefined || l1 === undefined) throw new Error("two lanes");
    const mode = { testIsolation: "test", runSelectedOnly: false };
    await r.priv.baselineDaemonFor(l0, mode, 1);
    await r.priv.baselineDaemonFor(l1, mode, 1);
    l1.inFlight = "baseline"; // a request in flight on lane 1
    let sleeps = 0;
    r.b.seams.memorySleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        expect(l0.holdsDaemon()).toBe(false); // idle: closed at the first poll
        expect(l1.holdsDaemon()).toBe(true); // in flight: kept
        l1.inFlight = undefined; // its request ends
      }
    };
    reads = 0;
    r.priv.lanedFillActive = true;
    try {
      expect(await r.priv.memoryGate(false)).toBe(true);
    } finally {
      r.priv.lanedFillActive = false;
    }
    expect(sleeps).toBeGreaterThanOrEqual(2);
    expect(l1.holdsDaemon()).toBe(false); // closed on a later poll
  });
});

describe("PR-437 M1: a lane is busy from the start of its request", () => {
  // Red: inFlight set only inside plain/batchRequest, so a lane whose daemon is starting reads as idle and the
  // over-bound close may shut that fresh daemon.
  test("the lane reads as in flight while its baseline daemon starts", async () => {
    const r = await rig({ n: 4, seams: { holdBaselineLaneZero: true } });
    const seen: { lane: number; inFlight: string | undefined }[] = [];
    const real = r.priv.baselineDaemonFor.bind(r.b);
    r.priv.baselineDaemonFor = (l, m, s) => {
      const lane = l as { index: number; inFlight: string | undefined };
      seen.push({ lane: lane.index, inFlight: lane.inFlight });
      return real(l, m, s);
    };
    await r.fill();
    expect(new Set(seen.map((x) => x.lane))).toEqual(new Set([0, 1]));
    for (const x of seen) expect(x.inFlight).toBe("baseline");
    expect(r.priv.laneList.every((l) => l.inFlight === undefined)).toBe(true); // restored after each request
  });
});

describe("PR-437 change 5: one-shots", () => {
  // Red: the "no free slot" branch skips settling the oldest, so a third one-shot starts beside two.
  test("never more than two one-shots in flight, in-place kinds included; an in-place one-shot first settles the oldest", async () => {
    // Lane 0: 79300, 79302; lane 1: 79301, 79303 (79302's answer waits until 79303's request arrived).
    // Samples: 79301 (planned, lane 1's first answer: beside), 79302 (lane 0's lane sample: beside), 79303 (lane 1's
    // lane sample: no free slot, so in place after settling the oldest).
    // 79301's one-shot runs until the loop starts settling a sample; 79302's until 79303's one-shot starts.
    const r = await rig({
      n: 8,
      seams: { holdBaselineLaneZero: true },
      serve: { holdUntil: (q, ev) => (q.cus.includes(79302) ? ev.when("req:79303") : undefined) },
      hooks: {
        hold: (cu, ev) =>
          cu === 79301
            ? ev.when("count:sample")
            : cu === 79302
              ? ev.when("start:79303")
              : undefined,
      },
    });
    await r.fill();
    expect(r.peak()).toBeLessThanOrEqual(2);
    expect(r.lanes()?.mostOneShots).toBe(2);
    expect(r.lanes()?.mostOneShots).toBeLessThanOrEqual(2);
    expect(r.rep().dropped).toBeUndefined();
    // The third one-shot to start began only after the first had ended.
    const starts = r.log.filter((e) => e.startsWith("start:"));
    const [first, , third] = starts;
    if (first === undefined || third === undefined) throw new Error("three one-shots");
    expect(r.idx(`end:${first.slice(6)}`)).toBeLessThan(r.idx(third));
  });

  // Red: before any join, samples take the two slots (no `admit` read), so one overlaps at 23 GiB used.
  test("with no lane joined, at most one sample runs beside, admitted by the memory read", async () => {
    const run = async (used: number) => {
      const box: { ev?: Events } = {};
      const r = await rig({
        n: 6,
        used: () => used,
        realAdmission: true,
        seams: {
          anonReader: () => 0, // unmeasured: no join
          sampleRss: () => {
            box.ev?.push("rss");
            return GIB;
          },
        },
        // 79302's answer waits until the first sample's one-shot started, so the request for 79303 starts after it
        serve: {
          holdUntil: (q, ev) => (q.cus.includes(79302) ? ev.when("start:79301") : undefined),
        },
        // that one-shot runs until the request for 79303 has arrived (beside it), or, in place with no room, until
        // the worker's S1 check has read the room (the request then waits for it)
        hooks: {
          hold: (cu, ev) =>
            cu === 79301
              ? ev.until(
                  () =>
                    ev.list.includes("req:79303") ||
                    ev.list.slice(ev.list.indexOf("start:79301")).includes("rss"),
                )
              : undefined,
        },
      });
      box.ev = r.ev;
      await r.fill();
      expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
      expect(r.lanes()?.mostOneShots).toBeLessThanOrEqual(1);
      return r.rep();
    };
    expect((await run(GIB)).samplesOverlapped).toBeGreaterThanOrEqual(1);
    expect((await run(23 * GIB)).samplesOverlapped).toBe(0); // 23 + 3 (size) + 3 (estimate) over the 28 GiB bound
  });

  // Red (S1): the loop's in-place one-shot not registered, so lane 0 sends 79304 beside the too-slow run of 79302
  // with no room.
  test("with no lane joined, a request goes beside an in-place one-shot only with room", async () => {
    const run = async (used: number, releaseOnRoomCheck: boolean) => {
      const box: { ev?: Events } = {};
      const r = await rig({
        n: 6,
        used: () => used,
        realAdmission: true,
        seams: {
          anonReader: () => 0, // unmeasured: no join
          sampleRss: () => {
            box.ev?.push("rss"); // read by admit (79301) and by S1's check
            return GIB;
          },
        },
        serve: {
          rows: (cu) => (cu === 79302 ? { status: "fail", message: SLOW } : pass(cu)),
          // 79303's answer waits until 79302's too-slow one-shot started, so 79304's request comes during it
          holdUntil: (q, ev) => (q.cus.includes(79303) ? ev.when("start:79302") : undefined),
        },
        // the too-slow one-shot runs until 79304's request arrived, or (no room) until S1 read the room after it started
        hooks: {
          hold: (cu, ev) =>
            cu === 79302
              ? ev.until(
                  () =>
                    ev.list.includes("req:79304") ||
                    (releaseOnRoomCheck &&
                      ev.list.slice(ev.list.indexOf("start:79302")).includes("rss")),
                )
              : undefined,
        },
      });
      box.ev = r.ev;
      await r.fill();
      expect(r.lanes()?.unitsByLane).toEqual({ 0: 6 });
      return { start: r.idx("start:79302"), end: r.idx("end:79302"), req: r.idx("req:79304") };
    };
    // 23 + 3 held + 3 over the 28 GiB bound: 79304 waits for the one-shot's end
    const no = await run(23 * GIB, true);
    expect(no.start).toBeGreaterThan(-1);
    expect(no.req).toBeGreaterThan(no.end);
    // room: 79304 goes out while the one-shot runs
    const yes = await run(GIB, false);
    expect(yes.req).toBeGreaterThan(yes.start);
    expect(yes.req).toBeLessThan(yes.end);
  });

  // Red: LETHAL_V3_SEQUENTIAL_SAMPLES / concurrentSamples:false ignored by the laned loop.
  test("sequential samples give none beside", async () => {
    const r = await rig({ n: 8, seams: { concurrentSamples: false, holdBaselineLaneZero: true } });
    await r.fill();
    expect(r.rep().samplesOverlapped).toBe(0);
    expect(r.lanes()?.mostOneShots).toBe(1);
  });

  // Red: C6 dropped (the in-place throw rethrown before the older in-flight sample's drop is applied).
  test("an in-place throw after an older dropping sample drops", async () => {
    const r = await rig({
      n: 8,
      seams: { holdBaselineLaneZero: true },
      // 79302's answer waits for 79303's request, so lane 1 takes 79303 (its second answer: a lane sample with no
      // free slot); 79302's dropping one-shot runs until 79303's in-place one-shot has started (and thrown)
      serve: { holdUntil: (q, ev) => (q.cus.includes(79302) ? ev.when("req:79303") : undefined) },
      oneShotRows: (cu) => (cu === 79302 ? { status: "fail", message: "differs" } : pass(cu)),
      hooks: {
        boom: [79303],
        hold: (cu, ev) => (cu === 79302 ? ev.when("start:79303") : undefined),
      },
    });
    await r.fill();
    expect(r.rep().dropped).toContain("codeunit 79302");
    expect(r.log).toContain("start:79303");
  });
});

describe("PR-437 change 2 and 4: the halt, the walk, the throws", () => {
  // Red: the loop's halt not checked before EACH request (C7): lane 1 sends 79303 alone after the drop, mid-unit.
  test("after the loop drops, no worker takes a new unit or sends another request, mid-unit included", async () => {
    let atDrop = -1;
    const box: { r?: Rig } = {};
    const DROP = "notify:al-runner-v3-baseline-daemon-dropped";
    const r = await rig({
      n: 6,
      seams: {
        concurrentSamples: false,
        holdBaselineLaneZero: true,
        baselineBatching: true,
        baselineBatchSize: 2,
      },
      // Lane 0: batch [79300, 79301], then batch [79304, 79305]; lane 1: batch [79302, 79303], which fails, so its
      // unit goes on alone: 79302, then 79303. 79302-alone and [79304, 79305] are answered only after the drop.
      serve: {
        eof: (q) => q.batch && q.cus.includes(79302),
        holdUntil: (q, ev) =>
          (!q.batch && q.cus.includes(79302)) || q.cus.includes(79304) ? ev.when(DROP) : undefined,
      },
      // the dropping sample's one-shot (79301, in place) waits until 79302-alone and [79304, 79305] have been sent
      hooks: {
        hold: (cu, ev) =>
          cu === 79301
            ? ev.until(() => ev.list.includes("req:79302") && ev.list.includes("req:79304+79305"))
            : undefined,
      },
      oneShotRows: (cu) => (cu === 79301 ? { status: "fail", message: "differs" } : pass(cu)),
      notify: (c) => {
        if (c === "al-runner-v3-baseline-daemon-dropped")
          atDrop = box.r?.serve.requests.length ?? -1;
      },
    });
    box.r = r;
    await r.fill();
    expect(r.rep().dropped).toContain("codeunit 79301");
    expect(r.log).toContain("req:79302"); // the unit's first alone request was in flight at the drop
    expect(r.log).not.toContain("req:79303"); // its second never went out
    expect(atDrop).toBe(4); // [79300, 79301], [79302, 79303] (failed), 79302, [79304, 79305]
    expect(r.serve.requests.length).toBe(atDrop);
  });

  // Red: the loop serving stored outcomes past its stop (e.g. every stored outcome kept at the end).
  test("only walked positions are served: an outcome stored past a stop is never in daemonBaseline", async () => {
    let spent = false;
    const r = await rig({
      n: 8,
      seams: { concurrentSamples: false, holdBaselineLaneZero: true },
      stopHandle: { spent: () => spent, signalled: () => false, stopForMemory: () => {} },
      // the sample's (timed-out) one-shot waits until four requests have arrived (the workers run ahead), then
      // the budget is spent
      hooks: {
        stub: { 79301: timedOut },
        hold: (cu, ev) =>
          cu === 79301
            ? ev
                .whenCount((e) => e.startsWith("req:"), 4)
                .then(() => {
                  spent = true;
                })
            : undefined,
      },
    });
    await r.fill();
    expect(r.serve.requests.length).toBeGreaterThanOrEqual(4);
    expect([...r.priv.daemonBaseline.keys()]).toEqual([79300]);
  });

  // Red (S2): the loop not reading spent() per position, so stored positions go on starting one-shots.
  test("a spent budget stops the walk: positions stored ahead start no further one-shot", async () => {
    let spent = false;
    const r = await rig({
      n: 8,
      seams: { concurrentSamples: false, holdBaselineLaneZero: true },
      stopHandle: { spent: () => spent, signalled: () => false, stopForMemory: () => {} },
      // the first sample's one-shot (in place) runs until every position is stored, then the budget is spent
      hooks: {
        hold: (cu, ev) =>
          cu === 79301
            ? ev
                .whenCount((e) => e.startsWith("ans:"), 8)
                .then(() => {
                  spent = true;
                })
            : undefined,
      },
    });
    await r.fill();
    expect(r.serve.answered).toHaveLength(8);
    expect(shotCus(r)).toEqual([79301]); // no lane sample, no planned 79307
    expect([...r.priv.daemonBaseline.keys()].sort()).toEqual([79300, 79301]);
  });

  /**
   * Lane 0 takes 79300 and 79302, lane 1 79301 and the rest (the hold seam). A signal read once, right after
   * lane 0's request for 79302, ends lane 0 without storing it: a gap at position 2.
   */
  const gapRig = async (throwAt?: number) => {
    let armed = false;
    const box: { ev?: Events } = {};
    const r = await rig({
      n: 6,
      seams: { concurrentSamples: false, holdBaselineLaneZero: true },
      // lane 1's answers wait until lane 0 has read the one-shot signal, so nothing else reads it first
      serve: { holdUntil: (q, ev) => (q.lane === 1 ? ev.when("signal-taken") : undefined) },
      stopHandle: {
        spent: () => false,
        signalled: () => {
          if (!armed) return false;
          armed = false;
          box.ev?.push("signal-taken");
          return true;
        },
        stopForMemory: () => {},
      },
    });
    box.ev = r.ev;
    const realReq = r.priv.baselineRequest.bind(r.b);
    r.priv.baselineRequest = async (...a) => {
      const lane = a[0] as { index: number };
      const cu = a[2] as number;
      if (throwAt !== undefined && cu === throwAt)
        throw new AlRunnerV3UnprovenBatchError("typed, from a later position");
      const out = await realReq(...a);
      if (lane.index === 0 && cu === 79302) armed = true;
      return out;
    };
    return r;
  };

  // Red: the gap rule throwing fill-gap before looking for a recorded throw at or after the gap.
  test("a typed throw after a gap is rethrown, never read as fill-gap", async () => {
    const r = await gapRig(79304);
    await expect(r.fill()).rejects.toThrow(AlRunnerV3UnprovenBatchError);
    expect(r.serve.answered).toContain(79302); // lane 0 was answered, then stopped without storing it
  });

  // Red: a gap with no stop and no throw read as a stop (a silent short fill).
  test("a gap with no throw and no stop throws fill-gap by name", async () => {
    const r = await gapRig();
    await expect(r.fill()).rejects.toThrow(AlRunnerV3BaselineFillGapError);
    await expect(Promise.reject(new AlRunnerV3BaselineFillGapError(2, 79302))).rejects.toThrow(
      "al-runner-v3-baseline-fill-gap",
    );
  });

  // Red: C4 dropped (a gap with memoryStopped and no stop handle read as a stop, the loud error swallowed).
  test("a gap with memoryStopped and no stop handle rethrows the memory-bound error", async () => {
    let threw = false;
    const r = await rig({ n: 6, seams: { holdBaselineLaneZero: true } });
    const realGate = r.priv.memoryGate.bind(r.b);
    let gates = 0;
    r.priv.memoryGate = async (hold) => {
      gates += 1;
      // Gate 3 is lane 0's request for 79302 (gate 1: lane 0's 79300; gate 2: lane 1's 79301 at its join).
      if (gates === 3) await r.ev.when("threw");
      return realGate(hold);
    };
    const realReq = r.priv.baselineRequest.bind(r.b);
    r.priv.baselineRequest = async (...a) => {
      if ((a[2] as number) === 79303) {
        r.priv.memoryStopped = true;
        threw = true;
        r.ev.push("threw");
        throw new AlRunnerV3MemoryBoundError(30 * GIB, 28 * GIB, "/sys/fs/cgroup/memory.max");
      }
      return realReq(...a);
    };
    await expect(r.fill()).rejects.toThrow(AlRunnerV3MemoryBoundError);
    expect(threw).toBe(true);
    expect(r.serve.requests.some((q) => q.cus.includes(79302))).toBe(false); // lane 0 stopped at its gate: a gap at 2
  });

  // Red: throws rethrown in completion order (a worker's throw before the loop reaches the earlier drop).
  test("a throw at a later position loses to a drop at an earlier one", async () => {
    const r = await rig({
      n: 8,
      seams: { concurrentSamples: false, holdBaselineLaneZero: true },
      oneShotRows: (cu) => (cu === 79301 ? { status: "fail", message: "differs" } : pass(cu)),
      // the earlier sample (79301, in place) finishes only after the later throw (79303) is recorded
      hooks: { hold: (cu, ev) => (cu === 79301 ? ev.when("threw:79303") : undefined) },
    });
    const realReq = r.priv.baselineRequest.bind(r.b);
    r.priv.baselineRequest = async (...a) => {
      if ((a[2] as number) === 79303) {
        r.ev.push("threw:79303");
        throw new AlRunnerV3UnprovenBatchError("later");
      }
      return realReq(...a);
    };
    await r.fill();
    expect(r.idx("threw:79303")).toBeLessThan(r.idx("end:79301")); // the throw came first in time
    expect(r.rep().dropped).toContain("codeunit 79301");
  });

  // Red: M2 dropped (a recorded worker throw rethrown before the older in-flight sample's drop is applied).
  test("an earlier dropping sample beside the loop beats a later worker throw", async () => {
    const r = await rig({
      n: 8,
      seams: { holdBaselineLaneZero: true }, // samples beside: 79301 is in flight when the loop reaches 79303
      oneShotRows: (cu) => (cu === 79301 ? { status: "fail", message: "differs" } : pass(cu)),
      hooks: { hold: (cu, ev) => (cu === 79301 ? ev.when("threw:79303") : undefined) },
    });
    const realReq = r.priv.baselineRequest.bind(r.b);
    r.priv.baselineRequest = async (...a) => {
      if ((a[2] as number) === 79303) {
        r.ev.push("threw:79303");
        throw new AlRunnerV3UnprovenBatchError("later");
      }
      return realReq(...a);
    };
    await r.fill();
    expect(r.rep().dropped).toContain("codeunit 79301");
  });

  // Red: the loop walking in completion order (the uniform watch and `unusable` would see lane 1's answers first).
  test("the uniform watch and unusable see ids order whatever the completion order", async () => {
    const observed: number[] = [];
    const proto = UniformRefusalWatch.prototype as unknown as {
      observe: (id: number, rows: unknown) => unknown;
    };
    const realObserve = proto.observe;
    const spy = spyOn(proto, "observe").mockImplementation(function (
      this: unknown,
      id: number,
      rows: unknown,
    ) {
      observed.push(id);
      return realObserve.call(this, id, rows);
    });
    try {
      const r = await rig({
        n: 7,
        seams: { holdBaselineLaneZero: true },
        serve: {
          // 79304's (usable) answer waits until 79306's has come: its lane is blocked, so the OTHER lane answers
          // 79305 and 79306 first
          holdUntil: (q, ev) => (q.cus.includes(79304) ? ev.when("ans:79306") : undefined),
          // 79303 and 79305 give no usable answer: consecutive in completion order, not in ids order
          eof: (q) => q.cus.includes(79303) || q.cus.includes(79305),
        },
      });
      await r.fill();
      // the lanes answered out of order: 79306 and the unusable 79305 before the usable 79304
      expect(r.idx("ans:79306")).toBeGreaterThan(-1);
      expect(r.idx("ans:79306")).toBeLessThan(r.idx("ans:79304"));
      expect(r.idx("eof:79305")).toBeLessThan(r.idx("ans:79304"));
      expect(observed).toEqual(r.ids.filter((id) => id !== 79303 && id !== 79305));
      expect(r.rep().dropped).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  // Red: units split across lanes, or a failed batch re-sent by another worker.
  test("a unit goes to one lane, in order; a failed batch is re-sent alone by the same worker", async () => {
    const r = await rig({
      n: 6,
      seams: { baselineBatching: true, baselineBatchSize: 2, holdBaselineLaneZero: true },
      // the batch [79302, 79303] fails (a request error)
      serve: { eof: (q) => q.batch && q.cus.includes(79302) },
    });
    await r.fill();
    const laneOf = (q: { daemon: number }) => r.serve.laneOfDaemon(q.daemon);
    const batches = r.serve.requests.filter((q) => q.batch);
    expect(batches[0]?.cus).toEqual([79300, 79301]);
    const failed = batches.find((q) => q.cus.includes(79302));
    if (failed === undefined) throw new Error("the failed batch");
    const alone = r.serve.requests.filter((q) => !q.batch && (q.cus[0] ?? 0) <= 79303);
    expect(alone.map((q) => q.cus[0])).toEqual([79302, 79303]);
    for (const q of alone) expect(laneOf(q)).toBe(laneOf(failed));
    // every unit's codeunits went to one lane: 79300+79301 together, 79304+79305 on one lane
    const tail = r.serve.requests.filter((q) => q.cus.some((c) => c >= 79304));
    expect(new Set(tail.map(laneOf)).size).toBe(1);
  });
});

describe("PR-437 change 6: per-lane samples", () => {
  // Red: lanes not sampled, sampled at their first answer, or a planned sample at a lane's FIRST answer counted (C1).
  test("each lane is sampled once at its second answer; a lane's first answer never counts; lane 0 is sampled warm", async () => {
    const r = await rig({ n: 8, seams: { holdBaselineLaneZero: true } });
    await r.fill();
    const planned = baselineSampleIds(r.ids);
    const by = r.answeredBy();
    expect(by.get(1)?.[0]).toBe(79301); // lane 1's FIRST answer is the planned index 1
    const second = [...by.values()].map((v) => v[1]).filter((x): x is number => x !== undefined);
    const expected = second.filter((c) => !planned.includes(c));
    expect(expected).toContain(by.get(1)?.[1] ?? -1); // lane 1 still gets its own sample
    expect(new Set(shotCus(r))).toEqual(new Set([...planned, ...expected]));
    expect(shotCus(r)).not.toContain(79300); // never lane 0's fresh first answer
    expect(r.rep().laneSampled).toBe(expected.length);
    expect(r.rep().compared).toBe(planned.length); // lane samples are never in `compared`
    expect(r.rep().dropped).toBeUndefined();
  });

  // Red: a planned sample past a lane's first answer not counted (an extra lane sample runs).
  test("a planned sample on a lane's second answer counts: no extra one-shot", async () => {
    const r = await rig({ n: 6, realAdmission: true, seams: { anonReader: () => 0 } });
    await r.fill(); // lane 1 never joins: lane 0's second answer is the planned index 1
    expect(shotCus(r).sort()).toEqual(baselineSampleIds(r.ids).sort());
    expect(r.rep().laneSampled).toBe(0);
    expect(r.rep().dropped).toBeUndefined();
  });

  /**
   * Units of two. Lane 0: [79300, 79301], then [79304, 79305], whose answer waits for the request of
   * [79306, 79307]; lane 1: [79302, 79303] (its first request), then [79306, 79307] (its second).
   */
  const pairs = (o: Opts = {}) =>
    rig({
      n: 8,
      serve: {
        holdUntil: (q, ev) => (q.cus.includes(79304) ? ev.when("req:79306+79307") : undefined),
      },
      ...o,
      seams: {
        baselineBatching: true,
        baselineBatchSize: 2,
        holdBaselineLaneZero: true,
        ...(o.seams ?? {}),
      },
    });

  // Red (S3): a lane's first REQUEST counted as warm, so 79303 (in lane 1's first batch) is sampled for it.
  test("every codeunit of a lane's first request counts as its first answer: the sample is in its second request", async () => {
    const r = await pairs();
    await r.fill();
    expect(r.answeredBy().get(1)).toEqual([79302, 79303, 79306, 79307]);
    expect(shotCus(r)).not.toContain(79303); // inside lane 1's first (cold) request
    expect(shotCus(r)).not.toContain(79305); // inside lane 0's second request, after its lane sample 79304
    expect(new Set(shotCus(r))).toEqual(new Set([79301, 79304, 79306, 79307]));
    expect(r.rep().laneSampled).toBe(2); // 79304 (lane 0) and 79306 (lane 1)
    expect(r.rep().dropped).toBeUndefined();
  });

  // Red (S3): a batched first unit's second codeunit (the planned 79301) counted, so lane 0 is never sampled warm;
  // or a sample in the lane's second request not counted, so the fill drops the lane as unsampled.
  test("with no lane joined, a batched first unit's planned sample does not count; one in the second request does", async () => {
    const noJoin = { realAdmission: true as const, seams: { anonReader: () => 0 } };
    const four = await rig({
      n: 4,
      ...noJoin,
      seams: { anonReader: () => 0, baselineBatching: true, baselineBatchSize: 2 },
    });
    await four.fill(); // [79300, 79301] then [79302, 79303]
    expect(four.lanes()?.unitsByLane).toEqual({ 0: 2 });
    expect(new Set(shotCus(four))).toEqual(new Set([79301, 79302, 79303])); // 79302: lane 0's warm sample
    expect(four.rep().laneSampled).toBe(1);
    expect(four.rep().dropped).toBeUndefined();
    const three = await rig({
      n: 3,
      ...noJoin,
      seams: { anonReader: () => 0, baselineBatching: true, baselineBatchSize: 2 },
    });
    await three.fill(); // [79300, 79301] then 79302 alone: the planned last sample, in the second request
    expect(three.lanes()?.unitsByLane).toEqual({ 0: 2 });
    expect(new Set(shotCus(three))).toEqual(new Set([79301, 79302]));
    expect(three.rep().laneSampled).toBe(0);
    expect(three.rep().dropped).toBeUndefined();
  });

  // Red: a lane sample that keeps the daemon's answer on a too-slow codeunit (B1).
  test("a too-slow lane sample serves the one-shot's answer and durations", async () => {
    const slow: Rows = (cu) => (cu === 79306 ? { status: "fail", message: SLOW } : pass(cu));
    const r = await pairs({
      serve: {
        rows: slow,
        holdUntil: (q, ev) => (q.cus.includes(79304) ? ev.when("req:79306+79307") : undefined),
      },
    });
    await r.fill();
    expect(r.answeredBy().get(1)).toEqual([79302, 79303, 79306, 79307]);
    expect(shotCus(r)).toContain(79306);
    expect(r.priv.daemonBaseline.get(79306)?.fromDaemon).toBeUndefined();
    expect(r.rep().skippedTooSlow).not.toContain("Codeunit79306");
    expect(r.rep().laneSampled).toBeGreaterThanOrEqual(1);
  });

  // Red: a skipped lane sample calls replace, writes sampledSkipped, or leaves the lane counted as sampled.
  test("a skipped lane sample calls no replace and is replaced by that lane's next answer; the identity holds", async () => {
    // Ten codeunits (planned: 79301 and 79309), so 79307, lane 1's next answer after 79306, is not planned.
    const r = await pairs({
      n: 10,
      // in place, so the skip is known before lane 1's next answer is walked
      seams: { concurrentSamples: false },
      hooks: { stub: { 79306: timedOut } },
    });
    await r.baseline();
    const d = r.rep();
    expect(d.dropped).toBeUndefined();
    expect(d.laneSampledSkipped).toEqual(["Codeunit79306 (timed-out)"]);
    expect(d.sampledSkipped).toEqual([]);
    expect(d.replacements).toEqual({});
    expect(shotCus(r)).toContain(79307); // lane 1's next answer
    expect(d.laneSampled).toBeGreaterThanOrEqual(1);
    // judgeDaemonBaseline's second identity holds with the lane terms, and fails without them.
    const planned = baselineSampleIds(r.ids).length;
    const j = judgeDaemonBaseline("T", d, d.codeunits - planned, planned);
    expect(j.fail).toBeUndefined();
    const without = judgeDaemonBaseline(
      "T",
      { ...d, laneSampled: 0, laneSampledSkipped: [] },
      d.codeunits - planned,
      planned,
    );
    expect(without.fail).toContain("lane-sampled");
  });

  // Red: the lane-unsampled rule dropped, or skipped on a stop.
  test("an unsampled lane drops by name, on a stop too", async () => {
    // Single units. Lane 0: 79300, 79302 (its answer waits for 79303's request), 79304, 79305; lane 1: 79301, 79303
    // (its second request: a lane sample; its answer waits for 79305's request, so lane 1 has no later answer).
    const lanesOf = {
      seams: { holdBaselineLaneZero: true as const },
      serve: {
        holdUntil: (q: Req, ev: Events) =>
          q.cus.includes(79302)
            ? ev.when("req:79303")
            : q.cus.includes(79303)
              ? ev.when("req:79305")
              : undefined,
      },
    };
    const plain = await rig({ n: 6, ...lanesOf, hooks: { stub: { 79303: timedOut } } });
    await plain.fill();
    expect(plain.answeredBy().get(1)).toEqual([79301, 79303]);
    expect(plain.rep().dropped).toContain("baseline-lane-unsampled:1");
    expect(plain.rep().droppedDetail).toEqual(["baseline-lane-unsampled:1"]);
    expect(plain.rep().laneSampledSkipped).toEqual(["Codeunit79303 (timed-out)"]);
    let spent = false;
    const stopped = await rig({
      n: 6,
      ...lanesOf,
      hooks: {
        stub: { 79303: timedOut },
        hold: (cu) => {
          if (cu === 79303) spent = true; // the budget is spent while lane 1's sample runs: a stop
          return undefined;
        },
      },
      stopHandle: { spent: () => spent, signalled: () => false, stopForMemory: () => {} },
    });
    await stopped.fill();
    expect(stopped.rep().laneSampledSkipped).toEqual([]); // a stop, not a skip
    expect(stopped.rep().dropped).toContain("baseline-lane-unsampled:1");
  });
});

describe("PR-437 change 7: closes", () => {
  // Red: a joined lane's daemon not closed in the fill's finally.
  test("every joined lane is closed and every one-shot settled at the end", async () => {
    const r = await rig({ n: 8, seams: { holdBaselineLaneZero: true } });
    await r.fill();
    expect(r.priv.laneList.every((l) => !l.holdsDaemon())).toBe(true);
    expect(r.serve.closes.length).toBe(r.serve.cwds.length);
    expect(r.running()).toBe(0);
  });

  // Red: the finally skipped by the immediate memory-bound throw (lane 1's daemon left running).
  test("and on the immediate memory-bound throw", async () => {
    const box: { r?: Rig } = {};
    const r = await rig({
      n: 8,
      seams: { holdBaselineLaneZero: true, memoryWaitPolls: 0 },
      used: () => ((box.r?.serve.requests.length ?? 0) >= 3 ? 30 * GIB : GIB),
    });
    box.r = r;
    await expect(r.fill()).rejects.toThrow(AlRunnerV3MemoryBoundError);
    expect(r.serve.cwds.some((c) => c?.endsWith("daemon-1"))).toBe(true);
    expect(r.priv.laneList.every((l) => !l.holdsDaemon())).toBe(true);
    expect(r.running()).toBe(0);
  });
});
