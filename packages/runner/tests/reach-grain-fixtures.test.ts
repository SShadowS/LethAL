import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

/**
 * GH-24. `reachGrainOf` claims it never throws on a shape the operators emit and that only
 * `statement` grain gets a marker. This makes that a checked claim over every fixture: the real
 * mutation set with the default operators (the path `lethal run` and `compile-only.ts` take),
 * instrumented for real.
 *
 * An `unplaced` entry FAILS: it is a shape no placement rule covers, and the answer is a rule and a
 * compile case, not a silent fallback.
 */
const REPO = resolve(import.meta.dir, "../../..");
const PROJECTS = [
  "fixtures/sandbox-app",
  "fixtures/sandbox-data",
  "fixtures/sandbox-hang",
  "fixtures/sandbox-symbols",
  "examples/gift-card",
  "examples/credit-limit",
];

describe("GH-24: reach grain over every fixture", () => {
  test("GH-24: every fixture mutant gets a grain, and only statement grain gets a marker", async () => {
    for (const rel of PROJECTS) {
      // R214: a project with a symbol-sets.json is checked once per build it lists.
      const setsPath = join(REPO, rel, "symbol-sets.json");
      const sets: readonly (readonly string[])[] = existsSync(setsPath)
        ? (JSON.parse(await readFile(setsPath, "utf8")) as string[][])
        : [[]];
      for (const symbols of sets) {
        const label = `[${symbols.join(",")}]`;
        const set = await generateMutationSet(join(REPO, rel), { preprocessorSymbols: symbols });
        const dir = await mkdtemp(join(tmpdir(), "lethal-grain-enum-"));
        try {
          await writeInstrumentedProject({
            targetDir: dir,
            files: set.files,
            identityOrdinals: identityOrdinalsOf(set),
            selectorIds: { selectorId: 79997, controlId: 79998, tableId: 79999 },
            artifactId: "0123456789abcdef0123456789abcdef",
            targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
            operatorTiers,
          });
          const manifest = JSON.parse(
            await readFile(join(dir, "mutant-manifest.json"), "utf8"),
          ) as MutantManifest;
          expect(manifest.mutants.length).toBeGreaterThan(0);

          const counts = { statement: 0, enclosing: 0, unplaced: 0 };
          const unplaced: string[] = [];
          for (const m of manifest.mutants) {
            const grain = m.reachGrain;
            // Optional on the type only so pre-GH-24 streams validate; a fresh compile always writes it.
            if (grain === undefined) throw new Error(`${rel} ${m.mutantId}: no reachGrain`);
            counts[grain] += 1;
            if (grain === "unplaced") {
              const s = set.files
                .find((f) => f.path === m.file)
                ?.specs.find(
                  (x) =>
                    x.operatorName === m.operatorName &&
                    x.before.startIndex === m.startIndex &&
                    x.before.endIndex === m.endIndex,
                );
              unplaced.push(
                `${rel} ${label} ${m.mutantId} ${m.operatorName} node=${s?.before.kind} parent=${s?.before.parent?.rawKind} at ${m.file}:${m.startLine}`,
              );
            }
          }
          console.log(
            `[GH-24 grain] ${rel} ${label}: ${JSON.stringify(counts)} over ${manifest.mutants.length}`,
          );
          expect(unplaced).toEqual([]);

          // Marker count equals statement count, and each statement mutant's marker is present once.
          let text = "";
          for (const name of await readdir(dir)) {
            if (name.endsWith(".al")) text += await readFile(join(dir, name), "utf8");
          }
          // R470: a reportextension's selector is `MutationSelector<id>` (suffixed if taken).
          const markers =
            text.match(/MutationSelector(?:\d+(?:_\d+)?)?\.Reached\('M\d+'\);/g) ?? [];
          expect(markers.length).toBe(counts.statement);
          for (const m of manifest.mutants) {
            // R470: by the mutant's own `Reached` call, whatever its object's selector is named.
            const n = text.split(`.Reached('${m.mutantId}');`).length - 1;
            expect(`${m.mutantId}:${n}`).toBe(
              `${m.mutantId}:${m.reachGrain === "statement" ? 1 : 0}`,
            );
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);
});
