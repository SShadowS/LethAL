import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R264: unit tests must never read or write the developer's real home. Defaults such as
 * al-runner's caches (multi-GB here), `~/.lethal/quarantine` and `~/.vscode/extensions` all
 * resolve through `os.homedir()`, which on Bun/Windows reads USERPROFILE at call time (measured
 * 2026-09-27) and on POSIX reads HOME. Both point at a fresh empty temp dir for this process.
 * `mkdtempSync` throws if it cannot create one, so a failure stops the suite rather than
 * silently leaving the real home in place.
 */
process.env.LETHAL_TEST_REAL_HOME = homedir();
const fake = mkdtempSync(join(tmpdir(), "lethal-test-home-"));
process.env.LETHAL_TEST_FAKE_HOME = fake;
process.env.USERPROFILE = fake;
process.env.HOME = fake;
