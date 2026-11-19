// PR-191: the keep entries for the five XML texts DO's y2 window closed its daemon on, measured CLEAN by the strict census with
// family `y2-xml`'s three extra readers (`/coord/handoff/PR-191/census3/`, invented cells).
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);
const xmlName = (n: string) => `XML name \`${n}\` (only plain names without a prefix are pinned)`;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64 = (n: number) => Array.from({ length: n }, (_, i) => B64[i % 64]).join("");

const KEPT: [string, string][] = [
  ["xml-unassigned-node", "use of an unassigned XmlNode"],
  ["xml-unassigned-element", "use of an unassigned XmlElement"],
  ["xml-node-as-content", "XmlNode as XML content (only XML nodes and text are pinned)"],
  ["xml-attribute-collection-other", "XmlAttributeCollection method on something else"],
  // The measured names: each end and character class of the slot.
  ["xml-name-measured-chars", xmlName("+")],
  ["xml-name-measured-chars", xmlName("1abc")],
  ["xml-name-measured-chars", xmlName("image/jpeg")],
  ["xml-name-measured-chars", xmlName("application/pdf")],
  ["xml-name-measured-chars", xmlName(`${b64(15)}=`)],
  ["xml-name-measured-chars", xmlName(`${b64(75)}=`)],
  ["xml-name-measured-chars", xmlName(b64(1336))],
  ["xml-name-measured-chars", xmlName(b64(2000))],
];

describe("PR-191 keep entries", () => {
  test("each measured text is kept by its own entry alone", () => {
    for (const [entry, t] of KEPT) {
      const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
      expect([t.slice(0, 80), keeps(P + t)]).toEqual([t.slice(0, 80), true]);
      expect([t.slice(0, 80), by]).toEqual([t.slice(0, 80), [entry]]);
    }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end, and a row that is not notRun", () => {
    for (const [, t] of KEPT) {
      for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
        expect([m.slice(0, 80), keeps(P + m)]).toEqual([m.slice(0, 80), false]);
      expect([t.slice(0, 80), keeps(P + t, false)]).toEqual([t.slice(0, 80), false]);
    }
  });

  test("only the measured names: other characters, a name over 2,000 characters, and other XML types close", () => {
    const k = (m: string) => keeps(P + m);
    for (const n of ["a-b", "a b", "a.b", "a_b", "a:b", "é", "a`b", "a\nb", b64(2001)])
      expect([n.slice(0, 40), k(xmlName(n))]).toEqual([n.slice(0, 40), false]);
    // PR-56's empty name stays kept, by its own entry
    expect(names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + xmlName("")))).toEqual([
      "xml-name-empty",
    ]);
    for (const t of [
      "use of an unassigned XmlDocument",
      "use of an unassigned XmlAttribute",
      "use of an unassigned XmlNodeList",
      "use of an unassigned Variant",
      "XmlNode as XML content",
      "XmlElement as XML content (only XML nodes and text are pinned)",
      "XmlAttribute method on something else",
    ])
      expect([t, k(t)]).toEqual([t, false]);
  });
});
