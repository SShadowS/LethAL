# R546 reports

The four `SessionReport`s behind `docs/measurements/2026-10-09-r546-alrunner-bc-agreement.md`:

| File | Backend | Leg | Coverage |
|---|---|---|---|
| `bc-A.report.json` | bcdev, Cronus28 | A | `none` |
| `bc-B.report.json` | bcdev, Cronus28 | B | `fenced` |
| `ar-A.report.json` | al-runner `--server` | A | `none` |
| `ar-B.report.json` | al-runner `--server` | B | `al-runner` |

**Redacted.** The project is Continia Document Output, and its source is not public. Every field that held verbatim AL source (`originalText`, `mutatedText` and the like) was replaced by `scripts/redact-campaign-report.ts`'s marker, and each file passes its `--check`.

Under the 2026-08-09 ruling, file paths, procedure names, test names and `killingTestFailure` (callstacks and messages) are kept. Because the source fields are redacted, these files cannot be re-bucketed for same-mutant text. The comparison was run on the unredacted reports before redaction.
