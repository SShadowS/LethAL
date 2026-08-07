/**
 * R88: which commit built this binary, and which operators it can actually run.
 *
 * `build/` is gitignored, so a released artifact is untracked and git records nothing about its
 * provenance. The filename carries only the package version
 * (`lethal-0.1.0-alpha.1-windows-x64.exe`), which does not move when `packages/` does. **Measured
 * 2026-08-04**: the local binary was 56 package-commits stale — `grep -c` against it returned 0 for
 * both `swap-call-arguments` and `remove-commit`, two operators that shipped, while
 * `negate-conditional` returned 3. A run driven by that binary silently measured a SMALLER operator
 * set than the same source would, and nothing in the report, the filename or `--version` said so.
 *
 * Two halves, and the second is the one that would have caught that specific incident:
 *
 * 1. **The build stamp** — commit, dirty flag and build time, injected by
 *    `scripts/build-binary.ts` at compile time.
 * 2. **The registered operator set** — read at RUNTIME from `operatorTiers`, the same map
 *    `generateMutationSet` walks. Not a hand-maintained list: a binary reports the operators it
 *    will actually run, so a downloader can compare against what a plan assumes without trusting
 *    the version string to imply it.
 *
 * ── HOW THE STAMP GETS IN ─────────────────────────────────────────────────────────────────────
 *
 * `bun build --define`, not a file read. R50 measured what happens to a runtime-computed path
 * under `bun build --compile`: it resolves against Bun's virtual root and fails, which is why the
 * VERSION is a static `package.json` import rather than a read. A generated source file would work
 * too, but it would have to be written before the build and cleaned up after, and a half-failed
 * build would leave a lying constant checked out in the tree.
 *
 * The `typeof` guard is what makes the same source run un-stamped. Under `bun run` these
 * identifiers are simply not defined, and `typeof <undeclared>` is the one expression in
 * JavaScript that does not throw on them — so a developer build reports "not stamped" instead of
 * crashing, and no build-time plumbing is needed to run from source.
 */

declare const __LETHAL_BUILD_COMMIT__: string;
declare const __LETHAL_BUILD_TIME__: string;
declare const __LETHAL_BUILD_DIRTY__: string;

export interface BuildStamp {
  /** Full 40-character commit sha the binary was built from. */
  readonly commit: string;
  /** ISO-8601 UTC instant of the build. */
  readonly builtAt: string;
  /** True when the working tree had uncommitted changes — the commit alone would then be a LIE
   *  about what is inside, so it is reported rather than left to be inferred. */
  readonly dirty: boolean;
}

/** The stamp, or `undefined` for a binary that was never stamped (any run from source). */
export function buildStamp(): BuildStamp | undefined {
  if (typeof __LETHAL_BUILD_COMMIT__ === "undefined") return undefined;
  return {
    commit: __LETHAL_BUILD_COMMIT__,
    builtAt: typeof __LETHAL_BUILD_TIME__ === "undefined" ? "" : __LETHAL_BUILD_TIME__,
    dirty: typeof __LETHAL_BUILD_DIRTY__ !== "undefined" && __LETHAL_BUILD_DIRTY__ === "1",
  };
}

/**
 * What `lethal --version` prints.
 *
 * The FIRST line is exactly the version and nothing else — unchanged from before this existed, so
 * a script doing `lethal --version | head -1` keeps working. Everything a bug report needs is on
 * the lines after it.
 *
 * An unstamped build says so IN WORDS ("built from source; no commit stamp") rather than omitting
 * the line. A missing line reads as "there is nothing to say"; the honest reading is "this binary
 * cannot tell you what it was built from", and those are different facts.
 */
export function renderVersion(
  version: string,
  operators: readonly string[],
  stamp: BuildStamp | undefined = buildStamp(),
): string {
  const lines = [version];
  if (stamp === undefined) {
    lines.push("build: built from source; no commit stamp");
  } else {
    const dirty = stamp.dirty
      ? " (DIRTY working tree — the commit does not describe this build)"
      : "";
    const at = stamp.builtAt === "" ? "" : ` built ${stamp.builtAt}`;
    lines.push(`build: ${stamp.commit}${dirty}${at}`);
  }
  // Sorted, so two binaries are diffable line-for-line rather than by registration order.
  lines.push(`operators (${operators.length}): ${[...operators].sort().join(", ")}`);
  return lines.join("\n");
}
