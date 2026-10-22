// R586: replace the first occurrence of <old> with <new> in a SCRATCH COPY of a probe file.
// Refuses a path inside the repo, and refuses when <old> is absent. Measurement tool only.
// Usage: bun replace-in-copy.ts <file> <old> <new>
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [file, oldText, newText] = process.argv.slice(2);
if (file === undefined || oldText === undefined || newText === undefined)
  throw new Error("usage: replace-in-copy.ts <file> <old> <new>");
const repo = realpathSync(resolve(import.meta.dir, "..", ".."));
const target = realpathSync(file);
if (target.startsWith(`${repo}/`)) throw new Error(`refusing to edit a repo file: ${target}`);
const text = readFileSync(target, "utf8");
if (!text.includes(oldText))
  throw new Error(`no match for ${JSON.stringify(oldText)} in ${target}`);
writeFileSync(target, text.replace(oldText, newText));
