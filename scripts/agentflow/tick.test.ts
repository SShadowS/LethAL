import { describe, expect, test } from "bun:test";
import { EffectRefusedError, EffectRunner } from "./effects.ts";
import { type FakeWorld, emptyWorld, fakePorts } from "./fakes.ts";
import type { MutantDiff } from "./gate-outcome.ts";
import { HaltError } from "./halt.ts";
import { ReceiptError } from "./receipt.ts";
import { type TickInput, runTick } from "./tick.ts";

const HEAD = "1111111111111111111111111111111111111111";

function input(over: Partial<TickInput> = {}): TickInput {
  return {
    runId: "run-1",
    sessionUrl: "https://example.invalid/session",
    base: "base",
    head: HEAD,
    finalHead: "HEAD",
    precommitment: [],
    precommitmentCommitted: true,
    precommitmentPredatesFirstLiveRun: true,
    burnedShas: [],
    testsWithoutRedCheck: [],
    ...over,
  };
}

function world(over: Partial<FakeWorld> = {}): FakeWorld {
  return emptyWorld({
    issues: [{ number: 42, title: "Fix the thing", bodyHash: "b1" }],
    // A docs-only change keeps the slice to one leg without weakening what it proves: the
    // path-to-leg table has its own tests.
    changedPaths: ["fixtures/sandbox-data/src/DataMain.Table.al"],
    ...over,
  });
}

function changed(key: string, from: string, to: string): MutantDiff {
  return { key, kind: "changed", fields: ["verdict"], baselineVerdict: from, observedVerdict: to };
}

describe("the happy path", () => {
  test("an issue travels claim, gates, seal, merge-tree, merge", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("merged");
    if (out.status !== "merged") throw new Error("unreachable");
    expect(out.issue).toBe(42);
    expect(out.pr).toBe(77);
    expect(out.mergeSha).toBe("MERGE");

    // The ORDER is the part that decides whether a wrong thing can merge: claim before work,
    // leases before gates, gates before the PR, release after.
    expect(w.journal).toEqual([
      "claim:42:https://example.invalid/session",
      "lease-acquire:agent-data:run-1",
      "gate:tables",
      "gate:chunked",
      "pr:Fix the thing (#42)",
      "merge:77:HEAD",
      "lease-release:agent-data:run-1",
    ]);
  });
});

describe("a dry run ranks and picks, and stops", () => {
  test("it reports the pick and the legs, and writes nothing at all", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("dry-run");
    if (out.status !== "dry-run") throw new Error("unreachable");
    expect(out.issue).toBe(42);
    expect(out.legs).toEqual(["tables", "chunked"]);

    // The witness. Every fake write appends here, so an empty journal is evidence rather than the
    // absence of an error.
    expect(w.journal).toEqual([]);
    // Nothing was even PLANNED, because the dry run stops before the first write rather than
    // planning its way through a tick it must not perform.
    expect(r.plannedWrites).toEqual([]);
  });

  test("a gate declares no dry-run result, so reaching one in a dry run refuses loudly", async () => {
    // Guards the classification rather than the current control flow: if a later change let a dry
    // run reach a leg, this fails instead of silently publishing to a container.
    const w = world();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });
    const ports = fakePorts(w);
    await expect(
      r.run(
        ports.gates.runLeg(
          "tables",
          {
            leg: "tables",
            nonce: "n",
            candidateSha: HEAD,
            containerGeneration: 1,
            expectedSublegs: 1,
          },
          HEAD,
        ),
      ),
    ).rejects.toThrow(EffectRefusedError);
    expect(w.journal).toEqual([]);
  });
});

describe("HALT stops the tick at the first forbidden write", () => {
  test("the claim is refused and nothing was written", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: false, isHalted: () => true });
    await expect(runTick(fakePorts(w), r, input())).rejects.toThrow(HaltError);
    expect(w.journal).toEqual([]);
  });

  test("HALT dropped after the claim stops the gate, because a gate run is not containment", async () => {
    const w = world();
    let halted = false;
    const r = new EffectRunner({ dryRun: false, isHalted: () => halted });
    const ports = fakePorts(w);
    const patched = {
      ...ports,
      gh: {
        ...ports.gh,
        claim: (n: number, url: string) => {
          const e = ports.gh.claim(n, url);
          return {
            ...e,
            perform: async () => {
              await e.perform();
              halted = true;
            },
          };
        },
      },
    };
    await expect(runTick(patched, r, input())).rejects.toThrow(HaltError);
    expect(w.journal).toEqual(["claim:42:https://example.invalid/session"]);
  });
});

describe("the gate decision governs the merge", () => {
  test("an unpredicted movement blocks and names the SHA to burn", async () => {
    const w = world();
    w.legDiffs.set("tables", [changed("K1", "killed", "survived")]);
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("blocked");
    if (out.status !== "blocked") throw new Error("unreachable");
    expect(out.burn).toBe(HEAD);
    // Nothing was merged. The journal is the proof, not the return value.
    expect(w.journal.some((j) => j.startsWith("merge:"))).toBe(false);
    expect(w.journal.some((j) => j.startsWith("pr:"))).toBe(false);
  });

  test("a predicted movement merges and re-records", async () => {
    const w = world();
    w.legDiffs.set("tables", [changed("K1", "survived", "killed")]);
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(
      fakePorts(w),
      r,
      input({ precommitment: [{ op: "change", key: "K1", from: "survived", to: "killed" }] }),
    );

    expect(out.status).toBe("merged");
    if (out.status !== "merged") throw new Error("unreachable");
    expect(out.reRecorded).toContain("tables");
  });

  test("a burned SHA never reaches a gate at all", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input({ burnedShas: [HEAD] }));

    expect(out.status).toBe("blocked");
    // The load-bearing part: not merely "did not merge", but never ran. Blocking only at merge
    // would leave the second observation in the agent's hands.
    expect(w.journal.some((j) => j.startsWith("gate:"))).toBe(false);
  });
});

describe("receipts, not exit codes", () => {
  test("a leg that reports SKIPPED fails the tick", async () => {
    const w = world();
    w.receiptOverrides.set("tables", {
      leg: "tables",
      nonce: "unused",
      candidateSha: HEAD,
      containerGeneration: 1,
      status: "skipped",
      sublegs: [],
      observedArtifacts: {},
    });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    await expect(runTick(fakePorts(w), r, input())).rejects.toThrow(ReceiptError);
    expect(w.journal.some((j) => j.startsWith("merge:"))).toBe(false);
  });

  test("a replayed receipt from an earlier run fails the tick", async () => {
    const w = world();
    w.receiptOverrides.set("tables", {
      leg: "tables",
      nonce: "a".repeat(32),
      candidateSha: HEAD,
      containerGeneration: 1,
      status: "passed",
      sublegs: ["tables-0"],
      observedArtifacts: {},
    });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    await expect(runTick(fakePorts(w), r, input())).rejects.toThrow(ReceiptError);
  });
});

describe("the things that can be true while every verdict matches", () => {
  test("a stale test app blocks the seal even with every leg green", async () => {
    // R56: nothing moves, so no prediction logic fires. Only expected-versus-observed catches it.
    const w = world({ observedArtifacts: { target: "sha:t", tests: "sha:OLD" } });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("blocked");
    if (out.status !== "blocked") throw new Error("unreachable");
    expect(out.reasons.join(" ")).toContain("stale");
    expect(w.journal.some((j) => j.startsWith("merge:"))).toBe(false);
  });

  test("a changed test with no red-check blocks the seal", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(
      fakePorts(w),
      r,
      input({ testsWithoutRedCheck: ["selection.test.ts > twins"] }),
    );
    expect(out.status).toBe("blocked");
  });

  test("an issue edited since claim blocks the merge", async () => {
    const w = world({ bodyHashNow: "b2" });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());
    expect(out.status).toBe("blocked");
    if (out.status !== "blocked") throw new Error("unreachable");
    expect(out.reasons.join(" ")).toContain("not the one tested");
  });

  test("a container reset since qualification blocks before any gate runs", async () => {
    const w = world({ generations: { "agent-data": 2 }, qualified: { "agent-data": 1 } });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());
    expect(out.status).toBe("blocked");
    expect(w.journal.some((j) => j.startsWith("gate:"))).toBe(false);
  });

  test("source in the evidence range is REGRESSED, not blocked, because the merge already landed", async () => {
    // The distinction is the point. The tree check compares the merge commit against what was
    // gated, so it can only run after the merge. Calling that "blocked" would imply nothing
    // happened, and master would keep carrying a commit nothing verified.
    const w = world({ evidencePaths: ["packages/runner/src/store.ts"] });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input({ finalHead: "FINAL" }));

    expect(out.status).toBe("regressed");
    if (out.status !== "regressed") throw new Error("unreachable");
    expect(out.mergeSha).toBe("MERGE");
    expect(out.reasons.join(" ")).toContain("not an allowed evidence path");
    // And the merge really did happen, which is why it needs reverting.
    expect(w.journal.some((j) => j.startsWith("merge:"))).toBe(true);
  });
});

describe("parking and the empty queue", () => {
  test("an empty queue ends the tick without a claim", async () => {
    const w = world({ issues: [] });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    expect((await runTick(fakePorts(w), r, input())).status).toBe("queue-empty");
    expect(w.journal).toEqual([]);
  });

  test("a manual-only path parks BEFORE the claim", async () => {
    // An issue nobody can gate autonomously should not carry a claim label that makes it look
    // like work in progress.
    const w = world({ changedPaths: ["packages/runner/src/env-tool.ts"] });
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());
    expect(out.status).toBe("parked");
    expect(w.journal).toEqual([]);
  });
});

describe("the control run decides whether the candidate is implicated", () => {
  test("it runs only when something moved, so a green ladder pays nothing for it", async () => {
    const w = world();
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    await runTick(fakePorts(w), r, input());
    expect(w.journal.some((j) => j.startsWith("control:"))).toBe(false);
  });

  test("a base that also moved is inconclusive, and the candidate is not burned", async () => {
    // The expensive mistake is burning a candidate for the machine's fault. al-runner ships
    // several times a day and is a global dotnet tool.
    const w = world();
    w.legDiffs.set("tables", [changed("K1", "killed", "survived")]);
    w.controlDiffs.set("tables", [changed("K9", "killed", "survived")]);
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("inconclusive");
    if (out.status !== "inconclusive") throw new Error("unreachable");
    expect(out.reason).toBe("environment-drift");
    expect(w.journal).toContain("control:tables");
  });

  test("a stable base with an unpredicted movement burns the candidate", async () => {
    const w = world();
    w.legDiffs.set("tables", [changed("K1", "killed", "survived")]);
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    const out = await runTick(fakePorts(w), r, input());

    expect(out.status).toBe("blocked");
    if (out.status !== "blocked") throw new Error("unreachable");
    expect(out.burn).toBe(HEAD);
    // The control really ran; the verdict rests on an observation rather than an assumption.
    expect(w.journal).toContain("control:tables");
  });
});
