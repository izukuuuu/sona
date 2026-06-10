import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sonaApi } from '@/services/sonaApi';

describe('sonaApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('requests JSON for session listing', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    await sonaApi.listSessions();

    expect(fetchMock).toHaveBeenCalledWith('/api/sona/v1/chat/sessions?limit=50', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  });

  it('throws a readable error when an API endpoint returns HTML', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>Bad gateway</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );

    await expect(sonaApi.listSessions()).rejects.toThrow(
      /non-JSON response \(502 Bad Gateway, text\/html; charset=utf-8\)/i,
    );
  });
});
