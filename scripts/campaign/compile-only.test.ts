import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "../../packages/engine/src";
import { generateMutationSet } from "../../packages/runner/src/orchestrator";
import { flatNamesFor } from "../../packages/schemata/src";
import { stageCompileOnlyBatch } from "./compile-only";

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
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
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
