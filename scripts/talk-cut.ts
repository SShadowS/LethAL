#!/usr/bin/env bun
/**
 * R662: cut a DRAFT release of a chosen commit, with `lethal-control.app` attached. It never
 * publishes the release: publishing is the owner's click.
 *
 *   bun scripts/talk-cut.ts <sha> [--version 0.1.0-alpha.4] [--notes <file>] [--package-cache <dir>] [--dry-run]
 *
 * Steps, in order, one log line each:
 *   1. CI is green on <sha>: the latest `ci.yml` run for that exact head sha succeeded, with both
 *      jobs `check` and `unit-linux` successful.
 *   2. No tag `v<version>` (local or origin) and no release for it exists.
 *   3. `lethal-control.app` is built from <sha> with alc (`$LETHAL_ALC_DIR/alc`, the container's
 *      build path, as `kraken-setup.sh` does it) in a temporary detached worktree. Its manifest
 *      must name LethAL Control, equal its app.json's version, and be at least 1.0.0.23.
 *   4. A `release.yml` workflow_dispatch TRIAL on exactly <sha> is green. A dispatch takes a ref,
 *      not a sha, so a throwaway branch `release-trial/<sha12>` is pushed at <sha>, dispatched,
 *      found by head sha, waited for, and deleted. A dispatch never creates a release: `publish`
 *      runs only on a pushed `v*` tag. The trial uses the workflow file AT <sha>.
 *   5. The bump commit, in the same worktree: root package.json `version` (a one-line diff), and
 *      CHANGELOG.md's `[Unreleased]` becomes `[<version>] — <date>` under a fresh empty
 *      `[Unreleased]`. An empty Unreleased is refused unless `--notes <file>` gives the section,
 *      and so is a section too long for a GitHub release body. Its only parent is <sha>.
 *      `changelog-section.ts v<version>` must print a non-empty section from the new tree.
 *   6. The bump commit is pushed to a NEW branch `release/v<version>`, never to master. The owner
 *      merges it afterwards. There is no CI wait on it.
 *   7. Annotated tag `v<version>` on the bump commit, pushed.
 *   8. `release.yml`'s run for the tag is waited for, then the release must be a draft for the tag.
 *   9. The control app is uploaded to the draft, and one line naming its version and sha256 is
 *      appended to the draft's body. `isDraft` is re-checked before each mutating gh call.
 *  10. The draft URL, and a reminder that publishing is the owner's click.
 *
 * `--dry-run` runs every read-only check for real and replaces every mutating call (commit, tag,
 * push, dispatch, upload, edit) with a log line. It still makes and removes the temporary worktree
 * and builds the control app there, since neither leaves the machine.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// `/` on every OS (Windows takes it too), so the paths talk-cut builds, and its tests' call
// sequence, do not depend on the platform the cut runs on.
import { join } from "node:path/posix";
import { parseArgs } from "node:util";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { sectionFor } from "./changelog-section.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Deps {
  run(cmd: string, args: readonly string[], opts?: { cwd?: string }): RunResult;
  now(): Date;
  sleep(ms: number): Promise<void>;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  readBytes(path: string): Uint8Array;
  /** A new, empty directory. */
  tempDir(): string;
  removeDir(path: string): void;
  log(line: string): void;
}

export interface Options {
  sha: string;
  /** Omitted: the next prerelease of <sha>'s package.json version. */
  version?: string;
  /** A file whose content becomes the new version's changelog section (only when Unreleased is empty). */
  notes?: string;
  dryRun: boolean;
  /** The caller's checkout: git runs here, and the temporary worktree is added from it. */
  repo: string;
  /** Directory holding `alc`. */
  alcDir: string;
  /** Symbols for the control app compile (`/packagecachepath`). */
  packageCache: string;
}

/** A rule said no. Nothing after it ran. */
export class TalkCutRefusedError extends Error {}
/** A command failed where the script expected it to work. */
export class CommandFailedError extends Error {}

export const MIN_CONTROL = "1.0.0.23";
export const WAIT_TIMEOUT_MS = 60 * 60_000;
export const POLL_MS = 30_000;
/** GitHub's limit on a release body, in characters. */
export const RELEASE_BODY_LIMIT = 125_000;
/**
 * What `publish` adds to the changelog section: release.yml's footer (about 1,250 characters with
 * the longer signing sentence, counted 2026-10-22), the control-app line talk-cut appends (about
 * 130), and GitHub's generated commit list (about 5,000, a guess).
 */
export const RELEASE_BODY_MARGIN = 1_500 + 200 + 5_000;
const CI_JOBS = ["check", "unit-linux"] as const;
const SHA = /^[0-9a-f]{40}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const CO_AUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const BOM = /^﻿/;

/** The calls that change something outside this machine's temp dirs. `--dry-run` never makes one. */
export function isMutating(cmd: string, args: readonly string[]): boolean {
  if (cmd === "git") return args.some((a) => a === "commit" || a === "tag" || a === "push");
  if (cmd === "gh") {
    const [a, b] = args;
    return (a === "release" && b !== "list" && b !== "view") || (a === "workflow" && b === "run");
  }
  return false;
}

/**
 * A git push may only be `push origin <src>:<dest>` with dest one of the three refs talk-cut owns,
 * or `push origin --delete <trial branch>`. Anything else (master, another remote, --all) throws.
 */
export function assertPushTarget(args: readonly string[], tag: string, trialBranch: string): void {
  const at = args.indexOf("push");
  const rest = args.slice(at + 1);
  const trialRef = `refs/heads/${trialBranch}`;
  const allowed = [`refs/heads/release/${tag}`, `refs/tags/${tag}`, trialRef];
  const [remote, a, b] = rest;
  const ok =
    at >= 0 &&
    remote === "origin" &&
    ((rest.length === 2 &&
      a !== undefined &&
      a.includes(":") &&
      allowed.includes(a.slice(a.indexOf(":") + 1))) ||
      (rest.length === 3 && a === "--delete" && b === trialRef));
  if (!ok) throw new Error(`internal: refusing to push ${args.join(" ")}`);
}

/** A dispatch may only be `workflow run release.yml --ref <trial branch>`: never a tag or master. */
export function assertTrialRef(args: readonly string[], trialBranch: string): void {
  const ok =
    args.length === 5 &&
    args[0] === "workflow" &&
    args[1] === "run" &&
    args[2] === "release.yml" &&
    args[3] === "--ref" &&
    args[4] === trialBranch;
  if (!ok) throw new Error(`internal: refusing to dispatch ${args.join(" ")}`);
}

/** Refuses a changelog section that, with what `publish` adds, would not fit a release body. */
export function checkReleaseBodySize(section: string): void {
  const total = section.length + RELEASE_BODY_MARGIN;
  if (total > RELEASE_BODY_LIMIT) {
    throw new TalkCutRefusedError(
      `the release body would be about ${total} characters (changelog section ${section.length} + margin ${RELEASE_BODY_MARGIN}), over GitHub's ${RELEASE_BODY_LIMIT} limit: shorten [Unreleased] on master, or see R662`,
    );
  }
}

/** 0.1.0-alpha.3 -> 0.1.0-alpha.4. Refuses a version with no numeric prerelease tail. */
export function nextPrerelease(v: string): string {
  const m = /^(\d+\.\d+\.\d+-[0-9A-Za-z-]+)\.(\d+)$/.exec(v);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new TalkCutRefusedError(`${v} has no numeric prerelease tail to bump: pass --version`);
  }
  return `${m[1]}.${Number(m[2]) + 1}`;
}

/** Four-part BC version compare: <0, 0, >0. */
export function compareAppVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** package.json with only the version line changed; refuses anything but a one-line diff. */
export function bumpPackageJson(text: string, from: string, to: string): string {
  const line = `"version": "${from}"`;
  if (text.split(line).length !== 2) {
    throw new TalkCutRefusedError(`package.json does not hold exactly one ${line}`);
  }
  const out = text.replace(line, `"version": "${to}"`);
  const a = text.split("\n");
  const b = out.split("\n");
  const changed = a.filter((l, i) => l !== b[i]).length;
  if (a.length !== b.length || changed !== 1) {
    throw new TalkCutRefusedError(`package.json bump is a ${changed}-line diff, expected 1`);
  }
  return out;
}

export const emptyUnreleasedHint = (version: string) =>
  `CHANGELOG.md's [Unreleased] section is empty: write it, or pass --notes <file>, whose content becomes the v${version} section`;

/** CHANGELOG.md with [Unreleased] cut into [version] (its body, or `notes`) under a new empty one. */
export function cutChangelog(
  text: string,
  version: string,
  date: string,
  notes: string | undefined,
): string {
  const lines = text.split("\n");
  const at = lines.flatMap((l, i) => (l.trimEnd() === "## [Unreleased]" ? [i] : []));
  if (at.length !== 1 || at[0] === undefined) {
    throw new TalkCutRefusedError(
      `CHANGELOG.md has ${at.length} "## [Unreleased]" headings, expected 1`,
    );
  }
  const i = at[0];
  const heading = `## [${version}] — ${date}`;
  const unreleased = sectionFor(text, "Unreleased");
  if (notes === undefined) {
    if (unreleased === null) throw new TalkCutRefusedError(emptyUnreleasedHint(version));
    return [...lines.slice(0, i + 1), "", heading, ...lines.slice(i + 1)].join("\n");
  }
  if (unreleased !== null) {
    throw new TalkCutRefusedError(
      "--notes was given but [Unreleased] is not empty: two accounts of one release, pick one",
    );
  }
  if (notes.trim() === "") throw new TalkCutRefusedError("--notes file is empty");
  // The empty Unreleased block (heading plus blank lines) stays; the notes go under the new heading.
  const next = lines.findIndex((l, j) => j > i && l.startsWith("## ["));
  const tail = next < 0 ? [] : lines.slice(next);
  return [...lines.slice(0, i + 1), "", heading, "", notes.trim(), "", ...tail].join("\n");
}

function must(d: Deps, cmd: string, args: readonly string[], cwd: string): string {
  const r = d.run(cmd, args, { cwd });
  if (r.code !== 0) {
    throw new CommandFailedError(`${cmd} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

function json<T>(d: Deps, cmd: string, args: readonly string[], cwd: string): T {
  return JSON.parse(must(d, cmd, args, cwd)) as T;
}

interface Run {
  databaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  headBranch?: string;
  createdAt: string;
  url?: string;
}

interface Release {
  tagName: string;
  isDraft: boolean;
  url: string;
  body: string;
}

export async function talkCut(o: Options, d: Deps): Promise<{ url: string | null }> {
  const refuse = (m: string): never => {
    throw new TalkCutRefusedError(m);
  };
  if (!SHA.test(o.sha)) refuse(`${o.sha} is not a full 40-hex sha`);
  const sha = o.sha;
  const sha12 = sha.slice(0, 12);
  const trialBranch = `release-trial/${sha12}`;
  let tag = "";
  const git = (args: readonly string[], cwd = o.repo) => must(d, "git", args, cwd);

  /** Mutating calls go through here only: a log line under --dry-run. */
  const mutate = (cmd: string, args: readonly string[], cwd = o.repo): string => {
    if (!isMutating(cmd, args))
      throw new Error(`internal: ${cmd} ${args.join(" ")} is not mutating`);
    if (cmd === "git" && args.includes("push")) assertPushTarget(args, tag, trialBranch);
    if (cmd === "gh" && args[0] === "workflow") assertTrialRef(args, trialBranch);
    if (o.dryRun) {
      d.log(`  dry-run: would run ${cmd} ${args.join(" ")}`);
      return "";
    }
    return must(d, cmd, args, cwd);
  };

  // 1. CI green on <sha>.
  if (d.run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: o.repo }).code !== 0) {
    refuse(`${sha} is not in the local repository: git fetch origin, then retry`);
  }
  const remote = d.run("gh", ["api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", ".sha"], {
    cwd: o.repo,
  });
  if (remote.code !== 0 || remote.stdout.trim() !== sha) refuse(`${sha} is not on origin`);
  const ci = json<Run[]>(
    d,
    "gh",
    [
      "run",
      "list",
      "--commit",
      sha,
      "--workflow",
      "ci.yml",
      "--limit",
      "50",
      "--json",
      "databaseId,status,conclusion,headSha,createdAt",
    ],
    o.repo,
  )
    .filter((r) => r.headSha === sha)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = ci[0];
  if (latest === undefined) refuse(`no ci.yml run for ${sha}`);
  else {
    if (latest.status !== "completed")
      refuse(`ci.yml run ${latest.databaseId} is ${latest.status}, not completed`);
    if (latest.conclusion !== "success")
      refuse(`ci.yml run ${latest.databaseId} concluded ${latest.conclusion}`);
    const { jobs } = json<{ jobs: { name: string; conclusion: string }[] }>(
      d,
      "gh",
      ["run", "view", String(latest.databaseId), "--json", "jobs"],
      o.repo,
    );
    for (const name of CI_JOBS) {
      const job = jobs.find((j) => j.name === name);
      if (job === undefined) refuse(`ci.yml run ${latest.databaseId} has no job ${name}`);
      else if (job.conclusion !== "success")
        refuse(`ci.yml run ${latest.databaseId} job ${name} concluded ${job.conclusion}`);
    }
    d.log(`[1/10] CI green on ${sha}: ci.yml run ${latest.databaseId}, jobs ${CI_JOBS.join(", ")}`);
  }

  const current = (JSON.parse(git(["show", `${sha}:package.json`])) as { version: string }).version;
  const version = o.version ?? nextPrerelease(current);
  if (!SEMVER.test(version)) refuse(`--version ${version} is not valid semver`);
  if (Bun.semver.order(version, current) !== 1) refuse(`${version} is not greater than ${current}`);
  tag = `v${version}`;

  // 2. No tag and no release for it.
  if (
    d.run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: o.repo }).code === 0
  ) {
    refuse(`tag ${tag} exists locally`);
  }
  if (git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "")
    refuse(`tag ${tag} exists on origin`);
  const releases = json<{ tagName: string; isDraft: boolean }[]>(
    d,
    "gh",
    ["release", "list", "--limit", "1000", "--json", "tagName,isDraft"],
    o.repo,
  );
  const clash = releases.find((r) => r.tagName === tag);
  if (clash !== undefined)
    refuse(`a release for ${tag} exists (draft: ${clash.isDraft}); it is left untouched`);
  d.log(`[2/10] ${tag} is free: no local or origin tag, no release (${current} -> ${version})`);

  const tmp = d.tempDir();
  const wt = join(tmp, "tree");
  let added = false;
  try {
    git(["worktree", "add", "--detach", wt, sha]);
    added = true;

    // 3. Control app, built from <sha> before anything is pushed.
    const ctl = join(wt, "extensions", "lethal-control");
    const app = join(tmp, "lethal-control.app");
    must(
      d,
      join(o.alcDir, "alc"),
      [`/project:${ctl}`, `/packagecachepath:${o.packageCache}`, `/out:${app}`],
      wt,
    );
    const bytes = d.readBytes(app);
    const id = readAppIdentity(Buffer.from(bytes));
    const declared = (
      JSON.parse(d.readText(join(ctl, "app.json")).replace(BOM, "")) as { version: string }
    ).version;
    if (id.name !== "LethAL Control") refuse(`built app is ${id.name}, not LethAL Control`);
    if (id.version !== declared)
      refuse(`built control app is ${id.version}, app.json says ${declared}`);
    if (compareAppVersion(id.version, MIN_CONTROL) < 0)
      refuse(`control app ${id.version} is below ${MIN_CONTROL}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    d.log(`[3/10] control app ${id.version} built from ${sha} (sha256 ${sha256})`);

    // 4. release.yml trial on exactly <sha>.
    if (git(["ls-remote", "--heads", "origin", `refs/heads/${trialBranch}`]).trim() !== "") {
      refuse(`branch ${trialBranch} exists on origin: a trial is running or was left behind`);
    }
    const trialRuns = () =>
      listRuns(d, o.repo, [
        "--workflow",
        "release.yml",
        "--event",
        "workflow_dispatch",
        "--commit",
        sha,
      ]);
    const dispatchedBefore = new Set(trialRuns().map((r) => r.databaseId));
    mutate("git", ["push", "origin", `${sha}:refs/heads/${trialBranch}`]);
    try {
      mutate("gh", ["workflow", "run", "release.yml", "--ref", trialBranch]);
      if (o.dryRun) d.log(`[4/10] dry-run: would wait for the release.yml trial on ${trialBranch}`);
      else {
        const trial = await waitForRun(d, "release.yml trial", () =>
          trialRuns().find((r) => r.headSha === sha && !dispatchedBefore.has(r.databaseId)),
        );
        d.log(`[4/10] release.yml trial green on ${sha}: run ${trial.databaseId}`);
      }
    } finally {
      // A failed delete must not hide why the trial stopped; it is logged by name instead.
      try {
        mutate("git", ["push", "origin", "--delete", `refs/heads/${trialBranch}`]);
      } catch (e) {
        d.log(
          `  could not delete trial branch ${trialBranch} on origin: ${e instanceof Error ? e.message : String(e)}. Delete it by hand.`,
        );
      }
    }

    // 5. Bump commit, in the same worktree.
    const pkgPath = join(wt, "package.json");
    d.writeText(pkgPath, bumpPackageJson(d.readText(pkgPath), current, version));
    const clPath = join(wt, "CHANGELOG.md");
    const date = d.now().toISOString().slice(0, 10);
    const notes = o.notes === undefined ? undefined : d.readText(o.notes);
    const changelog = cutChangelog(d.readText(clPath), version, date, notes);
    // The release body is this section; a later body-file option would check its own text here.
    checkReleaseBodySize(sectionFor(changelog, version) ?? "");
    d.writeText(clPath, changelog);
    let bump = "(dry-run)";
    mutate("git", [
      "-C",
      wt,
      "commit",
      "-q",
      "-m",
      `release: ${tag}\n\n${CO_AUTHOR}`,
      "--",
      "package.json",
      "CHANGELOG.md",
    ]);
    if (!o.dryRun) {
      bump = git(["rev-parse", "HEAD"], wt).trim();
      const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], wt)
        .trim()
        .split(" ")
        .slice(1);
      if (parents.length !== 1 || parents[0] !== sha)
        refuse(`bump commit's parents are ${parents.join(",")}, expected ${sha}`);
      const changed = git(["diff", "--numstat", sha, "HEAD", "--", "package.json"], wt).trim();
      if (changed !== "1\t1\tpackage.json")
        refuse(`package.json diff is "${changed}", expected one line`);
    }
    const section = d.run("bun", ["scripts/changelog-section.ts", tag], { cwd: wt });
    if (section.code !== 0 || section.stdout.trim() === "")
      refuse(`changelog-section.ts ${tag} printed no section: ${section.stderr.trim()}`);
    d.log(
      `[5/10] bump commit ${bump} on ${sha}: package.json ${version}, CHANGELOG [${version}] — ${date}`,
    );

    // 6. Push the bump to a new branch.
    const branch = `release/${tag}`;
    if (
      d.run("git", ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: o.repo })
        .code === 0
    )
      refuse(`branch ${branch} exists locally`);
    if (git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim() !== "")
      refuse(`branch ${branch} exists on origin`);
    mutate("git", ["-C", wt, "push", "origin", `HEAD:refs/heads/${branch}`]);
    d.log(`[6/10] pushed ${bump} to ${branch} (not master: the owner merges it)`);

    // 7. Tag.
    mutate("git", ["-C", wt, "tag", "-a", tag, "-m", tag, "HEAD"]);
    mutate("git", ["-C", wt, "push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    d.log(`[7/10] tagged ${bump} ${tag} and pushed it`);

    // 8. release.yml for the tag, then the draft.
    const draft = async (): Promise<Release> => {
      const r = json<Release>(
        d,
        "gh",
        ["release", "view", tag, "--json", "tagName,isDraft,url,body"],
        o.repo,
      );
      if (r.tagName !== tag) refuse(`release view ${tag} answered tag ${r.tagName}`);
      if (r.isDraft !== true) refuse(`the release for ${tag} is not a draft; it is left untouched`);
      return r;
    };
    let url: string | null = null;
    if (o.dryRun)
      d.log(`[8/10] dry-run: would wait for release.yml on ${tag}, then require a draft`);
    else {
      // A tag push may report the commit or the tag object as its head sha; the branch is the tag.
      const run = await waitForRun(d, `release.yml on ${tag}`, () =>
        listRuns(d, o.repo, ["--workflow", "release.yml", "--branch", tag]).find(
          (r) => r.headSha === bump || r.headBranch === tag,
        ),
      );
      url = (await draft()).url;
      d.log(`[8/10] release.yml run ${run.databaseId} green; draft ${url}`);
    }

    // 9. Attach the control app built in step 3.
    if (!o.dryRun) await draft();
    mutate("gh", ["release", "upload", tag, app]);
    const line = `**lethal-control.app:** LethAL Control ${id.version}, sha256 \`${sha256}\`.`;
    const notesFile = join(tmp, "release-body.md");
    if (!o.dryRun) {
      d.writeText(notesFile, `${(await draft()).body.trimEnd()}\n\n${line}\n`);
      await draft();
    }
    mutate("gh", ["release", "edit", tag, "--notes-file", notesFile]);
    d.log(`[9/10] control app ${id.version} attached, body line appended`);

    // 10.
    d.log(
      `[10/10] draft: ${url ?? "(dry-run, none)"}. Publishing it is the owner's click; this script never publishes.`,
    );
    return { url };
  } finally {
    if (added) d.run("git", ["worktree", "remove", "--force", wt], { cwd: o.repo });
    d.removeDir(tmp);
  }
}

function listRuns(d: Deps, repo: string, filter: readonly string[]): Run[] {
  return json<Run[]>(
    d,
    "gh",
    [
      "run",
      "list",
      ...filter,
      "--limit",
      "50",
      "--json",
      "databaseId,status,conclusion,headSha,headBranch,createdAt,url",
    ],
    repo,
  );
}

/** Poll until `find` returns a completed run; refuse a non-success conclusion or the timeout. */
async function waitForRun(d: Deps, label: string, find: () => Run | undefined): Promise<Run> {
  const deadline = d.now().getTime() + WAIT_TIMEOUT_MS;
  for (;;) {
    const r = find();
    if (r !== undefined && r.status === "completed") {
      if (r.conclusion !== "success")
        throw new TalkCutRefusedError(`${label}: run ${r.databaseId} concluded ${r.conclusion}`);
      return r;
    }
    if (d.now().getTime() >= deadline) {
      throw new TalkCutRefusedError(
        `${label}: not completed after ${WAIT_TIMEOUT_MS / 60_000} min`,
      );
    }
    await d.sleep(POLL_MS);
  }
}

export const realDeps: Deps = {
  run(cmd, args, opts) {
    const r = Bun.spawnSync([cmd, ...args], {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  },
  now: () => new Date(),
  sleep: (ms) => Bun.sleep(ms),
  readText: (p) => readFileSync(p, "utf8"),
  writeText: (p, t) => writeFileSync(p, t),
  readBytes: (p) => readFileSync(p),
  tempDir: () => mkdtempSync(join(tmpdir(), "talk-cut-")),
  removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  log: (l) => console.log(l),
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      notes: { type: "string" },
      "package-cache": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const [sha, extra] = positionals;
  if (sha === undefined || extra !== undefined) {
    throw new Error(
      "usage: bun scripts/talk-cut.ts <sha> [--version <v>] [--notes <file>] [--package-cache <dir>] [--dry-run]",
    );
  }
  const repo = resolve(import.meta.dir, "..");
  const alcDir = process.env.LETHAL_ALC_DIR;
  if (alcDir === undefined || alcDir === "")
    throw new Error("talk-cut: LETHAL_ALC_DIR is unset (the directory holding alc)");
  const packageCache = resolve(
    values["package-cache"] ?? join(repo, "extensions", "lethal-control", ".alpackages"),
  );
  if (!existsSync(packageCache)) {
    throw new Error(
      `talk-cut: no control-app symbols at ${packageCache}: pass --package-cache <dir> (the main checkout's extensions/lethal-control/.alpackages has them)`,
    );
  }
  await talkCut(
    {
      sha,
      ...(values.version !== undefined ? { version: values.version } : {}),
      ...(values.notes !== undefined ? { notes: resolve(values.notes) } : {}),
      dryRun: values["dry-run"] === true,
      repo,
      alcDir,
      packageCache,
    },
    realDeps,
  );
}
