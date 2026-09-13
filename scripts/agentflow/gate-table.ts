/**
 * Which live legs a change must run, decided from its changed paths alone.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "Selection is
 * default-deny, by module". Pure: this module reads no disk and runs nothing.
 *
 * Two rules carry the whole safety argument, and both exist because a first draft of the table got
 * it wrong in a way that would have merged unverified work.
 *
 * **Default-deny.** A path matching no rule selects THE FULL SET, never nothing. The first draft
 * omitted `packages/builtin-tier2/**`, which exists and holds the Tier-2 operators that only
 * `itest:tables` and `itest:chunked` exercise, so every Tier-2 change would have run zero live
 * legs and merged on unit tests alone. That omission is not a one-off to be fixed and forgotten:
 * this table is a hand-maintained model of a moving codebase, so it will be incomplete again. What
 * matters is which direction incompleteness fails in.
 *
 * **Rows union, they never override.** A diff touching `packages/runner/src/publisher.ts` matches
 * both the general runner row and the publisher row, and needs both sets. A first-match or
 * most-specific rule would let a narrow row silently REMOVE a leg the general row required, which
 * is the direction that loses a gate. Specific rows exist only to add.
 *
 * The structural delta (running the mutation planner per fixture and diffing the key set against
 * each committed baseline) may add legs to whatever this returns. It may never remove one: a
 * change can move a verdict with an unchanged key set, which R220 measured when wiring al-runner
 * coverage moved four verdicts with the mutant population unchanged at 19.
 */

/** Every live leg the repo has. `envtool` is absent on purpose: see `MANUAL_ONLY`. */
export const LEGS = [
  "bcdev",
  "lease",
  "stale-publish",
  "tables",
  "chunked",
  "alrunner",
  "hang",
  "coverage-differential",
] as const;

export type Leg = (typeof LEGS)[number];

/**
 * Everything an unmatched path selects. `coverage-differential` is deliberately NOT here: it is a
 * required gate for the coverage rows but has no `package.json` script and no receipt today, so
 * including it in the default would park every unmatched change on a gate nobody can run yet.
 */
export const FULL_SET: readonly Leg[] = [
  "bcdev",
  "lease",
  "stale-publish",
  "tables",
  "chunked",
  "alrunner",
  "hang",
];

/**
 * Legs must run in this order, which is by DESTRUCTIVE RESIDUE and not by cost.
 *
 * `bcdev` precedes `lease` because the lease gate reads the registered sandbox artifact and tells
 * the operator to run bcdev first if none is registered (its `no registered artifact` guidance). `hang` is
 * terminal because its OFF leg strands an operation marker BY DESIGN and its cleanup is
 * best-effort; a failure there makes later bcdev runs refuse with `operation-orphaned`
 * (the OFF leg's teardown), so a cheap-first schedule would make one gate red for the previous
 * gate's residue.
 */
export const LEG_ORDER: readonly Leg[] = [
  "bcdev",
  "lease",
  "stale-publish",
  "tables",
  "chunked",
  "alrunner",
  "coverage-differential",
  "hang",
];

/** Which container each leg runs against. One instrumented target per container is a hard rule. */
export const LEG_CONTAINER: Readonly<Record<Leg, "agent-app" | "agent-data">> = {
  bcdev: "agent-app",
  lease: "agent-app",
  "stale-publish": "agent-app",
  alrunner: "agent-app",
  hang: "agent-app",
  tables: "agent-data",
  chunked: "agent-data",
  "coverage-differential": "agent-data",
};

interface Rule {
  /** Matched against a POSIX-style repo-relative path. */
  readonly test: (path: string) => boolean;
  readonly legs: readonly Leg[];
  /** Present when the rule parks instead of gating. */
  readonly park?: string;
  readonly why: string;
}

const startsWith =
  (...prefixes: readonly string[]) =>
  (p: string) =>
    prefixes.some((prefix) => p.startsWith(prefix));

const isOneOf =
  (...paths: readonly string[]) =>
  (p: string) =>
    paths.includes(p);

const RULES: readonly Rule[] = [
  {
    test: (p) => p.startsWith("docs/") || (p.endsWith(".md") && !p.includes("/")),
    legs: [],
    why: "documentation cannot change a verdict",
  },
  {
    test: (p) => p.startsWith("scripts/") && !p.startsWith("scripts/agentflow/"),
    legs: [],
    why: "scripts are not on the measurement path; the gate scripts themselves are protected",
  },
  {
    test: startsWith(
      "packages/engine/",
      "packages/operator-sdk/",
      "packages/builtin-tier1/",
      "packages/builtin-tier2/",
    ),
    legs: ["bcdev", "tables", "chunked", "alrunner"],
    why: "these decide WHICH mutants exist and what their identity is",
  },
  {
    test: startsWith("packages/schemata/"),
    // `hang` is here because the selector schemata emits is what the stop has to interrupt, and no
    // other fixture contains a non-terminating mutant.
    legs: ["bcdev", "tables", "chunked", "alrunner", "hang"],
    why: "the compiler that instruments a project, including the selector the stop interrupts",
  },
  {
    test: startsWith("packages/runner/"),
    legs: ["bcdev", "lease", "tables", "chunked", "alrunner"],
    why: "orchestration, backends, store and transport",
  },
  {
    test: isOneOf(
      "packages/runner/src/publisher.ts",
      "packages/runner/src/app-version.ts",
      "packages/runner/src/publish-serializer.ts",
      "packages/runner/src/deployment-verifier.ts",
    ),
    legs: ["stale-publish"],
    why: "stale-publish is the only gate that races two altool publishes and asserts ordering",
  },
  {
    test: isOneOf("packages/runner/src/run-mutant-transport.ts", "packages/runner/src/harness.ts"),
    legs: ["hang"],
    why: "hang is the only gate with non-terminating mutants and the only one asserting a client abort is never promoted to timeout-killed",
  },
  {
    test: (p) =>
      /^packages\/runner\/src\/coverage[^/]*\.ts$/.test(p) ||
      isOneOf(
        "packages/runner/src/selection.ts",
        "packages/runner/src/line-map.ts",
        "packages/runner/src/interpretation.ts",
      )(p),
    legs: ["coverage-differential"],
    why: "attribution changes leave every frozen gate green while moving what was attributed",
  },
  {
    test: (p) => /^packages\/runner\/src\/env-tool[^/]*\.ts$/.test(p),
    legs: [],
    park: "manual-only: the envtool environment was deleted 2026-09-01 and no substitute gate exists",
    why: "the live leg cannot run and the proposed local substitute had no protocol, container, order position or receipt schema",
  },
  {
    test: startsWith("extensions/lethal-control/"),
    legs: FULL_SET,
    why: "the control app is on every gate's path; needs a bootstrap transaction first",
  },
  {
    test: startsWith("fixtures/sandbox-app/", "fixtures/sandbox-tests/"),
    legs: ["bcdev", "alrunner"],
    why: "the codeunit fixture and its suite",
  },
  {
    test: startsWith("fixtures/sandbox-probes/"),
    legs: ["bcdev", "lease"],
    why: "a missing probe app leaves bcdev's verdicts correct while only its protocol probe fails",
  },
  {
    test: startsWith("fixtures/sandbox-data/", "fixtures/sandbox-data-tests/"),
    legs: ["tables", "chunked"],
    why: "the table fixture and its suite",
  },
  {
    test: startsWith("fixtures/sandbox-hang/", "fixtures/sandbox-hang-tests/"),
    legs: ["hang"],
    why: "the hang fixture and its suite",
  },
];

export interface Selection {
  /** The legs to run, in `LEG_ORDER`. */
  readonly legs: readonly Leg[];
  /** Non-empty means the change cannot be gated autonomously; each entry is a reason. */
  readonly park: readonly string[];
  /** Paths that matched no rule and therefore widened the selection to the full set. */
  readonly unmatched: readonly string[];
}

/** Thrown for a caller-contract violation, never returned as a plausible empty selection. */
export class GateSelectionError extends Error {}

/**
 * Select the legs a change must run.
 *
 * An empty `changedPaths` throws rather than returning "no legs": a caller that computed an empty
 * diff and asked what to run has a bug, and answering "nothing" would let it merge.
 */
export function selectLegs(changedPaths: readonly string[]): Selection {
  if (changedPaths.length === 0) {
    throw new GateSelectionError("selectLegs called with no changed paths");
  }

  const legs = new Set<Leg>();
  const park = new Set<string>();
  const unmatched: string[] = [];

  for (const raw of changedPaths) {
    const path = raw.replace(/\\/g, "/");
    if (path.length === 0) throw new GateSelectionError("empty path in changedPaths");

    const matched = RULES.filter((r) => r.test(path));
    if (matched.length === 0) {
      // Default-deny. See the header: this is the direction incompleteness must fail in.
      unmatched.push(path);
      for (const l of FULL_SET) legs.add(l);
      continue;
    }
    for (const rule of matched) {
      // Union, never override.
      for (const l of rule.legs) legs.add(l);
      if (rule.park !== undefined) park.add(`${path}: ${rule.park}`);
    }
  }

  return {
    legs: LEG_ORDER.filter((l) => legs.has(l)),
    park: [...park],
    unmatched,
  };
}

/**
 * Widen a selection with the legs the offline structural delta implies.
 *
 * Only ever adds. The signature has no way to express a removal, which is the point.
 */
export function widenWithDelta(base: Selection, deltaLegs: readonly Leg[]): Selection {
  const legs = new Set<Leg>(base.legs);
  for (const l of deltaLegs) legs.add(l);
  return { ...base, legs: LEG_ORDER.filter((l) => legs.has(l)) };
}
