'use client';

import type { AgentStep, ConversationTurn } from '@/types/conversation';
import { Button } from 'antd';
import { AccordionItem } from '@lobehub/ui';
import {
  ChatList,
  type ChatMessage as LobeChatMessage,
  type OnActionsClick,
  type OnMessageChange,
} from '@lobehub/ui/chat';
import { Activity, Check, PencilLine, X } from 'lucide-react';
import { SonaChatAnswer } from '@/features/workspace/SonaChatAnswer';
import { SONA_ASSISTANT_TITLE } from '@/features/workspace/chatMessageUi';
import type { AgentApprovalAction } from '@/types/sona';

function formatChatTime(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function AgentStepsPanel({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  return (
    <AccordionItem
      classNames={{ base: 'sonaAgentSteps' }}
      defaultExpand={false}
      itemKey="agent-steps"
      padding={8}
      title={(
        <span className="sonaAgentStepsTitle">
        Agent 过程
          <span className="sonaAgentStepsCount">{steps.length} 步</span>
        </span>
      )}
      variant="outlined"
    >
      <ol className="sonaAgentStepsList">
        {steps.map((step) => (
          <li key={step.id} className={`sonaAgentStep sonaAgentStep--${step.kind}`}>
            <span className="sonaAgentStepTitle">{step.title}</span>
            <pre>{step.content}</pre>
          </li>
        ))}
      </ol>
    </AccordionItem>
  );
}

function ResearchProgressPanel({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  const ordered = steps.slice(-8);
  return (
    <section className="sonaResearchPanel">
      <div className="sonaResearchHeader">
        <Activity size={15} />
        <strong>深度研究进度</strong>
        <span>{ordered.filter((step) => step.status === 'completed').length}/{ordered.length}</span>
      </div>
      <ol className="sonaResearchList">
        {ordered.map((step) => (
          <li key={step.id} className={`sonaResearchItem sonaResearchItem--${step.status || 'running'}`}>
            <span className="sonaResearchDot" />
            <div>
              <div className="sonaResearchTitle">
                <strong>{step.title}</strong>
                {step.phase ? <span>{step.phase}</span> : null}
              </div>
              {step.content ? <p>{step.content}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ApprovalPanel({
  onApproval,
  step,
}: {
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  step: AgentStep;
}) {
  const pending = step.status === 'pending';
  return (
    <section className="sonaApprovalPanel">
      <div className="sonaApprovalHeader">
        <strong>{step.title}</strong>
        <span>{step.status === 'recorded' ? '已记录' : '等待处理'}</span>
      </div>
      <pre>{step.content}</pre>
      <div className="sonaApprovalActions">
        <Button disabled={!pending || !onApproval} icon={<Check size={14} />} onClick={() => onApproval?.(step, 'accept')} size="small">采用</Button>
        <Button disabled={!pending || !onApproval} icon={<PencilLine size={14} />} onClick={() => onApproval?.(step, 'edit')} size="small">请求修改</Button>
        <Button disabled={!pending || !onApproval} danger icon={<X size={14} />} onClick={() => onApproval?.(step, 'abort')} size="small">终止</Button>
      </div>
    </section>
  );
}

function AssistantInlinePanels({
  onApproval,
  turn,
}: {
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  turn: ConversationTurn;
}) {
  if (turn.kind !== 'assistant') return null;
  const research = turn.steps.filter((step) => step.kind === 'research');
  const approvals = turn.steps.filter((step) => step.kind === 'approval');
  const agentSteps = turn.steps.filter((step) => step.kind !== 'approval' && step.kind !== 'research');
  if (!research.length && !approvals.length && !agentSteps.length) return null;
  return (
    <div className="sonaAssistantInlinePanels">
      <ResearchProgressPanel steps={research} />
      {approvals.map((step) => (
        <ApprovalPanel key={step.id} onApproval={onApproval} step={step} />
      ))}
      <AgentStepsPanel steps={agentSteps} />
    </div>
  );
}

type SonaChatThreadProps = {
  turns: ConversationTurn[];
  currentSessionId?: string;
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  onMessageAction?: OnActionsClick;
  onMessageChange?: OnMessageChange;
  onOpenReport?: (sessionId: string) => void;
};

type LobeExtra = {
  currentSessionId?: string;
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  onOpenReport?: (sessionId: string) => void;
  turn: ConversationTurn;
};

function lobeMessagesFromTurns(
  turns: ConversationTurn[],
  extra: Omit<LobeExtra, 'turn'>,
): LobeChatMessage[] {
  return turns.map((turn) => ({
    content: turn.kind === 'user' ? turn.content : turn.answer,
    createAt: turn.timestamp,
    extra: { ...extra, turn },
    id: turn.id,
    meta: {
      avatar: turn.kind === 'user' ? '你' : '📡',
      title: turn.kind === 'user' ? '用户' : SONA_ASSISTANT_TITLE,
    },
    role: turn.kind === 'user' ? 'user' : 'assistant',
    updateAt: turn.timestamp,
  }));
}

export function SonaChatThread({
  turns,
  currentSessionId,
  onApproval,
  onMessageAction,
  onMessageChange,
  onOpenReport,
}: SonaChatThreadProps) {
  const data = lobeMessagesFromTurns(turns, { currentSessionId, onApproval, onOpenReport });
  return (
    <div className="sonaChatThread" role="log" aria-live="polite">
      <ChatList
        data={data}
        loadingId={turns.some((turn) => turn.id === 'live-stream') ? 'live-stream' : undefined}
        onActionsClick={onMessageAction}
        onMessageChange={onMessageChange}
        renderMessages={{
          assistant: ({ content, extra, id }) => {
            const scoped = extra as LobeExtra;
            if (scoped.turn.kind !== 'assistant') return null;
            return (
              <div className="sonaAssistantMessageContent">
                <AssistantInlinePanels onApproval={scoped.onApproval} turn={scoped.turn} />
                <SonaChatAnswer
                  answer={content}
                  currentSessionId={scoped.currentSessionId}
                  onOpenReport={scoped.onOpenReport}
                  streaming={id === 'live-stream'}
                />
              </div>
            );
          },
          user: ({ content, createAt, editableContent }) => (
            <span title={formatChatTime(createAt)}>{editableContent || content}</span>
          ),
        }}
        showAvatar
        showTitle
        text={{
          copy: '复制',
          copySuccess: '已复制',
          delete: '删除',
          edit: '编辑',
          regenerate: '重新生成',
        }}
        variant="bubble"
      />
    </div>
  );
}

