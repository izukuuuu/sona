'use client';

import type { AgentStep, ConversationTurn } from '@/types/conversation';
import { Button } from 'antd';
import { ChatList, type ChatMessage as LobeChatMessage } from '@lobehub/ui/chat';
import { Check, PencilLine, X } from 'lucide-react';
import { SonaChatAnswer } from '@/features/workspace/SonaChatAnswer';
import { SONA_ASSISTANT_TITLE } from '@/features/workspace/chatMessageUi';
import type { AgentApprovalAction } from '@/types/sona';

function formatChatTime(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return clock;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function AgentStepsPanel({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  return (
    <details className="sonaAgentSteps">
      <summary>
        Agent 过程
        <span className="sonaAgentStepsCount">{steps.length} 步</span>
      </summary>
      <ol className="sonaAgentStepsList">
        {steps.map((step) => (
          <li key={step.id} className={`sonaAgentStep sonaAgentStep--${step.kind}`}>
            <span className="sonaAgentStepTitle">{step.title}</span>
            <pre>{step.content}</pre>
          </li>
        ))}
      </ol>
    </details>
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

type SonaChatThreadProps = {
  turns: ConversationTurn[];
  currentTaskId?: string;
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  onOpenReport?: (taskId: string) => void;
};

type LobeExtra = {
  currentTaskId?: string;
  onApproval?: (step: AgentStep, action: AgentApprovalAction) => void;
  onOpenReport?: (taskId: string) => void;
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

export function SonaChatThread({ turns, currentTaskId, onApproval, onOpenReport }: SonaChatThreadProps) {
  const data = lobeMessagesFromTurns(turns, { currentTaskId, onApproval, onOpenReport });
  return (
    <div className="sonaChatThread" role="log" aria-live="polite">
      <ChatList
        data={data}
        loadingId={turns.some((turn) => turn.id === 'live-stream') ? 'live-stream' : undefined}
        renderMessages={{
          assistant: ({ content, extra, id }) => {
            const scoped = extra as LobeExtra;
            return (
              <SonaChatAnswer
                answer={content}
                currentTaskId={scoped.currentTaskId}
                onOpenReport={scoped.onOpenReport}
                streaming={id === 'live-stream'}
              />
            );
          },
          user: ({ content, createAt }) => (
            <span title={formatChatTime(createAt)}>{content}</span>
          ),
        }}
        renderMessagesExtra={{
          assistant: ({ extra }) => {
            const scoped = extra as LobeExtra;
            if (scoped.turn.kind !== 'assistant') return null;
            return (
              <>
                {scoped.turn.steps.filter((step) => step.kind === 'approval').map((step) => (
                  <ApprovalPanel key={step.id} onApproval={scoped.onApproval} step={step} />
                ))}
                <AgentStepsPanel steps={scoped.turn.steps.filter((step) => step.kind !== 'approval')} />
              </>
            );
          },
        }}
        showAvatar
        showTitle
        variant="bubble"
      />
    </div>
  );
}
