"""Migrate STM session JSON files to the current session contract."""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from utils.path import get_project_root, get_stm_dir
from utils.session_contract import SESSION_SCHEMA_VERSION, normalize_session_data


def _json_dump(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def migrate_sessions(*, dry_run: bool = False) -> tuple[int, int, Path]:
    root = get_project_root()
    stm_dir = get_stm_dir()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = root / "cache" / "session_migration_backup" / stamp
    changed = 0
    scanned = 0

    for session_file in sorted(stm_dir.glob("*.json")):
        scanned += 1
        try:
            original_text = session_file.read_text(encoding="utf-8")
            original = json.loads(original_text)
        except (OSError, json.JSONDecodeError):
            continue

        migrated = normalize_session_data(original)
        if migrated.get("schema_version") != SESSION_SCHEMA_VERSION:
            migrated["schema_version"] = SESSION_SCHEMA_VERSION
        migrated_text = json.dumps(migrated, ensure_ascii=False, indent=2) + "\n"
        if migrated_text == original_text:
            continue

        changed += 1
        if dry_run:
            continue
        backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(session_file, backup_dir / session_file.name)
        _json_dump(session_file, migrated)

    return scanned, changed, backup_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate memory/STM session files to current schema.")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing files.")
    args = parser.parse_args()
    scanned, changed, backup_dir = migrate_sessions(dry_run=args.dry_run)
    mode = "dry-run" if args.dry_run else "migrated"
    print(f"{mode}: scanned={scanned} changed={changed} schema_version={SESSION_SCHEMA_VERSION}")
    if changed and not args.dry_run:
        print(f"backup={backup_dir}")


if __name__ == "__main__":
    main()
