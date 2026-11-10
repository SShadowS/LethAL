import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import {
  TESTPAGE_DIAGNOSIS,
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
    expect(d).toStartWith(TESTPAGE_DIAGNOSIS);
    expect(d).toContain(CLR);
  });

  const OPENERS = [
    "Page.Run(50000);",
    "Page.RunModal(50000);",
    "Card.RunModal();",
    "Card.OpenEdit();",
    "Card.OpenView();",
    "Card.OpenNew();",
    "Card.Trap();",
  ];
  for (const call of OPENERS) {
    for (const [label, k] of [
      ["on the line", 2],
      ["one line after the frame", 1],
      ["two lines before the frame", 4],
    ] as const) {
      test(`${call} ${label} (K=${k}) is named`, () => {
        expect(
          describeLinuxPageRefusal(
            msg(`Demo Tests(CodeUnit 70001).Probe line ${k}`),
            lookupFor(codeunit(call)),
          ),
        ).toBeDefined();
      });
    }
    test(`${call} outside the window (K=0 and K=5) is NOT named`, () => {
      for (const k of [0, 5]) {
        expect(
          describeLinuxPageRefusal(
            msg(`Demo Tests(CodeUnit 70001).Probe line ${k}`),
            lookupFor(codeunit(call)),
          ),
        ).toBeUndefined();
      }
    });
  }

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
        msg("Demo Line(Table 70002).Show line 3"),
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
