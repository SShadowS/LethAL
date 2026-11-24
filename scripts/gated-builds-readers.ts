/**
 * R1208: the unit tests that read the gated-builds file, found by a rule rather than a hand list, so the update script can run
 * them on a new row before it pushes (edge-e5176a9fd's row, f8185a042, turned master red through a [skip ci] push).
 *
 * The rule: start from the top-level declarations of the READER MODULES that name the file, add every top-level declaration of
 * those modules whose text names one already found, until nothing grows; a reader test is a test file that names one of them.
 *
 * ponytail: bounded to the reader modules on purpose. Followed through every module, the closure reaches all 625 test files
 * (measured 2026-11-24), i.e. the whole suite; bounded, it is 13 names and 15 files, and holds the three R1208 named.
 * A test that reads the rows only through a caller outside these modules is not run; `gated-builds-readers.test.ts` refuses
 * a new module that imports the file directly, so the boundary cannot move silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export const GATED_BUILDS_JSON = "al-runner-v3-gated-builds.json";
/** The modules that own the file's readings: the one that imports it, and the one that reads its pins. */
export const READER_MODULES = [
  "packages/runner/src/al-runner-v3-pins.ts",
  "packages/runner/src/al-runner-v3-pin.ts",
] as const;
export const TEST_GLOBS = [
  "packages/*/tests/**/*.test.ts",
  "packages/*/itest/**/*.test.ts",
  "scripts/**/*.test.ts",
] as const;

/** A top-level declaration's name (the formatter puts every one at column 0). */
const DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;

const word = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);

/** Each top-level declaration of `text` with its text; an `import X from "...gated-builds.json"` binds X. */
export function topLevelDecls(text: string): { name: string; body: string }[] {
  const decls: { name: string; body: string }[] = [];
  let cur: { name: string; body: string } | undefined;
  for (const line of text.split("\n")) {
    const json = new RegExp(
      `^import (\\w+) from "[^"]*${GATED_BUILDS_JSON.replace(/\./g, "\\.")}"`,
    ).exec(line);
    if (json?.[1] !== undefined) decls.push({ name: json[1], body: GATED_BUILDS_JSON });
    const m = DECL.exec(line);
    if (m?.[1] !== undefined) {
      cur = { name: m[1], body: "" };
      decls.push(cur);
    } else if (/^\S/.test(line) && !/^[})\]]/.test(line)) cur = undefined;
    if (cur !== undefined) cur.body += `${line}\n`;
  }
  return decls;
}

/** The reader names: declarations of the reader modules that reach the file, to a fixpoint. */
export function gatedBuildsReaders(root: string): string[] {
  const decls = READER_MODULES.flatMap((m) => topLevelDecls(readFileSync(join(root, m), "utf8")));
  const names = new Set(decls.filter((d) => d.body.includes(GATED_BUILDS_JSON)).map((d) => d.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of decls)
      if (!names.has(d.name) && [...names].some((n) => word(n).test(d.body))) {
        names.add(d.name);
        grew = true;
      }
  }
  if (names.size === 0)
    throw new Error(`no declaration of ${READER_MODULES.join(", ")} reads ${GATED_BUILDS_JSON}`);
  return [...names].sort();
}

/** The test files (repo-relative, sorted) that name a reader. Never empty: an empty set would pass every row. */
export function gatedBuildsReaderTests(root: string): string[] {
  const names = gatedBuildsReaders(root).map(word);
  const files = TEST_GLOBS.flatMap((g) => [...new Glob(g).scanSync(root)])
    .filter((f) => {
      const text = readFileSync(join(root, f), "utf8");
      return names.some((n) => n.test(text));
    })
    .sort();
  if (files.length === 0) throw new Error(`no test file names a reader of ${GATED_BUILDS_JSON}`);
  return files;
}
