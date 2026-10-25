import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { alRunnerCoverageSupport } from "../src/al-runner-coverage";
import { buildPackageCacheCopy } from "../src/artifact";
import {
  SourceSnapshotUnreadableError,
  hashTestDir,
  readTargetSource,
  targetAlFiles,
  testAppHashFor,
} from "../src/baseline-snapshot";
import { danglingPackageWarning } from "../src/bcdev-backend";
import { configuredPackageCaches, loadDryRunConfig } from "../src/cli";
import { discoverTests } from "../src/discovery";
import { generateMutationSet, prepareBatchProject } from "../src/orchestrator";
import { ProjectChangedDuringRunError, watchProjectInputs } from "../src/source-drift";
import { readTestAppSources } from "../src/testpage-scan";
import {
  ProjectSymlinkRefusedError,
  onSkippedLinks,
  reachLimits,
  reachStats,
  refuseProjectLinks,
  setPackageCacheDirs,
} from "../src/walk";
import { scratchDirs } from "./helpers/scratch";

/**
 * R631 per site. alc, the .NET al-runner and al-runner v3 all FOLLOW a linked folder and a linked
 * `.al` file (measured, `/coord/handoff/R-631/tool-link-probe.md`), so every walk of a user target
 * or test root refuses a link by name rather than measure a different build.
 *
 * Directory links are junctions (no privilege needed on Windows). A file-link case skips BY NAME
 * on EPERM only.
 */
const scratch = scratchDirs();

const CODEUNIT =
  'codeunit 50100 "Alpha"\n{\n    procedure A(): Integer\n    begin\n        exit(1);\n    end;\n}\n';
const TEST_CU =
  'codeunit 50110 "Alpha Tests"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T()\n    begin\n    end;\n}\n';

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function fileLink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, "file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}

/** A project with `src/A.al` and a linked `src/Linked.al`, or `undefined` on Windows EPERM. */
function projectWithLinkedFile(text = CODEUNIT): { dir: string; link: string } | undefined {
  const base = scratch("lethal-r631-");
  const dir = join(base, "app");
  put(dir, "app.json", JSON.stringify({ id: "x", name: "App", version: "1.0.0.0" }));
  put(dir, "src/A.al", text);
  put(base, "outside/Linked.al", text.replace("50100", "50101").replace("50110", "50111"));
  const link = join(dir, "src", "Linked.al");
  return fileLink(join(base, "outside", "Linked.al"), link) ? { dir, link } : undefined;
}

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

/** A project with `src/A.al` and a JUNCTIONED `src/linked` folder holding `Linked.al`. Junctions
 *  need no privilege, so this variant runs on the Windows CI job too (review M2). */
function projectWithLinkedFolder(text = CODEUNIT): { dir: string; link: string } {
  const base = scratch("lethal-r631-");
  const dir = join(base, "app");
  put(dir, "app.json", JSON.stringify({ id: "x", name: "App", version: "1.0.0.0" }));
  put(dir, "src/A.al", text);
  put(base, "outside/Linked.al", text.replace("50100", "50101").replace("50110", "50111"));
  const link = join(dir, "src", "linked");
  symlinkSync(join(base, "outside"), link, "junction");
  return { dir, link };
}

const LINK_KINDS = {
  "a junctioned folder": projectWithLinkedFolder,
  "a linked .al file": projectWithLinkedFile,
} as const;

for (const [kind, make] of Object.entries(LINK_KINDS))
  describe(`R631: ${kind} refuses at every user-root reader, by the same class and path`, () => {
    test("target scan, batch prepare, the no-snapshot paths and test discovery", async () => {
      await initParser();
      const p = make();
      if (p === undefined) {
        console.log(`SKIPPED (EPERM): ${kind} at every reader`);
        return;
      }
      const t = make(TEST_CU);
      if (t === undefined) {
        console.log(`SKIPPED (EPERM): ${kind} at every reader`);
        return;
      }
      const batch = scratch("lethal-r631-batch-");
      // Each reader on its own, so one that stops refusing is named rather than hidden by another.
      const readers: Record<string, [() => Promise<unknown>, string]> = {
        targetAlFiles: [() => targetAlFiles(p.dir), p.link],
        readTargetSource: [() => readTargetSource(p.dir), p.link],
        prepareBatchProject: [
          () => prepareBatchProject(p.dir, batch, { id: "x" }, "1.0.0.1"),
          p.link,
        ],
        // With a snapshot, only the resource walk reads the disk.
        "prepareBatchProject(resources)": [
          () =>
            prepareBatchProject(
              p.dir,
              scratch("lethal-r631-batch-"),
              { id: "x" },
              "1.0.0.1",
              new Map(),
            ),
          p.link,
        ],
        generateMutationSet: [() => generateMutationSet(p.dir), p.link],
        alRunnerCoverageSupport: [() => alRunnerCoverageSupport(p.dir), p.link],
        discoverTests: [() => discoverTests(t.dir), t.link],
        readTestAppSources: [() => readTestAppSources(t.dir), t.link],
      };
      const got: Record<string, boolean> = {};
      for (const [name, [run, link]] of Object.entries(readers)) {
        const e = await refusalOf(run());
        got[name] = e instanceof ProjectSymlinkRefusedError && e.message.includes(link);
      }
      expect(got).toEqual(Object.fromEntries(Object.keys(readers).map((k) => [k, true])));
    });

    test("readTargetSource passes the refusal through, never as SourceSnapshotUnreadableError", async () => {
      const p = make();
      if (p === undefined) {
        console.log(`SKIPPED (EPERM): ${kind} pass-through`);
        return;
      }
      const e = await refusalOf(readTargetSource(p.dir));
      expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
      expect(e).not.toBeInstanceOf(SourceSnapshotUnreadableError);
    });
  });

describe("R631 r3 A: real AL under node_modules is still read, exactly as before", () => {
  test("targetAlFiles and discoverTests yield node_modules/pkg/*.al", async () => {
    await initParser();
    const base = scratch("lethal-r631-");
    put(base, "app/src/A.al", CODEUNIT);
    put(base, "app/node_modules/pkg/X.al", CODEUNIT.replace("50100", "50102"));
    expect(await targetAlFiles(join(base, "app"))).toContain(join("node_modules", "pkg", "X.al"));
    put(base, "tests/node_modules/pkg/T.al", TEST_CU);
    const found = await discoverTests(join(base, "tests"));
    expect(found.map((r) => r.method)).toEqual(["T"]);
  });
});

describe("R631: the test-app hash never covers a partial test tree", () => {
  function linkedHelper(): string {
    const base = scratch("lethal-r631-");
    put(base, "tests/T.al", TEST_CU);
    put(base, "helpers/H.al", CODEUNIT);
    symlinkSync(join(base, "helpers"), join(base, "tests", "helpers"), "junction");
    return join(base, "tests");
  }

  test("forced skip: testAppHashFor is undefined (do not reuse), and hashTestDir refuses", async () => {
    const tests = linkedHelper();
    expect(await testAppHashFor(undefined, tests, "skip")).toBeUndefined();
    await expect(hashTestDir(tests, "skip")).rejects.toBeInstanceOf(ProjectSymlinkRefusedError);
  });

  test("default (refuse): hashTestDir refuses the link by name", async () => {
    const tests = linkedHelper();
    const e = await refusalOf(hashTestDir(tests));
    expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((e as Error).message).toContain(join(tests, "helpers"));
  });

  test("control: the same tree without the link hashes", async () => {
    const base = scratch("lethal-r631-");
    put(base, "tests/T.al", TEST_CU);
    expect(await testAppHashFor(undefined, join(base, "tests"), "skip")).toStartWith("source:");
  });
});

describe("R631 r3 B: a link that appears mid-run is drift", () => {
  async function started(dir: string) {
    const watch = watchProjectInputs(dir, await readTargetSource(dir));
    await watch.check();
    return watch;
  }

  async function changesOf(watch: { check(): Promise<void> }): Promise<unknown> {
    return watch.check().then(
      () => null,
      (e: unknown) => e,
    );
  }

  test("a linked folder added after the start is `added link <rel>`, not ProjectSymlinkRefusedError", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "shared/S.al", CODEUNIT);
    const watch = await started(dir);
    symlinkSync(join(base, "shared"), join(dir, "shared"), "junction");
    const e = await changesOf(watch);
    expect(e).toBeInstanceOf(ProjectChangedDuringRunError);
    expect((e as ProjectChangedDuringRunError).changes).toEqual(["added link shared"]);
  });

  test("a linked .al file added after the start is `added link <rel>`", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "S.al", CODEUNIT);
    const watch = await started(dir);
    if (!fileLink(join(base, "S.al"), join(dir, "src", "S.al"))) return;
    const e = await changesOf(watch);
    expect(e).toBeInstanceOf(ProjectChangedDuringRunError);
    expect((e as ProjectChangedDuringRunError).changes).toEqual([
      `added link ${join("src", "S.al")}`,
    ]);
  });

  test("a link inside node_modules is excused: no drift", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "tool/x", "x");
    mkdirSync(join(dir, "node_modules"));
    const watch = await started(dir);
    symlinkSync(join(base, "tool"), join(dir, "node_modules", "tool"), "junction");
    expect(await changesOf(watch)).toBeNull();
  });
});

describe("R631: package caches", () => {
  test("a RELATIVE symlinked .app is copied from its real path: the copy's bytes equal the target's", async () => {
    const base = scratch("lethal-r631-");
    const cache = join(base, "cache");
    put(base, "store/Microsoft_System_1.0.0.0.app", "system-bytes");
    mkdirSync(cache);
    if (!fileLink(join("..", "store", "Microsoft_System_1.0.0.0.app"), join(cache, "Sys.app")))
      return;
    put(base, "control.app", "control");
    const root = join(base, "out");
    mkdirSync(root);
    const copy = await buildPackageCacheCopy(cache, join(base, "control.app"), root);
    expect(readFileSync(join(copy, "Sys.app"), "utf8")).toBe("system-bytes");
  });

  test("a linked SUBFOLDER of the package cache refuses by name", async () => {
    const base = scratch("lethal-r631-");
    const cache = join(base, "cache");
    put(cache, "A.app", "a");
    put(base, "more/B.app", "b");
    symlinkSync(join(base, "more"), join(cache, "more"), "junction");
    put(base, "control.app", "control");
    const root = join(base, "out");
    mkdirSync(root);
    const e = await refusalOf(buildPackageCacheCopy(cache, join(base, "control.app"), root));
    expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((e as Error).message).toContain(join(cache, "more"));
    // R636 N5: a cache-only walk's root IS the cache, so it keeps the name.
    expect((e as Error).message).toContain(`package cache ${cache}`);
  });

  // R636 N5: inside a project, the root is the project folder, and the cache is where the link sits.
  test("a linked subfolder of a project's .alpackages names the project folder, in its package cache", async () => {
    const base = scratch("lethal-r636-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(dir, ".alpackages/A.app", "a");
    put(base, "more/B.app", "b");
    symlinkSync(join(base, "more"), join(dir, ".alpackages", "more"), "junction");
    const e = await refusalOf(readTargetSource(dir));
    expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((e as Error).message).toContain(join(dir, ".alpackages", "more"));
    expect((e as Error).message).toContain(`project folder ${dir}, in its package cache`);
    expect((e as Error).message).not.toContain(`package cache ${dir}`);
  });
});

describe("R631 review L2: a link that appears mid-run is drift, never the tripwire", () => {
  test("the drift watch does not announce the new link to onSkippedLinks", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "shared/S.al", CODEUNIT);
    const watch = watchProjectInputs(dir, await readTargetSource(dir));
    await watch.check();
    symlinkSync(join(base, "shared"), join(dir, "shared"), "junction");
    const heard: string[] = [];
    const off = onSkippedLinks((_root, links) => heard.push(...links));
    try {
      const e = await refusalOf(watch.check());
      expect(e).toBeInstanceOf(ProjectChangedDuringRunError);
    } finally {
      off();
    }
    expect(heard).toEqual([]);
  });

  test("a junctioned .alpackages present at the start is not drift", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "symbols/Sys.app", "s");
    symlinkSync(join(base, "symbols"), join(dir, ".alpackages"), "junction");
    const watch = watchProjectInputs(dir, await readTargetSource(dir));
    await watch.check();
    expect(await refusalOf(watch.check())).toBeUndefined();
  });
});

describe("R631 review L3: a dangling .app link in the package cache warns", () => {
  test("danglingPackageWarning names the dangling link; a healthy cache is silent", () => {
    const base = scratch("lethal-r631-");
    const cache = join(base, "cache");
    put(cache, "Real.app", "r");
    expect(danglingPackageWarning(cache)).toBeUndefined();
    if (!fileLink(join(base, "gone.app"), join(cache, "Gone.app"))) return;
    expect(danglingPackageWarning(cache)).toContain(join(cache, "Gone.app"));
  });
});

describe("R631 review H1: configured package caches", () => {
  test("configuredPackageCaches reads bcdev and alRunnerV3 cache paths", () => {
    expect(
      configuredPackageCaches({
        bcdev: { packageCachePath: "a" },
        alRunnerV3: { packagesDir: "c" },
      }),
    ).toEqual(["a", "c"]);
    expect(configuredPackageCaches({})).toEqual([]);
  });

  test("the CLI config loader registers them: a junctioned configured cache runs only after the load", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "store/Sys.app", "s");
    symlinkSync(join(base, "store"), join(dir, "symbols"), "junction");
    const configPath = join(base, "lethal.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ bcdev: { packageCachePath: join(dir, "symbols") } }),
    );
    try {
      setPackageCacheDirs([]);
      expect(await refusalOf(refuseProjectLinks([dir]))).toBeInstanceOf(ProjectSymlinkRefusedError);
      await loadDryRunConfig(configPath, true);
      expect(await refusalOf(refuseProjectLinks([dir]))).toBeUndefined();
    } finally {
      setPackageCacheDirs([]);
    }
  });
});

/** Review r2 N1/N2: a cache link follows M1's rule; the drift watch uses the up-front rule. */
describe("R631 review r2: a cache link that reaches a .al refuses; the watch agrees with the start", () => {
  async function changesOf(watch: { check(): Promise<void> }): Promise<unknown> {
    return watch.check().then(
      () => null,
      (e: unknown) => e,
    );
  }

  test("a junctioned .alpackages holding a .al refuses up front, at the root and nested", async () => {
    for (const at of [".alpackages", join("src", "x", ".alpackages")]) {
      const base = scratch("lethal-r631-");
      const dir = join(base, "app");
      put(dir, "app.json", "{}");
      put(dir, "src/A.al", CODEUNIT);
      put(base, "foreign/B.al", CODEUNIT.replace("50100", "50101"));
      mkdirSync(join(dir, at, ".."), { recursive: true });
      symlinkSync(join(base, "foreign"), join(dir, at), "junction");
      const e = await refusalOf(readTargetSource(dir));
      expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
      expect((e as Error).message).toContain(join(dir, at));
      expect((e as Error).message).toContain("reaches a .al file");
    }
  });

  test("a configured cache of src with a linked .al file refuses up front", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "L.al", CODEUNIT.replace("50100", "50101"));
    if (!fileLink(join(base, "L.al"), join(dir, "src", "L.al"))) {
      console.log("SKIPPED (EPERM): configured cache linked .al");
      return;
    }
    try {
      setPackageCacheDirs([join(dir, "src")]);
      const e = await refusalOf(readTargetSource(dir));
      expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
      expect((e as Error).message).toContain(join(dir, "src", "L.al"));
      expect((e as Error).message).toContain("package cache");
      // R636 N5: the root named is the PROJECT folder, never called "the package cache".
      expect((e as Error).message).toContain(`project folder ${dir}, in its package cache`);
      expect((e as Error).message).not.toContain(`package cache ${dir}`);
    } finally {
      setPackageCacheDirs([]);
    }
  });

  test("a junctioned .alpackages holding only .app files runs, and the watch stays quiet", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "symbols/Sys.app", "s");
    put(base, "symbols/deeper/Base.app", "b");
    symlinkSync(join(base, "symbols"), join(dir, ".alpackages"), "junction");
    const watch = watchProjectInputs(dir, await readTargetSource(dir));
    expect(await changesOf(watch)).toBeNull();
    expect(await changesOf(watch)).toBeNull();
  });

  test("PHANTOM REMOVED: a .al the start took through a cache link is never reported as removed", async () => {
    // The r1 up-front walk admitted `.alpackages/B.al` through a junctioned cache; the r1 watch
    // (a "skip" walk) did not see it and stopped the run with `removed .alpackages/B.al`. The
    // snapshot is built by hand as r1 built it; the watch must name the LINK, never a removal.
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "app.json", "{}");
    put(dir, "src/A.al", CODEUNIT);
    put(base, "foreign/B.al", CODEUNIT);
    symlinkSync(join(base, "foreign"), join(dir, ".alpackages"), "junction");
    const snapshot = new Map<string, Buffer>([
      ["app.json", Buffer.from("{}")],
      [join("src", "A.al"), Buffer.from(CODEUNIT)],
      [join(".alpackages", "B.al"), Buffer.from(CODEUNIT)],
    ]);
    const e = await changesOf(watchProjectInputs(dir, snapshot));
    expect(e).toBeInstanceOf(ProjectChangedDuringRunError);
    expect((e as ProjectChangedDuringRunError).changes).toEqual(["added link .alpackages"]);
  });

  test("mid-run, an excused or cache link that reaches a .al is drift", async () => {
    for (const at of [join("node_modules", "lib"), ".alpackages"]) {
      const base = scratch("lethal-r631-");
      const dir = join(base, "app");
      put(dir, "app.json", "{}");
      put(dir, "src/A.al", CODEUNIT);
      put(base, "shared/S.al", CODEUNIT);
      mkdirSync(join(dir, at, ".."), { recursive: true });
      const watch = watchProjectInputs(dir, await readTargetSource(dir));
      expect(await changesOf(watch)).toBeNull();
      symlinkSync(join(base, "shared"), join(dir, at), "junction");
      const e = await changesOf(watch);
      expect(e).toBeInstanceOf(ProjectChangedDuringRunError);
      expect((e as ProjectChangedDuringRunError).changes).toEqual([`added link ${at}`]);
    }
  });
});

/** Review r2 N3: one visited set per walk. R636: a folder-count cut-off that refuses, not depth. */
describe("R631 review r2 N3: the reaches-a-.al scan", () => {
  function chain(root: string, depth: number): void {
    const parts = Array.from({ length: depth }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...parts), { recursive: true });
    writeFileSync(join(root, ...parts, "x.app"), "x");
  }

  /** A project whose `node_modules/<name>` links to `target`. */
  function linkedFrom(base: string, target: string, name = "deep"): string {
    const dir = join(base, "app");
    put(dir, "src/A.al", CODEUNIT);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(target, join(dir, "node_modules", name), "junction");
    return dir;
  }

  /** R636: `fn` with the folder cap lowered to `max`, restored whatever happens. */
  async function withFolderCap<T>(max: number, fn: () => Promise<T>): Promise<T> {
    const saved = reachLimits.maxFolders;
    reachLimits.maxFolders = max;
    try {
      return await fn();
    } finally {
      reachLimits.maxFolders = saved;
    }
  }

  // R636 test 3a: the cap counts FOLDERS, not depth, so a flat tree past it refuses and one within
  // it passes. Revert (depth counting, or no cap check): the flat 12-folder tree is admitted.
  test("R636: a linked tree of more folders than the cap refuses (the cut-off never admits); one within it passes", async () => {
    for (const [width, refuses] of [
      [12, true],
      [8, false],
    ] as const) {
      const base = scratch("lethal-r636-");
      for (let i = 0; i < width; i++) put(base, join("wide", `s${i}`, "x.app"), "x");
      const dir = linkedFrom(base, join(base, "wide"));
      const e = await withFolderCap(10, () => refusalOf(refuseProjectLinks([dir])));
      if (refuses) {
        expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
        expect((e as Error).message).toContain("could not prove it reaches no .al file");
        expect((e as Error).message).toContain("more than 10 folders");
      } else expect(e).toBeUndefined();
    }
  });

  // R640: the budget is the WALK's, shared by every link, so the refusal must not say the link it
  // names holds the excess. Two links of 6 folders each pass a cap of 10 only together. Revert (the
  // old "it holds more than N folders"): the second link, holding 6, is blamed for more than 10.
  test("R640: the cap refusal names the walk-wide budget, not the link that was being scanned", async () => {
    const base = scratch("lethal-r640-");
    for (const side of ["one", "two"])
      for (let i = 0; i < 5; i++) put(base, join(side, `s${i}`, "x.app"), "x");
    const dir = join(base, "app");
    put(dir, "src/A.al", CODEUNIT);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(base, "one"), join(dir, "node_modules", "one"), "junction");
    symlinkSync(join(base, "two"), join(dir, "node_modules", "two"), "junction");
    const e = await withFolderCap(10, () => refusalOf(refuseProjectLinks([dir])));
    expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
    const message = (e as Error).message;
    expect(message).toContain("more than 10 folders in all");
    expect(message).toContain("the limit was reached while scanning this one");
    expect(message).not.toContain("it holds more than");
  });

  // R636 test 3b: depth alone never refuses. Revert (a depth cap of 32): refused.
  test("R636: a 40-deep real folder chain behind a link is admitted at the default cap", async () => {
    const base = scratch("lethal-r636-");
    chain(join(base, "deep"), 40);
    const dir = linkedFrom(base, join(base, "deep"));
    expect(await refusalOf(refuseProjectLinks([dir]))).toBeUndefined();
  });

  // R636 test 1: a pnpm-style chain of 20 linked packages with no `.al` (the shape of the
  // R-630 chain probe): each link costs two depth steps, so a depth cap of 32 refused it.
  test("R636: a 20-link pnpm chain with no .al is admitted at the default cap", async () => {
    const root = scratch("lethal-r636-");
    put(root, "app.json", "{}");
    put(root, "src/A.al", CODEUNIT);
    const store = join(root, "node_modules", ".pnpm");
    const links = 20;
    for (let i = 0; i < links; i++) {
      mkdirSync(join(store, `p${i}`, "node_modules"), { recursive: true });
      writeFileSync(join(store, `p${i}`, "index.js"), "");
    }
    symlinkSync(join(store, "p0"), join(root, "node_modules", "p0"), "junction");
    for (let i = 0; i + 1 < links; i++)
      symlinkSync(
        join(store, `p${i + 1}`),
        join(store, `p${i}`, "node_modules", `p${i + 1}`),
        "junction",
      );
    expect(await refusalOf(refuseProjectLinks([root]))).toBeUndefined();
  });

  // R636 test 2: the visited set, not the cap, ends a link cycle. Revert (drop the visited set):
  // the cycle runs to the folder cap and refuses, so the no-.al case goes red (bounded by the
  // test's own timeout).
  test(
    "R636: a 2-link cycle with no .al finishes, admitted, in 2 folders; the same cycle holding a .al refuses",
    async () => {
      for (const withAl of [false, true]) {
        const cyc = scratch("lethal-r636-");
        put(cyc, "src/A.al", CODEUNIT);
        mkdirSync(join(cyc, "node_modules", "a"), { recursive: true });
        mkdirSync(join(cyc, "node_modules", "b"), { recursive: true });
        if (withAl) put(cyc, join("node_modules", "b", "B.al"), CODEUNIT);
        symlinkSync(
          join(cyc, "node_modules", "b"),
          join(cyc, "node_modules", "a", "to-b"),
          "junction",
        );
        symlinkSync(
          join(cyc, "node_modules", "a"),
          join(cyc, "node_modules", "b", "to-a"),
          "junction",
        );
        const before = reachStats.foldersScanned;
        const e = await refusalOf(refuseProjectLinks([cyc]));
        if (withAl) {
          expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
          expect((e as Error).message).toContain("reaches a .al file");
        } else {
          expect(e).toBeUndefined();
          expect(reachStats.foldersScanned - before).toBe(2);
        }
      }
    },
    ownTimeout(20_000),
  );

  test("many links to one store scan each store folder once per walk", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "app");
    put(dir, "src/A.al", CODEUNIT);
    chain(join(base, "store"), 4); // store, d0..d3: 5 real folders
    mkdirSync(join(dir, "node_modules"));
    for (let i = 0; i < 10; i++)
      symlinkSync(join(base, "store"), join(dir, "node_modules", `p${i}`), "junction");
    const before = reachStats.foldersScanned;
    expect(await refusalOf(refuseProjectLinks([dir]))).toBeUndefined();
    expect(reachStats.foldersScanned - before).toBe(5);
  });
});
