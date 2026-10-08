import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME, identitySiteKey } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf } from "../src/orchestrator";

/**
 * R254: the identity tuple names the OBJECT NAME, not its kind or id, and a skipped (non-carrier)
 * file reserves no ordinals. A reportextension and a codeunit may share a name. Before R254 the
 * extension `A` was skipped, so the codeunit's mutant was the only holder of its tuple (ordinal 0).
 * Admitting the extension, which sorts first, gives it ordinal 0 and moves the codeunit's key to
 * ordinal 1 for UNCHANGED source: a key move, so scheme 17 (15 was reserved for it; R-364 took 16). A later change that made skipped files
 * reserve ordinals would turn the first test red, and the scheme reasoning would need revisiting.
 */
const FILES: Record<string, string> = {
  "src/A.ReportExt.al": `reportextension 50101 "Twin" extends "Base Rep"
{
    procedure P(N: Integer): Integer
    begin
        exit(N + 1);
    end;
}
`,
  "src/B.Report.al": `report 50100 "Base Rep"
{
    ProcessingOnly = true;
}
`,
  "src/Z.Codeunit.al": `codeunit 50102 "Twin"
{
    procedure P(N: Integer): Integer
    begin
        exit(N + 1);
    end;
}
`,
};

let ordinal: number | undefined;

beforeAll(async () => {
  await initParser();
  const dir = await mkdtemp(join(tmpdir(), "lethal-r254-id-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    for (const [rel, text] of Object.entries(FILES)) await Bun.write(join(dir, rel), text);
    const set = await generateMutationSet(dir, { emit: () => {} });
    const ordinals = identityOrdinalsOf(set);
    const cu = set.files.find((f) => f.path === "src/Z.Codeunit.al");
    const spec = cu?.specs.find((s) => s.operatorName === "lethal.return-value");
    if (cu === undefined || spec === undefined) {
      throw new Error("no return-value mutant in the codeunit");
    }
    ordinal = ordinals.get(
      identitySiteKey(cu.path, spec.before.startIndex, spec.before.endIndex, spec.operatorName),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("R254: admitting a reportextension moves a same-named twin's key", () => {
  test("the codeunit's return-value mutant takes ordinal 1 (it was 0 while the extension was skipped)", () => {
    expect(ordinal).toBe(1);
  });
  test("so the identity scheme is 33 (17 for R254, 18 R-458, 19 R468, 20, 23 and 31 unused, 21 R459, 22 R-464, 24 R475, 25 R446, 26 R477, 27 R480, 28 R484, 29 R-300b, 30 R487, 32 R509, 33 R501)", () => {
    expect(IDENTITY_SCHEME).toBe(33);
  });
});
