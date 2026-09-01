import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusEntries, fingerprintCorpus } from "./corpus-fingerprint";

/**
 * R187. The fingerprint is what a rule pins its reference corpus by and what an instrument prints
 * first, so each property below is one a reader will rely on without re-checking:
 *
 *   - the same tree at two paths is ONE corpus (the near miss that filed R187);
 *   - a one-byte change anywhere parsed is a DIFFERENT corpus;
 *   - `.dependencies` is invisible, because the instruments do not parse it, and a fingerprint
 *     that counted it would describe a corpus nobody measured;
 *   - the file count is the count the instruments parse, so "417 files" here means the same 417
 *     the retrodiction reports.
 */

function corpus(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-corpus-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
  return dir;
}

const BASE = {
  "src/A.Codeunit.al": "codeunit 1 A { }",
  "src/deep/B.Table.al": "table 2 B { }",
};

describe("corpus fingerprint (R187)", () => {
  test("the same tree at two different paths is ONE corpus", async () => {
    const a = await fingerprintCorpus(corpus(BASE));
    const b = await fingerprintCorpus(corpus(BASE));
    expect(a).toEqual(b);
    expect(a.files).toBe(2);
  });

  test("a one-byte change in a parsed file is a DIFFERENT corpus", async () => {
    const a = await fingerprintCorpus(corpus(BASE));
    const b = await fingerprintCorpus(
      corpus({ ...BASE, "src/A.Codeunit.al": "codeunit 1 A { } " }),
    );
    expect(b.sha256).not.toBe(a.sha256);
    expect(b.files).toBe(a.files);
  });

  test("a file under .dependencies is invisible, because the instruments never parse it", async () => {
    const a = await fingerprintCorpus(corpus(BASE));
    const b = await fingerprintCorpus(
      corpus({ ...BASE, ".dependencies/Vendor/Thing.Codeunit.al": "codeunit 3 T { }" }),
    );
    expect(b).toEqual(a);
  });

  test("a non-.al file is invisible, and .AL is matched case-insensitively", async () => {
    const a = await fingerprintCorpus(corpus(BASE));
    const withNoise = await fingerprintCorpus(corpus({ ...BASE, "README.md": "hello" }));
    expect(withNoise).toEqual(a);
    const upper = await corpusEntries(corpus({ "src/C.Codeunit.AL": "codeunit 4 C { }" }));
    expect(upper).toEqual(["src/C.Codeunit.AL"]);
  });

  test("a file moved without change is a different corpus, since instruments report per file", async () => {
    const a = await fingerprintCorpus(corpus(BASE));
    const moved = await fingerprintCorpus(
      corpus({
        "src/A.Codeunit.al": BASE["src/A.Codeunit.al"],
        "src/B.Table.al": BASE["src/deep/B.Table.al"],
      }),
    );
    expect(moved.sha256).not.toBe(a.sha256);
  });

  test("entries are sorted with forward slashes, whatever the OS produced", async () => {
    const entries = await corpusEntries(corpus(BASE));
    expect(entries).toEqual(["src/A.Codeunit.al", "src/deep/B.Table.al"]);
  });
});
