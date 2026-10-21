import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GroupName, combineWorkers, groupLegs } from "./alrunner-legs";
import { type WorkerSpec, spawnWorker, superviseGroups } from "./alrunner-supervisor";

/**
 * I4: the REAL spawn and exit glue, against a fake worker script. Each wrong outcome must fail,
 * naming the group, once `combineWorkers` judges what `spawnWorker` saw.
 */
const NONCE = "e".repeat(32);
const BUILD = "al-runner v2.12.0-main.test";

const FAKE = `
import { writeFileSync } from "node:fs";
const [mode, dir, group, legs] = process.argv.slice(2);
console.log("cwd=" + process.cwd());
console.error("to stderr");
const done = () => writeFileSync(dir + "/" + group + ".done.json",
  JSON.stringify({ runNonce: "${NONCE}", group, ran: legs.split(","), buildLine: "${BUILD}" }));
if (mode === "ok") { done(); process.exit(4); }
if (mode === "exit4-nodone") process.exit(4);
if (mode === "exit0") { done(); process.exit(0); }
if (mode === "sigkill") process.kill(process.pid, "SIGKILL");
if (mode === "sleep") {
  // The worst worker: it claims green after a signal. The supervisor must still fail the run.
  process.on("SIGTERM", () => { done(); process.exit(4); });
  console.log("ready");
  setTimeout(() => process.exit(9), 30000);
}
`;

let root: string;
let script: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lethal-r587-sup-"));
  script = join(root, "fake-worker.ts");
  writeFileSync(script, FAKE);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function spec(group: GroupName, mode: string, out: string[], dir: string, cwd = root): WorkerSpec {
  return {
    group,
    argv: [process.execPath, script, mode, dir, group, groupLegs(group).join(",")],
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    reportsDir: dir,
    out: (l) => out.push(l),
  };
}

async function one(mode: string, cwd?: string) {
  const dir = mkdtempSync(join(root, "run-"));
  const out: string[] = [];
  const r = await spawnWorker(spec("layout", mode, out, dir, cwd)).finished;
  return { r, out, c: combineWorkers([r], { nonce: NONCE, buildLine: BUILD }) };
}

describe("spawnWorker against a fake worker (I4)", () => {
  test("exit 4 with a good done-file counts, and every line is prefixed (M3)", async () => {
    const { r, out, c } = await one("ok");
    expect(r.exitCode).toBe(4);
    expect(c.failures).toEqual([]);
    expect(c.ran).toEqual([...groupLegs("layout")]);
    expect(out).toContain("[layout] to stderr");
  });

  test("M4: the worker runs in the cwd it was given", async () => {
    const cwd = mkdtempSync(join(root, "cwd-"));
    const { out } = await one("ok", cwd);
    expect(out).toContain(`[layout] cwd=${cwd}`);
  });

  test("exit 4 with no done-file fails, naming the group", async () => {
    const { c } = await one("exit4-nodone");
    expect(c.failures.join()).toMatch(/worker layout: wrote no layout.done.json/);
    expect(c.ran).toEqual([]);
  });

  test("SIGKILL fails, naming the group (exitCode null is never read as a pass)", async () => {
    const { r, c } = await one("sigkill");
    expect(r.signal).toBe("SIGKILL");
    expect(c.failures.join()).toMatch(/worker layout: killed by SIGKILL/);
    expect(c.ran).toEqual([]);
  });

  test("exit 0 fails, naming the group, even with a done-file", async () => {
    const { c } = await one("exit0");
    expect(c.failures.join()).toMatch(/worker layout: exited 0/);
    expect(c.ran).toEqual([]);
  });
});

describe("superviseGroups (I5)", () => {
  test("an abort forwards the signal to live workers and the run fails as interrupted", async () => {
    const dir = mkdtempSync(join(root, "run-"));
    const out: string[] = [];
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = superviseGroups({
      groups: ["layout", "names"],
      parallel: 1,
      specFor: (g) => ({
        ...spec(g, "sleep", out, dir),
        out: (l) => {
          out.push(l);
          if (l.endsWith("ready")) ac.abort("SIGTERM");
        },
      }),
      signal: ac.signal,
    });
    const res = await pending;
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(res.interrupted).toBe("SIGTERM");
    // names is longest-first, so it started; layout never did.
    const names = res.results.find((r) => r.group === "names");
    expect(names?.exitCode).toBe(4);
    expect(res.results.find((r) => r.group === "layout")?.signal).toBe("not-started");
    const c = combineWorkers(res.results, {
      nonce: NONCE,
      buildLine: BUILD,
      ...(res.interrupted !== undefined ? { interrupted: res.interrupted } : {}),
    });
    expect(c.failures.join("\n")).toMatch(/interrupted by SIGTERM/);
    expect(c.failures.join("\n")).toMatch(/worker layout: not started/);
  });
});
