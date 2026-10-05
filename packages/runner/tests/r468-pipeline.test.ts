import { afterAll, describe, expect, it } from "bun:test";
/**
 * R468, through the whole pipeline (`generateMutationSet`, then `dedupeSpecs`, the deployed set): a
 * `Record` global declared in an object's SECOND var section is a resolved receiver.
 *
 * Revert (first section only) turns every test here red: the deletion at `R.SetRange` stays
 * `void-method-call`, `R.Modify(true)` stays a `flip-boolean-literal`, and `S.Modify(false)` is
 * tagged `run-trigger-forced` because its receiver is unresolved (R460) although table U has no
 * `OnModify`. `R.Modify(false)` staying `run-trigger-forced` is the unchanged positive control
 * (T has an `OnModify`, so it is tagged either way); the U assertion is what turns that test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeSpecs } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

const dir = mkdtempSync(join(tmpdir(), "r468-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, "app.json"),
  JSON.stringify({
    id: "4f6b1d0e-7c1a-4e58-9c58-3a1f0a4e6801",
    name: "R468",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 50480, to: 50489 }],
    runtime: "13.0",
  }),
);
mkdirSync(join(dir, "src"));
writeFileSync(
  join(dir, "src", "T.Table.al"),
  `table 50480 T
{
    fields { field(1; Code; Code[20]) { } }
    keys { key(PK; Code) { } }

    trigger OnModify()
    begin
        Code := 'M';
    end;
}
`,
);
writeFileSync(
  join(dir, "src", "U.Table.al"),
  `table 50481 U
{
    fields { field(1; Code; Code[20]) { } }
    keys { key(PK; Code) { } }
}
`,
);
writeFileSync(
  join(dir, "src", "Ops.Codeunit.al"),
  `codeunit 50482 Ops
{
    procedure P()
    begin
        R.SetRange(Code, 'X');
        R.Modify(true);
        R.Modify(false);
        S.Modify(false);
    end;

    protected var
        A: Boolean;

    var
        R: Record T;
        S: Record U;
}
`,
);

describe("R468: a second-section Record global through the whole pipeline", () => {
  async function specsAt(needle: string): Promise<string[]> {
    const set = await generateMutationSet(dir, { emit: () => {} });
    const ops = set.files.find((f) => f.path.endsWith("Ops.Codeunit.al"));
    if (ops === undefined) throw new Error("Ops.Codeunit.al not instrumented");
    const start = ops.source.indexOf(needle);
    const end = start + needle.length;
    // The DEPLOYED set: `files.specs` is every site; precedence drops the losers here, as
    // `writeInstrumentedProject` and the dry run do.
    return dedupeSpecs(ops.specs, (name) => operatorTiers.get(name))
      .filter((s) => s.before.startIndex >= start && s.before.endIndex <= end)
      .map((s) => `${s.operatorName} ${s.platformKillMechanism ?? "-"}`)
      .sort();
  }

  it("R.SetRange: exactly one deletion, remove-setrange", async () => {
    const at = await specsAt("R.SetRange(Code, 'X')");
    expect(
      at.filter((s) => s.includes("void-method-call") || s.includes("remove-setrange")),
    ).toEqual(["lethal.remove-setrange -"]);
  });

  it("R.Modify(true): swap-modify-flag, and no flip of the literal", async () => {
    const at = await specsAt("R.Modify(true)");
    expect(at.some((s) => s.startsWith("lethal.swap-modify-flag"))).toBe(true);
    expect(at.some((s) => s.startsWith("lethal.flip-boolean-literal"))).toBe(false);
  });

  it("Modify(false): forced on T (has OnModify), untagged on U (has none)", async () => {
    expect(
      (await specsAt("R.Modify(false)")).filter((s) => s.startsWith("lethal.flip-boolean-literal")),
    ).toEqual(["lethal.flip-boolean-literal run-trigger-forced"]);
    expect(
      (await specsAt("S.Modify(false)")).filter((s) => s.startsWith("lethal.flip-boolean-literal")),
    ).toEqual(["lethal.flip-boolean-literal -"]);
  });
});
