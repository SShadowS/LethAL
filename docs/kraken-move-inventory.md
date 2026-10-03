# Host-path inventory

Every tracked file that names a host path (a Windows drive path, the VS Code extensions folder
under the home directory) has a row here. `bun scripts/host-path-inventory.ts` runs `git grep` and
exits 1 if a file with a hit has no row. A row whose path ends in `/` covers every file below it.

Classes:

- **operational**: an agent or a script runs it. It must work in the Linux container, or say plainly
  that it is host-only. Rows marked "Task N" are changed by that task of plan 3.
- **inert**: names a host path, but only as data or a comment. No edit needed; it must still pass on Linux.
- **historical**: an old plan, spec, probe or record. Left alone.

Classified from plan 3, Appendix B (2026-10-03), plus files added on the branch since.

## Operational

| path | class | note |
|---|---|---|
| CLAUDE.md | operational | project instructions; Task 11 (needs owner approval) |
| .claude/commands/coord-join.md | operational | Task 11 |
| .claude/agents/al-compiler.md | operational | Task 11 |
| .claude/skills/al-compile/SKILL.md | operational | Task 11 |
| .claude/skills/control-app/SKILL.md | operational | host-only (BC container publish); Task 11 |
| .claude/skills/live-gate/SKILL.md | operational | Task 11 |
| .claude/skills/al-probe/SKILL.md | operational | Task 11 |
| .claude/skills/recover-tier/SKILL.md | operational | Task 11 |
| .claude/skills/repo-scripts/SKILL.md | operational | Task 11 |
| .claude/hooks/no-committed-secrets.ts | operational | Task 11 |
| docs/superpowers/runbooks/autonomy/README.md | operational | Task 11 |
| docs/superpowers/runbooks/autonomy/lane.md | operational | Task 11 |
| docs/superpowers/runbooks/autonomy/orchestrator.md | operational | Task 11 |
| scripts/kraken-corpora.sh | inert | runs in the container only; names the host BC.History folder in a comment, as the thing it mirrors at /work/src/BC.History |
| scripts/coord.sh | operational | Task 11 |
| scripts/coord-status.ts | operational | Task 11 |
| scripts/compile-fixtures.ts | operational | Task 11 |
| fixtures/README.md | operational | Task 11 |
| docs/releasing.md | operational | Task 11 |
| fixtures/do-campaign/README.md | operational | host-only |
| fixtures/do-campaign/preflight.ts | operational | host-only |
| fixtures/do-campaign/settings.json | operational | host-only |
| scripts/kraken-secrets.ts | operational | host-only by design: it runs on the Windows host, and its defaults name host folders. Not a Task 11 edit |

## Inert

| path | class | note |
|---|---|---|
| packages/engine/src/ast/parser-wasm.ts | inert | |
| packages/engine/tests/ast/preproc-arms.test.ts | inert | |
| packages/runner/itest/config-path.test.ts | inert | |
| packages/runner/itest/envtool.itest.ts | inert | |
| packages/runner/src/al-runner-predefined-probe.ts | inert | |
| packages/runner/src/al-runner-transport.ts | inert | |
| packages/runner/src/campaign-fence.ts | inert | |
| packages/runner/src/cli.ts | inert | |
| packages/runner/tests/al-runner-bc-build.test.ts | inert | |
| packages/runner/tests/al-runner-coverage.test.ts | inert | |
| packages/runner/tests/campaign-fence.test.ts | inert | |
| packages/runner/tests/campaign-manifest.test.ts | inert | |
| packages/runner/tests/compile-only-args.test.ts | inert | |
| packages/runner/tests/env-tool-client.test.ts | inert | false positive |
| scripts/test-preload.ts | inert | |
| scripts/roadmap-next-id.test.ts | inert | |
| .kraken/Dockerfile | inert | a comment names the VS Code extensions folder to say where LethAL looks |
| scripts/kraken-secrets.test.ts | inert | host paths are test data for the path rewriter |
| scripts/host-path-inventory.test.ts | inert | host paths are test data for this check |
| scripts/host-path-inventory.ts | inert | the pattern and its comment name the host forms |
| scripts/compile-fixtures.test.ts | inert | MSYS-style home path as test data |
| scripts/coord-join-role.test.ts | inert | host worktree paths are test data for the role lookup |

## Historical

| path | class | note |
|---|---|---|
| docs/superpowers/plans/ | historical | |
| docs/roadmap/ | historical | |
| docs/superpowers/specs/ | historical | |
| docs/campaign/ | historical | |
| docs/measurements/ | historical | |
| plans/ | historical | |
| Checkpoint.md | historical | |
| fixtures/do-campaign/fence-probe-matrix.md | historical | |
| scripts/r101c-define-probe/ | historical | one-off probe |
| scripts/r126-server-probe/ | historical | one-off probe |
| scripts/r13-probe/ | historical | one-off probe |
| scripts/r134-filter-probe/ | historical | one-off probe |
| scripts/r136-armc-probe/ | historical | one-off probe |
| scripts/r141-filter-probe/ | historical | one-off probe |
| scripts/r159-aor-spike/ | historical | one-off probe |
| scripts/r161-emit-proof.ts | historical | one-off probe |
| scripts/r174-ignore-methods-probe.ts | historical | one-off probe |
| scripts/r214/ | historical | one-off probe |
| scripts/r236-baseline-probe/ | historical | one-off probe |
| scripts/r289-probe/ | historical | one-off probe |
| scripts/r371-reach-measure/ | historical | one-off probe |
| scripts/r372-package-source-probe/ | historical | one-off probe |
| scripts/r72-probe/ | historical | one-off probe |
| scripts/r83-probe/ | historical | one-off probe |
| scripts/census-swap-call-arguments.ts | historical | one-off probe |
| scripts/corpus-fingerprint.ts | historical | one-off probe |
| scripts/probe-alrunner-canary.ts | historical | one-off probe |
| scripts/probe-alrunner-tables.ts | historical | one-off probe |
| scripts/probe-continia-env.ts | historical | one-off probe |
| scripts/probe-r13-deleteall.ts | historical | one-off probe |
| scripts/probe-r30-pageext.ts | historical | one-off probe |
