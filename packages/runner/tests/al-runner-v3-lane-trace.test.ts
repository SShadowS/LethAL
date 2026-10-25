// R766 step (a): the trace of one scripted serve-entries session through AlRunnerV3Backend must not
// move when per-daemon state is regrouped into a `Lane`. The expected value is the committed JSON
// beside this file (not a bun snapshot). It covers: warm-up, one prefetch with an R612 cut and
// re-send on a new daemon, coverage windows, a kill pair (clean, M-echo cut, NONE-echo cut), a
// [v3-codeunit-state-possible] note, the batchBlind latch, and the entriesRefused latch.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runV3LaneTrace } from "./helpers/v3-lane-trace";

test("the scripted session's requests, closes, stats and verdicts equal the committed trace", async () => {
  const expected: unknown = JSON.parse(
    await readFile(join(import.meta.dir, "v3-lane-trace.expected.json"), "utf8"),
  );
  const got: unknown = JSON.parse(JSON.stringify(await runV3LaneTrace()));
  expect(got).toEqual(expected);
});
