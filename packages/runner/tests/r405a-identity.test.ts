import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R-405 (a), plan `docs/superpowers/plans/2026-10-04-R-405a-arm-aware-symbol-table.md` section 3:
 * a newly ADMITTED mutant earlier in a member, with the same identity tuple as an existing one,
 * takes ordinal 0 and moves the existing mutant's key for UNCHANGED source. That is a key move, so
 * the identity scheme must be 8 or later. Both halves are pinned together: leaving the scheme at 7
 * turns the first test red, and the second proves the move is real, not a renaming of the test.
 */

const TABLE_A = `table 50400 "A Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
    trigger OnModify()
    begin
        Error('a');
    end;
}
`;

// B's OnModify sits inside a MEMBER-level #if. Before R-405 (a) no build saw it, so `B.Modify()`
// drew no swap-modify-flag mutant. Under [X] the arm is compiled and the mutant is admitted.
const TABLE_B = `table 50401 "B Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
#if X
    trigger OnModify()
    begin
        Error('b');
    end;
#endif
}
`;

const OPS = `codeunit 50410 "Twin Ops"
{
    procedure Run()
    var
        A: Record "A Tab";
        B: Record "B Tab";
    begin
        B.Modify();
        A.Modify();
    end;
}
`;

const FILES: Record<string, string> = {
  "src/ATab.Table.al": TABLE_A,
  "src/BTab.Table.al": TABLE_B,
  "src/Ops.Codeunit.al": OPS,
};

const SWAP = "lethal.swap-modify-flag";

type KeyRow = { line: number; key: string; ordinal: number };

async function swapKeys(symbols: readonly string[]): Promise<KeyRow[]> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r405a-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r405a-out-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    for (const [rel, text] of Object.entries(FILES)) await Bun.write(join(dir, rel), text);
    const set = await generateMutationSet(dir, { preprocessorSymbols: symbols, emit: () => {} });
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "00000000-0000-0000-0000-000000000000",
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set),
    });
    const manifest = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8"));
    const rows: KeyRow[] = [];
    for (const e of manifest.mutants) {
      if (e.operatorName !== SWAP) continue;
      if (e.file.replaceAll("\\", "/") !== "src/Ops.Codeunit.al") continue;
      const id = identityKeyOf(e);
      rows.push({
        line: OPS.slice(0, e.startIndex).split("\n").length,
        key: serializeKey(id),
        ordinal: id.ordinal,
      });
    }
    return rows.sort((a, b) => a.line - b.line);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

const lineOf = (needle: string): number => {
  const at = OPS.indexOf(needle);
  if (at < 0) throw new Error(`not in OPS: ${needle}`);
  return OPS.slice(0, at).split("\n").length;
};

let off: KeyRow[];
let on: KeyRow[];

beforeAll(async () => {
  await initParser();
  off = await swapKeys([]);
  on = await swapKeys(["X"]);
});

describe("R-405 (a): a newly admitted same-tuple twin moves a key", () => {
  test("the identity scheme is 23 (8 for this key move, 9 R307, 10 R196, 11 R295/R294, 13 R455, 14 R454, 16 R-364, 17 R254, 18 R-458, 19 R468, 20 unused, 21 R459, 22 R-464, 23 R446)", () => {
    expect(IDENTITY_SCHEME).toBe(23);
  });

  test("under [X] B.Modify() takes ordinal 0 and A.Modify()'s key moves to ordinal 1", () => {
    const lineB = lineOf("B.Modify()");
    const lineA = lineOf("A.Modify()");
    // Without X, B's OnModify is compiled out: only A.Modify() has a mutant, and it holds ordinal 0.
    expect(off.map((r) => r.line)).toEqual([lineA]);
    const aOff = off[0]?.key ?? "";
    expect(off[0]?.ordinal).toBe(0);
    // With X both exist; they share the tuple, B comes first in source order.
    expect(on.map((r) => r.line)).toEqual([lineB, lineA]);
    const [bOn, aOn] = on;
    expect(bOn?.ordinal).toBe(0);
    expect(bOn?.key).toBe(aOff);
    expect(aOn?.ordinal).toBe(1);
    expect(aOn?.key).toBe(`${aOff}|1`);
    expect(aOn?.key).not.toBe(aOff);
  });
});
