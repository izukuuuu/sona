"""Session-backed task compatibility registry for the HTTP API."""

from __future__ import annotations

import threading
from typing import List, Optional

from api.schema import TaskEnvelope, TaskStatus


class TaskStore:
    """Thread-safe compatibility index of TaskEnvelope by session/task id.

    The frontend originally consumed /v1/tasks as an in-memory task list. Chat
    sessions are now the durable context, so this store stitches transient task
    status together with session-derived artifacts instead of acting as a
    separate source of truth.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, TaskEnvelope] = {}

    def put(self, envelope: TaskEnvelope) -> None:
        with self._lock:
            self._tasks[envelope.task_id] = envelope

    def _from_session(self, task_id: str, base: Optional[TaskEnvelope] = None) -> Optional[TaskEnvelope]:
        from api.report_utils import build_task_envelope_from_session
        from utils.session_manager import get_session_manager

        if not get_session_manager().load_session(task_id):
            return base

        failed = base.status == TaskStatus.FAILED if base else False
        error_message = base.error.error_message if base and base.error else ""
        envelope = build_task_envelope_from_session(
            task_id,
            failed=failed,
            error_message=error_message,
        )
        if base and base.status in {TaskStatus.QUEUED, TaskStatus.RUNNING}:
            envelope.status = base.status
            envelope.error = base.error
        return envelope

    def get(self, task_id: str) -> Optional[TaskEnvelope]:
        with self._lock:
            existing = self._tasks.get(task_id)
        migrated = self._from_session(task_id, existing)
        if migrated is not None:
            with self._lock:
                self._tasks[task_id] = migrated
        return migrated

    def delete(self, task_id: str) -> None:
        with self._lock:
            self._tasks.pop(task_id, None)

    def list_all(self) -> List[TaskEnvelope]:
        """Return stored envelopes plus session-derived envelopes."""
        from utils.session_manager import get_session_manager

        with self._lock:
            merged = dict(self._tasks)

        for session in get_session_manager().list_sessions(limit=1000):
            task_id = str(session.get("task_id") or "").strip()
            if not task_id:
                continue
            migrated = self._from_session(task_id, merged.get(task_id))
            if migrated is not None:
                merged[task_id] = migrated

        with self._lock:
            self._tasks.update(merged)
        return list(merged.values())


_store = TaskStore()


def get_task_store() -> TaskStore:
    """Singleton used by FastAPI routes."""
    return _store
