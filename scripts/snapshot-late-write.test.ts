/**
 * R393: a timed-out test keeps running, and its late `toMatchSnapshot()` is filed under the NEXT
 * test's name. This runs the inert fixture (a real late write) in a fresh temp folder and checks that
 * `CI=true` at launch turns the silent wrong write into a refusal.
 *
 * Isolation: the temp folder is outside the repo, so the root `bunfig.toml` (and its preload) is not
 * found, and the child's env is built explicitly, so the outer suite's CI setting does not matter.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "r393", "late-write.fixture.ts");
const KEY = "B has no snapshot 1";
const roots: string[] = [];

function runLate(opts: { ci: boolean; seed?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "r393-late-"));
  roots.push(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"r393-late","private":true}');
  copyFileSync(FIXTURE, join(dir, "late.test.ts"));
  const snap = join(dir, "__snapshots__", "late.test.ts.snap");
  if (opts.seed !== undefined) {
    mkdirSync(join(dir, "__snapshots__"));
    writeFileSync(
      snap,
      `// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n\nexports[\`${KEY}\`] = \`\n{\n  "from": "${opts.seed}",\n}\n\`;\n`,
    );
  }
  const marker = join(dir, "marker.log");
  // CI must be ABSENT (not the string "undefined") in the control, so rebuild the env without it.
  const env = Object.fromEntries(
    Object.entries({ ...process.env, MARK: marker }).filter(([k]) => k !== "CI"),
  );
  if (opts.ci) env.CI = "true";
  const r = Bun.spawnSync(["bun", "test", "--timeout", "200"], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode ?? 1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
    marker: existsSync(marker) ? readFileSync(marker, "utf8") : "",
    snap: existsSync(snap) ? readFileSync(snap, "utf8") : "",
  };
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("R393 late snapshot write", () => {
  test("(a) CI=true: A's late call is refused, naming B's key, and nothing is written", () => {
    const r = runLate({ ci: true });
    expect(r.marker).toContain("A late call reached; CI=true");
    expect(r.marker).toContain(
      "Snapshot creation is disabled in CI environments unless --update-snapshots is used",
    );
    expect(r.marker).toContain(`Snapshot name: "${KEY}"`);
    expect(r.out).toMatch(/timed out/i);
    expect(r.code).not.toBe(0);
    expect(r.snap).not.toContain(KEY);
  });

  test("(b) control, CI unset: the wrong entry IS written under B's key", () => {
    const r = runLate({ ci: false });
    expect(r.marker).toContain("A late toMatchSnapshot returned OK");
    expect(r.snap).toContain(KEY);
    expect(r.snap).toContain('"from": "A"');
  });

  test("(c) control, existing entry: a different late value fails as a mismatch", () => {
    const r = runLate({ ci: true, seed: "seed" });
    expect(r.marker).toContain("A late toMatchSnapshot THREW");
    expect(r.marker).not.toContain("Snapshot creation is disabled");
    expect(r.code).not.toBe(0);
    expect(r.snap).toContain('"from": "seed"');
    expect(r.snap).not.toContain('"from": "A"');
  });
});
