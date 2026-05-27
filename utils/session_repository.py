"""SQLite-backed session repository.

The old STM JSON files remain useful as migration input, but the web API uses
this repository as the production source of truth.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from utils.path import ensure_data_dir
from utils.session_contract import SESSION_SCHEMA_VERSION, normalize_session_data

os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

APPLICATION_SCHEMA_VERSION = 4


def _now_iso() -> str:
    return datetime.now().isoformat()


def default_session_db_path() -> Path:
    configured = os.environ.get("SONA_SESSION_DB_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return ensure_data_dir() / "sona.db"


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _json_loads(value: Any, fallback: Any) -> Any:
    if value in (None, ""):
        return fallback
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return fallback


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _json_object(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _json_array(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


class SQLiteSessionRepository:
    """Durable session store backed by one SQLite file."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path is not None else default_session_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    @contextmanager
    def langgraph_checkpointer(self) -> Iterator[Any]:
        """Yield an official LangGraph SQLite checkpointer bound to this DB."""
        try:
            from langgraph.checkpoint.sqlite import SqliteSaver
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise RuntimeError(
                "langgraph-checkpoint-sqlite>=3.0.1,<4 is required for LangGraph persistence"
            ) from exc

        with self._lock, self._connect() as conn:
            saver = SqliteSaver(conn)
            saver.setup()
            yield saver

    def _ensure_columns(self, conn: sqlite3.Connection, table: str, columns: Dict[str, str]) -> None:
        existing = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")

    def _init_langgraph_schema(self) -> None:
        """Let LangGraph own its checkpoint tables in the same portable DB file."""
        try:
            with self.langgraph_checkpointer():
                pass
        except RuntimeError:
            # The repository still works for non-agent tests, but dependency
            # checks will fail if official checkpointing is expected.
            return

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    applied_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    initial_query TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    schema_version INTEGER NOT NULL DEFAULT 3,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    token_usage TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );

                CREATE TABLE IF NOT EXISTS conversation_items (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    run_id TEXT NOT NULL DEFAULT '',
                    turn_id TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL,
                    message_type TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    provider_message_id TEXT NOT NULL DEFAULT '',
                    tool_call_id TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL DEFAULT '',
                    token_usage TEXT NOT NULL DEFAULT '{}',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    source TEXT NOT NULL DEFAULT 'app',
                    item_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT '',
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    branch_id TEXT NOT NULL DEFAULT '',
                    superseded_by TEXT NOT NULL DEFAULT '',
                    UNIQUE(session_id, seq)
                );

                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    turn_id TEXT NOT NULL DEFAULT '',
                    query TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'queued',
                    route TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL DEFAULT '',
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    configurable_json TEXT NOT NULL DEFAULT '{}',
                    workflow_options_json TEXT NOT NULL DEFAULT '{}',
                    error_code TEXT NOT NULL DEFAULT '',
                    error_message TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    updated_at TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS agent_events (
                    event_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL DEFAULT '',
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    turn_id TEXT NOT NULL DEFAULT '',
                    seq INTEGER NOT NULL,
                    event_type TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    detail TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL DEFAULT '{}',
                    event_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(session_id, seq)
                );

                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    run_id TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT 'report',
                    path TEXT NOT NULL DEFAULT '',
                    mime_type TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS session_prefs (
                    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
                    prefs_json TEXT NOT NULL DEFAULT '{}',
                    notes_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memory_store (
                    namespace TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (namespace, key)
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_updated
                    ON sessions(updated_at DESC) WHERE deleted_at IS NULL;
                CREATE INDEX IF NOT EXISTS idx_items_session_seq
                    ON conversation_items(session_id, seq);
                CREATE INDEX IF NOT EXISTS idx_events_session_seq
                    ON agent_events(session_id, seq);
                CREATE INDEX IF NOT EXISTS idx_runs_session
                    ON agent_runs(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_artifacts_session
                    ON artifacts(session_id, created_at DESC);
                """
            )
            self._ensure_columns(conn, "sessions", {"thread_id": "TEXT NOT NULL DEFAULT ''"})
            self._ensure_columns(
                conn,
                "conversation_items",
                {
                    "run_id": "TEXT NOT NULL DEFAULT ''",
                    "turn_id": "TEXT NOT NULL DEFAULT ''",
                    "message_type": "TEXT NOT NULL DEFAULT ''",
                    "provider_message_id": "TEXT NOT NULL DEFAULT ''",
                    "tool_call_id": "TEXT NOT NULL DEFAULT ''",
                    "name": "TEXT NOT NULL DEFAULT ''",
                    "token_usage": "TEXT NOT NULL DEFAULT '{}'",
                    "metadata": "TEXT NOT NULL DEFAULT '{}'",
                    "source": "TEXT NOT NULL DEFAULT 'app'",
                    "updated_at": "TEXT NOT NULL DEFAULT ''",
                },
            )
            self._ensure_columns(
                conn,
                "agent_runs",
                {
                    "checkpoint_id": "TEXT NOT NULL DEFAULT ''",
                    "checkpoint_ns": "TEXT NOT NULL DEFAULT ''",
                    "configurable_json": "TEXT NOT NULL DEFAULT '{}'",
                    "workflow_options_json": "TEXT NOT NULL DEFAULT '{}'",
                    "error_code": "TEXT NOT NULL DEFAULT ''",
                    "error_message": "TEXT NOT NULL DEFAULT ''",
                    "updated_at": "TEXT NOT NULL DEFAULT ''",
                },
            )
            conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_sessions_thread
                    ON sessions(thread_id);
                CREATE INDEX IF NOT EXISTS idx_items_run
                    ON conversation_items(run_id);
                CREATE INDEX IF NOT EXISTS idx_items_tool_call
                    ON conversation_items(tool_call_id);
                CREATE INDEX IF NOT EXISTS idx_runs_checkpoint
                    ON agent_runs(checkpoint_id);
                CREATE INDEX IF NOT EXISTS idx_memory_namespace
                    ON memory_store(namespace, updated_at DESC);
                """
            )
            conn.execute(
                """
                UPDATE sessions SET thread_id = session_id
                WHERE thread_id = '' OR thread_id IS NULL
                """
            )
            conn.execute(
                """
                UPDATE conversation_items SET updated_at = created_at
                WHERE updated_at = '' OR updated_at IS NULL
                """
            )
            conn.execute(
                """
                UPDATE agent_runs SET updated_at = COALESCE(finished_at, started_at, created_at)
                WHERE updated_at = '' OR updated_at IS NULL
                """
            )
            conn.execute(
                """
                INSERT INTO schema_migrations (name, version, applied_at)
                VALUES ('application', ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    version=excluded.version,
                    applied_at=excluded.applied_at
                """,
                (APPLICATION_SCHEMA_VERSION, _now_iso()),
            )
        self._init_langgraph_schema()

    def _ensure_session_row(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        *,
        title: str = "",
        initial_query: str = "",
        now: Optional[str] = None,
    ) -> None:
        ts = now or _now_iso()
        conn.execute(
            """
            INSERT INTO sessions (
                session_id, thread_id, title, initial_query, status, schema_version,
                metadata, token_usage, created_at, updated_at, deleted_at
            )
            VALUES (?, ?, ?, ?, 'active', ?, '{}', '{}', ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
                thread_id=CASE
                    WHEN sessions.thread_id = '' OR sessions.thread_id IS NULL THEN excluded.thread_id
                    ELSE sessions.thread_id
                END,
                title=CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
                initial_query=CASE
                    WHEN excluded.initial_query != '' THEN excluded.initial_query
                    ELSE sessions.initial_query
                END,
                updated_at=excluded.updated_at
            """,
            (session_id, session_id, title, initial_query, SESSION_SCHEMA_VERSION, ts, ts),
        )

    def update_session_metadata(
        self,
        session_id: str,
        *,
        title: Optional[str] = None,
        initial_query: Optional[str] = None,
    ) -> None:
        now = _now_iso()
        with self._lock, self._connect() as conn:
            self._ensure_session_row(conn, session_id, now=now)
            updates = ["updated_at = ?"]
            params: List[Any] = [now]
            if title is not None:
                updates.append("title = ?")
                params.append(title)
            if initial_query is not None:
                updates.append("initial_query = ?")
                params.append(initial_query)
            params.append(session_id)
            conn.execute(f"UPDATE sessions SET {', '.join(updates)} WHERE session_id = ?", params)

    def append_conversation_item(
        self,
        session_id: str,
        item: Dict[str, Any],
        *,
        run_id: str = "",
        turn_id: str = "",
        source: str = "app",
    ) -> Dict[str, Any]:
        now = _now_iso()
        item_data = dict(item)
        item_data.setdefault("id", str(uuid.uuid4()))
        item_data.setdefault("timestamp", now)
        with self._lock, self._connect() as conn:
            self._ensure_session_row(conn, session_id, now=now)
            existing_messages = [
                _json_loads(row["item_json"], {})
                for row in conn.execute(
                    """
                    SELECT item_json FROM conversation_items
                    WHERE session_id = ? AND is_deleted = 0
                    ORDER BY seq ASC
                    """,
                    (session_id,),
                ).fetchall()
            ]
            normalized_messages = normalize_session_data(
                {
                    "session_id": session_id,
                    "task_id": session_id,
                    "messages": existing_messages + [item_data],
                    "agent_events": [],
                    "created_at": now,
                    "updated_at": now,
                }
            )["messages"]
            new_messages = normalized_messages[len(existing_messages) :] or normalized_messages[-1:]
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM conversation_items WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next_seq"] if row else 1)
            for offset, normalized in enumerate(new_messages):
                metadata = _json_object(normalized.get("metadata"))
                conn.execute(
                    """
                    INSERT INTO conversation_items (
                        id, session_id, seq, run_id, turn_id, role, message_type, content,
                        provider_message_id, tool_call_id, name, token_usage, metadata,
                        source, item_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        item_json=excluded.item_json,
                        content=excluded.content,
                        metadata=excluded.metadata,
                        updated_at=excluded.updated_at
                    """,
                    (
                        str(normalized["id"]),
                        session_id,
                        seq + offset,
                        run_id,
                        turn_id,
                        _text(normalized.get("role")),
                        _text(normalized.get("type") or normalized.get("message_type")),
                        _text(normalized.get("content")),
                        _text(normalized.get("provider_message_id") or normalized.get("response_id")),
                        _text(normalized.get("tool_call_id")),
                        _text(normalized.get("name") or normalized.get("tool_name")),
                        _json_dumps(normalized.get("token_usage") or {}),
                        _json_dumps(metadata),
                        source,
                        _json_dumps(normalized),
                        _text(normalized.get("timestamp") or now),
                        now,
                    ),
                )
            conn.execute("UPDATE sessions SET updated_at = ? WHERE session_id = ?", (now, session_id))
        return new_messages[-1]

    def soft_delete_item(self, session_id: str, item_id: str) -> bool:
        now = _now_iso()
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE conversation_items SET is_deleted = 1, updated_at = ?
                WHERE session_id = ? AND id = ? AND is_deleted = 0
                """,
                (now, session_id, item_id),
            )
            conn.execute("UPDATE sessions SET updated_at = ? WHERE session_id = ?", (now, session_id))
            return cursor.rowcount > 0

    def supersede_item(self, session_id: str, item_id: str, replacement: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        replacement_item = self.append_conversation_item(session_id, replacement, source="edit")
        now = _now_iso()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE conversation_items SET superseded_by = ?, is_deleted = 1, updated_at = ?
                WHERE session_id = ? AND id = ?
                """,
                (str(replacement_item["id"]), now, session_id, item_id),
            )
        return replacement_item

    def append_agent_event(self, session_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
        now = _now_iso()
        event_data = dict(event)
        event_data.setdefault("event_id", str(uuid.uuid4()))
        event_data.setdefault("created_at", now)
        payload = event_data.get("payload") if isinstance(event_data.get("payload"), dict) else {}
        with self._lock, self._connect() as conn:
            self._ensure_session_row(conn, session_id, now=now)
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_events WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next_seq"] if row else 1)
            conn.execute(
                """
                INSERT INTO agent_events (
                    event_id, run_id, session_id, turn_id, seq, event_type,
                    status, title, detail, payload, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    status=excluded.status,
                    title=excluded.title,
                    detail=excluded.detail,
                    payload=excluded.payload,
                    event_json=excluded.event_json
                """,
                (
                    str(event_data["event_id"]),
                    _text(event_data.get("run_id")),
                    session_id,
                    _text(event_data.get("turn_id")),
                    seq,
                    _text(event_data.get("event_type") or event_data.get("event")),
                    _text(event_data.get("status")),
                    _text(event_data.get("title")),
                    _text(event_data.get("detail")),
                    _json_dumps(payload),
                    _json_dumps(event_data),
                    _text(event_data.get("created_at") or now),
                ),
            )
            conn.execute("UPDATE sessions SET updated_at = ? WHERE session_id = ?", (now, session_id))
        return event_data

    def save_session(self, session_id: str, session_data: Dict[str, Any]) -> None:
        data = normalize_session_data({**session_data, "session_id": session_id, "task_id": session_id})
        now = str(data.get("updated_at") or _now_iso())
        created_at = str(data.get("created_at") or now)
        harness = data.get("harness_memory") if isinstance(data.get("harness_memory"), dict) else {}
        prefs = harness.get("session_prefs") if isinstance(harness.get("session_prefs"), dict) else {}
        notes = harness.get("notes") if isinstance(harness.get("notes"), dict) else {}
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (
                    session_id, thread_id, title, initial_query, status, schema_version,
                    metadata, token_usage, created_at, updated_at, deleted_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(session_id) DO UPDATE SET
                    thread_id=excluded.thread_id,
                    title=excluded.title,
                    initial_query=excluded.initial_query,
                    status=excluded.status,
                    schema_version=excluded.schema_version,
                    metadata=excluded.metadata,
                    token_usage=excluded.token_usage,
                    updated_at=excluded.updated_at,
                    deleted_at=NULL
                """,
                (
                    session_id,
                    session_id,
                    str(data.get("description") or ""),
                    str(data.get("initial_query") or ""),
                    str(data.get("status") or "active"),
                    int(data.get("schema_version") or SESSION_SCHEMA_VERSION),
                    _json_dumps({k: v for k, v in data.items() if k not in {"messages", "agent_events", "token_usage"}}),
                    _json_dumps(data.get("token_usage") or {}),
                    created_at,
                    now,
                ),
            )
            conn.execute("DELETE FROM conversation_items WHERE session_id = ?", (session_id,))
            for seq, item in enumerate(data.get("messages") or [], start=1):
                item_id = str(item.get("id") or f"{session_id}:item:{seq}")
                metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
                conn.execute(
                    """
                    INSERT INTO conversation_items (
                        id, session_id, seq, run_id, turn_id, role, message_type, content,
                        provider_message_id, tool_call_id, name, token_usage, metadata,
                        source, item_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id,
                        session_id,
                        seq,
                        str(item.get("run_id") or ""),
                        str(item.get("turn_id") or ""),
                        str(item.get("role") or ""),
                        str(item.get("type") or item.get("message_type") or ""),
                        str(item.get("content") or ""),
                        str(item.get("provider_message_id") or item.get("response_id") or ""),
                        str(item.get("tool_call_id") or ""),
                        str(item.get("name") or item.get("tool_name") or ""),
                        _json_dumps(item.get("token_usage") or {}),
                        _json_dumps(metadata),
                        str(item.get("source") or "legacy_save"),
                        _json_dumps(item),
                        str(item.get("timestamp") or now),
                        now,
                    ),
                )
            conn.execute("DELETE FROM agent_events WHERE session_id = ?", (session_id,))
            for seq, event in enumerate(data.get("agent_events") or [], start=1):
                if not isinstance(event, dict):
                    continue
                event_id = str(event.get("event_id") or f"{session_id}:event:{seq}")
                payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                conn.execute(
                    """
                    INSERT INTO agent_events (
                        event_id, run_id, session_id, turn_id, seq, event_type,
                        status, title, detail, payload, event_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        str(event.get("run_id") or ""),
                        session_id,
                        str(event.get("turn_id") or ""),
                        seq,
                        str(event.get("event_type") or event.get("event") or ""),
                        str(event.get("status") or ""),
                        str(event.get("title") or ""),
                        str(event.get("detail") or ""),
                        _json_dumps(payload),
                        _json_dumps(event),
                        str(event.get("created_at") or now),
                    ),
                )
            conn.execute(
                """
                INSERT INTO session_prefs (session_id, prefs_json, notes_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    prefs_json=excluded.prefs_json,
                    notes_json=excluded.notes_json,
                    updated_at=excluded.updated_at
                """,
                (session_id, _json_dumps(prefs), _json_dumps(notes), now),
            )

    def load_session(self, session_id: str, *, include_deleted: bool = False) -> Optional[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            if include_deleted:
                row = conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM sessions WHERE session_id = ? AND deleted_at IS NULL",
                    (session_id,),
                ).fetchone()
            if row is None:
                return None
            messages = [
                _json_loads(item["item_json"], {})
                for item in conn.execute(
                    """
                    SELECT item_json FROM conversation_items
                    WHERE session_id = ? AND is_deleted = 0
                    ORDER BY seq ASC
                    """,
                    (session_id,),
                ).fetchall()
            ]
            events = [
                _json_loads(item["event_json"], {})
                for item in conn.execute(
                    "SELECT event_json FROM agent_events WHERE session_id = ? ORDER BY seq ASC",
                    (session_id,),
                ).fetchall()
            ]
            prefs_row = conn.execute(
                "SELECT prefs_json, notes_json FROM session_prefs WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        metadata = _json_loads(row["metadata"], {})
        harness_memory = {
            "session_prefs": _json_loads(prefs_row["prefs_json"], {}) if prefs_row else {},
            "notes": _json_loads(prefs_row["notes_json"], {}) if prefs_row else {},
        }
        data = {
            **(metadata if isinstance(metadata, dict) else {}),
            "schema_version": int(row["schema_version"]),
            "session_id": row["session_id"],
            "task_id": row["session_id"],
            "thread_id": row["thread_id"] or row["session_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "status": row["status"],
            "description": row["title"],
            "initial_query": row["initial_query"],
            "messages": messages,
            "agent_events": events,
            "harness_memory": harness_memory,
            "token_usage": _json_loads(row["token_usage"], {}),
        }
        return normalize_session_data(data)

    def list_sessions(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT session_id FROM sessions
                WHERE deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (max(1, int(limit)),),
            ).fetchall()
        sessions: List[Dict[str, Any]] = []
        for row in rows:
            data = self.load_session(str(row["session_id"]))
            if data:
                sessions.append(data)
        return sessions

    def soft_delete_session(self, session_id: str) -> bool:
        now = _now_iso()
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE sessions SET deleted_at = ?, updated_at = ?
                WHERE session_id = ? AND deleted_at IS NULL
                """,
                (now, now, session_id),
            )
            return cursor.rowcount > 0

    def upsert_task_envelope(self, envelope: Any) -> None:
        now = _now_iso()
        task_id = str(getattr(envelope, "task_id", "") or "")
        session_id = str(getattr(envelope, "session_id", "") or task_id)
        if not task_id or not session_id:
            return
        status = str(getattr(envelope, "status", "") or "")
        error = getattr(envelope, "error", None)
        error_text = getattr(error, "error_message", "") if error else ""
        artifacts = getattr(envelope, "artifacts", None)
        report_path = str(getattr(artifacts, "report_path", "") or "") if artifacts else ""
        trace_path = str(getattr(artifacts, "trace_path", "") or "") if artifacts else ""
        sandbox_dir = str(getattr(artifacts, "sandbox_dir", "") or "") if artifacts else ""
        session_hint = str(getattr(artifacts, "session_hint", "") or "") if artifacts else ""
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO agent_runs (run_id, session_id, query, status, error, created_at, finished_at)
                VALUES (?, ?, '', ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    status=excluded.status,
                    error=excluded.error,
                    error_message=excluded.error,
                    finished_at=excluded.finished_at,
                    updated_at=excluded.finished_at
                """,
                (task_id, session_id, status, error_text, now, now),
            )
            for kind, path in (
                ("report", report_path),
                ("trace", trace_path),
                ("sandbox", sandbox_dir),
                ("session", session_hint),
            ):
                if not path:
                    continue
                conn.execute(
                    """
                    INSERT INTO artifacts (artifact_id, session_id, run_id, kind, path, metadata, created_at)
                    VALUES (?, ?, ?, ?, ?, '{}', ?)
                    ON CONFLICT(artifact_id) DO UPDATE SET
                        path=excluded.path,
                        created_at=excluded.created_at
                    """,
                    (f"{task_id}:{kind}", session_id, task_id, kind, path, now),
                )

    def upsert_agent_run(self, run: Any) -> None:
        now = _now_iso()
        run_id = str(getattr(run, "run_id", "") or "")
        session_id = str(getattr(run, "session_id", "") or "")
        if not run_id or not session_id:
            return
        status = str(getattr(run, "status", "") or "queued")
        options = getattr(run, "options", None)
        options_dict = options if isinstance(options, dict) else {}
        finished_at = now if status in {"succeeded", "failed", "aborted"} else None
        started_at = now if status in {"running", "waiting_approval", "succeeded", "failed", "aborted"} else None
        with self._lock, self._connect() as conn:
            self._ensure_session_row(conn, session_id, now=now)
            conn.execute(
                """
                INSERT INTO agent_runs (
                    run_id, session_id, turn_id, query, status, configurable_json,
                    workflow_options_json, created_at, started_at, finished_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    turn_id=excluded.turn_id,
                    query=excluded.query,
                    status=excluded.status,
                    configurable_json=excluded.configurable_json,
                    workflow_options_json=excluded.workflow_options_json,
                    started_at=COALESCE(agent_runs.started_at, excluded.started_at),
                    finished_at=COALESCE(excluded.finished_at, agent_runs.finished_at),
                    updated_at=excluded.updated_at
                """,
                (
                    run_id,
                    session_id,
                    str(getattr(run, "turn_id", "") or ""),
                    str(getattr(run, "query", "") or ""),
                    status,
                    _json_dumps({"thread_id": session_id}),
                    _json_dumps(options_dict.get("workflow_options") or {}),
                    now,
                    started_at,
                    finished_at,
                    now,
                ),
            )

    def record_run_checkpoint(
        self,
        run_id: str,
        *,
        checkpoint_id: str = "",
        checkpoint_ns: str = "",
        configurable: Optional[Dict[str, Any]] = None,
    ) -> None:
        now = _now_iso()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE agent_runs SET
                    checkpoint_id = ?,
                    checkpoint_ns = ?,
                    configurable_json = ?,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (checkpoint_id, checkpoint_ns, _json_dumps(configurable or {}), now, run_id),
            )

    def get_run_checkpoint(self, run_id: str) -> Optional[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT checkpoint_id, checkpoint_ns, configurable_json
                FROM agent_runs
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "checkpoint_id": row["checkpoint_id"],
            "checkpoint_ns": row["checkpoint_ns"],
            "configurable": _json_loads(row["configurable_json"], {}),
        }

    def put_memory(
        self,
        namespace: tuple[str, ...] | List[str],
        key: str,
        value: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        now = _now_iso()
        namespace_key = _json_dumps(list(namespace))
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO memory_store (namespace, key, value_json, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(namespace, key) DO UPDATE SET
                    value_json=excluded.value_json,
                    metadata=excluded.metadata,
                    updated_at=excluded.updated_at
                """,
                (namespace_key, key, _json_dumps(value), _json_dumps(metadata or {}), now, now),
            )

    def get_memory(self, namespace: tuple[str, ...] | List[str], key: str) -> Optional[Dict[str, Any]]:
        namespace_key = _json_dumps(list(namespace))
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM memory_store WHERE namespace = ? AND key = ?",
                (namespace_key, key),
            ).fetchone()
        if row is None:
            return None
        return {
            "namespace": _json_loads(row["namespace"], []),
            "key": row["key"],
            "value": _json_loads(row["value_json"], {}),
            "metadata": _json_loads(row["metadata"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def search_memory(self, namespace: tuple[str, ...] | List[str], *, limit: int = 10) -> List[Dict[str, Any]]:
        namespace_key = _json_dumps(list(namespace))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM memory_store
                WHERE namespace = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (namespace_key, max(1, int(limit))),
            ).fetchall()
        return [
            {
                "namespace": _json_loads(row["namespace"], []),
                "key": row["key"],
                "value": _json_loads(row["value_json"], {}),
                "metadata": _json_loads(row["metadata"], {}),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def list_task_envelopes(self) -> List[Any]:
        from api.schema import ApiError, TaskArtifacts, TaskEnvelope, TaskStatus

        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT r.run_id, r.session_id, r.status, r.error,
                       MAX(CASE WHEN a.kind = 'report' THEN a.path ELSE '' END) AS report_path,
                       MAX(CASE WHEN a.kind = 'trace' THEN a.path ELSE '' END) AS trace_path,
                       MAX(CASE WHEN a.kind = 'sandbox' THEN a.path ELSE '' END) AS sandbox_dir,
                       MAX(CASE WHEN a.kind = 'session' THEN a.path ELSE '' END) AS session_hint
                FROM agent_runs r
                LEFT JOIN artifacts a ON a.run_id = r.run_id
                JOIN sessions s ON s.session_id = r.session_id AND s.deleted_at IS NULL
                GROUP BY r.run_id
                ORDER BY COALESCE(r.finished_at, r.created_at) DESC
                """
            ).fetchall()
        out = []
        for row in rows:
            status = str(row["status"] or TaskStatus.SUCCEEDED)
            try:
                parsed_status = TaskStatus(status)
            except ValueError:
                parsed_status = TaskStatus.SUCCEEDED
            error_message = str(row["error"] or "")
            out.append(
                TaskEnvelope(
                    task_id=str(row["run_id"]),
                    session_id=str(row["session_id"]),
                    status=parsed_status,
                    artifacts=TaskArtifacts(
                        report_path=str(row["report_path"] or ""),
                        trace_path=str(row["trace_path"] or ""),
                        sandbox_dir=str(row["sandbox_dir"] or ""),
                        session_hint=str(row["session_hint"] or ""),
                    ),
                    error=ApiError(error_code="WORKFLOW_ERROR", error_message=error_message)
                    if error_message
                    else None,
                )
            )
        return out


_repository: Optional[SQLiteSessionRepository] = None


def get_session_repository() -> SQLiteSessionRepository:
    global _repository
    path = default_session_db_path()
    if _repository is None or _repository.db_path != path:
        _repository = SQLiteSessionRepository(path)
    return _repository


def reset_session_repository() -> None:
    global _repository
    _repository = None
