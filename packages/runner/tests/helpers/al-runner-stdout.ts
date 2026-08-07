/**
 * Builds stdout in the shape the REAL al-runner v2 emits, measured against the installed
 * al-runner v2.0.0.0 on 2026-08-07: a human progress banner first, then the `--output-json`
 * envelope pretty-printed, opening on a line that is exactly `{` at column zero.
 *
 * Every al-runner fake in this package goes through here rather than through a bare
 * `JSON.stringify(payload)`. The compact one-line form the fakes used to emit is a shape the
 * binary never produces, and that mismatch is precisely why the banner went unnoticed until it
 * was measured: `JSON.parse(stdout)` throws on every real v2 run, and no unit test could see it.
 * A fake that is easier to parse than the real thing is a fake that proves nothing.
 */
export function alRunnerStdout(payload: unknown, opts: { bundles?: number } = {}): string {
  const bundles = opts.bundles ?? 2;
  const banner = [
    "[r2r] re-execing with DOTNET_ReadyToRun=0 ...",
    // Kept verbatim: this banner line CONTAINS no brace, but the next one does — a fake whose
    // banner is brace-free would let a naive "first `{` in stdout" parser pass.
    "[bc] no --bc-version given - selecting BC 28.1.49838.50794, the exact build this binary was compiled against.",
    `al-runner - running ${bundles} bundle(s)`,
  ];
  for (let i = 1; i <= bundles; i++) {
    banner.push(`[${i}/${bundles}] C:\\fake\\bundle${i} - 1 suites {shape: mixed}`);
    banner.push("   0P/0F/0E across 0 tests, 0 suite errors (0.5s)");
  }
  return `${banner.join("\n")}\n${JSON.stringify(payload, null, 2)}\n`;
}
