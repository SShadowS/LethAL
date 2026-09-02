import { type SpawnFn, defaultSpawn } from "./publisher";

export interface AlRunnerRequest {
  readonly sourceDir: string;
  readonly testDir: string;
  /**
   * The name al-runner v2 both FILTERS on (`--test`) and REPORTS back, which is the
   * qualified `Codeunit<id>.<method>` form — build it with `qualifiedTestName` and never
   * by hand, so the filter we send and the row a caller matches cannot drift apart.
   */
  readonly qualifiedTest: string;
  readonly packagesDir?: string;
  readonly testTimeoutSeconds: number;
  readonly deadlineMs: number;
  /** R101(c) — see `AlRunnerConfig.preprocessorSymbols`. */
  readonly preprocessorSymbols?: readonly string[];
  /**
   * R147 — the Microsoft platform-app directory THIS session's one-time provisioning run reported
   * writing, handed straight back to the runner as an extra `--package-cache`.
   *
   * Present only after `AlRunnerBackend.usePlatformAppsDir` has been called with a directory that
   * passed every check in `provisionOnce`. Its presence is what suppresses `--auto-provision` — see
   * `buildAlRunnerArgv`, which is the one place the two are made mutually exclusive.
   */
  readonly platformAppsDir?: string;
}

export interface AlRunnerRawTest {
  readonly name: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly message?: string;
}

export type AlRunnerResult =
  | { readonly kind: "tests"; readonly tests: readonly AlRunnerRawTest[] }
  | { readonly kind: "deadline" }
  | { readonly kind: "error"; readonly detail: string };

export interface AlRunnerTransport {
  send(req: AlRunnerRequest): Promise<AlRunnerResult>;
  close(): Promise<void>;
  /**
   * R129: which BC artifact build al-runner announced it was executing against, as observed on the
   * runs this transport has already made. `undefined` before any run, and after a run whose output
   * carried no such line — never a guess.
   *
   * See `parseAlRunnerBcBuild` for why the answer is read off the runner's own words rather than
   * pinned by us with `--bc-version`.
   */
  observedBcBuild(): AlRunnerBcBuild | undefined;
  /** R148 — the first "NO IMPLEMENTATION" warning any invocation printed, if any. */
  observedMissingImplementation(): AlRunnerMissingImplementation | undefined;
}

/** R129 — the BC runtime an al-runner invocation announced, plus the line it was read from. */
export interface AlRunnerBcBuild {
  /** The version as announced, e.g. `28.1.49838.50794`. */
  readonly build: string;
  /** The runner's own line, verbatim and untrimmed of meaning — a reader who distrusts the parse
   *  can check it, and a future wording change is visible in the report rather than silent. */
  readonly announcement: string;
}

/**
 * Reads the BC artifact build al-runner announced out of its output. R129.
 *
 * Every invocation says which BC runtime it selected, and until this existed LethAL threw the line
 * away: a report named which al-runner BINARY ran (R123's contract probe) but not which BC RUNTIME
 * that binary executed the tests against, which is what the verdicts actually depend on.
 *
 * MEASURED 2026-08-09 on al-runner 2.1.1.0: these lines go to **stderr**, not stdout. Both forms
 * occur, and both are accepted:
 *
 *     [bc] no --bc-version given - selecting BC 28.1.49838.50794, the exact build this binary was
 *          compiled against. Override with --bc-version.
 *     [bc] selected BC 28.1.49838.50794 (~/.local/share/al-runner/artifacts/28.1.49838.50794)
 *
 * `selected` wins when both are present: it is the runner's statement of what it actually used,
 * where `selecting` is its statement of intent.
 *
 * WHY READ IT RATHER THAN PIN IT. Passing `--bc-version` ourselves would make the choice LethAL's,
 * and R125 measured that failure mode: a project whose symbols do not match the pin fails loudly
 * for a reason we introduced, and `--auto-provision` resolving the version is exactly what cured
 * it. Reading is also the only thing that would make a future divergence DETECTABLE — 2.1.1's own
 * `--help` documents a different default rule ("the latest version present in the artifacts dir")
 * from the one its runtime announces ("the exact build this binary was compiled against"). If a
 * release ever makes the help text true, selection becomes machine-state-dependent, and a run that
 * recorded nothing would give no way to tell two differing runs apart afterwards.
 *
 * Returns `undefined` when nothing matched. That is the honest "the runner did not say", never a
 * defaulted version — a wrong BC build recorded as fact is worse than an absent one.
 */
/** R148 — an app al-runner resolved to a package carrying NO procedure bodies. */
export interface AlRunnerMissingImplementation {
  /** The app as al-runner named it, e.g. `LethAL/LethAL Sandbox App v1.0.0.999`. */
  readonly app: string;
  /** The runner's own first line, verbatim, so a reader can grep the transcript for it. */
  readonly announcement: string;
}

/**
 * Reads al-runner's "resolved to a package with NO IMPLEMENTATION" warning out of its output. R148.
 *
 * al-runner prints this when dependency resolution picks a SYMBOL-ONLY package for an app the tests
 * call into:
 *
 *     [dep] LethAL/LethAL Sandbox App v1.0.0.999 resolved to a package with NO IMPLEMENTATION
 *           (no publishedartifacts DLL, no src/*.al) and no other copy was found in the package
 *           caches: ... Calls into this app will fail with "The object with ID 0 does not have a
 *           member with that ID".
 *
 * **Why this is worth reading rather than ignoring.** On the fixture it is harmless — the run also
 * compiles the target from source and an implementation package wins at execution time, so
 * resolution names one package and execution uses another, and the gate has been green either way
 * for months. On a REAL project the same line means the session is measuring an app whose procedure
 * bodies are absent, which is a whole-session correctness problem: every mutant in that app would be
 * scored against a program that cannot run. The difference between the two is not visible from the
 * line, which is exactly why it has to reach the report rather than the terminal scrollback.
 *
 * Anchored on `[dep] ` at line start, like `parseAlRunnerBcBuild`'s `[bc] `, so the phrase appearing
 * inside a test's own failure text can never be mistaken for the runner's announcement.
 *
 * Returns `undefined` when nothing matched. Absence is "the runner did not say it", never "there is
 * no problem".
 */
export function parseAlRunnerMissingImplementation(
  output: string,
): AlRunnerMissingImplementation | undefined {
  const match = /^\[dep\] (.+?) resolved to a package with NO IMPLEMENTATION\b.*$/m.exec(output);
  if (match === null) return undefined;
  const [line, app] = match;
  if (app === undefined) return undefined;
  return { app: app.trim(), announcement: line.trim() };
}

export function parseAlRunnerBcBuild(output: string): AlRunnerBcBuild | undefined {
  // Anchored on `[bc] ` at line start so a version number appearing in a test's own failure text
  // can never be mistaken for the runner's announcement.
  const selected = /^\[bc\] selected BC ([0-9]+(?:\.[0-9]+)+)\b.*$/m.exec(output);
  const chosen = selected ?? /^\[bc\][^\n]*\bselecting BC ([0-9]+(?:\.[0-9]+)+)\b.*$/m.exec(output);
  if (chosen === null) return undefined;
  const [line, build] = chosen;
  if (build === undefined) return undefined;
  return { build, announcement: line.trim() };
}

/**
 * R147 — what `parseAlRunnerPlatformAppsDir` found, including WHY it found nothing.
 *
 * A bare `string | undefined` was the obvious shape and is the wrong one. "No pin" has three
 * distinguishable causes and a reader who is told only that the optimisation is off cannot tell a
 * reworded runner from a conflicted one from a build of LethAL that never had the feature. Silence
 * on the negative path is exactly how this feature would die unnoticed.
 */
export type AlRunnerPlatformAppsParse =
  | {
      readonly kind: "found";
      /** The path exactly as the runner printed it, never normalised — the normalised form exists
       *  only to compare two spellings, and an operator reading a refusal wants the real string. */
      readonly dir: string;
      /**
       * How many `.app` files the runner said it wrote there. The caller turns this into a floor.
       *
       * ZERO when `basis` is `"already-complete"`: that sentence states no count, and inventing one
       * is the guess this parser exists to avoid. The caller applies a weaker but honest check
       * instead — see `basis`.
       */
      readonly appCount: number;
      /**
       * WHICH sentence established the pin, because the two support different checks.
       *
       * `"downloaded"` — the runner said it wrote N apps, so the caller can require the directory to
       * hold at least N and catch a provisioning that stopped part-way.
       *
       * `"already-complete"` — the runner said the directory is already complete and stated no
       * count. The caller can only require it to be non-empty. That is weaker, and it is recorded
       * here rather than hidden so the difference is visible at the call site.
       *
       * `"selected-artifact"` (R200) — the runner printed NO provisioning sentence at all (2.10.0.0
       * on a warm cache), and the directory is `<artifact dir>/platform-apps` derived from its
       * `[bc] selected BC <build> (<artifact dir>)` line, the layout both earlier sentences named
       * verbatim. Same non-empty check as `already-complete`; the derivation is named in the
       * refusal if the directory is not there.
       */
      readonly basis: "downloaded" | "already-complete" | "selected-artifact";
    }
  | { readonly kind: "no-completion-line" }
  | { readonly kind: "conflicting"; readonly dirs: readonly string[] };

/**
 * Whether an exit code is one the CHILD chose, rather than one a signal imposed on it.
 *
 * Measured for R123: `defaultSpawn` given an aborted signal RESOLVES, after the kill, with
 * `exitCode: 143` (128 + SIGTERM) and whatever partial stdout the child had written; a spawn failure
 * surfaces as a negative code. Neither is al-runner answering.
 *
 * Lives here rather than inside `al-runner-contract.ts` because R147 needs the same question
 * answered about the one-time provisioning run — a killed provisioning can print a completion
 * sentence and leave a half-written directory behind, and `AlRunnerProvisionResult.ran`
 * (`exitCode >= 0`) says `true` for it. Two spellings of "is this the runner speaking" would let one
 * of them go stale without the other noticing, so there is one.
 */
export function isChildChosenExit(exitCode: number): boolean {
  return exitCode >= 0 && exitCode < 128;
}

/**
 * The COMPLETION sentence al-runner prints once it has finished writing the Microsoft platform apps.
 *
 * Measured 2026-08-15 on al-runner 2.1.2.0, verbatim:
 *
 *     [provision] Downloaded 6 app(s) (115 MB total) to C:\...\28.0.46665.53671\platform-apps
 *
 * Three things about this regex are load-bearing.
 *
 * - **`^\[provision\] ` anchored at line start.** A test's own failure text can contain anything,
 *   including a path. The same rule `parseAlRunnerBcBuild` keeps for `[bc] `, for the same reason.
 * - **`Downloaded <N> app(s)`, not merely "Downloaded".** The SAME output carries
 *   `[provision] Downloaded 107 test .app file(s) (20 MB) to <...>\test-apps`, which is the test
 *   toolkit and not this. It is rejected twice over: the noun phrase differs and so does the
 *   directory.
 * - **The directory must END in `platform-apps`, and the path is taken to end of line.** That is
 *   what makes a path containing spaces safe. The prefix before it is LAZY, so the match starts at
 *   the FIRST position on the line where a rooted path begins, and everything after it — spaces
 *   included — belongs to the path. A greedy prefix would instead start at the last such position,
 *   which for `C:\Users\John Smith\...\platform-apps` is still `C:`, but only by luck.
 *
 * `~` is an accepted root even though nothing has been seen to print one here, because this runner
 * DOES print `~`-rooted paths elsewhere (`parseAlRunnerBcBuild`'s doc comment records one). Reading
 * it means the caller reports "that directory does not exist"; skipping it would report "the runner
 * printed nothing", and the difference is the whole value of the refusal.
 *
 * The separator before the path is a plain `\s`, and that is safe HERE and would not have been on
 * the `fetching` line: `od -c` of 2.1.2.0's output shows that one carrying a raw `0x1A` (SUB) where
 * an arrow glyph was mangled by the console code page. This sentence is `... to <path>` in ASCII.
 * Not reading the other line is what keeps this expression free of control characters.
 */
const PLATFORM_APPS_COMPLETION =
  /^\[provision\] Downloaded (\d+) app\(s\)[^\n]*?\s((?:[A-Za-z]:[\\/]|[\\/]|~[\\/])[^\n]*platform-apps[\\/]?)[ \t\r]*$/gm;

/**
 * The WARM-CACHE sentence, which names the same directory without downloading anything.
 *
 * Measured 2026-08-28 on al-runner 2.7.0.0, verbatim:
 *
 *     [provision] platform apps already complete at C:\...\28.0.46665.53952\platform-apps.
 *
 * **Why this had to exist, and why its absence was a real defect rather than a cosmetic gap.**
 * R147's whole purpose is to stop paying `--auto-provision` on every mutant invocation. Reading only
 * the `Downloaded` sentence meant the pin could be established ONLY on a run that actually
 * downloaded — so the optimisation switched itself off precisely when the cache was healthy, which
 * is the normal case. `itest:alrunner` caught it as a failed assertion the first time the gate ran
 * on a warm cache. The refusal message had named this possibility all along ("the cache was already
 * complete and the runner said nothing"); nothing had ever acted on it.
 *
 * Two things keep this from matching the wrong line, and both are exercised by the sibling
 * sentences in the SAME output:
 *
 * - **The directory must still end in `platform-apps`.** The same run prints
 *   `[provision] BC 28.1.49838.50794 engine artifacts already complete at C:\...\28.1.49838.50794.`
 *   — the same "already complete at" phrasing for the ENGINE, which must never be pinned as a
 *   package cache.
 * - **The noun phrase is `platform apps`, not `test toolkit`.** The run also prints
 *   `[provision] test toolkit already present at C:\...\test-apps.`, rejected twice over: different
 *   wording and a different directory.
 *
 * The trailing `.` is part of the SENTENCE, not the path, so it is consumed outside the capture
 * group. The cold sentence has no full stop, which is why the two patterns cannot be merged into one
 * without making the period optional for both and quietly accepting a path that ends in one.
 */
const PLATFORM_APPS_ALREADY_COMPLETE =
  /^\[provision\] platform apps already complete at ((?:[A-Za-z]:[\\/]|[\\/]|~[\\/])[^\n]*platform-apps[\\/]?)\.?[ \t\r]*$/gm;

/** Separator and trailing-separator insensitive, and case-insensitive on win32 — the three ways one
 *  directory gets two spellings. Used ONLY to compare; the reported path stays verbatim. */
function normalisePlatformAppsPath(p: string): string {
  const unified = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Read the platform-app directory al-runner said it finished writing. R147.
 *
 * WHY THE COMPLETION SENTENCE AND NOT THE INTENT ONE. The same run also prints
 * `[provision] fetching Microsoft platform R2R apps for BC <v> <SEP> <dir>` BEFORE the download
 * starts, so pinning on it would pin a directory that may be half written. That line is also unfit
 * to parse on its own terms: `od -c` of the 2.1.2.0 output shows byte `0x1A` (SUB) where an arrow
 * glyph was mangled by the console code page, so keying on its separator would bind LethAL to
 * whatever encoding the console happened to use. And its wording moved inside one week — on 2.1.1.0
 * (R130's transcript) it ended in a literal `...` and carried no path at all.
 *
 * WHY A COUNT COMES BACK WITH IT. The runner states how many apps it wrote in the same sentence that
 * states where. Reading that number is the same principle as reading the path; deciding the number
 * six ourselves would be the guess. The caller turns it into a floor on the directory's contents,
 * which is what catches a provisioning that stopped part-way.
 *
 * TWO PASSES, ONE DIRECTORY. `--auto-provision` provisions twice per invocation (R130), so the
 * sentence normally appears twice naming the same place. Identical answers are one answer. Two
 * DIFFERENT directories return `conflicting` and pin nothing: LethAL has no basis for picking one,
 * and picking one anyway is the invented-plausible-default this project refuses.
 */
export function parseAlRunnerPlatformAppsDir(output: string): AlRunnerPlatformAppsParse {
  PLATFORM_APPS_COMPLETION.lastIndex = 0;
  PLATFORM_APPS_ALREADY_COMPLETE.lastIndex = 0;
  const seen = new Map<string, string>();
  let appCount = 0;
  let downloaded = false;
  for (const m of output.matchAll(PLATFORM_APPS_COMPLETION)) {
    const [, count, dir] = m;
    if (count === undefined || dir === undefined) continue;
    seen.set(normalisePlatformAppsPath(dir), dir);
    appCount = Math.max(appCount, Number(count));
    downloaded = true;
  }
  // The warm-cache sentence names the same directory and states no count. Both are scanned because
  // ONE invocation can print both: `--auto-provision` provisions twice (R130), and the second pass
  // finds what the first wrote, so a cold run says "Downloaded ..." then "already complete at ...".
  // They must agree on the directory or this is `conflicting`, exactly as two `Downloaded` lines
  // naming different places would be.
  for (const m of output.matchAll(PLATFORM_APPS_ALREADY_COMPLETE)) {
    const [, dir] = m;
    if (dir === undefined) continue;
    seen.set(normalisePlatformAppsPath(dir), dir);
  }
  if (seen.size === 0) {
    // R200: al-runner 2.10.0.0 says nothing about provisioning on a warm cache. The `[bc] selected`
    // line still names the artifact directory, and both provisioning sentences ever measured put
    // the platform apps at `<that>/platform-apps` (2.1.2.0: `...\28.0.46665.53671\platform-apps`;
    // 2.7.0.0: `...\28.0.46665.53952\platform-apps`), so the location is measured layout. The
    // caller still refuses unless the directory exists and holds an `.app`.
    const selected = /^\[bc\] selected BC [0-9]+(?:\.[0-9]+)+ \(([^)\n]+)\)[ \t\r]*$/m.exec(output);
    const artifactDir = selected?.[1]?.trim();
    if (artifactDir === undefined || artifactDir === "") return { kind: "no-completion-line" };
    const sep = artifactDir.includes("\\") && !artifactDir.endsWith("/") ? "\\" : "/";
    return {
      kind: "found",
      dir: `${artifactDir}${sep}platform-apps`,
      appCount: 0,
      basis: "selected-artifact",
    };
  }
  if (seen.size > 1) return { kind: "conflicting", dirs: [...seen.values()] };
  // Exactly one entry, and `Map` preserves insertion order, so this is the last spelling seen of the
  // one directory every pass agreed on.
  const [dir] = [...seen.values()];
  if (dir === undefined) return { kind: "no-completion-line" };
  // A stated count outranks a bare completeness claim: if ANY pass said how many it wrote, the
  // caller gets the stronger floor. `appCount` stays 0 when only the warm sentence appeared, and
  // `basis` is what tells the caller which check it may apply.
  return {
    kind: "found",
    dir,
    appCount,
    basis: downloaded ? "downloaded" : "already-complete",
  };
}

/**
 * al-runner v2 reports and selects tests by their QUALIFIED name — measured against the
 * installed al-runner v2.0.0.0 (2026-08-07): `--test Codeunit79601.PassesQuietly` selected
 * exactly that one test, and the JSON rows carry the same qualified `name`. This is the ONE
 * place that name is built, so the `--test` filter and the result lookup can never disagree;
 * two independent spellings would mean the runner ran one thing and the caller scored another.
 */
export function qualifiedTestName(codeunitId: number, method: string): string {
  return `Codeunit${codeunitId}.${method}`;
}

/** Enough stdout to recognise what the runner actually said, without dumping a whole suite. */
function stdoutPrefix(stdout: string): string {
  const head = stdout.slice(0, 400);
  return JSON.stringify(stdout.length > 400 ? `${head}...` : head);
}

/**
 * al-runner v2 writes a human progress banner to stdout BEFORE the `--output-json` envelope
 * (measured against v2.0.0.0: `[r2r] re-execing ...`, `[bc] no --bc-version given ...`,
 * `al-runner - running 2 bundle(s)`, a per-bundle line each), so `JSON.parse(stdout)` throws on
 * every real run.
 *
 * The envelope is found as the LAST line that BEGINS with `{` at column zero, and runs from
 * there to the end of output. Three things about that rule are deliberate:
 * - column zero, because banner lines may CONTAIN a brace and "the first `{` anywhere" would
 *   slice mid-banner;
 * - `begins with` rather than `is exactly`, because the measured pretty-printed envelope opens
 *   with a bare `{` line while a compact one-line envelope would open the same way — accepting
 *   both costs nothing and rejects nothing a bare-`{` rule would have accepted;
 * - LAST rather than first, because the envelope always comes after the banner.
 *
 * THROWS rather than returning `[]` on anything it cannot read. An empty test list is
 * indistinguishable from "the filter matched no tests", and a caller that sees no failing test
 * scores the mutant SURVIVED — a silently-empty confirmation, this project's signature bug and
 * the reason R97 exists.
 */
export function parseAlRunnerPayload(stdout: string): readonly AlRunnerRawTest[] {
  const lines = stdout.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").startsWith("{")) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    throw new Error(
      `al-runner produced no --output-json envelope (no line beginning with "{"): ${stdoutPrefix(stdout)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(start).join("\n"));
  } catch (err) {
    throw new Error(
      `al-runner's --output-json envelope is not valid JSON (${err instanceof Error ? err.message : String(err)}): ${stdoutPrefix(stdout)}`,
    );
  }
  const tests =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { tests?: unknown }).tests
      : undefined;
  if (!Array.isArray(tests)) {
    throw new Error(
      `al-runner's --output-json envelope has no "tests" array — a project that failed to COMPILE answers with compilationErrors[] and no tests, and must not be read as "no test failed": ${stdoutPrefix(stdout)}`,
    );
  }
  return tests as readonly AlRunnerRawTest[];
}

/**
 * The exact argv this adapter sends al-runner, in one place.
 *
 * Exported because `al-runner-contract.ts` (R123) measures the wire contract by spawning al-runner
 * ITSELF rather than through `OneShotTransport` — a probe routed through the transport cannot see
 * an exit code the transport already swallowed. That only tells the truth if the probe's command
 * line is the transport's command line; two independent spellings would mean the probe blessed a
 * command nobody runs. So both call this.
 *
 * v2 argv, measured against the installed al-runner v2.0.0.0 (2026-08-07). The v1 shape it replaced
 * (`--run <method> ... --test-isolation method --packages --stubs --test-timeout`) is not merely
 * deprecated: v2 answers an unknown flag with `Unknown option '--run'.` and exit 2, so every one of
 * those spellings had to go.
 */
export function buildAlRunnerArgv(
  alRunnerPath: string,
  req: Pick<
    AlRunnerRequest,
    | "sourceDir"
    | "testDir"
    | "qualifiedTest"
    | "packagesDir"
    | "preprocessorSymbols"
    | "platformAppsDir"
  >,
): string[] {
  // R147 — the pin and `--auto-provision` are MUTUALLY EXCLUSIVE, and this is the one place that is
  // true. Sending both would keep paying what the flag costs (measured 2026-08-15 on 2.1.2.0: 17.1 s
  // and 2 x 115 MB per invocation, on a cache already holding every byte), which is the entire thing
  // the pin exists to stop. A caller therefore cannot assemble a half configuration.
  //
  // The direction of the default matters as much as the exclusivity: NO pin means today's argv,
  // exactly. R125's provisioning invocation and R123's contract probe both build their argv without
  // one and are unaffected by this change.
  const pinned = req.platformAppsDir !== undefined;
  const argv = [
    alRunnerPath,
    "--output-json",
    // v2 renamed the flag AND the mode. `test` gives every [Test] fresh state, which is what
    // AlRunnerBackend.capabilities() claims as `full-reset`. v2 still ACCEPTS `method`, but only as
    // a v1 alias for `codeunit` (state shared within a codeunit) — so the v1 argv was silently
    // buying the weaker isolation (R96).
    "--isolation",
    "test",
    "--test",
    req.qualifiedTest,
    // R125 (measured 2026-08-07 on al-runner 2.1.0.0): with no BC version given, the runner selects
    // the build it was COMPILED against — 28.1.49838.50794 for 2.1.0.0 — and refuses, because a
    // project's `.alpackages` hold SYMBOL-only Microsoft apps and the runtime (R2R) apps for that
    // build are not in its artifact cache. Every mutant then came back `error` and the whole run
    // measured nothing: `itest:alrunner` went 3/13/0 -> 0/0/0 the moment the tool auto-updated.
    //
    // `--auto-provision` is upstream's own named remedy for exactly this ("or re-run with
    // --auto-provision"). Cheap after the first run: artifacts are cached per BC version.
    //
    // CORRECTION, measured 2026-08-08 on 2.1.1.0 (R128): this comment used to say it "resolves the
    // version from the PROJECT rather than from the binary — which is the version whose symbols the
    // project actually carries". That is not what happens. With no `--bc-version` the runner
    // announces `selecting BC <v>, the exact build this binary was compiled against` and provisions
    // THAT, and it works even though the fixture's `.alpackages` carry 28.0.46665.47126 symbols
    // while the selected build is 28.1.49838.50794. It is the `provision` SUBCOMMAND that resolves
    // the project's version — and only for platform apps, which is precisely why that subcommand is
    // not a substitute (see R128).
    //
    // Placed BEFORE the positional bundle dirs deliberately: they are positional and repeatable, so
    // every flag belongs ahead of them.
    //
    // R147: omitted when a platform-app directory is pinned. See `pinned` above.
    ...(pinned ? [] : ["--auto-provision"]),
    // Bundle dirs are POSITIONAL and repeatable in v2; multiple dirs run sequentially and
    // aggregate into one summary envelope.
    //
    // The same dir is never sent twice. On the mutant path the two are different by construction
    // (`AlRunnerBackend.run` passes its active instrumented dir and the test dir), so this is a
    // no-op there. It matters for R128's one-time provisioning invocation, which has no
    // instrumented dir yet and passes the TEST bundle as both — without the dedupe that invocation
    // would compile the same bundle twice for nothing, which on a real project is a whole extra
    // compile before the session starts.
    ...(req.sourceDir === req.testDir ? [req.sourceDir] : [req.sourceDir, req.testDir]),
  ];
  if (req.packagesDir) argv.push("--package-cache", req.packagesDir);
  // R147. `--package-cache` is REPEATABLE (al-runner's own --help: "Extra directory to scan for .app
  // dependencies (repeatable)"), so the pin ADDS to the project's own symbol directory rather than
  // replacing it, and adds to al-runner's default scan rather than replacing that — which is why a
  // project resolving its test toolkit through the default scan keeps doing so. Measured 2026-08-15
  // on 2.1.2.0 in the two-entry shape a real config produces: `package caches: 2 dir(s)`, exit 0,
  // and a `diff` of stderr against today's shape that differs only in that count and two elapsed-ms
  // figures — same dependency resolution, same tests, same results.
  if (req.platformAppsDir !== undefined) argv.push("--package-cache", req.platformAppsDir);
  // R101(c). One repeated `--define SYM` per symbol rather than the comma-separated
  // `--preprocessor-symbols`: 2.1.1's own help says each entry of the comma form "is validated
  // identically to --define", so the two are the same thing, and the repeated form cannot be
  // broken by a symbol that ever contains a comma. Appended AFTER the positional bundle dirs is
  // wrong for this runner (positional args are repeatable), so it goes here, before them, like
  // `--package-cache` — which is itself pushed after the positionals above and measured to work,
  // so the runner's parser is not positional-strict. Keeping this next to it keeps one rule.
  for (const symbol of req.preprocessorSymbols ?? []) argv.push("--define", symbol);
  return argv;
}

/**
 * The env every al-runner invocation carries. v2 dropped `--test-timeout`; the per-test budget is
 * this variable, and the released build honours it (measured: `AL_RUNNER_TEST_TIMEOUT_SEC=15`
 * produced a 15.027 s test). `SpawnFn` merges this over `process.env`, so PATH survives.
 *
 * Exported alongside `buildAlRunnerArgv` and for the same reason — the contract probe must spawn
 * with the budget the transport spawns with, or its timeout measurement describes a run nobody
 * makes.
 */
export function alRunnerEnv(testTimeoutSeconds: number): Record<string, string> {
  return { AL_RUNNER_TEST_TIMEOUT_SEC: String(testTimeoutSeconds) };
}

/** One al-runner process per request. Correct, and pays full compilation each time. */
export class OneShotTransport implements AlRunnerTransport {
  /**
   * R129. Kept LATEST-WINS rather than first-wins: within a session every invocation is the same
   * binary with the same argv and so announces the same build, but if that ever stops being true
   * the report should describe the runs it most recently made rather than a stale first answer.
   * A run that announces nothing leaves the previous observation alone — absence of a line is not
   * evidence the selection changed.
   */
  private lastBcBuild: AlRunnerBcBuild | undefined;
  /**
   * R148. The FIRST one wins rather than the last: al-runner repeats the line identically on every
   * invocation, so keeping the first records when it started without the record changing under a
   * long run.
   */
  private firstMissingImplementation: AlRunnerMissingImplementation | undefined;

  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  observedBcBuild(): AlRunnerBcBuild | undefined {
    return this.lastBcBuild;
  }

  observedMissingImplementation(): AlRunnerMissingImplementation | undefined {
    return this.firstMissingImplementation;
  }

  async send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    const argv = buildAlRunnerArgv(this.alRunnerPath, req);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.spawn(argv, {
          signal: controller.signal,
          env: alRunnerEnv(req.testTimeoutSeconds),
        }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("deadline");
          }, req.deadlineMs);
        }),
      ]);
      if (res === "deadline") return { kind: "deadline" };
      // R129: read the announcement before branching on the exit code, so a run that FAILED still
      // records which BC runtime produced the failure. Both streams are scanned even though the
      // lines were measured on stderr — the cost is a regex over text already in memory, and a
      // future release moving its banner to stdout would otherwise silently stop being recorded.
      const bcBuild = parseAlRunnerBcBuild(`${res.stderr}\n${res.stdout}`);
      if (bcBuild !== undefined) this.lastBcBuild = bcBuild;
      // R148: read on the same pass and from the same two streams, for the same reason — the cost
      // is a regex over text already in memory, and a release moving the line to stdout would
      // otherwise silently stop being recorded.
      if (this.firstMissingImplementation === undefined) {
        this.firstMissingImplementation = parseAlRunnerMissingImplementation(
          `${res.stderr}\n${res.stdout}`,
        );
      }
      // v2 exit codes, from its own --help: 0 = all passed, 1 = at least one test FAILED or
      // ERRORED, 2 = a bundle could not EXECUTE, 3 = a bundle could not COMPILE.
      //
      // Only 0 and 1 carry per-test verdicts. R95: exit 2 used to map to `kind: "skip"`,
      // which turned a process-level failure — the runner never ran the mutant at all —
      // into a silently skipped mutant with no verdict and no error anyone would see. 2 and
      // 3 alike mean "we measured nothing", and so does any negative code (spawn failure),
      // so all of them are errors.
      if (res.exitCode === 0 || res.exitCode === 1)
        return { kind: "tests", tests: parseAlRunnerPayload(res.stdout) };
      return {
        kind: "error",
        detail: res.stderr || res.stdout || `al-runner exited ${res.exitCode} with no output`,
      };
    } catch (err) {
      return { kind: "error", detail: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // nothing retained between requests
  }
}
