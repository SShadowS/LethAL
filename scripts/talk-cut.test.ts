import { describe, expect, test } from "bun:test";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import { sectionFor } from "./changelog-section.ts";
import {
  type Deps,
  type Options,
  POLL_MS,
  RELEASE_BODY_LIMIT,
  RELEASE_BODY_MARGIN,
  type RunResult,
  TalkCutRefusedError,
  WAIT_TIMEOUT_MS,
  assertPushTarget,
  assertTrialRef,
  bumpPackageJson,
  checkReleaseBodySize,
  compareAppVersion,
  emptyUnreleasedHint,
  nextPrerelease,
  talkCut,
} from "./talk-cut.ts";

/**
 * R662. Every git, gh, alc, bun and file effect goes through a stateful fake: no network, no
 * /coord, no real worktree. The fake answers the way GitHub and git would, and keeps a call log.
 */
const SHA = "a".repeat(40);
const BUMP = "b".repeat(40);
const TMP = "/fake/tmp";
const WT = `${TMP}/tree`;
const REPO = "/fake/repo";
const PKG = `{
  "name": "lethal",
  "version": "0.1.0-alpha.3",
  "private": true,
  "devDependencies": {
    "x": "^1.0.0"
  }
}
`;
const CHANGELOG = `# Changelog

intro

## [Unreleased]

### Added

- a thing (R1)

## [0.1.0-alpha.3] — 2026-08-27

old notes
`;
const EMPTY_CHANGELOG = CHANGELOG.replace("### Added\n\n- a thing (R1)\n\n", "");

const appJson = (v: string) => `﻿{ "name": "LethAL Control", "version": "${v}" }`;
const appPkg = (v: string, name = "LethAL Control") =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="x" Name="${name}" Publisher="LethAL" Version="${v}" /></Package>`,
  });

interface Run {
  databaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  headBranch?: string;
  createdAt: string;
}
interface Release {
  tagName: string;
  isDraft: boolean;
  url: string;
  body: string;
}

class World {
  calls: string[] = [];
  logs: string[] = [];
  clock = Date.parse("2026-10-23T10:00:00Z");
  ciRuns: Run[] = [
    {
      databaseId: 1,
      status: "completed",
      conclusion: "success",
      headSha: SHA,
      createdAt: "2026-10-22T09:00:00Z",
    },
  ];
  jobs: { name: string; conclusion: string }[] = [
    { name: "check", conclusion: "success" },
    { name: "unit-linux", conclusion: "success" },
  ];
  localTags = new Set<string>();
  localBranches = new Set<string>();
  originRefs = new Set<string>();
  releases: Release[] = [
    { tagName: "v0.1.0-alpha.3", isDraft: true, url: "https://x/alpha3", body: "alpha3" },
  ];
  trialRuns: Run[] = [];
  releaseRuns: Run[] = [];
  trialConclusion = "success";
  trialCompletes = true;
  releaseConclusion = "success";
  releaseIsDraft = true;
  /** The head sha the tag's release.yml run reports (GitHub may give the tag object's). */
  releaseRunSha = BUMP;
  deleteFails = false;
  worktreeAddFails = false;
  parent = SHA;
  appVersion = "1.0.0.23";
  appName = "LethAL Control";
  declaredVersion = "1.0.0.23";
  changelog = CHANGELOG;
  files = new Map<string, string>();
  uploads: string[] = [];

  deps(): Deps {
    return {
      run: (cmd, args, opts) => this.run(cmd, args, opts?.cwd),
      now: () => new Date(this.clock),
      sleep: async (ms) => {
        this.clock += ms;
      },
      readText: (p) => {
        const t = this.files.get(p);
        if (t === undefined) throw new Error(`fake: no file ${p}`);
        return t;
      },
      writeText: (p, t) => {
        this.files.set(p, t);
      },
      readBytes: (p) => {
        if (p !== `${TMP}/lethal-control.app`) throw new Error(`fake: no bytes ${p}`);
        return appPkg(this.appVersion, this.appName);
      },
      tempDir: () => TMP,
      removeDir: (p) => {
        this.calls.push(`rmdir ${p}`);
      },
      log: (l) => {
        this.logs.push(l);
      },
    };
  }

  private run(cmd: string, a: readonly string[], cwd: string | undefined): RunResult {
    const line = `${cmd} ${a.join(" ")}`;
    this.calls.push(line);
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    const no: RunResult = { code: 1, stdout: "", stderr: "no" };
    const args = a[0] === "-C" ? a.slice(2) : a;
    const s = args.join(" ");
    if (cmd === "git") {
      if (args[0] === "cat-file") return ok();
      if (args[0] === "show" && args[1] === `${SHA}:package.json`) return ok(PKG);
      if (args[0] === "rev-parse" && args[1] === "-q") {
        const ref = args[3] ?? "";
        const has = ref.startsWith("refs/tags/")
          ? this.localTags.has(ref.slice(10))
          : this.localBranches.has(ref.slice(11));
        return has ? ok(BUMP) : no;
      }
      if (args[0] === "ls-remote")
        return ok(this.originRefs.has(args[3] ?? "") ? `x\t${args[3]}\n` : "");
      if (args[0] === "push" && args[2] === "--delete") {
        if (this.deleteFails) return no;
        this.originRefs.delete(args[3] ?? "");
        return ok();
      }
      if (args[0] === "push") {
        const spec = args[2] ?? "";
        const dest = spec.slice(spec.indexOf(":") + 1);
        this.originRefs.add(dest);
        if (dest.startsWith("refs/tags/")) {
          const tag = dest.slice(10);
          this.releaseRuns.push({
            databaseId: 700,
            status: "completed",
            conclusion: this.releaseConclusion,
            headSha: this.releaseRunSha,
            headBranch: tag,
            createdAt: "z",
          });
          this.releases.push({
            tagName: tag,
            isDraft: this.releaseIsDraft,
            url: `https://x/${tag}`,
            body: "generated notes\n",
          });
        }
        return ok();
      }
      if (args[0] === "worktree" && args[1] === "add") {
        if (this.worktreeAddFails) return no;
        this.files.set(`${WT}/package.json`, PKG);
        this.files.set(`${WT}/CHANGELOG.md`, this.changelog);
        this.files.set(`${WT}/extensions/lethal-control/app.json`, appJson(this.declaredVersion));
        return ok();
      }
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "commit") return ok();
      if (s === "rev-parse HEAD") return ok(`${BUMP}\n`);
      if (s === "rev-list --parents -n 1 HEAD") return ok(`${BUMP} ${this.parent}\n`);
      if (args[0] === "diff" && args[1] === "--numstat") {
        const before = PKG.split("\n");
        const after = (this.files.get(`${WT}/package.json`) ?? "").split("\n");
        const n = after.filter((l, i) => l !== before[i]).length;
        return ok(`${n}\t${n}\tpackage.json\n`);
      }
      if (args[0] === "tag") {
        this.localTags.add(args[2] ?? "");
        return ok();
      }
    }
    if (cmd === "gh") {
      if (args[0] === "api") return ok(`${SHA}\n`);
      if (s.startsWith("run list") && s.includes("ci.yml")) return ok(JSON.stringify(this.ciRuns));
      if (s.startsWith("run view 1 --json jobs")) return ok(JSON.stringify({ jobs: this.jobs }));
      if (s.startsWith("run list") && s.includes("workflow_dispatch"))
        return ok(JSON.stringify(this.trialRuns));
      if (s.startsWith("run list") && s.includes("--branch"))
        return ok(JSON.stringify(this.releaseRuns));
      if (s.startsWith("workflow run")) {
        this.trialRuns.push({
          databaseId: 500,
          status: this.trialCompletes ? "completed" : "in_progress",
          conclusion: this.trialCompletes ? this.trialConclusion : "",
          headSha: SHA,
          createdAt: "y",
        });
        return ok();
      }
      if (s.startsWith("release list")) return ok(JSON.stringify(this.releases));
      if (args[0] === "release" && args[1] === "view") {
        const r = this.releases.find((x) => x.tagName === args[2]);
        return r === undefined ? no : ok(JSON.stringify(r));
      }
      if (args[0] === "release" && args[1] === "upload") {
        this.uploads.push(args[3] ?? "");
        return ok();
      }
      if (args[0] === "release" && args[1] === "edit") {
        const r = this.releases.find((x) => x.tagName === args[2]);
        const body = this.files.get(args[4] ?? "");
        if (r === undefined || body === undefined) return no;
        r.body = body;
        return ok();
      }
    }
    if (cmd === "bun" && args[0] === "scripts/changelog-section.ts" && cwd === WT) {
      const section = sectionFor(this.files.get(`${WT}/CHANGELOG.md`) ?? "", args[1] ?? "");
      return section === null ? no : ok(`${section}\n`);
    }
    if (cmd === "/alc/alc") return ok();
    throw new Error(`fake: unexpected call ${line}`);
  }

  mutating(): string[] {
    return this.calls.filter((c) =>
      /^git (-C \S+ )?(push|commit|tag) |^gh workflow run|^gh release (upload|edit|create|delete)/.test(
        c,
      ),
    );
  }
  pushDests(): string[] {
    return this.calls
      .filter((c) => /^git (-C \S+ )?push /.test(c))
      .map((c) => {
        const spec = c.split(" ").at(-1) ?? "";
        return spec.slice(spec.indexOf(":") + 1);
      });
  }
}

const opts = (o: Partial<Options> = {}): Options => ({
  sha: SHA,
  dryRun: false,
  repo: REPO,
  alcDir: "/alc",
  packageCache: "/cache",
  ...o,
});

async function refusal(w: World, o: Partial<Options> = {}): Promise<string> {
  try {
    await talkCut(opts(o), w.deps());
  } catch (e) {
    if (e instanceof TalkCutRefusedError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

const TRIAL = "release-trial/aaaaaaaaaaaa";
const TAG = "v0.1.0-alpha.4";

describe("talk-cut happy path", () => {
  test("exact call sequence, one-line bump, parent is <sha>, a draft with the app and its line", async () => {
    const w = new World();
    const { url } = await talkCut(opts(), w.deps());
    expect(url).toBe(`https://x/${TAG}`);
    const fields = "databaseId,status,conclusion,headSha,headBranch,createdAt,url";
    expect(w.calls).toEqual([
      `git cat-file -e ${SHA}^{commit}`,
      `gh api repos/{owner}/{repo}/commits/${SHA} --jq .sha`,
      `gh run list --commit ${SHA} --workflow ci.yml --limit 50 --json databaseId,status,conclusion,headSha,createdAt`,
      "gh run view 1 --json jobs",
      `git show ${SHA}:package.json`,
      `git rev-parse -q --verify refs/tags/${TAG}`,
      `git ls-remote --tags origin refs/tags/${TAG}`,
      "gh release list --limit 1000 --json tagName,isDraft",
      `git worktree add --detach ${WT} ${SHA}`,
      `/alc/alc /project:${WT}/extensions/lethal-control /packagecachepath:/cache /out:${TMP}/lethal-control.app`,
      `git ls-remote --heads origin refs/heads/${TRIAL}`,
      `gh run list --workflow release.yml --event workflow_dispatch --commit ${SHA} --limit 50 --json ${fields}`,
      `git push origin ${SHA}:refs/heads/${TRIAL}`,
      `gh workflow run release.yml --ref ${TRIAL}`,
      `gh run list --workflow release.yml --event workflow_dispatch --commit ${SHA} --limit 50 --json ${fields}`,
      `git push origin --delete refs/heads/${TRIAL}`,
      `git -C ${WT} commit -q -m release: ${TAG}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com> -- package.json CHANGELOG.md`,
      "git rev-parse HEAD",
      "git rev-list --parents -n 1 HEAD",
      `git diff --numstat ${SHA} HEAD -- package.json`,
      `bun scripts/changelog-section.ts ${TAG}`,
      `git rev-parse -q --verify refs/heads/release/${TAG}`,
      `git ls-remote --heads origin refs/heads/release/${TAG}`,
      `git -C ${WT} push origin HEAD:refs/heads/release/${TAG}`,
      `git -C ${WT} tag -a ${TAG} -m ${TAG} HEAD`,
      `git -C ${WT} push origin refs/tags/${TAG}:refs/tags/${TAG}`,
      `gh run list --workflow release.yml --branch ${TAG} --limit 50 --json ${fields}`,
      `gh release view ${TAG} --json tagName,isDraft,url,body`,
      `gh release view ${TAG} --json tagName,isDraft,url,body`,
      `gh release upload ${TAG} ${TMP}/lethal-control.app`,
      `gh release view ${TAG} --json tagName,isDraft,url,body`,
      `gh release view ${TAG} --json tagName,isDraft,url,body`,
      `gh release edit ${TAG} --notes-file ${TMP}/release-body.md`,
      `git worktree remove --force ${WT}`,
      `rmdir ${TMP}`,
    ]);
    // package.json: exactly one line changed, to the new version.
    const pkg = w.files.get(`${WT}/package.json`) ?? "";
    expect(pkg).toBe(PKG.replace('"version": "0.1.0-alpha.3"', '"version": "0.1.0-alpha.4"'));
    // CHANGELOG: a fresh empty Unreleased above the new section, in the file's em-dash convention.
    const cl = w.files.get(`${WT}/CHANGELOG.md`) ?? "";
    expect(cl).toContain(
      "## [Unreleased]\n\n## [0.1.0-alpha.4] — 2026-10-23\n\n### Added\n\n- a thing (R1)",
    );
    expect(sectionFor(cl, "Unreleased")).toBeNull();
    // The draft body gained exactly one line, naming the control-app version and sha256.
    const body = w.releases.find((r) => r.tagName === TAG)?.body ?? "";
    const hash = new Bun.CryptoHasher("sha256").update(appPkg("1.0.0.23")).digest("hex");
    expect(body).toBe(
      `generated notes\n\n**lethal-control.app:** LethAL Control 1.0.0.23, sha256 \`${hash}\`.\n`,
    );
    expect(w.uploads).toEqual([`${TMP}/lethal-control.app`]);
    expect(w.originRefs.has(`refs/heads/${TRIAL}`)).toBe(false); // the trial branch is gone
    expect(w.logs.filter((l) => /^\[\d+\/10\]/.test(l))).toHaveLength(10);
    // The alpha.3 draft was never touched.
    expect(w.releases[0]).toEqual({
      tagName: "v0.1.0-alpha.3",
      isDraft: true,
      url: "https://x/alpha3",
      body: "alpha3",
    });
  });

  test("nothing is ever pushed to master: only the trial, release and tag refs", async () => {
    const w = new World();
    await talkCut(opts(), w.deps());
    expect(w.pushDests()).toEqual([
      `refs/heads/${TRIAL}`,
      `refs/heads/${TRIAL}`,
      `refs/heads/release/${TAG}`,
      `refs/tags/${TAG}`,
    ]);
    expect(w.calls.filter((c) => c.includes("master"))).toEqual([]);
  });

  test("the trial is never dispatched on a v* ref", async () => {
    const w = new World();
    await talkCut(opts(), w.deps());
    const refs = w.calls
      .filter((c) => c.startsWith("gh workflow run"))
      .map((c) => c.split(" ").at(-1));
    expect(refs).toEqual([TRIAL]);
  });

  test("--dry-run makes zero mutating calls, and says what it would do", async () => {
    const w = new World();
    const { url } = await talkCut(opts({ dryRun: true }), w.deps());
    expect(url).toBeNull();
    expect(w.mutating()).toEqual([]);
    expect(w.uploads).toEqual([]);
    expect(w.releases).toHaveLength(1);
    const would = w.logs.filter((l) => l.includes("dry-run: would run"));
    expect(would.map((l) => l.split(" ").slice(5, 7).join(" "))).toEqual([
      "git push",
      "gh workflow",
      "git push",
      "git -C",
      "git -C",
      "git -C",
      "git -C",
      "gh release",
      "gh release",
    ]);
    expect(w.logs.filter((l) => /^\[\d+\/10\]/.test(l))).toHaveLength(10);
  });
});

describe("talk-cut refusals", () => {
  test("a sha that is not 40 hex", async () => {
    expect(await refusal(new World(), { sha: "abc" })).toContain("not a full 40-hex sha");
  });

  test("CI: no run", async () => {
    const w = new World();
    w.ciRuns = [];
    expect(await refusal(w)).toContain("no ci.yml run");
  });

  test("CI: the latest run is in progress, even when an older one passed", async () => {
    const w = new World();
    w.ciRuns.push({
      databaseId: 2,
      status: "in_progress",
      conclusion: "",
      headSha: SHA,
      createdAt: "2026-10-22T10:00:00Z",
    });
    expect(await refusal(w)).toContain("run 2 is in_progress");
  });

  test("CI: the run failed", async () => {
    const w = new World();
    w.ciRuns = [
      { databaseId: 1, status: "completed", conclusion: "failure", headSha: SHA, createdAt: "x" },
    ];
    expect(await refusal(w)).toContain("concluded failure");
  });

  test("CI: one job failed", async () => {
    const w = new World();
    w.jobs = [
      { name: "check", conclusion: "success" },
      { name: "unit-linux", conclusion: "failure" },
    ];
    expect(await refusal(w)).toContain("job unit-linux concluded failure");
    expect(w.mutating()).toEqual([]);
  });

  test("CI: a job is missing", async () => {
    const w = new World();
    w.jobs = [{ name: "unit-linux", conclusion: "success" }];
    expect(await refusal(w)).toContain("has no job check");
  });

  test("tag exists locally", async () => {
    const w = new World();
    w.localTags.add(TAG);
    expect(await refusal(w)).toContain("exists locally");
    expect(w.mutating()).toEqual([]);
  });

  test("tag exists on origin", async () => {
    const w = new World();
    w.originRefs.add(`refs/tags/${TAG}`);
    expect(await refusal(w)).toContain("exists on origin");
  });

  test("a release for the tag exists", async () => {
    const w = new World();
    w.releases.push({ tagName: TAG, isDraft: true, url: "u", body: "" });
    expect(await refusal(w)).toContain(`a release for ${TAG} exists`);
    expect(w.mutating()).toEqual([]);
  });

  test("--version that is not semver, or not greater", async () => {
    expect(await refusal(new World(), { version: "0.1" })).toContain("not valid semver");
    expect(await refusal(new World(), { version: "0.1.0-alpha.3" })).toContain("not greater");
  });

  test("a failed release trial: refused, the trial branch deleted, no bump", async () => {
    const w = new World();
    w.trialConclusion = "failure";
    expect(await refusal(w)).toContain("trial: run 500 concluded failure");
    expect(w.originRefs.has(`refs/heads/${TRIAL}`)).toBe(false);
    expect(w.calls.some((c) => c.includes(" commit "))).toBe(false);
    expect(w.calls.at(-1)).toBe(`rmdir ${TMP}`);
  });

  test("a trial that never completes times out, and the branch is still deleted", async () => {
    const w = new World();
    w.trialCompletes = false;
    const start = w.clock;
    expect(await refusal(w)).toContain("not completed after 60 min");
    expect(w.clock - start).toBeGreaterThanOrEqual(WAIT_TIMEOUT_MS);
    expect(w.clock - start).toBeLessThan(WAIT_TIMEOUT_MS + 2 * POLL_MS);
    expect(w.originRefs.has(`refs/heads/${TRIAL}`)).toBe(false);
  });

  test("an empty Unreleased section, with the --notes hint", async () => {
    const w = new World();
    w.changelog = EMPTY_CHANGELOG;
    expect(await refusal(w)).toBe(emptyUnreleasedHint("0.1.0-alpha.4"));
    expect(w.calls.some((c) => c.includes(" commit ") || c.includes("HEAD:refs/"))).toBe(false);
  });

  test("an empty Unreleased section with --notes: the notes become the section", async () => {
    const w = new World();
    w.changelog = EMPTY_CHANGELOG;
    w.files.set("/notes.md", "### Talk\n\n- demo build\n");
    await talkCut(opts({ notes: "/notes.md" }), w.deps());
    const cl = w.files.get(`${WT}/CHANGELOG.md`) ?? "";
    expect(sectionFor(cl, "0.1.0-alpha.4")).toBe("### Talk\n\n- demo build");
    expect(sectionFor(cl, "Unreleased")).toBeNull();
    expect(sectionFor(cl, "0.1.0-alpha.3")).toBe("old notes");
  });

  test("--notes when Unreleased is not empty is refused", async () => {
    const w = new World();
    w.files.set("/notes.md", "x");
    expect(await refusal(w, { notes: "/notes.md" })).toContain("two accounts of one release");
  });

  test("the bump commit's parent must be <sha>", async () => {
    const w = new World();
    w.parent = "c".repeat(40);
    expect(await refusal(w)).toContain("parents are");
    expect(w.pushDests().filter((d) => d.startsWith("refs/heads/release/"))).toEqual([]);
  });

  test("the release branch already exists", async () => {
    const w = new World();
    w.originRefs.add(`refs/heads/release/${TAG}`);
    expect(await refusal(w)).toContain(`branch release/${TAG} exists on origin`);
  });

  test("a non-draft release for the tag is refused, and nothing is uploaded", async () => {
    const w = new World();
    w.releaseIsDraft = false;
    expect(await refusal(w)).toContain("is not a draft");
    expect(w.uploads).toEqual([]);
    expect(w.calls.some((c) => c.startsWith("gh release edit"))).toBe(false);
  });

  test("a failed release.yml run for the tag is refused before any upload", async () => {
    const w = new World();
    w.releaseConclusion = "failure";
    expect(await refusal(w)).toContain("concluded failure");
    expect(w.uploads).toEqual([]);
  });

  test("a control app below 1.0.0.23 is refused before anything is pushed", async () => {
    const w = new World();
    w.appVersion = "1.0.0.22";
    w.declaredVersion = "1.0.0.22";
    expect(await refusal(w)).toContain("below 1.0.0.23");
    expect(w.mutating()).toEqual([]);
  });

  test("a control app whose manifest disagrees with app.json is refused before any push", async () => {
    const w = new World();
    w.appVersion = "1.0.0.24";
    expect(await refusal(w)).toContain("app.json says 1.0.0.23");
    expect(w.mutating()).toEqual([]);
  });

  test("a built app that is not LethAL Control is refused before any push", async () => {
    const w = new World();
    w.appName = "Something Else";
    expect(await refusal(w)).toContain("not LethAL Control");
    expect(w.mutating()).toEqual([]);
  });

  test("a changelog section too long for a release body is refused before any push", async () => {
    const w = new World();
    const big = `- ${"x".repeat(RELEASE_BODY_LIMIT)}\n`;
    w.changelog = CHANGELOG.replace("- a thing (R1)\n", big);
    const m = await refusal(w);
    expect(m).toContain(`over GitHub's ${RELEASE_BODY_LIMIT} limit`);
    expect(m).toContain("shorten [Unreleased] on master, or see R662");
    expect(w.pushDests().filter((d) => d !== `refs/heads/${TRIAL}`)).toEqual([]);
    expect(w.calls.some((c) => c.includes(" commit "))).toBe(false);
  });

  test("a failed trial-branch delete is logged by name, and the trial's own error goes through", async () => {
    const w = new World();
    w.trialConclusion = "failure";
    w.deleteFails = true;
    expect(await refusal(w)).toContain("trial: run 500 concluded failure");
    expect(w.logs.some((l) => l.includes(`could not delete trial branch ${TRIAL}`))).toBe(true);
  });

  test("the temp dir is removed even when git worktree add fails", async () => {
    const w = new World();
    w.worktreeAddFails = true;
    await expect(talkCut(opts(), w.deps())).rejects.toThrow("worktree add");
    expect(w.calls.at(-1)).toBe(`rmdir ${TMP}`);
    expect(w.calls.some((c) => c.startsWith("git worktree remove"))).toBe(false);
  });

  test("the tag's release.yml run is found by its branch when its head sha is the tag object", async () => {
    const w = new World();
    w.releaseRunSha = "d".repeat(40);
    const { url } = await talkCut(opts(), w.deps());
    expect(url).toBe(`https://x/${TAG}`);
    expect(w.uploads).toHaveLength(1);
  });
});

describe("talk-cut push and dispatch guards", () => {
  const T = TAG;
  const bad: [string, string[]][] = [
    ["HEAD:refs/heads/master", ["push", "origin", "HEAD:refs/heads/master"]],
    ["HEAD:master", ["push", "origin", "HEAD:master"]],
    ["master", ["push", "origin", "master"]],
    ["another remote", ["push", "upstream", `HEAD:refs/heads/release/${T}`]],
    ["--all", ["push", "origin", "--all"]],
    ["deleting another branch", ["push", "origin", "--delete", "refs/heads/master"]],
  ];
  for (const [name, args] of bad) {
    test(`push ${name} throws`, () => {
      expect(() => assertPushTarget(args, T, TRIAL)).toThrow("refusing to push");
    });
  }
  test("the four legitimate pushes are accepted", () => {
    for (const args of [
      ["push", "origin", `${SHA}:refs/heads/${TRIAL}`],
      ["push", "origin", "--delete", `refs/heads/${TRIAL}`],
      ["-C", WT, "push", "origin", `HEAD:refs/heads/release/${T}`],
      ["-C", WT, "push", "origin", `refs/tags/${T}:refs/tags/${T}`],
    ]) {
      expect(() => assertPushTarget(args, T, TRIAL)).not.toThrow();
    }
  });
  for (const ref of [T, `refs/tags/${T}`, "master"]) {
    test(`dispatch with --ref ${ref} throws`, () => {
      expect(() => assertTrialRef(["workflow", "run", "release.yml", "--ref", ref], TRIAL)).toThrow(
        "refusing to dispatch",
      );
    });
  }
  test("the trial dispatch is accepted", () => {
    expect(() =>
      assertTrialRef(["workflow", "run", "release.yml", "--ref", TRIAL], TRIAL),
    ).not.toThrow();
  });
});

describe("talk-cut helpers", () => {
  test("nextPrerelease bumps the numeric tail, and refuses without one", () => {
    expect(nextPrerelease("0.1.0-alpha.3")).toBe("0.1.0-alpha.4");
    expect(nextPrerelease("0.1.0-alpha.9")).toBe("0.1.0-alpha.10");
    expect(() => nextPrerelease("0.1.0")).toThrow(TalkCutRefusedError);
  });

  test("bumpPackageJson changes exactly one line, and refuses an ambiguous file", () => {
    const out = bumpPackageJson(PKG, "0.1.0-alpha.3", "0.1.0-alpha.4");
    const a = PKG.split("\n");
    expect(out.split("\n").filter((l, i) => l !== a[i])).toEqual(['  "version": "0.1.0-alpha.4",']);
    const twice = `${PKG}{"version": "0.1.0-alpha.3"}\n`;
    expect(() => bumpPackageJson(twice, "0.1.0-alpha.3", "0.1.0-alpha.4")).toThrow(
      TalkCutRefusedError,
    );
  });

  test("checkReleaseBodySize: a section that fits passes, one character more is refused", () => {
    const fits = "x".repeat(RELEASE_BODY_LIMIT - RELEASE_BODY_MARGIN);
    expect(() => checkReleaseBodySize(fits)).not.toThrow();
    expect(() => checkReleaseBodySize(`${fits}x`)).toThrow(TalkCutRefusedError);
  });

  test("compareAppVersion is numeric per part", () => {
    expect(compareAppVersion("1.0.0.23", "1.0.0.23")).toBe(0);
    expect(compareAppVersion("1.0.0.9", "1.0.0.23")).toBeLessThan(0);
    expect(compareAppVersion("1.0.1.0", "1.0.0.23")).toBeGreaterThan(0);
  });
});
