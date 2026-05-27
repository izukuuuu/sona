import { describe, expect, it } from 'vitest';
import {
  dedupeSessionsByTopic,
  isLikelyTestSession,
  mergeSessionList,
  normalizeSessionTopic,
  topicsMatch,
} from '@/features/workspace/sessionIdentity';
import type { SessionEnvelope } from '@/types/sona';

describe('sessionIdentity', () => {
  it('normalizes description prefixes', () => {
    expect(normalizeSessionTopic('初始对话：分析 OPPO')).toBe('oppo');
    expect(normalizeSessionTopic('分析广州长隆大熊猫')).toBe('广州长隆大熊猫');
  });

  it('matches query to session topic', () => {
    const session: SessionEnvelope = {
      session_id: 'a',
      description: '分析广州长隆大熊猫健康状况',
      initial_query: '',
      created_at: '',
      updated_at: '',
      messages: [],
    };
    expect(topicsMatch('分析广州长隆大熊猫', session)).toBe(true);
  });

  it('dedupes sessions with the same topic', () => {
    const older: SessionEnvelope = {
      session_id: 'old',
      description: '分析 OPPO 母亲节广告',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-14T00:00:00',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const newer: SessionEnvelope = {
      session_id: 'new',
      description: '分析 OPPO 母亲节广告文案争议舆情',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-15T00:00:00',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const keys = dedupeSessionsByTopic([older, newer]).map((s) => s.session_id);
    expect(keys).toEqual(['new']);
    expect(topicsMatch(older.description || '', newer)).toBe(true);
  });

  it('mergeSessionList dedupes by session_id then topic', () => {
    const session: SessionEnvelope = {
      session_id: 'same',
      description: '分析 OPPO',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-15T00:00:00',
      messages: [],
    };
    expect(mergeSessionList([session, session])).toHaveLength(1);
  });

  it('identifies obvious smoke and legacy frontend sessions', () => {
    expect(isLikelyTestSession({ initial_query: 'stream smoke windows backslash report path' })).toBe(true);
    expect(isLikelyTestSession({ initial_query: 'legacy report path' })).toBe(true);
    expect(isLikelyTestSession({ initial_query: '测试事件' })).toBe(true);
    expect(isLikelyTestSession({ initial_query: '什么是舆情反转？' })).toBe(false);
  });
});

