import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALRUNNER_LEG_IDS, GROUP_NAMES } from "../packages/runner/itest/alrunner-legs.ts";
import { LegsDiffRefusal, diffRunDirs, readRunDir } from "./alrunner-legs-diff.ts";

function mutant(over: Record<string, unknown> = {}) {
  return {
    mutantCode: "M0001",
    astHash: "h1",
    codeunitName: "Sandbox Logic",
    procedureName: "Clamp",
    operatorName: "lethal.return-value",
    operatorMajor: 1,
    verdict: "killed",
    killingTest: "T1",
    killingTestFailure: "Error: expected 1",
    mutatedText: "exit(0)",
    ...over,
  };
}

/** A complete run directory; `edit` may change one leg's mutant or the run's files. */
function runDir(opts: {
  nonce?: string;
  buildLine?: string;
  leg?: { id: string; mutant?: Record<string, unknown>; nonce?: string; drop?: boolean };
  dropDone?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-r587-diff-"));
  const nonce = opts.nonce ?? "a".repeat(32);
  const buildLine = opts.buildLine ?? "al-runner v2.12.0-main.x";
  writeFileSync(join(dir, "run.json"), JSON.stringify({ runNonce: nonce, buildLine }));
  for (const g of GROUP_NAMES) {
    if (g !== opts.dropDone)
      writeFileSync(join(dir, `${g}.done.json`), JSON.stringify({ runNonce: nonce }));
  }
  for (const id of ALRUNNER_LEG_IDS) {
    const mine = opts.leg?.id === id ? opts.leg : undefined;
    if (mine?.drop === true) continue;
    const report = { identityScheme: 40, mutants: [mutant(mine?.mutant)] };
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ runNonce: mine?.nonce ?? nonce, legId: id, report }),
    );
  }
  return dir;
}

function diff(s: string, p: string) {
  try {
    return diffRunDirs(readRunDir(s), readRunDir(p));
  } finally {
    rmSync(s, { recursive: true, force: true });
    rmSync(p, { recursive: true, force: true });
  }
}

describe("alrunner-legs-diff", () => {
  test("equal runs are IDENTICAL, leg by leg", () => {
    const r = diff(runDir({}), runDir({ nonce: "b".repeat(32) }));
    expect(r.verdict).toBe("IDENTICAL");
    expect(r.lines.filter((l) => l.endsWith(", 1 mutants"))).toHaveLength(23);
  });

  test("a swapped verdict is DIFFERENT, naming the leg", () => {
    const r = diff(
      runDir({}),
      runDir({ leg: { id: "layout-server", mutant: { verdict: "survived", killingTest: null } } }),
    );
    expect(r.verdict).toBe("DIFFERENT");
    expect(r.lines.join("\n")).toMatch(/leg layout-server: DIFFERENT/);
  });

  test("a leg missing on one side is DIFFERENT", () => {
    const r = diff(runDir({}), runDir({ leg: { id: "names-a3", drop: true } }));
    expect(r.verdict).toBe("DIFFERENT");
    expect(r.lines.join("\n")).toMatch(/leg names-a3: missing in P/);
  });

  test("a different killingTestFailure is DIFFERENT on a names or wrapped leg only", () => {
    const other = { killingTestFailure: "Error: expected 2" };
    expect(diff(runDir({}), runDir({ leg: { id: "names-a1", mutant: other } })).verdict).toBe(
      "DIFFERENT",
    );
    expect(
      diff(runDir({}), runDir({ leg: { id: "wrapped-resource", mutant: other } })).verdict,
    ).toBe("DIFFERENT");
    expect(diff(runDir({}), runDir({ leg: { id: "layout-server", mutant: other } })).verdict).toBe(
      "IDENTICAL",
    );
  });

  test("I3: a row whose mutated text cannot be checked makes the run VOID", () => {
    const r = diff(
      runDir({}),
      runDir({ leg: { id: "sandbox-a", mutant: { mutatedText: undefined } } }),
    );
    expect(r.verdict).toBe("VOID");
    expect(r.lines.join("\n")).toMatch(/leg sandbox-a: IDENTICAL, 1 mutants, 1 text-UNVERIFIED/);
  });

  test("I2: different al-runner build lines make the run VOID", () => {
    const r = diff(runDir({}), runDir({ buildLine: "al-runner v2.12.0-main.y" }));
    expect(r.verdict).toBe("VOID");
  });

  test("B2: a leg file from another run, or a group that did not finish, is refused", () => {
    const stale = runDir({ leg: { id: "cli-default", nonce: "c".repeat(32) } });
    expect(() => readRunDir(stale)).toThrow(/cli-default.json is from another run/);
    const unfinished = runDir({ dropDone: "wrapped" });
    expect(() => readRunDir(unfinished)).toThrow(LegsDiffRefusal);
    rmSync(stale, { recursive: true, force: true });
    rmSync(unfinished, { recursive: true, force: true });
  });
});
