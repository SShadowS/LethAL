# R-438 plan (R438 + R440), two independent commits on lethal/r438

## Commit 1: R438 (packages/runner/src/harness.ts)
Two holes, both in `refuseUnfilteredExtensionsQuery` / `decodePercentEscapes`:
1. Only the path is checked. `fetchApiRows(<non-extensions path>, ..., {$expand: "extensions"})` is not refused.
2. After 16 decoding rounds a leftover `%XX` is returned unchecked, so deeply nested text hides `extensions`.

Change:
- Make the decoder report whether any `%XX` remains after the last round. If so, refuse (throw `UnfilteredExtensionsQueryError`) for path, keys and values alike.
- Run the "names extensions" test over the path, then over every query key and every query value, each decoded the same way. Path naming extensions keeps today's rule (only `{$filter: "id eq <GUID>"}`). A query key or value naming extensions on a path that does not is refused.
- Allowed form stays: extensions path + `$filter: "id eq <GUID>"`. The `companies` calls (no query) and `fetchExtensionRows` keep passing; the existing test file `packages/runner/tests/extensions-query-refusal.test.ts` must stay green.

Tests (same file), one red-going per new clause, each red-checked by deleting that clause (via the mutation-red-checker, Edit tool only):
- `$expand: "extensions"` (and an encoded `%65xtensions` value) on the companies path: refused, no fetch sent.
- 17-deep nested escape: refused. The control: a 3-deep escape of a harmless string still passes.
- Positive test: the allowed GUID filter still sends.

## Commit 2: R440 (scripts/r402-shape-sweep.ts, scripts/tsconfig.json)
- Import `identityOrdinalsOf` with the other orchestrator names; pass `identityOrdinals: identityOrdinalsOf(res)` at line 144, tolerant of old `--repo` trees as r214-capture.ts does.
- Run the sweep once (offline; alc only, no server). It needs `ALC=$LETHAL_ALC_DIR/alc` and the gitignored `.alpackages` of `fixtures/sandbox-symbols` and `fixtures/sandbox-app` (copy from /work/lethal-wt/lane-code, do not commit). Expected 132 cases; report count and time.
- Typing: add the script to `scripts/tsconfig.json` with type-only casts on the dynamic imports (`as typeof import(...)`) so `--repo` still works; add a schemata reference if tsc asks. If that cannot compile, write the exact reason in the file comment (the `--repo` dynamic import) and update its "Not in typecheck" note.
- No other script has the gap (see survey.md).

## Finish
Build loop: native parser is built; `bun run typecheck`, `rm -rf packages/*/dist scripts/dist`, `bun scripts/verify.ts`, `bunx biome check` on touched files, `bun test scripts/line-citations.test.ts` (roadmap cites names, not lines). Then set R438 and R440 `status` to `done (<commit>)` with `bun scripts/roadmap-set.ts`, regenerate with `bun scripts/roadmap-index.ts`, re-check next free id (nothing new expected). No identity, explain, report or schema change: the guard only throws earlier and the sweep is a script; no SessionReport field, so no schema regeneration.
