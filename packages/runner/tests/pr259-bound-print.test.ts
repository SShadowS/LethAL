// PR-259 (R1156): the bound print al-runner v3 compares before every send. Pure, and it moves with
// every byte, every path, the file order and the boundary between two files.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundPrint,
  hashAlTree,
  printAlTree,
  scanAlTree,
  scanTestDir,
} from "../src/baseline-snapshot";

const b = (s: string) => new TextEncoder().encode(s);
const two = (a: string, x: string, c: string, y: string) =>
  boundPrint([
    [a, b(x)],
    [c, b(y)],
  ]);

describe("PR-259: boundPrint", () => {
  const base = two("A.Codeunit.al", "codeunit 1 A { }", "B.Codeunit.al", "codeunit 2 B { }");

  test("the same paths and bytes give the same print", () => {
    expect(two("A.Codeunit.al", "codeunit 1 A { }", "B.Codeunit.al", "codeunit 2 B { }")).toBe(
      base,
    );
  });
  test("one byte changed in the SECOND file moves it", () => {
    expect(two("A.Codeunit.al", "codeunit 1 A { }", "B.Codeunit.al", "codeunit 2 C { }")).not.toBe(
      base,
    );
  });
  test("a renamed path with the same bytes moves it", () => {
    expect(two("A.Codeunit.al", "codeunit 1 A { }", "C.Codeunit.al", "codeunit 2 B { }")).not.toBe(
      base,
    );
  });
  test("the same two files in the other order move it", () => {
    expect(two("B.Codeunit.al", "codeunit 2 B { }", "A.Codeunit.al", "codeunit 1 A { }")).not.toBe(
      base,
    );
  });
  test("a byte moved across the boundary between two files moves it", () => {
    expect(two("A.Codeunit.al", "codeunit 1 A {", "B.Codeunit.al", " }codeunit 2 B { }")).not.toBe(
      base,
    );
  });
});

describe("PR-259: the proof's read and the per-send read agree", () => {
  test("scanAlTree's hash is hashAlTree's, and its print is printAlTree's (root control files left out)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr259-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "Logic.Codeunit.al"), "codeunit 50100 Logic { }");
    await writeFile(join(dir, "sub", "More.Codeunit.al"), "codeunit 50101 More { }");
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "codeunit 50199 Sel { }");
    const scan = await scanAlTree(dir);
    expect(scan.hash).toBe(await hashAlTree(dir));
    expect(scan.print).toBe(await printAlTree(dir));
    // The root control file is outside the print, as it is outside the hash.
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "codeunit 50199 Sel2 { }");
    expect(await printAlTree(dir)).toBe(scan.print);
    const t = await scanTestDir(dir);
    expect(t.print).not.toBe(scan.print);
  });
});
