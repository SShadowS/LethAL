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
  const m = /newer version (\d+\.\d+\.\d+\.\d+) was already installed/.exec(message);
  return m?.[1] ?? null;
}
