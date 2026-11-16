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
   | `1` | Error (the message is on stderr). | fail |
   | `3` | Quarantined: the run refused to vouch for its verdicts. | fail |
   | `4` | Nothing scored: every mutant errored. | fail |
   | `7` | Time budget or a signal: the report is partial (`--resume` continues it). | fail |
   | `8` | No mutable lines: the line filter kept no mutation site (a pull request with no `.al` change, a comment-only edit). Nothing ran and no report is written. `--dry-run` exits 8 too. Lines whose sites LethAL refused (hang-capable, an undecided `#if`) exit 1, not 8. With `--operator` or `--exclude-operator`, an earlier check can exit 1 first, so a pull request with no site fails there. | pass |
   | `9` | Survivors on the changed lines. Only with `--fail-on-survivors`, which needs `--lines` or `--changed-since`. On al-runner-v3, only positive signals put a survivor apart (a flagged baseline, coverage off, the restrictive-default list); those are listed apart and do not count. An unknown flag (serve rows carry none, upstream #7954) or an unrecorded one (a resumed run) counts, and the section says how many survivors rest on that. Known survivors (`--skip-known-survivors`) and carried survivors count too. 3, 4 and 7 win over 9. | fail |

   Without `--fail-on-survivors`, LethAL does not fail a run because mutants survived, and there is no score threshold: see
   [`threshold-options.md`](threshold-options.md). The run still ends with a list, SURVIVORS ON THE CHANGED LINES.
   **The flag is advisory until the DO pilot's numbers decide:** the owner's ruling is "Decide on gating from the DO pilot's
   measured numbers." The templates carry it commented out.
4. **Export for display.** Two formats:
   - `lethal export <report> --format mutation-elements` writes the Stryker interchange JSON.
   - `--format mutation-elements-html` writes one HTML page that holds that JSON and loads the Stryker elements bundle from
     jsDelivr (pinned version, integrity-checked). Opening it needs network access; LethAL writes no bundle.

   The GitHub template uploads both as an artifact. The Azure template shows the HTML with `PublishMutationReport@2` (only when the export step wrote the page, so exit 8 does not fail it). Whether
   Azure DevOps' report tab loads a script from a CDN is not measured; check it in your organisation.

## Before you copy them
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
