import { describe, expect, test } from "bun:test";
// Imports from packages/runner/src, not scripts/campaign/compile-only.ts directly: scripts/ is
// outside every package's tsconfig project graph, and this package's tsconfig is composite, so a
// cross-boundary import here fails `tsc --build` with TS6059/TS6307 even though `bun test` alone
// resolves it fine. The driver script re-exports the same symbol from the same module — see
// packages/runner/src/compile-only-args.ts.
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { compileOnlyMutationSet, parseCompileOnlyArgs } from "../src/compile-only-args";
import { type MutationSetResult, generateMutationSet } from "../src/orchestrator";
import { scratchDirs } from "./helpers/scratch";

describe("parseCompileOnlyArgs", () => {
  test("parses a full invocation", () => {
    const a = parseCompileOnlyArgs([
      "--project",
      "U:/Git/do-lethal/Cloud",
      "--selector-id",
      "6175466",
      "--control-id",
      "6175467",
      "--table-id",
      "6175468",
      "--alc",
      "C:/alc/alc.exe",
      "--package-cache",
      "U:/Git/do-lethal/Cloud/.alpackages",
      "--control-symbol",
      "U:/Git/LethAL/extensions/lethal-control/lethal-control.app",
    ]);
    expect(a.projectDir).toBe("U:/Git/do-lethal/Cloud");
    expect(a.selectorIds).toEqual({
      selectorId: 6175466,
      controlId: 6175467,
      tableId: 6175468,
    });
    expect(a.controlSymbolPath).toBe("U:/Git/LethAL/extensions/lethal-control/lethal-control.app");
  });

  test("throws naming the missing flag rather than defaulting", () => {
    expect(() => parseCompileOnlyArgs(["--project", "x"])).toThrow(/--selector-id/);
  });

  /**
   * The driver stages this symbol into the package cache itself. Making the flag optional would
   * put the operator back in front of an alc symbol-resolution failure on a hard gate, with
   * nothing naming the cause — so a missing `--control-symbol` has to be refused at parse time.
   */
  test("refuses an invocation with no --control-symbol", () => {
    expect(() =>
      parseCompileOnlyArgs([
        "--project",
        "P",
        "--selector-id",
        "1",
        "--control-id",
        "2",
        "--table-id",
        "3",
        "--alc",
        "alc.exe",
        "--package-cache",
        ".alpackages",
      ]),
    ).toThrow(/--control-symbol/);
  });
});

describe("R379: compile-only enumerates under the config's preprocessor symbols", () => {
  const REPO = resolve(import.meta.dir, "../../..");
  const project = join(REPO, "fixtures/sandbox-symbols");
  const scratch = scratchDirs();
  const base = (extra: string[]): string[] => [
    "--project",
    project,
    "--selector-id",
    "1",
    "--control-id",
    "2",
    "--table-id",
    "3",
    "--alc",
    "alc",
    "--package-cache",
    "pc",
    "--control-symbol",
    "c.app",
    ...extra,
  ];
  const sites = (set: MutationSetResult) =>
    set.files
      .flatMap((f) => f.specs.map((s) => `${f.path}|${s.before.startIndex}|${s.operatorName}`))
      .sort();

  test("--config defaults to <project>/lethal.config.json, as lethal run's", () => {
    expect(parseCompileOnlyArgs(base([])).configPath).toBe(join(project, "lethal.config.json"));
    expect(parseCompileOnlyArgs(base(["--config", "x.json"])).configPath).toBe("x.json");
  });

  test("a config naming LETHALA enumerates LETHALA's arm, as a real [LETHALA] run does", async () => {
    await initParser();
    const dir = scratch("lethal-r379-");
    const config = join(dir, "lethal.config.json");
    await writeFile(config, JSON.stringify({ preprocessorSymbols: ["LETHALA"] }));
    const withA = await compileOnlyMutationSet(parseCompileOnlyArgs(base(["--config", config])));
    expect(withA.configSymbols).toEqual(["LETHALA"]);
    const none = await compileOnlyMutationSet(
      parseCompileOnlyArgs(base(["--config", join(dir, "absent.json")])),
    );
    expect(none.configSymbols).toEqual([]);
    const real = await generateMutationSet(project, { preprocessorSymbols: ["LETHALA"] });
    expect(sites(withA.set)).toEqual(sites(real));
    expect(sites(withA.set)).not.toEqual(sites(none.set));
  });
});
