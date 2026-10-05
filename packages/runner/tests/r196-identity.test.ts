import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R196 (plan `docs/superpowers/plans/2026-10-05-R-196-refuse-hang-capable-sites.md` section 4.5):
 * refusing a site that is an EARLIER identity twin moves a later twin's key onto the refused one's
 * old key, for unchanged source. Three identical `Done := true` flips: the middle one writes the
 * repeat's exit flag and is now refused, so the last one takes ordinal 1, the key the middle one
 * held under scheme 9. That is a key move, so the scheme must be 10 or later.
 */
const SRC = `codeunit 50420 "Twin Flips"
{
    procedure Run()
    var
        Done: Boolean;
    begin
        Done := true;
        repeat
            Done := true;
        until Done;
        Done := true;
    end;
}
`;

type KeyRow = { line: number; key: string; ordinal: number };
let rows: KeyRow[];

beforeAll(async () => {
  await initParser();
  const dir = await mkdtemp(join(tmpdir(), "lethal-r196-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r196-out-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    await Bun.write(join(dir, "src", "Twin.Codeunit.al"), SRC);
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
    rows = [];
    for (const e of manifest.mutants) {
      if (e.operatorName !== "lethal.flip-boolean-literal") continue;
      const id = identityKeyOf(e);
      rows.push({
        line: SRC.slice(0, e.startIndex).split("\n").length,
        key: serializeKey(id),
        ordinal: id.ordinal,
      });
    }
    rows.sort((a, b) => a.line - b.line);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

describe("R196: refusing an earlier identity twin moves a later twin's key", () => {
  test("the identity scheme is 23 (10 for this key move, 11 R295/R294, 13 R455, 14 R454, 16 R-364, 17 R254, 18 R-458, 19 R468, 21 R459, 22 R-464, 23 R446)", () => {
    expect(IDENTITY_SCHEME).toBe(23);
  });

  test("the in-loop flip is refused and the last flip takes ordinal 1, the refused one's old key", () => {
    expect(rows.map((r) => r.line)).toEqual([7, 11]);
    const [first, last] = rows;
    expect(first?.ordinal).toBe(0);
    expect(last?.ordinal).toBe(1);
    expect(last?.key).toBe(`${first?.key}|1`);
  });
});
