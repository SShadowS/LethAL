import { test as bunTest, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Runs scripts/kraken-corpora.sh with a fake git and flock on PATH. Linux only, like
// kraken-setup.test.ts (the script runs only inside the Linux kraken image).
const script = resolve(import.meta.dir, "kraken-corpora.sh");
const test = process.platform === "win32" ? bunTest.skip : bunTest;

test("clones the BaseApp corpus once, depth 1, and never pulls", () => {
  const root = mkdtempSync(join(tmpdir(), "kraken-corpora-"));
  try {
    const bin = join(root, "bin");
    const src = join(root, "src");
    const calls = join(root, "calls.log");
    mkdirSync(bin);
    const fake = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, {
        mode: 0o755,
      });
    // the last argument is the destination: make its .git so the second run sees a checkout
    // FAKE_GIT_FAIL: a clone that dies part-way, leaving a half checkout at the destination
    fake(
      "git",
      'if [ "$1" = clone ]; then mkdir -p "${@: -1}/.git"; if [ -n "${FAKE_GIT_FAIL:-}" ]; then exit 1; fi; fi',
    );
    fake("flock", "true");
    const run = (env: Record<string, string> = {}) =>
      Bun.spawnSync(["bash", script], {
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          KRAKEN_SETUP_SRC: src,
          ...env,
        },
      });
    // a failed clone: warns, exits non-zero, and leaves no BC.History for the next run to trust
    const bad = run({ FAKE_GIT_FAIL: "1" });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain("clone of the BaseApp corpus failed");
    expect(existsSync(join(src, "BC.History"))).toBe(false);

    const ok = run();
    expect(ok.stderr.toString()).toBe("");
    expect(ok.exitCode).toBe(0);
    expect(existsSync(join(src, "BC.History", ".git"))).toBe(true);
    const clones = readFileSync(calls, "utf8").match(/^git .*$/gm) ?? [];
    expect(clones.at(-1)).toBe(
      `git clone --quiet --depth 1 --branch w1-28 --single-branch https://github.com/StefanMaron/MSDyn365BC.Code.History.git ${src}/.BC.History.partial`,
    );
    expect(run().exitCode).toBe(0);
    expect(readFileSync(calls, "utf8").match(/^git /gm)?.length).toBe(clones.length); // no third clone
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
