"""Tests for Paid Ad Management (Job 1.4, Track A: report + recommend + draft).

Covers the deterministic core: CSV/TSV snapshot parsing + lenient numeric
coercion, derived KPIs, budget-pacing recommendations, the snapshot store,
report + creative-variant review artifacts, the lessons/index/digest, and the
human-verdict -> Job 1.4 trust wiring. Also asserts the safety invariant that NO
spend-mutation tools are registered.

HERMES_HOME is redirected to a tmp dir per test so nothing touches the real
~/.hermes runtime; GBRAIN_BIN points at a missing binary so gbrain capture is a
clean no-op.
"""

import json

import pytest

from tools import paid_ads as pa
from tools import sales_trust


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


SAMPLE_CSV = (
    "Campaign,Amount spent,Impressions,Link clicks,Purchases,Purchase value\n"
    "Winner Ad,$100.00,10000,200,10,$600.00\n"
    "Dud Ad,$50.00,8000,40,0,$0.00\n"
    "Meh Ad,$80,5000,100,2,90\n"
)


# ---------------------------------------------------------------------------
# Parsing + numeric coercion
# ---------------------------------------------------------------------------


class TestParse:
    def test_parse_csv_maps_aliases(self):
        rows = pa.parse_snapshot(SAMPLE_CSV)
        assert len(rows) == 3
        win = rows[0]
        assert win["label"] == "Winner Ad"
        assert win["spend"] == 100.0
        assert win["impressions"] == 10000.0
        assert win["clicks"] == 200.0
        assert win["conversions"] == 10.0
        assert win["revenue"] == 600.0

    def test_parse_tsv(self):
        tsv = "Campaign\tSpend\tClicks\nA\t10\t5\n"
        rows = pa.parse_snapshot(tsv)
        assert rows[0]["label"] == "A"
        assert rows[0]["spend"] == 10.0
        assert rows[0]["clicks"] == 5.0

    def test_parse_empty(self):
        assert pa.parse_snapshot("") == []
        assert pa.parse_snapshot("   ") == []

    def test_parse_skips_blank_label_rows(self):
        rows = pa.parse_snapshot("Campaign,Spend\nA,10\n,20\n")
        assert len(rows) == 1

    def test_parse_unknown_cols_go_to_extra(self):
        rows = pa.parse_snapshot("Campaign,Spend,Notes\nA,10,hello\n")
        assert rows[0]["extra"]["Notes"] == "hello"

    def test_to_float_lenient(self):
        assert pa._to_float("$1,234.50") == 1234.5
        assert pa._to_float("12%") == 12.0
        assert pa._to_float("") == 0.0
        assert pa._to_float("n/a") == 0.0
        assert pa._to_float(None) == 0.0
        assert pa._to_float(7) == 7.0


# ---------------------------------------------------------------------------
# Derived KPIs + summary
# ---------------------------------------------------------------------------


class TestKPIs:
    def test_derive(self):
        d = pa._derive({"spend": 100.0, "impressions": 10000.0,
                        "clicks": 200.0, "conversions": 10.0, "revenue": 600.0})
        assert d["ctr"] == 2.0           # 200/10000 * 100
        assert d["cpc"] == 0.5           # 100/200
        assert d["cpa"] == 10.0          # 100/10
        assert d["cvr"] == 5.0           # 10/200 * 100
        assert d["roas"] == 6.0          # 600/100

    def test_derive_zero_safe(self):
        d = pa._derive({"spend": 0.0, "impressions": 0.0,
                        "clicks": 0.0, "conversions": 0.0, "revenue": 0.0})
        assert d["ctr"] == 0.0 and d["cpc"] == 0.0 and d["roas"] == 0.0

    def test_summary_totals_and_blended(self):
        summary = pa.summarize(pa.parse_snapshot(SAMPLE_CSV))
        assert summary["line_count"] == 3
        assert summary["totals"]["spend"] == 230.0
        assert summary["totals"]["conversions"] == 12.0
        assert summary["totals"]["revenue"] == 690.0
        assert summary["blended"]["roas"] == 3.0  # 690/230


# ---------------------------------------------------------------------------
# Recommendations (advisory only)
# ---------------------------------------------------------------------------


class TestRecommend:
    def test_pause_zero_conversion_spender(self):
        summary = pa.summarize(pa.parse_snapshot(SAMPLE_CSV))
        recs = {r["label"]: r for r in pa.recommend(summary)}
        assert recs["Dud Ad"]["action"] == "pause"

    def test_scale_up_high_roas(self):
        summary = pa.summarize(pa.parse_snapshot(SAMPLE_CSV))
        # blended roas = 3.0; winner roas = 6.0 >= 1.2x -> scale_up
        recs = {r["label"]: r for r in pa.recommend(summary)}
        assert recs["Winner Ad"]["action"] == "scale_up"

    def test_target_roas_override(self):
        summary = pa.summarize(pa.parse_snapshot(SAMPLE_CSV))
        # With a very high target, the winner no longer beats 1.2x and shouldn't scale_up.
        recs = {r["label"]: r for r in pa.recommend(summary, target_roas=100.0)}
        assert recs["Winner Ad"]["action"] != "scale_up"


# ---------------------------------------------------------------------------
# record_performance store + report artifact
# ---------------------------------------------------------------------------


class TestRecordPerformance:
    def test_record_writes_store_and_report(self):
        rec = pa.record_performance("meta-w23", SAMPLE_CSV, platform="meta", period="w23")
        assert rec["status"] == "new"
        assert rec["snapshot_id"] == "meta-w23"
        # store file exists
        assert (pa.snapshots_dir() / "meta-w23.json").exists()
        # report artifact exists and is unsent (review folder)
        report = pa.review_dir() / "meta-w23-report.md"
        assert report.exists()
        text = report.read_text(encoding="utf-8")
        assert "Track A" in text and "No spend was changed" in text
        assert "Winner Ad" in text

    def test_invalid_platform_raises(self):
        with pytest.raises(ValueError):
            pa.record_performance("x", SAMPLE_CSV, platform="snapchat")

    def test_load_and_list(self):
        pa.record_performance("s1", SAMPLE_CSV, platform="meta")
        assert pa.load_snapshot("s1") is not None
        listed = pa.list_snapshots()
        assert any(s["snapshot_id"] == "s1" for s in listed)
        assert pa.list_snapshots(status="approved") == []


# ---------------------------------------------------------------------------
# Creative drafts
# ---------------------------------------------------------------------------


class TestDraftCreative:
    def test_draft_writes_variant_files(self):
        out = pa.draft_creative(
            "fathers-day",
            [{"headline": "Celebrate Dad", "primary_text": "YES! Celebrational Cacao.", "cta": "Shop"},
             {"hook": "For the dad who has everything"}],
            platform="meta", angle="gifting",
        )
        assert out["variants_written"] == 2
        files = list(pa.review_dir().glob("creative-fathers-day-v*.md"))
        assert len(files) == 2
        body = (pa.review_dir() / "creative-fathers-day-v1.md").read_text(encoding="utf-8")
        assert "not published" in body
        assert "YES!" in body

    def test_draft_indices_increment(self):
        pa.draft_creative("c", [{"headline": "a"}], platform="meta")
        pa.draft_creative("c", [{"headline": "b"}], platform="meta")
        names = sorted(p.name for p in pa.review_dir().glob("creative-c-v*.md"))
        assert names == ["creative-c-v1.md", "creative-c-v2.md"]

    def test_draft_empty_variants_raises(self):
        with pytest.raises(ValueError):
            pa.draft_creative("c", [], platform="meta")


# ---------------------------------------------------------------------------
# Outcome -> trust wiring (reporting-only graduation)
# ---------------------------------------------------------------------------


class TestOutcomeTrust:
    def test_clean_approval_advances_streak(self):
        pa.record_performance("s1", SAMPLE_CSV, platform="meta")
        report = (pa.review_dir() / "s1-report.md").read_text(encoding="utf-8")
        out = pa.record_outcome("s1", ai_report=report, human_report=report)
        assert out["clean"] is True
        assert out["status"] == "approved"
        state = sales_trust.get_state(pa.JOB_ID)
        assert state["consecutive_clean"] == 1
        # Reporting-only MEDIUM graduation: seeded to content threshold, no L2 auth gate.
        assert state["N"] == pa.TRUST_N
        assert state["l2_requires_auth"] is False

    def test_material_edit_resets_streak(self):
        pa.record_performance("s2", SAMPLE_CSV, platform="meta")
        rpt = (pa.review_dir() / "s2-report.md").read_text(encoding="utf-8")
        pa.record_outcome("s2", ai_report=rpt, human_report=rpt)  # clean -> 1
        out = pa.record_outcome(
            "s2", ai_report="totally different report",
            human_report="a completely rewritten human report with new pacing calls",
        )
        assert out["clean"] is False
        assert sales_trust.get_state(pa.JOB_ID)["consecutive_clean"] == 0

    def test_structural_change_is_material(self):
        pa.record_performance("s3", SAMPLE_CSV, platform="meta")
        rpt = (pa.review_dir() / "s3-report.md").read_text(encoding="utf-8")
        out = pa.record_outcome("s3", ai_report=rpt, human_report=rpt, structural_change=True)
        assert out["clean"] is False

    def test_rejected_resets_and_records(self):
        pa.record_performance("s4", SAMPLE_CSV, platform="meta")
        out = pa.record_outcome("s4", rejected=True)
        assert out["status"] == "rejected"
        assert out["clean"] is False
        assert pa.load_snapshot("s4")["status"] == "rejected"

    def test_lessons_write_digest(self):
        pa.record_performance("s5", SAMPLE_CSV, platform="meta")
        rpt = (pa.review_dir() / "s5-report.md").read_text(encoding="utf-8")
        out = pa.record_outcome(
            "s5", ai_report=rpt, human_report=rpt + " edit",
            lessons=[{"category": "pacing", "rule": "Pause anything with spend and zero conv after 3 days."}],
        )
        assert out["lessons_recorded"] == 1
        assert out["gbrain_ok"] == 0  # gbrain binary missing -> clean no-op
        assert pa.digest_path().exists()
        playbook = pa.get_playbook()
        assert "Paid-Ad Playbook" in playbook
        # index appended
        idx = pa.index_path().read_text(encoding="utf-8").strip().splitlines()
        assert len(idx) == 1
        assert json.loads(idx[0])["category"] == "pacing"

    def test_outcome_missing_snapshot_raises(self):
        with pytest.raises(ValueError):
            pa.record_outcome("nope", ai_report="a", human_report="a")


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


class TestHandlers:
    def test_record_performance_handler(self):
        res = json.loads(pa._handle_record_performance(
            {"snapshot_id": "h1", "raw_snapshot": SAMPLE_CSV, "platform": "meta"}))
        assert res["line_count"] == 3
        assert res["totals"]["spend"] == 230.0
        assert "report_path" in res
        assert res["trust_header"].startswith("Trust:")

    def test_record_performance_handler_validates(self):
        assert "error" in json.loads(pa._handle_record_performance({"raw_snapshot": SAMPLE_CSV}))
        assert "error" in json.loads(pa._handle_record_performance({"snapshot_id": "x", "raw_snapshot": ""}))
        assert "error" in json.loads(pa._handle_record_performance(
            {"snapshot_id": "x", "raw_snapshot": SAMPLE_CSV, "platform": "snap"}))

    def test_get_recommendations_handler(self):
        pa.record_performance("g1", SAMPLE_CSV, platform="meta")
        res = json.loads(pa._handle_get_recommendations({"snapshot_id": "g1"}))
        assert "recommendations" in res and len(res["recommendations"]) == 3
        # list mode
        listed = json.loads(pa._handle_get_recommendations({}))
        assert any(s["snapshot_id"] == "g1" for s in listed["snapshots"])

    def test_draft_creative_handler(self):
        res = json.loads(pa._handle_draft_creative(
            {"creative_id": "h2", "platform": "meta", "variants": [{"headline": "Hi"}]}))
        assert res["variants_written"] == 1

    def test_draft_creative_handler_validates(self):
        assert "error" in json.loads(pa._handle_draft_creative({"creative_id": "x", "variants": []}))
        assert "error" in json.loads(pa._handle_draft_creative({"variants": [{"headline": "a"}]}))

    def test_record_outcome_handler(self):
        pa.record_performance("h3", SAMPLE_CSV, platform="meta")
        rpt = (pa.review_dir() / "h3-report.md").read_text(encoding="utf-8")
        res = json.loads(pa._handle_record_outcome(
            {"snapshot_id": "h3", "ai_report": rpt, "human_report": rpt}))
        assert res["clean"] is True
        assert "error" in json.loads(pa._handle_record_outcome({"snapshot_id": "missing"}))


# ---------------------------------------------------------------------------
# Safety invariant: NO spend-mutation tools, reporting-only registration
# ---------------------------------------------------------------------------


class TestSafetyInvariant:
    def test_registered_tools(self):
        from tools.registry import registry
        names = set(registry.get_tool_names_for_toolset(pa.TOOLSET))
        assert names == {
            "record_ad_performance", "draft_ad_creative",
            "get_ad_recommendations", "record_ad_outcome",
        }

    def test_no_spend_mutation_tools(self):
        from tools.registry import registry
        names = registry.get_tool_names_for_toolset(pa.TOOLSET)
        banned = ("spend", "budget", "campaign", "launch", "publish", "pause_ad", "set_")
        for n in names:
            assert not any(b in n for b in banned), f"unexpected spend-touching tool: {n}"
