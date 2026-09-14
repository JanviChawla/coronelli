# Coronelli

Local-first application for turning written fiction into a reviewed, provenance-aware spatial world model.

```
source text → sections → candidate extraction → review → canonical world data
```

## What it does

- Import `.txt`, `.md`, and text-bearing `.pdf` source documents.
- Detect and correct section boundaries; assign section titles.
- Extract candidate map-relevant entities and claims via a cloud LLM (BYOK — see below).
- Store candidates with temporal interpretation and inter-claim relation fields.
- Review each candidate — approve, reject, or defer — before anything becomes canonical.
- Every claim carries `explicit`, `inferred`, or `imagined` status and full source provenance.

## Requirements

- Python 3.12+, [uv](https://docs.astral.sh/uv/)
- Node 20+, pnpm 12+

## Setup

```sh
# Python dependencies (from apps/api)
cd apps/api
uv sync --extra dev

# JS dependencies (from repo root)
pnpm install
```

Copy `.env.example` to `.env` and fill in your credentials before starting the API.

## Running

```sh
# API — port 8000 (from apps/api)
uv run uvicorn app.main:app --reload

# Web client — port 5173 (from repo root, separate terminal)
pnpm dev
```

## Tests

```sh
# API
cd apps/api && uv run pytest -q

# Web
pnpm --filter web test --run
```

## Cloud extraction — BYOK

Candidate extraction uses the OpenAI API. Set `OPENAI_API_KEY` and `OPENAI_EXTRACTION_MODEL`
in `.env`. No shared key is bundled or implied. The application never makes LLM output
canonical automatically; all candidates are held for human review.

A preflight endpoint (`GET /api/sections/{id}/extract/preflight`) shows estimated token
count and cost before any request is sent. Repeated extraction on unchanged sections is
served from cache without a new API call.

## Workspaces

| Kind | Path | Status |
|---|---|---|
| demo | `data/demos/` | Tracked — public-domain or synthetic material only |
| private | `data/private/` | Ignored — copyrighted or personal corpus material |

`exports/private/` and `*.atlas.private` files are always ignored. Do not commit private
source text, extracted databases, or derived artefacts.

## License

Source-available, personal non-commercial use only. See [LICENSE](LICENSE).
