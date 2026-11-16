# Your first week with LethAL

This page is for a person who has never run LethAL. It walks the whole path once, on the gift card
example in [`examples/gift-card`](../examples/gift-card/README.md), with the exact commands. The same
steps work on your own app: swap the paths.

In every command, `lethal` means the executable you built (see [Installation](../README.md#installation)).
From a source checkout you can write `bun packages/runner/src/cli.ts` instead.

Two words first. LethAL makes a small, deliberate breakage in your code. That is a **mutant**. A
mutant is **killed** when one of your tests fails, **survived** when all your tests still pass, and
**no-coverage** when no test runs that code at all.

## 1. Set up

**Build `lethal`.** Follow [Installation](../README.md#installation) once.

**Write a config.** `lethal init` reads your `app.json` and picks the three object ids LethAL injects
into its copy of your app. They must sit inside an id range your app declares, and nobody can guess
them. Run it once your dependency packages are in `.alpackages` (see section 9 for why).

For the real server (the `bcdev` backend, the one you can trust):

```bash
lethal init --project examples/gift-card --out examples/gift-card/lethal.config.local.json
```

For the offline look (the `al-runner-v3` backend, Linux x64 only, no server):

```bash
lethal init --project examples/gift-card --backend al-runner-v3 --out examples/gift-card/lethal.config.v3.local.json
```

`--backend` defaults to `bcdev`. Any other value is refused by name.

Keep the `.local.json` name for the bcdev file. It holds a password, and `.gitignore` covers that name
only. The v3 file holds no secret.

**Fill in what `init` could not know.** Open the file.

- bcdev: `server`, `serverInstance`, `company`, `username`, `password`, `controlSymbolPath` (the
  `lethal-control.app` you published to the server, see [Quick start](../README.md#quick-start) step 2).
  The user and password go in twice: `bcdev.username` / `bcdev.password` and `bcdev.env`. On BC for
  Linux, add `bcdev.apiBaseUrl`.
- al-runner-v3: `alRunnerV3.bcVersion` is a placeholder on purpose. LethAL will not guess which BC
  build you test against, because the answer changes verdicts. Type your four-number build (the
  `bun scripts/fetch-ms-symbols.ts 28 ./symbols` command prints it). `alRunnerV3.environment` is a
  placeholder only when your `.vscode/launch.json` names no `environmentType`: then set it to
  `"onprem"` or `"saas"`. There is no `path` key: the default al-runner applies, and it must be a build
  LethAL has gated. See [Running without a BC server](../README.md#running-without-a-bc-server-the-al-runner-v3-backend).

**Check the setup.** This changes nothing and lists every problem at once:

```bash
lethal doctor --config examples/gift-card/lethal.config.local.json
```

## 2. Find out how big the job is

```bash
lethal run --project examples/gift-card --dry-run
```

This lists every mutant a run would try and executes nothing. On the gift card it prints about 65
sites. On your own app, read the count before you run anything.

A run of more than 1,000 mutation sites is refused unless you pass `--allow-large-run`. The flag does
not make the run cheaper. Narrow first: `--only "src/Posting/**"` picks files, and
`--lines` picks line ranges (see `lethal --help` for the exact form).

## 3. A cheap look (not the real answer)

The offline backend needs no server. It is quick, and it is **not authoritative**: some answers differ
from BC's. Use it to see the shape of the result, never to quote a score.

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend al-runner-v3 --config examples/gift-card/lethal.config.v3.local.json --out report.v3.json
```

## 4. A real run

Use a **sandbox or dev container, never a production tenant**: the changed build stays published on
the server (see section 9 and [Restoring your app after a run](../README.md#restoring-your-app-after-a-run)).

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend bcdev --config examples/gift-card/lethal.config.local.json --out report.json
```

If it stops partway, continue it with the same command plus `--resume`.

## 5. Read the result

```bash
lethal explain report.json --top 10
```

The number to read first is not the score. It is each survivor's evidence:

- **killed**: a test failed. Good.
- **survived**: every test passed with the code broken. This is a lead, not a verdict. Check
  `executionProven`. When it is `true`, a test really ran that code and did not notice the change.
  When it is `false`, some test touched the object and none is known to have run that procedure, so
  do not rewrite tests for it yet.
- **no-coverage**: no test runs that code. It is left out of the score and reported on its own.
- **error**: no verdict could be had. It counts as neither a kill nor a survivor.
- **timeout-killed**: the change ran past its time budget and BC stopped the session. It is the
  weakest kind of kill.

Also read `validity.caveats` in the report. They say what limits the score (for example, a narrowed
run). A narrowed score is never a project score. The full meaning of every field is in
[Driving LethAL from an agent](using-lethal-from-an-agent.md).

On the gift card, the planted bug is the missing filter in `GetBalance`: it survives, with
`executionProven` true, because every test creates only one card.

## 6. Fix: write a test that kills a survivor

LethAL never writes the test. You do. For the gift card, add a test that issues two cards and checks
that redeeming against one does not change the other's balance. Put it in
`examples/gift-card-tests/src/GiftCardTests.Codeunit.al`.

## 7. Prove the fix with `lethal verify`

`verify` runs the named survivors again, plus every test you added or edited since the run. It works on
`bcdev` only. Take `artifactId`, `batchIndex` and `mutantCode` from the survivor's row in the explain
output. A filled-in example:

```bash
lethal verify --db examples/gift-card/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests examples/gift-card-tests --config examples/gift-card/lethal.config.local.json
```

Exit code `0` means every survivor is now killed and every new test is stable. Verify is a check, not
the record: make the record with a fresh `lethal run` (never `--resume`, which would carry the old
verdicts).

## 8. Re-run only what changed

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend bcdev --config examples/gift-card/lethal.config.local.json --changed-since origin/main --out report.json
```

`--changed-since` mutates only the lines that differ from `git merge-base origin/main HEAD`, plus your
uncommitted edits. Needs git history that shares a commit with that ref. The report is marked
`line-narrowed`.

For a pull request pipeline, copy an example from [`docs/ci/`](ci/README.md).

## 9. What will surprise you in the first week

These come from a real pilot on a large app. None is hard, all of them cost time the first time.

- **Run `lethal init` after the dependency packages are in `.alpackages`.** `init` picks ids that no
  dependency already uses. It can only rule out a clash with a dependency whose `.app` file it can
  read. If a package is missing, it prints a warning naming it, and the clash then shows up later as an
  alc error.
- **Credentials live in the JSON you fill in.** There is no env-file form yet. Keep the file named
  `*.local.json`, and never commit it. The password appears twice in a bcdev config (once as
  `password`, once under `env`).
- **The large-run guard counts mutation sites, not files.** Even one `--only` file can be over 1,000.
  Either pass `--allow-large-run` (it does not make the run cheaper), or narrow with `--lines`
  or `--changed-since`. Always read `--dry-run` first.
- **`lethal verify` leaves the edited test app installed on the server.** It also does not put back the
  test app that was there before. The docs give no restore command. To get your own test app back,
  build and publish it yourself the way you normally do, and bump its `app.json` version if BC refuses
  it as a downgrade (the same trick as in [Restoring your app after a run](../README.md#restoring-your-app-after-a-run)).
  A normal `lethal run` never touches your test project.
- **Verify works on `bcdev` only.** On the offline backend you re-run instead.
- **Check that the server holds your app's dependencies before the first run.** `lethal doctor`
  checks that each direct dependency in your `app.json` has a compatible package in your package
  folder (`packageCachePath`). It does not look at what is installed on the server, and it does not
  check the dependencies of those packages. A dependency missing on the server shows up as a publish
  failure, not as a doctor failure. `doctor --tests <dir>` adds one more check: your test app is
  installed.
- **A survivor is not automatically a bug.** Some mutants are equivalent: the change cannot be
  observed. Read the code before you write a test.
