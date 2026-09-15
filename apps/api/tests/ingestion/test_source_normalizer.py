"""Tests for the source normalizer: Gutenberg boundary detection and end-matter extraction.

Test layers
-----------
Unit tests (always run): use synthetic in-module text, no private files required.
Fixture tests (skipped if files absent): verify real Gutenberg files behave correctly.
"""
from pathlib import Path

import pytest

from app.ingestion.normalizer import normalize_source

# ── Paths to private fixture files ────────────────────────────────────────────

_PRIVATE = Path(__file__).parent.parent.parent.parent.parent / "data" / "private"
_YELLOW_WALLPAPER = _PRIVATE / "yellow-wallpaper.txt"
_SLEEPY_HOLLOW    = _PRIVATE / "legend-of-sleepy-hollow.txt"

_GUTENBERG_START_PHRASE = "START OF THE PROJECT GUTENBERG"
_GUTENBERG_END_PHRASE   = "END OF THE PROJECT GUTENBERG"
_GUTENBERG_LICENSE_PHRASE = "Project Gutenberg License"


# ── Synthetic helper ──────────────────────────────────────────────────────────

def _make_gutenberg(narrative: str, postscript: str = "") -> str:
    header = (
        "The Project Gutenberg eBook of Test Story\n\n"
        "Some preamble text here.\n\n"
        "*** START OF THE PROJECT GUTENBERG EBOOK TEST STORY ***\n\n\n"
    )
    footer = (
        "\n\n\n*** END OF THE PROJECT GUTENBERG EBOOK TEST STORY ***\n\n"
        "Updated editions will replace the previous one.\n"
        "Some Project Gutenberg License text here.\n"
    )
    body = narrative
    if postscript:
        body += f"\n\n\n\nPOSTSCRIPT.\n\n{postscript}\n"
    return header + body + footer


# ── Unit tests: Gutenberg boundary detection ──────────────────────────────────

class TestGutenbergDetection:
    def test_strips_header_and_footer(self):
        raw = _make_gutenberg("Once upon a time.")
        result = normalize_source(raw)
        assert "preamble" not in result.narrative_body
        assert "Updated editions" not in result.narrative_body
        assert "Once upon a time." in result.narrative_body

    def test_no_gutenberg_markers_in_narrative_body(self):
        raw = _make_gutenberg("The valley lay still.")
        result = normalize_source(raw)
        assert _GUTENBERG_START_PHRASE not in result.narrative_body
        assert _GUTENBERG_END_PHRASE not in result.narrative_body

    def test_no_license_text_in_narrative_body(self):
        raw = _make_gutenberg("A quiet morning.")
        result = normalize_source(raw)
        assert _GUTENBERG_LICENSE_PHRASE not in result.narrative_body

    def test_raw_text_unchanged(self):
        raw = _make_gutenberg("The ship sailed on.")
        result = normalize_source(raw)
        assert result.raw_text == raw

    def test_body_offsets_map_correctly(self):
        raw = _make_gutenberg("The river ran cold.")
        result = normalize_source(raw)
        slice_ = result.raw_text[result.body_start:result.body_end]
        assert "The river ran cold." in slice_
        # The slice must be exactly the narrative body (modulo strip-equivalent).
        assert slice_.strip() == result.narrative_body.strip()

    def test_no_diagnostics_when_markers_present(self):
        raw = _make_gutenberg("Clear skies above.")
        result = normalize_source(raw)
        assert result.diagnostics == []

    def test_diagnostic_when_start_marker_missing(self):
        raw = "Just plain text with no markers."
        result = normalize_source(raw)
        assert len(result.diagnostics) == 1
        assert "START" in result.diagnostics[0]

    def test_full_text_used_when_no_markers(self):
        raw = "Plain text only."
        result = normalize_source(raw)
        assert "Plain text only." in result.narrative_body

    def test_diagnostic_when_end_marker_missing(self):
        raw = "*** START OF THE PROJECT GUTENBERG EBOOK X ***\n\nNarrative.\n"
        result = normalize_source(raw)
        assert len(result.diagnostics) == 1
        assert "END" in result.diagnostics[0]


# ── Unit tests: authored end-matter detection ─────────────────────────────────

class TestAuthoredEndMatterDetection:
    def test_postscript_detected_as_end_matter(self):
        raw = _make_gutenberg("Main story ends here.", "The moral of the story.")
        result = normalize_source(raw)
        assert len(result.authored_sections) == 1
        assert result.authored_sections[0].kind == "end_matter"
        assert result.authored_sections[0].title == "Postscript"

    def test_postscript_excluded_from_narrative_body(self):
        raw = _make_gutenberg("The hero returned home.", "A final note follows.")
        result = normalize_source(raw)
        assert "final note" not in result.narrative_body
        assert "hero returned" in result.narrative_body

    def test_postscript_text_captured(self):
        raw = _make_gutenberg("Main narrative.", "The epilogue begins here.")
        result = normalize_source(raw)
        assert "epilogue begins" in result.authored_sections[0].text

    def test_postscript_start_in_raw_correct(self):
        raw = _make_gutenberg("Story text.", "Postscript content.")
        result = normalize_source(raw)
        assert result.authored_sections[0].start_in_raw > 0
        # The first char at start_in_raw should be part of the POSTSCRIPT line.
        assert raw[result.authored_sections[0].start_in_raw:].upper().startswith("POSTSCRIPT")

    def test_no_authored_sections_when_none_present(self):
        raw = _make_gutenberg("A story without a postscript.")
        result = normalize_source(raw)
        assert result.authored_sections == []

    def test_narrative_body_offset_valid_after_postscript_split(self):
        raw = _make_gutenberg("Before.", "After.")
        result = normalize_source(raw)
        extracted = result.raw_text[result.body_start:result.body_end]
        assert "Before." in extracted
        assert "After." not in extracted

    def test_epilogue_keyword_detected(self):
        raw = _make_gutenberg("Main.", "").replace("POSTSCRIPT.", "EPILOGUE.")
        # Re-run on a synthetic with EPILOGUE keyword
        text = (
            "*** START OF THE PROJECT GUTENBERG EBOOK X ***\n\n"
            "Main narrative.\n\n\n\n"
            "EPILOGUE.\n\nThe end note.\n"
            "*** END OF THE PROJECT GUTENBERG EBOOK X ***\n"
        )
        result = normalize_source(text)
        assert len(result.authored_sections) == 1
        assert result.authored_sections[0].title == "Epilogue"


# ── Fixture tests: real Gutenberg files ───────────────────────────────────────

@pytest.fixture(scope="module")
def yellow_wallpaper_text():
    if not _YELLOW_WALLPAPER.exists():
        pytest.skip("yellow-wallpaper.txt not available in data/private")
    return _YELLOW_WALLPAPER.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def sleepy_hollow_text():
    if not _SLEEPY_HOLLOW.exists():
        pytest.skip("legend-of-sleepy-hollow.txt not available in data/private")
    return _SLEEPY_HOLLOW.read_text(encoding="utf-8")


class TestYellowWallpaper:
    def test_no_gutenberg_markers_in_narrative_body(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert _GUTENBERG_START_PHRASE not in result.narrative_body
        assert _GUTENBERG_END_PHRASE not in result.narrative_body

    def test_no_license_text_in_narrative_body(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert "Project Gutenberg License" not in result.narrative_body

    def test_raw_text_unchanged(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert result.raw_text == yellow_wallpaper_text

    def test_body_offsets_map_correctly(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        extracted = result.raw_text[result.body_start:result.body_end]
        assert extracted.strip() == result.narrative_body.strip()

    def test_narrative_contains_story_text(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert "mere ordinary people" in result.narrative_body

    def test_no_authored_sections(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert result.authored_sections == []

    def test_no_diagnostics(self, yellow_wallpaper_text):
        result = normalize_source(yellow_wallpaper_text)
        assert result.diagnostics == []


class TestSleepyHollow:
    def test_no_gutenberg_markers_in_narrative_body(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert _GUTENBERG_START_PHRASE not in result.narrative_body
        assert _GUTENBERG_END_PHRASE not in result.narrative_body

    def test_no_license_text_in_narrative_body(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert "Project Gutenberg License" not in result.narrative_body

    def test_raw_text_unchanged(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert result.raw_text == sleepy_hollow_text

    def test_body_offsets_map_correctly(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        extracted = result.raw_text[result.body_start:result.body_end]
        assert extracted.strip() == result.narrative_body.strip()

    def test_narrative_contains_story_text(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert "Sleepy Hollow" in result.narrative_body

    def test_postscript_detected_as_end_matter(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert len(result.authored_sections) == 1
        assert result.authored_sections[0].kind == "end_matter"
        assert result.authored_sections[0].title == "Postscript"

    def test_postscript_excluded_from_narrative_body(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert "FOUND IN THE HANDWRITING OF MR. KNICKERBOCKER" not in result.narrative_body

    def test_postscript_content_in_authored_section(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert "KNICKERBOCKER" in result.authored_sections[0].text

    def test_no_diagnostics(self, sleepy_hollow_text):
        result = normalize_source(sleepy_hollow_text)
        assert result.diagnostics == []


# ── Integration tests: import pipeline section count ─────────────────────────

class TestImportPipeline:
    """Verify that the full import_document pipeline produces the expected section structure."""

    def test_yellow_wallpaper_one_narrative_section(self, yellow_wallpaper_text):
        """Yellow Wallpaper must yield exactly one extractable narrative section."""
        from app.ingestion.normalizer import normalize_source as ns
        from app.ingestion.sectioner import section_text

        result = ns(yellow_wallpaper_text)
        sections = section_text(result.narrative_body)
        # All sections from section_text are narrative by default.
        assert len(sections) == 1
        assert sections[0].text.strip() != ""

    def test_sleepy_hollow_one_narrative_and_one_postscript(self, sleepy_hollow_text):
        """Sleepy Hollow must yield exactly one narrative section plus one end_matter postscript."""
        from app.ingestion.normalizer import normalize_source as ns
        from app.ingestion.sectioner import section_text

        result = ns(sleepy_hollow_text)
        narrative_sections = section_text(result.narrative_body)
        end_matter = result.authored_sections

        assert len(narrative_sections) == 1, (
            f"Expected 1 narrative section, got {len(narrative_sections)}"
        )
        assert len(end_matter) == 1
        assert end_matter[0].kind == "end_matter"
