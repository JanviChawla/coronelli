# Coronelli — Claude Code guide

Coronelli is a tool for building literary atlases by hand. A pipeline surfaces candidate places, relationships, and visual details as raw material — the cartographer reviews every candidate before anything lands on the map.

## Dev servers

```
# Backend (http://localhost:8000)
cd apps/api
uv run uvicorn app.main:app --reload

# Frontend (http://localhost:5173)
cd apps/web
pnpm dev

# Frontend tests
cd apps/web
pnpm test
```

> **Note:** `node` and `pnpm` may not be in PATH in Claude Code's shell. Fix with:
> `$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"`

## Release

```
# Build (from repo root)
.\scripts\build.ps1

# Publish to PyPI
cd apps/api
uv publish dist/coronelli-X.Y.Z-py3-none-any.whl dist/coronelli-X.Y.Z.tar.gz --username __token__
```

DB is stored in the platform data dir (`%LOCALAPPDATA%\Coronelli\` on Windows). Dev and installed versions share the same DB.

## Pipeline — the five stages

```
Upload → Catalog → Extract → Synthesize → Atlas Editor → 3D Explorer
```

| Stage | What happens | Key code |
|---|---|---|
| **Upload** | PDF/text split into `SourceSection` records | `apps/api/app/ingestion/sectioner.py` |
| **Catalog** | LLM reads each section, names every place → `Candidate(kind="entity")` | `prompts_catalog.py`, `extraction/service.py` |
| **Extract** | Three sub-passes per section: spatial claims, visual claims, travel rules → `Candidate(kind="claim")` | `prompts_evidence.py`, `extraction/openai_provider.py` |
| **Synthesize** | Candidates reviewed/deduped → promoted to `MapEntity` and `MapClaim` records | `synthesis/service.py`, `synthesis/review.py` |
| **Atlas Editor** | User refines hierarchy, renames entities, merges duplicates | `AtlasEditor.tsx` and sub-panels |

## Domain model

```
SourceDocument  1──* SourceSection
                      |
                      └──* ExtractionRun   (one per LLM pass; prompt_version identifies the pass)
                            └──* Candidate (raw LLM output, kind = "entity" | "claim")

MapEntity   — a canonicalized place (name, aliases, place_kind, tier, payload)
MapClaim    — a relationship between entities (predicate, subject_ref, object_refs[])
EntityMention — tracks where a MapEntity appears in the text
```

**Key `MapClaim` predicates:**
- `CONTAINS` — subject contains object (created by `assign-containment`)
- `LOCATED_IN` — subject is inside object (created by synthesis; legacy direction)
- `FLOWS_THROUGH` — a waterway/path passes through a place
- `SAME_AS` — dedup candidate (resolved to entity merge)

**Critical invariant:** `MapClaim.subject_ref` and `object_refs` store entity **IDs**, not names. Renaming a `MapEntity` is always safe — only update `MapEntity.name` (and move the old name to `aliases`).

**Active records:** filter `MapEntity.state == "active"` and `MapClaim.state == "active"`. Rejected/merged records keep their row with a different state.

## File map — backend

```
apps/api/app/
  main.py                        FastAPI app + router registration
  config.py                      Platform data dir (Windows/macOS/Linux) + default DB URL
  cli.py                         `coronelli` entry point — opens browser, loads .env
  domain/world.py                SQLAlchemy models (MapEntity, MapClaim, SourceDocument, ...)

  api/
    atlas.py                     Thin router assembler — includes the 5 sub-routers
    atlas_read.py                GET /atlas, /entity-mentions, /excerpts + output models
    atlas_edit.py                PATCH/DELETE entities & claims, POST manual-entity
    atlas_export.py              GET /atlas.json, /atlas-package
    atlas_hierarchy.py           POST /assign-containment (LLM inference), /promote-dedup
    atlas_suggestions.py         GET /place-suggestions, POST /catalog/validate
    extraction.py                Catalog + evidence extraction API endpoints
    candidates.py                Candidate review endpoints

  extraction/
    service.py                   Orchestrates per-section extraction runs
    openai_provider.py           All OpenAI API calls for extraction
    prompts.py                   Re-export shim (import from here; don't import sub-files directly)
    prompts_catalog.py           Catalog + catalog-gap system prompts & templates
    prompts_evidence.py          Spatial / visual / travelrule / containment / dedup prompts
    prompts_taxonomy.py          Shared taxonomy blocks (_ENTITY_TYPE_BLOCK etc.)
    validation.py                Candidate schema validation

  synthesis/
    service.py                   Orchestrates synthesis over all sections
    provider.py                  OpenAI API calls for synthesis
    prompts.py                   Synthesis prompts
    review.py                    Public orchestrator: canonicalize_synthesis_items()
    review_approve.py            _approve_entity/claim/route/same_as/visual_palette/reveal_event
    review_enrich.py             _write_entity_mentions, apply_scene_anchor_counts, apply_catalog_fields

  ingestion/
    sectioner.py                 Six-strategy section splitter (regex, heading, blank-line, ...)
```

## File map — frontend

```
apps/web/src/
  App.tsx                        Root: switches between SourceLibrary and AtlasExplorer
  index.css                      CSS variables (--ink, --parchment, --gold, --border-warm, ...)

  features/sources/
    SourceLibrary.tsx            Home page — star background canvas, glass world cards
    SourceWorkflow.tsx           Pipeline stepper + explorer toggle; overlays header in explorer mode
    WorkflowHeader.tsx           Consistent CORONELLI header across all views
    sourceApi.ts                 Document/section CRUD API calls
    extractionApi.ts             Catalog, extraction, dedup, validation API calls

  features/atlas/
    AtlasEditor.tsx              Orchestrator: state + handlers + 3-panel shell
    AtlasHierarchyTree.tsx       Left panel — entity tree, catalog groups, absorb, confirm bar
    AtlasDetailPanel.tsx         Center panel — excerpts, visual claims
    AtlasRelationshipsPanel.tsx  Right panel — spatial claims, add-relationship form, dedup
    atlasHierarchy.ts            buildHierarchy() — pure function, no React
    atlasApi.ts                  All atlas API calls + TypeScript types
    atlasGraph.ts                Graph layout logic
    AtlasExplorer.tsx            3D star-field scene — Three.js, orbit/pan/zoom, node selection
    AtlasExplorerDetailPanel.tsx Inspector panel — opens on node click, dynamic height
    AtlasExplorerOverlays.tsx    Legend + loading/error overlays

  features/candidates/
    CandidatesTable.tsx          Tabular candidate review UI
    CandidateQueue.tsx           Queue-style candidate review UI
```

## Extraction prompt versions

Each `ExtractionRun` records which prompt generated it via `prompt_version`. The active versions are defined in `prompts_evidence.py` and `prompts_catalog.py`. **Do not change a version string without also updating the corresponding prompt** — the version is used to look up cached runs.

## Hierarchy mechanics

The Atlas Editor builds containment from two claim types:
- **Pass 1** (synthesis): `LOCATED_IN` claims → `subject` is inside `object_refs[0]`
- **Pass 2** (assign-containment): `CONTAINS` claims → `subject` contains `object_refs[0]`

`buildHierarchy()` in `atlasHierarchy.ts` merges both into one `parentOf` map. The LLM-based `_llm_infer_containment` in `atlas_hierarchy.py` always runs when "Auto-arrange" is clicked — it uses the book title/author, entity names with their `place_kind`, and existing claims to infer parent-child pairs.

## Cost tracking

LLM calls that the user can trigger manually (Check web, Auto-arrange, etc.) compute cost from `resp.usage` using a per-model pricing table and return `cost_usd` to the UI. The UI displays it in parentheses next to the button after the call completes.
