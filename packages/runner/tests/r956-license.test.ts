// R956: `alRunnerV3.license`: the config key, the argv, the fingerprint and the refusal pointer. The
// backend-level argv checks (a one-shot call, the serve daemon) sit beside those rigs, in
// al-runner-v3-backend.test.ts and al-runner-v3-entries.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { licensePointer, v3CallArgv } from "../src/al-runner-v3-backend";
import { readLicenseIdentity, validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { sessionFingerprint } from "../src/resume";

const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function licenseFile(bytes: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r956-"));
  dirs.push(d);
  const p = join(d, "invented.bclicense");
  await writeFile(p, bytes);
  return p;
}

describe("R956: the config key", () => {
  test("an existing file is accepted, absent stays absent", async () => {
    const p = await licenseFile("invented");
    expect(validateAlRunnerV3Config({ ...base, license: p }).license).toBe(p);
    expect("license" in validateAlRunnerV3Config(base)).toBe(false);
  });
  test("a missing file and a non-string are refused by name", async () => {
    const p = await licenseFile("invented");
    expect(() => validateAlRunnerV3Config({ ...base, license: `${p}.nope` })).toThrow(
      "al-runner-v3-license-missing",
    );
    for (const bad of ["", 3, true])
      expect(() => validateAlRunnerV3Config({ ...base, license: bad })).toThrow(
        '"alRunnerV3.license" must be a non-empty path',
      );
  });
  test("the identity is the path and the sha256 of the bytes, never the bytes", async () => {
    const p = await licenseFile("invented license bytes");
    const id = await readLicenseIdentity(p);
    expect(id).toEqual({
      path: p,
      sha256: createHash("sha256").update("invented license bytes").digest("hex"),
    });
    expect(JSON.stringify(id)).not.toContain("invented license bytes");
    await expect(readLicenseIdentity(`${p}.nope`)).rejects.toThrow(
      "al-runner-v3-license-unreadable",
    );
  });
});

describe("R956: argv, fingerprint, pointer", () => {
  const a = {
    alRunnerPath: "/b",
    codeunitId: 7,
    stopSeconds: 3,
    packagesDir: "/d",
    bcVersion: "28.0.1.2",
    symbols: [],
    activeDir: "/a",
    testDir: "/t",
  };
  test("v3CallArgv passes --license <path> when set and nothing otherwise", () => {
    const on = v3CallArgv({ ...a, license: "/l/x.bclicense" });
    expect(on[on.indexOf("--license") + 1]).toBe("/l/x.bclicense");
    expect(v3CallArgv(a)).not.toContain("--license");
  });
  test("the fingerprint changes with the license hash, and is today's without one", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    const one = sessionFingerprint({ ...f, v3License: "a".repeat(64) });
    const two = sessionFingerprint({ ...f, v3License: "b".repeat(64) });
    expect(new Set([none, one, two]).size).toBe(3);
    expect(sessionFingerprint({ ...f })).toBe(none);
  });
  test("the pointer is added for al-runner's no-license text and for no other text", () => {
    expect(licensePointer("refused: a test with no license file loaded")).toContain(
      "set alRunnerV3.license to a .bclicense file (R956)",
    );
    expect(licensePointer("some other refusal")).toBe("");
    expect(licensePointer(undefined)).toBe("");
  });
});
