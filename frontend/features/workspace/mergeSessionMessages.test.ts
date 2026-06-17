import { describe, expect, it } from 'vitest';
import { dedupeMessages, mergeSessionMessages, messagesMatch } from '@/features/workspace/mergeSessionMessages';
import {
  applyAgentRunEvent,
  applyStreamEvent,
  blocksFromStream,
  buildConversationTurns,
  isStubText,
} from '@/features/workspace/conversationTurns';
import { slashStreamingRunOptions } from '@/features/workspace/sonaToolUi';
import type { AgentRunEvent, ChatMessage } from '@/types/sona';

describe('mergeSessionMessages', () => {
  it('keeps local tail when server is behind', () => {
    const server: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const local: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const merged = mergeSessionMessages(local, server);
    expect(merged).toHaveLength(2);
    expect(merged[1].content).toBe('world');
  });

  it('dedupes optimistic user with server user', () => {
    const server: ChatMessage[] = [
      { role: 'user', content: 'same question', timestamp: '2026-01-01T00:00:00Z' },
    ];
    const local: ChatMessage[] = [
      { role: 'user', content: 'same question', timestamp: '2026-01-01T00:00:01Z' },
    ];
    const merged = mergeSessionMessages(local, server);
    expect(merged).toHaveLength(1);
  });

  it('messagesMatch treats identical content as duplicate', () => {
    const text = '分析 OPPO 母亲节广告文案争议舆情分析';
    const a: ChatMessage = { role: 'user', content: text };
    const b: ChatMessage = { role: 'user', content: text, timestamp: '2026-05-15T00:00:00Z' };
    expect(messagesMatch(a, b)).toBe(true);
  });
});

describe('applyStreamEvent message', () => {
  it('preserves thinking when message content is empty', () => {
    let blocks = applyStreamEvent([], { event: 'token', data: { accumulated: '流式片段' } });
    blocks = applyStreamEvent(blocks, { event: 'message', data: { content: '' } });
    expect(blocks.some((b) => b.type === 'text' && b.content === '流式片段')).toBe(true);
  });

  it('shows token events as the live answer draft', () => {
    const blocks = applyStreamEvent([], { event: 'token', data: { accumulated: '正在生成回答' } });
    expect(blocksFromStream(blocks).answer).toBe('正在生成回答');
  });

  it('shows thinking events as process steps', () => {
    const blocks = applyStreamEvent([], { event: 'thinking', data: { accumulated: '先分析意图' } });
    const live = blocksFromStream(blocks);
    expect(live.answer).toBe('');
    expect(live.steps.some((step) => step.kind === 'thinking' && step.content === '先分析意图')).toBe(true);
  });

  it('records workflow_step events', () => {
    const blocks = applyStreamEvent([], {
      event: 'workflow_step',
      data: { step: 'step1', title: 'Step1: extract', detail: '关键词已提取' },
    });
    expect(blocks.some((b) => b.type === 'workflow' && b.title.includes('Step1'))).toBe(true);
  });

  it('renders collect plan workflow events as visible approval content', () => {
    const blocks = applyStreamEvent([], {
      event: 'workflow_step',
      data: {
        step: 'collect_plan',
        title: '建议搜索采集方案（等待确认）',
        detail: '{\n  "platforms": ["微博"]\n}',
      },
    });
    const live = blocksFromStream(blocks);
    expect(blocks.some((b) => b.type === 'approval')).toBe(true);
    expect(live.answer).toContain('建议搜索采集方案');
    expect(live.answer).toContain('"platforms"');
  });

  it('restores persisted workflow audit messages into approval steps', () => {
    const turns = buildConversationTurns([
      { role: 'user', content: '近期大熊猫相关舆情事件分析' },
      {
        role: 'system',
        content: JSON.stringify({
          event: 'workflow_step',
          step: 'collect_plan',
          title: '建议搜索采集方案（等待确认）',
          detail: '{\n  "return_count": 2000\n}',
        }),
      },
    ]);
    const assistant = turns.find((turn) => turn.kind === 'assistant');
    expect(assistant?.steps.some((step) => step.kind === 'approval')).toBe(true);
    expect(assistant?.answer).toContain('建议搜索采集方案');
  });

  it('appends tool_calls from message event', () => {
    const blocks = applyStreamEvent([], {
      event: 'message',
      data: {
        content: '',
        tool_calls: [{ name: 'search', args: { q: 'oppo' }, id: 'tc1' }],
      },
    });
    expect(blocks.some((b) => b.type === 'tool_call' && b.toolName === 'search')).toBe(true);
  });
});

describe('applyAgentRunEvent', () => {
  it('renders event workflow progress, approval, artifact, and completion as visible blocks', () => {
    const common = {
      run_id: 'run-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      created_at: '2026-05-28T12:00:00.000Z',
    };
    let blocks = applyAgentRunEvent([], {
      ...common,
      event_id: 'event-1',
      event_type: 'research_progress',
      status: 'running',
      title: 'Step1: extract_search_terms',
      detail: '关键词已提取',
      payload: { kind: 'deep_research_progress', phase: 'research', step: 'step1', status: 'running' },
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'event-2',
      event_type: 'approval_requested',
      status: 'pending',
      title: '建议搜索采集方案（等待确认）',
      detail: '{\n  "platforms": ["微博"]\n}',
      payload: { platforms: ['微博'] },
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'event-3',
      event_type: 'artifact_created',
      status: 'completed',
      title: 'full_report_mode_node',
      detail: 'file:///tmp/event-report.html',
      payload: { tool_name: 'full_report_mode_node', result: 'file:///tmp/event-report.html' },
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'event-4',
      event_type: 'run_completed',
      status: 'succeeded',
      title: '工作流完成',
      detail: '本次 Agent run 已完成。',
      payload: {},
    });

    const live = blocksFromStream(blocks);
    expect(live.answer).toContain('event-report.html');
    expect(live.steps.some((step) => step.kind === 'research' && step.title.includes('Step1'))).toBe(true);
    expect(live.steps.some((step) => step.kind === 'approval' && step.status === 'approved')).toBe(true);
    expect(live.steps.some((step) => step.kind === 'tool' && step.content.includes('event-report.html'))).toBe(true);
    expect(live.steps.some((step) => step.kind === 'workflow' && step.title === '工作流完成')).toBe(true);
  });

  it('keeps long research progress and updates a running step when completed', () => {
    const common = {
      run_id: 'run-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      created_at: '2026-05-28T12:00:00.000Z',
      event_type: 'research_progress',
    };
    let blocks = applyAgentRunEvent([], {
      ...common,
      event_id: 'collect-running',
      status: 'running',
      title: 'Step4: data_collect (微博)',
      detail: '平台=微博 -> data_collect',
      payload: {
        kind: 'deep_research_progress',
        phase: 'data_collect',
        step: 'step4:data_collect:微博',
        status: 'running',
      },
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'collect-completed',
      status: 'completed',
      title: '平台采集完成 微博',
      detail: 'rows=1780',
      payload: {
        kind: 'deep_research_progress',
        phase: 'data_collect',
        rows: 1780,
        step: 'step4:data_collect:微博',
        status: 'completed',
      },
    });
    for (let index = 5; index <= 9; index += 1) {
      blocks = applyAgentRunEvent(blocks, {
        ...common,
        event_id: `event-${index}`,
        status: 'running',
        title: `Step${index}: stage`,
        detail: `detail-${index}`,
        payload: {
          kind: 'deep_research_progress',
          phase: index === 9 ? 'judgement' : 'stats',
          step: `step${index}`,
          status: 'running',
        },
      });
    }

    const live = blocksFromStream(blocks);
    const collectSteps = live.steps.filter((step) => step.kind === 'research' && step.phase === 'data_collect');
    expect(collectSteps).toHaveLength(1);
    expect(collectSteps[0].status).toBe('completed');
    expect(collectSteps[0].title).toContain('平台采集完成');
    expect(live.steps.filter((step) => step.kind === 'research')).toHaveLength(6);
    expect(live.steps.some((step) => step.kind === 'research' && step.title.includes('Step9'))).toBe(true);
  });

  it('promotes final report artifact urls into the assistant answer', () => {
    const common = {
      run_id: 'run-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      created_at: '2026-06-17T02:04:56.000Z',
    };
    let blocks = applyAgentRunEvent([], {
      ...common,
      event_id: 'approval',
      event_type: 'approval_requested',
      status: 'pending',
      title: '建议搜索采集方案（等待确认）',
      detail: JSON.stringify({
        analysis_workers: 2,
        data_collect_workers: 1,
        data_num_workers: 2,
        keyword_combination_mode: '逐词检索并合并（当前实现）',
        platforms: ['微博'],
        return_count: 2000,
        searchWords_preview: ['美伊冲突'],
        time_range: '2026-05-17 23:59:59;2026-06-16 23:59:59',
      }, null, 2),
      payload: {},
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'artifact-report',
      event_type: 'artifact_created',
      status: 'completed',
      title: 'full_report_mode_node',
      detail: 'file:///F:/sona-master/sandbox/2489061a-1f16-4c6b-becd-3a27a75717a7/%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260617_100455.html',
      payload: {
        result: 'file:///F:/sona-master/sandbox/2489061a-1f16-4c6b-becd-3a27a75717a7/%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260617_100455.html',
        tool_name: 'full_report_mode_node',
      },
    });
    blocks = applyAgentRunEvent(blocks, {
      ...common,
      event_id: 'run-done',
      event_type: 'run_completed',
      status: 'succeeded',
      title: '工作流完成',
      detail: '已完成舆情事件分析工作流。报告：file:///F:/sona-master/sandbox/2489061a-1f16-4c6b-becd-3a27a75717a7/%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260617_100455.html',
      payload: {},
    });

    const live = blocksFromStream(blocks);
    expect(live.answer).toContain('report_20260617_100455.html');
    expect(live.answer).toContain('file:///F:/sona-master/sandbox');
    expect(live.answer).not.toContain('keyword_combination_mode');
    const approval = live.steps.find((step) => step.kind === 'approval');
    expect(approval?.status).toBe('approved');
  });
});

describe('slashStreamingRunOptions', () => {
  it('maps /event to the canonical Agent run streaming mode', () => {
    expect(slashStreamingRunOptions('/event')).toEqual({
      command: '/event',
      mode: 'event',
      routeLabel: '事件分析中',
    });
  });

  it('keeps /wiki on the same streaming path', () => {
    expect(slashStreamingRunOptions('/wiki')).toEqual({
      command: '/wiki',
      mode: 'wiki',
      routeLabel: 'Wiki 检索中',
    });
  });
});

describe('buildConversationTurns', () => {
  it('does not persist a fake loading placeholder when assistant is missing', () => {
    const turns = buildConversationTurns([{ role: 'user', content: '问题' }]);
    expect(turns).toHaveLength(1);
    expect(turns[0].kind).toBe('user');
  });

  it('does not treat long analysis text as stub', () => {
    const long =
      'OPPO母亲节广告文案争议舆情分析：2026年5月8日左右，OPPO发布母亲节主题广告，因表述引发全网批评。';
    expect(isStubText(long)).toBe(false);
    const turns = buildConversationTurns([
      { role: 'user', content: '分析' },
      { role: 'assistant', content: long },
    ]);
    expect(turns.some((t) => t.kind === 'assistant' && t.answer === long)).toBe(true);
  });

  it('merges consecutive assistant turns', () => {
    const turns = buildConversationTurns([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '短' },
      { role: 'assistant', content: '更长的助手回复内容' },
    ]);
    const assistants = turns.filter((t) => t.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].answer).toBe('更长的助手回复内容');
  });

  it('restores separate agent_events as assistant process steps', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '舆情分析方法', timestamp: '2026-05-27T20:13:58.000Z' },
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-05-27T20:14:06.000Z',
        tool_calls: [{ id: 'mode_full_task', name: 'full_report_mode_node', args: { query: '舆情分析方法' } }],
      },
      { role: 'user', content: '舆情分析方法', timestamp: '2026-05-27T20:14:06.000Z' },
    ];
    const events: AgentRunEvent[] = [
      {
        event_id: 'event-1',
        run_id: 'run-1',
        session_id: 'task',
        turn_id: 'turn',
        event_type: 'agent_step_started',
        title: '路由与执行计划',
        detail: '正在判断任务类型并准备执行。',
        payload: {},
        created_at: '2026-05-27T20:14:05.000Z',
      },
      {
        event_id: 'event-2',
        run_id: 'run-1',
        session_id: 'task',
        turn_id: 'turn',
        event_type: 'run_failed',
        title: '工作流失败',
        detail: 'Expecting value',
        payload: {},
        created_at: '2026-05-27T20:14:06.500Z',
      },
    ];

    const turns = buildConversationTurns(messages, events);
    expect(turns.filter((turn) => turn.kind === 'user')).toHaveLength(1);
    const assistant = turns.find((turn) => turn.kind === 'assistant');
    expect(assistant?.answer).not.toContain('"query"');
    expect(assistant?.steps.some((step) => step.title === '路由与执行计划')).toBe(true);
    expect(assistant?.steps.some((step) => step.title === '系统' && step.content === 'Expecting value')).toBe(true);
  });

  it('uses a synthetic assistant id when only agent_events exist for a user turn', () => {
    const turns = buildConversationTurns(
      [{ id: 'msg_same', role: 'user', content: '舆情分析方法', timestamp: '2026-05-27T20:13:58.000Z' }],
      [
        {
          event_id: 'event-1',
          run_id: 'run-1',
          session_id: 'task',
          turn_id: 'turn',
          event_type: 'agent_step_completed',
          title: '工作流完成',
          detail: '报告已生成',
          payload: {},
          created_at: '2026-05-27T20:14:05.000Z',
        },
      ],
    );

    expect(turns.map((turn) => turn.id)).toEqual(['msg_same', 'assistant-msg_same']);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(turns.length);
  });
});

describe('dedupeMessages', () => {
  it('removes back-to-back duplicates', () => {
    const out = dedupeMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'a' },
    ]);
    expect(out).toHaveLength(1);
  });
});

