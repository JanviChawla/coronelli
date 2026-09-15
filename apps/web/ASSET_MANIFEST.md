# Visual Asset Manifest — Coronelli Web

All production visual assets are catalogued here before commit.
**Do not add an asset to the codebase without a corresponding entry.**

Fields: `id`, `source`, `license / provenance`, `intended location`, `dimensions`, `theme role`, `status`.

---

## ── Committed assets ─────────────────────────────────────────────────────────

_None yet. All current chrome is hand-authored CSS and inline SVG._

---

## ── Planned generated assets (not yet committed) ────────────────────────────

These are placeholders for a future transparent-PNG / SVG kit.
They must remain **presentation-only** — replaceable without functional breakage.
Low opacity (≤ 0.15 normal use, ≤ 0.08 behind text) and generous negative space required.

| id | description | intended location | dimensions | theme role | license target | status |
|----|-------------|-------------------|------------|------------|----------------|--------|
| `texture/parchment-grain` | Subtle paper / laid-paper grain texture, seamlessly tileable | `atlas-canvas-root` background; workflow card backgrounds | 512 × 512 px PNG, transparent | Adds tactility to flat parchment; must not compete with place labels | CC0 or self-generated via noise | **not committed** |
| `ornament/corner-botanical` | Single botanical sprig (leaf or frond), mirrored to four corners | Atlas canvas frame corners; Inspector overlay header | 64 × 64 px SVG, transparent | Natural-history register; evokes cartographic tradition | Self-authored SVG or CC0 clip-art | **not committed** |
| `ornament/compass-seal` | Restrained compass rose or wax seal, no more than 8 directions | Atlas empty-state screen | 120 × 120 px SVG, transparent | Orientation glyph for empty / loading states; never in populated map | Self-authored SVG | **not committed** |
| `texture/fog-silhouette` | Light edge-fade / vignette, soft radial gradient | Atlas canvas outer edges | Full-bleed PNG at 10 % opacity | Frames the schematic softly; must not obscure nodes or edges | Self-generated CSS gradient preferred | **not committed** |
| `ornament/empty-state-medallion` | Decorative empty-state central mark (e.g. cartouche outline) | Workflow "no source selected" and Atlas "no entities" screens | 160 × 160 px SVG, transparent | Holds space elegantly; replaced automatically once content exists | Self-authored SVG | **not committed** |

---

## ── Constraints (apply to all entries above) ─────────────────────────────────

- No artwork that implies a specific story, character, place, or canon not in the source text.
- No artwork behind body text, place labels, edges, or inspector content.
- No source-specific imagery embedded in generic product chrome.
- No third-party assets with attribution requirements visible to end-users (internal tools only).
- Generated images: use low opacity (≤ 0.15 in normal use) and generous negative space.
- All generated art must be replaceable without code changes (CSS `background-image` swap).
- Respect `prefers-reduced-motion` and `prefers-contrast: more` — assets must degrade gracefully.

---

## ── Non-asset chrome elements (CSS / inline SVG — no manifest entry needed) ──

The following are implemented entirely in CSS or hand-authored `<svg>` inside components.
They are not binary assets and do not require a manifest entry.

- Panel borders and double-rule frames (`.cartouche`, `.atlas-canvas-root`)
- Divider rules with centre ornament (`.divider-rule`)
- Compact legend symbols (`LegendDot`, `LegendLine`, `LegendOrigin`, `LegendHull` SVGs)
- Place node glyphs — circles, concentric rings, origin mark, inferred dash (`SchematicNode`)
- Button and selection states (`.btn-cta`, `.btn-outline-warm`, `:focus-visible`)
- Inspector header and overlay chrome (`.atlas-inspector`, `.atlas-overlay`)
- Narrative scrubber and filter bar chrome (`.atlas-scrubber`, `.atlas-filter-bar`)
