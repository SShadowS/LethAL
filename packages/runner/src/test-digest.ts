/**
 * R-278 / R258: a per-test-method digest of the test app's SOURCE, so `lethal verify` can tell an
 * edited test from an unchanged one. Source, never the compiled package: `alc`'s output differs
 * between two compiles of the same source (docs/measurements/README.md, "Dev endpoint: test-app
 * read-back").
 *
 * The span is the method's own text: from the first attribute directly before the `procedure`
 * (`[Test]`, `[HandlerFunctions(...)]`, ...) to the end of the procedure. A method declared in
 * several `#if` arms is every declaration, joined in source order. Only line endings and trailing
 * spaces and tabs are normalized: a comment edit is a real edit, and over-normalizing is the unsafe
 * direction (an edited test read as unchanged skips verify's new-test checks).
 *
 * Known limit (filed on the roadmap): a helper, handler or library procedure the test CALLS is not
 * in the span, so editing one leaves the digest unchanged.
 */
import { type ALSyntaxNode, initParser, normalizeAlName, parseAL, wrapRoot } from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import { readTestAppSources } from "./testpage-scan";

/** The digest key: codeunit id plus method, the method compared case-insensitively as AL does. */
export const testDigestKey = (ref: { codeunitId: number; method: string }): string =>
  `${ref.codeunitId}::${ref.method.toLowerCase()}`;

const NAME_KINDS = new Set(["identifier", "quoted_identifier"]);
/** Trivia that may sit between a procedure's attributes, or between them and the procedure. */
const TRIVIA = new Set(["comment", "multiline_comment", "pragma"]);

const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");

function nodesOfKind(n: ALSyntaxNode, kind: string, out: ALSyntaxNode[]): ALSyntaxNode[] {
  if (n.rawKind === kind) out.push(n);
  else for (const c of n.namedChildren) nodesOfKind(c, kind, out);
  return out;
}

/** The procedure's text with the run of attributes directly before it (they are its siblings). */
function spanOf(source: string, proc: ALSyntaxNode): string {
  let start = proc.startIndex;
  const siblings = proc.parent?.namedChildren ?? [];
  let i = siblings.findIndex((s) => s.startIndex === proc.startIndex);
  for (i -= 1; i >= 0; i -= 1) {
    const s = siblings[i];
    if (s === undefined) break;
    if (s.rawKind === "attribute_item") start = s.startIndex;
    else if (!TRIVIA.has(s.rawKind)) break;
  }
  return source.slice(start, proc.endIndex);
}

/** Every discovered test's digest, by `testDigestKey`. Throws when the parser finds no declaration
 *  for a discovered test: an undigested test would read as unchanged or as missing, never loudly. */
export function testDigestsOfSources(
  files: ReadonlyArray<{ path: string; text: string }>,
  tests: readonly TestMethodRef[],
): Record<string, string> {
  // Every procedure in every codeunit, as (codeunit id, normalized name, span), in file order.
  const procs: Array<{ id: number; name: string; span: string }> = [];
  for (const f of files) {
    const root = wrapRoot(parseAL(f.text));
    for (const cu of nodesOfKind(root, "codeunit_declaration", [])) {
      const id = Number(cu.namedChildren.find((c) => c.rawKind === "integer")?.text);
      for (const p of nodesOfKind(cu, "procedure", [])) {
        const name = p.namedChildren.find((c) => NAME_KINDS.has(c.rawKind))?.text;
        if (name !== undefined)
          procs.push({ id, name: normalizeAlName(name), span: spanOf(f.text, p) });
      }
    }
  }
  const out: Record<string, string> = {};
  for (const t of tests) {
    const spans = procs
      .filter((p) => p.id === t.codeunitId && p.name === normalizeAlName(t.method))
      .map((p) => normalize(p.span));
    if (spans.length === 0) {
      throw new Error(
        `test-digest.ts: ${t.codeunitName}.${t.method} (codeunit ${t.codeunitId}) was discovered, but the parser found no procedure of that name to digest`,
      );
    }
    out[testDigestKey(t)] = new Bun.CryptoHasher("sha256").update(spans.join("\n")).digest("hex");
  }
  return out;
}

export async function testDigests(
  testDir: string,
  tests: readonly TestMethodRef[],
): Promise<Record<string, string>> {
  await initParser();
  return testDigestsOfSources(await readTestAppSources(testDir), tests);
}
