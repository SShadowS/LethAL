// R612's daemon keep rule (`serveDaemonReusable`), the rule alone. Moved unchanged from
// `al-runner-backend.test.ts` by R654 S1 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md),
// with the rule, which v3 uses, now in `al-runner-server.ts`.
import { describe, expect, test } from "bun:test";
import { AlRunnerServeDuplicateRowError, serveDaemonReusable } from "../src/al-runner-server";

// The measured texts (`/coord/handoff/R-612/measure.md`, probe `main.stdout`), verbatim.
const HTTP =
  "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)";
const COMMIT =
  "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function: what the runner keeps is not pinned";
const CASCADE =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HttpGet: did not run (an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a ): it can change session state the analysis does not follow, so the state it would have left is not BC's; this failure is not trusted: after a refusal";
const ONRUN =
  "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): Arithmetic operation resulted in an overflow.";
const NO_CALLEE =
  "NotRun: out-of-scope: R612 Broken.DoesNotCompile: call `NoSuchProcedure(1)` has no callee the checker resolved";
const PANIC_TEST =
  "NotRun: out-of-scope: runtime panic (bug): requested by ALRUNNER_DEBUG_PANIC_IN";
const PANIC_CASCADE =
  "NotRun: out-of-scope: an earlier test of this codeunit panicked (a runtime bug), so the rest of it was not run";
const DUP_KEY =
  "NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Data Key Probe is deferred: whether the test runner raises it at the end of the test is not pinned";

describe("serveDaemonReusable, the rule alone", () => {
  // Each row its own name: under v3 a repeated name throws (M-3).
  let rowSeq = 0;
  const r = (status: string, o: { message?: string; notRun?: boolean } = {}) => ({
    name: `C.X${++rowSeq}`,
    status,
    ...o,
  });
  test("v2 is today's condition: every row pass or fail, notRun ignored", () => {
    expect(serveDaemonReusable([r("pass"), r("fail")], "v2")).toBe(true);
    expect(serveDaemonReusable([r("pass", { notRun: true })], "v2")).toBe(true);
    expect(serveDaemonReusable([r("error", { notRun: true, message: COMMIT })], "v2")).toBe(false);
    expect(serveDaemonReusable([], "v2")).toBe(true);
  });
  test("R705: a no-callee row closes the v3 daemon", () => {
    expect(
      serveDaemonReusable(
        [
          { name: "C.NC1", status: "pass" },
          { name: "C.NC2", status: "error", notRun: true, message: NO_CALLEE },
        ],
        "v3",
      ),
    ).toBe(false);
  });
  test("v3 keeps on each of the four entries, and on pass/fail without notRun", () => {
    for (const m of [HTTP, COMMIT, CASCADE, ONRUN]) {
      expect([
        m,
        serveDaemonReusable([r("pass"), r("error", { notRun: true, message: m })], "v3"),
      ]).toEqual([m, true]);
    }
    expect(serveDaemonReusable([r("pass"), r("fail", { notRun: false })], "v3")).toBe(true);
  });
  // R635: the edge build's Commit wording, measured clean (`/coord/handoff/R-635/edge-reasons.md`).
  const EDGE_COMMIT =
    "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function is not supported yet: no corpus test pins whether BC keeps the committed rows for the next test (corpus issue 645). Run this codeunit with TestIsolation = Codeunit (al-runner: --isolation codeunit, the default)";
  test("R635: v3 keeps on the edge build's Commit wording", () => {
    expect(serveDaemonReusable([r("error", { notRun: true, message: EDGE_COMMIT })], "v3")).toBe(
      true,
    );
  });
  test("R635: the edge Commit wording is anchored at both ends (a tail or a prefix closes)", () => {
    for (const m of [`${EDGE_COMMIT} after a timeout`, `x${EDGE_COMMIT}`]) {
      expect([m, serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")]).toEqual([
        m,
        false,
      ]);
    }
  });
  // R808: today's http wording (alpha.7, alpha.12), exact (`/coord/handoff/R-808/probe.md`).
  const HTTP_TODAY =
    "NotRun: out-of-scope: an outbound HTTP request that a test handler does not answer: the runtime never opens a connection (ADR-027). To run the test, bind an [HttpClientHandler] that answers the request, or set TestHttpRequestPolicy = BlockOutboundRequests on the test codeunit to get BC's error for it";
  const keeps = (m: string, notRun = true): boolean =>
    serveDaemonReusable([r("error", { notRun, message: m })], "v3");
  test("R808 (a): v3 keeps on today's exact http text", () => {
    expect(keeps(HTTP_TODAY)).toBe(true);
  });
  test("R808 (c): alpha.2's http wording still keeps", () => {
    expect(keeps(HTTP)).toBe(true);
  });
  test("R808 (b): v3 closes on today's text plus a tail, a prefix of it, a reworded sentence, notRun false, or an unknown text", () => {
    const cases: [string, string, boolean][] = [
      ["tail", `${HTTP_TODAY} after a timeout`, true],
      ["tail with a newline", `${HTTP_TODAY}\nx`, true],
      ["prefix of it", HTTP_TODAY.slice(0, HTTP_TODAY.indexOf(" To run the test")), true],
      ["reworded", HTTP_TODAY.replace("does not answer", "answers"), true],
      ["notRun false", HTTP_TODAY, false],
      ["unknown", "NotRun: out-of-scope: an outbound HTTP request that nobody knows", true],
    ];
    for (const [what, m, notRun] of cases) expect([what, keeps(m, notRun)]).toEqual([what, false]);
  });
  test("v3 closes on a timeout row and both panic wordings", () => {
    for (const m of ["Test exceeded 3s timeout.", PANIC_TEST, PANIC_CASCADE]) {
      expect([m, serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")]).toEqual([
        m,
        false,
      ]);
    }
  });
  for (const [c, m] of [
    [
      "c",
      "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): runtime panic (bug): boom",
    ],
    [
      "d",
      "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): the OnRun panicked (a runtime bug) at x",
    ],
    [
      "e",
      "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (Y: runtime panic (bug): z)",
    ],
  ] as const) {
    test(`T3 (${c}): no entry with a tail keeps a panic`, () => {
      expect(serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")).toBe(false);
    });
  }
  // Build review r1 I-1: a tail must not keep a timeout, a wall-time stop or ANY panic (an
  // #5698 fix would put the OnRun timeout inside the onrun-failed tail). One test per word,
  // and a case variant each, so each word's red check names its own test.
  const ONRUN_TAIL = "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): ";
  const CASCADE_TAIL =
    "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (";
  for (const [c, m] of [
    ["f timeout", `${ONRUN_TAIL}Test exceeded 3s timeout.`],
    ["f timeout case", `${ONRUN_TAIL}TIMEOUT after 3s`],
    ["f timed out", `${ONRUN_TAIL}the trigger timed out`],
    ["f timed out case", `${CASCADE_TAIL}X: Timed Out)`],
    ["f exceeded", `${ONRUN_TAIL}CPU limit Exceeded`],
    ["f wall", `${ONRUN_TAIL}stopped at 10 times N of WALL time`],
    ["f wall cascade", `${CASCADE_TAIL}X: stopped on wall time)`],
    ["f deadline", `${ONRUN_TAIL}Deadline reached`],
    // Bugs' finding: a TIMEOUT-caused cascade row, alone in the answer (no timeout row beside it).
    [
      "g time limit cascade",
      `${CASCADE_TAIL}X: did not run (the test used more than the Time Limit): this failure is not trusted`,
    ],
    ["f panicked at", `${ONRUN_TAIL}thread 'worker' panicked at src/run.rs:10:5`],
    ["f panic case", `${CASCADE_TAIL}X: PANIC in the runtime)`],
  ] as const) {
    test(`T3 (${c}): a tail never keeps a timeout, a wall-time stop or a panic`, () => {
      expect(serveDaemonReusable([r("error", { notRun: true, message: m })], "v3")).toBe(false);
    });
  }
  test("M-3: the rule itself throws on a duplicate name under v3, never under v2", () => {
    const dup = [
      { ...r("pass"), name: "C.D" },
      { ...r("fail"), name: "C.D" },
    ];
    expect(() => serveDaemonReusable(dup, "v3")).toThrow(AlRunnerServeDuplicateRowError);
    expect(serveDaemonReusable(dup, "v2")).toBe(true);
    expect(serveDaemonReusable([r("pass"), r("pass")], "v3")).toBe(true);
  });
  test("v3 closes on every unknown kind", () => {
    const unknown = [
      r("error", { notRun: true, message: DUP_KEY }),
      r("error", { notRun: true, message: `${HTTP} and more` }),
      r("error", { notRun: true, message: `${COMMIT}.` }),
      r("error", { notRun: true }),
      r("error", { message: COMMIT }),
      r("error", { notRun: false, message: COMMIT }),
      r("fail", { notRun: true, message: COMMIT }),
      r("pass", { notRun: true }),
      r("skipped", { notRun: true, message: COMMIT }),
    ];
    for (const row of unknown) {
      expect([row, serveDaemonReusable([r("pass"), row], "v3")]).toEqual([row, false]);
    }
  });
  // R672 (plan 2026-10-23-r672-v3-refusal-prefix.md §1c): a refusal written as a plain pass/fail
  // (no notRun) says the runtime's state is not trusted, so v3 closes the daemon on it.
  const REFUSAL = "NotRun: out-of-scope: x";
  // R675: and on a plain pass/fail that holds the marker after ANY text (an Assert quoting it too).
  test("R672/R675: v3 closes on a plain fail or pass that holds the refusal marker anywhere", () => {
    for (const row of [
      r("fail", { notRun: false, message: REFUSAL }),
      r("fail", { notRun: false, message: `Error: ${REFUSAL}` }),
      r("pass", { message: `X.Y: ${REFUSAL}` }),
      r("fail", { message: `Runtime error: ${REFUSAL}` }),
      r("pass", { message: `Runtime error: ${REFUSAL}` }),
      r("fail", { message: `a::b: ${REFUSAL}` }),
      r("fail", { message: `A: B: ${REFUSAL}` }),
      r("fail", { message: `Assert.AreEqual failed. Expected: ${REFUSAL}` }),
    ]) {
      expect([row, serveDaemonReusable([row], "v3")]).toEqual([row, false]);
    }
  });
  test("R672/R675: v3 still keeps on a plain fail, a pass and every R612 keep-list refusal; v2 is unchanged", () => {
    for (const row of [
      r("fail", { message: "boom" }),
      r("fail", { message: "out-of-scope: x" }),
      r("pass"),
      ...[HTTP, COMMIT, CASCADE, ONRUN].map((message) => r("error", { notRun: true, message })),
    ]) {
      expect([row, serveDaemonReusable([row], "v3")]).toEqual([row, true]);
    }
    expect(serveDaemonReusable([r("fail", { notRun: false, message: REFUSAL })], "v2")).toBe(true);
  });

  // R945: the seven families R-937's probe measured clean (`/coord/handoff/R-937/probe/README.md`,
  // invented AL, edge-42af5d384), each keeping on the probe's exact texts and on texts of the same
  // shape from Cryptography Management's run, and closing on everything around them.
  const P = "NotRun: out-of-scope: ";
  const R945: Record<string, { keeps: string[]; closes: string[] }> = {
    "dotnet-exception": {
      keeps: [
        `${P}DotNet System.Convert.FromBase64String raised the .NET exception System.FormatException: The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.; the text AL would see is not pinned (ADR-014 section 7)`,
        `${P}DotNet new System.IO.MemoryStream raised the .NET exception System.ArgumentOutOfRangeException: capacity ('-1') must be a non-negative value. (Parameter 'capacity')`,
        `${P}DotNet new System.Guid raised the .NET exception System.FormatException: Unrecognized Guid format.; the text AL would see is not pinned (ADR-014 section 7)`,
      ],
      closes: [
        // Build review: a type the probe did not measure closes, whatever its message says.
        `${P}DotNet System.Threading.SemaphoreSlim.Wait raised the .NET exception System.TimeoutException: Time out has expired.`,
        `${P}DotNet System.IO.MemoryStream.Write raised the .NET exception System.ObjectDisposedException: Cannot access a closed Stream.`,
        `${P}DotNet System.X.Y raised the .NET exception System.OutOfMemoryException: x`,
        `${P}DotNet System.X.Y raised the .NET exception System.FormatExceptionX: x`,
        `${P}DotNet System.X.Y raised the .NET exception System.FormatException; x`,
        `${P}DotNet System X.Y raised the .NET exception System.FormatException: x`,
        `${P}DotNet System.Convert.FromBase64String raised the .NET exception System.TimeoutException: The operation has timed out.`,
        `${P}DotNet System.X.Y raised the .NET exception System.Exception: Test exceeded 3s timeout.`,
        `${P}DotNet System.X.Y raised the .NET exception System.Exception: boom\nNotRun: out-of-scope: anything`,
        `${P}DotNet System.X.Y raised the .NET exception`,
        `x${P}DotNet System.X.Y raised the .NET exception System.Exception: boom`,
      ],
    },
    "dotnet-no-object": {
      keeps: [
        `${P}DotNet System.Text.StringBuilder.Append: 'System.Text.StringBuilder.Append' is an instance member and the variable holds no object`,
      ],
      closes: [
        `${P}DotNet System.Text.StringBuilder.Append: 'System.Text.StringBuilder.Append' is an instance member and the variable holds no object after a timeout`,
        // An array type's member: never measured.
        `${P}DotNet System.Security.Cryptography.KeySizes[].GetValue: 'System.Security.Cryptography.KeySizes[].GetValue' is an instance member and the variable holds no object`,
      ],
    },
    "dotnet-assembly": {
      keeps: [
        `${P}DotNet new R937Missing.Lib.Thing: assembly 'R937Missing.Lib' could not be loaded: FileNotFoundException: Could not load file or assembly 'R937Missing.Lib, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified. Searched the .NET runtime's own assemblies, then: /work/tools/al-runtime-rs/cache/artifacts/28.4.53241.53758/service. To use it, pass a folder that holds R937Missing.Lib.dll with --dotnet-assembly-dir.`,
      ],
      closes: [
        `${P}DotNet new R.Thing: assembly 'R' could not be loaded: FileNotFoundException: the load timed out`,
        `${P}DotNet new R.Thing: assembly 'R' could not be loaded: BadImageFormatException: x`,
        // Build review: a dependency that failed after the assembly itself loaded: never measured.
        `${P}DotNet new R.Thing: assembly 'R' could not be loaded: FileNotFoundException: Could not load file or assembly 'R' or one of its dependencies. The system cannot find the file specified. x`,
        `${P}DotNet new R Thing: assembly 'R' could not be loaded: FileNotFoundException: Could not load file or assembly 'R'. The system cannot find the file specified. x`,
      ],
    },
    "dotnet-member": {
      keeps: [
        `${P}DotNet System.Text.StringBuilder.NoSuchMethod: member 'NoSuchMethod' not found on 'System.Text.StringBuilder'`,
        `${P}DotNet System.Text.StringBuilder.NoSuchProp: property, field or method 'NoSuchProp' not found on 'System.Text.StringBuilder'`,
        `${P}DotNet System.Text.StringBuilder.NoSuchProp: settable property or field 'NoSuchProp' not found on 'System.Text.StringBuilder'`,
      ],
      closes: [
        `${P}DotNet System.Text.StringBuilder.NoSuchMethod: member 'NoSuchMethod' not found on 'System.Text.StringBuilder' (panic)`,
        `${P}DotNet System.Text.StringBuilder.X: event 'X' not found on 'System.Text.StringBuilder'`,
        `${P}DotNet System.Text.String Builder.X: member 'X' not found on 'System.Text.StringBuilder'`,
      ],
    },
    "dotnet-overload": {
      keeps: [
        `${P}DotNet System.Text.StringBuilder.Append: System.Text.StringBuilder.Append has no overload taking 7 argument(s) of the given types (String, String, String, String, String, String, String)`,
        `${P}DotNet new System.Security.Cryptography.X509Certificates.CertificateRequest: new System.Security.Cryptography.X509Certificates.CertificateRequest has no overload taking 4 argument(s) of the given types (String, RSACryptoServiceProvider, null, RSASignaturePadding)`,
      ],
      closes: [
        `${P}DotNet System.Text.StringBuilder.Append: System.Text.StringBuilder.Append has no overload taking 7 argument(s) of the given types (String) and then a timeout`,
        `${P}DotNet System.Text.String Builder.Append: System.Text.StringBuilder.Append has no overload taking 1 argument(s) of the given types (String)`,
      ],
    },
    "stream-never-created": {
      keeps: [
        `${P}use of an InStream that was never created`,
        `${P}use of an OutStream that was never created`,
      ],
      closes: [
        // Never produced by the probe (F1): still closes.
        `${P}InStream method on an unassigned Variant`,
        `${P}OutStream method on an unassigned Variant`,
        `${P}use of an unassigned XmlElement`,
        `${P}use of an InStream that was never created x`,
      ],
    },
    "dotnet-policy-timezone": {
      keeps: [
        `${P}DotNet System.TimeZoneInfo.Local: refused by policy: member 'System.TimeZoneInfo.Local' (time zone that bypasses the host)`,
      ],
      closes: [
        // Another policy refusal: never measured.
        `${P}DotNet System.Environment.SetEnvironmentVariable: refused by policy: member 'System.Environment.SetEnvironmentVariable' (a member the runtime does not implement for a registry type (never forwarded to .NET, ADR-014 section 1))`,
        // Build review: another member under the same rule: only TimeZoneInfo.Local was measured.
        `${P}DotNet System.DateTime.Now: refused by policy: member 'System.DateTime.Now' (time zone that bypasses the host)`,
      ],
    },
  };
  for (const [entry, { keeps: k, closes: c }] of Object.entries(R945)) {
    test(`R945 ${entry}: keeps on each measured text; closes on a tail, a prefix, a timeout word or an unmeasured sibling`, () => {
      for (const m of k) expect([m, keeps(m)]).toEqual([m, true]);
      for (const m of [...c, ...k.map((x) => `${x}\n`), ...k.map((x) => `x${x}`)])
        expect([m, keeps(m)]).toEqual([m, false]);
      for (const m of k) expect([m, keeps(m, false)]).toEqual([m, false]);
    });
  }
});
