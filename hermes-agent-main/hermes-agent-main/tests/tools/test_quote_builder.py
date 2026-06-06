"""Tests for Quote & Line-Sheet Generation (Sales Persona Job 3.1).

Covers the price-book seed + no-pyyaml YAML/JSON reader, quote assembly incl. the
hard floor guard (below-floor / unknown-SKU pricing always human-gated), the
review-folder artifact, the pending list, the human-verdict outcome loop
(clean / pricing-changed / rejected) with the Job 3.1 trust counter + gbrain
lessons, and the tool handlers. HERMES_HOME is redirected per test; gbrain points
at a missing binary.
"""

import json

import pytest

from tools import quote_builder as qb
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


class TestPriceBook:
    def test_default_written_and_parsed(self):
        book = qb.load_price_book()
        assert qb.price_book_yaml_path().exists()
        skus = {p["sku"] for p in book["products"]}
        assert "YES-CEL-ORIG-12" in skus
        prod = qb._find_product(book, "YES-CEL-ORIG-12")
        assert prod["wholesale_price"] == 42.0
        assert prod["floor_price"] == 36.0
        assert prod["moq"] == 6

    def test_yaml_roundtrip_types(self):
        book = qb.load_price_book()  # writes default, reads back
        assert book["currency"] == "USD"
        assert isinstance(book["min_order_value"], float)
        assert isinstance(book["volume_breaks"], list)
        assert book["volume_breaks"][0]["min_qty"] == 24

    def test_terms_with_colon_preserved(self):
        # terms contains commas/periods; ensure it survives the simple parser.
        book = qb.load_price_book()
        assert "Net 30" in book["terms"]

    def test_json_fallback(self, tmp_path):
        qb.base_dir().mkdir(parents=True, exist_ok=True)
        qb.price_book_json_path().write_text(json.dumps({
            "currency": "USD",
            "products": [{"sku": "X-1", "name": "X One", "wholesale_price": 10,
                          "floor_price": 8, "moq": 2, "unit": "case"}],
        }), encoding="utf-8")
        book = qb.load_price_book()
        assert qb._find_product(book, "X-1")["wholesale_price"] == 10

    def test_find_product_by_name_ci(self):
        book = qb.load_price_book()
        assert qb._find_product(book, "yes! celebrational cacao — mint (12ct case)")


class TestDraftQuote:
    def test_basic_pricing_and_artifact(self):
        out = qb.draft_quote("Acme Grocer", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        assert out["subtotal"] == 420.0
        assert out["requires_human_approval"] is True
        assert out["any_below_floor"] is False
        from pathlib import Path
        text = Path(out["review_path"]).read_text(encoding="utf-8")
        assert "YES!" in text and "Celebrational Cacao" in text
        assert "HUMAN-APPROVED" in text
        assert "TODO(live-wiring)" in text  # draft_order degrade marker

    def test_below_floor_flagged(self):
        out = qb.draft_quote("Cheapskate", [
            {"sku": "YES-CEL-ORIG-12", "qty": 10, "unit_price": 20.0}])
        assert out["any_below_floor"] is True
        rec = qb.load_quote(out["quote_id"])
        assert rec["lines"][0]["below_floor"] is True
        # Floor guard holds the whole doc for approval regardless of trust.
        assert rec["requires_human_approval"] is True

    def test_unknown_sku_flagged(self):
        out = qb.draft_quote("Mystery", [{"sku": "NOPE-999", "qty": 5}])
        assert out["has_unknown_sku"] is True
        rec = qb.load_quote(out["quote_id"])
        assert rec["lines"][0]["unknown_sku"] is True
        assert rec["lines"][0]["line_total"] is None

    def test_below_moq_and_min_order(self):
        out = qb.draft_quote("Tiny", [{"sku": "YES-CEL-ORIG-12", "qty": 2}])
        rec = qb.load_quote(out["quote_id"])
        assert rec["lines"][0]["below_moq"] is True
        assert rec["below_min_order"] is True  # 84 < 250

    def test_doc_type_validation(self):
        with pytest.raises(ValueError):
            qb.draft_quote("X", [{"sku": "YES-CEL-ORIG-12", "qty": 1}], doc_type="invoice")

    def test_line_sheet_type(self):
        out = qb.draft_quote("Shop", [{"sku": "YES-CEL-GIFT-06", "qty": 8}],
                             doc_type="line_sheet")
        rec = qb.load_quote(out["quote_id"])
        assert rec["doc_type"] == "line_sheet"


class TestListing:
    def test_list_pending_only_drafts(self):
        a = qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        qb.draft_quote("B", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        qb.record_outcome(a["quote_id"], human_final="", rejected=False)
        ids = {x["quote_id"] for x in qb.list_pending()}
        assert a["quote_id"] not in ids


class TestOutcome:
    def test_clean_advances_trust(self):
        out = qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        body = qb.load_quote(out["quote_id"])  # ensure stored
        assert body is not None
        res = qb.record_outcome(out["quote_id"], ai_draft="hello", human_final="hello")
        assert res["clean"] is True and res["status"] == "approved"
        assert qb.load_quote(out["quote_id"])["pricing_human_approved"] is True
        assert st.get_state("3.1")["consecutive_clean"] == 1

    def test_pricing_changed_is_material(self):
        out = qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        qb.record_outcome(out["quote_id"], ai_draft="x", human_final="x")  # 1 clean
        out2 = qb.draft_quote("B", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        res = qb.record_outcome(
            out2["quote_id"], ai_draft="x", human_final="x",
            pricing_changed=True,
            lessons=[{"category": "pricing", "rule": "Hold 5% volume break until 24+ cases."}],
        )
        assert res["clean"] is False
        assert res["pricing_changed"] is True
        assert res["lessons_recorded"] == 1
        assert st.get_state("3.1")["consecutive_clean"] == 0

    def test_rejected(self):
        out = qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        res = qb.record_outcome(out["quote_id"], rejected=True)
        assert res["status"] == "rejected"
        assert qb.load_quote(out["quote_id"])["pricing_human_approved"] is False
        assert st.get_state("3.1")["consecutive_clean"] == 0

    def test_structural_change_resets(self):
        out = qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 10}])
        res = qb.record_outcome(out["quote_id"], ai_draft="x", human_final="x",
                                structural_change=True)
        assert res["clean"] is False

    def test_outcome_missing_quote_raises(self):
        with pytest.raises(ValueError):
            qb.record_outcome("ghost")


class TestHandlers:
    def test_get_price_book_handler(self):
        out = json.loads(qb._handle_get_price_book({}))
        assert out["price_book"]["currency"] == "USD"

    def test_draft_quote_handler(self):
        out = json.loads(qb._handle_draft_quote({
            "account": "Foo", "line_items": [{"sku": "YES-CEL-ORIG-12", "qty": 6}]}))
        assert out["subtotal"] == 252.0
        assert out["trust_header"].startswith("Trust:")

    def test_draft_quote_handler_missing_account(self):
        out = json.loads(qb._handle_draft_quote({"line_items": [{"qty": 1}]}))
        assert "error" in out

    def test_draft_quote_handler_empty_lines(self):
        out = json.loads(qb._handle_draft_quote({"account": "Foo", "line_items": []}))
        assert "error" in out

    def test_list_pending_handler(self):
        qb.draft_quote("A", [{"sku": "YES-CEL-ORIG-12", "qty": 6}])
        out = json.loads(qb._handle_list_pending({}))
        assert out["count"] == 1

    def test_record_outcome_handler_missing(self):
        out = json.loads(qb._handle_record_outcome({"quote_id": "ghost"}))
        assert "error" in out

    def test_registered_in_quotes_toolset(self):
        from tools.registry import registry
        names = set(registry.get_tool_names_for_toolset("quotes"))
        assert {"get_price_book", "draft_quote", "list_pending_quotes",
                "record_quote_outcome"} <= names
        assert registry.get_toolset_for_tool("draft_quote") == "quotes"
