import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../packages/runner/tests/helpers/scratch";
import { IDENTITY_SCHEME } from "../packages/schemata/src/project";
import { FROZEN_REPORT, type RefreezeDeps, figures, main } from "./gift-card-refreeze.ts";

const scratch = scratchDirs();

const mutant = (n: number, verdict: string, procedureName = "GetBalance") => ({
  mutantCode: `M${String(n).padStart(4, "0")}`,
  file: "src/GiftCardMgt.Codeunit.al",
  astHash: `hash${n}`,
  codeunitName: "Gift Card Mgt",
  procedureName,
  operatorName: "lethal.remove-setrange",
  operatorMajor: 1,
  verdict,
  killingTest: verdict === "killed" ? "RedeemReducesBalance" : null,
});

/** A fixture report: 4 mutants, 2 killed, 1 survived, 1 no-coverage in BlockExpiredCards. */
function report(over: { identityScheme?: number; m2?: string; text?: boolean } = {}) {
  const mutants = [
    mutant(1, "killed"),
    mutant(2, over.m2 ?? "survived"),
    mutant(3, "killed"),
    mutant(4, "no-coverage", "BlockExpiredCards"),
  ].map((m) => (over.text ? { ...m, originalText: "GiftCard.SetRange(x)", mutatedText: "" } : m));
  return {
    identityScheme: over.identityScheme ?? IDENTITY_SCHEME,
    counts: { killed: 2, survived: 1, noCoverage: 1 },
    mutationScore: 2 / 3,
    timings: { totalMs: 20630 },
    mutants,
  };
}

/** Fake deps: run `i` writes `reports[i]`; records every call so a refusal can be shown to write nothing. */
function harness(reports: object[], reachable = true) {
  const dir = scratch("lethal-refreeze-");
  const calls: string[] = [];
  let i = 0;
  const lines: string[] = [];
  const deps: RefreezeDeps = {
    reachable: async () => {
      calls.push("probe");
      return reachable;
    },
    run: async (out) => {
      calls.push("run");
      writeFileSync(out, JSON.stringify(reports[i++]));
      return 0;
    },
    freeze: async (r) => {
      calls.push(`freeze ${r}`);
    },
    redactCheck: async () => {
      calls.push("check");
      return true;
    },
    commit: () => "abc",
    scratch: dir,
    dest: join(dir, "out", "rehearsal.report.json"),
  };
  const go = async () => ({ code: await main(deps, (s) => lines.push(s)), out: lines.join("\n") });
  return { deps, calls, go, dir };
}

describe("gift-card-refreeze (R664)", () => {
  test("three agreeing reports are frozen from run 1, then checked", async () => {
    const h = harness([report(), report(), report()]);
    const { code, out } = await h.go();
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      "probe",
      "run",
      "run",
      "run",
      `freeze ${join(h.dir, "run-1.report.json")}`,
      "check",
    ]);
    expect(out).toContain("runs 1-3 agree per mutant");
  });

  test("one differing mutant refuses, naming it, and freezes nothing", async () => {
    const h = harness([report(), report(), report({ m2: "killed" })]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain("run 3 differs from run 1 in 1 mutant(s)");
    expect(out).toContain("hash2|Gift Card Mgt|GetBalance|lethal.remove-setrange|1");
    expect(h.calls.some((c) => c.startsWith("freeze"))).toBe(false);
  });

  test("a report at an old identity scheme refuses", async () => {
    const h = harness([report(), report({ identityScheme: 3 }), report()]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain(`run 2 is at identity scheme 3, not ${IDENTITY_SCHEME}`);
    expect(h.calls.some((c) => c.startsWith("freeze"))).toBe(false);
  });

  test("source text bound for a non-first-party path refuses before anything is written", async () => {
    const r = report({ text: true });
    const h = harness([r, r, r]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    // 4 originalText; the empty mutatedText of a deletion reveals nothing and is not counted.
    expect(out).toContain("4 unredacted source field(s)");
    expect(h.calls.some((c) => c.startsWith("freeze"))).toBe(false);
    expect(existsSync(h.deps.dest)).toBe(false);
  });

  test("a failing redact --check on the archived report refuses", async () => {
    const h = harness([report(), report(), report()]);
    const lines: string[] = [];
    const code = await main({ ...h.deps, redactCheck: async () => false }, (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("--check failed");
    expect(lines.join("\n")).toContain("do NOT commit it");
  });

  test("the gift-card report's real destination is first-party, so its source passes", async () => {
    const r = report({ text: true });
    const h = harness([r, r, r]);
    expect(await main({ ...h.deps, dest: FROZEN_REPORT }, () => {})).toBe(0);
    expect(h.calls).toContain("check");
  });

  test("bc-demo not reachable refuses by name, exit 2, and runs nothing", async () => {
    const h = harness([], false);
    const { code, out } = await h.go();
    expect(code).toBe(2);
    expect(out).toContain("bc-demo-unreachable");
    expect(out).toContain("bc-demo does not answer");
    expect(h.calls).toEqual(["probe"]);
  });

  test("the printed numbers are computed from the report", () => {
    const lines = figures(report() as never);
    expect(lines[0]).toBe(
      "deployed 4, killed 2, survived 1, no-coverage 1, score 66.7%, wall time 20.6 s",
    );
    expect(lines).toContain("<<REFREEZE: deployed>> = 4");
    expect(lines).toContain("<<REFREEZE: killed>> = 2");
    expect(lines).toContain("<<REFREEZE: survived>> = 1");
    expect(lines).toContain("<<REFREEZE: no-coverage>> = 1");
    expect(lines).toContain("<<REFREEZE: BlockExpiredCards no-coverage>> = 1");
    expect(lines).toContain("<<REFREEZE: wall s>> = 20.6");
  });
});
