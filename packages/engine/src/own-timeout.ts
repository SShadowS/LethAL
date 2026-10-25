/**
 * R726 option 3. A test's own timeout argument wins over verify's `--timeout`, so the Windows CI
 * rule (`testTimeout` in scripts/verify.ts, 60 s) does not reach it. Wrap every own timeout below
 * 60 s in this: on Windows CI it becomes at least 60 s; on Linux and on a local run it is returned
 * unchanged. `platform` and `ci` default to the real runner (CI means `CI` or `GITHUB_ACTIONS` is
 * set and not empty, as in verify); a test passes them to check each branch.
 *
 * It lives here, as the subpath `@lethal/engine/own-timeout`, only because every package's tests
 * can import engine, while a package project cannot import `scripts/`. It has no imports.
 * `scripts/own-timeout.test.ts` pins `WINDOWS_CI_OWN_TIMEOUT_MS` to verify's `WINDOWS_CI_TIMEOUT_MS`.
 */
export const WINDOWS_CI_OWN_TIMEOUT_MS = 60_000;

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

export function ownTimeout(
  ms: number,
  platform: string = process.platform,
  ci: boolean = set(process.env.CI) || set(process.env.GITHUB_ACTIONS),
): number {
  return platform === "win32" && ci ? Math.max(ms, WINDOWS_CI_OWN_TIMEOUT_MS) : ms;
}
