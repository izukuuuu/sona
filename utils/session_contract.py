"""Canonical session contract and migration helpers."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime
from typing import Any, Dict, List, Optional


SESSION_SCHEMA_VERSION = 3
MESSAGE_ROLES = {"user", "assistant", "tool", "system"}


def _now_iso() -> str:
    return datetime.now().isoformat()


def _stable_id(*parts: Any) -> str:
    raw = "|".join(str(part or "") for part in parts)
    digest = hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()[:24]
    return f"msg_{digest}"


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False)
    except TypeError:
        return str(content)


def _canonical_tool_call(raw: Any, *, fallback_name: str = "unknown", fallback_id: str = "") -> Dict[str, Any]:
    item = _as_dict(raw)
    function = _as_dict(item.get("function"))
    args = item.get("args", function.get("arguments", {}))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (json.JSONDecodeError, TypeError):
            args = {"raw": args}
    if not isinstance(args, dict):
        args = {}
    name = str(item.get("name") or function.get("name") or fallback_name or "unknown")
    call_id = str(item.get("id") or item.get("tool_call_id") or item.get("call_id") or fallback_id or "")
    tool_type = str(item.get("type") or "function")
    return {
        "id": call_id,
        "name": name,
        "args": args,
        "type": tool_type,
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        "identifier": str(item.get("identifier") or item.get("plugin_identifier") or "sona"),
        "apiName": str(item.get("apiName") or item.get("api_name") or name),
    }


def _canonical_message(raw: Any, *, task_id: str, index: int) -> Optional[Dict[str, Any]]:
    item = _as_dict(raw)
    role = str(item.get("role") or "").strip()
    if role not in MESSAGE_ROLES:
        return None

    timestamp = str(item.get("timestamp") or item.get("created_at") or _now_iso())
    content = _content_to_text(item.get("content"))
    message: Dict[str, Any] = {
        "id": str(item.get("id") or _stable_id(task_id, index, role, timestamp, content)),
        "role": role,
        "content": content,
        "timestamp": timestamp,
    }

    metadata = item.get("metadata")
    if isinstance(metadata, dict) and metadata:
        message["metadata"] = metadata

    if role == "assistant":
        raw_tool_calls = _as_list(item.get("tool_calls") or item.get("tools"))
        tool_calls = [_canonical_tool_call(tc) for tc in raw_tool_calls]
        tool_calls = [tc for tc in tool_calls if tc.get("id") or tc.get("name")]
        if tool_calls:
            message["tool_calls"] = tool_calls
            message["tools"] = tool_calls

    if role == "tool":
        message["tool_name"] = str(item.get("tool_name") or item.get("name") or "unknown")
        message["tool_call_id"] = str(item.get("tool_call_id") or item.get("id") or "")
        parent_id = item.get("parent_id") or item.get("parentId")
        if parent_id:
            message["parent_id"] = str(parent_id)
        plugin = item.get("plugin")
        if isinstance(plugin, dict):
            message["plugin"] = plugin

    return message


def _legacy_event_from_system_message(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if message.get("role") != "system":
        return None
    try:
        parsed = json.loads(str(message.get("content") or ""))
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    event = parsed.get("event")
    if event not in {"agent_run_event", "workflow_step"}:
        return None
    out = dict(parsed)
    out.setdefault("created_at", message.get("timestamp") or _now_iso())
    return out


def _tool_call_ids(message: Dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for tc in _as_list(message.get("tool_calls") or message.get("tools")):
        item = _as_dict(tc)
        call_id = str(item.get("id") or item.get("tool_call_id") or item.get("call_id") or "")
        if call_id:
            ids.add(call_id)
    return ids


def _paired_tool_call_parent(messages: List[Dict[str, Any]], tool_index: int, call_id: str) -> Optional[Dict[str, Any]]:
    for index in range(tool_index - 1, -1, -1):
        prev = messages[index]
        if prev.get("role") == "user":
            break
        if prev.get("role") == "assistant" and call_id in _tool_call_ids(prev):
            return prev
    return None


def _tool_plugin_payload(message: Dict[str, Any]) -> Dict[str, Any]:
    tool_name = str(message.get("tool_name") or "unknown")
    return {
        "toolCallId": str(message.get("tool_call_id") or ""),
        "apiName": tool_name,
        "identifier": "sona",
        "type": "default",
        "arguments": "",
        "state": {"status": "success"},
    }


def _insert_missing_tool_call_messages(messages: List[Dict[str, Any]], *, task_id: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "assistant" and message.get("tool_calls"):
            message["tools"] = [_canonical_tool_call(tc) for tc in _as_list(message.get("tool_calls"))]
        if message.get("role") == "tool":
            call_id = str(message.get("tool_call_id") or "")
            parent = _paired_tool_call_parent(out, len(out), call_id) if call_id else None
            if call_id and parent is None:
                parent_id = _stable_id(task_id, len(out), "assistant_tool_call", call_id)
                out.append(
                    {
                        "id": parent_id,
                        "role": "assistant",
                        "content": "",
                        "timestamp": str(message.get("timestamp") or _now_iso()),
                        "tool_calls": [
                            {
                                "id": call_id,
                                "name": str(message.get("tool_name") or "unknown"),
                                "args": {},
                                "type": "function",
                                "function": {
                                    "name": str(message.get("tool_name") or "unknown"),
                                    "arguments": "{}",
                                },
                                "identifier": "sona",
                                "apiName": str(message.get("tool_name") or "unknown"),
                            }
                        ],
                        "tools": [
                            {
                                "id": call_id,
                                "name": str(message.get("tool_name") or "unknown"),
                                "args": {},
                                "type": "function",
                                "function": {
                                    "name": str(message.get("tool_name") or "unknown"),
                                    "arguments": "{}",
                                },
                                "identifier": "sona",
                                "apiName": str(message.get("tool_name") or "unknown"),
                            }
                        ],
                        "metadata": {"migrated": True, "reason": "synthesized_missing_tool_call"},
                    }
                )
                parent = out[-1]
            if parent is not None:
                message["parent_id"] = str(parent.get("id") or "")
            message.setdefault("plugin", _tool_plugin_payload(message))
        out.append(message)
    return out


def normalize_session_data(session_data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a schema-v2 session with canonical messages and separate agent events."""
    data = copy.deepcopy(session_data)
    task_id = str(data.get("task_id") or "")
    created_at = str(data.get("created_at") or _now_iso())

    agent_events = list(_as_list(data.get("agent_events")))
    canonical_messages: List[Dict[str, Any]] = []
    for index, raw in enumerate(_as_list(data.get("messages"))):
        msg = _canonical_message(raw, task_id=task_id, index=index)
        if not msg:
            continue
        event = _legacy_event_from_system_message(msg)
        if event:
            agent_events.append(event)
            continue
        canonical_messages.append(msg)

    canonical_messages = _insert_missing_tool_call_messages(canonical_messages, task_id=task_id)

    data["schema_version"] = SESSION_SCHEMA_VERSION
    data["created_at"] = created_at
    data["updated_at"] = str(data.get("updated_at") or created_at)
    data["description"] = str(data.get("description") or "")
    data["initial_query"] = str(data.get("initial_query") or "")
    data["messages"] = canonical_messages
    data["agent_events"] = agent_events
    data.setdefault("harness_memory", {"session_prefs": {}, "notes": {}})
    if not isinstance(data.get("harness_memory"), dict):
        data["harness_memory"] = {"session_prefs": {}, "notes": {}}
    data.setdefault(
        "token_usage",
        {"total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "steps": []},
    )
    if not isinstance(data.get("token_usage"), dict):
        data["token_usage"] = {"total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "steps": []}
    data.setdefault("status", "active")
    return data


def append_agent_event(session_data: Dict[str, Any], event: Dict[str, Any]) -> Dict[str, Any]:
    data = normalize_session_data(session_data)
    events = data.setdefault("agent_events", [])
    if isinstance(events, list):
        events.append(dict(event))
    data["updated_at"] = _now_iso()
    return data
