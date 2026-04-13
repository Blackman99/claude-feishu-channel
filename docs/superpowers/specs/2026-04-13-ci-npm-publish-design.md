# CI + npm Publish GitHub Actions Design

**Date:** 2026-04-13
**Status:** Draft

## Goal

Add two GitHub Actions workflows:
1. **CI** — run typecheck, test, and build on every push/PR to ensure code quality
2. **Publish** — automatically publish to npm when a `v*` tag is pushed

## Constraints

- Follow existing workflow conventions (pnpm 10, Node 20, `actions/checkout@v4`)
- npm authentication via `NPM_TOKEN` repository secret
- Zero changes to existing `deploy-docs.yml`
- Zero changes to source code

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/ci.yml` | **Create** | CI pipeline: typecheck + test + build |
| `.github/workflows/publish.yml` | **Create** | npm publish on v* tag push |

## 1. `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

Design choices:
- Single job (typecheck → test → build sequential). These are fast (~5s total); parallelizing into separate jobs adds overhead without benefit.
- Runs on push to main and PRs to main. Feature branch pushes only trigger CI when they have an open PR.
- Matches `deploy-docs.yml` setup (pnpm 10, Node 20, `--frozen-lockfile`).

## 2. `.github/workflows/publish.yml`

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Design choices:
- **`registry-url`** on `setup-node` — required for `npm publish` to authenticate via `NODE_AUTH_TOKEN`.
- **`--provenance`** — generates an npm provenance attestation linking the package to this GitHub Actions run. Requires `id-token: write` permission.
- **`--access public`** — required for unscoped packages on first publish (npm defaults to restricted for org packages).
- **Full test + build before publish** — never publish a broken package. The `prepublishOnly` script in package.json provides a local safety net, but CI runs it independently.
- **`NPM_TOKEN` secret** — must be configured in repo Settings → Secrets and variables → Actions. Generate from npmjs.com → Access Tokens → Granular Access Token (publish scope for `claude-feishu-channel`).

## Release Workflow (User Steps)

```bash
# 1. Bump version (updates package.json + creates git tag)
npm version patch    # 0.1.0 → 0.1.1
# or: npm version minor  # 0.1.0 → 0.2.0
# or: npm version major  # 0.1.0 → 1.0.0

# 2. Push commit + tag
git push --follow-tags

# 3. GitHub Actions automatically:
#    - Runs typecheck, test, build
#    - Publishes to npm with provenance
```

## Prerequisites (Manual Setup)

Before the publish workflow can succeed, you must:

1. **Create npm account** (if not already) at https://www.npmjs.com
2. **Generate access token**: npmjs.com → Access Tokens → Generate New Token → Granular Access Token
   - Permissions: Read and Write (publish)
   - Packages: `claude-feishu-channel` (or all packages)
3. **Add secret to GitHub repo**: Settings → Secrets and variables → Actions → New repository secret
   - Name: `NPM_TOKEN`
   - Value: the token from step 2

## Testing

- CI workflow: push a commit to main or open a PR → verify typecheck + test + build all pass in Actions tab.
- Publish workflow: after configuring `NPM_TOKEN`, run `npm version patch && git push --follow-tags` → verify package appears on npmjs.com.
