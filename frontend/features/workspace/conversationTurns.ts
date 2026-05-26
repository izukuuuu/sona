import type { AgentStep, ConversationTurn, TurnBlock } from '@/types/conversation';
import type { AgentRunEvent, ChatMessage, StreamEvent } from '@/types/sona';

const STUB_PATTERN = /^已执行\s+\/(wiki|case|monitor|hot|event)\b/i;
const APPROVAL_PATTERN =
  /(是否同意|需要您确认|请确认|采集方案|确认后开始|确认后执行|approve|deny|继续执行|修改方案)/i;

export function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: string }).text || '');
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content).trim();
}

/** Parse LangChain ToolMessage string dumps into readable text. */
export function parseToolPayload(raw: string): { clean: string; toolName?: string } {
  const text = raw.trim();
  if (!text) return { clean: '' };

  const repr = text.match(/content=(['"])([\s\S]*?)\1\s+name='([^']+)'/);
  if (repr) {
    const inner = repr[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    const toolName = repr[3];
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        return { clean: JSON.stringify(JSON.parse(inner), null, 2), toolName };
      } catch {
        return { clean: inner, toolName };
      }
    }
    return { clean: inner, toolName };
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { clean: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { clean: text };
    }
  }

  return { clean: text };
}

const KNOWN_STUB_REPLIES = new Set([
  '已执行热点态势感知流程。',
  '已执行热点态势感知流程',
]);

const STUB_ANSWER_PREFIXES = ['完整舆情报告流程已完成', '已执行热点态势感知流程'];

export function isStubText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (KNOWN_STUB_REPLIES.has(t)) return true;
  if (STUB_ANSWER_PREFIXES.some((prefix) => t.startsWith(prefix))) return true;
  if (STUB_PATTERN.test(t)) return true;
  return false;
}

function parseTimestamp(message: ChatMessage, fallback: number): number {
  const parsed = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

type RawToolCall = {
  name?: string;
  args?: unknown;
  id?: string;
  tool_call_id?: string;
  function?: { name?: string; arguments?: unknown };
};

function parseToolCalls(message: ChatMessage) {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const tc = item as RawToolCall;
    let args = tc.args ?? tc.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    return {
      name: String(tc.name || tc.function?.name || 'unknown'),
      args,
      callId: tc.id || tc.tool_call_id,
    };
  });
}

function formatArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function extractUrls(text: string): Set<string> {
  const urls = new Set<string>();
  for (const m of text.matchAll(/file:\/\/[^\s)\]]+|https?:\/\/[^\s)\]]+/gi)) {
    urls.add(m[0]);
  }
  return urls;
}

function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length > 20 && b.includes(a.slice(0, Math.min(80, a.length)))) return true;
  const urlsA = extractUrls(a);
  const urlsB = extractUrls(b);
  if (urlsA.size && urlsB.size && [...urlsA].every((u) => urlsB.has(u))) return true;
  return false;
}

function rawBlocksFromMessages(messages: ChatMessage[], start: number, end: number): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  for (let i = start; i < end; i += 1) {
    const current = messages[i];
    if (current.role === 'assistant') {
      for (const call of parseToolCalls(current)) {
        blocks.push({
          type: 'tool_call',
          toolName: call.name,
          args: call.args,
          callId: call.callId,
        });
      }
      const text = normalizeMessageContent(current.content);
      if (text) blocks.push({ type: 'text', content: text });
    } else if (current.role === 'tool') {
      blocks.push({
        type: 'tool_result',
        toolName: current.tool_name || '工具',
        content: normalizeMessageContent(current.content),
        callId: current.tool_call_id,
      });
    } else if (current.role === 'system') {
      const body = normalizeMessageContent(current.content);
      if (!body) continue;
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.event === 'workflow_step' || parsed.event === 'agent_run_event') {
          const eventType = String(parsed.event_type || '');
          const nestedPayload = parsed.payload && typeof parsed.payload === 'object'
            ? parsed.payload as Record<string, unknown>
            : {};
          const step = String(parsed.step || nestedPayload.step || '');
          const title = String(parsed.title || '工作流');
          const detail = String(parsed.detail || '');
          if (
            step === 'collect_plan' ||
            eventType === 'approval_requested' ||
            title.includes('等待确认') ||
            title.includes('采集方案') ||
            APPROVAL_PATTERN.test(`${title}\n${detail}`)
          ) {
            blocks.push({
              type: 'approval',
              title,
              prompt: detail,
              status: eventType === 'approval_requested' ? 'recorded' : 'recorded',
              payload: nestedPayload.payload && typeof nestedPayload.payload === 'object'
                ? nestedPayload.payload as Record<string, unknown>
                : nestedPayload,
              runId: typeof parsed.run_id === 'string' ? parsed.run_id : undefined,
              approvalEventId: typeof parsed.event_id === 'string' ? parsed.event_id : undefined,
            });
          } else if (eventType === 'agent_message_delta') {
            const content = String(nestedPayload.accumulated || nestedPayload.content || detail || '');
            if (content) blocks.push({ type: 'text', content });
          } else if (eventType === 'tool_call_started') {
            blocks.push({
              type: 'tool_call',
              toolName: title || String(nestedPayload.tool_name || '工具'),
              args: nestedPayload.args ?? {},
              callId: typeof nestedPayload.run_id === 'string' ? nestedPayload.run_id : undefined,
            });
          } else if (eventType === 'tool_call_completed' || eventType === 'artifact_created') {
            blocks.push({
              type: 'tool_result',
              toolName: title || String(nestedPayload.tool_name || '工具'),
              content: String(nestedPayload.result || detail || ''),
              callId: typeof nestedPayload.run_id === 'string' ? nestedPayload.run_id : undefined,
            });
          } else if (eventType === 'approval_resolved') {
            blocks.push({
              type: 'workflow',
              step,
              title,
              content: detail || String(nestedPayload.action || ''),
            });
          } else {
            blocks.push({ type: 'workflow', step, title, content: detail });
          }
          continue;
        }
      } catch {
        // Fall through to plain system note.
      }
      blocks.push({ type: 'system', content: body });
    }
  }
  return blocks;
}

function consolidateRun(blocks: TurnBlock[]): { answer: string; steps: AgentStep[] } {
  const steps: AgentStep[] = [];
  const textParts: string[] = [];
  let stepIndex = 0;

  const pushStep = (step: Omit<AgentStep, 'id'>) => {
    const content = step.content.trim();
    if (!content) return;
    if (steps.some((s) => s.title === step.title && s.content === content)) return;
    steps.push({ ...step, id: `step-${stepIndex++}` });
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      if (!isStubText(block.content)) textParts.push(block.content);
      continue;
    }
    if (block.type === 'tool_call') {
      pushStep({
        kind: 'tool',
        title: `调用 · ${block.toolName}`,
        content: formatArgs(block.args),
      });
      continue;
    }
    if (block.type === 'tool_result') {
      const parsed = parseToolPayload(block.content);
      const name = parsed.toolName || block.toolName;
      const urls = extractUrls(parsed.clean);
      if (urls.size === 1 && parsed.clean.length < 120) {
        pushStep({
          kind: 'tool',
          title: `工具 · ${name}`,
          content: `报告/产物：${[...urls][0]}`,
        });
      } else {
        const body =
          parsed.clean.length > 2400 ? `${parsed.clean.slice(0, 2400)}…` : parsed.clean;
        pushStep({ kind: 'tool', title: `工具 · ${name}`, content: body });
      }
      continue;
    }
    if (block.type === 'thinking') {
      pushStep({ kind: 'thinking', title: '思考', content: block.content });
      continue;
    }
    if (block.type === 'route') {
      pushStep({
        kind: 'route',
        title: '路由',
        content: `${block.route || 'reactagent'} · ${block.taskMode || 'qa'}`,
      });
      continue;
    }
    if (block.type === 'compression') {
      pushStep({ kind: 'compression', title: '上下文压缩', content: block.summary });
      continue;
    }
    if (block.type === 'approval') {
      textParts.push(`**${block.title || '等待确认'}**\n\n${block.prompt}`);
      pushStep({
        kind: 'approval',
        title: block.title || '待确认',
        content: block.prompt,
        status: block.status,
        payload: block.payload,
        runId: block.runId,
        approvalEventId: block.approvalEventId,
      });
      continue;
    }
    if (block.type === 'system') {
      pushStep({ kind: 'note', title: '系统', content: block.content });
      continue;
    }
    if (block.type === 'workflow') {
      const body =
        block.content.length > 2400 ? `${block.content.slice(0, 2400)}…` : block.content;
      pushStep({ kind: 'workflow', title: block.title, content: body });
    }
  }

  let answer = '';
  if (textParts.length) {
    answer = textParts.reduce((best, cur) => (cur.length > best.length ? cur : best), '');
    for (let i = 0; i < textParts.length - 1; i += 1) {
      const part = textParts[i];
      if (part.length > 48 && !isNearDuplicate(part, answer)) {
        pushStep({ kind: 'note', title: '中间输出', content: part });
      }
    }
  } else if (steps.length) {
    const lastWorkflow = [...steps].reverse().find((s) => s.kind === 'workflow');
    const lastTool = [...steps].reverse().find((s) => s.kind === 'tool');
    if (lastWorkflow?.content) {
      answer = lastWorkflow.content.slice(0, 800);
    } else if (lastTool) {
      answer = lastTool.content.slice(0, 500);
    }
  }

  if (isStubText(answer) && steps.length) {
    const doneStep = [...steps].reverse().find((s) => s.kind === 'workflow' && s.title.includes('完成'));
    const fallback = doneStep || [...steps].reverse().find((s) => s.kind === 'workflow');
    if (fallback?.content) answer = fallback.content.slice(0, 800);
  }

  return { answer, steps };
}

function mergeAssistantTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const merged: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = merged[merged.length - 1];
    if (turn.kind === 'assistant' && prev?.kind === 'assistant') {
      prev.steps.push(...turn.steps);
      if (turn.answer && (!prev.answer || turn.answer.length > prev.answer.length)) {
        prev.answer = turn.answer;
      }
      prev.timestamp = Math.max(prev.timestamp, turn.timestamp);
      continue;
    }
    if (turn.kind === 'assistant' && isStubText(turn.answer) && turn.steps.length === 0) {
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

export function buildConversationTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (message.role === 'user') {
      const content = normalizeMessageContent(message.content);
      const userTimestamp = parseTimestamp(message, index);
      if (content) {
        const prev = turns[turns.length - 1];
        if (!(prev?.kind === 'user' && prev.content === content)) {
          turns.push({
            id: `user-${message.timestamp || index}`,
            kind: 'user',
            content,
            timestamp: userTimestamp,
          });
        }
      }
      index += 1;

      const runStart = index;
      while (index < messages.length && messages[index].role !== 'user') {
        index += 1;
      }

      if (runStart === index) {
        continue;
      } else {
        const blocks = rawBlocksFromMessages(messages, runStart, index);
        const { answer, steps } = consolidateRun(blocks);
        const first = messages[runStart];
        if (!answer && steps.length === 0) {
          continue;
        } else {
          turns.push({
            id: `assistant-${first.timestamp || runStart}`,
            kind: 'assistant',
            timestamp: parseTimestamp(first, runStart),
            answer: answer || '（无文本回复，请展开 Agent 过程查看工具输出）',
            steps,
          });
        }
      }
      continue;
    }

    const runStart = index;
    while (index < messages.length && messages[index].role !== 'user') {
      index += 1;
    }

    const blocks = rawBlocksFromMessages(messages, runStart, index);
    const { answer, steps } = consolidateRun(blocks);
    if (!answer && steps.length === 0) continue;

    const first = messages[runStart];
    turns.push({
      id: `assistant-${first.timestamp || runStart}`,
      kind: 'assistant',
      timestamp: parseTimestamp(first, runStart),
      answer: answer || '（无文本回复，请展开 Agent 过程查看工具输出）',
      steps,
    });
  }

  return mergeAssistantTurns(turns);
}

export function blocksFromStream(blocks: TurnBlock[]): { answer: string; steps: AgentStep[] } {
  return consolidateRun(blocks);
}

export function applyStreamEvent(blocks: TurnBlock[], event: StreamEvent): TurnBlock[] {
  const next = [...blocks];
  const data = event.data as Record<string, unknown>;

  if (event.event === 'route') {
    next.push({
      type: 'route',
      route: String(data.route || ''),
      taskMode: String(data.task_mode || ''),
    });
    return next;
  }

  if (event.event === 'token') {
    const content = String(data.accumulated || data.content || '');
    const last = next[next.length - 1];
    if (last?.type === 'text') {
      next[next.length - 1] = { type: 'text', content };
    } else {
      next.push({ type: 'text', content });
    }
    return next;
  }

  if (event.event === 'message') {
    const content = String(data.content || '').trim();
    const streamingText = [...next].reverse().find((b) => b.type === 'text');
    const filtered: TurnBlock[] = next.filter((b) => b.type !== 'thinking' && b.type !== 'text');
    if (content) {
      filtered.push({ type: 'text', content });
    } else if (streamingText?.type === 'text' && streamingText.content.trim()) {
      filtered.push({ type: 'text', content: streamingText.content });
    }
    const toolCalls = data.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const item of toolCalls) {
        const tc = item as RawToolCall;
        let args = tc.args ?? tc.function?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = { raw: args };
          }
        }
        filtered.push({
          type: 'tool_call',
          toolName: String(tc.name || tc.function?.name || '工具'),
          args,
          callId: tc.id || tc.tool_call_id ? String(tc.id || tc.tool_call_id) : undefined,
        });
      }
    }
    return filtered;
  }

  if (event.event === 'tool_call') {
    next.push({
      type: 'tool_call',
      toolName: String(data.tool_name || '工具'),
      args: data.args ?? {},
      callId: data.run_id ? String(data.run_id) : undefined,
    });
    return next;
  }

  if (event.event === 'tool_result') {
    next.push({
      type: 'tool_result',
      toolName: String(data.tool_name || '工具'),
      content: String(data.result || ''),
      callId: data.run_id ? String(data.run_id) : undefined,
    });
    return next;
  }

  if (event.event === 'compression') {
    next.push({
      type: 'compression',
      summary: String(data.summary || data.message || '上下文已压缩'),
    });
    return next;
  }

  if (event.event === 'workflow_step') {
    const step = String(data.step || '');
    const title = String(data.title || '工作流');
    const detail = String(data.detail || '');
    if (
      step === 'collect_plan' ||
      title.includes('等待确认') ||
      title.includes('采集方案') ||
      APPROVAL_PATTERN.test(`${title}\n${detail}`)
    ) {
      next.push({
        type: 'approval',
        title,
        prompt: detail,
        status: 'pending',
      });
      return next;
    }
    next.push({
      type: 'workflow',
      step,
      title,
      content: detail,
    });
    return next;
  }

  return next;
}

export function applyAgentRunEvent(blocks: TurnBlock[], event: AgentRunEvent): TurnBlock[] {
  const next = [...blocks];
  const payload = event.payload || {};
  const nestedPayload = payload.payload && typeof payload.payload === 'object'
    ? payload.payload as Record<string, unknown>
    : payload;

  if (event.event_type === 'agent_message_delta') {
    const content = String(payload.accumulated || payload.content || event.detail || '');
    const last = next[next.length - 1];
    if (last?.type === 'text') {
      next[next.length - 1] = { type: 'text', content };
    } else if (content) {
      next.push({ type: 'text', content });
    }
    return next;
  }

  if (event.event_type === 'approval_requested') {
    next.push({
      type: 'approval',
      title: event.title || '建议搜索采集方案（等待确认）',
      prompt: event.detail || formatArgs(event.payload || {}),
      status: 'pending',
      payload: event.payload || {},
      runId: event.run_id,
      approvalEventId: event.event_id,
    });
    return next;
  }

  if (event.event_type === 'approval_resolved') {
    const approvalEventId = typeof payload.approval_event_id === 'string' ? payload.approval_event_id : '';
    return next.map((block) => {
      if (block.type !== 'approval') return block;
      if (approvalEventId && block.approvalEventId !== approvalEventId) return block;
      return {
        ...block,
        status: payload.action === 'abort' ? 'rejected' : 'approved',
        decision: String(payload.action || ''),
      };
    });
  }

  if (event.event_type === 'tool_call_started') {
    next.push({
      type: 'tool_call',
      toolName: String(payload.tool_name || event.title || '工具'),
      args: payload.args ?? {},
      callId: payload.run_id ? String(payload.run_id) : undefined,
    });
    return next;
  }

  if (event.event_type === 'tool_call_completed' || event.event_type === 'artifact_created') {
    next.push({
      type: 'tool_result',
      toolName: String(payload.tool_name || event.title || '工具'),
      content: String(payload.result || event.detail || ''),
      callId: payload.run_id ? String(payload.run_id) : undefined,
    });
    return next;
  }

  if (event.event_type === 'run_failed') {
    next.push({ type: 'system', content: event.detail || '工作流失败' });
    return next;
  }

  if (
    event.event_type === 'agent_step_started' ||
    event.event_type === 'agent_step_updated' ||
    event.event_type === 'agent_step_completed' ||
    event.event_type === 'run_completed'
  ) {
    next.push({
      type: 'workflow',
      step: String(payload.step || nestedPayload.step || event.event_type),
      title: event.title || '工作流',
      content: event.detail || formatArgs(nestedPayload),
    });
    return next;
  }

  return next;
}

export function hasVisibleTurns(turns: ConversationTurn[]): boolean {
  return turns.some((t) => {
    if (t.kind === 'user') return t.content.trim().length > 0;
    return t.answer.trim().length > 0 || t.steps.length > 0;
  });
}
