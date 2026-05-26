"""Pydantic models for the public HTTP API (see docs/api_design.md)."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class TaskStatus(StrEnum):
    """Lifecycle of an API-tracked workflow run."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class AgentRunStatus(StrEnum):
    """Lifecycle of a frontend Agent run."""

    QUEUED = "queued"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    ABORTED = "aborted"


class AgentEventType(StrEnum):
    """Canonical frontend Agent event names."""

    AGENT_MESSAGE_DELTA = "agent_message_delta"
    RESEARCH_PROGRESS = "research_progress"
    AGENT_STEP_STARTED = "agent_step_started"
    AGENT_STEP_UPDATED = "agent_step_updated"
    AGENT_STEP_COMPLETED = "agent_step_completed"
    TOOL_CALL_STARTED = "tool_call_started"
    TOOL_CALL_COMPLETED = "tool_call_completed"
    TOOL_CALL_FAILED = "tool_call_failed"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    ARTIFACT_CREATED = "artifact_created"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"


class ApiError(BaseModel):
    """Structured error returned to API clients."""

    model_config = ConfigDict(extra="forbid")

    error_code: str = Field(..., description="Machine-readable error code.")
    error_message: str = Field(..., description="Human-readable message.")


class TaskArtifacts(BaseModel):
    """Paths and hints produced by a workflow; keys may grow over time."""

    model_config = ConfigDict(extra="allow")

    report_path: str = Field(default="", description="HTML report filesystem path, if any.")
    trace_path: str = Field(default="", description="Optional trace or debug log path.")
    sandbox_dir: str = Field(default="", description="Optional sandbox root for this task.")
    session_hint: str = Field(
        default="",
        description="Optional note linking to SessionManager / Streamlit session.",
    )


class TaskEnvelope(BaseModel):
    """Standard task response body: status, optional artifacts, optional error."""

    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(..., description="Task or session identifier (UUID or app-defined).")
    status: TaskStatus
    artifacts: TaskArtifacts = Field(default_factory=TaskArtifacts)
    error: Optional[ApiError] = Field(default=None, description="Set when status is failed or partial error info is exposed.")


class AnalyzeEventRequest(BaseModel):
    """Request body for POST /v1/analyze-event."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1, description="Natural language event analysis input.")
    prefer_existing_data: bool = Field(default=True)
    disable_blocking_prompts: bool = Field(default=False)


class SessionCreateRequest(BaseModel):
    """Create a chat/session container for frontend use."""

    model_config = ConfigDict(extra="forbid")

    initial_query: str = Field(default="Frontend session", min_length=1)


class SessionUpdateRequest(BaseModel):
    """Update frontend chat session metadata."""

    model_config = ConfigDict(extra="forbid")

    description: Optional[str] = Field(default=None, min_length=1, max_length=120)


class SessionEnvelope(BaseModel):
    """Serialized session data returned to frontend clients."""

    model_config = ConfigDict(extra="allow")

    schema_version: int = Field(default=3)
    task_id: str
    created_at: str = ""
    updated_at: str = ""
    status: str = "active"
    description: str = ""
    initial_query: str = ""
    messages: List[Dict[str, Any]] = Field(default_factory=list)
    agent_events: List[Dict[str, Any]] = Field(default_factory=list)
    token_usage: Dict[str, Any] = Field(default_factory=dict)


class SessionListResponse(BaseModel):
    """GET /v1/chat/sessions payload."""

    model_config = ConfigDict(extra="forbid")

    sessions: List[SessionEnvelope] = Field(default_factory=list)


class ChatMessageRequest(BaseModel):
    """Request body for streaming a message through the chat runtime."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    auto_route: bool = Field(default=True)
    prefer_existing_data: bool = Field(default=True)
    workflow_options: Dict[str, Any] = Field(default_factory=dict)


class AgentRunCreateRequest(BaseModel):
    """Create a web Agent run for a chat session."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    auto_route: bool = Field(default=True)
    prefer_existing_data: bool = Field(default=True)
    workflow_options: Dict[str, Any] = Field(default_factory=dict)


class AgentRunEvent(BaseModel):
    """Persisted frontend Agent event."""

    model_config = ConfigDict(extra="allow")

    event_id: str
    run_id: str
    task_id: str
    turn_id: str
    event_type: AgentEventType | str
    status: str = ""
    title: str = ""
    detail: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""


class AgentRunEnvelope(BaseModel):
    """Frontend Agent run state."""

    model_config = ConfigDict(extra="allow")

    run_id: str
    task_id: str
    turn_id: str
    status: AgentRunStatus | str
    query: str = ""
    events: List[AgentRunEvent] = Field(default_factory=list)


class AgentApprovalRequest(BaseModel):
    """Resolve a waiting frontend Agent approval."""

    model_config = ConfigDict(extra="forbid")

    action: str = Field(..., pattern="^(accept|edit|abort)$")
    patch: Dict[str, Any] = Field(default_factory=dict)


class WikiQueryRequest(BaseModel):
    """Request body for POST /v1/wiki/query."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    task_id: Optional[str] = Field(default=None, description="Optional chat session id for persistence.")
    topk: int = Field(default=6, ge=1, le=12)
    style: str = Field(default="teach")


class WikiApproveRequest(BaseModel):
    """Request body for POST /v1/wiki/approve."""

    model_config = ConfigDict(extra="forbid")

    selector: str = ""


class CaseSearchRequest(BaseModel):
    """Request body for POST /v1/cases/search."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    task_id: Optional[str] = Field(default=None, description="Optional chat session id for persistence.")


class HotRunRequest(BaseModel):
    """Request body for POST /v1/hot/run."""

    model_config = ConfigDict(extra="forbid")

    config_path: str = ""


class ArtifactPathResponse(BaseModel):
    """Generic path-producing workflow response."""

    model_config = ConfigDict(extra="allow")

    status: str = "succeeded"
    path: str = ""


class ModelInfo(BaseModel):
    """Model configuration entry safe for frontend display."""

    model_config = ConfigDict(extra="allow")

    name: str
    description: str = ""
    provider: str = ""
    model: str = ""
    api_key_env: str = ""


class ModelListResponse(BaseModel):
    """GET /v1/models payload."""

    model_config = ConfigDict(extra="forbid")

    models: List[ModelInfo] = Field(default_factory=list)


class ToolInfo(BaseModel):
    """Agent tool metadata safe for frontend display."""

    model_config = ConfigDict(extra="allow")

    name: str
    description: str = ""


class ToolListResponse(BaseModel):
    """GET /v1/tools payload."""

    model_config = ConfigDict(extra="forbid")

    tools: List[ToolInfo] = Field(default_factory=list)


class ComposerCommand(BaseModel):
    """Slash command shortcut exposed in the chat composer."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    command: str = Field(..., description="Slash command prefix, e.g. /event")
    description: str = ""
    action: str = Field(default="prefill", description="prefill | run")
    default_query: str = Field(
        default="",
        description="Full command executed when action=run, e.g. '/monitor list'",
    )


class ComposerCommandListResponse(BaseModel):
    """GET /v1/commands payload."""

    model_config = ConfigDict(extra="forbid")

    commands: List[ComposerCommand] = Field(default_factory=list)


class MonitorTopicCreateRequest(BaseModel):
    """Create a monitoring topic."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1)
    domain: str = Field(default="综合舆情")
    keywords: List[str] = Field(default_factory=list)
    description: str = ""
    run_initial_cycle: bool = True


class MonitorReportRequest(BaseModel):
    """Generate a periodic monitoring report."""

    model_config = ConfigDict(extra="forbid")

    period: str = Field(default="daily")


class MonitorTopicListResponse(BaseModel):
    """GET /v1/monitor/topics payload."""

    model_config = ConfigDict(extra="forbid")

    topics: List[Dict[str, Any]] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """GET /health payload."""

    model_config = ConfigDict(extra="forbid")

    status: str = Field(default="ok")
    service: str = Field(default="sona-api")
    version: str = Field(default="0.1.0")


class TaskListResponse(BaseModel):
    """GET /v1/tasks — in-memory tasks for the current API process."""

    model_config = ConfigDict(extra="forbid")

    tasks: List[TaskEnvelope] = Field(default_factory=list)


class ReportPathResponse(BaseModel):
    """JSON style for GET /v1/tasks/{id}/report when returning path only (mode A)."""

    model_config = ConfigDict(extra="forbid")

    report_path: str


# Common error_code literals (optional reference for callers; not enforced by schema)
ERROR_VALIDATION = "VALIDATION_ERROR"
ERROR_WORKFLOW = "WORKFLOW_ERROR"
ERROR_NOT_FOUND = "NOT_FOUND"
ERROR_NOT_READY = "NOT_READY"


def task_envelope_from_dict(data: dict[str, Any]) -> TaskEnvelope:
    """Parse a loose dict (e.g. from in-memory store) into TaskEnvelope."""

    return TaskEnvelope.model_validate(data)
