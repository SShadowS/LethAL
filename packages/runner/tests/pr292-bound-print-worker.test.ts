// PR-292 (R1156 follow-up): the per-send bound print runs in worker threads, so N lanes' checks no longer queue on
// LethAL's one JS thread. Spec: docs/superpowers/specs/2026-11-21-pr292-bound-print-worker.md, section 3.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { printAlTree, printTestDir, printWalkedSync } from "../src/baseline-snapshot";
import { ProjectSymlinkRefusedError } from "../src/walk";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
const tree = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pr292-"));
  roots.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
};

describe("PR-292: the bound print in a worker", () => {
  test("1: the JS thread stays free while a large tree is printed (a 1 ms interval keeps ticking)", async () => {
    // About 48 MB of .al: the synchronous print took tens of ms here and ticked 0 times.
    const big = "codeunit 50100 Big { }\n".repeat(50_000);
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`src/F${i}.Codeunit.al`] = big;
    const dir = await tree(files);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await printAlTree(dir);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(5); // spec §3 test 1; the synchronous print ticked 0
  }, 60_000);

  test("2: the worker's prints equal the inline computation, the root control file left out of the tree print only", async () => {
    const dir = await tree({
      "Logic.Codeunit.al": "codeunit 50100 Logic { }",
      "sub/More.Codeunit.al": "codeunit 50101 More { }",
      "MutationSelector.Codeunit.al": "codeunit 50199 Sel { }",
      "notes.txt": "not al",
    });
    expect(await printAlTree(dir)).toBe(printWalkedSync(dir, "refuse", true));
    expect(await printTestDir(dir)).toBe(printWalkedSync(dir, "refuse", false));
    expect(await printAlTree(dir)).not.toBe(await printTestDir(dir));
    const before = await printAlTree(dir);
    await writeFile(join(dir, "sub/More.Codeunit.al"), "codeunit 50101 Mora { }");
    expect(await printAlTree(dir)).not.toBe(before);
  });

  test("3: a link refusal crosses the thread as a real ProjectSymlinkRefusedError naming the link", async () => {
    const dir = await tree({ "Logic.Codeunit.al": "codeunit 50100 Logic { }" });
    const elsewhere = await tree({ "H.Codeunit.al": "codeunit 50150 H { }" });
    await symlink(elsewhere, join(dir, "helpers"), "junction");
    const err = await printAlTree(dir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((err as ProjectSymlinkRefusedError).linkPath).toContain("helpers");
  });

  test("4: a missing directory rejects (no hang), naming the directory", async () => {
    const gone = join(tmpdir(), `pr292-missing-${process.pid}`);
    await expect(printAlTree(gone)).rejects.toThrow(/pr292-missing/);
  });

  test("5: concurrent prints each get their own tree's answer (none swapped)", async () => {
    // The FIRST request gets a large tree, so it finishes last: answers matched by arrival order would swap.
    const big = "codeunit 50300 Big { }\n".repeat(50_000);
    const bigFiles: Record<string, string> = {};
    for (let i = 0; i < 20; i++) bigFiles[`B${i}.Codeunit.al`] = big;
    const dirs = [
      await tree(bigFiles),
      ...(await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          tree({ [`C${i}.Codeunit.al`]: `codeunit ${50200 + i} C${i} { }` }),
        ),
      )),
    ];
    const got = await Promise.all(dirs.map((d) => printAlTree(d)));
    expect(got).toEqual(dirs.map((d) => printWalkedSync(d, "refuse", true)));
    expect(new Set(got).size).toBe(6);
  });

  test(
    "6: a process that prints once exits by itself (the pool never holds it open)",
    async () => {
      const dir = await tree({ "Logic.Codeunit.al": "codeunit 50100 Logic { }" });
      const script = join(dir, "..", `pr292-exit-${process.pid}.ts`);
      await writeFile(
        script,
        `import { printAlTree } from ${JSON.stringify(join(import.meta.dir, "../src/baseline-snapshot"))};\n` +
          `console.log(await printAlTree(${JSON.stringify(dir)}));\n`,
      );
      roots.push(script);
      const t0 = performance.now();
      const p = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 10_000);
      const code = await p.exited;
      clearTimeout(timer);
      expect(code).toBe(0);
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect((await new Response(p.stdout).text()).trim()).toBe(
        printWalkedSync(dir, "refuse", true),
      );
    },
    ownTimeout(20_000),
  );
});
