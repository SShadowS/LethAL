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
    "sourceDir" | "testDir" | "qualifiedTest" | "packagesDir" | "preprocessorSymbols"
  >,
): string[] {
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
    "--auto-provision",
    // Bundle dirs are POSITIONAL and repeatable in v2; multiple dirs run sequentially and
    // aggregate into one summary envelope.
    req.sourceDir,
    req.testDir,
  ];
  if (req.packagesDir) argv.push("--package-cache", req.packagesDir);
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

  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  observedBcBuild(): AlRunnerBcBuild | undefined {
    return this.lastBcBuild;
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
