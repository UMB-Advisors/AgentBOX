"""Unit tests for the Phase 5 contact re-attribution inference rule (pure).

The rule (attribution.infer_reattribution_entity) decides whether a contact
page parked in 'unsorted' may move into an entity source based on the
attributions of the mailbox correspondence its email addresses appear in.
Conservative by design: ambiguity or weak signal always stays unsorted.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from attribution import (
    Attribution,
    REATTRIBUTE_MIN_CONFIDENCE,
    UNSORTED,
    infer_reattribution_entity,
)


class TestSingleEntity(unittest.TestCase):
    def test_one_entity_one_message(self):
        atts = [Attribution("heron", 1.0, 1)]
        self.assertEqual(infer_reattribution_entity(atts), "heron")

    def test_one_entity_many_messages(self):
        atts = [
            Attribution("umb", 1.0, 1),
            Attribution("umb", 0.9, 3),
            Attribution("umb", 0.95, 2),
        ]
        self.assertEqual(infer_reattribution_entity(atts), "umb")

    def test_unsorted_noise_does_not_block(self):
        """unsorted attributions carry no signal — they never make a contact
        ambiguous."""
        atts = [
            Attribution("yes", 0.9, 3),
            Attribution(UNSORTED, 0.0, 5),
            Attribution(UNSORTED, 0.0, 5),
        ]
        self.assertEqual(infer_reattribution_entity(atts), "yes")

    def test_weak_rung5_default_ignored_leaving_one_entity(self):
        """A rung-5 per-account default (personal, 0.3) reflects the account,
        not the contact — it must not block a clear domain/account signal."""
        atts = [
            Attribution("heron", 1.0, 1),
            Attribution("personal", 0.3, 5),
        ]
        self.assertEqual(infer_reattribution_entity(atts), "heron")


class TestAmbiguousStaysUnsorted(unittest.TestCase):
    def test_two_entities_is_ambiguous(self):
        atts = [
            Attribution("heron", 1.0, 1),
            Attribution("umb", 0.9, 3),
        ]
        self.assertIsNone(infer_reattribution_entity(atts))

    def test_many_entities_is_ambiguous(self):
        atts = [
            Attribution("heron", 1.0, 1),
            Attribution("umb", 1.0, 1),
            Attribution("yes", 0.9, 3),
        ]
        self.assertIsNone(infer_reattribution_entity(atts))


class TestNoSignalStaysUnsorted(unittest.TestCase):
    def test_empty_input(self):
        self.assertIsNone(infer_reattribution_entity([]))
        self.assertIsNone(infer_reattribution_entity(None))

    def test_only_unsorted(self):
        atts = [Attribution(UNSORTED, 0.0, 5), Attribution(UNSORTED, 0.0, 5)]
        self.assertIsNone(infer_reattribution_entity(atts))

    def test_only_weak_signals(self):
        """All-below-floor input (e.g. only rung-5 defaults) is no signal."""
        atts = [
            Attribution("personal", 0.3, 5),
            Attribution("personal", 0.3, 5),
        ]
        self.assertIsNone(infer_reattribution_entity(atts))


class TestConfidenceFloor(unittest.TestCase):
    def test_floor_excludes_rung5_includes_rung3(self):
        self.assertLess(0.3, REATTRIBUTE_MIN_CONFIDENCE)
        self.assertGreaterEqual(0.9, REATTRIBUTE_MIN_CONFIDENCE)

    def test_at_floor_counts(self):
        atts = [(("cde"), REATTRIBUTE_MIN_CONFIDENCE)]
        self.assertEqual(infer_reattribution_entity(atts), "cde")

    def test_just_below_floor_ignored(self):
        atts = [("cde", REATTRIBUTE_MIN_CONFIDENCE - 0.01)]
        self.assertIsNone(infer_reattribution_entity(atts))

    def test_custom_floor(self):
        atts = [("glue", 0.4)]
        self.assertIsNone(infer_reattribution_entity(atts))
        self.assertEqual(
            infer_reattribution_entity(atts, min_confidence=0.4), "glue"
        )


class TestTupleInput(unittest.TestCase):
    def test_accepts_entity_confidence_tuples(self):
        atts = [("myco", 1.0), (UNSORTED, 0.0), ("myco", 0.9)]
        self.assertEqual(infer_reattribution_entity(atts), "myco")

    def test_mixed_tuple_and_attribution(self):
        atts = [("future", 1.0), Attribution("future", 0.9, 3)]
        self.assertEqual(infer_reattribution_entity(atts), "future")


if __name__ == "__main__":
    unittest.main()
