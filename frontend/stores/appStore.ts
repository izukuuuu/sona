import { create } from 'zustand';
import type { TurnBlock } from '@/types/conversation';
import type { ChatMessage, SessionEnvelope, TaskEnvelope } from '@/types/sona';
import { mergeSessionMessages } from '@/features/workspace/mergeSessionMessages';
import { normalizeMessageContent } from '@/features/workspace/conversationTurns';

type AppState = {
  activeSession?: SessionEnvelope;
  currentSessionId?: string;
  messages: ChatMessage[];
  sessions: SessionEnvelope[];
  tasks: TaskEnvelope[];
  activeReportSessionId?: string;
  sessionLoading: boolean;
  sessionError?: string;
  streamBlocks: TurnBlock[];
  clearStreamBlocks: () => void;
  setStreamBlocks: (blocks: TurnBlock[]) => void;
  setActiveSession: (session?: SessionEnvelope) => void;
  mergeActiveSession: (session: SessionEnvelope) => void;
  clearCurrentSession: () => void;
  setSessions: (sessions: SessionEnvelope[]) => void;
  removeSessions: (sessionIds: string[]) => void;
  upsertSession: (session: SessionEnvelope) => void;
  setSessionLoading: (loading: boolean) => void;
  setSessionError: (error?: string) => void;
  addMessage: (message: ChatMessage) => void;
  commitStreamReply: (content: string) => void;
  updateLastAssistant: (content: string) => void;
  setTasks: (tasks: TaskEnvelope[]) => void;
  setActiveReportSessionId: (sessionId?: string) => void;
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
      currentSessionId: session?.session_id,
      messages: session?.messages || [],
      sessionError: undefined,
      streamBlocks: [],
    }),
  mergeActiveSession: (session) =>
    set((state) => {
      if (state.currentSessionId !== session.session_id) {
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
      currentSessionId: undefined,
      messages: [],
      streamBlocks: [],
    }),
  setSessions: (sessions) => set({ sessions }),
  removeSessions: (sessionIds) =>
    set((state) => {
      const deleted = new Set(sessionIds);
      const activeDeleted = state.currentSessionId ? deleted.has(state.currentSessionId) : false;
      return {
        activeSession: activeDeleted ? undefined : state.activeSession,
        currentSessionId: activeDeleted ? undefined : state.currentSessionId,
        messages: activeDeleted ? [] : state.messages,
        sessions: state.sessions.filter((item) => !deleted.has(item.session_id)),
        streamBlocks: activeDeleted ? [] : state.streamBlocks,
      };
    }),
  upsertSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions.filter((item) => item.session_id !== session.session_id)],
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
  setActiveReportSessionId: (sessionId) => set({ activeReportSessionId: sessionId }),
}));
