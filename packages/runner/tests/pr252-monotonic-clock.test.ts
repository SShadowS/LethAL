// PR-252: every DURATION and DEADLINE rides the monotonic clock (src/clock.ts); TIMESTAMPS stay on the
// wall clock. The wall clock is stepped by replacing `Date.now`, restored after each test. Call counters only.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { AlRunnerServer, AlRunnerServerRequestError } from "../src/al-runner-server";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { readTargetSource } from "../src/baseline-snapshot";
import { SUSPEND_THRESHOLD_MS, clock, createSuspendWatch, monoNow, readBootMs } from "../src/clock";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import { watchProjectInputs } from "../src/source-drift";
import { ResultsStore } from "../src/store";
import { createTimingFold } from "../src/timing-summary";

const STEP_MS = 2_000_000; // 2,000 s

const realNow = Date.now;
let offset = 0;
beforeEach(() => {
  offset = 0;
  Date.now = () => realNow() + offset;
});
afterEach(() => {
  Date.now = realNow;
});

/** A minimal async line source, like the daemon's stdout. */
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

async function serverWith(onRequest: (out: Chan) => void): Promise<AlRunnerServer> {
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
        onRequest(out);
      },
    }),
    [],
    "serve",
  );
  await server.start(10_000, [], 1);
  return server;
}

describe("PR-252: a daemon deadline ignores the wall clock", () => {
  test("a wall clock +2,000 s mid-request does not fire the deadline", async () => {
    const server = await serverWith((out) => {
      // the request is in flight (its deadline is set): an entry line, the step, then the summary
      out.push(JSON.stringify({ type: "entrySummary" }));
      setTimeout(() => {
        offset += STEP_MS;
        out.push(JSON.stringify({ type: "entrySummary" }));
      }, 20);
      setTimeout(() => out.push(JSON.stringify({ type: "summary", total: 0 })), 40);
    });
    const ans = await server.runEntries({ command: "runTests" }, 5_000);
    expect(ans.summary.total).toBe(0);
    await server.close();
  });

  test("a wall clock -2,000 s mid-request does not extend the deadline", async () => {
    const server = await serverWith(() => {
      // the step comes after the deadline was set, and the daemon never answers
      setTimeout(() => {
        offset -= STEP_MS;
      }, 20);
    });
    const t0 = monoNow();
    const err = await server.runEntries({ command: "runTests" }, 300).catch((e) => e);
    expect(err).toBeInstanceOf(AlRunnerServerRequestError);
    expect((err as AlRunnerServerRequestError).kind).toBe("deadline");
    expect(monoNow() - t0).toBeLessThan(5_000);
    await server.close();
  });

  test("the clock helper itself does not move with the wall clock", () => {
    const before = monoNow();
    offset += STEP_MS;
    expect(monoNow() - before).toBeLessThan(5_000);
    offset -= 2 * STEP_MS;
    expect(monoNow() - before).toBeGreaterThanOrEqual(0);
    expect(clock.mono).toBeFunction();
  });
});

const SOURCE = `codeunit 50013 "K Probe"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
`;
const TESTS = `codeunit 50140 "A Tests"
{
    Subtype = Test;

    [Test]
    procedure A1()
    begin
    end;
}
`;

beforeAll(async () => {
  await initParser();
});

class Backend implements ExecutionBackend {
  /** Armed: every mutant-phase test run steps the wall clock by this much. */
  stepOnRun = 0;
  /** When set, only that call number steps. */
  onlyCall: number | undefined;
  calls = 0;
  capabilities(): BackendCapabilities {
    return {
      kind: "al-runner-v3",
      coverage: "al-runner",
      deploy: "none",
      isolation: "session",
      authoritative: false,
    };
  }
  readonly runnerBuild = async () => ({ version: "alrunner 3.0.0", binarySha256: "b".repeat(64) });
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {}
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    this.calls += 1;
    // call 1 is the baseline's only test
    if (this.calls > 1 && (this.onlyCall === undefined || this.onlyCall === this.calls))
      offset += this.stepOnRun;
    return {
      ref,
      outcome: "pass",
      durationMs: 1,
      measuredDurationMs: 1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Twice" }],
      },
    };
  }
}

async function inSession<T>(
  b: Backend,
  fn: (r: {
    events: RunEvent[];
    totalMs: number;
    root: string;
    report: Awaited<ReturnType<typeof runSession>>;
  }) => Promise<T> | T,
  timeBudgetSeconds?: number,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr252-"));
  try {
    const app = { id: "11111111-2222-3333-4444-555555555555", name: "p", publisher: "x" };
    await Bun.write(join(root, "app", "app.json"), JSON.stringify({ ...app, version: "1.0.0.0" }));
    await Bun.write(join(root, "app", "src", "K.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "ATests.Codeunit.al"), TESTS);
    await Bun.write(
      join(root, "tests", "app.json"),
      JSON.stringify({ name: "t", publisher: "x", version: "1.0.0.0" }),
    );
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: b,
      store: new ResultsStore(":memory:"),
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
      selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
      emit: [(e: RunEvent) => events.push(e)],
      registerStopSignal: () => () => {},
      ...(timeBudgetSeconds !== undefined ? { timeBudgetSeconds } : {}),
    });
    expect(report.mutants.length).toBeGreaterThan(0);
    return await fn({ events, totalMs: report.timings.totalMs, root, report });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PR-252: phase elapsedMs and the session total ignore a wall-clock step", () => {
  for (const [name, step] of [
    ["forward", STEP_MS],
    ["backward", -STEP_MS],
  ] as const) {
    test(`a ${name} step of 2,000 s in the mutants phase`, async () => {
      const b = new Backend();
      b.stepOnRun = step;
      await inSession(b, ({ events, totalMs }) => {
        const left = events.filter((e) => e.type === "phase-left");
        const mutants = left.find((e) => e.type === "phase-left" && e.phase === "mutants");
        expect(mutants).toBeDefined();
        for (const e of left) {
          if (e.type !== "phase-left") continue;
          expect(e.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(e.elapsedMs).toBeLessThan(100_000);
        }
        expect(totalMs).toBeGreaterThanOrEqual(0);
        expect(totalMs).toBeLessThan(100_000);
      });
    });
  }
});

const suspendedWarnings = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === "warning" && e.code === "run-suspended" ? [e.message] : []));
const realBoot = clock.boot;

describe("PR-252: suspend detection (the wall fallback: no boot clock)", () => {
  // Amendment 2: these steps move only the wall clock, so they test the fallback (`clock.boot` missing).
  beforeEach(() => {
    clock.boot = () => undefined;
  });
  afterEach(() => {
    clock.boot = realBoot;
  });

  test("the threshold is 30 s", () => {
    expect(SUSPEND_THRESHOLD_MS).toBe(30_000);
  });

  test("+60 s between two samples with the monotonic clock still: exactly one run-suspended, N = 60, with its wall time", async () => {
    const b = new Backend();
    b.stepOnRun = 60_000;
    b.onlyCall = 2;
    const before = realNow();
    await inSession(b, ({ events }) => {
      const w = suspendedWarnings(events);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(
        /^\[lethal\] the machine was suspended \(or its clock stepped\) for 6[01] s at 20\d\d-/,
      );
      expect(w[0]).toEndWith("; durations and deadlines exclude it (monotonic clock)");
      const iso = /at (\S+);/.exec(w[0] ?? "")?.[1] ?? "";
      expect(Math.abs(Date.parse(iso) - (before + 60_000))).toBeLessThan(60_000);
      const timing = createTimingFold();
      for (const e of events) timing.add(e);
      expect(timing.render()).toMatch(/suspended 1 time\(s\), 6[01] s/);
    });
  });

  test("two separate +60 s steps are two warnings", async () => {
    const b = new Backend();
    b.stepOnRun = 60_000; // every mutant-phase call
    await inSession(b, ({ events }) => {
      expect(suspendedWarnings(events).length).toBeGreaterThanOrEqual(2);
    });
  });

  test("+10 s (under the threshold) emits none", async () => {
    const b = new Backend();
    b.stepOnRun = 10_000;
    b.onlyCall = 2;
    await inSession(b, ({ events }) => expect(suspendedWarnings(events)).toEqual([]));
  });

  test("a backward step emits none, and neither does the step after it back", async () => {
    const b = new Backend();
    b.stepOnRun = -60_000;
    b.onlyCall = 2;
    await inSession(b, ({ events }) => expect(suspendedWarnings(events)).toEqual([]));
  });
});

describe("PR-252 amendment 2: the boot clock (CLOCK_BOOTTIME) is the suspend signal", () => {
  afterEach(() => {
    clock.boot = realBoot;
  });

  test("a +60 s WALL step (an NTP step) with the boot clock still emits NONE", async () => {
    clock.boot = () => realNow(); // a readable boot clock the wall step does not move
    const b = new Backend();
    b.stepOnRun = 60_000;
    b.onlyCall = 2;
    await inSession(b, ({ events }) => expect(suspendedWarnings(events)).toEqual([]));
  });

  test("a +60 s suspend (boot and wall move, monotonic still) emits exactly one, N = 60", async () => {
    clock.boot = () => Date.now(); // follows the stepped wall clock, as boot time does over a suspend
    const b = new Backend();
    b.stepOnRun = 60_000;
    b.onlyCall = 2;
    await inSession(b, ({ events }) => {
      const w = suspendedWarnings(events);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/suspended \(or its clock stepped\) for 6[01] s at /);
    });
  });

  // The watch alone, every clock a seam (ms).
  const watchOf = (boot: () => number | undefined, wall: () => number) => {
    let mono = 1_000;
    const tick = (ms: number): void => {
      mono += ms;
    };
    return { w: createSuspendWatch(boot, () => mono, wall), tick };
  };

  test("boot +60 s with the wall clock unchanged: one sample of 60,000 ms, at the wall time", () => {
    let boot = 5_000_000;
    const { w } = watchOf(
      () => boot,
      () => 7_000,
    );
    boot += 60_000;
    expect(w.sample()).toEqual({ ms: 60_000, atWallMs: 7_000 });
    expect(w.sample()).toBeUndefined();
  });

  test("boot +10 s (under the threshold) gives nothing", () => {
    let boot = 5_000_000;
    const { w } = watchOf(
      () => boot,
      () => 7_000,
    );
    boot += 10_000;
    expect(w.sample()).toBeUndefined();
  });

  test("a boot read that fails after creation skips samples, never throws, and keeps the baseline", () => {
    let boot: number | undefined = 5_000_000;
    const { w, tick } = watchOf(
      () => boot,
      () => 7_000,
    );
    boot = undefined;
    expect(w.sample()).toBeUndefined();
    boot = 5_000_000 + 1_000;
    tick(1_000);
    expect(w.sample()).toBeUndefined();
  });

  test("the default source is the boot clock when it can be read, else the wall clock", async () => {
    clock.boot = () => realNow();
    const b = new Backend();
    b.stepOnRun = 60_000;
    b.onlyCall = 2;
    await inSession(b, ({ events }) => expect(suspendedWarnings(events)).toEqual([]));
    clock.boot = () => undefined;
    const c = new Backend();
    c.stepOnRun = 60_000;
    c.onlyCall = 2;
    await inSession(c, ({ events }) => expect(suspendedWarnings(events)).toHaveLength(1));
  });

  test("readBootMs: /proc/uptime's first field in ms; undefined when unreadable or garbage", () => {
    expect(readBootMs(() => "1432596.36 15674070.20\n")).toBe(1_432_596_360);
    expect(readBootMs(() => "garbage")).toBeUndefined();
    expect(readBootMs(() => "")).toBeUndefined();
    expect(
      readBootMs(() => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });
});

describe("PR-252: the --time-budget default clock is monotonic", () => {
  test("a +2,000 s wall step on the first mutant run, timeBudgetSeconds 60, no clockMs: budget not reached, every mutant scored", async () => {
    const control = new Backend();
    let expected = 0;
    await inSession(control, ({ report }) => {
      expected = report.mutants.length;
    });
    offset = 0;
    const b = new Backend();
    b.stepOnRun = STEP_MS;
    b.onlyCall = 2;
    await inSession(
      b,
      ({ report }) => {
        expect(report.timeBudget).toBeUndefined();
        expect(report.mutants).toHaveLength(expected);
      },
      60,
    );
  });
});

describe("PR-252: a TIMESTAMP site still reads the wall clock", () => {
  // source-drift's `checkedAt` is compared with FILE mtimes (epoch ms), so it must be wall time. A
  // pinned stat that is long past makes the file "settled" on wall time, and the check then skips
  // it: a changed byte goes unseen. On a monotonic `checkedAt` (ms since process start) the file
  // would look brand new, stay unsettled, be re-read and flagged.
  test("source-drift settles a file against the wall clock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-pr252-drift-"));
    try {
      await Bun.write(join(dir, "app.json"), "{}");
      await Bun.write(join(dir, "A.al"), "codeunit 1 A {}");
      const long = Date.UTC(2020, 0, 1);
      const watch = watchProjectInputs(dir, await readTargetSource(dir), [], async (p) => ({
        size: p.endsWith("A.al") ? 15 : 2,
        mtimeMs: long,
        ctimeMs: long,
      }));
      await watch.check(); // first sight: settled on wall time (2020 is before now - 3 s)
      await Bun.write(join(dir, "A.al"), "codeunit 1 B {}"); // same size, same pinned stat
      await expect(watch.check()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
