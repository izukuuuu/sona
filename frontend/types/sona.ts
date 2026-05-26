export type ApiHealth = {
  status: string;
  service: string;
  version: string;
};

export type ChatToolCall = {
  name?: string;
  args?: unknown;
  id?: string;
  tool_call_id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
  identifier?: string;
  apiName?: string;
};

export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: string;
  parent_id?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  tools?: ChatToolCall[];
  plugin?: Record<string, unknown>;
};

export type SessionEnvelope = {
  schema_version?: number;
  task_id: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  description?: string;
  initial_query?: string;
  messages: ChatMessage[];
  agent_events?: AgentRunEvent[];
  token_usage?: Record<string, unknown>;
};

export type TaskEnvelope = {
  task_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  artifacts: {
    report_path?: string;
    trace_path?: string;
    sandbox_dir?: string;
    session_hint?: string;
  };
  error?: {
    error_code: string;
    error_message: string;
  } | null;
};

export type ToolInfo = {
  name: string;
  description: string;
};

export type ComposerCommand = {
  id: string;
  label: string;
  command: string;
  description: string;
  action: 'prefill' | 'run';
  default_query: string;
};

export type ModelInfo = {
  name: string;
  description: string;
  provider: string;
  model: string;
  api_key_env: string;
};

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'aborted';

export type AgentEventType =
  | 'agent_message_delta'
  | 'research_progress'
  | 'agent_step_started'
  | 'agent_step_updated'
  | 'agent_step_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'artifact_created'
  | 'run_completed'
  | 'run_failed';

export type AgentRunEvent = {
  event_id: string;
  run_id: string;
  task_id: string;
  turn_id: string;
  event_type: AgentEventType | string;
  status?: string;
  title?: string;
  detail?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
};

export type AgentRunEnvelope = {
  run_id: string;
  task_id: string;
  turn_id: string;
  status: AgentRunStatus | string;
  query: string;
  events: AgentRunEvent[];
};

export type AgentApprovalAction = 'accept' | 'edit' | 'abort';

export type AgentRunSseEvent = {
  event: string;
  data: AgentRunEvent;
};

export type StreamEvent =
  | { event: 'token'; data: { content: string; accumulated?: string; message_id?: string } }
  | { event: 'message'; data: { content: string; message_id?: string } }
  | { event: 'tool_call'; data: { tool_name: string; args?: unknown; run_id?: string } }
  | { event: 'tool_result'; data: { tool_name: string; result: string; run_id?: string } }
  | { event: 'route'; data: { route: string; task_mode: string } }
  | { event: 'compression'; data: Record<string, unknown> }
  | { event: 'workflow_step'; data: { step?: string; title?: string; detail?: string } }
  | { event: 'done'; data: Record<string, unknown> }
  | { event: 'error'; data: { error?: string; message?: string } }
  | { event: string; data: Record<string, unknown> };
