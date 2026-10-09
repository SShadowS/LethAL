import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

// R455 item 2. Against a record scope an unqualified call binds to the TABLE's method before the
// object's own procedure. Measured with alc 18.0.43 on this exact source: every `T := F() + F()`
// below compiles (Text + Text, the table's `F(): Text` wins), and `I := F() + F()` outside `with`
// compiles (the codeunit's `F(): Integer`). Typing `F()` by the object let `swap-additive` emit
// `F() - F()` on Text, AL0175. Invented names only.

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000092810",
  name: "r455rs",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "13.0",
  idRanges: [{ from: 92800, to: 92849 }],
};

const TABLE = `table 92800 "R455 T"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Amount; Decimal) { }
    }
    keys { key(PK; Code) { Clustered = true; } }

    procedure F(): Text
    begin
        exit('t');
    end;
}
`;

const WITH_LINE = `        with R do
            T := F() + F(); // WITH
`;

const codeunitW = (withLine: string): string => `codeunit 92800 "R455 W"
{
    procedure F(): Integer
    begin
        exit(1);
    end;

    procedure Go()
    var
        R: Record "R455 T";
        T: Text;
        I: Integer;
    begin
${withLine}        I := F() + F(); // OUTSIDE
    end;
}
`;

const PAGE = `page 92800 "R455 P"
{
    SourceTable = "R455 T";

    procedure F(): Integer
    begin
        exit(1);
    end;

    trigger OnOpenPage()
    var
        T: Text;
    begin
        T := F() + F(); // PAGE
    end;
}
`;

const ONRUN = `codeunit 92801 "R455 U"
{
    TableNo = "R455 T";

    procedure F(): Integer
    begin
        exit(1);
    end;

    trigger OnRun()
    var
        T: Text;
    begin
        T := F() + F(); // ONRUN
    end;
}
`;

const REPORT = `report 92800 "R455 R"
{
    ProcessingOnly = true;
    dataset
    {
        dataitem(D; "R455 T")
        {
            trigger OnAfterGetRecord()
            var
                T: Text;
            begin
                T := F() + F(); // DATAITEM
            end;
        }
    }
    requestpage
    {
        SourceTable = "R455 T";
        trigger OnOpenPage()
        var
            T: Text;
        begin
            T := F() + F(); // REQUESTPAGE
        end;
    }

    procedure F(): Integer
    begin
        exit(1);
    end;
}
`;

const SWAP = "lethal.swap-additive";

async function manifestOf(files: Record<string, string>): Promise<MutantManifestEntry[]> {
  const src = await mkdtemp(join(tmpdir(), "lethal-r455rs-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r455rs-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
    // One object per file: a file mixing objects that can and cannot carry the selector var is
    // refused whole (R307).
    for (const [name, text] of Object.entries(files)) await writeFile(join(src, name), text);
    const set = await generateMutationSet(src, { emit: () => {} });
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 92847, controlId: 92848, tableId: 92849 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: APP_JSON.id,
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set),
    });
    const m = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
    return m.mutants.filter((e) => e.operatorName === SWAP);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

const ALL: Record<string, string> = {
  "T.al": TABLE,
  "W.al": codeunitW(WITH_LINE),
  "P.al": PAGE,
  "U.al": ONRUN,
  "R.al": REPORT,
};

let swaps: MutantManifestEntry[];
let outsideAlone: MutantManifestEntry[];
beforeAll(async () => {
  await initParser();
  swaps = await manifestOf(ALL);
  outsideAlone = await manifestOf({ "T.al": TABLE, "W.al": codeunitW("") });
});

const lineIn = (text: string, marker: string): number => {
  const at = text.indexOf(`// ${marker}\n`);
  if (at < 0) throw new Error(`no marker ${marker}`);
  return text.slice(0, at).split("\n").length;
};

const at = (rows: MutantManifestEntry[], file: string, marker: string): MutantManifestEntry[] => {
  const text = ALL[file] ?? "";
  return rows.filter(
    (m) => m.file.replaceAll("\\", "/") === file && m.startLine === lineIn(text, marker),
  );
};

describe("R455 item 2: an unqualified call in a record scope is untyped", () => {
  for (const [file, marker] of [
    ["W.al", "WITH"],
    ["P.al", "PAGE"],
    ["U.al", "ONRUN"],
    ["R.al", "DATAITEM"],
    ["R.al", "REQUESTPAGE"],
  ] as const) {
    test(`${marker}: no swap-additive mutant on F() + F()`, () => {
      expect(at(swaps, file, marker)).toEqual([]);
    });
  }

  test("control, outside the record scope: F() + F() is typed and mutated", () => {
    expect(at(swaps, "W.al", "OUTSIDE").map((m) => m.mutatedText)).toEqual(["F() - F()"]);
  });

  // The key move behind IDENTITY_SCHEME 13: the WITH twin, earlier in the same procedure with the
  // same tuple, held ordinal 0 under scheme 11 and pushed the OUTSIDE mutant to ordinal 1. Removing
  // it gives the OUTSIDE mutant ordinal 0, i.e. the key it has when the `with` line is not there.
  test("the OUTSIDE twin holds ordinal 0 and the key it has without the `with` line", () => {
    const [outside] = at(swaps, "W.al", "OUTSIDE");
    const [alone] = outsideAlone.filter((m) => m.file.replaceAll("\\", "/") === "W.al");
    if (outside === undefined || alone === undefined) throw new Error("no OUTSIDE mutant");
    expect(identityKeyOf(outside).ordinal).toBe(0);
    expect(serializeKey(identityKeyOf(outside))).toBe(serializeKey(identityKeyOf(alone)));
  });

  test("the identity scheme is 37 (13 for R455, 12, 15, 20, 23 and 31 unused, 14 R454, 16 R-364, 17 R254, 18 R-458, 19 R468, 21 R459, 22 R-464, 24 R475, 25 R446, 26 R477, 27 R480, 28 R484, 29 R-300b, 30 R487, 32 R509, 33 R501, 34 R343, 35 R500, 36 R497, 37 R340)", () => {
    expect(IDENTITY_SCHEME).toBe(37);
  });
});
