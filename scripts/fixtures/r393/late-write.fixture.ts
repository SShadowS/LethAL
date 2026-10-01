/**
 * R393 inert fixture. NOT a test here: the name has no `.test`, so `bun test` does not discover it.
 * `scripts/snapshot-late-write.test.ts` copies it into a temp folder as `late.test.ts` and runs it
 * with `bun test --timeout 200`.
 *
 * Test A sleeps past the timeout, so bun reports it as timed out and moves on to B. A keeps running,
 * and its late `toMatchSnapshot()` is filed under the name of the test running then: B. B has no
 * snapshot of its own. Env: MARK = file to append markers to, VAL = the value A snapshots.
 */
import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = (s: string) => appendFileSync(process.env.MARK ?? "marker.log", `${s}\n`);

test("A slow snapshot", async () => {
  await sleep(400);
  mark(`A late call reached; CI=${process.env.CI}`);
  try {
    expect({ from: process.env.VAL ?? "A" }).toMatchSnapshot();
    mark("A late toMatchSnapshot returned OK");
  } catch (e) {
    mark(`A late toMatchSnapshot THREW: ${String((e as Error).message)}`);
    throw e;
  }
});

test("B has no snapshot", async () => {
  await sleep(700);
});
