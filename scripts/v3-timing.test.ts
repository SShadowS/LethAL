import { describe, expect, test } from "bun:test";
import {
  type RunTiming,
  buildTimingMarkdown,
  parseProbe,
  parseServeStats,
  percentile,
  summarizeEvents,
  summarizeProcs,
} from "./v3-timing.ts";

// The line `AlRunnerV3Backend.close()` prints, with D1-like figures.
const SERVE =
  "[lethal] al-runner-v3 serve-entries (R635): daemons 1, cached:false 1, requests warm-up 1 / prefetch 2 / live 51 / coverage 3 / echo 4, entries sent 812, echo mismatches 0, kill pairs 40 (fallbacks M cut 0, confirm passed 0 / NONE cut 0, confirm passed 0); wall ms warm-up 9100 / prefetch 300 / live 61000 / windows 7000 (coverage 5000, echo 2000) / bound 1700 over 57 checks.";

const LOAD = { availGb: 31.6, load1: 2.04, load5: 1.5, otherHeavy: 1 };

const run = (o: Partial<RunTiming> = {}): RunTiming => ({
  subject: "d1",
  rep: 1,
  exit: 0,
  wallMs: 95_400,
  probe: { kind: "cache", note: "probe from cache (key abc)" },
  transport: "serve-entries",
  phases: { generate: 400, deploy: 12_300, baseline: 3_100, mutants: 80_000, session: 95_000 },
  alc: { n: 4, batchMs: 1_450, testAppMs: 2_100, probeMs: 2_350, otherMs: 0 },
  perMutant: { n: 63, medianMs: 1200, p90Ms: 2100 },
  loadStart: LOAD,
  loadEnd: { ...LOAD, otherHeavy: 0, load1: 3 },
  ...o,
});

describe("R774 v3-timing", () => {
  test("parseServeStats reads every figure of the close line; one-shot has none", () => {
    expect(parseServeStats(`x\n${SERVE}\ny`)).toEqual({
      daemons: 1,
      warmups: 1,
      liveRequests: 51,
      coverageRequests: 3,
      echoRequests: 4,
      entriesSent: 812,
      pairRequests: 40,
      warmupMs: 9100,
      prefetchMs: 300,
      liveMs: 61000,
      windowMs: 7000,
      coverageMs: 5000,
      echoMs: 2000,
      boundMs: 1700,
      boundChecks: 57,
    });
    expect(parseServeStats("phase: mutants done in 1.1s")).toBeUndefined();
  });

  test("parseServeStats reads the R798 speculative counters when the line has them", () => {
    const line = SERVE.replace(
      " checks.",
      " checks; speculative baseline calls (R798) kept 2 / dropped 1; test-app compile cache (R780) hits 0 / misses 1.",
    );
    expect(parseServeStats(line)).toMatchObject({ speculativeKept: 2, speculativeDropped: 1 });
  });

  test("parseProbe: cache, fresh, and no line", () => {
    expect(
      parseProbe("[lethal] al-runner-v3 contract probe from cache (key 0a1b) (R762)").kind,
    ).toBe("cache");
    expect(
      parseProbe("[lethal] al-runner-v3 contract probe ran fresh (key 0a1b; no entry) (R762)"),
    ).toEqual({ kind: "fresh", note: "probe ran fresh (key 0a1b; no entry)" });
    expect(parseProbe("").kind).toBe("unknown");
    // The backend appends why a fresh probe was not cached; that note does not end in ")".
    expect(
      parseProbe(
        "[lethal] al-runner-v3 contract probe ran fresh (key 0a1b; no entry); not cached: a normal session refuses it (R762)",
      ).kind,
    ).toBe("fresh");
  });

  test("percentile is nearest-rank on a sorted copy", () => {
    const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile([], 90)).toBe(0);
    expect(xs[0]).toBe(10);
  });

  test("summarizeEvents sums phases, skips no-coverage mutants, finds the fallback", () => {
    const ev = [
      { type: "phase-left", phase: "deploy", elapsedMs: 100 },
      { type: "phase-left", phase: "mutants", elapsedMs: 50 },
      { type: "phase-left", phase: "mutants", elapsedMs: 25 },
      { type: "mutant-scored", verdict: "killed", durationMs: 7 },
      { type: "mutant-scored", verdict: "no-coverage", durationMs: 0 },
      { type: "mutant-scored", verdict: "error", durationMs: 1 },
      { type: "mutant-scored", verdict: "timeout-killed", durationMs: 9 },
      { type: "warning", code: "al-runner-v3-serve-default-fallback", message: "resume" },
      { type: "session-finished", elapsedMs: 200 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(summarizeEvents(ev)).toEqual({
      phases: { deploy: 100, mutants: 75, session: 200 },
      durations: [7, 9],
      fallback: "resume",
    });
  });

  test("summarizeProcs splits alc by what it compiled, spans the probe, counts serve daemons", () => {
    const alc = (project: string, out: string) =>
      `/opt/dotnet/dotnet /x/bin/alc.dll /project:${project} /packagecachepath:/p /out:${out}`;
    expect(
      summarizeProcs([
        // the probe: two al-runner calls and an alc compile, 10 .. 150
        {
          comm: "al-runner",
          argv: "al-runner test /tmp/lethal-r586-contract-x/app",
          first: 10,
          last: 20,
        },
        {
          comm: "dotnet",
          argv: alc(
            "/tmp/lethal-r586-contract-x/broken/app",
            "/tmp/lethal-r586-contract-x/alc-out/broken.1.partial.app",
          ),
          first: 30,
          last: 130,
        },
        {
          comm: "al-runner",
          argv: "al-runner test /tmp/lethal-r586-contract-x/b",
          first: 140,
          last: 150,
        },
        {
          comm: "dotnet",
          argv: alc("/s/active", "/s/alc-out/v3-batch.2.partial.app"),
          first: 200,
          last: 500,
        },
        {
          comm: "dotnet",
          argv: alc("tests", "/s/alc-out/v3-testapp.3.partial.app"),
          first: 500,
          last: 900,
        },
        { comm: "alc", argv: "alc /project:z", first: 900, last: 950 },
        {
          comm: "al-runner",
          argv: "/bin/al-runner serve --package-cache /p",
          first: 950,
          last: 990,
        },
        { comm: "dotnet", argv: "/opt/dotnet/dotnet something-else.dll", first: 0, last: 999 },
      ]),
    ).toEqual({
      alc: { n: 4, batchMs: 300, testAppMs: 400, probeMs: 100, otherMs: 50 },
      probeProcMs: 140,
      serveDaemons: 1,
    });
    expect(summarizeProcs([])).toEqual({
      alc: { n: 0, batchMs: 0, testAppMs: 0, probeMs: 0, otherMs: 0 },
      serveDaemons: 0,
    });
  });

  test("buildTimingMarkdown: one row per run, the split, and the load beside it", () => {
    const serve = parseServeStats(SERVE);
    const md = buildTimingMarkdown(
      {
        gitSha: "abc1234",
        date: "2026-10-25T15:00:00Z",
        build: "al-runner 3.0.0-alpha.5 (x)",
        notes: ["n1"],
      },
      [
        run({ ...(serve !== undefined ? { serve } : {}) }),
        run({
          subject: "gc",
          rep: 2,
          exit: 1,
          probe: { kind: "fresh", note: "probe ran fresh" },
          probeProcMs: 4_250,
          transport: "one-shot (fallback: resume)",
          alc: { n: 4, batchMs: 1_450, testAppMs: 2_100, probeMs: 2_350, otherMs: 500 },
        }),
      ],
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("# al-runner-v3 timing at abc1234 (2026-10-25T15:00:00Z)");
    expect(lines).toContain("Build: al-runner 3.0.0-alpha.5 (x)");
    expect(lines).toContain("- n1");
    const rows = lines.filter((l) => l.startsWith("| d1") || l.startsWith("| gc"));
    expect(rows).toEqual([
      // loop other = 80.0 - (9.1 + 0.3 + 61.0 + 7.0 + 1.7) = 0.9
      "| d1 #1 | 0 | 95.4 | cache | 0.4 | 12.3 | 1.4 / 2.1 / 2.4 (4) | 3.1 | 80.0 | 9.1 | 61.0 (51) | 7.0 (5.0 / 2.0) | 1.7 (57) | 40 | - | 0.9 | 1200 / 2100 (63) | serve-entries | load 2.0/1.5, 32 GB free, 1 other heavy | load 3.0/1.5, 32 GB free, 0 other heavy |",
      "| gc #2 | 1 | 95.4 | fresh 4.3 s | 0.4 | 12.3 | 1.4 / 2.1 / 2.4 (4) + other 0.5 | 3.1 | 80.0 | - | - | - | - | - | - | - | 1200 / 2100 (63) | one-shot (fallback: resume) | load 2.0/1.5, 32 GB free, 1 other heavy | load 3.0/1.5, 32 GB free, 0 other heavy |",
    ]);
    const header = lines.find((l) => l.startsWith("| run"));
    expect(header?.split("|").length).toBe(rows[0]?.split("|").length);
  });
});
