# Coronelli ◉

A literary atlas builder — upload a book and explore its world in 3D.

Coronelli is inspired by the craft of historical cartographers: it reads a novel section by section, finds every named place, maps spatial relationships and visual qualities, and builds a navigable world you can orbit and inspect.

```
Upload → Catalog → Extract → Synthesize → Atlas Editor → 3D Explorer
```

- Import `.txt`, `.md`, and text-bearing `.pdf` files
- LLM pipeline identifies places, containment hierarchies, spatial claims, and visual details
- Every extracted candidate is held for human review before it becomes canonical
- Edit the atlas — rename entities, merge duplicates, assign hierarchy, add relationships
- Explore in an interactive 3D scene: zone rings, floating nodes, force-directed layout

## Requirements

- Python 3.12+, [uv](https://docs.astral.sh/uv/)
- Node 20+, pnpm 9+
- OpenAI API key

## Setup

```sh
# Backend
cd apps/api
uv sync --extra dev

# Frontend
pnpm install
```

Copy `.env.example` to `apps/api/.env` and set `OPENAI_API_KEY`.

## Running

```sh
# Backend  (http://localhost:8000)
cd apps/api
uv run uvicorn app.main:app --reload

# Frontend  (http://localhost:5173)
pnpm dev
```

## Tests

```sh
cd apps/api && uv run pytest -q
pnpm --filter web test --run
```

## Cost and caching

Estimated cost is shown before each pipeline stage. Repeated extraction on unchanged sections is served from cache — no new API call is made.

## Data

| Kind | Path | Notes |
|------|------|-------|
| Demo | `data/demos/` | Tracked — public-domain or synthetic material only |
| Private | `data/private/` | Ignored — copyrighted or personal source text |

`exports/private/` and `*.atlas.private` files are always gitignored. Do not commit private source text or derived artefacts.

## License

Source-available, personal non-commercial use only. See [LICENSE](LICENSE).
