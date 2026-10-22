import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  type MutantManifest,
  withRunIdentityOrdinals,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

// R294 review: an IMPLICIT `with` over a record. In these bodies a field of the record wins over
// an object GLOBAL of the same name, so typing a bare name by the global let `swap-call-arguments`
// emit a call `alc` rejects. Measured with `alc` 18.0.43: `Take(Q2, Z)`, Q2 and Z Integer globals
// and Z also a Text field of the record, compiles; the swap `Take(Z, Q2)` is AL0133. Each
// `Take*(Q2, Z)` below marked REFUSED sits where the field wins; each marked SWAPPED is a control
// where the global or local truly wins and both arguments are Integer. Invented names only.

const APP_JSON = {
  id: "00000000-0000-0000-0000-000000092700",
  name: "r294iw",
  publisher: "repro",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 92700, to: 92749 }],
};

const SRC = `table 92700 "IW T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Z; Text[30]) { }
    }
    keys { key(PK; "No.") { Clustered = true; } }

    var
        Q2, Z: Integer;

    procedure TTake(A: Integer; B: Integer)
    begin
    end;

    procedure TCall()
    begin
        TTake(Q2, Z); // SWAPPED table
    end;
}

page 92700 "IW P"
{
    SourceTable = "IW T";
    var
        Q2, Z: Integer;

    procedure PTake(A: Integer; B: Text)
    begin
    end;

    procedure PTakeInts(A: Integer; B: Integer)
    begin
    end;

    trigger OnOpenPage()
    begin
        PTake(Q2, Z); // REFUSED page
    end;

    procedure PLocal()
    var
        Q2, Z: Integer;
    begin
        PTakeInts(Q2, Z); // SWAPPED page local
    end;
}

page 92701 "IW NoSrc"
{
    var
        Q2, Z: Integer;

    procedure NTake(A: Integer; B: Integer)
    begin
    end;

    trigger OnOpenPage()
    begin
        NTake(Q2, Z); // SWAPPED page without SourceTable
    end;
}

page 92702 "IW Base"
{
    SourceTable = "IW T";
}

pageextension 92700 "IW PX" extends "IW Base"
{
    var
        Q2, Z: Integer;

    procedure XTake(A: Integer; B: Text)
    begin
    end;

    trigger OnOpenPage()
    begin
        XTake(Q2, Z); // REFUSED pageextension
    end;
}

codeunit 92700 "IW C"
{
    TableNo = "IW T";
    var
        Q2, Z: Integer;

    procedure CTake(A: Integer; B: Text)
    begin
    end;

    procedure CTakeInts(A: Integer; B: Integer)
    begin
    end;

    trigger OnRun()
    begin
        CTake(Q2, Z); // REFUSED codeunit OnRun
    end;

    procedure COther()
    begin
        CTakeInts(Q2, Z); // SWAPPED codeunit procedure
    end;
}

report 92700 "IW R"
{
    ProcessingOnly = true;
    dataset
    {
        dataitem(D; "IW T")
        {
            trigger OnAfterGetRecord()
            begin
                RTake(Q2, Z); // REFUSED report dataitem
            end;
        }
    }
    requestpage
    {
        SourceTable = "IW T";
        trigger OnOpenPage()
        begin
            RTake(Q2, Z); // REFUSED report requestpage
        end;
    }
    var
        Q2, Z: Integer;

    procedure RTake(A: Integer; B: Text)
    begin
    end;

}

report 92702 "IW R2"
{
    ProcessingOnly = true;
    var
        Q2, Z: Integer;

    procedure RTakeInts(A: Integer; B: Integer)
    begin
    end;

    trigger OnPreReport()
    begin
        RTakeInts(Q2, Z); // SWAPPED report trigger
    end;
}

report 92701 "IW R3"
{
    ProcessingOnly = true;
    dataset
    {
        dataitem(D; "IW T") { }
    }
}

reportextension 92700 "IW RX" extends "IW R3"
{
    dataset
    {
        modify(D)
        {
            trigger OnAfterAfterGetRecord()
            begin
                XRTake(Q2, Z); // REFUSED reportextension modify
            end;
        }
    }
    var
        Q2, Z: Integer;

    procedure XRTake(A: Integer; B: Text)
    begin
    end;

    procedure XRTakeInts(A: Integer; B: Integer)
    begin
    end;

    procedure XRCall()
    begin
        XRTakeInts(Q2, Z); // SWAPPED reportextension procedure
    end;
}
`;

const OBJECTS = SRC.split(/\n(?=(?:table|page|pageextension|codeunit|report|reportextension) \d)/);

let manifest: MutantManifest;
beforeAll(async () => {
  await initParser();
  const src = await mkdtemp(join(tmpdir(), "lethal-r294iw-src-"));
  const out = await mkdtemp(join(tmpdir(), "lethal-r294iw-out-"));
  try {
    await writeFile(join(src, "app.json"), JSON.stringify(APP_JSON));
    // One object per file: a file mixing objects that can and cannot carry the selector var is
    // refused whole (R307).
    for (const [i, text] of OBJECTS.entries()) await writeFile(join(src, `O${i}.al`), text);
    const set = await generateMutationSet(src);
    await writeInstrumentedProject(
      withRunIdentityOrdinals({
        targetDir: out,
        files: set.files,
        selectorIds: { selectorId: 92747, controlId: 92748, tableId: 92749 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: APP_JSON.id,
        operatorTiers,
      }),
    );
    manifest = JSON.parse(
      await readFile(join(out, "mutant-manifest.json"), "utf8"),
    ) as MutantManifest;
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

const siteOf = (marker: string): { file: string; line: number } => {
  for (const [i, text] of OBJECTS.entries()) {
    const at = text.indexOf(`// ${marker}\n`);
    if (at >= 0) return { file: `O${i}.al`, line: text.slice(0, at).split("\n").length };
  }
  throw new Error(`no marker ${marker}`);
};

const swapsAt = (marker: string): number => {
  const { file, line } = siteOf(marker);
  return manifest.mutants.filter(
    (m) =>
      m.file === file && m.startLine === line && m.operatorName === "lethal.swap-call-arguments",
  ).length;
};

describe("R294 review: implicit `with` over a record, the deployed manifest", () => {
  for (const ctx of [
    "page",
    "pageextension",
    "codeunit OnRun",
    "report dataitem",
    "report requestpage",
  ]) {
    test(`${ctx}: a bare name falling through to a global is not typed, so no swap`, () => {
      expect(swapsAt(`REFUSED ${ctx}`)).toBe(0);
    });
  }

  // Load-bearing since R254 (R455 point 4): a reportextension now has a scope and is instrumented,
  // so its globals are typed, and the `dataset_section` case of `implicitRecordShadowsGlobals` is
  // what keeps this site refused (red-checked by removing that case). The control
  // "reportextension procedure" below proves the scope exists, so this cannot pass vacuously.
  test("reportextension modify: no swap", () => {
    expect(swapsAt("REFUSED reportextension modify")).toBe(0);
  });

  for (const ctx of [
    "page local",
    "page without SourceTable",
    "codeunit procedure",
    "report trigger",
    "table",
    "reportextension procedure",
  ]) {
    test(`control, ${ctx}: the name is typed and the swap is emitted`, () => {
      expect(swapsAt(`SWAPPED ${ctx}`)).toBe(1);
    });
  }
});
