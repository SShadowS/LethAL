import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  withRunIdentityOrdinals,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

// R295 / R294 through the real pipeline: the DEPLOYED manifest, not operator output alone. Invented
// names only. The `with` case (sol-review r1 point 5): `types.ts` ignored `with` scope, so inside
// `with R do` a name R's table also declares was typed by the local, and once R295 made a later
// local name visible a swap the compiler rejects became possible. `alc` 18.0 compiles `Adv.al`
// below as written (Z inside the `with` is R's Text field, so `Take(Q, Z)` is Integer, Text) and
// would reject `Take(Z, Q)`; the plain `Q: Integer; Z: Integer` arm was emitted that way before.

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000092650",
  name: "r295",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 92650, to: 92699 }],
};

const ADV = `table 92650 "R295 WithRec"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Z; Text[50]) { }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}

codeunit 92650 "R295 Adv"
{
    var
        Z: Text;

    procedure Take(A: Integer; B: Text)
    begin
    end;

    procedure TakeInts(A: Integer; B: Integer)
    begin
    end;

    procedure WithMulti()
    var
        R: Record "R295 WithRec";
        Q, Z: Integer;
    begin
        with R do begin
            Take(Q, Z);
        end;
    end;

    procedure WithSingle()
    var
        R: Record "R295 WithRec";
        Q: Integer;
        Z: Integer;
    begin
        with R do begin
            Take(Q, Z);
        end;
    end;

    procedure LaterNameSwapped()
    var
        Q, Z: Integer;
    begin
        TakeInts(Q, Z);
    end;
}
`;

async function instrument(files: Record<string, string>) {
  const src = await mkdtemp(join(tmpdir(), "lethal-r295-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r295-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
    for (const [name, text] of Object.entries(files)) await writeFile(join(src, name), text);
    const set = await generateMutationSet(src);
    await writeInstrumentedProject(
      withRunIdentityOrdinals({
        targetDir: out,
        files: set.files,
        selectorIds: { selectorId: 92697, controlId: 92698, tableId: 92699 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: APP_JSON.id,
        operatorTiers,
      }),
    );
    const manifest = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    return { set, manifest };
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

const lineOf = (needle: string, nth = 0): number => {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = ADV.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`no ${needle}`);
  return ADV.slice(0, at).split("\n").length;
};

let manifest: MutantManifest;
beforeAll(async () => {
  await initParser();
  ({ manifest } = await instrument({ "Adv.Codeunit.al": ADV }));
});

const swapsAt = (line: number): string[] =>
  manifest.mutants
    .filter((m) => m.startLine === line && m.operatorName === "lethal.swap-call-arguments")
    .map((m) => m.procedureName);

describe("R295 + with-scope: the deployed manifest", () => {
  test("a later name inside `with R do`, where R's table declares that name: no swap", () => {
    expect(swapsAt(lineOf("Take(Q, Z)", 0))).toEqual([]);
  });

  test("the same with a single-name local (the older shape of the same hazard): no swap", () => {
    expect(swapsAt(lineOf("Take(Q, Z)", 1))).toEqual([]);
  });

  test("a later name of truly equal type outside any `with` IS swapped", () => {
    expect(swapsAt(lineOf("TakeInts(Q, Z)"))).toEqual(["LaterNameSwapped"]);
  });
});

describe("R295: a #if between two names of one declaration", () => {
  test("is not half-read: the file is excluded as undecided, as before", async () => {
    const { set } = await instrument({
      "P2.Codeunit.al": `codeunit 92651 "R295 Split Names"
{
    procedure P()
    var
        A,
#if X
        B,
#endif
        C: Integer;
    begin
        C := 1;
    end;
}
`,
    });
    expect(set.files).toEqual([]);
    expect(set.preprocExcluded.map((e) => [e.file, e.reason])).toEqual([
      ["P2.Codeunit.al", "preproc-undecided"],
    ]);
  });
});

test("R295/R294: the identity scheme is 30 (11 for R295/R294, 13 R455, 14 R454, 16 R-364, 17 R254, 18 R-458, 19 R468, 20 and 23 unused, 21 R459, 22 R-464, 24 R475, 25 R446, 26 R477, 27 R480, 28 R484, 29 R-300b, 30 R487)", () => {
  expect(IDENTITY_SCHEME).toBe(30);
});
