// PR-159: the keep entries for the two sibling texts DO's y1 window still closed its daemon on, measured CLEAN by PR-54's
// strict census with every refuser refusing (`/coord/handoff/PR-159/census/`, invented cells of family `y1-refusals`):
// `RecordRef.GetTable of Integer 12345` (a plain call and one behind an `IsRecord` guard) and the JSON writer's
// WriteStartObject at path `message.body.toRecipients[0].emailAddress`.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);
const start = (path: string) =>
  `DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path '${path}'.; the text AL would see is not pinned (ADR-014 section 7)`;

const KEPT: [string, string][] = [
  ["recordref-gettable-integer-123", "RecordRef.GetTable of Integer 12345"],
  ["dotnet-json-writer-start-object-in-object", start("message.body.toRecipients[0].emailAddress")],
];

describe("PR-159 keep entries", () => {
  test("each measured text is kept by its own entry alone", () => {
    for (const [entry, t] of KEPT) {
      const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
      expect([t, keeps(P + t)]).toEqual([t, true]);
      expect([t, by]).toEqual([t, [entry]]);
    }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end, and a row that is not notRun", () => {
    for (const [, t] of KEPT) {
      for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
        expect([m, keeps(P + m)]).toEqual([m, false]);
      expect([t, keeps(P + t, false)]).toEqual([t, false]);
    }
  });

  test("only the measured variants: other integers and other paths close", () => {
    const k = (m: string) => keeps(P + m);
    for (const v of [
      "1234",
      "123456",
      "0",
      "1",
      "-12345",
      " 12345",
      "12345 ",
      "1234 5",
      "123 45",
      "12345.0",
    ])
      expect([v, k(`RecordRef.GetTable of Integer ${v}`)]).toEqual([v, false]);
    // PR-133's 123 still kept
    expect(k("RecordRef.GetTable of Integer 123")).toBe(true);
    for (const p of [
      "message.body.toRecipients[1].emailAddress",
      "message.body.bccRecipients[0].emailAddress",
      "message.body.toRecipients[0]",
      "message.body.toRecipients[0].emailAddress.address",
      "message.toRecipients[0].emailAddress",
      "body.toRecipients[0].emailAddress",
      "message.body.toRecipients[00].emailAddress",
    ])
      expect([p, k(start(p))]).toEqual([p, false]);
    // PR-105's sibling stays kept
    expect(k(start("message.body.ccRecipients[0].emailAddress"))).toBe(true);
  });
});
