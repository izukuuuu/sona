import type { SessionEnvelope } from '@/types/sona';

const GENERIC_LABELS = new Set(['', '新话题', 'sona session', 'frontend session']);

/** Strip display prefixes so "初始对话：foo" and "分析foo" match the same topic. */
export function normalizeSessionTopic(text: string): string {
  let trimmed = text.trim();
  while (/^(初始对话：|分析)/u.test(trimmed)) {
    trimmed = trimmed.replace(/^(初始对话：|分析)/u, '').trim();
  }
  return trimmed.replace(/\s+/g, ' ').toLowerCase().slice(0, 120);
}

/** Same truncation as sidebar title (without task id suffix). */
export function sessionDisplayLabel(session: {
  description?: string;
  initial_query?: string;
}): string {
  const base = session.description || session.initial_query || '新话题';
  let t = base.trim();
  while (/^(初始对话：|分析)/u.test(t)) {
    t = t.replace(/^(初始对话：|分析)/u, '').trim();
  }
  const compact = t.replace(/\s+/g, ' ');
  if (!compact) return '新话题';
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
}

export function sessionSidebarKey(session: {
  description?: string;
  initial_query?: string;
}): string {
  return sessionDisplayLabel(session).toLowerCase();
}

/** Compact fingerprint for clustering near-duplicate topics. */
export function sessionFingerprint(session: {
  description?: string;
  initial_query?: string;
}): string {
  const raw = session.description || session.initial_query || '';
  return normalizeSessionTopic(raw).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20);
}

export function topicsMatch(
  query: string,
  session: { description?: string; initial_query?: string },
): boolean {
  const queryKey = normalizeSessionTopic(query);
  const sessionKey = normalizeSessionTopic(session.description || session.initial_query || '');
  if (!queryKey || !sessionKey) return false;
  if (queryKey === sessionKey) return true;
  if (sessionKey.startsWith(queryKey) || queryKey.startsWith(sessionKey)) return true;
  const minLen = Math.min(queryKey.length, sessionKey.length);
  const probe = Math.min(16, minLen);
  return probe >= 6 && queryKey.slice(0, probe) === sessionKey.slice(0, probe);
}

function isGenericSidebarKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return GENERIC_LABELS.has(k) || k.startsWith('wiki case');
}

export function sessionsAreDuplicates(a: SessionEnvelope, b: SessionEnvelope): boolean {
  if (a.task_id === b.task_id) return true;

  const labelA = a.description || a.initial_query || '';
  const labelB = b.description || b.initial_query || '';
  const keyA = sessionSidebarKey(a);
  const keyB = sessionSidebarKey(b);

  if (!isGenericSidebarKey(keyA) && keyA === keyB) return true;

  const fpA = sessionFingerprint(a);
  const fpB = sessionFingerprint(b);
  if (fpA.length >= 8 && fpB.length >= 8) {
    if (fpA === fpB) return true;
    const minLen = Math.min(fpA.length, fpB.length);
    if (minLen >= 8 && fpA.slice(0, minLen) === fpB.slice(0, minLen)) return true;
  }

  return topicsMatch(labelA, b) || topicsMatch(labelB, a);
}

/** One sidebar row per logical topic — keep the most recently updated session. */
export function dedupeSessionsByTopic(sessions: SessionEnvelope[]): SessionEnvelope[] {
  const sorted = [...sessions].sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
  );
  const kept: SessionEnvelope[] = [];
  for (const session of sorted) {
    if (!session.task_id) continue;
    const isDup = kept.some((item) => sessionsAreDuplicates(session, item));
    if (!isDup) kept.push(session);
  }
  return kept;
}

/** Dedupe by task_id first (active + list merge), then by topic. */
export function mergeSessionList(sessions: SessionEnvelope[]): SessionEnvelope[] {
  const byId = new Map<string, SessionEnvelope>();
  for (const session of sessions) {
    if (!session.task_id) continue;
    const prev = byId.get(session.task_id);
    if (!prev || String(session.updated_at || '') > String(prev.updated_at || '')) {
      byId.set(session.task_id, session);
    }
  }
  return dedupeSessionsByTopic([...byId.values()]);
}
