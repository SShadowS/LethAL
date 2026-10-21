import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "../../packages/engine/src";
import type { ArtifactIo } from "../../packages/runner/src/artifact";
import { generateMutationSet } from "../../packages/runner/src/orchestrator";
import { removeScratchDir } from "../../packages/runner/tests/helpers/scratch";
import { flatNamesFor } from "../../packages/schemata/src";
import { compileOnly, stageCompileOnlyBatch } from "./compile-only";

// R219 (sol run 001, finding 3): the compile-only batch is written by two writers, which must name
// a duplicate basename alike. Only Sales/Helper has a mutation site; Purchase/Helper has none, so
// the instrumented writer sees Sales alone while the copy sees both.
const SALES = "Sales/Helper.Codeunit.al";
const PURCHASE = "Purchase/Helper.Codeunit.al";
const SALES_AL = `codeunit 50100 "Sales Helper"
{
    procedure Pick(X: Integer): Integer
    begin
        if X > 1 then
            exit(1);
        exit(0);
    end;
}
`;
const PURCHASE_AL = `codeunit 50101 "Purchase Helper"
{
}
`;
const APP = {
  id: "21921921-2192-4192-8192-219219219219",
  name: "R219",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50100, to: 50199 }],
};

let root = "";
beforeAll(async () => {
  await initParser();
  root = await mkdtemp(join(tmpdir(), "lethal-r219-compile-only-"));
});
afterAll(() => {
  removeScratchDir(root);
});

describe("stageCompileOnlyBatch (R219)", () => {
  test("a duplicate with mutants and one without each appear ONCE, under their own flat names", async () => {
    const projectDir = join(root, "app");
    const target = join(root, "batch");
    await Bun.write(join(projectDir, "app.json"), JSON.stringify(APP));
    await Bun.write(join(projectDir, SALES), SALES_AL);
    await Bun.write(join(projectDir, PURCHASE), PURCHASE_AL);
    const set = await generateMutationSet(projectDir);
    expect(set.files.map((f) => f.path)).toEqual([SALES]);

    await stageCompileOnlyBatch({
      projectDir,
      target,
      set,
      selectorIds: { selectorId: 50197, controlId: 50198, tableId: 50199 },
      artifactId: "a".repeat(32),
      targetAppId: APP.id,
      appManifest: APP,
    });

    const names = flatNamesFor([SALES, PURCHASE]);
    const helpers = (await readdir(target)).filter((f) => f.startsWith("Helper."));
    expect(helpers.sort()).toEqual([names.flatOf(SALES), names.flatOf(PURCHASE)].sort());
    const sales = await readFile(join(target, names.flatOf(SALES)), "utf8");
    // The instrumented Sales (its guard calls the selector), not the original copied over it.
    expect(sales).not.toBe(SALES_AL);
    expect(sales).toContain('codeunit 50100 "Sales Helper"');
    expect(await readFile(join(target, names.flatOf(PURCHASE)), "utf8")).toBe(PURCHASE_AL);
  });
});

describe("compileOnly (R552): the --package-cache is never written", () => {
  async function run(name: string, exitCode: number) {
    const projectDir = join(root, `${name}-app`);
    await Bun.write(join(projectDir, "app.json"), JSON.stringify(APP));
    await Bun.write(join(projectDir, SALES), SALES_AL);
    const cache = join(root, `${name}-cache`);
    await mkdir(cache, { recursive: true });
    const other = join(cache, "Microsoft_System_1.0.0.0.app");
    await Bun.write(other, "system-symbol-bytes");
    const past = new Date("2020-01-02T03:04:05Z");
    await utimes(other, past, past);
    const controlSymbolPath = join(root, `${name}-control`, "lethal-control.app");
    await Bun.write(controlSymbolPath, "control-symbol-bytes");
    const listing = async () =>
      Promise.all(
        (await readdir(cache)).sort().map(async (n) => {
          const s = await stat(join(cache, n));
          const sha = Bun.SHA256.hash(await readFile(join(cache, n)), "hex");
          return `${n} ${s.size} ${sha} ${s.mtimeMs}`;
        }),
      );
    const before = await listing();

    let caches: string[] = [];
    let held: string[] = [];
    let seen = "";
    const io: ArtifactIo = {
      spawn: async (argv) => {
        caches = argv.filter((a) => a.startsWith("/packagecachepath:"));
        const copy = caches[0]?.slice("/packagecachepath:".length) ?? "";
        held = (await readdir(copy)).sort();
        seen = await readFile(join(copy, "lethal-control.app"), "utf8");
        return exitCode === 0
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode, stdout: "", stderr: "AL0001: boom" };
      },
      readArtifact: async () => new TextEncoder().encode("x"),
      writeArtifact: async () => {},
    };
    const outcome = await compileOnly(
      {
        projectDir,
        selectorIds: { selectorId: 50197, controlId: 50198, tableId: 50199 },
        alcPath: "alc",
        packageCachePath: cache,
        controlSymbolPath,
        configPath: join(root, "no-such-config.json"),
      },
      io,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    const copy = (caches[0] ?? "").slice("/packagecachepath:".length);
    return { outcome, caches, held, seen, copy, before, after: await listing() };
  }

  test("alc gets EXACTLY ONE path, a copy with the symbol; the cache listing is unchanged", async () => {
    const r = await run("r552", 0);
    expect(r.outcome).toBeUndefined();
    expect(r.caches).toHaveLength(1);
    expect(r.copy).not.toContain(";");
    expect(r.held).toEqual(["Microsoft_System_1.0.0.0.app", "lethal-control.app"]);
    expect(r.seen).toBe("control-symbol-bytes");
    expect(r.after).toEqual(r.before);
    await expect(stat(r.copy)).rejects.toThrow();
  });

  test("a failed alc compile still removes the copy (the finally)", async () => {
    const r = await run("r552-fail", 1);
    expect(r.outcome).toBeInstanceOf(Error);
    expect(r.held).toContain("lethal-control.app");
    await expect(stat(r.copy)).rejects.toThrow();
    expect(r.after).toEqual(r.before);
  });
});
