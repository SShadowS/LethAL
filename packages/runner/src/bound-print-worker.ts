/**
 * PR-292 (R1156 follow-up): the worker thread that computes al-runner v3's per-send bound print (`printWalkedSync`), so
 * the walk, the reads and the hash do not block LethAL's JS thread while other lanes wait. The pool and the error
 * crossing are in `baseline-snapshot.ts` (`printInWorker`). One request at a time, answered by its id.
 */
import { type PrintAnswer, type PrintRequest, printWalkedSync } from "./baseline-snapshot";
import { ProjectSymlinkRefusedError } from "./walk";

declare const self: Worker;

self.onmessage = (ev: MessageEvent<PrintRequest>) => {
  const { id, dir, links, skipRootControl } = ev.data;
  let answer: PrintAnswer;
  try {
    answer = { id, print: printWalkedSync(dir, links, skipRootControl) };
  } catch (err) {
    answer =
      err instanceof ProjectSymlinkRefusedError
        ? { id, link: { linkPath: err.linkPath, root: err.root, message: err.message } }
        : { id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(answer);
};
