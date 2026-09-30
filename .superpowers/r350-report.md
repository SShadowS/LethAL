# R350 report
Shared rule: `firstPartyVerdict(reportPath, mutants, repoRoot?, entries?)` in scripts/redact-campaign-report.ts (plus `loadFirstParty`). The report is identified by its repo-relative path; exempt only if allowlisted AND every mutant file exists inside the entry's projectDir. Used by --check, by write mode (refuses allowlisted reports) and by the test (its private copy was removed). A foreign file makes the CLI throw.
Tests (scripts/redact-campaign-report.test.ts): allowlisted passes (both committed reports, --check exit 0, write mode refused); non-allowlisted with source fails; allowlisted with files outside project is not exempt (function level).
Red-checks: .superpowers/r350-redcheck.log (A CLI ignores allowlist -> case 1 red; B path match ignored -> case 2 red (plus many others); C foreign check off -> case 3 red). git diff empty after each restore.
--check on gift-card rehearsal and credit-limit demo: exit 0, "ok (first-party: ...)".
Suite: typecheck ok, bun test 4720 pass / 7 skip / 0 fail (after rm -rf packages/*/dist).
Commits: 512715b1 (fix+tests); roadmap close commit follows.
CLAUDE.md: no change required; "run --check" now works for first-party reports (optionally mention write mode refuses them).
