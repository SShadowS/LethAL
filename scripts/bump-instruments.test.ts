import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * `probe-fixture-hashes.ts` is `census-fixture-mutants.ts` plus an identity hash, and it has to
 * STAY that way.
 *
 * The hash probe's whole value is that it replicates the real planning pipeline exactly: targets ->
 * generate -> validateSpec -> isMutableSite -> dedupeSpecs -> canCarryMutationSelectorVar. When a
 * grammar bump asks "did any mutant's identity move", an answer computed by a near-copy of that
 * pipeline is worth nothing, and the failure is silent: a probe that quietly drops a filter reports
 * hashes for specs that never deploy, and they all match, and the bump looks clean.
 *
 * That is not hypothetical. The first attempt at this probe was written from scratch, got
 * `validateSpec`'s signature wrong, and would have needed its own debugging to trust. It was thrown
 * away and the probe re-derived from the census by adding one line. This test is what keeps it
 * derived: edit the census's pipeline and the probe follows, or this fails and someone decides.
 *
 * See [[R218]] for what a wrong bump instrument costs, and `packages/engine/vendor/README.md` for
 * the procedure both scripts serve.
 */
describe("the grammar-bump instruments", () => {
  test("probe-fixture-hashes differs from census-fixture-mutants ONLY by the hash", async () => {
    const [census, probe] = await Promise.all([
      readFile("scripts/census-fixture-mutants.ts", "utf8"),
      readFile("scripts/probe-fixture-hashes.ts", "utf8"),
    ]);

    // Comments are allowed to differ: each explains its own job, and the probe's header explains
    // why it is a derivation at all. Everything that RUNS must be identical bar the two additions.
    const code = (src: string): string[] =>
      src
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
        );

    const a = code(census);
    const b = code(probe);

    const onlyCensus = a.filter((l) => !b.includes(l));
    const onlyProbe = b.filter((l) => !a.includes(l));

    // The census's display line is replaced, so it is the one line that leaves.
    expect(onlyCensus).toEqual([
      '`${rel}:${lineOf(source, s.before.startIndex)} ${s.operatorName} | ${s.before.text.replace(/\\n/g, "\\\\n")} => ${after}${mark}`,',
    ]);

    // And exactly two lines arrive: the import and the same display line carrying the hash.
    expect(onlyProbe).toEqual([
      'import { astSubtreeHash } from "../packages/engine/src/ast/hash";',
      '`${rel}:${lineOf(source, s.before.startIndex)} ${s.operatorName} | astHash=${astSubtreeHash(s.before)} | ${s.before.text.replace(/\\n/g, "\\\\n")} => ${after}${mark}`,',
    ]);
  });

  test("census-operator-sites sorts its file list, which R218 made load-bearing", async () => {
    const src = await readFile("scripts/census-operator-sites.ts", "utf8");
    // Unsorted `readdir` let file order reach `enumValuesOf`, so a multi-extension enum merged its
    // members in visit order and `swap-enum-member`'s wrapping choice varied BETWEEN RUNS OF THE
    // SAME GRAMMAR: 19 spurious rows on BaseApp, in the instrument a bump's proof depends on.
    expect(src).toContain(".sort()");
    const readdirCall = src.slice(src.indexOf("readdir(projectDir"));
    const sortWithin = readdirCall.slice(0, readdirCall.indexOf(";"));
    expect(sortWithin).toContain(".sort()");
  });
});
