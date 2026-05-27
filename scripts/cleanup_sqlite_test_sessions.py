"""Soft-delete known smoke/compat sessions from the SQLite session DB."""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from utils.session_repository import default_session_db_path


EXACT_LABELS = {
    "",
    "Sona session",
    "Frontend session",
    "hi",
    "hello",
    "你好",
    "保持连接",
    "tool context",
    "wiki stream",
    "agent run smoke",
    "report sync",
    "wiki case persistence",
    "mode node",
    "delete turn",
    "edit branch",
    "session backed task",
    "langgraph checkpoint",
    "append fields",
    "persist tokens",
    "stream smoke",
    "reconnect",
    "frontend smoke",
}

PATTERN = re.compile(
    r"(?:legacy report path|windows (?:drive|backslash)|agent run smoke|stream smoke|frontend smoke|smoke|test|测试)",
    re.IGNORECASE,
)


def _normalize_label(text: Any) -> str:
    label = str(text or "").strip()
    while label.startswith("初始对话：") or label.startswith("分析"):
        if label.startswith("初始对话："):
            label = label.removeprefix("初始对话：").strip()
        elif label.startswith("分析"):
            label = label.removeprefix("分析").strip()
    return re.sub(r"\s+", " ", label)


def _is_cleanup_candidate(row: sqlite3.Row) -> tuple[bool, str]:
    labels = [
        _normalize_label(row["title"]),
        _normalize_label(row["initial_query"]),
    ]
    for label in labels:
        if label in EXACT_LABELS:
            return True, f"exact:{label or '<empty>'}"
        if PATTERN.search(label):
            return True, f"pattern:{label}"
    return False, ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Soft-delete known test sessions from SQLite.")
    parser.add_argument("--db-path", default=str(default_session_db_path()), help="SQLite DB path.")
    parser.add_argument("--apply", action="store_true", help="Apply soft deletes. Default is dry-run.")
    args = parser.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"SQLite DB does not exist: {db_path}")
        return 1

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT session_id, title, initial_query, updated_at, deleted_at
        FROM sessions
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        """
    ).fetchall()
    candidates = []
    for row in rows:
        ok, reason = _is_cleanup_candidate(row)
        if ok:
            candidates.append((row, reason))

    print(f"SQLite DB: {db_path}")
    print(f"Mode: {'apply' if args.apply else 'dry-run'}")
    print(f"Live sessions: {len(rows)}")
    print(f"Cleanup candidates: {len(candidates)}")
    for row, reason in candidates[:80]:
        print(
            f"  {row['session_id']}\t{reason}\t"
            f"title={row['title']!r}\tinitial={row['initial_query']!r}"
        )
    if len(candidates) > 80:
        print(f"  ... {len(candidates) - 80} more")

    if args.apply and candidates:
        now = datetime.now().isoformat()
        conn.executemany(
            """
            UPDATE sessions
            SET deleted_at = ?, updated_at = ?
            WHERE session_id = ? AND deleted_at IS NULL
            """,
            [(now, now, row["session_id"]) for row, _reason in candidates],
        )
        conn.commit()
        print(f"Soft-deleted sessions: {len(candidates)}")
    elif not args.apply:
        print("Dry-run only. Re-run with --apply to soft-delete candidates.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
