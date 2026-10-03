import { test as bunTest, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Decision logic of scripts/al-runner-update.sh and al-runner-bootstrap.sh with fake git, dotnet,
// bun and flock. Linux only, like kraken-setup.test.ts (the scripts run only in the kraken image).
const update = resolve(import.meta.dir, "al-runner-update.sh");
const bootstrap = resolve(import.meta.dir, "al-runner-bootstrap.sh");
const test = process.platform === "win32" ? bunTest.skip : bunTest;
const SHA = "abcd1234";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "al-runner-update-"));
  const bin = join(root, "bin");
  const tools = join(root, "tools");
  const src = join(root, "src");
  const wt = join(root, "wt");
  const calls = join(root, "calls.log");
  const old = join(root, "old-build"); // stands for the image's c39ad5de build
  for (const d of [bin, tools, src, wt, old]) mkdirSync(d, { recursive: true });
  symlinkSync(old, join(tools, "current"));
  const fake = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, {
      mode: 0o755,
    });
  fake(
    "git",
    `case "$*" in
  *" clone "*) mkdir -p "\${@: -1}/.git" ;;
  *"rev-parse --short"*) echo ${SHA} ;;
  *"worktree add"*) mkdir -p "\${@: -2:1}" ;;
esac`,
  );
  // dotnet tool install ... --tool-path <dir>: writes <dir>/al-runner
  fake(
    "dotnet",
    `if [ "$2" = install ]; then for ((i=1;i<=$#;i++)); do if [ "\${!i}" = --tool-path ]; then j=$((i+1)); mkdir -p "\${!j}"; echo x > "\${!j}/al-runner"; chmod +x "\${!j}/al-runner"; fi; done; fi`,
  );
  // the gate: `bun run itest:alrunner`, exit code from FAKE_GATE
  fake(
    "bun",
    `echo "gate path=$LETHAL_ALRUNNER_PATH flag=$LETHAL_ITEST_ALRUNNER" >> "${calls}"; echo "gate summary line"; exit "\${FAKE_GATE:-0}"`,
  );
  fake("flock", "true");
  const run = (script: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", script], {
      cwd: wt,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        KRAKEN_SETUP_SRC: src,
        AL_RUNNER_TOOLS: tools,
        ...env,
      },
    });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { root, tools, old, run, log };
}

test("an already built and gated sha: nothing to do, current unchanged, no build, no gate", () => {
  const t = setup();
  try {
    mkdirSync(join(t.tools, SHA));
    writeFileSync(join(t.tools, SHA, "al-runner"), "x", { mode: 0o755 });
    const r = t.run(update);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(join(t.tools, "current"))).toBe(t.old);
    expect(t.log()).not.toMatch(/^dotnet /m);
    expect(t.log()).not.toMatch(/^bun /m);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a gate that fails leaves current alone, exits non-zero and names the failure", () => {
  const t = setup();
  try {
    const r = t.run(update, { FAKE_GATE: "1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(`${SHA} FAILED the itest:alrunner gate`);
    expect(r.stderr.toString()).toContain("gate summary line"); // the failing output is printed
    expect(readlinkSync(join(t.tools, "current"))).toBe(t.old);
    expect(existsSync(join(t.tools, SHA))).toBe(false); // not left where a rerun would call it good
    expect(existsSync(join(t.tools, "failed", SHA, "al-runner"))).toBe(true);
    expect(t.log()).toMatch(/^dotnet pack .*-p:AllowBcArtifactDownload=true/m);
    // the same failing commit is not rebuilt and re-gated every day
    const again = t.run(update, { FAKE_GATE: "1" });
    expect(again.exitCode).not.toBe(0);
    expect(t.log().match(/^dotnet pack /gm)?.length).toBe(1);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a gate that passes moves current onto the new build, gated on that build's own path", () => {
  const t = setup();
  try {
    const r = t.run(update);
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(join(t.tools, "current"))).toBe(join(t.tools, SHA));
    expect(existsSync(join(t.tools, "current", "al-runner"))).toBe(true);
    expect(t.log()).toContain(`gate path=${join(t.tools, SHA)}/al-runner flag=1`);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("bootstrap creates current once and never repoints an existing one", () => {
  const t = setup();
  try {
    rmSync(join(t.tools, "current"));
    const boot = join(t.root, "boot");
    mkdirSync(boot);
    expect(t.run(bootstrap, { AL_RUNNER_BOOTSTRAP: boot }).exitCode).toBe(0);
    expect(readlinkSync(join(t.tools, "current"))).toBe(boot);
    expect(t.run(bootstrap, { AL_RUNNER_BOOTSTRAP: "/elsewhere" }).exitCode).toBe(0);
    expect(readlinkSync(join(t.tools, "current"))).toBe(boot);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
