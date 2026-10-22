import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALRUNNER_LEG_IDS, GROUP_NAMES } from "../packages/runner/itest/alrunner-legs.ts";
import { diffRunDirs, readRunDir } from "./alrunner-legs-diff.ts";

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
  /** One group's done-file differs: another run's nonce, or another build line. */
  done?: { group: string; nonce?: string; buildLine?: string };
  /** `null` writes no result.json (the run did not pass). */
  result?: Record<string, unknown> | null;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-r587-diff-"));
  const nonce = opts.nonce ?? "a".repeat(32);
  const buildLine = opts.buildLine ?? "al-runner v2.12.0-main.x";
  writeFileSync(join(dir, "run.json"), JSON.stringify({ runNonce: nonce, buildLine }));
  if (opts.result !== null) {
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(opts.result ?? { runNonce: nonce, exitCode: 0, finalLine: "x" }),
    );
  }
  for (const g of GROUP_NAMES) {
    if (g === opts.dropDone) continue;
    const mine = opts.done?.group === g ? opts.done : undefined;
    writeFileSync(
      join(dir, `${g}.done.json`),
      JSON.stringify({
        runNonce: mine?.nonce ?? nonce,
        buildLine: mine?.buildLine ?? buildLine,
      }),
    );
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

  test("a leg file missing on one side is REFUSED", () => {
    const d = runDir({ leg: { id: "names-a3", drop: true } });
    try {
      expect(() => readRunDir(d)).toThrow(/names-a3.json is missing/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  const refuses = (d: string, pattern: RegExp) => {
    try {
      expect(() => readRunDir(d)).toThrow(pattern);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  test("I-1: a run without result.json, or with another run's or a failed one, is REFUSED", () => {
    refuses(runDir({ result: null }), /result.json is missing/);
    refuses(
      runDir({ result: { runNonce: "c".repeat(32), exitCode: 0 } }),
      /not this run's full PASS/,
    );
    refuses(runDir({ result: { runNonce: "a".repeat(32), exitCode: 1 } }), /not this run's/);
  });

  test("a done-file with another run's nonce, or another build line (I2), is REFUSED", () => {
    refuses(runDir({ done: { group: "names", nonce: "c".repeat(32) } }), /names.done.json is from/);
    refuses(
      runDir({ done: { group: "wrapped", buildLine: "al-runner v2.12.0-main.z" } }),
      /wrapped.done.json ran al-runner "al-runner v2.12.0-main.z"/,
    );
  });

  test("the CLI maps IDENTICAL 0, DIFFERENT 1, REFUSED 2, VOID 3", () => {
    const cli = (s: string, p: string): number => {
      try {
        return Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "alrunner-legs-diff.ts"), s, p],
          {
            stdout: "ignore",
            stderr: "ignore",
          },
        ).exitCode;
      } finally {
        rmSync(s, { recursive: true, force: true });
        rmSync(p, { recursive: true, force: true });
      }
    };
    expect(cli(runDir({}), runDir({}))).toBe(0);
    expect(
      cli(runDir({}), runDir({ leg: { id: "layout-server", mutant: { verdict: "survived" } } })),
    ).toBe(1);
    expect(cli(runDir({}), runDir({ result: null }))).toBe(2);
    expect(cli(runDir({}), runDir({ buildLine: "al-runner v2.12.0-main.y" }))).toBe(3);
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
    const unfinished = runDir({ dropDone: "wrapped" });
    try {
      expect(() => readRunDir(stale)).toThrow(/cli-default.json is from another run/);
      expect(() => readRunDir(unfinished)).toThrow(/wrapped.done.json is missing/);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(unfinished, { recursive: true, force: true });
    }
  });
});
