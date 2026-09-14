# Coronelli

A local-first application that turns text-bearing fiction into a reviewed, provenance-aware spatial world model and a browsable schematic atlas.

```
Source text → sections → candidate spatial extraction → review → canonical Atlas Package → atlas
```

## What it does

1. **Import** `.txt`, `.md`, and text-bearing `.pdf` documents locally.
2. **Section** documents into inspectable source sections and correct boundaries.
3. **Extract** candidate map-relevant entities and claims via a configured LLM provider.
4. **Review** candidates as provisional working facts — approve, challenge, edit, merge, or defer.
5. **Export** a canonical [Atlas Package](packages/atlas-package-v0.1/) and optional cartographer packet.
6. **Browse** a provenance-aware SVG schematic atlas with reader-knowledge reveal controls.

Every map fact carries an `explicit`, `inferred`, or `imagined` status and full source provenance. LLM output is never automatically canonical.

## Requirements

- Python 3.12+
- Node.js 20+, pnpm 8+

## Local setup

```sh
# Install Python dependencies
cd apps/api
pip install -e ".[dev]"

# Install JS dependencies
cd ../..
pnpm install

# Start the API server
cd apps/api
uvicorn app.main:app --reload

# Start the web client (separate terminal)
cd apps/web
pnpm dev
```

## Tests

```sh
# API tests
cd apps/api && python -m pytest -q

# Web tests
cd apps/web && pnpm test --run
```

## Workspaces

| Category | Path | Repository status |
|---|---|---|
| `demo` | `data/demos/` | Tracked — original/public-domain material only |
| `private` | `data/private/` | Ignored — copyrighted or personal corpus material |

Exports targeting `exports/private/` are gitignored. Files matching `*.atlas.private` are always ignored. Do not commit private source text, extracted databases, or derived art.

## Atlas Package

The portable interchange format is defined in [`packages/atlas-package-v0.1/`](packages/atlas-package-v0.1/). It stores canonical entities, claims, travel rules, layouts, discovery data, and art inventory — independently of any database or LLM provider.

## License

MIT
