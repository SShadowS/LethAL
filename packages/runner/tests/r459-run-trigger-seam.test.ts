import { afterAll, beforeAll, describe, expect, it } from "bun:test";
/**
 * R459, through the whole pipeline: who owns each RunTrigger literal, `swap-modify-flag` (Tier 2)
 * or `flip-boolean-literal` (Tier 1)? Both now ask ONE engine answer, `claimedRunTriggerSkip`: Tier 2
 * claims what it returns and Tier 1 cedes exactly that literal. Every literal below must have
 * exactly ONE owner (none is an orphan, two is a duplicate), and the owner is pinned per shape.
 *
 * Then the identity consequence: a two-argument Insert's literals are new flips, so a later
 * same-tuple `true` twin in the procedure moves ordinal (IDENTITY_SCHEME 21).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { IDENTITY_SCHEME, dedupeSpecs, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

const FLIP = "lethal.flip-boolean-literal";
const SWAP = "lethal.swap-modify-flag";

function project(prefix: string, files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: "4f6b1d0e-7c1a-4e58-9c58-3a1f0a4e6459",
      name: "R459",
      publisher: "LethAL",
      version: "1.0.0.0",
      idRanges: [{ from: 50590, to: 50599 }],
      runtime: "13.0",
    }),
  );
  mkdirSync(join(dir, "src"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
  return dir;
}

const PAR = `table 50590 Par
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { } }

    trigger OnInsert()
    begin
        "No." := 'X';
    end;
}
`;

// Ownership lines. One call per line, so a line names a shape.
const LINES = [
  "Par.Insert(true);",
  "Par.Insert(/* c */ true);",
  "Par.Insert(true, true);",
  "Par.Insert(false, true);",
  "Par.Insert(true, false);",
  "Par.Insert(true, true, true);",
  "Par.Insert();",
  "Par.Modify(true);",
  "Par.Delete(true);",
  "Par.Modify(false);",
  "Mgt.Modify(true);",
  "Nam.Delete(true);",
] as const;

const seamDir = project("r459-seam-", {
  "P.Table.al": PAR,
  // Cross-file namesake: a tableextension of Nam declares `Delete`, so `Nam.Delete(true)` is that
  // procedure, not the builtin, and neither claimed nor ceded.
  "N.Table.al": `table 50591 Nam\n{\n    fields { field(1; "No."; Code[20]) { } }\n    keys { key(PK; "No.") { } }\n}\n`,
  "NX.TableExt.al": `tableextension 50592 "Nam Ext" extends Nam\n{\n    procedure Delete(Run: Boolean)\n    begin\n    end;\n}\n`,
  "M.Codeunit.al":
    "codeunit 50593 Mgt\n{\n    procedure Modify(Run: Boolean)\n    begin\n    end;\n}\n",
  "O.Codeunit.al": `codeunit 50594 Ops\n{\n    procedure P()\n    var\n        Par: Record Par;\n        Nam: Record Nam;\n        Mgt: Codeunit Mgt;\n    begin\n${LINES.map((l) => `        ${l}\n`).join("")}    end;\n}\n`,
  // A codeunit wrapped whole in `#if` is not indexed, so its receiver does not resolve.
  "W.Codeunit.al":
    "#if not CLEANX\ncodeunit 50595 Wrapped\n{\n    procedure P()\n    var\n        Par: Record Par;\n    begin\n        Par.Modify(true);\n    end;\n}\n#endif\n",
});
afterAll(() => rmSync(seamDir, { recursive: true, force: true }));

/** Per literal of `line` in `file`: its owners, as `<op> <after> <tag>`. */
async function ownersOf(file: string, line: string): Promise<string[][]> {
  const set = await generateMutationSet(seamDir, { emit: () => {} });
  const f = set.files.find((x) => x.path.endsWith(file));
  if (f === undefined) throw new Error(`${file} not instrumented`);
  const start = f.source.indexOf(line);
  if (start < 0) throw new Error(`no ${line}`);
  const end = start + line.length;
  const specs = dedupeSpecs(f.specs, (name) => operatorTiers.get(name)).filter(
    (s) => s.before.startIndex >= start && s.before.endIndex <= end,
  );
  const literals = [...line.matchAll(/\b(true|false)\b/gi)].map((m) => start + (m.index ?? 0));
  return literals.map((at) => {
    const owners: string[] = [];
    for (const s of specs) {
      const tag = s.platformKillMechanism ?? "-";
      if (s.operatorName === FLIP && s.before.startIndex === at) {
        owners.push(`flip ${s.after.text} ${tag}`);
      }
      // The literal a swap rewrites is where its before and after text first differ.
      if (s.operatorName === SWAP) {
        const b = s.before.text;
        const a = s.after.text;
        let i = 0;
        while (i < b.length && b[i] === a[i]) i++;
        if (s.before.startIndex + i === at) owners.push(`swap ${a} ${tag}`);
      }
    }
    return owners;
  });
}

const SKIPPED = "run-trigger-skipped-insert";

describe("R459: one owner per RunTrigger literal (Tier 1 and Tier 2 together)", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Each row: the line, and per literal its sole owner. Reverts, each red on the rows named:
  //  - flip cedes every `true` of a claimed Insert (pre-R459): the two- and three-argument rows
  //    lose their `true` owners (orphans).
  //  - flip cedes any sole `true` of a Modify/Insert/Delete by NAME (no receiver claim): the Mgt,
  //    Nam and wrapped rows lose their owner.
  //  - `claimedRunTriggerSkip` reads raw `namedChildren[0]`: the commented row loses its owner.
  //  - `claimedRunTriggerSkip` accepts a two-argument Insert's first literal: those rows move
  //    their first owner to swap (and the twin-key test below goes red too).
  const EXPECTED: Record<(typeof LINES)[number], string[][]> = {
    "Par.Insert(true);": [[`swap Par.Insert(false) ${SKIPPED}`]],
    "Par.Insert(/* c */ true);": [[`swap Par.Insert(/* c */ false) ${SKIPPED}`]],
    "Par.Insert(true, true);": [[`flip false ${SKIPPED}`], ["flip false -"]],
    "Par.Insert(false, true);": [["flip true run-trigger-forced"], ["flip false -"]],
    "Par.Insert(true, false);": [[`flip false ${SKIPPED}`], ["flip true -"]],
    "Par.Insert(true, true, true);": [["flip false -"], ["flip false -"], ["flip false -"]],
    "Par.Insert();": [],
    "Par.Modify(true);": [["swap Par.Modify(false) -"]],
    "Par.Delete(true);": [["swap Par.Delete(false) -"]],
    "Par.Modify(false);": [["flip true -"]],
    "Mgt.Modify(true);": [["flip false -"]],
    "Nam.Delete(true);": [["flip false -"]],
  };
  for (const line of LINES) {
    it(`${line}`, async () => {
      expect(await ownersOf("O.Codeunit.al", line)).toEqual(EXPECTED[line]);
    });
  }

  // Unresolved receiver: not claimed, so not ceded. R473: the flip keeps the skip tag, since
  // nothing proves skipping `OnModify` harmless (R-364's rule).
  it("Par.Modify(true) on an unresolved receiver: flip owns it, tagged", async () => {
    expect(await ownersOf("W.Codeunit.al", "Par.Modify(true);")).toEqual([
      ["flip false run-trigger-skipped-modify"],
    ]);
  });
});

/**
 * The key move behind IDENTITY_SCHEME 21, as in BC.History's `Graph Mgt - Attachment Buffer`: a
 * `true` twin before and after an `Insert(true, true)` in one procedure. Before R459 the Insert's
 * literals were ceded and emitted nothing, so the last twin held ordinal 1. Now they are flips at
 * ordinals 1 and 2, and the last twin moves to 3: the same source, a different key.
 */
const TWINS = `codeunit 50596 Twins
{
    procedure P()
    var
        Par: Record Par;
        Flag: Boolean;
    begin
        Flag := true;
        Par.Insert(true, true);
        Flag := true;
    end;
}
`;

describe("R459: an Insert(true, true) moves a later twin's key", () => {
  type Row = { line: number; ordinal: number; key: string };
  let rows: Row[] = [];

  beforeAll(async () => {
    await initParser();
    const dir = project("r459-twins-", { "P.Table.al": PAR, "T.Codeunit.al": TWINS });
    const out = await mkdtemp(join(tmpdir(), "r459-twins-out-"));
    try {
      const set = await generateMutationSet(dir, { emit: () => {} });
      await writeInstrumentedProject({
        targetDir: out,
        files: set.files,
        selectorIds: { selectorId: 50597, controlId: 50598, tableId: 50599 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "4f6b1d0e-7c1a-4e58-9c58-3a1f0a4e6459",
        operatorTiers,
        identityOrdinals: identityOrdinalsOf(set),
      });
      const manifest = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8"));
      rows = [];
      for (const e of manifest.mutants) {
        if (e.operatorName !== FLIP || !String(e.file).endsWith("T.Codeunit.al")) continue;
        const id = identityKeyOf(e);
        rows.push({
          line: TWINS.slice(0, e.startIndex).split("\n").length,
          ordinal: id.ordinal,
          key: serializeKey(id),
        });
      }
      rows.sort((a, b) => a.line - b.line || a.ordinal - b.ordinal);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  // Revert: cede every `true` of a claimed Insert (pre-R459). The Insert rows vanish and the last
  // twin is back at ordinal 1.
  it("the four `true` flips take ordinals 0..3 and the last twin's key is the first's |3", () => {
    expect(rows.map((r) => [r.line, r.ordinal])).toEqual([
      [8, 0],
      [9, 1],
      [9, 2],
      [10, 3],
    ]);
    const first = rows[0];
    const last = rows[3];
    if (first === undefined || last === undefined) throw new Error("rows");
    expect(last.key).toBe(`${first.key}|3`);
  });

  it("the identity scheme is 25 (21 for R459; 20 and 23 unused; 22 R-464; 24 R475; 25 R446)", () => {
    expect(IDENTITY_SCHEME).toBe(25);
  });
});
