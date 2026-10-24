import { describe, expect, spyOn, test } from "bun:test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AlRunnerCoverageIndex,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import type { ServerPerTestCoverage } from "../src/al-runner-server";
import { scratchDirs } from "./helpers/scratch";

/**
 * R383/R407: what the coverage-frame rules separate, on al-runner's REAL `--server` output for
 * LethAL's instrumented `MultiPair.Codeunit.al` (two codeunits, `Multi A` on lines 1-24, `Multi B`
 * on 26-76). The kept al-runner coverage index applies these rules to `perTestCoverage`.
 *
 * NEGATIVE evidence, v2.12.0-main.c39ad5de (`server-reached-both-ways.json`,
 * `server-calls-never.json`): al-runner labelled coverage with the SOURCE path and reported every
 * `Multi B` line 17 lines early. Through an admitted index the source label STOPS the session
 * (`AlRunnerCoverageFrameError`), and had the label been right the scope would still contradict
 * the position.
 *
 * POSITIVE evidence, v2.12.0-main.43f76177 (`server-43f76177.json`): the same layout, every object
 * in the instrumented frame, labelled inside the bundle, so every hit resolves to its true owner.
 *
 * R654 S3 removed this file's one-shot Cobertura half (`parseCobertura`, `alRunnerCoverageFrom`)
 * with the .NET al-runner; the `cobertura-*.xml` captures stay in the fixture folder as the
 * evidence R383 and R407 cite.
 */

const DIR = join(import.meta.dir, "fixtures", "r383-real-frame");
const PAIR = "MultiPair.Codeunit.al";
const A = 79800;
const B = 79801;
const scratch = scratchDirs();

/** The measured layout, and an admitted index over its bundle. */
async function layout(): Promise<{ root: string; index: AlRunnerCoverageIndex }> {
  const root = scratch("lethal-r407-real-frame-");
  const bundle = join(root, "inst", "active");
  await mkdir(bundle, { recursive: true });
  await copyFile(join(DIR, PAIR), join(bundle, PAIR));
  const index = await buildAlRunnerCoverageIndex(bundle, { labelBase: root });
  return { root, index };
}
const show = (entries: readonly { objectId: number; procedure?: string; line?: number }[]) =>
  entries.map((e) => `${e.objectId} ${e.procedure ?? "-"} ${e.line ?? "-"}`);
const serverOf = async (name: string) =>
  JSON.parse(await readFile(join(DIR, name), "utf8")) as ServerPerTestCoverage;
/** The 43f76177 daemon payload for one test, its `<scratch>/work` prefix re-rooted at `root`. */
async function server43(test: string, root: string): Promise<ServerPerTestCoverage> {
  const all = JSON.parse(await readFile(join(DIR, "server-43f76177.json"), "utf8")) as {
    perTestCoverage: ServerPerTestCoverage[];
  };
  const entry = all.perTestCoverage.find((p) => p.test === test);
  if (entry === undefined) throw new Error(`no 43f76177 server entry for ${test}`);
  return {
    ...entry,
    coverage: (entry.coverage ?? []).map((f) => ({
      ...f,
      file: f.file.replace("<scratch>/work", root),
    })),
  };
}

describe("R383/R407: c39ad5de's real frame (negative evidence)", () => {
  test("R407: the SOURCE label stops the session, for both tests", async () => {
    const { index } = await layout();
    for (const name of ["server-reached-both-ways.json", "server-calls-never.json"]) {
      const payload = await serverOf(name);
      expect(() => alRunnerCoverageFromServer(payload, index)).toThrow(
        `as "fixtures/sandbox-multiobject/src/${PAIR}", which is outside the bundle`,
      );
    }
  });

  test("had only the label been right, --server would still stop: scope Reached at a line inside Never", async () => {
    const { root, index } = await layout();
    const payload = await serverOf("server-reached-both-ways.json");
    const relabelled: ServerPerTestCoverage = {
      ...payload,
      coverage: (payload.coverage ?? []).map((f) => ({
        ...f,
        file: join(root, "inst", "active", PAIR),
      })),
    };
    expect(() => alRunnerCoverageFromServer(relabelled, index)).toThrow(
      `${PAIR}:16 "Reached", but that line is inside "Never", in a multi-object file`,
    );
  });

  test("MAPPER test (synthetic, not evidence): a hit placed on A's line 20 resolves to exactly Multi A.Never 20", async () => {
    // The server statement is invented: this pins the mapper's arithmetic.
    const { root, index } = await layout();
    const exact = [{ objectType: "Codeunit", objectId: A, procedure: "Never", line: 20 }];
    const one: ServerPerTestCoverage = {
      test: "Codeunit79850.ReachedBothWays",
      coverage: [
        {
          file: join(root, "inst", "active", PAIR),
          statements: [{ scope: "Never", line: 20, hits: 1 }],
        },
      ],
    };
    expect(alRunnerCoverageFromServer(one, index).entries).toEqual(exact);
  });
});

describe("R407: 43f76177's real frame (positive evidence, the same layout)", () => {
  test("ReachedBothWays resolves to Multi B.Reached only, at its true lines", async () => {
    const { root, index } = await layout();
    const exact = [9, 11, 16, 21, 26, 33, 34, 35].map((line) => `${B} Reached ${line}`);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = await server43("Codeunit79850.ReachedBothWays", root);
      expect(show(alRunnerCoverageFromServer(server, index).entries)).toEqual(exact);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("CallsNever resolves to Multi A.Never only, at 8, 10, 14 and 20", async () => {
    const { root, index } = await layout();
    const exact = [8, 10, 14, 20].map((line) => `${A} Never ${line}`);
    const server = await server43("Codeunit79850.CallsNever", root);
    expect(show(alRunnerCoverageFromServer(server, index).entries)).toEqual(exact);
  });
});
