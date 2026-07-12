"""Tests 包入口。"""
import sys
from pathlib import Path

# 把 src/ 加入 sys.path（pyproject.toml 里也配了 pythonpath，这里做兜底）
SRC = Path(__file__).parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
