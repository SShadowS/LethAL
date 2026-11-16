# LethAL in CI (examples)

Two example pipelines run LethAL on a pull request:
- [`github-actions.yml`](github-actions.yml);
- [`azure-pipelines.yml`](azure-pipelines.yml).

They are examples to copy and adjust, not something LethAL ships or runs. `scripts/ci-templates.test.ts` parses every
`lethal` command in them with the CLI's own argument parser, so a renamed flag fails LethAL's tests before it reaches a
pipeline.

## What they do
1. **Check out with full history.** `--changed-since` diffs against `git merge-base <base> HEAD`.
2. **Run on the changed lines only.** `lethal run --changed-since origin/<target branch>` mutates only the AL lines the pull
   request changes, so a run costs minutes, not the hours a whole app takes.
3. **Map the exit code** to a pipeline result. The codes are LethAL's own:

   | Code | Meaning | The templates |
   |---|---|---|
   | `0` | The run completed. It says nothing about survivors. | pass |
   | `1` | Error (the message is on stderr). | fail |
   | `3` | Quarantined: the run refused to vouch for its verdicts. | fail |
   | `4` | Nothing scored: every mutant errored. | fail |
   | `7` | Time budget or a signal: the report is partial (`--resume` continues it). | fail |

   LethAL does not fail a run because mutants survived. There is no score threshold: see
   [`threshold-options.md`](threshold-options.md).
4. **Export for display.** `lethal export <report> --format mutation-elements` writes the Stryker interchange JSON:
   - Azure DevOps shows it with the Stryker extension's `PublishMutationReport` task;
   - on GitHub it is uploaded as an artifact, and `npx mutation-testing-elements` renders it to HTML.
   - **It embeds your source**, so keep it inside your organisation.

## Choosing the backend
- `--backend al-runner-v3` runs offline on Linux x64 with no BC server, and is fast. It is **not authoritative**: some answers
  differ from BC's, and those are refused or caveated in the report.
- `--backend bcdev` runs on a real BC sandbox and is authoritative. The agent must reach it, and the control app must be
  installed there (README). Never point it at a production tenant.
