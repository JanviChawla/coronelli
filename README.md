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

## Installation

Requires Python 3.12+. Install with [uv](https://docs.astral.sh/uv/):

```sh
uv tool install coronelli
```

Then launch:

```sh
coronelli
```

Coronelli opens in your browser at `http://localhost:8000`. Your atlas data is stored locally:

| Platform | Location |
|----------|----------|
| Windows  | `%LOCALAPPDATA%\Coronelli\coronelli.db` |
| macOS    | `~/Library/Application Support/Coronelli/coronelli.db` |
| Linux    | `~/.local/share/Coronelli/coronelli.db` |

Set your OpenAI API key before running extraction:

```sh
# in your shell profile, or in %LOCALAPPDATA%\Coronelli\.env  (Windows)
#                                ~/Library/Application Support/Coronelli/.env  (macOS)
OPENAI_API_KEY=sk-...
```

## Cost and caching

Estimated cost is shown before each pipeline stage. Repeated extraction on unchanged sections is served from cache — no new API call is made.

## License

Source-available, personal non-commercial use only. See [LICENSE](LICENSE).
