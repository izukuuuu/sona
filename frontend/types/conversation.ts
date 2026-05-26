/** One step inside an assistant turn (collapsed by default). */
export type AgentStep = {
  id: string;
  kind: 'tool' | 'thinking' | 'route' | 'compression' | 'note' | 'approval' | 'workflow' | 'research';
  title: string;
  content: string;
  status?: 'pending' | 'approved' | 'rejected' | 'recorded' | 'running' | 'completed' | 'failed';
  phase?: string;
  payload?: Record<string, unknown>;
  runId?: string;
  approvalEventId?: string;
};

export type ConversationTurn =
  | {
      id: string;
      kind: 'user';
      content: string;
      timestamp: number;
    }
  | {
      id: string;
      kind: 'assistant';
      timestamp: number;
      /** Primary reply shown like normal chat. */
      answer: string;
      /** Tool / route / interim notes — collapsed under “Agent 过程”. */
      steps: AgentStep[];
    };

/** @deprecated Internal stream building — use AgentStep after consolidate. */
export type TurnBlock =
  | { type: 'route'; route: string; taskMode: string }
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; args: unknown; callId?: string }
  | { type: 'tool_result'; toolName: string; content: string; callId?: string }
  | {
      type: 'research';
      step: string;
      title: string;
      content: string;
      phase?: string;
      status?: 'running' | 'completed' | 'failed';
      payload?: Record<string, unknown>;
    }
  | {
      type: 'approval';
      title?: string;
      prompt: string;
      status: 'pending' | 'approved' | 'rejected' | 'recorded';
      decision?: string;
      payload?: Record<string, unknown>;
      runId?: string;
      approvalEventId?: string;
    }
  | { type: 'compression'; summary: string }
  | { type: 'system'; content: string }
  | { type: 'workflow'; step: string; title: string; content: string };
