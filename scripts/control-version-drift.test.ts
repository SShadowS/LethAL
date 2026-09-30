/**
 * R348: docs must never state the CURRENT control-app version as a number. The number lives in
 * `extensions/lethal-control/app.json` (pinned equal to `MIN_CONTROL_VERSION` by harness.test.ts),
 * and every doc that wrote it down went stale at the next bump (CLAUDE.md said 1.0.0.19 while the
 * code required 1.0.0.20). What a container has INSTALLED is machine state: `lethal doctor`.
 *
 * The rule, per version literal `1.0.0.N` on a non-code line:
 * - its sentence (from the last ". " before it, at most 120 characters back) must mention
 *   "control", or it is some other app's version (fixtures are 1.0.0.x too) and is ignored;
 * - it is HISTORY, and allowed, when that sentence carries a date, names `app.json`, or uses a
 *   history word: "from", "since", "measured", "shipped", "removing", "older than".
 * Anything else is a current-state claim and fails, naming the file and line.
 *
 * Files whose name starts with a date (plans, specs, measurements) and roadmap items are dated
 * records: they describe their own day and cannot go stale, so they are not scanned. Fenced code
 * blocks are quoted output, not claims, and are skipped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, keep) : keep(path) ? [path] : [];
  });
}

const DATED = /^\d{4}-\d{2}-\d{2}/;
const isMd = (p: string) => p.endsWith(".md");

function scannedFiles(): string[] {
  return [
    join(ROOT, "CLAUDE.md"),
    join(ROOT, "README.md"),
    join(ROOT, "fixtures", "README.md"),
    ...walk(
      join(ROOT, "docs"),
      (p) =>
        isMd(p) &&
        !DATED.test(p.split(/[\\/]/).pop() ?? "") &&
        !relative(ROOT, p).split(/[\\/]/).includes("roadmap"),
    ),
    ...walk(join(ROOT, ".claude", "skills"), isMd),
  ];
}

/**
 * Docs whose version literal another test already pins to `MIN_CONTROL_VERSION`
 * (`packages/runner/tests/agent-contract.test.ts`, C02-07 I4): an agent reading the published
 * guide has no `app.json`, so the number stays there, and any other number fails that test.
 * Here the CURRENT number is allowed in them and nothing else.
 */
const PINNED = ["docs/using-lethal-from-an-agent.md"];

const HISTORY =
  /\d{4}-\d{2}-\d{2}|app\.json|\b(from|since|measured|shipped|removing|older than)\b/i;

/** Returns `path:line: text` for every current-state control version literal in `text`. */
function findDrift(path: string, text: string): string[] {
  const hits: string[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(/1\.0\.0\.\d+/g)) {
      const before = line.slice(Math.max(0, m.index - 120), m.index);
      const sentence = before.slice(before.lastIndexOf(". ") + 1);
      if (/control/i.test(sentence) && !HISTORY.test(sentence)) {
        hits.push(`${path}:${i + 1}: ...${sentence}${m[0]}`);
      }
    }
  });
  return hits;
}

describe("R348: no doc states the current control-app version as a literal", () => {
  test("the rule itself tells current state from history", () => {
    expect(
      findDrift(
        "x",
        "- **Control app 1.0.0.19 (GH-24) must be published to every gate container**",
      ),
    ).toHaveLength(1);
    expect(
      findDrift("x", "The control app has `ObservedActive` only from 1.0.0.19, not before."),
    ).toEqual([]);
    expect(findDrift("x", "Measured 2026-08-02, control app 1.0.0.13.")).toEqual([]);
    expect(findDrift("x", "LethAL Sandbox Data 1.0.0.4 was republished.")).toEqual([]);
    expect(findDrift("x", "```\nThe LethAL Control app reports version 1.0.0.9\n```")).toEqual([]);
  });

  test("scanned docs name app.json or lethal doctor instead of the number", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(5);
    const appJson = JSON.parse(
      readFileSync(join(ROOT, "extensions", "lethal-control", "app.json"), "utf8"),
    ) as { version: string };
    const hits = files
      .flatMap((f) => findDrift(relative(ROOT, f).replaceAll("\\", "/"), readFileSync(f, "utf8")))
      .filter((h) => !(PINNED.some((p) => h.startsWith(`${p}:`)) && h.endsWith(appJson.version)));
    expect(hits).toEqual([]);
  });
});
