import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutationSetResult, generateMutationSet } from "../src/orchestrator";

/**
 * R570 at the orchestrator: a codeunit loop `until not Src.FindNextA(Cust)` makes `generateMutationSet`
 * refuse every site of `Src.FindNextA` (counted in `hangRefused`), while `FindNextB`, the same body
 * called outside any loop, emits exactly as many sites as were refused.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

const body = `    begin
        Steps := Steps + 1;
        if Cust.Next() = 0 then
            exit(false);
        exit(Steps < 100);
    end;
`;

const SRC = "src/Src.Codeunit.al";
const SRC_AL = `codeunit 50910 "R570 Src"
{
    procedure FindNextA(var Cust: Record Customer): Boolean
${body}
    procedure FindNextB(var Cust: Record Customer): Boolean
${body}
    var
        Steps: Integer;
}
`;

const LOOP = "src/Loop.Codeunit.al";
const LOOP_AL = `codeunit 50911 "R570 Loop"
{
    procedure Run()
    var
        Cust: Record Customer;
        N: Integer;
    begin
        repeat
            N := N + 1;
        until not Src.FindNextA(Cust);
        Src.FindNextB(Cust);
    end;

    var
        Src: Codeunit "R570 Src";
}
`;

const at = (src: string, marker: string): number =>
  src.split("\n").findIndex((l) => l.includes(marker)) + 1;

let dir = "";
let set: MutationSetResult;
beforeAll(async () => {
  await initParser();
  dir = await mkdtemp(join(tmpdir(), "lethal-r570-"));
  await Bun.write(join(dir, "app.json"), APP_JSON);
  await Bun.write(join(dir, SRC), SRC_AL);
  await Bun.write(join(dir, LOOP), LOOP_AL);
  set = await generateMutationSet(dir, { emit: () => {} });
});
afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("R570: dispatch refuses the cursor callee of another object's loop exit", () => {
  const a = at(SRC_AL, "procedure FindNextA");
  const b = at(SRC_AL, "procedure FindNextB");
  const rows = () =>
    set.files
      .filter((f) => f.path === SRC)
      .flatMap((f) => f.specs.map((s) => s.before.startPosition.row + 1));
  const refused = () => set.hangRefused.find((r) => r.file === SRC)?.sites ?? 0;

  test("no site of FindNextA is emitted, and its sites are counted as hang-refused", () => {
    expect(rows().filter((r) => r > a && r < b)).toEqual([]);
    expect(refused()).toBeGreaterThan(0);
  });

  test("FindNextB, the same body outside any loop exit, emits as many sites as were refused", () => {
    const emitted = rows().filter((r) => r > b);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length).toBe(refused());
  });
});
