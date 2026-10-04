# R-428 plan

Facts (see measurements.md): the file has no hooks of its own; slow work is in the test bodies (mkdtemp + two cp of
a 2.8 KB, 6-file fixture pair). Alone 0.75 s for all 22 tests; under a concurrent verify 0.8-1.0 s; worst test 0.11 s.
Not reproducible at 5 s here, so the 5 s stalls are whole-process starvation. Bun does not cancel a timed-out test or
hook: it keeps running, so its mkdtemp/cp can land after afterAll's rm. That is the leak.

1. Cleanup that survives a timeout. Replace the local `roots` array with R358's `scratchDirs()` helper (tests/helpers/scratch.ts)
   or keep `roots`, and add an in-flight set: `makeSymbolsProject` registers its promise; `afterAll` first
   `await Promise.allSettled(inflight)`, then rm each root, then sweeps `lethal-r214-hist-*` in tmpdir() once more
   (the preload redirects tmpdir to a private dir, so the sweep cannot touch another session). The dir name is recorded
   right after mkdtemp, before cp. afterEach is not needed: bun runs it after a timed-out hook, but the leak comes
   from work finishing later, which only an awaiting afterAll catches.
2. Cheaper setup: not worth it (2.8 KB copy, ~5 ms). Give the file's tests an explicit 30 s timeout through one local
   wrapper `const t = (name, fn) => test(name, fn, 30_000)` (45x to 270x margin over the 0.11 s worst case). No
   suite-wide change, no setDefaultTimeout.
3. Red-check: temporarily add `await Bun.sleep(6000)` inside makeSymbolsProject with the timeout back at 5 s; show (a) before
   the fix: R358 reports the leak, (b) after the fix: folder gone and R358 green. Then remove the delay.
4. Keep all 22 tests, no assertion edits; confirm `Ran 22 tests`.
5. Finish: typecheck, rm -rf packages/*/dist, `bun scripts/verify.ts` twice under load, `bunx biome check` on the file,
   mark R428 done, `bun scripts/roadmap-index.ts`.
