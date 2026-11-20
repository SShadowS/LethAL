import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import {
  SLIM_LEFT_OUT,
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
} from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * PR-209, spec 0a item 7 and the build brief: `--profile slim` is the OLD default set, compared by
 * KEY SET (never by count) on every fixture a gate uses.
 *
 * The old default's keys are the frozen baselines' `key` fields: each baseline was recorded by a run
 * that did not walk `condition-true` or `blank-argument`. Once a baseline is re-recorded under the
 * new default it carries rows of those two operators too; those rows are set aside here (the
 * operator is the 4th part of a key), and what is left must still equal slim's keys.
 *
 * Also: the default run's keys are slim's plus rows of the two operators ONLY, so nothing else moved
 * (an existing key neither appears nor disappears).
 */
const ITEST = join(import.meta.dir, "../itest");
const ROOT = join(import.meta.dir, "../../..");

interface Leg {
  readonly baseline: string;
  readonly project: string;
  readonly symbols?: readonly string[];
}

const LEGS: readonly Leg[] = [
  { baseline: "bcdev.baseline.json", project: "fixtures/sandbox-app" },
  { baseline: "bcdev.names.baseline.json", project: "fixtures/sandbox-names" },
  {
    baseline: "bcdev.wrapped.baseline.json",
    project: "fixtures/sandbox-wrapped",
    symbols: ["WRAPDEF"],
  },
  {
    baseline: "al-runner-v3.wrapped.baseline.json",
    project: "fixtures/sandbox-wrapped",
    symbols: ["WRAPDEF"],
  },
  { baseline: "tables.baseline.json", project: "fixtures/sandbox-data" },
  { baseline: "hang.single.baseline.json", project: "fixtures/sandbox-hang" },
  { baseline: "harden.baseline.json", project: "fixtures/sandbox-harden" },
  { baseline: "al-runner-v3.layout.baseline.json", project: "fixtures/sandbox-layout" },
  { baseline: "al-runner-v3.multiobject.baseline.json", project: "fixtures/sandbox-multiobject" },
  { baseline: "al-runner-v3.recheck.baseline.json", project: "fixtures/sandbox-recheck" },
  {
    baseline: "al-runner-v3.symbols-lethala.baseline.json",
    project: "fixtures/sandbox-symbols",
    symbols: ["LETHALA"],
  },
  {
    baseline: "al-runner-v3.symbols-lethalb.baseline.json",
    project: "fixtures/sandbox-symbols",
    symbols: ["LETHALB"],
  },
];

const isTwo = (key: string): boolean => SLIM_LEFT_OUT.includes(key.split("|")[3] ?? "");

async function keysOf(
  project: string,
  symbols: readonly string[] | undefined,
  slim: boolean,
): Promise<Set<string>> {
  const set = await generateMutationSet(join(ROOT, project), {
    backend: { kind: "bcdev" },
    ...(symbols !== undefined ? { preprocessorSymbols: symbols } : {}),
    ...(slim ? { excludeOperators: [...SLIM_LEFT_OUT], profile: "slim" as const } : {}),
  });
  const appId: string =
    JSON.parse(readFileSync(join(ROOT, project, "app.json"), "utf8")).id ??
    "00000000-0000-0000-0000-000000000000";
  const out = await mkdtemp(join(tmpdir(), "pr209-slim-"));
  try {
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: appId,
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set as never),
    });
    const m = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8"));
    return new Set((m.mutants as never[]).map((r) => serializeKey(identityKeyOf(r))));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const diff = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((k) => !b.has(k)).sort();

describe("PR-209: slim's identity keys are the pre-flip default's, by key set", () => {
  for (const leg of LEGS) {
    test(`${leg.project} ${leg.baseline}`, async () => {
      const path = join(ITEST, leg.baseline);
      expect(existsSync(path), `${leg.baseline} must exist`).toBe(true);
      const file = JSON.parse(readFileSync(path, "utf8"));
      const rows: { key: string }[] = Array.isArray(file) ? file : file.entries;
      const frozen = new Set(rows.map((r) => r.key).filter((k) => !isTwo(k)));

      const slim = await keysOf(leg.project, leg.symbols, true);
      expect(diff(frozen, slim)).toEqual([]);
      expect(diff(slim, frozen)).toEqual([]);

      const full = await keysOf(leg.project, leg.symbols, false);
      // Nothing an old run had is gone, and the only new keys are the two operators' rows.
      expect(diff(slim, full)).toEqual([]);
      expect(diff(full, slim).filter((k) => !isTwo(k))).toEqual([]);
    }, 240_000);
  }
});
