import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import {
  buildAlRunnerArgv,
  isChildChosenExit,
  parseAlRunnerPlatformAppsDir,
} from "../src/al-runner-transport";
import type { SpawnFn } from "../src/publisher";

/**
 * R147 — pin the platform-app directory al-runner's own provisioning run reported, and stop sending
 * `--auto-provision` on every per-mutant invocation.
 *
 * MEASURED 2026-08-15 on al-runner 2.1.2.0, `fixtures/sandbox-app` + `fixtures/sandbox-tests`, on a
 * FULLY WARM cache: `--auto-provision` costs 17.1 s and downloads 2 x 115 MB of platform apps that
 * are already on disk, every single invocation. The same run handed
 * `--package-cache <artifacts>/<build>/platform-apps` and no `--auto-provision` costs 6.8 s and
 * downloads nothing, and its stderr is line-for-line identical apart from the `[provision]` block.
 *
 * LethAL invokes the CLI once per (mutant x covering test), so that is paid on every one.
 *
 * The reason this is allowed to change a verdict-producing argv at all: a wrong pin cannot produce a
 * wrong verdict. Measured — `--package-cache` at a directory that does not exist is dropped from the
 * scan and the run hits the same provisioning-gap refusal as no flags at all, exit 2 with empty
 * stdout, which `OneShotTransport` maps to `kind: "error"`. A mutant scores `error`, never
 * `survived`.
 */

/** The completion sentence, verbatim from the 2026-08-15 measurement. Plain ASCII. */
const DOWNLOADED =
  "[provision] Downloaded 6 app(s) (115 MB total) to C:\\x\\28.0.46665.53671\\platform-apps";

/**
 * The INTENT sentence from the same run, with the real byte in it. `od -c` shows `\032` (0x1A, SUB)
 * where an arrow glyph was mangled by the console code page — which is one of two reasons this line
 * is not read: it is also printed BEFORE the download, so it names a directory that may be half
 * written. Its wording moved inside a week, too: on 2.1.1.0 it ended in a literal `...` and carried
 * no path at all (R130's transcript).
 */
const FETCHING =
  "[provision] fetching Microsoft platform R2R apps for BC 28.0.46665.53671 \u001a C:\\x\\28.0.46665.53671\\platform-apps";

/** The neighbouring line from the SAME output. Different noun phrase, different directory. */
const TEST_APPS =
  "[provision] Downloaded 107 test .app file(s) (20 MB) to C:\\x\\28.0.46665.53671\\test-apps";

describe("parseAlRunnerPlatformAppsDir (R147)", () => {
  test("reads the directory AND the count off the completion sentence", () => {
    const parsed = parseAlRunnerPlatformAppsDir(`${FETCHING}\n${DOWNLOADED}\n`);
    expect(parsed).toEqual({
      kind: "found",
      dir: "C:\\x\\28.0.46665.53671\\platform-apps",
      appCount: 6,
    });
  });

  test("the intent line ALONE is not enough, control character or not", () => {
    // Pinning on `fetching` would pin a directory the runner has not finished writing. The 0x1A byte
    // is the second reason and not the first one.
    expect(parseAlRunnerPlatformAppsDir(`${FETCHING}\n`)).toEqual({ kind: "no-completion-line" });
  });

  test("the test-toolkit download in the same output is not mistaken for it", () => {
    // `Downloaded 107 test .app file(s) (20 MB) to <...>/test-apps` is rejected twice over: the noun
    // phrase is not `N app(s)`, and the directory's last component is not `platform-apps`.
    expect(parseAlRunnerPlatformAppsDir(`${TEST_APPS}\n`)).toEqual({ kind: "no-completion-line" });
  });

  test("output that never mentions one says so, rather than defaulting", () => {
    expect(
      parseAlRunnerPlatformAppsDir(
        "[bc] selected BC 28.1.49838.50794 (C:\\x\\28.1.49838.50794)\n" +
          "[provision] BC 28.1.49838.50794 engine artifacts already complete at C:\\x\\28.1.49838.50794.\n",
      ),
    ).toEqual({ kind: "no-completion-line" });
  });

  test("a `platform-apps` path on a line that is not the runner's own is ignored", () => {
    // A test's failure text can contain anything. The `[provision]` line-start anchor is what stops
    // it being read as the runner speaking — the same rule `parseAlRunnerBcBuild` keeps for `[bc] `.
    expect(
      parseAlRunnerPlatformAppsDir(
        "Downloaded 6 app(s) (115 MB total) to C:\\evil\\platform-apps\n" +
          "   [provision] Downloaded 6 app(s) (115 MB total) to C:\\indented\\platform-apps\n",
      ),
    ).toEqual({ kind: "no-completion-line" });
  });

  test("R130's double pass names the same directory twice, and that is ONE directory", () => {
    // `--auto-provision` provisions twice per invocation, so the completion sentence appears twice.
    // Two identical answers must not read as a conflict.
    expect(parseAlRunnerPlatformAppsDir(`${DOWNLOADED}\n${TEST_APPS}\n${DOWNLOADED}\n`)).toEqual({
      kind: "found",
      dir: "C:\\x\\28.0.46665.53671\\platform-apps",
      appCount: 6,
    });
  });

  test("two SPELLINGS of one directory are one directory", () => {
    // Separator, trailing separator and (on win32) case are formatting, not identity. Without
    // normalisation the conflict guard below would fire on a cosmetic difference and silently turn
    // the whole optimisation off.
    const parsed = parseAlRunnerPlatformAppsDir(
      `${DOWNLOADED}\n[provision] Downloaded 6 app(s) (115 MB total) to C:/x/28.0.46665.53671/platform-apps/\n`,
    );
    expect(parsed.kind).toBe("found");
  });

  test("two DIFFERENT directories refuse, and name both", () => {
    // Two provisioning passes disagreeing about where the platform apps live leaves LethAL no basis
    // for picking one. Picking one anyway is the invented-plausible-default this repo refuses.
    const parsed = parseAlRunnerPlatformAppsDir(
      `${DOWNLOADED}\n[provision] Downloaded 6 app(s) (115 MB total) to C:\\x\\28.0.46665.53700\\platform-apps\n`,
    );
    expect(parsed.kind).toBe("conflicting");
    if (parsed.kind !== "conflicting") throw new Error("unreachable");
    expect(parsed.dirs.length).toBe(2);
  });

  test("takes the LARGEST count any pass claimed", () => {
    // The count becomes a floor on how many `*.app` files the directory must hold. If two passes
    // disagree, believing the smaller one would accept a directory the larger pass says is short.
    const parsed = parseAlRunnerPlatformAppsDir(
      `[provision] Downloaded 4 app(s) (80 MB total) to C:\\x\\28.0.46665.53671\\platform-apps\n${DOWNLOADED}\n`,
    );
    expect(parsed).toEqual({
      kind: "found",
      dir: "C:\\x\\28.0.46665.53671\\platform-apps",
      appCount: 6,
    });
  });

  test("a `~`-rooted path is READ, not ignored", () => {
    // This runner prints `~`-rooted paths elsewhere (see `parseAlRunnerBcBuild`'s doc comment). If
    // the matcher skipped them the refusal would read "the runner printed nothing", when what
    // actually happened is "it printed a path we cannot open". The directory check downstream is
    // what rejects it, and it says which.
    expect(
      parseAlRunnerPlatformAppsDir(
        "[provision] Downloaded 6 app(s) (115 MB total) to ~/.local/share/al-runner/artifacts/28.0.46665.53671/platform-apps\n",
      ),
    ).toEqual({
      kind: "found",
      dir: "~/.local/share/al-runner/artifacts/28.0.46665.53671/platform-apps",
      appCount: 6,
    });
  });
});

describe("isChildChosenExit (R147, lifted out of the R123 probe)", () => {
  // A killed child comes back as 128 + signal and a spawn failure as a negative code. Neither is
  // al-runner answering. `al-runner-contract.ts` measured this and guarded one fact with it; R147
  // needs the same predicate to decide whether a provisioning run's output can be believed, so
  // there is ONE spelling of it rather than two that can drift.
  test("0 and 1 are the runner speaking", () => {
    expect(isChildChosenExit(0)).toBe(true);
    expect(isChildChosenExit(1)).toBe(true);
  });
  test("143 (SIGTERM) and -1 (spawn failure) are not", () => {
    expect(isChildChosenExit(143)).toBe(false);
    expect(isChildChosenExit(-1)).toBe(false);
  });
});

describe("buildAlRunnerArgv — the pin and --auto-provision are mutually exclusive (R147)", () => {
  const base = {
    sourceDir: "C:/proj/app",
    testDir: "C:/proj/tests",
    qualifiedTest: "Suite.Test",
  };

  test("with a pin: --package-cache <pin>, and NO --auto-provision", () => {
    const argv = buildAlRunnerArgv("al-runner", { ...base, platformAppsDir: "C:/cache/pa" });
    expect(argv).not.toContain("--auto-provision");
    expect(argv.indexOf("--package-cache")).toBeGreaterThanOrEqual(0);
    expect(argv).toContain("C:/cache/pa");
  });

  test("CONTROL: with no pin the argv is exactly what it was before R147", () => {
    // Passes with the feature working and with it removed alike, so the change cannot pass by being
    // switched off. Every caller that does not opt in — the provisioning invocation itself (R125's
    // ruling) and the R123 contract probe — is on this path.
    expect(buildAlRunnerArgv("al-runner", base)).toEqual([
      "al-runner",
      "--output-json",
      "--isolation",
      "test",
      "--test",
      "Suite.Test",
      "--auto-provision",
      "C:/proj/app",
      "C:/proj/tests",
    ]);
  });

  test("a configured packagesDir and the pin BOTH reach the runner", () => {
    // `--package-cache` is repeatable (al-runner's own --help), so the pin ADDS to the project's own
    // symbol directory rather than replacing it. Measured 2026-08-15 against the real binary: the
    // two-entry shape reports `package caches: 2 dir(s)`, exits 0, and resolves dependencies
    // identically to today's single-entry shape.
    const argv = buildAlRunnerArgv("al-runner", {
      ...base,
      packagesDir: "C:/proj/.alpackages",
      platformAppsDir: "C:/cache/pa",
    });
    expect(argv.filter((a) => a === "--package-cache").length).toBe(2);
    expect(argv).toContain("C:/proj/.alpackages");
    expect(argv).toContain("C:/cache/pa");
    expect(argv).not.toContain("--auto-provision");
  });

  test("the positional bundle dirs still precede every --package-cache entry", () => {
    const argv = buildAlRunnerArgv("al-runner", { ...base, platformAppsDir: "C:/cache/pa" });
    expect(argv.indexOf(base.testDir)).toBeLessThan(argv.indexOf("--package-cache"));
  });
});

interface Spy {
  readonly calls: string[][];
  readonly spawn: SpawnFn;
}

function spyingSpawn(result: { exitCode: number; stdout: string; stderr: string }): Spy {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    return result;
  };
  return { calls, spawn };
}

/** A platform-apps directory holding `n` `.app` files, plus a decoy that is not one. */
async function platformAppsDirWith(n: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r147-"));
  const dir = join(root, "28.0.46665.53671", "platform-apps");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `Microsoft_App${i}.app`), "x", "utf8");
  await writeFile(join(dir, "notes.txt"), "not an app", "utf8");
  return dir;
}

async function makeBackend(spawn: SpawnFn): Promise<AlRunnerBackend> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r147-backend-"));
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  return new AlRunnerBackend(
    { alRunnerPath: "al-runner", instrumentedDir: dir, testDir: "/tests", selectorObjectId: 50000 },
    spawn,
  );
}

function downloadedLine(dir: string, count: number): string {
  return `[provision] Downloaded ${count} app(s) (115 MB total) to ${dir}`;
}

describe("AlRunnerBackend.provisionOnce establishes the pin, or says why not (R147)", () => {
  test("all three conditions met: the directory is reported", async () => {
    const dir = await platformAppsDirWith(6);
    const { spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: downloadedLine(dir, 6) });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir).toBe(dir);
    expect(result.platformAppsRefusal).toBeUndefined();
  });

  test("a SIGNAL-killed provisioning is not believed, however complete its output looks", async () => {
    // `defaultSpawn` RESOLVES on a killed child with 128 + signal and whatever partial output it had
    // written (measured for R123). Under the old `ran: exitCode >= 0` predicate 143 reads as "it
    // ran", and a directory half written by a download the kill interrupted would be pinned for the
    // whole session. Today's behaviour repairs that on every invocation because every invocation
    // re-runs `--auto-provision`; R147 removes that repair from all but the first.
    const dir = await platformAppsDirWith(6);
    const { spawn } = spyingSpawn({ exitCode: 143, stdout: "", stderr: downloadedLine(dir, 6) });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir).toBeUndefined();
    expect(result.platformAppsRefusal ?? "").toContain("143");
  });

  test("a directory holding fewer apps than the runner claimed is refused", async () => {
    // The runner states its own count in the same sentence that states the path. Reading that number
    // is the same principle as reading the path; deciding the number ourselves would be a guess.
    const dir = await platformAppsDirWith(3);
    const { spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: downloadedLine(dir, 6) });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir).toBeUndefined();
    expect(result.platformAppsRefusal ?? "").toContain("3");
  });

  test("a directory that does not exist is refused BY NAME", async () => {
    const missing = join(tmpdir(), "lethal-r147-absent", "28.0.0.1", "platform-apps");
    const { spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: downloadedLine(missing, 6) });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir).toBeUndefined();
    expect(result.platformAppsRefusal ?? "").toContain(missing);
  });

  test("no completion line: refused, and the refusal says that is what happened", async () => {
    const { spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: `${FETCHING}\n` });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir).toBeUndefined();
    expect(result.platformAppsRefusal ?? "").toMatch(/printed no|no completion/i);
  });

  test("a refusal is ALWAYS present when a pin is not — never both absent", async () => {
    // The one property that makes "unpinned" reportable. Without it a reader cannot tell a run that
    // declined to pin from a build of LethAL that never had the feature.
    const { spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: "nothing at all\n" });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.platformAppsDir === undefined && result.platformAppsRefusal !== undefined).toBe(
      true,
    );
  });

  test("the provisioning invocation ITSELF keeps --auto-provision (R125)", async () => {
    // R125's ruling: `--auto-provision` is what makes a cold machine work at all, and dropping it
    // from this step is the mistake that row exists to prevent. Measured again 2026-08-15 on a
    // deliberately emptied 28.0 build directory: this invocation recreated it in 12.1 s.
    const dir = await platformAppsDirWith(6);
    const { calls, spawn } = spyingSpawn({
      exitCode: 0,
      stdout: "",
      stderr: downloadedLine(dir, 6),
    });
    await (await makeBackend(spawn)).provisionOnce();
    expect(calls[0] ?? []).toContain("--auto-provision");
  });
});

describe("AlRunnerBackend.usePlatformAppsDir reaches the argv of every later run (R147)", () => {
  test("before the pin, run() sends --auto-provision", async () => {
    const { calls, spawn } = spyingSpawn({
      exitCode: 0,
      stdout: '{"tests":[{"name":"Codeunit1.T","status":"pass"}]}',
      stderr: "",
    });
    const backend = await makeBackend(spawn);
    await backend.run(
      { codeunitId: 1, codeunitName: "T Suite", method: "T" },
      { timeoutMs: 60_000, coverage: "none" },
    );
    expect(calls[0] ?? []).toContain("--auto-provision");
  });

  test("after the pin, run() sends --package-cache <pin> and no --auto-provision", async () => {
    const { calls, spawn } = spyingSpawn({
      exitCode: 0,
      stdout: '{"tests":[{"name":"Codeunit1.T","status":"pass"}]}',
      stderr: "",
    });
    const backend = await makeBackend(spawn);
    backend.usePlatformAppsDir("C:/cache/pa");
    await backend.run(
      { codeunitId: 1, codeunitName: "T Suite", method: "T" },
      { timeoutMs: 60_000, coverage: "none" },
    );
    const argv = calls[0] ?? [];
    expect(argv).not.toContain("--auto-provision");
    expect(argv).toContain("C:/cache/pa");
  });
});
