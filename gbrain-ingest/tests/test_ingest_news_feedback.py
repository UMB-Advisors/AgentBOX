"""Unit tests for the news-feedback ingest pipeline (pure, no I/O)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest_news_feedback import (
    build_event_page,
    build_profile_page,
    load_ledger,
    process_events,
    title_tokens,
)


def ev(**over):
    event = {
        "id": 3,
        "ts": "2026-06-11T10:00:00+0000",
        "link": "https://example.com/story",
        "vote": "down",
        "reason": "not_interested",
        "title": "Quantum Widgets Disrupt Gadget Market",
        "source_id": "verge",
        "source": "The Verge",
        "published": "2026-06-11T09:00:00Z",
    }
    event.update(over)
    return event


class BuildEventPage(unittest.TestCase):
    def test_down_vote_page_carries_reason_and_lesson(self):
        slug, content = build_event_page(ev())
        self.assertEqual(slug, "news-feedback/3")
        self.assertIn("type: news-feedback", content)
        self.assertIn("vote: down", content)
        self.assertIn("not interested in this topic", content)
        self.assertIn("Show fewer stories like this", content)
        self.assertIn("Quantum Widgets", content)

    def test_source_reason_targets_the_source(self):
        _, content = build_event_page(ev(reason="source"))
        self.assertIn("Show fewer stories from The Verge.", content)

    def test_up_vote_lesson(self):
        _, content = build_event_page(ev(vote="up", reason=None))
        self.assertIn("vote: up", content)
        self.assertIn("Surface more stories like this", content)

    def test_missing_id_refuses(self):
        with self.assertRaises(RuntimeError):
            build_event_page(ev(id=None))

    def test_cleared_vote_refuses(self):
        with self.assertRaises(RuntimeError):
            build_event_page(ev(vote="none"))

    def test_title_is_redacted(self):
        _, content = build_event_page(
            ev(title="Leak: api_key: sk-abcdefghijklmnopqrstuv123")
        )
        self.assertNotIn("sk-abcdefghijklmnopqrstuv123", content)


class BuildProfilePage(unittest.TestCase):
    def test_aggregates_sources_and_topics(self):
        votes = {
            "https://a/1": {"vote": "up", "source_id": "hn",
                            "source": "Hacker News",
                            "title": "Fermentation startups raise capital"},
            "https://a/2": {"vote": "up", "source_id": "hn",
                            "source": "Hacker News",
                            "title": "Fermentation breakthrough announced"},
            "https://b/1": {"vote": "down", "reason": "source",
                            "source_id": "espn", "source": "ESPN",
                            "title": "Playoffs recap tonight"},
        }
        content = build_profile_page(votes)
        self.assertIn("Hacker News (+2)", content)
        self.assertIn("ESPN (-3)", content)
        self.assertIn("fermentation", content)
        # reason=source says nothing about the topic
        self.assertNotIn("playoffs", content)

    def test_mute_after_three_source_strikes(self):
        votes = {
            f"https://b/{i}": {"vote": "down", "reason": "source",
                               "source_id": "espn", "source": "ESPN",
                               "title": f"Game {i}"}
            for i in range(3)
        }
        content = build_profile_page(votes)
        self.assertIn("Muted entirely", content)
        self.assertIn("ESPN", content)

    def test_empty_votes_still_renders(self):
        content = build_profile_page({})
        self.assertIn("No source-level signal yet", content)
        self.assertIn("(none yet)", content)


class ProcessEvents(unittest.TestCase):
    def test_watermark_holds_at_first_failure(self):
        captured = []

        def capture(source, slug, content, page_type="note"):
            if slug.endswith("/5"):
                raise RuntimeError("daemon down")
            captured.append(slug)

        events = [ev(id=4), ev(id=5), ev(id=6)]
        written, errors, last_good = process_events(events, capture=capture)
        self.assertEqual((written, errors), (2, 1))
        self.assertEqual(last_good, 4)
        # success after failure still captured (harmless upsert)
        self.assertIn("news-feedback/6", captured)

    def test_cleared_votes_write_no_page_but_advance(self):
        captured = []
        events = [ev(id=7, vote="none", reason=None), ev(id=8)]
        written, errors, last_good = process_events(
            events, capture=lambda *a, **k: captured.append(a[1]))
        self.assertEqual((written, errors), (1, 0))
        self.assertEqual(last_good, 8)
        self.assertEqual(captured, ["news-feedback/8"])

    def test_dry_run_writes_nothing(self):
        def capture(*a, **k):
            raise AssertionError("capture called in dry run")

        written, errors, last_good = process_events(
            [ev(id=9)], dry_run=True, capture=capture)
        self.assertEqual((written, errors, last_good), (0, 0, 9))


class LoadLedger(unittest.TestCase):
    def test_missing_and_corrupt_degrade_to_empty(self):
        with tempfile.TemporaryDirectory() as td:
            missing = Path(td) / "absent.json"
            self.assertEqual(load_ledger(missing),
                             {"events": [], "votes": {}})
            corrupt = Path(td) / "bad.json"
            corrupt.write_text("{nope", encoding="utf-8")
            self.assertEqual(load_ledger(corrupt),
                             {"events": [], "votes": {}})

    def test_reads_events_and_votes(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ledger.json"
            p.write_text(json.dumps({
                "next_id": 2,
                "events": [ev(id=1), "junk"],
                "votes": {"https://a/1": {"vote": "up"}, "bad": 3},
            }), encoding="utf-8")
            ledger = load_ledger(p)
            self.assertEqual(len(ledger["events"]), 1)
            self.assertEqual(list(ledger["votes"]), ["https://a/1"])


class TitleTokens(unittest.TestCase):
    def test_stopwords_and_short_words_dropped(self):
        tokens = title_tokens("This is the BEST mushroom extraction story")
        self.assertIn("mushroom", tokens)
        self.assertIn("extraction", tokens)
        self.assertNotIn("this", tokens)
        self.assertNotIn("best", tokens)
        self.assertNotIn("is", tokens)


if __name__ == "__main__":
    unittest.main()
