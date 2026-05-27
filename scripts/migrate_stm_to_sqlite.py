"""Migrate legacy memory/STM JSON sessions into the SQLite session store."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from utils.path import get_stm_dir
from utils.session_contract import normalize_session_data
from utils.session_repository import SQLiteSessionRepository, default_session_db_path

TEST_EXACT_LABELS = {"hi", "hello", "你好", "保持连接"}
TEST_PATTERN = re.compile(
    r"(?:legacy report path|windows (?:drive|backslash)|stream smoke|agent run smoke|frontend smoke|smoke|test|测试)",
    re.IGNORECASE,
)


def _display_label(session: dict[str, Any]) -> str:
    base = str(session.get("description") or session.get("initial_query") or "").strip()
    while base.startswith("初始对话：") or base.startswith("分析"):
        if base.startswith("初始对话："):
            base = base.removeprefix("初始对话：").strip()
        elif base.startswith("分析"):
            base = base.removeprefix("分析").strip()
    return re.sub(r"\s+", " ", base).lower()


def is_likely_test_session(session: dict[str, Any]) -> bool:
    label = _display_label(session)
    return label in TEST_EXACT_LABELS or bool(TEST_PATTERN.search(label))


def iter_session_files(stm_dir: Path) -> list[Path]:
    return sorted(stm_dir.glob("*.json"), key=lambda p: p.stat().st_mtime)


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate memory/STM JSON sessions to SQLite.")
    parser.add_argument("--stm-dir", default=str(get_stm_dir()), help="Legacy STM directory.")
    parser.add_argument("--db-path", default=str(default_session_db_path()), help="Target SQLite DB path.")
    parser.add_argument("--apply", action="store_true", help="Write migrated sessions. Default is dry-run.")
    parser.add_argument("--dry-run", action="store_true", help="Preview migration without writing SQLite.")
    parser.add_argument("--include-test", action="store_true", help="Also migrate smoke/test sessions.")
    args = parser.parse_args()
    if args.apply and args.dry_run:
        parser.error("--apply and --dry-run are mutually exclusive")

    stm_dir = Path(args.stm_dir)
    files = iter_session_files(stm_dir) if stm_dir.is_dir() else []
    migrated: list[dict[str, str]] = []
    skipped_test: list[dict[str, str]] = []
    broken: list[dict[str, str]] = []

    repository = SQLiteSessionRepository(args.db_path) if args.apply else None

    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            session = normalize_session_data(raw)
        except Exception as exc:  # noqa: BLE001 - migration should report bad files
            broken.append({"file": path.name, "error": str(exc)})
            continue

        if is_likely_test_session(session) and not args.include_test:
            skipped_test.append({"file": path.name, "label": _display_label(session)})
            continue

        session_id = str(session.get("session_id") or session.get("task_id") or path.stem)
        migrated.append({"file": path.name, "session_id": session_id, "label": _display_label(session)})
        if repository is not None:
            repository.save_session(session_id, session)

    print(f"STM dir: {stm_dir}")
    print(f"SQLite DB: {args.db_path}")
    print(f"Mode: {'apply' if args.apply else 'dry-run'}")
    print(f"Total STM files: {len(files)}")
    print(f"Migratable sessions: {len(migrated)}")
    print(f"Skipped smoke/test sessions: {len(skipped_test)}")
    print(f"Broken files: {len(broken)}")
    if skipped_test[:10]:
        print("\nSkipped smoke/test examples:")
        for item in skipped_test[:10]:
            print(f"  {item['file']}\t{item['label']}")
    if broken[:10]:
        print("\nBroken examples:")
        for item in broken[:10]:
            print(f"  {item['file']}\t{item['error']}")
    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write SQLite.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
