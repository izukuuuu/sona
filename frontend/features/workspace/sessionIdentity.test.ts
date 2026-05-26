import { describe, expect, it } from 'vitest';
import {
  dedupeSessionsByTopic,
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
      task_id: 'a',
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
      task_id: 'old',
      description: '分析 OPPO 母亲节广告',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-14T00:00:00',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const newer: SessionEnvelope = {
      task_id: 'new',
      description: '分析 OPPO 母亲节广告文案争议舆情',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-15T00:00:00',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const keys = dedupeSessionsByTopic([older, newer]).map((s) => s.task_id);
    expect(keys).toEqual(['new']);
    expect(topicsMatch(older.description || '', newer)).toBe(true);
  });

  it('mergeSessionList dedupes by task_id then topic', () => {
    const session: SessionEnvelope = {
      task_id: 'same',
      description: '分析 OPPO',
      initial_query: '',
      created_at: '',
      updated_at: '2026-05-15T00:00:00',
      messages: [],
    };
    expect(mergeSessionList([session, session])).toHaveLength(1);
  });
});
