import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { listUpcomingCalendarEvents } from '@/google/calendar';
import { GOOGLE_TOKEN_KV_KEY } from '@/google/oauth';

const HOUR_MILLISECONDS = 60 * 60 * 1000;

function createFakeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: unknown) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function createLinkedEnvironment(nowMilliseconds: number): Env {
  return createFakeApolloEnvironment({
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_TOKENS: createFakeKv({
      [GOOGLE_TOKEN_KV_KEY]: JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAtMilliseconds: nowMilliseconds + HOUR_MILLISECONDS,
      }),
    }),
  });
}

function createEventListFetch(items: readonly unknown[]): {
  readonly fetchImplementation: typeof fetch;
  readonly requestedUrlList: string[];
} {
  const requestedUrlList: string[] = [];
  const fetchImplementation = (async (input: RequestInfo | URL) => {
    requestedUrlList.push(String(input));
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImplementation, requestedUrlList };
}

describe('listUpcomingCalendarEvents', () => {
  // 2026-08-24T18:00:00Z is 15:00 in Buenos Aires (UTC-3). The whole point of
  // Step 2 is that the spoken time matches the phone, not the Worker's UTC.
  const nowMilliseconds = Date.parse('2026-08-24T12:00:00Z');

  it('speaks a timed event in Buenos Aires time, not UTC', async () => {
    const { fetchImplementation } = createEventListFetch([
      {
        id: 'event-1',
        summary: 'Reunión con Ana',
        start: { dateTime: '2026-08-24T18:00:00Z' },
      },
    ]);

    const result = await listUpcomingCalendarEvents({
      environment: createLinkedEnvironment(nowMilliseconds),
      nowMilliseconds,
      fetchImplementation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.eventList[0]?.spokenWhen).toContain('15:00');
    expect(result.eventList[0]?.spokenWhen).not.toContain('18:00');
    expect(result.eventList[0]?.spokenWhen).toContain('hoy');
  });

  it('does not roll an all-day event onto the neighbouring day', async () => {
    const { fetchImplementation } = createEventListFetch([
      { id: 'event-2', summary: 'Feriado', start: { date: '2026-08-25' } },
    ]);

    const result = await listUpcomingCalendarEvents({
      environment: createLinkedEnvironment(nowMilliseconds),
      nowMilliseconds,
      fetchImplementation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.eventList[0]?.isAllDay).toBe(true);
    expect(result.eventList[0]?.spokenWhen).toBe('mañana, todo el día');
  });

  it('returns an empty list for an empty day', async () => {
    const { fetchImplementation, requestedUrlList } = createEventListFetch([]);

    const result = await listUpcomingCalendarEvents({
      environment: createLinkedEnvironment(nowMilliseconds),
      nowMilliseconds,
      fetchImplementation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.eventList).toHaveLength(0);
    expect(requestedUrlList[0]).toContain('singleEvents=true');
    expect(requestedUrlList[0]).toContain('orderBy=startTime');
    expect(requestedUrlList[0]).toContain(
      `timeZone=${encodeURIComponent('America/Argentina/Buenos_Aires')}`,
    );
  });

  it('drops cancelled events', async () => {
    const { fetchImplementation } = createEventListFetch([
      {
        id: 'event-3',
        summary: 'Cancelada',
        status: 'cancelled',
        start: { dateTime: '2026-08-24T18:00:00Z' },
      },
    ]);

    const result = await listUpcomingCalendarEvents({
      environment: createLinkedEnvironment(nowMilliseconds),
      nowMilliseconds,
      fetchImplementation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.eventList).toHaveLength(0);
  });

  it('fails closed with a spoken reconnect message when nothing is linked', async () => {
    const { fetchImplementation } = createEventListFetch([]);

    const result = await listUpcomingCalendarEvents({
      environment: createFakeApolloEnvironment({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_TOKENS: createFakeKv(),
      }),
      nowMilliseconds,
      fetchImplementation,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('reconectes');
  });
});
