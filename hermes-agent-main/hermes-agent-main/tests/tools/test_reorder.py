"""Tests for Reorder & Expansion Triggers (Sales Persona Job 3.3).

Covers stub order-history ingestion (CSV + JSON shapes), the cadence model and
overdue detection, drafted (UNSENT) reorder prompts, the human-verdict outcome
loop (clean / edited / rejected) feeding the Job 3.3 trust counter + gbrain
lessons, and the tool handlers. HERMES_HOME is redirected per test; gbrain points
at a missing binary so ingest stays best-effort.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from tools import reorder as ro
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


def _orders(*days_ago):
    """Build order dicts dated N days before now (most-recent listed last)."""
    now = datetime.now(timezone.utc)
    return [{"date": (now - timedelta(days=d)).date().isoformat(), "amount": 100} for d in days_ago]


# --------------------------------------------------------------------------
# Ingestion
# --------------------------------------------------------------------------


class TestIngest:
    def test_ingest_csv(self):
        d = ro.orders_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "h.csv").write_text(
            "account,date,amount\nAcme Co,2026-01-01,200\nAcme Co,2026-02-01,250\n",
            encoding="utf-8",
        )
        res = ro.ingest_order_history()
        assert res["count"] == 1
        acct = ro.load_account("acme-co")
        assert acct["name"] == "Acme Co"
        assert len(acct["orders"]) == 2
        assert acct["orders"][0]["date"] == "2026-01-01"

    def test_ingest_json_list(self):
        d = ro.orders_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "o.json").write_text(json.dumps([
            {"account": "Beta Shop", "date": "2026-01-10", "amount": 50},
            {"account": "Beta Shop", "date": "2026-03-10", "amount": 60},
        ]), encoding="utf-8")
        res = ro.ingest_order_history()
        assert "beta-shop" in res["accounts_ingested"]
        assert len(ro.load_account("beta-shop")["orders"]) == 2

    def test_ingest_json_per_account_object(self):
        d = ro.orders_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "gamma.json").write_text(json.dumps({
            "name": "Gamma Grocer",
            "orders": [{"date": "2026-01-01"}, {"date": "2026-02-01"}],
        }), encoding="utf-8")
        ro.ingest_order_history()
        assert ro.load_account("gamma-grocer") is not None

    def test_ingest_combined_accounts_object(self):
        d = ro.orders_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "all.json").write_text(json.dumps({"accounts": [
            {"name": "One", "orders": [{"date": "2026-01-01"}]},
            {"name": "Two", "orders": [{"date": "2026-01-02"}]},
        ]}), encoding="utf-8")
        res = ro.ingest_order_history()
        assert res["count"] == 2

    def test_ingest_dedupes_and_merges(self):
        ro.save_account_history("dup", "Dup Co", _orders(60))
        ro.save_account_history("dup", "Dup Co", _orders(60, 30))  # 60 repeats
        assert len(ro.load_account("dup")["orders"]) == 2

    def test_ingest_no_files(self):
        res = ro.ingest_order_history()
        assert res["count"] == 0 and res["files_read"] == 0


# --------------------------------------------------------------------------
# Cadence model
# --------------------------------------------------------------------------


class TestCadence:
    def test_overdue_flagged(self):
        # Orders every ~30 days, last one 90 days ago -> overdue.
        cad = ro.cadence(_orders(150, 120, 90))
        assert cad["enough_history"] is True
        assert cad["avg_interval_days"] == 30.0
        assert cad["overdue"] is True
        assert cad["days_overdue"] > 0

    def test_on_time_not_overdue(self):
        # Last order 10 days ago, cadence ~30 days -> not overdue.
        cad = ro.cadence(_orders(70, 40, 10))
        assert cad["overdue"] is False
        assert cad["days_overdue"] == 0

    def test_insufficient_history(self):
        assert ro.cadence(_orders(10))["enough_history"] is False
        assert ro.cadence([])["enough_history"] is False

    def test_as_of_override(self):
        orders = [{"date": "2026-01-01"}, {"date": "2026-02-01"}]
        cad = ro.cadence(orders, as_of=datetime(2026, 5, 1, tzinfo=timezone.utc))
        assert cad["overdue"] is True


class TestDetect:
    def test_detect_returns_overdue_sorted(self):
        ro.save_account_history("a", "A", _orders(150, 120, 90))   # ~30d cadence, overdue
        ro.save_account_history("b", "B", _orders(70, 40, 10))     # on time
        ro.save_account_history("c", "C", _orders(200, 180, 160))  # ~20d cadence, very overdue
        due = ro.detect_reorders()
        ids = [d["account_id"] for d in due]
        assert "b" not in ids
        assert set(ids) == {"a", "c"}
        # most overdue first
        assert due[0]["days_overdue"] >= due[-1]["days_overdue"]
        # state persisted on the account record
        assert ro.load_account("a")["reorder_due"] is True
        assert ro.load_account("b")["reorder_due"] is False


# --------------------------------------------------------------------------
# Drafted prompts (UNSENT)
# --------------------------------------------------------------------------


class TestDraft:
    def test_draft_writes_review_artifact(self):
        ro.save_account_history("a", "Acme", _orders(150, 120, 90))
        ro.detect_reorders()
        out = ro.draft_reorder_prompt(
            "a", expansion_signals=["seasonal gift tins"],
            draft_message="Time to restock YES! Celebrational Cacao?",
        )
        assert out["status"] == "drafted"
        assert out["trust_header"].startswith("Trust:")
        md = (ro.prompts_dir() / "a.md").read_text(encoding="utf-8")
        assert "Celebrational Cacao" in md
        assert "UNSENT" in md
        assert "seasonal gift tins" in md

    def test_draft_unknown_account_raises(self):
        with pytest.raises(ValueError):
            ro.draft_reorder_prompt("ghost")

    def test_list_prompts_sorted_by_overdue(self):
        ro.save_account_history("a", "A", _orders(150, 120, 90))
        ro.save_account_history("c", "C", _orders(400, 200, 120))
        ro.detect_reorders()
        ro.draft_reorder_prompt("a")
        ro.draft_reorder_prompt("c")
        rows = ro.list_reorder_prompts()
        assert len(rows) == 2
        assert rows[0]["cadence"]["days_overdue"] >= rows[-1]["cadence"]["days_overdue"]


# --------------------------------------------------------------------------
# Outcome -> trust wiring
# --------------------------------------------------------------------------


class TestOutcome:
    def _setup_prompt(self, msg="Restock YES! Celebrational Cacao today."):
        ro.save_account_history("a", "Acme", _orders(150, 120, 90))
        ro.detect_reorders()
        ro.draft_reorder_prompt("a", draft_message=msg)

    def test_clean_advances_trust(self):
        self._setup_prompt()
        out = ro.record_reorder_outcome(
            "a", human_final="Restock YES! Celebrational Cacao today.")
        assert out["clean"] is True and out["status"] == "approved"
        assert st.get_state("3.3")["consecutive_clean"] == 1

    def test_edited_resets_and_writes_lesson(self):
        self._setup_prompt()
        ro.record_reorder_outcome("a", human_final="Restock YES! Celebrational Cacao today.")
        # second account, materially edited
        ro.save_account_history("b", "Beta", _orders(150, 120, 90))
        ro.detect_reorders()
        ro.draft_reorder_prompt("b", draft_message="Hi.")
        out = ro.record_reorder_outcome(
            "b", human_final="Completely different rewritten reorder message about gift tins.",
            lessons=[{"category": "voice", "rule": "Lead with the account's bestselling SKU."}],
        )
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("3.3")["consecutive_clean"] == 0

    def test_rejected(self):
        self._setup_prompt()
        out = ro.record_reorder_outcome("a", rejected=True)
        assert out["status"] == "rejected"
        assert st.get_state("3.3")["consecutive_clean"] == 0

    def test_structural_change_not_clean(self):
        self._setup_prompt()
        out = ro.record_reorder_outcome(
            "a", human_final="Restock YES! Celebrational Cacao today.",
            structural_change=True)
        assert out["clean"] is False

    def test_outcome_missing_prompt_raises(self):
        with pytest.raises(ValueError):
            ro.record_reorder_outcome("ghost")


# --------------------------------------------------------------------------
# Tool handlers
# --------------------------------------------------------------------------


class TestHandlers:
    def test_ingest_handler(self):
        d = ro.orders_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "h.csv").write_text("account,date\nAcme,2026-01-01\nAcme,2026-02-01\n", encoding="utf-8")
        out = json.loads(ro._handle_ingest_order_history({}))
        assert out["count"] == 1
        assert out["trust_header"].startswith("Trust:")

    def test_detect_handler(self):
        ro.save_account_history("a", "A", _orders(150, 120, 90))
        out = json.loads(ro._handle_detect_reorders({}))
        assert out["count"] == 1
        assert "TODO" in out["source"]

    def test_draft_handler_missing_account(self):
        out = json.loads(ro._handle_draft_reorder_prompt({"account_id": "ghost"}))
        assert "error" in out

    def test_list_prompts_handler(self):
        ro.save_account_history("a", "A", _orders(150, 120, 90))
        ro.detect_reorders()
        ro.draft_reorder_prompt("a")
        out = json.loads(ro._handle_list_reorder_prompts({}))
        assert out["count"] == 1

    def test_record_outcome_handler_missing(self):
        out = json.loads(ro._handle_record_reorder_outcome({"account_id": "ghost"}))
        assert "error" in out
