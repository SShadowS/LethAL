import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { identityKeyOf } from "../src/selection";

/**
 * R477: `validate-to-assign`'s bare fallback adds a mutant that can share an identity tuple with an
 * existing one EARLIER in the same procedure, so the existing mutant's key moves for unchanged
 * source (sol's review of the R-477 plan, finding 1). Table T has its own `Name`; `Cust` is a
 * record over a dependency table. The call inside `with Cust do` was refused before R477 (no
 * provable receiver spelling) and now emits `Name := 'X'`; the outer call always emitted
 * `Rec.Name := 'X'`. Both have the same before-subtree, object, procedure and operator, so the new
 * one takes ordinal 0 and the old one moves to 1. That is why the scheme is 26.
 */
const TABLE = `table 50477 T
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
    procedure P(var Cust: Record Customer)
    begin
        with Cust do begin
            Validate(Name, 'X');
        end;
        Validate(Name, 'X');
    end;
}
`;

type Row = { after: string; ordinal: number };
let rows: Row[];

beforeAll(async () => {
  await initParser();
  const dir = await mkdtemp(join(tmpdir(), "lethal-r477-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r477-out-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    await Bun.write(join(dir, "src/T.Table.al"), TABLE);
    const set = await generateMutationSet(dir, { emit: () => {} });
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
    rows = manifest.mutants
      .filter((e: { operatorName: string }) => e.operatorName === "lethal.validate-to-assign")
      .map((e: { mutatedText: string; startIndex: number }) => ({
        after: e.mutatedText,
        ordinal: identityKeyOf(e as Parameters<typeof identityKeyOf>[0]).ordinal,
        at: e.startIndex,
      }))
      .sort((a: { at: number }, b: { at: number }) => a.at - b.at)
      .map(({ after, ordinal }: Row) => ({ after, ordinal }));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

describe("R477: the bare fallback moves a same-tuple twin's key", () => {
  test("the identity scheme is 32 (26 for this key move, 25 R446, 27 R480, 28 R484, 29 R-300b, 30 R487, 31 R-501, 32 R509)", () => {
    expect(IDENTITY_SCHEME).toBe(32);
  });

  test("the new bare mutant takes ordinal 0 and the old Rec.Name mutant moves to ordinal 1", () => {
    expect(rows).toEqual([
      { after: "Name := 'X'", ordinal: 0 },
      { after: "Rec.Name := 'X'", ordinal: 1 },
    ]);
  });
});
