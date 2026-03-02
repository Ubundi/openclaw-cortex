# /release — Release a new version of openclaw-cortex

Release a new version by bumping the version, running all checks, committing, tagging, and pushing.

## Arguments

- `patch` (default), `minor`, or `major` — the semver bump type
- Pass `--dry-run` to run all checks without committing, tagging, or pushing

## Steps

### 1. Pre-flight checks

Run these in parallel:
- `git status` — ensure working tree is clean (no uncommitted changes). If dirty, stop and ask the user to commit or stash first.
- `git branch --show-current` — confirm we're on `main`. If not, warn and ask to confirm.

### 2. Run tests and verify consistency

Run these in parallel:
- `npx tsc --noEmit` — type check
- `npm test` — unit tests (262+ tests)
- `npm run verify-release` — version and config consistency

All three must pass. If any fail, stop and report the failure.

### 3. Bump version

Determine the bump type from the argument (default: `patch`).

Read the current version from `package.json`. Calculate the new version using semver rules:
- `patch`: 1.1.4 → 1.1.5
- `minor`: 1.1.4 → 1.2.0
- `major`: 1.1.4 → 2.0.0

Then run:
```bash
npm version <patch|minor|major> --no-git-tag-version
```

This updates `package.json` and `package-lock.json`. Then sync the plugin manifest:
```bash
npm run version
```

This runs `sync-version.mjs` which copies the version to `openclaw.plugin.json`.

### 4. Verify again

Run `npm run verify-release` to confirm everything is in sync after the bump.

### 5. Dry-run check

If `--dry-run` was passed, show the user what would be committed and stop here. Reset the version changes:
```bash
git checkout -- package.json package-lock.json openclaw.plugin.json
```

### 6. Commit and tag

Stage the three changed files and commit:
```bash
git add package.json package-lock.json openclaw.plugin.json
git commit -m "<new-version>"
```

The commit message is just the version number (e.g., `1.1.5`), matching existing convention.

Then tag:
```bash
git tag v<new-version>
```

### 7. Push

Ask the user for confirmation, then:
```bash
git push origin main --tags
```

This triggers the `.github/workflows/publish.yml` workflow which builds, tests, and publishes to npm.

### 8. Summary

Print a summary:
- Previous version → new version
- Commit hash
- Tag name
- Remind the user to check GitHub Actions for the publish workflow status:
  `https://github.com/Ubundi/openclaw-cortex/actions`
