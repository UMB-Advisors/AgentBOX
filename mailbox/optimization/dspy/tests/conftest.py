"""Make the optimization/dspy/ root importable as flat modules in pytest.

The package isn't installed as a wheel (uv `package = false`) so pytest
needs the parent directory on ``sys.path`` for ``import trace_set`` etc.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
