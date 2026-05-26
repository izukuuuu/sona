"""FastAPI application skeleton for Sona HTTP API."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from api.event_runner import run_analyze_event
from api.agent_run_store import AgentRunRecord, get_agent_run_store
from api.report_utils import build_task_envelope_from_session, resolve_report_path_for_task
from api.schema import (
    AgentApprovalRequest,
    AgentEventType,
    AgentRunCreateRequest,
    AgentRunEnvelope,
    AgentRunStatus,
    AnalyzeEventRequest,
    ArtifactPathResponse,
    CaseSearchRequest,
    ChatMessageRequest,
    HealthResponse,
    HotRunRequest,
    ModelInfo,
    ModelListResponse,
    MonitorReportRequest,
    MonitorTopicCreateRequest,
    MonitorTopicListResponse,
    MemorySettings,
    MemorySettingsResponse,
    MemorySettingsUpdateRequest,
    SessionCreateRequest,
    SessionEnvelope,
    SessionListResponse,
    SessionMessageUpdateRequest,
    SessionUpdateRequest,
    SkillInfo,
    SkillListResponse,
    TaskEnvelope,
    TaskListResponse,
    TaskStatus,
    ComposerCommand,
    ComposerCommandListResponse,
    ToolInfo,
    ToolListResponse,
    WikiApproveRequest,
    WikiQueryRequest,
)
from api.task_store import TaskStore, get_task_store
from utils.harness_memory import get_session_prefs, normalize_session_pref_patch, set_session_prefs
from utils.message_utils import messages_from_session_data
from utils.path import ensure_task_dirs, get_memory_dir, get_project_root
from utils.session_manager import get_session_manager


def _cors_settings() -> tuple[list[str], bool]:
    """Return (allow_origins, allow_credentials)."""
    raw = os.environ.get("SONA_API_CORS_ORIGINS", "").strip()
    if raw == "*":
        return ["*"], False
    if raw:
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        return origins, True
    return (
        [
            "http://127.0.0.1:8501",
            "http://localhost:8501",
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.1:8765",
            "http://localhost:8765",
        ],
        True,
    )


v1_router = APIRouter(prefix="/v1", tags=["workflows"])


def _session_envelope(data: Dict[str, Any]) -> SessionEnvelope:
    """Normalize loose session JSON into the public session shape."""
    return SessionEnvelope(
        schema_version=int(data.get("schema_version") or 3),
        task_id=str(data.get("task_id") or ""),
        created_at=str(data.get("created_at") or ""),
        updated_at=str(data.get("updated_at") or ""),
        status=str(data.get("status") or "active"),
        description=str(data.get("description") or ""),
        initial_query=str(data.get("initial_query") or ""),
        messages=data.get("messages") if isinstance(data.get("messages"), list) else [],
        agent_events=data.get("agent_events") if isinstance(data.get("agent_events"), list) else [],
        token_usage=data.get("token_usage") if isinstance(data.get("token_usage"), dict) else {},
    )


def _sse(event_name: str, payload: Dict[str, Any]) -> str:
    """Format one server-sent event frame."""
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _message_content(message: Any) -> str:
    """Extract printable content from LangChain messages or plain values."""
    if hasattr(message, "content"):
        return str(getattr(message, "content") or "")
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(message or "")


def _tool_calls(message: Any) -> list[dict[str, Any]]:
    raw = getattr(message, "tool_calls", None) or []
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item)
        else:
            out.append(
                {
                    "name": getattr(item, "name", ""),
                    "args": getattr(item, "args", {}),
                    "id": getattr(item, "id", ""),
                }
            )
    return out


def _looks_like_tool_result_json(content: str) -> bool:
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(parsed, dict):
        return False
    tool_result_fields = {
        "eventIntroduction",
        "searchWords",
        "timeRange",
        "search_matrix",
        "result_file_path",
        "save_path",
        "html_file_path",
        "file_url",
    }
    return any(field in parsed for field in tool_result_fields)


def _execution_plan_steps(route_decision: str, route_data: Dict[str, Any]) -> list[str]:
    intent_result = route_data.get("intent_result")
    data_result = route_data.get("data_result")
    has_data = bool(getattr(data_result, "has_data", False)) if data_result is not None else False

    if route_decision in ("event_analysis_workflow", "event_analysis_with_existing_data"):
        if has_data and route_decision == "event_analysis_with_existing_data":
            steps = [
                "extract_search_terms（确认事件与关键词）",
                "复用已有数据（跳过 data_collect）",
                "analysis_timeline（时间线）",
                "analysis_sentiment（情感）",
                "keyword/region/author/volume 统计",
                "report_html（生成报告）",
            ]
        else:
            steps = [
                "extract_search_terms（提取事件与检索参数）",
                "data_num（关键词数量分配）",
                "data_collect（采集数据）",
                "analysis_timeline（时间线）",
                "analysis_sentiment（情感）",
                "keyword/region/author/volume 统计",
                "report_html（生成报告）",
            ]
    elif route_decision == "event_brief_workflow":
        steps = [
            "extract_search_terms（提取事件简介/关键词/时间范围）",
            "输出轻量事件概述（不采集、不生成长报告）",
        ]
    elif route_decision == "hottopics_workflow":
        steps = ["run_hot_command（热点聚合与态势感知）", "输出热点分析结果"]
    else:
        steps = ["reactagent（按 ReAct 决策按需调用工具）", "返回问答结果"]

    reason = str(getattr(intent_result, "reasoning", "") or "").strip()
    if reason:
        steps.insert(0, f"路由依据：{reason}")
    return steps


def _research_phase(step: str, title: str) -> str:
    text = f"{step} {title}".lower()
    if "collect_plan" in text or "confirm" in text:
        return "approval"
    if "extract" in text or "step1" in text or "search_terms" in text:
        return "plan"
    if "data_num" in text or "data_collect" in text or "step3" in text or "step4" in text:
        return "search"
    if "dataset" in text or "stats" in text or "timeline" in text or "sentiment" in text:
        return "analyze"
    if "interpretation" in text or "rag" in text or "wiki" in text or "oprag" in text:
        return "synthesize"
    if "report" in text or "done" in text:
        return "report"
    return "research"


def _research_progress_payload(progress_event: Dict[str, Any]) -> Dict[str, Any]:
    step = str(progress_event.get("step") or "")
    title = str(progress_event.get("title") or "")
    payload = progress_event.get("payload") if isinstance(progress_event.get("payload"), dict) else {}
    phase = str(payload.get("phase") or _research_phase(step, title))
    status = "completed" if step == "done" else "running"
    return {
        "kind": "deep_research_progress",
        "phase": phase,
        "step": step,
        "status": status,
        "detail": str(progress_event.get("detail") or ""),
        "payload": payload,
    }


def _approval_plugin_payload(event_id: str, title: str, detail: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "toolCallId": event_id,
        "apiName": "confirm_collect_plan",
        "identifier": "sona.deep_research",
        "type": "builtin",
        "arguments": json.dumps(payload, ensure_ascii=False),
        "state": {"status": "pending"},
        "intervention": {
            "status": "pending",
            "title": title,
            "prompt": detail,
            "actions": ["accept", "edit", "abort"],
            "payload": payload,
        },
    }


def _sync_session_to_task_store(
    task_id: str,
    *,
    failed: bool = False,
    error_message: str = "",
) -> None:
    """Mirror chat session workflow output into the in-memory task store."""
    get_task_store().put(
        build_task_envelope_from_session(
            task_id,
            failed=failed,
            error_message=error_message,
        )
    )


def _persist_agent_event(task_id: str, event: Dict[str, Any]) -> None:
    get_session_manager().add_agent_event(task_id, {"event": "agent_run_event", **event})


def _agent_run_event_frame(record: AgentRunRecord, event: Dict[str, Any]) -> str:
    payload = dict(event)
    payload.setdefault("run_id", record.run_id)
    payload.setdefault("task_id", record.task_id)
    payload.setdefault("turn_id", record.turn_id)
    return _sse(str(payload.get("event_type") or "agent_event"), payload)


def _previous_messages_before_query(session_data: Dict[str, Any], query: str) -> list[Any]:
    """Return chat history without the current user query just persisted for the run."""
    normalized_query = query.strip()
    messages = session_data.get("messages") if isinstance(session_data.get("messages"), list) else []
    for index in range(len(messages) - 1, -1, -1):
        item = messages[index]
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        if str(item.get("content") or "").strip() == normalized_query:
            session_data = {**session_data, "messages": [*messages[:index], *messages[index + 1 :]]}
        break
    return messages_from_session_data(session_data)


def _append_agent_event(
    record: AgentRunRecord,
    event_queue: "queue.Queue[Dict[str, Any]]",
    event_type: AgentEventType | str,
    *,
    status: str = "",
    title: str = "",
    detail: str = "",
    payload: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    event = record.add_event(
        event_type,
        status=status,
        title=title,
        detail=detail,
        payload=payload or {},
    )
    data = event.model_dump(mode="json")
    event_id = str(data.get("event_id") or "")
    plugin = data.get("payload", {}).get("plugin") if isinstance(data.get("payload"), dict) else None
    if isinstance(plugin, dict) and plugin.get("toolCallId") == "__event_id__":
        plugin["toolCallId"] = event_id
        intervention = plugin.get("intervention")
        if isinstance(intervention, dict):
            intervention.setdefault("approvalEventId", event_id)
    _persist_agent_event(record.task_id, data)
    event_queue.put(data)
    return data


def _agent_run_stream(record: AgentRunRecord) -> Iterable[str]:
    """Run or replay a frontend Agent run as canonical SSE events."""
    import queue

    from agent.reactagent import stream as agent_stream
    from cli.router import route_query

    event_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
    manager = get_session_manager()

    if record.started:
        replay_index = 0
        while True:
            while replay_index < len(record.events):
                event = record.events[replay_index]
                replay_index += 1
                yield _agent_run_event_frame(record, event.model_dump(mode="json"))
            if record.finished:
                return
            time.sleep(0.2)

    record.started = True

    def worker() -> None:
        streamed_content = ""
        try:
            record.status = AgentRunStatus.RUNNING
            _append_agent_event(
                record,
                event_queue,
                AgentEventType.AGENT_STEP_STARTED,
                status="running",
                title="路由与执行计划",
                detail="正在判断任务类型并准备执行。",
            )

            route_decision = "reactagent"
            route_data: Dict[str, Any] = {}
            task_mode = "qa"
            workflow_options: Dict[str, Any] = dict(record.options.get("workflow_options") or {})
            if record.options.get("auto_route", True):
                route_decision, route_data = route_query(record.query, record.task_id)
                data_result = route_data.get("data_result")
                route_policy = route_data.get("route_policy", {}) or {}
                if route_decision in ("event_analysis_workflow", "event_analysis_with_existing_data"):
                    task_mode = "full_report"
                    workflow_options.setdefault("report_length", route_policy.get("report_length") or "中篇")
                    if (
                        record.options.get("prefer_existing_data", True)
                        and data_result
                        and getattr(data_result, "has_data", False)
                        and getattr(data_result, "data_paths", None)
                    ):
                        workflow_options["existing_data_path"] = data_result.data_paths[0]
                        workflow_options["skip_data_collect"] = True
                elif route_decision == "event_brief_workflow":
                    task_mode = "brief"

            _append_agent_event(
                record,
                event_queue,
                AgentEventType.AGENT_STEP_COMPLETED,
                status="completed",
                title="路由完成",
                detail=f"{route_decision} · {task_mode}",
                payload={"route": route_decision, "task_mode": task_mode},
            )

            for index, step in enumerate(_execution_plan_steps(route_decision, route_data), start=1):
                _append_agent_event(
                    record,
                    event_queue,
                    AgentEventType.AGENT_STEP_STARTED,
                    status="running",
                    title=f"执行计划 {index}",
                    detail=step,
                    payload={"step": f"plan_{index}"},
                )

            def approval_hook(progress_event: Dict[str, Any]) -> Dict[str, Any] | None:
                step = str(progress_event.get("step") or "")
                title = str(progress_event.get("title") or "")
                if step != "collect_plan" and "采集方案" not in title:
                    return None
                payload = progress_event.get("payload")
                if not isinstance(payload, dict):
                    payload = {}
                approval = _append_agent_event(
                    record,
                    event_queue,
                    AgentEventType.APPROVAL_REQUESTED,
                    status="pending",
                    title=title or "建议搜索采集方案（等待确认）",
                    detail=str(progress_event.get("detail") or ""),
                    payload={
                        **payload,
                        "plugin": _approval_plugin_payload(
                            "__event_id__",
                            title or "建议搜索采集方案（等待确认）",
                            str(progress_event.get("detail") or ""),
                            payload,
                        ),
                    },
                )
                record.status = AgentRunStatus.WAITING_APPROVAL
                record.pending_approval_id = str(approval.get("event_id") or "")
                with record.approval_condition:
                    while record.approval_decision is None:
                        record.approval_condition.wait(timeout=1.0)
                    decision = dict(record.approval_decision)
                    record.approval_decision = None
                action = str(decision.get("action") or "accept")
                if action == "abort":
                    record.status = AgentRunStatus.ABORTED
                    approval_event_id = record.pending_approval_id
                    record.pending_approval_id = ""
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.APPROVAL_RESOLVED,
                        status="aborted",
                        title="采集方案已终止",
                        detail="用户终止了本次工作流。",
                        payload={
                            "approval_event_id": approval_event_id,
                            "action": action,
                            "plugin": {
                                "toolCallId": approval_event_id,
                                "apiName": "confirm_collect_plan",
                                "identifier": "sona.deep_research",
                                "type": "builtin",
                                "state": {"status": "aborted"},
                                "intervention": {"status": "aborted", "action": action},
                            },
                        },
                    )
                    raise RuntimeError("Agent run aborted by user")
                if action == "edit":
                    patch = decision.get("patch") if isinstance(decision.get("patch"), dict) else {}
                    payload.update(patch)
                record.status = AgentRunStatus.RUNNING
                approval_event_id = record.pending_approval_id
                record.pending_approval_id = ""
                _append_agent_event(
                    record,
                    event_queue,
                    AgentEventType.APPROVAL_RESOLVED,
                    status="accepted" if action == "accept" else "edited",
                    title="采集方案已确认",
                    detail="用户已确认采集方案，工作流继续执行。",
                    payload={
                        "approval_event_id": approval_event_id,
                        "action": action,
                        "patch": decision.get("patch") if isinstance(decision.get("patch"), dict) else {},
                        "plugin": {
                            "toolCallId": approval_event_id,
                            "apiName": "confirm_collect_plan",
                            "identifier": "sona.deep_research",
                            "type": "builtin",
                            "state": {"status": "success"},
                            "intervention": {
                                "status": "accepted" if action == "accept" else "edited",
                                "action": action,
                                "patch": decision.get("patch") if isinstance(decision.get("patch"), dict) else {},
                            },
                        },
                    },
                )
                return {"action": action, "patch": decision.get("patch") if isinstance(decision.get("patch"), dict) else {}}

            workflow_options["_web_progress_hook"] = approval_hook

            session_data = manager.load_session(record.task_id) or {}
            previous_messages = _previous_messages_before_query(session_data, record.query)
            assistant_persisted = False
            for item in agent_stream(
                record.query,
                task_id=record.task_id,
                previous_messages=previous_messages,
                task_mode=task_mode,
                workflow_options=workflow_options,
            ):
                if not isinstance(item, dict):
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.AGENT_STEP_UPDATED,
                        status="running",
                        title="状态更新",
                        detail=str(item),
                    )
                    continue
                item_type = str(item.get("type") or "")
                if item_type == "token":
                    accumulated = str(item.get("accumulated") or "")
                    if accumulated:
                        streamed_content = accumulated
                    elif item.get("content"):
                        streamed_content += str(item.get("content") or "")
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.AGENT_MESSAGE_DELTA,
                        status="running",
                        title="回复生成",
                        detail=streamed_content,
                        payload={"content": item.get("content", ""), "accumulated": streamed_content},
                    )
                elif item_type == "message":
                    content = _message_content(item.get("message")).strip()
                    if content:
                        streamed_content = content
                        manager.add_message(record.task_id, "assistant", content)
                        assistant_persisted = True
                        _append_agent_event(
                            record,
                            event_queue,
                            AgentEventType.AGENT_MESSAGE_DELTA,
                            status="running",
                            title="回复生成",
                            detail=content,
                        )
                elif item_type == "tool_call":
                    tool_call_id = str(item.get("run_id") or "")
                    if tool_call_id:
                        manager.add_message(
                            record.task_id,
                            "assistant",
                            "",
                            tool_calls=[
                                {
                                    "name": str(item.get("tool_name") or "unknown"),
                                    "args": item.get("args", {}),
                                    "id": tool_call_id,
                                }
                            ],
                        )
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.TOOL_CALL_STARTED,
                        status="running",
                        title=str(item.get("tool_name") or "工具调用"),
                        detail=json.dumps(item.get("args", {}), ensure_ascii=False, indent=2),
                        payload={"tool_name": item.get("tool_name", ""), "args": item.get("args", {}), "run_id": item.get("run_id", "")},
                    )
                elif item_type == "tool_result":
                    result = str(item.get("result") or "")
                    manager.add_message(
                        record.task_id,
                        "tool",
                        result,
                        tool_name=str(item.get("tool_name") or "unknown"),
                        tool_call_id=str(item.get("run_id") or ""),
                    )
                    event_type = AgentEventType.TOOL_CALL_COMPLETED
                    if "report" in str(item.get("tool_name") or "").lower() or "report_" in result:
                        event_type = AgentEventType.ARTIFACT_CREATED
                    _append_agent_event(
                        record,
                        event_queue,
                        event_type,
                        status="completed",
                        title=str(item.get("tool_name") or "工具结果"),
                        detail=result,
                        payload={"tool_name": item.get("tool_name", ""), "result": result, "run_id": item.get("run_id", "")},
                    )
                elif item_type == "workflow_step":
                    research_payload = _research_progress_payload(item)
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.RESEARCH_PROGRESS,
                        status=str(research_payload.get("status") or "running"),
                        title=str(item.get("title") or "深度研究进度"),
                        detail=str(item.get("detail") or ""),
                        payload=research_payload,
                    )
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.AGENT_STEP_UPDATED,
                        status="running",
                        title=str(item.get("title") or "工作流"),
                        detail=str(item.get("detail") or ""),
                        payload={"step": str(item.get("step") or ""), "payload": item.get("payload", {})},
                    )
                elif item_type == "compression":
                    _append_agent_event(
                        record,
                        event_queue,
                        AgentEventType.AGENT_STEP_COMPLETED,
                        status="completed",
                        title="上下文压缩",
                        detail=str(item.get("summary") or item.get("message") or "上下文已压缩"),
                    )

            if streamed_content.strip() and not assistant_persisted:
                manager.add_message(record.task_id, "assistant", streamed_content.strip())
            record.status = AgentRunStatus.SUCCEEDED
            _sync_session_to_task_store(record.task_id)
            _append_agent_event(
                record,
                event_queue,
                AgentEventType.RUN_COMPLETED,
                status="succeeded",
                title="工作流完成",
                detail="本次 Agent run 已完成。",
            )
        except Exception as exc:  # noqa: BLE001
            if record.status == AgentRunStatus.ABORTED:
                _sync_session_to_task_store(record.task_id, failed=True, error_message="Agent run aborted by user")
                _append_agent_event(
                    record,
                    event_queue,
                    AgentEventType.RUN_FAILED,
                    status="aborted",
                    title="工作流已终止",
                    detail="用户终止了本次工作流。",
                )
            else:
                record.status = AgentRunStatus.FAILED
                _sync_session_to_task_store(record.task_id, failed=True, error_message=str(exc))
                _append_agent_event(
                    record,
                    event_queue,
                    AgentEventType.RUN_FAILED,
                    status="failed",
                    title="工作流失败",
                    detail=str(exc),
                )
        finally:
            record.finished = True
            event_queue.put({"event_type": "__end__"})

    threading.Thread(target=worker, daemon=True).start()
    while True:
        event = event_queue.get()
        if event.get("event_type") == "__end__":
            break
        yield _agent_run_event_frame(record, event)


def _chat_stream(
    *,
    task_id: str,
    body: ChatMessageRequest,
) -> Iterable[str]:
    """Bridge agent stream events into SSE while keeping SessionManager updated."""
    from agent.reactagent import stream as agent_stream
    from cli.router import route_query

    manager = get_session_manager()
    session_data = manager.load_session(task_id)
    if not session_data:
        yield _sse("error", {"error": "SESSION_NOT_FOUND", "message": "Session not found"})
        return

    query = body.query.strip()
    route_decision = "reactagent"
    route_data: Dict[str, Any] = {}
    task_mode = "qa"
    workflow_options: Dict[str, Any] = dict(body.workflow_options or {})
    previous_messages = messages_from_session_data(session_data)

    if body.auto_route:
        try:
            route_decision, route_data = route_query(query, task_id)
            data_result = route_data.get("data_result")
            route_policy = route_data.get("route_policy", {}) or {}
            if route_decision in ("event_analysis_workflow", "event_analysis_with_existing_data"):
                task_mode = "full_report"
                workflow_options.setdefault("report_length", route_policy.get("report_length") or "中篇")
                if (
                    body.prefer_existing_data
                    and data_result
                    and getattr(data_result, "has_data", False)
                    and getattr(data_result, "data_paths", None)
                ):
                    workflow_options["existing_data_path"] = data_result.data_paths[0]
                    workflow_options["skip_data_collect"] = True
            elif route_decision == "event_brief_workflow":
                task_mode = "brief"
            elif route_decision == "hottopics_workflow":
                yield _sse("route", {"route": route_decision, "task_mode": "hot"})
                yield from _run_hot_as_sse()
                manager.add_message(task_id, "user", query)
                manager.add_message(task_id, "assistant", "已执行热点态势感知流程。")
                return
        except Exception as exc:  # noqa: BLE001
            yield _sse("route_error", {"message": str(exc)})

    yield _sse("route", {"route": route_decision, "task_mode": task_mode})
    for index, step in enumerate(_execution_plan_steps(route_decision, route_data), start=1):
        yield _sse(
            "workflow_step",
            {
                "step": f"plan_{index}",
                "title": f"执行计划 {index}",
                "detail": step,
            },
        )
    manager.add_message(task_id, "user", query)

    streamed_content = ""

    def _persist_streamed_reply() -> None:
        """Persist token-streamed assistant text when no final message was saved."""
        nonlocal streamed_content
        text = streamed_content.strip()
        if not text:
            return
        session = manager.load_session(task_id) or {}
        messages = session.get("messages") if isinstance(session.get("messages"), list) else []
        last = messages[-1] if messages else None
        if (
            isinstance(last, dict)
            and last.get("role") == "assistant"
            and str(last.get("content") or "").strip() == text
        ):
            streamed_content = ""
            return
        manager.add_message(task_id, "assistant", text)
        streamed_content = ""

    try:
        for item in agent_stream(
            query,
            task_id=task_id,
            previous_messages=previous_messages,
            task_mode=task_mode,
            workflow_options=workflow_options,
        ):
            if not isinstance(item, dict):
                yield _sse("state_update", {"value": str(item)})
                continue

            item_type = str(item.get("type") or "state_update")
            if item_type == "message":
                content = _message_content(item.get("message")).strip()
                calls = _tool_calls(item.get("message"))
                is_tool_result_json = bool(content and not calls and _looks_like_tool_result_json(content))
                if content or calls:
                    if calls or not is_tool_result_json:
                        manager.add_message(task_id, "assistant", content, tool_calls=calls or None)
                    streamed_content = ""
                yield _sse(
                    "message",
                    {
                        "message_id": item.get("message_id", ""),
                        "content": "" if is_tool_result_json else content,
                        "tool_calls": calls,
                    },
                )
            elif item_type == "tool_call":
                tool_call_id = str(item.get("run_id") or "")
                if tool_call_id:
                    manager.add_message(
                        task_id,
                        "assistant",
                        "",
                        tool_calls=[
                            {
                                "name": str(item.get("tool_name") or "unknown"),
                                "args": item.get("args", {}),
                                "id": tool_call_id,
                            }
                        ],
                    )
                yield _sse(
                    "tool_call",
                    {
                        "tool_name": item.get("tool_name", ""),
                        "args": item.get("args", {}),
                        "run_id": item.get("run_id", ""),
                    },
                )
            elif item_type == "tool_result":
                result = str(item.get("result") or "")
                manager.add_message(
                    task_id,
                    "tool",
                    result,
                    tool_name=str(item.get("tool_name") or "unknown"),
                    tool_call_id=str(item.get("run_id") or ""),
                )
                yield _sse(
                    "tool_result",
                    {
                        "tool_name": item.get("tool_name", ""),
                        "result": result,
                        "run_id": item.get("run_id", ""),
                    },
                )
            elif item_type == "token":
                accumulated = str(item.get("accumulated") or "")
                if accumulated:
                    streamed_content = accumulated
                elif item.get("content"):
                    streamed_content += str(item.get("content") or "")
                yield _sse(
                    "token",
                    {
                        "content": item.get("content", ""),
                        "message_id": item.get("message_id", ""),
                        "accumulated": streamed_content,
                    },
                )
            elif item_type == "compression":
                compressed = item.get("compressed_messages")
                if isinstance(compressed, list):
                    manager.replace_messages(task_id, compressed, reset_token_usage=True)
                yield _sse("compression", item)
            elif item_type == "workflow_step":
                workflow_event = {
                    "event": "workflow_step",
                    "step": str(item.get("step") or ""),
                    "title": str(item.get("title") or ""),
                    "detail": str(item.get("detail") or ""),
                    "payload": item.get("payload", {}),
                }
                manager.add_message(
                    task_id,
                    "system",
                    json.dumps(workflow_event, ensure_ascii=False),
                )
                yield _sse(
                    "workflow_step",
                    {
                        "step": workflow_event["step"],
                        "title": workflow_event["title"],
                        "detail": workflow_event["detail"],
                        "payload": workflow_event["payload"],
                    },
                )
            else:
                yield _sse(item_type, {"payload": item})
        _persist_streamed_reply()
        _sync_session_to_task_store(task_id)
        yield _sse("done", {"task_id": task_id})
    except Exception as exc:  # noqa: BLE001
        _persist_streamed_reply()
        _sync_session_to_task_store(task_id, failed=True, error_message=str(exc))
        yield _sse("error", {"error": "CHAT_STREAM_ERROR", "message": str(exc)})


def _run_hot_as_sse() -> Iterable[str]:
    yield _sse("tool_call", {"tool_name": "hottopics", "args": {}, "run_id": "hot"})
    try:
        from utils.hot_topics_env import ensure_hot_topics_cwd, prepare_hot_topics_environment

        prepare_hot_topics_environment()
        ensure_hot_topics_cwd()
        from tools.hottopics import run as run_hot_topics

        report_path = run_hot_topics(config_path=None)
        yield _sse("tool_result", {"tool_name": "hottopics", "result": report_path, "run_id": "hot"})
        yield _sse("message", {"content": f"热点态势报告已生成：{report_path or '未返回路径'}"})
        yield _sse("done", {"path": report_path})
    except Exception as exc:  # noqa: BLE001
        yield _sse("error", {"error": "HOT_WORKFLOW_ERROR", "message": str(exc)})


@v1_router.post("/analyze-event", response_model=TaskEnvelope)
def analyze_event(
    body: AnalyzeEventRequest,
    store: TaskStore = Depends(get_task_store),
) -> TaskEnvelope:
    """Run full event analysis (sync); result is stored for GET /v1/tasks/{task_id}."""
    envelope = run_analyze_event(body)
    store.put(envelope)
    return envelope


@v1_router.post("/chat/sessions", response_model=SessionEnvelope)
def create_chat_session(body: SessionCreateRequest) -> SessionEnvelope:
    """Create a frontend chat session, equivalent to CLI /new."""
    manager = get_session_manager()
    task_id = manager.create_session(body.initial_query.strip() or "Frontend session")
    ensure_task_dirs(task_id)
    data = manager.load_session(task_id) or {"task_id": task_id}
    return _session_envelope(data)


@v1_router.get("/chat/sessions", response_model=SessionListResponse)
def list_chat_sessions(limit: int = 20) -> SessionListResponse:
    """List persisted chat sessions, equivalent to CLI /memory."""
    manager = get_session_manager()
    sessions = [_session_envelope(item) for item in manager.list_sessions(limit=max(1, min(limit, 100)))]
    return SessionListResponse(sessions=sessions)


@v1_router.get("/chat/sessions/{task_id}", response_model=SessionEnvelope)
def get_chat_session(task_id: str) -> SessionEnvelope:
    """Return one persisted chat session."""
    data = get_session_manager().load_session(task_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_envelope(data)


@v1_router.patch("/chat/sessions/{task_id}", response_model=SessionEnvelope)
def update_chat_session(task_id: str, body: SessionUpdateRequest) -> SessionEnvelope:
    """Update persisted chat session metadata."""
    data = get_session_manager().update_session(
        task_id,
        description=body.description.strip() if body.description else None,
    )
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_envelope(data)


@v1_router.delete("/chat/sessions/{task_id}", response_model=SessionListResponse)
def delete_chat_session(task_id: str, limit: int = 20) -> SessionListResponse:
    """Delete a persisted chat session and return the remaining recent sessions."""
    manager = get_session_manager()
    if not manager.delete_session(task_id):
        raise HTTPException(status_code=404, detail="Session not found")
    get_task_store().delete(task_id)
    sessions = [_session_envelope(item) for item in manager.list_sessions(limit=max(1, min(limit, 100)))]
    return SessionListResponse(sessions=sessions)


@v1_router.patch("/chat/sessions/{task_id}/messages/{message_id}", response_model=SessionEnvelope)
def update_chat_message(
    task_id: str,
    message_id: str,
    body: SessionMessageUpdateRequest,
) -> SessionEnvelope:
    """Edit one persisted canonical message."""
    data = get_session_manager().update_message(
        task_id,
        message_id,
        content=body.content,
        mode=body.mode,
    )
    if data is None:
        raise HTTPException(status_code=404, detail="Session message not found")
    return _session_envelope(data)


@v1_router.delete("/chat/sessions/{task_id}/messages/{message_id}", response_model=SessionEnvelope)
def delete_chat_message(task_id: str, message_id: str, mode: str = "turn") -> SessionEnvelope:
    """Delete one persisted message or visible conversation turn."""
    if mode not in {"message", "turn", "branch"}:
        raise HTTPException(status_code=422, detail="mode must be message, turn, or branch")
    data = get_session_manager().delete_message(task_id, message_id, mode=mode)
    if data is None:
        raise HTTPException(status_code=404, detail="Session message not found")
    return _session_envelope(data)


@v1_router.post("/chat/sessions/{task_id}/runs", response_model=AgentRunEnvelope)
def create_agent_run(task_id: str, body: AgentRunCreateRequest) -> AgentRunEnvelope:
    """Create a canonical web Agent run; stream it from /events."""
    manager = get_session_manager()
    if manager.load_session(task_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=422, detail="query is required")
    manager.add_message(task_id, "user", query)
    record = get_agent_run_store().create(
        task_id=task_id,
        query=query,
        options={
            "auto_route": body.auto_route,
            "prefer_existing_data": body.prefer_existing_data,
            "workflow_options": body.workflow_options,
        },
    )
    return record.envelope()


@v1_router.get("/chat/sessions/{task_id}/runs/{run_id}", response_model=AgentRunEnvelope)
def get_agent_run(task_id: str, run_id: str) -> AgentRunEnvelope:
    """Return persisted web Agent run state."""
    record = get_agent_run_store().get(run_id)
    if record is None or record.task_id != task_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return record.envelope()


@v1_router.get("/chat/sessions/{task_id}/runs/{run_id}/events")
def stream_agent_run_events(task_id: str, run_id: str) -> StreamingResponse:
    """Stream canonical web Agent events for one run."""
    record = get_agent_run_store().get(run_id)
    if record is None or record.task_id != task_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return StreamingResponse(
        _agent_run_stream(record),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@v1_router.post("/chat/sessions/{task_id}/runs/{run_id}/approval", response_model=AgentRunEnvelope)
def resolve_agent_run_approval(task_id: str, run_id: str, body: AgentApprovalRequest) -> AgentRunEnvelope:
    """Resolve a pending Agent approval request."""
    record = get_agent_run_store().get(run_id)
    if record is None or record.task_id != task_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if record.status != AgentRunStatus.WAITING_APPROVAL or not record.pending_approval_id:
        raise HTTPException(status_code=409, detail="Agent run is not waiting for approval")
    with record.approval_condition:
        record.approval_decision = {"action": body.action, "patch": body.patch}
        record.approval_condition.notify_all()
    return record.envelope()


@v1_router.post("/chat/sessions/{task_id}/messages:stream")
def stream_chat_message(task_id: str, body: ChatMessageRequest) -> StreamingResponse:
    """Stream a chat response as SSE, including token/tool/message events."""
    if get_session_manager().load_session(task_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _chat_stream(task_id=task_id, body=body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@v1_router.post("/wiki/query")
def query_wiki(body: WikiQueryRequest) -> Dict[str, Any]:
    """Run local Wiki/RAG query, equivalent to CLI /wiki."""
    from workflow.wiki_cli import answer_wiki_query

    result = answer_wiki_query(
        body.query,
        topk=body.topk,
        style=body.style,
        weibo_aux=body.weibo_aux,
        project_root=get_project_root(),
    )
    if body.task_id:
        manager = get_session_manager()
        if manager.load_session(body.task_id):
            manager.add_message(body.task_id, "user", body.query)
            manager.add_message(body.task_id, "assistant", str(result.get("answer") or ""))
    return result


@v1_router.post("/wiki/approve")
def approve_wiki_candidate(body: WikiApproveRequest) -> Dict[str, Any]:
    """Approve latest or selected Wiki candidate, equivalent to CLI /wiki-approve."""
    from cli.wiki_ui import _approve_candidate_to_output, _pick_candidate

    root = get_project_root()
    candidate = _pick_candidate(root, selector=body.selector or None)
    if candidate is None:
        raise HTTPException(status_code=404, detail="No wiki candidate found")
    return _approve_candidate_to_output(root, candidate)


@v1_router.post("/cases/search")
def search_cases(body: CaseSearchRequest) -> Dict[str, Any]:
    """Search local case library, equivalent to CLI /case."""
    from workflow.wiki_cli import answer_case_query

    result = answer_case_query(body.query, project_root=get_project_root())
    if body.task_id:
        manager = get_session_manager()
        if manager.load_session(body.task_id):
            manager.add_message(body.task_id, "user", body.query)
            manager.add_message(body.task_id, "assistant", str(result.get("answer") or ""))
    return result


@v1_router.post("/hot/run", response_model=ArtifactPathResponse)
def run_hot(body: HotRunRequest) -> ArtifactPathResponse:
    """Run hot topics workflow, equivalent to CLI /hot."""
    from utils.hot_topics_env import ensure_hot_topics_cwd, prepare_hot_topics_environment

    prepare_hot_topics_environment()
    ensure_hot_topics_cwd()
    from tools.hottopics import run as run_hot_topics

    config_path = body.config_path.strip() or None
    report_path = run_hot_topics(config_path=config_path)
    return ArtifactPathResponse(path=report_path or "")


@v1_router.get("/models", response_model=ModelListResponse)
def list_models() -> ModelListResponse:
    """Return model configuration as JSON, equivalent to CLI /models."""
    import yaml

    config_path = get_project_root() / "config" / "model.yaml"
    if not config_path.is_file():
        raise HTTPException(status_code=404, detail="model.yaml not found")
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    descriptions = {
        "main": "主流程模型：作为 ReAct Agent 的底座",
        "tools": "工具模型：用于各种工具调用",
        "extract": "搜索词提取模型",
        "analysis": "分析模型：时间线、情感等",
        "report": "HTML 报告生成模型",
    }
    models: list[ModelInfo] = []
    for name in ["main", "tools", "extract", "analysis", "report"]:
        value = config.get(name)
        if not isinstance(value, dict):
            continue
        models.append(
            ModelInfo(
                name=name,
                description=descriptions.get(name, ""),
                provider=str(value.get("provider") or ""),
                model=str(value.get("model") or ""),
                api_key_env=str(value.get("api_key_env") or ""),
            )
        )
    return ModelListResponse(models=models)


def _extract_tool_description(text: str) -> str:
    if not text:
        return ""
    marker = "描述："
    if marker in text:
        text = text.split(marker, 1)[1]
    for section in ("使用时机：", "输入：", "输出：", "注意："):
        if section in text:
            text = text.split(section, 1)[0]
    return " ".join(text.split())[:600]


def _memory_settings_path() -> Path:
    return get_memory_dir() / "settings.json"


def _load_memory_settings() -> Dict[str, Any]:
    path = _memory_settings_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_memory_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    path = _memory_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    next_settings = dict(settings)
    next_settings["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    path.write_text(json.dumps(next_settings, ensure_ascii=False, indent=2), encoding="utf-8")
    return next_settings


def _memory_settings_model(data: Dict[str, Any] | None = None) -> MemorySettings:
    raw = dict(data or {})
    defaults = {
        "enable_memory": True,
        "wiki_style": "teach",
        "wiki_topk": 6,
        "wiki_weibo_aux": True,
        "updated_at": "",
    }
    defaults.update({key: value for key, value in raw.items() if value is not None})
    return MemorySettings.model_validate(defaults)


def _session_prefs_for_task(task_id: str | None) -> Dict[str, Any]:
    if not task_id:
        return {}
    data = get_session_manager().load_session(task_id)
    if data is None:
        return {}
    return get_session_prefs(data)


COMPOSER_COMMANDS: list[ComposerCommand] = [
    ComposerCommand(
        id="event",
        label="事件分析",
        command="/event",
        description="调用 POST /v1/analyze-event，生成事件脉络与 HTML 报告",
        action="prefill",
    ),
    ComposerCommand(
        id="wiki",
        label="知识库",
        command="/wiki",
        description="调用 POST /v1/wiki/query，查询本地 Wiki",
        action="prefill",
    ),
    ComposerCommand(
        id="case",
        label="案例检索",
        command="/case",
        description="调用 POST /v1/cases/search，检索历史案例",
        action="prefill",
    ),
    ComposerCommand(
        id="hot",
        label="热点",
        command="/hot",
        description="调用 POST /v1/hot/run",
        action="run",
        default_query="/hot",
    ),
    ComposerCommand(
        id="monitor_list",
        label="专题",
        command="/monitor",
        description="GET /v1/monitor/topics",
        action="run",
        default_query="/monitor list",
    ),
    ComposerCommand(
        id="monitor_demo",
        label="专题演示",
        command="/monitor",
        description="POST /v1/monitor/demo",
        action="run",
        default_query="/monitor demo",
    ),
    ComposerCommand(
        id="memory",
        label="最近话题",
        command="/memory",
        description="GET /v1/chat/sessions",
        action="run",
        default_query="/memory",
    ),
]


@v1_router.get("/commands", response_model=ComposerCommandListResponse)
def list_composer_commands() -> ComposerCommandListResponse:
    """Return slash-command shortcuts for the chat composer toolbar."""
    return ComposerCommandListResponse(commands=COMPOSER_COMMANDS)


@v1_router.get("/tools", response_model=ToolListResponse)
def list_tools() -> ToolListResponse:
    """Return agent tool metadata as JSON, equivalent to CLI /tools."""
    from agent.reactagent import AGENT_TOOLS

    tools: list[ToolInfo] = []
    for tool in AGENT_TOOLS:
        name = str(getattr(tool, "name", "") or tool)
        description = str(getattr(tool, "description", "") or getattr(tool, "__doc__", "") or "")
        tools.append(ToolInfo(name=name, description=_extract_tool_description(description)))
    return ToolListResponse(tools=tools)


@v1_router.get("/skills", response_model=SkillListResponse)
def list_skills() -> SkillListResponse:
    """Return backend skills available to the frontend settings screen."""
    from agent.reactagent import AGENT_TOOLS, QA_TOOLS

    seen: set[str] = set()
    skills: list[SkillInfo] = []
    for source, tool_group in (("agent_tool", AGENT_TOOLS), ("qa_tool", QA_TOOLS)):
        for tool in tool_group:
            name = str(getattr(tool, "name", "") or tool).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            description = str(getattr(tool, "description", "") or getattr(tool, "__doc__", "") or "")
            skills.append(
                SkillInfo(
                    id=name,
                    name=name,
                    description=_extract_tool_description(description),
                    source=source,
                    enabled=True,
                )
            )
    return SkillListResponse(skills=skills)


@v1_router.get("/settings/memory", response_model=MemorySettingsResponse)
def get_memory_settings(task_id: str | None = None) -> MemorySettingsResponse:
    """Return persisted memory settings and optional current-session prefs."""
    return MemorySettingsResponse(
        settings=_memory_settings_model(_load_memory_settings()),
        session_prefs=_session_prefs_for_task(task_id),
    )


@v1_router.patch("/settings/memory", response_model=MemorySettingsResponse)
def update_memory_settings(body: MemorySettingsUpdateRequest) -> MemorySettingsResponse:
    """Patch memory settings and mirror supported prefs into the selected session."""
    current = _memory_settings_model(_load_memory_settings()).model_dump()
    patch = body.model_dump(exclude_unset=True, exclude_none=True)
    task_id = str(patch.pop("task_id", "") or "").strip()
    if patch:
        current.update(patch)
        current = _save_memory_settings(_memory_settings_model(current).model_dump())

    session_prefs: Dict[str, Any] = {}
    if task_id and current.get("enable_memory", True):
        manager = get_session_manager()
        session_data = manager.load_session(task_id)
        if session_data is None:
            raise HTTPException(status_code=404, detail="Session not found")
        pref_patch = normalize_session_pref_patch(current)
        if pref_patch:
            session_data = set_session_prefs(session_data, patch=pref_patch)
            manager.save_session(task_id, session_data)
            session_prefs = _session_prefs_for_task(task_id)

    return MemorySettingsResponse(
        settings=_memory_settings_model(current),
        session_prefs=session_prefs,
    )


@v1_router.get("/monitor/topics", response_model=MonitorTopicListResponse)
def list_monitor_topics() -> MonitorTopicListResponse:
    """List monitoring topics, equivalent to /monitor list."""
    from workflow.topic_monitoring_pipeline import TopicMonitoringPipeline

    pipeline = TopicMonitoringPipeline()
    return MonitorTopicListResponse(topics=pipeline.db.list_monitor_topics())


@v1_router.post("/monitor/demo")
def run_monitor_demo() -> Dict[str, Any]:
    """Run built-in high-speed-rail monitor demo, equivalent to /monitor demo."""
    from workflow.topic_monitoring_pipeline import run_high_speed_rail_demo

    return run_high_speed_rail_demo()


@v1_router.post("/monitor/topics")
def create_monitor_topic(body: MonitorTopicCreateRequest) -> Dict[str, Any]:
    """Create a monitoring topic, equivalent to /monitor create."""
    from workflow.topic_monitoring_pipeline import TopicMonitoringPipeline

    pipeline = TopicMonitoringPipeline()
    topic = pipeline.create_topic(
        name=body.name,
        domain=body.domain,
        keywords=body.keywords,
        description=body.description or "由前端 API 创建",
        owner="frontend",
    )
    result: Dict[str, Any] = {"topic": topic}
    if body.run_initial_cycle:
        result["cycle"] = pipeline.run_monitoring_cycle([str(topic.get("id") or "")])
    return result


@v1_router.get("/monitor/topics/{topic_id}/status")
def get_monitor_topic_status(topic_id: str) -> Dict[str, Any]:
    """Return monitoring topic status, equivalent to /monitor status."""
    from workflow.topic_monitoring_pipeline import TopicMonitoringPipeline

    result = TopicMonitoringPipeline().get_topic_status(topic_id)
    if result.get("error"):
        raise HTTPException(status_code=404, detail=str(result["error"]))
    return result


@v1_router.post("/monitor/topics/{topic_id}/cycle")
def run_monitor_topic_cycle(topic_id: str) -> Dict[str, Any]:
    """Run one monitoring cycle for a topic."""
    from workflow.topic_monitoring_pipeline import TopicMonitoringPipeline

    return TopicMonitoringPipeline().run_monitoring_cycle([topic_id])


@v1_router.post("/monitor/topics/{topic_id}/report")
def create_monitor_topic_report(topic_id: str, body: MonitorReportRequest) -> Dict[str, Any]:
    """Generate monitor daily/weekly report, equivalent to /monitor report."""
    from workflow.topic_monitoring_pipeline import TopicMonitoringPipeline

    try:
        return TopicMonitoringPipeline().generate_periodic_report(topic_id, period=body.period)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@v1_router.get("/tasks", response_model=TaskListResponse)
def list_tasks(store: TaskStore = Depends(get_task_store)) -> TaskListResponse:
    """List tasks stored in the current API process memory (for Streamlit GUI)."""
    return TaskListResponse(tasks=store.list_all())


@v1_router.get("/tasks/{task_id}", response_model=TaskEnvelope)
def get_task(task_id: str, store: TaskStore = Depends(get_task_store)) -> TaskEnvelope:
    """Return last known envelope for tasks created via this API process."""
    env = store.get(task_id)
    if env is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return env


@v1_router.get("/tasks/{task_id}/report")
def get_task_report(task_id: str, store: TaskStore = Depends(get_task_store)) -> FileResponse:
    """Return HTML report file when available (mode B in docs/api_design.md)."""
    env = store.get(task_id)
    if env is not None and env.status != TaskStatus.SUCCEEDED:
        raise HTTPException(
            status_code=409,
            detail="Task did not succeed; report unavailable",
        )
    raw_path = resolve_report_path_for_task(task_id)
    if not raw_path:
        raise HTTPException(status_code=404, detail="Report path not recorded")
    path = Path(raw_path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Report file missing on disk")
    return FileResponse(
        path,
        media_type="text/html; charset=utf-8",
        filename=path.name,
    )


def create_app() -> FastAPI:
    """Build FastAPI app with CORS and core routes."""
    application = FastAPI(
        title="Sona API",
        description="HTTP API for Sona workflows (see docs/api_design.md).",
        version="0.1.0",
    )

    allow_origins, allow_credentials = _cors_settings()
    application.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/health", response_model=HealthResponse, tags=["meta"])
    def health() -> HealthResponse:
        """Liveness probe for load balancers and local checks."""
        return HealthResponse()

    application.include_router(v1_router)

    return application


app = create_app()
