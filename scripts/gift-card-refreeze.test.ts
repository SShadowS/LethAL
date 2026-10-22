import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import { scratchDirs } from "../packages/runner/tests/helpers/scratch";
import { IDENTITY_SCHEME } from "../packages/schemata/src/project";
import {
  EXPECTED_DEPLOYED,
  FROZEN_REPORT,
  RESTORE,
  type RefreezeDeps,
  figures,
  main,
  movedDemoRows,
} from "./gift-card-refreeze.ts";

const scratch = scratchDirs();

const mutant = (n: number, procedureName: string, operatorName: string, verdict: string) => ({
  mutantCode: `M${String(n).padStart(4, "0")}`,
  file: "src/GiftCardMgt.Codeunit.al",
  astHash: `hash${n}`,
  codeunitName: "Gift Card Mgt",
  procedureName,
  operatorName,
  operatorMajor: 1,
  verdict,
  killingTest: verdict === "killed" ? "RedeemReducesBalance" : null,
});

interface Over {
  identityScheme?: number;
  /** Verdict of mutant 5, a plain killed `Issue` mutant. */
  m5?: string;
  /** Verdict of the GetBalance remove-setrange row (mutant 1). */
  planted?: string;
  text?: boolean;
  count?: number;
  coverageMode?: string;
}

/**
 * A fixture report holding the three demo rows: GetBalance remove-setrange survived (1), Redeem
 * conditional-boundary survived (2), BlockExpiredCards no-coverage (3, 4); the rest killed in Issue.
 * 60 mutants by default, so 56 killed, 2 survived, 2 no-coverage.
 */
function report(over: Over = {}) {
  const mutants = [
    mutant(1, "GetBalance", "lethal.remove-setrange", over.planted ?? "survived"),
    mutant(2, "Redeem", "lethal.conditional-boundary", "survived"),
    mutant(3, "BlockExpiredCards", "lethal.remove-setrange", "no-coverage"),
    mutant(4, "BlockExpiredCards", "lethal.negate-guard", "no-coverage"),
  ];
  for (let n = 5; n <= (over.count ?? EXPECTED_DEPLOYED); n++) {
    const verdict = n === 5 ? (over.m5 ?? "killed") : "killed";
    mutants.push(mutant(n, "Issue", "lethal.void-method-call", verdict));
  }
  return {
    identityScheme: over.identityScheme ?? IDENTITY_SCHEME,
    coverageMode: over.coverageMode ?? "fenced",
    counts: { killed: 56, survived: 2, noCoverage: 2 },
    mutationScore: 56 / 58,
    timings: { totalMs: 20630 },
    mutants: over.text
      ? mutants.map((m) => ({ ...m, originalText: "GiftCard.SetRange(x)", mutatedText: "" }))
      : mutants,
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
    freeze: async (r, events) => {
      calls.push(`freeze ${r} ${events}`);
    },
    redactCheck: async () => {
      calls.push("check");
      return true;
    },
    commit: () => "abc",
    scratch: dir,
    dest: join(dir, "out", "rehearsal.report.json"),
  };
  const go = async (d: RefreezeDeps = deps) => ({
    code: await main(d, (s) => lines.push(s)),
    out: lines.join("\n"),
  });
  return { deps, calls, go, dir };
}

const froze = (calls: string[]) => calls.some((c) => c.startsWith("freeze"));

describe("gift-card-refreeze (R664)", () => {
  test("three agreeing reports are frozen from run 1, with run 1's events, then checked", async () => {
    const h = harness([report(), report(), report()]);
    const { code, out } = await h.go();
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      "probe",
      "run",
      "run",
      "run",
      `freeze ${join(h.dir, "run-1.report.json")} ${join(h.dir, "run-1.events.ndjson")}`,
      "check",
    ]);
    expect(out).toContain("runs 1-3 agree per mutant");
  });

  test("one differing mutant refuses, naming it, and freezes nothing", async () => {
    const h = harness([report(), report(), report({ m5: "survived" })]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain("run 3 differs from run 1 in 1 mutant(s)");
    expect(out).toContain("hash5|Gift Card Mgt|Issue|lethal.void-method-call|1");
    expect(froze(h.calls)).toBe(false);
  });

  test("a report at an old identity scheme refuses", async () => {
    const h = harness([report(), report({ identityScheme: 3 }), report()]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain(`run 2 is at identity scheme 3, not ${IDENTITY_SCHEME}`);
    expect(froze(h.calls)).toBe(false);
  });

  test("source text bound for a non-first-party path refuses before anything is written", async () => {
    const r = report({ text: true });
    const h = harness([r, r, r]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    // 60 originalText; the empty mutatedText of a deletion reveals nothing and is not counted.
    expect(out).toContain("60 unredacted source field(s)");
    expect(froze(h.calls)).toBe(false);
    expect(existsSync(h.deps.dest)).toBe(false);
  });

  test("a failing redact --check on the archived report refuses with the restore command", async () => {
    const h = harness([report(), report(), report()]);
    const { code, out } = await h.go({ ...h.deps, redactCheck: async () => false });
    expect(code).toBe(1);
    expect(out).toContain("--check failed");
    expect(out).toContain(RESTORE);
  });

  test("the gift-card report's real destination is first-party, so its source passes", async () => {
    const r = report({ text: true });
    const h = harness([r, r, r]);
    const { code } = await h.go({ ...h.deps, dest: FROZEN_REPORT });
    expect(code).toBe(0);
    expect(h.calls).toContain("check");
  });

  test("a mutant count other than the pre-committed 60 refuses before the delete", async () => {
    const r = report({ count: 59 });
    const h = harness([r, r, r]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain("run 1 deployed 59 mutants, not the pre-committed 60");
    expect(froze(h.calls)).toBe(false);
    // Nothing was deleted, so there is nothing to restore.
    expect(out).not.toContain(RESTORE);
  });

  test("a report with no valid coverage mode refuses before the delete", async () => {
    const r = report({ coverageMode: "bogus" });
    const h = harness([r, r, r]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain("records no coverageMode");
    expect(froze(h.calls)).toBe(false);
  });

  test("a moved demo row refuses by name before the delete", async () => {
    const r = report({ planted: "killed" });
    const h = harness([r, r, r]);
    const { code, out } = await h.go();
    expect(code).toBe(1);
    expect(out).toContain("demo row(s) moved: GetBalance remove-setrange survived");
    expect(froze(h.calls)).toBe(false);
  });

  test("the committed rehearsal report's demo rows hold", () => {
    const committed = JSON.parse(readFileSync(FROZEN_REPORT, "utf8")) as SessionReport;
    expect(movedDemoRows(committed)).toEqual([]);
  });

  test("a freeze that throws after the delete prints the restore command and exits 1", async () => {
    const h = harness([report(), report(), report()]);
    const { code, out } = await h.go({
      ...h.deps,
      freeze: async () => {
        throw new Error("campaign: refusing — rehearsal.precommit.md is modified");
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("rehearsal.precommit.md is modified");
    expect(out).toContain("git checkout -- docs/campaign/2026-08-16-gift-card/");
  });

  test("bc-demo not reachable refuses by name, exit 2, and runs nothing", async () => {
    const h = harness([], false);
    const { code, out } = await h.go();
    expect(code).toBe(2);
    expect(out).toContain("bc-demo-unreachable");
    expect(out).toContain("bc-demo does not answer");
    expect(h.calls).toEqual(["probe"]);
  });

  test("R663b laptop: a refused preflight exits 1 before the probe and runs nothing", async () => {
    const h = harness([report(), report(), report()]);
    const { code, out } = await h.go({
      ...h.deps,
      laptopHost: "http://localhost",
      preflight: async () => {
        throw new Error("bc-dev-mcp is missing: no x/package.json");
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("REFUSED: bc-dev-mcp is missing");
    expect(h.calls).toEqual([]);
  });

  test("R663b laptop: not reachable names the laptop host and its start step, not /coord", async () => {
    const h = harness([], false);
    const { code, out } = await h.go({
      ...h.deps,
      laptopHost: "http://localhost",
      preflight: async () => {},
    });
    expect(code).toBe(2);
    expect(out).toContain("does not answer on http://localhost:7349");
    expect(out).toContain("docker compose -p bc-demo");
    expect(out).not.toContain("/coord");
  });

  test("R663b: kraken mode (no laptop fields) still prints the owner steps", async () => {
    const h = harness([], false);
    const { out } = await h.go();
    expect(out).toContain("does not answer on http://192.168.2.157:7349");
    expect(out).toContain("Only the owner can start it");
  });

  test("the printed numbers are computed from the report", () => {
    const lines = figures(report() as never);
    expect(lines[0]).toBe(
      "deployed 60, killed 56, survived 2, no-coverage 2, score 96.6%, wall time 20.6 s",
    );
    expect(lines).toContain(
      "intro:   60 mutants, and the last measured run took **20.6 seconds**.",
    );
    expect(lines).toContain("§4 lead: Times are from the measured 20.6 s run");
    expect(lines).toContain('§4 0:40: "56 killed, 2 survived, 2 no-coverage.');
    expect(lines).toContain('§4 2:10: "2 mutants, no test executed any of them.');
  });

  test("on the committed report, every printed phrase is already in the runbook", () => {
    const runbook = readFileSync(
      join(import.meta.dir, "..", "docs", "directions-emea-2026-runbook.md"),
      "utf8",
    ).replace(/\s*\n\s*/g, " ");
    const committed = JSON.parse(readFileSync(FROZEN_REPORT, "utf8")) as SessionReport;
    const label = /^(intro|§4 lead|§4 0:40|§4 2:10):\s+/;
    const phrases = figures(committed)
      .filter((l) => label.test(l))
      .map((l) => l.replace(label, ""));
    expect(phrases.length).toBe(4);
    for (const p of phrases) expect(runbook).toContain(p);
  });
});
