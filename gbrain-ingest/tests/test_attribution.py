"""Unit tests for the 5-rung entity attribution ladder (pure, no I/O)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from attribution import (
    Attribution,
    attribute,
    email_domain,
    extract_emails,
    normalize_company,
    resolve_company,
)

ENTITIES = ["heron", "state", "cde", "krunchy", "yes", "future",
            "umb", "glue", "myco", "personal", "unsorted"]

MAPS = {
    "account_map": {
        "dustin@heronlabsinc.com": "heron",
        "dustin@umbadvisors.com": "umb",
    },
    "account_defaults": {"consultingfutures@gmail.com": "personal"},
    "domain_map": {
        "yescacao.com": "yes",
        "heronlabsinc.com": "heron",
        "mycofest.com": "myco",
    },
    "company_map": {
        "yes! cacao": "yes",
        "heron labs": "heron",
        "future compounds": "future",
        "krunchy kids": "krunchy",
    },
    "generic_domains": ["gmail.com", "yahoo.com"],
    "valid_entities": ENTITIES,
}


def run(account, sender=None, participants=(), subject=None, snippet=None, **kw):
    return attribute(account, sender, list(participants), subject, snippet,
                     **{**MAPS, **kw})


class TestRung1Account(unittest.TestCase):
    def test_heronlabsinc_account_wins(self):
        a = run("dustin@heronlabsinc.com", "stranger@randomco.com")
        self.assertEqual((a.entity, a.rung, a.confidence), ("heron", 1, 1.0))

    def test_umbadvisors_account_wins_over_domain(self):
        # account provenance beats a domain hit on the sender
        a = run("dustin@umbadvisors.com", "buyer@yescacao.com")
        self.assertEqual((a.entity, a.rung), ("umb", 1))

    def test_account_match_case_insensitive(self):
        a = run("Dustin@HeronLabsInc.com")
        self.assertEqual((a.entity, a.rung), ("heron", 1))


class TestRung2Crm(unittest.TestCase):
    def test_crm_company_match(self):
        crm = {"jane@somewhere.org": "YES! Cacao"}.get
        a = run("consultingfutures@gmail.com", "jane@somewhere.org",
                crm_lookup=crm)
        self.assertEqual((a.entity, a.rung), ("yes", 2))

    def test_crm_precedence_over_classifier(self):
        crm = {"jane@somewhere.org": "Heron Labs"}.get

        def classifier(subject, snippet):
            raise AssertionError("classifier must not run when CRM resolves")

        a = run("consultingfutures@gmail.com", "jane@somewhere.org",
                crm_lookup=crm, llm_classify_fn=classifier)
        self.assertEqual((a.entity, a.rung), ("heron", 2))

    def test_crm_company_with_suffix_normalizes(self):
        crm = {"x@y.org": "Krunchy Kids, LLC"}.get
        a = run("consultingfutures@gmail.com", "x@y.org", crm_lookup=crm)
        self.assertEqual((a.entity, a.rung), ("krunchy", 2))

    def test_crm_unknown_company_falls_through(self):
        crm = {"x@y.org": "Totally Unrelated Corp"}.get
        a = run("consultingfutures@gmail.com", "x@y.org", crm_lookup=crm)
        self.assertEqual(a.rung, 5)
        self.assertEqual(a.entity, "personal")

    def test_crm_checked_on_participants_not_just_sender(self):
        crm = {"cc@partner.io": "Future Compounds"}.get
        a = run("consultingfutures@gmail.com", "noone@gmail.com",
                participants=["cc@partner.io"], crm_lookup=crm)
        self.assertEqual((a.entity, a.rung), ("future", 2))


class TestRung3Domain(unittest.TestCase):
    def test_sender_domain(self):
        a = run("consultingfutures@gmail.com", "orders@yescacao.com")
        self.assertEqual((a.entity, a.rung, a.confidence), ("yes", 3, 0.9))

    def test_generic_domain_skipped(self):
        a = run("consultingfutures@gmail.com", "someone@yahoo.com")
        self.assertEqual(a.rung, 5)

    def test_participant_domain(self):
        a = run("consultingfutures@gmail.com", "someone@gmail.com",
                participants=["vendor@mycofest.com"])
        self.assertEqual((a.entity, a.rung), ("myco", 3))

    def test_own_account_excluded_from_participants(self):
        # the account's own address must not self-attribute via domain
        a = run("consultingfutures@gmail.com", None,
                participants=["consultingfutures@gmail.com"])
        self.assertEqual(a.rung, 5)


class TestRung4Classifier(unittest.TestCase):
    def test_confident_classifier_accepted(self):
        a = run("consultingfutures@gmail.com", "x@gmail.com",
                subject="CBD earn-out structure",
                llm_classify_fn=lambda s, sn: ("future", 0.85))
        self.assertEqual((a.entity, a.rung, a.confidence), ("future", 4, 0.85))

    def test_below_threshold_rejected(self):
        a = run("consultingfutures@gmail.com", "x@gmail.com",
                llm_classify_fn=lambda s, sn: ("future", 0.4))
        self.assertEqual((a.entity, a.rung), ("personal", 5))

    def test_invalid_slug_rejected(self):
        a = run("consultingfutures@gmail.com", "x@gmail.com",
                llm_classify_fn=lambda s, sn: ("not-an-entity", 0.99))
        self.assertEqual((a.entity, a.rung), ("personal", 5))

    def test_classifier_unsorted_answer_falls_to_default(self):
        a = run("consultingfutures@gmail.com", "x@gmail.com",
                llm_classify_fn=lambda s, sn: ("unsorted", 0.9))
        self.assertEqual((a.entity, a.rung), ("personal", 5))

    def test_classifier_failure_none_falls_through(self):
        a = run("consultingfutures@gmail.com", "x@gmail.com",
                llm_classify_fn=lambda s, sn: None)
        self.assertEqual((a.entity, a.rung), ("personal", 5))


class TestRung5Default(unittest.TestCase):
    def test_consultingfutures_defaults_to_personal(self):
        a = run("consultingfutures@gmail.com", "mystery@nowhere.zz")
        self.assertEqual((a.entity, a.rung), ("personal", 5))

    def test_unknown_account_falls_to_unsorted(self):
        a = run("primary@appliance.local", "mystery@nowhere.zz")
        self.assertEqual((a.entity, a.rung), ("unsorted", 5))
        self.assertEqual(a.confidence, 0.0)

    def test_no_account_at_all(self):
        a = run(None)
        self.assertEqual((a.entity, a.rung), ("unsorted", 5))


class TestHelpers(unittest.TestCase):
    def test_extract_emails(self):
        self.assertEqual(
            extract_emails('"Jane D" <jane@x.com>, bob@y.org'),
            ["jane@x.com", "bob@y.org"],
        )
        self.assertEqual(extract_emails(None), [])

    def test_email_domain(self):
        self.assertEqual(email_domain("A@YesCacao.COM"), "yescacao.com")
        self.assertIsNone(email_domain("not-an-email"))

    def test_normalize_company(self):
        self.assertEqual(normalize_company("YES! Cacao"), "yes! cacao")
        self.assertEqual(normalize_company("Heron Labs, Inc."), "heron labs")
        self.assertEqual(normalize_company(None), "")

    def test_resolve_company_exact_then_normalized(self):
        cmap = {"heron labs": "heron"}
        self.assertEqual(resolve_company("Heron Labs Inc", cmap), "heron")
        self.assertIsNone(resolve_company("Acme", cmap))

    def test_rung_name(self):
        self.assertEqual(Attribution("yes", 0.9, 3).rung_name, "domain")


class TestEntityMapYaml(unittest.TestCase):
    """Validates the shipped entity_map.yaml (skipped if PyYAML missing)."""

    def setUp(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed in test env")

    def test_yaml_is_consistent(self):
        import yaml
        path = Path(__file__).resolve().parents[1] / "entity_map.yaml"
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        slugs = set(data["entities"].keys())
        self.assertEqual(slugs, set(ENTITIES))
        for mapping in ("accounts", "account_defaults", "companies", "domains"):
            for key, target in data[mapping].items():
                # YAML 1.1 booleans: a bare `yes` key/value would parse as True
                self.assertIsInstance(key, str, f"{mapping} key {key!r}")
                self.assertIn(target, slugs, f"{mapping} target {target!r}")
        self.assertEqual(data["accounts"]["dustin@heronlabsinc.com"], "heron")
        self.assertEqual(data["account_defaults"]["consultingfutures@gmail.com"],
                         "personal")
        self.assertIn("{subject}", data["classifier"]["prompt"])
        self.assertIn("{entities}", data["classifier"]["prompt"])


if __name__ == "__main__":
    unittest.main()
