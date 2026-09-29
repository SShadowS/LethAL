import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { runSession } from "../src/orchestrator";
import type { SpawnFn } from "../src/publisher";
import { ResultsStore } from "../src/store";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

// R349, session level. `maxGuardsPerBatch: 1` splits the two carrier files into two batches, and
// one AlRunnerBackend deploys both. Each batch instruments only its own file, so the SAME file has
// a different line layout in each batch. The fake al-runner below reports coverage in the layout
// it was actually handed, the way the real one does, so a coverage index kept from batch 0 maps
// batch 1's lines through the wrong text.

const APP_JSON = JSON.stringify({
  id: "3f9a0f5e-6f63-4f37-9a53-1d0b3c1c3490",
  name: "R349 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

// `Target` sits FIRST and `Other` after it, so a line from the instrumented (longer) `Target`
// looked up in the raw layout lands on `Other` or past the end, never on `Target`.
const carrier = (id: number, name: string) => `codeunit ${id} "${name}"
{
    procedure Target(X: Integer): Integer
    begin
        if X > 0 then
            exit(X + 1);
        exit(X - 1);
    end;

    procedure Other(): Integer
    begin
        exit(7);
    end;
}
`;

const TESTS_AL = `codeunit 79100 "R349 Tests"
{
    Subtype = Test;

    [Test]
    procedure CoversA()
    begin
    end;

    [Test]
    procedure CoversB()
    begin
    end;
}
`;

/** The 1-based lines of `procedure Target` that hold an `exit(`, in the text as deployed. */
function targetExitLines(source: string): number[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("procedure Target("));
  const next = lines.findIndex((l, i) => i > start && l.includes("procedure Other("));
  if (start < 0 || next < 0) throw new Error("fake al-runner: deployed file lost a procedure");
  const out: number[] = [];
  for (let i = start + 1; i < next; i++) if ((lines[i] ?? "").includes("exit(")) out.push(i + 1);
  return out;
}

/** A fake al-runner: every test passes, and CoversX's coverage is file X's `Target` body AS DEPLOYED. */
function fakeAlRunner(activeDir: string): SpawnFn {
  return async (argv) => {
    if (argv.includes("--version"))
      return { exitCode: 0, stdout: "al-runner v2.11.0.0", stderr: "" };
    const t = argv.indexOf("--test");
    const wanted = t >= 0 ? argv[t + 1] : undefined;
    if (wanted === undefined) return { exitCode: 0, stdout: "", stderr: "" }; // provisioning
    const o = argv.indexOf("--coverage-out");
    const out = o >= 0 ? argv[o + 1] : undefined;
    if (out !== undefined) {
      const file = wanted.endsWith(".CoversA") ? "SandboxA.Codeunit.al" : "SandboxB.Codeunit.al";
      const source = await readFile(join(activeDir, file), "utf8");
      const rows = targetExitLines(source)
        .map((n) => `<line number="${n}" hits="1"/>`)
        .join("");
      await writeFile(
        out,
        `<coverage><packages><package><classes><class name="x" filename="${file}"><lines>${rows}</lines></class></classes></package></packages></coverage>`,
      );
    }
    return {
      exitCode: 0,
      stdout: alRunnerStdout({
        tests: [{ name: wanted, status: "pass", durationMs: 1 }],
        passed: 1,
        failed: 0,
        errors: 0,
        total: 1,
        exitCode: 0,
      }),
      stderr: "",
    };
  };
}

describe("R349: al-runner coverage across batches", () => {
  test("batch 2's covering tests are read through batch 2's layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r349-"));
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    const instrumentedDir = join(root, "instr");
    const backendDir = join(root, "backend");
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    await Bun.write(join(projectDir, "SandboxA.Codeunit.al"), carrier(79000, "Sandbox A"));
    await Bun.write(join(projectDir, "SandboxB.Codeunit.al"), carrier(79001, "Sandbox B"));
    await Bun.write(join(testDir, "R349Tests.Codeunit.al"), TESTS_AL);

    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: backendDir,
        testDir,
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      fakeAlRunner(join(backendDir, "active")),
    );
    const report = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      projectDir,
      testDir,
      instrumentedDir,
      selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
      maxGuardsPerBatch: 1,
    });
    expect(report.batches).toBe(2);

    // Pinned PER MUTANT, both batches. `Target` is covered by its own file's test alone, and
    // `Other` by nothing. Without R349's reset, batch 1's `Target` lines are looked up in batch 0's
    // raw text of SandboxB, where they land on `Other` or past the end: its `Target` mutants go
    // `no-coverage` and `Other`'s can pick up a test that never reached it.
    const table = report.mutants.map(
      (m) =>
        `${m.batchIndex}/${m.mutantCode} ${m.file} ${m.procedureName} ${m.verdict} [${m.coveringTests.join(",")}]`,
    );
    expect(table).toEqual([
      "0/M0001 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0002 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0003 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0004 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0005 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0006 SandboxA.Codeunit.al Target survived [R349 Tests.CoversA]",
      "0/M0007 SandboxA.Codeunit.al Other no-coverage []",
      "0/M0008 SandboxA.Codeunit.al Other no-coverage []",
      "1/M0001 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0002 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0003 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0004 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0005 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0006 SandboxB.Codeunit.al Target survived [R349 Tests.CoversB]",
      "1/M0007 SandboxB.Codeunit.al Other no-coverage []",
      "1/M0008 SandboxB.Codeunit.al Other no-coverage []",
    ]);
  });
});
