import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import {
  DOCTOR_SCHEMA_VERSION,
  FLAG_OWNERS,
  NOTHING_SCORED_EXIT_CODE,
  QUARANTINED_EXIT_CODE,
  RUN_FLAGS,
  VERIFY_NOT_ALL_KILLED_EXIT_CODE,
  VERIFY_REFUSED_EXIT_CODE,
  exitCodeForReport,
  helpText,
  parseCliConfig,
} from "../src/cli";
import {
  EQUIVALENCE_MARKS_FILENAME,
  applyEquivalenceMarks,
  parseEquivalenceMarks,
} from "../src/equivalence-marks";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import { ARTIFACT_ID_ABSENCES, EXPLAIN_SCHEMA_VERSION, explain } from "../src/explain";
import { LARGE_RUN_MUTANT_THRESHOLD } from "../src/orchestrator";
import { REPORT_SCHEMA_VERSION } from "../src/report";
import { identityKeyOf, serializeKey } from "../src/selection";
import {
  KILLED_BY,
  NEW_TEST_STATES,
  TEST_APP_REFUSALS,
  VERIFY_EXIT,
  VERIFY_REFUSALS,
  VERIFY_SCHEMA_VERSION,
  VERIFY_VERDICTS,
  parseVerifyRequest,
  verifyExitCode,
} from "../src/verify";

/**
 * R153. Two documents tell an OUTSIDE consumer how to call LethAL and how to read what it returns:
 * `docs/using-lethal-from-an-agent.md` (the reference) and `skills/lethal-mutation-testing/SKILL.md`
 * (the copyable operational form). Both make promises about flags, exit codes and schema versions.
 *
 * A document is the easiest thing in a repository to leave behind, and these two are worse than
 * most: they are meant to be COPIED into someone else's agent, so a stale claim keeps working for
 * whoever pasted it long after this repository moved. So neither is checked by reading — each
 * promise is asserted against the constant or the flag table it is a promise about.
 *
 * What this cannot do is judge whether the prose is GOOD, or whether an accurate sentence is the
 * one worth saying. That is review, and saying so is better than implying a test covers it.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const REFERENCE = join(REPO_ROOT, "docs", "using-lethal-from-an-agent.md");
const SKILL = join(REPO_ROOT, "skills", "lethal-mutation-testing", "SKILL.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Collapses runs of whitespace, so an assertion about a SENTENCE is not defeated by where the
 *  paragraph happened to wrap. A test that reddens on a reflow trains its reader to ignore it. */
function flowed(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Matches `key: <n>` in prose and `"key": <n>` inside a JSON sample, so one assertion covers both
 *  spellings a document legitimately uses. */
function statesVersion(text: string, key: string, version: number): boolean {
  return new RegExp(`${key}"?:\\s*${version}\\b`).test(text);
}

/** Flags a reader may legitimately meet that are not in `RUN_FLAGS`: `parseCliConfig` answers these
 *  two before `parseArgs` ever runs, so they are real but live outside the table. */
const NON_TABLE_FLAGS = new Set(["--help", "--version"]);

describe("the agent-facing documents (R153)", () => {
  const docs: ReadonlyArray<[string, string]> = [
    ["reference", read(REFERENCE)],
    ["skill", read(SKILL)],
  ];

  test("both documents exist and are not stubs", () => {
    for (const [name, text] of docs) {
      expect(text.length, `${name} is empty or missing`).toBeGreaterThan(1_000);
    }
  });

  test("every --flag either document names is a flag LethAL actually accepts", () => {
    // The classic documentation rot, and the one an outside consumer pays for: a document naming a
    // flag that was renamed or never existed. Derived from `RUN_FLAGS`, so a rename reddens here
    // rather than in someone else's agent.
    const known = new Set([...Object.keys(RUN_FLAGS).map((f) => `--${f}`), ...NON_TABLE_FLAGS]);
    for (const [name, text] of docs) {
      const named = [...new Set(text.match(/--[a-z][a-z0-9-]+/g) ?? [])];
      expect(
        named.length,
        `${name} names no flags at all — did the format change?`,
      ).toBeGreaterThan(5);
      expect(
        named.filter((f) => !known.has(f)),
        `${name} names unknown flag(s)`,
      ).toEqual([]);
    }
  });

  test("the exit codes promised are the exit codes the binary returns", () => {
    for (const [name, text] of docs) {
      expect(text, `${name} must state the quarantine exit code`).toContain(
        `\`${QUARANTINED_EXIT_CODE}\``,
      );
      // Stated as a MEANING, not just a number: an agent that reads 3 as "tests failed" would
      // report verdicts the run itself refuses to stand behind.
      expect(
        flowed(text).toLowerCase(),
        `${name} must say what ${QUARANTINED_EXIT_CODE} means`,
      ).toContain("vouch for its own verdicts");
      // R190: the same for the nothing-scored code. An agent that reads 4 as "tests failed" would
      // report a finding from a run that executed no mutant at all.
      expect(text, `${name} must state the nothing-scored exit code`).toContain(
        `\`${NOTHING_SCORED_EXIT_CODE}\``,
      );
      expect(
        flowed(text).toLowerCase(),
        `${name} must say what ${NOTHING_SCORED_EXIT_CODE} means`,
      ).toContain("measured nothing");
    }
  });

  test("the reference's schema versions are this build's schema versions", () => {
    const text = read(REFERENCE);
    expect(statesVersion(text, "[^a-zA-Z]schemaVersion", REPORT_SCHEMA_VERSION)).toBe(true);
    expect(statesVersion(text, "explainSchemaVersion", EXPLAIN_SCHEMA_VERSION)).toBe(true);
    expect(statesVersion(text, "streamSchemaVersion", STREAM_SCHEMA_VERSION)).toBe(true);
    expect(statesVersion(text, "doctorSchemaVersion", DOCTOR_SCHEMA_VERSION)).toBe(true);
  });

  test("the large-run refusal is documented with the threshold that is actually enforced", () => {
    // A consumer that plans an unscoped run against the wrong number discovers the refusal after
    // building its whole invocation. Both spellings are accepted so prose may use a thousands
    // separator.
    const plain = String(LARGE_RUN_MUTANT_THRESHOLD);
    const grouped = LARGE_RUN_MUTANT_THRESHOLD.toLocaleString("en-US");
    for (const [name, text] of docs) {
      expect(
        text.includes(plain) || text.includes(grouped),
        `${name} must state the ${plain}-site refusal`,
      ).toBe(true);
    }
  });

  test("both documents carry the six rules that stop a wrong conclusion", () => {
    // Each of these is a fact a consumer cannot derive from the output and will get wrong by
    // default. They are the reason these documents exist at all, so their absence is a failure
    // rather than a style note.
    for (const [name, text] of docs) {
      const lower = text.toLowerCase();
      expect(lower, `${name}: read validity before quoting the score`).toContain("validity");
      expect(lower, `${name}: a survivor is a lead`).toContain("a lead, not a proven");
      expect(text, `${name}: NDJSON verdicts are provisional`).toContain("session-finished");
      expect(text, `${name}: executionProven decides a survivor's worth`).toContain(
        "executionProven",
      );
      // R190: the fifth rule — a run that measured nothing is not a result.
      expect(lower, `${name}: exit 4 is not a result`).toContain("measured nothing");
    }
  });

  test("both documents state the sandbox-only rule before anything that publishes", () => {
    // LethAL leaves a changed build published until the user republishes their own app. An agent
    // that learns this after the fact has already done it.
    for (const [name, text] of docs) {
      const lower = text.toLowerCase();
      expect(lower, `${name} must say sandbox or dev container only`).toContain(
        "never a production",
      );
    }
  });

  test("the skill's frontmatter has the fields a skill loader reads", () => {
    const text = read(SKILL);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^name: lethal-mutation-testing$/m);
    expect(text).toMatch(/^description: .{40,}$/m);
  });
});
const GIFT_CARD = join(
  REPO_ROOT,
  "docs",
  "campaign",
  "2026-08-16-gift-card",
  "rehearsal.report.json",
);

/** Shell words, honouring "..." and '...'. The documents' examples use no variables or
 *  substitutions on purpose: an example must work exactly as a reader copies it. */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** Every `lethal ...` command inside a fenced code block, backslash continuations joined. */
function documentedCommands(text: string): string[][] {
  const out: string[][] = [];
  for (const block of text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").replace(/\\\r?\n\s*/g, " ").split("\n")) {
      const t = line.trim();
      if (t.startsWith("lethal ")) out.push(shellWords(t).slice(1));
    }
  }
  return out;
}

/** The body under one heading, up to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#+ /.test(l) && l.replace(/^#+ /, "") === heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "").length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0] ?? "").length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** A Markdown table's body rows as cells, header and separator dropped. */
function tableRows(body: string): string[][] {
  const rows = body.split("\n").filter((l) => l.startsWith("|"));
  return rows.slice(2).map((r) =>
    r
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim()),
  );
}

/** Every `backticked` token in a cell. */
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

describe("C02-07: the documents' commands and tables are the code's", () => {
  const docs: ReadonlyArray<[string, string]> = [
    ["reference", read(REFERENCE)],
    ["skill", read(SKILL)],
  ];

  test("every lethal command the documents show parses", () => {
    for (const [name, text] of docs) {
      const cmds = documentedCommands(text);
      for (const sub of ["doctor", "run", "explain"]) {
        expect(
          cmds.some((c) => c[0] === sub),
          `${name} shows no \`lethal ${sub}\``,
        ).toBe(true);
      }
      for (const argv of cmds) {
        expect(() => parseCliConfig(argv), `${name}: lethal ${argv.join(" ")}`).not.toThrow();
      }
    }
  });

  test("the reference's ownership table is FLAG_OWNERS", () => {
    const rows = tableRows(section(read(REFERENCE), "Which subcommand reads which flag (checked)"));
    expect(rows.length).toBeGreaterThan(5);
    for (const [flagCell = "", ownersCell = ""] of rows) {
      const flag = ticks(flagCell)[0]?.replace(/^--/, "") ?? "";
      const row = FLAG_OWNERS.find((r) => r.flag === flag);
      expect(row, `--${flag} has no FLAG_OWNERS row`).toBeDefined();
      expect(ticks(ownersCell).sort(), `--${flag}`).toEqual([...(row?.owners ?? [])].sort());
    }
  });

  test("the traps the reference warns about are refused", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    // Each row: | `lethal <sub> ... --flag x` | what to do instead |. The command is run.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const [cmdCell = ""] of rows) {
      const argv = shellWords(ticks(cmdCell)[0] ?? "").slice(1);
      expect(() => parseCliConfig(argv), argv.join(" ")).toThrow(
        /is only accepted by|is not accepted by/,
      );
    }
    const subs = rows.map(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1]);
    expect(subs).toContain("run");
    expect(subs).toContain("explain");
  });

  test("the run exit-code table is exitCodeForReport's", () => {
    const rows = tableRows(section(read(REFERENCE), "Exit codes (checked)"));
    expect(rows.map(([c = ""]) => ticks(c)[0]).sort()).toEqual(
      ["0", "1", String(QUARANTINED_EXIT_CODE), String(NOTHING_SCORED_EXIT_CODE)].sort(),
    );
    const meaning = (code: number) =>
      flowed(rows.find(([c = ""]) => ticks(c)[0] === String(code))?.[1] ?? "").toLowerCase();
    expect(meaning(0)).toContain("says nothing about whether mutants survived");
    expect(exitCodeForReport({ validity: { caveats: ["narrowed"] } })).toBe(0);
    expect(meaning(1)).toContain("error");
    expect(meaning(QUARANTINED_EXIT_CODE)).toContain("vouch for its own verdicts");
    expect(meaning(NOTHING_SCORED_EXIT_CODE)).toContain("measured nothing");
    expect(exitCodeForReport({ validity: { caveats: ["all-errors"] } })).toBe(
      NOTHING_SCORED_EXIT_CODE,
    );
    expect(
      exitCodeForReport({
        quarantined: { reason: "x" } as never,
        validity: { caveats: ["all-errors"] },
      }),
    ).toBe(QUARANTINED_EXIT_CODE);
    expect(flowed(read(REFERENCE))).toContain(
      `both quarantined and scored nothing, \`${QUARANTINED_EXIT_CODE}\` wins`,
    );
  });

  test("the documented default database is the one run uses", () => {
    const parsed = parseCliConfig(["run", "--project", "P", "--tests", "T", "--backend", "bcdev"]);
    expect(parsed.mode === "run" ? parsed.dbPath : "").toBe(join("P", "lethal.sqlite"));
    expect(section(read(REFERENCE), "Running (checked)")).toContain("`<project>/lethal.sqlite`");
  });

  test("every linked schema exists and each current one is linked", () => {
    const text = read(REFERENCE);
    const linked = [...text.matchAll(/\.\.\/schemas\/([a-z]+-v\d+\.schema\.json)/g)].map(
      (m) => m[1] ?? "",
    );
    for (const f of linked) expect(existsSync(join(REPO_ROOT, "schemas", f)), f).toBe(true);
    for (const f of [
      `report-v${REPORT_SCHEMA_VERSION}`,
      `explain-v${EXPLAIN_SCHEMA_VERSION}`,
      `stream-v${STREAM_SCHEMA_VERSION}`,
      `doctor-v${DOCTOR_SCHEMA_VERSION}`,
    ]) {
      expect(linked, `the reference must link ${f}.schema.json`).toContain(`${f}.schema.json`);
    }
  });

  test("the demo report's counts are the ones quoted", () => {
    const r = JSON.parse(read(GIFT_CARD)) as {
      readonly counts: {
        readonly killed: number;
        readonly survived: number;
        readonly noCoverage: number;
      };
      readonly mutants: readonly unknown[];
    };
    expect(flowed(read(REFERENCE))).toContain(
      `${r.mutants.length} mutants, ${r.counts.killed} killed, ${r.counts.survived} survived, ${r.counts.noCoverage} no-coverage`,
    );
  });

  test("every section says whether a test checks it", () => {
    const headings = read(REFERENCE)
      .split("\n")
      .filter((l) => /^#{2,6} /.test(l));
    expect(headings.length).toBeGreaterThan(10);
    expect(headings.filter((h) => !/ \((checked|guidance)\)$/.test(h))).toEqual([]);
  });

  test("no em dashes", () => {
    for (const [name, text] of docs) expect(text.includes("—"), name).toBe(false);
  });
});

const ART = "0123456789abcdef0123456789abcdef";

type ReportRow = {
  readonly mutantCode: string;
  readonly verdict: string;
  readonly astHash: string;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly triggerName?: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
  readonly identityOrdinal?: number;
};

/** The single line of a kind, or a thrown error: two recipes would let a wrong one hide. */
function onlyLine(text: string, pick: (argvOrLine: string) => boolean): string {
  const lines = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)]
    .flatMap((b) =>
      (b[1] ?? "")
        .replace(/\\\r?\n\s*/g, " ")
        .split("\n")
        .map((l) => l.trim()),
    )
    .filter(pick);
  if (lines.length !== 1) throw new Error(`expected exactly one such line, found ${lines.length}`);
  return lines[0] ?? "";
}

/** Runs a verify argv the way `verifyFromCli` starts: argv parse, then the request parse. Returns
 *  both, so a caller can pin the database and test project as well as the ids. */
function verifyRequestOf(argv: readonly string[]) {
  const parsed = parseCliConfig([...argv]);
  if (parsed.mode !== "verify") throw new Error(`not a verify command: ${argv.join(" ")}`);
  return { parsed, req: parseVerifyRequest(parsed.artifact, parsed.survivors) };
}

describe("C02-07: the hardening loop, run from the documents", () => {
  const docs: ReadonlyArray<[string, string]> = [
    ["reference", read(REFERENCE)],
    ["skill", read(SKILL)],
  ];

  test("every verify example is a request verify accepts", () => {
    for (const [name, text] of docs) {
      const examples = documentedCommands(text).filter(
        (c) => c[0] === "verify" && !c.join(" ").includes("<"),
      );
      expect(examples.length, `${name} shows no literal \`lethal verify\``).toBeGreaterThan(0);
      for (const argv of examples) {
        expect(() => verifyRequestOf(argv), `${name}: lethal ${argv.join(" ")}`).not.toThrow();
      }
    }
  });

  test("the documented recipe turns an explain row into a request for that row", () => {
    const report = {
      ...JSON.parse(read(GIFT_CARD)),
      artifacts: [
        { batchIndex: 0, artifactId: ART, sha256: "0".repeat(64), appVersion: "1.0.0.0" },
      ],
    };
    const rows = explain(report).survivors;
    expect(rows.length).toBeGreaterThan(0);
    const recipe = onlyLine(
      read(REFERENCE),
      (l) => l.startsWith("lethal verify ") && l.includes("<"),
    );
    for (const row of rows) {
      const fields = row as unknown as Record<string, unknown>;
      const filled = recipe.replace(/<([A-Za-z-]+)>/g, (_, name: string) => {
        if (name === "project") return "P";
        if (name === "tests-dir") return "T";
        if (name === "config") return "C";
        const v = fields[name];
        if (v === undefined)
          throw new Error(`recipe placeholder <${name}> is not an explain survivor field`);
        return String(v);
      });
      const { parsed, req } = verifyRequestOf(shellWords(filled).slice(1));
      expect(req.artifactId).toBe(ART);
      const { batchIndex, mutantCode } = row;
      if (batchIndex === undefined) throw new Error(`survivor ${mutantCode} has no batchIndex`);
      expect(req.ids).toEqual([{ batchIndex, mutantCode }]);
      // The rest of the loop: the run's own database (the run default for project P) and the
      // test project the agent edited. A valid request against the wrong store or tests is the
      // "valid request, wrong hardening loop" case.
      expect(parsed.dbPath).toBe("P/lethal.sqlite");
      expect(parsed.testDir).toBe("T");
      // Without --config verify reads <project>/lethal.config.json, not the config the run used.
      expect(parsed.configPath).toBe("C");
    }
    const body = section(read(REFERENCE), "From an explain row to a verify command (checked)");
    const absences = tableRows(body).map(([c = ""]) => ticks(c)[0] ?? "");
    expect(new Set(absences)).toEqual(new Set(ARTIFACT_ID_ABSENCES));
  });

  test("a mark built by the documented recipe loads and matches", () => {
    const rows = (JSON.parse(read(GIFT_CARD)) as { readonly mutants: readonly ReportRow[] })
      .mutants;
    const survivors = rows.filter((m) => m.verdict === "survived" && !m.identityOrdinal);
    expect(survivors.length).toBeGreaterThan(0);
    // A trigger row is present, so the fallback below matters; the doc must state it, or a reader
    // following the recipe alone builds a key with an empty procedure name.
    expect(survivors.some((m) => m.procedureName === "")).toBe(true);
    expect(flowed(section(read(REFERENCE), "Marking an equivalent survivor (checked)"))).toContain(
      "Use `triggerName` when `procedureName` is empty.",
    );
    const recipe = onlyLine(read(REFERENCE), (l) => l.startsWith("key = ")).slice("key = ".length);
    const keyOf = (m: ReportRow) =>
      recipe.replace(/<([A-Za-z]+)>/g, (_, name: string) => {
        const v =
          name === "procedureName"
            ? m.procedureName || m.triggerName || ""
            : (m as Record<string, unknown>)[name];
        if (v === undefined)
          throw new Error(`recipe placeholder <${name}> is not a report row field`);
        return String(v);
      });
    const file = JSON.stringify({
      marks: survivors.map((m) => ({ key: keyOf(m), reason: "equivalent" })),
    });
    const marks = parseEquivalenceMarks(file, EQUIVALENCE_MARKS_FILENAME);
    const identity = (m: ReportRow) =>
      serializeKey(
        identityKeyOf({
          ...m,
          operatorVersion: `${m.operatorMajor}.0.0`,
        } as unknown as MutantManifestEntry),
      );
    const result = applyEquivalenceMarks(
      marks,
      rows.map((m) => ({ mutantCode: m.mutantCode, identity: identity(m), verdict: m.verdict })),
    );
    expect(result.stale).toEqual([]);
    expect(result.contradicted).toEqual([]);
    expect(result.matched.map((x) => x.mutantCode).sort()).toEqual(
      survivors.map((m) => m.mutantCode).sort(),
    );
    expect(section(read(REFERENCE), "Marking an equivalent survivor (checked)")).toContain(
      EQUIVALENCE_MARKS_FILENAME,
    );
  });

  test("the R230 limit the doc states is the code's", () => {
    // A twin after the first serializes with a sixth field, which the marks parser refuses today.
    // When R230 is fixed this test goes red: then delete the limit from the doc and this test.
    const twin = serializeKey({
      astHash: "h",
      codeunitName: "C",
      procedureName: "P",
      operatorName: "o",
      operatorMajor: 1,
      ordinal: 2,
    });
    expect(() =>
      parseEquivalenceMarks(JSON.stringify({ marks: [{ key: twin, reason: "r" }] }), "t"),
    ).toThrow(/expected 5/);
    const body = flowed(section(read(REFERENCE), "Marking an equivalent survivor (checked)"));
    expect(body).toContain("`identityOrdinal`");
    expect(body).toContain("R230");
  });

  test("verifySchemaVersion is this build's", () => {
    expect(statesVersion(read(REFERENCE), "verifySchemaVersion", VERIFY_SCHEMA_VERSION)).toBe(true);
    expect(read(REFERENCE)).toContain(`../schemas/verify-v${VERIFY_SCHEMA_VERSION}.schema.json`);
  });

  test("verify's value sets are exact, per field", () => {
    // | `results[].verdict` | `killed`, `survived`, ... |
    const rows = tableRows(section(read(REFERENCE), "Reading a verify result (checked)"));
    const valuesOf = (field: string) => {
      const matching = rows.filter(([f = ""]) => ticks(f)[0] === field);
      // Exactly once: a second row for the same field could carry different values and hide.
      expect(matching.length, `rows for ${field}`).toBe(1);
      return new Set(ticks(matching[0]?.[1] ?? ""));
    };
    expect(valuesOf("results[].verdict")).toEqual(new Set(VERIFY_VERDICTS));
    expect(valuesOf("newTests[].state")).toEqual(new Set(NEW_TEST_STATES));
    expect(valuesOf("results[].killedBy")).toEqual(new Set(KILLED_BY));
  });

  test("the refusal table is VERIFY_REFUSALS", () => {
    const listed = tableRows(section(read(REFERENCE), "Verify refusals (checked)")).map(
      ([c = ""]) => ticks(c)[0] ?? "",
    );
    expect(listed.length).toBe(new Set(listed).size);
    expect(new Set(listed)).toEqual(new Set(VERIFY_REFUSALS));
  });

  test("verify exit codes and their precedence", () => {
    expect(VERIFY_NOT_ALL_KILLED_EXIT_CODE).toBe(VERIFY_EXIT.notAllKilled);
    expect(VERIFY_REFUSED_EXIT_CODE).toBe(VERIFY_EXIT.refused);
    const rows = tableRows(section(read(REFERENCE), "Verify exit codes (checked)"));
    const codes = rows.map(([c = ""]) => ticks(c)[0] ?? "");
    expect(codes.length, "a duplicated exit-code row").toBe(new Set(codes).size);
    expect(new Set(codes)).toEqual(new Set(["1", ...Object.values(VERIFY_EXIT).map(String)]));
    // Exit 3's row names exactly the test-app reasons that quarantine, and the refusal table none.
    const quarantining = Object.entries(TEST_APP_REFUSALS)
      .filter(([, to]) => to === "quarantined")
      .map(([r]) => r);
    const row3 =
      rows.find(([c = ""]) => ticks(c)[0] === String(VERIFY_EXIT.quarantined))?.[1] ?? "";
    // Filter by membership, not by a name prefix, so a future quarantining reason of any name counts.
    const testAppReasons: readonly string[] = Object.keys(TEST_APP_REFUSALS);
    expect(new Set(ticks(row3).filter((t) => testAppReasons.includes(t)))).toEqual(
      new Set(quarantining),
    );
    // One competing-condition case per precedence boundary, run through the real function.
    const R = (verdict: (typeof VERIFY_VERDICTS)[number]) => ({ verdict });
    const cases: ReadonlyArray<[string, Parameters<typeof verifyExitCode>[0], number]> = [
      [
        "3 over 6",
        { quarantined: "x", refused: {}, results: [], newTests: [] },
        VERIFY_EXIT.quarantined,
      ],
      ["6 over 4", { refused: {}, results: [R("error")], newTests: [] }, VERIFY_EXIT.refused],
      [
        "4 over 5: all error AND a flaky new test",
        { results: [R("error")], newTests: [{ state: "flaky" }] },
        VERIFY_EXIT.nothingMeasured,
      ],
      [
        "4 ignores skipped rows",
        { results: [R("error"), R("skipped")], newTests: [] },
        VERIFY_EXIT.nothingMeasured,
      ],
      [
        "5: one survivor",
        { results: [R("killed"), R("survived")], newTests: [] },
        VERIFY_EXIT.notAllKilled,
      ],
      [
        "5 over 0: all killed but a flaky new test",
        { results: [R("killed")], newTests: [{ state: "flaky" }] },
        VERIFY_EXIT.notAllKilled,
      ],
      [
        "0: all killed, every new test stable",
        { results: [R("killed")], newTests: [{ state: "stable" }] },
        VERIFY_EXIT.ok,
      ],
      ["0: every survivor skipped", { results: [R("skipped")], newTests: [] }, VERIFY_EXIT.ok],
    ];
    for (const [why, input, code] of cases) expect(verifyExitCode(input), why).toBe(code);
    const order = [
      VERIFY_EXIT.quarantined,
      VERIFY_EXIT.refused,
      VERIFY_EXIT.nothingMeasured,
      VERIFY_EXIT.notAllKilled,
      VERIFY_EXIT.ok,
    ]
      .map((c) => `\`${c}\``)
      .join(", ");
    expect(flowed(read(REFERENCE))).toContain(`Precedence: ${order}.`);
    for (const [name, text] of docs) {
      const t = flowed(text).toLowerCase();
      expect(t, `${name}: meaning of 5`).toContain("not every named survivor was killed");
      expect(t, `${name}: meaning of 6`).toContain("refused before measuring");
      expect(t, `${name}: all skipped`).toContain("every survivor skipped");
    }
  });

  test("verify --out is a documented, refused trap", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    const verifyRow = rows.find(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1] === "verify");
    const argv = shellWords(ticks(verifyRow?.[0] ?? "")[0] ?? "").slice(1);
    expect(argv).toContain("--out");
    expect(() => parseCliConfig(argv)).toThrow(/--out/);
  });

  test("both documents carry the six rules", () => {
    const rules: ReadonlyArray<[string, string]> = [
      ["reference", section(read(REFERENCE), "The six rules (checked)")],
      ["skill", section(read(SKILL), "Rules that stop a wrong conclusion")],
    ];
    for (const [name, body] of rules) {
      const items = body.split("\n").filter((l) => /^\d+\. /.test(l));
      expect(items.length, `${name} rule count`).toBe(6);
      const lower = flowed(body).toLowerCase();
      expect(lower, `${name}: rule 6`).toContain("never with `--resume`");
      expect(lower, `${name}: rule 6`).toContain("`skipped` is not a measured kill or survival");
    }
  });
});

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

describe("C02-07: README and --help state the contract's exit codes and rules", () => {
  test("help lists every promised exit code, in the right block", () => {
    const help = helpText("0.0.0");
    const footer = help.split("EXIT CODES")[1] ?? "";
    const runCodes = [...footer.matchAll(/(?:^|\s)(\d)\s/g)].map((m) => Number(m[1]));
    expect(new Set(runCodes)).toEqual(
      new Set([0, 1, QUARANTINED_EXIT_CODE, NOTHING_SCORED_EXIT_CODE]),
    );
    const lines = help.split("\n");
    const verifyStart = lines.findIndex((l) => l.startsWith("VERIFY"));
    const verifyLine = lines.findIndex(
      (l, i) => i > verifyStart && l.trim().startsWith("Exit codes:"),
    );
    expect(verifyStart, "no VERIFY block").toBeGreaterThanOrEqual(0);
    expect(verifyLine, "no verify Exit codes line").toBeGreaterThan(verifyStart);
    const verifyText = lines.slice(verifyLine, verifyLine + 3).join(" ");
    for (const c of Object.values(VERIFY_EXIT))
      expect(verifyText, `verify help omits ${c}`).toMatch(new RegExp(`\\b${c}\\b`));
  });

  test("README agrees with the reference", () => {
    const readme = read(join(REPO_ROOT, "README.md"));
    const body = flowed(section(readme, "Driving it from an agent, a script or CI"));
    expect(body).toContain(`\`${NOTHING_SCORED_EXIT_CODE}\``);
    expect(body.toLowerCase()).toContain("measured nothing");
    const count = section(read(REFERENCE), "The six rules (checked)")
      .split("\n")
      .filter((l) => /^\d+\. /.test(l)).length;
    expect(body).toContain(`the ${NUMBER_WORDS[count]} rules`);
    for (const w of NUMBER_WORDS.filter((_, i) => i !== count))
      expect(body).not.toContain(`the ${w} rules`);
  });

  test("README does not deny that verify publishes the test app", () => {
    // Regression guard only (a string): the claim was true before lethal verify existed.
    expect(read(join(REPO_ROOT, "README.md"))).not.toContain("does not even publish it");
  });
});
