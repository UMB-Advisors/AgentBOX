"""Tests for the Sales Persona L0/L1/L2 trust counter (Phase 0 scaffold).

Covers state init/defaults, clean vs material/structural/rejected outcomes,
graduation, the L1->L2 explicit-authorization gate, can_autoact gating,
freeze/downgrade, the trust_header visibility line, summary_all, and the read
tool. HERMES_HOME is redirected per test so nothing touches the real runtime.
"""

import json

import pytest

from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


class TestState:
    def test_init_defaults_by_category(self):
        s = st.get_state("1.1")  # judgment
        assert s["level"] == 0
        assert s["N"] == 5
        assert s["l2_requires_auth"] is True
        assert st.get_state("1.3")["N"] == 10  # content
        assert st.get_state("2.2")["N"] == 20  # sends

    def test_unknown_job_uses_default_category(self):
        s = st.get_state("9.9")
        assert s["category"] == st.DEFAULT_CATEGORY
        assert s["N"] == 10

    def test_state_persists(self):
        st.get_state("1.3")
        assert (st.trust_dir() / "1.3.json").exists()

    def test_set_config_override(self):
        st.set_config("1.3", N=3, material_threshold=0.1)
        s = st.get_state("1.3")
        assert s["N"] == 3 and s["material_threshold"] == 0.1


class TestRecordOutcome:
    def test_clean_increments(self):
        s = st.record_outcome("1.3", "same text here", "same text here")
        assert s["consecutive_clean"] == 1
        assert s["last_edit_magnitude"] == 0.0

    def test_material_edit_resets(self):
        st.record_outcome("1.3", "x", "x")  # 1 clean
        s = st.record_outcome(
            "1.3", "The quick brown fox jumps.", "Totally different sentence entirely."
        )
        assert s["consecutive_clean"] == 0

    def test_structural_change_forces_material(self):
        s = st.record_outcome("1.3", "same", "same", structural_change=True)
        assert s["consecutive_clean"] == 0

    def test_rejection_resets(self):
        st.record_outcome("1.3", "x", "x")
        s = st.record_outcome("1.3", "x", "x", rejected=True)
        assert s["consecutive_clean"] == 0

    def test_graduation_l0_to_l1(self):
        st.set_config("1.3", N=2)
        st.record_outcome("1.3", "a", "a")
        s = st.record_outcome("1.3", "a", "a")
        assert s["level"] == 1
        assert s["consecutive_clean"] == 0  # reset on level-up
        assert s["_leveled_up"] is True

    def test_history_capped(self):
        for _ in range(25):
            st.record_outcome("1.3", "a", "a")
        assert len(st.get_state("1.3")["history"]) == st._HISTORY_CAP


class TestL2Authorization:
    def test_l1_to_l2_requires_auth(self):
        st.set_config("2.2", N=1)  # sends -> l2_requires_auth True
        st.record_outcome("2.2", "a", "a")  # L0 -> L1
        assert st.get_state("2.2")["level"] == 1
        s = st.record_outcome("2.2", "a", "a")  # would hit L2 but gated
        assert s["level"] == 1
        assert s["pending_l2_authorization"] is True

    def test_authorize_applies_pending(self):
        st.set_config("2.2", N=1)
        st.record_outcome("2.2", "a", "a")
        st.record_outcome("2.2", "a", "a")
        s = st.authorize_l2("2.2")
        assert s["level"] == 2
        assert s["pending_l2_authorization"] is False

    def test_content_job_reaches_l2_without_auth(self):
        st.set_config("1.3", N=1)  # content -> l2_requires_auth False
        st.record_outcome("1.3", "a", "a")  # L1
        s = st.record_outcome("1.3", "a", "a")  # L2 freely
        assert s["level"] == 2


class TestCanAutoact:
    def test_l0_never(self):
        assert st.can_autoact("1.3") is False

    def test_l1_routine_yes_exception_no(self):
        st.set_config("1.3", N=1)
        st.record_outcome("1.3", "a", "a")  # -> L1
        assert st.can_autoact("1.3") is True
        assert st.can_autoact("1.3", is_exception=True) is False

    def test_frozen_blocks(self):
        st.set_config("1.3", N=1)
        st.record_outcome("1.3", "a", "a")
        st.freeze("1.3")
        assert st.can_autoact("1.3") is False
        st.unfreeze("1.3")
        assert st.can_autoact("1.3") is True


class TestDowngradeAndHeader:
    def test_downgrade_one_level(self):
        st.set_config("1.3", N=1)
        st.record_outcome("1.3", "a", "a")  # L1
        s = st.downgrade("1.3")
        assert s["level"] == 0
        assert s["consecutive_clean"] == 0

    def test_trust_header_l0(self):
        assert st.trust_header("1.3") == "Trust: L0, 0/10 clean toward L1"

    def test_trust_header_frozen(self):
        st.freeze("1.3")
        assert "frozen" in st.trust_header("1.3")

    def test_trust_header_autonomous(self):
        st.set_config("1.3", N=1)
        st.record_outcome("1.3", "a", "a")
        st.record_outcome("1.3", "a", "a")  # L2 (content, no auth)
        assert "autonomous" in st.trust_header("1.3")

    def test_trust_header_pending_auth(self):
        st.set_config("2.2", N=1)
        st.record_outcome("2.2", "a", "a")
        st.record_outcome("2.2", "a", "a")
        assert "awaiting L2 authorization" in st.trust_header("2.2")


class TestSummaryAndTool:
    def test_summary_all(self):
        st.get_state("1.3")
        st.get_state("2.3")
        rows = st.summary_all()
        ids = {r["job_id"] for r in rows}
        assert ids == {"1.3", "2.3"}
        assert all("header" in r for r in rows)

    def test_tool_status_single(self):
        st.get_state("1.3")
        out = json.loads(st._handle_status({"job_id": "1.3"}))
        assert out["state"]["job_id"] == "1.3"
        assert out["header"].startswith("Trust:")

    def test_tool_status_all(self):
        st.get_state("1.3")
        out = json.loads(st._handle_status({}))
        assert "jobs" in out and len(out["jobs"]) == 1
