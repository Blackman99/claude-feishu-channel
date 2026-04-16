# Logo Redesign

## Problem

The current `assets/logo.svg` is stale and has quality issues:

- Text reads **`CFC / CLAUDE FEISHU CHANNEL`**, but the project was renamed to `agent-feishu-channel` and the CLI command is now `afc`.
- Left element is a **Claude sparkle** in Anthropic orange, implying a Claude-only project. The project now supports **Claude + Codex**, so any single-provider symbol misrepresents scope.
- The Feishu bird is embedded as a **base64 PNG inside the SVG**. This bloats the file, breaks crisp scaling, and mixes raster with vector.
- Design is busy (sparkle + bridge + bird + "CFC" title + subtitle) — illegible at favicon sizes (16×16, 32×32).

## Approved Design

**Direction B — Chat bubble + `afc` wordmark.**

A Feishu-blue chat bubble containing the `afc` wordmark sits on a dark rounded-square plate. The bubble shape signals "this lives inside a messenger app". The bubble is provider-neutral. Plate makes the mark self-contained against any page background.

### Visual spec

- **Canvas**: 200×200 viewBox, rounded-rect plate (`rx=44`)
- **Plate fill**: `#0F172A` (dark variant), `#F8FAFC` (light variant)
- **Bubble fill**: `#3370FF` (Feishu blue, both variants)
- **Wordmark**: `afc` in Inter 800, `letter-spacing: -2`, centered in bubble
  - Fill: `#F1F5F9` on dark plate, `#FFFFFF` on light plate
- **Subtitle**: `AGENT · FEISHU · CHANNEL`, Inter 500, 10px, letter-spacing 3, fill `#64748B`
- **Bubble geometry**: rounded rect 88×68 centered at (100, 88) with a chat-tail pointing down-left, rendered as a single `<path>`

### Favicon variant

A separate 64×64 SVG — plate + bubble + single `a` (Inter 800, 22px). No subtitle, no full wordmark. Bubble tail preserved. Still legible at 16×16.

### Files to produce

| Path | Purpose |
| --- | --- |
| `assets/logo.svg` | Main logo, dark plate (primary) |
| `assets/logo-light.svg` | Light-plate variant for white-background contexts |
| `assets/favicon.svg` | Compact favicon variant |
| `site/public/logo.svg` | Copy of `assets/logo.svg` for VitePress `logoDark` |
| `site/public/logo-light.svg` | Copy of `assets/logo-light.svg` for VitePress `logoLight` |
| `site/public/favicon.svg` | Copy of `assets/favicon.svg` for VitePress favicon |

All SVGs are hand-written, pure-vector (no embedded raster), use only web-safe system font fallbacks in the stack `'Inter','Helvetica Neue',system-ui,sans-serif`.

### Files to update

- `site/.vitepress/config.ts`:
  - `head[0]` favicon href → `/agent-feishu-channel/favicon.svg`
  - `themeConfig.logo` → `{ light: '/logo-light.svg', dark: '/logo.svg' }` (VitePress auto-switches with theme)

### Files to delete

- `assets/feishu-logo.png` — no longer referenced after the embed goes away (verified via `grep`; the only references were the old base64 embed in `logo.svg` itself)
- `site/public/feishu-logo.png` — same

### Files that don't need changes

- `README.md` — already references `assets/logo.svg`; picks up the new design automatically. The dark plate works over both light and dark GitHub themes.
- `site/index.md` — references `/logo.svg`; auto-picks up new design.

## Non-goals

- No font file bundling — stick to system-font stack. `afc` renders acceptably in the fallback chain across OSes, and we avoid a web-font dependency for three letters.
- No PNG fallback — modern browsers (and GitHub README rendering) support SVG favicons and images. Skipping the extra format until someone reports a real-world need.
- No animated variant — a logo is a static identity mark; motion belongs on landing pages, not the favicon.
- No brand guidelines doc — this is a small OSS project, not a brand system.

## Testing

- **Visual**: open `assets/logo.svg`, `assets/logo-light.svg`, `assets/favicon.svg` directly in a browser; inspect at 180px, 64px, 32px, 16px.
- **README**: render locally by previewing `README.md` (e.g., via `gh markdown-preview` or GitHub's file view after push).
- **VitePress**: run `pnpm --filter site dev` (or the project's equivalent) and confirm header logo + favicon switch correctly with the theme toggle.
- **File weight**: the new `assets/logo.svg` should be < 2 KB (the current one is ~20 KB due to the base64 PNG). Smaller is a signal the embed is truly gone.

## Out of scope

- Brand palette / typography system for the docs site beyond what the logo uses.
- Social preview images (`og:image`) — can be regenerated later from the new logo if desired.
