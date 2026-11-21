# PR-292 spec-light: the per-send bound print in worker threads (R1156 follow-up)

lethal-preproc, 2026-11-21, pre-committed before any code. Ruled by the orchestrator: build it now.

## 1. Why
- R1156/PR-259 cut each bound check's hash cost: a per-file `Bun.hash` print instead of SHA-256, every byte still read.
  But the walk, the reads and the hash still run SYNCHRONOUSLY on LethAL's one JS thread (R767 made them synchronous on
  purpose: Bun's async fs cost more than the hash).
- So with N lanes the checks QUEUE: each lane waits for every other lane's hash.
- Measured: perf10c, 3 lanes, SHA-256: 237 ms per check (offline 84 ms). c1, 5 lanes, the bound print on edge-4ebfe7913:
  **365 ms per check** (1,375 s over 3,767 checks), while the print alone takes about 40-60 ms offline.
- Runs are moving to 6-8 lanes (PR-274, the owner), so the queue grows with them.

## 2. What changes
- `printAlTree(dir)` and `printTestDir(dir)` (`packages/runner/src/baseline-snapshot.ts`), the two per-send prints
  `assertBound` awaits, run their walk + read + hash in a small pool of Bun Workers (new `bound-print-worker.ts`).
  - Each worker runs the SAME function as today (`printWalked`, moved so both sides import it), so the print is
    byte-for-byte the same computation.
  - Pool size: min(4, the machine's available parallelism). Created lazily, reused, `unref()`ed so it never keeps a
    process alive.
- **Unchanged:**
  - what is read, the print, the comparison and its error texts;
  - the proof-time `scanAlTree`/`scanTestDir` (once per batch, inline);
  - `otherFilesDrift`, `app.json`, the selector and `<deps>` checks (stat-only or small, inline);
  - `hashAlTree` and every stored hash.
- **Errors cross the thread boundary explicitly:**
  - a link refusal in the worker becomes a real `ProjectSymlinkRefusedError` (same `linkPath`, `root` and message) on
    the main thread, so `linkIsUnproven` still turns it into `AlRunnerV3UnprovenBatchError`;
  - any other worker error rejects the print with its message, and the send is refused as today on any check error;
  - a worker that dies rejects every print it held, never hangs, and is replaced.
  - Fail loudly: there is no silent fallback to the inline path.

## 3. Pre-committed tests (red-going against today's synchronous code)
1. **The JS thread stays free:** a `setInterval` of 1 ms keeps ticking while `printAlTree` of a large temporary tree
   (about 30 MB of `.al`) runs. Today it ticks 0 times during the call; after the change, at least 5.
2. **Same print:** for a tree with a root control file, a nested `.al` and a non-`.al` file, the worker's
   `printAlTree`/`printTestDir` equal the inline `printWalked` (the root control file is left out of one and kept in
   the other, as today). One changed byte, or a rename, changes both alike.
3. **Link refusal:** a symlinked `.al` folder makes `printAlTree` reject with `instanceof ProjectSymlinkRefusedError`,
   naming the link's path. The existing T22 R631/R655 link cases still refuse at the next send.
4. **Other errors:** a missing directory rejects (no hang) with an error naming the directory.
5. **Concurrency:** 4 concurrent prints of 4 trees all resolve, each to its own tree's print (no answer swapped
   between requests).
6. **Exit:** a subprocess that calls `printAlTree` once and returns exits by itself within 10 s (the pool is unref'd).
- **All of T22** (`al-runner-v3-backend.test.ts`) passes unchanged.

## 4. Red checks, both directions
- the inline synchronous path restored turns test 1 red;
- the link reconstruction dropped (a plain Error) turns test 3 red;
- a worker that omits the paths from the print turns test 2 red;
- answers matched by arrival order instead of request id turn test 5 red;
- the pool not unref'd turns test 6 red.

## 5. Gates and the live claim
- Every leg `selectLegs` names, on the final head. They run after the combined re-run (c2), which keeps priority.
- **Live claim (R1156, read on the next DO run after merge):** per-check `boundMs/boundChecks` at 6+ lanes under 130 ms,
  where c1 read 365.
