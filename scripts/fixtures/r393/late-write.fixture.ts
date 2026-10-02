/**
 * R393 inert fixture. NOT a test here: the name has no `.test`, so `bun test` does not discover it.
 * `scripts/snapshot-late-write.test.ts` copies it into a temp folder as `late.test.ts` and runs it
 * with `bun test --timeout 200`.
 *
 * Test A sleeps past the timeout, so bun reports it as timed out and moves on to B. A keeps running,
 * and its late `toMatchSnapshot()` is filed under the name of the test running then: B. B has no
 * snapshot of its own. Env: MARK = file to append markers to, VAL = the value A snapshots.
 *
 * R406: B must still be the RUNNING test when A's late call lands. B used to sleep 700 ms under the
 * 200 ms timeout, so B timed out itself at about 400 ms, the moment A's late call fired. When B's
 * timeout won that race, no test was current and bun refused the matcher with "Snapshot matchers
 * are not supported in concurrent tests" (measured: 2 of 10 runs with A's sleep at 411 to 414 ms).
 * So B has its own long timeout and waits for A's late call to signal that it is done. Only A uses
 * the 200 ms timeout. The 5 s cap ends B if the late call never comes, so a broken fixture fails
 * the control rather than hanging. A sleeps 1000 ms, far past the moment B would time out without
 * its own timeout, so dropping that timeout fails every case instead of reopening the race.
 */
import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = (s: string) => appendFileSync(process.env.MARK ?? "marker.log", `${s}\n`);

let lateDone: () => void = () => {};
const lateCall = new Promise<void>((r) => {
  lateDone = r;
});

test("A slow snapshot", async () => {
  await sleep(1000);
  mark(`A late call reached; CI=${process.env.CI}`);
  try {
    expect({ from: process.env.VAL ?? "A" }).toMatchSnapshot();
    mark("A late toMatchSnapshot returned OK");
  } catch (e) {
    mark(`A late toMatchSnapshot THREW: ${String((e as Error).message)}`);
    throw e;
  } finally {
    lateDone();
  }
});

test("B has no snapshot", async () => {
  await Promise.race([lateCall, sleep(5000)]);
}, 10_000);
