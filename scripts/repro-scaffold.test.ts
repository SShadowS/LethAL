// R934: the repro scaffolder's offline half. Every folder is a temp dir; nothing touches /coord or /work/tools.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, compareReports, scaffold } from "./repro-scaffold.ts";

const TMP = mkdtempSync(join(tmpdir(), "repro-scaffold-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const symbols = (): string => {
  const d = join(TMP, `sym-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d);
  writeFileSync(join(d, "LethAL_LethAL Sandbox App_1.0.0.2.app"), "x");
  writeFileSync(join(d, "Microsoft_System_28.0.47067.0.app"), "x");
  return d;
};

describe("R934 repro-scaffold new", () => {
  test("writes the target, the test app with symbols and the AL given, both configs and run.sh", async () => {
    const dir = join(TMP, "r1");
    const al = join(TMP, "Repro.Codeunit.al");
    writeFileSync(al, 'codeunit 79150 "Repro Tests" { Subtype = Test; }\n');
    await scaffold({
      dir,
      tests: [al],
      symbols: symbols(),
      alRunner: "/x/al-runner",
      alc: "/x/alc",
    });
    expect(existsSync(join(dir, "app", "src", "SandboxLogic.Codeunit.al"))).toBe(true);
    expect(readFileSync(join(dir, "app-test", "src", "Repro.Codeunit.al"), "utf8")).toContain(
      "Repro Tests",
    );
    expect(
      existsSync(join(dir, "app-test", ".alpackages", "LethAL_LethAL Sandbox App_1.0.0.2.app")),
    ).toBe(true);
    const app = JSON.parse(readFileSync(join(dir, "app-test", "app.json"), "utf8"));
    expect(app.dependencies[0].name).toBe("LethAL Sandbox App");
    const def = JSON.parse(readFileSync(join(dir, "v3.default.json"), "utf8"));
    const one = JSON.parse(readFileSync(join(dir, "v3.oneshot.json"), "utf8"));
    expect(def.alRunnerV3.transport).toBeUndefined();
    expect(one.alRunnerV3.transport).toBe("one-shot");
    expect(def.alRunnerV3).toMatchObject({
      path: "/x/al-runner",
      downloadDemoData: false,
      dotnetSidecar: false,
    });
    expect(readFileSync(join(dir, "run.sh"), "utf8")).toContain("heavy-slot.sh --wait other");
  });

  test("refuses a folder that is not empty, and symbols without the sandbox app's package", async () => {
    const al = join(TMP, "Repro2.Codeunit.al");
    writeFileSync(al, 'codeunit 79151 "Repro Tests 2" { Subtype = Test; }\n');
    const dir = join(TMP, "r2");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep"), "x");
    await expect(scaffold({ dir, tests: [al], symbols: symbols() })).rejects.toThrow(
      /exists and is not empty/,
    );
    const empty = join(TMP, "sym-empty");
    mkdirSync(empty);
    await expect(scaffold({ dir: join(TMP, "r3"), tests: [al], symbols: empty })).rejects.toThrow(
      /no LethAL Sandbox App symbol package/,
    );
  });

  // Live smoke 2026-11-13: without a --test the test app held no test codeunit, and both runs failed "no tests discovered".
  test("refuses no --test before writing anything", async () => {
    const dir = join(TMP, "r4");
    await expect(scaffold({ dir, symbols: symbols() })).rejects.toThrow(/at least one --test/);
    await expect(scaffold({ dir, tests: [], symbols: symbols() })).rejects.toThrow(
      /at least one --test/,
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe("R934 repro-scaffold compare of a folder", () => {
  // Live smoke 2026-11-13: a failed run wrote no report and compare crashed with a bare ENOENT.
  test("names the run that wrote no report", () => {
    const dir = join(TMP, "c1");
    mkdirSync(dir);
    expect(() => compare(dir)).toThrow(/the default run wrote no report; see default\.stderr\.txt/);
    writeFileSync(join(dir, "default.report.json"), JSON.stringify({ mutants: [] }));
    expect(() => compare(dir)).toThrow(/the oneshot run wrote no report; see oneshot\.stderr\.txt/);
    writeFileSync(join(dir, "oneshot.report.json"), JSON.stringify({ mutants: [] }));
    expect(compare(dir)).toBe(0);
  });
});

describe("R934 repro-scaffold compare", () => {
  const m = (start: number, verdict: string, killingTest?: string) => ({
    file: "src/A.al",
    startIndex: start,
    endIndex: start + 1,
    operatorName: "op",
    verdict,
    ...(killingTest !== undefined ? { killingTest } : {}),
  });
  test("equal reports have no difference; a verdict, a killer or a missing mutant each is one", () => {
    expect(
      compareReports(
        [m(1, "killed", "T"), m(2, "survived")],
        [m(2, "survived"), m(1, "killed", "T")],
      ),
    ).toEqual([]);
    expect(compareReports([m(1, "killed", "T")], [m(1, "survived")])).toEqual([
      "src/A.al|1|2|op: default killed, one-shot survived",
    ]);
    expect(compareReports([m(1, "killed", "T")], [m(1, "killed", "U")])).toHaveLength(1);
    expect(compareReports([m(1, "killed", "T")], [])).toEqual(["src/A.al|1|2|op: only in default"]);
    expect(compareReports([], [m(1, "killed", "T")])).toEqual([
      "src/A.al|1|2|op: only in one-shot",
    ]);
  });
});
