import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import {
  DOCTOR_AL_RUNNER_ONLY_CAVEAT,
  DOCTOR_CAVEAT_KINDS,
  DOCTOR_CREATE_MODE_CAVEAT,
  DOCTOR_NOT_CHECKED_TOKENS,
  DOCTOR_SCHEMA_VERSION,
  FLAG_OWNERS,
  NOTHING_SCORED_EXIT_CODE,
  QUARANTINED_EXIT_CODE,
  RUN_FLAGS,
  VERIFY_NOT_ALL_KILLED_EXIT_CODE,
  VERIFY_REFUSED_EXIT_CODE,
  doctorJson,
  exitCodeForReport,
  helpText,
  parseCliConfig,
  resolveSelectorIds,
} from "../src/cli";
import { checkAlcRuntime } from "../src/doctor";
import {
  EQUIVALENCE_MARKS_FILENAME,
  applyEquivalenceMarks,
  loadEquivalenceMarks,
  parseEquivalenceMarks,
} from "../src/equivalence-marks";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import type { RunEvent, RunEventInput } from "../src/events";
import { ARTIFACT_ID_ABSENCES, EXPLAIN_SCHEMA_VERSION, explain } from "../src/explain";
import { MIN_CONTROL_VERSION } from "../src/harness";
import {
  LARGE_RUN_MUTANT_THRESHOLD,
  MIN_MUTANT_BUDGET_MS,
  REQUEST_CEILING_MS,
  STOP_GRACE_MS,
} from "../src/orchestrator";
import { createNdjsonSink } from "../src/progress-ndjson";
import {
  CAVEAT_INTERPRETATIONS,
  REPORT_SCHEMA_VERSION,
  buildReport,
  renderConsole,
} from "../src/report";
import type { SessionReport } from "../src/report";
import { identityKeyOf, serializeKey } from "../src/selection";
import {
  KILLED_BY,
  NEW_TEST_STATES,
  TEST_APP_REFUSALS,
  UNMUTATED_OUTCOMES,
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

/** The text directly under one heading, up to the NEXT heading of any level: what that heading's
 *  tag vouches for, without the subsections it contains. */
function ownText(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#+ /.test(l) && l.replace(/^#+ /, "") === heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Prose only: fenced code blocks removed, so `ticks` sees inline code and not a whole block. */
const prose = (text: string): string => text.replace(/```[a-z]*\r?\n[\s\S]*?```/g, "");

/** Every property name and every string `enum`/`const` value anywhere in a published schema: the
 *  field names and value domains the build actually writes, since `generate-schemas --check` keeps
 *  the schema equal to the code. */
function schemaVocabulary(file: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (n === null || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (k === "properties" && v !== null && typeof v === "object") {
        for (const p of Object.keys(v)) out.add(p);
      }
      if (k === "const" && typeof v === "string") out.add(v);
      if (k === "enum" && Array.isArray(v))
        for (const e of v) if (typeof e === "string") out.add(e);
      walk(v);
    }
  };
  walk(JSON.parse(read(join(REPO_ROOT, "schemas", file))));
  return out;
}

/** The field and value names a section's prose puts in backticks: `a.b[].c: 1` gives a, b, c. Flags,
 *  commands, paths and placeholders are not names and are skipped. */
function namedFields(body: string): string[] {
  return ticks(prose(body))
    .filter((t) => !/^(--|lethal |\.\.\/|<)/.test(t) && (!t.includes(" ") || t.includes(": ")))
    .flatMap((t) => (t.split(":")[0] ?? "").split("."))
    .map((t) => t.replace(/\[\]$/, "").trim())
    .filter((t) => t !== "" && !/^\d+$/.test(t));
}

/** `a`, `a or b`, `a, b or c`: how the documents list a code value set in a sentence. */
function listed(values: readonly string[], conj: string): string {
  const t = values.map((v) => `\`${v}\``);
  return t.length <= 2 ? t.join(` ${conj} `) : `${t.slice(0, -1).join(", ")} ${conj} ${t.at(-1)}`;
}

const CLI = join(REPO_ROOT, "packages", "runner", "src", "cli.ts");

/** Runs the real CLI entry point, so an exit code and the stream a message lands on are measured. */
function runCli(argv: readonly string[]) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

type SchemaNode = { readonly [k: string]: unknown };

/** Follows `$ref` (`#/$defs/X`) and flattens `anyOf`/`oneOf` into the object variants a value can be. */
function variantsOf(root: SchemaNode, node: unknown): SchemaNode[] {
  if (node === null || typeof node !== "object") return [];
  const n = node as SchemaNode;
  if (typeof n.$ref === "string") {
    const target = n.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((acc, k) => (acc as SchemaNode | undefined)?.[k], root);
    return variantsOf(root, target);
  }
  const union = (n.anyOf ?? n.oneOf) as unknown[] | undefined;
  return union === undefined ? [n] : union.flatMap((v) => variantsOf(root, v));
}

/** The nodes at a path like `validity` or `survivors[]` (`[]` steps into `items`). A missing
 *  property on any variant throws: the path IS the claim. */
function nodesAt(root: SchemaNode, from: SchemaNode[], path: string): SchemaNode[] {
  if (path === "") return from;
  return path.split(".").reduce<SchemaNode[]>(
    (nodes, seg) =>
      nodes.flatMap((node) => {
        const name = seg.replace(/\[\]$/, "");
        const prop = (node.properties as SchemaNode | undefined)?.[name];
        if (prop === undefined) throw new Error(`no property "${name}" on the path "${path}"`);
        const inner = seg.endsWith("[]") ? variantsOf(root, prop).map((v) => v.items) : [prop];
        if (inner.some((x) => x === undefined)) throw new Error(`"${name}" is not an array`);
        return inner.flatMap((x) => variantsOf(root, x));
      }),
    from,
  );
}

/**
 * The location claims a checked result section makes, checked against its schema. Every sentence
 * that says `carries`, `carry` or `values include` must have one of these shapes, so a location
 * claim cannot be written in a form this skips:
 *   The top level carries `a` and `b`.          (required at the root)
 *   `x.y` carries `a`.  Each `x` row carries `a`.  (required on that object, or on every array item)
 *   Every event carries `a`.  The `t` event carries `a`.  (every variant; the variant with type t)
 *   ... can carry ... / can also carry ...      (present, not necessarily required)
 *   The `f` values include `v` and `w`.         (each v is a const/enum value of f)
 * Returns the failures; an empty list means every claim holds.
 */
function locationClaimFailures(body: string, schemaFile: string): string[] {
  const root = JSON.parse(read(join(REPO_ROOT, "schemas", schemaFile))) as SchemaNode;
  const top = variantsOf(root, root);
  const failures: string[] = [];
  const sentences = flowed(prose(body))
    .split(/(?<=[.:])\s+(?=[A-Z`])/)
    .map((x) => x.trim())
    .filter((x) => /\bcarr(?:y|ies)\b|values include/.test(x));
  for (const sentence of sentences) {
    const carry =
      /^(?:(The top level)|(Every event)|The `([^`]+)` event|Each `([^`]+)` row|`([^`]+)`) (carries|can carry|can also carry) (.+)[.:]$/.exec(
        sentence,
      );
    const values = /^The `([^`]+)` values include (.+)\.$/.exec(sentence);
    try {
      if (carry !== null) {
        const [, , , event, row, path, verb = "", rest = ""] = carry;
        let at: SchemaNode[];
        if (event !== undefined) {
          at = top
            .filter((v) => (v.properties as SchemaNode)?.type !== undefined)
            .filter((v) => ((v.properties as SchemaNode).type as SchemaNode).const === event);
          if (at.length !== 1) throw new Error(`no single "${event}" event`);
        } else {
          at = nodesAt(root, top, row !== undefined ? `${row}[]` : (path ?? ""));
        }
        for (const field of ticks(rest)) {
          for (const node of at) {
            const ok =
              verb === "carries"
                ? ((node.required as readonly string[] | undefined) ?? []).includes(field)
                : (node.properties as SchemaNode | undefined)?.[field] !== undefined;
            if (!ok)
              throw new Error(
                `\`${field}\` is not ${verb === "carries" ? "required" : "a property"} there`,
              );
          }
        }
      } else if (values !== null) {
        const [, field = "", rest = ""] = values;
        const domain = new Set(
          top.flatMap((v) => {
            const f = (v.properties as SchemaNode | undefined)?.[field] as SchemaNode | undefined;
            if (f === undefined) return [];
            return [f.const, ...((f.enum as unknown[] | undefined) ?? [])].filter(
              (x): x is string => typeof x === "string",
            );
          }),
        );
        for (const v of ticks(rest)) if (!domain.has(v)) throw new Error(`\`${v}\` is not a value`);
      } else {
        throw new Error("not a recognised location-claim shape");
      }
    } catch (e) {
      failures.push(`${sentence} :: ${(e as Error).message}`);
    }
  }
  return failures;
}

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
    // exitCodeForReport never sees counts, so a narrowed report returning 0 is the whole proof.
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
    const own = ownText(text, "Reading the result (checked)");
    for (const f of [
      `report-v${REPORT_SCHEMA_VERSION}`,
      `explain-v${EXPLAIN_SCHEMA_VERSION}`,
      `stream-v${STREAM_SCHEMA_VERSION}`,
      `doctor-v${DOCTOR_SCHEMA_VERSION}`,
    ]) {
      expect(own, `Reading the result must link ${f}.schema.json`).toContain(
        `../schemas/${f}.schema.json`,
      );
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
    expect(flowed(ownText(read(REFERENCE), "Reading the result (checked)"))).toContain(
      `${r.mutants.length} mutants, ${r.counts.killed} killed, ${r.counts.survived} survived, ${r.counts.noCoverage} no-coverage`,
    );
  });

  test("the doctor sample and its sentences are doctorJson's", () => {
    const own = ownText(read(REFERENCE), "Before anything else: `doctor` (checked)");
    const sampleText = /```json\r?\n([\s\S]*?)```/.exec(own)?.[1] ?? "";
    const sample = JSON.parse(sampleText) as Record<string, unknown>;
    const report = {
      ok: false,
      checks: [checkAlcRuntime({ alcPath: "a", alcVersion: "x", cachePath: "c" })],
    };
    const real = doctorJson(report, DOCTOR_CREATE_MODE_CAVEAT) as unknown as Record<
      string,
      unknown
    >;
    expect(new Set(Object.keys(sample))).toEqual(new Set(Object.keys(real)));
    const first = (x: unknown) => Object.keys((x as readonly object[])[0] ?? {});
    expect(new Set(first(sample.checks))).toEqual(new Set(first(real.checks)));
    expect(new Set(Object.keys(sample.caveat as object))).toEqual(
      new Set(Object.keys(real.caveat as object)),
    );
    expect(sample.doctorSchemaVersion).toBe(DOCTOR_SCHEMA_VERSION);
    expect(sample.notChecked).toEqual([...DOCTOR_NOT_CHECKED_TOKENS]);
    expect(real.notChecked).toEqual([...DOCTOR_NOT_CHECKED_TOKENS]);
    const text = flowed(own);
    expect(text).toContain(`\`notChecked\` is always ${listed(DOCTOR_NOT_CHECKED_TOKENS, "and")}.`);
    expect(text).toContain(`\`caveat.kind\` is ${listed(DOCTOR_CAVEAT_KINDS, "or")}.`);
    // "present only for a config shape that has one": absent without a caveat, and every caveat
    // constant maps to one of the listed kinds.
    expect(Object.keys(doctorJson(report))).not.toContain("caveat");
    expect(
      [DOCTOR_CREATE_MODE_CAVEAT, DOCTOR_AL_RUNNER_ONLY_CAVEAT].map(
        (c) => doctorJson(report, c).caveat?.kind,
      ),
    ).toEqual([...DOCTOR_CAVEAT_KINDS]);
    const owners = FLAG_OWNERS.find((r) => r.flag === "json")?.owners ?? [];
    expect(text).toContain(`\`--json\` is accepted by ${listed(owners, "and")} only.`);
  });

  test("the running section's database and caveat names are the code's", () => {
    const own = ownText(read(REFERENCE), "Running (checked)");
    const withDb = parseCliConfig([
      "run",
      "--project",
      "P",
      "--tests",
      "T",
      "--backend",
      "bcdev",
      "--db",
      "D",
    ]);
    expect(withDb.mode === "run" ? withDb.dbPath : "").toBe("D");
    expect(own).toContain("unless `--db` names another file");
    const line =
      /A narrowed run carries (.*?) in `validity\.caveats`\./.exec(flowed(own))?.[1] ?? "";
    // The narrowing caveats, MEASURED: what buildReport adds for each scope a run can be given.
    const events = (
      [
        {
          type: "mutation-set-generated",
          siteCount: 1,
          deployedCount: 1,
          hangCapableCount: 0,
          totalFiles: 1,
          instrumentableFiles: 1,
          notInstrumentedFiles: [],
          declarativeSiteFiles: [],
          excludedByOnly: 0,
          excludedByExclude: 0,
          excludedByOperator: 0,
          excludedByLines: 0,
        },
        { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
        { type: "session-finished", elapsedMs: 1 },
      ] as RunEventInput[]
    ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
    const caps = {
      authoritative: true,
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
    } as const;
    const caveatsOf = (scope: object) =>
      buildReport({ caps, ...scope }, events).validity.caveats as readonly string[];
    const plain = new Set(caveatsOf({}));
    const scopes = [
      { only: { patterns: ["x"] } },
      { exclude: { patterns: ["x"] } },
      { operators: { names: ["x"] } },
      { lines: { ranges: [{ file: "f.al", start: 1, end: 1 }] } },
      { testsOnly: ["x"] },
    ];
    const narrowing = new Set(scopes.flatMap((sc) => caveatsOf(sc).filter((c) => !plain.has(c))));
    expect(new Set(ticks(line))).toEqual(narrowing);
    // A narrowing caveat with no scope above would be missed by the measurement; the names say so.
    for (const c of Object.keys(CAVEAT_INTERPRETATIONS).filter((k) => /narrowed$/.test(k)))
      expect([...narrowing], `${c} has no scope in this test`).toContain(c);
  });

  test("the dry-run exception names flags dry-run really ignores, and its roadmap row exists", () => {
    const own = flowed(ownText(read(REFERENCE), "Which subcommand reads which flag (checked)"));
    const para = own.slice(own.indexOf("One exception remains"));
    const bare = ["run", "--project", "P", "--dry-run"];
    const flags = ticks(para)
      .filter((t) => /^--[a-z-]+$/.test(t) && t !== "--dry-run")
      .map((t) => t.slice(2));
    expect(flags.length).toBeGreaterThan(0);
    const parsedWith = (flag: string): string => {
      const spec = RUN_FLAGS[flag as keyof typeof RUN_FLAGS] as { readonly type: string };
      for (const v of spec.type === "boolean" ? [undefined] : ["x", "2", "bcdev"]) {
        try {
          return JSON.stringify(
            parseCliConfig([...bare, `--${flag}`, ...(v === undefined ? [] : [v])]),
          );
        } catch {}
      }
      throw new Error(`--${flag} is refused on run --dry-run`);
    };
    for (const f of flags)
      expect(parsedWith(f), `--${f}`).toBe(JSON.stringify(parseCliConfig(bare)));
    const id = /\b(R\d+)\b/.exec(para)?.[1] ?? "";
    expect(read(join(REPO_ROOT, "docs", "roadmap", `R${id.slice(1).padStart(3, "0")}.md`))).toMatch(
      /^status: "open"$/m,
    );
  });

  test("the run exit sentences are exitCodeForReport's and main's", () => {
    const own = flowed(ownText(read(REFERENCE), "Exit codes (checked)"));
    const nothing = Object.keys(CAVEAT_INTERPRETATIONS).filter(
      (c) => exitCodeForReport({ validity: { caveats: [c] } }) === NOTHING_SCORED_EXIT_CODE,
    );
    expect(nothing.length).toBe(1);
    expect(own).toContain(
      `\`${NOTHING_SCORED_EXIT_CODE}\` is returned when \`validity.caveats\` carries \`${nothing[0]}\`.`,
    );
    // Row 1: an argv the parse refuses exits 1 with its message on stderr. The trap is the one the
    // Traps table shows for run.
    const trap = tableRows(section(read(REFERENCE), "Traps (checked)"))
      .map(([c = ""]) => shellWords(ticks(c)[0] ?? "").slice(1))
      .find((argv) => argv[0] === "run");
    if (trap === undefined) throw new Error("no run trap");
    const r = runCli(trap);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--report is only accepted by");
    expect(own).toContain(
      "| `1` | Error, including an argv the parse refuses. The message is on stderr. |",
    );
  }, 30_000);

  test("the result sections name fields and values the schemas define", () => {
    const text = read(REFERENCE);
    const cases: ReadonlyArray<[string, string]> = [
      ["`--out report.json`: the record (checked)", `report-v${REPORT_SCHEMA_VERSION}.schema.json`],
      [
        "`lethal explain report.json`: what it MEANS (checked)",
        `explain-v${EXPLAIN_SCHEMA_VERSION}.schema.json`,
      ],
      [
        "`--progress-out events.ndjson`: following a live run (checked)",
        `stream-v${STREAM_SCHEMA_VERSION}.schema.json`,
      ],
      ["Reading a verify result (checked)", `verify-v${VERIFY_SCHEMA_VERSION}.schema.json`],
    ];
    for (const [heading, schema] of cases) {
      const names = namedFields(ownText(text, heading));
      expect(names.length, heading).toBeGreaterThan(3);
      const vocab = schemaVocabulary(schema);
      // The NDJSON header is not an event, so the stream schema does not describe it (schemas/
      // README.md): its keys come from the sink that writes it.
      if (schema.startsWith("stream-")) {
        let header = "";
        createNdjsonSink((c) => {
          header += c;
        });
        for (const k of Object.keys(JSON.parse(header))) vocab.add(k);
      }
      expect(
        names.filter((n) => !vocab.has(n)),
        heading,
      ).toEqual([]);
      // Where each field lives, not only that the name exists somewhere.
      expect(
        /\b(carries|carry)\b/.test(ownText(text, heading)),
        `${heading} makes no location claim`,
      ).toBe(true);
      expect(locationClaimFailures(ownText(text, heading), schema), heading).toEqual([]);
    }
  });

  test("the explain section's behaviour is explain's", () => {
    const own = flowed(
      ownText(read(REFERENCE), "`lethal explain report.json`: what it MEANS (checked)"),
    );
    const report = JSON.parse(read(GIFT_CARD)) as SessionReport;
    // Refused, not explained with the value dropped: another schema version, or an unknown verdict.
    expect(() =>
      explain({ ...report, schemaVersion: REPORT_SCHEMA_VERSION + 1 } as never),
    ).toThrow();
    const [m0, ...rest] = report.mutants;
    if (m0 === undefined) throw new Error("empty report");
    expect(() =>
      explain({ ...report, mutants: [{ ...m0, verdict: "zz" as never }, ...rest] }),
    ).toThrow(/cannot interpret/);
    expect(own).toContain("is REFUSED rather than explained with the unrecognised value dropped");
    const uncapped = explain(report).survivorSelection;
    const capped = explain(report, { topSurvivors: 1 }).survivorSelection;
    expect(capped.shown).toBe(1);
    expect(capped.total).toBe(uncapped.total);
    expect(own).toContain(
      `\`rankedBy\` is \`${uncapped.rankedBy}\` when no cap was applied and \`${capped.rankedBy}\` when one was.`,
    );
    const sample = JSON.parse(
      `{${/```json\r?\n([\s\S]*?)```/.exec(ownText(read(REFERENCE), "`lethal explain report.json`: what it MEANS (checked)"))?.[1] ?? ""}}`,
    ) as {
      readonly survivorSelection: object;
    };
    expect(new Set(Object.keys(sample.survivorSelection))).toEqual(new Set(Object.keys(uncapped)));
    expect(() => parseCliConfig(["explain", "r.json", "--top", "0"])).toThrow();
    expect(own).toContain("`--top 0` is refused.");
  });

  test("the stream header is the sink's first line", () => {
    const own = flowed(
      ownText(read(REFERENCE), "`--progress-out events.ndjson`: following a live run (checked)"),
    );
    let written = "";
    createNdjsonSink((c) => {
      written += c;
    });
    const header = JSON.parse(written.split("\n")[0] ?? "") as Record<string, unknown>;
    const key =
      ticks(own)
        .find((t) => t.endsWith(": true"))
        ?.split(":")[0] ?? "";
    expect(header[key]).toBe(true);
    expect(own).toContain("Line 1 is a header this sink writes itself");
  });

  test("every section says whether a test checks it", () => {
    const headings = read(REFERENCE)
      .split("\n")
      .filter((l) => /^#{2,6} /.test(l));
    expect(headings.length).toBeGreaterThan(10);
    expect(headings.filter((h) => !/ \((checked|guidance)\)$/.test(h))).toEqual([]);
  });

  test("every (checked) heading is read by name in this file", () => {
    // A (checked) heading no test reads is a promise nothing keeps. Names only: WHAT each test
    // checks is the claim inventory in the C02-07 reject r1 report.
    const self = read(join(import.meta.dir, "agent-contract.test.ts"));
    const checked = read(REFERENCE)
      .split("\n")
      .filter((l) => /^#{2,6} .* \(checked\)$/.test(l))
      .map((l) => l.replace(/^#+ /, ""));
    expect(checked.length).toBeGreaterThan(5);
    expect(checked.filter((h) => !self.includes(`"${h}"`))).toEqual([]);
  });

  test("no em dashes", () => {
    for (const [name, text] of [...docs, ["README", read(join(REPO_ROOT, "README.md"))] as const])
      expect(text.includes("—"), name).toBe(false);
  });

  test("the code constants the documents quote are the code's", () => {
    // I4: a figure copied from a constant goes stale silently, guidance section or not.
    const readme = read(join(REPO_ROOT, "README.md"));
    for (const [name, text] of [...docs, ["README", readme] as const]) {
      const versions = [...text.matchAll(/\b1\.0\.0\.\d+\b/g)].map((m) => m[0]);
      expect(
        versions.filter((v) => v !== MIN_CONTROL_VERSION),
        name,
      ).toEqual([]);
    }
    for (const [name, text] of docs)
      expect(flowed(text), name).toContain(`LethAL Control ${MIN_CONTROL_VERSION} or newer`);
    const ref = flowed(read(REFERENCE));
    expect(ref).toContain(`the default is ${REQUEST_CEILING_MS / 1000} s`);
    expect(ref).toContain(`above the ceiling minus ${STOP_GRACE_MS / 1000} s`);
    // README's Configuration table: each default the code owns.
    const rows = tableRows(section(readme, "Configuration"));
    const defaultOf = (flag: string) =>
      rows.find(([f = ""]) => ticks(f).some((t) => t.split(" ")[0] === flag))?.[1] ?? "";
    expect(defaultOf("--mutant-timeout-ms")).toBe(`\`${MIN_MUTANT_BUDGET_MS}\``);
    const run = parseCliConfig(["run", "--project", "P", "--tests", "T", "--backend", "bcdev"]);
    if (run.mode !== "run") throw new Error("not a run");
    expect(defaultOf("--workers")).toBe(`\`${run.workers}\``);
    expect(normalize(ticks(defaultOf("--config"))[0] ?? "").replace("<project>", "P")).toBe(
      normalize(run.configPath),
    );
    expect(normalize(ticks(defaultOf("--db"))[0] ?? "").replace("<project>", "P")).toBe(
      normalize(run.dbPath),
    );
    const ids = Object.values(resolveSelectorIds({}, undefined));
    expect(defaultOf("--selector-id")).toBe(`\`${Math.min(...ids)}\` to \`${Math.max(...ids)}\``);
    const large = rows.find(([f = ""]) => ticks(f)[0] === "--allow-large-run")?.[2] ?? "";
    expect(large).toContain(LARGE_RUN_MUTANT_THRESHOLD.toLocaleString("en-US"));
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

  test("each literal verify example targets the run its document shows", () => {
    // The loop's other half: a valid request against another database, test project or config
    // hardens nothing. The substitution is the document's own sentence, `<x>` as `y`.
    for (const [name, text] of docs) {
      const values = new Map(
        [...flowed(text).matchAll(/`<([a-z-]+)>` as `([^`]+)`/g)].map((m) => [
          m[1] ?? "",
          m[2] ?? "",
        ]),
      );
      expect(values.size, `${name} states no substitution`).toBeGreaterThan(0);
      const runLine = onlyLine(text, (l) => l.startsWith("lethal run ") && l.includes("--tests"));
      const filled = runLine.replace(/<([A-Za-z-]+)>/g, (_, p: string) => {
        const v = values.get(p);
        if (v === undefined) throw new Error(`${name}: run placeholder <${p}> has no stated value`);
        return v;
      });
      const run = parseCliConfig(shellWords(filled).slice(1));
      if (run.mode !== "run") throw new Error(`${name}: not a run: ${filled}`);
      const examples = documentedCommands(text).filter(
        (c) => c[0] === "verify" && !c.join(" ").includes("<"),
      );
      expect(examples.length, `${name} shows no literal verify`).toBeGreaterThan(0);
      for (const argv of examples) {
        const { parsed } = verifyRequestOf(argv);
        expect(normalize(parsed.dbPath), `${name}: --db`).toBe(normalize(run.dbPath));
        expect(parsed.testDir, `${name}: --tests`).toBe(run.testDir);
        expect(parsed.configPath, `${name}: --config`).toBe(run.configPath);
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
      (l) => l.startsWith("lethal verify ") && l.includes("<batchIndex>/<mutantCode>"),
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
    // "A row with no `artifactId` has `artifactIdAbsent` instead": the report without artifacts.
    for (const row of explain(JSON.parse(read(GIFT_CARD))).survivors) {
      expect(row.artifactId).toBeUndefined();
      expect(row.artifactIdAbsent).toBeDefined();
    }
    const body = section(read(REFERENCE), "From an explain row to a verify command (checked)");
    const absences = tableRows(body).map(([c = ""]) => ticks(c)[0] ?? "");
    expect(new Set(absences)).toEqual(new Set(ARTIFACT_ID_ABSENCES));
  });

  test("the documented gap recipe turns an explain gap into a request for that gap, against that gap's artifact", () => {
    // Two batches, so an artifact taken from the wrong batch cannot coincide with the right one.
    // Gaps are the report's procedures; batch 1 (the LAST `artifacts` entry) holds the later ones.
    const base = JSON.parse(read(GIFT_CARD)) as SessionReport;
    const LATE = new Set(["Redeem", "GetBalance", "BlockExpiredCards", "PostEntry"]);
    const blocks = new Map<string, number[]>();
    for (const m of base.mutants) {
      const k = `${m.file}|${m.procedureName}`;
      blocks.set(k, [...(blocks.get(k) ?? []), m.line]);
    }
    const ids = [...blocks.keys()];
    const mutants = base.mutants.map((m) => {
      const k = `${m.file}|${m.procedureName}`;
      const lines = blocks.get(k) ?? [];
      return {
        ...m,
        batchIndex: LATE.has(m.procedureName) ? 1 : 0,
        gapId: `G${ids.indexOf(k).toString(16).padStart(12, "0")}`,
        blockStartLine: Math.min(...lines),
        blockEndLine: Math.max(...lines),
        // One carried survivor makes its whole gap `carried`.
        ...(m.mutantCode === "M0038" ? { carried: true } : {}),
      };
    });
    const ART_1 = "fedcba9876543210fedcba9876543210";
    const artifacts = [
      { batchIndex: 0, artifactId: ART, sha256: "0".repeat(64), appVersion: "1.0.0.0" },
      { batchIndex: 1, artifactId: ART_1, sha256: "1".repeat(64), appVersion: "1.0.0.1" },
    ];
    const report = { ...base, mutants, artifacts } as SessionReport;
    // The copy loses batch 0's entry only; the unrelated last entry stays.
    const unpublished = { ...report, artifacts: artifacts.filter((a) => a.batchIndex !== 0) };
    const recipe = onlyLine(
      read(REFERENCE),
      (l) => l.startsWith("lethal verify ") && l.includes("<gapId>"),
    );
    expect(
      flowed(section(read(REFERENCE), "From an explain gap to a verify command (checked)")),
    ).toContain("Take both `<artifactId>` and `<gapId>` from the same `gaps[]` entry");
    // An absent gap's value must be a row of the reference's absence table.
    const absences = tableRows(
      section(read(REFERENCE), "From an explain row to a verify command (checked)"),
    ).map(([c = ""]) => ticks(c)[0] ?? "");
    const seen = new Set<string>();
    for (const r of [report, unpublished] as SessionReport[]) {
      const out = explain(r, { topSurvivors: 1 });
      const shown = new Set(out.survivors.map((s) => s.mutantCode));
      const gaps = out.gaps ?? [];
      expect(gaps.length).toBeGreaterThan(1);
      for (const gap of gaps) {
        const hidden = gap.members.every((c) => !shown.has(c));
        const fields = gap as unknown as Record<string, unknown>;
        const fill = () =>
          recipe.replace(/<([A-Za-z-]+)>/g, (_, name: string) => {
            if (name === "project") return "P";
            if (name === "tests-dir") return "T";
            if (name === "config") return "C";
            const v = fields[name];
            if (v === undefined)
              throw new Error(`recipe placeholder <${name}> is not an explain gap field`);
            return String(v);
          });
        if (gap.artifactId !== undefined) {
          // The oracle is the report, not the projection: the entry for the gap's own batch.
          const own = r.artifacts?.find((a) => a.batchIndex === gap.batchIndex)?.artifactId;
          expect(gap.artifactId, gap.gapId).toBe(own ?? "");
          const { parsed, req } = verifyRequestOf(shellWords(fill()).slice(1));
          expect(req.artifactId).toBe(gap.artifactId);
          expect(req.gapIds).toEqual([gap.gapId]);
          expect(req.ids).toEqual([]);
          expect(parsed.dbPath).toBe("P/lethal.sqlite");
          expect(parsed.testDir).toBe("T");
          expect(parsed.configPath).toBe("C");
          if (hidden && gap.batchIndex !== artifacts.length - 1) seen.add("present-earlier-batch");
        } else {
          expect(fill).toThrow(/is not an explain gap field/);
          expect(absences).toContain(gap.artifactIdAbsent ?? "");
          if (hidden) seen.add(String(gap.artifactIdAbsent));
        }
      }
    }
    // Each kind reached on a gap none of whose survivors the capped list shows.
    expect([...seen].sort()).toEqual(["carried", "not-published", "present-earlier-batch"]);
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
    const own = ownText(read(REFERENCE), "Marking an equivalent survivor (checked)");
    expect(own).toContain(`\`<project>/${EQUIVALENCE_MARKS_FILENAME}\``);
  });

  test("the marks file lives where the doc says and has the documented shape", async () => {
    const own = ownText(read(REFERENCE), "Marking an equivalent survivor (checked)");
    let path = "";
    await loadEquivalenceMarks("P", async (p) => {
      path = p;
      return JSON.stringify({ marks: [] });
    });
    expect(path).toBe(join("P", EQUIVALENCE_MARKS_FILENAME));
    const sample = JSON.parse(/```json\r?\n([\s\S]*?)```/.exec(own)?.[1] ?? "") as {
      marks: Array<Record<string, string>>;
    };
    const key = serializeKey({
      astHash: "h",
      codeunitName: "C",
      procedureName: "P",
      operatorName: "o",
      operatorMajor: 1,
      ordinal: 0,
    });
    const mark: Record<string, string> = { ...sample.marks[0], key };
    expect(parseEquivalenceMarks(JSON.stringify({ ...sample, marks: [mark] }), "t")).toHaveLength(
      1,
    );
    const noReason = Object.fromEntries(Object.entries(mark).filter(([k]) => k !== "reason"));
    expect(() => parseEquivalenceMarks(JSON.stringify({ marks: [noReason] }), "t")).toThrow(
      /"reason" is required/,
    );
    expect(own).toContain("`reason` is required.");
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
    expect(valuesOf("newTests[].runs[].outcome")).toEqual(new Set(UNMUTATED_OUTCOMES));
    expect(valuesOf("results[].killedBy")).toEqual(new Set(KILLED_BY));
    // "`killedBy` never changes the exit code": every value, one exit code.
    const codes = new Set(
      KILLED_BY.map((k) =>
        verifyExitCode({ results: [{ verdict: "killed", killedBy: k }], newTests: [] } as never),
      ),
    );
    expect(codes).toEqual(new Set([VERIFY_EXIT.ok]));
    expect(ownText(read(REFERENCE), "Reading a verify result (checked)")).toContain(
      "`killedBy` never changes the exit code.",
    );
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
      [
        "0: some killed and the rest skipped",
        { results: [R("killed"), R("skipped")], newTests: [] },
        VERIFY_EXIT.ok,
      ],
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

  test("verify exit 1 is an argv refusal on stderr with no JSON", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    const verifyRow = rows.find(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1] === "verify");
    const argv = shellWords(ticks(verifyRow?.[0] ?? "")[0] ?? "").slice(1);
    const r = runCli(argv);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--out");
    // A missing flag is refused at parse, before verify prints anything.
    const noTests = argv.filter(
      (a, i) =>
        a !== "--tests" && argv[i - 1] !== "--tests" && a !== "--out" && argv[i - 1] !== "--out",
    );
    expect(() => parseCliConfig(noTests)).toThrow(/--tests/);
    const row1 = tableRows(section(read(REFERENCE), "Verify exit codes (checked)")).find(
      ([c = ""]) => ticks(c)[0] === "1",
    );
    expect(row1?.[1]).toContain("The message is on stderr and there is no JSON.");
    // Row 6 names `refused.reason`: it must be where the verify schema puts it.
    const verifySchema = JSON.parse(
      read(join(REPO_ROOT, "schemas", `verify-v${VERIFY_SCHEMA_VERSION}.schema.json`)),
    ) as SchemaNode;
    const row6 = tableRows(section(read(REFERENCE), "Verify exit codes (checked)")).find(
      ([c = ""]) => ticks(c)[0] === String(VERIFY_EXIT.refused),
    );
    for (const path of ticks(row6?.[1] ?? "").filter((t) => t.includes(".")))
      expect(() =>
        nodesAt(verifySchema, variantsOf(verifySchema, verifySchema), path),
      ).not.toThrow();
  }, 30_000);

  test("verify --out is a documented, refused trap", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    const verifyRow = rows.find(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1] === "verify");
    const argv = shellWords(ticks(verifyRow?.[0] ?? "")[0] ?? "").slice(1);
    expect(argv).toContain("--out");
    expect(() => parseCliConfig(argv)).toThrow(/--out/);
  });

  test("both documents carry the six rules", () => {
    const rules: ReadonlyArray<[string, string]> = [
      ["reference", section(read(REFERENCE), "The six rules (guidance)")],
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
    const count = section(read(REFERENCE), "The six rules (guidance)")
      .split("\n")
      .filter((l) => /^\d+\. /.test(l)).length;
    expect(body).toContain(`the ${NUMBER_WORDS[count]} rules`);
    for (const w of NUMBER_WORDS.filter((_, i) => i !== count))
      expect(body).not.toContain(`the ${w} rules`);
  });

  test.each([
    ["gift-card", GIFT_CARD],
    ["credit-limit", join(REPO_ROOT, "examples", "credit-limit", "demo.report.json")],
  ])("README's %s figures are the committed report's", (_name, reportPath) => {
    const r = JSON.parse(read(reportPath)) as SessionReport;
    // The score as the report itself renders it.
    const score = /score: (\S+%)/.exec(renderConsole(r))?.[1] ?? "";
    expect(score).toMatch(/^\d+\.\d%$/);
    const readme = flowed(read(join(REPO_ROOT, "README.md")));
    expect(readme).toContain(
      `${r.mutants.length} mutants, ${r.counts.killed} killed, ${r.counts.survived} survived, ${r.counts.noCoverage} no-coverage: a score of ${score}.`,
    );
  });

  test("README says run never modifies or publishes the test project", () => {
    // Run DOES read the test project (it discovers the tests there); it never changes or publishes it.
    const readme = flowed(read(join(REPO_ROOT, "README.md")));
    expect(readme).toContain("`lethal run` never modifies or publishes your test project.");
    expect(readme).not.toContain("never touches or publishes");
  });

  test("README does not deny that verify publishes the test app", () => {
    // Regression guard only (a string): the claim was true before lethal verify existed.
    expect(read(join(REPO_ROOT, "README.md"))).not.toContain("does not even publish it");
  });
});
