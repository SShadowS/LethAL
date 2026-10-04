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
 * - every test-app event-subscriber codeunit, automatic and manual, every test-app extension
 *   object, and every enum implementation codeunit, whole, with everything it reaches
 *   (`subscriberFold`): an event can run a subscriber from anywhere, and a dependency's own code
 *   can fire an extension's triggers or run an enum value's implementation;
 * - the dependency fingerprint and the test app's build inputs (digest-inputs.ts);
 * - when the test, or the subscriber fold, has an edge the walk cannot follow (UNFOLLOWED, fail
 *   closed), the WHOLE test-app source: every `.al` file's normalised text.
 *
 * A span is the method's text from the first attribute directly before the `procedure`, as R-278
 * defined it. For a TEST procedure (its widened run holds `[Test]`), R420 widens the attribute run
 * to an `#if` holding only attributes, so the span then starts at that `#if` and its every arm's
 * `[HandlerFunctions]` are walked; for a procedure that is a whole `#if` arm after its `[Test]`
 * (S11), the run before the `#if` is its span's first piece. Every other procedure keeps R-278's
 * run (testpage-scan.ts `memberRun`). Only line endings, trailing spaces and tabs and a BOM are normalised: a comment edit
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

/**
 * Each reached procedure's span hash and object's parts hash, BOUND to its identity (`Proc.key`,
 * the unit's key): two codeunits whose same-named procedures swap bodies run different code, and
 * a sorted list of unbound hashes would only exchange two entries (external review r1 #1).
 */
function reachLines(st: ReachState, keys: ReadonlyMap<Unit, string>): string[] {
  const out: string[] = [];
  for (const p of st.procs) out.push(`P ${p.key} ${p.spanHash}`);
  for (const u of st.units) out.push(`U ${keys.get(u) ?? unitKeyMissing(u)} ${u.partsHash}`);
  return out;
}

/** A unit outside the model's key map is a caller-contract violation, never an unkeyed line. */
function unitKeyMissing(u: Unit): never {
  throw new Error(`test-digest.ts: ${u.display} (${u.file}) has no unit key`);
}

/**
 * Every test-app subscriber codeunit, whole, and everything its procedures and triggers reach;
 * and every test-app extension object (tableextension, pageextension, ...), whole, and everything
 * its triggers reach. Folded into EVERY digest: an event can run a subscriber from any code, a
 * manual one is bound by BindSubscription, which the walk deliberately does not treat as an edge
 * (ruling 1), and an extension's triggers on a dependency's object fire from that dependency's
 * code, which the walk never sees.
 */
export function subscriberFold(
  scanner: Scanner,
  model: TestAppModel,
  keys: ReadonlyMap<Unit, string> = unitKeys(model),
): { hash: string; fallback: string | undefined; reached: ReachState } {
  const key = (u: Unit): string => keys.get(u) ?? unitKeyMissing(u);
  const st = newReachState();
  const lines: string[] = [];
  for (const u of model.units) {
    if (!u.subscriber) continue;
    lines.push(`C ${key(u)} ${u.textHash}`);
    for (const p of [...u.procs, ...u.triggers]) scanner.reach(p, st);
  }
  for (const u of model.objects) {
    if (!u.kind.endsWith("extension")) continue;
    lines.push(`E ${key(u)} ${u.textHash}`);
    // Its triggers and the page parts it adds, with the rest of its base object's test-app code.
    scanner.foldObject(u, st);
  }
  // An enum value's implementation codeunit can be run by any code handed the value, a
  // dependency's included: every implementation a test-app enum or enumextension names.
  for (const u of model.objects) {
    if (u.implementations.length === 0) continue;
    lines.push(`I ${key(u)} ${u.textHash}`);
    for (const raw of u.implementations)
      scanner.foldImplementation(raw, `${u.display} implementation ${raw}`, st);
  }
  // A test-app codeunit the folded code names as a value can be run by id from anywhere.
  scanner.foldIdTargets(st);
  lines.push(...reachLines(st, keys));
  // Parse damage can swallow a whole subscriber codeunit, so it never becomes a unit and is folded
  // nowhere: with any damaged file, every digest takes the whole-source fallback.
  const [damaged] = model.damaged;
  if (damaged !== undefined)
    st.fallback ??= `${damaged} has parse damage, which can hide a subscriber codeunit`;
  return { hash: sha256(lines.sort().join("\n")), fallback: st.fallback, reached: st };
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
  readonly keys: ReadonlyMap<Unit, string>;
  readonly subscribers: { hash: string; fallback: string | undefined };
  readonly app: string;
}

function contextOf(model: TestAppModel): DigestContext {
  const scanner = new Scanner(model);
  const keys = unitKeys(model);
  return {
    scanner,
    keys,
    subscribers: subscriberFold(scanner, model, keys),
    app: sha256(model.fileHashes.join("\n")),
  };
}

/** Walks one test. Throws `TestDigestError` when the parser found no declaration for it. */
export function walkTest(scanner: Scanner, model: TestAppModel, t: TestMethodRef): ReachState {
  const decls = declsOf(model, t);
  if (decls.length === 0) {
    throw new TestDigestError(
      `test-digest.ts: ${t.codeunitName}.${t.method} (codeunit ${t.codeunitId}) was discovered, but the parser found no procedure of that name to digest`,
    );
  }
  const st = newReachState();
  for (const d of decls) {
    scanner.reach(d, st);
    // The test codeunit's own OnRun runs before every method: each method is its own
    // CODEUNIT.Run of the test codeunit (extensions/lethal-control RunMany.Codeunit.al).
    for (const tr of d.unit.triggers) if (tr.name === "onrun") scanner.reach(tr, st);
  }
  // External review r1 #3: a test-app codeunit this test's code names as a value (its own
  // codeunit's other methods included) can be run by id by code the walk does not follow.
  scanner.foldIdTargets(
    st,
    [...new Set(decls.map((d) => d.unit))].flatMap((u) => [...u.procs, ...u.triggers]),
  );
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
    const st = walkTest(ctx.scanner, model, t);
    const lines = reachLines(st, ctx.keys);
    lines.push(`S ${ctx.subscribers.hash}`, `D ${inputs.dependencies}`, `B ${build}`);
    if (onFallback(ctx, st)) lines.push(`A ${ctx.app}`);
    digests[testDigestKey(t)] = `${PREFIX}${sha256(lines.sort().join("\n"))}`;
  }
  const procs: Record<string, string> = {};
  const objects: Record<string, string> = {};
  for (const [u, k] of ctx.keys) {
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
  const { keys } = ctx;
  const build = short(sha256(inputs.buildInputs));
  const testKeys = new Set<string>();
  for (const { ref, recorded } of tests) {
    const mine = new Set<NewTestCause>();
    if (!recorded) mine.add("added");
    else if (was === null) mine.add("unknown");
    else {
      const decls = declsOf(model, ref);
      for (const d of decls) testKeys.add(d.key);
      const st = walkTest(ctx.scanner, model, ref);
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
