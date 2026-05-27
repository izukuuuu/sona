"""In-memory Agent run registry for the frontend run/pause/resume API."""

from __future__ import annotations

import threading
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from api.schema import AgentEventType, AgentRunEnvelope, AgentRunEvent, AgentRunStatus


class AgentRunRecord:
    """Mutable server-side state for one Agent run."""

    def __init__(self, *, session_id: str, query: str, options: Dict[str, Any]) -> None:
        self.run_id = str(uuid.uuid4())
        self.session_id = session_id
        self.turn_id = str(uuid.uuid4())
        self.query = query
        self.options = dict(options)
        self.status: str = AgentRunStatus.QUEUED
        self.events: List[AgentRunEvent] = []
        self.started = False
        self.finished = False
        self.approval_condition = threading.Condition()
        self.pending_approval_id = ""
        self.approval_decision: Optional[Dict[str, Any]] = None

    @property
    def task_id(self) -> str:
        """Legacy alias while route variables migrate to session_id."""
        return self.session_id

    def envelope(self) -> AgentRunEnvelope:
        try:
            from utils.session_repository import get_session_repository

            get_session_repository().upsert_agent_run(self)
        except Exception:
            pass
        return AgentRunEnvelope(
            run_id=self.run_id,
            session_id=self.session_id,
            turn_id=self.turn_id,
            status=self.status,
            query=self.query,
            events=list(self.events),
        )

    def add_event(
        self,
        event_type: AgentEventType | str,
        *,
        status: str = "",
        title: str = "",
        detail: str = "",
        payload: Optional[Dict[str, Any]] = None,
    ) -> AgentRunEvent:
        event = AgentRunEvent(
            event_id=str(uuid.uuid4()),
            run_id=self.run_id,
            session_id=self.session_id,
            turn_id=self.turn_id,
            event_type=str(event_type),
            status=status,
            title=title,
            detail=detail,
            payload=payload or {},
            created_at=datetime.now().isoformat(),
        )
        self.events.append(event)
        try:
            from utils.session_repository import get_session_repository

            repository = get_session_repository()
            repository.upsert_agent_run(self)
            repository.append_agent_event(self.session_id, event.model_dump())
        except Exception:
            pass
        return event


class AgentRunStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: Dict[str, AgentRunRecord] = {}

    def create(self, *, session_id: str, query: str, options: Dict[str, Any]) -> AgentRunRecord:
        record = AgentRunRecord(session_id=session_id, query=query, options=options)
        with self._lock:
            self._runs[record.run_id] = record
        try:
            from utils.session_repository import get_session_repository

            get_session_repository().upsert_agent_run(record)
        except Exception:
            pass
        return record

    def get(self, run_id: str) -> Optional[AgentRunRecord]:
        with self._lock:
            return self._runs.get(run_id)


_store = AgentRunStore()


def get_agent_run_store() -> AgentRunStore:
    return _store
