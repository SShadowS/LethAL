// R639 P4 (pre-commitment r9, plan r4.1 item 1): the binding test. The two pinned BC texts are
// bound to the committed bc1 measurement, parsed from each test's FULL failure text (M-b).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BC_END_OF_TEST_TEXT, BC_HTTP_INTERNAL_TEXT } from "../src/al-runner-v3-contract";

const FILE = join(import.meta.dir, "../../../docs/measurements/r639/bc1-probe.json");

interface ProbeTest {
  readonly method: string;
  readonly outcome: string;
  readonly fullFailureText: string;
}
interface Probe {
  readonly [k: string]: unknown;
  readonly results: ReadonlyArray<{ readonly codeunit: number; readonly tests: ProbeTest[] }>;
}

/** M-b: `raw` between `MEASURED [` and the LAST `] [`; exactly one `MEASURED [`, `]` then `\n` or end. */
function parseRaw(full: string): string | undefined {
  const s = full.indexOf("MEASURED [");
  if (s < 0 || full.indexOf("MEASURED [", s + 1) >= 0) return undefined;
  const e = full.lastIndexOf("] [");
  const z = full.indexOf("]", e + 3);
  if (e < s || z < 0 || (z + 1 < full.length && full[z + 1] !== "\n")) return undefined;
  return full.slice(s + 10, e);
}

const firstLine = (t: string): string => t.split("\n")[0] ?? "";

/** Every way the file fails to carry the pinned texts and its provenance; [] when it does. */
function bcReadingProblems(d: Probe): string[] {
  const bad: string[] = [];
  const at = (cu: number, method: string): ProbeTest | undefined =>
    d.results.find((r) => r.codeunit === cu)?.tests.find((t) => t.method === method);
  const want = (cu: number, method: string, text: string, how: "raw" | "first"): void => {
    const t = at(cu, method);
    if (t === undefined) return void bad.push(`${cu}.${method}: no test`);
    if (t.outcome !== "fail") bad.push(`${cu}.${method}: outcome ${t.outcome}, not fail`);
    const got = how === "raw" ? parseRaw(t.fullFailureText) : firstLine(t.fullFailureText);
    if (got !== text) bad.push(`${cu}.${method}: ${how} ${JSON.stringify(got)}`);
  };
  want(92911, "HttpGetRaw", BC_HTTP_INTERNAL_TEXT, "raw");
  want(92910, "HttpGet", BC_HTTP_INTERNAL_TEXT, "first");
  want(92912, "DuplicateNamedKey", BC_END_OF_TEST_TEXT, "first");
  want(92913, "DuplicateNamedKey", BC_END_OF_TEST_TEXT, "first");
  want(92915, "DuplicateNamedKeyThenReadRaw", BC_END_OF_TEST_TEXT, "raw");
  if (d.server !== "bc1") bad.push(`server ${String(d.server)}`);
  if (!JSON.stringify(d.bcBuild ?? null).includes("28.4.53241.56590")) bad.push("bcBuild");
  if (d.lethalControl !== "1.0.0.23") bad.push(`lethalControl ${String(d.lethalControl)}`);
  if (!String(d.harness ?? "").startsWith("scripts/r639-bc-probe/drive.ts@")) bad.push("harness");
  if (d.testHttpRequestPolicy !== "absent") bad.push("testHttpRequestPolicy");
  if (!String(d.testPermissions ?? "").includes("Disabled")) bad.push("testPermissions");
  const removal = (d.removal ?? {}) as Record<string, { ok?: boolean; steps?: string[] }>;
  const apps = Object.values(removal);
  if (
    apps.length !== 2 ||
    !apps.every((a) => a.ok === true && (a.steps ?? []).some((s) => s.includes("absent (0 rows)")))
  )
    bad.push("removal: both apps removed and read back absent");
  return bad;
}

const real = (): Probe => JSON.parse(readFileSync(FILE, "utf8")) as Probe;

describe("R639 P4: the pinned BC texts are bc1's measured texts", () => {
  test("P4: BC_HTTP_INTERNAL_TEXT and BC_END_OF_TEST_TEXT equal bc1-probe.json, which names its provenance", () => {
    expect(bcReadingProblems(real())).toEqual([]);
  });
  test("P4 (the check bites): one character changed in a copy's failure text, or the policy field deleted, is caught", () => {
    const d = real();
    const r = d.results.find((x) => x.codeunit === 92911);
    const t = r?.tests[0];
    if (t === undefined) throw new Error("no 92911 test in bc1-probe.json");
    const copy: Probe = {
      ...d,
      results: d.results.map((x) =>
        x === r
          ? {
              ...x,
              tests: [{ ...t, fullFailureText: t.fullFailureText.replace("blocked", "blockeD") }],
            }
          : x,
      ),
    };
    expect(bcReadingProblems(copy).join("\n")).toMatch(/92911\.HttpGetRaw: raw/);
    const { testHttpRequestPolicy: _p, ...noPolicy } = d;
    expect(bcReadingProblems(noPolicy as Probe)).toEqual(["testHttpRequestPolicy"]);
  });
  test("M-b: raw is cut at the LAST `] [`, so brackets inside the text survive; two MEASURED markers refuse", () => {
    expect(parseRaw("MEASURED [a [x] b] [Code]\nstack")).toBe("a [x] b");
    expect(parseRaw("MEASURED [a] [C] MEASURED [b] [D]")).toBeUndefined();
    expect(parseRaw("MEASURED [a] [C]tail")).toBeUndefined();
  });
});
