// PR-448 (R1224): R590's event-loop turn must not depend on other timers. `yieldTurn` ends on setImmediate OR a 0 ms
// timer, whichever fires first. In Bun 1.4.4, setImmediate alone on a loop with no I/O due waited for an unrelated timer
// (measured up to 895 ms in a test rig, /coord/handoff/PR-448/measure.md). The stalls are modelled here by starving one
// primitive (a stub that never calls back), so each test is deterministic: a starved primitive is not waited for.
import { afterEach, describe, expect, test } from "bun:test";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { yieldTurn } from "../src/al-runner-v3-backend";

const realImmediate = globalThis.setImmediate;
const realClearImmediate = globalThis.clearImmediate;
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
afterEach(() => {
  globalThis.setImmediate = realImmediate;
  globalThis.clearImmediate = realClearImmediate;
  globalThis.setTimeout = realTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

/** Whether `p` settles before `n` turns of the REAL immediate queue (no wall clock). */
async function settlesWithin(p: Promise<void>, n: number): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let i = 0; i < n && !done; i++) await new Promise<void>((r) => realImmediate(r));
  return done;
}

describe("PR-448 (R1224): the yield R590 takes before reading stderr", () => {
  // Red: make yieldTurn wait on setImmediate alone (today's `new Promise((r) => setImmediate(r))`): it never settles.
  test("a starved setImmediate does not stall it: the 0 ms timer ends the turn", async () => {
    globalThis.setImmediate = (() => 0) as unknown as typeof setImmediate;
    globalThis.clearImmediate = (() => {}) as typeof clearImmediate;
    const p = yieldTurn();
    globalThis.setImmediate = realImmediate;
    // the 0 ms timer comes due on its own: awaited directly, so a yield that waits on setImmediate never settles and the
    // test times out (red), with no wall-clock assertion
    await p;
    expect(true).toBe(true);
  }, ownTimeout(2000));

  // Red: make yieldTurn wait on the 0 ms timer alone: it never settles.
  test("a starved timer does not stall it either: setImmediate ends the turn", async () => {
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    expect(await settlesWithin(yieldTurn(), 5)).toBe(true);
  });

  // Red: resolve yieldTurn synchronously (or by a microtask): an immediate queued before it has not run yet.
  test("it is a real turn: an immediate queued before it has run when it ends", async () => {
    let ran = false;
    realImmediate(() => {
      ran = true;
    });
    await yieldTurn();
    expect(ran).toBe(true);
  });

  // Red: leave the loser scheduled (drop the clears): a later turn finds the other callback still pending.
  test("the primitive that loses is cleared (nothing left behind)", async () => {
    const cleared: string[] = [];
    globalThis.clearImmediate = ((h: unknown) => {
      cleared.push("immediate");
      realClearImmediate(h as Parameters<typeof clearImmediate>[0]);
    }) as typeof clearImmediate;
    globalThis.clearTimeout = ((h: unknown) => {
      cleared.push("timeout");
      realClearTimeout(h as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout;
    await yieldTurn();
    expect(cleared.sort()).toEqual(["immediate", "timeout"]);
  });
});
