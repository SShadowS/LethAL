# GH-25: `--changed-since` measures the working tree, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--changed-since <ref>` selects the lines that differ between `git merge-base <ref> HEAD` and the WORKING TREE (index included), plus every line of each untracked, not-ignored `.al` file in the project. The report records the ref, the merge-base sha and the untracked files.

**Architecture:** One function changes behaviour: `changedLinesSince` in `packages/runner/src/line-filter.ts`. It runs three git commands instead of one (`merge-base`, `diff <sha>`, `ls-files --others`) and returns the ranges plus a small `ChangedSinceSource` record. `resolveLineRanges` (`packages/runner/src/cli.ts:2043`) passes both on. The source record rides `SessionConfig` into the `run-configured` event and the fold statics, and lands as `SessionReport.lines.changedSince`. The resume fingerprint is NOT touched: it already keys on the resolved ranges (`packages/runner/src/resume.ts:339-341`), which is exactly the mutant-set fact that changes.

**Tech Stack:** Bun + TypeScript, real `git` in hermetic temp repositories, `bun test`.

**Spec:** GitHub issue #25. Parent feature: issue #19, `docs/roadmap/R227.md`.

## The decision this plan rests on: no new flag

The issue proposes a `--worktree` modifier. This plan changes `--changed-since` itself instead, because the committed-only form is not "committed changes only". It is misaligned:

- `changedLinesSince` diffs `<ref>...HEAD` (`line-filter.ts:77-79`), so its line numbers are HEAD's.
- `generateMutationSet` reads every file from the working tree (`orchestrator.ts:524` lists them with `readdir`, `orchestrator.ts:573-575` reads them with `readFile`), and `spanTouches` compares those line numbers against HEAD's.
- So on a dirty tree, an uncommitted edit above a committed change shifts the committed change's lines, and the run mutates the wrong lines. Measured in a temp repo: committed change at line 5, three lines inserted above it uncommitted; the three-dot form reports `5-5`, the file LethAL parses has that change at line 8.

On a clean tree the two forms give identical ranges (`A...B` is defined as `diff $(merge-base A B) B`, and a clean tree equals HEAD). CI checkouts are clean, so CI results do not move. On a dirty tree the old form is wrong and the new one is right. There is no case where a user wants the old form, because LethAL stages and deploys the working tree either way. A modifier would add a flag whose only effect is to choose the wrong answer. It would also need the doctor warning, whose only job is to say "you picked the wrong answer". With no modifier, the doctor warning has nothing to warn about, so it is dropped (YAGNI).

`--changed-since HEAD` becomes useful for free: "only my uncommitted edits".

Ruled 2026-09-25 (see "Orchestrator rulings" at the end): the flag itself changes.

## Edge-case rulings (measured on git 2.55.0.windows.3, 2026-09-25, temp repo in the session scratchpad)

| Input | Ruling | Evidence / mechanism |
|---|---|---|
| Uncommitted edit, tracked file | counts | `git diff <sha>` with no second tree compares against the working tree |
| Staged, not committed | counts; if the worktree then differs from the index, the WORKTREE wins | same command; the index only decides what is tracked |
| Staged new file | counts whole, as `@@ -0,0 +1,N @@` | measured |
| Untracked `.al`, not ignored | every line counts | `git ls-files -z --others --exclude-standard -- .`, then count lines |
| Untracked, matched by `.gitignore` | excluded | `--exclude-standard`; measured (`ignored.al` absent) |
| Untracked, outside the project dir | excluded | `ls-files` runs with `cwd: projectDir` and `-- .`; it prints paths relative to cwd (measured: `src/Brand.al`) |
| Untracked empty `.al` | listed in `untrackedFiles`, no range | zero lines; nothing to mutate |
| Untracked binary `.al` (contains a NUL byte) | THROW naming the file | read as bytes first; a NUL means git's own binary rule would apply, and a UTF-8 line count of it is meaningless |
| Submodule under the project (a gitlink, mode `160000`) that holds at least one `.al` file | THROW naming it (one with no `.al` file is ignored: LethAL never parses it) | `git ls-files -s -z -- .` lists it (measured: `160000 <sha> 0	sub`). LethAL's `readdir` walks into it and parses its `.al` files, but the outer repo's diff and `ls-files --others` never list edits inside it, so its changes would silently get no mutants |
| Untracked nested repository under the project that holds at least one `.al` file | THROW naming it (one with no `.al` file is ignored) | `ls-files --others` prints it as a DIRECTORY entry with a trailing `/` (measured: `nested/`) and never lists its files. Same blind spot as a submodule |
| A tag, or `HEAD` itself, as the ref | works | `merge-base v1 HEAD` returns the tagged commit (measured). `--changed-since HEAD` diffs HEAD against the worktree: only uncommitted edits plus untracked files |
| Rename with a small edit | only the edited lines, under the NEW name; the old name yields nothing | pass `--find-renames` explicitly: a user's `diff.renames=false` otherwise turns it into delete plus whole-file add (measured) |
| Rename with a large edit (below git's 50% similarity) | the new file counts WHOLE, the old name yields nothing | git no longer pairs them (measured: 3 of 4 lines changed gives `+++ /dev/null` and `@@ -0,0 +1,4 @@` on the new name). More mutants, never wrong lines: the safe direction. The promise is "never misaligned", not "only the edited lines" |
| Renamed in Explorer, not `git mv` | the new file is untracked, so it counts whole | more mutants, never misaligned; documented, not fixed |
| Deleted file | nothing | `+++ /dev/null`, already skipped (`line-filter.ts:59`) |
| Path with a space | works | git appends a TAB to `+++ b/My File.al`; `.trim()` at `line-filter.ts:58` removes it (measured) |
| Non-ASCII path (`Æble.al`) | works after the fix | default `core.quotePath` prints `+++ "b/src/\303\206ble.al"`, which the parser keeps verbatim and the orchestrator then refuses as an unknown file. This is a live #19 bug too. Fix: `-c core.quotePath=false` (measured: prints `Æble.al` raw) |
| A path git still quotes (`"`, `\`, control chars) | THROW if it ends in `.al` | cannot occur on Windows; failing loudly beats guessing an unquote |
| `diff.mnemonicPrefix=true` / `diff.noprefix=true` in user config | works after the fix | mnemonicPrefix prints `+++ w/src/X.al` for a worktree diff (measured), which `replace(/^b\//, "")` misses. Fix: `--src-prefix=a/ --dst-prefix=b/` (measured) |
| CRLF | line numbers unaffected | hunks count lines, and the parser splits on `\r?\n` (`line-filter.ts:56`). A line-ending-only change (worktree CRLF, blob LF, `autocrlf` off) makes git report the whole file changed (measured `@@ -1,3 +1,4 @@`); `--ignore-cr-at-eol` fixes that. Untracked line count splits on `\n`, so CRLF counts the same |
| Binary `.al` (NUL byte, UTF-16) | THROW naming the file | git prints `Binary files /dev/null and b/src/Bin.al differ` and no `+++` line (measured), so the file would silently contribute nothing. A binary non-`.al` file in the project is ignored |
| Ref does not exist | THROW | `merge-base` exits 128, `fatal: Not a valid object name nope` (measured) |
| No git repository | THROW | exit 128, `fatal: not a git repository` (measured) |
| No common ancestor (orphan branch, shallow clone) | THROW | `merge-base` exits 1 with EMPTY stdout and stderr (measured). Empty-vs-empty is this project's signature bug, so exit 1 gets its own message |
| `merge-base` prints something that is not a sha | THROW | `/^[0-9a-f]{40}([0-9a-f]{24})?$/` (SHA-1 or SHA-256 repos) |
| Untracked `.al` whose basename starts with `Mutation` | refused by the existing unknown-file check (`orchestrator.ts:557-566`), because enumeration skips that prefix (`orchestrator.ts:526`) | same as a committed one today; loud, left alone |
| No `.al` line changed at all | refused by the existing "kept no deployable mutation site" check (`orchestrator.ts:714-719`) | unchanged |

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Fail loudly: every git failure throws an `Error` naming `--changed-since <ref>`, the command and git's stderr. Never return `[]` for a failed command.
- `SessionReport.lines.changedSince` is **OPTIONAL in the type and schema**, and this build writes it whenever `--changed-since` was given (absent for `--lines` alone). It is a nested optional key inside the existing optional `lines` object, so neither the root `required` list nor `lines.required` changes. R157's rule (`REPORT_SCHEMA_VERSION` doc comment in `report.ts`): **do not bump `REPORT_SCHEMA_VERSION`**. Committed sample reports are NOT regenerated, on the same ruling as C02-02 (optional field; regenerating needs a live run, which is the owner's call).
- No new `Caveat`. `line-narrowed` already covers the run.
- No console banner change. The ranges are already printed under `NARROWED (lines)`; the sha is machine data.
- `sessionFingerprint` is NOT changed. The resolved ranges are already in it; the ref, the merge-base and the form are not. **Ruled acceptable (orchestrator, 2026-09-25):** a run recorded by the OLD build, even on a dirty tree, may be resumed by the new build whenever its resolved ranges equal the new ones. Equal ranges over the same source select the same mutants, because selection is `spanTouches` on those ranges and nothing else, and every carried verdict is matched by identity key (`serializeKey`, which hashes the mutated subtree), so a mutant whose source changed is re-run, not carried. What the old build got wrong was WHICH ranges it computed, and a run whose ranges differ gets a different digest and is not resumed. Adding the ref or sha would only stop clean-tree #19 runs from resuming, for no change in the mutant set.
- Real git in tests, never a fake spawn for git semantics (same reasoning as `campaign-subcommands.test.ts:1-10`: a fake only re-asserts my beliefs about git). Hermetic env: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at a missing file, `GIT_TERMINAL_PROMPT=0`, plus `GIT_CEILING_DIRECTORIES=tmpdir()` so the "no repository" test cannot find a repo above the temp dir. Hostile user config (`diff.mnemonicPrefix`, `diff.noprefix`, `diff.renames=false`, `core.quotePath=true`) is set REPO-LOCALLY in the fixtures that need it, so the hermetic env does not hide it.
- No live gate is needed. `--changed-since` is not exercised by any gate (R227: "Not measured live yet").
- R205 is still open (`docs/roadmap/R205.md`, status "no code change yet"): there is no session snapshot to diff against. Lines are computed from the live tree at `cli.ts:3120`, before provisioning, and files are parsed later inside `runSession`. An edit in that window misaligns them. Same ceiling every run already has; Task 4 records it on R205 so the snapshot, when built, computes lines against itself.

## Review Focus

1. **An uncommitted edit in a tracked file, above a committed change.** Expected: the inserted lines count, and the committed change's range MOVES to its working-tree line. This is the misalignment the old form had. Pinned by `"an uncommitted insertion above a committed change carries the committed range with it"` (Task 2).
2. **A brand-new untracked codeunit** (CRLF, no trailing newline), next to an ignored `.al`, an untracked `.txt`, an empty `.al` and an untracked `.al` OUTSIDE the project. Expected: the codeunit counts whole (`1-3`), the empty file is listed with no range, the other three are absent. Pinned by `"a brand-new untracked codeunit counts whole; ignored, non-.al and outside-project files do not"` (Task 2).
3. **Staged but not committed, then changed again in the worktree.** Expected: a staged new file counts whole; a staged edit that the worktree then reverts contributes NO range. Pinned by `"staged changes count, and the working tree wins over the index"` (Task 2).
4. **A `git mv` plus an edit, in a repo whose config has `diff.renames=false`, `diff.mnemonicPrefix=true`, `diff.noprefix=true` and `core.quotePath=true`, with a space and a non-ASCII name in the paths.** Expected: for a small edit, exactly the edited lines under the new names, spelled as on disk; for a low-similarity rename, the whole new file and nothing under the old name. Pinned by `"renames, spaces, non-ASCII names and hostile diff config all yield on-disk paths"` and `"a low-similarity rename counts the new file whole"` (Task 2).
5. **`--resume` across the change.** Expected: on a CLEAN tree the new ranges equal what #19's three-dot form produced (so the digest is equal by construction, and the ruling in Global Constraints says why equal-range carry is safe); after one uncommitted edit the ranges, and so the fingerprint, differ. Pinned by `"a clean tree reproduces the three-dot ranges; an uncommitted edit changes the fingerprint"` and, for the mismatch case the old build got wrong, by Review Focus 1's test (Task 2).

---

### Task 1: Share the hermetic git helper

**Files:**
- Create: `packages/runner/tests/helpers/git-repo.ts`
- Modify: `packages/runner/tests/campaign-subcommands.test.ts` (lines 41-84: move `HERMETIC_GIT_ENV` and `git()` out, import them back; keep the long comments with the code they explain)

**Interfaces:**
- Produces:
  - `export const HERMETIC_GIT_ENV: Record<string, string | undefined>` (current value, plus `GIT_CEILING_DIRECTORIES: tmpdir()`).
  - `export async function git(cwd: string, args: readonly string[]): Promise<string>` (unchanged body).
  - `export const hermeticSpawn: SpawnFn = (argv, opts) => defaultSpawn(argv, { ...opts, env: { GIT_CONFIG_GLOBAL: ..., GIT_CONFIG_SYSTEM: ..., GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: tmpdir() } })`. `defaultSpawn` merges `env` over `process.env` (`publisher.ts:21-23`), so pass only the overrides.
  - `export async function makeGitRepo(files: Record<string, string>, localConfig: Record<string, string> = {}): Promise<string>`: `realpathSync(mkdtemp)`, `git init -q -b main`, user name/email, each `localConfig` entry as `git config <k> <v>`, write files, `add -A`, commit. Returns the repo root. `campaign-subcommands.test.ts`'s `makeRepo` becomes a one-line call to it.

- [ ] **Step 1:** Move the code. `GIT_CEILING_DIRECTORIES` is new; the campaign tests work inside their own repo, so it changes nothing for them.
- [ ] **Step 2:** `bun test packages/runner/tests/campaign-subcommands.test.ts`. Expected: PASS, same test count as before.
- [ ] **Step 3: Commit** `test: share the hermetic git fixture helper (GH-25)`.

### Task 2: `changedLinesSince` diffs the working tree and adds untracked files

**Files:**
- Modify: `packages/runner/src/line-filter.ts` (`parseUnifiedDiffAdded` lines 48-68, `changedLinesSince` lines 70-88)
- Modify: `packages/runner/tests/line-filter.test.ts` (the `parseUnifiedDiffAdded` test at line 88 gains cases; the fake-spawn `resolveLineRanges` test at line 138 is rewritten in Task 3)
- Create: `packages/runner/tests/changed-since-git.test.ts` (real git; every Review Focus test lives here)

**Interfaces:**
- Produces, in `line-filter.ts`:

```ts
/** GH-25: where `--changed-since` lines came from. Recorded in the report. */
export interface ChangedSinceSource {
  /** The ref as given. */
  readonly ref: string;
  /** Full sha of `git merge-base <ref> HEAD`; the diff runs from here to the working tree. */
  readonly mergeBase: string;
  /** Untracked, not-ignored `.al` files under the project, project-relative, sorted. Every line
   *  of each counts as changed; an empty one is listed and contributes no range. */
  readonly untrackedFiles: readonly string[];
}

/** Lines in a text as tree-sitter counts rows: split on "\n", a trailing newline ends the last
 *  line rather than starting a new one. "" is 0. CRLF counts the same as LF. */
export function lineCount(text: string): number;

export async function changedLinesSince(
  projectDir: string,
  ref: string,
  spawn: SpawnFn,
): Promise<{ ranges: LineRange[]; source: ChangedSinceSource }>;
```

`changedLinesSince` now:
1. `git merge-base <ref> HEAD` (cwd `projectDir`). Exit 1 with empty stdout: throw `--changed-since <ref>: <ref> and HEAD share no commit (an orphan branch or a shallow clone?) in <projectDir>`. Any other non-zero exit: throw with git's stderr (covers a bad ref and "not a git repository"). Stdout not a sha: throw.
2. `git -c core.quotePath=false diff -U0 --no-color --no-ext-diff --find-renames --ignore-cr-at-eol --src-prefix=a/ --dst-prefix=b/ --relative <sha> -- .` (no second tree, so the working tree). Non-zero: throw.
3. `git ls-files -s -z -- .`. Non-zero: throw. Any entry whose mode is `160000` (a gitlink): throw `--changed-since <ref>: <path> is a git submodule inside the project. LethAL parses its .al files, but this repository's diff cannot see edits inside it, so they would get no mutants. Move the project out of the submodule's parent.` Only when the submodule's directory holds at least one `.al` file (case-insensitive, searched recursively the way `orchestrator.ts` enumerates the project); a submodule with none is skipped. NO `--exclude` remedy: line resolution runs before exclusions are applied (`cli.ts` `resolveLineRanges`, ahead of the exclude merge), so `--exclude` cannot silence this check and the message must not suggest it. (Split on `\0`; the mode is the first space-separated field, the path follows the tab.)
4. `git ls-files -z --others --exclude-standard -- .`. Non-zero: throw. Split on `\0`, drop `""`. Any entry ending in `/` is an untracked nested repository: if it holds at least one `.al` file, throw with the same shape of message (no `--exclude` remedy); otherwise skip it (`<path> is a nested git repository inside the project ...`). Keep `.al` (case-insensitive), `normalizeRelPath`, sort. Read each as BYTES (`readFile(join(projectDir, rel))`); a `0x00` byte throws `a binary .al file (<path>): ...` with the same wording as the diff-side refusal; otherwise decode UTF-8 and push `{ file, start: 1, end: n }` when `lineCount > 0`.
5. Keep only `.al` ranges from the diff too (move the filter here from `resolveLineRanges`, `cli.ts:2053-2057`, so both halves filter in one place).

Add a comment on the function: `// ponytail: reads the live tree at session start; an edit before generateMutationSet parses misaligns the lines. R205's snapshot closes this.`

`parseUnifiedDiffAdded` additionally:
- throws on `/^Binary files .* and b\/(.+) differ$/` when the captured path ends in `.al` (case-insensitive): `a binary .al file (<path>): git reports no lines for it, so its changes would silently get no mutants`;
- throws when a `+++ ` target starts with `"` and ends with `.al"`: `git quoted this path, which LethAL does not unquote`. A quoted non-`.al` target sets `file = undefined`.

- [ ] **Step 1: Write the failing tests.** In `changed-since-git.test.ts`, set `setDefaultTimeout(60_000)` (see `HOOK_TIMEOUT_MS` in the campaign test for why). Each test builds its own repo with the project in a SUBDIRECTORY `app/`, so `--relative` and `-- .` are exercised. A shared fixture:

```ts
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLinesSince, parseUnifiedDiffAdded } from "../src/line-filter";
import { sessionFingerprint } from "../src/resume";
import { git, hermeticSpawn, makeGitRepo } from "./helpers/git-repo";

setDefaultTimeout(60_000);

const TEN = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`;

/** main = base; feat = base plus one committed change at app/src/A.al line 5. */
async function prFixture(localConfig: Record<string, string> = {}) {
  const root = await makeGitRepo({ "app/src/A.al": TEN, "app/.gitignore": "Ignored.al\n" }, localConfig);
  await git(root, ["checkout", "-qb", "feat"]);
  await writeFile(join(root, "app/src/A.al"), TEN.replace("l5\n", "L5\n"));
  await git(root, ["commit", "-qam", "committed change"]);
  return { root, app: join(root, "app") };
}
const rangesOf = async (app: string, ref = "main") =>
  (await changedLinesSince(app, ref, hermeticSpawn)).ranges;

test("an uncommitted insertion above a committed change carries the committed range with it", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(join(app, "src/A.al"), TEN.replace("l5\n", "L5\n").replace("l1\n", "l1\nx\ny\nz\n"));
    expect(await rangesOf(app)).toEqual([
      { file: "src/A.al", start: 2, end: 4 },
      { file: "src/A.al", start: 8, end: 8 },
    ]);
    // The #19 form on the same tree: HEAD's numbering, which is wrong for the file LethAL parses.
    const old = parseUnifiedDiffAdded(await git(app, ["diff", "-U0", "--relative", "main...HEAD", "--", "."]));
    expect(old).toEqual([{ file: "src/A.al", start: 5, end: 5 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a brand-new untracked codeunit counts whole; ignored, non-.al and outside-project files do not", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(join(app, "src/New.Codeunit.al"), "a\r\nb\r\nc"); // CRLF, no trailing newline
    await writeFile(join(app, "src/Empty.al"), "");
    await writeFile(join(app, "Ignored.al"), "q\n");
    await writeFile(join(app, "notes.txt"), "n\n");
    await writeFile(join(root, "Outside.al"), "o\n");
    const { ranges, source } = await changedLinesSince(app, "main", hermeticSpawn);
    expect(ranges).toContainEqual({ file: "src/New.Codeunit.al", start: 1, end: 3 });
    expect(ranges.map((r) => r.file).sort()).toEqual(["src/A.al", "src/New.Codeunit.al"]);
    expect(source.untrackedFiles).toEqual(["src/Empty.al", "src/New.Codeunit.al"]);
    expect(source.mergeBase).toBe((await git(root, ["merge-base", "main", "HEAD"])).trim());
    expect(source.ref).toBe("main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged changes count, and the working tree wins over the index", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(join(app, "src/Staged.al"), "s1\ns2\n");
    await git(app, ["add", "src/Staged.al"]);
    const edited = TEN.replace("l5\n", "L5\n");
    await writeFile(join(app, "src/A.al"), edited.replace("l9\n", "L9\n"));
    await git(app, ["add", "src/A.al"]);
    await writeFile(join(app, "src/A.al"), edited); // revert line 9 in the worktree only
    expect(await rangesOf(app)).toEqual([
      { file: "src/A.al", start: 5, end: 5 },
      { file: "src/Staged.al", start: 1, end: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renames, spaces, non-ASCII names and hostile diff config all yield on-disk paths", async () => {
  const root = await makeGitRepo(
    { "app/src/Old.al": "r1\nr2\nr3\nr4\n", "app/src/Æble.al": "x\ny\n" },
    { "diff.renames": "false", "diff.mnemonicPrefix": "true", "diff.noprefix": "true", "core.quotePath": "true" },
  );
  const app = join(root, "app");
  try {
    await git(app, ["mv", "src/Old.al", "src/My New.al"]);
    await writeFile(join(app, "src/My New.al"), "r1\nr2\nr3\nR4\n");
    await writeFile(join(app, "src/Æble.al"), "x\nY\n");
    expect(await rangesOf(app, "HEAD")).toEqual([
      { file: "src/My New.al", start: 4, end: 4 },
      { file: "src/Æble.al", start: 2, end: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean tree reproduces the three-dot ranges; an uncommitted edit changes the fingerprint", async () => {
  const { root, app } = await prFixture();
  try {
    const fp = (lines: readonly { file: string; start: number; end: number }[]) =>
      sessionFingerprint({
        projectDir: app, testDir: "t", backend: "bcdev", skipKnownSurvivors: false,
        selectorIds: { selectorId: 1, controlId: 2, tableId: 3 }, lines,
      });
    // Exactly #19's argv (line-filter.ts before this change), as the oracle.
    const old = parseUnifiedDiffAdded(
      await git(app, ["diff", "-U0", "--no-color", "--no-ext-diff", "--relative", "main...HEAD", "--", "."]),
    );
    const clean = await rangesOf(app);
    expect(clean).toEqual(old);
    await writeFile(join(app, "src/A.al"), TEN.replace("l5\n", "L5\n").replace("l9\n", "L9\n"));
    const dirty = await rangesOf(app);
    expect(fp(dirty)).not.toBe(fp(clean));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Also in `changed-since-git.test.ts`, a `describe("fails loudly")` block, each asserting `rejects.toThrow(...)`:
- `"a ref that does not exist"`: `changedLinesSince(app, "nope", hermeticSpawn)` rejects `/--changed-since nope.*merge-base.*Not a valid object name/s`.
- `"a directory that is not in a git repository"`: `mkdtemp(join(tmpdir(), "lethal-norepo-"))` rejects `/not a git repository/`.
- `"a ref with no common ancestor"`: in a fixture repo, `git checkout -q --orphan lonely`, write and commit one file, then `changedLinesSince(app, "main", ...)` rejects `/share no commit/`. (Do not use `git rm -rf` to empty the orphan; a safety hook blocks it. Committing on top of the staged tree is fine: the history is still unrelated.)
- `"a binary .al"`: commit nothing, write `src/Bin.al` with `"a\0b\n"`, `git add` it, rejects `/binary \.al file \(src\/Bin\.al\)/`.

- `"an untracked binary .al"`: in `prFixture()`, write `src/Blob.al` with `"a\0b\n"` and do NOT add it; rejects `/binary \.al file \(src\/Blob\.al\)/`.
- `"a submodule inside the project"`: build a second repo with `makeGitRepo({ "I.al": "i\n" })`, then in the fixture run `git -c protocol.file.allow=always submodule --quiet add <inner> app/sub` from the repo root and commit; `changedLinesSince(app, "main", ...)` rejects `/sub is a git submodule inside the project/`. (`protocol.file.allow=always` is needed for a local-path submodule since git 2.38.) Measured 2026-09-25: `git ls-files -s` in `app/` prints `160000 <sha> 0\tsub`.
- `"an untracked nested repository inside the project"`: `git init -q app/nested` and write `app/nested/N.al`; rejects `/nested\/ is a nested git repository inside the project/`. Measured: `ls-files --others` prints `nested/`.
- `"a nested repository or submodule with no .al file is ignored"`: an untracked `git init -q app/tools` holding only `README.md`, and a submodule whose repo holds only `x.txt`; `changedLinesSince` succeeds and selects the ordinary edits. Also assert neither refusal message contains `--exclude`.

Edge tests:
- `"a line-ending-only change adds no range"`: in `prFixture()` (whose `A.al` is LF), rewrite `A.al` as the same content with CRLF endings; `rangesOf(app)` equals `[{ file: "src/A.al", start: 5, end: 5 }]`.
- `"a low-similarity rename counts the new file whole"`: `makeGitRepo({ "app/src/Old.al": "r1\nr2\nr3\nr4\n" })`, `git mv src/Old.al src/Ren.al`, write `"a\nb\nc\nr4\n"`; `rangesOf(app, "HEAD")` equals `[{ file: "src/Ren.al", start: 1, end: 4 }]`, and no range names `src/Old.al`. Measured: git prints `+++ /dev/null` for the old name and `@@ -0,0 +1,4 @@` for the new. This pins the qualified promise: whole file, never misaligned.
- `"--changed-since HEAD: a clean tree selects only untracked files, a dirty one its edits"`: in `prFixture()`, `rangesOf(app, "HEAD")` is `[]` (a real run would then be refused by the existing "kept no deployable mutation site" check, which is right); after writing untracked `src/U.al` (`"u\n"`) it is `[{ file: "src/U.al", start: 1, end: 1 }]`; after also editing `A.al` line 9 it adds `{ file: "src/A.al", start: 9, end: 9 }` and contains nothing at line 5 (that change is committed).
- `"a tag works as the ref"`: in `prFixture()`, `git tag v0 main`; `changedLinesSince(app, "v0", ...)` gives the same ranges as `"main"`, and `source.ref` is `"v0"`.

In `line-filter.test.ts` next to the existing `parseUnifiedDiffAdded` test, pure cases: a `Binary files /dev/null and b/src/Bin.al differ` line throws; `Binary files a/logo.png and b/logo.png differ` does not; `+++ "b/src/\303\206ble.al"` throws; `+++ b/My File.al\t` yields `My File.al`. And `lineCount`: `""` is 0, `"a"` is 1, `"a\n"` is 1, `"a\r\nb"` is 2, `"a\n\n"` is 2.

- [ ] **Step 2: Run and see them fail:** `bun test packages/runner/tests/changed-since-git.test.ts packages/runner/tests/line-filter.test.ts`. Expected: FAIL (`source` undefined, three-dot ranges returned, `lineCount` not exported).
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/changed-since-git.test.ts packages/runner/tests/line-filter.test.ts`. Typecheck fails at the `resolveLineRanges` caller until Task 3; do Task 3's `resolveLineRanges` edit in the same sitting if needed, but commit separately.
- [ ] **Step 5: Red-checks** (use the `mutation-red-checker` subagent; report each red line and the restored green):
  - argv back to `${ref}...HEAD` without merge-base: Review Focus 1 and 3 go red.
  - drop the `ls-files` step: Review Focus 2 goes red.
  - drop `--exclude-standard`: Review Focus 2 goes red (`Ignored.al` appears).
  - drop `-c core.quotePath=false`: Review Focus 4 goes red (quoted `Æble`).
  - drop `--src-prefix=a/ --dst-prefix=b/`: Review Focus 4 goes red (`w/` or no prefix).
  - drop `--find-renames`: Review Focus 4 goes red (`My New.al` 1-4).
  - drop `--ignore-cr-at-eol`: the line-ending test goes red.
  - make `lineCount` return `split("\n").length`: Review Focus 2 goes red is NOT guaranteed (the CRLF file has no trailing newline), so the pure `"a\n"` is 1 case must go red. Check that it does.
  - remove the exit-1 branch: the no-common-ancestor test goes red (the generic message has no "share no commit").
  - remove the binary throw: the binary test goes red.
  - remove the NUL check on untracked files: `"an untracked binary .al"` goes red.
  - remove the gitlink check: `"a submodule inside the project"` goes red.
  - remove the trailing-`/` check: `"an untracked nested repository inside the project"` goes red.
  - drop the "holds an `.al` file" condition from either refusal: `"a nested repository or submodule with no .al file is ignored"` goes red.
- [ ] **Step 6: Commit** `fix(line-filter): --changed-since diffs the working tree and counts untracked .al files (GH-25)`.

### Task 3: Carry the source to the report

**Files:**
- Modify: `packages/runner/src/cli.ts` (`resolveLineRanges` at 2039-2058; its callers at 3120 and 4748; the `runSession` spread at 3317; the `--changed-since` help text at 821-823)
- Modify: `packages/runner/src/orchestrator.ts` (`SessionConfig`, next to `lines` at 812-814; the `run-configured` emit at 2919; the `statics` builder at 4659)
- Modify: `packages/runner/src/events.ts` (`run-configured.lines`, line 100)
- Modify: `packages/runner/src/report-fold.ts` (`FoldStatics.lines` line 63, `FoldedReport.lines` line 118, the reunion at 524-526)
- Modify: `packages/runner/src/report.ts` (`SessionReport.lines` doc comment and type near line 959; `buildReport` passes `input.lines` through unchanged at 2342, so only the type changes)
- Regenerate: `bun scripts/generate-schemas.ts` (`line-filter.ts` is already in its `FILES` list, so `ChangedSinceSource` resolves)
- Test: `packages/runner/tests/line-filter.test.ts`

**Interfaces:**
- Consumes: `ChangedSinceSource`, the new `changedLinesSince` (Task 2).
- Produces:
  - `resolveLineRanges(cfg, spawn): Promise<{ ranges: readonly LineRange[]; changedSince?: ChangedSinceSource } | undefined>`.
  - `SessionConfig.changedSince?: ChangedSinceSource`, doc comment: present exactly when `--changed-since` was given; it does not select anything by itself, `lines` does.
  - `lines?: { ranges; changedSince?: ChangedSinceSource }` on `run-configured` and `FoldStatics`, and `lines?: { ranges; excludedSiteCount; changedSince?: ChangedSinceSource }` on `FoldedReport` and `SessionReport`. The fold copies it with a conditional spread.
  - Help text: `--changed-since <ref>  the same filter, from the lines that differ between 'git merge-base <ref> HEAD' and your working tree (staged and unstaged), plus every line of each untracked .al file git does not ignore. Unions with --lines. Pure deletions add no line. '--changed-since HEAD' selects only uncommitted edits. Needs git and a history that shares a commit with <ref>`.

- [ ] **Step 1: Write the failing tests** in `line-filter.test.ts`:
  - Rewrite `"resolveLineRanges unions --lines with the diff, keeping only .al files"` (line 138): the fake spawn now dispatches on `argv[1]`/`argv[3]` (`merge-base` returns `"a".repeat(40)`, `diff` returns the existing canned diff, `ls-files` returns `""`). Assert `r?.ranges` as before, `r?.changedSince` equals `{ ref: "main", mergeBase: "a".repeat(40), untrackedFiles: [] }`, and that the diff argv contains `"a".repeat(40)` and does NOT contain `"main...HEAD"`. `resolveLineRanges({ projectDir: "p" }, spawn)` stays `undefined`, and `resolveLineRanges({ projectDir: "p", lines: [...] }, spawn)` has no `changedSince` key (`"changedSince" in r` is false).
  - Extend `"buildReport pushes line-narrowed ..."` (line 213): statics `lines: { ranges, changedSince: SRC }` gives `r.lines` equal to `{ ranges, excludedSiteCount: 7, changedSince: SRC }`; without it, `"changedSince" in r.lines` is false.
  - Extend `"only IsOver's mutants run, and the report records the filter"` (line 331): `runWith` gains an optional `changedSince` passed to `runSession` and an `events` collector (`emit: [(e) => events.push(e)]`). Assert `scoped.lines?.changedSince` equals `SRC`, AND the `run-configured` event's `lines.changedSince` equals `SRC`. Two assertions because the orchestrator builds the two carriages at two sites (2919 and 4659) and either can be forgotten.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** In `runFromCli`: `...(lineRanges !== undefined ? { lines: lineRanges.ranges, ...(lineRanges.changedSince !== undefined ? { changedSince: lineRanges.changedSince } : {}) } : {})`. The dry run uses `.ranges` only.
- [ ] **Step 4: Ripple** (CLAUDE.md's SessionReport paragraph): `bun scripts/generate-schemas.ts`, read the diff of `schemas/report-v2.schema.json` and `schemas/stream-v1.schema.json` (one optional `changedSince` object under `lines`, nothing else; root `required` and `lines.required` unchanged). `bun test packages/runner/tests/schemas.test.ts`: it should pass unedited. `report-equality`: run it; update the snapshot only if it changed, and read the diff (expected: no change, since its fixture has no line filter). No `CAVEAT_INTERPRETATIONS` change.
- [ ] **Step 5: The CLI-to-session hand-off.** Add to `changed-since-git.test.ts` a test `"runFromCli hands the changed-since source to runSession"`. Build `prFixture()` and add an `app/app.json` (copy `APP_JSON` from `line-filter.test.ts`). Call `runFromCli(parsed, deps)` with a `RunCliConfig` whose `projectDir` is `app`, `changedSince: "main"`, `dbPath: ":memory:"` and `configPath` a minimal temp config. Copy the shape from the `runFromCli` tests in `cli-envtool.test.ts` near line 790, which already drive it with `validateSelectorIdsForProject: async () => {}`, a stub `buildBackend`, and `runSession: async () => FAKE_REPORT`. Here the `runSession` stub CAPTURES its config argument, then returns `FAKE_REPORT`. Assert the captured config's `lines` equals `[{ file: "src/A.al", start: 5, end: 5 }]` and its `changedSince` equals `{ ref: "main", mergeBase: <git merge-base main HEAD>, untrackedFiles: [] }`. `runFromCli` calls `resolveLineRanges` with the real `defaultSpawn` today, which inherits the machine's git config (a global `*.al -diff` attribute would make the edit look binary). So add ONE optional `gitSpawn` field to `runFromCli`'s existing `deps` (defaulting to `defaultSpawn`), pass it to `resolveLineRanges`, and give this test the hermetic spawn from `campaign-subcommands.test.ts` (the helper that neutralises inherited git config). Keep the real repository and the capturing `runSession` stub. If `runFromCli` reaches something before `runSession` this fixture cannot satisfy, stub it through the existing `deps`; add a new seam only if none exists, and say so in the submit note. Also run the `wiring-completeness` subagent on `SessionConfig.changedSince` and `FoldStatics.lines`.
- [ ] **Step 6: Full loop:** typecheck, clean dist, `bun test`, `bunx biome check` on every touched file.
- [ ] **Step 7: Red-checks:** drop the fold's conditional spread (report assertion red, event assertion green); drop the `run-configured` spread (event assertion red); drop the `changedSince` half of the `runSession` spread in `cli.ts` (~3317) (`"runFromCli hands the changed-since source to runSession"` red). Restore each.
- [ ] **Step 8: Commit** `feat(report): lines.changedSince names the ref, merge-base and untracked files (GH-25)`.

### Task 4: Record the R205 constraint

**Files:**
- Modify: `docs/roadmap/R205.md` (append one paragraph; status unchanged)
- Modify: `docs/roadmap/R227.md` (append one line under "Landed")

- [ ] **Step 1:** R205, append: "**GH-25 (2026-09-25):** `--changed-since` now diffs `git merge-base <ref> HEAD` against the live working tree and reads untracked `.al` files, at `cli.ts` `resolveLineRanges`, before provisioning. When the snapshot lands, compute those lines against the SNAPSHOT (for example `git diff --no-index` per file, or run the diff before copying and hash-check each file after), or the lines and the parse can disagree again."
- [ ] **Step 2:** R227, append: "GH-25 moved `--changed-since` from `<ref>...HEAD` to the working tree plus untracked `.al` files; clean-tree ranges are unchanged."
- [ ] **Step 3:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`. Expected: index unchanged (titles and statuses did not move), test PASS.
- [ ] **Step 4: Commit** `roadmap: note GH-25 on R205 and R227`.

## Out of scope, on purpose

- **A `--worktree` modifier and the doctor warning.** See the decision section. Ruled out 2026-09-25.
- **The R205 snapshot.** Not built; its window is recorded in Task 4.
- **Unquoting git's C-style quoted paths.** `core.quotePath=false` removes the only case Windows can produce; the rest throw.
- **Detecting an Explorer rename as a rename.** Untracked means whole file. More mutants, never misaligned.
- **`--changed-since` in the config file.** It is CLI-only today (`LethalConfigFile`, `cli.ts:1833`, has no such key) and a standing ref in config is odd. Not added.
- **A console banner for the sha.**

## Submit note must say

- That `--changed-since`'s behaviour changed on a dirty tree, why (the misalignment, with Review Focus 1 as the proof), and that clean-tree ranges and fingerprints are unchanged (Review Focus 5).
- That the non-ASCII and `mnemonicPrefix` path bugs were live in #19's form too and are fixed here.
- Every red-check run, with its red and restored-green output line.
- That `REPORT_SCHEMA_VERSION` did not move, the root and `lines` `required` lists did not change, and no committed sample report was regenerated (optional field).
- That `sessionFingerprint` was deliberately not changed.
- That the CLI-to-`runSession` spread is pinned by the `runFromCli` test and its red-check.
- That the rename promise is "never misaligned": a low-similarity rename counts the new file whole.
- That submodules and untracked nested repositories under the project are refused, not skipped.

## Orchestrator rulings (2026-09-25)

1. **`--changed-since` itself changes; no `--worktree` modifier.** The current form is not "committed only", it is WRONG on a dirty tree: git reports HEAD's line numbers and LethAL applies them to the working-tree file it parses (measured in this plan: a committed change at line 5 reported as `5-5` sits at line 8). A modifier would keep a mode that points at the wrong lines. Clean trees and CI are unchanged, pinned by the test using #19's old command as the oracle. The issue's doctor warning is therefore dropped. The submit note and the GitHub close comment must say the flag's meaning changed on a dirty tree.
2. **`untrackedFiles` stays in the report**: it is the only way a reader can tell why a whole file counted.
