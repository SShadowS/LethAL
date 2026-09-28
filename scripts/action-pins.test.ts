// R320: every GitHub Action a workflow uses is pinned to a full commit SHA, with the version it
// was pinned from as a trailing comment. A tag or branch ref (`@v4`, `@main`) can be moved by the
// action's owner, so the code CI runs could change without a diff here.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");

/** The problem with one `uses:` value, or null when it is pinned. Local and docker refs are exempt. */
export function pinProblem(line: string): string | null {
  const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
  if (m === null) return null;
  const [, ref = "", rest = ""] = m;
  if (ref.startsWith("./") || ref.startsWith("docker://")) return null;
  const at = ref.lastIndexOf("@");
  if (at < 0) return `no @ref: ${ref}`;
  if (!/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) return `not pinned to a 40-hex commit SHA: ${ref}`;
  if (!/^\s+#\s*\S/.test(rest)) return `pinned but no trailing version comment: ${ref}`;
  return null;
}

describe("pinProblem", () => {
  const sha = "11d5960a326750d5838078e36cf38b85af677262";
  test("accepts a SHA pin with a version comment", () => {
    expect(pinProblem(`      - uses: actions/checkout@${sha} # v4.4.0`)).toBeNull();
    expect(pinProblem(`        uses: azure/login@${sha} # v2.3.1`)).toBeNull();
  });
  test("refuses a tag, a branch, a short SHA and a missing comment", () => {
    expect(pinProblem("      - uses: actions/checkout@v4")).toContain("not pinned");
    expect(pinProblem("      - uses: dtolnay/rust-toolchain@1.96.0")).toContain("not pinned");
    expect(pinProblem("      - uses: some/action@main")).toContain("not pinned");
    expect(pinProblem(`      - uses: actions/checkout@${sha.slice(0, 7)} # v4`)).toContain(
      "not pinned",
    );
    expect(pinProblem(`      - uses: actions/checkout@${sha}`)).toContain(
      "no trailing version comment",
    );
    expect(pinProblem("      - uses: actions/checkout")).toContain("no @ref");
  });
  test("exempts local and docker actions, ignores other lines", () => {
    expect(pinProblem("      - uses: ./.github/actions/local")).toBeNull();
    expect(pinProblem("      - uses: docker://alpine:3")).toBeNull();
    expect(pinProblem("      - run: bun test")).toBeNull();
  });
});

describe("the repo's workflows", () => {
  test("every uses: is pinned to a commit SHA with a version comment", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    let usesLines = 0;
    const problems: string[] = [];
    for (const f of files) {
      readFileSync(join(WORKFLOWS, f), "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*(?:-\s*)?uses:/.test(line)) usesLines++;
          const p = pinProblem(line);
          if (p !== null) problems.push(`${f}:${i + 1}: ${p}`);
        });
    }
    // Not vacuous: a parse that found no uses: at all would otherwise pass.
    expect(usesLines).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
