import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { describeAlRunnerCache, readAlRunnerCache } from "../src/al-runner-cache";
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
  REACH_DEPTH_CAP,
  onSkippedLinks,
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
    expect((e as Error).message).toContain("package cache");
  });
});

describe("R631: doctor's al-runner cache size", () => {
  test("a linked folder is not followed, not counted, and the count is said", async () => {
    const base = scratch("lethal-r631-");
    const dir = join(base, "artifacts");
    put(dir, "28.0.1.1/a.app", "x".repeat(100));
    put(base, "install/big.dll", "y".repeat(5000));
    symlinkSync(join(base, "install"), join(dir, "28.0.1.1", "shadow"), "junction");
    const report = await readAlRunnerCache(dir, join(base, "no-secondary"));
    expect(report.totalBytes).toBe(100);
    expect(report.skippedLinks).toBe(1);
    expect(describeAlRunnerCache(report)).toContain("1 link(s) in these caches were not followed");
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
  test("configuredPackageCaches reads bcdev, alRunner and alRunnerV3 cache paths", () => {
    expect(
      configuredPackageCaches({
        bcdev: { packageCachePath: "a" },
        alRunner: { packagesDir: "b" },
        alRunnerV3: { packagesDir: "c" },
      }),
    ).toEqual(["a", "b", "c"]);
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

/** Review r2 N3: one visited set per walk, and a depth cut-off that refuses. */
describe("R631 review r2 N3: the reaches-a-.al scan", () => {
  function chain(root: string, depth: number): void {
    const parts = Array.from({ length: depth }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...parts), { recursive: true });
    writeFileSync(join(root, ...parts, "x.app"), "x");
  }

  test("a link deeper than the cap refuses (the cut-off never admits); one within it passes", async () => {
    for (const [depth, refuses] of [
      [REACH_DEPTH_CAP + 2, true],
      [REACH_DEPTH_CAP - 2, false],
    ] as const) {
      const base = scratch("lethal-r631-");
      const dir = join(base, "app");
      put(dir, "src/A.al", CODEUNIT);
      chain(join(base, "deep"), depth);
      mkdirSync(join(dir, "node_modules"));
      symlinkSync(join(base, "deep"), join(dir, "node_modules", "deep"), "junction");
      const e = await refusalOf(refuseProjectLinks([dir]));
      if (refuses) {
        expect(e).toBeInstanceOf(ProjectSymlinkRefusedError);
        expect((e as Error).message).toContain("could not prove it reaches no .al file");
      } else expect(e).toBeUndefined();
    }
  });

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
