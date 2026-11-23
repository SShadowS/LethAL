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

## 6. Amendment 1 (2026-11-21, the Opus build review and a hang VERIFY found; before any gate)
- **Review B1 (BLOCK): release binaries.**
  - `scripts/build-binary.ts` compiled `cli.ts` alone, and a compiled binary contains a worker only as an entry point.
    So every release binary would have refused every v3 send.
  - Fixed: `COMPILE_ENTRIES` lists the CLI and the worker.
  - A guard test in `build-binary.test.ts` scans `packages/runner/src` for `new Worker(new URL("./x", import.meta.url))`
    and requires each worker in `COMPILE_ENTRIES`. Red-checked: the worker removed turns it red.
- **A real hang, found by VERIFY** (`al-runner-v3-entries.test.ts` ran past the 180 s watchdog): R653 P7 hung.
  - A refused check's continuation, run inside the previous answer's MESSAGE DISPATCH, posted the next request to the
    same worker. Its answer was posted by the worker but never delivered (Bun 1.4.4): no `message`, `messageerror` or
    `close` event, with the main thread idle in `ep_poll`. A standalone probe did not reproduce it.
  - Fixed: an answer is settled with `setImmediate`, outside the dispatch. Red-checked: settled inline, P7 hangs again.
    P7 is the regression test.
- **The pool's lifecycle changed from §2's "unref'd":**
  - Workers stay REFERENCED, so a pending print keeps the process alive.
  - A worker idle for 2 s is terminated by an unref'd timer, armed at CREATION too, so an unused worker cannot hold the
    process open. Red-checked: without the arm at creation, test 6 turns red.
  - The ref/unref toggle was tried and dropped: it was not the hang's cause, and the timer is simpler.
- **Review S1:** a worker that closes while idle now always leaves the pool, or the next print sent to it would never
  settle.
- **Review N2:** a send that throws holds nothing.
- **Review N1:** test 1's threshold is 5 ticks, as pre-committed (the first build had 2).
- **Red check 3 as run differs from §4's wording:** the worker passed the wrong root-control flag, rather than leaving the
  paths out of the print. Test 2 turned red either way.
- **Review S2, noted:** each check still walks both trees on the main thread in `otherFilesDrift` (about 8 ms warm,
  41 ms cold on DO). If the live claim misses at 6+ lanes, that walk moves into the worker next.
