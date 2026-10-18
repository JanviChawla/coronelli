"""Catalog and gap extraction pass — calls LLM to extract places from a section."""

import hashlib
import json
import logging
import re
from typing import Any

from app.extraction.prompts import CATALOG_SYSTEM, CATALOG_VERSION, GAP_SYSTEM, GAP_VERSION

logger = logging.getLogger(__name__)

_FENCE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_list(raw: str | None) -> list[dict[str, Any]]:
    """Parse a JSON array from a model response, stripping markdown fences."""
    text = (raw or "").strip()
    m = _FENCE.match(text)
    if m:
        text = m.group(1).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Could not parse LLM response as JSON: %s", text[:200])
        return []
    if isinstance(parsed, list):
        return parsed
    # model wrapped in an object — try common keys
    for key in ("places", "locations", "results", "items", "claims", "data"):
        if isinstance(parsed.get(key), list):
            return parsed[key]
    logger.warning("Unexpected JSON shape from LLM: %s", list(parsed.keys()))
    return []


def compute_catalog_hash(section_id: str, section_text: str, prompt_version: str) -> str:
    """SHA-256 of (prompt_version + section_id + section_text). Used as cache key."""
    raw = f"{prompt_version}:{section_id}:{section_text}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _build_catalog_user_prompt(section_text: str, known_names: list[dict[str, Any]]) -> str:
    known_block = ""
    if known_names:
        names_list = "\n".join(f"  - {p['name']} ({p.get('kind', '')})" for p in known_names)
        known_block = f"\n\nALREADY-CONFIRMED PLACES (do not re-emit these):\n{names_list}\n"
    return f"SECTION TEXT:\n{section_text}{known_block}"


def _build_gap_user_prompt(
    section_text: str, catalog_results: list[dict[str, Any]]
) -> str:
    catalog_block = json.dumps(catalog_results, indent=2)
    return (
        f"SECTION TEXT:\n{section_text}\n\n"
        f"CATALOG PASS RESULTS (already found — do not re-emit):\n{catalog_block}"
    )


async def run_catalog_and_gap(
    section_id: str,
    section_text: str,
    known_names: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Run the catalog + gap LLM passes for a single section.

    Returns a merged list of place dicts. Gap results are tagged with source='gap'.
    The caller is responsible for persisting to the database.

    TODO: Wire Anthropic API calls below. Replace the NotImplementedError with actual calls.
    """
    import os
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    model = os.getenv("OPENAI_EXTRACTION_MODEL", "gpt-4o")

    catalog_resp = await client.chat.completions.create(
        model=model,
        max_tokens=4096,
        messages=[
            {"role": "system", "content": CATALOG_SYSTEM},
            {"role": "user", "content": _build_catalog_user_prompt(section_text, known_names)},
        ],
    )
    catalog_results: list[dict[str, Any]] = _parse_list(catalog_resp.choices[0].message.content)

    gap_resp = await client.chat.completions.create(
        model=model,
        max_tokens=2048,
        messages=[
            {"role": "system", "content": GAP_SYSTEM},
            {"role": "user", "content": _build_gap_user_prompt(section_text, catalog_results)},
        ],
    )
    gap_results: list[dict[str, Any]] = _parse_list(gap_resp.choices[0].message.content)
    for p in gap_results:
        p["source"] = "gap"

    return catalog_results + gap_results


def get_combined_hash(section_id: str, section_text: str) -> str:
    """Hash covering both catalog and gap versions — bump either version to invalidate."""
    combined_version = f"{CATALOG_VERSION}+{GAP_VERSION}"
    return compute_catalog_hash(section_id, section_text, combined_version)
