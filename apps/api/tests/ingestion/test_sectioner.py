from app.ingestion.sectioner import section_text


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


def test_section_txt_by_chapter_headings(chapter_txt_bytes):
    text = chapter_txt_bytes.decode()
    sections = section_text(text)
    assert len(sections) == 3
    assert "Chapter 1" in sections[0].title


def test_section_ordinals_are_sequential(headed_md_bytes):
    text = headed_md_bytes.decode()
    sections = section_text(text)
    assert [s.ordinal for s in sections] == [0, 1, 2]


def test_unsectioned_text_is_single_section():
    text = "Once upon a time the barge drifted south. The end."
    sections = section_text(text)
    assert len(sections) == 1
    assert sections[0].ordinal == 0
    assert "barge" in sections[0].text


def test_single_section_title_is_none_for_plain_text():
    text = "No headings here."
    sections = section_text(text)
    assert sections[0].title is None


def test_heading_line_not_in_section_body():
    text = "# Prologue\nIt began at the shore.\n"
    sections = section_text(text)
    assert "It began" in sections[0].text
    assert sections[0].text.strip().startswith("It began")
