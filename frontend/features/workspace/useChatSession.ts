'use client';

import { useCallback, useRef } from 'react';
import { sonaApi } from '@/services/sonaApi';
import { useAppStore } from '@/stores/appStore';
import type { SessionEnvelope } from '@/types/sona';
import { mergeSessionList } from '@/features/workspace/sessionIdentity';

export const LAST_SESSION_KEY = 'sona:lastSessionId';
export const SESSION_LIST_LIMIT = 50;

function persistLastSession(sessionId: string, options?: { requireMessages?: boolean; messageCount?: number }) {
  if (options?.requireMessages && !options.messageCount) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, sessionId);
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

function rememberDeletedSessions(sessions: SessionEnvelope[]) {
  try {
    const deleted = new Set(sessions.map((session) => session.session_id).filter(Boolean));
    const last = localStorage.getItem(LAST_SESSION_KEY);
    if (last && deleted.has(last)) localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // ignore unavailable storage
  }
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
    currentSessionId,
    setActiveSession,
    mergeActiveSession,
    setSessions,
    upsertSession,
    setSessionLoading,
    setSessionError,
    clearCurrentSession,
  } = useAppStore();

  const reportSessionError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionError(message);
      onError?.(message);
      return message;
    },
    [onError, setSessionError],
  );

  const refreshSessions = useCallback(async () => {
    setSessionError(undefined);
    try {
      const result = await sonaApi.listSessions(SESSION_LIST_LIMIT);
      const listed = mergeSessionList(result.sessions || []);
      setSessions(listed);
      return listed;
    } catch (error) {
      reportSessionError(error);
      return [];
    }
  }, [reportSessionError, setSessionError, setSessions]);

  const openSession = useCallback(
    async (sessionId: string): Promise<SessionEnvelope | null> => {
      const seq = ++requestSeq.current;
      setSessionLoading(true);
      setSessionError(undefined);
      try {
        const session = await sonaApi.getSession(sessionId);
        if (seq !== requestSeq.current) return null;
        setActiveSession(session);
        upsertSession(session);
        persistLastSession(sessionId, {
          requireMessages: true,
          messageCount: session.messages?.length ?? 0,
        });
        setHomeMode(false);
        return session;
      } catch (error) {
        if (seq !== requestSeq.current) return null;
        reportSessionError(error);
        return null;
      } finally {
        if (seq === requestSeq.current) setSessionLoading(false);
      }
    },
    [reportSessionError, setActiveSession, setHomeMode, setSessionLoading, upsertSession],
  );

  const reloadSession = useCallback(
    async (sessionId: string) => {
      const seq = ++reloadSeq.current;
      const session = await sonaApi.getSession(sessionId);
      if (seq !== reloadSeq.current) return session;
      const serverCount = session.messages?.length ?? 0;
      if (currentSessionId === sessionId) {
        const localCount = useAppStore.getState().messages.length;
        if (serverCount === 0 && localCount > 0) {
          upsertSession({ ...session, messages: useAppStore.getState().messages });
          return session;
        }
        mergeActiveSession(session);
        const mergedCount = useAppStore.getState().messages.length;
        if (mergedCount > 0) {
          persistLastSession(sessionId, { requireMessages: true, messageCount: mergedCount });
        }
      }
      upsertSession({
        ...session,
        messages:
          currentSessionId === sessionId ? useAppStore.getState().messages : session.messages || [],
      });
      return session;
    },
    [currentSessionId, mergeActiveSession, upsertSession],
  );

  const ensureSession = useCallback(
    async (initialQuery: string, options?: { forceNew?: boolean }): Promise<SessionEnvelope> => {
      const trimmed = initialQuery.trim() || 'Sona session';

      if (!options?.forceNew) {
        if (currentSessionId && activeSession?.session_id === currentSessionId) {
          setHomeMode(false);
          return activeSession;
        }

        if (currentSessionId) {
          try {
            const existing = await sonaApi.getSession(currentSessionId);
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
      persistLastSession(session.session_id);
      setHomeMode(false);
      return session;
    },
    [
      activeSession,
      clearCurrentSession,
      currentSessionId,
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
    persistLastSession(session.session_id);
    setHomeMode(false);
    return session;
  }, [clearCurrentSession, setActiveSession, setHomeMode, upsertSession]);

  const hydrateFromUrl = useCallback(
    async (sessionId?: string | null) => {
      try {
        const preferred = sessionId?.trim() || readLastSession();
        const listed = await refreshSessions();
        const preferredInList = preferred ? listed.find((item) => item.session_id === preferred) : undefined;

        if (sessionHasMessages(preferredInList) && preferred) {
          const session = await openSession(preferred);
          return Boolean(session);
        }

        const fallback = listed.find((item) => sessionHasMessages(item) && item.session_id !== preferred);
        if (fallback?.session_id) {
          const session = await openSession(fallback.session_id);
          return Boolean(session);
        }

        if (preferred) {
          const session = await openSession(preferred);
          return Boolean(session);
        }

        return false;
      } catch {
        return false;
      }
    },
    [openSession, refreshSessions],
  );

  const openHome = useCallback(() => {
    setHomeMode(true);
  }, [setHomeMode]);

  const handleDeletedCurrent = useCallback(
    async (remaining: SessionEnvelope[]) => {
      const next = remaining[0];
      if (next?.session_id) {
        await openSession(next.session_id);
        return;
      }
      clearCurrentSession();
      setHomeMode(true);
    },
    [clearCurrentSession, openSession, setHomeMode],
  );

  const syncCurrentSessionIfNeeded = useCallback(
    async (listed: SessionEnvelope[]) => {
      if (!currentSessionId) return;
      if (!listed.some((item) => item.session_id === currentSessionId)) return;
      await reloadSession(currentSessionId);
    },
    [currentSessionId, reloadSession],
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
    rememberDeletedSessions,
  };
}

