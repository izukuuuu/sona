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
        try:
            from utils.session_repository import get_session_repository

            get_session_repository().upsert_task_envelope(envelope)
        except Exception:
            # TaskStore remains a compatibility cache; repository persistence
            # must not break a live workflow response.
            pass

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
        if existing is not None:
            try:
                from utils.session_manager import get_session_manager

                session_key = existing.session_id or existing.task_id
                if session_key and not get_session_manager().load_session(session_key):
                    return None
            except Exception:
                pass
            return existing
        try:
            from utils.session_repository import get_session_repository

            for envelope in get_session_repository().list_task_envelopes():
                if envelope.task_id == task_id:
                    with self._lock:
                        self._tasks[task_id] = envelope
                    return envelope
        except Exception:
            pass
        return None

    def delete(self, task_id: str) -> None:
        with self._lock:
            self._tasks.pop(task_id, None)

    def clear(self) -> None:
        with self._lock:
            self._tasks.clear()

    def list_all(self) -> List[TaskEnvelope]:
        """Return explicit task/run envelopes, not every chat session."""

        with self._lock:
            merged = dict(self._tasks)

        try:
            from utils.session_repository import get_session_repository

            for envelope in get_session_repository().list_task_envelopes():
                merged.setdefault(envelope.task_id, envelope)
        except Exception:
            pass

        with self._lock:
            self._tasks.update(merged)
        try:
            from utils.session_manager import get_session_manager

            manager = get_session_manager()
            return [
                envelope
                for envelope in merged.values()
                if manager.load_session(envelope.session_id or envelope.task_id)
            ]
        except Exception:
            return list(merged.values())


_store = TaskStore()


def get_task_store() -> TaskStore:
    """Singleton used by FastAPI routes."""
    return _store
