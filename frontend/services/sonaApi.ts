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

function isJsonLikeContentType(contentType: string | null) {
  if (!contentType) return false;
  return /\bapplication\/(.+\+)?json\b/i.test(contentType);
}

function looksLikeJson(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed === 'null';
}

function previewText(text: string, maxLength = 160) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function unexpectedResponseError(response: Response, text: string, contentType: string | null) {
  const typeLabel = contentType || 'unknown content-type';
  const snippet = previewText(text);
  const prefix = response.ok
    ? `Expected JSON response but received ${typeLabel}`
    : `Request failed with non-JSON response (${response.status} ${response.statusText || 'Error'}, ${typeLabel})`;
  const suffix = snippet ? ` Response preview: ${snippet}` : '';
  return new Error(`${prefix}.${suffix}`);
}

function readStringField(value: unknown, field: 'detail' | 'message') {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get('content-type');
  const shouldParseJson = Boolean(text) && (isJsonLikeContentType(contentType) || looksLikeJson(text));
  let data: unknown = null;

  if (shouldParseJson) {
    try {
      data = JSON.parse(text);
    } catch {
      throw unexpectedResponseError(response, text, contentType);
    }
  }

  if (!response.ok) {
    const message =
      readStringField(data, 'detail') ??
      readStringField(data, 'message') ??
      unexpectedResponseError(response, text, contentType).message;
    throw new Error(message || `HTTP ${response.status}`);
  }

  if (text && data === null) {
    throw unexpectedResponseError(response, text, contentType);
  }

  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  return parseJson<T>(response);
}

export async function apiPost<T>(path: string, body: JsonValue): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseJson<T>(response);
}

export const sonaApi = {
  health: () => apiGet<ApiHealth>('/health'),
  createSession: (initial_query: string) =>
    apiPost<SessionEnvelope>('/v1/chat/sessions', { initial_query }),
  updateSession: (sessionId: string, description: string) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description }),
    }).then((response) => parseJson<SessionEnvelope>(response)),
  deleteSession: (sessionId: string) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    })
      .then((response) => parseJson<{ sessions: SessionEnvelope[] }>(response)),
  getSession: (sessionId: string) => apiGet<SessionEnvelope>(`/v1/chat/sessions/${sessionId}`),
  updateSessionMessage: (
    sessionId: string,
    messageId: string,
    body: { content: string; mode?: SessionMessageEditMode },
  ) =>
    fetch(`${API_ROOT}/v1/chat/sessions/${sessionId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }).then((response) => parseJson<SessionEnvelope>(response)),
  deleteSessionMessage: (sessionId: string, messageId: string, mode: SessionMessageEditMode = 'turn') =>
    fetch(
      `${API_ROOT}/v1/chat/sessions/${sessionId}/messages/${messageId}?mode=${encodeURIComponent(mode)}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      },
    ).then((response) => parseJson<SessionEnvelope>(response)),
  createAgentRun: (
    sessionId: string,
    body: {
      query: string;
      auto_route?: boolean;
      prefer_existing_data?: boolean;
      mode?: string;
      command?: string;
      workflow_options?: Record<string, unknown>;
    },
  ) =>
    apiPost<AgentRunEnvelope>(`/v1/chat/sessions/${sessionId}/runs`, {
      auto_route: body.auto_route ?? true,
      command: body.command || '',
      mode: body.mode || '',
      prefer_existing_data: body.prefer_existing_data ?? true,
      query: body.query,
      workflow_options: body.workflow_options || {},
    }),
  getAgentRun: (sessionId: string, runId: string) =>
    apiGet<AgentRunEnvelope>(`/v1/chat/sessions/${sessionId}/runs/${runId}`),
  approveAgentRun: (
    sessionId: string,
    runId: string,
    action: AgentApprovalAction,
    patch: Record<string, unknown> = {},
  ) =>
    apiPost<AgentRunEnvelope>(`/v1/chat/sessions/${sessionId}/runs/${runId}/approval`, {
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
  wikiQuery: (query: string, sessionId?: string, settings?: Partial<MemorySettings>) =>
    apiPost<{ answer: string; sources?: unknown[] }>('/v1/wiki/query', {
      query,
      session_id: sessionId,
      topk: settings?.wiki_topk ?? 6,
      style: settings?.wiki_style ?? 'teach',
      weibo_aux: settings?.wiki_weibo_aux ?? true,
    }),
  wikiApprove: (selector: string) => apiPost<Record<string, unknown>>('/v1/wiki/approve', { selector }),
  caseSearch: (query: string, sessionId?: string) =>
    apiPost<{ answer: string; cases?: unknown[] }>('/v1/cases/search', { query, session_id: sessionId }),
  hotRun: (config_path = '') => apiPost<{ status: string; path: string }>('/v1/hot/run', { config_path }),
  models: () => apiGet<{ models: ModelInfo[] }>('/v1/models'),
  tools: () => apiGet<{ tools: ToolInfo[] }>('/v1/tools'),
  skills: () => apiGet<{ skills: SkillInfo[] }>('/v1/skills'),
  commands: () => apiGet<{ commands: ComposerCommand[] }>('/v1/commands'),
  memorySettings: (sessionId?: string) =>
    apiGet<MemorySettingsResponse>(
      `/v1/settings/memory${sessionId ? `?task_id=${encodeURIComponent(sessionId)}` : ''}`,
    ),
  updateMemorySettings: (body: Partial<MemorySettings> & { session_id?: string; task_id?: string }) =>
    fetch(`${API_ROOT}/v1/settings/memory`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
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
  sessionId: string,
  runId: string,
  handlers: SseHandlers<AgentRunSseEvent>,
) {
  const response = await fetch(`${API_ROOT}/v1/chat/sessions/${sessionId}/runs/${runId}/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: handlers.signal,
  });
  await readSseStream(response, handlers, (event, data) => ({
    event,
    data: data as AgentRunEvent,
  }));
}

export async function streamChatMessage(
  sessionId: string,
  query: string,
  handlers: SseHandlers<StreamEvent>,
) {
  const response = await fetch(`${API_ROOT}/v1/chat/sessions/${sessionId}/messages:stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, auto_route: true, prefer_existing_data: true }),
    signal: handlers.signal,
  });
  await readSseStream(response, handlers, (event, data) => ({ event, data } as StreamEvent));
}
