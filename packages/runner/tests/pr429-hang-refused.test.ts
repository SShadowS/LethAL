import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { generateMutationSet } from "../src/orchestrator";
import { removeScratchDir } from "./helpers/scratch";

/**
 * PR-429 (R1212): the two loop-cursor refusals are counted as `hang-refused` (R447), one site each.
 * Invented AL only.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});
const FILE = "src/Cursor.Codeunit.al";
const AL = `codeunit 50429 "Cursor"
{
    procedure Search(Id: Integer)
    var
        R: Record Customer;
        Other: Record Customer;
        Found: Text;
    begin
        repeat
            Found := 'x';
        until (Found <> '') or (R.Next() = 0);
    end;

    procedure Restore(Id: Integer)
    var
        R: Record Customer;
        Other: Record Customer;
    begin
        if R.FindSet() then
            repeat
                R := Other;
                R.Get(Id);
            until R.Next() = 0;
    end;

    procedure Plain()
    var
        Other: Record Customer;
    begin
        Other.Modify();
    end;
}
`;

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(() => {
  for (const r of roots) removeScratchDir(r);
});

async function hangRefused(operator: string) {
  const root = await mkdtemp(join(tmpdir(), "lethal-pr429-"));
  roots.push(root);
  await Bun.write(join(root, "app.json"), APP_JSON);
  await Bun.write(join(root, FILE), AL);
  const set = await generateMutationSet(root, { emit: () => {}, operators: [operator] });
  return set.hangRefused;
}

describe("PR-429: counted as hang-refused", () => {
  test("rule 1: the nested Next end test under negate-conditional is one refused site", async () => {
    expect(await hangRefused("lethal.negate-conditional")).toEqual([
      { file: FILE, kinds: "codeunit_declaration", sites: 1 },
    ]);
  });

  test("rule 2: the deleted restoring Get under void-method-call is one refused site", async () => {
    expect(await hangRefused("lethal.void-method-call")).toEqual([
      { file: FILE, kinds: "codeunit_declaration", sites: 1 },
    ]);
  });
});
