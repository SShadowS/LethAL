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

**Get the BC symbols.** Both backends need Microsoft's symbol files (the `.app` files for the System
Application, Base Application and so on) in the app's `.alpackages` folder. In VS Code, run "AL:
Download Symbols". Without VS Code, run this from the LethAL checkout. It needs no login, and it
prints the exact `bcVersion` you need in a moment:

```bash
bun scripts/fetch-ms-symbols.ts 28 examples/gift-card/.alpackages
```

`28` is the BC major version of your server. The bcdev `packageCachePath` and the al-runner-v3
`packagesDir` that `init` writes both point at this one folder.

**Write a config.** `lethal init` reads your `app.json` and picks the three object ids LethAL injects
into its copy of your app. They must sit inside an id range your app declares, and nobody can guess
them. Run it once your dependency packages are in `.alpackages`: see section 9 for why.

For the real server (the `bcdev` backend, the one you can trust):

```bash
lethal init --project examples/gift-card --out examples/gift-card/lethal.config.local.json
```

For the offline look (the `al-runner-v3` backend, Linux x64 only, no server):

```bash
lethal init --project examples/gift-card --backend al-runner-v3 --out examples/gift-card/lethal.config.v3.local.json
```

`--backend` defaults to `bcdev`. Any other value is refused by name.

The bcdev file holds a password. Name it exactly `lethal.config.local.json`: LethAL's own
`.gitignore` covers that name and no other. In your own repository, add that exact name to your
`.gitignore` before you fill in anything. The v3 file holds no secret.

**Fill in what `init` could not know.** Open the file.

- bcdev: `server`, `serverInstance`, `company`, `username`, `password`, `controlSymbolPath` (the
  `lethal-control.app` you published to the server, see [Quick start](../README.md#quick-start) step 2).
  The user and password go in twice: `bcdev.username` / `bcdev.password` and `bcdev.env`. On BC for
  Linux, add `bcdev.apiBaseUrl`.
- al-runner-v3: fill **both** placeholders. The checker refuses them one at a time, so fixing one
  and re-running only shows you the other.
  - `alRunnerV3.bcVersion`: LethAL will not guess which BC build you test against, because the answer
    changes verdicts. Use the version `fetch-ms-symbols` printed (four numbers). It must equal the
    System Application in `packagesDir`.
  - `alRunnerV3.environment`: a placeholder only when your `.vscode/launch.json` names no
    `environmentType`. Set it to `"onprem"` or `"saas"`.
  - `alc`, the AL compiler, is found in the AL Language VS Code extension. With no extension, run
    `bun scripts/fetch-alc.ts ./alc` and set `alRunnerV3.alcPath`. See
    [Running without a BC server](../README.md#running-without-a-bc-server-the-al-runner-v3-backend).
  - There is no `path` key: the default al-runner applies, and it must be a build LethAL has gated.

**Check the setup.** This changes nothing and lists every problem at once. With `--project` and
`--tests` it also checks that the app's direct dependencies have packages and that the test app is
installed:

```bash
lethal doctor --config examples/gift-card/lethal.config.local.json --project examples/gift-card --tests examples/gift-card-tests
```

Expect the test-app check to fail until you publish the apps in section 4.

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

**First, publish the gift card app and its test app yourself, to the dev scope.** LethAL republishes
the app under test on every run, but publishing the test app is your job. Without it the run stops
with a stale-test-app error. Publishing to the default (global) scope is the step that wastes an
afternoon: follow "Running it" in the
[gift card README](../examples/gift-card/README.md#running-it) exactly, then run the doctor command from
section 1 again.

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend bcdev --config examples/gift-card/lethal.config.local.json --out report.json
```

If it stops partway, continue it with the same command plus `--resume`.

Exit codes: `0` the run completed (it says nothing about survivors), `1` an error, `3` quarantined
(the run refused to vouch for its verdicts), `4` nothing scored, `7` time budget reached. The table is in
[`docs/ci/README.md`](ci/README.md).

## 5. Read the result

```bash
lethal explain report.json --top 15
```

The number to read first is not the score. It is each survivor's evidence:

- **killed**: a test failed. Good.
- **survived**: every test passed with the code broken. This is a lead, not a verdict. Check
  `executionProven`. When it is `true`, a test really ran that code and did not notice the change.
  When it is `false`, some test touched the object and none is known to have run that procedure, so
  do not rewrite tests for it yet.
- **no-coverage**: no test runs that code. It is left out of the score and reported on its own.
- **error**: no verdict could be had. It counts as neither a kill nor a survivor.
- **timeout-killed**: the change ran past its time budget and BC confirmed it stopped the session. It
  is the weakest kind of kill. This only happens with `--stop-hung-sessions` (or `stopHungSessions` in
  the config), which you may set only on a server whose owner agreed. Without it, a mutant that runs
  past its budget quarantines the run (exit `3`).

Also read `validity.caveats` in the report. They say what limits the score (for example, a narrowed
run). A narrowed score is never a project score. The full meaning of every field is in
[Driving LethAL from an agent](using-lethal-from-an-agent.md).

`--top 15` keeps the planted bug in view. `explain` ranks survivors by evidence, and the gift card's
planted bug sits around row 10, so a smaller number can cut it off.

On the gift card, the planted bug is the missing filter in `GetBalance`: it survives, with
`executionProven` true, because every test creates only one card.

## 6. Fix: write a test that kills a survivor

LethAL never writes the test. You do. For the gift card, add a test to
`examples/gift-card-tests/src/GiftCardTests.Codeunit.al` that issues two cards, redeems against one,
and then asserts `GiftCardMgt.GetBalance` of the **other** card equals the amount it was issued with.
That is what fails when the `SetRange` in `GetBalance` is gone: the balance becomes the sum of both
cards. Checking the card's `Remaining Amount` field kills nothing, because that field never goes
through `GetBalance`.

## 7. Prove the fix with `lethal verify`

`verify` runs the named survivors again, plus every test you added or edited since the run. It works on
`bcdev` only, and it needs the run's build still installed on the server. Only the run's last batch
stays installed, so a survivor from an earlier batch is refused. Take `artifactId`, `batchIndex` and
`mutantCode` from the survivor's row in the explain output. A filled-in example:

```bash
lethal verify --db examples/gift-card/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests examples/gift-card-tests --config examples/gift-card/lethal.config.local.json
```

Exit code `0` means every survivor is now killed and every new test is stable or not-rerun. Verify is a
check, not the record: make the record with a fresh `lethal run` (never `--resume`, which would carry
the old verdicts).

## 8. Re-run only what changed

`--changed-since` selects mutants from the lines of the **app code** that changed. It does not look at
your tests. After the test-only fix in sections 6 and 7 it keeps nothing, and the run is refused (R1079).
So after a test-only fix, re-run the whole gift card (about 65 sites), with the same command as in
section 4.

`--changed-since` is for when you change the app. Say you edit `GiftCardMgt.Codeunit.al`. To mutate only
your uncommitted edits:

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend bcdev --config examples/gift-card/lethal.config.local.json --changed-since HEAD --out report.json
```

For a branch, name the branch you will merge into: `origin/<your base branch>`. In the LethAL
repository that is `origin/master`:

```bash
lethal run --project examples/gift-card --tests examples/gift-card-tests --backend bcdev --config examples/gift-card/lethal.config.local.json --changed-since origin/master --out report.json
```

It uses `git merge-base <ref> HEAD` plus your uncommitted edits, so it needs git history that shares a
commit with that ref. The report is marked `line-narrowed`.

For a pull request pipeline, copy an example from [`docs/ci/`](ci/README.md).

## 9. What will surprise you in the first week

These come from a real pilot on a large app. None is hard, all of them cost time the first time.

- **Run `lethal init` after the dependency packages are in `.alpackages`.** `init` picks ids that no
  dependency already uses. It can only rule out a clash with a dependency whose `.app` file it can
  read. If a package is missing, it prints a warning naming it, and the clash then shows up later as an
  alc error.
- **Credentials live in the JSON you fill in.** There is no env-file form yet. Name the bcdev file
  `lethal.config.local.json`, add that exact name to your own `.gitignore`, and never commit it. The
  password appears twice in a bcdev config (once as `password`, once under `env`).
- **The large-run guard counts mutation sites, not files.** Even one `--only` file can be over 1,000.
  Either pass `--allow-large-run` (it does not make the run cheaper), or narrow with `--lines`
  or `--changed-since`. Always read `--dry-run` first.
- **On bcdev, one method of more than 4,800 guards is refused** (R826, measured on BC 28.4), and
  `--allow-large-run` does not lift it. `--dry-run` names the file and method; narrow with `--lines`,
  `--only` or fewer operators.
- **`lethal verify` leaves the edited test app installed on the server.** It does not put back the test
  app that was there before, and LethAL has no restore command. To get your own test app back, build and
  publish it yourself the way you normally do, and bump its `app.json` version if BC refuses it as a
  downgrade (the same trick as in [Restoring your app after a run](../README.md#restoring-your-app-after-a-run)).
  A normal `lethal run` never touches your test project.
- **Verify works on `bcdev` only.** On the offline backend you re-run instead.
- **Check that the server holds your app's dependencies before the first run.** With `--project`,
  `lethal doctor` checks that each direct dependency in your `app.json` has a compatible package in your
  package folder (`packageCachePath`). It does not look at what is installed on the server, and it does
  not check the dependencies of those packages. A dependency missing on the server shows up as a publish
  failure, not as a doctor failure. `--tests` adds one more check: your test app is installed.
- **A survivor is not automatically a bug.** Some mutants are equivalent: the change cannot be
  observed. Read the code before you write a test.
