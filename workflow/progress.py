"""Workflow progress hooks for API / frontend streaming."""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

ProgressCallback = Callable[[Dict[str, Any]], Any]


def emit_workflow_progress(
    callback: Optional[ProgressCallback],
    *,
    step: str,
    title: str,
    detail: str = "",
    payload: Optional[Dict[str, Any]] = None,
    status: str = "running",
) -> Any:
    """Notify API layer of a pipeline step (CLI may still print separately)."""
    if not callback:
        return None
    return callback(
        {
            "step": step,
            "title": title,
            "detail": detail[:8000] if detail else "",
            "payload": payload or {},
            "status": status,
        }
    )
