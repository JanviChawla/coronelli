from app.ingestion.sectioner import section_text


# ── Markdown ──────────────────────────────────────────────────────────────────

def test_section_markdown_by_headings(headed_md_bytes):
    text = headed_md_bytes.decode()
    sections = section_text(text)
    assert len(sections) == 3
    assert sections[0].title == "The Glass Coast"
    assert sections[1].title == "The Sunken Observatory"
    assert sections[2].title == "The Road East"


def test_section_heading_body_contains_content(headed_md_bytes):
    text = headed_md_bytes.decode()
    sections = section_text(text)
    assert "lantern" in sections[0].text


def test_section_ordinals_are_sequential(headed_md_bytes):
    text = headed_md_bytes.decode()
    sections = section_text(text)
    assert [s.ordinal for s in sections] == [0, 1, 2]


def test_heading_line_not_in_section_body():
    text = "# Prologue\nIt began at the shore.\n"
    sections = section_text(text)
    assert "It began" in sections[0].text
    assert sections[0].text.strip().startswith("It began")


# ── Chapter keyword headings (chapter-story.txt / Peter Pan) ─────────────────

def test_section_txt_by_chapter_headings(chapter_txt_bytes):
    text = chapter_txt_bytes.decode()
    sections = section_text(text)
    assert len(sections) == 3
    assert "Chapter 1" in sections[0].title


def test_unsectioned_text_is_single_section():
    text = "Once upon a time the barge drifted south. The end."
    sections = section_text(text)
    assert len(sections) == 1
    assert sections[0].ordinal == 0
    assert "barge" in sections[0].text


def test_plain_text_single_section_has_generated_title():
    text = "No headings here."
    sections = section_text(text)
    assert sections[0].title is not None
    assert sections[0].title.lower().startswith("section")


def test_chapter_heading_with_leading_whitespace():
    """Gutenberg sometimes pads headings with spaces for visual centering."""
    text = (
        "   CHAPTER I.\n"
        "Down the Rabbit-Hole\n\n"
        "Alice was beginning to get very tired.\n\n"
        "   CHAPTER II.\n"
        "The Pool of Tears\n\n"
        "Curiouser and curiouser.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2


def test_subtitle_extracted_and_combined_with_chapter_id():
    """Mixed-case 'Chapter I.' + subtitle on next line → 'Chapter I. Subtitle'."""
    text = (
        "Chapter I.\n"
        "Down the Rabbit-Hole\n\n"
        "Alice was beginning to get very tired of sitting by her sister.\n\n"
        "Chapter II.\n"
        "The Pool of Tears\n\n"
        "Curiouser and curiouser, cried Alice.\n"
    )
    sections = section_text(text)
    assert sections[0].title == "Chapter I. Down the Rabbit-Hole"
    assert sections[1].title == "Chapter II. The Pool of Tears"


def test_all_caps_subtitle_preserved_not_title_cased():
    """Peter Pan style: ALL-CAPS subtitle is kept exactly as found."""
    text = (
        "CHAPTER I\n"
        "PETER BREAKS THROUGH\n\n"
        "All children, except one, grow up.\n\n"
        "CHAPTER II\n"
        "THE SHADOW\n\n"
        "Mrs. Darling screamed.\n"
    )
    sections = section_text(text)
    assert sections[0].title == "Chapter I. PETER BREAKS THROUGH"
    assert sections[1].title == "Chapter II. THE SHADOW"


def test_chapter_without_subtitle_uses_roman_numeral():
    """Heading with Roman numeral but no subtitle → 'Chapter I', not 'Chapter 1'."""
    text = (
        "CHAPTER I.\n\n"
        "Alice was beginning to get very tired.\n\n"
        "CHAPTER II.\n\n"
        "She was considering in her own mind.\n"
    )
    sections = section_text(text)
    assert sections[0].title == "Chapter I"
    assert sections[1].title == "Chapter II"


def test_body_prose_chapter_not_matched_without_blank_line():
    """'chapter' mid-paragraph must not create a spurious section."""
    text = (
        "CHAPTER I.\n"
        "The Beginning\n\n"
        "She read every\nchapter, her mother always close by.\n\n"
        "CHAPTER II.\n"
        "The Middle\n\n"
        "More story here.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2


def test_toc_chapter_entry_not_matched_as_section():
    """A ToC line like ' Chapter I. PETER BREAKS THROUGH' must not become a section."""
    text = (
        "Contents\n\n"
        " Chapter I. PETER BREAKS THROUGH\n"
        " Chapter II. THE SHADOW\n\n\n\n"
        "Chapter I.\n"
        "PETER BREAKS THROUGH\n\n"
        "All children, except one, grow up.\n\n"
        "Chapter II.\n"
        "THE SHADOW\n\n"
        "Mrs. Darling screamed.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2
    assert sections[0].title == "Chapter I. PETER BREAKS THROUGH"
    assert sections[1].title == "Chapter II. THE SHADOW"


# ── Roman numeral + double-dash (Alice pg19033) ───────────────────────────────

def test_roman_dash_heading_format():
    """Alice pg19033 style: 'I--DOWN THE RABBIT-HOLE' subtitle is title-cased."""
    text = (
        "Publisher info.\n\n"
        "I--DOWN THE RABBIT-HOLE\n\n"
        "Alice was beginning to get very tired.\n\n"
        "II--THE POOL OF TEARS\n\n"
        "Curiouser and curiouser!\n"
    )
    sections = section_text(text)
    assert len(sections) == 2
    assert sections[0].title == "Chapter I. Down the Rabbit-Hole"
    assert sections[1].title == "Chapter II. The Pool of Tears"


def test_roman_dash_apostrophe_not_capitalised():
    """Python .title() wrongly capitalises 'S in contractions; we fix that."""
    text = (
        "VIII--THE QUEEN'S CROQUET GROUND\n\n"
        "Off with their heads!\n\n"
        "X--ALICE'S EVIDENCE\n\n"
        "Here comes the evidence.\n"
    )
    sections = section_text(text)
    assert sections[0].title == "Chapter VIII. The Queen's Croquet Ground"
    assert sections[1].title == "Chapter X. Alice's Evidence"


# ── Numeric chapter headings (Firebringer) ────────────────────────────────────

def test_numeric_chapters_detected():
    """'2 Changeling' style isolated numeric headings are sectioned."""
    text = (
        "Prologue text.\n\n"
        "1 Birth and Prophecy\n\n"
        "A lone red deer was grazing.\n\n"
        "2 Changeling\n\n"
        "No, you old fool, stay here.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2
    assert sections[0].title == "1 Birth and Prophecy"
    assert sections[1].title == "2 Changeling"


def test_numeric_chapter_after_part_heading():
    """Chapters that follow 'Part X - \\n' (single newline) are still found."""
    text = (
        "Part One - \n"
        "1 Birth and Prophecy\n\n"
        "A lone red deer was grazing.\n\n"
        "2 Changeling\n\n"
        "No, you old fool.\n\n"
        "Part Two - \n"
        "3 Escape\n\n"
        "They ran through the valley.\n"
    )
    sections = section_text(text)
    assert len(sections) == 3
    assert sections[0].title == "1 Birth and Prophecy"
    assert sections[1].title == "2 Changeling"
    assert sections[2].title == "3 Escape"


def test_numeric_body_sentence_not_matched():
    """A sentence starting with a number is NOT matched (it won't be isolated)."""
    text = (
        "1 Birth and Prophecy\n\n"
        "100 hinds gathered. The stag led them away.\n\n"
        "2 Changeling\n\n"
        "Story continues.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2


# ── Roman-numeral chapter keyword without subtitle (Pride & Prejudice) ─────────

def test_chapter_roman_isolated_no_subtitle():
    """'CHAPTER I.\\nBody...' where chapter is the only content on the line."""
    text = (
        "- [Vol. I] 1 -\n"
        "CHAPTER I.\n"
        "It is a truth universally acknowledged.\n\n"
        "- [Vol. I] 8 -\n"
        "CHAPTER II.\n"
        "Mr. Bennet was among the earliest.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2
    assert sections[0].title == "Chapter I"
    assert sections[1].title == "Chapter II"


def test_chapter_roman_volume_prefix_on_restart():
    """When chapter numbering restarts, prefix each section with its volume."""
    text = (
        "- [Vol. I] 1 -\n"
        "CHAPTER I.\n"
        "Volume one chapter one.\n\n"
        "- [Vol. I] 8 -\n"
        "CHAPTER II.\n"
        "Volume one chapter two.\n\n"
        "- [Vol. II] 1 -\n"
        "CHAPTER I.\n"
        "Volume two chapter one.\n\n"
        "- [Vol. II] 8 -\n"
        "CHAPTER II.\n"
        "Volume two chapter two.\n"
    )
    sections = section_text(text)
    assert len(sections) == 4
    assert sections[0].title == "Vol. I · Chapter I"
    assert sections[1].title == "Vol. I · Chapter II"
    assert sections[2].title == "Vol. II · Chapter I"
    assert sections[3].title == "Vol. II · Chapter II"


def test_chapter_roman_no_prefix_when_no_restart():
    """Single volume with no restart → plain 'Chapter X' titles."""
    text = (
        "- [Vol. I] 1 -\n"
        "CHAPTER I.\n"
        "It is a truth.\n\n"
        "- [Vol. I] 8 -\n"
        "CHAPTER II.\n"
        "Mr. Bennet was among.\n"
    )
    sections = section_text(text)
    assert len(sections) == 2
    assert sections[0].title == "Chapter I"
    assert sections[1].title == "Chapter II"


def test_chapter_roman_three_volumes():
    """Three-volume restart gets Vol. I / II / III prefixes."""
    text = (
        "CHAPTER I.\n"
        "Vol 1 ch 1.\n\n"
        "CHAPTER II.\n"
        "Vol 1 ch 2.\n\n"
        "CHAPTER I.\n"
        "Vol 2 ch 1.\n\n"
        "CHAPTER II.\n"
        "Vol 2 ch 2.\n\n"
        "CHAPTER I.\n"
        "Vol 3 ch 1.\n\n"
        "CHAPTER II.\n"
        "Vol 3 ch 2.\n"
    )
    sections = section_text(text)
    assert len(sections) == 6
    assert sections[0].title == "Vol. I · Chapter I"
    assert sections[2].title == "Vol. II · Chapter I"
    assert sections[4].title == "Vol. III · Chapter I"


def test_roman_dash_body_text_not_matched():
    """'chapter--' mid-paragraph is not isolated so is never matched."""
    text = (
        "I--DOWN THE RABBIT-HOLE\n\n"
        "Alice said I--never mind to the rabbit.\n\n"
        "II--THE POOL OF TEARS\n\n"
        "Story continues.\n"
    )
    sections = section_text(text)
    # Mid-paragraph "I--never mind" is in the middle of a paragraph, no blank
    # line before it, so only the two real chapter headings match.
    assert len(sections) == 2


# ── ToC-based (Oz) ────────────────────────────────────────────────────────────

def test_toc_based_sectioning():
    """
    Oz style: ToC lists 'Chapter N. Subtitle'; body uses subtitle-only headings.
    Structural keywords (Contents, Introduction) become un-numbered sections.
    """
    text = (
        "Contents\n\n"
        " Chapter I. The Storm\n"
        " Chapter II. The City\n\n"
        "Introduction\n\n"
        "Intro text here.\n\n"
        "The Storm\n\n"
        "Dorothy lived far away.\n\n"
        "The City\n\n"
        "She arrived at the gates.\n"
    )
    sections = section_text(text)
    assert len(sections) == 4
    assert sections[0].title == "Contents"
    assert sections[1].title == "Introduction"
    assert sections[2].title == "Chapter I. The Storm"
    assert sections[3].title == "Chapter II. The City"


def test_toc_body_text_preserved():
    """Body text of each ToC-based section is correct."""
    text = (
        "Contents\n\n"
        " Chapter I. The Storm\n"
        " Chapter II. The City\n\n"
        "The Storm\n\n"
        "Dorothy lived far away.\n\n"
        "The City\n\n"
        "She arrived at the gates.\n"
    )
    sections = section_text(text)
    # Contents + Chapter I + Chapter II
    assert len(sections) == 3
    assert "Dorothy" in sections[1].text
