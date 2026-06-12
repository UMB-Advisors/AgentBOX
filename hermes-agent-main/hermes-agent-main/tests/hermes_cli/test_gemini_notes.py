"""Unit tests for the Gemini meeting-notes parser (pure, no I/O)."""

from hermes_cli.gemini_notes import parse_gemini_note

# Faithful trim of a real gemini-notes@google.com email body (2026-06-10),
# including the soft-wrapped lines and footer boilerplate Gmail delivers.
SAMPLE_SUBJECT = "Notes: “Strategy Meeting” Jun 10, 2026"
SAMPLE_BODY = """Notes from “Strategy Meeting”

These notes have been sent to invited guests in your organization.

Open meeting notes

The content was auto-generated on June 10, 2026, 8:48 PM UTC and may
contain errors.


Summary
The group reviewed automation strategies and shifted to problem-centric
sales models while addressing internal team partnership challenges.


Refining Business Strategy Focus
The group decided to shift toward an accounting niche and implement a
problem-centric sales model.

Scaling Sales and Infrastructure
The team prioritized deterministic infrastructure over costly AI reasoning
to maintain reliability.


Suggested next steps



[Dustin] Follow up dev call: Address the automated push of meeting notes
into a consolidated folder during the 1:00 call with Eric.

[Kevin, Patrick, Michael] Evaluate accountant market: Analyze the market
and accessibility for accountants.

[The group] Conduct micro discovery sprint: Perform a 2-week sprint focused
on identifying automation opportunities.


We've updated the Decisions section based on your feedback.
What do you think?


Meeting records Document Notes by Gemini


Is the Next Steps section in this email helpful?
Not Useful Email Useful Email


Google LLC, 1600 Ampitheatre Parkway, Mountain View, CA 94043, USA

You have received this email because meeting artifacts were initiated in
Google Meet.
"""


def test_title_and_date_from_subject():
    p = parse_gemini_note(SAMPLE_SUBJECT, SAMPLE_BODY)
    assert p["title"] == "Strategy Meeting"
    assert p["meeting_date"] == "Jun 10, 2026"


def test_summary_extracted_and_unwrapped():
    p = parse_gemini_note(SAMPLE_SUBJECT, SAMPLE_BODY)
    assert p["summary"].startswith("The group reviewed automation strategies")
    assert "\n" not in p["summary"]


def test_topic_sections():
    p = parse_gemini_note(SAMPLE_SUBJECT, SAMPLE_BODY)
    headings = [s["heading"] for s in p["sections"]]
    assert headings == [
        "Refining Business Strategy Focus",
        "Scaling Sales and Infrastructure",
    ]
    assert p["sections"][0]["text"].startswith("The group decided to shift")


def test_next_steps_with_owner_variants():
    p = parse_gemini_note(SAMPLE_SUBJECT, SAMPLE_BODY)
    steps = p["next_steps"]
    assert len(steps) == 3
    assert steps[0]["owners"] == ["Dustin"]
    assert steps[0]["title"] == "Follow up dev call"
    assert steps[0]["text"].startswith("Address the automated push")
    assert steps[1]["owners"] == ["Kevin", "Patrick", "Michael"]
    assert steps[2]["owners"] == ["The group"]


def test_footer_boilerplate_never_leaks():
    p = parse_gemini_note(SAMPLE_SUBJECT, SAMPLE_BODY)
    blob = repr(p)
    for noise in ("Google LLC", "Useful Email", "auto-generated",
                  "invited guests", "Meeting records"):
        assert noise not in blob


def test_straight_quotes_subject():
    p = parse_gemini_note('Notes: "Myco" Jun 8, 2026', SAMPLE_BODY)
    assert p["title"] == "Myco"
    assert p["meeting_date"] == "Jun 8, 2026"


def test_title_falls_back_to_body_then_subject():
    p = parse_gemini_note("Fwd: meeting stuff", SAMPLE_BODY)
    assert p["title"] == "Strategy Meeting"  # from "Notes from “…”" line
    p2 = parse_gemini_note("Fwd: meeting stuff", "no recognizable content")
    assert p2["title"] == "Fwd: meeting stuff"


def test_malformed_body_degrades_gracefully():
    p = parse_gemini_note("", "")
    assert p["title"] == "(untitled meeting)"
    assert p["summary"] == ""
    assert p["sections"] == []
    assert p["next_steps"] == []


def test_step_without_colon_keeps_text():
    body = "Suggested next steps\n\n[Ana] just do the thing\n"
    p = parse_gemini_note("Notes: “X”", body)
    assert p["next_steps"] == [
        {"owners": ["Ana"], "title": "", "text": "just do the thing"}
    ]


def test_compact_steps_without_blank_lines_all_parse():
    # No blank lines between items — one block must still yield every step.
    body = (
        "Suggested next steps\n"
        "[Alice] Task one: do something\n"
        "[Bob] Task two: do other thing\n"
        "[Carol, Dan] Task three: spans a\n"
        "wrapped continuation line.\n"
    )
    p = parse_gemini_note("Notes: “X”", body)
    steps = p["next_steps"]
    assert [s["owners"] for s in steps] == [["Alice"], ["Bob"], ["Carol", "Dan"]]
    assert steps[0]["text"] == "do something"
    assert "[Bob]" not in steps[0]["text"]
    assert steps[2]["text"] == "spans a wrapped continuation line."
