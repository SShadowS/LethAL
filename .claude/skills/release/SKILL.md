---
name: release
description: Cut a LethAL release end to end — version bump, CHANGELOG section, README version references, the local and live gates, then the tag that triggers .github/workflows/release.yml. Use when asked to cut, tag, ship or publish a release, to bump the version, or when a release draft needs finishing. Covers the Azure Trusted Signing setup for the Windows binary and the two things the workflow deliberately leaves to a human.
disable-model-invocation: true
---

# Cutting a release

LethAL ships as a **standalone compiled binary**, not an npm package. A release is one git tag; the
tag triggers `.github/workflows/release.yml`, which builds five targets, signs the Windows one, and
opens a **draft** GitHub release. `docs/releasing.md` is the reference for what the build produces
and why; this skill is the order of operations.

**The tag is the trigger, not the source of truth.** The root `package.json` `version` is, and
`scripts/build-binary.ts` stamps it into every filename. The workflow refuses a tag that disagrees
with it, so a mismatch fails in seconds rather than shipping filenames that contradict the tag.

## Order, and why it is this order

Everything that can fail locally fails locally. The tag is last, because a pushed tag is the one
step that is annoying to undo.

### 1. Decide the version

Read the current one and the last released section:

```bash
bun --print 'require("./package.json").version'
grep -n "^## \[" CHANGELOG.md | head -5
```

If the current version already has a dated `## [x.y.z]` section, it was cut before — **bump**, do
not reuse it. Reusing a released version relabels work that shipped under a different number.
Pre-1.0 this project moves in `-alpha.N` steps.

### 2. Write the CHANGELOG section BEFORE anything else

Keep-a-Changelog style, dated, with the `[Unreleased]` heading left in place above it and empty.

Base it on what closed since the last release rather than on memory:

```bash
for f in docs/roadmap/R*.md; do
  s=$(grep -m1 '^status:' "$f"); case "$s" in *done*|*closed*)
    echo "$(basename "$f" .md)|$(grep -m1 '^title:' "$f")";; esac
done
```

Group by what a USER can see — Added / Changed / Fixed / Security — not one bullet per row. Cite the
`R<n>` in each bullet; the roadmap file carries the evidence, so the changelog can be specific
without repeating it.

**This section becomes the release body.** `scripts/changelog-section.ts` extracts it in CI and
REFUSES a missing or empty one, so a release cannot ship with no notes. Check it renders:

```bash
bun scripts/changelog-section.ts <version>
```

### 3. Bump the version and the places that quote it

```bash
# package.json is the source of truth
grep -rn "0\.1\.0-alpha\.[0-9]" README.md docs/releasing.md
```

Update: `package.json` `version`, the README release badge, the README's `--version` example
filename, and `docs/releasing.md`'s "It is currently" line plus its `git tag` example. Leave
historical measurements alone — `docs/releasing.md`'s binary size table records what a specific
build measured and is not a claim about the new one.

`scripts/changelog-section.test.ts` fails when `package.json`'s version has no changelog section, so
a bump without an entry reddens before a tag exists.

### 4. Local gate

```bash
bun run typecheck
rm -rf packages/*/dist        # AFTER typecheck, BEFORE the tests
bun test
bun run compile:fixtures      # if any .al under fixtures/ or examples/ changed
```

### 5. Live gate

`/live-gate`. Unit tests are structurally blind to AL that cannot compile and to real BC behaviour,
and a release is exactly the wrong place to find that out. Frozen per-gate figures are in
`CLAUDE.md`; a differing verdict blocks the release rather than updating an expectation.

### 6. Commit, push, watch CI

```bash
git add -A && git commit   # "release: cut <version>"
git push
gh run list --branch master --limit 3
```

CI must be green on the commit you are about to tag. The release workflow re-runs the same gate, so
a red CI here is a release that will fail after burning five cross-compiles.

### 7. Tag

```bash
git tag v<version>          # must equal package.json exactly
git push origin v<version>
gh run list --workflow Release --limit 3
```

### 8. Finish the draft by hand

The workflow opens a DRAFT, deliberately, because two things need a person:

1. **Attach `lethal-control.app`.** Building it needs `alc` from the AL VS Code extension, which no
   hosted runner has, and `*.app` is gitignored so there is no committed copy to attach. Say in the
   notes which control-app version it is: a user pointing `controlSymbolPath` at the wrong one gets
   a version mismatch at run time, not at publish time. Build it with `/control-app`.
2. **Read the notes.** The body is the changelog section plus a fixed install footer, and GitHub
   appends generated commit subjects underneath. Those were written for this repository's own
   record, not for a stranger.

Then publish the draft.

## Undoing a bad tag

Before the draft is published, this is cheap:

```bash
gh release delete v<version> --yes        # deletes the draft
git push --delete origin v<version>       # then the remote tag
git tag -d v<version>
```

After a release is PUBLISHED, do not delete it — cut the next patch instead. People's tooling
resolves published tags.

## Azure Trusted Signing (the Windows binary)

The Windows `.exe` is Authenticode-signed in CI. The Linux and macOS binaries are **not** and cannot
be by this mechanism: Authenticode is a Windows PE format, and macOS needs Apple notarisation, which
is a different account and a different tool. The release notes say so rather than letting a reader
assume all five are covered.

The setup is borrowed from `claude-code-lsps`, whose `.github/workflows/release.yml` is the working
reference.

### What the workflow needs

| Kind | Name | Value |
|---|---|---|
| Repo variable | `AZURE_SIGNING_ENDPOINT` | `https://neu.codesigning.azure.net/` |
| Repo variable | `AZURE_SIGNING_ACCOUNT` | `signingshadow` |
| Repo variable | `AZURE_SIGNING_PROFILE` | `sign1` |
| Repo secret | `AZURE_CLIENT_ID` | the app registration's client id |
| Repo secret | `AZURE_TENANT_ID` | the Entra tenant id |
| Repo secret | `AZURE_SUBSCRIPTION_ID` | the subscription holding the signing account |

Authentication is **OIDC federated credential, no client secret**. The job declares
`id-token: write` and `environment: release` — that environment is not decoration: the federated
credential's subject is `repo:SShadowS/LethAL:environment:release`, because the Entra tenant rejects
wildcard-tag credentials. A job without the environment gets an OIDC subject the credential does not
match, and `azure/login` fails with an unhelpful audience error.

### Order matters here too

**Set the three `vars` LAST.** They are the switch: every signing step is guarded by
`if: vars.AZURE_SIGNING_ACCOUNT != ''`, so while they are unset the release still builds and
publishes, unsigned. Set them before the secrets and the federated credential exist and the job will
try to sign and fail.

So: secrets → GitHub environment named `release` → Entra federated credential for that subject →
variables.

```bash
gh variable set AZURE_SIGNING_ENDPOINT --repo SShadowS/LethAL --body "https://neu.codesigning.azure.net/"
gh variable set AZURE_SIGNING_ACCOUNT  --repo SShadowS/LethAL --body "signingshadow"
gh variable set AZURE_SIGNING_PROFILE  --repo SShadowS/LethAL --body "sign1"
```

The Azure-side pieces (the federated credential, and granting the app registration the
`Trusted Signing Certificate Profile Signer` role on the signing account) are portal or `az` work
and are the user's to do — the values above are the ones `claude-code-lsps` already uses.

### The verification step is the point

After signing, CI runs `Get-AuthenticodeSignature` and fails the release unless the status is
`Valid`. A release that CLAIMS to be signed and is not is worse than an unsigned one, because the
claim is what a user checks instead of checking the binary. The smoke test runs AFTER signing for
the same reason: signing rewrites the PE, so the binary that gets `--version`'d is the one a user
downloads.

## What the workflow does not do

- **No live gates.** They need a Business Central container. Step 5 is yours.
- **No `biome check .`.** Pre-existing format debt in `engine`/`builtin-tier1` would fail every
  build; CI lints nothing repo-wide and per-file linting is a local habit.
- **No publish.** The draft is deliberate. See step 8.
