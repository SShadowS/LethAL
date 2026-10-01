/**
 * R-278 / R258 / R-371: a per-test digest of what a test RUNS, read from the test app's SOURCE, so
 * `lethal verify` can tell an edited test from an unchanged one. Source, never the compiled
 * package: `alc`'s output differs between two compiles of the same source
 * (docs/measurements/README.md, "Dev endpoint: test-app read-back").
 *
 * Scheme v2 (R-371). A test's digest covers:
 * - its own span and the span of every test-app procedure it reaches (the walk is testpage-scan's
 *   `Scanner.reach`, with `[HandlerFunctions]` handlers, with-receivers and OnRun followed);
 * - for every object it reaches, the object's parts outside its procedures (header, properties,
 *   globals and their initialisation, triggers), or a non-codeunit object's whole text; a
 *   non-codeunit object's triggers are walked whenever its code can run (cases 14 to 16);
 * - every test-app event-subscriber codeunit, automatic and manual, and every test-app extension
 *   object, whole, with everything it reaches (`subscriberFold`): an event can run a subscriber
 *   from anywhere, and a dependency's own code can fire an extension's triggers;
 * - the dependency fingerprint and the test app's build inputs (digest-inputs.ts);
 * - when the test, or the subscriber fold, has an edge the walk cannot follow (UNFOLLOWED, fail
 *   closed), the WHOLE test-app source: every `.al` file's normalised text.
 *
 * A span is the method's text from the first attribute directly before the `procedure`, as R-278
 * defined it. Only line endings, trailing spaces and tabs and a BOM are normalised: a comment edit
 * inside a procedure is a real edit, and over-normalising is the unsafe direction (an edited test
 * read as unchanged skips verify's new-test checks).
 *
 * The digest is `v2:` + SHA-256. A v1 digest (R-278's, the method span only) has no prefix, and
 * verify refuses a source run that recorded one (`source-predates-verify`).
 *
 * Memory: the source is parsed ONCE into `TestAppModel` (every span hashed while its file's tree
 * is alive), and a test's reached set is hashed and dropped before the next test is walked.
 */
import { initParser, normalizeAlName } from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import {
  type Proc,
  type ReachState,
  Scanner,
  type TestAppModel,
  type Unit,
  buildTestAppModel,
  newReachState,
  readTestAppSources,
  sha256,
} from "./testpage-scan";

/** The scheme tag every digest this build records starts with. */
export const TEST_DIGEST_SCHEME = "v2";
const PREFIX = `${TEST_DIGEST_SCHEME}:`;

/** Whether a recorded digest was made under this build's scheme. */
export const isCurrentDigest = (d: string): boolean => d.startsWith(PREFIX);

/** The digest key: codeunit id plus method, the method compared case-insensitively as AL does. */
export const testDigestKey = (ref: { codeunitId: number; method: string }): string =>
  `${ref.codeunitId}::${ref.method.toLowerCase()}`;

/** A discovered test the parser found no declaration for. Its own class so `runSession` can catch
 *  exactly this and nothing else: the run goes on without digests, and verify refuses it later. */
export class TestDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDigestError";
  }
}

/** What a digest covers beyond the test-app source (digest-inputs.ts). */
export interface DigestInputs {
  /** `dependencyFingerprint`'s answer. */
  readonly dependencies: string;
  /** `AppInputs.buildInputs`. */
  readonly buildInputs: string;
}

/**
 * Every part a digest is made of, 16 hex characters each, recorded beside the digests so verify
 * can say WHAT changed when it refuses `too-many-new-tests`. Never read to decide a verdict.
 */
export interface TestDigestParts {
  /** `Proc.key` -> span hash, for every procedure and trigger in every codeunit. */
  readonly procs: Readonly<Record<string, string>>;
  /** Object key -> parts hash (codeunits) or whole-text hash (other objects). */
  readonly objects: Readonly<Record<string, string>>;
  readonly subscribers: string;
  readonly app: string;
  readonly dependencies: string;
  readonly buildInputs: string;
}

const short = (h: string): string => h.slice(0, 16);

function reachLines(st: ReachState): string[] {
  const out: string[] = [];
  for (const p of st.procs) out.push(`P ${p.spanHash}`);
  for (const u of st.units) out.push(`U ${u.partsHash}`);
  return out;
}

/**
 * Every test-app subscriber codeunit, whole, and everything its procedures and triggers reach;
 * and every test-app extension object (tableextension, pageextension, ...), whole, and everything
 * its triggers reach. Folded into EVERY digest: an event can run a subscriber from any code, a
 * manual one is bound by BindSubscription, which the walk deliberately does not treat as an edge
 * (ruling 1), and an extension's triggers on a dependency's object fire from that dependency's
 * code, which the walk never sees.
 */
function subscriberFold(
  scanner: Scanner,
  model: TestAppModel,
): { hash: string; fallback: string | undefined } {
  const st = newReachState();
  const lines: string[] = [];
  for (const u of model.units) {
    if (!u.subscriber) continue;
    lines.push(`C ${u.textHash}`);
    for (const p of [...u.procs, ...u.triggers]) scanner.reach(p, st);
  }
  for (const u of model.objects) {
    if (!u.kind.endsWith("extension")) continue;
    lines.push(`E ${u.textHash}`);
    for (const t of u.triggers) scanner.reach(t, st);
  }
  lines.push(...reachLines(st));
  return { hash: sha256(lines.sort().join("\n")), fallback: st.fallback };
}

/** EVERY codeunit with the test's id and EVERY procedure of its name (all `#if` arms). */
function declsOf(model: TestAppModel, t: TestMethodRef): Proc[] {
  const name = normalizeAlName(t.method);
  return model.units
    .filter((u) => u.id === t.codeunitId)
    .flatMap((u) => u.procs.filter((p) => p.name === name));
}

/** The per-model facts every test's digest reads, computed once. */
interface DigestContext {
  readonly scanner: Scanner;
  readonly subscribers: { hash: string; fallback: string | undefined };
  readonly app: string;
}

function contextOf(model: TestAppModel): DigestContext {
  const scanner = new Scanner(model);
  return {
    scanner,
    subscribers: subscriberFold(scanner, model),
    app: sha256(model.fileHashes.join("\n")),
  };
}

/** Walks one test. Throws `TestDigestError` when the parser found no declaration for it. */
function walkTest(ctx: DigestContext, model: TestAppModel, t: TestMethodRef): ReachState {
  const decls = declsOf(model, t);
  if (decls.length === 0) {
    throw new TestDigestError(
      `test-digest.ts: ${t.codeunitName}.${t.method} (codeunit ${t.codeunitId}) was discovered, but the parser found no procedure of that name to digest`,
    );
  }
  const st = newReachState();
  for (const d of decls) {
    ctx.scanner.reach(d, st);
    // The test codeunit's own OnRun runs before every method: each method is its own
    // CODEUNIT.Run of the test codeunit (extensions/lethal-control RunMany.Codeunit.al).
    for (const tr of d.unit.triggers) if (tr.name === "onrun") ctx.scanner.reach(tr, st);
  }
  return st;
}

/** Whether a test's digest takes the whole-source fallback. */
const onFallback = (ctx: DigestContext, st: ReachState): boolean =>
  st.fallback !== undefined || ctx.subscribers.fallback !== undefined;

/** Every unit's key in `TestDigestParts.objects`; `#<n>` for a repeat (an object in two arms). */
function unitKeys(model: TestAppModel): Map<Unit, string> {
  const out = new Map<Unit, string>();
  const used = new Set<string>();
  for (const u of [...model.units, ...model.objects]) {
    const base = `${u.kind}:${u.id}:${u.display}`;
    let k = base;
    for (let n = 1; used.has(k); n += 1) k = `${base}#${n}`;
    used.add(k);
    out.set(u, k);
  }
  return out;
}

/**
 * Every discovered test's digest, by `testDigestKey`, and the parts they are made of: all of them
 * or, by throwing `TestDigestError`, none.
 */
export function testDigestsOfModel(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
  inputs: DigestInputs,
): { digests: Record<string, string>; parts: TestDigestParts } {
  const ctx = contextOf(model);
  const build = sha256(inputs.buildInputs);
  const digests: Record<string, string> = {};
  let n = 0;
  for (const t of tests) {
    if (++n % 1024 === 0) Bun.gc(false);
    const st = walkTest(ctx, model, t);
    const lines = reachLines(st);
    lines.push(`S ${ctx.subscribers.hash}`, `D ${inputs.dependencies}`, `B ${build}`);
    if (onFallback(ctx, st)) lines.push(`A ${ctx.app}`);
    digests[testDigestKey(t)] = `${PREFIX}${sha256(lines.sort().join("\n"))}`;
  }
  const procs: Record<string, string> = {};
  const objects: Record<string, string> = {};
  for (const [u, k] of unitKeys(model)) {
    for (const p of [...u.procs, ...u.triggers]) procs[p.key] = short(p.spanHash);
    objects[k] = short(u.partsHash);
  }
  return {
    digests,
    parts: {
      procs,
      objects,
      subscribers: short(ctx.subscribers.hash),
      app: short(ctx.app),
      dependencies: short(inputs.dependencies),
      buildInputs: short(build),
    },
  };
}

/** The digests only, over files not yet parsed. */
export function testDigestsOfSources(
  files: ReadonlyArray<{ path: string; text: string }>,
  tests: readonly TestMethodRef[],
  inputs: DigestInputs,
): Record<string, string> {
  return testDigestsOfModel(buildTestAppModel(files), tests, inputs).digests;
}

export async function testDigests(
  testDir: string,
  tests: readonly TestMethodRef[],
  inputs: DigestInputs,
): Promise<Record<string, string>> {
  await initParser();
  return testDigestsOfSources(await readTestAppSources(testDir), tests, inputs);
}

/** Why a test verify treats as new is new, for the `too-many-new-tests` refusal. */
export type NewTestCause =
  | "added"
  | "test"
  | "procedure"
  | "object"
  | "subscriber"
  | "fallback"
  | "dependency"
  | "build"
  | "reach"
  | "unknown";

/**
 * R-371: for each test verify treats as new, why, against the source run's recorded parts. Walks
 * the CURRENT source, so an edit that changed WHICH procedures a test reaches (a call added or
 * removed, with every reached part unchanged) reads as `reach`. `recorded` false means the source
 * run did not record the test at all (`added`). Explains; never decides.
 */
export function explainNewTests(
  model: TestAppModel,
  inputs: DigestInputs,
  tests: ReadonlyArray<{ readonly ref: TestMethodRef; readonly recorded: boolean }>,
  was: TestDigestParts | null,
): { causes: Map<NewTestCause, number>; changedProcs: string[] } {
  const causes = new Map<NewTestCause, number>();
  const ctx = contextOf(model);
  const keys = unitKeys(model);
  const build = short(sha256(inputs.buildInputs));
  const testKeys = new Set<string>();
  for (const { ref, recorded } of tests) {
    const mine = new Set<NewTestCause>();
    if (!recorded) mine.add("added");
    else if (was === null) mine.add("unknown");
    else {
      const decls = declsOf(model, ref);
      for (const d of decls) testKeys.add(d.key);
      const st = walkTest(ctx, model, ref);
      for (const p of st.procs)
        if (was.procs[p.key] !== short(p.spanHash))
          mine.add(decls.includes(p) ? "test" : "procedure");
      for (const u of st.units)
        if (was.objects[keys.get(u) ?? ""] !== short(u.partsHash)) mine.add("object");
      if (was.subscribers !== short(ctx.subscribers.hash)) mine.add("subscriber");
      if (was.dependencies !== short(inputs.dependencies)) mine.add("dependency");
      if (was.buildInputs !== build) mine.add("build");
      if (onFallback(ctx, st) && was.app !== short(ctx.app)) mine.add("fallback");
      if (mine.size === 0) mine.add("reach");
    }
    for (const c of mine) causes.set(c, (causes.get(c) ?? 0) + 1);
  }
  const changedProcs: string[] = [];
  if (was !== null) {
    for (const u of [...model.units, ...model.objects])
      for (const p of [...u.procs, ...u.triggers])
        if (!testKeys.has(p.key) && was.procs[p.key] !== short(p.spanHash))
          changedProcs.push(p.display);
  }
  return { causes, changedProcs: changedProcs.sort() };
}

/**
 * R-371: the store's recorded parts, checked. `null` stays `null` (a run that recorded none); a
 * value of another shape is a corrupt row and throws, never a plausible empty default.
 */
export function parseDigestParts(v: unknown): TestDigestParts | null {
  if (v === null) return null;
  const isMap = (x: unknown): x is Record<string, string> =>
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.values(x).every((y) => typeof y === "string");
  const o = v as Record<string, unknown>;
  if (
    typeof v !== "object" ||
    !isMap(o.procs) ||
    !isMap(o.objects) ||
    ["subscribers", "app", "dependencies", "buildInputs"].some((k) => typeof o[k] !== "string")
  ) {
    throw new Error("test-digest.ts: a recorded test_digest_parts value is not TestDigestParts");
  }
  return v as TestDigestParts;
}
