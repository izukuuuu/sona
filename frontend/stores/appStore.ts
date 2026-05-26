import { create } from 'zustand';
import type { TurnBlock } from '@/types/conversation';
import type { ChatMessage, SessionEnvelope, TaskEnvelope } from '@/types/sona';
import { mergeSessionMessages } from '@/features/workspace/mergeSessionMessages';
import { normalizeMessageContent } from '@/features/workspace/conversationTurns';

type AppState = {
  activeSession?: SessionEnvelope;
  currentTaskId?: string;
  messages: ChatMessage[];
  sessions: SessionEnvelope[];
  tasks: TaskEnvelope[];
  activeReportTaskId?: string;
  sessionLoading: boolean;
  sessionError?: string;
  streamBlocks: TurnBlock[];
  clearStreamBlocks: () => void;
  setStreamBlocks: (blocks: TurnBlock[]) => void;
  setActiveSession: (session?: SessionEnvelope) => void;
  mergeActiveSession: (session: SessionEnvelope) => void;
  clearCurrentSession: () => void;
  setSessions: (sessions: SessionEnvelope[]) => void;
  removeSessions: (taskIds: string[]) => void;
  upsertSession: (session: SessionEnvelope) => void;
  setSessionLoading: (loading: boolean) => void;
  setSessionError: (error?: string) => void;
  addMessage: (message: ChatMessage) => void;
  commitStreamReply: (content: string) => void;
  updateLastAssistant: (content: string) => void;
  setTasks: (tasks: TaskEnvelope[]) => void;
  setActiveReportTaskId: (taskId?: string) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  sessions: [],
  tasks: [],
  sessionLoading: false,
  streamBlocks: [],
  clearStreamBlocks: () => set({ streamBlocks: [] }),
  setStreamBlocks: (streamBlocks) => set({ streamBlocks }),
  setActiveSession: (session) =>
    set({
      activeSession: session,
      currentTaskId: session?.task_id,
      messages: session?.messages || [],
      sessionError: undefined,
      streamBlocks: [],
    }),
  mergeActiveSession: (session) =>
    set((state) => {
      if (state.currentTaskId !== session.task_id) {
        return { activeSession: session };
      }
      const merged = mergeSessionMessages(state.messages, session.messages || []);
      return {
        activeSession: { ...session, messages: merged },
        messages: merged,
        sessionError: undefined,
      };
    }),
  clearCurrentSession: () =>
    set({
      activeSession: undefined,
      currentTaskId: undefined,
      messages: [],
      streamBlocks: [],
    }),
  setSessions: (sessions) => set({ sessions }),
  removeSessions: (taskIds) =>
    set((state) => {
      const deleted = new Set(taskIds);
      const activeDeleted = state.currentTaskId ? deleted.has(state.currentTaskId) : false;
      return {
        activeSession: activeDeleted ? undefined : state.activeSession,
        currentTaskId: activeDeleted ? undefined : state.currentTaskId,
        messages: activeDeleted ? [] : state.messages,
        sessions: state.sessions.filter((item) => !deleted.has(item.task_id)),
        streamBlocks: activeDeleted ? [] : state.streamBlocks,
      };
    }),
  upsertSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions.filter((item) => item.task_id !== session.task_id)],
    })),
  setSessionLoading: (sessionLoading) => set({ sessionLoading }),
  setSessionError: (sessionError) => set({ sessionError }),
  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),
  commitStreamReply: (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const state = get();
    const last = state.messages[state.messages.length - 1];
    if (last?.role === 'assistant' && normalizeMessageContent(last.content) === trimmed) {
      return;
    }
    set({
      messages: [
        ...state.messages,
        { role: 'assistant', content: trimmed, timestamp: new Date().toISOString() },
      ],
    });
  },
  updateLastAssistant: (content) =>
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content };
      } else {
        messages.push({ role: 'assistant', content, timestamp: new Date().toISOString() });
      }
      return { messages };
    }),
  setTasks: (tasks) => set({ tasks }),
  setActiveReportTaskId: (taskId) => set({ activeReportTaskId: taskId }),
}));
