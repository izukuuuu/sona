from __future__ import annotations

import json

from langchain_core.messages import AIMessage, ToolMessage

from utils.message_utils import messages_from_session_data
from utils.session_contract import SESSION_SCHEMA_VERSION, normalize_session_data


def test_normalize_session_moves_legacy_agent_events_out_of_messages() -> None:
    raw = {
        "task_id": "task-a",
        "messages": [
            {"role": "user", "content": "你好", "timestamp": "2026-01-01T00:00:00"},
            {
                "role": "system",
                "content": json.dumps(
                    {
                        "event": "agent_run_event",
                        "event_type": "agent_step_started",
                        "title": "路由",
                    },
                    ensure_ascii=False,
                ),
                "timestamp": "2026-01-01T00:00:01",
            },
        ],
    }

    session = normalize_session_data(raw)

    assert session["schema_version"] == SESSION_SCHEMA_VERSION
    assert [m["role"] for m in session["messages"]] == ["user"]
    assert session["agent_events"][0]["event"] == "agent_run_event"
    assert session["agent_events"][0]["event_type"] == "agent_step_started"


def test_normalize_session_synthesizes_missing_tool_call_pair() -> None:
    raw = {
        "task_id": "task-b",
        "messages": [
            {"role": "user", "content": "查一下", "timestamp": "2026-01-01T00:00:00"},
            {
                "role": "tool",
                "tool_name": "search",
                "tool_call_id": "call-1",
                "content": "结果",
                "timestamp": "2026-01-01T00:00:01",
            },
        ],
    }

    session = normalize_session_data(raw)
    restored = messages_from_session_data(session)
    assistant = session["messages"][1]
    tool = session["messages"][2]

    assert [m["role"] for m in session["messages"]] == ["user", "assistant", "tool"]
    assert assistant["tools"][0]["id"] == "call-1"
    assert assistant["tools"][0]["function"]["name"] == "search"
    assert tool["parent_id"] == assistant["id"]
    assert tool["plugin"]["toolCallId"] == "call-1"
    assert any(isinstance(message, AIMessage) and message.tool_calls for message in restored)
    assert any(isinstance(message, ToolMessage) and message.tool_call_id == "call-1" for message in restored)


def test_messages_from_session_data_ignores_agent_events_for_model_context() -> None:
    session = normalize_session_data(
        {
            "task_id": "task-c",
            "messages": [{"role": "user", "content": "上下文", "timestamp": "2026-01-01T00:00:00"}],
            "agent_events": [{"event": "agent_run_event", "event_type": "agent_message_delta", "detail": "不进模型"}],
        }
    )

    restored = messages_from_session_data(session)

    assert len(restored) == 1
    assert restored[0].content == "上下文"
