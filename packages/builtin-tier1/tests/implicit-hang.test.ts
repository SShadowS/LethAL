import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-458: a loop that writes a field through an IMPLICIT record (`Rec` in a table, a page with a
 * `SourceTable`, a TableNo codeunit's `OnRun`, a report dataitem, a reportextension `modify`) or a
 * `with` subject, and reads it back in its condition, was not hang-refused: the target resolves
 * to nothing (or to a variable the field shadows), so the declaration check said no. The check
 * now asks R-364's by-name matcher once per implicit candidate. Each positive asserts, for
 * remove-assignment and flip-boolean-literal: `targets` false, `refusesHangCapable` true,
 * `generate` empty. Each control asserts `targets` true.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type SemanticContext,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";
import { removeAssignment } from "../src/remove-assignment";

/** `arms`: undefined = no arm map; a symbol list = built under those symbols; "undecided" = every
 *  node answers "undecided" (a file whose directives could not be evaluated). */
type Arms = undefined | readonly string[] | "undecided";

function load(src: string, arms: Arms): { root: ALSyntaxNode; ctx: SemanticContext } {
  const root = wrapRoot(parseAL(src));
  if (arms === undefined) return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
  const symbols = arms === "undecided" ? [] : arms;
  const map = new Map([[root, evaluateArms(root, src, symbols)]]);
  const ctx = buildSemanticContext([{ path: "t.al", root }], map);
  return { root, ctx: arms === "undecided" ? { ...ctx, armOf: () => "undecided" as const } : ctx };
}

/** The first node of `kind` (exact `text`) inside a node whose text is `within`, when given. */
function nodeAt(root: ALSyntaxNode, kind: string, text: string, within?: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode, inside: boolean): void => {
    const now = inside || within === undefined || n.text === within;
    if (now && n.rawKind === kind && n.text === text) out.push(n);
    for (const c of n.children) walk(c, now);
  };
  walk(root, false);
  const first = out[0];
  if (first === undefined) throw new Error(`no ${kind} "${text}"`);
  return first;
}

const TABLES = `table 50460 T { fields { field(1; Done; Boolean) { } field(2; Other; Boolean) { } field(3; "No."; Code[20]) { } } }
table 50461 L { fields { field(1; Flag; Boolean) { } } }
`;

type Case = {
  readonly id: string;
  readonly src: string;
  /** The assignment statement's text. */
  readonly write: string;
  readonly arms?: Arms;
  /** Also run flip-boolean-literal on the `true` in `write` (default true). */
  readonly flip?: boolean;
};

const cu = (vars: string, body: string, extra = "") =>
  `codeunit 50462 C { ${extra} procedure P() var R: Record T; S: Record T; ${vars} begin ${body} end; }`;
const pageOver = (props: string, members: string) => `page 50463 Pg { ${props} ${members} }`;
const report = (members: string) => `report 50464 Rp { dataset { dataitem(Header; T) {
  dataitem(Line; T) { trigger OnAfterGetRecord() begin repeat Done := true; until Header.Done; end; } }
  } ${members} }`;
const reportGlobal = `report 50465 Rg { dataset { dataitem(Header; T) {
  trigger OnAfterGetRecord() begin repeat Done := true; until Header.Done; end; } }
  procedure Q() begin repeat Done := true; until Header.Done; end;
  var Done: Boolean; }`;
const reportExt = (until: string) => `report 50466 Rp { dataset { dataitem(Header; T) { } } }
reportextension 50467 X extends Rp { dataset { modify(Header) {
  trigger OnAfterAfterGetRecord() begin repeat Done := true; until ${until}; end; } } }`;
const tableNo = (prop: string) => `codeunit 50468 Tn { ${prop}
  trigger OnRun() begin repeat Done := true; until Rec.Done; end; }`;
const sourceTable = (prop: string) =>
  `page 50469 Ps { ${prop} procedure RunLoop() begin repeat Done := true; until Rec.Done; end; }`;
const ifTableNo = "\n#if USE_T\n  TableNo = T;\n#endif\n";
const ifSourceTable = "\n#if USE_T\n  SourceTable = T;\n#endif\n";

const POSITIVES: Case[] = [
  {
    id: "a1 with R: local Done written, until R.Done",
    src: cu("Done: Boolean;", "with R do repeat Done := true; until R.Done;"),
    write: "Done := true",
  },
  {
    id: "a2 with R: R.Done written, until bare Done (no local)",
    src: cu("", "with R do repeat R.Done := true; until Done;"),
    write: "R.Done := true",
  },
  {
    id: "a2' with R: R.Done written, until bare Done (a local Done exists)",
    src: cu("Done: Boolean;", "with R do repeat R.Done := true; until Done;"),
    write: "R.Done := true",
  },
  {
    id: "b1 nested with R, S over T: until R.Done (conservative)",
    src: cu("", "with R do with S do repeat Done := true; until R.Done;"),
    write: "Done := true",
  },
  {
    id: "b1' nested with R over T, S over L: the write binds R.Done",
    src: cu("U: Record L;", "with R do with U do repeat Done := true; until R.Done;"),
    write: "Done := true",
  },
  {
    id: "b2 report: nested dataitem Line reads OUTER Header.Done",
    src: report(""),
    write: "Done := true",
  },
  {
    id: "b2' report: Line over L (no Done), bare Done inherits OUTER Header.Done",
    src: `report 50474 Rq { dataset { dataitem(Header; T) {
      dataitem(Line; L) { trigger OnAfterGetRecord() begin repeat Done := true; until Header.Done; end; } }
      } }`,
    write: "Done := true",
  },
  {
    id: 't1 table OnInsert number series: until not Get("No.")',
    src: `table 50470 Tt { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() begin repeat "No." := IncStr("No."); until not Get("No."); end;
      procedure Get(K: Code[20]): Boolean begin end; }`,
    write: '"No." := IncStr("No.")',
    flip: false,
  },
  {
    id: "t2 tableextension trigger: until Rec.Done",
    src: "tableextension 50471 Te extends T { trigger OnInsert() begin repeat Done := true; until Rec.Done; end; }",
    write: "Done := true",
  },
  {
    id: "t3 table: Rec.Done written, until bare Done",
    src: `table 50472 Tr { fields { field(1; Done; Boolean) { } }
      trigger OnInsert() begin repeat Rec.Done := true; until Done; end; }`,
    write: "Rec.Done := true",
  },
  { id: "tn TableNo OnRun: until Rec.Done", src: tableNo("TableNo = T;"), write: "Done := true" },
  {
    id: "g1 page SourceTable procedure, GLOBAL Done: until Rec.Done",
    src: pageOver(
      "SourceTable = T;",
      "procedure RunLoop() begin repeat Done := true; until Rec.Done; end; var Done: Boolean;",
    ),
    write: "Done := true",
  },
  {
    id: "g3 TableNo OnRun, GLOBAL Done",
    src: `codeunit 50473 Tg { TableNo = T;
      trigger OnRun() begin repeat Done := true; until Rec.Done; end; var Done: Boolean; }`,
    write: "Done := true",
  },
  {
    id: "g4 report dataitem trigger, report GLOBAL Done: until Header.Done",
    src: reportGlobal,
    write: "Done := true",
  },
  {
    id: "g5 pageextension, GLOBAL Done: until Rec.Done",
    src: `pageextension 50474 Pe extends Pg {
      procedure RunLoop() begin repeat Done := true; until Rec.Done; end; var Done: Boolean; }`,
    write: "Done := true",
  },
  {
    id: "c1 #if TableNo, active arm",
    src: tableNo(ifTableNo),
    write: "Done := true",
    arms: ["USE_T"],
  },
  {
    id: "c1'' #if TableNo, undecided file",
    src: tableNo(ifTableNo),
    write: "Done := true",
    arms: "undecided",
  },
  { id: "c1''' #if TableNo, no arm map", src: tableNo(ifTableNo), write: "Done := true" },
  {
    id: "c2 #if SourceTable, active arm",
    src: sourceTable(ifSourceTable),
    write: "Done := true",
    arms: ["USE_T"],
  },
  {
    id: "c2'' #if SourceTable, undecided file",
    src: sourceTable(ifSourceTable),
    write: "Done := true",
    arms: "undecided",
  },
  {
    id: "r1 reportextension modify(Header): until Header.Done",
    src: reportExt("Header.Done"),
    write: "Done := true",
  },
];

const CONTROLS: Case[] = [
  {
    id: "8 with R: until S.Done (another receiver)",
    src: cu("", "with R do repeat Done := true; until S.Done;"),
    write: "Done := true",
  },
  {
    id: "9 no with: R.Done written, until S.Done",
    src: cu("", "repeat R.Done := true; until S.Done;"),
    write: "R.Done := true",
  },
  {
    id: "10 with R: until R.Other (not the written name)",
    src: cu("", "with R do repeat Done := true; until R.Other;"),
    write: "Done := true",
  },
  {
    id: "11 with S, local Done: until R.Done",
    src: cu("Done: Boolean;", "with S do repeat Done := true; until R.Done;"),
    write: "Done := true",
  },
  {
    id: "12 local Done written OUTSIDE the with body",
    src: cu("Done: Boolean; I: Integer;", "repeat with R do I := 1; Done := true; until R.Done;"),
    write: "Done := true",
  },
  {
    id: "14 codeunit without TableNo (indexed): until Rec.Done",
    src: "codeunit 50475 Cn { procedure P() begin repeat Done := true; until Rec.Done; end; }",
    write: "Done := true",
  },
  {
    id: "g2 page SourceTable, LOCAL Done",
    src: pageOver(
      "SourceTable = T;",
      "procedure RunLoop() var Done: Boolean; begin repeat Done := true; until Rec.Done; end;",
    ),
    write: "Done := true",
  },
  {
    id: "g2' page SourceTable, PARAMETER Done",
    src: pageOver(
      "SourceTable = T;",
      "procedure RunLoop(var Done: Boolean) begin repeat Done := true; until Rec.Done; end;",
    ),
    write: "Done := true",
  },
  {
    id: "g3' TableNo codeunit, a procedure other than OnRun, GLOBAL Done",
    src: `codeunit 50476 Tq { TableNo = T;
      procedure Other() begin repeat Done := true; until Rec.Done; end; var Done: Boolean; }`,
    write: "Done := true",
  },
  {
    id: "g4' report procedure (no dataitem), GLOBAL Done",
    src: reportGlobal,
    write: "Done := true",
  },
  {
    id: "g6 table, GLOBAL Done beside field Done",
    src: `table 50477 Tg { fields { field(1; Done; Boolean) { } }
      trigger OnInsert() begin repeat Done := true; until Rec.Done; end; var Done: Boolean; }`,
    write: "Done := true",
  },
  {
    id: "g7 tableextension, GLOBAL Done",
    src: `tableextension 50478 Tx extends T {
      trigger OnInsert() begin repeat Done := true; until Rec.Done; end; var Done: Boolean; }`,
    write: "Done := true",
  },
  { id: "c1' #if TableNo, inactive arm", src: tableNo(ifTableNo), write: "Done := true", arms: [] },
  {
    id: "c2' #if SourceTable, inactive arm",
    src: sourceTable(ifSourceTable),
    write: "Done := true",
    arms: [],
  },
  {
    id: "r1' reportextension modify(Header): until Header.Other",
    src: reportExt("Header.Other"),
    write: "Done := true",
  },
];

/** g4' asks about the write in the report PROCEDURE, g4 about the one in the dataitem trigger. */
const WITHIN: Record<string, string> = {
  "g4 report dataitem trigger, report GLOBAL Done: until Header.Done":
    "trigger OnAfterGetRecord() begin repeat Done := true; until Header.Done; end;",
  "g4' report procedure (no dataitem), GLOBAL Done":
    "procedure Q() begin repeat Done := true; until Header.Done; end;",
};

function sites(c: Case, root: ALSyntaxNode): [MutationOperator, ALSyntaxNode][] {
  const within = WITHIN[c.id];
  const write = nodeAt(root, ALNodeKind.assignment_statement, c.write, within);
  const out: [MutationOperator, ALSyntaxNode][] = [[removeAssignment, write]];
  if (c.flip !== false) out.push([flipBooleanLiteral, nodeAt(write, "boolean", "true")]);
  return out;
}

describe("R-458: implicit-record and with-subject hang refusal", () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const c of POSITIVES) {
    it(`REFUSES ${c.id}`, () => {
      const { root, ctx } = load(TABLES + c.src, c.arms);
      for (const [op, node] of sites(c, root)) {
        expect([op.name, op.refusesHangCapable?.(node, ctx)]).toEqual([op.name, true]);
        expect([op.name, op.targets(node, ctx)]).toEqual([op.name, false]);
        expect(op.generate(node, ctx)).toEqual([]);
      }
    });
  }

  for (const c of CONTROLS) {
    it(`CLAIMS ${c.id}`, () => {
      const { root, ctx } = load(TABLES + c.src, c.arms);
      for (const [op, node] of sites(c, root)) {
        expect([op.name, op.targets(node, ctx)]).toEqual([op.name, true]);
        expect([op.name, op.refusesHangCapable?.(node, ctx)]).toEqual([op.name, false]);
      }
    });
  }
});
