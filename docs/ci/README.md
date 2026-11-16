# LethAL in CI (examples)

Two example pipelines run LethAL on a pull request:
- [`github-actions.yml`](github-actions.yml);
- [`azure-pipelines.yml`](azure-pipelines.yml).

They are examples to copy and adjust, not something LethAL ships or runs. `scripts/ci-templates.test.ts` parses every
`lethal` command in them with the CLI's own argument parser, so a renamed flag fails LethAL's tests before it reaches a
pipeline.

## What they do
1. **Check out with full history.** `--changed-since` runs `git merge-base <base> HEAD`, so the base branch must be fetched.
2. **Run on the changed lines only.** `lethal run --changed-since origin/<target branch>` mutates only the AL lines the pull
   request changes, so a run costs minutes, not the hours a whole app takes.
3. **Map the exit code** to a pipeline result. The codes are LethAL's own:

   | Code | Meaning | The templates |
   |---|---|---|
   | `0` | The run completed. It says nothing about survivors. | pass |
   | `1` | Error (the message is on stderr), including "the line filter kept no deployable mutation site" (R1079). | fail |
   | `3` | Quarantined: the run refused to vouch for its verdicts. | fail |
   | `4` | Nothing scored: every mutant errored. | fail |
   | `7` | Time budget or a signal: the report is partial (`--resume` continues it). | fail |

   LethAL does not fail a run because mutants survived. There is no score threshold: see
   [`threshold-options.md`](threshold-options.md).
4. **Export for display.** `lethal export <report> --format mutation-elements` writes the Stryker interchange JSON, which the
   templates keep as an artifact. LethAL does not write the HTML page that Azure DevOps' PublishMutationReport task shows,
   and `npx mutation-testing-elements` is not a command (R1080).

## Before you copy them
- **Pull requests that change no mutable line fail** with exit 1 (R1079). A path filter on `*.al` avoids most; a comment-only
  `.al` edit still fails.
- **Every artifact carries your AL source:** the report's mutant texts and the export's embedded files. Keep them inside your
  organisation.
- **A self-hosted runner executes the pull request's code.** Never combine one with fork pull requests on a public
  repository; with bcdev, the config holds a BC login.
- **Self-hosted Azure agents keep files between builds.** The Azure template cleans the checkout and removes old reports
  first, so a stale report is never published.

## Choosing the backend
- `--backend al-runner-v3` runs offline on Linux x64 with no BC server, and is fast. It is **not authoritative**: some answers
  differ from BC's, and those are refused or caveated in the report. It runs only an al-runner build LethAL has gated (R814):
  install the one `lethal doctor` names.
- `--backend bcdev` runs on a real BC sandbox and is authoritative. The agent must reach it, and the control app must be
  installed there (README). Never point it at a production tenant.
