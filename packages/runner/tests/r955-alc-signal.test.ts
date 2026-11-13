// R955: a SIGTERM or SIGINT reaches the whole process group, so alc can be killed while LethAL lives.
// A killed alc is never a compile verdict (bisection reads AlcCompileError as "does not compile"),
// and bisection stops, with no verdict, once the time budget is spent.
import { describe, expect, test } from "bun:test";
import { AlcCompileError, ArtifactCompiler, ArtifactPrepareError } from "../src/artifact";
import { TimeBudget } from "../src/mutant-windows";
import { isolateAndNote } from "../src/orchestrator";

const compilerWith = (result: {
  exitCode: number;
  signalCode?: string;
  stdout: string;
  stderr: string;
}) =>
  new ArtifactCompiler(
    { alcPath: "alc", packageCachePath: "/cache", outputDir: "/out" },
    {
      spawn: async () => result,
      readArtifact: async () => new Uint8Array([1]),
      writeArtifact: async () => {},
    },
  );
const compile = (c: ArtifactCompiler) =>
  c.compileProject({ projectDir: "/t", packageCachePath: "/c", name: "t" });

describe("R955: alc ended by a signal", () => {
  test("a signalled alc is an ArtifactPrepareError naming the signal, never an AlcCompileError", async () => {
    const err = await compile(
      compilerWith({ exitCode: 143, signalCode: "SIGTERM", stdout: "", stderr: "" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactPrepareError);
    expect(err).not.toBeInstanceOf(AlcCompileError);
    expect(String(err)).toContain("SIGTERM");
  });
  test("an ordinary non-zero exit is still an AlcCompileError", async () => {
    const err = await compile(
      compilerWith({ exitCode: 1, stdout: "error AL0001", stderr: "" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlcCompileError);
  });
});

describe("R955: bisection and the time budget", () => {
  const args = (budget: TimeBudget | undefined, seen: { checks: number }) =>
    ({
      subsetMutants: [{ mutantId: "M0001" }, { mutantId: "M0002" }],
      scratchDir: "/nonexistent/r955-bisect",
      batchFiles: [],
      identityOrdinals: new Map(),
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      projectDir: "/nonexistent",
      projectManifest: {},
      appVersion: "1.0.0.0",
      artifactId: "0123456789abcdef0123456789abcdef",
      compileCheck: async () => {
        seen.checks += 1;
      },
      originalErr: "alc failed",
      source: undefined,
      excludeOutputs: [],
      configPath: undefined,
      ...(budget !== undefined ? { timeBudget: budget } : {}),
    }) as unknown as Parameters<typeof isolateAndNote>[0];

  test("a spent budget (a stop signal) ends the search before any compile, with no verdict", async () => {
    const budget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
    budget.stop();
    const seen = { checks: 0 };
    const plan = await isolateAndNote(args(budget, seen));
    expect(plan.kind).toBe("none");
    expect(plan.compiles).toBe(0);
    expect(seen.checks).toBe(0);
    expect(plan.kind === "none" ? plan.note : "").toContain(
      "stop signal arrived; no verdict (R955)",
    );
  });
  test("an unspent budget does not stop the search", async () => {
    const budget = new TimeBudget(Number.POSITIVE_INFINITY, 0, () => 0);
    const plan = await isolateAndNote(args(budget, { checks: 0 }));
    expect(plan.compiles).toBeGreaterThan(0);
    expect(plan.kind === "none" ? plan.note : "").not.toContain("(R955)");
  });
});
