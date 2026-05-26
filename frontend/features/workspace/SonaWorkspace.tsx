'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { App, Button, Dropdown, Segmented, Tag } from 'antd';
import { LoadingDots, TokenTag } from '@lobehub/ui/chat';
import { SonaChatComposer } from '@/features/workspace/SonaChatComposer';
import { SonaChatThread } from '@/features/workspace/SonaChatThread';
import { SonaSidebar } from '@/features/workspace/SonaSidebar';
import {
  applyAgentRunEvent,
  blocksFromStream,
  buildConversationTurns,
  hasVisibleTurns,
  isStubText,
} from '@/features/workspace/chatMessageUi';
import type { ConversationTurn } from '@/types/conversation';
import { useChatSession } from '@/features/workspace/useChatSession';
import {
  Archive,
  Copy,
  FileText,
  Flame,
  Link,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { sonaApi, streamAgentRunEvents } from '@/services/sonaApi';
import { useAppStore } from '@/stores/appStore';
import type { AgentApprovalAction, ApiHealth, ComposerCommand, ModelInfo, ToolInfo } from '@/types/sona';
import type { AgentStep } from '@/types/conversation';
import { commandInputValue } from '@/features/workspace/sonaToolUi';
import {
  mergeSessionList,
  sessionDisplayLabel,
  sessionsAreDuplicates,
} from '@/features/workspace/sessionIdentity';

type UtilityTab = 'tasks' | 'profile' | 'models' | 'tools' | 'monitor';

type ActivityEntry = {
  id: string;
  label: string;
  detail?: string;
};

function shortId(id?: string) {
  return id ? `${id.slice(0, 8)}...` : '未选择';
}

function formatObject(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function taskStatusColor(status: string) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'processing';
  return 'default';
}

function contentFromResult(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function sessionTitle(session: { description?: string; initial_query?: string; task_id?: string }) {
  return sessionDisplayLabel(session);
}

export function SonaWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydratedRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const { message: messageApi, modal: modalApi } = App.useApp();
  const {
    activeSession,
    activeReportTaskId,
    currentTaskId,
    messages,
    sessions,
    sessionLoading,
    sessionError,
    tasks,
    addMessage,
    commitStreamReply,
    setActiveReportTaskId,
    setActiveSession,
    setSessions,
    setTasks,
    upsertSession,
    streamBlocks,
    clearStreamBlocks,
    setStreamBlocks,
  } = useAppStore();
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [apiError, setApiError] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [routeStatus, setRouteStatus] = useState('待命');
  const [utilityTab, setUtilityTab] = useState<UtilityTab>('tasks');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [commands, setCommands] = useState<ComposerCommand[]>([]);
  const [monitorResult, setMonitorResult] = useState('');
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [topicOpen, setTopicOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [homeMode, setHomeMode] = useState(true);
  const [sidebarExpand, setSidebarExpand] = useState(true);
  const [activeRun, setActiveRun] = useState<{ runId: string; taskId: string } | null>(null);

  const chatSession = useChatSession({
    setHomeMode,
    onError: (message) => messageApi.error(message),
  });

  const reportSrc = activeReportTaskId ? `/api/sona/v1/tasks/${activeReportTaskId}/report` : '';

  const visibleTasks = useMemo(
    () => [...tasks].reverse(),
    [tasks],
  );

  const visibleSessions = useMemo(() => {
    const text = searchText.trim().toLowerCase();
    const merged = [activeSession, ...sessions].filter((session): session is NonNullable<typeof session> =>
      Boolean(session?.task_id),
    );
    const deduped = mergeSessionList(merged);
    if (!text) return deduped;
    return deduped.filter((session) => {
      const title = `${sessionTitle(session)} ${session.task_id}`.toLowerCase();
      return title.includes(text);
    });
  }, [activeSession, searchText, sessions]);

  const conversationTurns = useMemo(() => {
    const turns = buildConversationTurns(messages);
    if (!busy) return turns;
    const last = turns[turns.length - 1];
    if (
      last?.kind === 'assistant' &&
      last.answer &&
      !last.answer.startsWith('（回复加载中') &&
      !streamBlocks.length
    ) {
      return turns;
    }
    const { answer, steps } = streamBlocks.length
      ? blocksFromStream(streamBlocks)
      : { answer: '正在连接后台…', steps: [] };
    const live: ConversationTurn = {
      id: 'live-stream',
      kind: 'assistant',
      timestamp: Date.now(),
      answer: answer || '生成中…',
      steps,
    };
    if (last?.kind === 'assistant' && last.answer.startsWith('（回复加载中')) {
      return [...turns.slice(0, -1), live];
    }
    return [...turns, live];
  }, [busy, messages, streamBlocks]);

  function abortActiveStream() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  async function handleAgentApproval(step: AgentStep, action: AgentApprovalAction) {
    const runId = step.runId || activeRun?.runId;
    const taskId = currentTaskId || activeRun?.taskId;
    if (!runId || !taskId) {
      messageApi.error('找不到等待确认的 Agent run');
      return;
    }
    let patch: Record<string, unknown> = {};
    if (action === 'edit') {
      const initial = JSON.stringify(step.payload || {}, null, 2);
      const raw = window.prompt('修改采集方案 JSON，确认后继续执行', initial);
      if (raw == null) return;
      try {
        patch = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        messageApi.error('JSON 格式不正确');
        return;
      }
    }
    try {
      await sonaApi.approveAgentRun(taskId, runId, action, patch);
      setRouteStatus(action === 'abort' ? '终止中' : '继续执行');
      pushActivity(action === 'edit' ? '采集方案已修改' : action === 'abort' ? '已请求终止' : '采集方案已确认');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApiError(message);
      messageApi.error(message);
    }
  }

  const showChat = Boolean(currentTaskId) && !homeMode;

  function openReportPanel(taskId: string) {
    setActiveReportTaskId(taskId);
    setTopicOpen(true);
    setUtilityTab('tasks');
  }

  function pushActivity(label: string, detail?: string) {
    setActivityLog((items) => [
      { detail, id: `${Date.now()}-${items.length}`, label },
      ...items.slice(0, 5),
    ]);
  }

  async function refreshStatus() {
    try {
      setApiError('');
      const [nextHealth, taskList, sessionList] = await Promise.all([
        sonaApi.health(),
        sonaApi.listTasks(),
        chatSession.refreshSessions(),
      ]);
      setHealth(nextHealth);
      const nextTasks = taskList.tasks || [];
      setTasks(nextTasks);
      await chatSession.syncCurrentSessionIfNeeded(sessionList);
      const currentReport = currentTaskId
        ? nextTasks.find(
            (task) =>
              task.task_id === currentTaskId &&
              task.status === 'succeeded' &&
              task.artifacts?.report_path,
          )
        : undefined;
      if (currentReport) {
        setActiveReportTaskId(currentReport.task_id);
      } else if (!activeReportTaskId) {
        const firstReport = nextTasks.find(
          (task) => task.status === 'succeeded' && task.artifacts?.report_path,
        );
        if (firstReport) setActiveReportTaskId(firstReport.task_id);
      }
    } catch (error) {
      setHealth(null);
      setApiError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectSession(taskId: string) {
    abortActiveStream();
    if (taskId === currentTaskId && !homeMode) {
      await chatSession.reloadSession(taskId);
      return;
    }
    setRouteStatus('待命');
    await chatSession.openSession(taskId);
    router.replace(`/?session=${encodeURIComponent(taskId)}`, { scroll: false });
  }

  function openUtility(tab: UtilityTab) {
    setUtilityTab(tab);
    setTopicOpen(true);
  }

  function openHome() {
    chatSession.openHome();
    setTopicOpen(false);
    setRouteStatus('待命');
  }

  async function createNewSession() {
    await chatSession.createEmptySession();
    setActivityLog([]);
    setRouteStatus('新话题');
  }

  async function copyText(text: string, success: string) {
    await navigator.clipboard.writeText(text);
    messageApi.success(success);
  }

  function sessionLink(taskId: string) {
    return `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(taskId)}`;
  }

  async function renameSession(taskId: string) {
    const current = visibleSessions.find((session) => session.task_id === taskId);
    const nextTitle = window.prompt('重命名话题', current ? sessionTitle(current) : '');
    const title = nextTitle?.trim();
    if (!title) return;
    try {
      const updated = await sonaApi.updateSession(taskId, title);
      if (currentTaskId === taskId) setActiveSession(updated);
      upsertSession(updated);
      messageApi.success('话题已重命名');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApiError(message);
      messageApi.error(message);
    }
  }

  function confirmDeleteSession(taskId: string) {
    const target = visibleSessions.find((session) => session.task_id === taskId);
    const deleteIds = target
      ? visibleSessions
          .filter((session) => sessionsAreDuplicates(session, target))
          .map((session) => session.task_id)
      : [taskId];
    modalApi.confirm({
      centered: true,
      title: null,
      content:
        deleteIds.length > 1
          ? `即将删除此话题及 ${deleteIds.length - 1} 个重复历史会话，该操作无法撤销。`
          : '即将删除此话题，该操作无法撤销。',
      okText: '确定',
      cancelText: '取消',
      onOk: async () => {
        chatSession.rememberDeletedSessionIds(deleteIds);
        useAppStore.getState().removeSessions(deleteIds);

        let remaining = useAppStore.getState().sessions;
        for (const id of deleteIds) {
          try {
            const result = await sonaApi.deleteSession(id);
            remaining = result.sessions || remaining;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Session not found')) throw error;
          }
        }

        const visibleRemaining = mergeSessionList(
          remaining.filter((session) => !deleteIds.includes(session.task_id)),
        );
        setSessions(visibleRemaining);
        if (currentTaskId && deleteIds.includes(currentTaskId)) {
          await chatSession.handleDeletedCurrent(visibleRemaining);
        }
        messageApi.success('话题已删除');
      },
    });
  }

  async function runSessionAction(taskId: string, action: string) {
    if (action === 'rename') {
      await renameSession(taskId);
      return;
    }
    if (action === 'copyId') {
      await copyText(taskId, '已复制会话 ID');
      return;
    }
    if (action === 'copyLink') {
      await copyText(sessionLink(taskId), '已复制链接');
      return;
    }
    if (action === 'delete') {
      confirmDeleteSession(taskId);
    }
  }

  async function handleSlashCommand(command: string) {
    const [head, ...restParts] = command.trim().split(/\s+/);
    const rest = restParts.join(' ').trim();
    const cmd = head.toLowerCase();

    if (cmd === '/event') {
      if (!rest) throw new Error('/event 需要事件描述');
      setRouteStatus('事件分析');
      const task = await sonaApi.analyzeEvent(rest);
      if (task.status === 'succeeded') {
        setActiveReportTaskId(task.task_id);
        setTopicOpen(true);
        setUtilityTab('tasks');
        messageApi.success('报告已生成');
      } else {
        setActiveReportTaskId('');
        const message = task.error?.error_message || `任务状态：${task.status}`;
        setApiError(message);
        messageApi.error(message);
      }
      await refreshStatus();
      return;
    }
    if (cmd === '/wiki') {
      if (!rest) throw new Error('/wiki 需要问题文本');
      setRouteStatus('知识库');
      const session = await chatSession.ensureSession(rest, { forceNew: homeMode });
      addMessage({ role: 'user', content: rest });
      const result = await sonaApi.wikiQuery(rest, session.task_id);
      addMessage({ role: 'assistant', content: result.answer || '未返回回答' });
      await chatSession.reloadSession(session.task_id);
      return;
    }
    if (cmd === '/wiki-approve') {
      setRouteStatus('知识库确认');
      const result = await sonaApi.wikiApprove(rest);
      setMonitorResult(formatObject(result));
      openUtility('monitor');
      messageApi.success('已确认');
      return;
    }
    if (cmd === '/case') {
      if (!rest) throw new Error('/case 需要检索问题');
      setRouteStatus('案例检索');
      const session = await chatSession.ensureSession(rest, { forceNew: homeMode });
      addMessage({ role: 'user', content: rest });
      const result = await sonaApi.caseSearch(rest, session.task_id);
      addMessage({ role: 'assistant', content: result.answer || '未找到匹配案例' });
      await chatSession.reloadSession(session.task_id);
      return;
    }
    if (cmd === '/hot') {
      setRouteStatus('热点任务');
      const result = await sonaApi.hotRun(rest);
      setMonitorResult(formatObject(result));
      openUtility('monitor');
      messageApi.success('热点任务已完成');
      return;
    }
    if (cmd === '/models') {
      const result = await sonaApi.models();
      setModels(result.models || []);
      openUtility('models');
      return;
    }
    if (cmd === '/tools') {
      const result = await sonaApi.tools();
      setTools(result.tools || []);
      openUtility('tools');
      return;
    }
    if (cmd === '/monitor') {
      await handleMonitor(rest);
      return;
    }
    if (cmd === '/new') {
      await createNewSession();
      return;
    }
    if (cmd === '/memory') {
      const listed = await chatSession.refreshSessions();
      const session = listed[0];
      if (session?.task_id) {
        await chatSession.openSession(session.task_id);
      }
      setRouteStatus('最近话题');
      return;
    }
    if (['/set', '/clear', '/compress', '/exit'].includes(cmd)) {
      messageApi.info('此操作在管理入口处理');
      setRouteStatus('待命');
      return;
    }
    throw new Error(`未知指令：${cmd}`);
  }

  async function handleMonitor(rest: string) {
    const [sub = 'list', ...args] = rest.split(/\s+/);
    openUtility('monitor');
    setRouteStatus(`专题 ${sub}`);
    if (sub === 'demo') {
      const result = await sonaApi.monitorDemo();
      setMonitorResult(formatObject(result));
      return;
    }
    if (sub === 'create') {
      const raw = args.join(' ');
      const [name, domain = '综合舆情', keywordText = ''] = raw.split('|').map((item) => item.trim());
      if (!name) throw new Error('/monitor create 需要：名称|领域|关键词1,关键词2');
      const result = await sonaApi.monitorCreate({
        name,
        domain,
        keywords: keywordText.split(',').map((item) => item.trim()).filter(Boolean),
      });
      setMonitorResult(formatObject(result));
      return;
    }
    if (sub === 'status') {
      const topicId = args[0];
      if (!topicId) throw new Error('/monitor status 需要 topic_id');
      const result = await sonaApi.monitorStatus(topicId);
      setMonitorResult(formatObject(result));
      return;
    }
    if (sub === 'report') {
      const [topicId, period = 'daily'] = args;
      if (!topicId) throw new Error('/monitor report 需要 topic_id');
      const result = await sonaApi.monitorReport(topicId, period);
      setMonitorResult(formatObject(result));
      const readable = contentFromResult(result, ['summary', 'answer', 'report', 'content']);
      if (readable) addMessage({ role: 'assistant', content: readable });
      return;
    }
    const result = await sonaApi.monitorList();
    setMonitorResult(formatObject(result));
  }

  async function executeQuery(query: string) {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setApiError('');
    setInput('');
    try {
      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed);
      } else {
        const session = await chatSession.ensureSession(trimmed, { forceNew: homeMode });
        const streamTaskId = session.task_id;
        addMessage({
          role: 'user',
          content: trimmed,
          timestamp: new Date().toISOString(),
        });
        setRouteStatus('创建 Agent run');
        clearStreamBlocks();
        const controller = new AbortController();
        streamAbortRef.current = controller;
        try {
          const run = await sonaApi.createAgentRun(streamTaskId, {
            query: trimmed,
            auto_route: true,
            prefer_existing_data: true,
          });
          setActiveRun({ runId: run.run_id, taskId: streamTaskId });
          setRouteStatus('Agent 运行中');
          await streamAgentRunEvents(streamTaskId, run.run_id, {
            signal: controller.signal,
            onEvent: (item) => {
              if (useAppStore.getState().currentTaskId !== streamTaskId) return;
              const event = item.data;
              setStreamBlocks(applyAgentRunEvent(useAppStore.getState().streamBlocks, event));
              if (event.event_type === 'agent_step_completed' && event.payload?.route) {
                setRouteStatus(`${String(event.payload.route || '')} · ${String(event.payload.task_mode || '')}`);
              }
              if (event.event_type === 'research_progress') {
                setRouteStatus('深度研究中');
                pushActivity(event.title || '深度研究进度', event.detail || '');
              }
              if (event.event_type === 'approval_requested') {
                setRouteStatus('等待确认');
                pushActivity(event.title || '等待确认', event.detail || '');
              }
              if (event.event_type === 'agent_step_started' || event.event_type === 'agent_step_updated') {
                pushActivity(event.title || '工作流步骤', event.detail || '');
              }
              if (event.event_type === 'tool_call_started') {
                pushActivity(`调用 ${String(event.payload?.tool_name || event.title || '工具')}`);
              }
              if (event.event_type === 'tool_call_completed' || event.event_type === 'artifact_created') {
                pushActivity(
                  `完成 ${String(event.payload?.tool_name || event.title || '工具')}`,
                  String(event.payload?.result || event.detail || '').slice(0, 400),
                );
              }
              if (event.event_type === 'run_completed') {
                setRouteStatus('完成');
              }
              if (event.event_type === 'run_failed') {
                throw new Error(event.detail || 'Agent run failed');
              }
            },
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        } finally {
          if (streamAbortRef.current === controller) {
            streamAbortRef.current = null;
          }
        }
        if (useAppStore.getState().currentTaskId === streamTaskId) {
          const { answer } = blocksFromStream(useAppStore.getState().streamBlocks);
          if (answer && !isStubText(answer)) {
            commitStreamReply(answer);
          } else {
            commitStreamReply('本次后台流程已结束，但没有返回可显示文本。请查看 Agent 过程或重试。');
          }
          await chatSession.reloadSession(streamTaskId);
          clearStreamBlocks();
        }
        setActiveRun(null);
        await refreshStatus();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApiError(message);
      messageApi.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    await executeQuery(input);
  }

  async function handleComposerCommand(command: ComposerCommand) {
    if (command.action === 'run') {
      await executeQuery(command.default_query || command.command);
      return;
    }
    setInput(commandInputValue(command));
  }

  useEffect(() => {
    // Hydrate remote API state on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    sonaApi.models().then((result) => setModels(result.models || [])).catch(() => undefined);
    sonaApi.tools().then((result) => setTools(result.tools || [])).catch(() => undefined);
    sonaApi.commands().then((result) => setCommands(result.commands || [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const urlSession = searchParams.get('session');
    void chatSession.hydrateFromUrl(urlSession).then((loaded) => {
      if (!loaded && !urlSession) return;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <main className="sonarShell">
      <SonaSidebar
        activeTaskId={currentTaskId}
        apiError={apiError || sessionError || ''}
        expand={sidebarExpand}
        health={health}
        homeMode={homeMode}
        onExpandChange={setSidebarExpand}
        onCreateSession={createNewSession}
        onHome={openHome}
        onOpenProfile={() => openUtility('profile')}
        onOpenTasks={() => openUtility('tasks')}
        onRefresh={refreshStatus}
        onSearchChange={setSearchText}
        onSelectSession={selectSession}
        onSessionAction={runSessionAction}
        onToday={() => handleSlashCommand('/memory')}
        searchText={searchText}
        sessionTitle={sessionTitle}
        sessions={visibleSessions}
      />

      <section className="conversationPane">
        <header className="sonarHeader">
          <div className="headerTitle">
            <strong>{showChat ? sessionTitle(activeSession || {}) : '首页'}</strong>
            {showChat && activeSession?.task_id ? (
              <Dropdown
                menu={{
                  onClick: ({ key }) => runSessionAction(activeSession.task_id, key),
                  items: [
                    { icon: <Pencil size={15} />, key: 'rename', label: '重命名' },
                    { icon: <Copy size={15} />, key: 'copyId', label: '复制会话 ID' },
                    { icon: <Link size={15} />, key: 'copyLink', label: '复制链接' },
                    { danger: true, icon: <Trash2 size={15} />, key: 'delete', label: '删除' },
                  ],
                }}
                trigger={['click']}
              >
                <button><MoreHorizontal size={17} /></button>
              </Dropdown>
            ) : null}
          </div>
          <div className="headerActions">
            <Tag color={busy ? 'processing' : 'default'}>{routeStatus}</Tag>
            {activeSession?.token_usage ? (
              <TokenTag
                maxValue={200000}
                mode="used"
                showInfo={false}
                value={Number(activeSession.token_usage.total_tokens || 0)}
              />
            ) : null}
            <button onClick={() => setTopicOpen((open) => !open)} title="打开侧栏">
              <PanelRight size={18} />
            </button>
          </div>
        </header>

        <div className="workspaceBody">
          <div className="conversationStage">
            <div className={`conversationScroll${sessionLoading ? ' isLoading' : ''}`}>
              {sessionLoading ? (
                <div className="sessionLoadingBar">
                  <LoadingDots />
                </div>
              ) : null}
              <div className={showChat ? 'chatCanvas' : 'homeCanvas'}>
                {!showChat ? (
                  <section className="homeHero">
                    <div className="heroAgent">
                      <span className="sonaMark large">📡</span>
                      <strong>Sona AI</strong>
                    </div>
                    <h1>今日目标，稳步达成</h1>
                    <p>带着新问题来了吧</p>
                    <div className="homeShortcuts">
                      <button onClick={() => setInput('/event ')}>事件分析</button>
                      <button onClick={() => setInput('/wiki ')}>知识库</button>
                      <button onClick={() => setInput('/case ')}>案例检索</button>
                    </div>
                    <div className="briefList">
                      <div className="briefHead">
                        <strong>简报</strong>
                        <button onClick={() => openUtility('tasks')}>查看任务</button>
                      </div>
                      <button onClick={() => setInput('/event 近期舆情事件分析')}>
                        <FileText size={18} />
                        <span>舆情事件分析</span>
                        <small>生成事件脉络、观点聚类和报告</small>
                      </button>
                      <button onClick={() => setInput('/wiki 舆情分析方法')}>
                        <FileText size={18} />
                        <span>知识库问答</span>
                        <small>查询本地 Wiki 与资料库</small>
                      </button>
                    </div>
                  </section>
                ) : !hasVisibleTurns(conversationTurns) ? (
                  <div className="chatEmpty">
                    <span className="sonaMark large">📡</span>
                    <strong>Sona AI</strong>
                    <p className="chatEmptyHint">
                      {activeSession?.initial_query &&
                      activeSession.initial_query !== 'Sona session' &&
                      activeSession.initial_query !== 'Frontend session'
                        ? `话题：${activeSession.initial_query}`
                        : '这是新话题，发送第一条消息开始对话。'}
                    </p>
                    {apiError || sessionError ? (
                      <p className="chatEmptyError">{apiError || sessionError}</p>
                    ) : null}
                  </div>
                ) : (
                  <SonaChatThread
                    currentTaskId={currentTaskId}
                    onApproval={handleAgentApproval}
                    onOpenReport={openReportPanel}
                    turns={conversationTurns}
                  />
                )}
                {busy ? (
                  <div className="streaming">
                    <LoadingDots />
                  </div>
                ) : null}
              </div>
            </div>

            <SonaChatComposer
              busy={busy}
              commands={commands}
              onCommand={handleComposerCommand}
              onInput={setInput}
              onSend={submit}
              value={input}
            />
          </div>

          <aside className={`topicPanel ${topicOpen ? 'open' : 'closed'}`}>
            <Segmented
              block
              value={utilityTab}
              onChange={(value) => setUtilityTab(value as UtilityTab)}
              options={[
                { label: '任务', value: 'tasks' },
                { label: '档案', value: 'profile' },
                { label: '模型', value: 'models' },
                { label: '工具', value: 'tools' },
                { label: '专题', value: 'monitor' },
              ]}
            />

            {activityLog.length ? (
              <div className="activityPanel">
                {activityLog.map((entry) => (
                  <div className="activityItem" key={entry.id}>
                    <strong>{entry.label}</strong>
                    {entry.detail ? <span>{entry.detail}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {utilityTab === 'tasks' ? (
              <div className="panel">
                <div className="panelTitle">
                  <FileText size={18} />
                  <strong>报告任务</strong>
                </div>
                <div className="taskList">
                  {visibleTasks.map((task) => (
                    <button
                      key={task.task_id}
                      onClick={() =>
                        setActiveReportTaskId(
                          task.status === 'succeeded' && task.artifacts?.report_path ? task.task_id : '',
                        )
                      }
                    >
                      <span>{shortId(task.task_id)}</span>
                      <Tag color={taskStatusColor(task.status)}>{task.status}</Tag>
                      {task.status === 'succeeded' && !task.artifacts?.report_path ? (
                        <small className="muted">未记录报告路径</small>
                      ) : null}
                      {task.status === 'failed' && task.error?.error_message ? (
                        <small className="muted">{task.error.error_message.slice(0, 180)}</small>
                      ) : null}
                    </button>
                  ))}
                  {!visibleTasks.length ? <p className="muted">暂无任务记录。</p> : null}
                </div>
                {reportSrc ? <iframe className="reportFrame" src={reportSrc} sandbox="allow-scripts allow-same-origin" /> : null}
              </div>
            ) : null}

            {utilityTab === 'profile' ? (
              <div className="panel listPanel">
                <div className="panelTitle">
                  <Archive size={18} />
                  <strong>助理档案</strong>
                </div>
                <div className="profileSummary">
                  <span>模型 {models.length}</span>
                  <span>工具 {tools.length}</span>
                </div>
                {models.slice(0, 3).map((model) => (
                  <div className="lineItem" key={`profile-model-${model.name}`}>
                    <strong>{model.name}</strong>
                    <span>{model.provider} · {model.model}</span>
                  </div>
                ))}
                {tools.slice(0, 5).map((tool) => (
                  <div className="lineItem" key={`profile-tool-${tool.name}`}>
                    <strong>{tool.name}</strong>
                    <span>{tool.description || '无描述'}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {utilityTab === 'models' ? (
              <div className="panel listPanel">
                {models.map((model) => (
                  <div className="lineItem" key={model.name}>
                    <strong>{model.name}</strong>
                    <span>{model.provider} · {model.model}</span>
                    <small>{model.api_key_env}</small>
                  </div>
                ))}
              </div>
            ) : null}

            {utilityTab === 'tools' ? (
              <div className="panel listPanel">
                {tools.map((tool) => (
                  <div className="lineItem" key={tool.name}>
                    <strong>{tool.name}</strong>
                    <span>{tool.description || '无描述'}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {utilityTab === 'monitor' ? (
              <div className="panel">
                <div className="panelTitle">
                  <Flame size={18} />
                  <strong>专题监测</strong>
                </div>
                <div className="quickActions">
                  <Button icon={<Play size={15} />} onClick={() => handleSlashCommand('/monitor list')}>列表</Button>
                  <Button icon={<Play size={15} />} onClick={() => handleSlashCommand('/monitor demo')}>演示</Button>
                </div>
                <pre className="jsonBox">{monitorResult || '暂无专题数据'}</pre>
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
}
