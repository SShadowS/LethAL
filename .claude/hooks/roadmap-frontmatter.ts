#!/usr/bin/env bun
/**
 * PostToolUse(Edit|Write) hook: after editing a roadmap row, prove the index can still PARSE it.
 *
 * `docs/roadmap/R<nnn>.md` is the durable record and `ROADMAP.md` is generated from it, so a row
 * whose frontmatter stops parsing is not a cosmetic problem: `bun scripts/roadmap-index.ts` refuses
 * to build the index at all, and `scripts/roadmap-index.test.ts` then fails for a reason that names
 * the generator rather than the edit that caused it.
 *
 * It broke twice on 2026-08-29, both times invisibly until a later manual run:
 *
 *   - CRLF. A row rewritten by a Python script in text mode on Windows got `\r\n` line endings, and
 *     the parser's `text.startsWith("---\n")` failed with "does not start with a '---' frontmatter
 *     fence" — a message that points at the fence, which was present and correct.
 *   - An unescaped `"` inside a `status:` value. Frontmatter values are JSON-ENCODED scalars, so a
 *     status containing a quoted phrase fails with "'status' is not a JSON-encoded scalar".
 *
 * Both are silent at edit time and both are caught in ~250ms by simply running the generator, which
 * is what this does. The generator is idempotent and rewrites `ROADMAP.md` from the rows, so the
 * hook doubles as "the index is never stale after a row edit" — the thing CLAUDE.md asks for by
 * hand ("never hand-edit it; `bun scripts/roadmap-index.ts` rebuilds it").
 *
 * NON-BLOCKING, deliberately. It exits 0 whatever happens and prints the generator's own error, for
 * the reason `biome-touched.ts` gives: a hook that breaks the session is worse than a hook that
 * misses one edit. The generator's message is precise enough to act on, and the paired test still
 * fails the build if nobody does. Refusing the edit would also be wrong on the common legitimate
 * case of writing a row in two passes, where the first pass is briefly incomplete.
 */
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let file = "";
try {
  file = (JSON.parse(raw)?.tool_input?.file_path ?? "") as string;
} catch {
  process.exit(0);
}

const normalized = file.replace(/\\/g, "/");
// Rows only. `ROADMAP.md` itself is GENERATED, and `_template.md` has no id, so neither is a row
// whose frontmatter the index parses.
if (!/docs\/roadmap\/R\d{3}\.md$/.test(normalized)) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Check the one file first, so the message names the row that was just edited rather than whichever
// row the generator happens to reach first. Two distinct failures, both measured, both silent.
const bytes = await Bun.file(file)
  .arrayBuffer()
  .then((b) => new Uint8Array(b))
  .catch(() => null);
if (bytes !== null) {
  const text = new TextDecoder().decode(bytes);
  const fence = text.indexOf("\n---", 4);
  const head = fence === -1 ? text : text.slice(0, fence);
  if (head.includes("\r")) {
    console.error(
      `[roadmap] ${normalized}: frontmatter contains CRLF line endings. The index parser requires ` +
        `LF ("---\\n"), and reports this as "does not start with a '---' frontmatter fence", which ` +
        `points at the fence rather than the line endings. Rewrite the file with LF.`,
    );
  }
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!/^(id|title|status|section|order)$/.test(key)) continue;
    const value = line.slice(colon + 2);
    if (value === "") continue;
    try {
      JSON.parse(value);
    } catch {
      console.error(
        `[roadmap] ${normalized}: '${key}' is not a JSON-encoded scalar. Frontmatter values are ` +
          `JSON, so an inner double quote must be escaped (\\") or replaced with backticks. ` +
          `Got: ${value.slice(0, 120)}`,
      );
    }
  }
}

// Then rebuild, which is both the real parse check and the "index is never stale" guarantee.
const res = Bun.spawnSync(["bun", "scripts/roadmap-index.ts"], {
  cwd,
  stdout: "pipe",
  stderr: "pipe",
});
if (res.exitCode !== 0) {
  const err = new TextDecoder().decode(res.stderr).trim();
  console.error(
    `[roadmap] the index could not be rebuilt after editing ${normalized}. ROADMAP.md is now STALE ` +
      `and scripts/roadmap-index.test.ts will fail until this parses:\n${err.slice(-800)}`,
  );
}
process.exit(0);
