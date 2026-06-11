"""Pipeline-level durability tests for contact re-attribution (Phase 5).

The inference rule is pure and covered in test_reattribute.py. These tests
cover the gap the rule alone can't close: the daily regular ingest must NOT
resurrect a moved contact in 'unsorted', and --re-attribute must be
idempotent across runs. Both behaviors hinge on the durable move ledger
(STATE_DIR/contacts-reattributed.json) consulted by route_entity().

All gbrain/psql I/O is mocked; STATE_DIR is pointed at a temp dir.
"""

import argparse
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import common
import ingest_contacts
from attribution import UNSORTED

EMAP = {
    "entities": {"heron": {"name": "Heron Labs"}, "umb": {"name": "UMB"}},
    "companies": {"heron labs": "heron"},
    "accounts": {},
    "account_defaults": {},
    "domains": {},
    "generic_domains": [],
}

CONTACT_UNRESOLVED = {
    "id": 7, "name": "Jane Doe", "company": "Mystery Co",
    "emails": ["jane@example.com"],
}
CONTACT_RESOLVED = {
    "id": 8, "name": "Bob Heron", "company": "Heron Labs",
    "emails": ["bob@heronlabs.com"],
}


def reattr_args(dry_run=False):
    return argparse.Namespace(
        limit=None, dry_run=dry_run, entity_map=None, re_attribute=True
    )


class StateDirMixin(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(common, "STATE_DIR", Path(self._tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)


class TestRouteEntity(unittest.TestCase):
    def test_crm_company_resolves(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_RESOLVED, EMAP["companies"], EMAP["entities"], {}),
            "heron")

    def test_unresolved_no_ledger_is_unsorted(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_UNRESOLVED, EMAP["companies"], EMAP["entities"], {}),
            UNSORTED)

    def test_ledger_override_routes_to_moved_entity(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_UNRESOLVED, EMAP["companies"], EMAP["entities"],
                {"7": "umb"}),
            "umb")

    def test_crm_resolution_outranks_stale_ledger(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_RESOLVED, EMAP["companies"], EMAP["entities"],
                {"8": "umb"}),
            "heron")

    def test_ledger_entity_no_longer_valid_falls_back_unsorted(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_UNRESOLVED, EMAP["companies"], EMAP["entities"],
                {"7": "retired-entity"}),
            UNSORTED)

    def test_ledger_unsorted_value_ignored(self):
        self.assertEqual(
            ingest_contacts.route_entity(
                CONTACT_UNRESOLVED, EMAP["companies"], EMAP["entities"],
                {"7": UNSORTED}),
            UNSORTED)


class TestReattributeDurability(StateDirMixin):
    def run_reattr(self, capture, delete, dry_run=False):
        with mock.patch.object(ingest_contacts, "fetch_contacts",
                               return_value=[CONTACT_UNRESOLVED]), \
             mock.patch.object(ingest_contacts, "correspondence_attributions",
                               return_value=[("umb", 1.0)]), \
             mock.patch.object(common, "gbrain_capture", capture), \
             mock.patch.object(common, "gbrain_delete", delete):
            return ingest_contacts.run_reattribute(reattr_args(dry_run), EMAP)

    def test_move_recorded_then_skipped_on_rerun(self):
        capture, delete = mock.Mock(), mock.Mock()
        self.assertEqual(self.run_reattr(capture, delete), 0)
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(delete.call_count, 1)
        self.assertEqual(ingest_contacts.load_reattributed(), {"7": "umb"})
        # delete must tolerate an already-absent page on retried moves
        self.assertTrue(delete.call_args.kwargs.get("missing_ok"))

        # second run: ledger routes contact 7 to 'umb', so it's no longer a
        # candidate — no capture, no re-delete of the soft-deleted page
        self.run_reattr(capture, delete)
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(delete.call_count, 1)

    def test_failed_delete_not_recorded_and_retried(self):
        capture = mock.Mock()
        delete = mock.Mock(side_effect=RuntimeError("daemon down"))
        self.assertEqual(self.run_reattr(capture, delete), 1)
        self.assertEqual(ingest_contacts.load_reattributed(), {})

        # next run retries the same contact
        delete_ok = mock.Mock()
        self.run_reattr(capture, delete_ok)
        self.assertEqual(delete_ok.call_count, 1)
        self.assertEqual(ingest_contacts.load_reattributed(), {"7": "umb"})

    def test_dry_run_writes_nothing(self):
        capture, delete = mock.Mock(), mock.Mock()
        self.run_reattr(capture, delete, dry_run=True)
        capture.assert_not_called()
        delete.assert_not_called()
        self.assertEqual(ingest_contacts.load_reattributed(), {})


class TestDailyIngestHonorsLedger(StateDirMixin):
    """The 04:00 regular ingest must capture a moved contact into its NEW
    entity source — never resurrect it in 'unsorted'."""

    def run_main(self, contacts, capture):
        with mock.patch.object(ingest_contacts, "fetch_contacts",
                               return_value=contacts), \
             mock.patch.object(common, "load_entity_map", return_value=EMAP), \
             mock.patch.object(common, "gbrain_capture", capture), \
             mock.patch.object(sys, "argv", ["ingest_contacts.py"]):
            return ingest_contacts.main()

    def test_moved_contact_recaptured_into_entity_not_unsorted(self):
        common.write_state_json(
            ingest_contacts.REATTRIBUTED_STATE, {"7": "umb"})
        capture = mock.Mock()
        self.assertEqual(
            self.run_main([CONTACT_UNRESOLVED, CONTACT_RESOLVED], capture), 0)
        targets = [call.args[0] for call in capture.call_args_list]
        self.assertEqual(sorted(targets), ["heron", "umb"])
        self.assertNotIn(UNSORTED, targets)

    def test_without_ledger_unresolved_still_goes_to_unsorted(self):
        capture = mock.Mock()
        self.run_main([CONTACT_UNRESOLVED], capture)
        self.assertEqual(capture.call_args.args[0], UNSORTED)


class TestDeleteMissingOk(unittest.TestCase):
    def fake_run(self, stderr):
        return mock.Mock(returncode=1, stdout="", stderr=stderr)

    def test_missing_ok_swallows_not_found(self):
        with mock.patch.object(subprocess, "run",
                               return_value=self.fake_run("error: page not found")):
            common.gbrain_delete("unsorted", "contacts/7-jane", missing_ok=True)

    def test_default_still_raises_on_not_found(self):
        with mock.patch.object(subprocess, "run",
                               return_value=self.fake_run("error: page not found")):
            with self.assertRaises(RuntimeError):
                common.gbrain_delete("unsorted", "contacts/7-jane")

    def test_missing_ok_does_not_mask_real_failures(self):
        with mock.patch.object(subprocess, "run",
                               return_value=self.fake_run("connection refused")):
            with self.assertRaises(RuntimeError):
                common.gbrain_delete("unsorted", "contacts/7-jane", missing_ok=True)


if __name__ == "__main__":
    unittest.main()
