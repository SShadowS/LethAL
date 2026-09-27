/**
 * Harness-level tests for `probe-grammar-crosscheck.ts`: they spawn the real CLI, so they catch a
 * harness that stops CALLING a checked helper, which the pure tests in `lib/grammar-crosscheck.test.ts`
 * cannot. Opt-in like the pwsh round trip there: set LETHAL_ALC_BIN to the AL extension's `bin`.
 *
 * Why a stand-in compiler parser for the duplicate-key cases: no hand-written or garbled AL was found
 * that makes EITHER parser emit two statement-position sites of one probe at one start (18 hand-picked
 * broken bodies and 3,600 randomly garbled ones, GH-06 run 002; see r2-report.md). The harness already
 * takes the compiler's `bin` directory as an argument, so a tiny assembly with the same type name,
 * built here, stands in for `Microsoft.Dynamics.Nav.CodeAnalysis.dll`. No production code changes.
 * It emits two `InvocationExpression` nodes under `ExpressionStatement` at offset 0 of any file whose
 * text contains `DUP`, and nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alcBin = process.env.LETHAL_ALC_BIN;
const harness = join(import.meta.dir, "probe-grammar-crosscheck.ts");

const HEALTHY = `codeunit 50120 "Healthy Probe"
{
    procedure Run()
    begin
        Message('ok');
    end;
}
`;
// A missing `)` and `;`: tree-sitter reports ERROR/MISSING, so R1 excludes the file.
const UNHEALTHY = `codeunit 50121 "Unhealthy Probe"
{
    // DUP
    procedure Run()
    begin
        Message('ok'
    end;
}
`;

const FAKE_PARSER = `
using System.Collections.Generic;
using System.Threading;
namespace Microsoft.Dynamics.Nav.CodeAnalysis.Syntax {
  public class FakeSpan { public int Start; public int End; }
  public class FakeNode { public string Kind; public FakeSpan Span; public FakeNode Parent; }
  public class FakeRoot {
    public List<FakeNode> Nodes = new List<FakeNode>();
    public IEnumerable<FakeNode> DescendantNodes() { return Nodes; }
  }
  public class SyntaxTree {
    private FakeRoot root = new FakeRoot();
    public static SyntaxTree ParseObjectText(string text, string path, object a, object b, CancellationToken ct) {
      var t = new SyntaxTree();
      if (text.Contains("DUP")) {
        var stmt = new FakeNode { Kind = "ExpressionStatement", Span = new FakeSpan { Start = 0, End = 5 } };
        for (int i = 0; i < 2; i++)
          t.root.Nodes.Add(new FakeNode { Kind = "InvocationExpression", Span = new FakeSpan { Start = 0, End = 4 + i }, Parent = stmt });
      }
      return t;
    }
    public object[] GetDiagnostics(CancellationToken ct) { return new object[0]; }
    public FakeRoot GetRoot(CancellationToken ct) { return root; }
  }
}
`;

let root = "";
let fakeBin = "";

/** Runs the harness on `files` (name -> AL text) with the given compiler bin dir. */
function runHarness(name: string, files: Record<string, string>, bin: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  const json = join(root, `${name}.json`);
  const run = spawnSync("bun", [harness, dir, bin, "--json", json], { encoding: "utf8" });
  return {
    status: run.status,
    out: `${run.stdout}\n${run.stderr}`,
    report: existsSync(json)
      ? (JSON.parse(readFileSync(json, "utf8")) as { warnings: string[]; exitCode: number })
      : undefined,
  };
}

describe.skipIf(alcBin === undefined)(
  "probe-grammar-crosscheck.ts end to end (opt-in: LETHAL_ALC_BIN)",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "gh06-harness-"));
      fakeBin = join(root, "fake-bin");
      mkdirSync(fakeBin);
      const src = join(root, "fake.cs");
      writeFileSync(src, FAKE_PARSER);
      const dll = join(fakeBin, "Microsoft.Dynamics.Nav.CodeAnalysis.dll");
      const build = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-Command",
          `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${src}') -OutputAssembly '${dll}' -OutputType Library`,
        ],
        { encoding: "utf8" },
      );
      if (build.status !== 0) throw new Error(`fake parser build failed: ${build.stderr}`);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test("real compiler: an unhealthy file is excluded with a warning and the run finishes", () => {
      const r = runHarness("real", { "A.al": HEALTHY, "B.al": UNHEALTHY }, alcBin ?? "");
      expect(r.report).toBeDefined();
      expect([0, 1]).toContain(r.status);
      expect(r.report?.warnings.some((w) => w.includes("B.al excluded"))).toBe(true);
    }, 60_000);

    test("a duplicate context key in an EXCLUDED file is a warning, not a throw (R1/R5)", () => {
      const r = runHarness("dup-excluded", { "A.al": HEALTHY, "B.al": UNHEALTHY }, fakeBin);
      expect(r.out).not.toContain("error:");
      expect(r.report).toBeDefined();
      expect([0, 1]).toContain(r.status);
      const dup = r.report?.warnings.filter((w) => w.includes("duplicate key")) ?? [];
      expect(dup).toHaveLength(1);
      expect(dup[0]).toContain("compiler: duplicate key");
      expect(dup[0]).toContain("B.al|call in statement position|0");
    }, 60_000);

    test("a duplicate context key in a COMPARABLE file still throws", () => {
      const r = runHarness(
        "dup-comparable",
        { "A.al": HEALTHY.replace("Healthy", "DUP") },
        fakeBin,
      );
      expect(r.status).not.toBe(0);
      expect(r.report).toBeUndefined();
      expect(r.out).toContain("compiler: duplicate key");
    }, 60_000);
  },
);
