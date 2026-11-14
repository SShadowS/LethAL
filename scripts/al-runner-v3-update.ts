/**
 * R586 §12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`, r2 §12 with r3's
 * F6 and r4's I-3): the al-runner v3 update gate, the only al-runner update path since the .NET
 * al-runner (v2) and its update script were retired (R654). Daily, or by hand:
 *
 *   bun scripts/al-runner-v3-update.ts               (the daily run, both tracks, `dailyOnce`)
 *   bun scripts/al-runner-v3-update.ts --regate <lethal commit>
 *   bun scripts/al-runner-v3-update.ts --edge        (the edge track only, `edgeOnce`)
 *   bun scripts/al-runner-v3-update.ts --edge-rejudge <edge sha>   (R639: a KEPT edge binary,
 *                                                     re-gated at `.gated`'s commit, `edgeRejudge`)
 *   bun scripts/al-runner-v3-update.ts --refresh-rows <id>[,<id>...]   (R859: in a BRANCH's
 *                                                     checkout, `refreshRows`; see its comment)
 *
 * Every gate path holds `<root>/.gate.lock` (R639 I3); a run skipped by it exits 2 on `--regate`
 * and `--edge-rejudge`.
 *
 * R859 `--refresh-rows`: when a batch moves a v3 fixture's counts, a hand pin's digest moves and its
 * manifest rows go stale. This re-gates each named row's KEPT binary at the checkout's head by the
 * row's own pin and, only on that row's pass, rewrites that row's `readingsDigest` and
 * `lethalCommit` in the checkout's manifest, leaving a receipt under `<root>/refresh/`. It never
 * commits or pushes, and never writes `gated-builds.published`, `current`, `.gated`, `failed/` or
 * `held/`. It holds the gate lock, so it cannot overlap the daily run. A later daily run cannot
 * undo a refresh: `publishToMaster` adds an id only when master lacks it, and a ledger row for an
 * id already on master is never put back. The one collision left is a text conflict, if the daily
 * run adds a row to master while the branch is open; merge master in and re-run.
 *
 * R813/R814 (owner): two tracks. EDGE moves `current`, only forward (`commitOrder`). A numbered
 * RELEASE never moves `current`: its pass adds it to the gate manifest, which is what users install.
 * R814: a candidate is judged against `current`'s hand pin (`LETHAL_V3_PIN_FROM`, the prediction,
 * committed before the run), so a build whose readings did not move passes with no person. Anything
 * that moved fails the same judges a hand pin fails, and stops here until someone pre-commits it.
 *
 * 1. Release candidates: `v3.0.0-alpha.N` releases of aldevtools/BusinessCentral.AL.Runner with N
 *    above the newest listed one, tried NEWEST first (R586d): the first pass ends the run; anything
 *    else falls back to the next older one.
 * 2. The linux-x64 tarball and SHA256SUMS go into a NEW empty folder; a checksum mismatch is
 *    `infra-fail` and the tarball is NEVER extracted. Extraction goes into another new folder.
 * 3. The gate runs in a detached worktree at `.gated`'s `lethalCommit` (never a moving master), with
 *    `LETHAL_ALRUNNER_V3_CANDIDATE=1`, the CDO corpus and leg T. Its receipt is deleted before the
 *    run and accepted only with this run's nonce AND the candidate's binary sha256. R777: when that
 *    commit predates a leg of this script's `V3_GATE_LEGS`, `current` is first re-gated at this
 *    script's own commit (logged `stale-gated`); if that does not pass, `current` stays and the
 *    candidate is judged at the script's commit. A script commit off origin/master is refused.
 * 4. Outcomes: `pass` -> installed, `.gated` written, its row in the ledger, and on the edge track
 *    `current` moved (unless a process started through `current/` runs, R950: "deferred: in use"); `gate-fail` -> `failed/`
 *    for good; `held` (every difference a move toward BC or a named refusal; read the receipt's
 *    lines) -> `held/`, never blacklisted, a line for the orchestrator to re-pre-commit;
 *    `infra-fail` -> nothing kept, retried next run, a line after 3 in a row.
 * `--regate <commit>`: gate the CURRENT build at a new LethAL commit; on pass `.gated` takes it.
 * The script's ONE commit: `publishToMaster` adds ledger rows to the gated-builds data file (R814),
 * from its own worktree, never forced. A row holds no reading, so it cannot move a verdict.
 * To-do (not v1; serve is out of v1): capture `serve`'s full summary for one edit in the CDO
 * 18-dependency workspace, the measurement #5614 lacks (R586's defect table, row 14).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import {
  type V3LegOutcome,
  V3_GATE_LEGS,
  gateOutcome,
} from "../packages/runner/itest/al-runner-v3-gate";
import { prepareFixtureSymbols } from "../packages/runner/itest/fixture-symbols";
import {
  type GatedBuild,
  V3_PIN_FROM_ENV,
  parseGated,
  sha256OfFile,
  warnFactReadings,
} from "../packages/runner/src/al-runner-v3-pin";
import {
  type GatedBuildEntry,
  V3_BUILD_PINS,
  alphaOfEntry,
  findV3Pin,
  gatedBuilds,
  handV3Pin,
  parseGatedBuilds,
  v3ReadingsDigest,
} from "../packages/runner/src/al-runner-v3-pins";
import {
  type Proc,
  READER,
  SLOTS,
  SLOT_BUSY,
  WATCHER,
  descendants,
  lockDir,
  parsePs,
} from "./corpus-snapshot";
import { checkBuild } from "./upstream-repros";
import {
  DEFAULT_PEAK_GIB,
  PEAK_GIB,
  type SlotClass,
  memoryVerdict,
  readContainerMemory,
  readSlot,
  readSlotClass,
} from "./heavy-slot-class";

export const ROOT = "/work/tools/al-runner-v3";
export const REPO = "aldevtools/BusinessCentral.AL.Runner";
export const GATE_WORKTREE = "/work/lethal-wt/al-runner-v3-gate";
export const LOG = "/coord/handoff/R-586/v3-updates.log";
/**
 * R632 A: the CDO checkout the D legs need (the gate page's `LETHAL_ITEST_V3_CDO`). Without it the
 * gate runs no D leg, and the receipt is an infra-fail every day (alpha.3, 2026-10-22).
 */
export const V3_CDO_DEFAULT = "/work/lethal-wt/cdo-r396";
/** R814: the scratch worktree `publishToMaster` commits from; never a lane's checkout. */
export const PIN_WORKTREE = "/work/lethal-wt/al-runner-v3-pins";
export const GATED_BUILDS_FILE = "packages/runner/src/al-runner-v3-gated-builds.json";
const PINS_FILE = "packages/runner/src/al-runner-v3-pins.ts";

export type Outcome = "pass" | "held" | "gate-fail" | "infra-fail";
/** R814: GitHub's compare of two upstream commits. */
export type CommitOrder = "ahead" | "behind" | "identical" | "diverged";

/** Everything with a side effect, injected so the test drives every branch (T19). */
export interface UpdateDeps {
  readonly root: string;
  /** Release tags, newest first (`gh release list`). */
  listReleases(): Promise<readonly string[]>;
  /** Downloads the linux-x64 tarball and SHA256SUMS of `tag` into the empty `dir`. */
  download(tag: string, dir: string): Promise<{ readonly tarball: string; readonly sums: string }>;
  /** Extracts `tarball` into the empty `dir`; returns the binary's path. */
  extract(tarball: string, dir: string): Promise<string>;
  versionOf(binary: string): Promise<string>;
  /**
   * Checks out `commit` detached in the gate worktree and runs the gate with `env`. `log` takes a
   * preparation line (R614 I2: how the fixture `.alpackages` were prepared) into the update log.
   */
  runGate(
    commit: string,
    env: Readonly<Record<string, string>>,
    log: (line: string) => Promise<void>,
  ): Promise<void>;
  /** A running process a move of `current` would affect (`movesUnder`). */
  inUse(): Promise<boolean>;
  log(line: string): Promise<void>;
  now(): string;
  /** Heavy jobs running container-wide (bun itests, `cli.ts run`, corpus jobs, verify). */
  heavyJobs(): Promise<number>;
  /**
   * R952 (R953): the memory rule for this gate (`--peak gate`) against the cgroup and the held slots'
   * declared peaks. Undefined, or an answer of undefined (no cgroup limit to read): the job count
   * and `freeGb` decide, as before.
   */
  gateMemory?(): Promise<{ readonly refuse: boolean; readonly message: string } | undefined>;
  /**
   * R-996: our invented upstream repros on `candidate` and on `current` (`scripts/upstream-repros.ts`); returns the report's
   * lines. Optional: absent (test rigs), nothing is run. It never decides the gate.
   */
  upstreamRepros?(candidate: string, current: string): Promise<readonly string[]>;
  /** `free -g`'s available column. */
  freeGb(): Promise<number>;
  /** R639 I3: `/proc/<pid>/cmdline` with NULs as spaces, or undefined when there is no such pid. */
  procCmdline(pid: number): Promise<string | undefined>;
  /** R639 I3: the pids (not this one) whose cwd is `dir` or under it: an orphaned itest child. */
  procsWithCwdUnder(dir: string): Promise<readonly number[]>;
  /** R777: the legs `V3_GATE_LEGS` names at LethAL `commit` (that commit's gate module). */
  legsAt(commit: string): Promise<readonly string[]>;
  /** R777: the full sha of the LethAL commit this script runs from. */
  selfCommit(): Promise<string>;
  /** R777: `git merge-base --is-ancestor a b` (a commit is its own ancestor). */
  isAncestor(a: string, b: string): Promise<boolean>;
  /** R814: does LethAL `commit`'s gate read `LETHAL_V3_PIN_FROM`? An older one ignores it. */
  pinFromAt(commit: string): Promise<boolean>;
  /** R814: does this script's pin file differ from LethAL `commit`'s? */
  pinsMovedSince(commit: string): Promise<boolean>;
  /** R814: where upstream's `head` stands against `base`. Throws when it cannot tell. */
  commitOrder(base: string, head: string): Promise<CommitOrder>;
  /** R814: adds these rows to master's gated-builds file (`publishToMaster`). */
  publishEntries(entries: readonly GatedBuildEntry[]): Promise<PublishResult>;
  /** R814: the committed gated builds this checkout ships (`gatedBuilds`). */
  listedBuilds(): readonly GatedBuildEntry[];
  /**
   * R886: builds the .NET sidecar of al-runner commit `commit` into the new, empty `outDir`;
   * returns the dll's path. Throws when it cannot. Optional: absent, no sidecar is tried (and no
   * field is written). Run AFTER the gate passed; a throw never changes the outcome.
   */
  buildSidecar?(commit: string, outDir: string): Promise<string>;
}

/** R886: the folder of a build's sidecar, beside its binary. */
export const SIDECAR_DIR = "dotnet-sidecar";

/**
 * R886: builds the sidecar into `<dest>/dotnet-sidecar` and returns the `.gated` fields: its file
 * (relative to `dest`) and sha256, or a note saying why not. Never throws.
 */
export async function sidecarFields(
  deps: UpdateDeps,
  dest: string,
  version: string,
): Promise<Pick<GatedBuild, "dotnetSidecar" | "dotnetSidecarNote">> {
  if (deps.buildSidecar === undefined) return {};
  const out = join(dest, SIDECAR_DIR);
  try {
    // A new, empty folder every time: a failed earlier try must not leave half a build to pick up.
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const dll = await deps.buildSidecar(commitOfVersion(version), out);
    const sha256 = await sha256OfFile(dll);
    await deps.log(`${deps.now()} ${version}: .NET sidecar built, sha256 ${sha256}`);
    return { dotnetSidecar: { file: relative(dest, dll), sha256 } };
  } catch (err) {
    const note = `sidecar build failed: ${String(err)}`.slice(0, 400);
    await deps.log(`${deps.now()} ${version}: ${note} (the build still gates)`);
    return { dotnetSidecarNote: note };
  }
}

/** R814: what `publishEntries` did: ids now on master, and rows refused, each by name. */
export interface PublishResult {
  readonly published: readonly string[];
  readonly refused: readonly { readonly id: string; readonly why: string }[];
}

/** R777: the leg names of the `V3_GATE_LEGS` literal in a gate module's source; throws when absent. */
export function parseGateLegs(src: string): string[] {
  const m = /export const V3_GATE_LEGS = \[([\s\S]*?)\] as const;/.exec(src);
  if (m === null)
    throw new Error("no `export const V3_GATE_LEGS = [...] as const;` in the gate module");
  const body = (m[1] ?? "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
}

/** `v3.0.0-alpha.N` -> N; anything else (edge, other lines) -> undefined. */
export function alphaOf(tag: string): number | undefined {
  const m = /^v3\.0\.0-alpha\.(\d+)$/.exec(tag);
  return m === null ? undefined : Number(m[1]);
}

/**
 * Candidates above the gated alpha, NEWEST first (R586d); never `edge`. Versions compare by the
 * alpha number as a number, so alpha.10 is newer than alpha.9.
 */
export function candidates(tags: readonly string[], gatedAlpha: number): string[] {
  return tags
    .map((t) => ({ t, n: alphaOf(t) }))
    .filter((x): x is { t: string; n: number } => x.n !== undefined && x.n > gatedAlpha)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.t);
}

/** The sha256 SHA256SUMS states for `file` (by basename), or undefined. */
export function expectedSha(sums: string, file: string): string | undefined {
  const name = file.split("/").pop() ?? file;
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m !== null && m[2] === name) return m[1];
  }
  return undefined;
}

/**
 * Reads the receipt: valid only with this nonce, this binary's sha256 and the LethAL commit the gate
 * was asked to run at (M3); and its `legs` must give its `outcome` by `gateOutcome` over the exact
 * leg set (a `pass` needs EVERY leg passed). Anything else is infra-fail, never a pass.
 * R814, for a candidate (`expect`): K is outside the leg set, so its pass is required here (a release
 * never becomes `current`, so K is the only normal session it gets), and a run asked to judge by a
 * pin must say it applied one.
 */
export async function readReceipt(
  path: string,
  nonce: string,
  sha: string,
  commit: string,
  expect: { readonly candidate?: boolean; readonly pinFrom?: string } = {},
): Promise<{ outcome: Outcome; why: string; pinApplied?: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { outcome: "infra-fail", why: "no receipt" };
  }
  const r = raw as {
    nonce?: unknown;
    binarySha256?: unknown;
    lethalCommit?: unknown;
    dirty?: unknown;
    outcome?: unknown;
    legs?: unknown;
    pinApplied?: unknown;
    pinDigest?: unknown;
  };
  if (r.nonce !== nonce) return { outcome: "infra-fail", why: "a receipt of another run (nonce)" };
  if (r.binarySha256 !== sha)
    return { outcome: "infra-fail", why: "a receipt for another binary (sha256)" };
  // F6: the full 40-character sha, equal; never a prefix match either way.
  const at = typeof r.lethalCommit === "string" ? r.lethalCommit : "";
  if (!FULL_SHA.test(at) || !FULL_SHA.test(commit) || at !== commit)
    return {
      outcome: "infra-fail",
      why: `a receipt of LethAL ${at || "(none)"}, not the requested ${commit} (both must be the full 40-character sha)`,
    };
  if (
    r.outcome !== "pass" &&
    r.outcome !== "held" &&
    r.outcome !== "gate-fail" &&
    r.outcome !== "infra-fail"
  ) {
    return { outcome: "infra-fail", why: `a receipt with outcome ${JSON.stringify(r.outcome)}` };
  }
  const legs = (typeof r.legs === "object" && r.legs !== null ? r.legs : {}) as Record<
    string,
    V3LegOutcome
  >;
  const byLegs = gateOutcome(legs);
  if (byLegs !== r.outcome)
    return {
      outcome: "infra-fail",
      why: `the receipt says ${r.outcome}, but its legs ${JSON.stringify(legs)} give ${byLegs} (every leg of ${V3_GATE_LEGS.join(",")} must be present)`,
    };
  // F5: a pass from a dirty gate worktree (an edited file, a rewritten lockfile) proves nothing.
  if (r.outcome === "pass" && r.dirty !== false)
    return {
      outcome: "infra-fail",
      why: `a pass from a gate worktree that was not clean (dirty: ${JSON.stringify(r.dirty)})`,
    };
  const pinApplied = typeof r.pinApplied === "string" ? r.pinApplied : undefined;
  if (r.outcome === "pass" && expect.candidate === true && legs.K !== "pass") {
    // A K that ran and failed is a verdict on the build, so it is kept like one and not re-gated daily.
    const kept = legs.K === "gate-fail" || legs.K === "held" ? legs.K : "infra-fail";
    return {
      outcome: kept,
      why: `a candidate's pass with K ${JSON.stringify(legs.K)}: K is the only normal session it gets`,
    };
  }
  if (r.outcome === "pass" && expect.pinFrom !== undefined && pinApplied === undefined)
    return {
      outcome: "infra-fail",
      why: `a pass that applied no pin, asked to judge by ${expect.pinFrom}`,
    };
  // The gate ran at `.gated`'s commit: a hand pin edited since then is not what it judged by.
  const hand = pinApplied !== undefined ? handV3Pin(pinApplied) : undefined;
  if (
    r.outcome === "pass" &&
    expect.candidate === true &&
    hand !== undefined &&
    r.pinDigest !== v3ReadingsDigest(hand)
  )
    return {
      outcome: "infra-fail",
      why: `the gate judged by another ${pinApplied} than this checkout's: re-gate current first`,
    };
  // R632 A: name the legs that never ran (D1 and D1c need LETHAL_ITEST_V3_CDO).
  const missing = V3_GATE_LEGS.filter((l) => !(l in legs));
  return {
    outcome: r.outcome,
    why: `receipt legs ${JSON.stringify(legs)}${missing.length > 0 ? `; missing legs ${missing.join(",")}` : ""}`,
    ...(pinApplied !== undefined ? { pinApplied } : {}),
  };
}

/** R632 C: the receipt's own `lines` (each leg's message), or none. */
async function receiptLines(path: string): Promise<string[]> {
  try {
    const l = (JSON.parse(await readFile(path, "utf8")) as { lines?: unknown }).lines;
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
}

/** R612 M-2: the receipt's warn-fact readings, carried into `.gated` on a pass. */
async function receiptWarnFacts(
  path: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    return warnFactReadings(
      (JSON.parse(await readFile(path, "utf8")) as { warnFacts?: unknown }).warnFacts,
    );
  } catch {
    return undefined;
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * M4: run in the gate worktree before any leg; a moved commit can need either. F5: the lockfile is
 * never rewritten there. The fixture `.alpackages` follow, by `prepareFixtureSymbols` (R614, shared
 * with the itest's own startup): extracted from the pinned tar, verified, or refused by name.
 */
export const GATE_STEPS: readonly (readonly string[])[] = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "scripts/build-native-parser.ts"],
];

async function readCurrentGated(root: string): Promise<GatedBuild & { readonly dir: string }> {
  const dir = await readlink(join(root, "current"));
  return { ...parseGated(await readFile(join(dir, ".gated"), "utf8"), join(dir, ".gated")), dir };
}

/**
 * R777: a candidate is never judged on fewer legs than `V3_GATE_LEGS` requires. When `.gated`'s
 * commit predates some of them, `current` is first re-gated at this script's own commit, under the
 * caller's lock. Returns the `.gated` to judge against: the re-gated one on a pass; otherwise
 * `current`'s with this script's commit, so the candidate is still judged on every leg while
 * `current` stays put. Undefined (logged) when this script's commit cannot serve: it lacks the legs
 * too, is not on origin/master, or is older than `.gated`'s.
 */
async function gatedWithAllLegs(
  deps: UpdateDeps,
  what: string,
): Promise<(GatedBuild & { readonly dir: string }) | undefined> {
  const current = await readCurrentGated(deps.root);
  const has = new Set(await deps.legsAt(current.lethalCommit));
  const missing = [
    ...V3_GATE_LEGS.filter((l) => !has.has(l)),
    // R814: a gate that ignores the pin would judge a candidate on the default tables: a false gate-fail.
    ...((await deps.pinFromAt(current.lethalCommit)) ? [] : [V3_PIN_FROM_ENV]),
    // The gate runs there, so a hand pin edited since would judge a candidate by old readings.
    ...((await deps.pinsMovedSince(current.lethalCommit)) ? [PINS_FILE] : []),
  ];
  if (missing.length === 0) return current;
  const self = await deps.selfCommit();
  const selfHas = new Set(await deps.legsAt(self));
  const selfHasPinFrom = await deps.pinFromAt(self);
  const stale = `${deps.now()} ${what}: stale-gated: .gated's lethalCommit ${current.lethalCommit} predates leg(s) ${missing.join(",")} of V3_GATE_LEGS`;
  const cannot =
    V3_GATE_LEGS.some((l) => !selfHas.has(l)) || !selfHasPinFrom
      ? "lacks them too (uncommitted legs?)"
      : !(await deps.isAncestor(self, "origin/master"))
        ? "is not on origin/master"
        : (await deps.isAncestor(self, current.lethalCommit))
          ? "is not newer than .gated's (an old checkout?)"
          : undefined;
  if (cannot !== undefined) {
    await deps.log(
      `${stale}; this script's commit ${self} ${cannot}: not gated; run it from a current master checkout, or \`--regate <master commit>\``,
    );
    return undefined;
  }
  await deps.log(`${stale}; re-gating current at ${self} first`);
  const o = await gateOne(deps, "regate", current, { regateAt: self });
  if (o === "pass") return readCurrentGated(deps.root);
  await deps.log(
    `${deps.now()} ${what}: the re-gate of current at ${self} gave ${o}: current stays at ${current.lethalCommit}; the candidate is judged at ${self}`,
  );
  return { ...current, lethalCommit: self };
}

async function infraCount(root: string, name: string, bump: boolean): Promise<number> {
  const f = join(root, "infra", `${name}.count`);
  await mkdir(join(root, "infra"), { recursive: true });
  const n = existsSync(f) ? Number(await readFile(f, "utf8")) : 0;
  const next = bump ? n + 1 : 0;
  await writeFile(f, String(next));
  return next;
}

/** `gateOne`'s options: `--regate`'s commit, or `--edge-rejudge`'s custody-checked kept binary. */
export interface GateOneOpts {
  readonly regateAt?: string;
  /** R639 M4: the kept binary (no download, no extract) and the sha its custody check gave. */
  readonly binary?: string;
  readonly binarySha256?: string;
  /** R639 M5: the kept folder the binary came from, written into `.gated` on a pass. */
  readonly rejudgedFrom?: string;
  /** R814: a numbered release: its pass joins the manifest and never moves `current`. */
  readonly release?: boolean;
  /**
   * R859 `--refresh-rows`: gate the kept `binary` as a candidate by `gated.readingsFrom`, at
   * `gated.lethalCommit`, and on a pass return at once: no `failed/`, `held/`, build folder, ledger
   * row, `.gated` or `current` is written. The caller writes the manifest row.
   */
  readonly refreshRow?: boolean;
  /** R859: this gate's own warn facts and time, handed to `refreshRows` on a pass. */
  readonly onRefreshPass?: (r: {
    warnFacts?: Readonly<Record<string, string>>;
    gatedAt: string;
  }) => void;
}

/** The `(commit)` of a `--version` line. */
function commitOfVersion(version: string): string {
  const c = /\(([0-9a-f]+)\)/.exec(version)?.[1];
  if (c === undefined) throw new Error(`no commit in the version line "${version}"`);
  return c;
}

/** R814: the hand pin behind a build, its own or its readings' (undefined: no pin at all). */
export function pinRootOf(g: GatedBuild): string | undefined {
  return g.readingsFrom ?? findV3Pin(g.version, g.binarySha256)?.id;
}

const ledgerPath = (root: string) => join(root, "gated-builds.jsonl");
const publishedPath = (root: string) => join(root, "gated-builds.published");

async function textLines(path: string): Promise<string[]> {
  return existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "")
    : [];
}

/** The ledger's rows, each id once. A line that does not parse (a torn write) is logged and skipped. */
async function readLedger(deps: UpdateDeps): Promise<GatedBuildEntry[]> {
  const rows = new Map<string, GatedBuildEntry>();
  for (const l of await textLines(ledgerPath(deps.root))) {
    try {
      const e = JSON.parse(l) as GatedBuildEntry;
      rows.set(e.id, e);
    } catch {
      await deps.log(`${deps.now()} gated-builds ledger: an unreadable line skipped`);
    }
  }
  return [...rows.values()];
}

/**
 * R814: ledger rows not yet published go to master, once. An id is published at most once, so a row
 * a person recalled from master is not put back. A refused row stays pending, and does not block the
 * rest. A failure is logged and retried by the next run: `.gated` already carries the readings.
 */
export async function publishPending(deps: UpdateDeps): Promise<void> {
  try {
    const done = new Set(await textLines(publishedPath(deps.root)));
    const pending = (await readLedger(deps)).filter((e) => !done.has(e.id));
    if (pending.length === 0) return;
    const r = await deps.publishEntries(pending);
    if (r.published.length > 0)
      await writeFile(publishedPath(deps.root), `${r.published.join("\n")}\n`, { flag: "a" });
    for (const id of r.published) await deps.log(`${deps.now()} ${id}: gated-builds row on master`);
    for (const x of r.refused)
      await deps.log(`${deps.now()} ${x.id}: gated-builds row REFUSED: ${x.why}; a person decides`);
  } catch (err) {
    await deps.log(`${deps.now()} gated-builds publish failed, next run retries: ${String(err)}`);
  }
}

/** One candidate (or the current build, on `--regate`) through the gate. */
export async function gateOne(
  deps: UpdateDeps,
  tag: string,
  gated: GatedBuild,
  opts: GateOneOpts = {},
): Promise<Outcome | "not-ahead"> {
  const { root } = deps;
  const work = await mkdtemp(join(root, ".work-"));
  try {
    let binary: string;
    let tarballSha: string | undefined;
    const name = tag;
    const commit = opts.regateAt ?? gated.lethalCommit;
    // I-2: a gate-fail is final for THIS build at THIS LethAL commit only; a LethAL fix (a new
    // `.gated` commit after a re-pre-commitment) may gate the same build again. R639 I5: checked
    // before every binary path, so a rejudge can never write into an existing failed/ folder.
    const failedDir = join(root, "failed", `${name}@${commit}`);
    const refresh = opts.refreshRow === true;
    if (opts.regateAt === undefined && existsSync(failedDir)) {
      await deps.log(
        `${deps.now()} ${tag}: gate-fail: already gate-failed at ${commit} (${failedDir}); not gated again at this commit, \`--regate\` to re-judge`,
      );
      return "gate-fail";
    }
    if (opts.regateAt !== undefined) {
      binary = join(await readlink(join(root, "current")), "al-runner");
    } else if (opts.binary !== undefined) {
      binary = opts.binary;
    } else {
      const dl = join(work, "dl");
      await mkdir(dl);
      let got: { tarball: string; sums: string };
      try {
        got = await deps.download(tag, dl);
      } catch (err) {
        await deps.log(`${deps.now()} ${tag}: infra-fail: download: ${String(err)}`);
        return infra(deps, name);
      }
      const want = expectedSha(await readFile(got.sums, "utf8"), got.tarball);
      tarballSha = await sha256OfFile(got.tarball);
      if (want === undefined || want !== tarballSha) {
        // Logged loudly, never extracted.
        await deps.log(
          `${deps.now()} ${tag}: infra-fail: CHECKSUM MISMATCH (SHA256SUMS ${want ?? "none"}, tarball ${tarballSha}); not extracted`,
        );
        return infra(deps, name);
      }
      const x = join(work, "x");
      await mkdir(x);
      binary = await deps.extract(got.tarball, x);
    }
    const sha = await sha256OfFile(binary);
    // R639 M4: the bytes gated are the bytes the custody check read.
    if (opts.binarySha256 !== undefined && sha !== opts.binarySha256)
      throw new Error(
        `al-runner-v3-edge-rejudge-refused: ${binary} has sha256 ${sha} now, not the custody-checked ${opts.binarySha256}`,
      );
    const version = await deps.versionOf(binary);
    const candidate = opts.regateAt === undefined;
    // R814: only an edge candidate moves `current`, and only forward. The commit is the DOWNLOADED
    // binary's: edge can be replaced between reading the tag and the download.
    let movesCurrent = candidate && opts.release !== true && !refresh;
    if (movesCurrent) {
      let order: CommitOrder;
      try {
        order = await deps.commitOrder(commitOfVersion(gated.version), commitOfVersion(version));
      } catch (err) {
        await deps.log(`${deps.now()} ${tag}: infra-fail: commit order: ${String(err)}`);
        return infra(deps, name);
      }
      if (order === "behind" || order === "diverged") {
        await deps.log(
          `${deps.now()} ${tag}: ${order} current (${gated.version}): current never moves backwards; a person decides`,
        );
        if (opts.binary === undefined) return "not-ahead";
        movesCurrent = false; // A rejudge still measures the kept build.
      }
    }
    const pinFrom = candidate ? pinRootOf(gated) : undefined;
    const nonce = randomUUID();
    const receipt = join(work, "receipt.json");
    await rm(receipt, { force: true });
    try {
      await deps.runGate(
        commit,
        {
          LETHAL_ITEST_ALRUNNER_V3: "1",
          LETHAL_ALRUNNER_V3_PATH: binary,
          // R814: K on every candidate, the only normal session a release ever gets.
          ...(candidate
            ? { LETHAL_ALRUNNER_V3_CANDIDATE: "1", LETHAL_ITEST_V3_K_ON_CANDIDATE: "1" }
            : {}),
          ...(pinFrom !== undefined ? { [V3_PIN_FROM_ENV]: pinFrom } : {}),
          LETHAL_ITEST_V3_TABLES: "1",
          LETHAL_ITEST_V3_CDO: process.env.LETHAL_ITEST_V3_CDO ?? V3_CDO_DEFAULT,
          LETHAL_V3_GATE_NONCE: nonce,
          LETHAL_V3_GATE_RECEIPT: receipt,
        },
        (line) => deps.log(`${deps.now()} ${tag}: ${line}`),
      );
    } catch (err) {
      // A failing gate still writes its receipt; the receipt decides. R633 I1: the error is logged.
      await deps.log(
        `${deps.now()} ${tag}: the gate exited with an error: ${String(err).slice(0, 1000)}`,
      );
    }
    const { outcome, why, pinApplied } = await readReceipt(receipt, nonce, sha, commit, {
      candidate,
      ...(pinFrom !== undefined ? { pinFrom } : {}),
    });
    const lines = await receiptLines(receipt);
    await deps.log(
      `${deps.now()} ${tag} (${version}, ${sha}) at ${commit}: ${outcome}: ${why}${lines.length > 0 ? `; lines: ${lines.join(" | ")}` : ""}`,
    );
    // R-996: a new candidate's repro report, against `current`, whatever the gate said (a flip to BC
    // matters even on a gate-fail). Never on a re-gate or refresh (no new build), never a verdict.
    if (candidate && !refresh && outcome !== "infra-fail" && deps.upstreamRepros !== undefined) {
      try {
        const cur = join(await readlink(join(root, "current")), "al-runner");
        for (const l of await deps.upstreamRepros(binary, cur))
          await deps.log(`${deps.now()} ${tag}: ${l}`);
      } catch (err) {
        await deps.log(
          `${deps.now()} ${tag}: upstream repros not run: ${String(err).slice(0, 300)}`,
        );
      }
    }
    // R632 C, R633 I1: the receipt and the gate's own output (`gate.log`) outlive `work`, beside the
    // outcome they gave, each when it exists. R633 M2: a failed copy is logged and never blocks the
    // verdict, `.gated` or the count.
    const gateLog = join(work, "gate.log");
    const keep = async (dir: string, prefix = "") => {
      for (const [from, file] of [
        [receipt, "receipt.json"],
        [gateLog, "gate.log"],
      ] as const) {
        if (!existsSync(from)) continue;
        try {
          await mkdir(dir, { recursive: true });
          await cp(from, join(dir, `${prefix}${file}`));
        } catch (err) {
          await deps.log(`${deps.now()} ${tag}: ${file} not kept in ${dir}: ${String(err)}`);
        }
      }
    };
    if (opts.regateAt !== undefined) await keep(join(root, "regate"), `${commit}.`);
    // R639 §6 step 8: a rejudge's evidence, whatever the outcome; nothing old is moved or rewritten.
    const rejudge = opts.binary !== undefined && !refresh;
    if (rejudge) await keep(join(root, "rejudge", `${name}@${commit}`));
    if (refresh) await keep(join(root, "refresh", `${name}@${commit}`));
    if (outcome === "infra-fail") {
      if (opts.regateAt === undefined && !refresh) await keep(join(root, "infra"), `${name}.`);
      return infra(deps, name);
    }
    await infraCount(root, name, false);
    if (outcome === "gate-fail") {
      if (opts.regateAt === undefined && !refresh) {
        await mkdir(failedDir, { recursive: true });
        await cp(binary, join(failedDir, "al-runner"));
        await keep(failedDir);
      }
      return "gate-fail";
    }
    if (outcome === "held") {
      const heldDir = join(root, "held", name);
      // R639: a rejudge never rewrites an existing held/<tag>/ (its record stays in rejudge/).
      if (opts.regateAt === undefined && !refresh && !(rejudge && existsSync(heldDir))) {
        await mkdir(heldDir, { recursive: true });
        await cp(binary, join(heldDir, "al-runner"));
        await keep(heldDir);
      }
      await deps.log(
        `${deps.now()} ${tag}: HELD for the orchestrator: every difference is a move toward BC or a named refusal; read the receipt's lines; re-pre-commit, then re-gate`,
      );
      return "held";
    }
    // pass
    if (refresh) {
      // R859: the gate must have judged by the row's own pin, or the pass says nothing about the row.
      if (pinApplied !== gated.readingsFrom) {
        await deps.log(
          `${deps.now()} ${tag}: infra-fail: a pass that applied pin ${pinApplied ?? "(none)"}, not ${gated.readingsFrom ?? "(none)"}`,
        );
        return infra(deps, name);
      }
      const w = await receiptWarnFacts(receipt);
      opts.onRefreshPass?.({ ...(w !== undefined ? { warnFacts: w } : {}), gatedAt: deps.now() });
      return "pass";
    }
    const dirName =
      opts.regateAt !== undefined
        ? undefined
        : `${tag.replace(/^v/, "")}-${/\(([0-9a-f]+)\)/.exec(version)?.[1] ?? "unknown"}`;
    const dest =
      dirName === undefined ? await readlink(join(root, "current")) : join(root, dirName);
    if (dirName !== undefined) {
      await mkdir(dest, { recursive: true });
      await cp(binary, join(dest, "al-runner"));
      await chmod(join(dest, "al-runner"), 0o755);
      // R805: one folder per build, so this is the latest CANDIDATE pass's evidence. A later
      // `--regate` moves `.gated` only: its evidence is `regate/<commit>.*`.
      await keep(dest);
    }
    // R612 M-2: this gate's warn-fact readings, so a session shows what the gate read.
    const warnFacts = await receiptWarnFacts(receipt);
    // R886: after the pass, never before: a sidecar that fails to build cannot change the outcome.
    // A new build gets one; a regate keeps `current`'s, or tries again when it has none.
    const sidecar =
      dirName === undefined && gated.dotnetSidecar !== undefined
        ? { dotnetSidecar: gated.dotnetSidecar }
        : await sidecarFields(deps, dest, version);
    const next: GatedBuild = {
      ...sidecar,
      ...(warnFacts !== undefined ? { warnFacts } : {}),
      version,
      binarySha256: sha,
      lethalCommit: commit,
      // M5 (R639): only `--regate` (the same binary) inherits the tarball; a rejudge names its
      // kept folder instead.
      ...(tarballSha !== undefined
        ? { tarballSha256: tarballSha }
        : opts.regateAt !== undefined && gated.tarballSha256 !== undefined
          ? { tarballSha256: gated.tarballSha256 }
          : {}),
      ...(opts.rejudgedFrom !== undefined
        ? { rejudgedFrom: opts.rejudgedFrom }
        : opts.regateAt !== undefined && gated.rejudgedFrom !== undefined
          ? { rejudgedFrom: gated.rejudgedFrom }
          : {}),
      // R814: the hand pin it passed on; a regate keeps what a mechanical `current` had.
      ...(pinApplied !== undefined
        ? { readingsFrom: pinApplied }
        : opts.regateAt !== undefined && gated.readingsFrom !== undefined
          ? { readingsFrom: gated.readingsFrom }
          : {}),
      gatedAt: deps.now(),
    };
    await writeFile(join(dest, ".gated"), `${JSON.stringify(next, null, 2)}\n`);
    if (dirName !== undefined) {
      // R814: the row goes to the ledger before `current` moves; `publishPending` commits it.
      const handPin = pinApplied !== undefined ? handV3Pin(pinApplied) : undefined;
      if (handPin !== undefined) {
        const row: GatedBuildEntry = {
          id:
            opts.release === true
              ? `${tag.replace(/^v3\.0\.0-/, "")}-${commitOfVersion(version)}`
              : `edge-${commitOfVersion(version)}`,
          track: opts.release === true ? "release" : "edge",
          ...(opts.release === true ? { tag } : {}),
          version,
          binarySha256: sha,
          readingsFrom: handPin.id,
          readingsDigest: v3ReadingsDigest(handPin),
          lethalCommit: commit,
          gatedAt: next.gatedAt ?? deps.now(),
          ...(warnFacts !== undefined ? { warnFacts } : {}),
          ...(sidecar.dotnetSidecar !== undefined
            ? { dotnetSidecarSha256: sidecar.dotnetSidecar.sha256 }
            : {}),
          ...(sidecar.dotnetSidecarNote !== undefined
            ? { dotnetSidecarNote: sidecar.dotnetSidecarNote }
            : {}),
        };
        await writeFile(ledgerPath(root), `${JSON.stringify(row)}\n`, { flag: "a" });
      } else {
        await deps.log(
          `${deps.now()} ${tag}: no gated-builds row: ${pinApplied === undefined ? "no pin applied" : `this script's checkout has no pin ${pinApplied}`}`,
        );
      }
      if (!movesCurrent) {
        await deps.log(`${deps.now()} ${tag}: passed; current stays`);
        return "pass";
      }
      if (await deps.inUse()) {
        await deps.log(`${deps.now()} ${tag}: passed; deferred: in use (current not moved)`);
        return "pass";
      }
      const tmp = join(root, `current.${randomUUID()}`);
      await symlink(dest, tmp);
      await rename(tmp, join(root, "current"));
      await deps.log(`${deps.now()} ${tag}: current -> ${dest} (a line for R586)`);
    }
    return "pass";
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function infra(deps: UpdateDeps, name: string): Promise<Outcome> {
  const n = await infraCount(deps.root, name, true);
  if (n >= 3)
    await deps.log(`${deps.now()} ${name}: ${n} infra-fails in a row: a line for the orchestrator`);
  return "infra-fail";
}

/**
 * The release track: the candidates above the newest listed release, newest first, until one passes
 * (R586d). A candidate that does not pass (gate-fail, held, infra-fail, or already in `failed/`)
 * sends the run to the next older one. Older releases skipped after a pass get no verdict that day.
 * R814: a release never moves `current`, whatever its outcome.
 */
export async function updateOnce(
  deps: UpdateDeps,
  opts: { readonly regateAt?: string } = {},
): Promise<(Outcome | "skipped" | "not-ahead")[]> {
  // R632 D: the D legs make every gate a corpus job, on this path too.
  const what = opts.regateAt !== undefined ? "regate" : "alpha";
  if (await skippedForTheDay(deps, what)) return ["skipped"];
  const lock = await takeGateLock(deps, what);
  if (lock === undefined) return ["skipped"];
  try {
    return await updateLocked(deps, opts);
  } finally {
    await lock.release();
  }
}

/** R814: the newest listed release: the committed file plus the ledger, so an unpublished pass counts. */
async function newestListedAlpha(deps: UpdateDeps): Promise<number> {
  const rows = [...deps.listedBuilds(), ...(await readLedger(deps))];
  return rows.reduce((n, e) => (e.track === "release" ? Math.max(n, alphaOfEntry(e)) : n), -1);
}

async function updateLocked(
  deps: UpdateDeps,
  opts: { readonly regateAt?: string },
): Promise<(Outcome | "skipped" | "not-ahead")[]> {
  if (opts.regateAt !== undefined)
    return [await gateOne(deps, "regate", await readCurrentGated(deps.root), opts)];
  const current = await gatedWithAllLegs(deps, "alpha");
  if (current === undefined) return ["skipped"];
  const tags = await deps.listReleases();
  for (const t of tags)
    if (t !== "edge" && t.startsWith("v3") && alphaOf(t) === undefined)
      await deps.log(`${deps.now()} ${t}: a release tag this script cannot read; not gated`);
  const out: (Outcome | "skipped" | "not-ahead")[] = [];
  const unjudged: string[] = [];
  for (const tag of candidates(tags, await newestListedAlpha(deps))) {
    // R632 D, per gate: a daily run can hold several.
    if (out.length > 0 && (await skippedForTheDay(deps, "alpha"))) {
      out.push("skipped");
      break;
    }
    const o = await gateOne(deps, tag, current, { release: true });
    out.push(o);
    if (o === "infra-fail") unjudged.push(tag);
    if (o === "pass") {
      // A newer release the gate could not judge today is not a verdict: say so.
      for (const t of unjudged)
        await deps.log(`${deps.now()} ${tag}: passed after ${t} was not judged (infra-fail) today`);
      break;
    }
  }
  return out;
}

/**
 * The daily EDGE path (owner request, via the orchestrator): upstream's `edge` release by download.
 * - Skipped for the day, with the reason logged, when 3 or more other heavy jobs run container-wide or
 *   `free -g` shows under 10 GB available.
 * - A NO-OP when edge's commit equals the one last seen (`<root>/edge.last-seen`).
 * - Otherwise the candidate goes through `gateOne`: the checksum is checked before anything is
 *   extracted, the receipt is matched by nonce and sha256, the gate runs at `.gated`'s commit, and
 *   only a `pass` moves `current`. `held` is kept, never blacklisted.
 * The commit is recorded as seen once the gate gave an answer other than `infra-fail`, so an
 * infrastructure failure is retried the next day.
 */
export interface EdgeDeps {
  /** Edge's commit (short or full sha), from `gh release view edge`. */
  edgeCommit(): Promise<string>;
}

export type EdgeResult = "skipped" | "no-op" | Outcome;

/**
 * A heavy job's command line (`/proc/<pid>/cmdline`, NULs as spaces): an itest, `cli.ts run`, verify or
 * a corpus job. R633 M5: bun may appear by a full path (`/home/dev/.bun/bin/bun ...`).
 */
export const HEAVY_JOB =
  /(^|\/)bun packages\/runner\/itest\/[\w-]+\.itest\.ts|cli\.ts run|(^|\/)bun scripts\/verify\.ts|\/work\/src\/(BC\.History|DC|DO|do-lethal)/;

/**
 * R950: whether a move of `current` would change what a running process runs. It runs an al-runner build
 * (`exe` resolves under `root`), and it was started through `<root>/current/` or its `argv[0]` is unreadable or
 * relative (the safe side). One started with an explicit build path (`<root>/<build>/al-runner`) is untouched by
 * the move: LethAL spawns the path it was given and never re-reads `current` for it.
 */
export function movesUnder(root: string, exe: string, argv0: string | undefined): boolean {
  if (!exe.startsWith(`${root}/`)) return false;
  // POSIX on every platform: these are Linux `/proc` paths (`path.normalize` is win32 on Windows CI).
  if (argv0 === undefined || !posix.isAbsolute(argv0)) return true;
  // Normalised, so `<root>//current/`, `<root>/./current/` and `<root>/x/../current/` count too.
  const a = posix.normalize(argv0);
  if (!a.startsWith(`${root}/`)) return true;
  return a.startsWith(`${root}/current/`);
}

/** R950: argv[0] from a `/proc/<pid>/cmdline` text (NUL-separated); `undefined` when there is none. */
export function argv0FromCmdline(cmdline: string): string | undefined {
  const first = cmdline.split("\0")[0];
  return first === undefined || first === "" ? undefined : first;
}

/**
 * R851: heavy JOBS, not processes. One job is a wrapper shell, `flock`, `bun run`, a bun child and
 * workers: on 2026-11-06 one corpus job read as 6 and skipped a release for the day. A job is a
 * process group, a `--worker` is part of its itest, and a held `heavy.<n>` lock is a job even if its
 * process names nothing heavy. The higher of the two counts, because a job under a lock is in both.
 */
/** R934: the `scripts/heavy-slot.sh` wrapper's own process (`bash .../heavy-slot.sh [--wait] [--peak <p>] <class> ...`). */
// R952: anchored at the command's start (heavy-slot.sh, or bash/sh running it), as corpus-snapshot's is.
const HEAVY_SLOT_WRAPPER =
  /^(?:(?:\S*\/)?(?:ba)?sh\s+)?(?:\S*\/)?heavy-slot\.sh\s+(--wait\s+)?(--peak\s+\S+\s+)?(baseapp|other)\s/;

export function countHeavyJobs(
  procs: readonly Proc[],
  heldSlots: number,
  // R905: the class of each held slot (undefined = none readable, which counts as BaseApp).
  heldClasses: readonly (SlotClass | undefined)[] = [],
): number {
  // R930: a reader (`grep`, `ps`, ...) is never a job by its text. A shell names what it runs, and
  // `timeout` (or a harness's own shell) puts that job in ANOTHER group: one job read as two. So a
  // shell is skipped when a process below it is a job of its own, and still counts when none is
  // (`bash -c 'cd /work/src/BC.History && bun census.ts .'`: only the shell names the corpus).
  const isJob = (p: Proc): boolean =>
    HEAVY_JOB.test(p.args) && !p.args.includes("--worker") && !WATCHER.test(p.args);
  // R952 review: the shells that launched a wrapper (the Bash tool's `bash -c ... eval '...
  // heavy-slot.sh ...'`) are not the job either: its slot or its own command is.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const aboveWrapper = new Set<number>();
  for (const p of procs) {
    if (!HEAVY_SLOT_WRAPPER.test(p.args)) continue;
    for (
      let q = byPid.get(p.ppid);
      q !== undefined && !aboveWrapper.has(q.pid);
      q = byPid.get(q.ppid)
    )
      aboveWrapper.add(q.pid);
  }
  const groups = new Set<number>();
  for (const p of procs) {
    if (READER.test(p.args) || !HEAVY_JOB.test(p.args) || p.args.includes("--worker")) continue;
    // R934: `heavy-slot.sh` itself is never the job: a holder's slot counts in `heldSlots`, its
    // command counts on its own, and a queued `--wait` waiter holds no slot and runs nothing yet.
    if (HEAVY_SLOT_WRAPPER.test(p.args) || aboveWrapper.has(p.pid)) continue;
    if (WATCHER.test(p.args)) {
      const below = descendants(procs, p.pid);
      if (procs.some((q) => below.has(q.pid) && isJob(q))) continue;
    }
    groups.add(p.pgid);
  }
  const jobs = Math.max(groups.size, heldSlots);
  // With two or more jobs running and any held slot BaseApp-class or unclassed, the container is
  // full (two heavy jobs in all while a BaseApp job runs): the gate would be a third.
  return jobs >= 2 && heldClasses.some((c) => c !== "other") ? Math.max(jobs, 3) : jobs;
}

/**
 * R633 I2: a `--regate` (R639: or an `--edge-rejudge`) that was skipped exits 2, so a `&&` chain
 * stops.
 */
export function updateExitCode(mustRun: boolean, out: readonly string[]): number {
  return mustRun && out[0] === "skipped" ? 2 : 0;
}

/**
 * True, with the reason logged, when 3 or more OTHER heavy jobs run or under 10 GB is available:
 * at most 3 heavy jobs container-wide (2026-10-22, 32 GB), counting the gate itself. R905: but at
 * most 2 while any held slot is BaseApp-class or has no class (`countHeavyJobs` returns 3 for two
 * jobs then), because the gate is not itself a BaseApp job but would be the third.
 */
async function skippedForTheDay(deps: UpdateDeps, what: string): Promise<boolean> {
  // R952 (R953): where the cgroup names a limit, memory decides, not the job count: a busy day with
  // memory free no longer skips the gate (2026-11-13: skipped twice at 3 jobs, 12.5 GiB used of 32).
  const mem = await deps.gateMemory?.();
  if (mem !== undefined) {
    if (!mem.refuse) return false;
    await deps.log(`${deps.now()} ${what}: skipped for the day: ${mem.message}`);
    return true;
  }
  const heavy = await deps.heavyJobs();
  if (heavy >= 3) {
    await deps.log(
      `${deps.now()} ${what}: skipped for the day: ${heavy} heavy jobs are running (limit: 2 others)`,
    );
    return true;
  }
  const free = await deps.freeGb();
  if (free < 10) {
    await deps.log(`${deps.now()} ${what}: skipped for the day: ${free} GB available (needs 10)`);
    return true;
  }
  return false;
}

/** The holder a lock file names, or undefined when it is empty or unreadable. */
async function lockHolder(
  path: string,
): Promise<{ readonly pid: number; readonly startedAt: string } | undefined> {
  try {
    const h = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
    return typeof h.pid === "number" && typeof h.startedAt === "string"
      ? { pid: h.pid, startedAt: h.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `link()` a fully written temp file to `lock`: atomic, so the lock is never seen half-written. */
async function linkLock(lock: string, body: string): Promise<boolean> {
  const tmp = `${lock}.${randomUUID()}`;
  await writeFile(tmp, body);
  try {
    await link(tmp, lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * R639 I3: one lock, `<root>/.gate.lock`, around every gate path (the alpha path, `--regate`,
 * `--edge`, `--edge-rejudge`), since all of them check out and run in `GATE_WORKTREE`. A holder is
 * live only when its `/proc/<pid>/cmdline` names `al-runner-v3-update`; a dead, reused, empty or
 * unreadable holder is stale, and is taken over (by rename, then a second `link`) unless a process
 * still runs under `GATE_WORKTREE` (an orphaned itest child). Every skip is logged with the manual
 * clear step and returns `undefined`.
 */
export async function takeGateLock(
  deps: UpdateDeps,
  what: string,
): Promise<{ release(): Promise<void> } | undefined> {
  const lock = join(deps.root, ".gate.lock");
  const me = { pid: process.pid, startedAt: deps.now() };
  const body = JSON.stringify({ ...me, argv: process.argv });
  const release = async () => {
    const h = await lockHolder(lock);
    if (h?.pid === me.pid && h.startedAt === me.startedAt) await unlink(lock).catch(() => {});
  };
  if (await linkLock(lock, body)) return { release };
  const h = await lockHolder(lock);
  const skip = async (why: string) => {
    await deps.log(
      `${deps.now()} ${what}: skipped: the gate lock ${lock} is held by pid ${h?.pid ?? "?"} since ${h?.startedAt ?? "?"} (${why}); check that no process runs under ${GATE_WORKTREE}, then \`rm ${lock}\``,
    );
    return undefined;
  };
  if (
    h !== undefined &&
    h.pid !== process.pid &&
    ((await deps.procCmdline(h.pid)) ?? "").includes("al-runner-v3-update")
  )
    return skip("a live al-runner-v3-update");
  if (h === undefined)
    await deps.log(`${deps.now()} ${what}: the gate lock ${lock} is empty or unreadable: stale`);
  const orphans = await deps.procsWithCwdUnder(GATE_WORKTREE);
  if (orphans.length > 0)
    return skip(`stale, but pid(s) ${orphans.join(", ")} still run under ${GATE_WORKTREE}`);
  // ponytail: two runs that both find the same stale lock in the same instant can both take it; needs a stale lock plus simultaneous starts. Upgrade: re-read the lock before and after the rename and skip unless it still names the dead holder.
  await rename(lock, `${lock}.stale.${randomUUID()}`).catch(() => {});
  if (!(await linkLock(lock, body))) return skip("another run took it over first");
  await deps.log(`${deps.now()} ${what}: took over the stale gate lock ${lock}`);
  return { release };
}

/** The kept folders of `tag`: `failed/<tag>@*` and `held/<tag>`, each with a binary and a receipt. */
async function keptFolders(root: string, tag: string): Promise<string[]> {
  const failed = join(root, "failed");
  const names = existsSync(failed) ? await readdir(failed) : [];
  return [
    ...names.filter((n) => n.startsWith(`${tag}@`)).map((n) => join(failed, n)),
    join(root, "held", tag),
  ].filter((d) => existsSync(join(d, "al-runner")) && existsSync(join(d, "receipt.json")));
}

/**
 * R639 `--edge-rejudge <edge sha>` (plan r2 §6, r3 I4/I5, M4/M5): re-gate a KEPT edge binary at
 * `.gated`'s current commit. It never downloads, never reads or writes `edge.last-seen`, and never
 * deletes, moves or rewrites anything under `failed/` or `held/`. A refusal throws.
 */
export async function edgeRejudge(deps: UpdateDeps, arg: string): Promise<Outcome | "skipped"> {
  const refuse = (why: string): never => {
    throw new Error(`al-runner-v3-edge-rejudge-refused: ${why}`);
  };
  if (!/^[0-9a-f]{7,40}$/.test(arg)) refuse(`"${arg}" is not a 7-40 character sha`);
  if (await skippedForTheDay(deps, "edge-rejudge")) return "skipped";
  const lock = await takeGateLock(deps, "edge-rejudge");
  if (lock === undefined) return "skipped";
  try {
    const { root } = deps;
    const tag = `edge-${arg}`;
    // Custody: every kept copy is the bytes its receipt names, and all are one build.
    const folders = await keptFolders(root, tag);
    if (folders.length === 0)
      refuse(`no kept binary with a receipt for ${tag} in failed/ or held/`);
    const before: string[] = [];
    let sha: string | undefined;
    for (const d of folders) {
      const r = JSON.parse(await readFile(join(d, "receipt.json"), "utf8")) as {
        binarySha256?: unknown;
        outcome?: unknown;
        lethalCommit?: unknown;
      };
      const s = await sha256OfFile(join(d, "al-runner"));
      if (s !== r.binarySha256)
        refuse(`${d}/al-runner has sha256 ${s}, its receipt names ${String(r.binarySha256)}`);
      if (sha !== undefined && s !== sha)
        refuse(`two different kept builds of ${tag} (${sha}, ${s})`);
      sha = s;
      before.push(`${String(r.outcome)}@${String(r.lethalCommit)}`);
    }
    const [from] = folders;
    if (from === undefined || sha === undefined) return refuse(`no kept binary for ${tag}`);
    const binary = join(from, "al-runner");
    // I4: the kept bytes ARE the build the argument names.
    const v = /\(([0-9a-f]+)\)$/.exec((await deps.versionOf(binary)).trim())?.[1] ?? "";
    if (v.length < 7 || !(v.startsWith(arg) || arg.startsWith(v)))
      refuse(`${binary} reports commit "${v}", not ${arg}`);
    // R777: after the cheap refusals, since a stale `.gated` costs a re-gate first.
    const current = await gatedWithAllLegs(deps, "edge-rejudge");
    if (current === undefined) return "skipped";
    const commit = current.lethalCommit;
    // I5: at the same commit a verdict is final, whether or not its folder holds a receipt.
    const judged = () =>
      refuse(`${tag} already judged at ${commit}; --regate to a new commit first`);
    if (existsSync(join(root, "failed", `${tag}@${commit}`))) judged();
    for (const r of [
      join(root, "rejudge", `${tag}@${commit}`, "receipt.json"),
      join(root, "held", tag, "receipt.json"),
    ]) {
      const k = existsSync(r)
        ? (JSON.parse(await readFile(r, "utf8")) as { lethalCommit?: unknown; outcome?: unknown })
        : undefined;
      if (k?.lethalCommit === commit && k.outcome !== "infra-fail") judged();
    }
    const outcome = await gateOne(deps, tag, current, {
      binary,
      binarySha256: sha,
      rejudgedFrom: from,
    });
    if (outcome === "not-ahead") return "skipped"; // Unreachable: a rejudge always measures.
    await publishPending(deps); // R861: a rejudge can move `current`, so its row goes out now.
    const same = before.every((b) => b.startsWith(`${outcome}@`));
    await deps.log(
      `${deps.now()} edge-rejudge ${tag} (${sha}) at ${commit}: ${outcome}; before: ${before.join(", ")}; ${same ? "same" : "different"}`,
    );
    return outcome;
  } finally {
    await lock.release();
  }
}

/** R859: what `refreshRows` needs beyond `UpdateDeps`. */
export interface RefreshDeps {
  /** True when the checkout has an uncommitted change to a tracked file. */
  isDirty(): Promise<boolean>;
  /** The checkout's `al-runner-v3-gated-builds.json`. */
  readonly manifestPath: string;
}

/**
 * R859 `--refresh-rows <id>[,<id>...]`, run in a BRANCH's checkout: for each named manifest row,
 * re-gate its kept binary at this checkout's head by the row's own hand pin, and only on that row's
 * pass replace that row's `readingsDigest` and `lethalCommit` in the checkout's manifest. Nothing
 * else is written there: no commit, no push, no `gated-builds.published`, no `current`, `.gated`,
 * `failed/` or `held/`. Every refusal throws before any gate runs. Rows go in order and the run
 * stops at the first row that does not pass; rows that passed before it stay written. Returns each
 * row's outcome, or ["skipped"] when the load check or the gate lock skipped the run.
 */
export async function refreshRows(
  deps: UpdateDeps & RefreshDeps,
  ids: readonly string[],
): Promise<(Outcome | "skipped")[]> {
  const refuse = (why: string): never => {
    throw new Error(`al-runner-v3-refresh-refused: ${why}`);
  };
  if (ids.length === 0 || new Set(ids).size !== ids.length)
    refuse("name each row once: --refresh-rows <id>[,<id>...]");
  const { root } = deps;
  const text = await readFile(deps.manifestPath, "utf8");
  const rows = JSON.parse(text) as GatedBuildEntry[];
  if (`${JSON.stringify(rows, null, 2)}\n` !== text)
    refuse(`${deps.manifestPath} is not in the script's own format; format it first`);
  if (await deps.isDirty()) refuse("the checkout has uncommitted changes; commit them first");
  const head = await deps.selfCommit();
  if (!FULL_SHA.test(head)) refuse(`the checkout's head "${head}" is not a full sha`);
  // Every refusal first, so a bad id never leaves the others half done.
  const plan = new Map<string, { binary: string; row: GatedBuildEntry }>();
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return refuse(`${id} is not a row of ${deps.manifestPath}`);
    if (handV3Pin(row.readingsFrom) === undefined)
      refuse(`${id}: its pin "${row.readingsFrom}" is no hand pin in this checkout`);
    const suffix = `-${commitOfVersion(row.version)}`;
    const dirs = (await readdir(root))
      .filter((n) => n.endsWith(suffix) && existsSync(join(root, n, "al-runner")))
      .map((n) => join(root, n, "al-runner"));
    if (dirs.length === 0)
      refuse(`${id}: no kept binary <root>/*${suffix}/al-runner under ${root}`);
    let binary: string | undefined;
    for (const d of dirs) if ((await sha256OfFile(d)) === row.binarySha256) binary = d;
    if (binary === undefined)
      return refuse(`${id}: ${dirs.join(", ")} does not have the row's sha256 ${row.binarySha256}`);
    plan.set(id, { binary, row });
  }
  if (await skippedForTheDay(deps, "refresh-rows")) return ["skipped"];
  const lock = await takeGateLock(deps, "refresh-rows");
  if (lock === undefined) return ["skipped"];
  try {
    const out: Outcome[] = [];
    for (const [id, { binary, row }] of plan) {
      const dir = join(root, "refresh", `refresh-${id}@${head}`);
      const receiptFile = join(dir, "refresh.json");
      // A pass receipt of an earlier run for this id and head must not outlive a run that fails.
      await rm(receiptFile, { force: true });
      let thisGate: { warnFacts?: Readonly<Record<string, string>>; gatedAt: string } | undefined;
      const o = await gateOne(
        deps,
        `refresh-${id}`,
        {
          version: row.version,
          binarySha256: row.binarySha256,
          lethalCommit: head,
          readingsFrom: row.readingsFrom,
        },
        {
          binary,
          binarySha256: row.binarySha256,
          refreshRow: true,
          onRefreshPass: (r) => {
            thisGate = r;
          },
        },
      );
      if (o === "not-ahead") return refuse(`${id}: unreachable: a refresh always measures`);
      out.push(o);
      if (o !== "pass") break;
      const pin = handV3Pin(row.readingsFrom);
      // TypeScript cannot see the callback's assignment, so it narrows `thisGate` to undefined.
      const g = thisGate as
        | { warnFacts?: Readonly<Record<string, string>>; gatedAt: string }
        | undefined;
      if (pin === undefined || g === undefined) return refuse(`${id}: no pin or gate result`);
      const refusal = async (why: string): Promise<never> => {
        await mkdir(dir, { recursive: true });
        await writeFile(
          receiptFile,
          `${JSON.stringify({ id, outcome: `refused: ${why}` }, null, 2)}\n`,
        );
        await deps.log(`${deps.now()} refresh-${id}: REFUSED, nothing written: ${why}`);
        return refuse(`${id}: ${why}`);
      };
      const nowHead = await deps.selfCommit();
      if (nowHead !== head)
        return await refusal(`the checkout's head moved during the gate (${head} -> ${nowHead})`);
      const fresh = JSON.parse(await readFile(deps.manifestPath, "utf8")) as GatedBuildEntry[];
      if (!fresh.some((r) => r.id === id))
        return await refusal(`${id} is no longer a row of ${deps.manifestPath}`);
      // This gate's result only: the digest, the commit, warnFacts and gatedAt; nothing else moves.
      const next = fresh.map((r) => {
        if (r.id !== id) return r;
        const { warnFacts: _old, ...rest } = r;
        return {
          ...rest,
          readingsDigest: v3ReadingsDigest(pin),
          lethalCommit: head,
          gatedAt: g.gatedAt,
          ...(g.warnFacts !== undefined ? { warnFacts: g.warnFacts } : {}),
        };
      });
      parseGatedBuilds(next, new Set(V3_BUILD_PINS.map((p) => p.id)));
      // The receipt goes first, so a crash cannot leave a row with no receipt.
      await mkdir(dir, { recursive: true });
      await writeFile(
        receiptFile,
        `${JSON.stringify({ id, binary, binarySha256: row.binarySha256, readingsFrom: row.readingsFrom, oldDigest: row.readingsDigest, newDigest: v3ReadingsDigest(pin), oldCommit: row.lethalCommit, lethalCommit: head, gatedAt: g.gatedAt, warnFacts: g.warnFacts ?? null, outcome: "pass" }, null, 2)}\n`,
      );
      await writeFile(deps.manifestPath, `${JSON.stringify(next, null, 2)}\n`);
      await deps.log(
        `${deps.now()} refresh-${id}: pass at ${head}: digest ${row.readingsDigest} -> ${v3ReadingsDigest(pin)}; row written to ${deps.manifestPath}; receipt ${dir}`,
      );
    }
    return out;
  } finally {
    await lock.release();
  }
}

export async function edgeOnce(deps: UpdateDeps & EdgeDeps): Promise<EdgeResult> {
  if (await skippedForTheDay(deps, "edge")) return "skipped";
  const lock = await takeGateLock(deps, "edge");
  if (lock === undefined) return "skipped";
  try {
    const outcome = await edgeLocked(deps);
    await publishPending(deps);
    return outcome;
  } finally {
    await lock.release();
  }
}

async function edgeLocked(deps: UpdateDeps & EdgeDeps): Promise<EdgeResult> {
  const commit = (await deps.edgeCommit()).trim();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`edge's commit "${commit}" is not a sha`);
  const seenFile = join(deps.root, "edge.last-seen");
  const seen = existsSync(seenFile) ? (await readFile(seenFile, "utf8")).trim() : "";
  if (seen === commit) {
    await deps.log(`${deps.now()} edge: no-op: commit ${commit} was already gated`);
    return "no-op";
  }
  // Not marked seen when skipped here: the edge is retried once current re-gates.
  const current = await gatedWithAllLegs(deps, "edge");
  if (current === undefined) return "skipped";
  const before = await readlink(join(deps.root, "current"));
  const outcome = await gateOne(deps, `edge-${commit}`, current);
  // Not seen either way: behind or diverged waits for a person; a pass deferred by "in use" retries.
  if (outcome === "not-ahead") return "skipped";
  const deferred = outcome === "pass" && (await readlink(join(deps.root, "current"))) === before;
  if (outcome !== "infra-fail" && !deferred) await writeFile(seenFile, `${commit}\n`);
  return outcome;
}

/**
 * R813/R814: the daily run, both tracks under one lock. Edge first, so a release is judged by the
 * newest pin. A release only joins the manifest, so its outcome never touches `current`.
 */
export async function dailyOnce(
  deps: UpdateDeps & EdgeDeps,
): Promise<{ edge: EdgeResult; releases: readonly string[] }> {
  if (await skippedForTheDay(deps, "daily")) return { edge: "skipped", releases: [] };
  const lock = await takeGateLock(deps, "daily");
  if (lock === undefined) return { edge: "skipped", releases: [] };
  // One track failing must not stop the other, or the rows of what already passed.
  const guarded = async <T>(what: string, f: () => Promise<T>, failed: T): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      await deps.log(`${deps.now()} daily: the ${what} track failed: ${String(err)}`);
      return failed;
    }
  };
  try {
    await publishPending(deps);
    const edge = await guarded<EdgeResult>("edge", () => edgeLocked(deps), "infra-fail");
    const releases = (await skippedForTheDay(deps, "alpha"))
      ? ["skipped"]
      : await guarded<readonly string[]>("release", () => updateLocked(deps, {}), ["infra-fail"]);
    await publishPending(deps);
    return { edge, releases };
  } finally {
    await lock.release();
  }
}

/**
 * Runs `argv`; returns its stdout, and throws on a non-zero exit with the tail of its stderr. With
 * `logPath` (R633 I1), stdout and stderr are written there first, on EVERY exit, so the gate's own
 * output (leg C's per-fact lines included) survives a failing run.
 */
export async function runToLog(
  argv: string[],
  env: Record<string, string> = {},
  cwd?: string,
  logPath?: string,
): Promise<string> {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (logPath !== undefined)
    await writeFile(
      logPath,
      `$ ${argv.join(" ")}\n-- exit ${code}\n-- stdout\n${out}\n-- stderr\n${err}\n`,
    );
  if (code !== 0) throw new Error(`${argv.join(" ")}: exit ${code}: ${err.slice(-400)}`);
  return out;
}

/** Real side effects. */
export function realDeps(root = ROOT): UpdateDeps {
  const run = (argv: string[], env: Record<string, string> = {}, cwd?: string) =>
    runToLog(argv, env, cwd);
  return {
    root,
    listReleases: async () =>
      (
        await run([
          "gh",
          "release",
          "list",
          "--repo",
          REPO,
          "--limit",
          "50",
          "--json",
          "tagName",
          "--jq",
          ".[].tagName",
        ])
      )
        .split("\n")
        .filter((t) => t !== ""),
    download: async (tag, dir) => {
      await run([
        "gh",
        "release",
        "download",
        tag.startsWith("edge-") ? "edge" : tag,
        "--repo",
        REPO,
        "--dir",
        dir,
        "--pattern",
        "*x86_64-unknown-linux*.tar.xz",
        "--pattern",
        "SHA256SUMS",
      ]);
      const files = await readdir(dir);
      const tarball = files.find((f) => f.endsWith(".tar.xz"));
      if (tarball === undefined || !files.includes("SHA256SUMS"))
        throw new Error(`release ${tag} has no linux-x64 tarball or SHA256SUMS`);
      return { tarball: join(dir, tarball), sums: join(dir, "SHA256SUMS") };
    },
    extract: async (tarball, dir) => {
      await run(["tar", "-xJf", tarball, "-C", dir]);
      for (const n of ["al-runner", "alrunner"]) if (existsSync(join(dir, n))) return join(dir, n);
      throw new Error(`no al-runner binary in ${tarball}`);
    },
    versionOf: async (b) => (await run([b, "--version"])).trim(),
    // R-996: the repros of this checkout, run in-process.
    upstreamRepros: async (candidate, current) => (await checkBuild(candidate, current)).lines,
    runGate: async (commit, env, log) => {
      if (!existsSync(GATE_WORKTREE))
        await run([
          "git",
          "-C",
          process.cwd(),
          "worktree",
          "add",
          "--detach",
          GATE_WORKTREE,
          commit,
        ]);
      await run(["git", "-C", GATE_WORKTREE, "checkout", "--detach", commit]);
      // M4: prepare the worktree, or refuse by name before any leg (a throw here is infra-fail:
      // no receipt is written).
      for (const step of GATE_STEPS) await run([...step], {}, GATE_WORKTREE);
      // R614: extracted from the pinned tar, verified against it, or refused by name.
      // I2: logged at once, so the first run's `marked` (or an `extracted`) shows in the update log.
      const prepared = await prepareFixtureSymbols({ worktree: GATE_WORKTREE });
      await log(`fixture .alpackages: ${prepared}`);
      // R633 I1: the itest's own output goes to `gate.log` beside the receipt; `gateOne` keeps it.
      const receipt = env.LETHAL_V3_GATE_RECEIPT;
      await runToLog(
        ["bun", "run", "itest:alrunner-v3"],
        { ...env },
        GATE_WORKTREE,
        receipt !== undefined ? join(dirname(receipt), "gate.log") : undefined,
      );
    },
    inUse: async () => {
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
        if (!exe.startsWith(`${root}/`)) continue;
        // argv[0] is the path the process was started with; undefined when unreadable.
        const argv0 = await readFile(`/proc/${pid}/cmdline`, "utf8")
          .then(argv0FromCmdline)
          .catch(() => undefined);
        if (movesUnder(root, exe, argv0)) return true;
      }
      return false;
    },
    log: async (line) => {
      console.log(line);
      await writeFile(LOG, `${line}\n`, { flag: "a" }).catch(() => {});
    },
    now: () => new Date().toISOString(),
    heavyJobs: async () => {
      const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,args"], { stdout: "pipe" });
      const held = SLOTS.filter(
        (n) =>
          Bun.spawnSync(["flock", "-n", "-E", String(SLOT_BUSY), `${lockDir()}/heavy.${n}`, "true"])
            .exitCode === SLOT_BUSY,
      );
      return countHeavyJobs(
        parsePs(ps.stdout.toString()),
        held.length,
        held.map((n) => readSlotClass(lockDir(), n)),
      );
    },
    gateMemory: async () => {
      const sample = readContainerMemory();
      if (sample?.maxBytes === undefined) return undefined;
      const held = SLOTS.filter(
        (n) =>
          Bun.spawnSync(["flock", "-n", "-E", String(SLOT_BUSY), `${lockDir()}/heavy.${n}`, "true"])
            .exitCode === SLOT_BUSY,
      );
      const unclassed = Math.max(...Object.values(DEFAULT_PEAK_GIB));
      return memoryVerdict(
        sample,
        held.map((n) => readSlot(lockDir(), n)?.peakGiB ?? unclassed),
        PEAK_GIB.gate,
      );
    },
    freeGb: async () => {
      const p = Bun.spawn(["free", "-g"], { stdout: "pipe" });
      const out = await new Response(p.stdout).text();
      const mem = out
        .split("\n")
        .find((l) => l.startsWith("Mem:"))
        ?.trim()
        .split(/\s+/);
      const avail = Number(mem?.[6]);
      if (!Number.isFinite(avail)) throw new Error(`cannot read free -g: ${out}`);
      return avail;
    },
    procCmdline: async (pid) =>
      readFile(`/proc/${pid}/cmdline`, "utf8")
        .then((c) => c.replaceAll("\0", " "))
        .catch(() => undefined),
    procsWithCwdUnder: async (dir) => {
      const pids: number[] = [];
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
        if (cwd === dir || cwd.startsWith(`${dir}/`)) pids.push(Number(pid));
      }
      return pids;
    },
    legsAt: async (commit) =>
      parseGateLegs(
        await run([
          "git",
          "-C",
          dirname(import.meta.dir),
          "show",
          `${commit}:packages/runner/itest/al-runner-v3-gate.ts`,
        ]),
      ),
    selfCommit: async () =>
      (await run(["git", "-C", dirname(import.meta.dir), "rev-parse", "HEAD"])).trim(),
    isAncestor: async (a, b) =>
      (await Bun.spawn(
        ["git", "-C", dirname(import.meta.dir), "merge-base", "--is-ancestor", a, b],
        { stdout: "ignore", stderr: "ignore" },
      ).exited) === 0,
    pinFromAt: async (commit) =>
      (
        await run(["git", "-C", dirname(import.meta.dir), "show", `${commit}:${PIN_FILE}`])
      ).includes(V3_PIN_FROM_ENV_NAME),
    pinsMovedSince: async (commit) =>
      (await Bun.spawn(
        ["git", "-C", dirname(import.meta.dir), "diff", "--quiet", commit, "HEAD", "--", PINS_FILE],
        { stdout: "ignore", stderr: "ignore" },
      ).exited) !== 0,
    commitOrder: async (base, head) => {
      const s = (
        await run(["gh", "api", `repos/${REPO}/compare/${base}...${head}`, "--jq", ".status"])
      ).trim();
      if (s !== "ahead" && s !== "behind" && s !== "identical" && s !== "diverged")
        throw new Error(`compare ${base}...${head}: "${s}"`);
      return s;
    },
    publishEntries: (entries) =>
      publishToMaster(entries, { repo: dirname(import.meta.dir), worktree: PIN_WORKTREE }),
    listedBuilds: gatedBuilds,
    // R886: al-runner ships the sidecar as source only (tools/dotnet-sidecar), not in any release
    // or edge asset. Fetch that folder at the build's commit, publish it with the SDK, and run
    // nothing from inside the download: every path is an argument, the cwd is a separate empty dir.
    buildSidecar: async (commit, outDir) => {
      const work = await mkdtemp(join(root, ".sidecar-"));
      try {
        const [src, cwd] = [join(work, "src"), join(work, "cwd")];
        await mkdir(src);
        await mkdir(cwd);
        const tgz = join(work, "source.tar.gz");
        const p = Bun.spawn(["gh", "api", `repos/${REPO}/tarball/${commit}`], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [bytes, err] = [
          await new Response(p.stdout).arrayBuffer(),
          await new Response(p.stderr).text(),
        ];
        if ((await p.exited) !== 0) throw new Error(`gh api tarball ${commit}: ${err.slice(-300)}`);
        await writeFile(tgz, new Uint8Array(bytes));
        await run(["tar", "-xzf", tgz, "-C", src, "--wildcards", "*/tools/dotnet-sidecar/*"]);
        const top = (await readdir(src))[0];
        const csproj = join(src, top ?? "", "tools", "dotnet-sidecar", "AlDotNetSidecar.csproj");
        if (!existsSync(csproj)) throw new Error(`no tools/dotnet-sidecar at ${commit}`);
        // The cwd has no global.json (the sidecar's pins SDK 8; the container has 10).
        await run(
          [
            process.env.DOTNET ?? "/opt/dotnet/dotnet",
            "publish",
            csproj,
            "--configuration",
            "Release",
            "--output",
            outDir,
          ],
          {
            DOTNET_CLI_HOME: join(work, "home"),
            DOTNET_NOLOGO: "1",
            DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          },
          cwd,
        );
        const dll = join(outDir, "AlDotNetSidecar.dll");
        if (!existsSync(dll)) throw new Error("dotnet publish wrote no AlDotNetSidecar.dll");
        return dll;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/** R814: the file and literal `pinFromAt` looks for; the literal is checked by a test. */
const PIN_FILE = "packages/runner/src/al-runner-v3-pin.ts";
const V3_PIN_FROM_ENV_NAME = `export const V3_PIN_FROM_ENV = "${V3_PIN_FROM_ENV}"`;

/** Every hand pin's readings digest, for `masterPinDigests`. */
export function pinDigests(): Record<string, string> {
  return Object.fromEntries(V3_BUILD_PINS.map((p) => [p.id, v3ReadingsDigest(p)]));
}

/** The digests master's own code computes, in the pin worktree (its script, its pins). */
async function masterPinDigests(worktree: string): Promise<Record<string, string>> {
  await runToLog(["bun", "install", "--frozen-lockfile"], {}, worktree);
  const out = await runToLog(
    ["bun", "scripts/al-runner-v3-update.ts", "--pin-digests"],
    {},
    worktree,
  );
  return JSON.parse(out) as Record<string, string>;
}

/**
 * R814: adds `entries` to origin/master's gated-builds file, from its own worktree, and pushes. It
 * checks each row against MASTER's pins, not this checkout's: a row whose hand pin is unmerged, or
 * differs on master, is refused alone. The commit touches that one file or nothing. Never forced: a rejected push refetches
 * and tries again, twice.
 */
export async function publishToMaster(
  entries: readonly GatedBuildEntry[],
  o: {
    readonly repo: string;
    readonly worktree: string;
    /** Each hand pin's digest as master has it (tests fake it; master's own script computes it). */
    readonly digestsOf?: (worktree: string) => Promise<Readonly<Record<string, string>>>;
  },
): Promise<PublishResult> {
  const git = (...a: string[]) => runToLog(["git", "-C", o.worktree, ...a]);
  if (!existsSync(o.worktree))
    await runToLog(["git", "-C", o.repo, "worktree", "add", "--detach", o.worktree, "HEAD"]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await git("fetch", "origin", "master");
    await git("checkout", "--detach", "--force", "FETCH_HEAD");
    const file = join(o.worktree, GATED_BUILDS_FILE);
    const rows = JSON.parse(await readFile(file, "utf8")) as GatedBuildEntry[];
    const digests = await (o.digestsOf ?? masterPinDigests)(o.worktree);
    const handIds = new Set(Object.keys(digests));
    const published: string[] = [];
    const refused: { id: string; why: string }[] = [];
    const fresh: GatedBuildEntry[] = [];
    for (const e of entries) {
      if (rows.some((r) => r.id === e.id)) {
        published.push(e.id);
        continue;
      }
      try {
        parseGatedBuilds([...rows, ...fresh, e], handIds);
        if (digests[e.readingsFrom] !== e.readingsDigest)
          throw new Error(`${e.readingsFrom} on master is not the pin ${e.id} was gated by`);
        fresh.push(e);
      } catch (err) {
        refused.push({ id: e.id, why: err instanceof Error ? err.message : String(err) });
      }
    }
    if (fresh.length === 0) return { published, refused };
    const next = [...rows, ...fresh].sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    await git("add", GATED_BUILDS_FILE);
    const touched = (await git("diff", "--cached", "--name-only")).trim();
    if (touched !== GATED_BUILDS_FILE)
      throw new Error(`gated-builds publish refused: the commit would touch ${touched}`);
    await git(
      "commit",
      "-q",
      "-m",
      `R814: gated build${fresh.length > 1 ? "s" : ""} ${fresh.map((e) => e.id).join(", ")} [skip ci]`,
    );
    try {
      await git("push", "-q", "origin", "HEAD:master");
      return { published: [...published, ...fresh.map((e) => e.id)], refused };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The edge path's real side effects, with the per-day log. */
export function realEdgeDeps(root = ROOT): UpdateDeps & EdgeDeps {
  const base = realDeps(root);
  const day = new Date().toISOString().slice(0, 10);
  const log = `/coord/handoff/al-runner-v3-update/${day}.log`;
  return {
    ...base,
    log: async (line) => {
      console.log(line);
      await mkdir("/coord/handoff/al-runner-v3-update", { recursive: true }).catch(() => {});
      await writeFile(log, `${line}\n`, { flag: "a" }).catch(() => {});
    },
    edgeCommit: async () => {
      const p = Bun.spawn(
        ["gh", "release", "view", "edge", "--repo", REPO, "--json", "targetCommitish,name,body"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error("gh release view edge failed");
      const j = JSON.parse(out) as { targetCommitish?: string; name?: string; body?: string };
      const sha = [j.targetCommitish, j.name, j.body]
        .map((s) => /\b[0-9a-f]{7,40}\b/.exec(s ?? "")?.[0])
        .find((s) => s !== undefined);
      if (sha === undefined) throw new Error("edge names no commit");
      return sha;
    },
  };
}

if (import.meta.main && process.argv.includes("--pin-digests")) {
  console.log(JSON.stringify(pinDigests()));
} else if (import.meta.main && process.argv.includes("--refresh-rows")) {
  const repo = dirname(import.meta.dir);
  const ids = (process.argv[process.argv.indexOf("--refresh-rows") + 1] ?? "")
    .split(",")
    .filter((s) => s !== "");
  const out = await refreshRows(
    {
      ...realDeps(),
      manifestPath: join(repo, GATED_BUILDS_FILE),
      isDirty: async () =>
        (
          await runToLog(["git", "-C", repo, "status", "--porcelain", "--untracked-files=no"])
        ).trim() !== "",
    },
    ids,
  );
  console.log(`al-runner-v3-update --refresh-rows: ${out.join(", ")}`);
  process.exitCode = out.length === ids.length && out.every((o) => o === "pass") ? 0 : 2;
} else if (import.meta.main && process.argv.includes("--edge")) {
  console.log(`al-runner-v3-update --edge: ${await edgeOnce(realEdgeDeps())}`);
} else if (import.meta.main && process.argv.includes("--edge-rejudge")) {
  const sha = process.argv[process.argv.indexOf("--edge-rejudge") + 1] ?? "";
  const out = await edgeRejudge(realEdgeDeps(), sha);
  console.log(`al-runner-v3-update --edge-rejudge: ${out}`);
  process.exitCode = updateExitCode(true, [out]);
} else if (import.meta.main) {
  const i = process.argv.indexOf("--regate");
  const regateAt = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (regateAt === undefined || !/^[0-9a-f]{40}$/.test(regateAt))) {
    throw new Error("--regate needs a full 40-character LethAL commit sha (F6)");
  }
  if (regateAt !== undefined) {
    const out = await updateOnce(realDeps(), { regateAt });
    console.log(`al-runner-v3-update: ${out.join(", ")}`);
    process.exitCode = updateExitCode(true, out);
  } else {
    const r = await dailyOnce(realEdgeDeps());
    console.log(
      `al-runner-v3-update: edge ${r.edge}; releases ${r.releases.join(", ") || "no candidate"}`,
    );
  }
}
