'use client';

import { useCallback, useRef } from 'react';
import { sonaApi } from '@/services/sonaApi';
import { useAppStore } from '@/stores/appStore';
import type { SessionEnvelope } from '@/types/sona';
import { mergeSessionList } from '@/features/workspace/sessionIdentity';

export const LAST_SESSION_KEY = 'sona:lastSessionId';
const DELETED_SESSION_KEY = 'sona:deletedSessionIds';
export const SESSION_LIST_LIMIT = 50;

function persistLastSession(taskId: string, options?: { requireMessages?: boolean; messageCount?: number }) {
  if (options?.requireMessages && !options.messageCount) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, taskId);
  } catch {
    // ignore quota / private mode
  }
}

function sessionHasMessages(session?: SessionEnvelope | null) {
  return Boolean(session?.messages?.length);
}

function readLastSession(): string | undefined {
  try {
    const value = localStorage.getItem(LAST_SESSION_KEY)?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readDeletedSessionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberDeletedSessionIds(taskIds: string[]) {
  try {
    const next = readDeletedSessionIds();
    taskIds.forEach((id) => {
      if (id) next.add(id);
    });
    localStorage.setItem(DELETED_SESSION_KEY, JSON.stringify([...next].slice(-500)));
    const last = localStorage.getItem(LAST_SESSION_KEY);
    if (last && next.has(last)) localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // ignore unavailable storage
  }
}

function omitDeletedSessions(sessions: SessionEnvelope[]): SessionEnvelope[] {
  const deleted = readDeletedSessionIds();
  if (!deleted.size) return sessions;
  return sessions.filter((session) => !deleted.has(session.task_id));
}

type UseChatSessionOptions = {
  setHomeMode: (value: boolean) => void;
  onError?: (message: string) => void;
};

export function useChatSession({ setHomeMode, onError }: UseChatSessionOptions) {
  const requestSeq = useRef(0);
  const reloadSeq = useRef(0);
  const {
    activeSession,
    currentTaskId,
    setActiveSession,
    mergeActiveSession,
    setSessions,
    upsertSession,
    setSessionLoading,
    setSessionError,
    clearCurrentSession,
  } = useAppStore();

  const refreshSessions = useCallback(async () => {
    const result = await sonaApi.listSessions(SESSION_LIST_LIMIT);
    const listed = mergeSessionList(omitDeletedSessions(result.sessions || []));
    setSessions(listed);
    return listed;
  }, [setSessions]);

  const openSession = useCallback(
    async (taskId: string): Promise<SessionEnvelope | null> => {
      const seq = ++requestSeq.current;
      setSessionLoading(true);
      setSessionError(undefined);
      try {
        const session = await sonaApi.getSession(taskId);
        if (seq !== requestSeq.current) return null;
        setActiveSession(session);
        upsertSession(session);
        persistLastSession(taskId, {
          requireMessages: true,
          messageCount: session.messages?.length ?? 0,
        });
        setHomeMode(false);
        return session;
      } catch (error) {
        if (seq !== requestSeq.current) return null;
        const message = error instanceof Error ? error.message : String(error);
        setSessionError(message);
        onError?.(message);
        return null;
      } finally {
        if (seq === requestSeq.current) setSessionLoading(false);
      }
    },
    [onError, setActiveSession, setHomeMode, setSessionError, setSessionLoading, upsertSession],
  );

  const reloadSession = useCallback(
    async (taskId: string) => {
      const seq = ++reloadSeq.current;
      const session = await sonaApi.getSession(taskId);
      if (seq !== reloadSeq.current) return session;
      const serverCount = session.messages?.length ?? 0;
      if (currentTaskId === taskId) {
        const localCount = useAppStore.getState().messages.length;
        if (serverCount === 0 && localCount > 0) {
          upsertSession({ ...session, messages: useAppStore.getState().messages });
          return session;
        }
        mergeActiveSession(session);
        const mergedCount = useAppStore.getState().messages.length;
        if (mergedCount > 0) {
          persistLastSession(taskId, { requireMessages: true, messageCount: mergedCount });
        }
      }
      upsertSession({
        ...session,
        messages:
          currentTaskId === taskId ? useAppStore.getState().messages : session.messages || [],
      });
      return session;
    },
    [currentTaskId, mergeActiveSession, upsertSession],
  );

  const ensureSession = useCallback(
    async (initialQuery: string, options?: { forceNew?: boolean }): Promise<SessionEnvelope> => {
      const trimmed = initialQuery.trim() || 'Sona session';

      if (!options?.forceNew) {
        if (currentTaskId && activeSession?.task_id === currentTaskId) {
          setHomeMode(false);
          return activeSession;
        }

        if (currentTaskId) {
          try {
            const existing = await sonaApi.getSession(currentTaskId);
            setActiveSession(existing);
            upsertSession(existing);
            setHomeMode(false);
            return existing;
          } catch {
            clearCurrentSession();
          }
        }
      }

      const session = await sonaApi.createSession(trimmed);
      setActiveSession(session);
      upsertSession(session);
      persistLastSession(session.task_id);
      setHomeMode(false);
      return session;
    },
    [
      activeSession,
      clearCurrentSession,
      currentTaskId,
      setActiveSession,
      setHomeMode,
      upsertSession,
    ],
  );

  const createEmptySession = useCallback(async (): Promise<SessionEnvelope> => {
    clearCurrentSession();
    const session = await sonaApi.createSession('Sona session');
    setActiveSession(session);
    upsertSession(session);
    persistLastSession(session.task_id);
    setHomeMode(false);
    return session;
  }, [clearCurrentSession, setActiveSession, setHomeMode, upsertSession]);

  const hydrateFromUrl = useCallback(
    async (sessionId?: string | null) => {
      const preferred = sessionId?.trim() || readLastSession();
      const listed = await refreshSessions();
      const preferredInList = preferred ? listed.find((item) => item.task_id === preferred) : undefined;

      if (sessionHasMessages(preferredInList) && preferred) {
        const session = await openSession(preferred);
        return Boolean(session);
      }

      const fallback = listed.find((item) => sessionHasMessages(item) && item.task_id !== preferred);
      if (fallback?.task_id) {
        const session = await openSession(fallback.task_id);
        return Boolean(session);
      }

      if (preferred) {
        const session = await openSession(preferred);
        return Boolean(session);
      }

      return false;
    },
    [openSession, refreshSessions],
  );

  const openHome = useCallback(() => {
    setHomeMode(true);
  }, [setHomeMode]);

  const handleDeletedCurrent = useCallback(
    async (remaining: SessionEnvelope[]) => {
      const next = omitDeletedSessions(remaining)[0];
      if (next?.task_id) {
        await openSession(next.task_id);
        return;
      }
      clearCurrentSession();
      setHomeMode(true);
    },
    [clearCurrentSession, openSession, setHomeMode],
  );

  const syncCurrentSessionIfNeeded = useCallback(
    async (listed: SessionEnvelope[]) => {
      if (!currentTaskId) return;
      if (!listed.some((item) => item.task_id === currentTaskId)) return;
      await reloadSession(currentTaskId);
    },
    [currentTaskId, reloadSession],
  );

  return {
    openSession,
    reloadSession,
    ensureSession,
    createEmptySession,
    refreshSessions,
    hydrateFromUrl,
    openHome,
    handleDeletedCurrent,
    syncCurrentSessionIfNeeded,
    rememberDeletedSessionIds,
  };
}
