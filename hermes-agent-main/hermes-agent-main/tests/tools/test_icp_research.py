"""Tests for Market & ICP Research (Sales Persona Job 1.1).

Covers the ICP/competitor/calendar stores, the critical cross-wire to the
enrichment rubric + content digest, the judgment-heavy human-verdict outcome loop
(clean / structural / rejected) including the Job 1.1 trust counter, the
best-effort Shopify catalog peek, and the tool handlers. HERMES_HOME is
redirected per test; gbrain points at a missing binary.
"""

import json

import pytest

from tools import icp_research as icp
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


# --------------------------------------------------------------------------- #
# ICP segments
# --------------------------------------------------------------------------- #


class TestICPSegments:
    def test_record_and_load(self):
        rec = icp.record_icp_segment(
            "dtc_consumer",
            title="Premium gift-giver",
            description="Buys artisan chocolate for celebrations.",
            fit_signals=["gifts seasonally"],
            disqualifiers=["price sensitive"],
            channels=["instagram"],
            pain_points=["generic gifts feel impersonal"],
        )
        assert rec["segment"] == "dtc_consumer"
        loaded = icp.load_icp_segment("dtc_consumer")
        assert loaded["title"] == "Premium gift-giver"
        assert loaded["fit_signals"] == ["gifts seasonally"]

    def test_default_title(self):
        rec = icp.record_icp_segment("wholesale_buyer")
        assert rec["title"] == "Wholesale Buyer"

    def test_bad_segment(self):
        with pytest.raises(ValueError):
            icp.record_icp_segment("linkedin_lead")

    def test_list_segments(self):
        icp.record_icp_segment("dtc_consumer")
        icp.record_icp_segment("corporate_gifting")
        segs = {s["segment"] for s in icp.list_icp_segments()}
        assert segs == {"dtc_consumer", "corporate_gifting"}

    def test_load_missing_returns_none(self):
        assert icp.load_icp_segment("dtc_consumer") is None


# --------------------------------------------------------------------------- #
# Critical cross-wire
# --------------------------------------------------------------------------- #


class TestCrossWire:
    def test_recording_segment_writes_both_files(self, tmp_hermes):
        icp.record_icp_segment(
            "wholesale_buyer",
            description="Specialty grocery buyers.",
            fit_signals=["stocks premium CPG"],
            disqualifiers=["mass-market only"],
        )
        rubric = icp.enrichment_rubric_path()
        digest = icp.content_digest_path()
        assert rubric.exists() and digest.exists()
        # Paths land where Jobs 2.1 / 1.3 read them.
        assert rubric == tmp_hermes / "enrichment" / "icp_rubric.md"
        assert digest == tmp_hermes / "content_engine" / "icp_digest.md"
        rtext = rubric.read_text()
        assert "stocks premium CPG" in rtext
        assert "mass-market only" in rtext

    def test_content_digest_includes_competitors_and_brand_rules(self):
        icp.record_icp_segment("dtc_consumer", description="Gift-givers.")
        icp.record_competitor("Rival Cacao", positioning="mass premium", price_tier="premium")
        dtext = icp.content_digest_path().read_text()
        assert "Rival Cacao" in dtext
        assert "YES!" in dtext
        assert "Celebrational Cacao" in dtext

    def test_export_is_idempotent_refresh(self):
        icp.record_icp_segment("corporate_gifting", description="Q4 corporate gifts.")
        out = icp.export_icp_rubric()
        assert out["icp_rubric"].endswith("icp_rubric.md")
        assert out["content_digest"].endswith("icp_digest.md")


# --------------------------------------------------------------------------- #
# Competitors
# --------------------------------------------------------------------------- #


class TestCompetitors:
    def test_record_and_list(self):
        icp.record_competitor(
            "Craft Bar Co",
            positioning="bean-to-bar premium",
            price_tier="luxury",
            gaps=["no gifting line"],
        )
        rows = icp.list_competitors()
        assert len(rows) == 1
        assert rows[0]["competitor_id"] == "craft-bar-co"
        assert rows[0]["gaps"] == ["no gifting line"]

    def test_bad_price_tier(self):
        with pytest.raises(ValueError):
            icp.record_competitor("X", price_tier="cheapest")

    def test_custom_id(self):
        rec = icp.record_competitor("Some Brand!", competitor_id="sb")
        assert rec["competitor_id"] == "sb"


# --------------------------------------------------------------------------- #
# Demand calendar
# --------------------------------------------------------------------------- #


class TestDemandCalendar:
    def test_set_and_get(self):
        icp.set_demand_calendar(
            [{"month": "February", "occasion": "Valentine's Day", "intensity": 5}],
            notes="gifting peak",
        )
        cal = icp.get_demand_calendar()
        assert cal["notes"] == "gifting peak"
        assert cal["peaks"][0]["occasion"] == "Valentine's Day"

    def test_get_empty_default(self):
        assert icp.get_demand_calendar() == {"peaks": [], "notes": "", "updated_at": None}

    def test_set_rejects_non_list(self):
        with pytest.raises(ValueError):
            icp.set_demand_calendar({"not": "a list"})

    def test_set_filters_non_dict_entries(self):
        rec = icp.set_demand_calendar(["junk", {"occasion": "Holiday"}])
        assert len(rec["peaks"]) == 1
        assert rec["peaks"][0]["occasion"] == "Holiday"


# --------------------------------------------------------------------------- #
# Outcome -> Job 1.1 trust counter
# --------------------------------------------------------------------------- #


class TestOutcomeAndTrust:
    def test_clean_advances_streak(self):
        res = icp.record_research_outcome(approved=True, structural_change=False)
        assert res["clean"] is True
        s = st.get_state("1.1")
        assert s["consecutive_clean"] == 1
        assert s["category"] == "judgment"  # judgment-heavy default

    def test_structural_change_is_material(self):
        icp.record_research_outcome(approved=True)  # streak = 1
        res = icp.record_research_outcome(approved=True, structural_change=True)
        assert res["clean"] is False
        assert st.get_state("1.1")["consecutive_clean"] == 0

    def test_rejection_resets(self):
        icp.record_research_outcome(approved=True)
        res = icp.record_research_outcome(approved=False)
        assert res["clean"] is False
        assert st.get_state("1.1")["consecutive_clean"] == 0

    def test_lessons_written_and_indexed(self):
        res = icp.record_research_outcome(
            approved=True,
            structural_change=True,
            lessons=[{"category": "segmentation", "rule": "Split corporate gifting by order size."}],
        )
        assert res["lessons_recorded"] == 1
        # gbrain points at a missing binary -> best-effort, not ok, never raises.
        assert res["gbrain_ok"] == 0
        assert icp.index_path().exists()
        assert icp.digest_path().exists()
        assert "Split corporate gifting" in icp.digest_path().read_text()

    def test_trust_header_present(self):
        res = icp.record_research_outcome(approved=True)
        assert res["trust_header"].startswith("Trust:")


# --------------------------------------------------------------------------- #
# Shopify catalog peek (best-effort)
# --------------------------------------------------------------------------- #


class TestCatalogPeek:
    def test_peek_degrades_without_creds(self, monkeypatch):
        # No Shopify creds configured -> _req raises -> peek returns ok=False.
        monkeypatch.delenv("SHOPIFY_SHOP", raising=False)
        monkeypatch.delenv("SHOPIFY_ACCESS_TOKEN", raising=False)
        out = icp.peek_catalog()
        assert out["ok"] is False
        assert out["products"] == []

    def test_peek_slims_products(self, monkeypatch):
        def fake_req(method, path, payload=None):
            assert method == "GET"
            return {"products": [{"id": 1, "title": "Bar", "product_type": "choc", "tags": "x", "extra": "drop"}]}

        from tools import shopify_tools
        monkeypatch.setattr(shopify_tools, "_req", fake_req)
        out = icp.peek_catalog()
        assert out["ok"] is True and out["count"] == 1
        assert out["products"][0] == {"id": 1, "title": "Bar", "product_type": "choc", "tags": "x"}


# --------------------------------------------------------------------------- #
# Tool handlers
# --------------------------------------------------------------------------- #


class TestHandlers:
    def test_record_icp_segment_handler(self):
        out = json.loads(icp._handle_record_icp_segment({
            "segment": "dtc_consumer", "description": "Gift-givers.",
        }))
        assert out["segment"]["segment"] == "dtc_consumer"
        assert out["cross_wired"]["icp_rubric"].endswith("icp_rubric.md")
        assert out["trust_header"].startswith("Trust:")

    def test_record_icp_segment_handler_bad_segment(self):
        out = json.loads(icp._handle_record_icp_segment({"segment": "nope"}))
        assert "error" in out

    def test_get_icp_handler_one_and_all(self):
        icp.record_icp_segment("dtc_consumer")
        icp.record_icp_segment("wholesale_buyer")
        one = json.loads(icp._handle_get_icp({"segment": "dtc_consumer"}))
        assert one["segment"]["segment"] == "dtc_consumer"
        allrows = json.loads(icp._handle_get_icp({}))
        assert allrows["count"] == 2

    def test_get_icp_handler_missing(self):
        out = json.loads(icp._handle_get_icp({"segment": "dtc_consumer"}))
        assert "error" in out

    def test_record_competitor_handler(self):
        out = json.loads(icp._handle_record_competitor({
            "name": "Rival", "price_tier": "premium",
        }))
        assert out["competitor"]["name"] == "Rival"

    def test_record_competitor_handler_missing_name(self):
        out = json.loads(icp._handle_record_competitor({}))
        assert "error" in out

    def test_set_and_get_demand_calendar_handlers(self):
        out = json.loads(icp._handle_set_demand_calendar({
            "peaks": [{"occasion": "Holiday", "month": "Nov-Dec"}],
        }))
        assert out["calendar"]["peaks"][0]["occasion"] == "Holiday"
        got = json.loads(icp._handle_get_demand_calendar({}))
        assert got["calendar"]["peaks"][0]["occasion"] == "Holiday"

    def test_set_demand_calendar_handler_missing_peaks(self):
        out = json.loads(icp._handle_set_demand_calendar({}))
        assert "error" in out

    def test_record_research_outcome_handler(self):
        out = json.loads(icp._handle_record_research_outcome({
            "approved": True, "structural_change": False,
        }))
        assert out["clean"] is True
        assert out["trust_header"].startswith("Trust:")
