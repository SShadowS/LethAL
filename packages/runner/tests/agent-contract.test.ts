import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTHING_SCORED_EXIT_CODE, QUARANTINED_EXIT_CODE, RUN_FLAGS } from "../src/cli";
import { DOCTOR_SCHEMA_VERSION } from "../src/cli";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import { EXPLAIN_SCHEMA_VERSION } from "../src/explain";
import { LARGE_RUN_MUTANT_THRESHOLD } from "../src/orchestrator";
import { REPORT_SCHEMA_VERSION } from "../src/report";

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

  test("both documents carry the five rules that stop a wrong conclusion", () => {
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
