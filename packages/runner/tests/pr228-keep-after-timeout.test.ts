// PR-228 (docs/superpowers/specs/2026-11-19-pr228-keep-daemon-after-timeout-cut.md): `alRunnerV3.keepAfterTimeout`.
// Off (default): a `--test-timeout` cut kills the daemon and the rest is re-sent on a fresh one (R895). On: the
// daemon is kept, armed like a kept refusal, so the next request on it runs PR-56's drift check. The lane rig
// (a scripted serve daemon); call counters only.
import { afterEach, describe, expect, test } from "bun:test";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import type { V3RequestTimed } from "../src/backend";
import { v3SectionPassThrough } from "../src/cli";
import { createTimingFold } from "../src/timing-summary";
import {
  CU,
  type FakeRow,
  type LanesRig,
  OPTS,
  type Req,
  type RowsFn,
  TIMEOUT_1S,
  cleanRigs,
  lanesRig,
  ref,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const METHODS = ["A", "B", "C"];
const MUTANTS = ["M0001", "M0002", "M0003"];
const CUT_TEST = `Codeunit${CU}.A`;
const pass = (method: string): FakeRow => ({ method, status: "pass" });
const fail = (method: string): FakeRow => ({ method, status: "fail", message: "boom" });

/** M0001 times out at A (the cut); `drift(m, daemon)` makes A and C fail for `m` on that daemon. */
const rowsWith =
  (drift: (m: string, d: number) => boolean = () => false): RowsFn =>
  (m, _cu, d) =>
    m === "M0001"
      ? [{ method: "A", status: "error", notRun: true, message: TIMEOUT_1S }, pass("B"), pass("C")]
      : drift(m, d)
        ? [fail("A"), pass("B"), fail("C")]
        : METHODS.map(pass);

async function cutRig(o: {
  keep?: boolean;
  drift?: (m: string, d: number) => boolean;
  deadAfterTimeout?: (n: number, req: Req) => boolean;
}): Promise<{ r: LanesRig; timed: V3RequestTimed[] }> {
  const r = await lanesRig({
    lanes: 0,
    methods: METHODS,
    rows: rowsWith(o.drift),
    mutants: MUTANTS,
    ...(o.deadAfterTimeout !== undefined
      ? { serve: { deadAfterTimeout: o.deadAfterTimeout } }
      : {}),
    ...(o.keep !== undefined ? { extra: { keepAfterTimeout: o.keep } } : {}),
  });
  const timed: V3RequestTimed[] = [];
  r.b.setRequestTimedSink((e) => timed.push(e));
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
  } finally {
    r.b.baselinePhase(false);
  }
  // One prefetch request holds the three groups; M0001's entry is cut at A.
  const plans = [
    { mutantId: "M0001", refs: [ref("A")] },
    { mutantId: "M0002", refs: [ref("C")] },
    { mutantId: "M0003", refs: [ref("C")] },
  ];
  await r.b.prefetchMutants(plans, { batchPlans: plans });
  return { r, timed };
}

/** The requests after the baseline that carry a mutant. */
const mutantReqs = (r: LanesRig) => r.serve.requests.filter((q) => q.mutants.length > 0);
/** The requests that carry M0002 after the cut one (which carried all three). */
const m2After = (r: LanesRig) =>
  mutantReqs(r).filter((q) => q.mutants.includes("M0002") && !q.mutants.includes("M0001"));
const closes = (r: LanesRig) => r.b.daemonCloses().byReason;
const notices = (r: LanesRig, code: string) => r.notices.filter((n) => n.startsWith(`${code}:`));

describe("PR-228: keep the serve daemon after a timeout cut", () => {
  test("1 off (default): a cut kills and closes the daemon; the rest is re-sent on a fresh one after an after-timeout warm-up", async () => {
    const { r, timed } = await cutRig({});
    const s = r.b.entriesStats();
    expect(s.timeoutCuts).toBe(1);
    expect(s.timeoutCutsKept).toBe(0);
    expect(closes(r).get("timeout")).toBe(1);
    const cutReq = mutantReqs(r).find((q) => q.mutants.includes("M0001"));
    const cutDaemon = cutReq?.daemon;
    expect(cutDaemon).toBeDefined();
    expect(r.serve.kills).toContain(cutDaemon as number);
    const resent = m2After(r)[0];
    expect(resent?.mutants).toEqual(["M0002", "M0003"]);
    expect(resent?.daemon).not.toBe(cutDaemon);
    expect(timed.some((e) => e.kind === "warmup" && e.cause === "after-timeout")).toBe(true);
    expect(notices(r, "al-runner-v3-timeout-cut-kept")).toEqual([]);
    expect(s.armedRequests).toBe(0);
  });

  test("2 on: a cut keeps the daemon; the re-send runs on it, armed for the drift check, and nothing drifts", async () => {
    const { r, timed } = await cutRig({ keep: true });
    const s = r.b.entriesStats();
    expect(s.timeoutCuts).toBe(1);
    expect(s.timeoutCutsKept).toBe(1);
    expect(closes(r).get("timeout")).toBeUndefined();
    expect(r.serve.kills).toEqual([]);
    const cutReq = mutantReqs(r).find((q) => q.mutants.includes("M0001"));
    const resent = m2After(r)[0];
    expect(resent?.mutants).toEqual(["M0002", "M0003"]);
    expect(resent?.daemon).toBe(cutReq?.daemon as number);
    expect(r.serve.daemons).toHaveLength(1);
    // the request after the kept cut was checked (PR-56's armed counter) and did not drift
    expect(s.armedRequests).toBe(1);
    expect(s.keptDrifts).toBe(0);
    expect(timed.some((e) => e.kind === "warmup" && e.cause === "after-timeout")).toBe(false);
    const kept = notices(r, "al-runner-v3-timeout-cut-kept");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain(CUT_TEST);
    await r.b.activate("M0002");
    expect((await r.b.run(ref("C"), OPTS)).outcome).toBe("pass");
  });

  test("3 on: a planted drift after a kept cut closes the daemon and re-runs the request on a fresh one; the fresh rows stand", async () => {
    // M0002 drifts (A fails, before its covering test C) on daemon 0 only, the kept one
    const { r } = await cutRig({ keep: true, drift: (m, d) => m === "M0002" && d === 0 });
    const s = r.b.entriesStats();
    expect(s.timeoutCutsKept).toBe(1);
    expect(s.keptDrifts).toBe(1);
    expect(closes(r).get("kept-refusal-drift")).toBe(1);
    expect(closes(r).get("timeout")).toBeUndefined();
    const drift = notices(r, "al-runner-v3-serve-drift-after-kept-refusal");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain(`"timeout cut" (${CUT_TEST})`);
    expect(m2After(r).map((q) => q.daemon)).toEqual([0, 1]);
    await r.b.activate("M0002");
    // C failed on the kept daemon too: the drifted rows would be a kill, the fresh daemon's are a pass
    expect((await r.b.run(ref("C"), OPTS)).outcome).toBe("pass");
  });

  test("4 on: a daemon that does not answer after the cut is still closed", async () => {
    const { r } = await cutRig({
      keep: true,
      deadAfterTimeout: (_n, req) => req.mutants.includes("M0001"),
    });
    const s = r.b.entriesStats();
    expect(s.timeoutCutsKept).toBe(1);
    expect(closes(r).get("request-failed")).toBe(1);
    // the kept daemon held no request beyond the cut one; nothing ran on it after the cut
    const cutReq = mutantReqs(r).find((q) => q.mutants.includes("M0001"));
    expect(r.serve.requests.filter((q) => q.daemon === cutReq?.daemon).at(-1)).toBe(cutReq);
    expect(s.keptDrifts).toBe(0);
  });

  test("5 config: the option parses, defaults false, is boolean only, and the CLI passes it on only when on", () => {
    const base = { packagesDir: "/p", bcVersion: "28.0.1.2", path: "/x" };
    const v = (extra: object) => validateAlRunnerV3Config({ ...base, ...extra }, () => true);
    expect(v({}).keepAfterTimeout).toBe(false);
    expect(v({ keepAfterTimeout: true }).keepAfterTimeout).toBe(true);
    expect(v({ keepAfterTimeout: false }).keepAfterTimeout).toBe(false);
    expect(() => v({ keepAfterTimeout: "yes" })).toThrow("keepAfterTimeout");
    expect(v3SectionPassThrough(v({ keepAfterTimeout: true })).keepAfterTimeout).toBe(true);
    expect("keepAfterTimeout" in v3SectionPassThrough(v({}))).toBe(false);
  });

  test("6 TIMING: the timeouts line counts the kept cuts, and is unchanged without any", () => {
    const fold = (kept: number) => {
      const f = createTimingFold({ now: () => 0 });
      f.add({
        type: "serve-request-timed",
        seq: 1,
        kind: "prefetch",
        lane: 0,
        wallMs: 1,
        entries: 1,
        tests: 1,
        cut: true,
      });
      for (let i = 0; i < kept; i++)
        f.add({ type: "warning", seq: 2 + i, code: "al-runner-v3-timeout-cut-kept", message: "x" });
      return f.render();
    };
    expect(fold(1)).toContain("1 answer cut at a timeout row (timeout cuts kept 1, PR-228)");
    expect(fold(0)).toContain("1 answer cut at a timeout row");
    expect(fold(0)).not.toContain("kept");
  });
});
