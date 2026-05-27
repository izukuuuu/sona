from __future__ import annotations

import json
import sys
import threading
import time
import types
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, ToolMessage

import api.event_runner as event_runner
import api.server as server
from api.report_utils import extract_report_html_path
from api.schema import AnalyzeEventRequest, TaskStatus
from api.server import app
from api.agent_run_store import get_agent_run_store
from api.task_store import get_task_store
from utils.message_utils import messages_from_session_data
from utils.path import ensure_task_dirs, get_task_dir
from utils.session_manager import get_session_manager


client = TestClient(app)


def test_health_and_session_endpoints() -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    created = client.post("/v1/chat/sessions", json={"initial_query": "frontend smoke"})
    assert created.status_code == 200
    body = created.json()
    assert body["session_id"]
    assert body["messages"] == []

    listed = client.get("/v1/chat/sessions?limit=3")
    assert listed.status_code == 200
    assert isinstance(listed.json()["sessions"], list)

    fetched = client.get(f"/v1/chat/sessions/{body['session_id']}")
    assert fetched.status_code == 200
    assert fetched.json()["session_id"] == body["session_id"]

    renamed = client.patch(
        f"/v1/chat/sessions/{body['session_id']}",
        json={"description": "renamed frontend smoke"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["description"] == "renamed frontend smoke"

    deleted = client.delete(f"/v1/chat/sessions/{body['session_id']}")
    assert deleted.status_code == 200
    assert isinstance(deleted.json()["sessions"], list)

    missing = client.get(f"/v1/chat/sessions/{body['session_id']}")
    assert missing.status_code == 404


def test_chat_stream_syncs_report_to_task_store(monkeypatch: Any) -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "report sync"}).json()
    session_id = created["session_id"]
    report_dir = Path(".pytest_cache") / "sona_reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"report_{uuid.uuid4().hex}.html"
    report_path.write_text("<html><body>demo</body></html>", encoding="utf-8")

    monkeypatch.setattr("cli.router.route_query", lambda query, session_id: ("reactagent", {}))

    def fake_agent_stream(*args: Any, **kwargs: Any):
        yield {
            "type": "tool_result",
            "tool_name": "report_html",
            "result": json.dumps({"html_file_path": str(report_path)}),
            "run_id": "r1",
        }
        yield {"type": "message", "message": {"content": f"报告：file:///{report_path}"}}

    monkeypatch.setattr("agent.reactagent.stream", fake_agent_stream)

    response = client.post(
        f"/v1/chat/sessions/{session_id}/messages:stream",
        json={"query": "分析事件"},
    )
    assert response.status_code == 200

    env = get_task_store().get(session_id)
    assert env is not None
    assert env.status == TaskStatus.SUCCEEDED
    assert env.artifacts.report_path == str(report_path)

    tasks = client.get("/v1/tasks").json()["tasks"]
    assert any(item["session_id"] == session_id for item in tasks)

    report = client.get(f"/v1/tasks/{session_id}/report")
    assert report.status_code == 200
    assert "demo" in report.text


def test_report_path_extraction_supports_full_report_wrapper() -> None:
    report_path = (Path(".pytest_cache") / "sona_reports" / f"report_{uuid.uuid4().hex}.html").resolve()
    session_data = {
        "messages": [
            {
                "role": "tool",
                "tool_name": "full_report_mode_node",
                "content": report_path.as_uri(),
            }
        ]
    }

    assert extract_report_html_path(session_data) == str(report_path)


def test_report_path_extraction_falls_back_to_assistant_message() -> None:
    report_path = (Path(".pytest_cache") / "sona_reports" / f"report_{uuid.uuid4().hex}.html").resolve()
    session_data = {
        "messages": [
            {
                "role": "assistant",
                "content": f"已完成舆情事件分析工作流。报告：{report_path.as_uri()}",
            }
        ]
    }

    assert extract_report_html_path(session_data) == str(report_path)


def test_report_endpoint_localizes_legacy_sandbox_file_url() -> None:
    session_id = get_session_manager().create_session("legacy report path")
    ensure_task_dirs(session_id)
    report_dir = get_task_dir(session_id) / "结果文件"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report_legacy.html"
    report_path.write_text("<html><body>legacy demo</body></html>", encoding="utf-8")

    legacy_url = f"file:///Users/example/sona-master/sandbox/{session_id}/结果文件/report_legacy.html"
    get_session_manager().add_message(session_id, "assistant", f"已完成舆情事件分析工作流。报告：{legacy_url}")

    report = client.get(f"/v1/tasks/{session_id}/report")

    assert report.status_code == 200
    assert "legacy demo" in report.text


def test_tasks_endpoint_does_not_hydrate_plain_session_without_registered_run() -> None:
    session_id = get_session_manager().create_session("session backed task")
    ensure_task_dirs(session_id)
    report_dir = get_task_dir(session_id) / "结果文件"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report_session_backed.html"
    report_path.write_text("<html><body>session backed demo</body></html>", encoding="utf-8")
    get_session_manager().add_message(session_id, "assistant", f"报告：{report_path.as_uri()}")
    get_task_store().delete(session_id)

    detail = client.get(f"/v1/tasks/{session_id}")
    assert detail.status_code == 404

    tasks = client.get("/v1/tasks").json()["tasks"]
    assert not any(item["session_id"] == session_id for item in tasks)

    report = client.get(f"/v1/tasks/{session_id}/report")
    assert report.status_code == 200
    assert "session backed demo" in report.text


def test_deleted_session_stays_out_of_recent_list_after_repository_reload() -> None:
    session_id = get_session_manager().create_session("delete me")
    deleted = client.delete(f"/v1/chat/sessions/{session_id}")
    assert deleted.status_code == 200
    assert all(item["session_id"] != session_id for item in deleted.json()["sessions"])

    from utils import session_manager as session_manager_module
    from utils.session_repository import reset_session_repository

    session_manager_module._session_manager = None  # noqa: SLF001
    reset_session_repository()

    listed = client.get("/v1/chat/sessions?limit=100")
    assert listed.status_code == 200
    assert all(item["session_id"] != session_id for item in listed.json()["sessions"])
    assert client.get(f"/v1/chat/sessions/{session_id}").status_code == 404


def test_report_endpoint_localizes_encoded_legacy_sandbox_file_url() -> None:
    session_id = get_session_manager().create_session("encoded legacy report path")
    ensure_task_dirs(session_id)
    report_dir = get_task_dir(session_id) / "结果文件"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "report_20260512_015642.html"
    report_path.write_text("<html><body>encoded legacy demo</body></html>", encoding="utf-8")

    legacy_url = (
        f"file:///Users/example/sona-master/sandbox/{session_id}/"
        "%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260512_015642.html"
    )
    get_session_manager().add_message(session_id, "assistant", f"已完成舆情事件分析工作流。报告：{legacy_url}")

    report = client.get(f"/v1/tasks/{session_id}/report")

    assert report.status_code == 200
    assert "encoded legacy demo" in report.text


def test_report_endpoint_localizes_windows_sandbox_file_urls() -> None:
    cases = [
        (
            "windows drive report path",
            "file:///F:/legacy/sona-master/sandbox/{session_id}/"
            "%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_win.html",
        ),
        (
            "windows backslash report path",
            "file:///F:\\legacy\\sona-master\\sandbox\\{session_id}\\"
            "%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6\\report_win.html",
        ),
    ]
    for title, url_template in cases:
        session_id = get_session_manager().create_session(title)
        ensure_task_dirs(session_id)
        report_dir = get_task_dir(session_id) / "结果文件"
        report_dir.mkdir(parents=True, exist_ok=True)
        report_path = report_dir / "report_win.html"
        report_path.write_text(f"<html><body>{title}</body></html>", encoding="utf-8")

        legacy_url = url_template.format(session_id=session_id)
        get_session_manager().add_message(session_id, "assistant", f"已完成舆情事件分析工作流。报告：{legacy_url}")

        report = client.get(f"/v1/tasks/{session_id}/report")

        assert report.status_code == 200
        assert title in report.text


def test_chat_stream_persists_accumulated_tokens(monkeypatch: Any) -> None:
  created = client.post("/v1/chat/sessions", json={"initial_query": "persist tokens"}).json()

  monkeypatch.setattr("cli.router.route_query", lambda query, session_id: ("reactagent", {}))

  def fake_agent_stream(*args: Any, **kwargs: Any):
    yield {"type": "token", "content": "你", "accumulated": "你好，世界"}

  monkeypatch.setattr("agent.reactagent.stream", fake_agent_stream)

  response = client.post(
    f"/v1/chat/sessions/{created['session_id']}/messages:stream",
    json={"query": "你好"},
  )
  assert response.status_code == 200

  session = client.get(f"/v1/chat/sessions/{created['session_id']}").json()
  assert [message["role"] for message in session["messages"]] == ["user", "assistant"]
  assert session["messages"][1]["content"] == "你好，世界"


def test_session_message_edit_branch_truncates_following_context() -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "edit branch"}).json()
    session_id = created["session_id"]
    manager = get_session_manager()
    manager.add_message(session_id, "user", "old question")
    manager.add_message(session_id, "assistant", "old answer")
    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    user_id = session["messages"][0]["id"]

    edited = client.patch(
        f"/v1/chat/sessions/{session_id}/messages/{user_id}",
        json={"content": "new question", "mode": "branch"},
    )

    assert edited.status_code == 200
    messages = edited.json()["messages"]
    assert [message["role"] for message in messages] == ["user"]
    assert messages[0]["content"] == "new question"


def test_session_message_delete_turn_removes_assistant_tool_block() -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "delete turn"}).json()
    session_id = created["session_id"]
    manager = get_session_manager()
    manager.add_message(session_id, "user", "use tool")
    manager.add_message(
        session_id,
        "assistant",
        "",
        tool_calls=[{"id": "call_delete_turn", "name": "demo_tool", "args": {}}],
    )
    manager.add_message(session_id, "tool", "tool output", tool_name="demo_tool", tool_call_id="call_delete_turn")
    manager.add_message(session_id, "assistant", "final answer")
    manager.add_message(session_id, "user", "next question")
    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    assistant_id = session["messages"][1]["id"]

    deleted = client.delete(f"/v1/chat/sessions/{session_id}/messages/{assistant_id}?mode=turn")

    assert deleted.status_code == 200
    messages = deleted.json()["messages"]
    assert [message["role"] for message in messages] == ["user", "user"]
    assert messages[0]["content"] == "use tool"
    assert messages[1]["content"] == "next question"


def test_sqlite_session_round_trips_tool_context_after_reload() -> None:
    session_id = get_session_manager().create_session("tool roundtrip")
    manager = get_session_manager()
    manager.add_message(session_id, "user", "use tool")
    manager.add_message(
        session_id,
        "assistant",
        "",
        tool_calls=[{"id": "call_roundtrip", "name": "demo_tool", "args": {"q": "x"}}],
    )
    manager.add_message(
        session_id,
        "tool",
        "tool output",
        tool_name="demo_tool",
        tool_call_id="call_roundtrip",
    )

    from utils import session_manager as session_manager_module
    from utils.session_repository import reset_session_repository

    session_manager_module._session_manager = None  # noqa: SLF001
    reset_session_repository()

    session = get_session_manager().load_session(session_id)
    assert session is not None
    restored = messages_from_session_data(session)
    assert any(isinstance(message, AIMessage) and message.tool_calls for message in restored)
    assert any(isinstance(message, ToolMessage) and message.tool_call_id == "call_roundtrip" for message in restored)


def test_langgraph_sqlite_checkpointer_restores_thread_state_after_reload() -> None:
    from langgraph.graph import StateGraph

    from utils.session_repository import get_session_repository, reset_session_repository

    session_id = get_session_manager().create_session("langgraph checkpoint")
    run = get_agent_run_store().create(session_id=session_id, query="persist graph", options={})

    builder = StateGraph(int)
    builder.add_node("add_one", lambda value: value + 1)
    builder.set_entry_point("add_one")
    builder.set_finish_point("add_one")

    repo = get_session_repository()
    config = {"configurable": {"thread_id": session_id}}
    with repo.langgraph_checkpointer() as checkpointer:
        graph = builder.compile(checkpointer=checkpointer)
        assert graph.invoke(1, config) == 2
        assert graph.invoke(2, config) == 3
        state = graph.get_state(config)
        checkpoint_id = state.config["configurable"]["checkpoint_id"]
        repo.record_run_checkpoint(
            run.run_id,
            checkpoint_id=checkpoint_id,
            checkpoint_ns=state.config["configurable"].get("checkpoint_ns", ""),
            configurable=state.config["configurable"],
        )
        stored = repo.get_run_checkpoint(run.run_id)
        assert stored is not None
        assert stored["checkpoint_id"] == checkpoint_id

    reset_session_repository()
    reloaded_repo = get_session_repository()
    with reloaded_repo.langgraph_checkpointer() as checkpointer:
        graph = builder.compile(checkpointer=checkpointer)
        state = graph.get_state(config)

    assert state.values == 3


def test_langgraph_checkpointer_requires_thread_id() -> None:
    from langgraph.graph import StateGraph

    from utils.session_repository import get_session_repository

    builder = StateGraph(int)
    builder.add_node("add_one", lambda value: value + 1)
    builder.set_entry_point("add_one")
    builder.set_finish_point("add_one")

    with get_session_repository().langgraph_checkpointer() as checkpointer:
        graph = builder.compile(checkpointer=checkpointer)
        try:
            graph.invoke(1, {})
        except ValueError as exc:
            assert "thread_id" in str(exc)
        else:  # pragma: no cover - regression guard
            raise AssertionError("LangGraph checkpointer accepted missing thread_id")


def test_repository_append_fields_and_memory_store_contract() -> None:
    from utils.session_repository import get_session_repository

    session_id = get_session_manager().create_session("append fields")
    repo = get_session_repository()
    item = repo.append_conversation_item(
        session_id,
        {
            "role": "tool",
            "content": "tool output",
            "tool_name": "demo_tool",
            "tool_call_id": "call_fields",
            "metadata": {"provider": "test"},
        },
        run_id="run-fields",
        turn_id="turn-fields",
        source="contract",
    )

    assert item["tool_call_id"] == "call_fields"
    repo.put_memory(("users", "contract"), "preference", {"style": "concise"}, metadata={"source": "test"})
    assert repo.get_memory(("users", "contract"), "preference")["value"] == {"style": "concise"}  # type: ignore[index]
    assert repo.search_memory(("users", "contract"))[0]["key"] == "preference"


def test_chat_stream_sse_contract(monkeypatch: Any) -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "stream smoke"}).json()

    def fake_stream(*, task_id: str, body: Any):
        yield server._sse("route", {"route": "reactagent", "task_mode": "qa"})
        yield server._sse("token", {"content": "你", "accumulated": "你"})
        yield server._sse("message", {"content": "你好", "message_id": "m1"})
        yield server._sse("done", {"session_id": task_id})

    monkeypatch.setattr(server, "_chat_stream", fake_stream)
    response = client.post(
        f"/v1/chat/sessions/{created['session_id']}/messages:stream",
        json={"query": "你好"},
    )
    assert response.status_code == 200
    text = response.text
    assert "event: token" in text
    assert "event: message" in text
    assert "你好" in text


def test_agent_run_sse_contract(monkeypatch: Any) -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "agent run smoke"}).json()
    session_id = created["session_id"]

    monkeypatch.setattr("cli.router.route_query", lambda query, session_id: ("reactagent", {}))

    def fake_agent_stream(*args: Any, **kwargs: Any):
        yield {"type": "thinking", "content": "先分析", "accumulated": "先分析"}
        yield {
            "type": "workflow_step",
            "step": "collect_terms",
            "title": "提取检索词",
            "detail": "大熊猫 舆情",
            "payload": {"keywords": ["大熊猫"]},
        }
        yield {
            "type": "tool_call",
            "tool_name": "search",
            "args": {"q": "大熊猫"},
            "run_id": "tc1",
        }
        yield {
            "type": "tool_result",
            "tool_name": "search",
            "result": "采集完成",
            "run_id": "tc1",
        }
        yield {"type": "token", "content": "已", "accumulated": "已完成分析"}

    monkeypatch.setattr("agent.reactagent.stream", fake_agent_stream)

    created_run = client.post(
        f"/v1/chat/sessions/{session_id}/runs",
        json={"query": "近期大熊猫相关舆情事件分析"},
    )
    assert created_run.status_code == 200
    run_id = created_run.json()["run_id"]

    response = client.get(f"/v1/chat/sessions/{session_id}/runs/{run_id}/events")
    assert response.status_code == 200
    text = response.text
    assert "event: agent_step_started" in text
    assert "event: agent_thinking_delta" in text
    assert "event: research_progress" in text
    assert "event: tool_call_started" in text
    assert "event: agent_message_delta" in text
    assert "event: run_completed" in text

    envelope = client.get(f"/v1/chat/sessions/{session_id}/runs/{run_id}").json()
    assert envelope["status"] == "succeeded"
    assert any(
        event["event_type"] == "research_progress"
        and event["payload"]["kind"] == "deep_research_progress"
        for event in envelope["events"]
    )
    assert any(event["event_type"] == "tool_call_completed" for event in envelope["events"])

    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    roles = [message["role"] for message in session["messages"]]
    assert "user" in roles
    assert "assistant" in roles
    assert any(message["role"] == "assistant" and message["content"] == "已完成分析" for message in session["messages"])


def test_wiki_agent_run_streams_sources_answer_and_persists(monkeypatch: Any) -> None:
    import workflow.wiki_cli as wiki_cli

    created = client.post("/v1/chat/sessions", json={"initial_query": "wiki stream"}).json()
    session_id = created["session_id"]

    monkeypatch.setattr(
        wiki_cli,
        "answer_wiki_query",
        lambda *args, **kwargs: {
            "answer": "舆情方法论包括议题识别、传播链路分析和风险研判。",
            "sources": [{"title": "舆情方法论", "path": "concepts/method.md"}],
        },
    )

    run = client.post(
        f"/v1/chat/sessions/{session_id}/runs",
        json={"query": "舆情方法论", "mode": "wiki", "command": "/wiki"},
    )
    assert run.status_code == 200
    assert run.json()["session_id"] == session_id

    response = client.get(f"/v1/chat/sessions/{session_id}/runs/{run.json()['run_id']}/events")
    assert response.status_code == 200
    text = response.text
    assert "event: agent_step_started" in text
    assert "wiki_retrieve" in text
    assert "event: tool_call_started" in text
    assert "event: tool_call_completed" in text
    assert "event: agent_message_delta" in text
    assert "event: run_completed" in text

    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    assert session["session_id"] == session_id
    assert [message["role"] for message in session["messages"]] == ["user", "assistant"]
    assert "舆情方法论" in session["messages"][1]["content"]
    assert any(event["event_type"] == "tool_call_completed" for event in session["agent_events"])


def test_agent_run_archived_session_restores_tool_context(monkeypatch: Any) -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "tool context"}).json()
    session_id = created["session_id"]
    captured: dict[str, Any] = {}

    monkeypatch.setattr("cli.router.route_query", lambda query, session_id: ("reactagent", {}))

    def fake_agent_stream(*args: Any, **kwargs: Any):
        captured["previous_messages"] = kwargs.get("previous_messages")
        yield {
            "type": "tool_call",
            "tool_name": "search",
            "args": {"q": "大熊猫"},
            "run_id": "tool-1",
        }
        yield {
            "type": "tool_result",
            "tool_name": "search",
            "result": "采集完成",
            "run_id": "tool-1",
        }
        yield {"type": "token", "content": "完成", "accumulated": "完成"}

    monkeypatch.setattr("agent.reactagent.stream", fake_agent_stream)

    run = client.post(
        f"/v1/chat/sessions/{session_id}/runs",
        json={"query": "用工具查一下大熊猫"},
    ).json()
    response = client.get(f"/v1/chat/sessions/{session_id}/runs/{run['run_id']}/events")
    assert response.status_code == 200

    assert captured["previous_messages"] == []

    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    restored = messages_from_session_data(session)
    assert any(isinstance(message, AIMessage) and message.tool_calls for message in restored)
    assert any(isinstance(message, ToolMessage) and message.tool_call_id == "tool-1" for message in restored)


def test_agent_run_does_not_archive_internal_mode_node(monkeypatch: Any) -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "mode node"}).json()
    session_id = created["session_id"]

    monkeypatch.setattr("cli.router.route_query", lambda query, session_id: ("reactagent", {}))

    def fake_agent_stream(*args: Any, **kwargs: Any):
        yield {
            "type": "tool_call",
            "tool_name": "full_report_mode_node",
            "args": {"query": "舆情分析方法"},
            "run_id": "mode-full",
        }
        yield {
            "type": "tool_result",
            "tool_name": "full_report_mode_node",
            "result": "file:///tmp/report.html",
            "run_id": "mode-full",
        }
        yield {"type": "token", "content": "完成", "accumulated": "完成"}

    monkeypatch.setattr("agent.reactagent.stream", fake_agent_stream)

    run = client.post(
        f"/v1/chat/sessions/{session_id}/runs",
        json={"query": "舆情分析方法"},
    ).json()
    response = client.get(f"/v1/chat/sessions/{session_id}/runs/{run['run_id']}/events")
    assert response.status_code == 200

    session = client.get(f"/v1/chat/sessions/{session_id}").json()
    archived = json.dumps(session["messages"], ensure_ascii=False)
    assert "full_report_mode_node" not in archived
    assert session["messages"][-1]["role"] == "assistant"
    assert session["messages"][-1]["content"] == "完成"


def test_agent_run_events_reconnect_waits_for_live_events() -> None:
    created = client.post("/v1/chat/sessions", json={"initial_query": "reconnect"}).json()
    run = client.post(
        f"/v1/chat/sessions/{created['session_id']}/runs",
        json={"query": "保持连接"},
    ).json()
    record = get_agent_run_store().get(run["run_id"])
    assert record is not None
    record.started = True
    record.add_event("agent_step_started", status="running", title="已开始", detail="回放事件")

    def finish_run() -> None:
        time.sleep(0.05)
        record.add_event("run_completed", status="succeeded", title="完成", detail="实时补到")
        record.finished = True

    thread = threading.Thread(target=finish_run)
    thread.start()
    response = client.get(f"/v1/chat/sessions/{created['session_id']}/runs/{run['run_id']}/events")
    thread.join(timeout=2)

    assert response.status_code == 200
    assert "event: agent_step_started" in response.text
    assert "event: run_completed" in response.text
    assert "实时补到" in response.text


def test_approval_plugin_payload_matches_lobe_intervention_shape() -> None:
    payload = server._approval_plugin_payload(  # noqa: SLF001
        "approval-1",
        "建议搜索采集方案（等待确认）",
        "请确认是否执行",
        {"platforms": ["微博"]},
    )

    assert payload["toolCallId"] == "approval-1"
    assert payload["identifier"] == "sona.deep_research"
    assert payload["intervention"]["status"] == "pending"
    assert payload["intervention"]["actions"] == ["accept", "edit", "abort"]
    assert payload["intervention"]["payload"]["platforms"] == ["微博"]


def test_analyze_event_failure_is_logged(monkeypatch: Any) -> None:
    log_dir = Path(".pytest_cache") / "sona_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"debug_{uuid.uuid4().hex}.log"

    monkeypatch.setattr(event_runner, "LOG_PATH", str(log_path))
    monkeypatch.setattr(event_runner, "route_query", lambda query, session_id: ("event", {}))

    def fail_workflow(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("data_collect failed: playwright executable missing")

    monkeypatch.setattr(event_runner, "run_event_analysis_workflow", fail_workflow)

    envelope = event_runner.run_analyze_event(
        AnalyzeEventRequest(query="测试事件", disable_blocking_prompts=True),
    )

    assert envelope.status == "failed"
    assert envelope.artifacts.trace_path == str(log_path)
    assert envelope.error is not None
    assert "playwright executable missing" in envelope.error.error_message
    assert log_path.exists()
    log_text = log_path.read_text(encoding="utf-8")
    assert "API_EVENT_WORKFLOW_FAILED" in log_text
    assert "playwright executable missing" in log_text


def test_wiki_and_case_endpoints(monkeypatch: Any) -> None:
    import workflow.wiki_cli as wiki_cli

    monkeypatch.setattr(
        wiki_cli,
        "answer_wiki_query",
        lambda *args, **kwargs: {"answer": "wiki answer", "sources": [{"title": "source"}]},
    )
    monkeypatch.setattr(
        wiki_cli,
        "answer_case_query",
        lambda *args, **kwargs: {"answer": "case answer", "cases": [], "comparison": ""},
    )

    created = client.post("/v1/chat/sessions", json={"initial_query": "wiki case persistence"}).json()

    wiki = client.post(
        "/v1/wiki/query",
        json={"query": "什么是舆情反转？", "session_id": created["session_id"]},
    )
    assert wiki.status_code == 200
    assert wiki.json()["answer"] == "wiki answer"

    case = client.post(
        "/v1/cases/search",
        json={"query": "高铁服务争议", "session_id": created["session_id"]},
    )
    assert case.status_code == 200
    assert case.json()["answer"] == "case answer"

    session = client.get(f"/v1/chat/sessions/{created['session_id']}").json()
    assert [message["role"] for message in session["messages"]] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert session["messages"][1]["content"] == "wiki answer"
    assert session["messages"][3]["content"] == "case answer"


def test_models_tools_and_monitor_contracts(monkeypatch: Any) -> None:
    fake_tool = types.SimpleNamespace(name="fake_tool", description="描述：用于测试。输入：无")
    monkeypatch.setitem(sys.modules, "agent.reactagent", types.SimpleNamespace(AGENT_TOOLS=[fake_tool]))

    models = client.get("/v1/models")
    assert models.status_code == 200
    assert isinstance(models.json()["models"], list)

    tools = client.get("/v1/tools")
    assert tools.status_code == 200
    assert tools.json()["tools"][0]["name"] == "fake_tool"

    commands = client.get("/v1/commands")
    assert commands.status_code == 200
    payload = commands.json()["commands"]
    assert any(item["command"] == "/event" for item in payload)
    assert any(item["action"] == "run" and item["default_query"] == "/monitor list" for item in payload)

    created = client.post(
        "/v1/monitor/topics",
        json={
            "name": "测试专题",
            "domain": "测试",
            "keywords": ["测试"],
            "run_initial_cycle": True,
        },
    )
    assert created.status_code == 200
    topic_id = created.json()["topic"]["id"]

    status = client.get(f"/v1/monitor/topics/{topic_id}/status")
    assert status.status_code == 200
    assert status.json()["topic"]["id"] == topic_id

    report = client.post(f"/v1/monitor/topics/{topic_id}/report", json={"period": "daily"})
    assert report.status_code == 200
    assert report.json()["report_path"]

