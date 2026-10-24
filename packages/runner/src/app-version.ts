/** BC version components are 16-bit. */
const MAX_COMPONENT = 65535;
const MS_PER_DAY = 86_400_000;

export class VersionOverflowError extends Error {}

export interface ReserveInput {
  /** The project's own version from app.json — supplies major.minor. */
  readonly sourceVersion: string;
  readonly nowMs: number;
  /** Last version this allocator issued, if any. Guarantees strict increase. */
  readonly lastIssued?: string;
}

function parse(version: string): [number, number, number, number] {
  const parts = version.split(".");
  if (parts.length !== 4) {
    throw new Error(`app version must be four-part (a.b.c.d), got "${version}"`);
  }
  const nums = parts.map((p) => {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== p) {
      throw new Error(`app version component "${p}" is not a non-negative integer ("${version}")`);
    }
    // Range-checked HERE, not only on reserveAppVersion's assembled candidate: parse() is the
    // boundary where untrusted input (a target project's own app.json, Task 6) first enters,
    // and every caller — reserve, nextAbove, lastIssued comparison — must fail loudly on a
    // component BC's 16-bit version fields cannot represent, never emit it downstream.
    if (n > MAX_COMPONENT) {
      throw new VersionOverflowError(
        `app version component ${n} exceeds ${MAX_COMPONENT} ("${version}")`,
      );
    }
    return n;
  });
  const [a, b, c, d] = nums;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error(`app version must be four-part (a.b.c.d), got "${version}"`);
  }
  return [a, b, c, d];
}

function compare(x: readonly number[], y: readonly number[]): number {
  for (let i = 0; i < 4; i++) {
    const a = x[i] ?? 0;
    const b = y[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two BC four-part versions (`major.minor.build.revision`) NUMERICALLY, component by
 * component: negative when `a` sorts below `b`, 0 when equal, positive when above.
 *
 * Exported because a string compare is wrong in a way that looks right on every version anyone
 * writes by hand: lexically `"1.0.0.10" < "1.0.0.9"`, and `reserveAppVersion` mints
 * `<major>.<minor>.<days>.<halfSeconds>` where the last two components are routinely 4-5 digits —
 * so the components that actually differ are exactly the ones a string compare misreads.
 *
 * Throws (via `parse`) on anything that is not four non-negative 16-bit components, rather than
 * ranking a malformed version as equal or lowest: a caller gating on this needs to know it could
 * not read the version at all, not receive a plausible ordering for a value it never parsed.
 */
export function compareAppVersions(a: string, b: string): number {
  return compare(parse(a), parse(b));
}

/**
 * `<sourceMajor>.<sourceMinor>.<daysSinceUnixEpoch>.<secondsOfDay / 2>`.
 *
 * Major/minor come from the project's app.json so a 2.x project is never forced under a 1.0
 * ceiling it can never clear. The clock components need no stored counter, so there is no state
 * to lose or reset — the defect that broke publishing when `lethal.sqlite` was deleted.
 *
 * The 2-second resolution is coarser than a compile (~1s), so `lastIssued` guarantees strict
 * increase regardless of granularity or a clock that steps backwards.
 */
export function reserveAppVersion(input: ReserveInput): string {
  const [major, minor] = parse(input.sourceVersion);
  const days = Math.floor(input.nowMs / MS_PER_DAY);
  const halfSeconds = Math.floor((input.nowMs % MS_PER_DAY) / 2000);
  let candidate: [number, number, number, number] = [major, minor, days, halfSeconds];

  if (input.lastIssued !== undefined) {
    const last = parse(input.lastIssued);
    if (compare(candidate, last) <= 0) candidate = parse(nextAbove(input.lastIssued));
  }
  for (const c of candidate) {
    if (c > MAX_COMPONENT) {
      throw new VersionOverflowError(
        `app version component ${c} exceeds ${MAX_COMPONENT} (candidate ${candidate.join(".")})`,
      );
    }
  }
  return candidate.join(".");
}

/** Smallest version strictly greater than `version`, carrying right-to-left. */
export function nextAbove(version: string): string {
  const parts = parse(version);
  for (let i = 3; i >= 0; i--) {
    const cur = parts[i] ?? 0;
    if (cur < MAX_COMPONENT) {
      parts[i] = cur + 1;
      for (let j = i + 1; j < 4; j++) parts[j] = 0;
      return parts.join(".");
    }
  }
  throw new VersionOverflowError(`no version above ${version} is representable`);
}

/**
 * BC's downgrade rejection names the installed version verbatim, e.g.
 * "...because a newer version 1.0.106.0 was already installed."
 * Verified live against Cronus281 on 2026-07-19.
 */
export function parseVersionConflict(message: string): string | null {
  // R709: BC's restore-failure text embeds this sentence (naming the NEW version); it is not a
  // conflict to re-stamp past, and a caller that skips `restoreFailed` must still not retry it.
  if (restoreFailed(message)) return null;
  const m = /newer version (\d+\.\d+\.\d+\.\d+) was already installed/.exec(message);
  return m?.[1] ?? null;
}

/**
 * R709: BC refused an UPGRADE because an installed dependent no longer compiles against it, and
 * then could not put the old target back ("The original extensions could not be restored ...").
 * Measured on bc2 by R-707 (step 4): the target is left uninstalled and every installed app that
 * depends on it (the tests app at least) is removed.
 */
export function restoreFailed(message: string): boolean {
  return /could not be restored/i.test(message);
}

/**
 * R709 part 2: the apps BC lists as "previously installed but could not be reinstalled". Measured
 * on bc2 (R-709b, `scripts/r709-probe/`): after "... command to do so:" BC writes one
 * "<name> by <publisher>" per line (the target first, then its dependents) and a blank line; it
 * gives NO versions. A body printed raw has its line breaks escaped (`\n`), so both are read.
 * Fail-closed: null when the list is missing, empty, or has a line not in that form, never `[]`.
 */
export function notReinstalledApps(
  text: string,
): { readonly name: string; readonly publisher: string }[] | null {
  const t = text.replace(/\\n/g, "\n");
  const head = /could not be reinstalled[^\n]*?to do so:[^\S\n]*\n/i.exec(t);
  if (head === null) return null;
  const out: { name: string; publisher: string }[] = [];
  for (const raw of t.slice(head.index + head[0].length).split("\n")) {
    const line = raw.trim();
    if (line === "") break;
    const by = line.lastIndexOf(" by ");
    if (by <= 0) return null;
    out.push({ name: line.slice(0, by), publisher: line.slice(by + 4) });
  }
  return out.length > 0 ? out : null;
}

/** The sentence naming what BC lists, or saying the list could not be read. */
function notReinstalledSentence(bcText: string): string {
  const apps = notReinstalledApps(bcText);
  return apps === null
    ? "BC's text names no list of the apps it could not reinstall that LethAL can read; see BC's " +
        "text below. "
    : `BC lists ${apps.length} apps it could not reinstall (name by publisher; BC gives no ` +
        `versions): ${apps.map((a) => `${a.name} by ${a.publisher}`).join("; ")}. `;
}

/** R709: the named refusal for `restoreFailed`. Keeps BC's text verbatim, names every app BC lists
 *  (`notReinstalledApps`), and says how to recover. Extends `Error` directly. */
export class UpgradeNotRestoredError extends Error {
  constructor(bcText: string) {
    super(
      "BC refused to upgrade the target and could not restore the previous version (R709). " +
        "An installed app that depends on the target no longer compiles against the new build " +
        "(most often the tests app on the server is older than your tests source). BC has left " +
        "the target UNINSTALLED and REMOVED every installed app that depends on it, the tests " +
        "app at least; BC's text below names them. LethAL did not retry. To recover: uninstall " +
        "and unpublish the stranded target, then publish the target, the tests app built from " +
        "your CURRENT source, and every other app BC names. On a LethAL gate server (bc1-bc3) " +
        "the setup script refuses this state: ask the owner to restart the server, then run " +
        "`bun scripts/bc-linux-setup.ts --server bcN` (docs/gates/servers.md, R709). If BC " +
        "refuses an old version as a downgrade, its installed-version record needs a restart " +
        `(R605). ${notReinstalledSentence(bcText)}BC said: ${bcText}`,
    );
    this.name = "UpgradeNotRestoredError";
  }
}

/** The app a publish tried to install: its name and publisher, and the version sent. */
export interface PublishIdentity {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
}

/**
 * R250: proof that BC refused THIS publish as a downgrade. Returns the installed version only when
 * the text holds BC's whole sentence naming this app, publisher and attempted version, as
 * measured live (Cronus281 2026-07-19, and the 2026-07-20 stale-publish probes in
 * fixtures/README.md): "Cannot install the extension <name> by <publisher> <attempted> because a
 * newer version <v> was already installed." Not anchored to the start of the text, because BC
 * itself wraps the sentence ("Publishing failed due to '...'"). A text that only QUOTES the
 * phrase, or names another app, publisher or version, is not proof. `parseVersionConflict` stays
 * the loose reader for the retry's version; this is what confirms a refusal.
 */
export function confirmedDowngradeRefusal(
  message: string,
  attempted: PublishIdentity,
): string | null {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(
    `Cannot install the extension ${esc(attempted.name)} by ${esc(attempted.publisher)} ${esc(attempted.version)} because a newer version (\\d+\\.\\d+\\.\\d+\\.\\d+) was already installed\\.`,
  ).exec(message);
  return m?.[1] ?? null;
}
