import type {
  ApiHealth,
  AgentApprovalAction,
  AgentRunEnvelope,
  AgentRunEvent,
  AgentRunSseEvent,
  ComposerCommand,
  MemorySettings,
  MemorySettingsResponse,
  ModelInfo,
  SessionEnvelope,
  SessionMessageEditMode,
  StreamEvent,
  TaskEnvelope,
  SkillInfo,
  ToolInfo,
} from '@/types/sona';

const API_ROOT = '/api/sona';

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

type SseHandlers<T> = {
  onEvent: (event: T) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
};

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof data?.detail === 'string'
        ? data.detail
        : typeof data?.message === 'string'
          ? data.message
          : response.statusText;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, { cache: 'no-store' });
  return parseJson<T>(response);
}

export async function apiPost<T>(path: string, body: JsonValue): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson<T>(response);
}

export const sonaApi = {
  health: () => apiGet<ApiHealth>('/health'),
  createSession: (initial_query: string) =>
    apiPost<SessionEnvelope>('/v1/chat/sessions', { initial_query }),
  updateSession: (taskId: string, description: string) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    }).then((response) => parseJson<SessionEnvelope>(response)),
  deleteSession: (taskId: string) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${taskId}`, { method: 'DELETE' })
      .then((response) => parseJson<{ sessions: SessionEnvelope[] }>(response)),
  getSession: (taskId: string) => apiGet<SessionEnvelope>(`/v1/chat/sessions/${taskId}`),
  updateSessionMessage: (
    taskId: string,
    messageId: string,
    body: { content: string; mode?: SessionMessageEditMode },
  ) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${taskId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => parseJson<SessionEnvelope>(response)),
  deleteSessionMessage: (taskId: string, messageId: string, mode: SessionMessageEditMode = 'turn') =>
    fetch(
      `${API_ROOT}/v1/chat/sessions/${taskId}/messages/${messageId}?mode=${encodeURIComponent(mode)}`,
      { method: 'DELETE' },
    ).then((response) => parseJson<SessionEnvelope>(response)),
  createAgentRun: (
    taskId: string,
    body: { query: string; auto_route?: boolean; prefer_existing_data?: boolean; workflow_options?: Record<string, unknown> },
  ) =>
    apiPost<AgentRunEnvelope>(`/v1/chat/sessions/${taskId}/runs`, {
      auto_route: body.auto_route ?? true,
      prefer_existing_data: body.prefer_existing_data ?? true,
      query: body.query,
      workflow_options: body.workflow_options || {},
    }),
  getAgentRun: (taskId: string, runId: string) =>
    apiGet<AgentRunEnvelope>(`/v1/chat/sessions/${taskId}/runs/${runId}`),
  approveAgentRun: (
    taskId: string,
    runId: string,
    action: AgentApprovalAction,
    patch: Record<string, unknown> = {},
  ) =>
    apiPost<AgentRunEnvelope>(`/v1/chat/sessions/${taskId}/runs/${runId}/approval`, {
      action,
      patch,
    }),
  listSessions: (limit = 50) =>
    apiGet<{ sessions: SessionEnvelope[] }>(`/v1/chat/sessions?limit=${Math.max(1, Math.min(limit, 100))}`),
  listTasks: () => apiGet<{ tasks: TaskEnvelope[] }>('/v1/tasks'),
  analyzeEvent: (query: string) =>
    apiPost<TaskEnvelope>('/v1/analyze-event', {
      query,
      prefer_existing_data: true,
      disable_blocking_prompts: true,
    }),
  wikiQuery: (query: string, taskId?: string, settings?: Partial<MemorySettings>) =>
    apiPost<{ answer: string; sources?: unknown[] }>('/v1/wiki/query', {
      query,
      task_id: taskId,
      topk: settings?.wiki_topk ?? 6,
      style: settings?.wiki_style ?? 'teach',
      weibo_aux: settings?.wiki_weibo_aux ?? true,
    }),
  wikiApprove: (selector: string) => apiPost<Record<string, unknown>>('/v1/wiki/approve', { selector }),
  caseSearch: (query: string, taskId?: string) =>
    apiPost<{ answer: string; cases?: unknown[] }>('/v1/cases/search', { query, task_id: taskId }),
  hotRun: (config_path = '') => apiPost<{ status: string; path: string }>('/v1/hot/run', { config_path }),
  models: () => apiGet<{ models: ModelInfo[] }>('/v1/models'),
  tools: () => apiGet<{ tools: ToolInfo[] }>('/v1/tools'),
  skills: () => apiGet<{ skills: SkillInfo[] }>('/v1/skills'),
  commands: () => apiGet<{ commands: ComposerCommand[] }>('/v1/commands'),
  memorySettings: (taskId?: string) =>
    apiGet<MemorySettingsResponse>(
      `/v1/settings/memory${taskId ? `?task_id=${encodeURIComponent(taskId)}` : ''}`,
    ),
  updateMemorySettings: (body: Partial<MemorySettings> & { task_id?: string }) =>
    fetch(`${API_ROOT}/v1/settings/memory`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => parseJson<MemorySettingsResponse>(response)),
  monitorList: () => apiGet<{ topics: Record<string, unknown>[] }>('/v1/monitor/topics'),
  monitorDemo: () => apiPost<Record<string, unknown>>('/v1/monitor/demo', {}),
  monitorCreate: (payload: { name: string; domain: string; keywords: string[]; description?: string }) =>
    apiPost<Record<string, unknown>>('/v1/monitor/topics', {
      ...payload,
      run_initial_cycle: true,
    }),
  monitorStatus: (topicId: string) => apiGet<Record<string, unknown>>(`/v1/monitor/topics/${topicId}/status`),
  monitorReport: (topicId: string, period = 'daily') =>
    apiPost<Record<string, unknown>>(`/v1/monitor/topics/${topicId}/report`, { period }),
};

async function readSseStream<T>(
  response: Response,
  handlers: SseHandlers<T>,
  parsePayload: (event: string, data: unknown) => T,
) {
  if (!response.ok || !response.body) {
    throw new Error(response.statusText || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flush = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const raw = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n') || '{}';
    try {
      handlers.onEvent(parsePayload(event, JSON.parse(raw)));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      handlers.onError?.(normalized);
      throw normalized;
    }
  };

  while (true) {
    if (handlers.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    frames.filter((frame) => frame.trim()).forEach(flush);
  }
  if (buffer.trim()) flush(buffer);
}

export async function streamAgentRunEvents(
  taskId: string,
  runId: string,
  handlers: SseHandlers<AgentRunSseEvent>,
) {
  const response = await fetch(`${API_ROOT}/v1/chat/sessions/${taskId}/runs/${runId}/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: handlers.signal,
  });
  await readSseStream(response, handlers, (event, data) => ({
    event,
    data: data as AgentRunEvent,
  }));
}

export async function streamChatMessage(
  taskId: string,
  query: string,
  handlers: SseHandlers<StreamEvent>,
) {
  const response = await fetch(`${API_ROOT}/v1/chat/sessions/${taskId}/messages:stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, auto_route: true, prefer_existing_data: true }),
    signal: handlers.signal,
  });
  await readSseStream(response, handlers, (event, data) => ({ event, data } as StreamEvent));
}
