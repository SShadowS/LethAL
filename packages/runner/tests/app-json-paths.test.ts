import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskCaseResolver, normaliseAppJsonPaths } from "../src/app-json-paths";
import { appJsonPathWarning, prepareBatchProject } from "../src/orchestrator";
import { testAppPathRewrite, testAppPathWarning } from "../src/test-app-publish";
import { removeScratchDirs } from "./helpers/scratch";

const scratch: string[] = [];
afterAll(() => removeScratchDirs(scratch));

async function project(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r913-"));
  scratch.push(dir);
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "x");
  }
  return dir;
}

test("R913: a logo in the wrong case is rewritten to the one file on disk", async () => {
  const dir = await project(["extensionlogo.png"]);
  const { manifest, changes } = normaliseAppJsonPaths(
    { logo: "ExtensionLogo.png" },
    diskCaseResolver(dir),
  );
  expect(manifest.logo).toBe("extensionlogo.png");
  expect(changes).toEqual([
    { field: "logo", from: "ExtensionLogo.png", to: "extensionlogo.png", kind: "case" },
  ]);
});

test("R913: an exact-case logo is untouched", async () => {
  const dir = await project(["ExtensionLogo.png"]);
  const { manifest, changes } = normaliseAppJsonPaths(
    { logo: "ExtensionLogo.png" },
    diskCaseResolver(dir),
  );
  expect(manifest.logo).toBe("ExtensionLogo.png");
  expect(changes).toEqual([]);
});

test("R913: no match leaves the path as written", async () => {
  const none = await project(["other.png"]);
  expect(normaliseAppJsonPaths({ logo: "Logo.png" }, diskCaseResolver(none)).changes).toEqual([]);
});

// On a case-insensitive disk (Windows, macOS) `a.png` and `A.png` are one file, so the two-match
// case cannot be built there.
const caseInsensitiveDisk = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r913-probe-"));
  scratch.push(dir);
  await writeFile(join(dir, "probe"), "x");
  return existsSync(join(dir, "PROBE"));
})();

test.skipIf(caseInsensitiveDisk)(
  "R913: two case-insensitive matches leave the path as written",
  async () => {
    const dir = await project(["a.png", "A.png"]);
    expect(normaliseAppJsonPaths({ logo: "A.PNG" }, diskCaseResolver(dir)).manifest.logo).toBe(
      "A.PNG",
    );
  },
);

test("R913: an absolute path, a drive letter and a .. step are left as written", async () => {
  const dir = await project(["logo.png"]);
  const resolve = diskCaseResolver(dir);
  expect(resolve(`${dir}/LOGO.png`)).toBeUndefined();
  expect(resolve("/LOGO.png")).toBeUndefined();
  expect(resolve("sub/../LOGO.png")).toBeUndefined();
  expect(resolve("../LOGO.png")).toBeUndefined();
  expect(resolve("LOGO.png")).toBe("logo.png");
});

// A directory named `C:` cannot exist on Windows, so the drive-letter guard is only observable elsewhere.
test.skipIf(process.platform === "win32")("R913: a drive letter is left as written", async () => {
  const dir = await project(["C:/logo.png"]);
  expect(diskCaseResolver(dir)("C:/LOGO.png")).toBeUndefined();
});

test("R913: the test app's rewrite fixes a logo's case when given the test dir", async () => {
  const testDir = await project(["extensionlogo.png"]);
  const text = JSON.stringify({ logo: "ExtensionLogo.png" });
  const withDir = testAppPathRewrite(text, testDir);
  expect(withDir.manifest.logo).toBe("extensionlogo.png");
  expect(withDir.changes.map((c) => c.kind)).toEqual(["case"]);
  expect(testAppPathRewrite(text).changes).toEqual([]);
});

test("R913: the target's warning names the letter case, not a backslash", () => {
  const text = appJsonPathWarning([{ field: "logo", from: "A.png", to: "a.png", kind: "case" }]);
  expect(text).toContain("different letter case");
  expect(text).not.toContain('with "\\"');
});

test("R913: a folder path is fixed one segment at a time", async () => {
  const dir = await project(["res/Sub/a.txt"]);
  const { manifest, changes } = normaliseAppJsonPaths(
    { resourceFolders: ["Res\\sub"] },
    diskCaseResolver(dir),
  );
  expect(manifest.resourceFolders).toEqual(["res/Sub"]);
  expect(changes.map((c) => [c.kind, c.from, c.to])).toEqual([
    ["backslash", "Res\\sub", "Res/sub"],
    ["case", "Res/sub", "res/Sub"],
  ]);
});

test("R913: without a resolver nothing changes in case", () => {
  expect(normaliseAppJsonPaths({ logo: "Logo.png" }).changes).toEqual([]);
});

test("R913: the warning names a case change differently from a backslash change", () => {
  const caseText = testAppPathWarning([
    { field: "logo", from: "A.png", to: "a.png", kind: "case" },
  ]);
  const slashText = testAppPathWarning([
    { field: "logo", from: "I\\a.png", to: "I/a.png", kind: "backslash" },
  ]);
  expect(caseText).toContain("different letter case");
  expect(caseText).not.toContain('with "\\"');
  expect(slashText).toContain('with "\\"');
  expect(slashText).not.toContain("letter case");
  expect(caseText).toContain("was not changed");
});

test("R913: the batch app.json gets the disk spelling and the source app.json is unchanged", async () => {
  const dir = await project(["extensionlogo.png"]);
  const source = JSON.stringify({ name: "A", logo: "ExtensionLogo.png" });
  await writeFile(join(dir, "app.json"), source);
  const batch = await mkdtemp(join(tmpdir(), "lethal-r913-batch-"));
  scratch.push(batch);
  const changes = await prepareBatchProject(dir, batch, JSON.parse(source), "1.0.0.1");
  expect(JSON.parse(await readFile(join(batch, "app.json"), "utf8")).logo).toBe(
    "extensionlogo.png",
  );
  expect(changes.map((c) => c.kind)).toEqual(["case"]);
  expect(await readFile(join(dir, "app.json"), "utf8")).toBe(source);
});
