/**
 * R726 option 3. A test's own timeout argument wins over verify's `--timeout`, so the Windows CI
 * rule (`testTimeout` in scripts/verify.ts, 60 s) does not reach it. Wrap every own timeout below
 * 60 s in this: it returns `max(ms, floor)`.
 *
 * The floor comes from verify, not from this process: verify's test child always has `CI=true`, so
 * `CI` and the platform cannot tell the Windows CI job from a local Windows run. `testTimeout`
 * picks the Windows-CI value once, and `testChildEnv` passes it to the child as
 * `LETHAL_VERIFY_OWN_TIMEOUT_FLOOR` (the name is pinned to `OWN_TIMEOUT_FLOOR_ENV` by
 * scripts/own-timeout.test.ts). Without the marker (Linux, local runs, a bare `bun test`) the
 * floor is 0 and `ms` comes back unchanged.
 *
 * It lives here, as the subpath `@lethal/engine/own-timeout`, only because every package's tests
 * can import engine, while a package project cannot import `scripts/`. It has no imports.
 */
export function ownTimeout(
  ms: number,
  floor: number = Number(process.env.LETHAL_VERIFY_OWN_TIMEOUT_FLOOR) || 0,
): number {
  return Math.max(ms, floor);
}
