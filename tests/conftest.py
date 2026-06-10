from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest

# Wiki：默认关闭 LLM 与微博辅助，避免 CI / 无密钥环境调用外网或非确定模型。
os.environ.setdefault("SONA_WIKI_USE_LLM", "0")
os.environ.setdefault("SONA_WIKI_NEO4J_PRIORITY", "0")
os.environ.setdefault("SONA_WIKI_WEIBO_AUX", "0")
# 默认不在每次 wiki 检索前跑增量编译（避免 CI 对未编译 expert_notes 反复尝试走模型）。
os.environ.setdefault("SONA_WIKI_AUTO_COMPILE_ON_QUERY", "0")

# 专题监测单测若需内存库，在测试里 monkeypatch SONA_TOPIC_MONITOR_SQLITE=0 或传入 DummyDB。

# Ensure project root is importable when running pytest from any cwd.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture(autouse=True)
def isolated_session_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Keep contract tests from writing production session storage."""
    monkeypatch.setenv("SONA_SESSION_DB_PATH", str(tmp_path / "sona-test.db"))

    import utils.session_manager as session_manager
    import utils.session_repository as session_repository
    from api.task_store import get_task_store

    session_manager._session_manager = None  # noqa: SLF001
    session_repository.reset_session_repository()
    get_task_store().clear()
    yield
    session_manager._session_manager = None  # noqa: SLF001
    session_repository.reset_session_repository()
    get_task_store().clear()

