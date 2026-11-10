import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import {
  describeLinuxPageRefusal,
  describeTestPageRefusal,
  frameSourceLookup,
} from "../src/testpage-unsupported";

/**
 * R909. Linux BC reports a page open as a plain CLR NotSupportedException, with the top AL frame at
 * the page call. It is named only when that frame resolves, in source LethAL has, to a page-opening
 * call. All names, ids and AL below are invented.
 */
const CLR =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported.";
const TAIL =
  "- Demo App by Demo Pub version 1.0.0.0;Test Runner - Mgt(CodeUnit 130454).RunTests line 26";
const msg = (frame: string, first = CLR) => `${first}\n${frame} ${TAIL}`;

/** `procedure` is row 0; the statement `body` is row 2. */
const codeunit = (body: string) => `codeunit 70001 "Demo Tests"
{
    procedure Probe()
    begin
        ${body}
    end;

    trigger OnRun()
    begin
        ${body}
    end;
}
`;
const table = (body: string) => `table 70002 "Demo Line"
{
    procedure Show()
    begin
        ${body}
    end;
}
`;
const lookupFor = (...texts: string[]) => frameSourceLookup(texts);

beforeAll(async () => {
  await initParser();
});

describe("R909 — Linux page-open frame", () => {
  test("a Page.Run at the frame's line is named, quoting BC's message", () => {
    const d = describeLinuxPageRefusal(
      msg("Demo Tests(CodeUnit 70001).Probe line 2"),
      lookupFor(codeunit("Page.Run(50000);")),
    );
    expect(d).toContain("Top frame: Demo Tests(CodeUnit 70001).Probe line 2");
    expect(d).toContain(CLR);
  });

  const OPENERS = [
    "Page.Run(50000);",
    "Page.RunModal(50000);",
    "Card.RunModal();",
    "Card.OpenEdit();",
    "Card.OpenView();",
    "Card.OpenNew();",
    "Card.OpenEdit;", // written without parentheses
  ];
  for (const call of OPENERS) {
    test(`${call} at exactly K is named`, () => {
      expect(
        describeLinuxPageRefusal(
          msg("Demo Tests(CodeUnit 70001).Probe line 2"),
          lookupFor(codeunit(call)),
        ),
      ).toBeDefined();
    });
    test(`${call} one row off (K-1 and K+1) is NOT named`, () => {
      for (const k of [1, 3]) {
        expect(
          describeLinuxPageRefusal(
            msg(`Demo Tests(CodeUnit 70001).Probe line ${k}`),
            lookupFor(codeunit(call)),
          ),
        ).toBeUndefined();
      }
    });
  }

  test("Trap is never the failing call: NOT named", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).Probe line 2"),
        lookupFor(codeunit("Card.Trap();")),
      ),
    ).toBeUndefined();
  });

  /** `procedure` is row 0, the declarations row 2, the statement row 4. */
  const withVar = (decl: string, body: string) => `codeunit 70001 "Demo Tests"
{
    procedure Probe()
    var
        ${decl}
    begin
        ${body}
    end;
}
`;
  const at4 = (text: string) =>
    describeLinuxPageRefusal(msg("Demo Tests(CodeUnit 70001).Probe line 4"), lookupFor(text));

  test(".Run on a receiver declared as Page is named; declared as Codeunit is not", () => {
    expect(at4(withVar("P: Page 50000;", "P.Run();"))).toBeDefined();
    expect(at4(withVar("P: Codeunit 50000;", "P.Run();"))).toBeUndefined();
  });

  test("Report, Xmlport and Codeunit receivers (literal or declared) are NOT named", () => {
    for (const [decl, body] of [
      ["R: Report 50000;", "R.RunModal();"],
      ["X: Xmlport 50000;", "X.Run();"],
      ["H: Codeunit 50000;", "H.OpenView();"],
      ["H: Codeunit 50000;", "H.RunModal();"],
      ["", "Report.RunModal(50000);"],
      ["", "Xmlport.RunModal(50000);"],
      ["", "Codeunit.RunModal(50000);"],
    ] as const) {
      expect(at4(withVar(decl, body))).toBeUndefined();
    }
  });

  test("a receiver declared as Page or TestPage with an open method is named", () => {
    expect(at4(withVar("P: Page 50000;", "P.RunModal();"))).toBeDefined();
    expect(at4(withVar("T: TestPage 50000;", "T.OpenEdit();"))).toBeDefined();
  });

  test("a leading BOM does not hide the object", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).Probe line 2"),
        lookupFor(`﻿${codeunit("Page.Run(50000);")}`),
      ),
    ).toBeDefined();
  });

  test("the diagnosis prints the whole matched frame, even with ' - ' in the name", () => {
    const text = `codeunit 70003 "Library - Demo"\n{\n    procedure Probe()\n    begin\n        Page.Run(1);\n    end;\n}\n`;
    const d = describeLinuxPageRefusal(
      msg("Library - Demo(CodeUnit 70003).Probe line 2"),
      lookupFor(text),
    );
    expect(d).toContain("Top frame: Library - Demo(CodeUnit 70003).Probe line 2");
  });

  test("the Linux diagnosis says page, not TestPage", () => {
    const d = describeLinuxPageRefusal(
      msg("Demo Tests(CodeUnit 70001).Probe line 2"),
      lookupFor(codeunit("Page.Run(50000);")),
    );
    expect(d).toStartWith("this test opens a page,");
    expect(d).not.toContain("test service");
  });

  test("an answer is kept: the same lookup does not reparse", () => {
    const lookup = lookupFor(codeunit("Page.Run(50000);"));
    expect(lookup("CodeUnit", 70001, "Probe")).toBe(lookup("CodeUnit", 70001, "Probe"));
  });

  test("a non-page statement at the frame is NOT named", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).Probe line 2"),
        lookupFor(codeunit("Message('hi'); Card.Validate();")),
      ),
    ).toBeUndefined();
  });

  test("Run on a receiver that is not Page is NOT named", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).Probe line 2"),
        lookupFor(codeunit("Codeunit.Run(50000);")),
      ),
    ).toBeUndefined();
  });

  test("a frame in an object with no source is NOT named", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Other(CodeUnit 70999).Probe line 2"),
        lookupFor(codeunit("Page.Run(50000);")),
      ),
    ).toBeUndefined();
  });

  test("a different message on line one is NOT named, even at a page call", () => {
    expect(
      describeLinuxPageRefusal(
        msg(
          "Demo Tests(CodeUnit 70001).Probe line 2",
          "Unexpected CLR exception thrown.: System.InvalidOperationException: nope",
        ),
        lookupFor(codeunit("Page.Run(50000);")),
      ),
    ).toBeUndefined();
  });

  test("a trigger frame resolves", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).OnRun(Trigger) line 2"),
        lookupFor(codeunit("Page.Run(50000);")),
      ),
    ).toBeDefined();
    expect(
      describeLinuxPageRefusal(
        msg("Demo Tests(CodeUnit 70001).OnRun(Trigger) line 2"),
        lookupFor(codeunit("Message('x');")),
      ),
    ).toBeUndefined();
  });

  test("a Table object frame resolves", () => {
    expect(
      describeLinuxPageRefusal(
        msg("Demo Line(Table 70002).Show line 2"),
        lookupFor(table("Page.RunModal(50000);")),
      ),
    ).toBeDefined();
  });

  test("the Windows text is still named with no source lookup at all", () => {
    const win =
      "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
      "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";
    expect(describeTestPageRefusal(win, undefined)).toContain("CreateNavTestService");
  });

  test("the Linux shape with no lookup is NOT named", () => {
    expect(
      describeTestPageRefusal(msg("Demo Tests(CodeUnit 70001).Probe line 2"), undefined),
    ).toBeUndefined();
  });
});
