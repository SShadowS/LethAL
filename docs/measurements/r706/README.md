# R706: the HTTP error text on the web-service path and on the test runner hub path

- server: bc1, date 2026-10-24 (attempt 3, 08:37Z), Base and System Application 28.4.53241.56590
- LethAL Control: the version in `readings.json`
- harness: `scripts/r706-client-probe/drive.ts` at 766d93b63cbcdaa3854d57385834220113eb21f6
- web-service path: runner Test Runner - Isol. Codeunit (130450); read through the Control app's RunMutant path
- hub path: bc-dev-mcp `bcdev_test_run`, `coverage: "none"`, `TestHttpRequestPolicy` absent
- probe: the r639 probe apps (92910 `HttpGet`, 92911 `HttpGetRaw`), removed and read back absent afterwards
- `readings.json`: names, classes and the two error texts only; no AL source

Result: the web-service path reads "The request was blocked by the runtime to prevent accidental use of production
services." on both tests in both runs. The hub path reads "There was an error while executing the HTTP request, the
connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint." (code
`HttpRequest:Security`) on both tests in both runs.

The committed first-line classifier read 92911 on the hub as OTHER, because the test's own `MEASURED [<text>] [<code>]`
wrapper surrounds the text. So `readings.json` says row 1 "Unsettled". By substance it is outcome A of the
pre-commitment (`docs/superpowers/specs/2026-10-24-r706-client-path-probe-precommitment.md` section 7).
Owner ruling 2026-10-24: the hub path is the oracle (R712). The bcdev side (a note and a warning when a baseline test
fails with the web-service text) is R713.
