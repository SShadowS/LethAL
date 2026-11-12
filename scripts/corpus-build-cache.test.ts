import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CacheCheckError,
  CacheRefusedError,
  check,
  entryName,
  list,
  probingKey,
  put,
  removeTree,
} from "./corpus-build-cache.ts";

// Never /coord: every root here is a temp folder (tests never touch /coord).
const TMP = mkdtempSync(join(tmpdir(), "corpus-build-cache-test-"));
afterAll(() => removeTree(TMP));
let seq = 0;
const fresh = (tag: string): string => {
  const d = join(TMP, `${tag}-${seq++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

function source(): string {
  const d = fresh("src");
  write(d, "pkgs/A.app", "app-a");
  write(d, "src/x/B.al", "codeunit 1 B {}");
  return d;
}
const putIn = (root: string, from: string, name = "sysapp-pool", probing: string[] = []) =>
  put({ root, name, corpusRoot: "/corpus", corpusSha: SHA, from, probing, note: "t" });

describe("R-935 corpus-build cache", () => {
  test("put writes a whole, read-only entry with a manifest of every file, and no temp folder", () => {
    const root = fresh("root");
    const dir = putIn(root, source());
    expect(dir).toBe(join(root, `sysapp-pool@${SHA.slice(0, 12)}+none`));
    const m = check(dir, true);
    expect(m.files.map((f) => f.path)).toEqual(["pkgs/A.app", "src/x/B.al"]);
    expect(readdirSync(root)).toEqual([`sysapp-pool@${SHA.slice(0, 12)}+none`]);
    expect(() => writeFileSync(join(dir, "pkgs", "A.app"), "changed")).toThrow();
  });
  test("an existing entry is refused, never replaced", () => {
    const root = fresh("root");
    const from = source();
    putIn(root, from);
    expect(() => putIn(root, from)).toThrow(CacheRefusedError);
  });
  test("links are followed: the entry holds the file, not a link into a scratch folder", () => {
    const root = fresh("root");
    const from = source();
    const outside = fresh("outside");
    write(outside, "C.app", "app-c");
    symlinkSync(join(outside, "C.app"), join(from, "pkgs", "C.app"));
    const dir = putIn(root, from);
    removeTree(outside);
    expect(check(dir, true).files.map((f) => f.path)).toContain("pkgs/C.app");
  });
  test("a failed put leaves nothing behind, and an empty source is refused", () => {
    const root = fresh("root");
    const from = source();
    write(from, "manifest.json", "{}");
    expect(() => putIn(root, from)).toThrow("manifest.json");
    expect(readdirSync(root)).toEqual([]);
    expect(() => putIn(root, fresh("empty"))).toThrow("no file");
    expect(readdirSync(root)).toEqual([]);
  });
  test("a folder with no manifest is half-written and refused; list names temp folders as not entries", () => {
    const root = fresh("root");
    write(root, `.tmp-x@${SHA.slice(0, 12)}+none-1/a`, "a");
    write(root, "half/a", "a");
    expect(() => check(join(root, "half"), false)).toThrow("half-written");
    const l = list(root);
    expect(l).toContain(`unfinished (not an entry): .tmp-x@${SHA.slice(0, 12)}+none-1`);
    expect(l).toContain("no manifest (not an entry): half");
  });
  test("check: the quick one sees a missing file or a size; the full one also a hash and an extra file", () => {
    const root = fresh("root");
    const dir = putIn(root, source());
    const f = join(dir, "pkgs", "A.app");
    chmodSync(join(dir, "pkgs"), 0o755);
    chmodSync(f, 0o644);
    writeFileSync(f, "app-b"); // same size, other bytes
    expect(check(dir, false).entry).toContain("sysapp-pool@");
    expect(() => check(dir, true)).toThrow(CacheCheckError);
    writeFileSync(f, "app-a");
    writeFileSync(join(dir, "pkgs", "extra.app"), "x");
    expect(() => check(dir, true)).toThrow("extra pkgs/extra.app");
    writeFileSync(f, "longer than before");
    expect(() => check(dir, false)).toThrow("size pkgs/A.app");
  });
  test("names: the probing key depends on the paths as a set; a bad name or sha is refused", () => {
    expect(probingKey([])).toBe("none");
    expect(probingKey(["/b", "/a"])).toBe(probingKey(["/a", "/b"]));
    expect(probingKey(["/a"])).not.toBe(probingKey(["/b"]));
    expect(entryName("pool", SHA, ["/a"])).toBe(`pool@${SHA.slice(0, 12)}+${probingKey(["/a"])}`);
    expect(() => entryName("System Application", SHA, [])).toThrow(CacheRefusedError);
    expect(() => entryName(".x", SHA, [])).toThrow(CacheRefusedError);
    expect(() => entryName("p", "HEAD", [])).toThrow(CacheRefusedError);
  });
  test("the CLI: put, path and check exit 0; a second put and a missing entry exit 2", () => {
    const root = fresh("root");
    const corpus = fresh("corpus");
    const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: corpus, stdout: "pipe" });
    g("init", "-q");
    write(corpus, "a.txt", "a");
    g("add", "-A");
    g(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "c",
    );
    const cli = (...a: string[]) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "corpus-build-cache.ts"), ...a], {
        env: { ...process.env, LETHAL_CORPUS_BUILDS: root },
        stdout: "pipe",
        stderr: "pipe",
      });
    const from = source();
    const p1 = cli("put", "pool", "--corpus", corpus, "--from", from);
    expect(p1.exitCode, p1.stderr.toString()).toBe(0);
    const path = cli("path", "pool", "--corpus", corpus);
    expect(path.exitCode, path.stderr.toString()).toBe(0);
    const dir = path.stdout.toString().trim();
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(cli("check", dir).exitCode).toBe(0);
    expect(cli("put", "pool", "--corpus", corpus, "--from", from).exitCode).toBe(2);
    expect(cli("path", "other", "--corpus", corpus).exitCode).toBe(2);
  });
});
