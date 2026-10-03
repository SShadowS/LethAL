import { test as bunTest, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    fake("git", 'if [ "$1" = clone ]; then mkdir -p "${@: -1}/.git"; fi');
    fake("flock", "true");
    const run = () => {
      const r = Bun.spawnSync(["bash", script], {
        env: { ...process.env, PATH: bin + delimiter + process.env.PATH, KRAKEN_SETUP_SRC: src },
      });
      expect(r.stderr.toString()).toBe("");
      expect(r.exitCode).toBe(0);
    };
    run();
    expect(readFileSync(calls, "utf8").match(/^git .*$/gm)).toEqual([
      `git clone --quiet --depth 1 --branch w1-28 --single-branch https://github.com/StefanMaron/MSDyn365BC.Code.History.git ${src}/BC.History`,
    ]);
    run();
    expect(readFileSync(calls, "utf8").match(/^git /gm)?.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
