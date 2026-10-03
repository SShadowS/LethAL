import { afterAll, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One private directory per `bun test` process, made in the real temp folder and removed when the
 * run ends. It holds the fake home (R264) and the redirected temp folder (R358).
 */
const runDir = mkdtempSync(join(tmpdir(), "lethal-unit-run-"));

/**
 * R264: unit tests must never read or write the developer's real home. Defaults such as
 * al-runner's caches (multi-GB here), `~/.lethal/quarantine` and `~/.vscode/extensions` all
 * resolve through `homeDir()` (`packages/runner/src/home.ts`). On Windows that is `os.homedir()`,
 * which reads USERPROFILE at call time (measured 2026-09-27). On POSIX Bun's `os.homedir()` keeps
 * the HOME the process STARTED with (R409), so `homeDir()` reads HOME itself at call time. Both
 * variables point at a fresh empty dir for this process.
 * `mkdirSync` throws if it cannot create one, so a failure stops the suite rather than silently
 * leaving the real home in place.
 */
process.env.LETHAL_TEST_REAL_HOME = homedir();
const fake = join(runDir, "home");
mkdirSync(fake);
process.env.LETHAL_TEST_FAKE_HOME = fake;
process.env.USERPROFILE = fake;
process.env.HOME = fake;

/**
 * R358: the temp folder is shared by every session on the machine, so a check that scanned it
 * would blame whichever test happened to be running when another session wrote there. Instead
 * `os.tmpdir()` (which reads TEMP/TMP on Windows and TMPDIR on POSIX at call time) points at a
 * directory only this process uses, and the run FAILS, naming the test file, if a file leaves a
 * `lethal-*` entry there.
 *
 * Bun runs every file in one process and a preload's `afterAll` runs once for the whole run
 * (measured 2026-09-30), so there is no per-file hook. Instead each test's new entries (made
 * between the preload's `beforeEach` and `afterEach`) are held against the file that made them,
 * found through `Bun.main`, which names the running test file. When the next file starts, or the
 * run ends, whatever of them still exists is a leak: a file may clean up in its own `afterAll`,
 * which runs after the last test, so nothing is judged earlier. An entry made in a `beforeAll`
 * is outside every test; the run-end check catches it, without a file name.
 *
 * A child process does NOT see this redirect: Bun gives a child the environment the parent
 * STARTED with unless `env` is passed explicitly (measured 2026-09-30), so a child's temp files
 * land in the real temp folder, outside this guard. A full run left nothing there on 2026-09-30.
 */
const tmp = join(runDir, "tmp");
mkdirSync(tmp);
process.env.TEMP = tmp;
process.env.TMP = tmp;
process.env.TMPDIR = tmp;

const lethalEntries = (): string[] => readdirSync(tmp).filter((e) => e.startsWith("lethal-"));
const leaks: string[] = [];
let file = "";
let made: string[] = [];
let before = new Set<string>();
function judgeFile(): void {
  const left = made.filter((e) => existsSync(join(tmp, e)));
  if (left.length > 0) leaks.push(`${file}: ${left.join(", ")}`);
  made = [];
}
beforeEach(() => {
  if (Bun.main !== file) {
    judgeFile();
    file = Bun.main;
  }
  before = new Set(lethalEntries());
});
afterEach(() => {
  for (const e of lethalEntries()) if (!before.has(e)) made.push(e);
});
afterAll(() => {
  judgeFile();
  const stray = lethalEntries();
  // Built BEFORE the removal, and a failed removal is appended rather than thrown: a leaked file
  // still held open (EBUSY on Windows) must not replace the list that names who leaked it.
  const lines =
    leaks.length > 0 || stray.length > 0
      ? [
          "R358: test files left lethal-* entries in the temp folder. Bun reports this under the LAST file that ran; the leaking files are named below. Remove what a test creates (in the test, an afterEach or the file's afterAll); if product code made it, fix the product.",
          ...leaks,
          ...(stray.length > 0 ? [`still present at the end of the run: ${stray.join(", ")}`] : []),
        ]
      : [];
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    lines.push(`could not remove ${runDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (lines.length > 0) throw new Error(lines.join("\n"));
});
