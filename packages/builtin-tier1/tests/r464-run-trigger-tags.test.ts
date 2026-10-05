import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-464: a qualified page `Rec` now RESOLVES (the one implicit-record resolver), so its
 * `DeleteAll(true)` flip is tagged by the real skip predicate (`deleteSkipCanRaise`) instead of
 * R-364's unresolved-receiver rule, which tagged it unconditionally. Both directions.
 */
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";

const KID = `table 50302 Kid { fields { field(1; "Parent No."; Code[20]) { } } }`;
const par = (trigger: string): string => `table 50300 Par
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { } }
${trigger}}`;
const PAGE = `page 50303 ParList
{
    SourceTable = Par;
    trigger OnOpenPage()
    begin
        Rec.DeleteAll(true);
    end;
}`;

function tagged(files: Readonly<Record<string, string>>): string[] {
  const parsed = Object.entries(files).map(([path, text]) => ({
    path,
    root: wrapRoot(parseAL(text)),
  }));
  const ctx = buildSemanticContext(parsed);
  const page = parsed.find((p) => p.path === "O.al");
  if (page === undefined) throw new Error("no O.al");
  return findAll(page.root, ALNodeKind.boolean_literal)
    .filter((n) => flipBooleanLiteral.targets(n, ctx))
    .flatMap((n) => flipBooleanLiteral.generate(n, ctx))
    .map((s) => `${s.before.text}->${s.after.text} ${s.platformKillMechanism ?? "-"}`);
}

describe("R-464 page Rec run-trigger tags", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("page Rec.DeleteAll(true) on a table WITHOUT OnDelete: untagged (was R-364's blanket tag)", () => {
    expect(tagged({ "K.al": KID, "P.al": par(""), "O.al": PAGE })).toEqual(["true->false -"]);
  });

  it("page Rec.DeleteAll(true) on a table whose OnDelete writes: tagged", () => {
    const onDelete = `    trigger OnDelete()
    var
        Kid: Record Kid;
    begin
        Kid.SetRange("Parent No.", "No.");
        Kid.DeleteAll();
    end;
`;
    expect(tagged({ "K.al": KID, "P.al": par(onDelete), "O.al": PAGE })).toEqual([
      "true->false run-trigger-skipped-delete",
    ]);
  });
});
