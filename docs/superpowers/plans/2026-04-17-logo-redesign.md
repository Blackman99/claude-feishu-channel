# Logo Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale `CFC`/base64-PNG logo with a clean pure-SVG `afc` chat-bubble mark (dark + light variants + favicon), update VitePress wiring, and delete the unused PNG asset.

**Architecture:** Three hand-written SVG files in `assets/`, mirrored into `site/public/` so VitePress can serve them. VitePress config switches from a single `logo` string to `{ light, dark }` so the theme toggle swaps plates. README keeps pointing at `assets/logo.svg` and auto-picks up the new content. Unused `feishu-logo.png` files are removed now that nothing embeds or references them.

**Tech Stack:** SVG, VitePress (`vitepress` 1.x via `pnpm docs:*` scripts), Node LTS, pnpm.

**Design spec:** `docs/superpowers/specs/2026-04-17-logo-redesign-design.md`

---

## File Structure

**Create:**
- `assets/logo.svg` — overwrite existing (dark-plate primary)
- `assets/logo-light.svg` — light-plate variant
- `assets/favicon.svg` — 64×64 compact variant
- `site/public/logo.svg` — overwrite existing (identical to `assets/logo.svg`)
- `site/public/logo-light.svg` — identical to `assets/logo-light.svg`
- `site/public/favicon.svg` — identical to `assets/favicon.svg`

**Modify:**
- `site/.vitepress/config.ts` — favicon href + `themeConfig.logo` shape

**Delete:**
- `assets/feishu-logo.png`
- `site/public/feishu-logo.png`

---

## Task 1: Replace assets/logo.svg with new dark-plate design

**Files:**
- Modify: `assets/logo.svg` (full overwrite)

- [ ] **Step 1: Verify current state**

Run: `wc -c assets/logo.svg && grep -c 'data:image/png' assets/logo.svg`
Expected: ~19781 bytes; grep count 1 (the base64 embed exists today).

- [ ] **Step 2: Overwrite `assets/logo.svg` with the new dark-plate design**

Write exactly this content (use the Write tool):

```xml
<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="44" fill="#0F172A"/>
  <g transform="translate(100,88)">
    <path d="M -44 -14 Q -44 -34 -24 -34 L 24 -34 Q 44 -34 44 -14 L 44 14 Q 44 34 24 34 L -2 34 L -16 46 L -12 34 L -24 34 Q -44 34 -44 14 Z" fill="#3370FF"/>
    <text x="0" y="10" text-anchor="middle" font-family="'Inter','Helvetica Neue',system-ui,sans-serif" font-size="36" font-weight="800" fill="#F1F5F9" letter-spacing="-2">afc</text>
  </g>
  <text x="100" y="166" text-anchor="middle" font-family="'Inter',system-ui,sans-serif" font-size="10" font-weight="500" letter-spacing="3" fill="#64748B">AGENT · FEISHU · CHANNEL</text>
</svg>
```

- [ ] **Step 3: Verify the embed is gone and size shrank**

Run: `wc -c assets/logo.svg && grep -c 'data:image/png' assets/logo.svg || true`
Expected: ~700 bytes, grep count 0 (exit status 1 is fine — `|| true` keeps the pipeline green).

- [ ] **Step 4: Visual sanity check**

Run: `open assets/logo.svg` (macOS) or equivalent.
Expected: dark rounded plate, blue chat bubble with `afc`, small grey subtitle. No broken image, no missing PNG placeholder.

- [ ] **Step 5: Commit**

```bash
git add assets/logo.svg
git commit -m "design(logo): replace CFC+PNG logo with afc chat-bubble mark"
```

---

## Task 2: Add light-plate variant

**Files:**
- Create: `assets/logo-light.svg`

- [ ] **Step 1: Write the light variant**

Write exactly this content to `assets/logo-light.svg`:

```xml
<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="44" fill="#F8FAFC"/>
  <g transform="translate(100,88)">
    <path d="M -44 -14 Q -44 -34 -24 -34 L 24 -34 Q 44 -34 44 -14 L 44 14 Q 44 34 24 34 L -2 34 L -16 46 L -12 34 L -24 34 Q -44 34 -44 14 Z" fill="#3370FF"/>
    <text x="0" y="10" text-anchor="middle" font-family="'Inter','Helvetica Neue',system-ui,sans-serif" font-size="36" font-weight="800" fill="#FFFFFF" letter-spacing="-2">afc</text>
  </g>
  <text x="100" y="166" text-anchor="middle" font-family="'Inter',system-ui,sans-serif" font-size="10" font-weight="500" letter-spacing="3" fill="#64748B">AGENT · FEISHU · CHANNEL</text>
</svg>
```

- [ ] **Step 2: Verify it renders**

Run: `open assets/logo-light.svg`
Expected: light plate, same blue bubble, `afc` is white on blue, subtitle readable.

- [ ] **Step 3: Commit**

```bash
git add assets/logo-light.svg
git commit -m "design(logo): add light-plate variant"
```

---

## Task 3: Add compact favicon variant

**Files:**
- Create: `assets/favicon.svg`

- [ ] **Step 1: Write the favicon variant**

Write exactly this content to `assets/favicon.svg`:

```xml
<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="#0F172A"/>
  <path d="M 10 18 Q 10 10 18 10 L 46 10 Q 54 10 54 18 L 54 38 Q 54 46 46 46 L 28 46 L 20 56 L 22 46 L 18 46 Q 10 46 10 38 Z" fill="#3370FF"/>
  <text x="32" y="37" text-anchor="middle" font-family="'Inter','Helvetica Neue',system-ui,sans-serif" font-size="22" font-weight="800" fill="#F1F5F9" letter-spacing="-1">a</text>
</svg>
```

- [ ] **Step 2: Sanity-check rendering at small sizes**

Render the favicon at 16 / 32 / 64 on a dark backdrop:

```bash
ABS="$(pwd)/assets/favicon.svg"
cat > /tmp/favicon-check.html <<HTML
<!doctype html><style>body{background:#111;padding:32px;display:flex;gap:32px;align-items:center}</style>
<img src="file://$ABS" width="16">
<img src="file://$ABS" width="32">
<img src="file://$ABS" width="64">
HTML
open /tmp/favicon-check.html
```

Expected: bubble + `a` recognizable at 16px (small but visible); crisp at 32/64.

- [ ] **Step 3: Commit**

```bash
git add assets/favicon.svg
git commit -m "design(logo): add compact favicon svg"
```

---

## Task 4: Mirror SVGs into site/public/

**Files:**
- Modify: `site/public/logo.svg` (overwrite)
- Create: `site/public/logo-light.svg`
- Create: `site/public/favicon.svg`

These files must stay byte-identical to the ones in `assets/`. Keeping a second copy (rather than a symlink) avoids VitePress's public-asset resolution quirks and mirrors what the repo does today.

- [ ] **Step 1: Copy all three SVGs**

Run:

```bash
cp assets/logo.svg site/public/logo.svg
cp assets/logo-light.svg site/public/logo-light.svg
cp assets/favicon.svg site/public/favicon.svg
```

- [ ] **Step 2: Verify the copies match**

Run:

```bash
diff assets/logo.svg site/public/logo.svg
diff assets/logo-light.svg site/public/logo-light.svg
diff assets/favicon.svg site/public/favicon.svg
```

Expected: no output on any of the three (exit 0, files identical).

- [ ] **Step 3: Commit**

```bash
git add site/public/logo.svg site/public/logo-light.svg site/public/favicon.svg
git commit -m "design(logo): mirror new svg assets into site/public"
```

---

## Task 5: Wire VitePress to the new favicon and dual logos

**Files:**
- Modify: `site/.vitepress/config.ts`

Current relevant lines (for context):

```ts
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-feishu-channel/logo.svg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
```

- [ ] **Step 1: Update the favicon href and logo shape**

Replace the snippet above with:

```ts
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-feishu-channel/favicon.svg' }],
  ],

  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo.svg' },
```

Apply with the Edit tool (exact match on the two changed properties). Do not touch any other config.

- [ ] **Step 2: Typecheck the docs config**

VitePress configs are TypeScript; root `pnpm typecheck` covers them.

Run: `pnpm typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 3: Build the docs site**

Run: `pnpm docs:build`
Expected: exits 0; output lists `site/.vitepress/dist/` with `logo.svg`, `logo-light.svg`, `favicon.svg` present. No warnings about missing public assets.

- [ ] **Step 4: Visual check in dev server**

Run (background): `pnpm docs:dev`
Open the printed URL. Confirm:
- Browser tab favicon shows the new bubble mark
- Header logo in light theme uses the light-plate SVG
- Toggle theme to dark — header logo switches to the dark-plate SVG

Kill the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add site/.vitepress/config.ts
git commit -m "site: use svg favicon and light/dark logo pair"
```

---

## Task 6: Delete the now-unused PNG files

**Files:**
- Delete: `assets/feishu-logo.png`
- Delete: `site/public/feishu-logo.png`

- [ ] **Step 1: Confirm nothing references the PNGs**

Run: `grep -rn 'feishu-logo' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=site/.vitepress/dist --exclude-dir=.worktrees --exclude-dir=.claude . || true`
Expected: no matches in tracked source (matches inside `.worktrees/` or `site/.vitepress/dist/` can be ignored — worktrees are separate checkouts and `dist/` is build output).

- [ ] **Step 2: Remove the PNGs**

Run:

```bash
git rm assets/feishu-logo.png site/public/feishu-logo.png
```

- [ ] **Step 3: Re-run the full test suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass (no dependency on the PNG exists).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(assets): drop unused feishu-logo.png"
```

---

## Task 7: End-to-end verification

No new files. This task guards against regressions across README, docs build, and repo hygiene.

- [ ] **Step 1: Confirm README still points to the existing path**

Run: `grep -n 'assets/logo.svg' README.md`
Expected: one line, `<img src="assets/logo.svg" width="180" alt="AFC Logo" />`. No change needed — README already references `assets/logo.svg` which now holds the new design.

- [ ] **Step 2: Re-render the docs build clean**

Run:

```bash
rm -rf site/.vitepress/dist
pnpm docs:build
```

Expected: exits 0. `ls site/.vitepress/dist/*.svg` shows `favicon.svg`, `logo.svg`, `logo-light.svg`.

- [ ] **Step 3: Confirm no leftover references to `CFC` or `CLAUDE FEISHU CHANNEL` in tracked assets**

Run:

```bash
grep -rn 'CFC\|CLAUDE FEISHU CHANNEL' assets/ site/public/ || true
```

Expected: no matches (both strings lived only inside the old SVG's text nodes).

- [ ] **Step 4: Final file-size sanity**

Run:

```bash
wc -c assets/logo.svg assets/logo-light.svg assets/favicon.svg
```

Expected: each file under 2 KB.

- [ ] **Step 5: No commit**

This task is pure verification. If anything failed, fix in the relevant task's branch and re-run — don't paper over here.

---

## Self-Review Notes

- Spec coverage: every file in the spec's "Files to produce / update / delete" table is covered by a task (1–3 produce, 4 mirrors, 5 updates config, 6 deletes).
- No placeholders: each code step includes full file contents or exact `sed`/`cp` commands.
- Naming consistency: `logo.svg` / `logo-light.svg` / `favicon.svg` used uniformly across spec and plan.
- Testing section of the spec maps to Task 5 Steps 3–4 (build + dev check) and Task 7 (end-to-end).
