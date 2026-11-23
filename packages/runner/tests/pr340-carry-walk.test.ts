import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlRunnerV3Backend,
  CARRY_WALK_ENV,
  type V3Row,
  V3_SINGLEINSTANCE_NOTE,
  V3_STALE_BUFFER_TEXT,
  judgeCarryWalk,
} from "../src/al-runner-v3-backend";
import { mergeChildEnv, v3MutantDaemonEnv } from "../src/al-runner-v3-seed";
import type {
  BackendCapabilities,
  BackendStatus,
  CarryWalkResult,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { CarryWalkError, readCarryWalk, runSession } from "../src/orchestrator";
import { splitBackend } from "../src/parallel-queue";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-340: the carry walk. Part 1 judges three answers (pure). Part 2 drives the backend's walk through a
 * shell backend whose daemon is a stateful fake with call counters. Part 3 drives the orchestrator's
 * trigger, scoring and ledger rule. Part 4 is the knob and its fingerprint. Never timing.
 * Each test names, in a comment, the line of the fix whose revert turns it red.
 */

const scratch = scratchDirs();

// ================================================================ part 1: judgeCarryWalk

const ECHO = 9;
const NONE = "NONE";
const row = (cu: number, method: string, status: "pass" | "fail", message?: string): V3Row => ({
  codeunit: cu,
  method,
  name: `Codeunit${cu}.${method}`,
  status,
  ...(message !== undefined ? { message } : {}),
  notRun: false,
});
const echo = (m: string): V3Row => row(ECHO, "Echo", "fail", `LETHAL-ECHO:${m}:true`);
const EXPECTED = new Map<number, ReadonlySet<string>>([
  [1, new Set(["t1"])],
  [2, new Set(["t2"])],
]);
/** One answer: the echo for `m`, then T1 and T2 with these statuses. */
const answer = (m: string, t1: "pass" | "fail", t2: "pass" | "fail" = "pass"): V3Row[] => [
  echo(m),
  row(1, "T1", t1, t1 === "fail" ? "boom" : undefined),
  row(2, "T2", t2, t2 === "fail" ? "boom2" : undefined),
];
const judge = (answers: V3Row[][]): CarryWalkResult =>
  judgeCarryWalk({ mutantId: "M1", echoId: ECHO, expected: EXPECTED, answers, stopSeconds: 60 });
const failedReason = (r: CarryWalkResult): string => (r.kind === "failed" ? r.reason : r.kind);

describe("PR-340: judgeCarryWalk", () => {
  // 1. Red: in judgeCarryWalk, remove the `r1.status === "fail" && second ... && third ...` return of `killed`.
  test("1. fail, pass, fail with complete rows and correct echoes: killed by T, with both failure texts", () => {
    const r = judge([answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")]);
    expect(r).toEqual({
      kind: "killed",
      codeunitId: 1,
      method: "T1",
      failure: "boom",
      reproduced: "boom",
    });
  });

  // PR-396. Red: in judgeCarryWalk, drop the `staleBufferGuard(` wrap around `v3RowVerdict`.
  test("PR-396: fail, pass, fail on the #8721 stale-buffer text is a failed walk, never a kill", () => {
    const stale = (m: string): V3Row[] => [
      echo(m),
      row(1, "T1", "fail", `Codeunit1 ${V3_STALE_BUFFER_TEXT}.`),
      row(2, "T2", "pass"),
    ];
    const r = judge([stale("M1"), answer(NONE, "pass"), stale("M1")]);
    expect(r.kind).toBe("failed");
    expect(failedReason(r)).toContain("reads error");
  });

  test("1b. the FIRST such test in the first answer's order is the killer", () => {
    const r = judge([
      [echo("M1"), row(2, "T2", "fail", "x"), row(1, "T1", "fail", "y")],
      [echo(NONE), row(2, "T2", "pass"), row(1, "T1", "pass")],
      [echo("M1"), row(2, "T2", "fail", "x"), row(1, "T1", "fail", "y")],
    ]);
    expect(r).toMatchObject({ kind: "killed", codeunitId: 2, method: "T2" });
  });

  // 2. Red: drop the `second.get(k)?.status === "pass"` condition.
  test("2. fail, fail, fail (red without the mutant) is walked, not killed", () => {
    expect(judge([answer("M1", "fail"), answer(NONE, "fail"), answer("M1", "fail")])).toEqual({
      kind: "walked",
    });
  });

  // 3. Red: drop the `third.get(k)?.status === "fail"` condition.
  test("3. fail, pass, PASS (no reproduction) is walked, not killed", () => {
    expect(judge([answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "pass")])).toEqual({
      kind: "walked",
    });
  });

  test("a clean all-pass walk is walked", () => {
    expect(judge([answer("M1", "pass"), answer(NONE, "pass"), answer("M1", "pass")])).toEqual({
      kind: "walked",
    });
  });

  // 4. Red: remove the `echoMismatch(echo, activation[i])` check in judgeCarryWalk.
  test("4. an echo naming none where the mutant was expected, or missing, is walk-failed", () => {
    const wrong = judge([answer("M1", "fail"), answer("M1", "pass"), answer("M1", "fail")]);
    expect(wrong.kind).toBe("failed");
    expect(failedReason(wrong)).toContain("request 2");
    const leaked = judge([answer(NONE, "fail"), answer(NONE, "pass"), answer("M1", "fail")]);
    expect(failedReason(leaked)).toContain("request 1");
    const missing = judge([
      answer("M1", "fail"),
      answer(NONE, "pass").filter((r) => r.codeunit !== ECHO),
      answer("M1", "fail"),
    ]);
    expect(failedReason(missing)).toContain("echo");
  });

  // 5. Red: remove the `missing.length > 0 || extra.length > 0` completeness check.
  test("5. a kept codeunit's row missing in ANY answer, or an extra or repeated row, is walk-failed", () => {
    for (const bad of [0, 1, 2]) {
      const answers = [answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")];
      answers[bad] = (answers[bad] ?? []).filter((r) => r.codeunit !== 2);
      const r = judge(answers);
      expect(r.kind, `answer ${bad + 1}`).toBe("failed");
      expect(failedReason(r)).toContain(`request ${bad + 1} is incomplete`);
    }
    const extra = judge([
      [...answer("M1", "fail"), row(3, "Hidden", "fail", "z")],
      answer(NONE, "pass"),
      answer("M1", "fail"),
    ]);
    expect(failedReason(extra)).toContain("unexpected");
    const twice = judge([
      [...answer("M1", "fail"), row(1, "T1", "fail", "again")],
      answer(NONE, "pass"),
      answer("M1", "fail"),
    ]);
    expect(failedReason(twice)).toContain("unexpected");
  });

  // 6 (rows half). Red: remove the `rows.length === 0` return.
  test("6. zero rows in any request is walk-failed", () => {
    const r = judge([answer("M1", "fail"), [], answer("M1", "fail")]);
    expect(failedReason(r)).toContain("request 2 gave zero rows");
  });

  test("a not-run (refused) row is never a kill row", () => {
    const refused: V3Row = { ...row(1, "T1", "fail", "refused"), notRun: true };
    const r = judge([
      [echo("M1"), refused, row(2, "T2", "pass")],
      answer(NONE, "pass"),
      answer("M1", "fail"),
    ]);
    expect(r.kind).toBe("failed");
  });

  // B1. Red: in judgeCarryWalk, bypass the `v3RowVerdict` classification (compare `r.status` directly).
  // Each of these is a `fail` by raw status, which a raw-status judge would call a kill.
  const REFUSALS: Array<[string, string]> = [
    [
      "v3's refusal marker without notRun (K1(a), R675)",
      "NotRun: out-of-scope: Sleep is not trusted",
    ],
    ["a RUNNER_REFUSAL text (R534 D3)", "Codeunit: out-of-scope: a refused statement"],
  ];
  for (const [what, message] of REFUSALS) {
    for (const bad of [0, 1, 2]) {
      test(`B1. ${what} in answer ${bad + 1} is walk-failed with the reason named, never a kill`, () => {
        const answers = [answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")];
        // the same test, refused: its status stays `fail` in answers 1 and 3 (and `pass` -> `fail` in 2)
        answers[bad] = (answers[bad] ?? []).map((r) =>
          r.method === "T1" ? { ...r, status: "fail", message } : r,
        );
        const r = judge(answers);
        expect(r.kind).toBe("failed");
        expect(failedReason(r)).toContain(`request ${bad + 1}: Codeunit1.T1 reads error`);
      });
    }
  }

  test("B1. the control: the same rows with a plain failure message ARE a kill", () => {
    expect(judge([answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")]).kind).toBe(
      "killed",
    );
  });

  test("B1. a timeout row in any answer is walk-failed, never a pass or a fail", () => {
    for (const bad of [0, 1, 2]) {
      const answers = [answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")];
      answers[bad] = (answers[bad] ?? []).map((r) =>
        r.method === "T1"
          ? { ...r, status: "error" as const, notRun: true, message: "Test exceeded 60s timeout." }
          : r,
      );
      const r = judge(answers);
      expect(r.kind, `answer ${bad + 1}`).toBe("failed");
      expect(failedReason(r)).toContain("reads timeout");
    }
  });

  // B1 leftover. Red: remove the `v.flagged === true || v.flaggedUnknown === true` check in judgeCarryWalk.
  // A flagged pass in answer 2 would otherwise be the no-mutant pass of a kill.
  for (const [what, flag, reason] of [
    ["flagged", { flagged: true as const }, "al-runner flagged it"],
    ["flag state unknown", { flaggedUnknown: true as const }, "its flag state is unknown"],
  ] as const) {
    for (const bad of [0, 1, 2]) {
      test(`B1. a pass whose ${what} is walk-failed (answer ${bad + 1})`, () => {
        const answers = [answer("M1", "fail"), answer(NONE, "pass"), answer("M1", "fail")];
        answers[bad] = (answers[bad] ?? []).map((r) => (r.method === "T2" ? { ...r, ...flag } : r));
        const r = judge(answers);
        expect(r.kind).toBe("failed");
        expect(failedReason(r)).toContain(`request ${bad + 1}: Codeunit2.T2 passed but ${reason}`);
      });
    }
  }
});

// ================================================================ part 2: the backend's walk

const SITE = { objectType: "codeunit", codeunitId: 50100 };
const ref = (codeunitId: number, method: string): TestMethodRef => ({
  codeunitId,
  codeunitName: `Tests${codeunitId}`,
  method,
});

type Rows = Record<string, unknown>[];
interface Lane0 {
  readonly index: number;
  readonly deployedDir: string;
  readonly resourcePath: () => string;
  readonly requestBase: () => Record<string, unknown>;
}

/** A shell backend: just the fields `carryWalkOn` reads, a counting fake daemon per lane. */
function shell(
  o: {
    whyOff?: string | undefined;
    singleInstance?: boolean;
    /** The raw rows of request number `n` (0-based, over ALL daemons), given the resource file's content. */
    answers?: (n: number, file: string) => Rows | Error;
    lanes?: number;
  } = {},
) {
  const lanesN = o.lanes ?? 1;
  const dir = process.env.TMPDIR ?? tmpdir();
  const calls: Array<{
    lane: number;
    body: Record<string, unknown>;
    file: string | undefined;
    deadline: number;
  }> = [];
  const events: string[] = [];
  const closes: Array<{ lane: number; reason: string }> = [];
  let n = 0;
  const lanes: Lane0[] = [];
  const daemons = new Map<Lane0, { requests: number; server: { runEntries: unknown } }>();
  for (let i = 0; i < lanesN; i++) {
    const resource = join(dir, `pr340-res-${Math.random().toString(36).slice(2)}`);
    const lane: Lane0 = {
      index: i,
      deployedDir: "/deployed",
      resourcePath: () => resource,
      requestBase: () => ({ command: "runTests", lane: i }),
    };
    lanes.push(lane);
    daemons.set(lane, {
      requests: 0,
      server: {
        runEntries: async (body: Record<string, unknown>, deadline: number) => {
          const file = await readFile(resource, "utf8").catch(() => undefined);
          calls.push({ lane: i, body, file, deadline });
          events.push(`send@lane${i}`);
          const out = (o.answers ?? defaultAnswers)(n++, file ?? "");
          if (out instanceof Error) throw out;
          return { tests: out, summary: {} };
        },
      },
    });
  }
  const b = Object.create(AlRunnerV3Backend.prototype) as Record<string, unknown>;
  b.entries = true;
  b.carryWalkWhyOff = o.whyOff;
  b.carryWalkStats = { walks: 0, ms: 0 };
  b.coverageIndex = {
    singleInstance: new Set(o.singleInstance === false ? [] : ["codeunit:50100"]),
  };
  b.proof = { manifestIds: new Set(["M0009"]), artifactId: "x" };
  b.echoId = ECHO;
  b.testsPerCodeunit = new Map([
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
  b.suitePerCodeunit = new Map();
  b.baselineRows = new Map([
    [1, [row(1, "T1", "pass")]],
    [2, [row(2, "T2", "pass")]],
    [3, [row(3, "T3", "pass")]],
  ]);
  b.serveRowFields = false;
  b.memoryStopped = false;
  b.stopHandle = undefined;
  b.modeOfCall = () => ({ testIsolation: "test", runSelectedOnly: false });
  b.serveStopSeconds = () => 60;
  b.ensureDaemon = async (lane: Lane0) => {
    events.push(`ensure@lane${lane.index}`);
    const d = daemons.get(lane);
    if (d === undefined) throw new Error("unknown lane");
    return d;
  };
  b.assertBound = async (lane: Lane0) => {
    events.push(`bound@lane${lane.index}`);
  };
  b.refuseDaemonDependencySkip = async () => undefined;
  b.closeLane = async (lane: Lane0, reason: string) => {
    closes.push({ lane: lane.index, reason });
  };
  return {
    b: b as unknown as AlRunnerV3Backend,
    raw: b,
    lanes,
    calls,
    events,
    closes,
    walk: (lane: Lane0, covering: readonly TestMethodRef[] = [ref(1, "T1"), ref(2, "T2")]) =>
      (
        b as unknown as {
          carryWalkOn: (
            l: Lane0,
            id: string,
            c: readonly TestMethodRef[],
            s: typeof SITE,
          ) => Promise<CarryWalkResult | undefined>;
        }
      ).carryWalkOn(lane, "M0009", covering, SITE),
  };
}

/** Request 0 and 2 run under the mutant (file says M0009), request 1 under NONE; T1 leaks under the mutant. */
function defaultAnswers(_n: number, file: string): Rows {
  const under = file !== "NONE";
  return [
    { name: "Codeunit9.Echo", status: "fail", message: `LETHAL-ECHO:${file}:true` },
    {
      name: "Codeunit1.T1",
      status: under ? "fail" : "pass",
      ...(under ? { message: "leak" } : {}),
    },
    { name: "Codeunit2.T2", status: "pass" },
  ];
}

describe("PR-340: carryWalkOn, on a shell backend", () => {
  const files: string[] = [];
  afterEach(async () => {
    for (const f of files.splice(0)) await rm(f, { force: true });
  });

  test("the walk sends THREE batch-shaped strictOrder requests: the mutant, NONE, the mutant; echo kept, the rest excluded", async () => {
    const s = shell();
    const lane = s.lanes[0] as Lane0;
    await writeFile(lane.resourcePath(), "NONE", "utf8");
    files.push(lane.resourcePath());
    const r = await s.walk(lane);
    expect(r).toMatchObject({ kind: "killed", method: "T1", failure: "leak", reproduced: "leak" });
    expect(s.calls.map((c) => c.file)).toEqual(["M0009", "NONE", "M0009"]);
    for (const c of s.calls) {
      expect(c.body.strictOrder).toBe(true);
      expect(Object.hasOwn(c.body, "entries")).toBe(false);
      expect(Object.hasOwn(c.body, "test")).toBe(false);
      expect(Object.hasOwn(c.body, "runSelectedOnly")).toBe(false);
      // codeunit 3 (not kept) is excluded; the echo (9) is NOT.
      expect(c.body.excludeTests).toEqual(["Codeunit3."]);
    }
    // the file is back to what it was
    expect(await readFile(lane.resourcePath(), "utf8")).toBe("NONE");
  });

  // 12. Red: remove the `finally` that writes `prior` back (or `rm`s the file) in carryWalkOn.
  test("12. the resource file is restored after a throw, and a missing file stays missing", async () => {
    const s = shell({ answers: () => new Error("a transport throw") });
    const lane = s.lanes[0] as Lane0;
    await writeFile(lane.resourcePath(), "NONE", "utf8");
    files.push(lane.resourcePath());
    await expect(s.walk(lane)).rejects.toThrow("a transport throw");
    expect(await readFile(lane.resourcePath(), "utf8")).toBe("NONE");
    // no prior file: the walk leaves none behind
    const t = shell({ answers: () => new Error("boom") });
    const l2 = t.lanes[0] as Lane0;
    await t.walk(l2).catch(() => undefined);
    expect(await readFile(l2.resourcePath(), "utf8").catch(() => "missing")).toBe("missing");
  });

  // 6 (request half). Red: the `AlRunnerServerRequestError` branch / the `closeLane(.., "request-failed")` before it.
  test("6. a request error and a timeout are each walk-failed with the reason named; the daemon is replaced; never a verdict", async () => {
    const { AlRunnerServerRequestError } = await import("../src/al-runner-server");
    const refused = shell({ answers: () => new AlRunnerServerRequestError("error", "refused it") });
    const r1 = await refused.walk(refused.lanes[0] as Lane0);
    expect(failedReason(r1ShouldFail(r1))).toContain("a request failed");
    expect(refused.closes).toEqual([{ lane: 0, reason: "request-failed" }]);
    const timeout = shell({
      answers: (n) =>
        n === 0
          ? defaultAnswers(0, "M0009")
          : new AlRunnerServerRequestError("deadline", "no summary line within 1 ms"),
    });
    const r2 = await timeout.walk(timeout.lanes[0] as Lane0);
    expect(failedReason(r2ShouldFail(r2))).toContain("a request timed out");
    expect(timeout.closes).toEqual([{ lane: 0, reason: "request-failed" }]);
    // the later request is never sent after the timeout
    expect(timeout.calls).toHaveLength(2);
    const zero = shell({ answers: () => [] });
    const r3 = await zero.walk(zero.lanes[0] as Lane0);
    expect(failedReason(r3ShouldFail(r3))).toContain("zero rows");
  });

  // 7. Red: remove the `carryWalkWhyOff !== undefined` return in carryWalkOn.
  test("7. a build that is not carry-proven gives no walk and the note 'build not carry-proven'; nothing is sent", async () => {
    const s = shell({ whyOff: "this session's probe read batch-sequential-carry diverged" });
    const r = await s.walk(s.lanes[0] as Lane0);
    expect(r).toEqual({
      kind: "failed",
      reason: "build not carry-proven (this session's probe read batch-sequential-carry diverged)",
    });
    expect(s.calls).toHaveLength(0);
    expect(s.events).toEqual([]);
  });

  // 9 (backend half). Red: remove the `singleInstanceCarryNote(...) === undefined` return.
  test("9. an unlabelled survivor and a 1-codeunit set send nothing: the call counter is 0", async () => {
    const plain = shell({ singleInstance: false });
    expect(await plain.walk(plain.lanes[0] as Lane0)).toBeUndefined();
    const one = shell();
    expect(await one.walk(one.lanes[0] as Lane0, [ref(1, "T1"), ref(1, "T1b")])).toBeUndefined();
    expect(plain.calls.length + one.calls.length).toBe(0);
    expect(plain.events.length + one.events.length).toBe(0);
  });

  // The guards: the bound check and the manifest check come BEFORE every resource write; a mutant that is not in the manifest throws.
  // Red: move `assertBound` after the `writeFile` of the resource file, or drop the manifest check.
  test("the bound check runs before each request's resource write; an id outside the manifest throws and sends nothing", async () => {
    const s = shell();
    const lane = s.lanes[0] as Lane0;
    await s.walk(lane);
    // bound is asked right before each send, and the file read by the send is the mutant's, so the check came first
    expect(s.events.filter((e) => e.startsWith("bound"))).toHaveLength(3);
    expect(s.events.slice(0, 3)).toEqual(["ensure@lane0", "bound@lane0", "send@lane0"]);
    const bad = shell();
    (bad.raw.proof as { manifestIds: Set<string> }).manifestIds = new Set(["M0001"]);
    await expect(bad.walk(bad.lanes[0] as Lane0)).rejects.toThrow(
      /not a mutant of the deployed batch/,
    );
    expect(bad.calls).toHaveLength(0);
  });

  test("a stop signal before a request ends the walk as walk-failed, and nothing more is sent", async () => {
    const s = shell();
    let n = 0;
    s.raw.stopHandle = { signalled: () => n++ >= 1, spent: () => false };
    const r = await s.walk(s.lanes[0] as Lane0);
    expect(failedReason(r2ShouldFail(r))).toContain("stop signal");
    expect(s.calls).toHaveLength(1);
  });

  // 10. Red: in laneView, `carryWalk: (...) => b.carryWalkOn(lane, ...)` replaced by lane 0 (or the sole lane).
  test("10. with 2 lanes the walk's sends go to the scoring lane's own daemon and resource file only", async () => {
    const s = shell({ lanes: 2 });
    const view = (lane: Lane0) =>
      (
        s.raw as unknown as {
          laneView: (l: Lane0) => {
            carryWalk: (
              id: string,
              c: readonly TestMethodRef[],
              site: typeof SITE,
            ) => Promise<CarryWalkResult | undefined>;
          };
        }
      ).laneView(lane);
    const l0 = s.lanes[0] as Lane0;
    const l1 = s.lanes[1] as Lane0;
    await writeFile(l0.resourcePath(), "NONE", "utf8");
    await writeFile(l1.resourcePath(), "NONE", "utf8");
    files.push(l0.resourcePath(), l1.resourcePath());
    const r = await view(l1).carryWalk("M0009", [ref(1, "T1"), ref(2, "T2")], SITE);
    expect(r?.kind).toBe("killed");
    expect(s.calls.map((c) => c.lane)).toEqual([1, 1, 1]);
    expect(s.events.filter((e) => e.endsWith("@lane0"))).toEqual([]);
    expect(s.calls.every((c) => (c.body as { lane: number }).lane === 1)).toBe(true);
    // lane 0's resource file was never touched, lane 1's is back to NONE
    expect(await readFile(l0.resourcePath(), "utf8")).toBe("NONE");
    expect(await readFile(l1.resourcePath(), "utf8")).toBe("NONE");
    // and the other way round
    const s2 = shell({ lanes: 2 });
    const v0 = (
      s2.raw as unknown as {
        laneView: (l: Lane0) => { carryWalk: (...a: unknown[]) => Promise<unknown> };
      }
    ).laneView(s2.lanes[0] as Lane0);
    await v0.carryWalk("M0009", [ref(1, "T1"), ref(2, "T2")], SITE);
    expect(s2.calls.map((c) => c.lane)).toEqual([0, 0, 0]);
  });

  // 10b. Red: add `carryWalk: (...) => lane0.carryWalk?.(...)` to splitBackend.
  test("the split view (baseline phase) has no carryWalk: it can never forward to lane 0", () => {
    const owner = {} as ExecutionBackend;
    const lane0 = { carryWalk: async () => ({ kind: "walked" }) } as unknown as ExecutionBackend;
    expect(splitBackend(owner, lane0).carryWalk).toBeUndefined();
  });
});

// Small helpers that narrow a possibly-undefined result for the assertions above.
function r1ShouldFail(r: CarryWalkResult | undefined): CarryWalkResult {
  if (r === undefined) throw new Error("expected a walk result");
  return r;
}
const r2ShouldFail = r1ShouldFail;
const r3ShouldFail = r1ShouldFail;

// ================================================================ part 2b: the environment (test 8)

describe("PR-340 test 8: AL_STRICT_SEQUENTIAL on every mutant-run daemon", () => {
  const ambient = process.env.AL_STRICT_SEQUENTIAL;
  afterEach(() => {
    if (ambient === undefined) Reflect.deleteProperty(process.env, "AL_STRICT_SEQUENTIAL");
    else process.env.AL_STRICT_SEQUENTIAL = ambient;
  });

  /** Spawns a daemon through the real `spawnDaemon`, capturing the env its spawn was handed. */
  async function envOf(mutantRun: boolean): Promise<Readonly<Record<string, string | undefined>>> {
    let seen: Readonly<Record<string, string | undefined>> | undefined;
    const b = Object.create(AlRunnerV3Backend.prototype) as Record<string, unknown>;
    b.cfg = {
      alRunnerPath: "/x/al-runner",
      cacheDir: "/cache",
      packagesDir: "/packages",
      bcVersion: "28.0.0.0",
      environmentChoice: { value: "saas", source: "config" },
    };
    b.serverSpawn = (_argv: string[], opts?: { env?: Record<string, string | undefined> }) => {
      seen = opts?.env;
      throw new Error("stop here: only the env was wanted");
    };
    const lane = { scratchCwd: () => "/tmp", index: 0 };
    await expect(
      (
        b as unknown as {
          spawnDaemon: (...a: unknown[]) => Promise<unknown>;
        }
      ).spawnDaemon(
        lane,
        { testIsolation: "test", runSelectedOnly: false },
        60,
        "first",
        mutantRun,
      ),
    ).rejects.toThrow();
    if (seen === undefined) throw new Error("no spawn was attempted");
    // S2: the env the child REALLY gets: the spawn options merged over the ambient environment.
    return mergeChildEnv(seen);
  }

  // Red (a): `cacheEnv(mutantRun)` ignoring its flag (never v3MutantDaemonEnv). Red (b): always v3MutantDaemonEnv
  // (then the baseline daemon's env, the second assertion, has the variable too).
  test("a mutant-run daemon's env carries AL_STRICT_SEQUENTIAL=1 whether the ambient value is 0, 1 or unset; a baseline daemon's does not", async () => {
    for (const ambientValue of ["0", "1", undefined]) {
      if (ambientValue === undefined) Reflect.deleteProperty(process.env, "AL_STRICT_SEQUENTIAL");
      else process.env.AL_STRICT_SEQUENTIAL = ambientValue;
      const mutant = await envOf(true);
      expect(mutant.AL_STRICT_SEQUENTIAL, `ambient ${ambientValue}`).toBe("1");
      // the helper alone, as leg C's carry fact's server does it by hand
      expect(v3MutantDaemonEnv().AL_STRICT_SEQUENTIAL).toBe("1");
      const baseline = await envOf(false);
      // Red (c), S2: `mergeChildEnv` not dropping the ambient variable: "0" or "1" would reach this daemon.
      expect(Object.hasOwn(baseline, "AL_STRICT_SEQUENTIAL"), `ambient ${ambientValue}`).toBe(
        false,
      );
    }
  });

  // Red: pass `false` (or nothing) in `spawnRestarted` or in `startDaemon`'s spawnDaemon call.
  test("the two callers that start a MUTANT daemon (startDaemon, spawnRestarted) pass mutantRun=true; the baseline and probe callers do not", async () => {
    const src = await readFile(join(import.meta.dir, "../src/al-runner-v3-backend.ts"), "utf8");
    const calls = [...src.matchAll(/this\.spawnDaemon\(([^;]*?)\);/gs)].map((m) => m[1] ?? "");
    const mutantCalls = calls.filter((c) => c.includes("lane.takeCause(modeKey(mode))"));
    expect(mutantCalls).toHaveLength(2);
    for (const c of mutantCalls) expect(c.trim().endsWith("true")).toBe(true);
    const others = calls.filter((c) => !c.includes("lane.takeCause(modeKey(mode))"));
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const c of others) expect(c.trim().endsWith("true")).toBe(false);
  });
});

// ================================================================ part 3: the orchestrator

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Alpha Tests"
{
    Subtype = Test;

    [Test]
    procedure A1() begin end;
}

codeunit 79101 "Zulu Tests"
{
    Subtype = Test;

    [Test]
    procedure Z1() begin end;
}
`;
const APP_JSON = JSON.stringify({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sandbox Orchestrator Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const caps = (kind: BackendCapabilities["kind"]): BackendCapabilities => ({
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind,
  authoritative: kind === "bcdev",
});
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = scratch("lethal-pr340-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, root };
}

/** What the fake walk answers for a mutant; `undefined` means "no walk" (an unlabelled survivor). */
type WalkScript = (mutantId: string) => CarryWalkResult | undefined;

class WalkStub implements ExecutionBackend {
  /** Every mutated run, in order: the ordering the kill ledger would change. */
  readonly runs: Array<{ mutant: string; method: string }> = [];
  /** The call counter of the walk: every mutant id the orchestrator asked the backend to walk. */
  readonly walks: string[] = [];
  private active: string | null = null;
  constructor(
    private readonly kind: BackendCapabilities["kind"],
    private readonly script: WalkScript,
    private readonly ordinary: (mutant: string, method: string) => "pass" | "fail" = () => "pass",
    private readonly onMutatedRun: (mutant: string, method: string) => void = () => {},
  ) {}
  readonly runnerBuild = async () => ({
    version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
    binarySha256: "b".repeat(64),
  });
  capabilities() {
    return caps(this.kind);
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy() {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.active = id;
  }
  survivorNote(): string | undefined {
    return V3_SINGLEINSTANCE_NOTE;
  }
  async carryWalk(mutantId: string): Promise<CarryWalkResult | undefined> {
    this.walks.push(mutantId);
    return this.script(mutantId);
  }
  async run(r: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.active;
    let outcome: "pass" | "fail" = "pass";
    if (active !== null) {
      this.runs.push({ mutant: active, method: r.method });
      outcome = this.ordinary(active, r.method);
      this.onMutatedRun(active, r.method);
    }
    const baseline = active === null;
    const attests = this.caps2().authoritative && opts.coverage === "none";
    return {
      ref: r,
      outcome,
      durationMs: 5,
      ...(baseline
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(attests ? { attestation: { observedAny: true, identityMismatch: false } } : {}),
      ...(attests ? { reachedActive: active !== null } : {}),
    };
  }
  private caps2() {
    return caps(this.kind);
  }
  runsOf(mutant: string): string[] {
    return this.runs.filter((r) => r.mutant === mutant).map((r) => r.method);
  }
}

async function withKnob<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = process.env[CARRY_WALK_ENV];
  if (value === undefined) Reflect.deleteProperty(process.env, CARRY_WALK_ENV);
  else process.env[CARRY_WALK_ENV] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, CARRY_WALK_ENV);
    else process.env[CARRY_WALK_ENV] = before;
  }
}

async function session(
  backend: ExecutionBackend,
  o: {
    knob?: string | undefined;
    extra?: Partial<Parameters<typeof runSession>[0]>;
    store?: ResultsStore;
    project?: Awaited<ReturnType<typeof makeProject>>;
    tag?: string;
  } = {},
) {
  const project = o.project ?? (await makeProject());
  const store = o.store ?? new ResultsStore(":memory:");
  const report = await withKnob(o.knob, () =>
    runSession({
      backend,
      store,
      projectDir: project.projectDir,
      testDir: project.testDir,
      instrumentedDir: join(project.root, `instr${o.tag ?? ""}`),
      selectorIds,
      ...o.extra,
    }),
  );
  const row = (code: string) => report.mutants.find((m) => m.mutantCode === code);
  return { report, row, store };
}

const killedBy = (method: string): CarryWalkResult => ({
  kind: "killed",
  codeunitId: method === "A1" ? 79100 : 79101,
  method,
  failure: `first ${method}`,
  reproduced: `again ${method}`,
});
const LABEL = "[singleinstance-carry-unobservable]";

describe("PR-340: the orchestrator's trigger and scoring", () => {
  // 1 (orchestrator half). Red: in the orchestrator's `carry?.kind === "killed"` block, drop `verdict = "killed"`.
  test("1. a walk kill scores killed by T with the note, the failure texts and no label", async () => {
    const backend = new WalkStub("al-runner-v3", (m) =>
      m === "M0002" ? killedBy("Z1") : undefined,
    );
    const { row, store } = await session(backend);
    const m2 = row("M0002");
    expect(m2?.verdict).toBe("killed");
    expect(m2?.killingTest).toBe("Z1");
    expect(m2?.failureNote).toContain("[singleinstance-carry-killed]");
    expect(m2?.failureNote).not.toContain(LABEL);
    expect(m2?.killingTestFailure).toBe("first Z1");
    // a survivor nobody walked keeps today's label
    expect(row("M0001")?.verdict).toBe("survived");
    expect(row("M0001")?.failureNote).toContain(LABEL);
    expect(backend.walks.length).toBeGreaterThan(1);
    store.close();
  });

  // 2/3 (orchestrator half). Red: remove the `carry?.kind === "walked"` replacement of the label.
  test("a walked survivor stays survived: the label is replaced by the walked note", async () => {
    const backend = new WalkStub("al-runner-v3", () => ({ kind: "walked" }));
    const { row, store } = await session(backend);
    const m = row("M0001");
    expect(m?.verdict).toBe("survived");
    expect(m?.failureNote).toContain("[singleinstance-carry-walked]");
    expect(m?.failureNote).not.toContain(LABEL);
    store.close();
  });

  // 6 (orchestrator half). Red: remove the `carry?.kind === "failed"` note.
  test("6. a failed walk keeps the label, adds the named reason, and never moves the verdict", async () => {
    const backend = new WalkStub("al-runner-v3", () => ({
      kind: "failed",
      reason: "build not carry-proven (this session's probe read batch-sequential-carry diverged)",
    }));
    const { row, store } = await session(backend);
    const m = row("M0001");
    expect(m?.verdict).toBe("survived");
    expect(m?.failureNote).toContain(LABEL);
    expect(m?.failureNote).toContain("[singleinstance-carry-walk-failed: build not carry-proven");
    store.close();
  });

  // 9. Red: remove, one by one, the matching condition of the orchestrator's walk guard (kind, isUnsafe,
  // exhausted/signalled, args.carryWalk, verdict === "survived").
  test("9. no walk on bcdev: the call counter is 0", async () => {
    const backend = new WalkStub("bcdev", () => ({ kind: "walked" }));
    const { row, store } = await session(backend);
    expect(backend.walks).toEqual([]);
    // today's label stays, and none of the walk's notes appears
    for (const tag of ["carry-killed", "carry-walked", "carry-walk-failed"])
      expect(row("M0001")?.failureNote ?? "").not.toContain(tag);
    store.close();
  });

  test("9. no walk with LETHAL_V3_CARRY_WALK=off: the call counter is 0, and the label stays", async () => {
    const backend = new WalkStub("al-runner-v3", () => killedBy("A1"));
    const { row, store } = await session(backend, { knob: "off" });
    expect(backend.walks).toEqual([]);
    expect(row("M0001")?.verdict).toBe("survived");
    expect(row("M0001")?.failureNote).toContain(LABEL);
    store.close();
  });

  test("9. no walk for a mutant a test killed: only survivors are walked", async () => {
    const backend = new WalkStub(
      "al-runner-v3",
      () => ({ kind: "walked" }),
      (m, method) => (m === "M0002" && method === "A1" ? "fail" : "pass"),
    );
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("killed");
    expect(backend.walks).not.toContain("M0002");
    expect(backend.walks).toContain("M0001");
    store.close();
  });

  test("9. no walk for a session latched unsafe after the survivor's last test", async () => {
    const real = Object.getOwnPropertyDescriptor(SessionSafety.prototype, "isUnsafe");
    let latched = false;
    Object.defineProperty(SessionSafety.prototype, "isUnsafe", {
      configurable: true,
      get() {
        return latched || (real?.get?.call(this) as boolean);
      },
    });
    try {
      const backend = new WalkStub(
        "al-runner-v3",
        () => ({ kind: "walked" }),
        () => "pass",
        (m, method) => {
          if (m === "M0002" && method === "Z1") latched = true;
        },
      );
      const { row, store } = await session(backend);
      expect(row("M0002")?.verdict).toBe("survived");
      expect(backend.walks).not.toContain("M0002");
      store.close();
    } finally {
      if (real !== undefined) Object.defineProperty(SessionSafety.prototype, "isUnsafe", real);
    }
  });

  test("9. no walk once the time budget is spent after the survivor's last test (and a walk with budget to spare)", async () => {
    // Control: a clock that never runs out walks M0002.
    const control = new WalkStub("al-runner-v3", () => ({ kind: "walked" }));
    const c = await session(control, { extra: { timeBudgetSeconds: 100, clockMs: () => 0 } });
    expect(control.walks).toContain("M0002");
    c.store.close();
    let armed = 0;
    let spent = false;
    const backend = new WalkStub(
      "al-runner-v3",
      () => ({ kind: "walked" }),
      () => "pass",
      (m, method) => {
        if (m === "M0002" && method === "Z1") armed = 1;
      },
    );
    const clockMs = () => {
      if (armed > 0 && ++armed > 2) spent = true;
      return spent ? 1_000_000 : 0;
    };
    const { row, store } = await session(backend, { extra: { timeBudgetSeconds: 100, clockMs } });
    expect(row("M0002")?.verdict).toBe("survived");
    expect(backend.walks).not.toContain("M0002");
    store.close();
  });

  // 11. Red: add `recordKill(args.killLedger, m, ref)` to the carry-killed block. The ledger would then put Z1
  // first for M0003, so its covering tests would run Z1, A1 instead of A1, Z1.
  test("11. a carry kill never enters the kill ledger: the next mutant's order is the no-ledger order", async () => {
    const backend = new WalkStub("al-runner-v3", (m) =>
      m === "M0002" ? killedBy("Z1") : undefined,
    );
    const { row, store } = await session(backend);
    expect(row("M0002")?.verdict).toBe("killed");
    expect(backend.runsOf("M0002")).toEqual(["A1", "Z1"]);
    expect(backend.runsOf("M0003")).toEqual(["A1", "Z1"]);
    store.close();
  });
});

// ================================================================ part 4: the knob and the fingerprint

describe("PR-340 test 13: LETHAL_V3_CARRY_WALK", () => {
  // Red: make readCarryWalk accept any value.
  test("unset, empty and on are on; off is off; anything else is refused by name, before any run", async () => {
    expect(readCarryWalk({})).toBe(true);
    expect(readCarryWalk({ [CARRY_WALK_ENV]: "" })).toBe(true);
    expect(readCarryWalk({ [CARRY_WALK_ENV]: "on" })).toBe(true);
    expect(readCarryWalk({ [CARRY_WALK_ENV]: "off" })).toBe(false);
    expect(() => readCarryWalk({ [CARRY_WALK_ENV]: "OFF" })).toThrow(CarryWalkError);
    expect(() => readCarryWalk({ [CARRY_WALK_ENV]: "0" })).toThrow(/carry-walk-value-refused/);
    const backend = new WalkStub("al-runner-v3", () => undefined);
    await expect(session(backend, { knob: "maybe" })).rejects.toThrow(/carry-walk-value-refused/);
    expect(backend.walks).toEqual([]);
  });

  // Red: drop `v3CarryWalkOff` from the fingerprint (resume.ts / fingerprintWith), or the carryFlag checks in resolveResume.
  test("a --resume across on and off is refused by name, both ways, by id and as last; the same value resumes", async () => {
    for (const [first, second] of [
      [undefined, "off"],
      ["off", undefined],
    ] as const) {
      const store = new ResultsStore(":memory:");
      const project = await makeProject();
      await session(new WalkStub("al-runner-v3", () => ({ kind: "walked" })), {
        knob: first,
        store,
        project,
        tag: "-1",
      });
      store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
      const byId = new WalkStub("al-runner-v3", () => ({ kind: "walked" }));
      await expect(
        session(byId, { knob: second, store, project, tag: "-2", extra: { resume: 1 } }),
      ).rejects.toThrow(
        // L1. Red: put back "on" alone: a run recorded before the knob existed has the digest of "on".
        second === "off"
          ? /recorded with LETHAL_V3_CARRY_WALK on, or before the knob existed/
          : /carry-walk-resume-refused/,
      );
      expect(byId.walks).toEqual([]);
      await expect(
        session(new WalkStub("al-runner-v3", () => ({ kind: "walked" })), {
          knob: second,
          store,
          project,
          tag: "-3",
          extra: { resume: "last" },
        }),
      ).rejects.toThrow(/carry-walk-resume-refused/);
      const resumed = await session(new WalkStub("al-runner-v3", () => ({ kind: "walked" })), {
        knob: first,
        store,
        project,
        tag: "-4",
        extra: { resume: 1 },
      });
      expect(resumed.report.resumedFrom?.runId).toBe(1);
    }
  }, 120_000);
});

describe("PR-340 review fixes", () => {
  // S3. Red: drop `this.carryWalkStats.walks += 1` (or the ms line) in carryWalkOn.
  test("S3. the walk count and wall time are reported once, and only when a walk ran", async () => {
    const none = shell({ whyOff: "not proven" });
    await none.walk(none.lanes[0] as Lane0);
    expect((none.b as unknown as { carryWalkLine(): string | undefined }).carryWalkLine()).toBe(
      undefined,
    );
    const s = shell();
    const lane = s.lanes[0] as Lane0;
    await writeFile(lane.resourcePath(), "NONE", "utf8");
    await s.walk(lane);
    await s.walk(lane);
    const line = (s.b as unknown as { carryWalkLine(): string | undefined }).carryWalkLine();
    expect(line).toContain("2 walk(s)");
    expect(line).toMatch(/\d+ ms in all/);
    await rm(lane.resourcePath(), { force: true });
  });

  // S1. Red: make judgeCarryOrder accept an order whose only serve request predates the last walk.
  test("S1. the carry gate's order check: an ordinary request must follow the last walk", async () => {
    const { judgeCarryOrder } = await import("../itest/alrunner-v3-legs");
    // every prefetch before every walk: the pin would be empty
    expect(judgeCarryOrder(["req:warmup", "req:prefetch", "walk", "walk", "walk"])).toContain(
      "would be empty",
    );
    expect(judgeCarryOrder(["req:prefetch", "req:live"])).toContain("no walk ran");
    expect(judgeCarryOrder(["req:prefetch", "walk", "walk", "req:live"])).toBeUndefined();
    expect(judgeCarryOrder(["walk", "req:prefetch"])).toBeUndefined();
  });

  // S1 (b). Red: drop the `.includes("close")` check in judgeCarryOrder.
  test("S1 (b). a daemon close between the last walk and the next request fails the order check", async () => {
    const { judgeCarryOrder } = await import("../itest/alrunner-v3-legs");
    const closed = judgeCarryOrder(["walk", "close", "req:warmup", "req:live"]);
    expect(closed).toContain("closed between the last walk and the next ordinary request");
    // a close AFTER the ordinary request, or before the last walk, does not matter
    expect(judgeCarryOrder(["walk", "req:live", "close"])).toBeUndefined();
    expect(judgeCarryOrder(["close", "walk", "req:live"])).toBeUndefined();
  });

  // S1 (a). Red: call `this.carryWalkSink?.()` at the top of carryWalkOn (or carryWalkSend) instead of at the
  // first send, so an empty call counts as a walk.
  test("S1 (a). only a walk that really sends leaves a mark: an unlabelled survivor and a build not carry-proven leave none", async () => {
    const mark = async (o: Parameters<typeof shell>[0]) => {
      const s = shell(o);
      const marks: string[] = [];
      s.raw.carryWalkSink = () => marks.push(`walk@${s.events.length}`);
      const lane = s.lanes[0] as Lane0;
      await writeFile(lane.resourcePath(), "NONE", "utf8");
      await s.walk(lane);
      await rm(lane.resourcePath(), { force: true });
      return { marks, s };
    };
    expect((await mark({ singleInstance: false })).marks).toEqual([]);
    expect((await mark({ whyOff: "not proven" })).marks).toEqual([]);
    const real = await mark({});
    expect(real.marks).toHaveLength(1);
    // the mark comes after the guards (ensure and bound ran) and before the first send's request is answered
    expect(real.s.events.slice(0, 2)).toEqual(["ensure@lane0", "bound@lane0"]);
    expect(real.marks[0]).toBe("walk@2");
  });

  // S2 directly. Red: remove the `delete out[V3_STRICT_SEQUENTIAL_ENV]` line in mergeChildEnv.
  test("S2. mergeChildEnv drops an ambient AL_STRICT_SEQUENTIAL unless the extras set it", () => {
    const before = process.env.AL_STRICT_SEQUENTIAL;
    try {
      for (const ambient of ["0", "1"]) {
        process.env.AL_STRICT_SEQUENTIAL = ambient;
        expect(Object.hasOwn(mergeChildEnv({}), "AL_STRICT_SEQUENTIAL")).toBe(false);
        expect(mergeChildEnv({ AL_STRICT_SEQUENTIAL: "1" }).AL_STRICT_SEQUENTIAL).toBe("1");
      }
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "AL_STRICT_SEQUENTIAL");
      else process.env.AL_STRICT_SEQUENTIAL = before;
    }
  });
});
