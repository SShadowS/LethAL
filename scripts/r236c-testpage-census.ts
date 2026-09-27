// R-236c census: on each corpus, how many discovered tests the TestPage scan refuses, and whether
// any loud error fires. Run BEFORE the wiring lands. Prints names and counts only, never source.
// Relative, not "@lethal/engine": scripts/ is outside the workspaces, so the alias does not
// resolve here (same reason measure-gui-guarded.ts imports by path).
import { initParser } from "../packages/engine/src/index";
import { discoverTests } from "../packages/runner/src/discovery";
import { analyzeTestPageSources, readTestAppSources } from "../packages/runner/src/testpage-scan";

await initParser();
for (const dir of process.argv.slice(2)) {
  const started = Date.now();
  try {
    const tests = await discoverTests(dir);
    const files = await readTestAppSources(dir);
    const { refused, errors } = analyzeTestPageSources(files, tests);
    console.log(
      JSON.stringify({
        corpus: dir,
        files: files.length,
        tests: tests.length,
        refused: refused.size,
        loudErrors: errors.length,
        firstErrors: errors.slice(0, 20),
        ms: Date.now() - started,
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ corpus: dir, threw: e instanceof Error ? e.message : String(e) }));
  }
}
