#!/usr/bin/env bun
/**
 * PreToolUse(Edit|Write) hook: refuse a silent edit to a frozen per-mutant baseline.
 *
 * `packages/runner/itest/*.baseline.json` are not fixtures and not config. Each one is a RECORD OF
 * MEASURED VERDICTS — mutant key → verdict/killingTest/coverageFiltered/errorClass — and comparing
 * against it per mutant is the only regression signal this project has. Aggregate counts matching
 * is explicitly not sufficient (CLAUDE.md: "a differing verdict is a BLOCK, never close enough").
 *
 * The failure this blocks is not malice, it is convenience: a gate goes red, the diff is one line,
 * and editing the baseline makes it green. That converts the detector into a mirror of whatever the
 * code currently does, permanently and silently.
 *
 * There is precedent for it going unnoticed. R29: a committed `tables.baseline.json` could never
 * match itself, and nothing caught that until it was proven to compare on a subsequent run.
 *
 * NOT a ban — re-recording is legitimate when an operator or a Tier-2 change genuinely moves
 * verdicts (R30/R33 are expected to). It has to be DELIBERATE, so it requires an explicit env var
 * rather than a keystroke:
 *
 *     LETHAL_RERECORD_BASELINE=1 <command>
 *
 * Exits 2 (blocking) only for that file class. Exits 0 for everything else, and for any unexpected
 * input: a hook that breaks the session is worse than a hook that misses one edit.
 */
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let file = "";
try {
  file = (JSON.parse(raw)?.tool_input?.file_path ?? "") as string;
} catch {
  process.exit(0);
}

const normalized = file.replace(/\\/g, "/");
// Scoped to the itest baselines specifically, not to every *.baseline.json anywhere: this guard is
// about the frozen live-gate records, and a broad match would train people to set the escape hatch
// habitually — which would defeat it.
const isFrozenBaseline = /\/packages\/runner\/itest\/[^/]+\.baseline\.json$/i.test(normalized);
if (!isFrozenBaseline) process.exit(0);

if (process.env.LETHAL_RERECORD_BASELINE === "1") process.exit(0);

console.error(
  [
    `Refusing to edit the frozen baseline ${normalized}.`,
    "",
    "This file is a record of MEASURED per-mutant verdicts, and comparing against it is the only",
    "regression signal the live gates have. Editing it to make a red gate green does not fix",
    "anything — it retunes the detector to agree with whatever the code now does, silently and",
    "permanently. R29 is the precedent: a committed baseline that could never match itself went",
    "unnoticed until it was proven to compare on a later run.",
    "",
    "If a gate is red, the verdict differing IS the finding. Read it before touching this file.",
    "",
    "If re-recording is genuinely correct (a new operator or a Tier-2 change that legitimately",
    "moves verdicts — R30/R33 will), re-run the gate and record it deliberately:",
    "",
    "    LETHAL_RERECORD_BASELINE=1 bun run itest:<gate>",
    "",
    "and then PROVE the new file compares against itself on a subsequent run (R29's lesson: a",
    "baseline nobody re-ran is not a baseline).",
  ].join("\n"),
);
process.exit(2);
