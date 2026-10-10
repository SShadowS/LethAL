import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItemHangRefuses } from "@lethal/builtin-tier1";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { IDENTITY_SCHEME, canCarryMutationSelectorVar, identitySiteKey } from "@lethal/schemata";
import {
  type MutationSetResult,
  generateMutationSet,
  identityOrdinalsOf,
} from "../src/orchestrator";

/**
 * R500 at the orchestrator: what only `generateMutationSet` shows. (1) The real r1 hang, pinned:
 * an XMLport whose open `Integer` tableelement reaches a procedure raising an IntegrationEvent with
 * a `var` result, and a codeunit subscriber holding the `Position = 1` shape (ServPEPPOL's): the
 * subscriber is refused, a same-shape subscriber of a DIFFERENT event emits. (2) The XMLport file
 * itself: xmlport cannot carry the selector var, so its specs go to the `skipped` row, exactly as
 * many as a bounded twin's (the dispatch refusal is dormant there, and the in-operator R487 path keeps
 * its report-only scope). (3) The identity scheme twin: a `Date` item's assignment is refused, so a
 * `MaxIteration` item's same-tuple assignment, numbered 1 before R500, becomes 0.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

const xmlport = (id: number, name: string, bound: string) => `xmlport ${id} "${name}"
{
    schema
    {
        textelement(Root)
        {
            tableelement(InvLoop; Integer)
            {
${bound}                trigger OnAfterGetRecord()
                begin
                    if not this.FindNextRec(Calls) then
                        currXMLport.Break();
                end;
            }
        }
    }

    local procedure FindNextRec(Position: Integer): Boolean
    var
        Found: Boolean;
    begin
        Calls := Calls + 1;
        OnFindNextRec(Position, Found);
        exit(Found);
    end;

    procedure RaiseOther()
    var
        Found: Boolean;
    begin
        OnOtherEvent(Found);
    end;

    [IntegrationEvent(false, false)]
    local procedure OnFindNextRec(Position: Integer; var Found: Boolean)
    begin
    end;

    [IntegrationEvent(false, false)]
    local procedure OnOtherEvent(var Found: Boolean)
    begin
    end;

    var
        Calls: Integer;
}
`;

const XP = "src/AB.XmlPort.al";
const XP_BOUNDED = "src/ABBounded.XmlPort.al";
const SUBS = "src/ASubs.Codeunit.al";
const SUBS_AL = `codeunit 50901 "A Subs"
{
    [EventSubscriber(ObjectType::XmlPort, XmlPort::"A - B 3.0", OnFindNextRec, '', false, false)]
    local procedure HandleFind(Position: Integer; var Found: Boolean)
    begin
        if Position = 1 then
            Found := Header.Find('-')
        else
            Found := Header.Next() <> 0;
    end;

    [EventSubscriber(ObjectType::XmlPort, XmlPort::"A - B 3.0", OnOtherEvent, '', false, false)]
    local procedure HandleOther(var Found: Boolean)
    begin
        if Position2 = 1 then
            Found := Header.Find('-')
        else
            Found := Header.Next() <> 0;
    end;

    var
        Header: Record Customer;
        Position2: Integer;
}
`;

const TWIN = "src/Twin.Report.al";
const TWIN_AL = `report 50500 "Twin Probe"
{
    dataset
    {
        dataitem(Days; Date)
        {
            trigger OnAfterGetRecord()
            begin
                Total := 0;
            end;
        }
        dataitem(One; Integer)
        {
            MaxIteration = 1;
            trigger OnAfterGetRecord()
            begin
                Total := 0;
            end;
        }
    }

    var
        Total: Integer;
}
`;

const FILES: Record<string, string> = {
  [XP]: xmlport(50900, "A - B 3.0", ""),
  [XP_BOUNDED]: xmlport(
    50902,
    "A - B 3.0 Bounded",
    "                SourceTableView = where(Number = const(1));\n",
  ),
  [SUBS]: SUBS_AL,
  [TWIN]: TWIN_AL,
};

/** 1-based line of the `nth` (1-based) line containing `marker`. */
function at(src: string, marker: string, nth = 1): number {
  let seen = 0;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(marker) === true && ++seen === nth) return i + 1;
  }
  throw new Error(`marker ${JSON.stringify(marker)} #${nth} not found`);
}

let dir = "";
let set: MutationSetResult;
beforeAll(async () => {
  await initParser();
  dir = await mkdtemp(join(tmpdir(), "lethal-r500-"));
  await Bun.write(join(dir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(FILES)) await Bun.write(join(dir, rel), content);
  set = await generateMutationSet(dir, { emit: () => {} });
});
afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

const specsOf = (file: string) => set.files.filter((f) => f.path === file).flatMap((f) => f.specs);
const refused = (file: string): number => set.hangRefused.find((r) => r.file === file)?.sites ?? 0;
const skippedSites = (file: string): number => set.skipped.find((r) => r.file === file)?.sites ?? 0;

describe("R500: the XMLport publisher's subscriber (the r1 hang)", () => {
  const find = at(SUBS_AL, "procedure HandleFind");
  const other = at(SUBS_AL, "procedure HandleOther");
  const rows = () => specsOf(SUBS).map((s) => s.before.startPosition.row + 1);

  test("the subscriber of the event an open tableelement's callee raises is refused, every site", () => {
    expect(rows().filter((r) => r > find && r < other)).toEqual([]);
    expect(refused(SUBS)).toBeGreaterThan(0);
  });

  test("its twin, the same body subscribing to another event, emits as many sites as were refused", () => {
    const emitted = rows().filter((r) => r > other);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length).toBe(refused(SUBS));
  });
});

describe("R500 step 7: an XMLport is not a carrier, so its own refusal is dormant", () => {
  test("xmlport cannot carry the selector var (adding it wakes R500's XMLport refusal: measure first)", () => {
    expect(canCarryMutationSelectorVar(wrapRoot(parseAL(FILES[XP] ?? "")))).toBe(false);
  });

  test("the open XMLport's specs: none is hang-refused", () => {
    expect(refused(XP)).toBe(0);
    expect(skippedSites(XP)).toBeGreaterThan(0);
  });

  test("the twin really is bounded: asked directly, the open element's code is refused and the twin's is not", () => {
    const files = [XP, XP_BOUNDED].map((path) => ({
      path,
      root: wrapRoot(parseAL(FILES[path] ?? "")),
    }));
    const ctx = buildSemanticContext(files);
    const callsWrite = (path: string): ALSyntaxNode => {
      let hit: ALSyntaxNode | null = null;
      const root = files.find((f) => f.path === path)?.root;
      if (root !== undefined) {
        visit(root, (n: ALSyntaxNode) => {
          if (
            hit === null &&
            n.rawKind === "assignment_statement" &&
            n.text === "Calls := Calls + 1"
          )
            hit = n;
        });
      }
      if (hit === null) throw new Error(`no Calls write in ${path}`);
      return hit;
    };
    expect(openItemHangRefuses(callsWrite(XP), ctx, undefined)).toBe(true);
    expect(openItemHangRefuses(callsWrite(XP_BOUNDED), ctx, undefined)).toBe(false);
  });

  test("so the open XMLport's `skipped` sites equal its bounded twin's: nothing moved out of `skipped`", () => {
    expect(skippedSites(XP)).toBe(skippedSites(XP_BOUNDED));
  });
});

describe("R500: the identity scheme twin (a Date item refused, a MaxIteration twin renumbered)", () => {
  test("the identity scheme is 39 (34 R343, 35 for R500, 36 R497, 37 R340, 38 R555, 39 R-531)", () => {
    expect(IDENTITY_SCHEME).toBe(39);
  });

  test("the Date item's `Total := 0` emits nothing and is hang-refused", () => {
    const days = at(TWIN_AL, "Total := 0", 1);
    expect(specsOf(TWIN).filter((s) => s.before.startPosition.row + 1 === days)).toEqual([]);
    expect(refused(TWIN)).toBeGreaterThan(0);
  });

  test("every mutant of the MaxIteration item's same-tuple `Total := 0` now takes ordinal 0", () => {
    const one = at(TWIN_AL, "Total := 0", 2);
    const ord = identityOrdinalsOf(set);
    const here = specsOf(TWIN).filter((s) => s.before.startPosition.row + 1 === one);
    expect(here.length).toBeGreaterThan(0);
    for (const s of here) {
      expect(
        ord.get(identitySiteKey(TWIN, s.before.startIndex, s.before.endIndex, s.operatorName)),
      ).toBe(0);
    }
  });
});
