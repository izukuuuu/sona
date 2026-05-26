"""Helpers to read workflow outputs from session data (API layer)."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse

from api.schema import (
    ERROR_WORKFLOW,
    ApiError,
    TaskArtifacts,
    TaskEnvelope,
    TaskStatus,
)
from utils.path import get_task_dir
from utils.session_manager import get_session_manager

_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_TRACE_PATH = os.getenv("SONA_DEBUG_LOG_PATH", str(_ROOT / ".cursor" / "debug.log"))
_FILE_URL_RE = re.compile(r"(file://[^\s)\]]+)", re.IGNORECASE)
_REPORT_PATH_RE = re.compile(
    r"([A-Za-z]:[\\/][^\s)\]]+|(?:\.?[\\/]|sandbox[\\/])?[A-Za-z0-9_.\-\u4e00-\u9fff\\/]+\.html?)",
    re.IGNORECASE,
)


def _file_url_to_path(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme.lower() != "file":
        return value
    path = unquote(parsed.path or "")
    if parsed.netloc and parsed.netloc.lower() not in ("localhost", ""):
        path = f"//{parsed.netloc}{path}"
    if re.match(r"^/[A-Za-z]:/", path):
        path = path[1:]
    return path.replace("/", os.sep)


def _normalize_report_path(value: Any) -> str:
    text = str(value or "").strip().strip("\"'")
    if not text:
        return ""
    if text.lower().startswith("file://"):
        return _file_url_to_path(text)
    return text


def _extract_report_path_from_text(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = _FILE_URL_RE.search(text)
    if match:
        return _normalize_report_path(match.group(1))
    match = _REPORT_PATH_RE.search(text)
    if not match:
        return ""
    return _normalize_report_path(match.group(1))


def _localize_sandbox_report_path(task_id: str, raw_path: str) -> str:
    path_text = _normalize_report_path(raw_path)
    if not task_id or not path_text:
        return path_text
    path_obj = Path(path_text).expanduser()
    if path_obj.is_file():
        return str(path_obj)

    normalized = path_text.replace("\\", "/")
    marker = f"/sandbox/{task_id}/"
    index = normalized.lower().find(marker.lower())
    if index >= 0:
        tail = normalized[index + len(marker) :]
        local_path = _ROOT / "sandbox" / task_id / Path(*tail.split("/"))
        if local_path.is_file():
            return str(local_path)
    return path_text


def _find_latest_report_in_task_sandbox(task_id: str) -> str:
    if not task_id:
        return ""
    task_dir = get_task_dir(task_id)
    if not task_dir.exists():
        return ""
    reports = [path for path in task_dir.rglob("*.html") if path.is_file()]
    if not reports:
        return ""
    reports.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return str(reports[0])


def extract_report_html_path(session_data: Dict[str, Any]) -> str:
    """
    Parse the latest report-producing message and return filesystem path.

    Streamed full-report runs persist the wrapper tool ``full_report_mode_node``
    rather than the inner ``report_html`` tool, so support both shapes.
    """
    messages = session_data.get("messages", [])
    for msg in reversed(messages):
        if msg.get("role") != "tool":
            continue
        tool_name = msg.get("tool_name")
        if tool_name not in ("report_html", "full_report_mode_node"):
            continue
        raw = str(msg.get("content", "") or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            data = None
        if isinstance(data, dict):
            html_path = _normalize_report_path(data.get("html_file_path") or data.get("report_path") or data.get("file_url"))
            if html_path:
                return html_path
        else:
            html_path = _extract_report_path_from_text(raw)
            if html_path:
                return html_path
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        html_path = _extract_report_path_from_text(str(msg.get("content", "") or ""))
        if html_path:
            return html_path
    return ""


def build_task_envelope_from_session(
    task_id: str,
    *,
    failed: bool = False,
    error_message: str = "",
) -> TaskEnvelope:
    """Build a TaskEnvelope from persisted chat/session messages."""
    manager = get_session_manager()
    session_data = manager.load_session(task_id) or {}
    report_path = _localize_sandbox_report_path(task_id, extract_report_html_path(session_data))
    if not report_path or not Path(report_path).expanduser().is_file():
        report_path = _find_latest_report_in_task_sandbox(task_id) or report_path
    stm_file = manager.stm_dir / f"{task_id}.json"
    artifacts = TaskArtifacts(
        report_path=report_path,
        trace_path=_DEFAULT_TRACE_PATH,
        sandbox_dir=str(get_task_dir(task_id)),
        session_hint=str(stm_file),
    )
    if failed:
        return TaskEnvelope(
            task_id=task_id,
            status=TaskStatus.FAILED,
            artifacts=artifacts,
            error=ApiError(
                error_code=ERROR_WORKFLOW,
                error_message=error_message or "Chat workflow failed",
            ),
        )
    return TaskEnvelope(
        task_id=task_id,
        status=TaskStatus.SUCCEEDED,
        artifacts=artifacts,
        error=None,
    )


def resolve_report_path_for_task(task_id: str) -> Optional[str]:
    """Resolve HTML report path from task store or persisted session."""
    from api.task_store import get_task_store

    env = get_task_store().get(task_id)
    if env is not None:
        raw_path = (env.artifacts.report_path or "").strip()
        localized = _localize_sandbox_report_path(task_id, raw_path)
        if localized and Path(localized).expanduser().is_file():
            return localized

    session_data = get_session_manager().load_session(task_id) or {}
    session_path = _localize_sandbox_report_path(task_id, extract_report_html_path(session_data))
    if session_path and Path(session_path).expanduser().is_file():
        return session_path
    sandbox_path = _find_latest_report_in_task_sandbox(task_id)
    if sandbox_path:
        return sandbox_path
    return session_path or None
