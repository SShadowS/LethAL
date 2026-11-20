// PR-250 part 1 (docs/superpowers/specs/2026-11-20-pr250-baseline-refused-cut.md): a test whose BASELINE row
// is a refusal the daemon does not keep cuts every mutant entry of its codeunit just before it. The lane rig
// (a scripted serve daemon that leaves out an entry's `excludeTests` rows, as v3 does); call counters only.
import { afterEach, describe, expect, test } from "bun:test";
import type { TestVerdict } from "../src/backend";
import {
  CU,
  type FakeRow,
  type LanesRig,
  OPTS,
  type RowsFn,
  TIMEOUT_1S,
  cleanRigs,
  lanesRig,
  ref,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const METHODS = ["A", "B", "C", "D"];
const [A, B, C, D] = METHODS.map(ref) as [
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
];
const UNLISTED = "NotRun: out-of-scope: the install baseline read resource active-mutant.txt";
const KEPT = "NotRun: out-of-scope: conversion of Blob to Integer";
const MUTANTS = ["M0001", "M0002"];

type BRow = "unkept" | "kept" | "fail" | "pass" | "timeout";
const bRow = (kind: BRow): FakeRow =>
  kind === "unkept"
    ? { method: "B", status: "error", notRun: true, message: UNLISTED }
    : kind === "kept"
      ? { method: "B", status: "error", notRun: true, message: KEPT }
      : kind === "fail"
        ? { method: "B", status: "fail", message: "boom" }
        : kind === "timeout"
          ? { method: "B", status: "error", message: TIMEOUT_1S }
          : { method: "B", status: "pass" };

/** B answers `kind` in the baseline and under every mutant; M0002 makes A fail. */
const rowsWith =
  (kind: BRow): RowsFn =>
  (m) => [
    {
      method: "A",
      ...(m === "M0002" ? { status: "fail", message: "killed" } : { status: "pass" }),
    },
    bRow(kind),
    { method: "C", status: "pass" },
    { method: "D", status: "pass" },
  ];

async function cutRig(kind: BRow): Promise<LanesRig> {
  const r = await lanesRig({
    lanes: 0,
    methods: METHODS,
    rows: rowsWith(kind),
    serve: { honorExcludes: true },
    mutants: MUTANTS,
  });
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
  } finally {
    r.b.baselinePhase(false);
  }
  return r;
}

/** Prefetches `mutant`, covered by `refs`; returns its entry's `excludeTests` in the prefetch request. */
async function prefetchExcludes(
  r: LanesRig,
  mutant: string,
  refs: readonly ReturnType<typeof ref>[],
): Promise<readonly string[] | undefined> {
  const before = r.serve.requests.length;
  await r.b.prefetchMutants([{ mutantId: mutant, refs }], {
    batchPlans: MUTANTS.map((mutantId) => ({ mutantId, refs })),
  });
  const sent = r.serve.requests.slice(before).filter((q) => q.mutants.includes(mutant));
  expect(sent.length).toBeGreaterThan(0);
  const q = sent[0];
  if (q === undefined) throw new Error("no request");
  const ids = q.ids.filter((i) => !i.endsWith("|echo"));
  expect(ids).toHaveLength(1); // one group, one codeunit entry
  return q.excludes[ids[0] ?? ""];
}

const stats = (r: LanesRig) => r.b.entriesStats() as unknown as Record<string, number>;
const cutNotices = (r: LanesRig) =>
  r.notices.filter((n) => n.startsWith("al-runner-v3-baseline-refused-cut:"));
const outcome = (v: TestVerdict) => [v.outcome, v.runnerRow ?? ""];

describe("PR-250: the cut before a baseline refusal the daemon does not keep", () => {
  test("an unkept baseline refusal on B leaves out B and every later test of the codeunit, with today's cut (union)", async () => {
    const r = await cutRig("unkept");
    // covering A and D: today's L4 cut leaves nothing out; the PR-250 cut leaves out B, C, D
    expect(await prefetchExcludes(r, "M0001", [A, D])).toEqual([
      `Codeunit${CU}.B`,
      `Codeunit${CU}.C`,
      `Codeunit${CU}.D`,
    ]);
    expect(stats(r).refusedCutEntries).toBe(1);
    expect(cutNotices(r)).toHaveLength(1);
    expect(cutNotices(r)[0]).toContain(`Codeunit${CU}.B`);
    expect(cutNotices(r)[0]).toContain(UNLISTED);
    // the refused test never reached the daemon under a mutant, so no refusal closed it
    expect(r.b.daemonCloses().byReason.get("refusal") ?? 0).toBe(0);
  });

  for (const kind of ["fail", "pass", "kept"] as const) {
    test(`a baseline ${kind} on B cuts nothing`, async () => {
      const r = await cutRig(kind);
      expect(await prefetchExcludes(r, "M0001", [A, D])).toBeUndefined();
      expect(stats(r).refusedCutEntries).toBe(0);
      expect(cutNotices(r)).toEqual([]);
    });
  }

  test("a baseline timeout on B cuts nothing (read on the backend: its warm-up refuses a prefetch before any entry)", async () => {
    const r = await cutRig("timeout");
    const left = (r.b as unknown as { mutantLeftOutNames(cu: number): unknown }).mutantLeftOutNames(
      CU,
    );
    expect(left).toBeUndefined();
    const unkept = await cutRig("unkept");
    expect(
      (unkept.b as unknown as { mutantLeftOutNames(cu: number): unknown }).mutantLeftOutNames(CU),
    ).toEqual([`Codeunit${CU}.B`, `Codeunit${CU}.C`, `Codeunit${CU}.D`]);
  });

  test("a mutant whose covering test is after the cut: that test is an error naming the baseline refusal (held by the walk), never a pass", async () => {
    const r = await cutRig("unkept");
    await prefetchExcludes(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(A, OPTS))).toEqual(["pass", ""]);
    const c = await r.b.run(C, OPTS);
    expect(outcome(c)).toEqual(["error", "runner-refused"]);
    expect(c.failureMessage).toContain("baseline-refused-cut");
    expect(c.failureMessage).toContain(`Codeunit${CU}.B`);
    expect(c.failureMessage).toContain("baseline refusal");
    // the cut test itself, too
    expect(outcome(await r.b.run(B, OPTS))).toEqual(["error", "runner-refused"]);
  });

  test("a kill by a test before the cut stands", async () => {
    const r = await cutRig("unkept");
    await prefetchExcludes(r, "M0002", [A, C]);
    await r.b.activate("M0002");
    const a = await r.b.run(A, OPTS);
    expect(a.outcome).toBe("fail");
  });

  test("with no unkept baseline refusal (Prediction 2), entries are today's: the L4 cut alone, no count, no line", async () => {
    const r = await cutRig("pass");
    expect(await prefetchExcludes(r, "M0001", [A, C])).toEqual([`Codeunit${CU}.D`]);
    expect(await prefetchExcludes(r, "M0002", [A, D])).toBeUndefined();
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(C, OPTS))).toEqual(["pass", ""]);
    expect(stats(r).refusedCutEntries).toBe(0);
    expect(cutNotices(r)).toEqual([]);
  });
});
