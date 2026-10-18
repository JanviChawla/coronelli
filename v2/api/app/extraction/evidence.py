"""Evidence extraction pass — extracts spatial and visual claims from a section."""

import json
import logging
import re
from typing import Any

from app.extraction.prompts import EVIDENCE_SYSTEM
from app.extraction.catalog import _parse_list

logger = logging.getLogger(__name__)


def _build_evidence_user_prompt(
    section_text: str, confirmed_places: list[dict[str, Any]]
) -> str:
    places_block = "\n".join(
        f"  - {p['name']} (id: {p['id']}, kind: {p.get('kind', '')})"
        for p in confirmed_places
    )
    return (
        f"CONFIRMED PLACES IN THIS BOOK:\n{places_block}\n\n"
        f"SECTION TEXT:\n{section_text}"
    )


async def extract_evidence(
    section_id: str,
    section_text: str,
    confirmed_places: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Extract spatial and visual claims from a section of text.

    Returns a list of claim dicts. The caller is responsible for resolving
    subject/object names to Place IDs and persisting to the database.

    TODO: Wire Anthropic API calls below. Replace the NotImplementedError with actual calls.
    """
    import os
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    model = os.getenv("OPENAI_EXTRACTION_MODEL", "gpt-4o")

    resp = await client.chat.completions.create(
        model=model,
        max_tokens=4096,
        messages=[
            {"role": "system", "content": EVIDENCE_SYSTEM},
            {"role": "user", "content": _build_evidence_user_prompt(section_text, confirmed_places)},
        ],
    )
    return _parse_list(resp.choices[0].message.content)
